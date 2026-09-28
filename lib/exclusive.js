// ═══════════════════════════════════════════════════════════════
// NEXORA EXCLUSIVE PACK — Phase 1 (Boss order 2026-09-27)
// 1. 🎯 Lead Funnel builder — owner multi-step keyword flows banaye;
//    customer keyword bheje → guided Q&A → jawab owner inbox mein lead card.
// 2. 🏷️ Mini-CRM — customer labels + private owner notes.
// Factory: buildExclusive(deps) → { commands, exclusiveHook }
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════
// Module-level shared (Phase 2+3) — index.js (poll votes) aur
// lib/commands.js (briefing tick, voiceai hook) bhi istemal karte hain.
// ═══════════════════════════════════════════════════════════════
const XDATA = path.join(__dirname, '..', 'data');
const VOICEAI_FILE = path.join(XDATA, 'voiceai.json');
const PMENU_FILE = path.join(XDATA, 'pmenus.json');
const BRIEF_FILE = path.join(XDATA, 'briefing.json');
const xjread = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const xjwrite = (f, v) => { try { fs.mkdirSync(XDATA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); } catch {} };

// 🎙️ voiceai: is chat mein AI ka jawab voice note mein jayega?
function voiceaiOn(jid) {
  try { const v = xjread(VOICEAI_FILE, {}); return !!(v && v[jid]); } catch { return false; }
}

// ── 📊 poll-menu: 2-level interactive polls (votes encrypted aate hain!) ──
// NOTE (2026-09-27): is fork mein Baileys ka messages.update/pollUpdates rasta
// COMMENT-OUT hai — vote messages.upsert mein pollUpdateMessage ban kar aata hai
// aur vote ENCRYPTED hota hai. decryptPollVote + poll ka messageSecret chahiye
// (messageSecret .pmenu bhejte waqt save hota hai).
const crypto = require('crypto');
let _decryptPollVote = null;
try { _decryptPollVote = require('@chaeulso/baileys').decryptPollVote; } catch {}
let _xIsOwner = null; // buildExclusive set karega
let _xHandleMessage = null; // vote → command run (Boss: "vote karo, type na karna pare")
let _xPnOfLid = null; // LID → PN reverse (voter sirf LID mein aata hai)
const sha256hex = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const xbytes = (v) => {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  try { return Buffer.from(String(v), 'base64'); } catch { return null; }
};
const jidStrip = (j) => String(j || '').split(':')[0].split('@')[0].toLowerCase();
// JID normalize: device suffix hatao (9234...:10@s.whatsapp.net → 9234...@s.whatsapp.net)
// decrypt ke HMAC/AAD mein exact string chahiye — :10 wala form hamesha fail hota hai
const jidNorm = (j) => String(j || '').replace(/:\d+@/, '@');

