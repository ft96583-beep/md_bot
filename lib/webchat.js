// ─── 💬 NEXORA WebChat bridge (bot side) ─────────────────────────
// Web visitors ke messages: page →(Nostr)→ Python worker →
//   sessions/webchat/to_boss.jsonl → [yahan poll hota hai] → Boss ki WhatsApp.
// Boss ka jawab (.wr / 1-2-3): sessions/webchat/to_web.jsonl → worker → page.
//
// Queue item schema (bridge/Python side likhta hai):
//   {"id":"page-msg-id","type":"text","ticket":"W1234","threadId":"...",
//    "name":"Ali","text":"...","first":true,"wa":"+92..."}
//   {"id":"...","type":"voice","ticket":"W1234","threadId":"...","name":"Ali",
//    "audio":"<base64 ogg/wav/mp3>"}
//   {"id":"...","type":"rating","ticket":"W1234","threadId":"...","name":"Ali","stars":5}
// Ack (hum likhte hain → to_web.jsonl):
//   {"ts":..,"threadId":..,"type":"ack","msgId":<item.id>,"st":"delivered"|"seen"}
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BASE = '/home/hatch/workspace/whatsapp-md-bot/sessions/webchat';
const TO_BOSS = path.join(BASE, 'to_boss.jsonl');
const TO_WEB = path.join(BASE, 'to_web.jsonl');
const OFFSET_FILE = path.join(BASE, 'webchat.offset');
const LAST_FILE = path.join(BASE, 'last.json');
const BLOCKED_FILE = path.join(BASE, 'blocked.json');
const PRESENCE_FILE = path.join(BASE, 'presence.json');
const TICKETS_FILE = path.join(BASE, 'tickets.json');
const PAGE_DIR = '/home/hatch/workspace/webchat-page';
const PAGE_URL_FILE = path.join(PAGE_DIR, 'DEPLOYED_URL.txt');
const DEFAULT_PAGE_URL = 'https://nexora-chat.surge.sh';

// Webchat page ka URL — page builder DEPLOYED_URL.txt chhor jaye to wahi,
// warna default. (.contact text mein istemal hota hai.)
function webchatUrl() {
  try {
    const u = fs.readFileSync(PAGE_URL_FILE, 'utf8').trim().split(/\s+/)[0];
    if (u && /^https?:\/\//i.test(u)) return u;
  } catch {}
  return DEFAULT_PAGE_URL;
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts || {}, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve({ stdout, stderr });
    });
  });
}

