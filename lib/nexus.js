// ═══════════════════════════════════════════════════════════════
// NEXORA NEXUS PACK — ~80 advanced commands (Boss order 2026-09-23)
// Factory: buildNexus(deps) → { commands, onMessage, onGroupUpdate, aiPrompt, cmdBlocked, setSock }
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');

function buildNexus(deps) {
  const { reply, chatComplete, askNexa, config, isOwner, isOwnerMsg, downloadMediaMessage, ctxOf, getText, num } = deps;
  const P = config.prefix || '.';
  const BOT = config.botName || 'NEXORA-MD';

  // ── storage (per-process: STATE_FILE ke folder mein) ──
  const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'state.json');
  const DATA = path.join(path.dirname(STATE_FILE), 'nexus');
  try { fs.mkdirSync(DATA, { recursive: true }); } catch {}
  const jread = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
  const jwrite = (f, v) => { try { fs.writeFileSync(path.join(DATA, f), JSON.stringify(v)); } catch {} };

  // ── AI ──
  const SYS_NEXA = 'You are Nexa, NEXORA-MD WhatsApp bot ki female AI assistant. Hamesha Roman Urdu (Latin script) mein, feminine grammar (rahi hoon, karongi) mein jawab do. Mukhtasir aur dilchasp raho.';
  async function AI(sys, prompt, maxOut) {
    try {
      const t = await chatComplete(sys, String(prompt).slice(0, 4000));
      return (t || '').trim().slice(0, maxOut || 2500);
    } catch { return ''; }
  }
  const aiNexa = (prompt, maxOut) => AI(SYS_NEXA, prompt, maxOut);

  // ── text helpers ──
  function qtext(msg) {
    try {
      const q = ctxOf(msg)?.quotedMessage;
      if (!q) return '';
      return q.extendedTextMessage?.text || q.conversation || q.imageMessage?.caption || q.videoMessage?.caption || '';
    } catch { return ''; }
  }
  function qmsg(msg) { try { return ctxOf(msg)?.quotedMessage || null; } catch { return null; } }
  function inText(msg, args) { return (args || []).join(' ').trim() || qtext(msg).trim(); }
  const esc = (s) => String(s || '').slice(0, 1500);

  // ── web ──
  async function fetchText(url, maxLen) {
    try {
      const r = await fetch(String(url), { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) NEXORA-MD' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) return '';
      const html = await r.text();
      const txt = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      return txt.slice(0, maxLen || 4000);
    } catch { return ''; }
  }
  async function webSearch(q, n) {
    try {
      const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), {
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) NEXORA-MD' }, signal: AbortSignal.timeout(20000),
      });
      const html = await r.text();
      const out = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\//g;
      let m;
      while ((m = re.exec(html)) && out.length < (n || 5)) {
        let u = m[1];
        const ud = u.match(/uddg=([^&]+)/); if (ud) u = decodeURIComponent(ud[1]);
        out.push({ t: m[2].replace(/<[^>]+>/g, '').trim().slice(0, 120), u, s: m[3].replace(/<[^>]+>/g, '').trim().slice(0, 220) });
      }
      return out;
    } catch { return []; }
  }
  async function weatherOf(city) {
    try {
      const r = await fetch('https://wttr.in/' + encodeURIComponent(city || 'Lahore') + '?format=j1', { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      const c = j.current_condition?.[0];
      if (!c) return '';
      return `${city}: ${c.temp_C}°C, ${c.weatherDesc?.[0]?.value || ''}, hawa ${c.windspeedKmph} km/h, nami ${c.humidity}%`;
    } catch { return ''; }
  }
  async function newsHeadlines() {
    try {
      const r = await fetch('https://news.google.com/rss?hl=en-PK&gl=PK&ceid=PK:en', { signal: AbortSignal.timeout(15000) });
      const xml = await r.text();
      const items = [...xml.matchAll(/<title>([^<]+)<\/title>/g)].map((m) => m[1].replace(/&[^;]+;/g, '').trim()).slice(1, 7);
      return items;
    } catch { return []; }
  }
  async function ocrImage(buf) {
    try {
      const form = new FormData();
      form.append('base64Image', 'data:image/jpeg;base64,' + buf.toString('base64'));
      form.append('isOverlayRequired', 'false');
      const r = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      return (j?.ParsedResults?.[0]?.ParsedText || '').trim();
    } catch { return ''; }
  }
  async function genImage(prompt, w, h) {
    const models = ['flux', 'turbo'];
    for (const model of models) {
      try {
        const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt)
          + `?width=${w || 1024}&height=${h || 1024}&seed=${Math.floor(Math.random() * 99999)}&nologo=true&enhance=true&quality=hd&model=${model}`;
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 120000);
        const res = await fetch(url, { signal: ctrl.signal }); clearTimeout(t);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 5000) return buf;
      } catch {}
    }
    return null;
  }
  async function dlMedia(sock, msg, qm, kind) {
    // kind: 'imageMessage' | 'audioMessage' | 'videoMessage' | 'documentMessage' | 'stickerMessage'
    try {
      const useQ = !!qm;
      const message = useQ ? { [kind]: qm[kind] } : msg.message;
      const buf = await downloadMediaMessage({ key: msg.key, message }, 'buffer', {});
      return buf && buf.length ? buf : null;
    } catch { return null; }
  }
  function qMediaKind(msg) {
    const q = qmsg(msg); if (!q) return null;
    for (const k of ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'])
      if (q[k]) return k;
    return null;
  }
  function ownMediaKind(msg) {
    const m = msg.message || {}; if (!m) return null;
    for (const k of ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'])
      if (m[k]) return k;
    return null;
  }
  async function transcribeAudio(buf) {
    try {
      const tmp = `/tmp/nx-tr-${Date.now()}.ogg`;
      fs.writeFileSync(tmp, buf);
      const out = await new Promise((res) => {
        execFile('/home/hatch/workspace/voice-env/bin/python', [path.join(__dirname, 'voice.py'), tmp],
          { timeout: 90000 }, (e, stdout) => { try { fs.unlinkSync(tmp); } catch {} res(e ? '' : stdout); });
      });
      try { const j = JSON.parse(out); return j.text || ''; } catch { return ''; }
    } catch { return ''; }
  }

  // ── message log (deja/rewind/memorymap/boss ke liye) ──
  function logMsg(jid, sender, text) {
    try {
      text = String(text || '').slice(0, 500);
      if (!text || text.startsWith(P)) return; // commands log nahi
      const all = jread('msglog.json', {});
      const arr = all[jid] || [];
      arr.push({ s: String(sender || '').split('@')[0].slice(-12), t: text, ts: Date.now() });
      while (arr.length > 60) arr.shift();
      all[jid] = arr;
      const keys = Object.keys(all);
      if (keys.length > 250) delete all[keys[0]];
      jwrite('msglog.json', all);
    } catch {}
  }
  function chatLog(jid, n) { try { return (jread('msglog.json', {})[jid] || []).slice(-(n || 30)); } catch { return []; } }

  // ── audit log ──
  function audit(cmd, jid, sender) {
    try {
      const a = jread('audit.json', []);
      a.push({ ts: Date.now(), cmd, j: String(jid || '').slice(0, 40), s: String(sender || '').split('@')[0].slice(-12) });
      while (a.length > 300) a.shift();
      jwrite('audit.json', a);
    } catch {}
  }

  // ── modes ──
  const modes = () => jread('modes.json', {});
  const saveModes = (m) => jwrite('modes.json', m);
  function cmdBlocked(cmdName, sender, jid, msg) {
    try {
      const m = modes();
      if (m.panic && !isOwnerMsg(msg, sender, jid)) return 'panic';
      if (m.lockdown && !isOwnerMsg(msg, sender, jid)) {
        const allow = ['menu', 'ping', 'ai', 'contact', 'panic', 'lockdown'];
        if (!allow.includes(cmdName)) return 'lockdown';
      }
      const perms = m.perms || {};
      const pol = perms[cmdName];
      if (pol === 'off') return 'off';
      if (pol === 'owner' && !isOwnerMsg(msg, sender, jid)) return 'perm-owner';
      const dc = m.disabledCats || [];
      const cat = CMD_CAT[cmdName];
      if (cat && dc.includes(cat) && !isOwnerMsg(msg, sender, jid)) return 'cat';
      return null;
    } catch { return null; }
  }
  // AI prompt filter: rift/swap modes
  function aiPrompt(q, jid, sender) {
    try {
      const m = modes();
      let pre = '';
      if (m.rift && Date.now() < m.rift.until)
        pre += '[RIFT MODE: tum abhi alternate reality ki Nexa ho — thori mysterious, glitchy, poetic. Jawab mein kabhi kabhi "▓▒░" jaisi glitch lines shamil karo, lekin madadgar raho.]\n';
      const sw = m.swap;
      if (sw && Date.now() < sw.until && sender) {
        const snum = String(sender).split('@')[0].replace(/\D/g, '');
        if (snum.endsWith(String(sw.a).slice(-10)) || String(sw.a).slice(-10).endsWith(snum.slice(-10)))
          pre += `[STYLE SWAP: is user ko uske dost (${sw.b}) ke andaaz mein jawab do — uski wording jaisa.]\n`;
        else if (snum.endsWith(String(sw.b).slice(-10)) || String(sw.b).slice(-10).endsWith(snum.slice(-10)))
          pre += `[STYLE SWAP: is user ko uske dost (${sw.a}) ke andaaz mein jawab do — uski wording jaisa.]\n`;
      }
      return pre + q;
    } catch { return q; }
  }

  // ── scheduler (per-process; tasks isi process ke file mein) ──
  let SOCK = null;
  const setSock = (s) => { SOCK = s; };
  function schedAll() { return jread('sched.json', []); }
  function schedSave(a) { jwrite('sched.json', a); }
  function parseDailyTime(str) {
    // "08:00" ya "8 baje" / "8:30 baje"
    let m = String(str).match(/(\d{1,2})(?::(\d{2}))?\s*(baje)?/i);
    if (!m) return null;
    let h = parseInt(m[1], 10); const mi = parseInt(m[2] || '0', 10);
    if (h > 23 || mi > 59) return null;
    return { h, mi };
  }
  function nextDaily(h, mi) {
    const d = new Date(); d.setHours(h, mi, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  async function schedTick() {
    if (!SOCK) return;
    try {
      const now = Date.now();
      let arr = schedAll(); let changed = false;
      for (const t of arr) {
        if (t.done || t.next > now) continue;
        try {
          if (t.type === 'once') {
            await SOCK.sendMessage(t.jid, { text: `⏰ *Reminder* 💗\n\n${t.text}` });
            t.done = true; changed = true;
          } else if (t.type === 'daily' || t.type === 'interval') {
            const ans = await aiNexa(`User ka scheduled task hai: "${t.task}". Is par mukhtasir Roman Urdu update/brief likho (feminine grammar). Aaj ki tareekh ${new Date().toLocaleDateString('en-PK')}.`, 1200);
            await SOCK.sendMessage(t.jid, { text: `⏰ *Scheduled:* ${t.label} 💗\n\n${ans || t.task}` });
            t.next = t.type === 'daily' ? nextDaily(t.h, t.mi) : now + t.mins * 60000;
            changed = true;
          } else if (t.type === 'echobox') {
            const box = t;
            const lines = (box.entries || []).map((e, i) => `${i + 1}. _${e}_`).join('\n');
            await SOCK.sendMessage(box.jid, { text: `📦 *ECHOBOX REVEAL* 🔓\n\n${lines || '(koi secret nahi aaya)'}\n\n— sab anonymous thay 💗` });
            t.done = true; changed = true;
          } else if (t.type === 'watch') {
            const txt = await fetchText(t.url, 6000);
            if (txt && txt.toLowerCase().includes(t.word.toLowerCase()) && !t.fired) {
              await SOCK.sendMessage(t.jid, { text: `👁️ *WATCH alert!* "${t.word}" mil gaya:\n${t.url}` });
              t.fired = true; changed = true;
            }
          }
        } catch {}
      }
      if (changed) schedSave(arr.filter((t) => !t.done || (t.type !== 'once' && t.type !== 'echobox')));
    } catch {}
  }
  setInterval(schedTick, 30000).unref?.();

  // ── command registry ──
  const commands = {};
  const CMD_CAT = {};
  function C(name, cat, desc, run, opts) {
    commands[name] = { desc, run, ...(opts || {}) };
    CMD_CAT[name] = cat;
  }
  const need = (v, usage) => !v;

  // ═══ 🧠 INTELLIGENCE ═══
  C('agent', 'ai', 'Multi-step AI agent — ek request, kai kaam', async (sock, msg, args, { jid, sender }) => {
    const q = (args || []).join(' ').trim();
    if (!q) return reply(sock, jid, msg, `❌ Usage: *${P}agent <kaam>*\nMasalan: *${P}agent Lahore ka mausam aur aaj ki news ka summary*`);
    await reply(sock, jid, msg, '🕵️ *Agent* kaam par lag gaya — steps follow karo 👇');
    const steps = [];
    const ql = q.toLowerCase();
    let weather = '', news = '', web = '';
    if (/mausam|weather|mosam/.test(ql)) {
      const city = (q.match(/(?:mausam|weather)\s+(?:of\s+)?([A-Za-z\u0600-\u06FF]+)/i) || [])[1] || 'Lahore';
      weather = await weatherOf(city);
      steps.push('🌤️ Mausam check kiya' + (weather ? '' : ' (nahi mil saka)'));
    }
    if (/news|khabr|khabrein|headline/.test(ql)) {
      const hs = await newsHeadlines();
      news = hs.join('\n• ');
      steps.push(`📰 ${hs.length} headlines uthayein`);
    }
    if (/search|dekho|batao|kya hai|rate|price|kimat/.test(ql) && !weather && !news) {
      const rs = await webSearch(q, 4);
      web = rs.map((r) => `• ${r.t}: ${r.s}`).join('\n');
      steps.push(`🌐 Web search (${rs.length} results)`);
    }
    const brief = await aiNexa(
      `User ki request: "${q}"\n\nTumhare paas ye live data hai:\n${weather ? 'MAUSAM:\n' + weather + '\n' : ''}${news ? 'NEWS HEADLINES:\n' + news + '\n' : ''}${web ? 'WEB:\n' + web + '\n' : ''}\n\nIn sab ko combine karke ek concise, dilchasp Roman Urdu brief banao (feminine grammar). Headings istemal karo.`, 2500);
    await reply(sock, jid, msg,
      `🤖 *NEXORA AGENT* 💗\n\n${steps.map((s) => '✅ ' + s).join('\n')}\n\n${brief || '❌ Agent jawab nahi bana saka.'}`);
  });

  C('magic', 'ai', 'Universal command — khud samjhe kya karna hai', async (sock, msg, args, { jid }) => {
    const qk = qMediaKind(msg), ok = ownMediaKind(msg);
    const kind = qk || ok;
    // Boss (2026-09-24): quoted TEXT bhi input hai — pehle sirf args dekhe jaate thay,
    // is liye quoted "AoA" par sirf help text aa raha tha, magic nahi ho raha tha.
    const txt = inText(msg, args);
    if (kind === 'imageMessage') {
      await reply(sock, jid, msg, '🪄 Image mili — parh rahi hoon... 👀');
      const buf = await dlMedia(sock, msg, qk ? qmsg(msg) : null, 'imageMessage');
      const ocr = buf ? await ocrImage(buf) : '';
      const ans = await aiNexa(`Image ka OCR text: "${ocr.slice(0, 800) || '(koi text nahi mila)'}"\nUser ne kaha: "${txt || 'is image ke baare mein batao'}"\nOCR ki bunyad par madadgar Roman Urdu jawab do. Agar koi text nahi to image ke mumkinah mawad par rehnumai do.`, 1500);
      return reply(sock, jid, msg, `🪄 *NEXORA MAGIC* — 📷 Image detected\n\n${ocr ? '📝 *Likha hua:*\n' + ocr.slice(0, 500) + '\n\n' : ''}${ans || '❌ Samajh nahi aaya.'}`);
    }
    if (kind === 'audioMessage') {
      await reply(sock, jid, msg, '🪄 Voice note mili — sun rahi hoon... 🎙️');
      const buf = await dlMedia(sock, msg, qk ? qmsg(msg) : null, 'audioMessage');
      const heard = buf ? await transcribeAudio(buf) : '';
      const ans = await aiNexa(`Voice note ka transcript: "${heard.slice(0, 800) || '(samajh nahi aaya)'}"\nIs ka khulasa Roman Urdu mein do.`, 1200);
      return reply(sock, jid, msg, `🪄 *NEXORA MAGIC* — 🎙️ Audio detected\n\n${heard ? '🗣️ *Suna:* ' + heard.slice(0, 600) + '\n\n' : ''}${ans || '❌ Transcribe nahi ho saka.'}`);
    }
    if (/https?:\/\//.test(txt)) {
      const url = (txt.match(/https?:\/\/[^\s]+/) || [])[0];
      await reply(sock, jid, msg, '🪄 Link mila — parh rahi hoon... 🔗');
      const page = await fetchText(url, 3500);
      const ans = await aiNexa(`Is webpage ka khulasa Roman Urdu mein do:\n${page.slice(0, 2500) || '(page nahi khul saki)'}`, 1500);
      return reply(sock, jid, msg, `🪄 *NEXORA MAGIC* — 🔗 URL detected\n\n${ans || '❌ Page analyze nahi ho saki.'}`);
    }
    if (txt) {
      // Boss (2026-09-24): "bas khwab hai aur kuch nahi" — greeting par sirf rewrite
      // bekaar lagta hai. Ab MAGIC khud samjhe: greeting→greeting ka jawab,
      // sawal→jawab, aam text→behtar version.
      const ans = await aiNexa(
        `User ka text: "${txt.slice(0, 1000)}"\n\nTum NEXORA MAGIC ho — khud samjho is text par BEST action kya hai aur wahi karo:\n` +
        `• Greeting/salam (jaise AoA, salam, hello, adab) → uska khubsurat, garmajoshi bhara jawab do. Greeting ka jawab greeting hota hai — rewrite NAHI karna.\n` +
        `• Sawal → seedha, sahi, mufeed jawab do.\n` +
        `• Aam message/text → usay behtar, polished, dilchasp banao (matlab wahi rakho).\n` +
        `• Koi kaam/command lage → woh karke dikhao.\n` +
        `Roman Urdu, feminine grammar. Sirf final result do — koi explanation, koi heading nahi.`,
        1500);
      return reply(sock, jid, msg, `🪄 *NEXORA MAGIC* — 💬 Text detected\n\n${ans || '❌ Nahi ho saka.'}`);
    }
    return reply(sock, jid, msg, `🪄 *NEXORA MAGIC*\nKisi message ke reply mein likho — image, voice note, link ya text — main khud samajh kar best action loongi! 💗`);
  });

  C('mirror', 'ai', 'Chat ka AI X-Ray — tone/intent/emotion', async (sock, msg, args, { jid }) => {
    const t = inText(msg, args);
    if (!t) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${P}mirror* likho.`);
    await reply(sock, jid, msg, '🪞 X-ray kar rahi hoon... 👀');
    const ans = await AI('Tum message analysis expert ho. Hamesha Roman Urdu mein jawab do, is EXACT format mein:\n🪞 MESSAGE X-RAY\nTone: ...\nIntent: ...\nEmotion: ...\nUrgency: Low/Medium/High\nKey point: ...\nPossible misunderstanding: ...\n💡 Suggested interpretation: "..."', `Is message ka X-ray karo:\n"${t.slice(0, 800)}"`, 1500);
    return reply(sock, jid, msg, ans || '❌ X-ray nahi ho saka.');
  });

  C('detect', 'ai', 'Message mein kya ho raha hai?', async (sock, msg, args, { jid }) => {
    const t = inText(msg, args);
    if (!t) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${P}detect* likho.`);
    const ans = await AI('Tum conversation intelligence expert ho. Roman Urdu mein is EXACT format mein jawab do:\n🔎 MESSAGE ANALYSIS\nIntent: ...\nTone: ...\nImportant info: 2-3 points\nQuestion detected: YES/NO\nAction requested: YES/NO\n⚠️ Ambiguity: ...\n🤖 Recommended clarification: "..."', `Analyze karo:\n"${t.slice(0, 800)}"`, 1500);
    return reply(sock, jid, msg, ans || '❌ Analyze nahi ho saka.');
  });

  C('intent', 'ai', 'Message ka exact intent + action', async (sock, msg, args, { jid }) => {
    const t = inText(msg, args);
    if (!t) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${P}intent* likho.`);
    const ans = await AI('Tum intent detection expert ho. Roman Urdu, mukhtasir, is format mein:\n🎯 INTENT: ...\n📋 Required action: ...\n⚡ Priority: Low/Medium/High', `Intent nikalo:\n"${t.slice(0, 800)}"`, 800);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('who', 'ai', 'Message ka hidden context', async (sock, msg, args, { jid }) => {
    const t = inText(msg, args);
    if (!t) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${P}who* likho.`);
    const recent = chatLog(jid, 8).map((m) => `${m.s}: ${m.t}`).join('\n');
    const ans = await AI('Tum context analyst ho. Roman Urdu mein is format mein:\n👁️ NEXORA ANALYSIS\nThis message appears to be: ...\n🎯 Intent: ...\n🧠 Context: ...\n⚡ Urgency: ...\n💬 Expected response: ...\n🔍 Key phrase: "..."', `Recent chat:\n${recent.slice(0, 1000)}\n\nIs message ka hidden context batao:\n"${t.slice(0, 600)}"`, 1200);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('analyze', 'ai', 'Reply ka deep analysis', async (sock, msg, args, { jid }) => {
    const t = inText(msg, args);
    if (!t) return reply(sock, jid, msg, `❌ Kisi text ke reply mein *${P}analyze* likho.`);
    await reply(sock, jid, msg, '🔬 Gehrai se analyze kar rahi hoon... 🧠');
    const ans = await aiNexa(`Is text ka deep analysis karo — strengths, weaknesses, hidden meaning, aur aakhir mein verdict. Roman Urdu:\n"${t.slice(0, 1200)}"`, 2200);
    return reply(sock, jid, msg, `🔬 *DEEP ANALYSIS*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  C('askweb', 'web', 'Web search + sources + AI summary', async (sock, msg, args, { jid }) => {
    const q = (args || []).join(' ').trim();
    if (!q) return reply(sock, jid, msg, `❌ Usage: *${P}askweb <sawal>*`);
    await reply(sock, jid, msg, '🌐 Web search kar rahi hoon... 🔍');
    const rs = await webSearch(q, 5);
    const ctx = rs.map((r, i) => `[${i + 1}] ${r.t}\n${r.s}\n${r.u}`).join('\n\n');
    const ans = await aiNexa(`Sawal: "${q}"\n\nWeb results:\n${ctx || '(koi result nahi)'}\n\nIn ki bunyad par Roman Urdu mein jawab do. Aakhir mein sources ki list do.`, 2200);
    const srcs = rs.map((r, i) => `${i + 1}. ${r.t}\n   ${r.u}`).join('\n');
    return reply(sock, jid, msg, `🌐 *ASKWEB*\n\n${ans || '❌ Jawab nahi ban saka.'}${srcs ? '\n\n📚 *Sources:*\n' + srcs : ''}`);
  });

  C('deepsearch', 'web', 'Multi-source deep search', async (sock, msg, args, { jid }) => {
    const q = (args || []).join(' ').trim();
    if (!q) return reply(sock, jid, msg, `❌ Usage: *${P}deepsearch <topic>*`);
    await reply(sock, jid, msg, '🔎 Deep search — kai angles se... ⏳');
    const r1 = await webSearch(q, 4);
    const r2 = await webSearch(q + ' details explained', 3);
    const ctx = [...r1, ...r2].map((r, i) => `[${i + 1}] ${r.t}: ${r.s}`).join('\n');
    const ans = await aiNexa(`Topic: "${q}"\n\nSources:\n${ctx || '(koi result nahi)'}\n\nCross-check karke ek bharosa-mand Roman Urdu deep analysis do: facts, different angles, aur aakhir mein "key takeaway".`, 2500);
    return reply(sock, jid, msg, `🔎 *DEEP SEARCH: ${esc(q).slice(0, 60)}*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  // .remix two-step
  const remixPending = {};
  C('remix', 'ai', 'Message ko 5 styles mein transform', async (sock, msg, args, { jid, sender }) => {
    const t = qtext(msg).trim();
    const pick = (args || [])[0];
    if (pick && /^[1-5]$/.test(pick) && remixPending[jid + sender]) {
      const orig = remixPending[jid + sender]; delete remixPending[jid + sender];
      const styles = { 1: 'professional/formal', 2: 'funny/mazahiya', 3: 'savage aur tez', 4: 'emotional/jazbati', 5: 'bohat mukhtasir' };
      const ans = await aiNexa(`Is message ko "${styles[pick]}" style mein rewrite karo. Roman Urdu. Matlab wahi rakho:\n"${orig.slice(0, 800)}"`, 1200);
      return reply(sock, jid, msg, `🔄 *REMIX* (${styles[pick]})\n\n${ans || '❌ Nahi ho saka.'}`);
    }
    if (!t) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${P}remix* likho.`);
    remixPending[jid + sender] = t;
    setTimeout(() => delete remixPending[jid + sender], 120000).unref?.();
    return reply(sock, jid, msg, `🔄 *REMIX MENU*\n\n1️⃣ Professional\n2️⃣ Funny\n3️⃣ Savage\n4️⃣ Emotional\n5️⃣ Short\n\nReply karo: *${P}remix <number>*`);
  });

  C('dna', 'ai', 'Text/photo ka Digital DNA', async (sock, msg, args, { jid }) => {
    const t = inText(msg, args);
    if (!t) return reply(sock, jid, msg, `❌ Kuch text do ya reply mein *${P}dna* likho.`);
    const ans = await AI('Tum "Digital DNA" generator ho. Roman Urdu mein is EXACT style mein jawab do, bars █ aur ░ se banao (10 blocks):\n🧬 NEXORA DNA\nStyle       ████████░░\nEnergy      █████████░\nCreativity  ███████░░░\nEmotion     ██████░░░░\nSignature: "..."\nGenerated Identity: NX-XXXX', `Is input ka digital DNA banao:\n"${t.slice(0, 600)}"`, 1000);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('scene', 'ai', 'Text → cinematic scene package', async (sock, msg, args, { jid }) => {
    const t = (args || []).join(' ').trim();
    if (!t) return reply(sock, jid, msg, `❌ Usage: *${P}scene <manzar>*\nMasalan: *${P}scene barish mein Lahore ki raat*`);
    await reply(sock, jid, msg, '🎬 Scene buna rahi hoon... 🎥');
    const ans = await AI('Tum cinematic director ho. Roman Urdu mein is EXACT format mein scene package banao:\n🎬 SCENE GENERATED\n📍 Location: ...\n🎥 Camera: ...\n💡 Lighting: ...\n🎨 Visual style: ...\n🎵 Music mood: ...\n🗣 Dialogue: "..."\n🖼 Image prompt: ...\n🎞 Video prompt: ...', `Scene banao: "${t}"`, 1800);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('storyboard', 'ai', 'Topic → 5-scene storyboard', async (sock, msg, args, { jid }) => {
    const t = (args || []).join(' ').trim();
    if (!t) return reply(sock, jid, msg, `❌ Usage: *${P}storyboard <topic>*`);
    const ans = await AI('Tum storyboard artist ho. Roman Urdu mein 5 scenes banao, har scene: 🎞 Scene N — Visual / Action / Dialogue / Mood.', `Storyboard: "${t}"`, 2000);
    return reply(sock, jid, msg, `🎬 *STORYBOARD*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  C('poster', 'media', 'Poster spec + AI poster image', async (sock, msg, args, { jid }) => {
    const t = (args || []).join(' ').trim();
    if (!t) return reply(sock, jid, msg, `❌ Usage: *${P}poster <topic>*`);
    await reply(sock, jid, msg, '🎨 Poster design kar rahi hoon... ⏳');
    const spec = await AI('Tum poster designer ho. Roman Urdu mein: Title, Tagline, Color scheme, Layout, aur English mein ek detailed image prompt (for AI generation).', `Poster: "${t}"`, 1200);
    const ipm = (spec.match(/image prompt[:\s]+(.+)/i) || [])[1] || t + ' movie poster, cinematic';
    const buf = await genImage(ipm.slice(0, 400), 768, 1024);
    if (buf) await sock.sendMessage(jid, { image: buf, caption: `🎨 *POSTER*\n\n${spec.slice(0, 800)}\n\n— ${BOT} 💗` }, { quoted: msg });
    else await reply(sock, jid, msg, `🎨 *POSTER SPEC*\n\n${spec || '❌ Nahi ho saka.'}`);
  });

  C('fate', 'ai', 'Random future scenario', async (sock, msg, args, { jid }) => {
    const ans = await AI('Tum random scenario generator ho (entertainment only, prediction NAHI). Roman Urdu mein is format mein:\n🔮 NEXORA FATE\nYEAR: ...\nROLE: ...\nLOCATION: ...\nMISSION: ...\n🎲 FATE CODE: NX-XXXXX\nAakhir mein ek line: "Ye sirf tafreeh hai 😄"', 'Ek random future scenario generate karo.', 800);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('timemachine', 'ai', 'Saal ka simulation', async (sock, msg, args, { jid }) => {
    const y = (args || [])[0] || '2050';
    const ans = await AI('Tum time-travel guide ho. Roman Urdu mein is format mein (fictional projection, prediction nahi):\n⏳ ENTERING YEAR...\n💻 Technology:\n🌍 Duniya:\n📱 WhatsApp/life:\n🤖 AI:\n⚠️ Ye fictional projection hai.', `Saal ${y} ka simulation batao.`, 1500);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('afterlife', 'ai', 'Message ka future reply', async (sock, msg, args, { jid }) => {
    const t = inText(msg, args);
    if (!t) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${P}afterlife* likho.`);
    const ans = await AI('Tum poetic futurist ho. Roman Urdu mein:\n⏳ 10 YEARS LATER...\n"Ye message us waqt ordinary tha."\n📜 What it became: 3 poetic lines\nNEXORA archived this moment. 🕊️', `Is message ka "10 saal baad" version likho:\n"${t.slice(0, 500)}"`, 900);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('autopilot', 'ai', 'Goal → khud workflow banao', async (sock, msg, args, { jid }) => {
    const t = (args || []).join(' ').trim();
    if (!t) return reply(sock, jid, msg, `❌ Usage: *${P}autopilot <tumhara goal>*\nMasalan: *${P}autopilot mujhe birthday invitation banana hai*`);
    const ans = await AI('Tum workflow planner ho. Roman Urdu mein is format mein:\n🎯 GOAL DETECTED: ...\nStep 1 → ...\nStep 2 → ...\nStep 3 → ...\nStep 4 → ...\nSTATUS: READY ✅\nAakhir mein: "Shuru karne ke liye step 1 batao, ya .chain se joro!"', `Goal: "${t}"\nIs ke liye practical step-by-step workflow banao jo WhatsApp bot kar sake.`, 1500);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('omniscape', 'ai', 'Text+image unified understanding', async (sock, msg, args, { jid }) => {
    const t = (args || []).join(' ').trim();
    const qk = qMediaKind(msg);
    let ocr = '';
    if (qk === 'imageMessage') {
      const buf = await dlMedia(sock, msg, qmsg(msg), 'imageMessage');
      ocr = buf ? await ocrImage(buf) : '';
    }
    if (!t && !ocr) return reply(sock, jid, msg, `❌ Text do ya image ke reply mein *${P}omniscape* likho.`);
    const ans = await aiNexa(`Unified analysis karo:\nTEXT: "${t.slice(0, 600)}"\nIMAGE OCR: "${ocr.slice(0, 600) || '(koi image nahi)'}"\nDono ko jor kar ek unified natija Roman Urdu mein do.`, 1500);
    return reply(sock, jid, msg, `🌐 *OMNISCAPE*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  C('context', 'ai', 'Chat ka context graph', async (sock, msg, args, { jid }) => {
    const log = chatLog(jid, 25);
    if (!log.length) return reply(sock, jid, msg, '❌ Is chat mein abhi koi logged baat nahi.');
    const ans = await AI('Tum context analyst ho. Roman Urdu mein is format mein:\n🕸️ CONTEXT GRAPH\n📌 Topics: ...\n👥 Entities (naam/cheezein): ...\n🔄 Open loops (adhoori baatein): ...\n💡 Tumhara mashwara: ...', `Recent messages:\n${log.map((m) => `${m.s}: ${m.t}`).join('\n').slice(0, 2000)}`, 1500);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('chatvision', 'ai', 'Image + recent chat context', async (sock, msg, args, { jid }) => {
    const qk = qMediaKind(msg), ok = ownMediaKind(msg);
    const kind = qk || ok;
    if (kind !== 'imageMessage') return reply(sock, jid, msg, `❌ Image bhejo ya uske reply mein *${P}chatvision* likho.`);
    const buf = await dlMedia(sock, msg, qk ? qmsg(msg) : null, 'imageMessage');
    const ocr = buf ? await ocrImage(buf) : '';
    const recent = chatLog(jid, 8).map((m) => `${m.s}: ${m.t}`).join('\n');
    const ans = await aiNexa(`Recent chat context:\n${recent.slice(0, 800)}\n\nImage ka OCR text: "${ocr.slice(0, 600) || '(koi text nahi)'}"\n\nUser ne ye image is context mein bheji hai — context ko samajh kar Roman Urdu mein jawab do ke image ka matlab/maqsad kya lagta hai.`, 1500);
    return reply(sock, jid, msg, `👁️ *CHATVISION*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  C('vision', 'ai', 'Image analysis (OCR based)', async (sock, msg, args, { jid }) => {
    const qk = qMediaKind(msg), ok = ownMediaKind(msg);
    const kind = qk || ok;
    if (kind !== 'imageMessage') return reply(sock, jid, msg, `❌ Image ke reply mein *${P}vision* likho.`);
    await reply(sock, jid, msg, '👁️ Image dekh rahi hoon... (OCR) ⏳');
    const buf = await dlMedia(sock, msg, qk ? qmsg(msg) : null, 'imageMessage');
    const ocr = buf ? await ocrImage(buf) : '';
    let meta = '';
    try { const s = await require('sharp')(buf).metadata(); meta = `${s.width}x${s.height} ${s.format}`; } catch {}
    const ans = await aiNexa(`Image analysis:\n- Size: ${meta}\n- OCR text: "${ocr.slice(0, 800) || '(koi text nahi mila)'}"\n\nIs image ke baare mein Roman Urdu mein tajziya do: kya likha hai, kis qism ki image lagti hai, aur koi dilchasp note.`, 1200);
    return reply(sock, jid, msg, `👁️ *VISION* (${meta})\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  C('compareimg', 'media', 'Do images ka farq (metadata)', async (sock, msg, args, { jid }) => {
    const qk = qMediaKind(msg);
    // doosri image: media log se pichli
    const recent = mediaRecent(2);
    if (qk !== 'imageMessage' || recent.length < 1) return reply(sock, jid, msg, `❌ Pehle 2 images bhejo, phir doosri ke reply mein *${P}compareimg* likho.`);
    try {
      const sharp = require('sharp');
      const b1 = await dlMedia(sock, msg, qmsg(msg), 'imageMessage');
      const b2 = recent[0].buf;
      const m1 = await sharp(b1).metadata(), m2 = await sharp(b2).metadata();
      const s1 = await sharp(b1).stats(), s2 = await sharp(b2).stats();
      const dom = (s) => { const c = s.channels.slice(0, 3).map((ch) => Math.round(ch.mean)); return `rgb(${c.join(',')})`; };
      return reply(sock, jid, msg,
        `🖼️ *COMPAREIMG*\n\n*Image 1:* ${m1.width}x${m1.height} ${m1.format}, ${(b1.length / 1024).toFixed(0)}KB, dominant ${dom(s1)}\n*Image 2:* ${m2.width}x${m2.height} ${m2.format}, ${(b2.length / 1024).toFixed(0)}KB, dominant ${dom(s2)}\n\n${m1.width === m2.width && m1.height === m2.height ? '📐 Dono ka size same hai.' : '📐 Size mukhtalif hai.'}`);
    } catch { return reply(sock, jid, msg, '❌ Compare nahi ho saka.'); }
  });

  C('visualsearch', 'web', 'Image ke clues se web search', async (sock, msg, args, { jid }) => {
    const qk = qMediaKind(msg), ok = ownMediaKind(msg);
    const kind = qk || ok;
    if (kind !== 'imageMessage') return reply(sock, jid, msg, `❌ Image ke reply mein *${P}visualsearch* likho.`);
    const buf = await dlMedia(sock, msg, qk ? qmsg(msg) : null, 'imageMessage');
    const ocr = buf ? await ocrImage(buf) : '';
    if (!ocr) return reply(sock, jid, msg, '❌ Image mein koi parhne laiq text nahi mila.');
    const rs = await webSearch(ocr.slice(0, 100), 4);
    const ans = await aiNexa(`Image mein ye text tha: "${ocr.slice(0, 300)}"\nWeb results: ${rs.map((r) => r.t + ' — ' + r.s).join(' | ').slice(0, 800)}\nIs ke baare mein Roman Urdu mein batao ye kya ho sakta hai.`, 1200);
    return reply(sock, jid, msg, `🔍 *VISUALSEARCH*\n📝 Image text: ${ocr.slice(0, 200)}\n\n${ans || '❌ Nahi mila.'}`);
  });

  C('transform', 'media', 'Photo → style image (AI)', async (sock, msg, args, { jid }) => {
    const style = (args || []).join(' ').trim() || 'cinematic';
    const qk = qMediaKind(msg), ok = ownMediaKind(msg);
    if ((qk || ok) !== 'imageMessage') return reply(sock, jid, msg, `❌ Photo ke reply mein *${P}transform <style>* likho.\nStyles: anime, 3d, cinematic, comic, vintage, cyberpunk`);
    await reply(sock, jid, msg, `🎭 *${esc(style)}* style bana rahi hoon... ⏳`);
    const buf = await dlMedia(sock, msg, qk ? qmsg(msg) : null, 'imageMessage');
    const ocr = buf ? await ocrImage(buf) : '';
    const p = `${style} style digital artwork${ocr ? ', inspired by image containing text: ' + ocr.slice(0, 150) : ''}, highly detailed, dramatic`;
    const out = await genImage(p, 768, 768);
    if (out) await sock.sendMessage(jid, { image: out, caption: `🎭 *TRANSFORM* — ${esc(style)}\n_(AI style artwork — original photo ka stylized version)_ 💗` }, { quoted: msg });
    else await reply(sock, jid, msg, '❌ Image nahi ban saki.');
  });

  C('alter', 'media', 'Alternate universe version', async (sock, msg, args, { jid }) => {
    const qk = qMediaKind(msg), ok = ownMediaKind(msg);
    if ((qk || ok) !== 'imageMessage') return reply(sock, jid, msg, `❌ Apni photo ke reply mein *${P}alter* likho.`);
    await reply(sock, jid, msg, '🪞 Alternate universe khol rahi hoon... ⏳');
    const persona = await AI('Tum alternate-universe generator ho. Roman Urdu mein is format mein:\n🪞 ALTERNATE YOU\nUniverse: NX-XX\nTimeline: ....\nRole: ...\nEnvironment: ...\nStyle: ...\nEk line description.', 'Ek random alternate universe persona banao.', 600);
    const pm = (persona.match(/Role:\s*(.+)/i) || [])[1] || 'cyber warrior';
    const pe = (persona.match(/Environment:\s*(.+)/i) || [])[1] || 'neon city';
    const out = await genImage(`cinematic portrait of a ${pm} in ${pe}, dramatic lighting, ultra detailed`, 768, 1024);
    if (out) await sock.sendMessage(jid, { image: out, caption: `${persona}\n\n— ${BOT} 💗` }, { quoted: msg });
    else await reply(sock, jid, msg, `${persona}\n\n(❌ image nahi ban saki)`);
  });

  C('restore', 'media', 'Photo enhance (real)', async (sock, msg, args, { jid }) => {
    const qk = qMediaKind(msg), ok = ownMediaKind(msg);
    if ((qk || ok) !== 'imageMessage') return reply(sock, jid, msg, `❌ Photo ke reply mein *${P}restore* likho.`);
    await reply(sock, jid, msg, '✨ Photo restore kar rahi hoon... ⏳');
    try {
      const sharp = require('sharp');
      const buf = await dlMedia(sock, msg, qk ? qmsg(msg) : null, 'imageMessage');
      const meta = await sharp(buf).metadata();
      const w = Math.min((meta.width || 800) * 2, 2048);
      const out = await sharp(buf).resize({ width: w }).normalize().sharpen().jpeg({ quality: 92 }).toBuffer();
      await sock.sendMessage(jid, { image: out, caption: `✨ *RESTORED* — enhance + sharpen + 2x upscale\n— ${BOT} 💗` }, { quoted: msg });
    } catch { await reply(sock, jid, msg, '❌ Restore nahi ho saka.'); }
  });

  C('contactsheet', 'media', 'Aakhri images ka sheet', async (sock, msg, args, { jid }) => {
    const n = Math.min(Math.max(parseInt((args || [])[0] || '4', 10), 2), 6);
    const recent = mediaRecent(n);
    if (recent.length < 2) return reply(sock, jid, msg, `❌ Pehle kuch images bhejo (kam az kam 2), phir *${P}contactsheet* likho.`);
    await reply(sock, jid, msg, `🖼️ ${recent.length} images ka sheet bana rahi hoon... ⏳`);
    try {
      const sharp = require('sharp');
      const TW = 400, cols = n <= 2 ? 2 : 3, rows = Math.ceil(recent.length / cols);
      const thumbs = await Promise.all(recent.map((r) => sharp(r.buf).resize(TW, TW, { fit: 'cover' }).jpeg({ quality: 85 }).toBuffer()));
      const comps = [];
      thumbs.forEach((t, i) => comps.push({ input: t, left: (i % cols) * TW, top: Math.floor(i / cols) * TW }));
      const out = await sharp({ create: { width: cols * TW, height: rows * TW, channels: 3, background: { r: 10, g: 20, b: 22 } } })
        .composite(comps).jpeg({ quality: 90 }).toBuffer();
      await sock.sendMessage(jid, { image: out, caption: `🖼️ *CONTACT SHEET* — ${recent.length} images\n— ${BOT} 💗` }, { quoted: msg });
    } catch { await reply(sock, jid, msg, '❌ Sheet nahi ban saka.'); }
  });

  // ═══ 🌐 WEB DEEP ═══
  C('compareweb', 'web', 'Do websites ka comparison', async (sock, msg, args, { jid }) => {
    const urls = ((args || []).join(' ').match(/https?:\/\/[^\s]+/g) || []);
    if (urls.length < 2) return reply(sock, jid, msg, `❌ Usage: *${P}compareweb <link1> <link2>*`);
    await reply(sock, jid, msg, '⚖️ Dono sites parh rahi hoon... ⏳');
    const t1 = await fetchText(urls[0], 2500), t2 = await fetchText(urls[1], 2500);
    const ans = await aiNexa(`Do websites ka structured comparison Roman Urdu mein (table style):\nSITE 1 (${urls[0]}):\n${t1.slice(0, 1500) || '(nahi khul saki)'}\n\nSITE 2 (${urls[1]}):\n${t2.slice(0, 1500) || '(nahi khul saki)'}\n\nCompare: content, design feel, aur verdict — konsi behtar aur kyun.`, 2200);
    return reply(sock, jid, msg, `⚖️ *COMPAREWEB*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  C('siteaudit', 'web', 'Website ka audit', async (sock, msg, args, { jid }) => {
    const url = ((args || []).join(' ').match(/https?:\/\/[^\s]+/) || [])[0];
    if (!url) return reply(sock, jid, msg, `❌ Usage: *${P}siteaudit <link>*`);
    await reply(sock, jid, msg, '🔍 Site audit kar rahi hoon... ⏳');
    const t0 = Date.now();
    const txt = await fetchText(url, 4000);
    const ms = Date.now() - t0;
    const links = (txt.match(/https?:\/\//g) || []).length;
    const ans = await aiNexa(`Website audit Roman Urdu mein:\nURL: ${url}\nLoad time: ~${ms}ms, text size: ${txt.length} chars\nContent sample:\n${txt.slice(0, 2000) || '(khul nahi saki)'}\n\nAudit do: Content quality, SEO basics (title/headings), Speed feel, aur 3 improvement tips. Score /10 bhi do.`, 2000);
    return reply(sock, jid, msg, `🔍 *SITE AUDIT*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  C('linkmap', 'web', 'Site ke links ka map', async (sock, msg, args, { jid }) => {
    const url = ((args || []).join(' ').match(/https?:\/\/[^\s]+/) || [])[0];
    if (!url) return reply(sock, jid, msg, `❌ Usage: *${P}linkmap <link>*`);
    await reply(sock, jid, msg, '🗺️ Links nikaal rahi hoon... ⏳');
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 NEXORA-MD' }, signal: AbortSignal.timeout(20000) });
      const html = await r.text();
      const host = new URL(url).hostname;
      const links = [...new Set([...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]))].slice(0, 40);
      const internal = links.filter((l) => { try { return new URL(l).hostname === host; } catch { return false; } });
      const external = links.filter((l) => !internal.includes(l));
      return reply(sock, jid, msg,
        `🗺️ *LINKMAP* — ${host}\n\n🔗 Internal (${internal.length}):\n${internal.slice(0, 10).join('\n') || '—'}\n\n🌐 External (${external.length}):\n${external.slice(0, 10).join('\n') || '—'}`);
    } catch { return reply(sock, jid, msg, '❌ Site nahi khul saki.'); }
  });

  C('sourcecheck', 'web', 'Daawe ke sources check karo', async (sock, msg, args, { jid }) => {
    const q = (args || []).join(' ').trim();
    if (!q) return reply(sock, jid, msg, `❌ Usage: *${P}sourcecheck <daawa>*`);
    await reply(sock, jid, msg, '🕵️ Sources verify kar rahi hoon... ⏳');
    const rs = await webSearch(q, 5);
    const ans = await aiNexa(`Daawa: "${q}"\n\nWeb sources:\n${rs.map((r, i) => `[${i + 1}] ${r.t}: ${r.s}`).join('\n') || '(koi source nahi)'}\n\nRoman Urdu mein: VERDICT (Sach/Jhoot/Mixed/Ghair-yaqeeni), supporting sources, aur ek line wajah.`, 1500);
    return reply(sock, jid, msg, `🕵️ *SOURCECHECK*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  C('webtimeline', 'web', 'Topic ki dated timeline', async (sock, msg, args, { jid }) => {
    const q = (args || []).join(' ').trim();
    if (!q) return reply(sock, jid, msg, `❌ Usage: *${P}webtimeline <topic>*`);
    await reply(sock, jid, msg, '📜 Timeline bana rahi hoon... ⏳');
    const rs = await webSearch(q + ' history timeline', 6);
    const ans = await aiNexa(`Topic: "${q}"\n\nSources:\n${rs.map((r) => `• ${r.t}: ${r.s}`).join('\n') || '(koi result nahi)'}\n\nIn ki bunyad par Roman Urdu mein dated timeline banao (saal: waqia), puranay se naye tak.`, 2000);
    return reply(sock, jid, msg, `📜 *TIMELINE: ${esc(q).slice(0, 50)}*\n\n${ans || '❌ Nahi ho saka.'}`);
  });

  // ── in-memory recent media (contactsheet/compareimg ke liye) ──
  const mediaMem = [];
  function mediaPush(buf, jid, kind) {
    try {
      mediaMem.push({ buf, jid, kind, ts: Date.now() });
      while (mediaMem.length > 8) mediaMem.shift();
      // meta persist (bina buffer)
      const meta = jread('medialog.json', []);
      meta.push({ jid, kind, ts: Date.now(), kb: Math.round(buf.length / 1024) });
      while (meta.length > 100) meta.shift();
      jwrite('medialog.json', meta);
    } catch {}
  }
  function mediaRecent(n) { return mediaMem.filter((m) => m.kind === 'imageMessage').slice(-(n || 4)).reverse(); }

  // ═══ 💾 MEMORY ═══
  C('memory', 'memory', 'AI memory on/off + facts', async (sock, msg, args, { jid, sender }) => {
    const mem = jread('memory.json', {});
    const key = String(sender || jid).split('@')[0].replace(/\D/g, '');
    const sub = (args || [])[0];
    if (sub === 'on') { mem[key] = mem[key] || { on: true, facts: [] }; mem[key].on = true; jwrite('memory.json', mem); return reply(sock, jid, msg, '🧠 *Memory ON* — ab tumhari pasand/notes yaad rakhongi! `.memory add <baat>` se kuch save karo. 💗'); }
    if (sub === 'off') { if (mem[key]) mem[key].on = false; jwrite('memory.json', mem); return reply(sock, jid, msg, '🧠 *Memory OFF* — ab kuch yaad nahi rakhongi.'); }
    if (sub === 'add') { const f = (args || []).slice(1).join(' ').trim(); if (!f) return reply(sock, jid, msg, `❌ Usage: *${P}memory add <baat>*`); mem[key] = mem[key] || { on: true, facts: [] }; mem[key].facts.push({ t: f.slice(0, 300), ts: Date.now() }); jwrite('memory.json', mem); return reply(sock, jid, msg, '🧠 Yaad kar liya! ✅'); }
    if (sub === 'list') { const f = (mem[key]?.facts || []); return reply(sock, jid, msg, `🧠 *Tumhari memory* (${mem[key]?.on ? 'ON' : 'OFF'})\n\n${f.map((x, i) => `${i + 1}. ${x.t}`).join('\n') || '(khali)'}`); }
    if (sub === 'forget') { delete mem[key]; jwrite('memory.json', mem); return reply(sock, jid, msg, '🧠 Sab bhool gayi! 🫧'); }
    return reply(sock, jid, msg, `🧠 *MEMORY*\n${P}memory on / off\n${P}memory add <baat>\n${P}memory list\n${P}memory forget`);
  });

  C('secondbrain', 'memory', 'Idea vault — save + search', async (sock, msg, args, { jid, sender }) => {
    const brain = jread('brain.json', {});
    const key = String(sender || jid).split('@')[0].replace(/\D/g, '');
    const sub = (args || [])[0];
    const rest = (args || []).slice(1).join(' ').trim();
    brain[key] = brain[key] || [];
    if (!sub) return reply(sock, jid, msg, `🧠 *SECONDBRAIN*\n${P}secondbrain <idea> [#tag] — save\n${P}secondbrain search <lafz>\n${P}secondbrain list`);
    if (sub === 'search') {
      if (!rest) return reply(sock, jid, msg, '❌ Kya search karun?');
      const ql = rest.toLowerCase();
      const hits = brain[key].filter((e) => (e.t + ' ' + (e.tags || []).join(' ')).toLowerCase().includes(ql));
      return reply(sock, jid, msg, `🔍 *BRAIN SEARCH: ${esc(rest).slice(0, 40)}*\n\n${hits.map((e, i) => `${i + 1}. 💡 ${e.t}\n   🏷️ ${(e.tags || []).join(' ') || '—'} · 📅 ${new Date(e.ts).toLocaleDateString('en-PK')}`).join('\n\n') || '(kuch nahi mila)'}`);
    }
    if (sub === 'list') {
      return reply(sock, jid, msg, `🧠 *IDEA VAULT* (${brain[key].length})\n\n${brain[key].slice(-15).map((e, i) => `${i + 1}. 💡 ${e.t.slice(0, 120)}`).join('\n') || '(khali)'}`);
    }
    const tags = (rest.match(/#[\w\u0600-\u06FF]+/g) || []);
    brain[key].push({ t: ((args || []).join(' ')).slice(0, 500), tags, ts: Date.now() });
    jwrite('brain.json', brain);
    return reply(sock, jid, msg, `🧠 Idea vault mein save! ✅ ${tags.join(' ')}`);
  });

  C('deja', 'memory', 'Purani baat yaad karo', async (sock, msg, args, { jid, sender }) => {
    const q = (args || []).join(' ').trim();
    if (!q) return reply(sock, jid, msg, `❌ Usage: *${P}deja <lafz>*\nMasalan: *${P}deja invoice wala idea*`);
    const ql = q.toLowerCase();
    const hits = [];
    const all = jread('msglog.json', {});
    for (const [cj, arr] of Object.entries(all)) for (const m of arr)
      if (m.t.toLowerCase().includes(ql)) hits.push({ ...m, chat: cj });
    const key = String(sender || jid).split('@')[0].replace(/\D/g, '');
    const brain = (jread('brain.json', {})[key] || []).filter((e) => e.t.toLowerCase().includes(ql)).map((e) => ({ t: '💡 IDEA: ' + e.t, ts: e.ts }));
    const comb = [...hits.slice(-8), ...brain.slice(-4)].sort((a, b) => a.ts - b.ts).slice(-8);
    if (!comb.length) return reply(sock, jid, msg, `🧠 *" ${esc(q).slice(0, 40)} "* — is bare mein kuch yaad nahi aaya.`);
    return reply(sock, jid, msg,
      `╭───〔 🧠 DEJA VU 〕───╮\n│ *I REMEMBER THIS...*\n│\n${comb.map((m) => `│ 📅 ${new Date(m.ts).toLocaleDateString('en-PK')}\n│ ${m.t.slice(0, 90)}`).join('\n│\n')}\n╰─────────────────────╯`);
  });

  C('rewind', 'memory', 'Chat ka movie-trailer summary', async (sock, msg, args, { jid }) => {
    const log = chatLog(jid, 30);
    if (log.length < 3) return reply(sock, jid, msg, '❌ Rewind ke liye thori aur baatein chahiye.');
    await reply(sock, jid, msg, '🎬 Rewind buna rahi hoon... 🍿');
    const ans = await AI('Tum movie-trailer narrator ho. Recent chat ko cinematic trailer ki tarah Roman Urdu mein summarize karo:\n🎬 NEXORA REWIND\nPreviously...\n(2-3 dramatic lines)\n📍 CHAPTER 01 "...."\n📍 CHAPTER 02 "...."\n📍 CHAPTER 03 "...."\n▶️ Continue...\nMukhtasir, mazahiya-dramatic.', `Chat:\n${log.map((m) => `${m.s}: ${m.t}`).join('\n').slice(0, 2200)}`, 1500);
    return reply(sock, jid, msg, ans || '❌ Nahi ho saka.');
  });

  C('memorymap', 'memory', 'Conversation ka map', async (sock, msg, args, { jid, sender }) => {
    const key = String(sender || jid).split('@')[0].replace(/\D/g, '');
    const mem = (jread('memory.json', {})[key] || {});
    const log = chatLog(jid, 20);
    const audit = jread('audit.json', []).filter((a) => a.j === jid);
    const cmdCount = {};
    audit.forEach((a) => { cmdCount[a.cmd] = (cmdCount[a.cmd] || 0) + 1; });
    const top = Object.entries(cmdCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const topics = log.length ? await AI('In messages se 3-5 recent topics nikalo, Roman Urdu, sirf list:', log.map((m) => m.t).join('\n').slice(0, 1200), 400) : '(koi baat nahi)';
    return reply(sock, jid, msg,
      `🧠 *YOUR MEMORY MAP*\n\n👤 *Preferences*\n${(mem.facts || []).slice(-5).map((f) => '├─ ' + f.t.slice(0, 60)).join('\n') || '├─ (koi saved nahi)'}\n\n📌 *Recent Topics*\n${topics}\n\n⚡ *Top Commands*\n${top.map(([c, n]) => `├─ ${P}${c}: ${n}x`).join('\n') || '├─ (abhi koi nahi)'}\n\n📊 *Usage*\n├─ Messages logged: ${log.length}\n└─ Memory: ${mem.on === false ? 'OFF' : 'ON'}`);
  });

  // vault: AES-256-GCM
  function vaultKey(pass, salt) { return crypto.scryptSync(String(pass), salt, 32); }
  C('vault', 'memory', 'Encrypted private vault', async (sock, msg, args, { jid, sender }) => {
    const v = jread('vault.json', {});
    const key = String(sender || jid).split('@')[0].replace(/\D/g, '');
    const sub = (args || [])[0];
    const rest = (args || []).slice(1).join(' ');
    if (sub === 'set') {
      if (!rest || rest.length < 4) return reply(sock, jid, msg, '❌ Kam az kam 4 harf ka password do (ye chat mein likha jayega — behtar hai DM mein karo).');
      const salt = crypto.randomBytes(16).toString('hex');
      v[key] = { salt, hp: crypto.scryptSync(rest, salt, 32).toString('hex'), items: [] };
      jwrite('vault.json', v);
      return reply(sock, jid, msg, '🔐 *Vault ready!* Ab `.vault add <pass> <note>` se save karo.');
    }
    const me = v[key];
    if (!me) return reply(sock, jid, msg, `🔐 Pehle *${P}vault set <password>* karo.`);
    if (sub === 'add') {
      const [pass, ...nt] = rest.split(' ');
      const note = nt.join(' ').trim();
      if (!pass || !note) return reply(sock, jid, msg, `❌ Usage: *${P}vault add <password> <note>*`);
      if (crypto.scryptSync(pass, me.salt, 32).toString('hex') !== me.hp) return reply(sock, jid, msg, '❌ Password ghalat.');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(pass, me.salt), iv);
      const enc = Buffer.concat([cipher.update(note, 'utf8'), cipher.final()]);
      me.items.push({ iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), d: enc.toString('hex'), ts: Date.now() });
      jwrite('vault.json', v);
      return reply(sock, jid, msg, `🔐 Vault mein save! (${me.items.length} notes)`);
    }
    if (sub === 'list') return reply(sock, jid, msg, `🔐 *Vault* — ${me.items.length} encrypted notes\nParhne ke liye: *${P}vault read <password> <number>*`);
    if (sub === 'read') {
      const [pass, ns] = rest.split(' ');
      const it = me.items[parseInt(ns, 10) - 1];
      if (!pass || !it) return reply(sock, jid, msg, `❌ Usage: *${P}vault read <password> <number>*`);
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(pass, me.salt), Buffer.from(it.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(it.tag, 'hex'));
        const dec = Buffer.concat([decipher.update(Buffer.from(it.d, 'hex')), decipher.final()]).toString('utf8');
        return reply(sock, jid, msg, `🔓 *Vault #${ns}*\n\n${dec}`);
      } catch { return reply(sock, jid, msg, '❌ Password ghalat ya data kharab.'); }
    }
    return reply(sock, jid, msg, `🔐 *VAULT*\n${P}vault set <password>\n${P}vault add <password> <note>\n${P}vault list\n${P}vault read <password> <number>`);
  });

  C('burn', 'memory', 'Temp data delete karo', async (sock, msg, args, { jid, sender }) => {
    const sub = (args || [])[0];
    if (sub !== 'yes') return reply(sock, jid, msg, `🔥 *BURN*\nIs chat ka logged data (messages, landmarks, media meta) delete ho jayega.\nConfirm: *${P}burn yes*`);
    const all = jread('msglog.json', {}); delete all[jid]; jwrite('msglog.json', all);
    const lm = jread('landmarks.json', {}); delete lm[jid]; jwrite('landmarks.json', lm);
    const meta = jread('medialog.json', []).filter((m) => m.jid !== jid); jwrite('medialog.json', meta);
    return reply(sock, jid, msg, '🔥 Sab jala diya — is chat ka temp data khatam! 🫧');
  });

  C('mark', 'memory', 'Message ko landmark banao', async (sock, msg, args, { jid, sender }) => {
    const t = qtext(msg).trim();
    if (!t) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${P}mark* likho.`);
    const lm = jread('landmarks.json', {});
    lm[jid] = lm[jid] || [];
    const id = (lm[jid].length + 1);
    lm[jid].push({ id, t: t.slice(0, 300), s: String(sender || '').split('@')[0].slice(-12), ts: Date.now() });
    jwrite('landmarks.json', lm);
    return reply(sock, jid, msg, `📍 *MESSAGE MARKED*\n\n*NEXORA LANDMARK* #${String(id).padStart(6, '0')}\n📅 ${new Date().toLocaleDateString('en-PK')}\n\n"${t.slice(0, 120)}"\n\nYe lamha timeline mein mehfooz ho gaya. 💗`);
  });

  C('landmarks', 'memory', 'Group ke landmarks timeline', async (sock, msg, args, { jid }) => {
    const lm = (jread('landmarks.json', {})[jid] || []);
    if (!lm.length) return reply(sock, jid, msg, '📍 Abhi koi landmark nahi. Kisi message ke reply mein `.mark` likho.');
    return reply(sock, jid, msg, `📍 *LANDMARKS TIMELINE* (${lm.length})\n\n${lm.slice(-15).map((l) => `#${String(l.id).padStart(6, '0')} · ${new Date(l.ts).toLocaleDateString('en-PK')}\n"${l.t.slice(0, 100)}" — ${l.s}`).join('\n\n')}`);
  });

  // void: absorb + recall
  const voidPending = {};
  C('void', 'memory', 'Message gaayab karo / recall', async (sock, msg, args, { jid, sender }) => {
    const sub = (args || [])[0];
    if (sub === 'recall') {
      const id = (args || [])[1];
      const store = jread('void.json', {});
      const it = store[id];
      if (!it) return reply(sock, jid, msg, '❌ Is ID ka kuch nahi mila.');
      const snum = String(sender || '').split('@')[0].replace(/\D/g, '');
      if (it.by !== snum && !isOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '🔒 Sirf bhejne wala ya owner recall kar sakta hai.');
      return reply(sock, jid, msg, `🕳️ *VOID RECALL* ${id}\n\n${it.t.slice(0, 1000)}`);
    }
    voidPending[jid + sender] = true;
    setTimeout(() => delete voidPending[jid + sender], 120000).unref?.();
    return reply(sock, jid, msg, `╭──〔 🕳️ NEXORA VOID 〕──╮\n│\n│  Send anything...\n│  Text · Photo · Video · Audio\n│\n│  _The VOID is listening._\n╰─────────────────────╯`);
  });

  C('mediaindex', 'memory', 'Received media catalogue', async (sock, msg, args, { jid }) => {
    const meta = jread('medialog.json', []).slice(-20).reverse();
    if (!meta.length) return reply(sock, jid, msg, '🖼️ Abhi koi media logged nahi.');
    return reply(sock, jid, msg, `🖼️ *MEDIA INDEX* (${meta.length})\n\n${meta.map((m, i) => `${i + 1}. ${m.kind.replace('Message', '')} · ${m.kb}KB · ${new Date(m.ts).toLocaleString('en-PK')}`).join('\n')}`);
  });

  C('snapshot', 'web', 'Webpage ka snapshot save karo', async (sock, msg, args, { jid }) => {
    const url = ((args || []).join(' ').match(/https?:\/\/[^\s]+/) || [])[0];
    const sub = (args || [])[0];
    const snaps = jread('snaps.json', {});
    if (sub === 'list') {
      const mine = snaps[jid] || [];
      return reply(sock, jid, msg, `📸 *SNAPSHOTS* (${mine.length})\n\n${mine.map((s, i) => `${i + 1}. ${s.url.slice(0, 50)}\n   📅 ${new Date(s.ts).toLocaleString('en-PK')}`).join('\n\n') || '(khali)'}`);
    }
    if (!url) return reply(sock, jid, msg, `❌ Usage: *${P}snapshot <link>* ya *${P}snapshot list*`);
    await reply(sock, jid, msg, '📸 Snapshot le rahi hoon... ⏳');
    const txt = await fetchText(url, 5000);
    if (!txt) return reply(sock, jid, msg, '❌ Page nahi khul saki.');
    snaps[jid] = snaps[jid] || [];
    snaps[jid].push({ url, txt: txt.slice(0, 5000), ts: Date.now() });
    jwrite('snaps.json', snaps);
    return reply(sock, jid, msg, `📸 *Snapshot saved!*\n${url}\n📅 ${new Date().toLocaleString('en-PK')}\n📝 ${txt.length} chars mehfooz.`);
  });

  // ═══ ⚙️ AUTOMATION ═══
  C('time', 'auto', 'Message future mein bhejo', async (sock, msg, args, { jid }) => {
    // .time 25-12-2026 00:00 Happy Birthday 🎂
    const a = args || [];
    const m = (a[0] || '').match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    const tm = (a[1] || '').match(/(\d{1,2}):(\d{2})/);
    if (!m || !tm) return reply(sock, jid, msg, `❌ Usage: *${P}time DD-MM-YYYY HH:MM <message>*\nMasalan: *${P}time 25-12-2026 00:00 Happy Birthday 🎂*`);
    const at = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), parseInt(tm[1], 10), parseInt(tm[2], 10)).getTime();
    if (at <= Date.now()) return reply(sock, jid, msg, '❌ Waqt guzar chuka hai — future ka time do.');
    const text = a.slice(2).join(' ').trim();
    if (!text) return reply(sock, jid, msg, '❌ Message bhi likho.');
    const arr = schedAll();
    arr.push({ id: 't' + Date.now(), type: 'once', jid, text: text.slice(0, 1000), next: at });
    schedSave(arr);
    return reply(sock, jid, msg, `⏰ *Scheduled!* ✅\n📅 ${new Date(at).toLocaleString('en-PK')}\n📝 ${text.slice(0, 100)}\n\nUs waqt khud bhej doongi! 💗`);
  });

  C('autotask', 'auto', 'Repeated task automation', async (sock, msg, args, { jid }) => {
    // .autotask har roz 08:00 mausam bhejo
    // .autotask har 6 ghante news bhejo
    const raw = (args || []).join(' ');
    const daily = raw.match(/har\s+roz\s+(\d{1,2})(?::(\d{2}))?/i);
    const hourly = raw.match(/har\s+(\d+)\s*ghante/i);
    if (!daily && !hourly) return reply(sock, jid, msg, `❌ Usage:\n*${P}autotask har roz 08:00 <kaam>*\n*${P}autotask har 6 ghante <kaam>*`);
    const task = raw.replace(/har\s+roz\s+\d{1,2}(?::\d{2})?|har\s+\d+\s*ghante/i, '').trim();
    if (!task) return reply(sock, jid, msg, '❌ Kaam bhi batao.');
    const arr = schedAll();
    if (daily) {
      const h = parseInt(daily[1], 10), mi = parseInt(daily[2] || '0', 10);
      arr.push({ id: 'a' + Date.now(), type: 'daily', jid, task: task.slice(0, 300), label: `har roz ${h}:${String(mi).padStart(2, '0')}`, h, mi, next: nextDaily(h, mi) });
    } else {
      const mins = parseInt(hourly[1], 10) * 60;
      arr.push({ id: 'a' + Date.now(), type: 'interval', jid, task: task.slice(0, 300), label: `har ${hourly[1]} ghante`, mins, next: Date.now() + mins * 60000 });
    }
    schedSave(arr);
    return reply(sock, jid, msg, `🤖 *Autotask ON!* ✅\n${daily ? '📅 Har roz ' + daily[1] + ':' + (daily[2] || '00') : '⏳ Har ' + hourly[1] + ' ghante'}\n📝 ${task.slice(0, 100)}\n\nManage: *${P}scheduler*`);
  });

  C('scheduler', 'auto', 'Schedules dekho/cancel karo', async (sock, msg, args, { jid }) => {
    const arr = schedAll();
    const sub = (args || [])[0];
    if (sub === 'cancel') {
      const id = (args || [])[1];
      const n = arr.filter((t) => t.id !== id);
      schedSave(n);
      return reply(sock, jid, msg, n.length === arr.length ? '❌ Is ID ka task nahi mila.' : '🗑️ Task cancel! ✅');
    }
    const mine = arr.filter((t) => t.jid === jid);
    if (!mine.length) return reply(sock, jid, msg, '📭 Koi scheduled task nahi.');
    return reply(sock, jid, msg, `⏰ *SCHEDULED TASKS* (${mine.length})\n\n${mine.map((t) => `🆔 \`${t.id}\`\n${t.type === 'once' ? '📅 ' + new Date(t.next).toLocaleString('en-PK') : '🔁 ' + t.label}\n📝 ${(t.text || t.task || '').slice(0, 80)}`).join('\n\n')}\n\nCancel: *${P}scheduler cancel <id>*`);
  });

  C('ghostmsg', 'auto', 'Self-destructing message', async (sock, msg, args, { jid }) => {
    const secs = Math.min(Math.max(parseInt((args || [])[0] || '30', 10), 5), 600);
    const text = (args || []).slice(1).join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${P}ghostmsg <seconds> <message>*`);
    const sent = await sock.sendMessage(jid, { text: `👻 *GHOST MSG* (${secs}s mein gaayab)\n\n${text}` });
    setTimeout(async () => {
      try { await sock.sendMessage(jid, { delete: sent.key }); } catch {}
    }, secs * 1000).unref?.();
    return reply(sock, jid, msg, `👻 Bhej diya — ${secs} second mein delete ho jayega!`);
  });

  C('ghost', 'auto', 'Temporary private session', async (sock, msg, args, { jid }) => {
    const mins = Math.min(Math.max(parseInt((args || [])[0] || '60', 10), 5), 1440);
    const sub = (args || [])[0];
    const m = modes();
    if (sub === 'end') { delete m.ghost; saveModes(m); return reply(sock, jid, msg, '👻 Ghost mode khatam.'); }
    m.ghost = { [jid]: Date.now() + mins * 60000 };
    saveModes(m);
    setTimeout(() => { const mm = modes(); if (mm.ghost) { delete mm.ghost[jid]; saveModes(mm); const all = jread('msglog.json', {}); delete all[jid]; jwrite('msglog.json', all); } }, mins * 60000).unref?.();
    return reply(sock, jid, msg, `👻 *GHOST MODE* — ${mins} min\nIs chat ki baatein log nahi hongi, waqt khatam hote hi sab auto-delete. 🫧\nKhatam: *${P}ghost end*`);
  });

  C('bomb', 'fun', 'Timed group countdown event', async (sock, msg, args, { jid }) => {
    const secs = Math.min(Math.max(parseInt((args || [])[0] || '30', 10), 10), 300);
    await reply(sock, jid, msg, `💣 *NEXORA EVENT* — ${secs} second mein DHAMAKA!\n\n${secs}...`);
    const marks = [Math.floor(secs * 0.66), Math.floor(secs * 0.33), 10, 5, 4, 3, 2, 1].filter((x, i, a) => x > 0 && x < secs && a.indexOf(x) === i).sort((a, b) => b - a);
    let i = 0;
    const step = Math.max(1, Math.floor(secs / (marks.length + 1)));
    const iv = setInterval(async () => {
      try {
        if (i < marks.length) { await sock.sendMessage(jid, { text: `💣 ${marks[i]}...` }); i++; }
        else {
          clearInterval(iv);
          const boom = await aiNexa('Ek dhamakedaar funny "BOOM" celebration message likho Roman Urdu mein — koi harmless surprise (meme caption, challenge, ya shayari). 2-3 lines.', 400);
          await sock.sendMessage(jid, { text: `💥 *BOOM!* 💥\n\n${boom || 'Dhamaka ho gaya! 🎉'}` });
        }
      } catch { clearInterval(iv); }
    }, step * 1000);
    if (iv.unref) iv.unref();
    return;
  });

  // hunt: scavenger
  C('hunt', 'fun', 'Treasure hunt game', async (sock, msg, args, { jid, sender }) => {
    const hunts = jread('hunts.json', {});
    const sub = (args || [])[0];
    if (sub === 'stop') { delete hunts[jid]; jwrite('hunts.json', hunts); return reply(sock, jid, msg, '🛑 Hunt khatam.'); }
    if (hunts[jid] && !sub) {
      // jawab check
      const ans = (args || []).join(' ').toLowerCase();
      const h = hunts[jid];
      if (h.answers[h.step] && ans.includes(h.answers[h.step])) {
        h.step++;
        if (h.step >= h.clues.length) {
          delete hunts[jid]; jwrite('hunts.json', hunts);
          return reply(sock, jid, msg, `🏆 *HUNT COMPLETE!* @${String(sender).split('@')[0]} jeet gaya! 🎉\nKhazana: tum sab se tez dimagh ho! 🧠💰`);
        }
        jwrite('hunts.json', hunts);
        return reply(sock, jid, msg, `✅ Sahi! Agla clue:\n\n🔍 *Clue ${h.step + 1}:* ${h.clues[h.step]}`, { mentions: [sender] });
      }
      return reply(sock, jid, msg, `🔍 *Clue ${h.step + 1}:* ${h.clues[h.step]}\n\nJawab do: *${P}hunt <jawab>*`);
    }
    await reply(sock, jid, msg, '🕵️ Clues bana rahi hoon... 🗺️');
    const raw = await AI('Tum treasure-hunt designer ho. Roman Urdu mein 5 asaan-mazedaar riddles (clues) banao WhatsApp group game ke liye. Format EXACT:\nCLUE: ...\nANSWER: ...\n(5 baar, har clue ke neeche uska ek-lafz ya mukhtasir jawab)', '5 riddles banao.', 1500);
    const clues = [...raw.matchAll(/CLUE:\s*(.+)/gi)].map((m) => m[1].trim());
    const answers = [...raw.matchAll(/ANSWER:\s*(.+)/gi)].map((m) => m[1].trim().toLowerCase());
    if (clues.length < 3) return reply(sock, jid, msg, '❌ Clues nahi ban sake, dobara try karo.');
    hunts[jid] = { clues, answers, step: 0, ts: Date.now() };
    jwrite('hunts.json', hunts);
    return reply(sock, jid, msg, `🕵️ *TREASURE HUNT* shuru! 🗺️\n\n🔍 *Clue 1:* ${clues[0]}\n\nJawab: *${P}hunt <jawab>*\nRoko: *${P}hunt stop*`);
  });

  C('echobox', 'fun', 'Anonymous secret box', async (sock, msg, args, { jid }) => {
    // .echobox 23:59  → us waqt reveal
    const tm = ((args || [])[0] || '').match(/(\d{1,2}):(\d{2})/);
    if (!tm) return reply(sock, jid, msg, `❌ Usage: *${P}echobox HH:MM*\nSecrets bhejo: *${P}drop <secret>*`);
    const at = nextDaily(parseInt(tm[1], 10), parseInt(tm[2], 10));
    const arr = schedAll();
    arr.push({ id: 'e' + Date.now(), type: 'echobox', jid, entries: [], next: at });
    schedSave(arr);
    return reply(sock, jid, msg, `📦 *ECHOBOX* ban gaya! 🔒\n\nSab apne secrets bhejo: *${P}drop <secret>*\n🔓 Khulega: ${new Date(at).toLocaleString('en-PK')}\nKoi nahi dekhega kis ne kya bheja! 🤫`);
  });

  C('drop', 'fun', 'Echobox mein secret daalo', async (sock, msg, args, { jid }) => {
    const secret = (args || []).join(' ').trim();
    if (!secret) return reply(sock, jid, msg, `❌ Usage: *${P}drop <secret>*`);
    const arr = schedAll();
    const box = arr.find((t) => t.type === 'echobox' && t.jid === jid && !t.done);
    if (!box) return reply(sock, jid, msg, `❌ Koi khula echobox nahi. Pehle *${P}echobox HH:MM* banao.`);
    box.entries.push(secret.slice(0, 300));
    schedSave(arr);
    return reply(sock, jid, msg, '🤫 Secret mehfooz! Kisi ko nahi pata chalega. 📦');
  });

  C('event', 'auto', 'Event → action rules', async (sock, msg, args, { jid }) => {
    const ev = jread('events.json', {});
    const sub = (args || [])[0];
    if (sub === 'add') {
      const type = (args || [])[1]; // join
      const text = (args || []).slice(2).join(' ').trim();
      if (type !== 'join' || !text) return reply(sock, jid, msg, `❌ Usage: *${P}event add join <welcome text>*\n(@user mention ke liye kaam karega)`);
      ev[jid] = ev[jid] || [];
      ev[jid].push({ type, text: text.slice(0, 500) });
      jwrite('events.json', ev);
      return reply(sock, jid, msg, '⚡ Event rule lag gaya! Naya member aayega to ye message jayega. ✅');
    }
    if (sub === 'list') {
      const mine = ev[jid] || [];
      return reply(sock, jid, msg, `⚡ *EVENT RULES*\n\n${mine.map((e, i) => `${i + 1}. [${e.type}] ${e.text.slice(0, 80)}`).join('\n') || '(koi nahi)'}`);
    }
    if (sub === 'clear') { delete ev[jid]; jwrite('events.json', ev); return reply(sock, jid, msg, '🗑️ Event rules saaf!'); }
    return reply(sock, jid, msg, `⚡ *EVENT*\n${P}event add join <text>\n${P}event list\n${P}event clear`);
  });

  C('chain', 'auto', 'Kai commands ek saath', async (sock, msg, args, ctx) => {
    const { jid } = ctx;
    const raw = (args || []).join(' ');
    const parts = raw.split(/\s*&&\s*/).filter(Boolean).slice(0, 5);
    if (!parts.length) return reply(sock, jid, msg, `❌ Usage: *${P}chain .ping && ${P}ai hello*`);
    await reply(sock, jid, msg, `⛓️ *CHAIN* — ${parts.length} commands...`);
    const { commands: allCmds } = deps;
    for (const p of parts) {
      const pp = p.startsWith(P) ? p.slice(P.length) : p;
      const [nm, ...a] = pp.trim().split(/\s+/);
      const c = allCmds[(nm || '').toLowerCase()];
      if (!c) { await reply(sock, jid, msg, `⚠️ .${nm} nahi mila — skip.`); continue; }
      try { await c.run(sock, msg, a, ctx); await new Promise((r) => setTimeout(r, 800)); }
      catch { await reply(sock, jid, msg, `⚠️ .${nm} mein error.`); }
    }
  });

  C('macro', 'auto', 'Custom command macro banao', async (sock, msg, args, { jid }) => {
    const sub = (args || [])[0];
    const macros = jread('macros.json', {});
    if (sub === 'list') return reply(sock, jid, msg, `⚙️ *MACROS*\n\n${Object.keys(macros).map((k) => `• ${P}${k} → ${macros[k].slice(0, 60)}`).join('\n') || '(koi nahi)'}`);
    if (sub === 'del') { delete macros[(args || [])[1]]; jwrite('macros.json', macros); return reply(sock, jid, msg, '🗑️ Macro delete!'); }
    const name = sub, body = (args || []).slice(1).join(' ').trim();
    if (!name || !body) return reply(sock, jid, msg, `❌ Usage: *${P}macro <naam> <command>*\nMasalan: *${P}macro goodmorning ai subah ki dua do*`);
    if (commands[name] || !/^[a-z0-9]{2,15}$/.test(name)) return reply(sock, jid, msg, '❌ Naam 2-15 English harf ho aur pehle se command na ho.');
    macros[name] = body.slice(0, 300);
    jwrite('macros.json', macros);
    const { commands: allCmds } = deps;
    allCmds[name] = {
      desc: 'Custom macro',
      run: async (s2, m2, a2, ctx2) => {
        const full = macros[name] + (a2.length ? ' ' + a2.join(' ') : '');
        const [nm, ...aa] = full.trim().split(/\s+/);
        const c = allCmds[(nm || '').toLowerCase()];
        if (!c) return reply(s2, ctx2.jid, m2, '❌ Macro ka command nahi mila.');
        return c.run(s2, m2, aa, ctx2);
      },
    };
    CMD_CAT[name] = 'auto';
    return reply(sock, jid, msg, `⚙️ Macro tayyar! Ab *${P}${name}* likho — chal jayega! ✅`);
  });

  C('trigger', 'auto', 'Word par auto-reply', async (sock, msg, args, { jid }) => {
    const sub = (args || [])[0];
    const tr = jread('triggers.json', {});
    if (sub === 'list') { const mine = tr[jid] || {}; return reply(sock, jid, msg, `⚡ *TRIGGERS*\n\n${Object.entries(mine).map(([k, v]) => `"${k}" → ${v.slice(0, 60)}`).join('\n') || '(koi nahi)'}`); }
    if (sub === 'del') { if (tr[jid]) delete tr[jid][(args || [])[1]]; jwrite('triggers.json', tr); return reply(sock, jid, msg, '🗑️ Trigger delete!'); }
    const word = sub, text = (args || []).slice(1).join(' ').trim();
    if (!word || !text) return reply(sock, jid, msg, `❌ Usage: *${P}trigger <lafz> <jawab>*`);
    tr[jid] = tr[jid] || {};
    tr[jid][word.toLowerCase()] = text.slice(0, 500);
    jwrite('triggers.json', tr);
    return reply(sock, jid, msg, `⚡ Trigger lag gaya! "${word}" likhte hi jawab jayega. ✅`);
  });

  C('watch', 'auto', 'Page par lafz nazar rakho', async (sock, msg, args, { jid }) => {
    const url = ((args || []).join(' ').match(/https?:\/\/[^\s]+/) || [])[0];
    const word = (args || []).join(' ').replace(url || '', '').trim();
    if (!url || !word) return reply(sock, jid, msg, `❌ Usage: *${P}watch <link> <lafz>*`);
    const arr = schedAll();
    arr.push({ id: 'w' + Date.now(), type: 'watch', jid, url, word: word.slice(0, 100), next: Date.now() + 60000, fired: false });
    schedSave(arr);
    return reply(sock, jid, msg, `👁️ *WATCH ON!*\n"${word.slice(0, 40)}" nazar aate hi khabar doongi.\n(Har 30s check — dobara check ke liye dobara lagao)`);
  });

  C('pagetrack', 'web', 'Page changes track karo', async (sock, msg, args, { jid }) => {
    const url = ((args || []).join(' ').match(/https?:\/\/[^\s]+/) || [])[0];
    const sub = (args || [])[0];
    const tk = jread('track.json', {});
    if (!url) return reply(sock, jid, msg, `❌ Usage: *${P}pagetrack <link>* (save) ya *${P}pagetrack check <link>*`);
    if (sub === 'check') {
      const old = (tk[url] || {}).txt;
      if (!old) return reply(sock, jid, msg, '❌ Pehle `.pagetrack <link>` se save karo.');
      const now = await fetchText(url, 3000);
      if (!now) return reply(sock, jid, msg, '❌ Page nahi khul saki.');
      const same = old.slice(0, 500) === now.slice(0, 500);
      return reply(sock, jid, msg, same ? '✅ *Koi change nahi* — page waisa hi hai.' : `🔄 *CHANGE MILA!*\n\nPehle:\n${old.slice(0, 300)}\n\nAb:\n${now.slice(0, 300)}`);
    }
    await reply(sock, jid, msg, '📌 Page save kar rahi hoon... ⏳');
    const txt = await fetchText(url, 3000);
    if (!txt) return reply(sock, jid, msg, '❌ Page nahi khul saki.');
    tk[url] = { txt, ts: Date.now() };
    jwrite('track.json', tk);
    return reply(sock, jid, msg, `📌 *Tracked!* Baad mein *${P}pagetrack check ${url.slice(0, 40)}* se compare karo.`);
  });

  C('pricewatch', 'web', 'Price change monitor', async (sock, msg, args, { jid }) => {
    const url = ((args || []).join(' ').match(/https?:\/\/[^\s]+/) || [])[0];
    const sub = (args || [])[0];
    const pw = jread('pricewatch.json', {});
    const findPrice = (t) => { const m = (t || '').match(/(?:Rs\.?|PKR|₨|\$|USD)\s?[\d,]+(?:\.\d{1,2})?/); return m ? m[0] : null; };
    if (sub === 'check' && url) {
      const old = pw[url];
      if (!old) return reply(sock, jid, msg, '❌ Pehle `.pricewatch <link>` se save karo.');
      const now = await fetchText(url, 6000);
      const np = findPrice(now);
      if (!np) return reply(sock, jid, msg, '❌ Ab price nahi mili page par.');
      if (np === old.price) return reply(sock, jid, msg, `✅ Price same hai: *${np}*`);
      pw[url] = { price: np, ts: Date.now() }; jwrite('pricewatch.json', pw);
      return reply(sock, jid, msg, `💰 *PRICE CHANGE!*\nPehle: ${old.price}\nAb: *${np}*`);
    }
    if (!url) return reply(sock, jid, msg, `❌ Usage: *${P}pricewatch <link>* phir *${P}pricewatch check <link>*`);
    const txt = await fetchText(url, 6000);
    const pr = findPrice(txt);
    if (!pr) return reply(sock, jid, msg, '❌ Page par price nahi mili.');
    pw[url] = { price: pr, ts: Date.now() }; jwrite('pricewatch.json', pw);
    return reply(sock, jid, msg, `💰 *Price saved: ${pr}*\nCheck: *${P}pricewatch check ${url.slice(0, 40)}*`);
  });

  C('availability', 'web', 'Cheez available hai?', async (sock, msg, args, { jid }) => {
    const url = ((args || []).join(' ').match(/https?:\/\/[^\s]+/) || [])[0];
    if (!url) return reply(sock, jid, msg, `❌ Usage: *${P}availability <link>*`);
    await reply(sock, jid, msg, '📦 Check kar rahi hoon... ⏳');
    const txt = await fetchText(url, 4000);
    if (!txt) return reply(sock, jid, msg, '❌ Page nahi khul saki.');
    const ans = await aiNexa(`Is page text ki bunyad par batao: kya product/service AVAILABLE hai ya OUT OF STOCK? Roman Urdu, ek line verdict + wajah:\n${txt.slice(0, 2000)}`, 600);
    return reply(sock, jid, msg, `📦 *AVAILABILITY*\n\n${ans || '❌ Andaza nahi laga saki.'}`);
  });

  C('flow', 'auto', 'Simple workflow runner', async (sock, msg, args, ctx) => {
    const { jid } = ctx;
    const sub = (args || [])[0];
    const flows = jread('flows.json', {});
    if (sub === 'create') {
      const name = (args || [])[1];
      const body = (args || []).slice(2).join(' ');
      if (!name || !body) return reply(sock, jid, msg, `❌ Usage: *${P}flow create <naam> <cmd1> ; <cmd2>*`);
      flows[name] = body.slice(0, 500); jwrite('flows.json', flows);
      return reply(sock, jid, msg, `🌊 Flow *${name}* ban gaya! Chalao: *${P}flow run ${name}*`);
    }
    if (sub === 'run') {
      const body = flows[(args || [])[1]];
      if (!body) return reply(sock, jid, msg, '❌ Flow nahi mila.');
      const { commands: allCmds } = deps;
      for (const p of body.split(/\s*;\s*/).filter(Boolean).slice(0, 5)) {
        const pp = p.startsWith(P) ? p.slice(P.length) : p;
        const [nm, ...a] = pp.trim().split(/\s+/);
        const c = allCmds[(nm || '').toLowerCase()];
        if (!c) continue;
        try { await c.run(sock, msg, a, ctx); await new Promise((r) => setTimeout(r, 800)); } catch {}
      }
      return;
    }
    if (sub === 'list') return reply(sock, jid, msg, `🌊 *FLOWS*\n${Object.keys(flows).map((k) => `• ${k}`).join('\n') || '(koi nahi)'}`);
    return reply(sock, jid, msg, `🌊 *FLOW*\n${P}flow create <naam> <cmd1> ; <cmd2>\n${P}flow run <naam>\n${P}flow list`);
  });

  // ═══ 🎮 GROUP FUN ═══
  C('curse', 'fun', 'Group curse lagao', async (sock, msg, args, { jid, sender }) => {
    const target = (args || [])[0] || '';
    const mins = Math.min(Math.max(parseInt((args || [])[1] || '10', 10), 1), 120);
    const victim = target.replace(/[^0-9]/g, '').slice(-12);
    if (!victim || !jid.endsWith('@g.us')) return reply(sock, jid, msg, `❌ Group mein usage: *${P}curse @user <minutes>*`);
    const m = modes();
    m.curse = m.curse || {};
    m.curse[jid] = { victim, until: Date.now() + mins * 60000, word: 'bro' };
    saveModes(m);
    return reply(sock, jid, msg, `🧿 *CURSE ACTIVATED!* @${victim} par ${mins} min ka saya! 😈\n\nJab bhi ye "bro" bolega → NEXORA random emoji bhejegi!\nToro: *${P}cure @${victim}*`, { mentions: [victim + '@s.whatsapp.net'] });
  });

  C('cure', 'fun', 'Curse toro', async (sock, msg, args, { jid }) => {
    const m = modes();
    if (m.curse) delete m.curse[jid];
    saveModes(m);
    return reply(sock, jid, msg, '🧿✨ Curse toot gaya — sab aazaad! 🕊️');
  });

  C('boss', 'fun', 'Group live mission', async (sock, msg, args, { jid }) => {
    if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye group game hai.');
    const log = chatLog(jid, 60);
    if (log.length < 5) return reply(sock, jid, msg, '❌ Mission ke liye thori activity chahiye.');
    const counts = {};
    log.forEach((m) => { counts[m.s] = (counts[m.s] || 0) + 1; });
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const mission = await AI('Tum game master ho. Roman Urdu mein ek 60-second ka funny group mission banao is format mein:\n╔══ NEXORA BOSS MODE ══╗\nMISSION #XXX\n🎯 ...\n⏱️ Time: 60 sec\n🏆 Winner gets 500 XP\n╚══════════════════════╝', `Group stats: ${top.map(([s, n]) => s + ':' + n + 'msgs').join(', ')}. Mission in stats par based ho.`, 700);
    await sock.sendMessage(jid, { text: mission || '🎯 Mission: agle 60 second mein sab se zyada messages bhejo!' });
    const snapCounts = { ...counts };
    setTimeout(async () => {
      try {
        const now = {};
        chatLog(jid, 120).forEach((m) => { now[m.s] = (now[m.s] || 0) + 1; });
        let win = null, best = -1;
        for (const [s, n] of Object.entries(now)) { const d = n - (snapCounts[s] || 0); if (d > best) { best = d; win = s; } }
        await sock.sendMessage(jid, { text: `🏁 *MISSION END!*\n\n🏆 Winner: @${win} (+${best} msgs) — 500 XP! 🎉` });
      } catch {}
    }, 60000).unref?.();
  });

  C('glitch', 'fun', '30s glitch mode', async (sock, msg, args, { jid }) => {
    const seq = [
      '╔══ NEXORA // ERROR ══╗\n\nSYSTEM: ████████░░ 73%',
      '> command detected\n> reality mismatch\n> user: ???\n> identity: [REDACTED]',
      '████ CONNECTION LOST ████\n▓▒░ bzzzt...',
      '⚠️ WARNING: main tumhein dekh sakti hoon 👁️',
      '✓ SYSTEM RESTORED\nNEXORA ONLINE. 💗\n\n_(sab theek hai Boss, bas mazaak tha 😄)_',
    ];
    await reply(sock, jid, msg, '🌀 Glitch mode ON — 30 second!');
    for (let i = 0; i < seq.length; i++) {
      await new Promise((r) => setTimeout(r, 6000));
      try { await sock.sendMessage(jid, { text: seq[i] }); } catch {}
    }
  });

  C('rift', 'fun', 'Alternate NEXORA mode (15 min)', async (sock, msg, args, { jid }) => {
    const m = modes();
    if ((args || [])[0] === 'close') { delete m.rift; saveModes(m); return reply(sock, jid, msg, '✅ Rift band — normal NEXORA wapas! 💗'); }
    m.rift = { until: Date.now() + 15 * 60000 };
    saveModes(m);
    return reply(sock, jid, msg, `╔═══〔 ⚠️ RIFT OPENED 〕═══╗\n\nReality: NX-09\nNEXORA: *NOT THE SAME*\n\nAI jawab ab 15 min tak alternate style mein aayenge... 👁️\n\nBand karo: *${P}rift close*`);
  });

  C('swap', 'fun', 'Do users ke style swap karo', async (sock, msg, args, { jid }) => {
    const a = ((args || [])[0] || '').replace(/\D/g, '').slice(-10);
    const b = ((args || [])[1] || '').replace(/\D/g, '').slice(-10);
    const mins = Math.min(Math.max(parseInt((args || [])[2] || '10', 10), 1), 60);
    if (!a || !b) return reply(sock, jid, msg, `❌ Usage: *${P}swap @user1 @user2 <minutes>*`);
    const m = modes();
    m.swap = { a, b, until: Date.now() + mins * 60000 };
    saveModes(m);
    return reply(sock, jid, msg, `🪞 *SWAP!* Agle ${mins} min tak bot ke AI jawab in dono ke style mein swapped aayenge! 😄`);
  });

  const chaosPending = {};
  C('chaos', 'fun', 'Random impossible challenge', async (sock, msg, args, { jid, sender }) => {
    chaosPending[jid + sender] = { img: null, audio: null, word: null };
    setTimeout(() => delete chaosPending[jid + sender], 300000).unref?.();
    return reply(sock, jid, msg, `🎲 *NEXORA CHAOS EVENT* ⚠️\n\nTumhara mission:\n📸 Ek random photo bhejo\n🎙️ Ek voice note bhejo\n📝 Ek lafz likho\n\nTeenon milte hi main kuch unexpected banaongi! ⏱️`);
  });

  // ═══ 🖥️ SYSTEM ═══
  C('health', 'sys', 'Bot + server health dashboard', async (sock, msg, args, { jid }) => {
    const mu = process.memoryUsage();
    const totalCmds = Object.keys(deps.commands).length;
    const tasks = schedAll().filter((t) => !t.done).length;
    const up = Math.floor(process.uptime());
    const uh = Math.floor(up / 3600), um = Math.floor((up % 3600) / 60);
    return reply(sock, jid, msg,
      `🖥️ *NEXORA HEALTH*\n\n⏱️ Uptime: ${uh}h ${um}m\n🧠 RAM: ${(mu.rss / 1048576).toFixed(0)}MB / ${(os.totalmem() / 1073741824).toFixed(1)}GB\n⚙️ Load: ${os.loadavg().map((x) => x.toFixed(2)).join(' ')}\n📂 Commands: ${totalCmds}\n⏰ Active tasks: ${tasks}\n👷 Worker: ${process.env.WORKER ? 'YES (' + process.env.WORKER + ')' : 'Manager'}\n\n${mu.rss > 800 * 1048576 ? '⚠️ RAM zyada hai — restart socho.' : '✅ Sab smooth hai!'} 💗`);
  });

  C('console', 'sys', 'Owner diagnostics console', async (sock, msg, args, { jid, sender }) => {
    if (!deps.isOwner(sender)) return reply(sock, jid, msg, '❌ Sirf owner.');
    const sub = (args || [])[0] || 'stats';
    if (sub === 'stats') {
      const a = jread('audit.json', []);
      const cmds = {};
      a.forEach((x) => { cmds[x.cmd] = (cmds[x.cmd] || 0) + 1; });
      const top = Object.entries(cmds).sort((a2, b2) => b2[1] - a2[1]).slice(0, 8);
      return reply(sock, jid, msg, `🖥️ *CONSOLE — stats*\n\nTop commands:\n${top.map(([c, n]) => `• ${P}${c}: ${n}`).join('\n') || '—'}\n\nTotal executions: ${a.length}`);
    }
    if (sub === 'tasks') {
      const t = schedAll().filter((x) => !x.done);
      return reply(sock, jid, msg, `🖥️ *CONSOLE — tasks* (${t.length})\n${t.map((x) => `• ${x.id} [${x.type}] ${new Date(x.next).toLocaleString('en-PK')}`).join('\n') || '—'}`);
    }
    if (sub === 'modes') {
      const m = modes();
      return reply(sock, jid, msg, `🖥️ *CONSOLE — modes*\n\nPanic: ${m.panic ? '🔴 ON' : '🟢 off'}\nLockdown: ${m.lockdown ? '🔴 ON' : '🟢 off'}\nRift: ${m.rift ? 'open' : '—'}\nSwap: ${m.swap ? 'active' : '—'}\nDisabled cats: ${(m.disabledCats || []).join(', ') || '—'}`);
    }
    return reply(sock, jid, msg, `🖥️ *CONSOLE*\n${P}console stats | tasks | modes`);
  }, { owner: true });

  C('plugin', 'sys', 'Modules enable/disable', async (sock, msg, args, { jid }) => {
    const sub = (args || [])[0], cat = (args || [])[1];
    const cats = ['ai', 'memory', 'auto', 'fun', 'sys', 'web', 'media'];
    const m = modes();
    if (sub === 'disable' && cats.includes(cat)) {
      m.disabledCats = [...new Set([...(m.disabledCats || []), cat])]; saveModes(m);
      return reply(sock, jid, msg, `🔌 *${cat}* module OFF (non-owner ke liye).`);
    }
    if (sub === 'enable' && cats.includes(cat)) {
      m.disabledCats = (m.disabledCats || []).filter((c) => c !== cat); saveModes(m);
      return reply(sock, jid, msg, `🔌 *${cat}* module ON! ✅`);
    }
    const counts = {};
    Object.values(CMD_CAT).forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
    return reply(sock, jid, msg, `🔌 *NEXORA PLUGINS*\n\n${cats.map((c) => `${(m.disabledCats || []).includes(c) ? '🔴' : '🟢'} *${c}* — ${counts[c] || 0} commands`).join('\n')}\n\n${P}plugin disable <cat> | ${P}plugin enable <cat>`);
  });

  C('node', 'sys', 'Instances status', async (sock, msg, args, { jid }) => {
    return reply(sock, jid, msg,
      `🛰️ *NEXORA NODE*\n\nRole: ${process.env.WORKER ? '👷 Worker' : '👑 Manager'}\nUptime: ${Math.floor(process.uptime() / 60)} min\nRAM: ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB\nCommands loaded: ${Object.keys(deps.commands).length}\n\n(Multi-session mesh manager par chalta hai 💗)`);
  });

  C('nexus', 'sys', 'Master control dashboard', async (sock, msg, args, { jid }) => {
    const m = modes();
    const tasks = schedAll().filter((t) => !t.done).length;
    const counts = {};
    Object.values(CMD_CAT).forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
    return reply(sock, jid, msg,
      `⬡ *NEXUS CONTROL* ⬡\n\n🧠 ai: ${counts.ai || 0} · 💾 memory: ${counts.memory || 0}\n⚙️ auto: ${counts.auto || 0} · 🎮 fun: ${counts.fun || 0}\n🖥️ sys: ${counts.sys || 0} · 🌐 web: ${counts.web || 0} · 🎨 media: ${counts.media || 0}\n\n⏰ Active tasks: ${tasks}\n🔴 Panic: ${m.panic ? 'ON' : 'off'} · 🟠 Lockdown: ${m.lockdown ? 'ON' : 'off'}\n🌀 Rift: ${m.rift && Date.now() < m.rift.until ? 'OPEN' : '—'}\n\n— ${BOT} 💗`);
  });

  C('link', 'sys', 'Live status card link', async (sock, msg, args, { jid }) => {
    await reply(sock, jid, msg, '🌐 Status card bana rahi hoon... ⏳');
    try {
      const slug = 'nexora-link-' + Math.random().toString(36).slice(2, 8);
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${BOT} — Live Status</title><style>body{background:#001619;color:#EAF7F8;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0} .c{background:#062529;border:1px solid #50E8F455;border-radius:20px;padding:40px;text-align:center;max-width:420px} h1{color:#50E8F4} .dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#3dff8f;box-shadow:0 0 12px #3dff8f;margin-right:8px} .n{font-size:48px;font-weight:800;color:#50E8F4} small{color:#7FA3A7}</style></head><body><div class="c"><h1>⬡ ${BOT}</h1><p><span class="dot"></span><b>ONLINE</b></p><p class="n">${Object.keys(deps.commands).length}</p><p>commands live</p><small>Generated ${new Date().toLocaleString('en-PK')} · Temporary card</small></div></body></html>`;
      const dir = `/tmp/nxlink-${slug}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), html);
      await new Promise((res, rej) => {
        execFile('surge', [dir, `https://${slug}.surge.sh`], { timeout: 90000, env: { ...process.env, HOME: '/home/hatch/workspace/.surge-bot-home', PATH: '/home/hatch/workspace/npm-global/bin:' + process.env.PATH } }, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so)));
      });
      return reply(sock, jid, msg, `🌐 *LINK ready!*\n\nhttps://${slug}.surge.sh\n\n_(temporary status card — ${BOT} online 💗)_`);
    } catch (e) { return reply(sock, jid, msg, '❌ Link nahi ban saka: ' + String(e.message || e).slice(0, 120)); }
  });

  C('auditlog', 'sys', 'Bot actions ka log', async (sock, msg, args, { jid }) => {
    const a = jread('audit.json', []).slice(-15).reverse();
    if (!a.length) return reply(sock, jid, msg, '📋 Abhi koi log nahi.');
    return reply(sock, jid, msg, `📋 *AUDIT LOG*\n\n${a.map((x) => `${new Date(x.ts).toLocaleTimeString('en-PK')} · ${P}${x.cmd} · ${x.s}`).join('\n')}`);
  });

  C('accesslog', 'sys', 'User access history', async (sock, msg, args, { jid, sender }) => {
    const who = ((args || [])[0] || '').replace(/\D/g, '').slice(-10) || String(sender).split('@')[0].replace(/\D/g, '').slice(-10);
    const a = jread('audit.json', []).filter((x) => x.s.endsWith(who) || who.endsWith(x.s)).slice(-15).reverse();
    return reply(sock, jid, msg, `🔑 *ACCESS LOG — ${who}*\n\n${a.map((x) => `${new Date(x.ts).toLocaleString('en-PK')} · ${P}${x.cmd}`).join('\n') || '(koi record nahi)'}`);
  });

  C('replay', 'sys', 'Chat events ka replay', async (sock, msg, args, { jid }) => {
    const log = chatLog(jid, 12);
    const aud = jread('audit.json', []).filter((a) => a.j === jid).slice(-8);
    return reply(sock, jid, msg,
      `⏪ *REPLAY* — last events\n\n💬 Messages:\n${log.map((m) => `• ${m.s}: ${m.t.slice(0, 60)}`).join('\n') || '—'}\n\n⌨️ Commands:\n${aud.map((a) => `• ${P}${a.cmd} (${a.s})`).join('\n') || '—'}`);
  });

  C('panic', 'sys', 'Emergency shutdown', async (sock, msg, args, { jid, sender }) => {
    if (!deps.isOwner(sender)) return reply(sock, jid, msg, '❌ Sirf owner.');
    const m = modes();
    if ((args || [])[0] === 'off') { m.panic = false; saveModes(m); return reply(sock, jid, msg, '🟢 Panic OFF — bot normal.'); }
    m.panic = true; saveModes(m);
    return reply(sock, jid, msg, '🔴 *PANIC MODE ON!*\nSirf owner ke commands chalenge. Band: `.panic off`');
  }, { owner: true });

  C('lockdown', 'sys', 'Features freeze karo', async (sock, msg, args, { jid, sender }) => {
    if (!deps.isOwner(sender)) return reply(sock, jid, msg, '❌ Sirf owner.');
    const m = modes();
    if ((args || [])[0] === 'off') { m.lockdown = false; saveModes(m); return reply(sock, jid, msg, '🟢 Lockdown OFF.'); }
    m.lockdown = true; saveModes(m);
    return reply(sock, jid, msg, '🟠 *LOCKDOWN ON!*\nSirf basic commands (menu, ping, ai) chalenge. Band: `.lockdown off`');
  }, { owner: true });

  C('privacycheck', 'sys', 'Privacy risk audit', async (sock, msg, args, { jid }) => {
    const st = deps.STATE || {};
    const lines = [];
    lines.push(`🔒 aiauto: ${(st.aiauto === false) ? 'OFF ✅ (unknown ko auto-AI nahi)' : 'ON ⚠️'}`);
    lines.push(`🔒 power: ${st.power === false ? 'OFF (bot khamosh)' : 'ON ✅'}`);
    lines.push(`🔒 autoreact: ${st.autoreact ? 'ON ⚠️ (har msg par react)' : 'OFF ✅'}`);
    lines.push(`🔒 antidelete: ${st.antidelete ? 'ON' : 'OFF'}`);
    lines.push(`🔒 panic: ${modes().panic ? '🔴 ON' : 'off ✅'}`);
    lines.push(`🔒 vault notes: ${(jread('vault.json', {}) && Object.keys(jread('vault.json', {})).length) || 0} users`);
    return reply(sock, jid, msg, `🛡️ *PRIVACY CHECK*\n\n${lines.join('\n')}\n\n_(numbers kabhi public reply mein nahi aate ✅)_`);
  });

  C('sessionkill', 'sys', 'Worker session kill karo', async (sock, msg, args, { jid, sender }) => {
    if (!deps.isOwner(sender)) return reply(sock, jid, msg, '❌ Sirf owner.');
    const regPath = path.join(DATA, '..', 'sessions', 'registry.json');
    let reg = {};
    try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch {}
    const digits = ((args || [])[0] || '').replace(/\D/g, '');
    const mainNum = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
    if (!digits) {
      const list = Object.entries(reg).map(([k, e]) => `• ${k} (port ${e.port}, ${e.connected ? 'connected' : 'dead'})`).join('\n');
      return reply(sock, jid, msg, `🖥️ *SESSIONS*\n\n${list || '(koi worker nahi)'}\n\nKill: *${P}sessionkill <number>*`);
    }
    if (mainNum && (digits === mainNum || digits.slice(-10) === mainNum.slice(-10))) return reply(sock, jid, msg, '🛑 Main/owner session kill nahi ho sakta!');
    const e = reg[digits];
    if (!e) return reply(sock, jid, msg, '❌ Session nahi mila.');
    try { if (e.pid) process.kill(e.pid, 'SIGTERM'); } catch {}
    try { fs.rmSync(path.join(DATA, '..', 'sessions', 's_' + digits), { recursive: true, force: true }); } catch {}
    delete reg[digits];
    try { fs.writeFileSync(regPath, JSON.stringify(reg)); } catch {}
    return reply(sock, jid, msg, `💀 Session ${digits} kill + saaf! ✅`);
  }, { owner: true });

  C('permission', 'sys', 'Command permissions', async (sock, msg, args, { jid, sender }) => {
    if (!deps.isOwner(sender)) return reply(sock, jid, msg, '❌ Sirf owner.');
    const [cmd, pol] = args || [];
    const m = modes();
    if (!cmd) {
      const p = m.perms || {};
      return reply(sock, jid, msg, `🔐 *PERMISSIONS*\n\n${Object.entries(p).map(([k, v]) => `• ${P}${k}: ${v}`).join('\n') || '(koi custom nahi)'}\n\nSet: *${P}permission <cmd> <all|owner|off>*`);
    }
    if (!['all', 'owner', 'off'].includes(pol)) return reply(sock, jid, msg, '❌ Policy: all | owner | off');
    m.perms = m.perms || {};
    if (pol === 'all') delete m.perms[cmd]; else m.perms[cmd] = pol;
    saveModes(m);
    return reply(sock, jid, msg, `🔐 *${P}${cmd}* → ${pol} ✅`);
  }, { owner: true });

  C('cfgsnap', 'sys', 'Config ka snapshot', async (sock, msg, args, { jid, sender }) => {
    if (!deps.isOwner(sender)) return reply(sock, jid, msg, '❌ Sirf owner.');
    const st = deps.STATE || {};
    const snap = { ts: Date.now(), mode: 'public', keys: Object.keys(st), aichat: Object.keys(st.aichat || {}).length, settings: Object.keys(st.settings || {}) };
    const snaps = jread('cfgsnap.json', []);
    snaps.push(snap);
    jwrite('cfgsnap.json', snaps.slice(-10));
    return reply(sock, jid, msg, `📸 *CONFIG SNAPSHOT* #${snaps.length}\n📅 ${new Date().toLocaleString('en-PK')}\n🔑 ${snap.keys.length} keys · aichat chats: ${snap.aichat}\n\nMehfooz ho gaya! 💾`);
  }, { owner: true });

  C('clone', 'sys', 'Group config snapshot', async (sock, msg, args, { jid, sender }) => {
    if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Group mein use karo.');
    if (!deps.isOwner(sender)) return reply(sock, jid, msg, '❌ Sirf owner.');
    const st = deps.STATE || {};
    const snap = {
      ts: Date.now(), jid,
      welcome: (st.settings?.welcome || {})[jid] || null,
      goodbye: (st.settings?.goodbye || {})[jid] || null,
    };
    const snaps = jread('clones.json', {});
    snaps[jid] = snap;
    jwrite('clones.json', snaps);
    return reply(sock, jid, msg, `🧬 *GROUP CLONED!*\nSettings ka snapshot le liya.\nRestore: *${P}clonerestore*`);
  }, { owner: true });

  C('clonerestore', 'sys', 'Group config restore karo', async (sock, msg, args, { jid, sender }) => {
    if (!deps.isOwner(sender)) return reply(sock, jid, msg, '❌ Sirf owner.');
    const snap = (jread('clones.json', {})[jid]);
    if (!snap) return reply(sock, jid, msg, '❌ Koi snapshot nahi — pehle `.clone` karo.');
    const st = deps.STATE || {};
    st.settings = st.settings || {};
    if (snap.welcome) { st.settings.welcome = st.settings.welcome || {}; st.settings.welcome[jid] = snap.welcome; }
    if (snap.goodbye) { st.settings.goodbye = st.settings.goodbye || {}; st.settings.goodbye[jid] = snap.goodbye; }
    try { deps.saveState(); } catch {}
    return reply(sock, jid, msg, `🧬 *RESTORED!* ✅\n📅 Snapshot: ${new Date(snap.ts).toLocaleString('en-PK')}`);
  }, { owner: true });

  // ── macros boot-restore ──
  function restoreMacros() {
    try {
      const macros = jread('macros.json', {});
      for (const [name, body] of Object.entries(macros)) {
        if (commands[name]) continue;
        commands[name] = {
          desc: 'Custom macro', hidden: true,
          run: async (s2, m2, a2, ctx2) => {
            const full = body + (a2.length ? ' ' + a2.join(' ') : '');
            const [nm, ...aa] = full.trim().split(/\s+/);
            const c = deps.commands[(nm || '').toLowerCase()];
            if (!c) return reply(s2, ctx2.jid, m2, '❌ Macro ka command nahi mila.');
            return c.run(s2, m2, aa, ctx2);
          },
        };
        CMD_CAT[name] = 'auto';
      }
    } catch {}
  }

  C('nexuslist', 'sys', 'Saari NEXUS commands ki list', async (sock, msg, args, { jid }) => {
    const cats = { ai: '🧠', memory: '💾', auto: '⚙️', fun: '🎮', sys: '🖥️', web: '🌐', media: '🎨' };
    const byCat = {};
    for (const [n, c] of Object.entries(CMD_CAT)) { byCat[c] = byCat[c] || []; byCat[c].push(n); }
    let out = `⬡ *NEXUS COMMANDS* (${Object.keys(CMD_CAT).length}) ⬡\n`;
    for (const [c, em] of Object.entries(cats)) {
      if (!byCat[c]) continue;
      out += `\n${em} *${c.toUpperCase()}*\n${byCat[c].sort().map((n) => `├ ${P}${n}`).join('\n')}\n`;
    }
    return reply(sock, jid, msg, out.slice(0, 3800));
  });

  function nexusMenuBox() {
    const box = (title, cmds) => `╭━━━〔 ${title} 〕━━━\n${cmds.map((c) => `┃ ⬡ ${c}`).join('\n')}\n╰━━━━━━━━━━━━━━━━━━`;
    return box('⬡ NEXUS — ADVANCED', [
      `${P}agent <kaam> — multi-step AI agent 🕵️`,
      `${P}magic — reply: khud samjhe kya karna hai 🪄`,
      `${P}mirror — chat ka AI X-Ray 🪞`,
      `${P}askweb / ${P}deepsearch — web research 🌐`,
      `${P}time / ${P}autotask — scheduling ⏰`,
      `${P}vault — encrypted notes 🔐`,
      `${P}secondbrain — idea vault 🧠`,
      `${P}nexuslist — poori ${Object.keys(CMD_CAT).length} list 📋`,
    ]);
  }

  // ── message hook (handleMessage se call hota hai) ──
  async function onMessage(sock, msg, jid, sender, text) {
    try {
      const m = msg.message || {};
      const t = String(text || '');
      const snum = String(sender || '').split('@')[0].replace(/\D/g, '');
      const key = jid + sender;

      // image → media memory (fire and forget)
      if (m.imageMessage && !msg.key.fromMe) {
        dlMedia(sock, msg, null, 'imageMessage').then((b) => { if (b) mediaPush(b, jid, 'imageMessage'); }).catch(() => {});
      }

      // void absorb
      if (voidPending[key] && !t.startsWith(P)) {
        delete voidPending[key];
        const store = jread('void.json', {});
        const id = 'VX' + Math.random().toString(36).slice(2, 8).toUpperCase();
        store[id] = { t: t.slice(0, 1000) || (m.imageMessage ? '[photo]' : m.videoMessage ? '[video]' : m.audioMessage ? '[audio]' : '[media]'), by: snum, ts: Date.now() };
        jwrite('void.json', store);
        await sock.sendMessage(jid, { text: `🕳️ *ABSORBED.*\n\nID: \`${id}\`\nWapas: *${P}void recall ${id}*` });
        return;
      }

      // chaos collect
      const ch = chaosPending[key];
      if (ch && !t.startsWith(P)) {
        if (m.imageMessage) { const b = await dlMedia(sock, msg, null, 'imageMessage'); if (b) ch.img = b; }
        else if (m.audioMessage) { const b = await dlMedia(sock, msg, null, 'audioMessage'); if (b) ch.audio = b; }
        else if (t.trim()) ch.word = t.trim().slice(0, 50);
        if (ch.img && ch.audio && ch.word) {
          delete chaosPending[key];
          await sock.sendMessage(jid, { text: '🎲 Teenon mil gaye! Chaos buna rahi hoon... ⏳' });
          const heard = await transcribeAudio(ch.audio);
          const ocr = await ocrImage(ch.img);
          const story = await aiNexa(`CHAOS EVENT: teen random cheezein mili hain:\n1. Photo ka text: "${ocr.slice(0, 300) || '(koi text nahi)'}"\n2. Voice note: "${heard.slice(0, 300) || '(samajh nahi aayi)'}"\n3. Lafz: "${ch.word}"\n\nIn teenon ko jor kar ek funny/absurd mini-kahani banao (Roman Urdu, 4-6 lines).`, 1200);
          await sock.sendMessage(jid, { text: `🎲 *CHAOS RESULT* 🎲\n\n${story || 'Chaos itna tha ke kahani ban hi nahi saki! 😄'}` });
        } else {
          const missing = [!ch.img && '📸 photo', !ch.audio && '🎙️ voice note', !ch.word && '📝 lafz'].filter(Boolean).join(', ');
          await sock.sendMessage(jid, { text: `✅ Mil gaya! Baqi: ${missing}` });
        }
        return;
      }

      // ghost mode → no logging
      const gm = modes().ghost || {};
      if (!(gm[jid] && Date.now() < gm[jid])) logMsg(jid, sender, t);

      if (msg.key.fromMe || t.startsWith(P)) return;

      // curse
      const cu = (modes().curse || {})[jid];
      if (cu && Date.now() < cu.until && snum.endsWith(cu.victim.slice(-10)) && t.toLowerCase().includes(cu.word)) {
        const em = ['😈', '🧿', '👻', '⚡', '🌀', '💀', '🤡', '👹'];
        await sock.sendMessage(jid, { text: em[Math.floor(Math.random() * em.length)] + ' _*curse strikes!* 🧿_' });
        return;
      }

      // triggers
      const tr = (jread('triggers.json', {})[jid] || {});
      const tl = t.toLowerCase();
      for (const [w, rtext] of Object.entries(tr)) {
        if (w && tl.includes(w)) { await sock.sendMessage(jid, { text: rtext }); break; }
      }
    } catch {}
  }

  // ── group update hook (.event join rules) ──
  async function onGroupUpdate(sock, u) {
    try {
      if (!u || u.action !== 'add' || !u.id?.endsWith('@g.us')) return;
      const rules = (jread('events.json', {})[u.id] || []).filter((r) => r.type === 'join');
      if (!rules.length) return;
      for (const p of u.participants || []) {
        const tag = '@' + String(p).split('@')[0];
        for (const r of rules) {
          await sock.sendMessage(u.id, { text: r.text.replace(/@user/gi, tag), mentions: [p] }).catch(() => {});
        }
      }
    } catch {}
  }

  restoreMacros();
  return { commands, onMessage, onGroupUpdate, aiPrompt, cmdBlocked, setSock, nexusMenuBox, audit };
}

module.exports = { buildNexus };