// 📊 Level-1/2: CURATED categories — buildMenu ke Boss-approved boxes se.
// Har command SAHI category mein — regex guess nahi (2026-09-27, Boss: "proper category")
let _xMenuCats = null; // buildExclusive set karega (getMenuCategories dep)
// Naye exclusive commands abhi .menu mein nahi — poll ke liye alag box
const EXCLUSIVE_POLL_CMDS = ['funnel', 'clabel', 'clabels', 'cnote', 'cnotes', 'voiceai', 'pmenu', 'briefing', 'find'];
function firstEmoji(s) {
  try { const m = String(s || '').match(/(\p{Extended_Pictographic})/u); return m ? m[1] : '▫️'; } catch { return '▫️'; }
}
// L1: category list — 👑 OWNER box sirf owner ko; 🎯 EXCLUSIVE sab ko (andar owner-only filter lagta hai)
function pollCatList(voterIsOwner) {
  const boxes = (typeof _xMenuCats === 'function') ? (_xMenuCats() || []) : [];
  const list = boxes
    .filter(b => !/👑/.test(b.label) || voterIsOwner)
    .map(b => ({ label: b.label, cmds: b.cmds }));
  list.push({ label: '🎯 EXCLUSIVE', cmds: EXCLUSIVE_POLL_CMDS.slice() });
  return list;
}
// L2: category ke commands — curated list ∩ live registry (hidden kabhi nahi; owner-only sirf effOwner ko)
// Order = menu ka curated order (alphabetical sort nahi — Boss ki tarteeb)
function catCmdList(label, effOwner) {
  if (!_xCommands) return [];
  let names = [];
  if (label === '🎯 EXCLUSIVE') names = EXCLUSIVE_POLL_CMDS.slice();
  else {
    const boxes = (typeof _xMenuCats === 'function') ? (_xMenuCats() || []) : [];
    const b = boxes.find(x => x.label === label);
    if (b) names = b.cmds.slice();
  }
  const out = [];
  for (const name of names) {
    const c = _xCommands[name];
    if (!c || c.hidden) continue;
    if (c.owner && !effOwner) continue;
    out.push({ name, desc: String(c.desc || '').slice(0, 90) });
  }
  return out;
}
// 🔐 sirf owner ke liye: hidden (secret) commands ka alag poll
function hiddenCommands() {
  if (!_xCommands) return [];
  const out = [];
  for (const name of Object.keys(_xCommands)) {
    const c = _xCommands[name];
    if (!c || !c.hidden) continue;
    out.push({ name, desc: String(c.desc || '').slice(0, 90) });
    if (out.length >= 12) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
// 📊 command-poll bhejo + track karo (dobara istemal ke liye helper)
async function sendCmdPoll(sock, chat, cmds, title, menus) {
  const labels = cmds.map(c => `${firstEmoji(c.desc)} ${c.name}`);
  const sent = await sock.sendMessage(chat, {
    poll: { name: title, values: labels, selectableCount: 1 },
  });
  const mid2 = sent && sent.key && sent.key.id;
  if (!mid2) return;
  const secret = sent.message && sent.message.messageContextInfo && sent.message.messageContextInfo.messageSecret;
  const map2 = {};
  cmds.forEach((c, i) => { map2[sha256hex(labels[i])] = c.name; });
  menus[mid2] = {
    jid: chat, at: Date.now(), seen: {}, type: 'cmds',
    encKey: secret ? Buffer.from(secret).toString('base64') : null,
    creatorId: sock.user && sock.user.id, creatorLid: sock.user && sock.user.lid,
    map: map2, cmds: cmds.map(c => ({ name: c.name, desc: c.desc })),
  };
}
let _xCommands = null; // buildExclusive set karega
const pdbg = (s) => { try { fs.appendFileSync('/tmp/polldebug.log', new Date().toISOString() + ' ' + s + '\n'); } catch {} };

// 📊 poll vote interceptor — messages.upsert se (pollUpdateMessage, encrypted)
async function handlePollVote(sock, messages) {
  try {
    const arr = Array.isArray(messages) ? messages : [];
    if (!arr.length || !_decryptPollVote) return;
    const menus = xjread(PMENU_FILE, {});
    let dirty = false;
    const meId = (sock && sock.user && (sock.user.lid || sock.user.id)) || '';
    for (const msg of arr) {
      const mm = (msg && msg.message) || {};
      const pum = mm.pollUpdateMessage
        || (mm.ephemeralMessage && mm.ephemeralMessage.message && mm.ephemeralMessage.message.pollUpdateMessage);
      if (pum && !pum.vote) pdbg(`pum without vote mid=${pum.pollCreationMessageKey && pum.pollCreationMessageKey.id}`);
      if (!pum || !pum.vote) continue;
      const mid = pum.pollCreationMessageKey && pum.pollCreationMessageKey.id;
      pdbg(`vote seen mid=${mid} fromMe=${msg.key && msg.key.fromMe} participant=${msg.key && msg.key.participant} remoteJid=${msg.key && msg.key.remoteJid}`);
      const m = mid && menus[mid];
      if (!m || !m.encKey) { pdbg(`no tracked menu for ${mid}`); continue; }
      if (Date.now() - (m.at || 0) > 10 * 60 * 1000) { delete menus[mid]; dirty = true; continue; }
      const chat = (msg.key && msg.key.remoteJid) || m.jid;
      // voter: group mein participant, DM/self mein khud
      const rawVoter = (msg.key && (msg.key.participant || (msg.key.fromMe ? meId : msg.key.remoteJid))) || '';
      const voterKey = jidStrip(rawVoter) || 'self';
      // 🗳️ voter ki pehchan: LID → PN resolve (owner check + command dispatch ke liye)
      const fromMeVote = !!(msg.key && msg.key.fromMe);
      let voterPnJid = null;
      try {
        const vd = String(rawVoter || '').split('@')[0].split(':')[0].replace(/\D/g, '');
        const vpn = _xPnOfLid ? _xPnOfLid(vd) : null;
        if (vpn && vpn.length >= 7) voterPnJid = vpn + '@s.whatsapp.net';
      } catch {}
      const voterIsOwner = fromMeVote
        ? !!(_xIsOwner && (_xIsOwner(sock.user && sock.user.id) || _xIsOwner(sock.user && sock.user.lid)))
        : !!(_xIsOwner && (_xIsOwner(rawVoter) || (voterPnJid && _xIsOwner(voterPnJid))));
      // decrypt — creator/voter ke mukhtalif JID forms try karo (LID vs PN)
      const encKey = xbytes(m.encKey);
      if (!encKey) continue;
      const rawCreators = [m.creatorId, m.creatorLid, sock.user && sock.user.id, sock.user && sock.user.lid].filter(Boolean);
      const rawVoters = [rawVoter, meId].filter(Boolean);
      const creatorCands = [...new Set([...rawCreators, ...rawCreators.map(jidNorm)])];
      const voterCands = [...new Set([...rawVoters, ...rawVoters.map(jidNorm)])];
      pdbg(`decrypt try: creators=${creatorCands.join('|')} voters=${voterCands.join('|')} encKeyLen=${encKey.length}`);
      let dec = null, decErr = '';
      outer:
      for (const cj of creatorCands) {
        for (const vj of voterCands) {
          try {
            dec = _decryptPollVote(
              { encPayload: xbytes(pum.vote.encPayload), encIv: xbytes(pum.vote.encIv) },
              { pollCreatorJid: cj, pollMsgId: mid, pollEncKey: encKey, voterJid: vj }
            );
            if (dec) { pdbg(`decrypt OK cj=${cj} vj=${vj}`); break outer; }
          } catch (e) { decErr = String((e && e.message) || e).slice(0, 80); }
        }
      }
      if (!dec) pdbg(`decrypt FAIL all: ${decErr}`);
      if (!dec || !dec.selectedOptions || !dec.selectedOptions.length) continue;
      const hash0 = Buffer.from(dec.selectedOptions[0]).toString('hex');
      const hitKey = m.map && m.map[hash0];
      if (!hitKey) continue;
      // 🧠 Hoshiyar dedup: WhatsApp aik hi vote 4-6 baar bhejta hai → SAME voter + SAME option
      // 60s ke andar dobara aaye to skip; NAYI vote (mukhtalif option) foran process — koi wait nahi.
      m.seen = m.seen || {};
      const lastV = m.seen[voterKey];
      const lastHash = lastV && typeof lastV === 'object' ? lastV.hash : null;
      const lastAt = lastV && typeof lastV === 'object' ? lastV.at : (typeof lastV === 'number' ? lastV : 0);
      if (lastHash === hash0 && Date.now() - lastAt < 60000) continue; // duplicate delivery
      m.seen[voterKey] = { hash: hash0, at: Date.now() }; dirty = true;
      try {
        if (m.type === 'cats') {
          // Level-2: CURATED category ke commands — 12-per-poll chunks (koi command miss na ho)
          // 🔒 Group mein owner/hidden commands poll mein NAZAR bhi nahi ayenge (sirf DM mein) — Boss rule
          const effOwner = voterIsOwner && !/@g\.us$/.test(chat || '');
          const all = catCmdList(hitKey, effOwner);
          if (!all.length) { await sock.sendMessage(chat, { text: `❌ Is category mein koi command nahi mili 💗` }); continue; }
          const pages = Math.ceil(all.length / 12);
          for (let pi = 0; pi < pages; pi++) {
            const title = pages > 1 ? `💗 ${hitKey} (${pi + 1}/${pages}) — vote karo, foran chalegi` : `💗 ${hitKey} — vote karo, foran chalegi`;
            await sendCmdPoll(sock, chat, all.slice(pi * 12, pi * 12 + 12), title, menus);
          }
          if (/EXCLUSIVE/.test(hitKey) && effOwner) {
            const hid = hiddenCommands();
            const hpages = Math.ceil(hid.length / 12);
            for (let pi = 0; pi < hpages; pi++)
              await sendCmdPoll(sock, chat, hid.slice(pi * 12, pi * 12 + 12),
                hpages > 1 ? `🔐 Secret commands (${pi + 1}/${hpages}) — vote karo` : `🔐 Secret commands — vote karo, foran chalegi`, menus);
          }
        } else if (m.type === 'cmds') {
          // 🔒 vote→run se pehle khamosh pre-check: owner/hidden command sirf owner chala sake (koi reply nahi — khabar tak na ho)
          const cmdDef = _xCommands && _xCommands[hitKey];
          if (cmdDef && (cmdDef.owner || cmdDef.hidden) && !voterIsOwner) { pdbg(`vote-run denied cmd=.${hitKey} voter=${voterKey}`); continue; }
          // 🗳️ Vote = command RUN — jaise voter ne khud type kiya ho (Boss: "vote karo, type na karna pare")
          if (!_xHandleMessage) { pdbg('vote-run: no handleMessage'); continue; }
          try {
            const fk = { remoteJid: chat, id: 'pv' + Date.now().toString(36) + Math.floor(Math.random() * 1e6) };
            if (fromMeVote) { fk.fromMe = true; }
            else { fk.fromMe = false; fk.participant = voterPnJid || rawVoter || undefined; }
            const fakeMsg = { key: fk, message: { conversation: '.' + hitKey }, messageTimestamp: Math.floor(Date.now() / 1000) };
            await _xHandleMessage(sock, fakeMsg);
            pdbg(`vote-run OK cmd=.${hitKey} voter=${voterKey}`);
          } catch (e) { pdbg('vote-run fail: ' + String((e && e.message) || e).slice(0, 100)); }
        }
      } catch (e) { pdbg('pollvote branch err: ' + String((e && e.message) || e).slice(0, 120)); }
    }
    if (dirty) xjwrite(PMENU_FILE, menus);
  } catch {}
}

// ── 🌅 briefing builder (best-effort: jo fail ho, skip) ──
async function buildBriefing() {
  const lines = [];
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' }));
  const days = ['Itwar', 'Peer', 'Mangal', 'Budh', 'Jumeraat', 'Juma', 'Hafta'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  lines.push(`🌅 *Subah Bakhair!* 💗`);
  lines.push(`📅 ${days[now.getDay()]} — ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`);
  try { // mausam (Lahore)
    const w = await (await fetch('https://api.open-meteo.com/v1/forecast?latitude=31.5204&longitude=74.3587&current=temperature_2m&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FKarachi', { signal: AbortSignal.timeout(15000) })).json();
    const t = w && w.current && w.current.temperature_2m;
    if (t !== undefined && t !== null)
      lines.push(`\n🌤️ *Mausam (Lahore):* ${Math.round(t)}°C · aaj ${Math.round(w.daily.temperature_2m_min[0])}°–${Math.round(w.daily.temperature_2m_max[0])}°C`);
  } catch {}
  try { // namaz
    const j = await (await fetch('https://api.aladhan.com/v1/timingsByCity?city=Lahore&country=Pakistan&method=2', { signal: AbortSignal.timeout(15000) })).json();
    const t = j && j.data && j.data.timings;
    if (t && t.Fajr) {
      const hh = (s) => String(s || '').split(' ')[0];
      lines.push(`\n🕌 *Namaz:* Fajr ${hh(t.Fajr)} · Dhuhr ${hh(t.Dhuhr)} · Asr ${hh(t.Asr)} · Maghrib ${hh(t.Maghrib)} · Isha ${hh(t.Isha)}`);
    }
  } catch {}
  try { // khabrein (top 3)
    const r = await fetch('https://news.google.com/rss?hl=en-PK&gl=PK&ceid=PK:en', { signal: AbortSignal.timeout(15000) });
    const xml = await r.text();
    const titles = [];
    const re = /<item>[\s\S]*?<title>(.*?)<\/title>/g;
    let mm;
    while ((mm = re.exec(xml)) !== null && titles.length < 3) {
      const t = mm[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").trim().slice(0, 120);
      if (t) titles.push(t);
    }
    if (titles.length) lines.push(`\n📰 *Khabrein:*\n` + titles.map(t => `• ${t}`).join('\n'));
  } catch {}
  try { // reminders
    const rs = xjread(path.join(XDATA, 'reminders.json'), []);
    const n = Array.isArray(rs) ? rs.length : 0;
    if (n) lines.push(`\n⏰ *Reminders pending:* ${n}`);
  } catch {}
  lines.push(`\n⚡ _NEXORA-MD briefing_ 💗`);
  return lines.join('\n');
}

// 🌅 briefing tick — har 30s scheduler se; claim-first taake duplicate na jaye
async function briefingTick(sock) {
  try {
    const b = xjread(BRIEF_FILE, null);
    if (!b || !b.time || !/^\d{1,2}:\d{2}$/.test(b.time)) return;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Karachi' }));
    const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (b.lastSent === today) return;
    const parts = b.time.split(':').map(Number);
    if (now.getHours() < parts[0] || (now.getHours() === parts[0] && now.getMinutes() < parts[1])) return;
    const me = String((sock.user && sock.user.id) || '').split(':')[0].split('@')[0] || 'x';
    xjwrite(BRIEF_FILE, { ...b, lastSent: today, sentBy: me, sentAt: Date.now() }); // claim
    const re = xjread(BRIEF_FILE, null);
    if (!re || re.sentBy !== me) return; // kisi aur process ne claim kar liya
    let ownerJid = null;
    try {
      const d = String(fs.readFileSync(path.join(__dirname, '..', '.owner'), 'utf8')).replace(/\D/g, '');
      if (d.length >= 7) ownerJid = d + '@s.whatsapp.net';
    } catch {}
    if (!ownerJid) return;
    const text = await buildBriefing();
    try { await sock.sendMessage(ownerJid, { text }); } catch {}
  } catch {}
}

function buildExclusive(deps) {
  const { reply, config, isOwner, isOwnerMsg, ctxOf, getText, num, aiChatOn } = deps;
  const allCommands = deps.commands; // .find ke liye (runtime par poora set)
  _xCommands = allCommands; // 📊 poll-menu level-2 ke liye
  _xMenuCats = (typeof deps.getMenuCategories === 'function') ? deps.getMenuCategories : null; // 📊 curated categories
  _xIsOwner = (typeof isOwner === 'function') ? isOwner : null;
  _xHandleMessage = (typeof deps.handleMessage === 'function') ? deps.handleMessage : null;
  _xPnOfLid = (typeof deps.pnDigitsOfLid === 'function') ? deps.pnDigitsOfLid : null;
  const P = config.prefix || '.';

  // ── storage (data/ — baqi features wali convention) ──
  const DATA = path.join(__dirname, '..', 'data');
  const FUNNEL_FILE = path.join(DATA, 'funnels.json');
  const FSESS_FILE = path.join(DATA, 'funnel_sessions.json');
  const CRM_FILE = path.join(DATA, 'crm.json');
  const jread = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const jwrite = (f, v) => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); } catch {} };

  const ownerJid = () => {
    const d = String(num(config.owner || '') || '').replace(/\D/g, '');
    return d.length >= 7 ? d + '@s.whatsapp.net' : null;
  };
  const cleanName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
  const esc = (s) => String(s || '').slice(0, 500);

  // ── CRM target: number arg > quoted sender > current DM ──
  function crmTarget(msg, jid, maybeNum) {
    const d = String(maybeNum || '').replace(/\D/g, '');
    if (d.length >= 7) return d;
    try {
      const qp = ctxOf(msg)?.participant;
      if (qp) { const q = String(num(qp) || '').replace(/\D/g, ''); if (q.length >= 7) return q; }
    } catch {}
    if (!String(jid || '').endsWith('@g.us')) {
      const c = String(num(jid) || '').replace(/\D/g, '');
      if (c.length >= 7) return c;
    }
    return null;
  }
  const firstIsNum = (a) => String(a || '').replace(/\D/g, '').length >= 7;

  const commands = {

    // ── 🎯 FUNNEL MANAGER ──
    funnel: {
      desc: '🎯 Lead funnel — customer se step-by-step details lo',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const sub = String(args[0] || '').toLowerCase();
        const funnels = jread(FUNNEL_FILE, {});

        // .funnel → help + list
        if (!sub || sub === 'help' || sub === 'list') {
          const names = Object.keys(funnels);
          let out = `🎯 *Funnel Manager* 💗\n\n` +
            `*${P}funnel new <naam>* — naya funnel\n` +
            `*${P}funnel ask <naam> <sawaal>* — sawal add karo\n` +
            `*${P}funnel key <naam> <lafz>* — trigger lafz (default: naam)\n` +
            `*${P}funnel on <naam>* / *${P}funnel off <naam>*\n` +
            `*${P}funnel leads <naam>* — pakri hui leads\n` +
            `*${P}funnel del <naam>* — delete\n\n`;
          out += names.length
            ? `📋 *Funnels (${names.length}):*\n` + names.map(n => {
              const f = funnels[n];
              return `${f.on ? '🟢' : '🔴'} *${n}* — key: _${f.keyword}_ · ${f.questions.length} sawal · ${f.leads.length} leads`;
            }).join('\n')
            : `_Abhi koi funnel nahi — *${P}funnel new order* se shuru karo!_`;
          await reply(sock, jid, msg, out);
          return;
        }

        const name = cleanName(args[1]);
        if (!name) { await reply(sock, jid, msg, `❌ Naam to batao na — misal: *${P}funnel new order* 💗`); return; }

        if (sub === 'new') {
          if (funnels[name]) { await reply(sock, jid, msg, `⚠️ *${name}* pehle se hai. Sawal add karne ke liye: *${P}funnel ask ${name} <sawaal}*`); return; }
          funnels[name] = { name, keyword: name, on: false, questions: [], leads: [], created: Date.now() };
          jwrite(FUNNEL_FILE, funnels);
          await reply(sock, jid, msg, `🎯 *Funnel _${name}_ ban gaya!* 💗\n\nAb sawal add karo:\n*${P}funnel ask ${name} Aap ka naam kya hai?*\n\nPhir on karo: *${P}funnel on ${name}*`);
          return;
        }

        const f = funnels[name];
        if (!f) { await reply(sock, jid, msg, `❌ *${name}* naam ka funnel nahi mila. *${P}funnel* likh kar list dekho 💗`); return; }

        if (sub === 'ask') {
          const q = args.slice(2).join(' ').trim().slice(0, 300);
          if (!q) { await reply(sock, jid, msg, `❌ Sawal to likho — misal: *${P}funnel ask ${name} Aap ka sheher?* 💗`); return; }
          f.questions.push(q);
          jwrite(FUNNEL_FILE, funnels);
          await reply(sock, jid, msg, `✅ Sawal ${f.questions.length} add ho gaya:\n_"${q}"_\n\n${f.on ? '🟢 Funnel live hai!' : `On karne ke liye: *${P}funnel on ${name}*`}`);
          return;
        }
        if (sub === 'key') {
          const k = args.slice(2).join(' ').trim().toLowerCase().slice(0, 40);
          if (!k) { await reply(sock, jid, msg, `❌ Trigger lafz likho — misal: *${P}funnel key ${name} order* 💗`); return; }
          f.keyword = k;
          jwrite(FUNNEL_FILE, funnels);
          await reply(sock, jid, msg, `🔑 *${name}* ka trigger lafz: _${k}_\n\nCustomer jab ye lafz bheje ga, funnel shuru ho jayega 💗`);
          return;
        }
        if (sub === 'on' || sub === 'off') {
          if (sub === 'on' && !f.questions.length) {
            await reply(sock, jid, msg, `⚠️ Pehle kam az kam aik sawal add karo: *${P}funnel ask ${name} <sawaal>* 💗`);
            return;
          }
          f.on = sub === 'on';
          jwrite(FUNNEL_FILE, funnels);
          await reply(sock, jid, msg, f.on
            ? `🟢 *${name}* live ho gaya! 🎯\n\nCustomer jab _${f.keyword}_ bheje ga to main khud us se ${f.questions.length} sawal puchungi 💗`
            : `🔴 *${name}* band kar diya.`);
          return;
        }
        if (sub === 'leads') {
          if (!f.leads.length) { await reply(sock, jid, msg, `📭 *${name}* mein abhi koi lead nahi aayi. Thora sabar karo 💗`); return; }
          const last = f.leads.slice(-10).reverse();
          let out = `🎯 *Leads — ${name}* (${f.leads.length})\n\n`;
          out += last.map((l, i) => {
            const d = new Date(l.at);
            const dt = `${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
            const qa = f.questions.map((q, qi) => `  • _${q}_\n    → ${esc(l.answers[qi] || '-')}`).join('\n');
            return `*${i + 1}.* 👤 ${l.from} · 🕐 ${dt}\n${qa}`;
          }).join('\n\n');
          await reply(sock, jid, msg, out.slice(0, 3500));
          return;
        }
        if (sub === 'del' || sub === 'delete') {
          delete funnels[name];
          jwrite(FUNNEL_FILE, funnels);
          const sess = jread(FSESS_FILE, {});
          for (const k of Object.keys(sess)) if (sess[k]?.name === name) delete sess[k];
          jwrite(FSESS_FILE, sess);
          await reply(sock, jid, msg, `🗑️ Funnel *${name}* delete kar diya.`);
          return;
        }
        await reply(sock, jid, msg, `❌ Samajh nahi aaya — *${P}funnel* likh kar tareeqa dekho 💗`);
      },
    },

    // ── 🏷️ CRM: label ──
    clabel: {
      desc: '🏷️ Customer par label lagao (lead/trial/paid/vip)',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const a0num = firstIsNum(args[0]);
        const target = crmTarget(msg, jid, a0num ? args[0] : null);
        const label = (a0num ? args.slice(1) : args).join(' ').trim().toLowerCase().slice(0, 24);
        if (!target) { await reply(sock, jid, msg, `❌ Customer samajh nahi aaya — number likho ya us ke message par reply karo 💗\nMisal: *${P}clabel 923001234567 paid*`); return; }
        if (!label) { await reply(sock, jid, msg, `❌ Label to batao — misal: *${P}clabel ${target} trial* 💗`); return; }
        const crm = jread(CRM_FILE, {});
        crm[target] = crm[target] || { notes: [] };
        if (label === 'clear') {
          delete crm[target].label;
          jwrite(CRM_FILE, crm);
          await reply(sock, jid, msg, `🏷️ ${target} ka label hata diya.`);
          return;
        }
        crm[target].label = label;
        jwrite(CRM_FILE, crm);
        await reply(sock, jid, msg, `🏷️ *${target}* → label: *${label}* ✅`);
      },
    },

    clabels: {
      desc: '🏷️ Sab labeled customers ki list',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const crm = jread(CRM_FILE, {});
        const rows = Object.keys(crm).filter(k => crm[k].label);
        if (!rows.length) { await reply(sock, jid, msg, `📭 Abhi kisi par label nahi — *${P}clabel <number> <label>* se shuru karo 💗`); return; }
        let out = `🏷️ *Labeled Customers* (${rows.length})\n\n`;
        out += rows.map(k => `👤 ${k} — *${crm[k].label}*${crm[k].notes?.length ? ` (${crm[k].notes.length} notes)` : ''}`).join('\n');
        await reply(sock, jid, msg, out.slice(0, 3500));
      },
    },

    // ── 📝 CRM: notes ──
    cnote: {
      desc: '📝 Customer ke liye private note likho',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const a0num = firstIsNum(args[0]);
        const target = crmTarget(msg, jid, a0num ? args[0] : null);
        const text = (a0num ? args.slice(1) : args).join(' ').trim().slice(0, 500);
        if (!target) { await reply(sock, jid, msg, `❌ Customer samajh nahi aaya — number likho ya us ke message par reply karo 💗`); return; }
        if (!text) { await reply(sock, jid, msg, `❌ Note to likho — misal: *${P}cnote ${target} 500 advance mil gaya* 💗`); return; }
        const crm = jread(CRM_FILE, {});
        crm[target] = crm[target] || { notes: [] };
        crm[target].notes = crm[target].notes || [];
        crm[target].notes.push({ t: Date.now(), text });
        jwrite(CRM_FILE, crm);
        await reply(sock, jid, msg, `📝 Note save ho gaya — *${target}* ✅`);
      },
    },

    cnotes: {
      desc: '📝 Customer ke private notes dekho',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const a0num = firstIsNum(args[0]);
        const target = crmTarget(msg, jid, a0num ? args[0] : null);
        const rest = (a0num ? args.slice(1) : args).join(' ').trim().toLowerCase();
        if (!target) { await reply(sock, jid, msg, `❌ Customer samajh nahi aaya — number likho ya us ke message par reply karo 💗`); return; }
        const crm = jread(CRM_FILE, {});
        const rec = crm[target];
        if (rest === 'clear') {
          if (rec) rec.notes = [];
          jwrite(CRM_FILE, crm);
          await reply(sock, jid, msg, `🗑️ *${target}* ke notes saaf kar diye.`);
          return;
        }
        if (!rec?.notes?.length) { await reply(sock, jid, msg, `📭 *${target}* ke liye koi note nahi — *${P}cnote ${target} <note>* se likho 💗`); return; }
        let out = `📝 *Notes — ${target}*${rec.label ? ` 🏷️ ${rec.label}` : ''}\n\n`;
        out += rec.notes.slice(-10).reverse().map((n, i) => {
          const d = new Date(n.t);
          return `*${i + 1}.* 🕐 ${d.getDate()}/${d.getMonth() + 1} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}\n   ${esc(n.text)}`;
        }).join('\n\n');
        await reply(sock, jid, msg, out.slice(0, 3500));
      },
    },

    // ── 🎙️ VOICE AI (Phase 2a) ──
    voiceai: {
      desc: '🎙️ AI ka jawab voice note mein (is chat mein)',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const v = String(args[0] || '').toLowerCase();
        const cur = voiceaiOn(jid);
        if (!v) {
          await reply(sock, jid, msg, `🎙️ *Voice AI* abhi *${cur ? 'ON ✅' : 'OFF ⛔'}* hai 💗\n\n*${P}voiceai on* — is chat mein AI ka jawab voice note mein aayega\n*${P}voiceai off* — wapas text mein`);
          return;
        }
        if (v === 'on') {
          const st = xjread(VOICEAI_FILE, {}); st[jid] = true; xjwrite(VOICEAI_FILE, st);
          try { if (aiChatOn) aiChatOn(jid); } catch {} // ye toggle hi AI activation hai
          await reply(sock, jid, msg, `🎙️ *Voice AI: ✅ ON* 💗\n\nAb is chat mein mera jawab *voice note* mein aayega! 🗣️`);
          return;
        }
        if (v === 'off') {
          const st = xjread(VOICEAI_FILE, {}); delete st[jid]; xjwrite(VOICEAI_FILE, st);
          await reply(sock, jid, msg, `🎙️ *Voice AI: ⛔ OFF*\n\nAb jawab text mein aayega.`);
          return;
        }
        await reply(sock, jid, msg, `❌ *${P}voiceai on* ya *${P}voiceai off* likho 💗`);
      },
    },

    // ── 📊 POLL MENU (Phase 2b) ──
    pmenu: {
      desc: '📊 Interactive poll menu bhejo (vote → command foran chalegi)',
      owner: true,
      run: async (sock, msg, args, { jid, sender }) => {
        try {
          // 📊 Curated categories (Boss-approved .menu boxes) — 12-per-poll chunks
          const voterIsOwner = isOwnerMsg(msg, sender, jid);
          const cats = pollCatList(voterIsOwner);
          const menus = xjread(PMENU_FILE, {});
          for (const k of Object.keys(menus)) if (Date.now() - (menus[k].at || 0) > 10 * 60 * 1000) delete menus[k];
          for (let ci = 0; ci < cats.length; ci += 12) {
            const chunk = cats.slice(ci, ci + 12);
            const labels = chunk.map(c => c.label);
            const pages = Math.ceil(cats.length / 12);
            const sent = await sock.sendMessage(jid, {
              poll: { name: pages > 1 ? `🌟 NEXORA-MD — category chuno (${ci / 12 + 1}/${pages}) 💗` : '🌟 NEXORA-MD — category par vote karo 💗', values: labels, selectableCount: 1 },
            });
            const mid = sent && sent.key && sent.key.id;
            if (!mid) continue;
            const secret = sent.message && sent.message.messageContextInfo && sent.message.messageContextInfo.messageSecret;
            const map = {};
            chunk.forEach((c, i) => { map[sha256hex(labels[i])] = c.label; });
            menus[mid] = {
              jid, at: Date.now(), seen: {}, type: 'cats',
              encKey: secret ? Buffer.from(secret).toString('base64') : null,
              creatorId: sock.user && sock.user.id, creatorLid: sock.user && sock.user.lid,
              map,
            };
          }
          xjwrite(PMENU_FILE, menus);
          await reply(sock, jid, msg, `📊 *Poll menu bhej diya!* 💗\n\n1️⃣ Category par vote karo → us ke commands ka poll ayega\n2️⃣ Command par vote karo → **foran chalegi** ⚡\n(10 minute valid)`);
        } catch { await reply(sock, jid, msg, `❌ Poll nahi bheja ja saka, dobara try karo.`); }
      },
    },

    // ── 🔍 SMART HELP (Phase 3a) ──
    find: {
      desc: '🔍 Alfaz se sahi command dhoondo (500+ mein se)',
      run: async (sock, msg, args, { jid, sender }) => {
        const q = args.join(' ').trim().toLowerCase();
        if (!q) {
          await reply(sock, jid, msg, `🔍 *Smart Help* 💗\n\nMisal: *${P}find birthday wish* — main 500+ commands mein se sahi wali nikaal dungi!`);
          return;
        }
        const toks = q.split(/[^a-z0-9]+/).filter(t => t.length > 1);
        if (!toks.length) { await reply(sock, jid, msg, `❌ Kuch samajh nahi aaya 💗`); return; }
        const owner = isOwnerMsg(msg, sender, jid);
        const all = (allCommands && typeof allCommands === 'object') ? allCommands : {};
        const scored = [];
        for (const name of Object.keys(all)) {
          const c = all[name];
          if (!c || c.hidden) continue;
          if (c.owner && !owner) continue;
          const dn = String(name).toLowerCase();
          const dd = String(c.desc || '').toLowerCase();
          const dnT = dn.split(/[^a-z0-9]+/);
          const ddT = dd.split(/[^a-z0-9]+/);
          let s = 0;
          for (const t of toks) {
            if (dnT.includes(t)) s += 3;
            else if (dn.includes(t)) s += 1;
            if (ddT.includes(t)) s += 2;
            else if (dd.includes(t)) s += 1;
          }
          if (s > 0) scored.push({ name, s, desc: String(c.desc || '').slice(0, 80) });
        }
        scored.sort((a, b) => b.s - a.s);
        const top = scored.slice(0, 5);
        if (!top.length) { await reply(sock, jid, msg, `🔍 *Kuch nahi mila* 😅\n\n*${P}menu* likh kar poori list dekho 💗`); return; }
        let out = `🔍 *Ye rahi!* 💗\n\n`;
        out += top.map((r, i) => `*${i + 1}.* ${P}${r.name} — ${r.desc}`).join('\n');
        await reply(sock, jid, msg, out);
      },
    },

    // ── 🌅 DAILY BRIEFING (Phase 3b) ──
    briefing: {
      desc: '🌅 Roz subah briefing: mausam + namaz + khabrein',
      owner: true,
      run: async (sock, msg, args, { jid }) => {
        const sub = String(args[0] || '').toLowerCase();
        if (sub === 'test') {
          await reply(sock, jid, msg, `🌅 *Briefing bana rahi hoon...* 💗`);
          try { await sock.sendMessage(jid, { text: await buildBriefing() }); }
          catch { await reply(sock, jid, msg, `❌ Briefing nahi ban saki, thodi der baad try karo.`); }
          return;
        }
        if (sub === 'off') {
          xjwrite(BRIEF_FILE, {});
          await reply(sock, jid, msg, `🌅 *Briefing: ⛔ OFF*`);
          return;
        }
        const tstr = sub === 'on' ? args[1] : args[0];
        const m = String(tstr || '').match(/^(\d{1,2}):(\d{2})$/);
        if (m) {
          const H = +m[1], M = +m[2];
          if (H > 23 || M > 59) { await reply(sock, jid, msg, `❌ Time ghalat hai — misal: *${P}briefing on 07:00* 💗`); return; }
          const hh = `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`;
          xjwrite(BRIEF_FILE, { time: hh, lastSent: null });
          await reply(sock, jid, msg, `🌅 *Briefing: ✅ ON* 💗\n\nRoz *${hh}* baje aap ke inbox mein:\n🌤️ Mausam · 🕌 Namaz · 📰 Khabrein`);
          return;
        }
        const cur = xjread(BRIEF_FILE, {});
        await reply(sock, jid, msg, `🌅 *Daily Briefing* 💗\n\nStatus: *${cur.time ? `ON ✅ (${cur.time})` : 'OFF ⛔'}*\n\n*${P}briefing on 07:00* — roz subah inbox mein\n*${P}briefing off* — band\n*${P}briefing test* — abhi dekho`);
      },
    },
  };

  // ── 🎯 funnel hook: active session = jawab · keyword = shuruaat ──
  // Sirf keyword par REACT karta hai — kabhi khud pehel nahi karta.
  async function exclusiveHook(sock, msg, sender, jid) {
    try {
      if (msg.key?.fromMe) return false;
      const text = (getText(msg) || '').trim();
      if (!text || text.startsWith(P)) return false;
      // Owner kabhi funnel mein nahi phansta
      if (isOwnerMsg(msg, sender, jid)) return false;
      const me = String(num(sender) || '').replace(/\D/g, '');
      if (me.length < 7) return false;

      const funnels = jread(FUNNEL_FILE, {});
      const sess = jread(FSESS_FILE, {});

      // 1. active session → ye jawab hai
      const st = sess[me];
      if (st) {
        const f = funnels[st.name];
        if (!f || !f.on) { delete sess[me]; jwrite(FSESS_FILE, sess); return false; }
        if (st.last && Date.now() - st.last > 15 * 60 * 1000) {
          delete sess[me]; jwrite(FSESS_FILE, sess);
          await reply(sock, jid, msg, `🎯 *Funnel auto-khatam* — 15 minute se jawab nahi aaya 😴\n\nDobara shuru karna ho to *${f.keyword}* likhein 💗`);
          return true;
        }
        st.answers.push(text.slice(0, 500));
        st.idx += 1;
        st.last = Date.now();
        if (st.idx >= f.questions.length) {
          // poora ho gaya → lead save + owner inbox card
          delete sess[me]; jwrite(FSESS_FILE, sess);
          f.leads.push({ at: Date.now(), from: me, answers: st.answers });
          jwrite(FUNNEL_FILE, funnels);
          await reply(sock, jid, msg, `✅ *Shukriya!* 💗\n\nAap ki details mil gayin — hamari team jald aap se rabta karegi.`);
          const oj = ownerJid();
          if (oj) {
            const d = new Date();
            const qa = f.questions.map((q, qi) => `  • _${q}_\n    → ${esc(st.answers[qi] || '-')}`).join('\n');
            try {
              await sock.sendMessage(oj, { text:
                `🎯 *Nayi Lead — ${f.name}* 💰\n\n` +
                `👤 *${me}*\n` +
                `🕐 ${d.getDate()}/${d.getMonth() + 1} · ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}\n\n` +
                `${qa}\n\n_Label lagana ho to:_ *${P}clabel ${me} lead*`
              });
            } catch {}
          }
        } else {
          jwrite(FSESS_FILE, sess);
          await reply(sock, jid, msg, `🎯 *${f.name}* (${st.idx + 1}/${f.questions.length}) 💗\n\n${f.questions[st.idx]}`);
        }
        return true;
      }

      // 2. koi session nahi → active funnel ka keyword mila?
      const low = text.toLowerCase();
      const f = Object.values(funnels).find(x => x && x.on && x.keyword && String(x.keyword).toLowerCase() === low && x.questions.length);
      if (f) {
        sess[me] = { name: f.name, idx: 0, answers: [], last: Date.now() };
        jwrite(FSESS_FILE, sess);
        await reply(sock, jid, msg, `🎯 *${f.name}* — chalen shuru karte hain! 💗\n\n(1/${f.questions.length}) ${f.questions[0]}`);
        return true;
      }
      return false;
    } catch { return false; }
  }

  return { commands, exclusiveHook };
}

module.exports = { buildExclusive, handlePollVote, briefingTick, voiceaiOn, buildBriefing,
  // test-only helpers (production flow ko nahi chhoote)
  xTest: { sha256hex, firstEmoji, pollCatList, catCmdList,
    setDecrypt: (fn) => { _decryptPollVote = fn; }, setMenuCats: (fn) => { _xMenuCats = fn; },
    setCommands: (c) => { _xCommands = c; }, setIsOwner: (fn) => { _xIsOwner = fn; } } };