function buildWebchat(deps) {
  const {
    reply, askNexa, aiPrompt, config, isOwnerMsg, num,
    getText, recordOwnMsgId, isOwnMsgId, transcribeVoice,
    baseDir, // test override
  } = deps || {};
  const B = baseDir || BASE;
  const P = {
    toBoss: path.join(B, 'to_boss.jsonl'),
    toWeb: path.join(B, 'to_web.jsonl'),
    offset: path.join(B, 'webchat.offset'),
    last: path.join(B, 'last.json'),
    blocked: path.join(B, 'blocked.json'),
    presence: path.join(B, 'presence.json'),
    tickets: path.join(B, 'tickets.json'),
    seen: path.join(B, 'seen.json'),
  };

  let SOCK = null;
  let timer = null;
  const setSock = (s) => { SOCK = s; };

  // ── file helpers ──
  function ensure() {
    try { fs.mkdirSync(B, { recursive: true }); } catch {}
    for (const f of [P.toBoss, P.toWeb]) {
      try { if (!fs.existsSync(f)) fs.writeFileSync(f, ''); } catch {}
    }
  }
  function jread(f, fb) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; }
  }
  function jwrite(f, v) {
    try { fs.writeFileSync(f, JSON.stringify(v)); } catch (e) { console.error('[webchat] write fail', f, e.message); }
  }
  function appendLine(f, obj) {
    try { fs.appendFileSync(f, JSON.stringify(obj) + '\n'); }
    catch (e) { console.error('[webchat] append fail', f, e.message); }
  }
  function ownerJid() {
    const d = num(config.owner);
    return d ? d + '@s.whatsapp.net' : null;
  }
  // AI helper — maujooda Nexa path (askNexa + NEXUS aiPrompt filter), koi naya path nahi.
  // BUGFIX (2026-09-24): retry + sanitize. Raw HTML / error-page / stack-trace
  // kabhi bahar nahi jata — failure par '' (callers ke paas friendly fallback hai).
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), ms))]);
  }
  function cleanAiText(s) {
    let t = String(s == null ? '' : s);
    if (!t.trim()) return '';
    // HTML / error-page markers → garbage, drop it
    if (/<(!doctype|html[\s>]|head[\s>])/i.test(t)) return '';
    if (/<[a-z][^>]*>/i.test(t) && /(bad gateway|cloudflare|error code|502|503|origin\.pollinations)/i.test(t)) return '';
    // koi bhi bachi-khuchi tags strip karo
    t = t.replace(/<[^>]*>/g, '');
    t = t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
         .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    if (!t || /^[\s\W]*$/.test(t)) return '';
    return t.slice(0, 2000);
  }
  async function ai(q) {
    const j = ownerJid() || '';
    for (let attempt = 0; attempt < 3; attempt++) { // initial + max 2 retries
      try {
        const raw = await withTimeout(askNexa(aiPrompt(q, j, j)), 25000);
        const clean = cleanAiText(raw);
        if (clean) return clean;
      } catch {}
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); // backoff
    }
    return '';
  }
  const AI_FALLBACK = 'Thori der mein jawab deti hoon 💗';

  // ── NEXORA-MD ke ASAL features (curated, behtareen pehle) ──
  // Boss ka usool: FEATURES/fayde batao, raw .commands ki list KABHI nahi;
  // jo sab se achhe hon pehle; list se bahar kuch invent mat karo.
  const NEXORA_FEATURES = [
    ['🤖 AI Assistant', '24/7 smart chat — koi bhi sawal pucho, foran jawab pao'],
    ['🎨 AI Images', 'lafz likho, khoobsurat tasweer banao — stylish DP bhi'],
    ['📥 Video Downloaders', 'TikTok, Instagram, Facebook, YouTube se video/audio download'],
    ['🎭 Stickers', 'photo, text ya emoji se foran sticker banao'],
    ['🎙️ Voice', 'voice note bhejo — suno bhi, parho bhi (transcript ke saath)'],
    ['👥 Group Tools', 'tag-all, anti-link, welcome message, admin control'],
    ['🛠️ Daily Utilities', 'mausam, namaz timings, currency, QR code, news, yaad-dihani'],
    ['🎉 Fun & Games', 'jokes, shayari, memes, pranks aur khel'],
    ['🔐 Privacy Tools', 'temp email, delete-shuda messages pakro, view-once'],
    ['💼 Apna Bot', 'NEXORA-MD jaisa apna bot chahiye to owner se rabta karo'],
  ];
  // BUGFIX 2026-09-24 (DHD hallucination): option jawab AI se nahi bante thay —
  // kabhi kabhi Pollinations "DHD symptoms tracking, AI healing" jaisi cheezein
  // invent kar deta tha (negative-priming: prompt mein "DHD mat kaho" likhne se
  // model DHD kehne lagta hai). Ab chaaron option ke jawab FIXED templates hain —
  // hallucination 0%, jawab foran (AI latency bhi khatam).
  const OPT_FEATURES =
    '💗 *NEXORA-MD ke best features:*\n\n' +
    NEXORA_FEATURES.slice(0, 5).map(([t, d]) => `${t}\n_${d}_`).join('\n\n') +
    '\n\nKonsa feature try karna chahoge? 😊';
  const OPT_PRICE =
    '💰 Qeemat feature aur package ke hisaab se hoti hai — ye owner tay karta hai.\n\n' +
    '👤 *Owner se baat* dabao ya apna sawal yahin likho — owner khud jawab dega 💗';
  const OPT_HELP =
    '🛠️ Zaroor madad karongi! Bas batao kis cheez mein — bot use karna, koi feature, ya koi masla?\n\n' +
    'Jitni detail doge, utni achhi madad milegi 💗';
  const OPT_OWNER =
    '👤 Owner ko foran ittila de rahi hoon — woh jald jawab dega 💗\n\n' +
    'Intezar mein apna sawal yahin likh do!';
  let _ownerSends = 0; // EXACTLY-ONCE bookkeeping: WhatsApp sends ka counter
  async function sendOwner(payload) {
    const r = await SOCK.sendMessage(ownerJid(), payload);
    _ownerSends++;
    try { recordOwnMsgId(r && r.key && r.key.id); } catch {} // echo loop protection
    return r;
  }
  function appendAck(threadId, msgId, st) {
    appendLine(P.toWeb, { ts: Date.now(), threadId, type: 'ack', msgId, st });
  }

  // ── AI classifiers ──
  async function isUrgent(text) {
    const a = await ai(
      'Neeche wale customer message ko SIRF ek lafz mein classify karo: URGENT ya NORMAL.\n' +
      'URGENT = gussa, shikayat, foran madad ki darkhwast, paise/payment ka masla, dhoka, dhamki, emergency.\n' +
      'NORMAL = aam sawal, salam-dua, maloomat.\nSirf ek lafz jawab do.\n\nMessage: """' +
      String(text).slice(0, 800) + '"""');
    return /^\s*urgent/i.test(a || '');
  }
  // SPEED (2026-09-24): tez single-attempt urgent check — 1.2s cap.
  // Slow ho to false (plain body foran jata hai, Boss ka wait nahi hota).
  async function isUrgentFast(text) {
    try {
      const j = ownerJid() || '';
      const raw = await withTimeout(askNexa(aiPrompt(
        'SIRF ek lafz jawab do: URGENT ya NORMAL.\n' +
        'URGENT = gussa, shikayat, foran madad, paise ka masla, emergency.\n' +
        'NORMAL = baqi sab.\n\nMessage: """' + String(text).slice(0, 500) + '"""',
        j, j)), 1200);
      return /^\s*urgent/i.test(cleanAiText(raw));
    } catch { return false; }
  }
  // SPEED: lambi message ka khulasa — single attempt, 3s cap; fail ho to truncated text.
  async function oneLineSummaryFast(text) {
    try {
      const j = ownerJid() || '';
      const raw = await withTimeout(askNexa(aiPrompt(
        'Neeche wale customer message ka SIRF 1 line mein khulasa Roman Urdu mein likho (koi izafi baat nahi):\n\n"""' +
        String(text).slice(0, 1500) + '"""', j, j)), 3000);
      const line = cleanAiText(raw).split('\n').map((l) => l.trim()).filter(Boolean)[0];
      return line || '';
    } catch { return ''; }
  }
  async function oneLineSummary(text) {
    const a = await ai(
      'Neeche wale customer message ka SIRF 1 line mein khulasa Roman Urdu mein likho (koi izafi baat nahi):\n\n"""' +
      String(text).slice(0, 1500) + '"""');
    return String(a || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  }
  async function quickReplies(text) {
    const a = await ai(
      'Tum NEXORA-MD ki assistant Nexa ho. Neeche web visitor ka message hai. ' +
      'Owner (Boss) ke liye 3 MUKHTASIR jawab suggest karo — har jawab 1 line, Roman Urdu, visitor se mukhatib, ' +
      'baghair number ya bullet ke. SIRF 3 lines do, koi izafi text nahi.\n\nVisitor: """' +
      String(text).slice(0, 800) + '"""');
    const lines = String(a || '').split('\n').map((l) => l.replace(/^[\d\-•*).]+\s*/, '').trim()).filter(Boolean);
    return lines.length >= 3 ? lines.slice(0, 3) : [];
  }

  // ── ticket ↔ threadId map ──
  function ticketMap() { return jread(P.tickets, {}); }
  function saveTicket(ticket, threadId) {
    if (!ticket || !threadId) return;
    try {
      const m = ticketMap();
      m[String(ticket)] = threadId;
      m[String(ticket).toUpperCase()] = threadId;
      jwrite(P.tickets, m);
    } catch {}
  }
  function lookupTicket(ticket) {
    const t = String(ticket || '').trim();
    if (!t) return null;
    const m = ticketMap();
    if (m[t] || m[t.toUpperCase()]) return m[t] || m[t.toUpperCase()];
    // fallback: to_boss.jsonl history scan
    try {
      const lines = fs.readFileSync(P.toBoss, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i]);
          if (String(o.ticket || '').toUpperCase() === t.toUpperCase() && o.threadId) return o.threadId;
        } catch {}
      }
    } catch {}
    return null;
  }
  function latestMsgIdFor(threadId) {
    try {
      const lines = fs.readFileSync(P.toBoss, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i]);
          if (String(o.threadId) === String(threadId) && o.id) return o.id;
        } catch {}
      }
    } catch {}
    return null;
  }

  const hdr = (ticket, name) => `(#${ticket}${name ? ' · ' + name : ''})`;

  // ── forward handlers ──
  // SPEED (2026-09-24): Boss ko paigham foran mile — body pehle, ack foran,
  // AI cheezein (urgent-flag, quick replies) body ko block nahi kartin.
  async function handleText(item, ticket, name) {
    const text = String(item.text || '');
    const threadId = item.threadId;
    let body;
    if (text.length > 600) {
      const sum = await oneLineSummaryFast(text);
      body = sum
        ? `📝 *Khulasa (Web ${hdr(ticket, name)}):*\n${sum}\n_(poori baat mehfooz hai)_`
        : `📩 *Web ${hdr(ticket, name)}*\n${text.slice(0, 600)}…\n_(lambi baat ka khulasa nahi ban saka)_`;
    } else {
      // urgent-check ko 1.2s se zyada wait nahi — slow ho to plain body foran
      const urgent = await Promise.race([
        isUrgentFast(text),
        new Promise((r) => setTimeout(() => r(false), 1200)),
      ]);
      body = `${urgent ? '🔴 *URGENT* ' : ''}📩 *Web ${hdr(ticket, name)}*\n${text}`;
    }
    if (item.first) body += `\n\n_(nayi webchat thread)_`;
    if (item.wa) body += `\n📞 _jawab WhatsApp par chahiye: ${String(item.wa).slice(0, 40)}_`;
    await sendOwner({ text: body });
    appendAck(threadId, item.id, 'delivered'); // page ko foran ✓✓ — quick replies ka wait nahi
    // SPEED 2026-09-24: AI quick replies background mein (tick block nahi) —
    // Boss ko suggestions thori der mein mil jayengi, agla message nahi rukega.
    quickReplies(text).then(async (sug) => {
      if (sug.length === 3) {
        try { await sendOwner({ text: `⚡ _Jawab:_\n1️⃣ ${sug[0]}\n2️⃣ ${sug[1]}\n3️⃣ ${sug[2]}` }); } catch {}
        // NOTE: _ownerSends nahi barhate — background send hai, exactly-once
        // counter sirf tick-path ke sends ke liye hai (galat retry decision na ho).
        jwrite(P.last, { ticket, threadId, suggestions: sug, ts: Date.now() });
      }
    }).catch(() => {});
  }

  async function handleVoice(item, ticket, name) {
    const b64 = item.audio_b64 || item.audio || item.data || item.text;
    const threadId = item.threadId;
    if (!b64 || String(b64).length < 100) {
      console.log('[webchat] voice item mein audio nahi — skip');
      return;
    }
    const ts = Date.now();
    const tmpIn = path.join('/tmp', `webchat_v_${ts}.bin`);
    const tmpOgg = path.join('/tmp', `webchat_v_${ts}.ogg`);
    try {
      fs.writeFileSync(tmpIn, Buffer.from(String(b64), 'base64'));
      try {
        await execFileP('ffmpeg', ['-y', '-v', 'error', '-i', tmpIn, '-c:a', 'libopus', '-b:a', '48k', tmpOgg], { timeout: 60000 });
      } catch (fe) {
        // POISON-GUARD 2026-09-24: corrupt audio kabhi decode nahi hogi —
        // dobara koshish bekaar hai, is liye foran drop (queue block nahi).
        const pe = new Error('voice audio kharab — ffmpeg decode nakam: ' + (fe && fe.message ? fe.message : fe));
        pe.permanent = true;
        throw pe;
      }
      const ogg = fs.readFileSync(tmpOgg);
      await sendOwner({ audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true });
      appendAck(threadId, item.id, 'delivered'); // audio gaya = delivered; transcript ka wait nahi
      // SPEED 2026-09-24: transcript background mein (tick block nahi).
      // NOTE: tmpIn finally mein delete hota hai — is liye pehle copy bana lo.
      const tmpCopy = path.join('/tmp', `webchat_vt_${ts}.bin`);
      try { fs.copyFileSync(tmpIn, tmpCopy); } catch {}
      transcribeVoice(tmpCopy).then(async (heard) => {
        try { fs.unlinkSync(tmpCopy); } catch {}
        if (heard && heard.text) {
          try { await sendOwner({ text: `🎙️ *Web voice ${hdr(ticket, name)} — transcript:*\n${String(heard.text).slice(0, 1500)}` }); } catch {}
        } else {
          console.log('[webchat] voice transcript nahi ban saka — voice baghair transcript bheji');
        }
      }).catch(() => { try { fs.unlinkSync(tmpCopy); } catch {} });
    } finally {
      for (const f of [tmpIn, tmpOgg]) { try { fs.unlinkSync(f); } catch {} }
    }
  }

  async function handleRating(item, ticket, name) {
    const stars = Math.max(1, Math.min(5, parseInt(item.stars, 10) || 0)) || '?';
    await sendOwner({ text: `⭐ *Web rating ${hdr(ticket, name)}:* ${stars}/5` });
    appendAck(item.threadId, item.id, 'delivered');
  }

  async function handleOpt(item, ticket, name) {
    const m = String(item.text || '').trim().match(/^\[opt:([a-z0-9_]+)\]/i);
    const opt = (m && m[1] || 'help').toLowerCase();
    const threadId = item.threadId;
    // Deterministic jawab — AI nahi (hallucination-proof, foran).
    let guide = OPT_HELP;
    if (opt === 'features') guide = OPT_FEATURES;
    else if (opt === 'price' || opt === 'pricing') guide = OPT_PRICE;
    else if (opt === 'owner') guide = OPT_OWNER;
    appendLine(P.toWeb, {
      ts: Date.now(), threadId, type: 'text',
      text: guide || AI_FALLBACK,
    });
    if (opt === 'owner') {
      // Boss ko mukhtasir ittila — poora opt text forward nahi hota
      await sendOwner({ text: `📩 *Web ${hdr(ticket, name)}* _owner se baat karna chahta hai_` });
    }
    // AI-gate ne handle kar liya — baqi opts Boss ko forward NAHI (design decision)
    appendAck(threadId, item.id, 'delivered');
  }

  // ── idempotency: processed item.id cache (BUGFIX 2026-09-24 triple-reply) ──
  // tick() har 1s chalta hai, AI calls is se lambi hoti hain — overlapping ticks
  // same item dobara process kar lete thay. seen.json persistent hai (restart-safe).
  let _seenSet = null;
  function seenLoad() {
    try { const a = JSON.parse(fs.readFileSync(P.seen, 'utf8')); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function seenHas(id) {
    if (!_seenSet) _seenSet = new Set(seenLoad());
    return _seenSet.has(id);
  }
  function seenAdd(id) {
    if (!_seenSet) _seenSet = new Set(seenLoad());
    _seenSet.add(id);
    if (_seenSet.size > 3000) _seenSet = new Set([..._seenSet].slice(-2000));
    try { fs.writeFileSync(P.seen, JSON.stringify([..._seenSet])); } catch {}
  }

  // ── queue consumer ──
  // offset = {n: consumed lines, size: file size at last tick}; size guard se
  // truncate/rotate detect hoti hai (sirf off > lines.length kaafi nahi hota)
  function readOffset() {
    try {
      const o = JSON.parse(fs.readFileSync(P.offset, 'utf8'));
      if (o && typeof o.n === 'number') return { n: Math.max(0, o.n), size: Math.max(0, o.size || 0) };
    } catch {}
    try { // legacy plain-number format
      const n = Math.max(0, parseInt(fs.readFileSync(P.offset, 'utf8').trim(), 10) || 0);
      return { n, size: 0 };
    } catch { return { n: 0, size: 0 }; }
  }
  function writeOffset(n, size) {
    try { fs.writeFileSync(P.offset, JSON.stringify({ n, size })); } catch {}
  }

  // POISON-MESSAGE GUARD 2026-09-24: ek kharab item ki musalsal nakami poori
  // qataar ko rok deti thi — is liye har item ki nakam koshishon ki ginti.
  const _failCount = {};
  async function processItem(line) {
    let item;
    try { item = JSON.parse(line); } catch { console.log('[webchat] malformed line skip'); return 'drop'; }
    if (!item || typeof item !== 'object') return 'drop';
    const ticket = String(item.ticket || '').trim();
    const threadId = String(item.threadId || '').trim();
    if (!threadId) { console.log('[webchat] threadId missing — skip'); return 'drop'; }
    // TEST SAFETY: WTEST kabhi WhatsApp par nahi jata
    if (ticket === 'WTEST' || threadId.startsWith('test-')) {
      console.log('[webchat-test] dropped', ticket, threadId);
      if (item.id) appendAck(threadId, item.id, 'delivered');
      return 'drop';
    }
    const itemId = String(item.id || '');
    if (itemId && seenHas(itemId)) {
      console.log('[webchat] duplicate item skip:', itemId);
      return 'drop';
    }
    const blocked = jread(P.blocked, []);
    if (ticket && Array.isArray(blocked) && blocked.includes(ticket)) {
      console.log('[webchat] blocked ticket skip:', ticket);
      return 'drop'; // block = khamoshi; page ko ack nahi (jhoot nahi bolna)
    }
    let sendsBefore = _ownerSends; // EXACTLY-ONCE: is item mein kitne sends hue
    const name = String(item.name || '').slice(0, 40);
    const type = String(item.type || 'text');
    try {
      saveTicket(ticket, threadId);
      const t = String(item.text || '').trim();
      if (type === 'text' && /^\[opt:[a-z0-9_]+\]/i.test(t)) await handleOpt(item, ticket || 'W?', name);
      else if (type === 'text') await handleText(item, ticket || 'W?', name);
      else if (type === 'voice') await handleVoice(item, ticket || 'W?', name);
      else if (type === 'rating') await handleRating(item, ticket || 'W?', name);
      else { console.log('[webchat] unknown type skip:', type); }
      if (itemId) seenAdd(itemId);
      return 'ok';
    } catch (e) {
      // EXACTLY-ONCE (2026-09-24): agar WhatsApp send HO CHUKA phir error aaya
      // (masalan quickReplies ka AI timeout) to retry mat karo — warna Boss ko
      // same paigham dobara jayega (yehi spam tha). Sirf tab retry jab kuch
      // bheja hi nahi gaya (wahan duplicate ka khatra nahi).
      if (_ownerSends > sendsBefore) {
        console.error('[webchat] item fail AFTER send — no retry (already delivered):', e.message);
        if (itemId) seenAdd(itemId);
        return 'ok';
      }
      // POISON-MESSAGE GUARD (2026-09-24): pehle ek kharab voice (corrupt audio)
      // har tick fail ho kar offset ko hamesha ke liye rok deti thi — us ke
      // peeche qataar mein phanse tamam paigham Boss tak kabhi nahi pohanchtay
      // thay. Ab: permanent error foran drop; aam error 10 koshishon ke baad
      // drop (Boss ko mukhtasir ittila ke saath) — qataar kabhi nahi rukti.
      const failKey = itemId || ('raw:' + String(line).slice(0, 80));
      const typeLabel = type === 'voice' ? 'voice message' : type === 'text' ? 'paigham' : type;
      const dropPoison = async (why) => {
        console.error('[webchat] POISON drop —' + why + ':', e && e.message ? e.message : e);
        try { await sendOwner({ text: `⚠️ *Web ${hdr(ticket || 'W?', name)}* — ${typeLabel} nahi bheji ja saki (${why}).` }); } catch {}
        if (itemId) seenAdd(itemId);
        delete _failCount[failKey];
        return 'ok';
      };
      if (e && e.permanent) return dropPoison('file kharab thi');
      const tries = (_failCount[failKey] || 0) + 1;
      _failCount[failKey] = tries;
      if (tries >= 10) return dropPoison('10 koshishen nakam');
      console.error(`[webchat] item fail (koshish ${tries}/10, agle tick mein retry):`, e && e.message ? e.message : e);
      return 'retry';
    }
  }

  let ticking = false;
  async function tick() {
    if (ticking) return; // BUGFIX 2026-09-24: overlapping ticks = duplicate replies
    ticking = true;
    try {
      ensure();
      const ojid = ownerJid();
      if (!SOCK || !ojid) return; // sock/owner tayyar nahi — items qataar mein rehte hain
      const raw = fs.readFileSync(P.toBoss, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length);
      const fsize = Buffer.byteLength(raw, 'utf8');
      let { n: off, size: psize } = readOffset();
      if (off > lines.length || fsize < psize) off = 0; // file truncate/rotate hui
      for (let i = off; i < lines.length; i++) {
        const r = await processItem(lines[i]);
        if (r === 'retry') return; // offset na barhao — agle tick dobara
        off = i + 1;
        writeOffset(off, fsize);
      }
    } catch (e) { console.error('[webchat] tick error:', e.message); }
    finally { ticking = false; }
  }

  function start() {
    ensure();
    // presence default: file na ho to online=true (bot chal raha = available).
    // .wroffline isay false karta hai; dobara .wronline true.
    try { if (!fs.existsSync(P.presence)) jwrite(P.presence, { online: true, ts: Date.now() }); } catch {}
    if (timer) return;
    timer = setInterval(() => { tick().catch((e) => console.error('[webchat] tick crash:', e.message)); }, 1000);
    console.log('[webchat] poller start (1s) →', P.toBoss);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // ── Boss ka jawab → web (shared sender) ──
  async function sendWrReply(threadId, ticket, text, sock, msg, jid) {
    appendLine(P.toWeb, { ts: Date.now(), threadId, type: 'text', text: String(text).slice(0, 2000) });
    const lastId = latestMsgIdFor(threadId);
    if (lastId) appendAck(threadId, lastId, 'seen');
    await reply(sock, jid, msg, '✅ bhej diya');
  }

  // ── owner commands ──
  const commands = {
    wr: {
      desc: 'WebChat reply — .wr <ticket> <msg>',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const ticket = String(args[0] || '').trim();
        const text = args.slice(1).join(' ').trim();
        if (!ticket || !text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}wr* <ticket> <paigham>`);
        const threadId = lookupTicket(ticket);
        if (!threadId) return reply(sock, jid, msg, `❌ Ticket *${ticket}* nahi mila.`);
        await sendWrReply(threadId, ticket.toUpperCase(), text, sock, msg, jid);
      },
    },
    wrblock: {
      desc: 'WebChat ticket block — .wrblock <ticket>',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const ticket = String(args[0] || '').trim().toUpperCase();
        if (!ticket) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}wrblock* <ticket>`);
        const b = jread(P.blocked, []);
        const arr = Array.isArray(b) ? b : [];
        if (!arr.includes(ticket)) { arr.push(ticket); jwrite(P.blocked, arr); }
        return reply(sock, jid, msg, '🚫 block ho gaya');
      },
    },
    wronline: {
      desc: 'WebChat online — .wronline',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        jwrite(P.presence, { online: true, ts: Date.now() });
        return reply(sock, jid, msg, '🟢 WebChat *online* — visitors dekh sakte hain aap mojood hain 💗');
      },
    },
    wroffline: {
      desc: 'WebChat offline — .wroffline',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        jwrite(P.presence, { online: false, ts: Date.now() });
        return reply(sock, jid, msg, '⚫ WebChat *offline* — ab AI-gate jawab dega.');
      },
    },
  };

  // ── hook: owner ke bare "1"/"2"/"3" → aakhri AI suggestions mein se bhejo ──
  async function webchatHook(sock, msg, sender, jid) {
    try {
      if (isOwnMsgId(msg.key && msg.key.id)) return false; // bot ke apne msg ka echo — loop protection
      const t = String(getText(msg) || '').trim();
      if (t !== '1' && t !== '2' && t !== '3') return false;
      if (!isOwnerMsg(msg, sender, jid)) return false; // gair-owner → khamoshi se ignore
      const last = jread(P.last, null);
      if (!last || !Array.isArray(last.suggestions) || !last.threadId) return false;
      if (Date.now() - (last.ts || 0) > 10 * 60 * 1000) return false; // 10 min purana
      const s = last.suggestions[parseInt(t, 10) - 1];
      if (!s) return false;
      await sendWrReply(last.threadId, last.ticket, s, sock, msg, jid);
      return true;
    } catch { return false; }
  }

  return {
    commands, webchatHook, setSock, start, stop, webchatUrl,
    _paths: P,
    _test: { processItem, tick, lookupTicket, latestMsgIdFor, handleOpt, handleText, handleVoice, handleRating, readOffset, writeOffset },
  };
}

module.exports = { buildWebchat, webchatUrl };
