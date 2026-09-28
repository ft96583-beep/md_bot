// ─── NEXORA-MD · command handlers ────────────────────────
// Har command: { desc, admin?, owner?, run(sock, msg, args, ctx) }
// Sirf working commands — koi padding nahi.

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { downloadMediaMessage } = require('@chaeulso/baileys');
const config = require('../config');
const pairAuth = require('./pair-auth'); // 🔐 password pairing system
const { queuePanelPush } = require('./panel-push'); // 📣 Owner Panel push notifications
const { buildNexus } = require('./nexus'); // ⬡ NEXUS advanced command pack
const { buildExclusive, briefingTick, voiceaiOn } = require('./exclusive'); // 🎯 EXCLUSIVE PACK Phase 1-3: Funnel/CRM + VoiceAI/PollMenu + Find/Briefing
const { buildGroupKit } = require('./groupkit'); // 👥 GROUP KIT — group management commands

// ─── secret owner commands (.accounts / .disconnect) ───
// Menu mein NAHI dikhte — sirf owner ko pata hain. Worker process manager
// se localhost par baat karta hai (MANAGER_PORT spawnWorker set karta hai).
const MANAGER_PORT = process.env.MANAGER_PORT || config.port || 3000;
// Worker → manager internal API ke liye stable token (manager .internal_token
// file se load karta hai aur spawnWorker mein workers ko deta hai).
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || (() => { try { return fs.readFileSync(path.join(__dirname, '..', '.internal_token'), 'utf8').trim(); } catch { return ''; } })();

// ─── 🎙 voice engine (voice note → text) ───
// venv: ~/workspace/voice-env (faster-whisper) · model: ~/workspace/voice-models/base
const VOICE_PY = path.join(__dirname, 'voice.py');
const VOICE_VENV_PY = '/home/hatch/workspace/voice-env/bin/python';
function transcribeVoice(file) {
  return new Promise((resolve) => {
    execFile(VOICE_VENV_PY, [VOICE_PY, file], { timeout: 90000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const d = JSON.parse(String(stdout).trim().split('\n').pop());
        resolve(d.text ? d : null);
      } catch { resolve(null); }
    });

  });
}

// Voice note mein boli hui baat → bot command.
// Roman Urdu + Urdu script dono ke keywords (whisper auto-detect karta hai).
const VOICE_MAP = [
  { k: ['tasveer banao', 'tasveer', 'image banao', 'photo banao', 'imagine', 'تصویر بناؤ', 'تصویر'], cmd: 'imagine', rest: true },
  { k: ['dp banao', 'dp', 'ڈی پی'], cmd: 'dp', rest: true },
  { k: ['sticker banao', 'sticker', 'سٹیکر'], cmd: 'sticker' },
  { k: ['menu dikhao', 'menu', 'مینیو'], cmd: 'menu' },
  { k: ['ping'], cmd: 'ping' },
  { k: ['joke sunao', 'joke', 'latifa', 'لطیفہ'], cmd: 'joke' },
  { k: ['shayari sunao', 'shayari', 'sher sunao', 'شاعری'], cmd: 'shayari' },
  { k: ['mausam', 'weather', 'موسم'], cmd: 'weather', rest: true },
  { k: ['gana', 'geet', 'lyrics', 'گانا'], cmd: 'lyrics', rest: true },
  { k: ['bolo', 'sunao', 'say'], cmd: 'say', rest: true },
  { k: ['tarjuma', 'translate'], cmd: 'tr', rest: true },
  { k: ['qr banao', 'qr'], cmd: 'qr', rest: true },
  { k: ['tiktok'], cmd: 'tiktok', rest: true },
  { k: ['sawal', 'poocho', 'batao', 'سوال'], cmd: 'ai', rest: true },
  { k: ['meme banao', 'meme'], cmd: 'meme', rest: true },
  { k: ['channel react', 'react cycle', 'channel par react'], cmd: 'creact', rest: true },
  { k: ['screenshot lo', 'screenshot', 'website ka screenshot', 'site ka screenshot'], cmd: 'ss', rest: true },
];
function mapVoiceToCommand(heard) {
  // Sirf standalone dots hatao (".menu" bola ho to) — URL ke dot mehfooz
  let t = ' ' + heard.toLowerCase().replace(/[۔،!؟?'"،]/g, ' ');
  t = t.replace(/(^|\s)\.(\s|$)/g, ' ').replace(/\s+/g, ' ') + ' ';
  const dot = t.match(/\.\s?([a-z]{2,12})\b/); // ".menu" jaisa literal
  if (dot && commands[dot[1]]) {
    const after = t.slice(t.indexOf(dot[0]) + dot[0].length).trim();
    return '.' + dot[1] + (after ? ' ' + after : '');
  }
  // Filler verbs jo aksar jumle ke aakhir mein aate hain — args se kaato
  const clean = (s) => s.replace(/\s+(ka|ki|ke|ko|batao|bata|dikhao|dikha|sunao|suna|karo|kar|de|do|zara|bhai|boss)\s*$/g, '').trim();
  for (const e of VOICE_MAP) {
    for (const k of e.k) {
      const i = t.indexOf(' ' + k);
      if (i === -1) continue;
      const rest = clean(t.slice(i + k.length + 1).replace(/\s+/g, ' '));
      return '.' + e.cmd + (e.rest && rest ? ' ' + rest : '');
    }
  }
  return null;
}

const COBALT = 'https://co.otomir23.me/'; // cobalt v11 API (POST /)

// ─── persistent state (antidelete, aichat, autoreact, mode) ───
const STATE_PATH = process.env.STATE_FILE || path.join(__dirname, '..', 'state.json');
let STATE = { antidelete: false, aichat: [], autoreact: false, mode: 'public', contactMap: {}, settings: {} };
try { STATE = { ...STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) }; } catch {}
function saveState() { try { fs.writeFileSync(STATE_PATH, JSON.stringify(STATE)); } catch {} }
// aichat: purana array format → naya object format { jid: 'on'|'off'|'auto' }
if (Array.isArray(STATE.aichat)) {
  const o = {};
  for (const j of STATE.aichat) if (j) o[j] = 'on';
  STATE.aichat = o;
}
if (!STATE.ownerChats || typeof STATE.ownerChats !== 'object' || Array.isArray(STATE.ownerChats)) STATE.ownerChats = {};
if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {};
if (!STATE.gactive || typeof STATE.gactive !== 'object') STATE.gactive = {};
if (!STATE.tracked || typeof STATE.tracked !== 'object') STATE.tracked = {};
if (!STATE.tictactoe || typeof STATE.tictactoe !== 'object') STATE.tictactoe = {};
// 🌍 GLOBAL aichat: saare sessions (manager + workers) ek hi file parhte/likhte hain,
// taake `.aichat off` kisi bhi number par chalao — har number par laagu ho.
const AICHAT_GLOBAL_PATH = path.join(__dirname, '..', 'sessions', 'aichat.json');
function readGlobalAichat() {
  try { const o = JSON.parse(fs.readFileSync(AICHAT_GLOBAL_PATH, 'utf8')); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
function writeGlobalAichat(jid, mode) {
  try {
    const o = readGlobalAichat();
    if (mode) o[jid] = mode; else delete o[jid];
    const tmp = AICHAT_GLOBAL_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o));
    fs.renameSync(tmp, AICHAT_GLOBAL_PATH);
  } catch {}
}
// purani per-session settings ko ek baar global mein lao (sirf khaali keys bharti hain — overwrite nahi)
try {
  const g = readGlobalAichat();
  const mine = (STATE.aichat && typeof STATE.aichat === 'object' && !Array.isArray(STATE.aichat)) ? STATE.aichat : {};
  let changed = false;
  for (const k of Object.keys(mine)) if (g[k] === undefined && (mine[k] === 'on' || mine[k] === 'off')) { g[k] = mine[k]; changed = true; }
  if (changed) { const tmp = AICHAT_GLOBAL_PATH + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(g)); fs.renameSync(tmp, AICHAT_GLOBAL_PATH); }
} catch {}
// 🌍 GLOBAL master switches (aiauto/power): workers ki apni state file aksar hoti hi nahi,
// is liye per-session switches wahan kabhi nahi pahunchte thay — `.aiauto off` sirf ek
// number par lagta tha, baqi numbers unknown ko AI jawab bhejte rehte thay. Ab ye file
// sab sessions (manager + workers) parhte/likhte hain: ek number par off = sab par off.
const GLOBAL_SWITCH_PATH = path.join(__dirname, '..', 'sessions', 'global.json');
function readGlobalSwitches() {
  try { const o = JSON.parse(fs.readFileSync(GLOBAL_SWITCH_PATH, 'utf8')); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
function writeGlobalSwitch(k, v) {
  try {
    const o = readGlobalSwitches(); o[k] = v;
    const tmp = GLOBAL_SWITCH_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, GLOBAL_SWITCH_PATH);
  } catch {}
}
// migrate: jis session mein pehle se off tha, use global banao (sirf khaali keys)
try {
  const g = readGlobalSwitches(); let ch = false;
  if (g.aiauto === undefined && STATE.aiauto === false) { g.aiauto = false; ch = true; }
  if (g.power === undefined && STATE.power === false) { g.power = false; ch = true; }
  if (ch) { const tmp = GLOBAL_SWITCH_PATH + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(g)); fs.renameSync(tmp, GLOBAL_SWITCH_PATH); }
} catch {}
function globalAiauto() { try { const v = readGlobalSwitches().aiauto; return v === undefined ? STATE.aiauto : v; } catch { return STATE.aiauto; } }
function globalPower() { try { const v = readGlobalSwitches().power; return v === undefined ? STATE.power : v; } catch { return STATE.power; } }
// 🔌 POWER SWITCH: false = bot mukammal khamosh (sirf owner commands). Default ON.
if (STATE.power === undefined) STATE.power = true;
// 🤖 AI AUTO SWITCH: false = unknown numbers ko khud AI jawab nahi (sirf explicit .aichat on wale chats). Default ON.
if (STATE.aiauto === undefined) STATE.aiauto = true;
if (STATE.settings.prefix) config.prefix = String(STATE.settings.prefix);
if (STATE.settings.botname) config.botName = String(STATE.settings.botname);

// ─── multi-account .creact fan-out (index.js manager inject karta hai) ───
// Har connected worker apna 1 reaction dega → tally = accounts ki tadaad.
// (WhatsApp: ek account = ek post par sirf 1 reaction — same emoji repeat se count nahi barhta.)
let CREACT_FANOUT = null;
function setCreactFanout(fn) { CREACT_FANOUT = fn; }

// ─── 👥 Owner Panel — leads (contact inbox) ───
// User worker/group mein .contact kare → manager ke STATE.leads mein save.
// Owner ko WhatsApp par KOI forward nahi jata — sab kuch sirf web panel par.
if (!STATE.leads || typeof STATE.leads !== 'object' || Array.isArray(STATE.leads)) STATE.leads = {};
// Disconnected accounts ka record (panel se ya command se disconnect hue) — count ke liye.
if (!Array.isArray(STATE.disconnected)) STATE.disconnected = [];
const maskLogNum = (n) => { const d = String(n || '').replace(/\D/g, ''); return d.length <= 4 ? '****' : '…' + d.slice(-4); };
function recordDisconnect({ number, via }) {
  const d = String(number || '').replace(/\D/g, '');
  if (!d) return false;
  STATE.disconnected.push({ number: d, at: Date.now(), via: via || 'panel' });
  saveState();
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'disconnects.log'),
      `${new Date().toISOString()} disconnect number=${maskLogNum(d)} via=${via || 'panel'}\n`);
  } catch {}
  return true;
}
function getDisconnected() { return Array.isArray(STATE.disconnected) ? STATE.disconnected : []; }
const leadKey = (j) => String(j || '').toLowerCase();
// ":device" suffix wali JID ko saaf karo — ye sender ke apne session ka device id
// hai (jaise sock.user.id = 92349...:4@s.whatsapp.net), chat ka pata NAHI.
// Is par bheja hua reply Baileys ko "kamyaab" lagta hai lekin WhatsApp kabhi
// deliver nahi karta (panel mein bubble lag jata hai, message nahi pahunchta).
// Is liye lead HAMESHA saaf JID (92349...@s.whatsapp.net) par save honi chahiye.
const cleanChatJid = (j) => String(j || '').replace(/:\d+@/, '@');
// ── Migration: purani kharab lead keys (":device" wali) ko saaf JID par lao ──
try {
  for (const k of Object.keys(STATE.leads || {})) {
    const ck = leadKey(cleanChatJid(k));
    if (ck && ck !== k) {
      const L = STATE.leads[k] || {};
      if (STATE.leads[ck] && typeof STATE.leads[ck] === 'object') {
        const T = STATE.leads[ck];
        T.messages = [...(T.messages || []), ...(L.messages || [])].sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-200);
        T.replies = (T.replies || 0) + (L.replies || 0);
        T.unread = (T.unread || 0) + (L.unread || 0);
        T.lastAt = Math.max(T.lastAt || 0, L.lastAt || 0);
        if (!T.worker && L.worker) T.worker = L.worker;
      } else STATE.leads[ck] = L;
      delete STATE.leads[k];
    }
  }
} catch {}
function saveLeadIn({ userJid, name, phone, worker, text }) {
  const k = leadKey(cleanChatJid(userJid));
  if (!k) return false;
  if (!STATE.leads[k] || typeof STATE.leads[k] !== 'object') {
    STATE.leads[k] = { name: 'Unknown', phone: '', worker: '', firstAt: Date.now(), lastAt: 0, unread: 0, messages: [], replies: 0 };
  }
  const L = STATE.leads[k];
  if (name) L.name = String(name).slice(0, 60);
  if (phone) L.phone = String(phone);
  if (worker) L.worker = String(worker);
  L.messages.push({ dir: 'in', text: String(text || '').slice(0, 1000), at: Date.now() });
  if (L.messages.length > 200) L.messages = L.messages.slice(-200);
  L.unread = (L.unread || 0) + 1;
  L.lastAt = Date.now();
  saveState();
  return true;
}
function saveLeadOut({ userJid, text, kind }) {
  const L = STATE.leads[leadKey(cleanChatJid(userJid))];
  if (!L) return false;
  // Purane 'discount' records bhi ab sirf reply ke tor par dikhte hain.
  const k2 = kind === 'reply' ? 'reply' : 'reply';
  L.messages.push({ dir: 'out', kind: k2, text: String(text || '').slice(0, 1000), at: Date.now() });
  if (L.messages.length > 200) L.messages = L.messages.slice(-200);
  L.replies = (L.replies || 0) + 1;
  if (L.discounts) delete L.discounts; // purani migration: discount counter hatao
  L.unread = 0;
  L.lastAt = Date.now();
  saveState();
  return true;
}
function markLeadRead(userJid) {
  const L = STATE.leads[leadKey(cleanChatJid(userJid))];
  if (L && L.unread) { L.unread = 0; saveState(); }
}
function getLeadStats() {
  const ks = Object.keys(STATE.leads || {});
  let messages = 0, replies = 0, unread = 0;
  for (const k of ks) {
    const L = STATE.leads[k] || {};
    messages += (L.messages || []).filter((m) => m && m.dir === 'in').length;
    replies += L.replies || 0; unread += L.unread || 0;
  }
  return { users: ks.length, messages, replies, unread, disconnected: getDisconnected().length };
}
function getLeadInbox() {
  return Object.entries(STATE.leads || {}).map(([jid, L]) => {
    const msgs = (L && L.messages) || [];
    const last = msgs[msgs.length - 1] || {};
    return {
      jid, name: L.name || 'Unknown', phone: L.phone || '', worker: L.worker || '',
      lastAt: L.lastAt || 0, unread: L.unread || 0,
      msgCount: msgs.filter((m) => m && m.dir === 'in').length,
      lastText: String(last.text || '').slice(0, 120), lastDir: last.dir || '', lastKind: last.kind === 'discount' ? 'reply' : (last.kind || ''),
    };
  }).sort((a, b) => b.lastAt - a.lastAt);
}
function getLeadThread(userJid) {
  const L = STATE.leads[leadKey(userJid)];
  if (!L) return null;
  return (L.messages || []).map((m) => (m && m.kind === 'discount') ? { ...m, kind: 'reply' } : m);
}
// ownerChats: jin private chats mein owner ne khud kabhi message bheja (known contacts)
// → unknown number ka pata isi se chalta hai (owner ne kabhi baat nahi ki = unknown)
let MODE = STATE.mode === 'self' ? 'self' : 'public'; // public | self (owner-only runtime mode, persisted)
const tempMailBox = new Map(); // jid -> mailbox name

// ─── owner activity log (kaun user kya command chalata hai) ───
// Sirf accepted commands log hoti hain (spam rate-limit se pehle hi girta hai).
// Ring buffer: aakhri 200 entries. Sirf owner (.activity / .users) dekh sakta hai.
const ACT = []; // { t, u, c, g }
function logActivity(sender, cmd, jid) {
  try {
    ACT.push({
      t: Date.now(),
      u: String(sender).replace(/\D/g, '').slice(-13),
      c: String(cmd).toLowerCase().slice(0, 24),
      g: String(jid || '').endsWith('@g.us') ? 'group' : 'private',
    });
    if (ACT.length > 200) ACT.splice(0, ACT.length - 200);
  } catch {}
}

// ─── anti-ban rate limiter (sirf non-owner) ───
// WhatsApp aggressive bots ko flag karta hai — koi bahar wala tumhare bot ko
// spam karke tumhara number risk mein na daal sake, is liye:
// • har command ke darmiyan 2.5s ka waqfa (khamosh ignore)
// • har user max 25 commands per 5 min → pehle warning, phir khamosh ignore
// • 5 min window mein 5 dafa limit torne par 10 MIN MUTE (spam rokne ke liye)
// Owner (tum) is se mustasna ho.
const RL_MAX = 25, RL_WINDOW = 5 * 60 * 1000, RL_GAP = 2500;
const RL_MUTE_STRIKES = 5, RL_MUTE_MS = 10 * 60 * 1000;
const rateMap = new Map(); // sender -> { count, windowStart, lastCmd, warned, strikes, muteUntil, muteWarned }
function rateLimitCheck(sender) {
  const now = Date.now();
  let r = rateMap.get(sender);
  if (!r) { r = { count: 0, windowStart: now, lastCmd: 0, warned: 0, strikes: 0, muteUntil: 0, muteWarned: 0 }; rateMap.set(sender, r); }
  if (now < r.muteUntil) {
    if (now - r.muteWarned > 60000) { r.muteWarned = now; return 'muted-warn'; }
    return 'muted';
  }
  if (now - r.windowStart > RL_WINDOW) { r.count = 0; r.windowStart = now; r.warned = 0; r.strikes = 0; }
  if (rateMap.size > 500) { // memory saaf rakho
    for (const [k, v] of rateMap) if (now - v.windowStart > 2 * RL_WINDOW && now > v.muteUntil) rateMap.delete(k);
  }
  if (now - r.lastCmd < RL_GAP) return 'slow';
  if (r.count >= RL_MAX) {
    r.strikes += 1;
    if (r.strikes >= RL_MUTE_STRIKES) {
      r.muteUntil = now + RL_MUTE_MS;
      r.muteWarned = 0;
      return 'muted-new';
    }
    if (now - r.warned > 60000) { r.warned = now; return 'quota-warn'; }
    return 'quota';
  }
  r.count += 1;
  r.lastCmd = now;
  return null;
}
// Owner kisi ko mute se chhutkara de sake
function unmuteSender(digits) {
  const want = String(digits || '').replace(/\D/g, '').slice(-10);
  if (!want) return 0;
  let n = 0;
  for (const k of [...rateMap.keys()]) {
    if (String(k).replace(/\D/g, '').slice(-10) === want) { rateMap.delete(k); n++; }
  }
  return n;
}

// ─── anti-delete message cache (LRU, max 200; text restart-proof) ───
const msgCache = new Map();
const ADCACHE_MAX = 200;
const adTextCache = new Map(); // persistent text-only fallback (restart-proof)
try {
  for (const [k, v] of (STATE.adcache || [])) {
    if (k && v) adTextCache.set(k, v);
  }
} catch {}
function adCacheSet(ck, entry) {
  msgCache.set(ck, entry);
  if (msgCache.size > ADCACHE_MAX) msgCache.delete(msgCache.keys().next().value);
  // text entries restart-proof banao (foran disk par — restart ke baad bhi pakra jaye)
  if (entry.text) {
    try {
      adTextCache.set(ck, { text: entry.text, pushName: entry.pushName, mediaKind: entry.mediaKind });
      const arr = [...adTextCache.entries()].slice(-150);
      adTextCache.clear(); for (const [k, v] of arr) adTextCache.set(k, v);
      STATE.adcache = arr; saveState();
    } catch {}
  }
}
function adCacheGet(ck, id) {
  let hit = msgCache.get(ck);
  if (hit) return hit;
  hit = adTextCache.get(ck);
  if (hit) return hit;
  // id-only fallback (agar chat key kisi wajah se mismatch ho)
  if (id) {
    for (const [k, v] of msgCache) if (k.endsWith('|' + id)) return v;
    for (const [k, v] of adTextCache) if (k.endsWith('|' + id)) return v;
  }
  return null;
}
function cacheMessage(msg, jid) {
  try {
    const m = msg.message || {};
    if (m.protocolMessage) return;
    const id = msg.key?.id;
    if (!id) return;
    const text = getText(msg);
    const kind = m.imageMessage ? 'imageMessage' : m.videoMessage ? 'videoMessage' : m.stickerMessage ? 'stickerMessage' : m.audioMessage ? 'audioMessage' : null;
    const mediaMsg = kind ? m[kind] : null;
    const entry = { text, pushName: msg.pushName || '', mediaKind: kind, mimetype: mediaMsg?.mimetype || null, buffer: null };
    if (kind) {
      const len = mediaMsg.fileLength || 0;
      if (kind === 'videoMessage' && len > 25 * 1024 * 1024) return; // bohat bari video skip
      downloadMediaMessage({ key: msg.key, message: { [kind]: mediaMsg } }, 'buffer', {})
        .then((buf) => { entry.buffer = buf; })
        .catch(() => {});
    }
    if (!entry.text && !entry.mediaKind) return;
    adCacheSet(jid + '|' + id, entry);
  } catch {}
}

// ─── 👁️ View-Once Saver (2026-09-27): view-once aate hi foran disk par save ───
// Boss ka hukm: "jo khol bhi li ho phir bhi open ho" — WhatsApp server se delete
// hone se PEHLE bot apne paas copy rakh lega, taake baad mein .vv se khul sake.
// Sirf AAGE se aane wali view-once ke liye kaam karega (purani recover nahi hoti).
const VVCACHE_DIR = path.join(__dirname, '..', 'data', 'vvcache');
const VVCACHE_INDEX = path.join(VVCACHE_DIR, 'index.json');
const VVCACHE_MAX = 30;
function vvCacheLoad() {
  try {
    const a = JSON.parse(fs.readFileSync(VVCACHE_INDEX, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function vvCacheSave(idx) {
  try { fs.writeFileSync(VVCACHE_INDEX, JSON.stringify(idx.slice(-VVCACHE_MAX))); } catch {}
}
function vvCacheFind(id) {
  if (!id) return null;
  const sid = String(id);
  return vvCacheLoad().find((e) => String(e.id) === sid) || null;
}
function cacheViewOnce(msg, jid) {
  try {
    const m = msg.message || {};
    if (m.protocolMessage) return;
    const vo = extractViewOnce(m);
    if (!vo) return;
    const id = msg.key?.id;
    if (!id) return;
    const { imgM, vidM, stM, audM } = vo;
    let kind = null, mediaMsg = null, ext = null;
    if (imgM) { kind = 'image'; mediaMsg = { imageMessage: imgM }; ext = 'jpg'; }
    else if (vidM) { kind = 'video'; mediaMsg = { videoMessage: vidM }; ext = 'mp4'; }
    else if (audM) { kind = 'audio'; mediaMsg = { audioMessage: audM }; ext = 'ogg'; }
    else if (stM) { kind = 'sticker'; mediaMsg = { stickerMessage: stM }; ext = 'webp'; }
    else return;
    const len = (imgM || vidM || audM || stM).fileLength || 0;
    if (kind === 'video' && len > 20 * 1024 * 1024) return; // bohat bari video skip
    if (vvCacheFind(id)) return; // pehle se saved
    const sender = msg.key.fromMe ? '' : (msg.key.participant || jid);
    const pushName = msg.pushName || '';
    // foran download (fire-and-forget) — user ke dekhne se pehle copy pakki
    downloadMediaMessage({ key: msg.key, message: mediaMsg }, 'buffer', {})
      .then((buf) => {
        try {
          if (!buf || !buf.length) return;
          fs.mkdirSync(VVCACHE_DIR, { recursive: true });
          const ts = Date.now();
          const file = ts + '_' + String(id).replace(/\W/g, '').slice(-12) + '.' + ext;
          fs.writeFileSync(path.join(VVCACHE_DIR, file), buf);
          const idx = vvCacheLoad();
          if (idx.find((e) => String(e.id) === String(id))) return;
          idx.push({ id: String(id), chat: jid, sender: sender ? num(sender) : 'me', pushName, kind, file, time: ts });
          while (idx.length > VVCACHE_MAX) {
            const old = idx.shift();
            try { fs.unlinkSync(path.join(VVCACHE_DIR, old.file)); } catch {}
          }
          vvCacheSave(idx);
        } catch {}
      })
      .catch(() => {});
  } catch {}
}
async function vvSendCached(sock, msg, sender, e) {
  const inboxJid = vvInboxJid(sender);
  const buf = fs.readFileSync(path.join(VVCACHE_DIR, e.file));
  const caption = `👁️ *View-once (saved copy)* 💾\n_— ${config.botName}_`;
  if (e.kind === 'image') await sock.sendMessage(inboxJid, { image: buf, caption });
  else if (e.kind === 'video') await sock.sendMessage(inboxJid, { video: buf, caption });
  else if (e.kind === 'audio') await sock.sendMessage(inboxJid, { audio: buf, ptt: true });
  else await sock.sendMessage(inboxJid, { sticker: buf });
}

// Delete-for-everyone pakro → owner inbox mein forward (sirf antidelete ON par)
async function checkRevoke(sock, msg, jid) {
  const proto = msg.message?.protocolMessage;
  if (!proto) return false;
  const t = proto.type;
  if (t !== 0 && t !== 'REVOKE') return false;
  if (!STATE.antidelete || !config.owner) return true;
  try {
    const rk = proto.key || {};
    const ck = (rk.remoteJid || jid) + '|' + rk.id;
    const hit = adCacheGet(ck, rk.id);
    msgCache.delete(ck); adTextCache.delete(ck);
    try { STATE.adcache = [...adTextCache.entries()]; saveState(); } catch {}
    const ownerJid = num(config.owner) + '@s.whatsapp.net';
    const who = msg.pushName || num(rk.participant || '') || 'koi';
    try { console.log(`[antidelete] revoke pakra: ${jid} | id=${rk.id} | hit=${hit ? 'YES' : 'NO'}`); } catch {}
    if (!hit) {
      await sock.sendMessage(ownerJid, { text: `🗑️ *Kisi ne message delete kiya!*\n👤 ${who}\n💬 ${jid}\n\n(Message cache mein nahi tha — bot ke online hone ke baad wala message hona chahiye tha)` });
      return true;
    }
    const cap = `🗑️ *Delete pakra gaya!*\n👤 ${hit.pushName || who}\n💬 ${jid}`;
    if (hit.buffer && hit.mediaKind === 'imageMessage') await sock.sendMessage(ownerJid, { image: hit.buffer, caption: cap + (hit.text ? `\n\n📝 ${hit.text}` : '') });
    else if (hit.buffer && hit.mediaKind === 'videoMessage') await sock.sendMessage(ownerJid, { video: hit.buffer, caption: cap + (hit.text ? `\n\n📝 ${hit.text}` : '') });
    else if (hit.buffer && hit.mediaKind === 'stickerMessage') await sock.sendMessage(ownerJid, { sticker: hit.buffer });
    else if (hit.buffer && hit.mediaKind === 'audioMessage') await sock.sendMessage(ownerJid, { audio: hit.buffer, mimetype: hit.mimetype || 'audio/ogg; codecs=opus' });
    else await sock.sendMessage(ownerJid, { text: cap + `\n\n📝 ${hit.text || '(koi text nahi)'}` });
  } catch {}
  return true;
}

// Nexa AI — careful, contextual replies (Roman Urdu, feminine persona)
const NEXA_SYSTEM_URDU = 'You are Nexa, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do. Tum larki ho: APNE liye feminine grammar istemal karo (rahi hoon, karongi, sakti hoon, bataongi). USER ki gender kabhi assume mat karo — hamesha "aap" kaho aur gender-neutral alfaz istemal karo (karein, bataein, chahein); user ko "sakte hain / sakti hain" jaisi gender wali baat kabhi mat kaho. Lehja casual aur dostana rakho, khushmizaj larki jaisi — formal ya robotic nahi. Greeting (salam, aoa, hello, hi) par seedha garamjoshi se jawab do aur poocho kis cheez mein madad kar sakti hoon — "samajh nahi aaya" kabhi mat kaho. Misaal: user "salam" kahe to jawab do: "Walekum salam! 💗 Kya haal hain? Bataein, mein aapki kya madad kar sakti hoon?" User ki baat dhyaan se samajh kar USI ka jawab do. Jawab mukhtasir rakho (1-3 lines), jab tak user tafseel na mange. Kabhi Devanagari script istemal na karo.';
// 🌍 Bot language — owner .setlang se badalta hai; Nexa ki AI persona isi mein baat karti hai
function nexaSystem() {
  const lang = String(getSetting('lang', '') || '').trim();
  if (!lang || /^(roman )?urdu$/i.test(lang)) return NEXA_SYSTEM_URDU;
  return 'You are Nexa, the friendly female AI assistant of the NEXORA-MD WhatsApp bot. ' +
    'Always reply in ' + lang.slice(0, 40) + '. ' +
    'Speak as a cheerful, warm girl — casual and friendly, never formal or robotic. ' +
    'Keep replies short (1-3 lines) unless the user asks for detail. ' +
    'On greeting, respond warmly and ask how you can help — never say you did not understand.';
}

// --- AI resilience (2026-09-25): semaphore + multi-path retry chain ---
// Pollinations ka keyless tier kabhi kabhi thori der ke liye atakta hai.
// Is liye: (1) ek waqt mein max 4 AI calls (burst se khud throttle na ho),
// (2) 3 mukhtalif raaste (POST -> /openai JSON -> GET), har raaste par retry,
// (3) API ki shikayat (credit/quota/rate-limit text) kabhi user tak nahi jayegi.
const AI_MAX_INFLIGHT = 4;
let _aiInflight = 0;
const _aiWaiters = [];
function _aiAcquire() {
  return new Promise((resolve) => {
    if (_aiInflight < AI_MAX_INFLIGHT) { _aiInflight++; return resolve(); }
    const to = setTimeout(() => {
      const i = _aiWaiters.indexOf(done); if (i >= 0) _aiWaiters.splice(i, 1);
      _aiInflight++; resolve(); // 15s se zyada intezar nahi — koshish zaroor hogi
    }, 15000);
    const done = () => { clearTimeout(to); _aiInflight++; resolve(); };
    _aiWaiters.push(done);
  });
}
function _aiRelease() {
  _aiInflight = Math.max(0, _aiInflight - 1);
  const w = _aiWaiters.shift(); if (w) w();
}
const _isApiErrorText = (t) => /not enough credits|top[\s-]?up|complete a quest|api key|rate limit|quota exceeded|ERR_CHALLENGE/i.test(t || '');
const _aiNap = (ms) => new Promise((r) => setTimeout(r, ms));
async function _aiPost(messages, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('https://text.pollinations.ai/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, model: 'openai', temperature: 0.9 }), signal: ctrl.signal,
    });
    clearTimeout(t);
    const raw = (await res.text()).trim();
    if (!raw || raw.startsWith('<') || _isApiErrorText(raw)) return '';
    return raw.slice(0, 2000);
  } catch { return ''; }
}
async function _aiOpenAI(messages, timeoutMs) {
  try { // OpenAI-compatible JSON raasta — alag code path, alag mizaj
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai', messages, temperature: 0.9 }), signal: ctrl.signal,
    });
    clearTimeout(t);
    const raw = (await res.text()).trim();
    if (!raw || raw.startsWith('<') || _isApiErrorText(raw)) return '';
    const j = JSON.parse(raw);
    const ans = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    if (!ans || _isApiErrorText(ans)) return '';
    return ans.slice(0, 2000);
  } catch { return ''; }
}
async function _aiGet(text, timeoutMs) {
  try { // simple GET (bina persona ke) — aakhri sahara
    const r2 = await fetch('https://text.pollinations.ai/' + encodeURIComponent(String(text).slice(0, 500)),
      { signal: AbortSignal.timeout(timeoutMs) });
    const t2 = (await r2.text()).trim();
    if (!t2 || t2.startsWith('<') || _isApiErrorText(t2)) return '';
    return t2.slice(0, 2000);
  } catch { return ''; }
}
// --- HUGGINGFACE (2026-09-25): free inference token wala primary provider ---
// Pollinations ka anonymous tier ab lambe prompts par credit error deta hai,
// Groq/SiliconFlow/Cerebras signup CAPTCHA par ruk gaye —
// HuggingFace (Qwen 2.5 72B) free inference token asal kaam karega; Pollinations backup rahega.
const HF_KEY = (() => {
  try {
    return require('fs').readFileSync(require('path').join(__dirname, '..', '.hf_key'), 'utf8').trim();
  } catch { return ''; }
})();
async function _aiHF(sysMessages, timeoutMs) {
  if (!HF_KEY) return '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + HF_KEY },
      body: JSON.stringify({ model: 'Qwen/Qwen2.5-72B-Instruct', messages: sysMessages, temperature: 0.9, max_tokens: 800 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return '';
    const j = await res.json();
    const ans = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '').trim();
    if (!ans || _isApiErrorText(ans)) return '';
    return ans.slice(0, 2000);
  } catch { return ''; }
}
// 2026-09-26 speed: kayi AI raaste parallel — pehla saaf jawab jeet-ta hai (losers ignore).
// (HF 30s ka stall ab Pollinations ko rokta nahi; har raaste ka apna timeout hai, loser khud band hota hai.)
function _firstAiAnswer(promises) {
  return new Promise((resolve) => {
    let pending = promises.length;
    if (!pending) return resolve('');
    const settle = (v) => {
      if (v && String(v).trim() && !_isApiErrorText(v)) return resolve(v);
      if (--pending === 0) resolve('');
    };
    promises.forEach((p) => Promise.resolve(p).then(settle, () => { if (--pending === 0) resolve(''); }));
  });
}
async function chatComplete(system, text, hist) {
  // 2026-09-25: Pollinations ab `system` role / lambe prompts par credit mangta hai
  // (anonymous tier). Is liye:
  //  - HuggingFace (inference token): ASAL system prompt ke saath — primary raasta.
  //  - Pollinations: system prompt ko user message mein lapait kar — backup raaste.
  const histClean = (hist || []).filter((m) => m && m.role && m.role !== 'system');
  const userTail = { role: 'user', content: String(text).slice(0, 1500) };
  const sysMessages = [{ role: 'system', content: system }, ...histClean, userTail]; // HF ke liye (proper)
  const sysWrapped = '[[HIDAYAT — in par amal karo, inhen dohraya mat]]\n' + system;
  const messages = [{ role: 'user', content: sysWrapped }, ...histClean, userTail]; // Pollinations backup ke liye
  await _aiAcquire();
  try {
    // 2026-09-26 speed: HF (primary) + Pollinations (backup) ek saath — pehla jawab foran wapas.
    // (Pehle HF 30s stall karta tha, phir Pollinations shuru hota tha.)
    let ans = await _firstAiAnswer([_aiHF(sysMessages, 30000), _aiPost(messages, 25000)]);
    if (ans) return ans;
    await _aiNap(1500);
    ans = await _aiPost(messages, 20000);
    if (ans) return ans;
    await _aiNap(3000);
    ans = await _aiOpenAI(messages, 20000);
    if (ans) return ans;
    await _aiNap(3000);
    ans = await _aiGet(text, 20000);
    if (ans) return ans;
    await _aiNap(5000);
    ans = await _aiGet(text, 15000);
    if (ans) return ans;
    return '';
  } finally { _aiRelease(); }
}
async function askNexa(text, hist) { return chatComplete(nexaSystem(), text, hist); }

// Boss-style casual chat — dost ko aisa lage Boss khud reply kar raha hai.
// Bilkul GENDER-NEUTRAL: samne wala larka ho ya larki, pata nahi chalna chahiye.
// (aichat ke liye; .ai command ab bhi Nexa persona istemal karta hai)
const BOSSCHAT_SYSTEM = `Tum "Boss" ho jo WhatsApp par apne dost se chat kar raha hai. Bilkul usi ke andaaz mein jawab do.

LAZMI QAWAID:
- Sirf Roman Urdu (English letters mein Urdu). Lambi English ya formal Urdu kabhi nahi.
- SAB SE PEHLE us ki baat ko DHYAAN SE PARHO aur SAMJHO — wo kya pooch raha hai ya kya keh raha hai, USI ka jawab do. Sirf "salam" dekh kar ready-made greeting jawab KABHI mat de do.
  • Wo "kha ho" pooche to JAGAH ka jawab do ("bas yahin hoon"), "me theek hoon" mat kaho.
  • Wo "kya kar rahe ho" pooche to KAAM ka jawab do, haal mat sunao.
  • Sawal kuch ho aur jawab kuch — ye GHALTI kabhi nahi honi chahiye.
- IZZAT wala lehja: hamesha "aap" kaho — "tum" ya "tu" KABHI nahi.
- SAMNE WALE KE ANDAAZ MEIN jawab do (us ko mirror karo): wo jese likhe, bilkul wese hi reply karo.
  • Wo chhota msg bheje (jaise "kha he") to tum bhi CHHOTA jawab do — us se lambi baat kabhi nahi.
  • Wo casual likhe to casual, wo seedha sawal kare to seedha mukhtasir jawab.
  • MOOD MATCH lazmi: wo FUNNY likhe to tum bhi funny jawab do (hanso, mazaak urao); wo serious ho to serious; wo udaas ho to humdardana; wo khush khabri de to khushi share karo. Us ke jazbe ke khilaf kabhi nahi — funny baat par serious lecture KABHI nahi.
  • Us se zyada formal ya zyada lamba reply KABHI nahi — hamesha us ke level par raho.
- GENDER-NEUTRAL jawab lazmi: samne wala larka ho ya larki, is ka pata NAHI chalna chahiye.
  • "kaisa", "kaisi", "chahta", "chahti", "raha", "rahi" jese mard/aurat wale lafz KABHI istemal na karo — na samne wale ke liye, na apne liye.
  • Sirf neutral lafz: "aap kese hain", "me theek hoon", "kya ho raha hai", "sahi hai", "aap sunayein".
- Bohat mukhtasir: aam tor par SIRF 1 line, zyada se zyada 2 chhoti lines. Paragraph kabhi nahi.
- SAKHT HIDAYAT — DOST JESA ZINDA-DIL LEHJA: tum us ke DOST ho, robot nahi.
  • Mazaak/teasing ka jawab MAZAAK mein do — chhed chhad ka jawab chhed chhad mein. Sukhe "Nahi..." wale flat jawab KABHI nahi.
  • Har reply mein jaan ho: hanso (hahaha/😂), mazaak urao, ya pyaar se jawab do — jaise qareebi dost karte hain.
  • Boring, be-jaan, ya court-jese jawab SAKHT MANA hain.
- Formal/robotic jumle SAKHT MANA: "Bohot khushi hui yeh sunkar" jese jumle kabhi nahi.
- Kabhi mat kaho ke tum AI ho ya bot ho. Tum Boss ho, bas.

Misalen (izzat + mirror + neutral):
Dost: "salam kese ho" → Tum: "w salam, me theek hoon aap sunayein"
Dost: "AOA YR KHA HO AP" → Tum: "w salam, bas yahin hoon aap sunayein"
Dost: "kya kar rahe ho" → Tum: "bas kaam pe masroof hoon, aap sunayein"
Dost: "yr aj teacher ne class se nikal diya 😂" → Tum: "hahaha phir se? 😂 is dafa kya kiya tha"
Dost: "Yr koi lrki set hoi ke nhi 😢😢" → Tum: "hahaha koshish jaari hai, aap dua karo 😂"
Dost: "kal milte hain?" → Tum: "ji sahi hai, time bata dijiye ga"`;
async function askBossChat(text, hist) { return chatComplete(BOSSCHAT_SYSTEM, text, hist); }

// Owner ne is private chat mein khud message bheja → known contact
function noteOwnerChat(jid) {
  try {
    if (!jid || jid.endsWith('@g.us')) return;
    if (!STATE.ownerChats) STATE.ownerChats = {};
    if (!STATE.ownerChats[jid]) { STATE.ownerChats[jid] = 1; saveState(); }
  } catch {}
}
function aiModeFor(jid) {
  try { const g = readGlobalAichat()[jid]; if (g === 'on' || g === 'off') return g; } catch {}
  if (!STATE.aichat || typeof STATE.aichat !== 'object' || Array.isArray(STATE.aichat)) STATE.aichat = {};
  return STATE.aichat[jid]; // 'on' | 'off' | 'auto' | undefined
}

// Auto AI chat — 3 tareeqe:
// • 'on' (manual): har message ka Boss-style jawab
// • 'off' (manual): kabhi jawab nahi (unknown-auto bhi blocked)
// • smart auto (default): sirf private chat mein UNKNOWN number ho
//   (owner ne us chat mein kabhi khud baat nahi ki) → khud activate, jawab do
const _aiLast = {}; // jid -> aakhri AI reply ka time (5s cooldown)
const _aiHour = {}; // jid|hour -> is ghante mein kitne replies (40 cap, anti-spam)
async function autoAI(sock, msg, sender, jid) {
  try {
    const text = getText(msg);
    if (!text || text.startsWith(config.prefix)) return false;
    const isGroup = jid.endsWith('@g.us');
    let mode = aiModeFor(jid);
    if (mode === 'off') return false;
    const fromMe = !!msg.key.fromMe;
    // 'on' mode: jo bhi msg kare — owner khud bhi — AI jawab dega.
    // (Bot ke apne bheje hue msg par kabhi nahi: isOwnMsgId loop rokta hai.)
    // 'auto'/smart mode mein owner ke khud ke msg par jawab nahi (wo khud baat kar raha hai).
    if (fromMe && mode !== 'on') return false;
    if (isOwnMsgId(msg.key?.id)) return false; // hamare kisi bot ka bheja hua msg (LID-proof, loop protection)
    // 'on' mode mein apne doosre number/session se aaye msg par BHI jawab do (user ki explicit demand).
    // 'auto'/smart mode mein apne sessions ke msg par nahi — bot-to-bot echo band.
    if (!fromMe && mode !== 'on' && isOwnSessionMsg(msg, sender, jid)) return false;
    if (mode === 'on') { /* manual on — neeche jawab do */ }
    else {
      // 🌍 global AI-auto switch: kisi bhi number par owner ne band kiya ho to unknown-auto bilkul nahi
      // (pehle se auto-active chats bhi khamosh; sirf explicit 'on' wale chalte hain)
      if (globalAiauto() === false) return false;
      // smart auto: groups mein kabhi khud on nahi; known contacts par bhi nahi
      if (isGroup) return false;
      if (mode !== 'auto') {
        if (STATE.ownerChats && STATE.ownerChats[jid]) return false; // daily contact — Boss khud on karega
        STATE.aichat[jid] = 'auto'; saveState(); // unknown number → khud active
        mode = 'auto';
      }
    }
    // double reply rokna (cross-process): kisi aur session ne is msg ko
    // pehle hi claim kar liya ho to khamoshi se skip — AI call se PEHLE claim
    if (aiReplyClaimed(msg.key?.id)) return true;
    // anti-spam: ek chat mein 5s cooldown + 40 replies/hour cap
    const now = Date.now();
    if (now - (_aiLast[jid] || 0) < 5000) return true;
    _aiLast[jid] = now;
    const hk = jid + '|' + Math.floor(now / 3600000);
    if ((_aiHour[hk] || 0) >= 40) return true;
    _aiHour[hk] = (_aiHour[hk] || 0) + 1;
    if (Object.keys(_aiHour).length > 200) for (const k of Object.keys(_aiHour)) if (!k.endsWith('|' + Math.floor(now / 3600000))) delete _aiHour[k];
    if (!STATE.aihist) STATE.aihist = {};
    const hist = (STATE.aihist[jid] || []).slice(-10);
    const ans = await askBossChat(NEXUS.aiPrompt(text, jid, sender), hist);
    if (!ans) { aiReplyUnclaim(msg.key?.id); log.warn('[aichat] AI se jawab nahi aaya, skip: ' + jid); return true; }
    hist.push({ role: 'user', content: text.slice(0, 400) },
      { role: 'assistant', content: ans.slice(0, 400) });
    STATE.aihist[jid] = hist.slice(-10);
    saveState();
    // 2026-09-26 speed: masnooi lambi "human-like" typing (4s + 45ms/char, max 12s) hata di —
    // Boss ne bot tez karne ko kaha. Sirf halki typing jhalak (max ~1.2s), jawab foran.
    const typeMs = Math.min(400 + ans.length * 6, 1200); // 0.4s base + 6ms/char, max 1.2s
    try { await sock.sendPresenceUpdate('composing', jid); } catch {}
    await new Promise(r => setTimeout(r, typeMs));
    try { await sock.sendPresenceUpdate('paused', jid); } catch {}
    // 🎙️ voiceai (EXCLUSIVE Phase 2a): is chat mein AI ka jawab voice note mein
    try {
      if (voiceaiOn(jid)) {
        try {
          const ogg = await nxTtsBuffer(ans.slice(0, 400), 'ur');
          await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
          return true;
        } catch { /* neeche text fallback */ }
      }
    } catch {}
    await reply(sock, jid, msg, ans, { nosig: true }); // autoAI chat — signature nahi
    return true;
  } catch { return true; }
}

// AI image generate (imagine + dp share karte hain)
// flux → zimage → turbo fallback chain (sab free/anonymous tested 2026-09-23)
async function genAIImage(sock, jid, msg, prompt, caption) {
  await reply(sock, jid, msg, wline(['🎨 Ban rahi hai, thoda sabar... 💗', '🎨 Rangon ko mila rahi hoon... ✨', '🖌️ Tasveer buna rahi hoon... ek pal! 💫']));
  const seed = Math.floor(Math.random() * 999999);
  const models = ['flux', 'zimage', 'turbo'];
  for (const model of models) {
    try {
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt)
        + `?width=1024&height=1024&seed=${seed}&nologo=true&enhance=true&quality=hd&model=${model}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 120000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 5000) continue;
      await sock.sendMessage(jid, { image: buf, caption }, { quoted: msg });
      return;
    } catch { /* agla model try karo */ }
  }
  await reply(sock, jid, msg, '❌ Image nahi ban saki, dobara try karein.');
}

// ─── helpers ───────────────────────────────────────────
const num = (s) => String(s || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ─── vv inbox: JO COMMAND USE KARE, USKE INBOX MEIN (simple) ───
// Owner ke liye dedicated inbox = worker DM wali ALAG chat —
// "Message yourself" (علی حسن wali chat) mein KUCH nahi jata. Boss ka hukm.
//   • main bot se: worker ke JID par → Boss ke phone par alag "92349…" chat
//   • worker se: owner ke JID par → Boss ko worker ki taraf se DM (wohi alag chat)
// Aam user ke liye: uska apna DM (private).
// Har attempt vv-inbox.log mein — silent-fail kabhi dobara andekha nahi rahega.
// Aakhri maloom worker JID yaad rakho — restart/spawn ke dauran agar
// registry.json ek lamhe ke liye na mile to purani chat mein fallback
// kabhi nahi hoga; yaad shuda worker hi istemal hoga.
let cachedWorkerJid = null;
function firstWorkerJid() {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sessions', 'registry.json'), 'utf8'));
    for (const k of Object.keys(reg || {})) {
      const d = String(k).replace(/\D/g, '');
      if (d.length >= 7 && d !== num(config.owner)) { cachedWorkerJid = d + '@s.whatsapp.net'; return cachedWorkerJid; }
    }
  } catch {}
  return cachedWorkerJid;
}
function vvInboxJid(sender) {
  const s = num(sender);
  // Boss ka rule (2026-09-22): jo command chalaye, usi ke "Message yourself" mein jaye. Bas. Koi chakkar nahi.
  const target = (s || num(config.owner)) + '@s.whatsapp.net';
  try { fs.appendFileSync('vv-inbox.log', `[${new Date().toISOString()}] vv target=${target}\n`); } catch {}
  return target;
}
async function sendOwnerInbox(sock, sender, content, kind) {
  const target = vvInboxJid(sender);
  const stamp = new Date().toISOString();
  try {
    const sent = await sock.sendMessage(target, content);
    const mid = (sent && sent.key && sent.key.id) || 'no-id';
    try { fs.appendFileSync('vv-inbox.log', `[${stamp}] -> ${target} kind=${kind} OK id=${mid}\n`); } catch {}
    return sent;
  } catch (e) {
    try { fs.appendFileSync('vv-inbox.log', `[${stamp}] -> ${target} kind=${kind} FAIL err=${String((e && e.message) || e)}\n`); } catch {}
    throw e;
  }
}

// ─── 👑 Extra owners (Boss: .owner <number> se add, .unowner se remove) ───
// Main owner (config.owner) ke ilawa ye numbers bhi owner commands chala sakte hain.
// Sirf MAIN owner add/remove kar sakta hai — extra owner kisi ko add/remove nahi kar sakta.
const EXTRA_OWNERS_PATH = path.join(__dirname, '..', 'extra-owners.json');
function loadExtraOwners() {
  try {
    const a = JSON.parse(fs.readFileSync(EXTRA_OWNERS_PATH, 'utf8'));
    return Array.isArray(a) ? a.map(x => String(x).replace(/\D/g, '').slice(-10)).filter(x => x.length >= 7) : [];
  } catch { return []; }
}
function saveExtraOwners(list) {
  try { fs.writeFileSync(EXTRA_OWNERS_PATH, JSON.stringify(list, null, 1)); } catch {}
}

// ─── 🎫 Demo/Perm link system (Boss ka demo trial system) ───
// .demolink 30m → demo token; customer pairs → timer starts → expiry par
// auto-disconnect + owner & customer dono ko message.
// .permlink <number> → permanent link, sirf us number ke liye locked.
const DEMO_LINKS_PATH = path.join(__dirname, '..', 'demo-links.json');
function loadDemoLinks() {
  try { const o = JSON.parse(fs.readFileSync(DEMO_LINKS_PATH, 'utf8')); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
function saveDemoLinks(o) {
  try { fs.writeFileSync(DEMO_LINKS_PATH, JSON.stringify(o, null, 1)); } catch {}
}
function makeDemoToken() {
  const c = 'abcdefghjkmnpqrstuvwxyz23456789';
  let t = ''; for (let i = 0; i < 10; i++) t += c[Math.floor(Math.random() * c.length)];
  return t;
}
function parseDemoTime(s) {
  const m = String(s || '').trim().toLowerCase().match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hour|hours|d|day|days)?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10); const u = m[2] || 'm';
  if (u.startsWith('m')) return n;             // minutes
  if (u.startsWith('h')) return n * 60;        // hours
  if (u.startsWith('d')) return n * 1440;      // days
  return null;
}
function fmtDemoTime(min) {
  if (min >= 1440) return (min / 1440) + ' din';
  if (min >= 60) return (min / 60) + ' ghante';
  return min + ' minute';
}
function isExtraOwner(jid) {
  const a = num(jid).slice(-10);
  return a.length >= 7 && loadExtraOwners().includes(a);
}
function isMainOwner(jid) {
  if (!config.owner) return false;
  const a = num(jid).slice(-10);
  const b = String(config.owner).replace(/\D/g, '').slice(-10);
  return a.length >= 7 && a === b;
}
function isMainOwnerMsg(msg, sender, jid) {
  if (!config.owner) return false;
  const b = String(config.owner).replace(/\D/g, '').slice(-10);
  if (b.length < 7) return false;
  const lidB = lidDigitsOf(b);
  for (const d of numSetOf(msg, sender, jid)) {
    if (d === b) return true;
    if (lidB && d === lidB) return true;
  }
  return false;
}

function isOwner(jid) {
  if (isMainOwner(jid)) return true;
  return isExtraOwner(jid);
}

// Hamare apne sessions (owner + registry ke saare worker numbers):
// in ke darmiyan AI kabhi nahi bolegi — forward/confirmation par bot-to-bot echo band.
let _ownNums = null, _ownNumsAt = 0;
function ownNumbers() {
  const now = Date.now();
  if (_ownNums && now - _ownNumsAt < 60000) return _ownNums;
  const set = new Set();
  if (config.owner) set.add(String(config.owner).replace(/\D/g, '').slice(-10));
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sessions', 'registry.json'), 'utf8'));
    for (const k of Object.keys(reg || {})) {
      const d = String(k).replace(/\D/g, '').slice(-10);
      if (d.length >= 7) set.add(d);
    }
  } catch {}
  _ownNums = set; _ownNumsAt = now;
  return set;
}
function isOwnSession(jid) {
  const a = num(jid).slice(-10);
  return a.length >= 7 && ownNumbers().has(a);
}

// ─── LID-proof pehchan ───
// WhatsApp kabhi sender LID (@lid) mein bhejta hai, kabhi number mein.
// Baileys msg.key.remoteJidAlt / participantAlt mein doosri shakal rakhta hai.
// Apne sessions (owner + workers) ko IN SAB shaklon se pehchano — taake
// aapas ke personal chats (owner <-> worker) mein bot kabhi shor na kare,
// aur owner LID mein aaye tab bhi pehchana jaye (relay/commands na tootein).
// ─── LID cache (WhatsApp kabhi sirf LID bhejta hai, number nahi) ───
// index.js sock connect hone par owner + workers ke PN→LID resolve karke
// yahan set karta hai. Phir isOwnerMsg / isOwnSessionMsg LID se bhi pehchante hain.
let _lidOf = {}; // pnDigits(-10) -> lidDigits(-10)
function setKnownLids(map) { try { _lidOf = { ..._lidOf, ...map }; } catch {} }
function lidDigitsOf(pnDigits) {
  try {
    const d = String(pnDigits || '').replace(/\D/g, '').slice(-10);
    return _lidOf[d] || null;
  } catch { return null; }
}
// 🔄 reverse: LID digits → PN digits (poll votes waghera mein voter sirf LID mein aata hai)
function pnDigitsOfLid(lidDigits) {
  try {
    const l = String(lidDigits || '').replace(/\D/g, '').slice(-10);
    if (l.length < 7) return null;
    for (const k of Object.keys(_lidOf)) if (String(_lidOf[k]) === l) return k;
  } catch {}
  return null;
}
function numSetOf(msg, sender, jid) {
  const s = new Set();
  const add = (v) => {
    const d = num(v).slice(-10);
    if (d.length >= 7) s.add(d);
  };
  add(sender); add(jid);
  try {
    const k = msg?.key || {};
    add(k.remoteJidAlt); add(k.participant); add(k.participantAlt);
  } catch {}
  return s;
}
function isOwnerMsg(msg, sender, jid) {
  if (isMainOwnerMsg(msg, sender, jid)) return true;
  // Extra owners bhi owner commands chala sakte hain
  const extras = loadExtraOwners();
  if (!extras.length) return false;
  for (const d of numSetOf(msg, sender, jid)) {
    if (extras.includes(d)) return true;
    const l = lidDigitsOf(d);
    if (l && extras.includes(l)) return true;
  }
  return false;
}
function isOwnSessionMsg(msg, sender, jid) {
  const own = ownNumbers();
  // LIDs bhi own mein shamil karo
  for (const pn of own) {
    const l = lidDigitsOf(pn);
    if (l) own.add(l);
  }
  for (const d of numSetOf(msg, sender, jid)) if (own.has(d)) return true;
  return false;
}

// ─── Bot-to-bot pehchan (message ID se — LID-proof) ───
// Hamara koi bhi session (main/worker) jab koi msg bhejta hai to us ka ID
// shared file mein record hota hai. Doosra session jab wahi msg receive kare
// to autoAI us par jawab NAHI degi — chahe sender LID mein aaye ya number mein.
const OWNMSG_PATH = path.join(__dirname, '..', 'sessions', 'own_msg_ids.json');
let _ownMsgCache = null, _ownMsgAt = 0;
function recordOwnMsgId(id) {
  try {
    if (!id) return;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(OWNMSG_PATH, 'utf8')); } catch {}
    d[id] = Date.now();
    // prune: 10 minute se purane nikaal do
    const cut = Date.now() - 10 * 60 * 1000;
    for (const k of Object.keys(d)) if (d[k] < cut) delete d[k];
    fs.writeFileSync(OWNMSG_PATH, JSON.stringify(d));
    _ownMsgCache = d; _ownMsgAt = Date.now();
  } catch {}
}
function isOwnMsgId(id) {
  try {
    if (!id) return false;
    const now = Date.now();
    if (!_ownMsgCache || now - _ownMsgAt > 30000) {
      try { _ownMsgCache = JSON.parse(fs.readFileSync(OWNMSG_PATH, 'utf8')); }
      catch { _ownMsgCache = {}; }
      _ownMsgAt = now;
    }
    return !!_ownMsgCache[id];
  } catch { return false; }
}

// ─── Cross-process AI reply dedup (double reply rokna) ───
// Main aur worker alag processes hain — agar dono ne ek hi incoming message
// dekha (misal owner<->worker chat ya group), to dono AI jawab na dein.
// Shared file mein incoming msg ID claim karo — jo pehle claim kare wahi jawab de.
const AIREPLIED_PATH = path.join(__dirname, '..', 'sessions', 'ai_replied.json');
function aiReplyClaimed(id) {
  try {
    if (!id) return false;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(AIREPLIED_PATH, 'utf8')); } catch {}
    const now = Date.now();
    for (const k of Object.keys(d)) if (now - d[k] > 120000) delete d[k]; // 2 min purane saaf
    if (d[id]) return true; // kisi aur session ne pehle hi claim kar liya
    d[id] = now;
    fs.writeFileSync(AIREPLIED_PATH, JSON.stringify(d));
    return false;
  } catch { return false; }
}
function aiReplyUnclaim(id) {
  try {
    if (!id) return;
    let d = {};
    try { d = JSON.parse(fs.readFileSync(AIREPLIED_PATH, 'utf8')); } catch {}
    if (d[id]) { delete d[id]; fs.writeFileSync(AIREPLIED_PATH, JSON.stringify(d)); }
  } catch {}
}

function getText(msg) {
  const m = msg.message || {};
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';
}

function ctxOf(msg) {
  return msg.message?.extendedTextMessage?.contextInfo || null;
}

// View-once extract: wrapper (viewOnceMessage) ho ya haqeeqi WhatsApp reply
// jaisa unwrapped quotedMessage jis par viewOnce flag ho — dono cover.
function extractViewOnce(q) {
  if (!q) return null;
  const inner = q.viewOnceMessage?.message || q.viewOnceMessageV2?.message || q.viewOnceMessageV2Extension?.message;
  let imgM = inner?.imageMessage, vidM = inner?.videoMessage, stM = inner?.stickerMessage, audM = inner?.audioMessage;
  if (!imgM && !vidM && !stM && !audM) {
    if (q.imageMessage?.viewOnce) imgM = q.imageMessage;
    else if (q.videoMessage?.viewOnce) vidM = q.videoMessage;
    else if (q.stickerMessage?.isViewOnce) stM = q.stickerMessage;
    else if (q.audioMessage?.viewOnce) audM = q.audioMessage;
  }
  if (!imgM && !vidM && !stM && !audM) return null;
  return { imgM, vidM, stM, audM };
}

// Stealth view-once: owner ne view-once ke REPLY mein koi sticker ya lafz
// bheja (bina .vv likhe) → unlocked media khamoshi se dedicated inbox mein,
// us chat mein KUCH nahi aata. Command (. se shuru) par ye nahi chalta.
async function stealthViewOnce(sock, msg, sender) {
  try {
    if (!isOwnerMsg(msg, sender, msg.key?.remoteJid) || !config.owner) return false;
    const m = msg.message || {};
    const txt = m.conversation || m.extendedTextMessage?.text || '';
    if (txt.startsWith(config.prefix)) return false; // command hai → normal flow
    const isWord = !!txt.trim();
    const isSticker = !!m.stickerMessage;
    if (!isWord && !isSticker) return false;
    const q = m.extendedTextMessage?.contextInfo?.quotedMessage
           || m.stickerMessage?.contextInfo?.quotedMessage;
    const vo = extractViewOnce(q);
    if (!vo) return false;
    // Boss ka rule (2026-09-22): jis ne reply kiya, usi ke "Message yourself" mein jaye.
    // vvInboxJid() — personal se -> personal self-chat, business se -> business self-chat.
    const inboxJid = vvInboxJid(sender);
    const caption = `👁️ *View-once (auto)*\n_— ${config.botName}_`;
    let kind = null;
    if (vo.stM) {
      const buf = await downloadMediaMessage({ key: msg.key, message: { stickerMessage: vo.stM } }, 'buffer', {});
      await sock.sendMessage(inboxJid, { sticker: buf }); kind = 'sticker';
    } else if (vo.imgM) {
      const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: vo.imgM } }, 'buffer', {});
      await sock.sendMessage(inboxJid, { image: buf, caption }); kind = 'image';
    } else if (vo.vidM) {
      const buf = await downloadMediaMessage({ key: msg.key, message: { videoMessage: vo.vidM } }, 'buffer', {});
      await sock.sendMessage(inboxJid, { video: buf, caption }); kind = 'video';
    } else if (vo.audM) {
      const buf = await downloadMediaMessage({ key: msg.key, message: { audioMessage: vo.audM } }, 'buffer', {});
      await sock.sendMessage(inboxJid, { audio: buf, ptt: true, mimetype: vo.audM.mimetype || 'audio/ogg; codecs=opus' }); kind = 'audio';
    } else return false;
    try { fs.appendFileSync('vv-inbox.log', `[${new Date().toISOString()}] auto -> ${inboxJid} kind=${kind} via=reupload OK\n`); } catch {}
    return true;
  } catch { return false; }
}

// ─── ✨ Nexa signature — SIRF final results par (errors / working msgs / usage hints par nahi) ───
const WORK_FLAIR = ['💗', '✨', '💫', '🌸', '💖'];
function nexaSig(text) {
  if (!text || typeof text !== 'string') return text;
  const t = text.trim();
  if (!t) return text;
  if (t.includes('— Nexa 💗') || t.includes('NEXORA-MD 💗')) return text; // pehle se signed
  if (/^❌/.test(t)) return text;                                          // errors
  if (/rahi hoon|raha hoon|rahi hai|raha hai|rahe hain/i.test(t)) {                 // working msgs → sirf flair rotate
    return t.replace(/💗\s*$/, () => WORK_FLAIR[Math.floor(Math.random() * WORK_FLAIR.length)]);
  }
  if (/Usage:|Likhein:|Misal:|Masalan:|Istemal:|Tariqa:/.test(t)) return text; // usage hints
  return text + '\n\n— Nexa 💗';
}

// ─── 🛡️ Global outbound throttle — bot ke NUMBER ko ban se bachao ───
// WhatsApp tez outgoing flood ko spam samajh kar number ban kar sakta hai
// (purana number isi wajah se gaya). Har reply se pehle rolling 60s window:
// 40 se zyada hon to thora wait karwa kar smooth karo — drop kuch nahi hota.
// (Har process ka apna counter hai = har linked number ki apni hifazat.)
const outTimes = [];
async function outboundThrottle() {
  try {
    const now = Date.now();
    while (outTimes.length && now - outTimes[0] > 60000) outTimes.shift();
    if (outTimes.length >= 40) {
      const wait = Math.min(8000, (outTimes[0] + 60000) - now);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      const n2 = Date.now();
      while (outTimes.length && n2 - outTimes[0] > 60000) outTimes.shift();
    }
    outTimes.push(Date.now());
    if (outTimes.length > 200) outTimes.splice(0, outTimes.length - 200);
  } catch {}
}
async function reply(sock, jid, msg, text, opts = {}) {
  try {
    await outboundThrottle(); // ban-protection: flood smooth karo
    const extra = {};
    if (getSetting('mentionreply') && jid.endsWith('@g.us')) {
      const who = msg.key?.participant || (!msg.key?.fromMe ? jid : null);
      if (who && /@s.whatsapp.net$/.test(who)) extra.mentions = [who];
    }
    const out = opts.nosig ? text : nexaSig(text);
    const sent = await sock.sendMessage(jid, { text: out, ...extra }, { quoted: msg });
    try { if (sent && sent.key && sent.key.id) recordOwnMsgId(sent.key.id); } catch {} // self-loop guard: apne msg par hooks dobara na fire hon
  } catch { await sock.sendMessage(jid, { text }, { quoted: msg }); }
}

// Photo buffer → WhatsApp sticker (512x512 webp)
async function imgToSticker(buf) {
  return sharp(buf)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 90 }).toBuffer();
}

// cobalt v11: POST /  → {status:'tunnel'|'redirect'|'picker', url...} ya {status:'error', error:{code}}
async function cobalt(url, extra = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000); // 2026-09-26: 45s → 30s (race ke saath zyada wait nahi)
  try {
    const res = await fetch(COBALT, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, ...extra }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    if (j.status === 'error') throw new Error(j.error?.code || 'unknown');
    return j;
  } finally {
    clearTimeout(t);
  }
}

function cobaltErr(code) {
  const map = {
    'error.api.content.post.unavailable': 'Is link ka content nahi mila (deleted / private / ghalat link).',
    'error.api.link.invalid': 'Link sahi nahi hai, dobara check karein.',
    'error.api.youtube.login': 'YouTube ne download block kiya hua hai — TikTok / IG / FB link try karein.',
    'error.api.rate_limit': 'Thoda zyada use ho gaya, 1 minute baad try karein.',
  };
  return map[code] || 'Download nahi ho saka, thodi der baad dobara try karein.';
}

// Group admin check — LID aur PN dono handle karta hai
async function requireAdmin(sock, msg, sender) {
  const jid = msg.key.remoteJid;
  if (!jid.endsWith('@g.us')) return '❌ Ye command sirf group mein chalti hai.';
  const meta = await sock.groupMetadata(jid);
  const sNum = num(sender);
  const meNum = num(sock.user?.id);
  let senderAdmin = false, botAdmin = false;
  for (const p of meta.participants) {
    if (!p.admin) continue;
    const pNums = [num(p.id), num(p.phoneNumber)];
    if (pNums.includes(sNum)) senderAdmin = true;
    if (pNums.includes(meNum)) botAdmin = true;
  }
  if (!senderAdmin && !isOwnerMsg(msg, sender, msg.key?.remoteJid)) return '❌ Sirf group admin ye command chala sakta hai.';
  if (!botAdmin) return '❌ Pehle bot ko group admin banayein.';
  return null;
}

// Text → stylish PNG (logo commands ke liye, local — hamesha kaam karega)
function textImage(text, style) {
  const t = esc(text.slice(0, 40) || 'NEXORA');
  const styles = {
    neon: { glow: '#50E8F4', c1: '#02181b', c2: '#06333a' },
    glow: { glow: '#ff6ef5', c1: '#1a0b2e', c2: '#2b0f4d' },
  };
  const st = styles[style] || styles.neon;
  const svg =
    `<svg width="800" height="400" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${st.c1}"/><stop offset="1" stop-color="${st.c2}"/>` +
    `</linearGradient><filter id="gl" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="14" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>` +
    `</filter></defs>` +
    `<rect width="800" height="400" rx="28" fill="url(#bg)"/>` +
    `<text x="400" y="222" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="66" font-weight="bold" fill="${st.glow}" filter="url(#gl)">${t}</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ── fancy unicode fonts (pure JS, koi API nahi) ──
function buildStyleMap(upper, lower, digits, excU, excL, excD) {
  const m = {};
  for (let i = 0; i < 26; i++) {
    const U = String.fromCharCode(65 + i), L = String.fromCharCode(97 + i);
    m[U] = (excU && excU[U]) || String.fromCodePoint(upper + i);
    m[L] = (excL && excL[L]) || String.fromCodePoint(lower + i);
  }
  for (let i = 0; i < 10; i++) {
    const D = String(i);
    m[D] = (excD && excD[D]) || (digits != null ? String.fromCodePoint(digits + i) : D);
  }
  return m;
}
const STYLE_FONTS = [
  { name: 'Bold', map: buildStyleMap(0x1D400, 0x1D41A, 0x1D7CE) },
  { name: 'Italic', map: buildStyleMap(0x1D434, 0x1D44E, null, null, { h: 'ℎ' }) },
  { name: 'Bold Italic', map: buildStyleMap(0x1D468, 0x1D482, null) },
  { name: 'Script', map: buildStyleMap(0x1D49C, 0x1D4B6, null,
    { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ' },
    { e: 'ℯ', g: 'ℊ', o: 'ℴ' }) },
  { name: 'Double', map: buildStyleMap(0x1D538, 0x1D552, 0x1D7D8,
    { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' }) },
  { name: 'Fraktur', map: buildStyleMap(0x1D504, 0x1D51E, null,
    { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' }) },
  { name: 'Monospace', map: buildStyleMap(0x1D5A0, 0x1D5BA, 0x1D7F6) },
  { name: 'Sans Bold', map: buildStyleMap(0x1D5D4, 0x1D5EE, 0x1D7EC) },
  { name: 'Circled', map: buildStyleMap(0x24B6, 0x24D0, null, null, null,
    { 0: '⓪', 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤', 6: '⑥', 7: '⑦', 8: '⑧', 9: '⑨' }) },
  { name: 'Fullwidth', map: buildStyleMap(0xFF21, 0xFF41, 0xFF10) },
];
function stylize(text, font) {
  return String(text).split('').map(ch => font.map[ch] || ch).join('');
}

// ── zaati notes (persistent JSON, sessions/ mein nahi) ──
const NOTES_FILE = path.join(__dirname, '..', 'data', 'notes.json');
function loadNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); } catch { return {}; }
}
function saveNotes(n) {
  try { fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true }); fs.writeFileSync(NOTES_FILE, JSON.stringify(n)); } catch (e) { console.error('[notes] save fail:', e.message); }
}

// ── reminders (persistent; har process apne session wale fire karta hai) ──
const REMINDERS_FILE = path.join(__dirname, '..', 'data', 'reminders.json');
function loadReminders() { try { const a = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveReminders(a) { try { fs.mkdirSync(path.dirname(REMINDERS_FILE), { recursive: true }); fs.writeFileSync(REMINDERS_FILE, JSON.stringify(a)); } catch (e) { console.error('[reminders] save fail:', e.message); } }
let REM_SOCK = null;
let AUTOBIO_TIMER = null;
function ensureAutobio() {
  try {
    if (!getSetting('autobio')) { if (AUTOBIO_TIMER) { clearInterval(AUTOBIO_TIMER); AUTOBIO_TIMER = null; } return; }
    if (AUTOBIO_TIMER || !REM_SOCK) return;
    const tick = async () => {
      try {
        if (!getSetting('autobio') || !REM_SOCK) { if (AUTOBIO_TIMER) { clearInterval(AUTOBIO_TIMER); AUTOBIO_TIMER = null; } return; }
        const t = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit' });
        await REM_SOCK.updateProfileStatus(`\u{1F550} ${t} | NEXORA-MD \u{1F497}`);
      } catch {}
    };
    tick();
    AUTOBIO_TIMER = setInterval(tick, 60000);
  } catch {}
}
async function checkReminders() {
  if (!REM_SOCK) return;
  try {
    const me = num(REM_SOCK.user?.id || '');
    const all = loadReminders();
    const now = Date.now();
    const mine = all.filter(r => r.due <= now && (!r.by || r.by === me));
    if (!mine.length) return;
    saveReminders(all.filter(r => !mine.includes(r)));
    for (const r of mine) {
      try { await REM_SOCK.sendMessage(r.jid, { text: `⏰ *Yaad-dihani* 💗\n\n${r.text}` }); } catch {}
    }
  } catch {}
}
setInterval(() => { checkReminders(); checkSchedules(); checkCapsules(); try { if (REM_SOCK) briefingTick(REM_SOCK).catch(() => {}); } catch {} }, 30000);
function parseReminderTime(s) {
  s = (s || '').trim().toLowerCase();
  let m = s.match(/^(\d+)\s*m(in(ute)?s?)?$/); if (m && +m[1] > 0 && +m[1] <= 43200) return Date.now() + (+m[1]) * 60000;
  m = s.match(/^(\d+)\s*h(ours?)?$/); if (m && +m[1] > 0 && +m[1] <= 720) return Date.now() + (+m[1]) * 3600000;
  m = s.match(/^(\d+)\s*d(ays?)?$/); if (m && +m[1] > 0 && +m[1] <= 365) return Date.now() + (+m[1]) * 86400000;
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m && +m[1] < 24 && +m[2] < 60) {
    const now = new Date();
    const off = (5 * 60 + now.getTimezoneOffset()) * 60000; // PKT wall-clock shift
    const pkt = new Date(now.getTime() + off);
    const t = new Date(pkt); t.setHours(+m[1], +m[2], 0, 0);
    if (t.getTime() <= pkt.getTime()) t.setDate(t.getDate() + 1);
    return t.getTime() - off;
  }
  return null;
}
function fmtPktTime(epoch) {
  const off = (5 * 60 + new Date().getTimezoneOffset()) * 60000;
  const d = new Date(epoch + off);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// ── tasbih counter (persistent, per-user) ──
const TASBIH_FILE = path.join(__dirname, '..', 'data', 'tasbih.json');
function loadTasbih() { try { return JSON.parse(fs.readFileSync(TASBIH_FILE, 'utf8')); } catch { return {}; } }
function saveTasbih(t) { try { fs.mkdirSync(path.dirname(TASBIH_FILE), { recursive: true }); fs.writeFileSync(TASBIH_FILE, JSON.stringify(t)); } catch (e) {} }

// ── AFK state (persistent, per-user) ──
const AFK_FILE = path.join(__dirname, '..', 'data', 'afk.json');
function loadAfk() { try { return JSON.parse(fs.readFileSync(AFK_FILE, 'utf8')); } catch { return {}; } }
function saveAfk(a) { try { fs.mkdirSync(path.dirname(AFK_FILE), { recursive: true }); fs.writeFileSync(AFK_FILE, JSON.stringify(a)); } catch (e) {} }
async function afkHook(sock, msg, sender, jid) {
  try {
    if (!jid.endsWith('@g.us') || msg.key.fromMe) return false;
    const mentioned = (getContextInfo(msg)?.mentionedJid) || [];
    if (!mentioned.length) return false;
    const keys = Object.keys(loadAfk());
    if (!keys.length) return false;
    for (const mt of mentioned) {
      const mn = num(mt);
      if (num(sender) === mn) continue;
      const key = keys.find(k => num(k) === mn);
      if (key) {
        const a = loadAfk()[key];
        const mins = Math.max(0, Math.round((Date.now() - a.since) / 60000));
        const ago = mins < 1 ? 'abhi abhi gaye' : mins < 60 ? `${mins} min pehle gaye` : `${Math.floor(mins / 60)} ghante pehle gaye`;
        await sock.sendMessage(jid, { text: `💤 *@${mn}* AFK hain (${ago}): _${a.reason}_`, mentions: [mt] }, { quoted: msg });
        return false;
      }
    }
  } catch {}
  return false;
}

// ── antilink per-group state ──
const ANTILINK_FILE = path.join(__dirname, '..', 'data', 'antilink.json');
function loadAntilink() { try { return JSON.parse(fs.readFileSync(ANTILINK_FILE, 'utf8')); } catch { return {}; } }
function saveAntilink(a) { try { fs.mkdirSync(path.dirname(ANTILINK_FILE), { recursive: true }); fs.writeFileSync(ANTILINK_FILE, JSON.stringify(a)); } catch (e) {} }

// ── audio speed (slow/fast) shared helper ──
async function audioSpeed(sock, msg, jid, tempo, label) {
  const q = ctxOf(msg)?.quotedMessage;
  const hasQ = !!(q && q.audioMessage);
  const aud = hasQ ? q.audioMessage : msg.message?.audioMessage;
  if (!aud) return reply(sock, jid, msg, `❌ Kisi audio/voice note ke reply mein *${config.prefix}${tempo < 1 ? 'slow' : 'fast'}* likhein.`);
  await reply(sock, jid, msg, `⏳ ${label} bana rahi hoon... 💗`);
  const tag = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const tmp = `/tmp/audspd-${tag}.ogg`, out = `/tmp/audspd-${tag}-out.ogg`;
  try {
    const buf = await downloadMediaMessage({ key: msg.key, message: hasQ ? { audioMessage: aud } : msg.message }, 'buffer', {});
    if (!buf || !buf.length) throw new Error('empty');
    fs.writeFileSync(tmp, buf);
    await new Promise((res, rej) => {
      execFile('/usr/bin/ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-filter:a', `atempo=${tempo}`, '-c:a', 'libopus', out],
        { timeout: 120000 }, (e) => (e ? rej(e) : res()));
    });
    const ob = fs.readFileSync(out);
    if (!ob.length) throw new Error('empty-out');
    await sock.sendMessage(jid, { audio: ob, mimetype: 'audio/ogg; codecs=opus', ptt: !!aud.ptt }, { quoted: msg });
  } catch (e) {
    console.error('[audiospeed] fail:', e.message);
    await reply(sock, jid, msg, '❌ Audio process nahi ho saka, dobara try karein.');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(out); } catch {}
  }
}

// ── voice changer (16 effects) shared helper — NAVEED-MD style (2026-09-26) ──
async function voiceFX(sock, msg, jid, af, label, cmd) {
  const q = ctxOf(msg)?.quotedMessage;
  const hasQ = !!(q && q.audioMessage);
  const aud = hasQ ? q.audioMessage : msg.message?.audioMessage;
  if (!aud) return reply(sock, jid, msg, `❌ Kisi audio/voice note ke reply mein *${config.prefix}${cmd}* likhein.`);
  await reply(sock, jid, msg, `⏳ ${label} bana rahi hoon... 💗`);
  const tag = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const tmp = `/tmp/vfx-${tag}.ogg`, out = `/tmp/vfx-${tag}-out.ogg`;
  try {
    const buf = await downloadMediaMessage({ key: msg.key, message: hasQ ? { audioMessage: aud } : msg.message }, 'buffer', {});
    if (!buf || !buf.length) throw new Error('empty');
    fs.writeFileSync(tmp, buf);
    await new Promise((res, rej) => {
      execFile('/usr/bin/ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-filter:a', af, '-c:a', 'libopus', out],
        { timeout: 120000 }, (e) => (e ? rej(e) : res()));
    });
    const ob = fs.readFileSync(out);
    if (!ob.length) throw new Error('empty-out');
    await sock.sendMessage(jid, { audio: ob, mimetype: 'audio/ogg; codecs=opus', ptt: !!aud.ptt }, { quoted: msg });
  } catch (e) {
    console.error('[voicefx] fail:', e.message);
    await reply(sock, jid, msg, '❌ Audio process nahi ho saka, dobara try karein.');
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
    try { fs.unlinkSync(out); } catch {}
  }
}

// ── khwab ki tabeer pool ──
const DREAMS = [
  { k: ['saanp', 'sanp', 'snake', 'naag'], t: '🐍 *Saanp dekhna:* Aam tor par dushman ya hasad karne wale ki taraf ishara hai — ehtiyat karein, aur Allah se hifazat ki dua mangein. Safed saanp kamzor dushman ki alamat hai.' },
  { k: ['paani', 'pani', 'darya', 'samandar', 'nadi', 'water'], t: '🌊 *Paani dekhna:* Saaf paani rizq, rehmat aur dill ke sukoon ki alamat hai. Ganda paani pareshani ki taraf ishara — sadqa dein aur dua karein.' },
  { k: ['barish', 'baarish', 'rain'], t: '🌧️ *Barish dekhna:* Rehmat aur barkat ki alamat hai — rizq mein izafa aur mushkilon ka khatma, in sha Allah.' },
  { k: ['shaadi', 'shadi', 'dulha', 'dulhan', 'nikah', 'marriage'], t: '💒 *Shaadi dekhna:* Khushi ki khabar ya zindagi mein nayi mubarak shuruaat ki alamat hai.' },
  { k: ['safar', 'train', 'jahaz', 'plane', 'travel'], t: '✈️ *Safar dekhna:* Zindagi mein tabdeeli ya naye marhale ki alamat — koi faisla qareeb hai.' },
  { k: ['daant', 'dant', 'tooth', 'teeth'], t: '🦷 *Daant girna:* Ghar walon se mutaliq khayal ki alamat — walidain aur rishtedaron ka khayal rakhein, un ke liye dua karein.' },
  { k: ['bacha', 'baby', 'nanha'], t: '👶 *Bacha dekhna:* Khushkhabri aur nayi nemat ki alamat hai — dill khush karne wali khabar mil sakti hai.' },
  { k: ['murda', 'maiyat', 'qabar', 'janaza', 'maut', 'dead'], t: '🪦 *Murda dekhna:* Aam tor par lambi umar ya kisi bhooli hui zimmedari ki yaad-dihani hai. Marhoomeen ke liye dua-e-maghfirat karein.' },
  { k: ['sona', 'gold', 'chandi', 'silver', 'maal', 'dolat'], t: '🪙 *Sona/chandi dekhna:* Rizq aur nemat ki alamat — lekin sath hi zimmedari ka ehsas bhi; halal kamai par shukr ada karein.' },
  { k: ['aag', 'fire', 'jalna'], t: '🔥 *Aag dekhna:* Azmaish ya gusse ki alamat ho sakti hai — sabr karein aur Allah se aafiyat mangein. Roshni wali aag hidayat ki alamat hai.' },
  { k: ['machli', 'machhli', 'fish'], t: '🐟 *Machli dekhna:* Rizq-e-halal aur barkat ki alamat hai — khaas tor par samandari machli.' },
  { k: ['doodh', 'milk'], t: '🥛 *Doodh dekhna:* Deen ki fitrat aur halal rizq ki alamat — bohat mubarak khwab hai.' },
  { k: ['chand', 'moon', 'hilal'], t: '🌙 *Chand dekhna:* Noor, hidayat aur khushkhabri ki alamat hai.' },
  { k: ['suraj', 'sun', 'dhoop'], t: '☀️ *Suraj dekhna:* Izzat, kamyabi aur roshni ki alamat — mushkil waqt guzarne wala hai.' },
  { k: ['masjid', 'namaz', 'quran', 'hujj', 'umrah', 'roza'], t: '🕌 *Masjid/namaz dekhna:* Deen ki taraf rujoo aur Allah ki qurbat ki alamat — bohat mubarak khwab, is par qaim rahein.' },
  { k: ['parinda', 'bird', 'chidiya', 'kabutar'], t: '🕊️ *Parinda dekhna:* Azadi, khushkhabri ya safar ki alamat hai. Safed parinda aman ki nishani.' },
  { k: ['kutta', 'dog'], t: '🐕 *Kutta dekhna:* Wafadar dost ya hifazat ki alamat — lekin kaatne wala kutta dushman se khabardar karta hai.' },
  { k: ['billi', 'cat'], t: '🐈 *Billi dekhna:* Ghar mein kisi chaalak shakhs ki taraf ishara ho sakta hai — ehtiyat se kaam lein.' },
  { k: ['paisa', 'rupay', 'note', 'sikke', 'money'], t: '💵 *Paisa dekhna:* Rizq mein izafe ki umeed — mehnat jari rakhein, Allah barkat dega.' },
  { k: ['kapre', 'libas', 'naye kapde', 'clothes'], t: '👗 *Naye kapre dekhna:* Izzat aur nayi shuruaat ki alamat hai.' },
];

// compact number: 1732439659255 → "1.73T"
function compactNum(n) {
  n = Number(n) || 0;
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}

// ── autoreply (per-chat, business) ──
const AUTOREPLY_FILE = path.join(__dirname, '..', 'data', 'autoreply.json');
function loadAutoreply() { try { return JSON.parse(fs.readFileSync(AUTOREPLY_FILE, 'utf8')); } catch { return {}; } }
function saveAutoreply(a) { try { fs.mkdirSync(path.dirname(AUTOREPLY_FILE), { recursive: true }); fs.writeFileSync(AUTOREPLY_FILE, JSON.stringify(a)); } catch (e) {} }
async function autoreplyHook(sock, msg, sender, jid) {
  try {
    if (msg.key.fromMe || isOwnMsgId(msg.key?.id)) return false;
    if (isOwnerMsg(msg, sender, jid)) return false; // owner ke apne messages par nahi
    const text = getText(msg) || '';
    if (!text || text.startsWith(config.prefix)) return false; // command hai
    const map = loadAutoreply();
    const rep = map[jid];
    if (!rep) return false;
    await reply(sock, jid, msg, rep);
    return true;
  } catch { return false; }
}

// 🎶 antakshari hook: game active ho to saada text = gane ka jawab
async function antakshariHook(sock, msg, sender, jid) {
  try {
    if (msg.key.fromMe || isOwnMsgId(msg.key?.id)) return false;
    const text = (getText(msg) || '').trim();
    if (!text || text.startsWith(config.prefix)) return false;
    const all = loadAntak();
    const st = all[jid];
    if (!st || !st.on) return false;
    const first = songEdge(text, true);
    if (!first) return false;
    if (first === (st.need || '').toLowerCase()) {
      st.rounds = (st.rounds || 0) + 1;
      // user ke gane ke aakhri harf se bot ka gana
      const ulast = songEdge(text, false);
      let pool = ANTAK_SONGS.filter(s => songEdge(s, true) === ulast);
      if (!pool.length) pool = ANTAK_SONGS;
      const mine = pool[Math.floor(Math.random() * pool.length)];
      st.need = songEdge(mine, false);
      saveAntak(all);
      const wahs = ['✅ *Wah wah!* Sahi harf! 🎶', '✅ *Kya gaya hai!* Dil khush kar diya 🎶', '✅ *Zabardast!* Aap to singer nikle 🎤✨'];
      await reply(sock, jid, msg, `${wahs[Math.floor(Math.random() * wahs.length)]}\n\n🎤 Mera misra:\n_"${mine}"_\n\nAb aap *${st.need.toUpperCase()}* harf se koi gana gao! 🎤`);
    } else {
      await reply(sock, jid, msg, `❌ Arey! *${(st.need || '').toUpperCase()}* harf se shuru hona chahiye tha 😄\n\nDobara try karo — ya *${config.prefix}antakshari khatam* likho.`);
    }
    return true;
  } catch { return false; }
}

// 🎤 interview hook: interview mode ON ho to saada text = jawab
async function interviewHook(sock, msg, sender, jid) {
  try {
    if (msg.key.fromMe || isOwnMsgId(msg.key?.id)) return false;
    const text = (getText(msg) || '').trim();
    if (!text || text.startsWith(config.prefix)) return false;
    const all = loadInterview();
    const st = all[jid];
    if (!st || !st.on) return false;
    if (st.last && Date.now() - st.last > 15 * 60 * 1000) {
      delete all[jid]; saveInterview(all);
      await reply(sock, jid, msg, `🎤 *Interview auto-khatam* — 15 minute se koi jawab nahi aaya 😴\n\nDobara shuru karna ho to: *${config.prefix}interview <field>* 💗`);
      return true;
    }
    st.count = (st.count || 0) + 1;
    st.last = Date.now();
    saveInterview(all);
    await reply(sock, jid, msg, `🎤 _Jawab note kar liya..._ 💗`, { nosig: true });
    try {
      const q = await askNexa(`Tum professional interviewer ho. Field: "${st.field}". Candidate ka jawab: "${text.slice(0, 500)}". Pehle 1 line mein jawab par MUKHTASIR tabsira do, phir AGLA interview sawal pucho. Roman Urdu, kul 3-4 lines.`);
      if (q && q.trim()) await reply(sock, jid, msg, `🎤 *Interview — ${st.field}*\n\n${q.trim().slice(0, 1200)}\n\n_(Khatam karne ke liye: ${config.prefix}interview khatam)_`);
    } catch (e) { console.error('[interview] fail:', e.message); }
    return true;
  } catch { return false; }
}

// ── dukaan rate list (per-user) ──
const RATELIST_FILE = path.join(__dirname, '..', 'data', 'ratelist.json');
function loadRatelist() { try { return JSON.parse(fs.readFileSync(RATELIST_FILE, 'utf8')); } catch { return {}; } }
function saveRatelist(r) { try { fs.mkdirSync(path.dirname(RATELIST_FILE), { recursive: true }); fs.writeFileSync(RATELIST_FILE, JSON.stringify(r)); } catch (e) {} }

// ── team tasks (per-group) ──
const TASKS_FILE = path.join(__dirname, '..', 'data', 'tasks.json');
function loadTasks() { try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); } catch { return {}; } }
function saveTasks(t) { try { fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true }); fs.writeFileSync(TASKS_FILE, JSON.stringify(t)); } catch (e) {} }

// ── scheduled messages (reminder infra reuse) ──
const SCHEDULES_FILE = path.join(__dirname, '..', 'data', 'schedules.json');
function loadSchedules() { try { const a = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveSchedules(a) { try { fs.mkdirSync(path.dirname(SCHEDULES_FILE), { recursive: true }); fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(a)); } catch (e) {} }
async function checkSchedules() {
  if (!REM_SOCK) return;
  try {
    const me = num(REM_SOCK.user?.id || '');
    const all = loadSchedules();
    const now = Date.now();
    const mine = all.filter(s => s.due <= now && (!s.by || s.by === me));
    if (!mine.length) return;
    saveSchedules(all.filter(s => !mine.includes(s)));
    for (const s of mine) {
      try { await REM_SOCK.sendMessage(s.jid, { text: `📅 *Scheduled paigham* 💗\n\n${s.text}` }); } catch {}
    }
  } catch {}
}

// ── time capsules ⏳ (date par khud khulenge) ──
const CAPSULES_FILE = path.join(__dirname, '..', 'data', 'capsules.json');
function loadCapsules() { try { const a = JSON.parse(fs.readFileSync(CAPSULES_FILE, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveCapsules(a) { try { fs.mkdirSync(path.dirname(CAPSULES_FILE), { recursive: true }); fs.writeFileSync(CAPSULES_FILE, JSON.stringify(a)); } catch (e) { console.error('[capsules] save fail:', e.message); } }
async function checkCapsules() {
  if (!REM_SOCK) return;
  try {
    const me = num(REM_SOCK.user?.id || '');
    const all = loadCapsules();
    const now = Date.now();
    const mine = all.filter(c => c.due <= now && (!c.by || c.by === me));
    if (!mine.length) return;
    saveCapsules(all.filter(c => !mine.includes(c)));
    for (const c of mine) {
      try { await REM_SOCK.sendMessage(c.jid, { text: `⏳ *Time Capsule khula!* 📬\n\n📅 *${c.date}* ko likha tha:\n\n💌 ${c.text}\n\n💗 _${config.botName}_` }); } catch {}
    }
  } catch {}
}

// ── Asia/Karachi date (YYYY-MM-DD) ──
function pktDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function pktAddDaysStr(n) {
  const d = new Date(Date.now() + n * 86400000);
  return pktDateStr(d);
}

// ── habit tracker 🌱 ──
const HABITS_FILE = path.join(__dirname, '..', 'data', 'habits.json');
function loadHabits() { try { return JSON.parse(fs.readFileSync(HABITS_FILE, 'utf8')); } catch { return {}; } }
function saveHabits(h) { try { fs.mkdirSync(path.dirname(HABITS_FILE), { recursive: true }); fs.writeFileSync(HABITS_FILE, JSON.stringify(h)); } catch (e) {} }
function habitStreak(dates) {
  const set = new Set(dates);
  let streak = 0;
  for (let i = 0; ; i++) {
    if (set.has(pktAddDaysStr(-i))) streak++;
    else break;
  }
  return streak;
}

// ── antakshari state 🎶 ──
const ANTAK_FILE = path.join(__dirname, '..', 'data', 'antakshari.json');
function loadAntak() { try { return JSON.parse(fs.readFileSync(ANTAK_FILE, 'utf8')); } catch { return {}; } }
function saveAntak(a) { try { fs.mkdirSync(path.dirname(ANTAK_FILE), { recursive: true }); fs.writeFileSync(ANTAK_FILE, JSON.stringify(a)); } catch (e) {} }
const ANTAK_SONGS = [
  'Tum hi ho, tum hi ho', 'O mere dil ke chain', 'Chaiyya chaiyya', 'Kabhi kabhi mere dil mein',
  'Lag ja gale ke phir', 'Tujhe dekha to ye jana sanam', 'Mere sapno ki rani', 'Ajeeb dastan hai ye',
  'Yeh dosti hum nahi todenge', 'Zindagi ek safar hai suhana', 'Aao na gale lag jao na', 'Dil diyan gallan',
  'Gerua rang de', 'Kal ho na ho', 'O saathi re', 'Ek pyaar ka naghma hai',
  'Aa chal ke tujhe', 'Hum tum ek kamre mein', 'Mera joota hai Japani', 'Ishq wala love',
  'Ek ladki ko dekha', 'Aankh mare o ladka', 'O o jane jana', 'Nachde ne saare',
  'Gallan goodiyan', 'Ude jab jab zulfen teri', 'Roop tera mastana', 'Aaj kal tere mere',
  'Babuji dheere chalna', 'Aati kya Khandala',
];
function songEdge(s, first) {
  const letters = (s.toLowerCase().match(/[a-z\u00c0-\u024f\u0600-\u06ff]/g) || []);
  if (!letters.length) return '';
  return first ? letters[0] : letters[letters.length - 1];
}

// ── sauda (bargaining) state 🛒 ──
const SAUDA_FILE = path.join(__dirname, '..', 'data', 'sauda.json');
function loadSauda() { try { return JSON.parse(fs.readFileSync(SAUDA_FILE, 'utf8')); } catch { return {}; } }
function saveSauda(s) { try { fs.mkdirSync(path.dirname(SAUDA_FILE), { recursive: true }); fs.writeFileSync(SAUDA_FILE, JSON.stringify(s)); } catch (e) {} }

// ── interview state 🎤 ──
const INTERVIEW_FILE = path.join(__dirname, '..', 'data', 'interview.json');
function loadInterview() { try { return JSON.parse(fs.readFileSync(INTERVIEW_FILE, 'utf8')); } catch { return {}; } }
function saveInterview(s) { try { fs.mkdirSync(path.dirname(INTERVIEW_FILE), { recursive: true }); fs.writeFileSync(INTERVIEW_FILE, JSON.stringify(s)); } catch (e) {} }
// "khatam" ke aam misspellings bhi STOP samjho — taake ghalat spelling par naya session na khul jaye
const STOPWORD_RE = /^(khatam|khtam|khatm|katam|khattm|khaatam|khatam karo)$/i;
function isStopWord(s) { return STOPWORD_RE.test((s || '').trim()); }

// ── Allah ke 99 naam ✨ [transliteration, arabic, urdu matlab] ──
const ALLAH_NAMES = [
  ['Ar-Rahman', 'الرحمن', 'Nihayat reham karne wala'],
  ['Ar-Rahim', 'الرحيم', 'Bara meharban'],
  ['Al-Malik', 'الملك', 'Sab ka baadshah'],
  ['Al-Quddus', 'القدوس', 'Har aib se paak'],
  ['As-Salam', 'السلام', 'Salamti dene wala'],
  ['Al-Mu\'min', 'المؤمن', 'Aman dene wala'],
  ['Al-Muhaymin', 'المهيمن', 'Sab ka nigehban'],
  ['Al-Aziz', 'العزيز', 'Sab par ghalib'],
  ['Al-Jabbar', 'الجبار', 'Bigre kaam sanwarne wala'],
  ['Al-Mutakabbir', 'المتكبر', 'Sab se buzurg'],
  ['Al-Khaliq', 'الخالق', 'Paida karne wala'],
  ['Al-Bari', 'البارئ', 'Be-misal paida karne wala'],
  ['Al-Musawwir', 'المصور', 'Soortein banane wala'],
  ['Al-Ghaffar', 'الغفار', 'Baar baar bakhshne wala'],
  ['Al-Qahhar', 'القهار', 'Sab ko maghloob karne wala'],
  ['Al-Wahhab', 'الوهاب', 'Be-hisab dene wala'],
  ['Ar-Razzaq', 'الرزاق', 'Sab ko rizq dene wala'],
  ['Al-Fattah', 'الفتاح', 'Mushkilein kholne wala'],
  ['Al-Alim', 'العليم', 'Sab kuch janne wala'],
  ['Al-Qabid', 'القابض', 'Rozi tang karne wala'],
  ['Al-Basit', 'الباسط', 'Rozi kushada karne wala'],
  ['Al-Khafid', 'الخافض', 'Maghrooron ko girane wala'],
  ['Ar-Rafi', 'الرافع', 'Darje buland karne wala'],
  ['Al-Mu\'izz', 'المعز', 'Izzat dene wala'],
  ['Al-Mudhill', 'المذل', 'Zillat dene wala'],
  ['As-Sami', 'السميع', 'Sab kuch sunne wala'],
  ['Al-Basir', 'البصير', 'Sab kuch dekhne wala'],
  ['Al-Hakam', 'الحكم', 'Sab se behtar faisla karne wala'],
  ['Al-Adl', 'العدل', 'Kaamil insaaf karne wala'],
  ['Al-Latif', 'اللطيف', 'Nihayat narm aur bareek-been'],
  ['Al-Khabir', 'الخبير', 'Har cheez ki khabar rakhne wala'],
  ['Al-Halim', 'الحليم', 'Burdbar, jaldi saza na dene wala'],
  ['Al-Azim', 'العظيم', 'Nihayat azmat wala'],
  ['Al-Ghafur', 'الغفور', 'Bakhshne wala'],
  ['Ash-Shakur', 'الشكور', 'Thode amal par bara ajar dene wala'],
  ['Al-Ali', 'العلي', 'Sab se buland'],
  ['Al-Kabir', 'الكبير', 'Sab se bara'],
  ['Al-Hafiz', 'الحفيظ', 'Har cheez ki hifazat karne wala'],
  ['Al-Muqit', 'المقيت', 'Sab ko rozi pahunchane wala'],
  ['Al-Hasib', 'الحسيب', 'Hisab lene wala'],
  ['Al-Jalil', 'الجليل', 'Buzurgi aur azmat wala'],
  ['Al-Karim', 'الكريم', 'Bara karam karne wala'],
  ['Ar-Raqib', 'الرقيب', 'Har cheez par nazar rakhne wala'],
  ['Al-Mujib', 'المجيب', 'Duaen qabool karne wala'],
  ['Al-Wasi', 'الواسع', 'Ilm aur rehmat mein kushada'],
  ['Al-Hakim', 'الحكيم', 'Kaamil hikmat wala'],
  ['Al-Wadud', 'الودود', 'Apne bandon se mohabbat karne wala'],
  ['Al-Majid', 'المجيد', 'Bara buzurg aur azeem'],
  ['Al-Ba\'ith', 'الباعث', 'Qayamat ko uthane wala'],
  ['Ash-Shahid', 'الشهيد', 'Har cheez ka gawah'],
  ['Al-Haqq', 'الحق', 'Barhaq, hamesha qaim'],
  ['Al-Wakil', 'الوكيل', 'Kaam banane wala'],
  ['Al-Qawiyy', 'القوي', 'Kaamil taqat wala'],
  ['Al-Matin', 'المتين', 'Nihayat mazboot'],
  ['Al-Waliyy', 'الولي', 'Madadgar dost'],
  ['Al-Hamid', 'الحميد', 'Har haal mein tareef ke laiq'],
  ['Al-Muhsi', 'المحصي', 'Har cheez ginne wala'],
  ['Al-Mubdi', 'المبدئ', 'Pehli baar paida karne wala'],
  ['Al-Mu\'id', 'المعيد', 'Dobara paida karne wala'],
  ['Al-Muhyi', 'المحيي', 'Zindagi dene wala'],
  ['Al-Mumit', 'المميت', 'Maut dene wala'],
  ['Al-Hayy', 'الحي', 'Hamesha zinda rehne wala'],
  ['Al-Qayyum', 'القيوم', 'Sab ko qaim rakhne wala'],
  ['Al-Wajid', 'الواجد', 'Har cheez pane wala, be-niyaz'],
  ['Al-Majid', 'الماجد', 'Bara shan wala'],
  ['Al-Wahid', 'الواحد', 'Akela, be-misal'],
  ['Al-Ahad', 'الأحد', 'Yekta, tanha'],
  ['As-Samad', 'الصمد', 'Be-niyaz, sab us ke mohtaj'],
  ['Al-Qadir', 'القادر', 'Har cheez par qadir'],
  ['Al-Muqtadir', 'المقتدر', 'Kaamil qudrat wala'],
  ['Al-Muqaddim', 'المقدم', 'Jise chahe aage kare'],
  ['Al-Mu\'akhkhir', 'المؤخر', 'Jise chahe peechhe kare'],
  ['Al-Awwal', 'الأول', 'Sab se pehle'],
  ['Al-Akhir', 'الآخر', 'Sab se aakhir'],
  ['Az-Zahir', 'الظاهر', 'Sab se zahir'],
  ['Al-Batin', 'الباطن', 'Sab se poshida'],
  ['Al-Wali', 'الوالي', 'Sab ka haakim'],
  ['Al-Muta\'ali', 'المتعالي', 'Har kami se buland tar'],
  ['Al-Barr', 'البر', 'Bara ehsan karne wala'],
  ['At-Tawwab', 'التواب', 'Tauba qabool karne wala'],
  ['Al-Muntaqim', 'المنتقم', 'Mujrimon se badla lene wala'],
  ['Al-Afuww', 'العفو', 'Bara maaf karne wala'],
  ['Ar-Ra\'uf', 'الرؤوف', 'Nihayat shafeeq'],
  ['Malik-ul-Mulk', 'مالك الملك', 'Baadshahat ka malik'],
  ['Dhul-Jalali-wal-Ikram', 'ذو الجلال والإكرام', 'Jalal aur ikram wala'],
  ['Al-Muqsit', 'المقسط', 'Insaaf qaim karne wala'],
  ['Al-Jami', 'الجامع', 'Sab ko jama karne wala'],
  ['Al-Ghaniyy', 'الغني', 'Be-niyaz, ghani'],
  ['Al-Mughni', 'المغني', 'Ghani karne wala'],
  ['Al-Mani', 'المانع', 'Buraai se rokne wala'],
  ['Ad-Darr', 'الضار', 'Nuqsan par qadir (apni hikmat se)'],
  ['An-Nafi', 'النافع', 'Faida dene wala'],
  ['An-Nur', 'النور', 'Aasmanon aur zameen ka noor'],
  ['Al-Hadi', 'الهادي', 'Hidayat dene wala'],
  ['Al-Badi', 'البديع', 'Be-misal ijaad karne wala'],
  ['Al-Baqi', 'الباقي', 'Hamesha baqi rehne wala'],
  ['Al-Warith', 'الوارث', 'Sab cheezon ka waris'],
  ['Ar-Rashid', 'الرشيد', 'Seedhi rah dikhane wala'],
  ['As-Sabur', 'الصبور', 'Bara sabar karne wala'],
];

// ── Pakistan income tax FY 2025-26 (salaried, FBR) — andaaza ──
function pakIncomeTax(monthly) {
  const annual = Math.round(monthly * 12);
  let tax = 0;
  if (annual <= 600000) tax = 0;
  else if (annual <= 1200000) tax = 0.01 * (annual - 600000);
  else if (annual <= 2200000) tax = 6000 + 0.11 * (annual - 1200000);
  else if (annual <= 3200000) tax = 116000 + 0.23 * (annual - 2200000);
  else if (annual <= 4100000) tax = 346000 + 0.30 * (annual - 3200000);
  else tax = 616000 + 0.35 * (annual - 4100000);
  tax = Math.round(tax);
  return { annual, tax, monthlyTax: Math.round(tax / 12), eff: annual ? (tax / annual * 100) : 0 };
}

// ── quiz pool (20+): general knowledge / Islamic / Pakistan ──
const QUIZ_QS = [
  { q: 'Pakistan ka dar-ul-hakumat konsa hai?', opts: ['Karachi', 'Lahore', 'Islamabad', 'Peshawar'], a: 2 },
  { q: 'Quran ki sab se lambi surah konsi hai?', opts: ['Al-Imran', 'Al-Baqarah', 'An-Nisa', 'Al-Maida'], a: 1 },
  { q: 'Pakistan ne Cricket World Cup kab jeeta?', opts: ['1987', '1996', '1992', '1999'], a: 2 },
  { q: 'Roze kis Islami mahine mein farz hain?', opts: ['Shaban', 'Shawwal', 'Ramadan', 'Zil Hajj'], a: 2 },
  { q: 'Quaid-e-Azam ka asal naam kya tha?', opts: ['Liaquat Ali Khan', 'Muhammad Ali Jinnah', 'Allama Iqbal', 'Fatima Jinnah'], a: 1 },
  { q: 'Duniya ka sab se bara samandar konsa hai?', opts: ['Atlantic', 'Pacific', 'Indian', 'Arctic'], a: 1 },
  { q: 'Din mein kitni namazein farz hain?', opts: ['3', '4', '6', '5'], a: 3 },
  { q: 'Pakistan ka qaumi khel konsa hai?', opts: ['Hockey', 'Cricket', 'Football', 'Kabaddi'], a: 0 },
  { q: 'Pehla Kalma konsa hai?', opts: ['Kalma Shahadat', 'Kalma Tayyab', 'Kalma Tamjeed', 'Kalma Tauheed'], a: 1 },
  { q: 'Minar-e-Pakistan kahan hai?', opts: ['Karachi', 'Islamabad', 'Lahore', 'Multan'], a: 2 },
  { q: 'Zameen suraj ke gird ek chakkar kitne din mein lagati hai?', opts: ['365', '364', '366', '360'], a: 0 },
  { q: 'Hazrat Muhammad (SAW) ki wiladat kis sheher mein hui?', opts: ['Madina', 'Taif', 'Makkah', 'Jeddah'], a: 2 },
  { q: 'Pakistan ki sarhad kitne mulkon se milti hai?', opts: ['3', '5', '4', '6'], a: 2 },
  { q: 'Pakistan ki qaumi zaban konsi hai?', opts: ['Punjabi', 'Urdu', 'English', 'Saraiki'], a: 1 },
  { q: 'Chand par pehla qadam kis ne rakha?', opts: ['Buzz Aldrin', 'Neil Armstrong', 'Yuri Gagarin', 'Michael Collins'], a: 1 },
  { q: 'Zakat ki sharah kitni hai?', opts: ['5%', '2.5%', '7.5%', '10%'], a: 1 },
  { q: 'K2 ki unchai kitni hai?', opts: ['8849m', '8611m', '8500m', '8100m'], a: 1 },
  { q: 'Pakistan ka Youm-e-Azadi kab hai?', opts: ['15 August', '14 August', '23 March', '25 December'], a: 1 },
  { q: 'Wuzu mein kitne farz hain?', opts: ['4', '5', '6', '7'], a: 0 },
  { q: 'Duniya ki sab se lambi nadi konsi hai?', opts: ['Amazon', 'Nile', 'Ganga', 'Indus'], a: 1 },
  { q: 'PSL ka pehla edition kab hua?', opts: ['2015', '2017', '2016', '2018'], a: 2 },
  { q: 'Allama Iqbal ka mashhoor majmua konsa hai?', opts: ['Diwan-e-Ghalib', 'Bang-e-Dara', 'Gulistan', 'Shah Jo Risalo'], a: 1 },
];
const quizState = new Map(); // key: sender||jid → { order, i, score }

// ── paheliyan (15+) ──
const RIDDLES = [
  { q: 'Wo kya hai jo aap ka hai, lekin doosre aap se zyada istemal karte hain?', a: ['naam', 'name', 'aap ka naam'] },
  { q: 'Mere paas sheher hain lekin ghar nahi, jangal hain lekin darakht nahi, dariya hain lekin pani nahi. Main kya hoon?', a: ['naqsha', 'naksha', 'map'] },
  { q: 'Mere 4 pair hain lekin chal nahi sakta. Main kya hoon?', a: ['mez', 'table'] },
  { q: 'Wo konsi cheez hai jo jitni istemal ho utni tez hoti hai?', a: ['dimagh', 'dimaagh', 'brain', 'aqal'] },
  { q: 'Main hamesha aata hoon lekin kabhi pohnchta nahi. Main kya hoon?', a: ['kal', 'tomorrow', 'aane wala kal'] },
  { q: 'Aap jitne qadam uthate hain, wo utna peeche reh jata hai. Wo kya hai?', a: ['qadam', 'kadam', 'step', 'nishan'] },
  { q: 'Konsa mahina 28 din ka hota hai?', a: ['sab', 'sare', 'saare', 'all', 'har', 'har mahina'] },
  { q: 'Wo kya hai jo upar jata hai lekin neeche kabhi nahi aata?', a: ['umar', 'age'] },
  { q: 'Meri ek aankh hai lekin dekh nahi sakti. Main kya hoon?', a: ['soyi', 'sui', 'needle'] },
  { q: 'Wo konsi cheez hai jo pani mein gir kar bhi geeli nahi hoti?', a: ['saya', 'saaya', 'shadow', 'parchhai'] },
  { q: 'Main bol nahi sakta lekin aap jo kehte hain dohra deta hoon. Main kya hoon?', a: ['goonj', 'echo'] },
  { q: 'Main din ko sota hoon, raat ko jagta hoon. Main kya hoon?', a: ['ullu', 'owl'] },
  { q: 'Wo kya hai jo zaroorat ke waqt phenk dete hain aur baghair zaroorat utha lete hain?', a: ['langar', 'anchor'] },
  { q: 'Mere paas keys hain lekin koi taala nahi khol sakta. Main kya hoon?', a: ['keyboard'] },
  { q: 'Wo kya hai jo daudta hai lekin chalta kabhi nahi?', a: ['ghari', 'clock'] },
  { q: 'Wo kya hai jo hamesha bhookha rehta hai, jitna khilao utna mangta hai?', a: ['aag', 'fire'] },
];
const riddleState = new Map(); // key: sender||jid → { a: [answers] }

// ── hairan-kun facts (20+, Roman Urdu) ──
const FACTS = [
  '🍯 Shahd (honey) kabhi kharab nahi hota — 3000 saal purana shahd bhi khane ke qabil milta hai!',
  '🐙 Octopus ke 3 dil hote hain!',
  '🧠 Insani dimagh ki yaad-dasht taqreeban 2.5 petabyte hoti hai.',
  '🐝 Ek chamach shahd ke liye makhi taqreeban 5000 phoolon ka chakkar lagati hai.',
  '🌊 Zameen ka sab se gehra muqam Mariana Trench hai — taqreeban 11 km gehra!',
  '🐱 Billi apni moonchhon se rasta aur jagah napti hai.',
  '👅 Ungliyon ke nishan ki tarah har insan ki zaban ka nishan bhi munfarid hota hai.',
  '🦒 Giraffe ki zaban taqreeban 50 cm lambi hoti hai!',
  '🌍 Duniya mein har saal taqreeban 50,000 zalzale aate hain — aksar mehsoos nahi hote.',
  '🐪 Oont apne kohaan mein charbi zakheera karta hai, pani nahi!',
  '👁️ Insani aankh taqreeban 1 crore (10 million) rang pehchan sakti hai.',
  '🍓 Strawberry wahid phal hai jiske beej bahar ki taraf hote hain.',
  '🦤 Shutarmurgh ki aankh uske dimagh se bari hoti hai!',
  '❄️ Barf ke kisi do tukron (snowflakes) ka design ek jaisa nahi hota.',
  '🦷 Danton ka enamel insani jism ka sab se sakht mada hai.',
  '🏔️ K2 (8611m) duniya ki doosri buland tareen choti hai.',
  '😴 Neend mein insani dimagh jaagne se zyada faal hota hai.',
  '🐘 Hathi wahid janwar hai jo kood nahi sakta.',
  '💧 Unchai par pani 100°C se kam darje par ubalne lagta hai.',
  '🌳 Bristlecone pine duniya ke qadeem tareen darakhton mein se hai — 5000 saal tak zinda rehta hai!',
  '🦷 Insani jism mein 206 haddiyan hoti hain — aadhi se zyada haathon aur pairon mein!',
  '🐭 Chuha baghair ruke 3 din tak tair sakta hai.',
];

// Text → sticker (attp)
function attpBuffer(text) {
  const t = esc(text.slice(0, 30) || 'NEXORA');
  const svg =
    `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">` +
    `<text x="256" y="286" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="72" font-weight="bold" fill="#ffffff" stroke="#0b2b30" stroke-width="2">${t}</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp().toBuffer();
}

// Wish card (Rexai theme) — SVG → PNG. NOTE: SVG ke andar emoji mat dalo, sharp/librsvg unhe render nahi karta.
function wishCard(name, occasion, subtext) {
  const n = esc(String(name || 'Dost').slice(0, 24));
  const o = esc(String(occasion || 'Dher Sari Duaen').slice(0, 40));
  const s = esc(String(subtext || '').slice(0, 60));
  // lamba naam ho to font chhota taake card se bahar na jaye
  const fs = Math.max(44, Math.min(88, Math.floor(680 / Math.max(4, n.length * 0.58))));
  const svg =
    `<svg width="800" height="1000" xmlns="http://www.w3.org/2000/svg">` +
    `<defs>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#001619"/><stop offset="1" stop-color="#06333a"/>` +
    `</linearGradient>` +
    `<radialGradient id="gl1" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0" stop-color="#50E8F4" stop-opacity="0.35"/><stop offset="1" stop-color="#50E8F4" stop-opacity="0"/>` +
    `</radialGradient>` +
    `<radialGradient id="gl2" cx="0.5" cy="0.5" r="0.5">` +
    `<stop offset="0" stop-color="#ff9ecf" stop-opacity="0.30"/><stop offset="1" stop-color="#ff9ecf" stop-opacity="0"/>` +
    `</radialGradient>` +
    `<filter id="gl" x="-60%" y="-60%" width="220%" height="220%">` +
    `<feGaussianBlur stdDeviation="12" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>` +
    `</filter></defs>` +
    `<rect width="800" height="1000" rx="40" fill="url(#bg)"/>` +
    `<circle cx="400" cy="300" r="260" fill="url(#gl1)"/>` +
    `<circle cx="400" cy="760" r="290" fill="url(#gl2)"/>` +
    `<rect x="24" y="24" width="752" height="952" rx="32" fill="none" stroke="#50E8F4" stroke-opacity="0.35" stroke-width="3"/>` +
    `<text x="400" y="140" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="46" font-weight="bold" fill="#C7F8FE">${o}</text>` +
    `<line x1="250" y1="190" x2="550" y2="190" stroke="#6DD5C4" stroke-opacity="0.5" stroke-width="2"/>` +
    `<text x="400" y="470" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${fs}" font-weight="bold" fill="#50E8F4" filter="url(#gl)">${n}</text>` +
    (s ? `<text x="400" y="590" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="36" fill="#6DD5C4">${s}</text>` : '') +
    `<text x="400" y="880" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="34" font-weight="bold" fill="#ff9ecf">NEXORA-MD</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Qibla compass (Rexai theme, 1000x1000) — SVG → PNG. NOTE: SVG ke andar emoji
// mat dalo, sharp/librsvg unhe render nahi karta. Sui bearing par rotated.
function qiblaSVG(city, deg, needleDeg) {
  const c = esc(String(city || '').slice(0, 44));
  const d = Math.max(0, Math.min(360, Number(deg) || 0));
  const nd = Number.isFinite(+needleDeg) ? +needleDeg : d; // sui ka angle (animation mein badalta hai)
  const cx = 500, cy = 440, R = 300;
  let ticks = '';
  for (let a = 0; a < 360; a += 15) {
    const rad = a * Math.PI / 180;
    const major = a % 90 === 0;
    const r1 = R - (major ? 44 : 24), r2 = R - 8;
    const x1 = cx + r1 * Math.sin(rad), y1 = cy - r1 * Math.cos(rad);
    const x2 = cx + r2 * Math.sin(rad), y2 = cy - r2 * Math.cos(rad);
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${major ? '#50E8F4' : '#6DD5C4'}" stroke-opacity="${major ? '0.95' : '0.5'}" stroke-width="${major ? 6 : 3}"/>`;
    if (major) {
      const lx = cx + (R - 72) * Math.sin(rad), ly = cy - (R - 72) * Math.cos(rad);
      ticks += `<text x="${lx.toFixed(1)}" y="${(ly + 13).toFixed(1)}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="38" font-weight="bold" fill="#C7F8FE">${a}</text>`;
    }
  }
  let labels = '';
  for (const [t, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const rad = a * Math.PI / 180;
    const lx = cx + (R - 140) * Math.sin(rad), ly = cy - (R - 140) * Math.cos(rad);
    labels += `<text x="${lx.toFixed(1)}" y="${(ly + 20).toFixed(1)}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="58" font-weight="bold" fill="${a === 0 ? '#ff9ecf' : '#EAF7F8'}">${t}</text>`;
  }
  const svg =
    `<svg width="1000" height="1000" xmlns="http://www.w3.org/2000/svg">` +
    `<defs>` +
    `<linearGradient id="qbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#001619"/><stop offset="1" stop-color="#06333a"/></linearGradient>` +
    `<linearGradient id="ndl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd166"/><stop offset="0.55" stop-color="#ff9e3d"/><stop offset="1" stop-color="#e63946"/></linearGradient>` +
    `<radialGradient id="qgl" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#50E8F4" stop-opacity="0.30"/><stop offset="1" stop-color="#50E8F4" stop-opacity="0"/></radialGradient>` +
    `</defs>` +
    `<rect width="1000" height="1000" fill="url(#qbg)"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${R + 80}" fill="url(#qgl)"/>` +
    `<rect x="30" y="30" width="940" height="940" rx="36" fill="none" stroke="#50E8F4" stroke-opacity="0.35" stroke-width="4"/>` +
    `<text x="500" y="92" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="44" font-weight="bold" fill="#C7F8FE">QIBLA COMPASS</text>` +
    `<circle cx="${cx}" cy="${cy}" r="${R}" fill="#041e22" stroke="#50E8F4" stroke-opacity="0.8" stroke-width="5"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${R - 96}" fill="none" stroke="#6DD5C4" stroke-opacity="0.25" stroke-width="2"/>` +
    ticks + labels +
    // sunehri sui — 0° par North ki taraf, needleDeg ke hisaab se clockwise rotate
    `<g transform="rotate(${nd.toFixed(1)} ${cx} ${cy})">` +
    `<polygon points="${cx},${cy - R + 28} ${cx - 24},${cy + 42} ${cx},${cy + 16} ${cx + 24},${cy + 42}" fill="url(#ndl)" stroke="#ffffff" stroke-opacity="0.65" stroke-width="2"/>` +
    `<polygon points="${cx},${cy + R - 56} ${cx - 16},${cy + 42} ${cx},${cy + 16} ${cx + 16},${cy + 42}" fill="#3a4a4e"/>` +
    `</g>` +
    `<circle cx="${cx}" cy="${cy}" r="32" fill="#0b2b30" stroke="#ffd166" stroke-width="4"/>` +
    // Kaaba — kala cube, sunehri patti (emoji nahi)
    `<rect x="455" y="792" width="90" height="90" rx="8" fill="#111111" stroke="#ffd166" stroke-width="4"/>` +
    `<rect x="455" y="814" width="90" height="13" fill="#ffd166"/>` +
    `<text x="500" y="950" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="46" font-weight="bold" fill="#50E8F4">${c} — ${d.toFixed(1)}°</text>` +
    `</svg>`;
  return svg;
}

// Static compass PNG (fallback)
function qiblaCompass(city, deg) {
  return sharp(Buffer.from(qiblaSVG(city, deg, deg))).png().toBuffer();
}

// ─── 🎬 Animated Qibla compass — sui tez ghoom kar bearing par settle (MP4, 12fps/4s) ───
// 0–2.2s: 2.5 chakkar tez | 2.2–3.4s: ease-out + halka overshoot | 3.4–4s: bounce, bilkul bearing
async function qiblaVideo(city, deg) {
  const FPS = 12, N = FPS * 4; // 48 frames
  const d = ((Number(deg) % 360) + 360) % 360;
  const target = d + 360 * Math.max(2, Math.ceil((900 - d) / 360)); // spin ke baad wala bearing (≥900°)
  const easeOutCubic = p => 1 - Math.pow(1 - p, 3);
  const angles = [];
  for (let i = 0; i < N; i++) {
    const t = i / FPS;
    let a;
    if (t < 2.2) a = (t / 2.2) * 900;
    else if (t < 3.4) { const p = (t - 2.2) / 1.2; a = 900 + (target + 18 - 900) * easeOutCubic(p); }
    else { const p = Math.min(1, (t - 3.4) / 0.6); a = target + 18 * Math.pow(1 - p, 2) * Math.cos(2 * Math.PI * p); }
    if (i === N - 1) a = target; // aakhri frame bilkul bearing par
    angles.push(a);
  }
  const dir = '/tmp/qibla_' + Date.now();
  fs.mkdirSync(dir, { recursive: true });
  for (let s = 0; s < N; s += 12) { // parallel batches — tez render
    await Promise.all(angles.slice(s, s + 12).map(async (a, k) => {
      const buf = await sharp(Buffer.from(qiblaSVG(city, d, a))).resize(720, 720).png().toBuffer();
      fs.writeFileSync(`${dir}/f_${String(s + k).padStart(3, '0')}.png`, buf);
    }));
  }
  const out = `${dir}/qibla.mp4`;
  await new Promise((res, rej) => execFile('/usr/bin/ffmpeg',
    ['-y', '-v', 'error', '-framerate', String(FPS), '-i', `${dir}/f_%03d.png`,
     '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', out],
    { timeout: 60000 }, e => e ? rej(e) : res()));
  return { buf: fs.readFileSync(out), dir };
}

// ─── 🖼️ Generic info card — Rexai theme (SVG + sharp), har info command ke liye ───
// rows: [[label, value], ...] (max 8). opts: {sub, hero, desc, accent}
async function infoCard(title, rows, opts = {}) {
  const W = 1000, H = 1240;
  const t = esc(String(title || '').slice(0, 42));
  const sub = esc(String(opts.sub || '').slice(0, 60));
  const accent = opts.accent || '#50E8F4';
  const F = "Arial,'Noto Sans Arabic',Helvetica,sans-serif";
  let y = 120;
  let inner = '';
  inner += `<text x="500" y="${y}" text-anchor="middle" font-family="${F}" font-size="48" font-weight="bold" fill="${accent}">${t}</text>`;
  y += 52;
  if (sub) { inner += `<text x="500" y="${y}" text-anchor="middle" font-family="${F}" font-size="32" fill="#7FA3A7">${sub}</text>`; y += 44; }
  inner += `<line x1="120" y1="${y}" x2="880" y2="${y}" stroke="${accent}" stroke-opacity="0.4" stroke-width="3"/>`;
  y += 40;
  if (opts.hero) {
    const h = esc(String(opts.hero).slice(0, 60));
    inner += `<text x="500" y="${y + 72}" text-anchor="middle" font-family="${F}" font-size="76" font-weight="bold" fill="#EAF7F8">${h}</text>`;
    y += 130;
  }
  if (opts.desc) {
    const words = String(opts.desc).slice(0, 260).split(/\s+/);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > 44) { lines.push(cur.trim()); cur = w; if (lines.length >= 5) break; }
      else cur += ' ' + w;
    }
    if (cur.trim() && lines.length < 6) lines.push(cur.trim());
    for (const ln of lines) {
      inner += `<text x="100" y="${y + 34}" font-family="${F}" font-size="33" fill="#C7F8FE">${esc(ln)}</text>`;
      y += 46;
    }
    y += 18;
  }
  const list = (rows || []).slice(0, 8);
  list.forEach((r, i) => {
    const label = esc(String(r[0] || '').slice(0, 26));
    const val = esc(String(r[1] == null ? '' : r[1]).slice(0, 40));
    const bg = i % 2 ? '#062a30' : '#042026';
    inner += `<rect x="70" y="${y}" width="860" height="78" rx="16" fill="${bg}" stroke="${accent}" stroke-opacity="0.22" stroke-width="2"/>` +
      `<text x="104" y="${y + 50}" font-family="${F}" font-size="33" fill="#7FA3A7">${label}</text>` +
      `<text x="896" y="${y + 50}" text-anchor="end" font-family="${F}" font-size="35" font-weight="bold" fill="#EAF7F8">${val}</text>`;
    y += 94;
  });
  const svg =
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><linearGradient id="icbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#001619"/><stop offset="1" stop-color="#06333a"/></linearGradient>` +
    `<radialGradient id="icgl" cx="0.5" cy="0.35" r="0.6"><stop offset="0" stop-color="${accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${W}" height="${H}" fill="url(#icbg)"/>` +
    `<rect width="${W}" height="${H}" fill="url(#icgl)"/>` +
    `<rect x="28" y="28" width="944" height="1184" rx="36" fill="none" stroke="${accent}" stroke-opacity="0.35" stroke-width="4"/>` +
    inner +
    `<text x="500" y="1190" text-anchor="middle" font-family="${F}" font-size="28" letter-spacing="6" fill="#50E8F4" fill-opacity="0.75">NEXORA-MD</text>` +
    `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Card ke liye emoji-strip (librsvg emoji render nahi karta)
const noEm = (s) => String(s || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/gu, '').replace(/\s{2,}/g, ' ').trim();

// Working messages ke rotating variants — har bar ek jaisa na lage
function wline(variants) { return variants[Math.floor(Math.random() * variants.length)]; }

// Fun commands ke liye 2-step suspense reveal (working line auto-no-signature, result par signature)
async function suspense(sock, jid, msg, line) {
  await reply(sock, jid, msg, line);
  await sleep(1100 + Math.floor(Math.random() * 600));
}

// Card bhejo — render fail ho to text fallback (signature ke saath)
async function sendCard(sock, jid, msg, title, rows, opts, text) {
  const caption = nexaSig(text || '');
  try {
    const png = await infoCard(title, rows, opts || {});
    await sock.sendMessage(jid, { image: png, caption }, { quoted: msg });
  } catch (e) {
    await reply(sock, jid, msg, text);
  }
}

// yt-dlp fallback jab Cobalt fail ho (masalan Instagram par error.api.fetch.empty).
// WhatsApp-compatible (h264+aac) mp4 ka path deta hai, ya null. (2026-09-23)
// baseOpt diya jaye to usi base par download karta hai (race loser cleanup ke liye — 2026-09-26)
async function downloadCompatVideo(url, baseOpt) {
  const YTDLP = '/home/hatch/workspace/ytvenv/bin/yt-dlp';
  const base = baseOpt || `/tmp/fbdl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bname = path.basename(base);
  try {
    await new Promise((res, rej) => {
      execFile(YTDLP, ['--impersonate', 'chrome', '--socket-timeout', '30', '--retries', '3',
        '--concurrent-fragments', '8', // 2026-09-26: chunked downloads tez
        '-f', 'bv*[protocol=https][height<=720]+ba[protocol=https]/b[protocol=https][height<=720]/b',
        '--merge-output-format', 'mp4', '--max-filesize', '40M', '--no-playlist', '--no-warnings',
        '-o', base + '.%(ext)s', url], { timeout: 180000 },
        (err, stdout, stderr) => (err ? rej(new Error(String(stderr || err.message || '').slice(-300))) : res()));
    });
  } catch (e) { console.error('[dl-fallback] yt-dlp fail:', String(e.message || e).slice(-200)); return null; }
  let found = null;
  try {
    if (fs.existsSync(base + '.mp4') && fs.statSync(base + '.mp4').size >= 100 * 1024) found = base + '.mp4';
    else for (const f of fs.readdirSync('/tmp')) {
      if (!f.startsWith(bname) || f.endsWith('.part') || f.endsWith('.ytdl')) continue;
      const p = '/tmp/' + f;
      try { if (fs.statSync(p).size >= 100 * 1024) { found = p; break; } } catch (e) {}
    }
  } catch (e) {}
  if (!found) return null;
  const codecs = await new Promise((res) => {
    execFile('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'csv', found],
      { timeout: 20000 }, (err, stdout) => {
        if (err) return res(null);
        const out = { v: null, a: null };
        String(stdout || '').split('\n').forEach(line => {
          const m = line.match(/^stream,([^,]+),(video|audio)/);
          if (m && m[2] === 'video' && !out.v) out.v = m[1];
          if (m && m[2] === 'audio' && !out.a) out.a = m[1];
        });
        res(out);
      });
  });
  if (codecs && (codecs.v === 'h264' || codecs.v === 'avc1') && codecs.a === 'aac' && found.endsWith('.mp4')) return found;
  // incompatible codec (masalan Instagram ka vp9) → h264+aac mein convert
  const dst = base + '.wa.mp4';
  try {
    await new Promise((res, rej) => {
      execFile('/usr/bin/ffmpeg', ['-y', '-v', 'error', '-i', found, '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', '800k', '-maxrate', '1200k', '-bufsize', '2400k', '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart', dst], { timeout: 300000 }, (e) => (e ? rej(e) : res()));
    });
    if (fs.existsSync(dst) && fs.statSync(dst).size >= 100 * 1024) {
      try { fs.unlinkSync(found); } catch (e) {}
      return dst;
    }
  } catch (e) { console.error('[dl-fallback] transcode fail:', e.message); }
  return null; // convert fail → kharab file mat bhejo
}

async function sendDownload(sock, jid, msg, url, label, emoji) {
  await reply(sock, jid, msg, wline(['⏳ Video nikal rahi hoon... 💗', '🎬 Video laane gayi hoon... thoda sabar ✨', '⏳ Video tayyar ho rahi hai... 💫']));
  const fbBase = `/tmp/fbdl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cleanFb = () => { try { fs.readdirSync('/tmp').forEach((f) => { if (f.startsWith(path.basename(fbBase))) try { fs.unlinkSync('/tmp/' + f); } catch (e) {} }); } catch (e) {} };
  // 2026-09-26 speed: cobalt aur yt-dlp PARALLEL race — pehle cobalt ka wait phir fallback nahi,
  // jo pehle de de wahi bhejo (donon mein se jeetne wala)
  const cobaltTry = (async () => {
    try {
      const r = await cobalt(url);
      let fileUrl = r.url, kind = 'video';
      if (r.status === 'picker' && Array.isArray(r.picker) && r.picker.length) {
        const pick = r.picker.find((p) => p.type === 'video') || r.picker[0];
        fileUrl = pick.url; kind = pick.type === 'photo' ? 'image' : 'video';
      }
      if (!fileUrl) return null;
      return { type: 'url', fileUrl, kind };
    } catch (e) { console.error('[sendDownload] cobalt fail:', url, '-', e.message); return null; }
  })();
  const ytdlpTry = serializedYtdlp(async () => {
    const p = await downloadCompatVideo(url, fbBase);
    return p ? { type: 'file', path: p } : null;
  });
  const win = await raceNonNull([cobaltTry, ytdlpTry]);
  try {
    if (!win) throw new Error('all-fail');
    const caption = `${emoji} *${label}* — via ${config.botName}`;
    if (win.type === 'url') {
      if (win.kind === 'image') await sock.sendMessage(jid, { image: { url: win.fileUrl }, caption }, { quoted: msg });
      else await sock.sendMessage(jid, { video: { url: win.fileUrl }, caption }, { quoted: msg });
    } else {
      const buf = fs.readFileSync(win.path);
      try { fs.unlinkSync(win.path); } catch (e) {}
      await sock.sendMessage(jid, { video: buf, caption }, { quoted: msg });
    }
    return;
  } catch (e) {
    await reply(sock, jid, msg, '❌ Is link ka content nahi mila (deleted / private / ghalat link).');
  } finally {
    cleanFb(); // race haare hue attempt ki bachi-khuchi files saaf
  }
}

// ─── fun content (local — koi API nahi, hamesha chalega) ──
const JOKES = [
  'Teacher: "Agar tumhare paas 10 aam hon aur tum 3 kha lo to kitne bache?"\nStudent: "Sir, 10 hi... mujhe aam se allergy hai!" 😄',
  'Dost: "Yaar tu itna khush kyun hai?"\nMain: "Bijli ka bill kam aaya hai... kyunke light hi nahi aati!" 😂',
  'Biwi: "Tum mujhe kabhi surprise nahi dete!"\nShohar: "Deta hoon... tumhein pata hi nahi chalta!" 😅',
  'Doctor: "Tumhein aaram ki zaroorat hai."\nPatient: "Kitna aaram, doctor sahab?"\nDoctor: "Jitna office se milta hai!" 🤣',
  'Ammi: "Beta, parhai kaisi chal rahi hai?"\nBeta: "Bilkul bijli ki tarah... aati jaati rehti hai!" ⚡😄',
  'Dost: "Teri salary kitni hai?"\nMain: "Itni ke month ke end mein main aur salary dono ro lete hain!" 💸😂',
  'Teacher: "Kal test hai, sab yaad karke aana."\nStudent: "Sir, yaad to main roz karta hoon... bhool jaata hoon!" 📚😅',
  'Girlfriend: "Tum mujhse kitna pyaar karte ho?"\nBoyfriend: "Jitna WiFi se... signal kam ho to bhi connect rehta hoon!" 📶😄',
  'Boss: "Tum late kyun aaye?"\nEmployee: "Sir, traffic tha!"\nBoss: "Toh jaldi nikla karo!"\nEmployee: "Sir, neend bhi to traffic mein phansi thi!" 😴🤣',
  'Dost: "Yaar dieting kar raha hoon."\nMain: "Kya kha raha hai?"\nDost: "Jo bhi nazar aaye... dekh ke!" 🍔😂',
  'Ammi: "Beta, mobile chhod de, aankhein kharab ho jayengi!"\nBeta: "Ammi, aap chashma lagati hain... mobile to aapne bhi chalaya hoga!" 👓😄',
  'Police: "Tumne red light kyun cross ki?"\nDriver: "Sir, green light mein to sab jaate hain... main special hoon!" 🚦🤣',
];

const QUOTES = [
  '"Kamyabi unhi ko milti hai jo haar nahi maante." 💪',
  '"Waqt sab se bara ustaad hai... jo sikhata bhi hai aur aazmata bhi hai." ⏳',
  '"Chhoti soch se bara kaam nahi hota." 🌟',
  '"Mehnat ka phal meetha hota hai — bas sabar ka phal us se bhi meetha!" 🌱',
  '"Jo log tumhein giraana chahte hain, unhein dekh ke muskurao — tum un se upar ho." 😊',
  '"Kal ki fikar chhodo, aaj ko behtar banao — kal khud sanwar jayega." ☀️',
  '"Zindagi mein do cheezein kabhi mat bhoolo: upar wale ka shukar aur apne waade." 🤲',
  '"Mushkil waqt mein himmat mat haaro — raat jitni gehri ho, subah utni qareeb hoti hai." 🌅',
  '"Duniya tumhein tab tak nahi pehchanti jab tak tum khud ko na pehchano." 🪞',
  '"Sapne wo nahi jo neend mein aayein... sapne wo hain jo neend ura dein!" 🔥',
];

const EIGHTBALL = [
  'Haan, bilkul! ✅', 'Mushkil lag raha hai... ❌', 'Bhai, signal weak hain — dobara poocho 🔮',
  '100% haan! 🎯', 'Naamumkin nahi, lekin mehnat lagegi 💪', 'Meri crystal ball kehti hai: HAAN ✨',
  'Abhi waqt sahi nahi hai ⏳', 'Dil kehta hai haan, dimagh kehta hai soch lo 🤔',
  'Pakki baat — ho jayega! 🚀', 'Hmm... 50/50 🎲', 'Taqdeer tumhare saath hai 🌟', 'Bilkul nahi! 🙅',
];

const SHAYARI = [
  'Chandni raaton mein aksar ye socha karta hoon,\nTum jo mil jaate to kya baat hoti! 🌙',
  'Mohabbat mein haar jeet nahi hoti,\nBas dil lagane ki der hoti hai! ❤️',
  'Teri yaadon ke diye jalte hain seene mein,\nTu door hai phir bhi rehta hai qareeb mere! 🕯️',
  'Zindagi guzar gayi tujhe chahte chahte,\nAb to khuda se bhi shikayat nahi hoti! 💔',
  'Phoolon se khushbu aati hai, kaanton se nahi,\nIshq mein dard milta hai, aaraam se nahi! 🥀',
  'Aankhon mein aansu, hothon pe hansi rakhte hain,\nHum apne gham ko chhupana bhi jaante hain! 😊',
  'Dost wo nahi jo saath de mushkil mein,\nDost wo hai jo mushkil ko saath bana le! 🤝',
  'Waqt badalta hai, log badalte hain,\nBas yaadein wahi rehti hain! ⏳',
];

// ─── commands ────────────────────────────────────────────
// ─── menu builder (NEXORA style) ───
function buildMenu() {
  const p = config.prefix;
  const n = Object.keys(commands).filter((k) => !commands[k].hidden).length; // secret commands gintee mein nahi
  // Stylish font (bold sans) — SIRF titles/labels ke liye; command names plain rehte hain taake samajh aayein ✨
  const F = (t) => String(t).replace(/[A-Za-z0-9]/g, (c) => {
    const o = c.charCodeAt(0);
    if (o >= 65 && o <= 90) return String.fromCodePoint(0x1D5A0 + o - 65); // 𝗔-𝗭
    if (o >= 97 && o <= 122) return String.fromCodePoint(0x1D5BA + o - 97); // 𝗮-𝘇
    return String.fromCodePoint(0x1D7EC + o - 48); // 𝟎-𝟗
  });
  const box = (title, cmds) => `╭─━━━━〔 ${F(title)} 〕━━━━─╮\n${cmds.map((c) => `┃ ✦ ${c}`).join('\n')}\n╰─━━━━━━━━━━━━━━━━━━━━━━─╯`;
  return `╭─━━━━━━〔 💗 ${F('NEXORA-MD')} 💗 〕━━━━━━╮
┃ ✦ 👤 ${F('Owner')}    : ${(STATE.settings||{}).owneremoji||'👑'} ${(STATE.settings||{}).ownername||'NEXORA'}
┃ ✦ 🔑 ${F('Prefix')}   : ${p}
┃ ✦ 🛡️ ${F('Mode')}     : ${MODE}
┃ ✦ 📂 ${F('Commands')} : ${n}
┃ ✦ 🟢 ${F('Status')}   : ${F('ONLINE')}
╰─━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━─╯

${box('MAIN', [`${p}menu`, `${p}ping`, `${p}alive`, `${p}contact`])}

${box('🕌 ISLAMIC', [
  `${p}quran — ayat / poori surah / poora para (audio) 📖`,
  `${p}quranmenu — 114 suraton ki list 📖`,
  `${p}alafasy <surah> — Alafasy ki tilawat 🎙️`,
  `${p}basit <surah> — Abdul Basit ki tilawat 🎙️`,
  `${p}ghamdi <surah> — Ghamdi ki tilawat 🎙️`,
  `${p}shuraim <surah> — Shuraim ki tilawat 🎙️`,
  `${p}tilawat <surah>:<ayat> — Quran audio 🎧`,
  `${p}naat <naam> — naat suno 🎤`,
  `${p}hijri — aaj ki Islami tareekh 🌙`,
])}

${box('✨ WOW', [
  `${p}imagine <prompt> — AI image`,
  `${p}img <prompt> — AI image, enhanced HD 🎨✨`,
  `${p}img3d <prompt> — 3D render style 🎨`,
  `${p}imgpro <prompt> — professional photo 📸`,
  `${p}dp [lafz] — stylish DP`,
  `${p}antidelete <on|off> — delete pakro`,
  `${p}tempmail — temp email`,
  `${p}inbox — mail parho`,
  `${p}aichat <on|off|auto> — auto AI reply (Boss style)`,
  `${p}poll <sawal> | <opt1> | <opt2>`,
  `${p}lyrics <gaana>`,
  `${p}vcf — group contacts`,
  `${p}tomp3 — reply → MP3`,
  `${p}meme <template> | <upar> | <neeche> — meme banao 🎭`,
  `${p}ss <link> — website screenshot 📸`,
  `${p}emojimix 🥺🔥 — do emoji → naya sticker 🧪`,
  `${p}capsule <YYYY-MM-DD> <paigham> — time capsule ⏳`,
  `${p}capsules / ${p}delcapsule <n>`,
  `${p}aadat <naam> — habit tracker 🌱`,
  `${p}aadatein — streaks dekho 🔥`,
  `${p}antakshari — bot se gane khelo 🎶`,
  `${p}qibla <sheher> — Qibla direction 🧭`,
  `${p}allah [1-99] — Allah ke 99 naam ✨`,
  `${p}sauda <cheez> <qeemat> — mol-bhaav 🛒`,
  `${p}adalat <muqadma> — funny faisla ⚖️`,
  `${p}interview <field> — mock interview 🎤`,
  `${p}kahani <topic> — chhoti kahani 📖`,
  `${p}trip <jagah> <din> — safar plan ✈️`,
  `${p}sorry <naam> <wajah> — maafi-nama 🥺`,
  `${p}praytime [sheher] — namaz ke auqat 🕌`,
  `${p}movie <naam> — film ki maloomat 🎬`,
  `${p}remini — photo enhance (reply) ✨`,
])}

${NEXUS.nexusMenuBox()}

${GROUPKIT.groupKitMenuBox()}

${box('🛠 UTILITY', [
  `${p}weather <sheher> — live mausam 🌤️`,
  `${p}short <link> — chhota link 🔗`,
  `${p}currency 100 USD to PKR 💱`,
  `${p}prayer <sheher> — namaz timings 🕌`,
  `${p}password [16] — mazboot password 🔐`,
  `${p}news — taaza khabrein 📰`,
  `${p}define <lafz> — dictionary 📖`,
  `${p}github <user> — GitHub info 🐙`,
  `${p}calc 12*8+5 — foran hisaab 🧮`,
  `${p}ip <ip> — IP ki location 🌐`,
  `${p}barcode <text> — barcode banao 📊`,
  `${p}qr [text] — QR code banao 📷 (8 types)`,
  `${p}wiki <topic> — Wikipedia khulasa 📚`,
  `${p}dict <word> — lafz ka matlab 📖`,
  `${p}loc <jagah> — map location 📍`,
  `${p}reminder 10:30 <kaam> — yaad-dihani ⏰`,
  `${p}ocr — photo ka text (reply) 📷`,
  `${p}tasbih — digital tasbih 📿`,
  `${p}crypto <coin> — crypto price 💰`,
  `${p}afk <wajah> — AFK mode 💤`,
  `${p}antilink on/off — links block 🔗`,
  `${p}slow / ${p}fast — audio speed 🐢🐇`,
  `${p}dream <khwab> — khwab ki tabeer 🌙`,
  `${p}jid — JID dekho (reply) 🆔`,
  `${p}ud <word> — Urban Dictionary 📖`,
  `${p}getpp — profile photo (reply/tag)`,
  `${p}getdp — profile photo (getpp jaisa) 🖼️`,
  `${p}screenshot / ${p}webshot — website screenshot 📸`,
  `${p}botstats — system health`,
  `${p}vv — view-once unlock, media aapki private chat mein (reply)`,
  `${p}vv s — view-once photo ka sticker aapki chat mein`,
  `${p}vv2 — view-once media aapki private chat mein (vv jaisa)`,
  `${p}vv3 — view-once media ISI chat mein (reply) 👁️`,
  `${p}vvl — saved view-once list, dekhi hui bhi kholo 💾`,
])}

${box('🎉 FUN', [
  `${p}jadu — zehen parhne wala jadu 🔮😱`,
  `${p}dilkhush [@user] — dil khush card 💗`,
  `${p}compliment [@user] — taareef card 💐`,
  `${p}dhamaka <text> — text blast animation 💥`,
  `${p}sammohan [text] — hypnotic spiral 😵‍💫`,
  `${p}firetext <text> — aag wala text 🔥`,
  `${p}icetext <text> — barf wala text 🧊`,
  `${p}thundertext <text> — bijli wala text ⚡`,
  `${p}metalfire <text> — metal-fire text 🔥`,
  `${p}rhyme <lafz> — qafiya dhoondo ✍`,
  `${p}ship <n1> | <n2> — love % 💘`,
  `${p}country <naam> — mulk ki maloomat 🌍`,
  `${p}recipe <dish> — khana pakao 🍳`,
  `${p}iss — ISS abhi kahan hai 🛰`,
  `${p}quiz — quiz khelo 🧠`,
  `${p}crypto <coin> — live price 🪙`,
  `${p}slap — anime slap 💥`,
  `${p}nokia — Nokia meme 📱`,
  `${p}drake <upar> | <neeche> 😎`,
  `🎧 VOICE CHANGER (audio/voice ke reply mein):`,
  `${p}bass 🔊 ${p}deep 🗣️ ${p}smooth ✨ ${p}fat 🐷`,
  `${p}tupai 🐿️ ${p}blown 📢 ${p}radio 📻 ${p}robot 🤖`,
  `${p}chipmunk 🐹 ${p}nightcore ⚡ ${p}earrape 🔊 ${p}reverse 🔄`,
  `${p}slow 🐢 ${p}fast 🐇 ${p}baby 👶 ${p}demon 😈 ${p}bassboost 🔊`,
  `${p}tovideo — photo → Ken Burns video (reply) 🎬`,
  `${p}collage [2-4] — aakhri photos ka collage 🖼️`,
  `${p}tictactoe — bot se khelo ⭕`,
  `${p}fakechat <naam> | <msg> — fake chat 😄`,
  `${p}cat / ${p}dog — cute pics 🐱🐶`,
  `${p}mock <text> 😜`,
  `${p}clap <text> 👏`,
  `${p}slot — slot machine 🎰`,
  `${p}yesno [sawal] ✅❌`,
  `${p}excuse — foran bahana 😅`,
  `${p}fact — random fact 🧠`,
  `${p}truth — sach bolo 😳`,
  `${p}dare — himmat hai? 😈`,
  `${p}roll [NdM] — pasa phenko 🎲`,
  `${p}coin — head ya tail 🪙`,
  `${p}dadjoke — dad joke 😂`,
  `${p}uwu <text> — uwuify 🥺`,
  `${p}paheli — Urdu paheli 🧩`,
  `${p}vote <sawal> — vote karo 🗳️`,
  `${p}joke`, `${p}quote`, `${p}8ball <sawal>`, `${p}shayari`,
  `${p}shadi <a> & <b> — shaadi fun 💒`,
  `${p}dua — Islami duaein 🤲`,
  `${p}sound1-16 — funny sounds 🔊`,
  `${p}typewriter <text> — harf-ba-harf ✍️`,
  `${p}disappear [sec] <text> — khud mitne wala 💨`,
  `${p}fancy <text> — 8 stylish fonts ✨`,
  `${p}glitch <text> — zalgo glitch 👾`,
  `${p}filter <vintage|pink|dark|bw|sepia> — photo filter (reply) 🎨`,
  `${p}qimg <text> — aesthetic quote card 💬`,
  `${p}circle — photo gol (reply) ⭕`,
  `${p}wasted — WASTED meme (reply) 💀`,
  `${p}pfp [naam] — avatar generator 🎨`,
])}

${box('🎙 VOICE', [
  `🎙 Voice note bhejo — main sun kar command chalaongi!`,
  `Bolo: "menu dikhao" · "tasveer banao ek sher" · "mausam Lahore"`,
  `${p}say <text> — meri awaz mein suno 💗`,
  `${p}say en <text> — English awaz`,
  `${p}tr — reply → Urdu tarjuma`,
  `${p}qr <text> — QR code banao`,
  `${p}qrread — QR photo ka reply → parho`,
])}

${box('📥 DOWNLOAD', [
  `${p}tiktok <link>`,
  `${p}tiktoksearch <lafz> — TikTok search 🔍`,
  `${p}ig <link>`,
  `${p}fb <link>`,
  `${p}audio <gaana> — YouTube audio 🎵`,
  `${p}video <link> — har platform 🎬`,
  `${p}play <gaana> — YouTube search 🎵`,
  `${p}insta <link> — ig jaisa 📸`,
  `${p}ttmp3 <link> — TikTok audio 🎵`,
  `${p}drama <naam> ep <n> — drama episode 📺`,
  `${p}zip2apk — ZIP website → APK 📱`,
  `${p}zip2host [naam] — ZIP website → live link 🌐 (naam apni marzi ka)`,
  `${p}alldown <link> — har platform downloader 📦`,
  `${p}mediafire <link> — MediaFire download 📥`,
  `${p}gdrive <link> — Google Drive download 📥`,
  `${p}gitclone <owner/repo> — GitHub repo ZIP 💻`,
])}

${box('🎨 STICKER', [
  `${p}sticker — photo → sticker (reply)`,
  `${p}toimg — sticker → photo`,
  `${p}attp <text>`,
  `${p}gif — reply video → GIF 🎞️`,
  `${p}wanted — WANTED poster 🤠`,
  `${p}autosticker on/off — har photo auto sticker 🎭`,
])}

${box('💼 PRO', [
  `${p}transcribe — voice ka text (reply) 🎙`,
  `${p}google <sawal> — web search 🔍`,
  `${p}code <kaam> — code likho 💻`,
  `${p}letter <topic> — darkhwast likho ✉️`,
  `${p}autoreply <text>/off — auto jawab 💬`,
  `${p}additem <naam> | <qeemat> — rate list 🏷`,
  `${p}ratelist — dukaan ki price list`,
  `${p}vcard <naam> <number> [company] 👤`,
  `${p}task @user <kaam> — kaam do 📋`,
  `${p}schedule <waqt> <paigham> 📅`,
  `${p}faisla <masla> — faisla karo ⚖️`,
  `${p}tax <mahana tankhwah> — tax andaza 💰`,
  `${p}json <text> — pretty JSON 📦`,
  `${p}base64 / ${p}unbase64 — encode/decode 🔐`,
  `${p}hash <text> — SHA-256 + MD5 #️⃣`,
  `${p}phoneinfo <number> — network/region 📲`,
  `${p}encrypt <text> / ${p}decrypt <text> — secret code 🔐`,
  `${p}apifetch <url> — API ka data lao 🌐`,
  `${p}get <url> — file download karo 📥`,
  `${p}gitstalk <user> — GitHub profile 🔍`,
  `${p}ipstalk <ip> — IP maloomat 🔍`,
  `${p}npmstalk <package> — npm package info 📦`,
])}

${box('😄 PRANK', [
  `${p}hack [@user] — fake hacking 💻`,
  `${p}virus — fake virus alert 🦠`,
  `${p}trace [@user] — fake trace 📡`,
  `${p}spy [@user] — spy report 🕵️`,
  `${p}jailbreak — fake jailbreak 🔓`,
  `${p}matrix <text> — Matrix style 🟩`,
  `${p}secret <text> — fake encryption 🔐`,
  `${p}creact <link> — reaction cycler 🔄`,
  `_Sab 100% mazak hain 😄_`,
])}

${box('🎭 PRANK PACK', [
  `${p}ghosttype [sec] — typing... aur kuch nahi 👻`,
  `${p}fakedelete — fake deleted message 🚫`,
  `${p}fakepreview <t> | <d> | <url> — fake link card 🔗`,
  `${p}fakenews <naam> | <khabar> — breaking news 📰`,
  `${p}voiceprank <text> — shararti voice note 🎤`,
  `${p}fakeupdate — WhatsApp expire alert 📲`,
  `${p}fakebattery [n] — battery khatam 🔋`,
  `${p}fakeresult <naam> | <pass/fail> — BISE result 🎓`,
  `${p}missedcall <naam> — 47 missed calls 📲`,
  `${p}fakeatm — ATM se paise nikle?! 🏧`,
  `${p}fakebill <naam> | <amount> — bijli ka bill 💡`,
  `${p}fakeban [game] — account BAN 🚫`,
  `${p}fakescore — Pakistan 600/0 🏏`,
  `${p}shaadi <dulha> | <dulhan> — shaadi card 💍`,
  `${p}challan <naam> | <amount> — traffic challan 🧾`,
  `${p}faketv <headline> — breaking strip 📺`,
  `${p}fakeorder <naam> — pizza order 🍕`,
  `${p}fakeparcel <naam> | <amount> — COD parcel 📦`,
  `${p}fakeholiday — chhutti ka elaan 🎉`,
  `${p}fakenotif <app> | <t> | <text> — fake notification 🔔`,
  `_Sab 100% mazak hain 😄_`,
])}

${box('🤖 AI', [
  `${p}ai <sawal>`,
  `${p}explain <topic> 🎓`,
  `${p}code <kaam> 💻`,
  `${p}dream <khwab> 😴`,
  `${p}future <sawal> 🔮`,
  `${p}poem <topic> 🌹`,
  `${p}script <topic> 🎬`,
  `${p}idea <topic> 💡`,
  `${p}reply <msg> 💬`,
  `${p}gift <banda> 🎁`,
  `${p}trip <sheher> ✈`,
  `${p}horoscope <star> ♈`,
  `${p}loveletter <naam> 💘`,
  `${p}comeback <baat> 😎`,
  `${p}rewrite <text> 🔄`,
  `${p}grammar <text> ✍`,
  `${p}congrats <khushi> 🎉`,
  `${p}sorry <ghalti> 😅`,
  `${p}breakup <naam> 💔`,
  `${p}interview <job> 💼`,
  `${p}dialogue <topic> 🎬`,
  `${p}chatbot on/off — AI auto-reply 🤖`,
  `${p}tts <text> — voice note banao 🎙️`,
])}

${box('👥 GROUP', [
  `${p}tagall`, `${p}hidetag`, `${p}kick`, `${p}add`,
  `${p}promote`, `${p}demote`, `${p}gclose`, `${p}gopen`,
  `${p}glink`, `${p}del (reply)`,
  `${p}mute / ${p}unmute — group mute 🔇`,
  `${p}welcome on/off — join message 🎉`,
  `${p}goodbye on/off — leave message 👋`,
  `${p}setwelcome / ${p}setgoodbye <text>`,
  `${p}antibot on/off — fake bots kick 🛡️`,
  `${p}antitag on/off — mass-tag block 🚫`,
  `${p}antifake on/off — ghair-PK numbers kick 🛡️`,
  `${p}acceptall / ${p}rejectall — join requests ✅❌`,
  `${p}gactive — top 10 active members 🏆`,
])}

${box('⚡ LOGO', [`${p}neon <text>`, `${p}glow <text>`])}

${box('👑 OWNER', [
  `${p}vv auto — sticker/word reply → inbox`,
  `${p}activity — kaun kya chala raha hai`,
  `${p}users — bot users ki list`,
  `${p}restart — bot restart 🔄`,
  `${p}stopall — sab auto-modes band 🛑`,
  `${p}setlang — bot ki language 🌍`,
  `${p}broadcast <msg> — sab users ko paigham 📢`,
  `${p}join <link> — group join karo 🔗`,
  `${p}setmenuimage — menu banner badlo 🖼️ (photo reply)`,
  `${p}mode <public|self> · ${p}self · ${p}public`,
  `${p}autoreact on/off — har msg par auto react 💗`,
  `${p}block / ${p}unblock — number block/unblock 🚫 (reply/number)`,
  `${p}sudo <number> / ${p}delsudo / ${p}listsudo — sudo system 👑`,
  `${p}gcstatusall <msg> — tamam groups mein broadcast 📢`,
  `${p}alwaysonline on/off — hamesha online 🟢`,
  `${p}statuslike on/off — status auto ❤️`,
  `${p}ghost on/off — chupke status dekho, pata na chale 👻`,
  `${p}ghostchat on/off — DM copy inbox mein, blue tick na jaye 👻`,
  `${p}track <number> — online aaye to khabar 🟢`,
  `${p}autobio <on|off> — har minute time bio 🕐`,
  `${p}mentionme on/off — mention par AI jawab 💬`,
  `${p}vv3 — view-once isi chat mein 👁️`,
  `${p}blocklist — blocked numbers`,
  `${p}getbio — kisi ki bio (reply/number)`,
  `${p}getprivacy — privacy settings 🔐`,
  `${p}wr <ticket> <msg> — WebChat reply 💬`,
  `${p}wrblock <ticket> — WebChat ticket block 🚫`,
  `${p}wronline / ${p}wroffline — WebChat online/offline 🟢⚫`,
])}

${box('⚙️ SETTINGS', [
  `${p}settings — saari settings dekho`,
  `${p}prefix / ${p}botname / ${p}ownername / ${p}ownernumber`,
  `${p}description — bot ki description`,
  `${p}stickername — sticker pack naam 🏷`,
  `${p}delpath — download folder 📁`,
  `${p}reactemojis / ${p}owneremojis`,
  `${p}autoread / ${p}antilink / ${p}antistatus`,
  `${p}recording / ${p}autotyping / ${p}mentionreply`,
  `${p}mentionme / ${p}statuslike / ${p}alwaysonline`,
  `${p}voicecmd on/off — voice note se command 🎙 (default OFF)`,
  `${p}statusview — status auto-view 👀`,
  `${p}anticall / ${p}anticallmsg — call reject 📵`,
  `${p}adminaction — admin notices 🛡️`,
  `${p}setppall / ${p}setonline / ${p}setname / ${p}updatebio`,
  `${p}botdp — bot ki DP 🖼`,
  `${p}groupsprivacy <everyone|contacts|nobody>`,
])}

${box('🤖 APNA BOT BANWANA HAI?', [
  `Aisa hi NEXORA-MD jaisa bot chahiye? 💗`,
  `Owner se rabta karein: ${p}contact <apna paigham>`,
  `Aapka paigham seedha owner tak pahunchega — jawab aapke inbox mein milega ✨`,
])}

╭─━━━━〔 💗 ${F('NEXORA')} 💗 〕━━━━─╮
┃ 💗 Main Nexa hoon — bolo kya karoon?
┃ 🎬 ${F('Demo video')}: ${p}d<command>
┃     _misal: ${p}dvv, ${p}dmenu, ${p}dsticker_
┃ ⚡ ${F('POWERED BY NEXORA')}
╰─━━━━━━━━━━━━━━━━━━━━━━━━━━─╯`;
}

async function sendFullMenu(sock, jid, quoted, caption) {
  // Boss (2026-09-24) FINAL: beauty banner pic + neeche full menu text (2 messages).
  const BANNER = path.join(__dirname, '..', 'assets', 'nexora-banner.jpg');
  try {
    if (fs.existsSync(BANNER)) {
      await sock.sendMessage(jid, {
        image: fs.readFileSync(BANNER),
        caption: caption || `💗 *${config.botName}* — Main Nexa hoon ✨\n🟢 Online · Prefix *${config.prefix}*\n\nBolo, kya karoon? 👇`,
      }, quoted ? { quoted } : {});
    }
  } catch {}
  await sock.sendMessage(jid, { text: buildMenu() }, quoted ? { quoted } : {});
}

// ── yt-dlp download queue: ek waqt mein sirf ek download ──
// (concurrent downloads se YouTube datacenter IP ko zyada flag karta hai — 2026-09-22)
let _ytdlpQueue = Promise.resolve();
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));
function serializedYtdlp(fn) {
  const run = _ytdlpQueue.then(fn, fn);
  _ytdlpQueue = run.catch(() => {});
  return run;
}

// ── race helper: promises mein se pehla NON-NULL result — 2026-09-26 speed optimization ──
function raceNonNull(promises) {
  return new Promise((resolve) => {
    let done = 0;
    const n = promises.length;
    promises.forEach((p) => {
      Promise.resolve(p).then(
        (v) => { if (v) resolve(v); else if (++done === n) resolve(null); },
        () => { if (++done === n) resolve(null); }
      );
    });
  });
}

// ── YouTube fast download: 2 parallel yt-dlp attempts race karte hain (pehla kamyab jeetta hai)
// mode 'audio' | 'video'. {path, meta, tmp} deta hai ya null. Queue ke ek slot mein chalta hai.
// (2026-09-26: pehle 3 attempts sequence mein chalte the har 10s sleep ke saath — ab parallel)
async function raceYtDownload({ mode, target, dlBase, bin }) {
  const uid = () => Date.now() + '_' + crypto.randomInt(999999);
  const base = (sfx) => path.join(dlBase, (mode === 'audio' ? 'song_' : 'vid_') + uid() + sfx);
  const runExec = (a, timeoutMs) => new Promise((res, rej) => {
    execFile(bin, a, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { err.ytStderr = String(stderr || '').slice(-600); return rej(err); }
      res(String(stdout || '').trim());
    });
  });
  const minSize = mode === 'audio' ? 20 * 1024 : 100 * 1024;
  const findDl = (t) => {
    const main = t + (mode === 'audio' ? '.m4a' : '.mp4');
    try { if (fs.existsSync(main) && fs.statSync(main).size >= minSize) return main; } catch (e) {}
    const b = path.basename(t);
    try {
      for (const f of fs.readdirSync(dlBase)) {
        if (!f.startsWith(b) || f.endsWith('.part') || f.endsWith('.ytdl')) continue;
        const p = path.join(dlBase, f);
        try { if (fs.statSync(p).size >= minSize) return p; } catch (e) {}
      }
    } catch (e) {}
    return null;
  };
  const clean = (t) => { const b = path.basename(t); try { fs.readdirSync(dlBase).forEach((f) => { if (f.startsWith(b)) try { fs.unlinkSync(path.join(dlBase, f)); } catch (e) {} }); } catch (e) {} };
  const common = ['--impersonate', 'chrome', '--extractor-args', 'youtube:player_client=mediaconnect',
    '--print', 'after_move:%(id)s | %(title)s | %(duration_string)s | %(uploader)s | %(view_count)s',
    '--no-playlist', '--socket-timeout', '30', '--no-warnings',
    '--retries', '5', '--retry-sleep', '3', '--concurrent-fragments', '8'];
  const audioArgs = (t) => [...common, '-x', '--audio-format', 'm4a', '--audio-quality', '128k', '-o', t + '.%(ext)s', target];
  const dashArgs = (t) => [...common,
    '-f', 'bv*[protocol=https][height<=360][vcodec^=avc1]+ba[protocol=https][ext=m4a]/bv*[protocol=https][height<=360]+ba[protocol=https][ext=m4a]/bv*[protocol=https][height<=360]+ba[protocol=https]/b[protocol=https][height<=360]',
    '--max-filesize', '40M', '--merge-output-format', 'mp4', '-o', t + '.%(ext)s', target];
  const progArgs = (t) => [...common,
    '-f', 'b[protocol=https][ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=360]/b[protocol=https][ext=mp4][height<=360]',
    '--max-filesize', '40M', '-o', t + '.%(ext)s', target];
  let lastErr = '';
  const attempt = (builder, ipv4) => new Promise(async (resolve) => {
    const t = base(ipv4 ? '_a' : '_b');
    try {
      const out = await runExec([...(ipv4 ? ['--force-ipv4'] : []), ...builder(t)], 120000);
      const found = findDl(t);
      if (found) return resolve({ path: found, meta: parseYtMeta(out), tmp: t });
    } catch (e) { lastErr = (e && e.ytStderr) || (e && e.message) || String(e); }
    clean(t);
    resolve(null);
  });
  // Round 1: 2 parallel attempts (video ke liye alag-alag format strategies, audio ke liye dono audio)
  const builders = mode === 'video' ? [dashArgs, progArgs] : [audioArgs, audioArgs];
  let results = await Promise.all([attempt(builders[0], true), attempt(builders[1], false)]);
  let win = results.find((r) => r);
  if (!win) {
    // Round 2: ek aakhri sequential koshish (thodi der ruk kar)
    await _sleep(4000);
    const r2 = await attempt(mode === 'video' ? dashArgs : audioArgs, false);
    win = r2;
  }
  // haare hue attempts ki files saaf karo
  results.forEach((r) => { if (r && r !== win) clean(r.tmp); });
  if (!win) console.error('[raceYtDownload] all fail:', mode, String(target).slice(0, 80), '-', String(lastErr).slice(-200));
  return win;
}

// ── yt-dlp --print metadata parser (song/video proper details ke liye — 2026-09-23) ──
// format: %(id)s | %(title)s | %(duration_string)s | %(uploader)s | %(view_count)s
function parseYtMeta(stdout) {
  const lines = String(stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parts = lines[i].split(' | ');
    // title mein ' | ' ho sakta hai — aakhir se anchor karo: views, uploader, duration
    if (parts.length >= 5 && /^[A-Za-z0-9_-]{11}$/.test(parts[0])) {
      const views = parts.pop(), up = parts.pop(), dur = parts.pop();
      return { id: parts[0], title: parts.slice(1).join(' | '), dur, up, views };
    }
  }
  return null;
}
function compactViews(v) {
  const n = parseInt(String(v || '').replace(/\D/g, ''), 10);
  if (!n) return '';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}
function ytDetailsCaption(emoji, meta, fallbackName) {
  // Boss ki pasand (2026-09-23): khoobsurat minimal details — sirf title + duration,
  // channel name aur views NAHI. Audio aur video dono par.
  const title = (meta && meta.title ? meta.title.replace(/\s+/g, ' ').slice(0, 90) : fallbackName);
  const dur = (meta && meta.dur && meta.dur !== 'NA') ? meta.dur : '';
  return `${emoji} *${title}*` + (dur ? `\n\n⏱ ${dur}` : '') + `\n\n💗 NEXORA-MD`;
}

const commands = {
  menu: {
    desc: 'Saare commands dekho',
    run: async (sock, msg, args, { jid }) => {
      await sendFullMenu(sock, jid, msg);
    },
  },


  ping: {
    desc: 'Bot ki speed check karo',
    run: async (sock, msg, args, { jid }) => {
      // 2026-09-26 speed: ek hi round-trip naapa jata hai (pehle do message ka double time dikhta tha).
      // Text reply — "naap rahi hoon" wala message hi result mein badal jata hai (edit).
      // NOTE (2026-09-27): rich HTML card try kiya tha — phone par "can't verify security"
      // warning ban kar aata hai, render nahi hota. Is liye wapas text card.
      const t0 = Date.now();
      let probe = null;
      try { probe = await sock.sendMessage(jid, { text: '🏓 *PONG* — speed naap rahi hoon... ⏳' }, { quoted: msg }); }
      catch { return; }
      const ms = Date.now() - t0;
      // 2026-09-26: premium TEXT-ART card (competitor-style) — pic nahi, styled text.
      const fill = Math.max(1, Math.min(12, Math.round(12 * (1 - Math.min(ms, 2000) / 2000))));
      const bar = '▬'.repeat(fill) + '●' + '▬'.repeat(12 - fill);
      const done =
        `╭━━━〔 🏓 PONG 〕━━━╮\n` +
        `┃\n` +
        `┃ 🚀 SPEED ➤ ${ms} MS\n` +
        `┃\n` +
        `┃ ${bar}\n` +
        `┃\n` +
        `╰━━━━━━━━━━━━╯\n` +
        `⚡ Powered By NEXORA-MD ⚡`;
      try {
        if (probe && probe.key) await sock.sendMessage(jid, { text: done, edit: probe.key });
        else await reply(sock, jid, msg, done);
      } catch {
        try { await reply(sock, jid, msg, done); } catch {}
        try { if (probe && probe.key) await sock.sendMessage(jid, { delete: probe.key }); } catch {}
      }
    },
  },

  alive: {
    desc: 'Bot zinda hai?',
    run: async (sock, msg, args, { jid }) => {
      const s = Math.floor(process.uptime());
      const up = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
      const bdesc = getSetting('description');
      await reply(sock, jid, msg, `💗 *${config.botName} is alive!*\n\nMain Nexa hoon ✨ — bolo kya karoon?${bdesc ? `\n📝 ${bdesc}` : ''}\n\n🕐 Uptime: ${up}\n📡 Mode: ${MODE}\n⌨️ Prefix: ${config.prefix}`);
    },
  },

  botstats: {
    desc: 'System health: uptime, RAM, commands',
    run: async (sock, msg, args, { jid }) => {
      const s = Math.floor(process.uptime());
      const up = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
      const mem = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
      await reply(sock, jid, msg,
        `🤖 *${config.botName} — System Health*\n\n` +
        `⏱ Uptime: ${up}\n` +
        `🧠 RAM: ${mem} MB\n` +
        `📦 Commands: ${Object.keys(commands).length}\n` +
        `📡 Mode: ${MODE}\n` +
        `🛡 Anti-ban rate-limit: ON\n` +
        `🔁 Auto-restart: ON\n` +
        `💾 Session backup: ON\n\n` +
        `_⚡ POWERED BY NEXORA_`);
    },
  },

  owner: {
    desc: 'Owner se rabta (identity private) / owner add karo (main owner)',
    run: async (sock, msg, args, { jid, sender }) => {
      const digits = String(args[0] || '').replace(/\D/g, '');
      // .owner <number> — sirf MAIN owner kisi ko owner bana sakta hai
      if (digits) {
        if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner kisi ko owner bana sakta hai.');
        if (digits.length < 10 || digits.length > 15) return reply(sock, jid, msg, '❌ Sahi number likhein (country code ke saath). Masalan: `.owner 923001234567`');
        const short = digits.slice(-10);
        const mainShort = String(config.owner || '').replace(/\D/g, '').slice(-10);
        if (short === mainShort) return reply(sock, jid, msg, '✅ Ye number pehle se main owner hai.');
        const list = loadExtraOwners();
        if (list.includes(short)) return reply(sock, jid, msg, `✅ *${digits}* pehle se owner hai.`);
        list.push(short); saveExtraOwners(list);
        return reply(sock, jid, msg, `👑 *${digits}* ko owner bana diya gaya!\n\nAb ye number bhi owner commands chala sakta hai.\n\n🤫 _Hatane ke liye: *${config.prefix}unowner* ${digits}_`);
      }
      // .owner (bina number) — purana contact-info behavior
      await reply(sock, jid, msg,
        `👑 *${config.botName} Owner*\n\n🔒 Owner ki identity private hai — number show nahi hota.\n\n📩 Rabta karne ke liye likhein:\n*${config.prefix}contact* <aapka paigham>\n\nAapka paigham seedha owner tak pahunchega 💗\n\n🤖 _Aap bhi aisa bot chahte hain? *${config.prefix}contact* likh kar message bhejein — jawab aapke inbox mein milega ✨_`);
    },
  },

  unowner: {
    desc: 'Secret: kisi ko owner se hatao (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      const digits = String(args[0] || '').replace(/\D/g, '');
      if (!digits) return reply(sock, jid, msg, `👑 *Unowner*\n\nLikhein: *${config.prefix}unowner* <number>\nMasalan: *${config.prefix}unowner* 923001234567`);
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner kisi ko hata sakta hai.');
      const short = digits.slice(-10);
      const mainShort = String(config.owner || '').replace(/\D/g, '').slice(-10);
      if (short === mainShort) return reply(sock, jid, msg, '❌ Main owner ko nahi hata sakte!');
      const list = loadExtraOwners();
      if (!list.includes(short)) return reply(sock, jid, msg, `❌ *${digits}* owner list mein nahi hai.`);
      saveExtraOwners(list.filter(x => x !== short));
      await reply(sock, jid, msg, `✅ *${digits}* ko owner se hata diya gaya.\n\nAb ye number owner commands nahi chala sakta.`);
    },
  },

  unmute: {
    desc: 'Secret: spam-mute se chhutkara do (sirf owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      const digits = String(args[0] || '').replace(/\D/g, '');
      if (digits.length < 7) return reply(sock, jid, msg, `🔇 *Unmute*\n\nLikhein: *${config.prefix}unmute* <number>\nMasalan: *${config.prefix}unmute* 923001234567`);
      const n = unmuteSender(digits);
      await reply(sock, jid, msg, n ? `✅ *${digits}* unmute ho gaya — ab commands chala sakta hai.` : `❌ *${digits}* mute list mein nahi mila.`);
    },
  },

  mainowner: {
    desc: 'Secret: MAIN owner badlo (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner ye badal sakta hai.');
      const digits = String(args[0] || '').replace(/\D/g, '');
      if (digits.length < 7) return reply(sock, jid, msg, `👑 *Main Owner*\n\nLikhein: *${config.prefix}mainowner* <number>\nMasalan: *${config.prefix}mainowner* 923001234567\n\n⚠️ Purana main owner extra owner ban jayega (uski access rahegi).\n🔄 Bot ~10 second mein restart hoga.`);
      const mainShort = String(config.owner || '').replace(/\D/g, '').slice(-10);
      if (digits.slice(-10) === mainShort) return reply(sock, jid, msg, '❌ Ye number pehle se main owner hai.');
      // Manager par seedha endpoint hit karo; worker se manager ko forward karo.
      const isWorker = !!process.env.WORKER;
      const url = isWorker ? ('http://127.0.0.1:' + MANAGER_PORT + '/api/owner/mainowner') : null;
      const doSwitch = async () => {
        if (!isWorker) {
          // Manager: seedha internal function jaisa flow — endpoint ko localhost par hit karo
          const r = await fetch('http://127.0.0.1:' + (config.port || 3000) + '/api/owner/mainowner', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: JSON.stringify({ digits }),
            signal: AbortSignal.timeout(15000),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || 'switch fail');
          return j;
        }
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
          body: JSON.stringify({ digits }),
          signal: AbortSignal.timeout(15000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'switch fail');
        return j;
      };
      try {
        const j = await doSwitch();
        await reply(sock, jid, msg, `👑 *Main owner badal diya!*\n\nNaya: *${j.newMain}*\nPurana: *${j.oldMain}* (extra owner rahega)\n\n🔄 Bot restart ho raha hai — ~10 second mein sab normal.`);
      } catch (e) {
        await reply(sock, jid, msg, '❌ Switch nahi ho saka: ' + String(e && e.message || e));
      }
    },
  },

  // ─── 👑 .oc — Boss ka secret: saari owner/secret commands ki list ───
  // Sirf MAIN owner. Koi aur likhe to bilkul khamosh (koi jawab nahi) —
  // taake kisi ko pata na chale ye command hai bhi. Menu mein nahi dikhta.
  oc: {
    desc: 'Secret: owner commands ki list (sirf main owner)',
    owner: true, hidden: true, silentDeny: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return; // bilkul khamosh
      const px = config.prefix;
      const list = Object.entries(commands)
        .filter(([k, v]) => (v.owner || v.hidden) && k !== 'oc')
        .map(([k, v]) => `▪️ *${px}${k}* — ${v.desc || ''}`.trim())
        .join('\n');
      await reply(sock, jid, msg,
        `👑 *Owner Secret Commands* 🤫\n\n${list}\n\n🤫 _Ye list sirf aap dekh sakte hain Boss 💗_`);
    },
  },

  // ─── 🎫 Demo link commands (Boss ka trial system) ───
  demolink: {
    desc: 'Secret: demo link banao, number-locked (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner demo link bana sakta hai.');
      const mins = parseDemoTime(args[0]);
      const digits = String(args[1] || '').replace(/\D/g, '');
      if (!mins || mins < 5 || mins > 43200 || digits.length < 10 || digits.length > 15) return reply(sock, jid, msg,
        `🎫 *Demo Link*\n\nLikhein: *${config.prefix}demolink* <time> <number>\nMisal: *${config.prefix}demolink* 30m 923001234567\n\n⏱ Time: 5m se 30d tak\n📱 Number: customer ka WhatsApp number (locked)\n\n📌 Number pair hote hi timer auto-start!`);
      const links = loadDemoLinks();
      let token = makeDemoToken();
      while (links[token]) token = makeDemoToken();
      // Naya proper method: number pehle se locked. Bot sweep mein detect karega
      // jab ye number connect ho → timer auto-start. Page ko server se baat nahi karni.
      links[token] = { type: 'demo', durationMin: mins, lockedNumber: digits, createdAt: Date.now(), status: 'active', pairedAt: null, expiresAt: null };
      saveDemoLinks(links);
      const link = `https://boxxaxmd-pair.surge.sh/?demo=${token}`;
      await reply(sock, jid, msg,
        `🎫 *Demo Link tayyar!*\n\n📱 Number: *${digits}* (locked)\n⏱ Time: *${fmtDemoTime(mins)}* (pair hote hi auto-start)\n🔗 Link:\n${link}\n\n📌 Customer ko link bhejein — wo apna number pair kare.\n⏰ Time khatam → auto-disconnect + link dead + dono ko message.\n\n🤫 _Ek link = ek customer (number locked)_`);
    },
  },

  permlink: {
    desc: 'Secret: permanent link banao, number-locked (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner permanent link bana sakta hai.');
      const digits = String(args[0] || '').replace(/\D/g, '');
      if (digits.length < 10 || digits.length > 15) return reply(sock, jid, msg,
        `🔗 *Permanent Link*\n\nLikhein: *${config.prefix}permlink* <number>\nMisal: *${config.prefix}permlink* 923001234567\n\n_Ye link SIRF us number par kaam karega._`);
      const links = loadDemoLinks();
      let token = makeDemoToken();
      while (links[token]) token = makeDemoToken();
      links[token] = { type: 'perm', lockedNumber: digits, createdAt: Date.now(), status: 'active', pairedAt: null };
      saveDemoLinks(links);
      const link = `https://boxxaxmd-pair.surge.sh/?perm=${token}`;
      await reply(sock, jid, msg,
        `🔗 *Permanent Link tayyar!*\n\n📱 Number: *${digits}* (locked)\n🔗 Link:\n${link}\n\n✅ Sirf ye number pair ho sakta hai.\n❌ Koi aur number dale to message aayega: "Ye link sirf ${digits} ke liye hai".`);
    },
  },

  demolist: {
    desc: 'Secret: active demos dekho (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner.');
      const links = loadDemoLinks();
      const keys = Object.keys(links);
      if (!keys.length) return reply(sock, jid, msg, '🎫 Koi demo/perm link nahi bana abhi.');
      const lines = keys.map(t => {
        const l = links[t];
        if (l.type === 'perm') return `🔗 \`${t}\` — perm → *${l.lockedNumber}* (${l.status}${l.pairedAt ? ', paired' : ''})`;
        const left = l.expiresAt ? Math.max(0, Math.round((l.expiresAt - Date.now()) / 60000)) : null;
        const num = l.lockedNumber || l.pairedNumber;
        return `🎫 \`${t}\` — ${fmtDemoTime(l.durationMin)} → ${num ? `*${num}* (${l.expiresAt ? left + 'm baqi' : 'timer start nahi hua'})` : '_number nahi_'} [${l.status}]`;
      });
      await reply(sock, jid, msg, `🎫 *Demo Links* (${keys.length})\n\n${lines.join('\n')}`);
    },
  },

  demostop: {
    desc: 'Secret: demo foran khatam karo (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner.');
      const digits = String(args[0] || '').replace(/\D/g, '');
      if (!digits) return reply(sock, jid, msg, `Likhein: *${config.prefix}demostop* <number>`);
      const links = loadDemoLinks();
      const tok = Object.keys(links).find(t => {
        const n = links[t].lockedNumber || links[t].pairedNumber;
        return n === digits || n === digits.slice(-10);
      });
      if (!tok) return reply(sock, jid, msg, `❌ *${digits}* ka koi active demo nahi mila.`);
      links[tok].status = 'stopped';
      saveDemoLinks(links);
      await reply(sock, jid, msg, `🛑 *${digits}* ka demo rok diya gaya.\n\nDisconnect ho raha hai...`);
      try {
        const mod = require('child_process');
        // manager ko disconnect ke liye kehte hain (worker sweep khud sambhal lega)
      } catch {}
    },
  },

  demoextend: {
    desc: 'Secret: demo ka time barhao (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner.');
      const digits = String(args[0] || '').replace(/\D/g, '');
      const mins = parseDemoTime(args[1]);
      if (!digits || !mins) return reply(sock, jid, msg, `Likhein: *${config.prefix}demoextend* <number> <time>\nMisal: *${config.prefix}demoextend* 923001234567 2h`);
      const links = loadDemoLinks();
      const tok = Object.keys(links).find(t => {
        const n = links[t].lockedNumber || links[t].pairedNumber;
        return n === digits || n === digits.slice(-10);
      });
      if (!tok || links[tok].status !== 'active') return reply(sock, jid, msg, `❌ *${digits}* ka koi active demo nahi mila.`);
      links[tok].expiresAt = (links[tok].expiresAt || Date.now()) + mins * 60000;
      links[tok].durationMin = (links[tok].durationMin || 0) + mins;
      saveDemoLinks(links);
      await reply(sock, jid, msg, `⏰ *${digits}* ka demo *${fmtDemoTime(mins)}* barha diya!\n\nNaya total: *${fmtDemoTime(links[tok].durationMin)}*`);
    },
  },

  // ─── 🔐 Password pairing system (naya — token links ki jagah) ───
  // Demo: ek global password har 5 min rotate (pair-auth.js se derive).
  // .demopass <number> <time> → customer authorize (max 5 active).
  // Perm: ek fixed password (.permpass se set) + number allow-list.
  demopass: {
    desc: 'Secret: demo ke liye number authorize karo (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner demo authorize kar sakta hai.');
      const digits = pairAuth.cleanNum(args[0]);
      const mins = parseDemoTime(args[1]);
      if (!pairAuth.validNum(digits) || !mins || mins < 5 || mins > 43200) return reply(sock, jid, msg,
        `🎫 *Demo Authorize*\n\nLikhein: *${config.prefix}demopass* <number> <time>\nMisal: *${config.prefix}demopass* 923001234567 30m\n\n⏱ Time: 5m se 30d tak (pair hote hi timer auto-start)\n👥 Max *5* active demos — chhata tab jab koi khatam/stop ho.\n\n📌 Customer ko bhejein:\n🔗 https://boxxaxmd-pair.surge.sh → *Demo* tab\n🔑 Password: *${config.prefix}livepass* se dekhein`);
      const auth = pairAuth.loadAuth();
      const existing = auth.demo[digits];
      if ((!existing || existing.status !== 'active') && pairAuth.activeDemoCount(auth) >= 5)
        return reply(sock, jid, msg, `❌ *5 active demos* pehle se hain — naya authorize karne ke liye pehle kisi ka demo khatam hone dein ya *${config.prefix}demostop* <number> se rokein.\n\nMaujooda list: *${config.prefix}livepass*`);
      auth.demo[digits] = { durationMin: mins, status: 'active', authorizedAt: Date.now(), pairedAt: null, expiresAt: null };
      pairAuth.saveAuth(auth);
      // Dobara authorize → registry se block hatao (taake pair ho sake)
      try {
        const regPath = path.join(__dirname, '..', 'sessions', 'registry.json');
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        if (reg[digits] && reg[digits].disabled) { delete reg[digits].disabled; fs.writeFileSync(regPath, JSON.stringify(reg, null, 2)); }
      } catch {}
      await reply(sock, jid, msg,
        `🎫 *Demo authorized!*\n\n📱 Number: *${digits}*\n⏱ Time: *${fmtDemoTime(mins)}* (pair hote hi timer start)\n\n📌 Customer ko bhejein:\n🔗 https://boxxaxmd-pair.surge.sh → *Demo* tab\n🔑 Password (*${config.prefix}livepass* se): *${pairAuth.currentDemoPassword()}*\n\n⚠️ Password har 5 minute badalta hai — customer ko foran bhejein.`);
    },
  },

  livepass: {
    desc: 'Secret: maujooda demo password + active demos (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner.');
      const auth = pairAuth.loadAuth();
      const keys = Object.keys(auth.demo).filter(d => auth.demo[d].status === 'active');
      const lines = keys.map(d => {
        const e = auth.demo[d];
        const left = e.expiresAt ? Math.max(0, Math.round((e.expiresAt - Date.now()) / 60000)) : null;
        return `📱 *${d}* — ${fmtDemoTime(e.durationMin)} (${e.expiresAt ? left + 'm baqi' : '⏳ pairing ka intezar'})`;
      });
      await reply(sock, jid, msg,
        `🔑 *Demo Password (abhi ka):* \`${pairAuth.currentDemoPassword()}\`\n⏱ Har 5 minute mein badalta hai\n\n🎫 *Active demos* (${keys.length}/5):\n${lines.length ? lines.join('\n') : '_koi nahi_'}\n\n🔗 Page: https://boxxaxmd-pair.surge.sh → *Demo* tab`);
    },
  },

  demostop: {
    desc: 'Secret: demo foran khatam karo — naye + purane dono system (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner.');
      const digits = pairAuth.cleanNum(args[0]);
      if (!digits) return reply(sock, jid, msg, `Likhein: *${config.prefix}demostop* <number>`);
      const ownerDigits = String(config.owner || '').replace(/\D/g, '');
      if (ownerDigits && (digits === ownerDigits || digits.endsWith(ownerDigits.slice(-10))))
        return reply(sock, jid, msg, '❌ Ye main owner ka number hai — isay stop nahi kar sakte.');
      // ── 1) Naya system: pair-auth.json ──
      const auth = pairAuth.loadAuth();
      const de = auth.demo[digits];
      let stoppedNew = false;
      if (de && de.status === 'active') {
        // Pehle respawn roko (persistent), phir exact worker khatam karo
        try {
          const regPath = path.join(__dirname, '..', 'sessions', 'registry.json');
          const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
          const entry = reg[digits];
          if (entry) {
            entry.disabled = true;
            fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
            if (entry.pid) { try { process.kill(entry.pid, 'SIGTERM'); } catch {} }
          }
        } catch {}
        de.status = 'stopped';
        pairAuth.saveAuth(auth);
        stoppedNew = true;
      }
      // ── 2) Legacy: demo-links.json (purane token links) ──
      let stoppedLegacy = false;
      try {
        const links = loadDemoLinks();
        const tok = Object.keys(links).find(t => {
          const n = links[t].lockedNumber || links[t].pairedNumber;
          return n === digits || String(n || '').endsWith(digits.slice(-10));
        });
        if (tok && links[tok].status === 'active') {
          links[tok].status = 'stopped';
          saveDemoLinks(links);
          stoppedLegacy = true;
          try {
            const regPath = path.join(__dirname, '..', 'sessions', 'registry.json');
            const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
            const entry = reg[digits];
            if (entry) { entry.disabled = true; fs.writeFileSync(regPath, JSON.stringify(reg, null, 2)); if (entry.pid) { try { process.kill(entry.pid, 'SIGTERM'); } catch {} } }
          } catch {}
        }
      } catch {}
      if (!stoppedNew && !stoppedLegacy) return reply(sock, jid, msg, `❌ *${digits}* ka koi active demo nahi mila.`);
      await reply(sock, jid, msg, `🛑 *${digits}* ka demo rok diya gaya ✅\n\nWorker disconnect ho gaya, dobara respawn nahi hoga.`);
    },
  },

  permpass: {
    desc: 'Secret: permanent password set/dekho (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner.');
      const auth = pairAuth.loadAuth();
      const pw = String(args[0] || '').trim();
      if (!pw) {
        if (!auth.permPassword) return reply(sock, jid, msg, `🔑 Permanent password abhi set nahi.\n\nSet karein: *${config.prefix}permpass* <password>\nMisal: *${config.prefix}permpass* Nexa2026`);
        return reply(sock, jid, msg, `🔑 *Permanent password:* \`${auth.permPassword}\`\n\n🔗 Page: https://boxxaxmd-pair.surge.sh → *Permanent* tab`);
      }
      if (pw.length < 4 || pw.length > 32) return reply(sock, jid, msg, '❌ Password 4 se 32 harf ka ho.');
      auth.permPassword = pw;
      pairAuth.saveAuth(auth);
      await reply(sock, jid, msg, `🔑 *Permanent password set!* \`${pw}\`\n\n📌 Customer flow:\n1️⃣ *${config.prefix}permauth* <number> se number authorize karein\n2️⃣ Customer ko password + page link bhejein:\n🔗 https://boxxaxmd-pair.surge.sh → *Permanent* tab`);
    },
  },

  permauth: {
    desc: 'Secret: permanent ke liye number authorize karo (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner.');
      const digits = pairAuth.cleanNum(args[0]);
      if (!pairAuth.validNum(digits)) return reply(sock, jid, msg,
        `🔗 *Permanent Authorize*\n\nLikhein: *${config.prefix}permauth* <number>\nMisal: *${config.prefix}permauth* 923001234567\n\n⚠️ Pehle *${config.prefix}permpass* <password> se password set karein.`);
      const auth = pairAuth.loadAuth();
      if (!auth.permPassword) return reply(sock, jid, msg, `❌ Pehle password set karein: *${config.prefix}permpass* <password>`);
      auth.perm[digits] = { status: 'active', authorizedAt: Date.now() };
      pairAuth.saveAuth(auth);
      try {
        const regPath = path.join(__dirname, '..', 'sessions', 'registry.json');
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        if (reg[digits] && reg[digits].disabled) { delete reg[digits].disabled; fs.writeFileSync(regPath, JSON.stringify(reg, null, 2)); }
      } catch {}
      await reply(sock, jid, msg,
        `💎 *Permanent authorized!*\n\n📱 Number: *${digits}*\n\n📌 Customer ko bhejein:\n🔗 https://boxxaxmd-pair.surge.sh → *Permanent* tab\n🔑 Password: \`${auth.permPassword}\`\n\n✅ Sirf ye number + ye password = pairing.`);
    },
  },

  permdel: {
    desc: 'Secret: permanent authorization hatao (sirf main owner)',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner.');
      const digits = pairAuth.cleanNum(args[0]);
      if (!digits) return reply(sock, jid, msg, `Likhein: *${config.prefix}permdel* <number>`);
      const ownerDigits = String(config.owner || '').replace(/\D/g, '');
      if (ownerDigits && (digits === ownerDigits || digits.endsWith(ownerDigits.slice(-10))))
        return reply(sock, jid, msg, '❌ Ye main owner ka number hai.');
      const auth = pairAuth.loadAuth();
      if (!auth.perm[digits]) return reply(sock, jid, msg, `❌ *${digits}* permanent mein authorized nahi hai.`);
      delete auth.perm[digits];
      pairAuth.saveAuth(auth);
      try {
        const regPath = path.join(__dirname, '..', 'sessions', 'registry.json');
        const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
        const entry = reg[digits];
        if (entry) { entry.disabled = true; fs.writeFileSync(regPath, JSON.stringify(reg, null, 2)); if (entry.pid) { try { process.kill(entry.pid, 'SIGTERM'); } catch {} } }
      } catch {}
      await reply(sock, jid, msg, `🗑️ *${digits}* ki permanent authorization hata di ✅\n\nWorker disconnect ho gaya, dobara pair nahi ho sakta.`);
    },
  },

  contact: {
    desc: 'Owner ko paigham bhejo — owner panel se reply karega, identity private',
    run: async (sock, msg, args, { jid, sender }) => {
      if (!config.owner) return reply(sock, jid, msg, '❌ Contact system abhi set nahi hai.');
      const text = args.join(' ').trim();
      if (!text) return reply(sock, jid, msg, `📩 *Owner se rabta*\n\nLikhein: *${config.prefix}contact* <aapka paigham>\n\n_Misal:_ *${config.prefix}contact* Assalam o Alaikum, mujhe bot chahiye!\n\n💬 _Foran baat karni hai? Live webchat:_ ${WEBCHAT.webchatUrl()}`);
      if (text.length > 1000) return reply(sock, jid, msg, '❌ Paigham 1000 harf se zyada lamba nahi ho sakta.');
      const isGroup = jid.endsWith('@g.us');
      const isWorker = !!process.env.WORKER;
      // Main number ke DM mein user ka paigham owner ke inbox mein (user wali chat mein)
      // naturally mojood hai — owner wahi se normal reply karega, jawab user ko wahi
      // milega. Bot bilkul khamosh rahega: koi confirmation, koi forward nahi —
      // personal inbox mein koi shor nahi. Group ya worker number se aaye to
      // leads store mein save karo — owner Owner Panel (web) par dekhega.
      if (!isGroup && !isWorker) return;
      // Owner khud .contact kare to kuch nahi — personal chat mein bekaar ka shor nahi.
      if (isOwnerMsg(msg, sender, jid)) return;
      // NAYA FLOW (2026-09-22): owner ko WhatsApp par KOI forward nahi jata.
      // Paigham manager ke leads store mein save hota hai — owner sirf web
      // Owner Panel par dekhega aur wahin se reply bhejega.
      const who = String(sender || '').split('@')[0];
      const name = msg.pushName || 'Unknown';
      let myNum = '';
      try { myNum = String(sock && sock.user && sock.user.id || '').split(':')[0].replace(/\D/g, ''); } catch {}
      let saved = false;
      if (isWorker) {
        // Worker → manager ke internal API par lead bhejo
        try {
          const r = await fetch('http://127.0.0.1:' + MANAGER_PORT + '/api/owner/lead', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
            body: JSON.stringify({ userJid: String(sender), name: name, phone: who, worker: myNum, text: text }),
            signal: AbortSignal.timeout(15000),
          });
          saved = !!r.ok;
        } catch { saved = false; }
      } else {
        // Manager khud (group mein) — seedha local leads mein save
        saved = saveLeadIn({ userJid: String(sender), name: name, phone: who, worker: myNum, text: text });
        // 📣 Naya lead → Owner Panel (khula ho to) foran notification
        if (saved) queuePanelPush({ type: 'new_lead', name: String(name || 'Unknown').slice(0, 60), phone: who, worker: myNum, text: String(text || '').slice(0, 140), jid: String(sender) });
      }
      if (saved) await reply(sock, jid, msg, '✅ Paigham owner tak pahunch gaya! Jawab aapke inbox mein aayega 💗');
      else await reply(sock, jid, msg, '❌ Paigham nahi pahunch saka, thori dair baad dobara try karein.');
    },
  },

  // ─── 🤫 SECRET owner commands — menu mein NAHI dikhte ───
  accounts: {
    desc: 'Secret: connected numbers dekho',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid }) => {
      try {
        const r = await fetch(`http://127.0.0.1:${MANAGER_PORT}/api/accounts`, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return reply(sock, jid, msg, '❌ Accounts nahi nikal saka.');
        const d = await r.json();
        const tick = (c) => (c ? '🟢' : '🔴');
        let out = '📱 *Connected accounts*\n';
        out += `\n1. \`${d.main.number || '—'}\` ${tick(d.main.connected)} ${d.main.connected ? 'online' : 'offline'} — *main* (${d.main.mode})`;
        (d.workers || []).forEach((w, i) => {
          out += `\n${i + 2}. \`${w.number}\` ${tick(w.connected)} ${w.connected ? 'online' : 'offline'} — worker (:${w.port}, ${w.mode})`;
        });
        if (!(d.workers || []).length) out += '\n\n_Koi extra number connected nahi._';
        out += '\n\n🤫 _Ye command menu mein nahi hai — sirf tumhare liye._';
        await reply(sock, jid, msg, out);
      } catch { await reply(sock, jid, msg, '❌ Accounts nahi nikal saka.'); }
    },
  },

  disconnect: {
    desc: 'Secret: koi connected number hatao',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid }) => {
      const digits = String(args[0] || '').replace(/\D/g, '');
      if (!digits) return reply(sock, jid, msg, `✂️ *Disconnect*\n\nLikhein: *${config.prefix}disconnect* <number>\n\nPehle *${config.prefix}accounts* se number dekho 🤫`);
      try {
        const r = await fetch(`http://127.0.0.1:${MANAGER_PORT}/api/disconnect`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
          body: JSON.stringify({ number: digits }), signal: AbortSignal.timeout(20000),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return reply(sock, jid, msg, '❌ ' + (d.error || 'Nahi ho saka.'));
        await reply(sock, jid, msg, `✅ *${d.number}* disconnect ho gaya.\n\nWo number ab bot se hata diya gaya hai.`);
      } catch { await reply(sock, jid, msg, '❌ Disconnect nahi ho saka.'); }
    },
  },

  // .unpair = .disconnect ka alias (Boss ka pasandeeda naam)
  unpair: {
    desc: 'Secret: koi connected number hatao (disconnect ka alias)',
    owner: true, hidden: true,
    run: async (sock, msg, args, ctx) => {
      return commands.disconnect.run(sock, msg, args, ctx);
    },
  },

  pair: {
    desc: 'Secret: naye number ke liye pairing code nikalo',
    owner: true, hidden: true,
    run: async (sock, msg, args, { jid }) => {
      const digits = String(args[0] || '').replace(/\D/g, '');
      if (!digits || digits.length < 10 || digits.length > 15) {
        return reply(sock, jid, msg, `🔗 *Pair*\n\nLikhein: *${config.prefix}pair* <number>\nMasalan: *${config.prefix}pair* 923001234567\n\nCode aayega — usay WhatsApp mein lagao:\nLinked devices → Link a device → *Link with phone number instead* 🤫`);
      }
      await reply(sock, jid, msg, `🔗 *${digits}* ke liye pairing code nikal rahi hoon...`);
      try {
        const r = await fetch(`http://127.0.0.1:${MANAGER_PORT}/api/pair`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ number: digits }),
          signal: AbortSignal.timeout(180000),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return reply(sock, jid, msg, '❌ ' + (d.error || 'Code nahi mil saka.'));
        if (d.alreadyConnected) return reply(sock, jid, msg, `✅ *${digits}* pehle se connected hai.`);
        const code = d.code || '';
        if (!code) return reply(sock, jid, msg, '❌ Code nahi mil saka — dobara try karein.');
        await reply(sock, jid, msg,
          `🔗 *Pairing Code*\n\nNumber: \`${digits}\`\nCode: *${code}*\n\nWhatsApp kholein → ⋮ → Linked devices → Link a device → *Link with phone number instead* → ye code likhein.\n\n⏱️ Code ~75 second valid hai.\n\n🤫 _Ye command menu mein nahi hai — sirf tumhare liye._`);
      } catch { await reply(sock, jid, msg, '❌ Code nahi mil saka — thori dair baad dobara try karein.'); }
    },
  },

  autoreact: {
    desc: 'Har message par auto emoji react (on/off)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const v = (args[0] || '').toLowerCase();
      if (v === 'on' || v === 'off') {
        STATE.autoreact = v === 'on';
        saveState();
        await reply(sock, jid, msg, STATE.autoreact
          ? '💗 *Auto-react ON* — ab main har message par pyaara sa react karoongi ✨'
          : '💗 Auto-react *OFF* kar diya.');
      } else {
        await reply(sock, jid, msg,
          `💗 Auto-react abhi *${STATE.autoreact ? 'ON ✨' : 'OFF'}* hai.\n\nUsage: *${config.prefix}autoreact on* ya *${config.prefix}autoreact off*`);
      }
    },
  },

  // ── download ──
  tiktok: {
    desc: 'TikTok video download',
    run: async (sock, msg, args, { jid }) => {
      const url = args[0];
      if (!url || !/tiktok\.com/i.test(url)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}tiktok <tiktok-link>*`);
      await sendDownload(sock, jid, msg, url, 'TikTok', '🎬');
    },
  },

  ig: {
    desc: 'Instagram reel/post download',
    run: async (sock, msg, args, { jid }) => {
      const url = args[0];
      if (!url || !/instagram\.com/i.test(url)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}ig <instagram-link>*`);
      await sendDownload(sock, jid, msg, url, 'Instagram', '📸');
    },
  },

  fb: {
    desc: 'Facebook video download',
    run: async (sock, msg, args, { jid }) => {
      const url = args[0];
      if (!url || !/facebook\.com|fb\.watch/i.test(url)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}fb <facebook-link>*`);
      await sendDownload(sock, jid, msg, url, 'Facebook', '📘');
    },
  },

  // ── sticker ──
  sticker: {
    desc: 'Photo → sticker (photo ke reply mein)',
    run: async (sock, msg, args, { jid }) => {
      const img = ctxOf(msg)?.quotedMessage?.imageMessage || msg.message?.imageMessage;
      if (!img) return reply(sock, jid, msg, `❌ Kisi photo ke reply mein *${config.prefix}sticker* likhein.`);
      await reply(sock, jid, msg, '⏳ Sticker ban raha hai... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: img } }, 'buffer', {});
        const webp = await sharp(buf)
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { sticker: await withStickerExif(webp) }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ Sticker nahi ban saka, dobara try karein.');
      }
    },
  },

  toimg: {
    desc: 'Sticker → photo, aapke inbox mein (sticker ke reply mein)',
    run: async (sock, msg, args, { jid }) => {
      const st = ctxOf(msg)?.quotedMessage?.stickerMessage || msg.message?.stickerMessage;
      if (!st) return reply(sock, jid, msg, `❌ Kisi sticker ke reply mein *${config.prefix}toimg* likhein.`);
      await reply(sock, jid, msg, '⏳ Image bana rahi hoon... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { stickerMessage: st } }, 'buffer', {});
        const png = await sharp(buf, { animated: false }).png().toBuffer();
        const ownerJid = config.owner ? num(config.owner) + '@s.whatsapp.net' : jid;
        await sock.sendMessage(ownerJid, { image: png, caption: `🖼️ *Sticker → Image*\n_— ${config.botName}_` });
        if (ownerJid !== jid) await reply(sock, jid, msg, '✅ Image aapke inbox mein bhej di hai!');
      } catch {
        await reply(sock, jid, msg, '❌ Image nahi ban saki, dobara try karein.');
      }
    },
  },

  attp: {
    desc: 'Text → sticker',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ');
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}attp <text>*`);
      const webp = await attpBuffer(text);
      await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
    },
  },

  meme: {
    desc: 'Mashhoor templates par apna meme banao',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ').trim();
      if (/^list$/i.test(raw)) {
        try {
          const r = await fetch('https://api.memegen.link/templates', { signal: AbortSignal.timeout(15000) });
          const list = await r.json();
          const popular = ['drake', 'distracted', 'doge', 'fry', 'buzz', 'wonka', 'mordor', 'keanu', 'rollsafe', 'gru', 'pigeon', 'changemymind'];
          const have = new Set((list || []).map((t) => t.id));
          const show = popular.filter((p) => have.has(p));
          return reply(sock, jid, msg, `🎭 *Meme templates*\n\n${show.map((t) => `• \`${t}\``).join('\n')}\n\nUsage: *${config.prefix}meme <template> | <upar> | <neeche>*\nMasalan: *${config.prefix}meme drake | purana bot | NEXORA-MD* 💗`);
        } catch { return reply(sock, jid, msg, '❌ Templates nahi mil sake, dobara try karo.'); }
      }
      const parts = raw.split('|').map((s) => s.trim());
      if (parts.length < 3 || !parts[0]) {
        return reply(sock, jid, msg, `🎭 *Meme banao*\n\nUsage: *${config.prefix}meme <template> | <upar wali line> | <neeche wali line>*\nMasalan: *${config.prefix}meme drake | purana bot | NEXORA-MD*\n\nTemplates: *${config.prefix}meme list*`);
      }
      const esc = (s) => (s || ' ').replace(/_/g, '__').replace(/-/g, '--').replace(/ /g, '_')
        .replace(/\?/g, '~q').replace(/%/g, '~p').replace(/#/g, '~h').replace(/\//g, '~s').replace(/"/g, "''");
      const url = `https://api.memegen.link/images/${encodeURIComponent(parts[0].toLowerCase())}/${esc(parts[1])}/${esc(parts[2])}.png`;
      await reply(sock, jid, msg, '🎭 Meme ban raha hai... 💗');
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
        if (!r.ok) throw new Error('bad template');
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 2000) throw new Error('bad image');
        await sock.sendMessage(jid, { image: buf, caption: `🎭 *Tumhara meme*\n_— ${config.botName} 💗_` }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, `❌ Meme nahi ban saka. Template ka naam check karo: *${config.prefix}meme list*`);
      }
    },
  },

  ss: {
    desc: 'Kisi bhi website ka screenshot lo',
    run: async (sock, msg, args, { jid }) => {
      let u = (args[0] || '').trim();
      if (!u) return reply(sock, jid, msg, `📸 Usage: *${config.prefix}ss <link>*\nMasalan: *${config.prefix}ss google.com*`);
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      await reply(sock, jid, msg, '📸 Screenshot le rahi hoon... 💗');
      try {
        const api = `https://api.microlink.io/?url=${encodeURIComponent(u)}&screenshot=true&meta=false`;
        const r = await fetch(api, { signal: AbortSignal.timeout(45000) });
        const j = await r.json();
        const shot = j && j.data && j.data.screenshot && j.data.screenshot.url;
        if (!shot) throw new Error('no screenshot');
        const img = await fetch(shot, { signal: AbortSignal.timeout(45000) });
        const buf = Buffer.from(await img.arrayBuffer());
        if (buf.length < 5000) throw new Error('bad image');
        await sock.sendMessage(jid, { image: buf, caption: `📸 *${u}*\n_— ${config.botName} 💗_` }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ Screenshot nahi le saki. Link check karo aur dobara try karo.');
      }
    },
  },

  emojimix: {
    desc: 'Do emoji milao → naya sticker',
    run: async (sock, msg, args, { jid }) => {
      const input = args.join('').replace(/\s+/g, '');
      let graphemes = [];
      try {
        const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
        graphemes = [...seg.segment(input)].map((s) => s.segment).filter((g) => /\p{Extended_Pictographic}/u.test(g));
      } catch {
        graphemes = [...input.matchAll(/\p{Extended_Pictographic}/gu)].map((m) => m[0]);
      }
      if (graphemes.length < 2) {
        return reply(sock, jid, msg, `🧪 *Emoji Mix*\n\nUsage: *${config.prefix}emojimix* 🥺🔥\n\nDo emoji aik saath likho — main unhein mila kar naya sticker banaongi! 💗`);
      }
      const cps = (g, keepFe0f) => [...g].map((c) => c.codePointAt(0).toString(16))
        .filter((h) => keepFe0f || h !== 'fe0f').join('-');
      const [g1, g2] = graphemes;
      const variants = [];
      for (const keep of [false, true]) {
        const a = cps(g1, keep), b = cps(g2, keep);
        if (a && b) { variants.push([a, b], [b, a]); }
      }
      await reply(sock, jid, msg, '🧪 Emoji mix ho rahe hain... 💗');
      let buf = null;
      for (const [a, b] of variants) {
        try {
          const url = `https://www.gstatic.com/android/keyboard/emojikitchen/20201001/u${a}/u${a}_u${b}.png`;
          const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!r.ok) continue;
          const t = await r.arrayBuffer();
          if (t.byteLength > 1500) { buf = Buffer.from(t); break; }
        } catch {}
      }
      if (!buf) return reply(sock, jid, msg, '❌ Ye do emoji mix nahi ho sakte. Kuch aur emoji try karo! 🧪');
      try {
        const webp = await sharp(buf).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { sticker: webp }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ Sticker nahi ban saka, dobara try karo.');
      }
    },
  },

  // ── group ──
  tagall: {
    desc: 'Sab members ko tag karo (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const meta = await sock.groupMetadata(jid);
      const mentions = meta.participants.map((p) => p.id);
      await sock.sendMessage(jid, {
        text: `📢 *TAG ALL*\n${args.join(' ')}\n\n` + mentions.map((m) => '@' + num(m)).join(' ') + '\n\n— Nexa 💗',
        mentions,
      }, { quoted: msg });
    },
  },

  hidetag: {
    desc: 'Chhupa tag — sab ko bina naam liye notify (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const meta = await sock.groupMetadata(jid);
      await sock.sendMessage(jid, {
        text: `🔔 ${args.join(' ') || config.botName}\n\n— Nexa 💗`,
        mentions: meta.participants.map((p) => p.id),
      }, { quoted: msg });
    },
  },

  kick: {
    desc: 'Member nikalo (admin — tag ya reply)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const ctx = ctxOf(msg);
      const target = ctx?.mentionedJid?.[0] || ctx?.participant;
      if (!target) return reply(sock, jid, msg, `❌ Kisi ko tag karein ya uske message ke reply mein *${config.prefix}kick* likhein.`);
      if (isOwner(target)) return reply(sock, jid, msg, '❌ Owner ko kick nahi kar sakte!');
      await sock.groupParticipantsUpdate(jid, [target], 'remove');
      await sock.sendMessage(jid, { text: `👢 @${num(target)} kicked.\n\n— Nexa 💗`, mentions: [target] }, { quoted: msg });
    },
  },

  add: {
    desc: 'Number se member add karo (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const n = (args[0] || '').replace(/\D/g, '');
      if (!n) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}add <number with country code>*\nMasalan: ${config.prefix}add 923001234567`);
      await sock.groupParticipantsUpdate(jid, [n + '@s.whatsapp.net'], 'add');
      await reply(sock, jid, msg, `✅ ${n} ko add karne ki request bhej di.`);
    },
  },

  promote: {
    desc: 'Admin banao (admin — tag ya reply)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const ctx = ctxOf(msg);
      const target = ctx?.mentionedJid?.[0] || ctx?.participant;
      if (!target) return reply(sock, jid, msg, '❌ Tag karein ya reply karein.');
      await sock.groupParticipantsUpdate(jid, [target], 'promote');
      await sock.sendMessage(jid, { text: `⬆️ @${num(target)} ab admin hai.\n\n— Nexa 💗`, mentions: [target] }, { quoted: msg });
    },
  },

  demote: {
    desc: 'Admin se hatao (admin — tag ya reply)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const ctx = ctxOf(msg);
      const target = ctx?.mentionedJid?.[0] || ctx?.participant;
      if (!target) return reply(sock, jid, msg, '❌ Tag karein ya reply karein.');
      await sock.groupParticipantsUpdate(jid, [target], 'demote');
      await sock.sendMessage(jid, { text: `⬇️ @${num(target)} ab admin nahi raha.\n\n— Nexa 💗`, mentions: [target] }, { quoted: msg });
    },
  },

  gclose: {
    desc: 'Group band karo — sirf admin likhein (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      await sock.groupSettingUpdate(jid, 'announcement');
      await reply(sock, jid, msg, '🔒 Group closed — ab sirf admin likh sakte hain.');
    },
  },

  gopen: {
    desc: 'Group kholo — sab likh sakein (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      await sock.groupSettingUpdate(jid, 'not_announcement');
      await reply(sock, jid, msg, '🔓 Group open — ab sab likh sakte hain.');
    },
  },

  glink: {
    desc: 'Group ka invite link (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const code = await sock.groupInviteCode(jid);
      await reply(sock, jid, msg, `🔗 *Group Invite Link*\n\nhttps://chat.whatsapp.com/${code}`);
    },
  },

  del: {
    desc: 'Message delete karo (kisi message ke reply mein)',
    run: async (sock, msg, args, { jid, sender }) => {
      const ctx = ctxOf(msg);
      const stanzaId = ctx?.stanzaId;
      const participant = ctx?.participant;
      if (!stanzaId) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${config.prefix}del* likhein.`);
      const isBotMsg = participant && num(participant) === num(sock.user?.id);
      if (!isBotMsg) {
        const err = await requireAdmin(sock, msg, sender);
        if (err) return reply(sock, jid, msg, err);
      }
      const key = { remoteJid: jid, id: stanzaId, fromMe: !!isBotMsg };
      if (!isBotMsg && participant) key.participant = participant;
      await sock.sendMessage(jid, { delete: key });
    },
  },

  // ── fun ──
  joke: {
    desc: 'Ek mazahiya joke',
    run: async (sock, msg, args, { jid }) => {
      await suspense(sock, jid, msg, '😂 Ek dhamakedaar joke yaad kar rahi hoon... 💗');
      await reply(sock, jid, msg, `😂 *Joke*\n\n${JOKES[Math.floor(Math.random() * JOKES.length)]}`);
    },
  },

  quote: {
    desc: 'Aaj ka motivational quote',
    run: async (sock, msg, args, { jid }) => {
      await suspense(sock, jid, msg, '💡 Koi dil ko chhune wali baat dhoondh rahi hoon... 💗');
      await reply(sock, jid, msg, `💡 *Quote*\n\n${QUOTES[Math.floor(Math.random() * QUOTES.length)]}`);
    },
  },

  '8ball': {
    desc: 'Sawal poochein, 8ball jawab dega',
    run: async (sock, msg, args, { jid }) => {
      if (!args.length) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}8ball <aapka sawal>*`);
      await suspense(sock, jid, msg, '🎱 Ball ko hila rahi hoon... jawab aa raha hai... 🔮');
      await reply(sock, jid, msg, `🎱 *8Ball*\n\n❓ ${args.join(' ')}\n🔮 ${EIGHTBALL[Math.floor(Math.random() * EIGHTBALL.length)]}`);
    },
  },

  shayari: {
    desc: 'Ek khoobsurat shayari',
    run: async (sock, msg, args, { jid }) => {
      await suspense(sock, jid, msg, '✨ Lafzon ke moti piro rahi hoon... 💗');
      await reply(sock, jid, msg, `✨ *Shayari*\n\n${SHAYARI[Math.floor(Math.random() * SHAYARI.length)]}`);
    },
  },

  // ── logo ──
  neon: {
    desc: 'Neon glow text image',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ');
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}neon <text>*`);
      const png = await textImage(text, 'neon');
      await sock.sendMessage(jid, { image: png, caption: `💠 *${text}*\n_— ${config.botName}_` }, { quoted: msg });
    },
  },

  glow: {
    desc: 'Pink glow text image',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ');
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}glow <text>*`);
      const png = await textImage(text, 'glow');
      await sock.sendMessage(jid, { image: png, caption: `💗 *${text}*\n_— ${config.botName}_` }, { quoted: msg });
    },
  },

  // ── naye commands (2026-09-23) ──
  score: {
    desc: 'Live cricket score 🏏',
    run: async (sock, msg, args, { jid }) => {
      await reply(sock, jid, msg, '🏏 Score la rahi hoon... 💗');
      try {
        const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/cricket/scorepanel', {
          signal: AbortSignal.timeout(25000),
          headers: { 'User-Agent': 'curl/8.5.0', 'Accept': 'application/json' }, // ESPN browser/undici UA par 403 deta hai
        });
        if (!res.ok) throw new Error('http-' + res.status);
        const d = await res.json();
        const events = [];
        for (const sc of (d.scores || [])) {
          const lg = (sc.leagues && sc.leagues[0] && sc.leagues[0].name) || 'Cricket';
          for (const ev of (sc.events || [])) {
            const comp = ev.competitions && ev.competitions[0];
            if (!comp) continue;
            const st = comp.status || {}, t = st.type || {};
            const summary = st.summary || '';
            events.push({
              lg, state: t.state || '', descr: t.descr || t.description || '', summary,
              teams: (comp.competitors || []).map(c => ({
                name: (c.team && (c.team.displayName || c.team.abbreviation)) || 'Team',
                score: c.score || '',
              })),
            });
          }
        }
        if (!events.length) return reply(sock, jid, msg, '❌ Abhi koi score nahi mil saka, thodi der baad try karein.');
        const hasScore = (e) => e.teams.some(t => t.score);
        const live = events.filter(e => e.state === 'in' && !/^starts at/i.test(e.summary)).sort((a, b) => (hasScore(b) ? 1 : 0) - (hasScore(a) ? 1 : 0));
        const results = events.filter(e => e.state === 'post');
        const upcoming = events.filter(e => e.state === 'pre' || (e.state === 'in' && /^starts at/i.test(e.summary)));
        const fmt = (e) => {
          const head = e.state === 'in' ? (e.descr === 'Live' ? '🔴 *LIVE*' : `⏸ *${e.descr}*`) : e.state === 'post' ? '✅ *Result*' : '🕐 *Upcoming*';
          let s = `\n${head} — ${e.lg}\n`;
          e.teams.forEach(t => { s += `🏏 *${t.name}*${t.score ? ` — _${t.score}_` : ''}\n`; });
          if (e.summary) s += `📌 ${e.summary}\n`;
          return s;
        };
        let out = `🏏 *Cricket Score*\n_— ${config.botName} 💗_`;
        if (live.length) live.slice(0, 3).forEach(e => { out += fmt(e); });
        else if (results.length) { out += '\n\n📋 *Recent Results*'; results.slice(0, 3).forEach(e => { out += fmt(e); }); }
        else if (upcoming.length) { out += '\n\n📅 *Upcoming Matches*'; upcoming.slice(0, 3).forEach(e => { out += fmt(e); }); }
        const shown = (live.length ? live : results.length ? results : upcoming).slice(0, 4);
        const srows = shown.map(e => {
          const tag = e.state === 'in' ? 'LIVE' : e.state === 'post' ? 'Result' : 'Upcoming';
          const vs = e.teams.map(x => `${x.name}${x.score ? ' ' + x.score : ''}`).join(' vs ');
          return [`${tag} — ${e.lg}`.slice(0, 26), vs.slice(0, 40) || '—'];
        });
        await sendCard(sock, jid, msg, 'CRICKET SCORE', srows, { accent: '#4ade80' }, out.slice(0, 3500));
      } catch (e) {
        console.error('[score] fail:', e.message);
        await reply(sock, jid, msg, '❌ Score nahi mil saka, thodi der baad dobara try karein.');
      }
    },
  },

  wish: {
    desc: 'Wish card banao: .wish <naam> [birthday|shaadi|eid|mubarak] 💌',
    run: async (sock, msg, args, { jid }) => {
      if (!args.length) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}wish <naam> [birthday|shaadi|eid|mubarak]*\nMasalan: *${config.prefix}wish Ali birthday* 💗`);
      const occRaw = String(args[args.length - 1] || '').toLowerCase();
      const occMap = {
        birthday: ['Happy Birthday', 'Janam din bohat bohat mubarak ho'],
        shaadi: ['Shaadi Mubarak', 'Nayi zindagi ki dheron khushiyan'],
        eid: ['Eid Mubarak', 'Eid ki khushiyan mubarak hon'],
        mubarak: ['Mubarak Ho', 'Dili mubarakbaad'],
        anniversary: ['Anniversary Mubarak', 'Hamesha khush raho'],
        success: ['Mubarak Ho', 'Kamyabi par dili mubarakbaad'],
      };
      let occ, sub, name;
      if (occMap[occRaw]) { [occ, sub] = occMap[occRaw]; name = args.slice(0, -1).join(' '); }
      else { occ = 'Dher Sari Duaen'; sub = 'Aap ke liye mohabbat aur khushiyan'; name = args.join(' '); }
      name = (name || 'Dost').slice(0, 24);
      await reply(sock, jid, msg, '💌 Card bana rahi hoon... 💗');
      try {
        const png = await wishCard(name, occ, sub);
        await sock.sendMessage(jid, { image: png, caption: `💌 *${occ}* — *${name}*\n\n_${sub}_\n\n💗 _${config.botName}_` }, { quoted: msg });
      } catch (e) {
        console.error('[wish] fail:', e.message);
        await reply(sock, jid, msg, '❌ Card nahi ban saka, dobara try karein.');
      }
    },
  },

  trans: {
    desc: 'Urdu ↔ English tarjuma 🌐',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim();
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}trans <jumla>*\nMasalan: *${config.prefix}trans hello kaise ho*`);
      await reply(sock, jid, msg, '🌐 Tarjuma kar rahi hoon... 💗');
      try {
        const isUrdu = /[؀-ۿ]/.test(q);
        const tl = isUrdu ? 'en' : 'ur';
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + tl + '&dt=t&q=' + encodeURIComponent(q.slice(0, 500));
        const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) throw new Error('http-' + res.status);
        const d = await res.json();
        const out = (d[0] || []).map(s => s[0]).join('').trim();
        if (!out) throw new Error('empty');
        const dir = isUrdu ? 'اردو → English' : 'English → اردو';
        await reply(sock, jid, msg, `🌐 *Tarjuma* (${dir})\n\n📝 ${q.slice(0, 500)}\n\n💗 ${out}`);
      } catch (e) {
        console.error('[trans] fail:', e.message);
        await reply(sock, jid, msg, '❌ Tarjuma nahi ho saka, thodi der baad try karein.');
      }
    },
  },

  // ── naye commands part 2 (2026-09-23) ──
  style: {
    desc: 'Naam fancy fonts mein ✨',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 20);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}style <naam>*\nMasalan: *${config.prefix}style Ahmad*`);
      let out = `✨ *Fancy Styles* — _${text}_\n`;
      STYLE_FONTS.forEach((f, i) => { out += `\n*${i + 1}. ${f.name}*\n${stylize(text, f)}\n`; });
      out += `\n💗 _${config.botName}_`;
      await reply(sock, jid, msg, out.slice(0, 3500));
    },
  },

  note: {
    desc: 'Zaati note save karo 📝',
    run: async (sock, msg, args, { jid, sender }) => {
      const text = args.join(' ').trim().slice(0, 500);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}note <aapka note>*\nDekhne ke liye: *${config.prefix}notes*`);
      const all = loadNotes();
      const key = sender || jid;
      (all[key] = all[key] || []).push(text);
      saveNotes(all);
      await reply(sock, jid, msg, `📝 Note save ho gaya! (kul ${all[key].length})\nDekhne ke liye: *${config.prefix}notes* 💗`);
    },
  },

  notes: {
    desc: 'Apne notes dekho 📝',
    run: async (sock, msg, args, { jid, sender }) => {
      const all = loadNotes();
      const list = all[sender || jid] || [];
      if (!list.length) return reply(sock, jid, msg, `📝 Abhi koi note nahi hai.\nSave karne ke liye: *${config.prefix}note <text>* 💗`);
      let out = `📝 *Aapke Notes* (${list.length})\n`;
      list.forEach((n, i) => { out += `\n*${i + 1}.* ${n}`; });
      out += `\n\n🗑 Delete: *${config.prefix}delnote <number>*`;
      await reply(sock, jid, msg, out.slice(0, 3500));
    },
  },

  delnote: {
    desc: 'Note delete karo 🗑',
    run: async (sock, msg, args, { jid, sender }) => {
      const n = parseInt(args[0], 10);
      const all = loadNotes();
      const key = sender || jid;
      const list = all[key] || [];
      if (!n || n < 1 || n > list.length) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}delnote <number>* (1 se ${list.length} tak)`);
      const gone = list.splice(n - 1, 1)[0];
      saveNotes(all);
      await reply(sock, jid, msg, `🗑 Note delete ho gaya: _${String(gone).slice(0, 60)}_ 💗`);
    },
  },

  namaz: {
    desc: 'Namaz timings 🕌',
    run: async (sock, msg, args, { jid }) => {
      const city = args.join(' ').trim().slice(0, 40) || 'Karachi';
      await reply(sock, jid, msg, `🕌 ${city} ki namaz timings la rahi hoon... 💗`);
      try {
        const url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=Pakistan&method=2`;
        const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
        const d = await res.json();
        if (d.code !== 200) throw new Error('api-' + d.code);
        const t = d.data.timings;
        const clean = (s) => String(s || '').replace(/\s*\(PKT\)/i, '').trim();
        const nout =
          `🕌 *Namaz Timings — ${city}*\n📅 ${d.data.date.readable}\n\n` +
          `🌅 Fajr: *${clean(t.Fajr)}*\n☀️ Sunrise: *${clean(t.Sunrise)}*\n🌞 Dhuhr: *${clean(t.Dhuhr)}*\n` +
          `🌤️ Asr: *${clean(t.Asr)}*\n🌇 Maghrib: *${clean(t.Maghrib)}*\n🌙 Isha: *${clean(t.Isha)}*`;
        await sendCard(sock, jid, msg, 'NAMAZ TIMINGS', [
          ['Fajr', clean(t.Fajr)],
          ['Sunrise', clean(t.Sunrise)],
          ['Dhuhr', clean(t.Dhuhr)],
          ['Asr', clean(t.Asr)],
          ['Maghrib', clean(t.Maghrib)],
          ['Isha', clean(t.Isha)],
        ], { sub: `${city} — ${d.data.date.readable}`, accent: '#ffd166' }, nout);
      } catch (e) {
        console.error('[namaz] fail:', e.message);
        await reply(sock, jid, msg, '❌ Timings nahi mil sakin — sheher ka naam check karein (masalan: `.namaz Lahore`).');
      }
    },
  },

  gold: {
    desc: 'Aaj sone ka rate 🪙',
    run: async (sock, msg, args, { jid }) => {
      await reply(sock, jid, msg, '🪙 Sone ka rate la rahi hoon... 💗');
      try {
        const res = await fetch('https://gold.pk/', {
          signal: AbortSignal.timeout(25000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        if (!res.ok) throw new Error('http-' + res.status);
        const html = await res.text();
        const tola = html.match(/1 tola Gold Rate in Pakistan for 24 karat is Rs\.\s*([\d,]*\d)/i);
        const gram = html.match(/Gold per Gram<\/b>[\s\S]{0,300}?Rs\.\s*([\d,]*\d)/i);
        const dt = html.match(/updated on ([A-Za-z0-9 ,rdth]+?2026)/i);
        if (!tola) throw new Error('parse-fail');
        const gout =
          `🪙 *Sone ka Rate — Pakistan*\n📅 ${dt ? dt[1].trim() : 'aaj'}\n\n` +
          `✨ Fi tola (24K): *Rs. ${tola[1]}*\n✨ Fi gram (24K): *Rs. ${gram ? gram[1] : '—'}*`;
        await sendCard(sock, jid, msg, 'SONE KA RATE', [
          ['Fi tola (24K)', `Rs. ${tola[1]}`],
          ['Fi gram (24K)', gram ? `Rs. ${gram[1]}` : '—'],
          ['Mulk', 'Pakistan'],
        ], { sub: dt ? dt[1].trim().slice(0, 50) : '', accent: '#ffd166' }, gout);
      } catch (e) {
        console.error('[gold] fail:', e.message);
        await reply(sock, jid, msg, '❌ Rate nahi mil saka, thodi der baad dobara try karein.');
      }
    },
  },

  quiz: {
    desc: '5 sawalon ka quiz 🎯 (jawab: .ans A)',
    run: async (sock, msg, args, { jid, sender }) => {
      const key = sender || jid;
      const order = [...QUIZ_QS.keys()].sort(() => Math.random() - 0.5).slice(0, 5);
      quizState.set(key, { order, i: 0, score: 0 });
      const Q = QUIZ_QS[order[0]];
      const letters = ['A', 'B', 'C', 'D'];
      let out = `🎯 *Quiz shuru!* (5 sawal)\nJawab: *${config.prefix}ans A/B/C/D*\n\n❓ *Sawal 1/5:* ${Q.q}\n`;
      Q.opts.forEach((o, i) => { out += `\n${letters[i]}. ${o}`; });
      await reply(sock, jid, msg, out);
    },
  },

  ans: {
    desc: 'Quiz ka jawab do 🎯',
    run: async (sock, msg, args, { jid, sender }) => {
      const key = sender || jid;
      const st = quizState.get(key);
      if (!st) return reply(sock, jid, msg, `❌ Pehle *${config.prefix}quiz* likh kar quiz shuru karo 💗`);
      const pick = String(args[0] || '').trim().toUpperCase();
      const idx = ['A', 'B', 'C', 'D'].indexOf(pick);
      if (idx === -1) return reply(sock, jid, msg, `❌ Jawab *A*, *B*, *C* ya *D* mein do. Masalan: *${config.prefix}ans B*`);
      const Q = QUIZ_QS[st.order[st.i]];
      const letters = ['A', 'B', 'C', 'D'];
      let out;
      if (idx === Q.a) {
        st.score++;
        const cel = ['✅ *Bilkul sahi!* 🎉', '✅ *Wah! Kya baat hai!* 🌟', '✅ *Zabardast!* Dimagh tez chal raha hai 🧠✨', '✅ *Perfect!* Aap to champion nikle 🏆'];
        out = cel[Math.floor(Math.random() * cel.length)] + `\n`;
      } else {
        const con = ['❌ Ghalat!', '❌ Oops! Ye wala choot gaya!', '❌ Arey! Thoda sa reh gaya!'];
        out = `${con[Math.floor(Math.random() * con.length)]} Sahi jawab tha: *${letters[Q.a]}. ${Q.opts[Q.a]}*\n`;
      }
      st.i++;
      if (st.i >= st.order.length) {
        quizState.delete(key);
        const s = st.score;
        const praise = s === 5 ? '🏆 Wah! Perfect score — aap to genius hain!' : s >= 3 ? '👏 Bohat khoob! Zabardast khela!' : s >= 1 ? '💪 Acha khela! Dobara try karo, aur behtar hoga!' : '💗 Koi baat nahi! Dobara khelo, seekh jaoge!';
        out += `\n🏁 *Quiz khatam!*\n⭐ Score: *${s}/5*\n${praise}\n\nDobara: *${config.prefix}quiz*`;
      } else {
        const NQ = QUIZ_QS[st.order[st.i]];
        out += `\n❓ *Sawal ${st.i + 1}/5:* ${NQ.q}\n`;
        NQ.opts.forEach((o, i) => { out += `\n${letters[i]}. ${o}`; });
      }
      await reply(sock, jid, msg, out);
    },
  },

  riddle: {
    desc: 'Paheli — jawab: .riddle <jawab> 🧩',
    run: async (sock, msg, args, { jid, sender }) => {
      const key = sender || jid;
      const guess = args.join(' ').trim().toLowerCase();
      if (!guess) {
        const R = RIDDLES[Math.floor(Math.random() * RIDDLES.length)];
        riddleState.set(key, R);
        return reply(sock, jid, msg, `🧩 *Paheli:*\n\n${R.q}\n\n💡 Jawab: *${config.prefix}riddle <aapka jawab>*`);
      }
      const R = riddleState.get(key);
      if (!R) return reply(sock, jid, msg, `❌ Pehle *${config.prefix}riddle* likh kar paheli lo 💗`);
      const norm = (s) => s.toLowerCase().trim().replace(/[?.!،۔]/g, '');
      const ok = R.a.some(a => norm(guess) === norm(a) || norm(guess).includes(norm(a)));
      if (ok) {
        riddleState.delete(key);
        const rcel = ['🎉 *Bilkul sahi!* Aap to paheliyon ke badshah! 👑', '🎉 *Kya baat hai!* Bilkul sahi jawab! 🌟', '🎉 *Wah!* Dimagh ki batti jal gayi! 💡'];
        return reply(sock, jid, msg, `${rcel[Math.floor(Math.random() * rcel.length)]}\nJawab tha: *${R.a[0]}*\n\nNayi paheli: *${config.prefix}riddle* 🧩`);
      }
      const rcon = ['❌ Ghalat jawab! Dobara socho... 🤔', '❌ Hmm, qareeb thay! Phir try karo 🤔', '❌ Nahi hua! Thoda aur dimagh lagao 🧠'];
      return reply(sock, jid, msg, `${rcon[Math.floor(Math.random() * rcon.length)]}\n\n🧩 ${R.q}`);
    },
  },

  fact: {
    desc: 'Hairan-kun fact 🤯',
    run: async (sock, msg, args, { jid }) => {
      await reply(sock, jid, msg, `🤯 *Fact*\n\n${FACTS[Math.floor(Math.random() * FACTS.length)]}\n\n💗 _${config.botName}_`);
    },
  },

  khulasa: {
    desc: 'Reply wale message ka khulasa 📝',
    run: async (sock, msg, args, { jid }) => {
      const quoted = ctxOf(msg)?.quotedMessage;
      const text = quoted ? getText({ message: quoted }).trim() : '';
      if (!text) return reply(sock, jid, msg, `❌ Kisi message par *reply* karke *${config.prefix}khulasa* likho, phir main uska khulasa bataungi 💗`);
      if (text.length < 30) return reply(sock, jid, msg, '❌ Itna chhota message hai — kisi lambe message par reply karo 😄');
      await reply(sock, jid, msg, '📝 Khulasa bana rahi hoon... 💗');
      try {
        const sum = await askNexa('Neeche diye gaye message ka 3-4 line mein khulasa Roman Urdu mein likho (koi izafi baat nahi):\n\n' + text.slice(0, 2000));
        if (!sum || !sum.trim()) throw new Error('empty');
        await reply(sock, jid, msg, `📝 *Khulasa* 💗\n\n${sum.trim().slice(0, 1500)}`);
      } catch (e) {
        console.error('[khulasa] fail:', e.message);
        await reply(sock, jid, msg, '❌ Khulasa nahi ban saka, thodi der baad try karein.');
      }
    },
  },

  countdown: {
    desc: 'Event countdown ⏳ (.countdown YYYY-MM-DD event)',
    run: async (sock, msg, args, { jid }) => {
      const ds = args[0] || '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}countdown <YYYY-MM-DD> <event>*\nMasalan: *${config.prefix}countdown 2026-12-25 Christmas*`);
      }
      const target = new Date(ds + 'T00:00:00');
      if (isNaN(target.getTime())) return reply(sock, jid, msg, '❌ Tareekh samajh nahi aayi. Format: *YYYY-MM-DD* (masalan 2026-12-25).');
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const days = Math.round((target - now) / 86400000);
      const ev = args.slice(1).join(' ').slice(0, 60) || 'event';
      if (days < 0) await reply(sock, jid, msg, `⌛ *${ev}* guzar chuka hai (${Math.abs(days)} din pehle). 💗`);
      else if (days === 0) await reply(sock, jid, msg, `🎉 *${ev}* AAJ hai! Mubarak ho! 💗`);
      else await reply(sock, jid, msg, `⏳ *${ev}* mein *${days} din* baqi hain! 💗`);
    },
  },

  // ── professional batch (2026-09-23): transcribe/google/code/letter/autoreply/ratelist/vcard/task/schedule/faisla/tax/json/base64/hash + img3d/imgpro ──
  transcribe: {
    desc: 'Voice note → text 🎙 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => {
      const q = ctxOf(msg)?.quotedMessage;
      const hasQ = !!(q && q.audioMessage);
      const aud = hasQ ? q.audioMessage : msg.message?.audioMessage;
      if (!aud) return reply(sock, jid, msg, `❌ Kisi voice note/audio ke reply mein *${config.prefix}transcribe* likhein.`);
      await reply(sock, jid, msg, '🎙 Sun rahi hoon... 💗');
      const tmp = `/tmp/trs-${Date.now()}.ogg`;
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: hasQ ? { audioMessage: aud } : msg.message }, 'buffer', {});
        if (!buf || !buf.length) throw new Error('empty');
        fs.writeFileSync(tmp, buf);
        const out = await new Promise((res) => {
          execFile('/home/hatch/workspace/voice-env/bin/python', ['/home/hatch/workspace/whatsapp-md-bot/lib/voice.py', tmp],
            { timeout: 180000 }, (e, stdout) => res(String(stdout || '')));
        });
        let txt = '', lang = '';
        try { const j = JSON.parse(out); txt = (j.text || '').trim(); lang = j.lang || ''; } catch {}
        if (!txt) throw new Error('notext');
        await reply(sock, jid, msg, `🎙 *Transcription*${lang ? ` (${lang})` : ''} 💗\n\n${txt.slice(0, 2000)}`);
      } catch (e) {
        console.error('[transcribe] fail:', e.message);
        await reply(sock, jid, msg, '❌ Audio samajh nahi aaya — saaf voice note par dobara try karein.');
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    },
  },

  google: {
    desc: 'Web search 🔍',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 100);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}google <sawal>*\nMasalan: *${config.prefix}google Pakistan ki abadi*`);
      await reply(sock, jid, msg, `🔍 *${q}* dhoondh rahi hoon... 💗`);
      // typo sudharo: Google suggest (bina key ke kaam karta hai) — "eln musk" → "elon musk"
      let sq = q, fixed = '';
      try {
        const sr = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&q=' + encodeURIComponent(q), {
          signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const sj = await sr.json();
        const top = Array.isArray(sj) && Array.isArray(sj[1]) && sj[1][0] ? String(sj[1][0]) : '';
        if (top && top.toLowerCase() !== q.toLowerCase()) { sq = top; fixed = top; }
      } catch (e) {}
      try {
        // Bing RSS search — DDG datacenter IPs par 202/block deta hai, ye kaam karta hai
        const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(sq)}&format=rss`, {
          signal: AbortSignal.timeout(25000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        });
        if (!res.ok) throw new Error('http-' + res.status);
        const xml = await res.text();
        const clean = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").trim();
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
        const results = items.map(it => {
          const t = it.match(/<title>([\s\S]*?)<\/title>/);
          const l = it.match(/<link>([\s\S]*?)<\/link>/);
          const d = it.match(/<description>([\s\S]*?)<\/description>/);
          return { title: clean(t && t[1]), link: clean(l && l[1]), desc: clean(d && d[1]).slice(0, 140) };
        }).filter(r => r.title && r.link && !/bing\.com/i.test(r.link));
        const n = Math.min(5, results.length);
        if (!n) throw new Error('noresults');
        let out = `🔍 *${q}* — top ${n} 💗\n`;
        if (fixed) out += `_Aapka matlab *${fixed}* tha?_ 😉\n`;
        for (let i = 0; i < n; i++) {
          out += `\n*${i + 1}.* ${results[i].title.slice(0, 90)}`;
          if (results[i].desc && results[i].desc !== results[i].title) out += `\n   _${results[i].desc}_`;
          out += `\n   🔗 ${results[i].link.slice(0, 90)}`;
        }
        await reply(sock, jid, msg, out.slice(0, 1800));
      } catch (e) {
        console.error('[google] fail:', e.message);
        await reply(sock, jid, msg, e.message === 'noresults' ? `❌ *${q}* par koi result nahi mila — mukhtalif lafzon se try karein.` : '❌ Search nahi ho saka, thodi der baad try karein.');
      }
    },
  },

  code: {
    desc: 'Code likhwao 💻 (.code <masla>)',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 500);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}code <kya banana hai>*\nMasalan: *${config.prefix}code python mein factorial function*`);
      await reply(sock, jid, msg, '💻 Code likh rahi hoon... 💗');
      try {
        const ans = await askNexa(`Tum senior developer ho. Neeche wale masle ka SIRF code do triple-backtick block mein (language tag ke saath), phir neeche 2 line Roman Urdu mein wazahat. Koi izafi baat nahi.\n\nMasla: ${q}`);
        if (!ans || !ans.trim()) throw new Error('empty');
        await reply(sock, jid, msg, `💻 *Code* 💗\n\n${ans.trim().slice(0, 3000)}`);
      } catch (e) {
        console.error('[code] fail:', e.message);
        await reply(sock, jid, msg, '❌ Code nahi ban saka, thodi der baad try karein.');
      }
    },
  },

  letter: {
    desc: 'Darkhwast likhwao ✉️ (.letter [ur] <topic>)',
    run: async (sock, msg, args, { jid }) => {
      let lang = 'en', topic = args.join(' ').trim();
      if (/^ur\b/i.test(topic)) { lang = 'ur'; topic = topic.replace(/^ur\b/i, '').trim(); }
      topic = topic.slice(0, 200);
      if (!topic) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}letter <topic>* ya *${config.prefix}letter ur <topic>*\nMasalan: *${config.prefix}letter chhutti ki darkhwast*`);
      await reply(sock, jid, msg, '✉️ Darkhwast likh rahi hoon... 💗');
      try {
        const prompt = lang === 'ur'
          ? `Urdu mein ek formal darkhwast (application) likho is topic par: "${topic}". Format: tareekh, mukhatib (To), mozua (Subject), adab se body, aakhir mein "Aapka mukhlis" signature line.`
          : `Write a formal application letter in English on this topic: "${topic}". Format: date, To, Subject, polite body, ending with "Yours sincerely" signature line.`;
        const ans = await askNexa(prompt);
        if (!ans || !ans.trim()) throw new Error('empty');
        await reply(sock, jid, msg, `✉️ *Darkhwast* 💗\n\n${ans.trim().slice(0, 2500)}`);
      } catch (e) {
        console.error('[letter] fail:', e.message);
        await reply(sock, jid, msg, '❌ Darkhwast nahi ban saki, thodi der baad try karein.');
      }
    },
  },

  autoreply: {
    desc: 'Is chat ka auto-reply 💬 (.autoreply <text>/off)',
    run: async (sock, msg, args, { jid, sender }) => {
      const raw = args.join(' ').trim();
      // group mein sirf admin/owner laga sakta hai — warna koi bhi poori group ka reply badal dega
      if (jid.endsWith('@g.us')) {
        const sNum = num(sender);
        let isAdm = isOwnerMsg(msg, sender, jid);
        try {
          const meta = await sock.groupMetadata(jid);
          isAdm = isAdm || (meta.participants || []).some((pt) => pt.admin && [num(pt.id), num(pt.phoneNumber)].includes(sNum));
        } catch {}
        if (!isAdm) return reply(sock, jid, msg, '❌ Group mein sirf admin auto-reply laga sakta hai.');
      }
      const all = loadAutoreply();
      if (/^off$/i.test(raw)) {
        delete all[jid]; saveAutoreply(all);
        return reply(sock, jid, msg, '💬 Auto-reply: ⛔ OFF');
      }
      if (!raw) {
        const cur = all[jid];
        return reply(sock, jid, msg, cur ? `💬 Auto-reply ON ✅\n\n_"${cur.slice(0, 200)}"_\n\nBand karne ke liye: *${config.prefix}autoreply off*` : `❌ Usage: *${config.prefix}autoreply <jawab>*\nMasalan: *${config.prefix}autoreply Assalam o Alaikum! Main abhi masroof hoon, jald jawab dunga.*\n\nBand: *${config.prefix}autoreply off*`);
      }
      all[jid] = raw.slice(0, 500); saveAutoreply(all);
      await reply(sock, jid, msg, `💬 Auto-reply ON ✅\n\nAb is chat mein har message ka ye jawab jayega:\n_"${raw.slice(0, 200)}"_\n\n💗 _${config.botName}_`);
    },
  },

  additem: {
    desc: 'Dukaan rate list mein cheez add karo 🏷 (.additem naam | qeemat)',
    run: async (sock, msg, args, { jid, sender }) => {
      const raw = args.join(' ').trim();
      const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length < 2) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}additem <naam> | <qeemat>*\nMasalan: *${config.prefix}additem Doodh 1kg | 180*`);
      const key = sender || jid;
      const all = loadRatelist();
      const list = all[key] || [];
      list.push({ name: parts[0].slice(0, 60), price: parts.slice(1).join(' | ').slice(0, 40) });
      all[key] = list; saveRatelist(all);
      await reply(sock, jid, msg, `✅ Add ho gaya: *${parts[0]}* — ${parts.slice(1).join(' | ')}\n\nDekhne ke liye: *${config.prefix}ratelist* 💗`);
    },
  },

  ratelist: {
    desc: 'Dukaan ki price list 🏷',
    run: async (sock, msg, args, { jid, sender }) => {
      const list = (loadRatelist()[sender || jid]) || [];
      if (!list.length) return reply(sock, jid, msg, `🏷 Rate list khaali hai.\n\nAdd karein: *${config.prefix}additem Doodh 1kg | 180* 💗`);
      await reply(sock, jid, msg, `🏷 *Rate List* 💗\n\n` + list.map((it, i) => `*${i + 1}.* ${it.name}\n    💰 ${it.price}`).join('\n\n') + `\n\nHatane ke liye: *${config.prefix}delitem <number>*`);
    },
  },

  delitem: {
    desc: 'Rate list se hatao 🗑',
    run: async (sock, msg, args, { jid, sender }) => {
      const n = parseInt(args[0], 10);
      const key = sender || jid;
      const all = loadRatelist();
      const list = all[key] || [];
      if (!n || n < 1 || n > list.length) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}delitem <number>* (1 se ${list.length} tak)`);
      const gone = list.splice(n - 1, 1)[0];
      all[key] = list; saveRatelist(all);
      await reply(sock, jid, msg, `🗑 Hat gaya: _${gone.name}_ 💗`);
    },
  },

  vcard: {
    desc: 'Digital business card 👤 (.vcard naam number [company])',
    run: async (sock, msg, args, { jid }) => {
      // phone-number token dhoondo: us se pehle = naam, baad mein = company
      const toks = args.map(t => t.trim()).filter(Boolean);
      const pi = toks.findIndex(t => t.replace(/\D/g, '').length >= 7);
      const name = (pi === -1 ? toks.join(' ') : toks.slice(0, pi).join(' ')).slice(0, 60);
      let phone = pi === -1 ? '' : toks[pi].replace(/[^\d+]/g, '');
      const company = (pi === -1 ? '' : toks.slice(pi + 1).join(' ')).trim().slice(0, 60);
      if (!name || !phone || phone.replace(/\D/g, '').length < 7) {
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}vcard <naam> <number> [company]*\nMasalan: *${config.prefix}vcard Ali Raza 03001234567 Dukaan*`);
      }
      if (!phone.startsWith('+')) phone = '+' + phone;
      const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:' + name + '\nTEL;TYPE=CELL:' + phone + (company ? '\nORG:' + company : '') + '\nEND:VCARD';
      await sock.sendMessage(jid, { contacts: { displayName: name, contacts: [{ vcard }] } }, { quoted: msg });
    },
  },

  task: {
    desc: 'Team ko kaam do 📋 (.task @user kaam)',
    run: async (sock, msg, args, { jid, sender }) => {
      if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf groups mein chalti hai.');
      const ci = getContextInfo(msg);
      const mentioned = (ci && ci.mentionedJid) || [];
      const work = args.join(' ').replace(/@\d+/g, '').trim().slice(0, 200);
      if (!mentioned.length || !work) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}task @user <kaam>*\nMasalan: *${config.prefix}task @Ali doodh le aao*`);
      const all = loadTasks();
      const list = all[jid] || [];
      list.push({ who: mentioned[0], by: sender, text: work, done: false, at: Date.now() });
      all[jid] = list; saveTasks(all);
      await sock.sendMessage(jid, { text: `📋 *Naya task* 💗\n\n👤 @${num(mentioned[0])}\n📝 ${work}\n⏳ _pending_\n\nMukammal par: *${config.prefix}donetask ${list.length}*\n\n— Nexa 💗`, mentions: mentioned }, { quoted: msg });
    },
  },

  tasks: {
    desc: 'Group ke tasks dekho 📋',
    run: async (sock, msg, args, { jid }) => {
      if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf groups mein chalti hai.');
      const list = loadTasks()[jid] || [];
      if (!list.length) return reply(sock, jid, msg, `📋 Koi task nahi.\n\nNaya: *${config.prefix}task @user <kaam>* 💗`);
      const mentions = list.map(t => t.who).filter(Boolean);
      await sock.sendMessage(jid, {
        text: `📋 *Group Tasks* 💗\n\n` + list.map((t, i) => `*${i + 1}.* ${t.done ? '✅' : '⏳'} ${t.text}\n    👤 @${num(t.who)}`).join('\n\n') + '\n\n— Nexa 💗',
        mentions,
      }, { quoted: msg });
    },
  },

  donetask: {
    desc: 'Task mukammal ✅ (.donetask <n>)',
    run: async (sock, msg, args, { jid, sender }) => {
      if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf groups mein chalti hai.');
      const n = parseInt(args[0], 10);
      const all = loadTasks();
      const list = all[jid] || [];
      if (!n || n < 1 || n > list.length) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}donetask <number>* (1 se ${list.length} tak)`);
      const t = list[n - 1];
      const sNum = num(sender);
      let isAdm = isOwnerMsg(msg, sender, jid);
      try {
        const meta = await sock.groupMetadata(jid);
        isAdm = isAdm || (meta.participants || []).some((pt) => pt.admin && [num(pt.id), num(pt.phoneNumber)].includes(sNum));
      } catch {}
      if (num(t.by) !== sNum && !isAdm) {
        return reply(sock, jid, msg, '❌ Sirf kaam dene wala ya group admin mukammal kar sakta hai.');
      }
      t.done = true; saveTasks(all);
      await reply(sock, jid, msg, `✅ Task mukammal: _${t.text.slice(0, 60)}_ 🎉💗`);
    },
  },

  schedule: {
    desc: 'Paigham schedule karo 📅 (.schedule 10:30 text)',
    run: async (sock, msg, args, { jid, sender }) => {
      const due = parseReminderTime(args[0] || '');
      const text = args.slice(1).join(' ').trim().slice(0, 500);
      if (!due || !text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}schedule <waqt> <paigham>*\n\nWaqt: *10:30* · *30m* · *2h* · *1d*\nMasalan: *${config.prefix}schedule 08:00 Good morning group!*`);
      const all = loadSchedules();
      const mine = all.filter(s => (s.who || '') === (sender || jid));
      if (mine.length >= 20) return reply(sock, jid, msg, '❌ 20 schedules pehle se hain — `.delsched <number>` se hatayein.');
      all.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), jid, who: sender || jid, by: num(sock.user?.id || ''), text, due });
      saveSchedules(all);
      await reply(sock, jid, msg, `📅 Schedule ho gaya! 💗\n\n🕐 ${fmtPktTime(due)} (PKT) — is chat mein bhejungi\n\nDekhne ke liye: *${config.prefix}schedules*`);
    },
  },

  schedules: {
    desc: 'Mere schedules dekho 📅',
    run: async (sock, msg, args, { jid, sender }) => {
      const mine = loadSchedules().filter(s => (s.who || '') === (sender || jid)).sort((a, b) => a.due - b.due);
      if (!mine.length) return reply(sock, jid, msg, `📅 Koi schedule nahi.\n\nLagayein: *${config.prefix}schedule 08:00 Good morning!* 💗`);
      await reply(sock, jid, msg, `📅 *Aapke schedules* 💗\n\n` + mine.map((s, i) => `*${i + 1}.* 🕐 ${fmtPktTime(s.due)}\n    _${s.text.slice(0, 80)}_`).join('\n\n') + `\n\nHatane ke liye: *${config.prefix}delsched <number>*`);
    },
  },

  delsched: {
    desc: 'Schedule cancel karo 🗑',
    run: async (sock, msg, args, { jid, sender }) => {
      const n = parseInt(args[0], 10);
      const all = loadSchedules();
      const mine = all.filter(s => (s.who || '') === (sender || jid)).sort((a, b) => a.due - b.due);
      if (!n || n < 1 || n > mine.length) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}delsched <number>* (1 se ${mine.length} tak)`);
      const gone = mine[n - 1];
      saveSchedules(all.filter(s => s.id !== gone.id));
      await reply(sock, jid, msg, `🗑 Schedule hat gaya: _${gone.text.slice(0, 60)}_ 💗`);
    },
  },

  faisla: {
    desc: 'Qismat se faisla karo 🎯 (.faisla a | b)',
    run: async (sock, msg, args, { jid }) => {
      const opts = args.join(' ').split('|').map(s => s.trim()).filter(Boolean);
      if (opts.length < 2) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}faisla <a> | <b> [| <c>...]*\nMasalan: *${config.prefix}faisla biryani | qorma | daal*`);
      const pick = opts[Math.floor(Math.random() * opts.length)];
      const fun = ['Qismat ne faisla suna diya! ⚖️', 'Sochne ka waqt khatam! 😄', 'Dill ne bhi yehi kaha tha 💗', 'Ab behas band, yehi final! 🎯'][Math.floor(Math.random() * 4)];
      await suspense(sock, jid, msg, '🎯 Qismat ka panna palat rahi hoon... 💗');
      await reply(sock, jid, msg, `🎯 *Faisla ho gaya:* ${pick}\n\n_${fun}_`);
    },
  },

  tax: {
    desc: 'Pakistan income tax andaaza 🧾 (.tax <mahana tankhah>)',
    run: async (sock, msg, args, { jid }) => {
      const monthly = parseInt(String(args[0] || '').replace(/,/g, ''), 10);
      if (!monthly || monthly <= 0 || monthly > 100000000) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}tax <mahana tankhah>*\nMasalan: *${config.prefix}tax 150000*`);
      const t = pakIncomeTax(monthly);
      const f = (n) => Number(n).toLocaleString('en-US');
      await reply(sock, jid, msg,
        `🧾 *Income Tax Andaaza* (FY 2025-26, salaried)\n\n` +
        `💰 Mahana tankhah: *Rs. ${f(monthly)}*\n📊 Salana aamdani: *Rs. ${f(t.annual)}*\n\n` +
        `🏛 Salana tax: *Rs. ${f(t.tax)}*\n📉 Mahana katoti: *Rs. ${f(t.monthlyTax)}*\n📈 Effective rate: *${t.eff.toFixed(2)}%*\n\n` +
        `⚠️ _Ye sirf andaaza hai, tax mashwara nahi._\n💗 _${config.botName}_`);
    },
  },

  json: {
    desc: 'JSON pretty-print 📦',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ').trim();
      if (!raw) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}json <json text>*`);
      try {
        const pretty = JSON.stringify(JSON.parse(raw), null, 2);
        await reply(sock, jid, msg, `📦 *Pretty JSON* 💗\n\n\`\`\`\n${pretty.slice(0, 2500)}\n\`\`\``);
      } catch (e) {
        await reply(sock, jid, msg, `❌ Ye valid JSON nahi hai.\n\n_${String(e.message).slice(0, 200)}_`);
      }
    },
  },

  base64: {
    desc: 'Base64 encode 🔐',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ');
      if (!raw) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}base64 <text>*`);
      await reply(sock, jid, msg, `🔐 *Base64* 💗\n\n\`${Buffer.from(raw, 'utf8').toString('base64')}\``);
    },
  },

  unbase64: {
    desc: 'Base64 decode 🔓',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ').trim().replace(/\s+/g, '');
      if (!raw) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}unbase64 <base64>*`);
      // strict Base64 validation: sirf valid alphabet, length 4 ka multiple
      if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
        return reply(sock, jid, msg, '❌ Ye valid Base64 nahi lagta.');
      }
      try {
        const dec = Buffer.from(raw, 'base64').toString('utf8');
        if (!dec) throw new Error('empty');
        await reply(sock, jid, msg, `🔓 *Decoded* 💗\n\n${dec.slice(0, 1500)}`);
      } catch {
        await reply(sock, jid, msg, '❌ Ye valid Base64 nahi lagta.');
      }
    },
  },

  hash: {
    desc: 'SHA-256 + MD5 hash #️⃣',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ');
      if (!raw) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}hash <text>*`);
      const cryptoMod = require('crypto');
      const sha = cryptoMod.createHash('sha256').update(raw, 'utf8').digest('hex');
      const md5 = cryptoMod.createHash('md5').update(raw, 'utf8').digest('hex');
      await reply(sock, jid, msg, `#️⃣ *Hash* 💗\n\n*SHA-256:*\n\`${sha}\`\n\n*MD5:*\n\`${md5}\``);
    },
  },

  img3d: {
    desc: 'AI 3D render image 🎨✨',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 300);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}img3d <kya banana hai>*\nMasalan: *${config.prefix}img3d sher, neon jungle mein*`);
      const prompt = `${q}, breathtaking ultra-detailed 3D render, cinematic lighting, octane render quality, soft shadows, vibrant colors, intricate details, professional 3D illustration, 8k, masterpiece`;
      await genAIImage(sock, jid, msg, prompt, `🎨✨ *3D Render*\n_${q.slice(0, 100)}_\n_— ${config.botName} 💗_`);
    },
  },

  imgpro: {
    desc: 'Professional AI photo 📸✨',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 300);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}imgpro <kya banana hai>*\nMasalan: *${config.prefix}imgpro barish mein purani gali*`);
      const prompt = `${q}, professional photography, 85mm lens, studio lighting, ultra sharp focus, stunning composition, award winning photo, 8k uhd, photorealistic, masterpiece`;
      await genAIImage(sock, jid, msg, prompt, `📸✨ *Pro Photo*\n_${q.slice(0, 100)}_\n_— ${config.botName} 💗_`);
    },
  },

  // ── 14 naye commands (2026-09-23): wiki/dict/reminder/ocr/tasbih + hijri/loc/afk/antilink/slow/fast/dream/jid/crypto ──
  wiki: {
    desc: 'Wikipedia khulasa 📚',
    run: async (sock, msg, args, { jid }) => {
      const topic = args.join(' ').trim().slice(0, 100);
      if (!topic) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}wiki <topic>*\nMasalan: *${config.prefix}wiki Pakistan*`);
      await reply(sock, jid, msg, `📚 *${topic}* dhoondh rahi hoon... 💗`);
      try {
        const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`, {
          signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'NEXORA-MD/1.0' },
        });
        if (res.status === 404) throw new Error('notfound');
        if (!res.ok) throw new Error('http-' + res.status);
        const d = await res.json();
        if (d.type === 'disambiguation') throw new Error('notfound');
        const extract = (d.extract || '').trim().replace(/\s+/g, ' ');
        if (!extract) throw new Error('notfound');
        const short = extract.length > 600 ? extract.slice(0, 600).trim() + '…' : extract;
        const wout = `📚 *${d.title}*\n\n${short}`;
        await sendCard(sock, jid, msg, 'WIKIPEDIA', [], { sub: d.title, desc: extract.slice(0, 260), accent: '#50E8F4' }, wout);
      } catch (e) {
        console.error('[wiki] fail:', e.message);
        if (e.message === 'notfound') await reply(sock, jid, msg, `❌ *${topic}* par wazeh maloomat nahi mili — spelling check karke dobara try karein 💗`);
        else await reply(sock, jid, msg, '❌ Wikipedia se jawab nahi aaya, thodi der baad try karein.');
      }
    },
  },

  dict: {
    desc: 'English lafz ka matlab 📖',
    run: async (sock, msg, args, { jid }) => {
      const word = (args[0] || '').trim().toLowerCase().slice(0, 40);
      if (!word || !/^[a-z'-]+$/.test(word)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}dict <word>*\nMasalan: *${config.prefix}dict love*`);
      await reply(sock, jid, msg, `📖 *${word}* ka matlab dhoondh rahi hoon... 💗`);
      let res = null, lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, { signal: AbortSignal.timeout(30000) });
          if (r.status === 404) throw new Error('notfound');
          if (!r.ok) throw new Error('http-' + r.status);
          res = r; break;
        } catch (e) {
          lastErr = e.message;
          if (lastErr === 'notfound') throw e;
          await new Promise(rr => setTimeout(rr, 2000));
        }
      }
      if (!res) throw new Error(lastErr || 'noresponse');
      try {
        const e = (await res.json())[0];
        if (!e) throw new Error('notfound');
        const phon = e.phonetic || ((e.phonetics || []).find(p => p.text) || {}).text || '';
        let out = `📖 *${e.word}*${phon ? `  _${phon}_` : ''}\n`, n = 0;
        for (const m of (e.meanings || []).slice(0, 3)) {
          for (const def of (m.definitions || []).slice(0, 2)) {
            if (n >= 3) break;
            n++;
            out += `\n*${n}.* (${m.partOfSpeech}) ${def.definition}`;
            if (def.example) out += `\n   💬 _"${String(def.example).slice(0, 120)}"_`;
          }
          if (n >= 3) break;
        }
        if (!n) throw new Error('notfound');
        const dout = out.slice(0, 1500);
        const drows = [];
        for (const m of (e.meanings || []).slice(0, 3)) {
          const def = (m.definitions || [])[0];
          if (def) drows.push([m.partOfSpeech || '—', String(def.definition).slice(0, 40)]);
        }
        await sendCard(sock, jid, msg, 'DICTIONARY', drows, { hero: e.word, sub: phon || '', accent: '#6DD5C4' }, dout);
      } catch (e) {
        console.error('[dict] fail:', e.message);
        if (e.message === 'notfound') await reply(sock, jid, msg, `❌ *${word}* ka matlab nahi mila — spelling check karein 💗`);
        else await reply(sock, jid, msg, '❌ Dictionary se jawab nahi aaya, thodi der baad try karein.');
      }
    },
  },

  reminder: {
    desc: 'Yaad-dihani lagao ⏰ (.reminder 10:30 dawai)',
    run: async (sock, msg, args, { jid, sender }) => {
      const due = parseReminderTime(args[0] || '');
      const text = args.slice(1).join(' ').trim().slice(0, 200);
      if (!due || !text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}reminder <waqt> <kaam>*\n\nWaqt: *10:30* (aaj/kal) · *30m* · *2h* · *1d*\nMasalan: *${config.prefix}reminder 10:30 dawai leni hai*`);
      const all = loadReminders();
      const mine = all.filter(r => (r.who || '') === (sender || jid));
      if (mine.length >= 20) return reply(sock, jid, msg, '❌ Aapke 20 reminders pehle se lage hain — `.delrem <number>` se purane hatayein.');
      all.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), jid, who: sender || jid, by: num(sock.user?.id || ''), text, due });
      saveReminders(all);
      await reply(sock, jid, msg, `⏰ Reminder lag gaya! 💗\n\n📝 *${text}*\n🕐 ${fmtPktTime(due)} (PKT)\n\nDekhne ke liye: *${config.prefix}reminders*`);
    },
  },

  reminders: {
    desc: 'Mere reminders dekho ⏰',
    run: async (sock, msg, args, { jid, sender }) => {
      const mine = loadReminders().filter(r => (r.who || '') === (sender || jid)).sort((a, b) => a.due - b.due);
      if (!mine.length) return reply(sock, jid, msg, `⏰ Koi reminder nahi laga.\n\nLagayein: *${config.prefix}reminder 10:30 dawai leni hai* 💗`);
      await reply(sock, jid, msg, `⏰ *Aapke reminders* 💗\n\n` + mine.map((r, i) => `*${i + 1}.* ${r.text}\n    🕐 ${fmtPktTime(r.due)}`).join('\n\n') + `\n\nHatane ke liye: *${config.prefix}delrem <number>*`);
    },
  },

  delrem: {
    desc: 'Reminder cancel karo 🗑',
    run: async (sock, msg, args, { jid, sender }) => {
      const n = parseInt(args[0], 10);
      const all = loadReminders();
      const mine = all.filter(r => (r.who || '') === (sender || jid)).sort((a, b) => a.due - b.due);
      if (!n || n < 1 || n > mine.length) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}delrem <number>* (1 se ${mine.length} tak)`);
      const gone = mine[n - 1];
      saveReminders(all.filter(r => r.id !== gone.id));
      await reply(sock, jid, msg, `🗑 Reminder hat gaya: _${gone.text.slice(0, 60)}_ 💗`);
    },
  },

  ocr: {
    desc: 'Photo mein likha text nikalo 📷',
    run: async (sock, msg, args, { jid }) => {
      const q = ctxOf(msg)?.quotedMessage;
      const img = (q && q.imageMessage) || msg.message?.imageMessage;
      if (!img) return reply(sock, jid, msg, `❌ Kisi photo ke reply mein *${config.prefix}ocr* likhein.`);
      await reply(sock, jid, msg, '📷 Photo parh rahi hoon... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: q ? { imageMessage: img } : msg.message }, 'buffer', {});
        if (!buf || !buf.length) throw new Error('empty');
        const small = await sharp(buf).resize(1000, 1000, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
        const form = new FormData();
        form.append('apikey', 'helloworld');
        form.append('file', new Blob([small], { type: 'image/jpeg' }), 'img.jpg');
        const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
        const d = await res.json();
        const txt = (d?.ParsedResults?.[0]?.ParsedText || '').trim();
        if (!txt) throw new Error('notext');
        await reply(sock, jid, msg, `📷 *Photo ka text* 💗\n\n${txt.slice(0, 1500)}`);
      } catch (e) {
        console.error('[ocr] fail:', e.message);
        await reply(sock, jid, msg, '❌ Photo ka text nahi parh saki — saaf photo par dobara try karein.');
      }
    },
  },

  tasbih: {
    desc: 'Digital tasbih 📿 (.tasbih / .tasbih 100 / .tasbih reset)',
    run: async (sock, msg, args, { jid, sender }) => {
      const key = sender || jid;
      const all = loadTasbih();
      const cur = all[key] || { count: 0, target: 33 };
      const a = (args[0] || '').toLowerCase();
      if (a === 'reset') {
        all[key] = { count: 0, target: cur.target }; saveTasbih(all);
        return reply(sock, jid, msg, `📿 Tasbih reset — phir se shuru karein! 💗`);
      }
      const t = parseInt(a, 10);
      if (t && t > 0 && t <= 10000) {
        all[key] = { count: 0, target: t }; saveTasbih(all);
        return reply(sock, jid, msg, `📿 Target set: *${t}* — ab *${config.prefix}tasbih* likh kar ginte jayein! 💗`);
      }
      if (a) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}tasbih* (ginna) · *${config.prefix}tasbih 100* (target) · *${config.prefix}tasbih reset*`);
      cur.count++;
      if (cur.count >= cur.target) {
        const done = cur.target;
        all[key] = { count: 0, target: done }; saveTasbih(all);
        const tdone = `📿 *${done}* / ${done}\n\n🎉 *Mubarak! ${done} mukammal!* Allah qabool farmaye 🤲`;
        await sendCard(sock, jid, msg, 'TASBIH', [], {
          hero: `${done} / ${done}`, sub: `Mubarak! ${done} mukammal — Allah qabool farmaye`, accent: '#ffd166',
        }, tdone);
        return;
      }
      all[key] = cur; saveTasbih(all);
      const tout = `📿 *${cur.count}* / ${cur.target}`;
      await sendCard(sock, jid, msg, 'TASBIH', [], {
        hero: `${cur.count} / ${cur.target}`, sub: 'SubhanAllah — ginte jayein', accent: '#6DD5C4',
      }, tout);
    },
  },

  hijri: {
    desc: 'Aaj ki Islami tareekh 🌙',
    run: async (sock, msg, args, { jid }) => {
      try {
        const now = new Date();
        const pkt = new Date(now.getTime() + (5 * 60 + now.getTimezoneOffset()) * 60000);
        const p = (n) => String(n).padStart(2, '0');
        const ds = `${p(pkt.getUTCDate())}-${p(pkt.getUTCMonth() + 1)}-${pkt.getUTCFullYear()}`;
        const res = await fetch(`https://api.aladhan.com/v1/gToH?date=${ds}`, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error('http-' + res.status);
        const d = await res.json();
        if (d.code !== 200) throw new Error('api-' + d.code);
        const h = d.data.hijri, g = d.data.gregorian;
        const hout = `🌙 *${h.day} ${h.month.en} ${h.year} AH*\n📅 ${g.day} ${g.month.en} ${g.year} (${g.weekday.en})`;
        await sendCard(sock, jid, msg, 'ISLAMI TAREEKH', [], {
          hero: `${h.day} ${h.month.en} ${h.year}`,
          sub: `${g.day} ${g.month.en} ${g.year} — ${g.weekday.en}`,
          accent: '#c084fc',
        }, hout);
      } catch (e) {
        console.error('[hijri] fail:', e.message);
        await reply(sock, jid, msg, '❌ Islami tareekh nahi mil saki, thodi der baad try karein.');
      }
    },
  },

  loc: {
    desc: 'Jagah ka map location 📍',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 80);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}loc <jagah>*\nMasalan: *${config.prefix}loc Badshahi Mosque*`);
      await reply(sock, jid, msg, `📍 *${q}* dhoondh rahi hoon... 💗`);
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
          signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'NEXORA-MD/1.0' },
        });
        if (!res.ok) throw new Error('http-' + res.status);
        const arr = await res.json();
        if (!arr.length) throw new Error('notfound');
        const r = arr[0];
        await sock.sendMessage(jid, { location: { degreesLatitude: parseFloat(r.lat), degreesLongitude: parseFloat(r.lon), name: String(r.display_name || q).slice(0, 100) } }, { quoted: msg });
        await reply(sock, jid, msg, `📍 *${r.display_name}*\n\n💗 _${config.botName}_`);
      } catch (e) {
        console.error('[loc] fail:', e.message);
        if (e.message === 'notfound') await reply(sock, jid, msg, `❌ *${q}* nahi mila — mukhtalif naam se try karein 💗`);
        else await reply(sock, jid, msg, '❌ Location nahi mil saki, thodi der baad try karein.');
      }
    },
  },

  afk: {
    desc: 'AFK mode 💤 (.afk <wajah>)',
    run: async (sock, msg, args, { jid, sender }) => {
      const key = sender || jid;
      const all = loadAfk();
      const reason = args.join(' ').trim().slice(0, 100);
      if (reason) {
        all[key] = { reason, since: Date.now() }; saveAfk(all);
        return reply(sock, jid, msg, `💤 AFK on: _${reason}_\nAb group mein jo aapko mention karega, use bata dungi 💗`);
      }
      if (all[key]) { delete all[key]; saveAfk(all); return reply(sock, jid, msg, `✨ Wapas aa gayi! AFK off ho gaya 💗`); }
      return reply(sock, jid, msg, `❌ Usage: *${config.prefix}afk <wajah>*\nMasalan: *${config.prefix}afk namaz parh raha hoon*`);
    },
  },

  antilink: {
    desc: 'Group mein links block 🔗 (.antilink on/off)',
    run: async (sock, msg, args, { jid, sender }) => {
      if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf groups mein chalti hai.');
      // sender admin? (owner hamesha allowed) + kya bot khud admin hai? (delete ke liye lazmi)
      let senderAdmin = isOwnerMsg(msg, sender, jid);
      let botAdmin = false;
      try {
        const meta = await sock.groupMetadata(jid);
        const sNum = num(sender), meNum = num(sock.user?.id);
        for (const p of meta.participants || []) {
          if (!p.admin) continue;
          const pNums = [num(p.id), num(p.phoneNumber)];
          if (pNums.includes(sNum)) senderAdmin = true;
          if (pNums.includes(meNum)) botAdmin = true;
        }
      } catch {}
      if (!senderAdmin) return reply(sock, jid, msg, '❌ Sirf group admin ye command chala sakta hai.');
      const v = (args[0] || '').toLowerCase();
      const all = loadAntilink();
      const adminWarn = botAdmin ? '' : '\n\n⚠️ *Main group admin nahi hoon* — link delete nahi kar paunga. Pehle mujhe admin banao, phir links auto-delete honge.';
      if (v === 'on') {
        all[jid] = true; saveAntilink(all);
        if (botAdmin) return reply(sock, jid, msg, '🔗 Antilink: ✅ ON — ghair-admin ka link delete ho jayega.');
        return reply(sock, jid, msg, `🔗 Antilink: ✅ ON kar diya — lekin${adminWarn}\n\n— Nexa 💗`);
      }
      if (v === 'off') { delete all[jid]; saveAntilink(all); return reply(sock, jid, msg, '🔗 Antilink: ⛔ OFF'); }
      const cur = !!all[jid];
      return reply(sock, jid, msg, `🔗 Antilink is group mein *${cur ? 'ON ✅' : 'OFF ❌'}* hai.${cur ? adminWarn : ''}\n\nUsage: *${config.prefix}antilink on/off*`);
    },
  },

  slow: {
    desc: 'Audio slow 🐢 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await audioSpeed(sock, msg, jid, 0.7, '🐢 Slow audio'); },
  },

  fast: {
    desc: 'Audio fast 🐇 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await audioSpeed(sock, msg, jid, 1.5, '🐇 Fast audio'); },
  },

  // ── voice changer pack: 16 effects (NAVEED-MD style, 2026-09-26) ──
  // slow/fast pehle se thay; baqi 14 yahan. Sab audio/voice note ke reply mein.
  bass: {
    desc: 'Bass boost 🔊 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'bass=g=15', '🔊 Bass', 'bass'); },
  },

  deep: {
    desc: 'Gehri bhari awaz 🗣️ (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'asetrate=44100*0.75,aresample=44100,atempo=1.3333', '🗣️ Deep voice', 'deep'); },
  },

  smooth: {
    desc: 'Smooth naram awaz ✨ (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'lowpass=f=4000,acompressor', '✨ Smooth voice', 'smooth'); },
  },

  fat: {
    desc: 'Fat moti awaz 🐷 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'bass=g=10,acrusher=level_in=6:level_out=12:bits=8:mode=log', '🐷 Fat voice', 'fat'); },
  },

  tupai: {
    desc: 'Tupai (squirrel) awaz 🐿️ (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'asetrate=44100*1.6,aresample=44100,atempo=0.625', '🐿️ Tupai voice', 'tupai'); },
  },

  blown: {
    desc: 'Blown speaker awaz 📢 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'acrusher=level_in=10:level_out=11:bits=6:mode=log,acompressor,volume=4dB', '📢 Blown voice', 'blown'); },
  },

  radio: {
    desc: 'Radio wali awaz 📻 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'highpass=f=400,lowpass=f=3200,acompressor,volume=3dB', '📻 Radio voice', 'radio'); },
  },

  robot: {
    desc: 'Robot awaz 🤖 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'asetrate=44100*0.85,aresample=44100,atempo=1.1765,flanger=delay=12:depth=0.25', '🤖 Robot voice', 'robot'); },
  },

  chipmunk: {
    desc: 'Chipmunk awaz 🐹 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'asetrate=44100*1.5,aresample=44100,atempo=0.6667', '🐹 Chipmunk voice', 'chipmunk'); },
  },

  nightcore: {
    desc: 'Nightcore style ⚡ (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'atempo=1.25,asetrate=44100*1.2,aresample=44100', '⚡ Nightcore', 'nightcore'); },
  },

  earrape: {
    desc: 'Earrape tez awaz 🔊 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'volume=8dB,acrusher=level_in=10:level_out=12:bits=6:mode=log', '🔊 Earrape', 'earrape'); },
  },

  reverse: {
    desc: 'Ulti awaz 🔄 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'areverse', '🔄 Reverse audio', 'reverse'); },
  },

  baby: {
    desc: 'Baby awaz 👶 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'asetrate=44100*1.35,aresample=44100,atempo=0.7407', '👶 Baby voice', 'baby'); },
  },

  demon: {
    desc: 'Demon awaz 😈 (audio ke reply mein)',
    run: async (sock, msg, args, { jid }) => { await voiceFX(sock, msg, jid, 'asetrate=44100*0.6,aresample=44100,atempo=1.6667,aecho=0.8:0.88:60:0.4', '😈 Demon voice', 'demon'); },
  },

  dream: {
    desc: 'Khwab ki tabeer 🌙',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 200);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}dream <khwab>*\nMasalan: *${config.prefix}dream saanp dekha*`);
      const ql = q.toLowerCase();
      const hit = DREAMS.find(d => d.k.some(k => k && ql.includes(k)));
      if (hit) return reply(sock, jid, msg, `🌙 *Khwab ki tabeer* 💗\n\n_"${q.slice(0, 80)}"_\n\n${hit.t}\n\n🤲 _Ye aam tabeer hai — behtar rehnumai ke liye kisi aalim se rujoo karein._`);
      await reply(sock, jid, msg, '🌙 Tabeer dhoondh rahi hoon... 💗');
      try {
        const ans = await askNexa(`"${q}" — is khwab ki Islami tabeer Roman Urdu mein 3-4 line mein batao, naram aur ehtiyat wale lehje mein (koi izafi baat nahi):`);
        if (!ans || !ans.trim()) throw new Error('empty');
        await reply(sock, jid, msg, `🌙 *Khwab ki tabeer* 💗\n\n${ans.trim().slice(0, 1200)}`);
      } catch (e) {
        console.error('[dream] fail:', e.message);
        await reply(sock, jid, msg, '❌ Tabeer nahi mil saki, thodi der baad try karein.');
      }
    },
  },

  jid: {
    desc: 'JID / number dekho 🆔',
    run: async (sock, msg, args, { jid, sender }) => {
      const ci = getContextInfo(msg);
      const target = (ci && ci.quotedMessage && ci.participant) ? ci.participant : null;
      if (target) {
        await reply(sock, jid, msg, `🆔 *Quoted sender*\n📱 Number: *${num(target) || '—'}*\n🔑 JID: \`${target}\``);
      } else {
        const me = sender || jid;
        await reply(sock, jid, msg, `🆔 *Aap*\n📱 Number: *${num(me) || '—'}*\n🔑 JID: \`${me}\`\n\n💬 Chat: \`${jid}\``);
      }
    },
  },

  crypto: {
    desc: 'Crypto price 💰 (.crypto btc)',
    run: async (sock, msg, args, { jid }) => {
      const cmap = { btc: 'bitcoin', eth: 'ethereum', bnb: 'binancecoin', sol: 'solana', doge: 'dogecoin', xrp: 'ripple', ada: 'cardano', usdt: 'tether', trx: 'tron', ltc: 'litecoin', link: 'chainlink', dot: 'polkadot', shib: 'shiba-inu', avax: 'avalanche-2', matic: 'matic-network' };
      const coin = (args[0] || '').toLowerCase().trim();
      const id = coin ? cmap[coin] : 'bitcoin';
      if (coin && !id) return reply(sock, jid, msg, `❌ *${coin}* coin nahi mila.\n\nTry: btc · eth · sol · doge · bnb · xrp · ada · usdt · trx · ltc 💗`);
      try {
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${id}&price_change_percentage=24h`, { signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error('http-' + res.status);
        const c = (await res.json())[0];
        if (!c) throw new Error('nodata');
        const usd = Number(c.current_price).toLocaleString('en-US', { maximumFractionDigits: 2 });
        const chg = Number(c.price_change_percentage_24h) || 0;
        const arrow = chg >= 0 ? '📈' : '📉';
        const cout = `🪙 *${c.name} (${String(c.symbol).toUpperCase()})*\n💵 *$${usd}*\n${arrow} 24h: ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%\n🏦 Market Cap: *$${compactNum(c.market_cap)}*`;
        await sendCard(sock, jid, msg, 'CRYPTO', [
          ['Coin', `${c.name} (${String(c.symbol).toUpperCase()})`],
          ['Price', `$${usd}`],
          ['24h Change', `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`],
          ['Market Cap', `$${compactNum(c.market_cap)}`],
        ], { accent: chg >= 0 ? '#4ade80' : '#f87171' }, cout);
      } catch (e) {
        console.error('[crypto] fail:', e.message);
        await reply(sock, jid, msg, '❌ Price nahi mil saki, thodi der baad try karein.');
      }
    },
  },

  // ── ai ──
  ai: {
    desc: 'AI se kuch bhi poochein',
    run: async (sock, msg, args, { jid, sender }) => {
      const q = args.join(' ');
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}ai <aapka sawal>*`);
      await reply(sock, jid, msg, wline(['🤖 Soch rahi hoon... 💗', '🧠 Dimagh ke ghode dauda rahi hoon... ✨', '🤖 Zara tehro, jawab buna rahi hoon... 💫']));
      try {
        const txt = await askNexa(NEXUS.aiPrompt(q, jid, sender));
        if (!txt) throw new Error('empty');
        await reply(sock, jid, msg, `🤖 *Nexa* 💗\n\n${txt.slice(0, 3000)}`);
      } catch {
        await reply(sock, jid, msg, '❌ AI abhi jawab nahi de saka, thodi der baad try karein.');
      }
    },
  },

  // ── utility ──
  getpp: {
    desc: 'Profile photo nikalo (reply ya tag)',
    run: async (sock, msg, args, { jid, sender }) => {
      const ctx = ctxOf(msg);
      const target = ctx?.mentionedJid?.[0] || ctx?.participant || sender;
      try {
        const url = await sock.profilePictureUrl(target, 'image');
        await sock.sendMessage(jid, { image: { url }, caption: `🖼️ @${num(target)} ki profile photo` }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ Profile photo nahi mili (privacy settings ki wajah se).');
      }
    },
  },

  // ── owner ──
  vv: {
    desc: 'View-once unlock — media jisne use kiya uski apni private chat mein (reply); "s" se photo ka sticker',
    run: async (sock, msg, args, { jid, sender }) => {
      const a0 = String(args[0] || '').toLowerCase();
      // .vv <number> → saved view-once list se kholo (chahe dekh li ho!)
      if (/^\d+$/.test(a0)) {
        const list = vvCacheLoad().slice().reverse();
        const e = list[parseInt(a0, 10) - 1];
        if (!e) return reply(sock, jid, msg, `❌ #${a0} nahi mila. *${config.prefix}vvl* se saved list dekho.`);
        try {
          await vvSendCached(sock, msg, sender, e);
          return;
        } catch {
          return reply(sock, jid, msg, '❌ Saved copy nahi mil saki.');
        }
      }
      const quoted = ctxOf(msg)?.quotedMessage;
      const vo = extractViewOnce(quoted);
      if (!vo) {
        return reply(sock, jid, msg, `❌ Kisi view-once photo/video/voice ke reply mein *${config.prefix}vv* likhein (photo ka sticker chahiye to *${config.prefix}vv s*).\n\n💡 *Tip:* View-once par seedha koi sticker ya word se reply karein — bina .vv likhe khud-ba-khud yourself mein aa jayega.`);
      }
      const { imgM, vidM, stM, audM } = vo;
      const wantSticker = /^(s|sticker)$/i.test(args[0] || '');
      // quoted message ki ID — saved copy dhoondne ke liye
      const ci = msg.message?.extendedTextMessage?.contextInfo || msg.message?.stickerMessage?.contextInfo || {};
      const stanzaId = ci.stanzaId;
      try {
        const caption = `👁️ *View-once unlocked*\n_— ${config.botName}_`;
        if (audM) {
          // view-once voice note → inbox mein voice note
          const buf = await downloadMediaMessage({ key: msg.key, message: { audioMessage: audM } }, 'buffer', {});
          await sendOwnerInbox(sock, sender, { audio: buf, ptt: true, mimetype: audM.mimetype || 'audio/ogg; codecs=opus' }, 'audio-ptt');
        } else if (stM) {
          // view-once sticker → inbox mein sticker
          const buf = await downloadMediaMessage({ key: msg.key, message: { stickerMessage: stM } }, 'buffer', {});
          await sendOwnerInbox(sock, sender, { sticker: buf }, 'sticker');
        } else if (wantSticker) {
          if (!imgM) return reply(sock, jid, msg, '❌ Sticker sirf view-once *photo* ka ban sakta hai.');
          const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: imgM } }, 'buffer', {});
          await sendOwnerInbox(sock, sender, { sticker: await imgToSticker(buf) }, 'sticker-from-photo');
        } else if (imgM) {
          const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: imgM } }, 'buffer', {});
          await sendOwnerInbox(sock, sender, { image: buf, caption }, 'image');
        } else {
          const buf = await downloadMediaMessage({ key: msg.key, message: { videoMessage: vidM } }, 'buffer', {});
          await sendOwnerInbox(sock, sender, { video: buf, caption }, 'video');
        }
        // chat mein kuch nahi — na media, na confirmation (Boss ka hukm: bilkul khamosh)
      } catch {
        // live download fail (dekh li hui / purani) → saved copy try karo 💾
        const e = vvCacheFind(stanzaId);
        if (e) {
          try { await vvSendCached(sock, msg, sender, e); return; } catch {}
        }
        await reply(sock, jid, msg, `❌ View-once khol nahi saka — ye bot ke *auto-save* se pehle ki hai.\n\n💡 Aage se aane wali har view-once auto-save hogi, phir dekh li ho tab bhi *${config.prefix}vv* se khul jayegi!`);
      }
    },
  },

  vvl: {
    desc: 'Saved view-once list — dekhi hui bhi kholo 👁️💾',
    run: async (sock, msg, args, { jid }) => {
      const list = vvCacheLoad().slice().reverse();
      if (!list.length) return reply(sock, jid, msg, `👁️ *Saved View-Once*\n\nAbhi koi saved view-once nahi hai.\n\n_Jab koi view-once aayega, bot usay foran auto-save kar lega — phir dekh li ho tab bhi khul jayegi 💾_`);
      const lines = list.slice(0, 15).map((e, i) => {
        const d = new Date(e.time);
        const t = d.toLocaleDateString('en-PK') + ' ' + d.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' });
        const who = e.pushName || e.sender || '?';
        const icon = e.kind === 'image' ? '📷' : e.kind === 'video' ? '🎥' : e.kind === 'audio' ? '🎤' : '🎨';
        return `${i + 1}. ${icon} *${who}* — ${e.kind} (${t})`;
      });
      return reply(sock, jid, msg, `👁️ *Saved View-Once* 💾\n\n${lines.join('\n')}\n\n_Kholne ke liye:_ *${config.prefix}vv <number>*\nMasalan: *${config.prefix}vv 1*`);
    },
  },

  vv2: {
    desc: 'View-once unlock — media jisne use kiya uski apni private chat mein (vv jaisa, reply)',
    run: async (sock, msg, args, { jid, sender }) => {
      const quoted = ctxOf(msg)?.quotedMessage;
      const vo = extractViewOnce(quoted);
      if (!vo) {
        return reply(sock, jid, msg, `❌ Kisi view-once photo/video/voice ke reply mein *${config.prefix}vv2* likhein.\n\n💡 *Tip:* View-once par seedha koi sticker ya word se reply karein — bina command likhe khud-ba-khud yourself mein aa jayega.`);
      }
      const { imgM, vidM, stM, audM } = vo;
      if (isOwner(sender) && !config.owner) return reply(sock, jid, msg, '❌ OWNER_NUMBER set nahi hai.');
      const wantSticker = /^(s|sticker)$/i.test(args[0] || '');
      try {
        const caption = `👁️ *View-once unlocked (vv2)*\n_— ${config.botName}_`;
        if (audM) {
          const buf = await downloadMediaMessage({ key: msg.key, message: { audioMessage: audM } }, 'buffer', {});
          await sendOwnerInbox(sock, sender, { audio: buf, ptt: true, mimetype: audM.mimetype || 'audio/ogg; codecs=opus' }, 'audio-ptt');
        } else if (stM) {
          const buf = await downloadMediaMessage({ key: msg.key, message: { stickerMessage: stM } }, 'buffer', {});
          await sendOwnerInbox(sock, sender, { sticker: buf }, 'sticker');
        } else if (wantSticker) {
          if (!imgM) return reply(sock, jid, msg, '❌ Sticker sirf view-once *photo* ka ban sakta hai.');
          const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: imgM } }, 'buffer', {});
          await sendOwnerInbox(sock, sender, { sticker: await imgToSticker(buf) }, 'sticker-from-photo');
        } else {
          const kind = imgM ? 'imageMessage' : 'videoMessage';
          const buf = await downloadMediaMessage({ key: msg.key, message: { [kind]: imgM || vidM } }, 'buffer', {});
          if (imgM) await sendOwnerInbox(sock, sender, { image: buf, caption }, 'image');
          else await sendOwnerInbox(sock, sender, { video: buf, caption }, 'video');
        }
        // bilkul khamosh — chat mein kuch nahi (Boss ka hukm)
      } catch {
        await reply(sock, jid, msg, '❌ View-once khol nahi saka, dobara try karein.');
      }
    },
  },

  mode: {
    desc: 'Bot mode: public ya self (owner) — quick: .self / .public',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const m = (args[0] || '').toLowerCase();
      if (m !== 'public' && m !== 'self') {
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}mode <public|self>* (ya seedha *${config.prefix}self* / *${config.prefix}public*)\n\npublic — sab use kar sakte hain\nself — sirf aap (connected number) use kar sakta hai\n\nMaujooda mode: *${MODE}*`);
      }
      MODE = m; STATE.mode = m; saveState();
      await reply(sock, jid, msg, m === 'self'
        ? '🔒 *Self mode ON* 💗\n\nAb sirf aap (connected number) commands use kar sakte ho. Baqi sab ke commands band hain.'
        : '🌐 *Public mode ON* 💗\n\nAb har koi commands use kar sakta hai.');
    },
  },

  self: {
    desc: 'Self mode ON: sirf owner (connected number) commands use kare (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      MODE = 'self'; STATE.mode = 'self'; saveState();
      await reply(sock, jid, msg, '🔒 *Self mode ON* 💗\n\nAb sirf aap (connected number) commands use kar sakte ho. Baqi sab ke commands band hain.');
    },
  },

  public: {
    desc: 'Public mode ON: har koi commands use kare (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      MODE = 'public'; STATE.mode = 'public'; saveState();
      await reply(sock, jid, msg, '🌐 *Public mode ON* 💗\n\nAb har koi commands use kar sakta hai.');
    },
  },

  power: {
    desc: 'Master switch: bot on/off — off ho to kisi ko koi reply nahi (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const m = (args[0] || '').toLowerCase();
      if (m === 'on' || m === 'off') {
        STATE.power = (m === 'on');
        saveState();
        writeGlobalSwitch('power', STATE.power); // 🌍 sab numbers par laagu
        await reply(sock, jid, msg, m === 'on'
          ? '🟢 *Bot ON* 💗\n\nAb bot normal kaam karega — sab ko replies jayenge.'
          : '🔴 *Bot OFF* 💗\n\nAb bot *kisi ko* koi reply/message nahi bhejega — na commands, na auto-AI, na welcome/goodbye.\nSirf tumhare (owner) commands chalenge.\n\nWapas on karne ke liye: *.power on*');
      } else {
        await reply(sock, jid, msg, `🔌 *Power switch*\n\nMaujooda haalat: *${globalPower() === false ? 'OFF 🔴' : 'ON 🟢'}*\n\n*${config.prefix}power on* — bot on karo\n*${config.prefix}power off* — bot bilkul khamosh (sirf owner)`);
      }
    },
  },

  // ─── owner spy: kaun user bot par kya kar raha hai ───
  activity: {
    desc: 'Recent bot activity: kaun ne kya command chalai (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      if (!ACT.length) return reply(sock, jid, msg, '📭 Abhi tak kisi ne koi command nahi chalai.');
      const n = Math.min(Math.max(parseInt(args[0]) || 15, 1), 50);
      const lines = ACT.slice(-n).reverse().map((e) => {
        const d = new Date(e.t);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const where = e.g === 'group' ? '👥 group' : '💬 private';
        return `⏰ ${hh}:${mm} · 📱 ${e.u} · .${e.c} · ${where}`;
      });
      await reply(sock, jid, msg, `📊 *Recent Activity* (aakhri ${lines.length})\n\n${lines.join('\n')}\n\n_Usage: ${config.prefix}activity 30_\n_⚡ NEXORA-MD_`);
    },
  },

  users: {
    desc: 'Bot use karne walon ki list (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      if (!ACT.length) return reply(sock, jid, msg, '📭 Abhi tak koi user nahi.');
      const m = new Map(); // u -> { n, last, cmd }
      for (const e of ACT) {
        const o = m.get(e.u) || { n: 0, last: 0, cmd: '' };
        o.n += 1;
        if (e.t >= o.last) { o.last = e.t; o.cmd = e.c; }
        m.set(e.u, o);
      }
      const lines = [...m.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .slice(0, 30)
        .map(([u, o]) => {
          const d = new Date(o.last);
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          return `📱 *${u}*\n   ⌨️ ${o.n} commands · aakhri: *.${o.cmd}* (${hh}:${mm})`;
        });
      await reply(sock, jid, msg, `👥 *Bot Users* (${m.size})\n\n${lines.join('\n\n')}\n\n_⚡ NEXORA-MD_`);
    },
  },

  // ─── 🔊🔳🌐 dhamakedaar utility ───
  say: {
    desc: 'Text ko awaz mein suno (voice note)',
    run: async (sock, msg, args, { jid }) => {
      let lang = 'ur', q = args.join(' ');
      const first = (args[0] || '').toLowerCase();
      if (first === 'en' || first === 'english') { lang = 'en'; q = args.slice(1).join(' '); }
      else if (first === 'ur' || first === 'urdu') { q = args.slice(1).join(' '); }
      if (!q.trim()) {
        return reply(sock, jid, msg,
          `❌ Usage: *${config.prefix}say <text>*\n` +
          `Masalan: ${config.prefix}say Assalam o Alaikum Boss\n` +
          `English awaz: ${config.prefix}say en Hello Boss`);
      }
      q = q.slice(0, 500);
      await reply(sock, jid, msg, '🔊 Awaz bana rahi hoon... 💗');
      const stamp = Date.now();
      const mp3p = `/tmp/say_${stamp}.mp3`, oggp = `/tmp/say_${stamp}.ogg`;
      try {
        // Google TTS: ek request mein ~200 chars — chunk karke joro
        const chunks = q.match(/[\s\S]{1,180}(?=\s|$)|[\s\S]{1,180}/g) || [q];
        const parts = [];
        for (const ch of chunks) {
          const url = 'https://translate.google.com/translate_tts?ie=UTF-8&q='
            + encodeURIComponent(ch) + `&tl=${lang}&client=tw-ob`;
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!r.ok) throw new Error('tts http ' + r.status);
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length < 500) throw new Error('tts empty');
          parts.push(b);
        }
        fs.writeFileSync(mp3p, Buffer.concat(parts));
        // WhatsApp voice note = ogg/opus
        await new Promise((res, rej) =>
          execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3p, '-c:a', 'libopus', '-b:a', '64k', oggp],
            { timeout: 30000 }, (e) => e ? rej(e) : res()));
        const ogg = fs.readFileSync(oggp);
        await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, '❌ Awaz nahi ban saki. Thodi der baad dobara try karo.');
      } finally {
        try { fs.unlinkSync(mp3p); } catch {}
        try { fs.unlinkSync(oggp); } catch {}
      }
    },
  },

  tr: {
    desc: 'Tarjuma: reply → Urdu, ya .tr en <text>',
    run: async (sock, msg, args, { jid }) => {
      let target = 'ur', q = '';
      const first = (args[0] || '').toLowerCase();
      if (['en', 'english'].includes(first)) { target = 'en'; q = args.slice(1).join(' '); }
      else if (['ur', 'urdu'].includes(first)) { target = 'ur'; q = args.slice(1).join(' '); }
      else if (['ar', 'arabic'].includes(first)) { target = 'ar'; q = args.slice(1).join(' '); }
      else q = args.join(' ');
      if (!q.trim()) {
        const qq = ctxOf(msg)?.quotedMessage;
        q = qq ? (qq.conversation || qq.extendedTextMessage?.text || qq.imageMessage?.caption || qq.videoMessage?.caption || '') : '';
      }
      if (!q.trim()) {
        return reply(sock, jid, msg,
          `❌ Kisi message ka *reply* karke ${config.prefix}tr likho (Urdu tarjuma)\n` +
          `Ya: *${config.prefix}tr en <text>* (English tarjuma)`);
      }
      q = q.slice(0, 450);
      try {
        const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + `&langpair=auto|${target}`;
        const r = await fetch(url);
        const d = await r.json();
        const out = d?.responseData?.translatedText;
        if (!out) throw new Error('no translation');
        const name = target === 'en' ? 'English' : target === 'ar' ? 'Arabic' : 'Urdu';
        await reply(sock, jid, msg, `🌐 *Tarjuma (${name}):*\n\n${out}`);
      } catch {
        await reply(sock, jid, msg, '❌ Tarjuma nahi ho saka. Dobara try karo.');
      }
    },
  },

  qr: {
    desc: 'Text/link ka QR code banao',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim();
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}qr <text ya link>*\nMasalan: ${config.prefix}qr https://google.com`);
      if (q.length > 800) return reply(sock, jid, msg, '❌ Itna lamba text QR mein nahi aayega (800 chars max).');
      try {
        const url = 'https://api.qrserver.com/v1/create-qr-code/?size=512x512&margin=12&data=' + encodeURIComponent(q);
        const r = await fetch(url);
        if (!r.ok) throw new Error('qr http ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        await sock.sendMessage(jid, { image: buf, caption: `🔳 *QR Code*\n\n📝 ${q.slice(0, 300)}` }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ QR nahi ban saka. Dobara try karo.');
      }
    },
  },

  qrread: {
    desc: 'QR photo ka reply → andar ka text parho',
    run: async (sock, msg, args, { jid }) => {
      const qm = ctxOf(msg)?.quotedMessage?.imageMessage;
      if (!qm) return reply(sock, jid, msg, `❌ Kisi *QR wali photo* ka reply karke ${config.prefix}qrread likho.`);
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: qm } }, 'buffer', {});
        if (!buf || !buf.length) throw new Error('no media');
        const fd = new FormData();
        fd.append('file', new Blob([buf], { type: 'image/jpeg' }), 'qr.jpg');
        const r = await fetch('https://api.qrserver.com/v1/read-qr-code/', { method: 'POST', body: fd });
        const d = await r.json();
        const out = d?.[0]?.symbol?.[0]?.data;
        if (!out) throw new Error('no data');
        await reply(sock, jid, msg, `🔳 *QR ke andar ye tha:*\n\n${out}`);
      } catch {
        await reply(sock, jid, msg, '❌ QR parha nahi gaya. Saaf aur qareebi photo bhejo.');
      }
    },
  },

  // ─── ✨ WOW commands ───

  imagine: {
    desc: 'AI se image banao',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ');
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}imagine <kya banana hai>*\nMasalan: ${config.prefix}imagine ek sher, neon city mein`);
      await genAIImage(sock, jid, msg, q, `🎨 *${q.slice(0, 100)}*\n_— ${config.botName} 💗_`);
    },
  },

  // .img: behtar quality — prompt ko pehle AI se enhance karwao, phir best model chain
  img: {
    desc: 'AI image — enhanced HD quality 🎨✨',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 300);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}img <kya banana hai>*\nMasalan: *${config.prefix}img baraf se dhaka pahar, suraj tulu*`);
      await reply(sock, jid, msg, '🎨✨ Prompt enhance kar rahi hoon, phir HD image banegi... 💗');
      let prompt = q;
      try {
        const enh = await askNexa(`You are an image prompt engineer. Rewrite this idea as ONE detailed English image prompt (max 60 words, no quotes, no preamble, just the prompt): "${q.slice(0, 200)}"`);
        if (enh && enh.trim().length > 10) prompt = enh.trim().replace(/^["'\s]+|["'\s]+$/g, '');
      } catch (e) { console.error('[img] enhance fail:', e.message); }
      await genAIImage(sock, jid, msg, prompt + ', ultra high quality, sharp details, vibrant, masterpiece', `🎨✨ *${q.slice(0, 100)}*\n_— ${config.botName} 💗_`);
    },
  },

  dp: {
    desc: 'Stylish AI DP banao',
    run: async (sock, msg, args, { jid }) => {
      const styles = ['cyberpunk neon portrait', 'aesthetic anime portrait', 'luxury golden portrait', 'dark cinematic portrait', 'futuristic warrior portrait', 'elegant royal portrait'];
      const style = styles[Math.floor(Math.random() * styles.length)];
      const extra = args.join(' ');
      const prompt = `stylish profile picture, ${style}${extra ? ', ' + extra : ''}, centered, high quality, square format`;
      await genAIImage(sock, jid, msg, prompt, `🖼️ *Tumhari nayi DP*\n_— ${config.botName} 💗_`);
    },
  },

  antidelete: {
    desc: 'Delete kiye gaye messages pakro (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const m = (args[0] || '').toLowerCase();
      if (m === 'on') {
        STATE.antidelete = true; saveState();
        return reply(sock, jid, msg, '🗑️ Anti-delete: ✅ ON');
      }
      if (m === 'off') {
        STATE.antidelete = false; saveState();
        return reply(sock, jid, msg, '🗑️ Anti-delete: ⛔ OFF');
      }
      return reply(sock, jid, msg, `🗑️ *Anti-delete*\n\nMaujooda: *${STATE.antidelete ? 'ON ✅' : 'OFF ❌'}*\nYaad mein: *${new Set([...msgCache.keys(), ...adTextCache.keys()]).size}* messages\n\nON karne ke liye: *${config.prefix}antidelete on*\n_Note: sirf "delete for everyone" pakra jata hai — jo message bot ke online hone ke baad aaya ho._`);
    },
  },

  tempmail: {
    desc: 'Ek temp email address banao',
    run: async (sock, msg, args, { jid }) => {
      const name = 'boxxa' + Math.floor(1000 + Math.random() * 9000);
      tempMailBox.set(jid, name);
      await reply(sock, jid, msg, `📧 *Temp email tayyar!*\n\n\`${name}@maildrop.cc\`\n\nMail check karne ke liye: *${config.prefix}inbox*\n_Address 24 ghante tak valid rehta hai._`);
    },
  },

  inbox: {
    desc: 'Temp email ke messages parho',
    run: async (sock, msg, args, { jid }) => {
      const box = tempMailBox.get(jid);
      if (!box) return reply(sock, jid, msg, `❌ Pehle *${config.prefix}tempmail* se address banao.`);
      await reply(sock, jid, msg, '📭 Inbox khol rahi hoon...');
      try {
        const res = await fetch('https://api.maildrop.cc/graphql', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: `{ inbox(mailbox:"${box}") { id headerfrom subject date } }` }),
        });
        const j = await res.json();
        const items = j?.data?.inbox || [];
        if (!items.length) return reply(sock, jid, msg, `📭 *${box}@maildrop.cc*\n\nInbox khaali hai. Mail aaye to dobara *${config.prefix}inbox* likhna.`);
        const last = items.slice(-5).reverse();
        let out = `📧 *${box}@maildrop.cc* — ${items.length} mails\n\n`;
        for (const it of last) {
          let body = '';
          try {
            const r2 = await fetch('https://api.maildrop.cc/graphql', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: `{ message(mailbox:"${box}", id:"${it.id}") { data } }` }),
            });
            const j2 = await r2.json();
            body = (j2?.data?.message?.data || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
          } catch {}
          out += `✉️ *${it.subject || '(no subject)'}\n*From:* ${it.headerfrom}\n${body}\n\n`;
        }
        await reply(sock, jid, msg, out.slice(0, 3500));
      } catch {
        await reply(sock, jid, msg, '❌ Inbox nahi khul saka, dobara try karein.');
      }
    },
  },

  aichat: {
    desc: 'Auto AI reply: on/off/auto/test (har koi)',
    run: async (sock, msg, args, { jid }) => {
      const m = (args[0] || '').toLowerCase();
      if (!STATE.aichat || typeof STATE.aichat !== 'object' || Array.isArray(STATE.aichat)) STATE.aichat = {};
      const cur = STATE.aichat[jid];
      const curTxt = cur === 'on' ? 'ON ✅ (har msg ka jawab)' : cur === 'off' ? 'OFF ⛔' : cur === 'auto' ? 'AUTO 🤖 (unknown number par khud on hua)' : 'SMART AUTO 🤖 (unknown number par khud on hoga)';
      if (m === 'on') {
        STATE.aichat[jid] = 'on';
        saveState();
        writeGlobalAichat(jid, 'on'); // 🌍 sab numbers par laagu
        return reply(sock, jid, msg, '🤖 AI chat: ✅ ON\n_(sab numbers par)_');
      }
      if (m === 'off') {
        STATE.aichat[jid] = 'off';
        if (STATE.aihist) delete STATE.aihist[jid];
        saveState();
        writeGlobalAichat(jid, 'off'); // 🌍 sab numbers par laagu
        return reply(sock, jid, msg, '🤖 AI chat: ⛔ OFF\n_(sab numbers par — ab koi jawab nahi jayega)_');
      }
      if (m === 'auto') {
        delete STATE.aichat[jid];
        saveState();
        writeGlobalAichat(jid, null); // 🌍 global se hatao → smart auto
        return reply(sock, jid, msg, '🤖 AI chat: 🔄 AUTO');
      }
      if (m === 'test') {
        const t = args.slice(1).join(' ').trim();
        if (!t) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}aichat test <message>*\n\nMisal: *${config.prefix}aichat test kese ho*`);
        const hist = (STATE.aihist && STATE.aihist[jid] ? STATE.aihist[jid] : []).slice(-10);
        const ans = await askBossChat(t, hist);
        if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi aaya, dobara try karein.');
        return reply(sock, jid, msg, `🧪 *Test reply:*\n\n"${t}"\n↓\n${ans}\n\n_(Ye wahi jawab hai jo samne wale ko milta)_`);
      }
      return reply(sock, jid, msg, `❌ Usage: *${config.prefix}aichat <on|off|auto|test>*\n\nMaujooda: *${curTxt}*\n\n• *on* — har msg ka jawab\n• *off* — bilkul band\n• *auto* — smart mode (unknown number par khud on)\n• *test <msg>* — AI jawab test karo`);
    },
  },

  aiauto: {
    desc: 'AI auto-reply global on/off — unknown numbers ko khud jawab (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const m = (args[0] || '').toLowerCase();
      if (m === 'on') {
        STATE.aiauto = true; saveState();
        writeGlobalSwitch('aiauto', true); // 🌍 sab numbers par laagu
        return reply(sock, jid, msg, '🤖 *AI auto-reply: ✅ ON* 💗\n\nAb unknown numbers ko phir se khud AI jawab jayega.');
      }
      if (m === 'off') {
        STATE.aiauto = false;
        writeGlobalSwitch('aiauto', false); // 🌍 sab numbers par laagu
        // pehle se auto-active chats bhi khamosh (explicit on/off wale barkarar)
        if (STATE.aichat && typeof STATE.aichat === 'object') {
          for (const k of Object.keys(STATE.aichat)) if (STATE.aichat[k] === 'auto') delete STATE.aichat[k];
        }
        saveState();
        return reply(sock, jid, msg, '🤖 *AI auto-reply: ⛔ OFF* 💗\n\nAb kisi unknown number ko khud AI jawab *nahi* jayega.\n✅ Commands sab ke liye chalte rahenge.\n✅ Jin chats mein tumne khud *.aichat on* kiya hai, wahan jawab aata rahega.\n\nWapas on: *.aiauto on*');
      }
      return reply(sock, jid, msg, `🤖 *AI auto-reply*\n\nMaujooda: *${globalAiauto() === false ? 'OFF ⛔' : 'ON ✅'}*\n\n*${config.prefix}aiauto on* — unknown ko khud jawab\n*${config.prefix}aiauto off* — sirf commands, koi auto AI jawab nahi`);
    },
  },

  poll: {
    desc: 'Asli WhatsApp poll banao',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length < 3) {
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}poll <sawal> | <option1> | <option2> [| option3...]*\n\nMasalan:\n${config.prefix}poll Chai ya coffee? | Chai ☕ | Coffee ☕`);
      }
      const [name, ...values] = parts;
      if (values.length > 12) return reply(sock, jid, msg, '❌ Zyada se zyada 12 options.');
      await sock.sendMessage(jid, { poll: { name: name.slice(0, 300), values: values.map((v) => v.slice(0, 100)), selectableCount: 1 } });
    },
  },

  weather: {
    desc: 'Kisi sheher ka mausam',
    run: async (sock, msg, args, { jid }) => {
      const city = args.join(' ');
      if (!city) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}weather <sheher>*\nMasalan: ${config.prefix}weather Lahore`);
      try {
        const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city) + '&count=1')).json();
        const loc = g?.results?.[0];
        if (!loc) return reply(sock, jid, msg, '❌ Sheher nahi mila.');
        const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`)).json();
        const c = w?.current || {};
        const d = w?.daily || {};
        const WMO = {
          0: '☀️ Saaf aasmaan', 1: '🌤️ Halke badal', 2: '⛅ Badal chhaye', 3: '☁️ Ghane badal',
          45: '🌫️ Dhund', 48: '🌫️ Ghani dhund',
          51: '🌦️ Halki boonda-bandi', 53: '🌦️ Halki boonda-bandi', 55: '🌦️ Halki boonda-bandi', 56: '🌦️ Halki barish', 57: '🌦️ Halki barish',
          61: '🌧️ Barish', 63: '🌧️ Barish', 65: '🌧️ Barish', 66: '🌧️ Barish', 67: '🌧️ Barish',
          71: '🌨️ Barf-bari', 73: '🌨️ Barf-bari', 75: '🌨️ Barf-bari', 77: '🌨️ Barf-bari',
          80: '🌧️ Tez barish', 81: '🌧️ Tez barish', 82: '🌧️ Tez barish',
          95: '⛈️ Toofan', 96: '⛈️ Toofan', 99: '⛈️ Toofan',
        };
        const desc = WMO[c.weather_code] || '🌡️';
        const tmax = d.temperature_2m_max?.[0], tmin = d.temperature_2m_min?.[0], pp = d.precipitation_probability_max?.[0];
        const out =
          `🌦️ *${loc.name}, ${loc.country}*\n\n${desc}\n` +
          `🌡️ Abhi: *${c.temperature_2m}°C*` + (tmax != null ? ` (Max ${tmax}° / Min ${tmin}°)` : '') + `\n` +
          (pp != null ? `🌧️ Barish ka chance: *${pp}%*\n` : '') +
          `💧 Nami: ${c.relative_humidity_2m}%\n💨 Hawa: ${c.wind_speed_10m} km/h`;
        await sendCard(sock, jid, msg, 'MAUSAM', [
          ['Sheher', `${loc.name}`],
          ['Halat', noEm(desc) || '—'],
          ['Darja', `${c.temperature_2m}°C`],
          ['Max / Min', tmax != null ? `${tmax}° / ${tmin}°` : '—'],
          ['Barish chance', pp != null ? `${pp}%` : '—'],
          ['Nami', `${c.relative_humidity_2m}%`],
          ['Hawa', `${c.wind_speed_10m} km/h`],
        ], { sub: loc.country || '', accent: '#50E8F4' }, out);
      } catch {
        await reply(sock, jid, msg, '❌ Mausam nahi mil saka, dobara try karein.');
      }
    },
  },

  shorten: {
    desc: 'Lamba link chota karo',
    run: async (sock, msg, args, { jid }) => {
      const url = (args[0] || '').trim();
      if (!/^https?:\/\//i.test(url)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}shorten <link>*\nMasalan: ${config.prefix}shorten https://google.com`);
      try {
        const res = await fetch('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(url));
        const short = (await res.text()).trim();
        if (!short.startsWith('http')) throw new Error('x');
        await reply(sock, jid, msg, `🔗 *Short link:*\n${short}`);
      } catch {
        await reply(sock, jid, msg, '❌ Link chota nahi ho saka.');
      }
    },
  },

  lyrics: {
    desc: 'Gaane ke bol nikalo',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ');
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}lyrics <gaane ka naam>*\nMasalan: ${config.prefix}lyrics pasoori`);
      await reply(sock, jid, msg, '🎵 Dhoond raha hoon...');
      try {
        const s = await (await fetch('https://api.lyrics.ovh/suggest/' + encodeURIComponent(q))).json();
        const hit = s?.data?.[0];
        if (!hit) return reply(sock, jid, msg, '❌ Gaana nahi mila.');
        const l = await (await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(hit.artist.name)}/${encodeURIComponent(hit.title)}`)).json();
        if (!l?.lyrics) return reply(sock, jid, msg, '❌ Lyrics nahi mile.');
        await reply(sock, jid, msg, `🎵 *${hit.title}* — ${hit.artist.name}\n\n${l.lyrics.slice(0, 3500)}`);
      } catch {
        await reply(sock, jid, msg, '❌ Lyrics nahi mil sake, dobara try karein.');
      }
    },
  },

  vcf: {
    desc: 'Group ke saare contacts ek file mein',
    run: async (sock, msg, args, { jid }) => {
      if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf group mein chalti hai.');
      try {
        const meta = await sock.groupMetadata(jid);
        const parts = meta.participants || [];
        if (!parts.length) return reply(sock, jid, msg, '❌ Members nahi mile.');
        let v = '';
        parts.forEach((p, i) => {
          v += `BEGIN:VCARD\nVERSION:3.0\nFN:${meta.subject || 'Group'} - ${i + 1}\nTEL;TYPE=CELL:+${num(p.id)}\nEND:VCARD\n`;
        });
        await sock.sendMessage(jid, {
          document: Buffer.from(v), mimetype: 'text/vcard',
          fileName: `${(meta.subject || 'group').replace(/[^\w\- ]/g, '')}-contacts.vcf`,
          caption: `👥 *${parts.length} contacts* — ${meta.subject || ''}`,
        }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ Contacts nahi nikal sake.');
      }
    },
  },

  tomp3: {
    desc: 'Reply wali video/audio → MP3',
    run: async (sock, msg, args, { jid }) => {
      const q = ctxOf(msg)?.quotedMessage;
      const media = q?.videoMessage || q?.audioMessage;
      if (!media) return reply(sock, jid, msg, `❌ Kisi video ya audio ke reply mein *${config.prefix}tomp3* likhein.`);
      await reply(sock, jid, msg, '🎵 MP3 ban raha hai...');
      const tmp = `/tmp/tomp3-${Date.now()}`;
      const inExt = q.videoMessage ? 'mp4' : 'ogg';
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: q.videoMessage ? { videoMessage: media } : { audioMessage: media } }, 'buffer', {});
        fs.writeFileSync(`${tmp}.${inExt}`, buf);
        await new Promise((res, rej) => {
          require('child_process').execFile('ffmpeg', ['-y', '-i', `${tmp}.${inExt}`, '-vn', '-b:a', '128k', `${tmp}.mp3`], (e) => (e ? rej(e) : res()));
        });
        const out = fs.readFileSync(`${tmp}.mp3`);
        await sock.sendMessage(jid, { audio: out, mimetype: 'audio/mpeg', fileName: 'audio.mp3' }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ MP3 nahi ban saka.');
      } finally {
        try { fs.unlinkSync(`${tmp}.${inExt}`); } catch {}
        try { fs.unlinkSync(`${tmp}.mp3`); } catch {}
      }
    },
  },

short: {
  desc: 'Link chhota karo',
  run: async (sock, msg, args, { jid, sender }) => {
    const link = args[0];
    if (!link) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}short <link>*`);
    try {
      let tiny = '';
      try {
        const r1 = await fetch(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(link)}`, { signal: AbortSignal.timeout(15000) });
        const t1 = (await r1.text()).trim();
        if (r1.ok && t1.startsWith('http') && !t1.startsWith('Error:')) tiny = t1;
      } catch (e) { /* fallback neeche */ }
      if (!tiny) {
        const r2 = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(link)}`, { signal: AbortSignal.timeout(15000) });
        const t2 = (await r2.text()).trim();
        if (r2.ok && t2.startsWith('http')) tiny = t2;
      }
      if (!tiny) return reply(sock, jid, msg, '❌ Link chhota nahi ho saka, thodi der baad dobara koshish karo.');
      return reply(sock, jid, msg, `🔗 *Chhota link:*\n${tiny}`);
    } catch (e) {
      return reply(sock, jid, msg, '❌ Link chhota nahi ho saka, thodi der baad dobara koshish karo.');
    }
  },
},
currency: {
  desc: 'Currency convert karo',
  run: async (sock, msg, args, { jid, sender }) => {
    const input = args.join(' ');
    const m = input.match(/^(\d+(?:\.\d+)?)?\s*([a-zA-Z]{3})\s+to\s+([a-zA-Z]{3})$/i);
    if (!m) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}currency <amount> <FROM> to <TO>*\nMasalan: *${config.prefix}currency 100 USD to PKR*`);
    try {
      const amount = m[1] ? parseFloat(m[1]) : 1;
      const FROM = m[2].toUpperCase();
      const TO = m[3].toUpperCase();
      const r = await fetch(`https://open.er-api.com/v6/latest/${FROM}`, { signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      if (d.result !== 'success' || !d.rates || typeof d.rates[TO] !== 'number') {
        return reply(sock, jid, msg, '❌ Currency code ghalat hai ya rate nahi mila.');
      }
      const rate = d.rates[TO];
      const total = amount * rate;
      const fmt = (n, dec) => n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
      return reply(sock, jid, msg, `💱 *${fmt(amount, 0)} ${FROM}* = *${fmt(total, 2)} ${TO}*\n📊 1 ${FROM} = ${fmt(rate, 2)} ${TO}`);
    } catch (e) {
      return reply(sock, jid, msg, '❌ Rate hasil nahi ho saka, thodi der baad dobara koshish karo.');
    }
  },
},
prayer: {
  desc: 'Namaz ke auqaat',
  run: async (sock, msg, args, { jid, sender }) => {
    try {
      const city = args.join(' ').trim() || 'Lahore';
      const n = new Date();
      const today = `${String(n.getDate()).padStart(2, '0')}-${String(n.getMonth() + 1).padStart(2, '0')}-${n.getFullYear()}`;
      const r = await fetch(`https://api.aladhan.com/v1/timingsByCity/${today}?city=${encodeURIComponent(city)}&country=Pakistan&method=1`, { signal: AbortSignal.timeout(15000) });
      const d = await r.json();
      if (d.code !== 200 || !d.data || !d.data.timings) {
        return reply(sock, jid, msg, '❌ Sheher ka naam check karo aur dobara koshish karo.');
      }
      const t = d.data.timings;
      const hh = (s) => String(s || '').slice(0, 5);
      const out = `🕌 *Namaz ke auqaat — ${city}*\n📅 ${today}\n\n🌅 Fajr: ${hh(t.Fajr)}\n☀️ Sunrise: ${hh(t.Sunrise)}\n🌞 Dhuhr: ${hh(t.Dhuhr)}\n🌤️ Asr: ${hh(t.Asr)}\n🌇 Maghrib: ${hh(t.Maghrib)}\n🌙 Isha: ${hh(t.Isha)}`;
      return reply(sock, jid, msg, out);
    } catch (e) {
      return reply(sock, jid, msg, '❌ Auqaat hasil nahi ho sake, thodi der baad dobara koshish karo.');
    }
  },
},
password: {
  desc: 'Mazboot password banao',
  run: async (sock, msg, args, { jid, sender }) => {
    try {
      let len = parseInt(args[0], 10);
      if (isNaN(len)) len = 16;
      if (len < 4) len = 4;
      if (len > 64) len = 64;
      const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
      let pwd = '';
      for (let i = 0; i < len; i++) pwd += charset[crypto.randomInt(0, charset.length)];
      return reply(sock, jid, msg, `🔐 *Mazboot password (${len} lafz):*\n\`${pwd}\``);
    } catch (e) {
      return reply(sock, jid, msg, '❌ Password nahi ban saka, dobara koshish karo.');
    }
  },
},
news: {
  desc: 'Taaza khabrein',
  run: async (sock, msg, args, { jid, sender }) => {
    try {
      const grab = async (url) => {
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return null;
        return r.text();
      };
      let xml = await grab('https://news.google.com/rss?hl=en-PK&gl=PK&ceid=PK:en');
      if (!xml || !xml.includes('<item>')) {
        xml = await grab('https://feeds.bbci.co.uk/news/rss.xml');
      }
      if (!xml || !xml.includes('<item>')) {
        return reply(sock, jid, msg, '❌ Khabrein hasil nahi ho sakin, thodi der baad dobara koshish karo.');
      }
      const titles = [];
      const re = /<item>[\s\S]*?<title>(.*?)<\/title>/g;
      let mm;
      while ((mm = re.exec(xml)) !== null && titles.length < 5) {
        let t = mm[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
        if (t) titles.push(t);
      }
      if (!titles.length) return reply(sock, jid, msg, '❌ Khabrein hasil nahi ho sakin, thodi der baad dobara koshish karo.');
      return reply(sock, jid, msg, `📰 *Taaza khabrein:*\n\n` + titles.map((t) => `📰 ${t}`).join('\n\n'));
    } catch (e) {
      return reply(sock, jid, msg, '❌ Khabrein hasil nahi ho sakin, thodi der baad dobara koshish karo.');
    }
  },
},
define: {
  desc: 'Lafz ka matlab',
  run: async (sock, msg, args, { jid, sender }) => {
    const word = args[0];
    if (!word) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}define <lafz>*`);
    try {
      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`;
      let r = null;
      for (let a = 0; a < 2; a++) {
        try {
          r = await fetch(url, { signal: AbortSignal.timeout(45000) });
          if (r.status === 522) { r = null; continue; }
          break;
        } catch (e) { r = null; }
      }
      if (!r || !r.ok) return reply(sock, jid, msg, '❌ Is lafz ka matlab nahi mila.');
      let d;
      try { d = await r.json(); } catch (e) { return reply(sock, jid, msg, '❌ Is lafz ka matlab nahi mila.'); }
      if (!Array.isArray(d) || !d[0] || !d[0].meanings || !d[0].meanings[0]) {
        return reply(sock, jid, msg, '❌ Is lafz ka matlab nahi mila.');
      }
      const entry = d[0];
      const def = entry.meanings[0].definitions[0] || {};
      let out = `📖 *${entry.word || word}*`;
      if (entry.phonetic) out += ` (${entry.phonetic})`;
      out += `\n_${entry.meanings[0].partOfSpeech || ''}_`;
      out += `\n\n💡 ${def.definition || 'Matlab nahi mila.'}`;
      if (def.example) out += `\n\n📝 Masalan: _${def.example}_`;
      return reply(sock, jid, msg, out.trim());
    } catch (e) {
      return reply(sock, jid, msg, '❌ Is lafz ka matlab nahi mila.');
    }
  },
},
github: {
  desc: 'GitHub profile dekho',
  run: async (sock, msg, args, { jid, sender }) => {
    const user = args[0];
    if (!user) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}github <username>*`);
    try {
      const r = await fetch(`https://api.github.com/users/${encodeURIComponent(user)}`, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'NEXORA-MD' },
      });
      if (r.status === 404) return reply(sock, jid, msg, '❌ Ye GitHub user nahi mila.');
      const d = await r.json();
      if (d.message === 'Not Found' || !d.login) return reply(sock, jid, msg, '❌ Ye GitHub user nahi mila.');
      const out = `🐙 *GitHub — ${d.login}*\n\n👤 Naam: ${d.name || '—'}\n📝 Bio: ${d.bio || '—'}\n📍 Jagah: ${d.location || '—'}\n📦 Repos: ${d.public_repos ?? '—'}\n👥 Followers: ${d.followers ?? '—'} | Following: ${d.following ?? '—'}\n🔗 ${d.html_url || ''}`;
      return reply(sock, jid, msg, out.trim());
    } catch (e) {
      return reply(sock, jid, msg, '❌ Profile hasil nahi ho saka, thodi der baad dobara koshish karo.');
    }
  },
},
calc: {
  desc: 'Hisab karo',
  run: async (sock, msg, args, { jid, sender }) => {
    const expr = args.join(' ');
    if (!expr) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}calc <expression>*\nMasalan: *${config.prefix}calc 12*8+5*`);
    if (!/^[0-9+\-*/().%^ \t]+$/.test(expr)) {
      return reply(sock, jid, msg, '❌ Sirf numbers aur +, -, *, /, %, ^, ( ) allowed hain.');
    }
    try {
      const js = expr.replace(/\^/g, '**');
      const result = Function('"use strict"; return (' + js + ')')();
      if (typeof result !== 'number' || !isFinite(result)) {
        return reply(sock, jid, msg, '❌ Hisab ghalat hai, dobara likho.');
      }
      return reply(sock, jid, msg, `🧮 *${expr}* = *${result}*`);
    } catch (e) {
      return reply(sock, jid, msg, '❌ Hisab ghalat hai, dobara likho.');
    }
  },
},

  rhyme: {
    desc: 'Qafiya dhoondo',
    run: async (sock, msg, args, { jid, sender }) => {
      const word = args.join(' ').trim();
      if (!word) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}rhyme <lafz>*`);
      try {
        const res = await fetch(`https://api.datamuse.com/words?rel_rhy=${encodeURIComponent(word)}&max=15`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error('API error');
        const data = await res.json();
        if (!Array.isArray(data) || !data.length) return reply(sock, jid, msg, `😅 *"${word}"* ke qafiye nahi mile. Koi aur lafz try karo.`);
        const list = data.slice(0, 12).map(w => `• ${w.word}`).join('\n');
        await reply(sock, jid, msg, `✍️ *"${word}"* ke qafiye:\n${list}`);
      } catch (e) {
        await reply(sock, jid, msg, `😞 Qafiya service se rabta nahi ho saka. Thori der baad try karo.`);
      }
    },
  },
  ship: {
    desc: 'Love percentage',
    run: async (sock, msg, args, { jid, sender }) => {
      const raw = args.join(' ').trim();
      const parts = raw.split('|').map(s => s.trim()).filter(Boolean);
      if (parts.length < 2) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}ship <naam1> | <naam2>*`);
      const [a, b] = parts;
      const key = [a.toLowerCase(), b.toLowerCase()].sort().join('❤');
      let h = 0;
      for (const ch of key) h = (h * 31 + ch.codePointAt(0)) >>> 0;
      const pct = 40 + (h % 61);
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      let verdict = '💔 Bas dost hi ache ho…';
      if (pct >= 90) verdict = '💍 Shadi pakki samjho!';
      else if (pct >= 75) verdict = '💘 Kya baat hai, jodi kamaal!';
      else if (pct >= 60) verdict = '💖 Chemistry to hai!';
      else if (pct >= 50) verdict = '🙂 Guzara ho jayega…';
      await suspense(sock, jid, msg, '💘 Dilon ke taar jod rahi hoon... 💗');
      await reply(sock, jid, msg, `💞 *Love Ship*\n\n*${a}* ❤️ *${b}*\n\n${bar} *${pct}%*\n\n${verdict}\n\n— NEXORA-MD 💗`);
    },
  },
  country: {
    desc: 'Mulk ki maloomat',
    run: async (sock, msg, args, { jid, sender }) => {
      const q = args.join(' ').trim();
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}country <mulk>*`);
      try {
        const res = await fetch('https://api.sampleapis.com/countries/countries', { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error('API error');
        const list = await res.json();
        const ql = q.toLowerCase();
        const c = list.find(x => (x.name || '').toLowerCase() === ql)
          || list.find(x => (x.abbreviation || '').toLowerCase() === ql)
          || list.find(x => (x.name || '').toLowerCase().includes(ql));
        if (!c) return reply(sock, jid, msg, `😅 "${q}" naam ka mulk nahi mila. Spelling check karo.`);
        const flagEmoji = (c.abbreviation || '').toUpperCase().split('').map(ch => {
          const code = ch.charCodeAt(0);
          return (code >= 65 && code <= 90) ? String.fromCodePoint(0x1F1E6 + code - 65) : ch;
        }).join('');
        const pop = c.population != null ? Number(c.population).toLocaleString('en-US') : 'Maloom nahi';
        await reply(sock, jid, msg, `${flagEmoji} *${c.name}*\n\n🏙️ Darul-hukumat: ${c.capital || '—'}\n👥 Abadi: ${pop}\n💰 Currency: ${c.currency || '—'}\n📞 Dial code: ${c.phone ? '+' + c.phone : '—'}`);
      } catch (e) {
        await reply(sock, jid, msg, `😞 Mulk ki maloomat nahi mil saki. Thori der baad try karo.`);
      }
    },
  },
  recipe: {
    desc: 'Dish ki recipe',
    run: async (sock, msg, args, { jid, sender }) => {
      const dish = args.join(' ').trim();
      if (!dish) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}recipe <dish>*`);
      try {
        const res = await fetch(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(dish)}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error('API error');
        const data = await res.json();
        if (!data.meals || !data.meals.length) return reply(sock, jid, msg, `😅 "${dish}" ki recipe nahi mili. Koi aur dish try karo.`);
        const m = data.meals[0];
        const ings = [];
        for (let i = 1; i <= 20; i++) {
          const ing = (m['strIngredient' + i] || '').trim();
          const mea = (m['strMeasure' + i] || '').trim();
          if (ing) ings.push(`• ${ing}${mea ? ' — ' + mea : ''}`);
        }
        const caption = `🍽️ *${m.strMeal}*\n\n📂 Category: ${m.strCategory || '—'} | 🌍 ${m.strArea || '—'}\n\n🧂 *Ajza (${ings.length}):*\n${ings.slice(0, 14).join('\n')}${ings.length > 14 ? `\n…aur ${ings.length - 14} mazeed` : ''}\n\n📝 *Tarkeeb:*\n${(m.strInstructions || '—').slice(0, 1200)}\n\n— NEXORA-MD 💗`;
        try {
          const ir = await fetch(m.strMealThumb, { signal: AbortSignal.timeout(20000) });
          if (ir.ok) {
            const buf = Buffer.from(await ir.arrayBuffer());
            await sock.sendMessage(jid, { image: buf, caption }, { quoted: msg });
            return;
          }
        } catch (e) {}
        await reply(sock, jid, msg, caption);
      } catch (e) {
        await reply(sock, jid, msg, `😞 Recipe service se rabta nahi ho saka. Thori der baad try karo.`);
      }
    },
  },
  iss: {
    desc: 'ISS ki live location',
    run: async (sock, msg, args, { jid, sender }) => {
      try {
        const res = await fetch('http://api.open-notify.org/iss-now.json', { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error('API error');
        const data = await res.json();
        const lat = data.iss_position.latitude;
        const lon = data.iss_position.longitude;
        await reply(sock, jid, msg, `🛰️ *ISS abhi yahan hai:*\n🌍 Lat: ${lat}\n🌍 Lon: ${lon}`);
        await sock.sendMessage(jid, { location: { degreesLatitude: parseFloat(lat), degreesLongitude: parseFloat(lon) } }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, `😞 ISS ki location nahi mil saki. Thori der baad try karo.`);
      }
    },
  },
  // (purana opentdb quiz hata diya 2026-09-23 — naya scored Roman Urdu quiz upar hai)
  // (crypto: naya CoinGecko markets version neeche "14 naye commands" block mein hai — 2026-09-23)

slap: {
  desc: 'Anime slap gif',
  run: async (sock, msg, args, { jid }) => {
    try {
      let gif = '';
      const apis = [
        'https://api.waifu.pics/sfw/slap',
        'https://api.otakugifs.xyz/gif?reaction=slap',
        'https://nekos.life/api/v2/img/slap',
      ];
      for (const api of apis) {
        try {
          const res = await fetch(api, { signal: AbortSignal.timeout(15000) });
          if (!res.ok) continue;
          const d = await res.json();
          if (d && d.url && /^https?:\/\//.test(d.url)) { gif = d.url; break; }
        } catch { /* agli API try karo */ }
      }
      if (!gif) throw new Error('no gif');
      await sock.sendMessage(jid, { video: { url: gif }, gifPlayback: true, caption: '💥 *SLAP!*' }, { quoted: msg });
    } catch (e) {
      await reply(sock, jid, msg, '❌ Slap GIF nahi mili, thori der baad ' + config.prefix + 'slap dobara try karein.');
    }
  },
},
nokia: {
  desc: 'Nokia meme with profile pic',
  run: async (sock, msg, args, { jid, sender }) => {
    try {
      let pic = null;
      const ctx = ctxOf(msg);
      const qp = ctx && ctx.participant ? ctx.participant : null;
      if (qp) { try { pic = await sock.profilePictureUrl(qp, 'image'); } catch {} }
      if (!pic) { try { pic = await sock.profilePictureUrl(sender, 'image'); } catch {} }
      if (!pic) return await reply(sock, jid, msg, '❌ Profile photo nahi mili.');
      const res = await fetch('https://api.popcat.xyz/nokia?image=' + encodeURIComponent(pic), { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error('API ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      await sock.sendMessage(jid, { image: buf, caption: '📱 *Nokia meme*' }, { quoted: msg });
    } catch (e) {
      await reply(sock, jid, msg, '❌ Nokia meme banane mein masla hua, dobara try karein.');
    }
  },
},
drake: {
  desc: 'Drake meme (upar | neeche)',
  run: async (sock, msg, args, { jid }) => {
    const text = args.join(' ');
    const parts = text.split('|');
    if (parts.length < 2 || !parts[0].trim() || !parts[1].trim()) {
      return await reply(sock, jid, msg, '❌ Usage: *' + config.prefix + 'drake <upar> | <neeche>*');
    }
    try {
      const url = 'https://api.popcat.xyz/drake?text1=' + encodeURIComponent(parts[0].trim()) + '&text2=' + encodeURIComponent(parts[1].trim());
      const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error('API ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      await sock.sendMessage(jid, { image: buf, caption: '😎 *Drake meme*' }, { quoted: msg });
    } catch (e) {
      await reply(sock, jid, msg, '❌ Meme banane mein masla hua, dobara try karein.');
    }
  },
},
nightcore: {
  desc: 'Audio ko nightcore speed mein badlein',
  run: async (sock, msg, args, { jid }) => {
    const q = ctxOf(msg)?.quotedMessage?.audioMessage || msg.message?.audioMessage;
    if (!q) return await reply(sock, jid, msg, '❌ Kisi voice note ya audio ke reply mein *' + config.prefix + 'nightcore* likhein.');
    const rand = crypto.randomBytes(6).toString('hex');
    const inp = '/tmp/nc_' + rand + '.ogg';
    const out = '/tmp/nc_' + rand + '.mp3';
    try {
      await reply(sock, jid, msg, '⏳ Nightcore bana rahi hoon... 🎵');
      const buf = await downloadMediaMessage({ key: msg.key, message: { audioMessage: q } }, 'buffer', {});
      fs.writeFileSync(inp, buf);
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-y', '-i', inp, '-filter:a', 'atempo=1.25,asetrate=44100*1.25,aresample=44100', '-c:a', 'libmp3lame', '-q:a', '4', out], { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(err); else resolve({ stdout, stderr });
        });
      });
      await sock.sendMessage(jid, { audio: fs.readFileSync(out), mimetype: 'audio/mpeg' }, { quoted: msg });
    } catch (e) {
      await reply(sock, jid, msg, '❌ Nightcore banane mein masla hua. Audio lambi ya kharab to nahi?');
    } finally {
      try { fs.unlinkSync(inp); } catch {}
      try { fs.unlinkSync(out); } catch {}
    }
  },
},
slowed: {
  desc: 'Audio ko slowed + reverb mein badlein',
  run: async (sock, msg, args, { jid }) => {
    const q = ctxOf(msg)?.quotedMessage?.audioMessage || msg.message?.audioMessage;
    if (!q) return await reply(sock, jid, msg, '❌ Kisi voice note ya audio ke reply mein *' + config.prefix + 'slowed* likhein.');
    const rand = crypto.randomBytes(6).toString('hex');
    const inp = '/tmp/sl_' + rand + '.ogg';
    const out = '/tmp/sl_' + rand + '.mp3';
    try {
      await reply(sock, jid, msg, '⏳ Slowed + reverb bana rahi hoon... 🎧');
      const buf = await downloadMediaMessage({ key: msg.key, message: { audioMessage: q } }, 'buffer', {});
      fs.writeFileSync(inp, buf);
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-y', '-i', inp, '-filter:a', 'atempo=0.8,aecho=0.8:0.9:1000:0.3,aresample=44100', '-c:a', 'libmp3lame', '-q:a', '4', out], { timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(err); else resolve({ stdout, stderr });
        });
      });
      await sock.sendMessage(jid, { audio: fs.readFileSync(out), mimetype: 'audio/mpeg' }, { quoted: msg });
    } catch (e) {
      await reply(sock, jid, msg, '❌ Slowed audio banane mein masla hua. Audio lambi ya kharab to nahi?');
    } finally {
      try { fs.unlinkSync(inp); } catch {}
      try { fs.unlinkSync(out); } catch {}
    }
  },
},
mock: {
  desc: 'Spongebob mocking text',
  run: async (sock, msg, args, { jid }) => {
    const text = args.join(' ');
    if (!text.trim()) return await reply(sock, jid, msg, '❌ Usage: *' + config.prefix + 'mock <text>*');
    try {
      let li = 0, out = '';
      for (const ch of text) {
        if (/[a-zA-Z]/.test(ch)) { out += (li % 2 === 0) ? ch.toLowerCase() : ch.toUpperCase(); li++; }
        else out += ch;
      }
      await reply(sock, jid, msg, out);
    } catch (e) {
      await reply(sock, jid, msg, '❌ Mock text banane mein masla hua.');
    }
  },
},
clap: {
  desc: 'Clap emoji words',
  run: async (sock, msg, args, { jid }) => {
    const text = args.join(' ');
    if (!text.trim()) return await reply(sock, jid, msg, '❌ Usage: *' + config.prefix + 'clap <text>*');
    try {
      const words = text.split(/\s+/).filter(Boolean);
      await reply(sock, jid, msg, '👏 ' + words.join(' 👏 ') + ' 👏');
    } catch (e) {
      await reply(sock, jid, msg, '❌ Clap text banane mein masla hua.');
    }
  },
},
slot: {
  desc: 'Slot machine game',
  run: async (sock, msg, args, { jid }) => {
    try {
      const R = ['🍒', '🍋', '⭐', '💎', '7️⃣', '🍇'];
      const a = R[Math.floor(Math.random() * R.length)];
      const b = R[Math.floor(Math.random() * R.length)];
      const c = R[Math.floor(Math.random() * R.length)];
      const caption = (a === b && b === c) ? '🎰 *JACKPOT!* 🎉\n🎰 | ' + a + ' | ' + b + ' | ' + c + ' |' : '🎰 | ' + a + ' | ' + b + ' | ' + c + ' |';
      await reply(sock, jid, msg, caption);
    } catch (e) {
      await reply(sock, jid, msg, '❌ Slot machine kharab ho gayi, dobara try karein.');
    }
  },
},
yesno: {
  desc: 'Yes/No answer with gif',
  run: async (sock, msg, args, { jid }) => {
    try {
      const q = args.join(' ').trim();
      const res = await fetch('https://yesno.wtf/api', { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('API ' + res.status);
      const d = await res.json();
      if (!d || !d.answer || !d.image) throw new Error('bad response');
      let caption = '*' + String(d.answer).toUpperCase() + '!*';
      if (q) caption += '\n\n❓ _' + q + '_';
      await sock.sendMessage(jid, { image: { url: d.image }, caption }, { quoted: msg });
    } catch (e) {
      await reply(sock, jid, msg, '❌ Jawab nahi mila, thori der baad ' + config.prefix + 'yesno dobara try karein.');
    }
  },
},
excuse: {
  desc: 'Random funny bahana',
  run: async (sock, msg, args, { jid }) => {
    try {
      const res = await fetch('https://excuser-three.vercel.app/v1/excuse', { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('API ' + res.status);
      const d = await res.json();
      const item = Array.isArray(d) ? d[0] : null;
      if (!item || !item.excuse) throw new Error('bad response');
      let text = '😅 *Bahana:* ' + item.excuse.replace(/^["“]|["”]$/g, '');
      if (item.category) text += '\n🏷️ _' + item.category + '_';
      await reply(sock, jid, msg, text);
    } catch (e) {
      await reply(sock, jid, msg, '❌ Bahana nahi mila, thori der baad ' + config.prefix + 'excuse dobara try karein.');
    }
  },
},

explain: {
  desc: 'Mushkil topic asaan lafzon mein samjhao',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}explain <topic>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Jawab mukhtasir aur dilchasp rakho (2-8 lines, jab tak tafseel na mangi jaye). Kabhi Devanagari script istemal na karo. User jo bhi topic de, use BILKUL ASAAN lafzon mein samjhao jaise kisi dost ko samjha rahi ho. Misal do.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
code: {
  desc: 'Kisi kaam ka code likho',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}code <kaam>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User jo kaam bataye us ka code likh do (zaban user bataye warna Python). Sirf code + 1-2 line wazahat. Code ko code block mein do.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
dream: {
  desc: 'Khwab ki tabeer batao',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}dream <khwab>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Jawab mukhtasir aur dilchasp rakho (2-8 lines, jab tak tafseel na mangi jaye). Kabhi Devanagari script istemal na karo. User apna khwab batayega, us ki dilchasp tabeer batao (khwabon ki tabeer wale andaz mein, positive lehja).';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
future: {
  desc: 'Funny mustaqbil ki peshgoi',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}future <sawal>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Jawab mukhtasir aur dilchasp rakho (2-8 lines, jab tak tafseel na mangi jaye). Kabhi Devanagari script istemal na karo. Funny/tafreehi andaz mein user ke sawal ka "mustaqbil" batao — crystal ball wali dost jaise. Wazeh karo ye mazaak hai.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
poem: {
  desc: 'Topic par chhoti nazm likho',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}poem <topic>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User ke topic par khoobsurat chhoti nazm likho (Roman Urdu mein).';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
script: {
  desc: 'YouTube video script likho',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}script <topic>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User ke topic par YouTube video ka script likho: hook, intro, 3 points, outro. Roman Urdu mein.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
idea: {
  desc: 'Topic par 5 creative ideas',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}idea <topic>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Jawab mukhtasir aur dilchasp rakho (2-8 lines, jab tak tafseel na mangi jaye). Kabhi Devanagari script istemal na karo. User ke topic par 5 creative naye ideas do, numbered list mein.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
reply: {
  desc: 'Kisi message ka behtareen jawab',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}reply <message>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User kisi ka message dega (misal dost ya crush ka), us ka behtareen jawab likh do — 2-3 options do: funny, sweet, aur smart.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
gift: {
  desc: 'Tohfa ideas budget ke sath',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}gift <banda>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Jawab mukhtasir aur dilchasp rakho (2-8 lines, jab tak tafseel na mangi jaye). Kabhi Devanagari script istemal na karo. User batayega kise tohfa dena hai (misal "ami ke liye", "dost ki birthday"), 5 tohfa ideas do budget ke sath (PKR mein).';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
trip: {
  desc: 'Safar plan banao',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}trip <sheher/jagah>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User jahan jana chahta hai wahan ka 1-din ya 2-din ka safar plan banao: jane ki jagah, khana, tips.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
horoscope: {
  desc: 'Aaj ka sitara batao',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}horoscope <star>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Jawab mukhtasir aur dilchasp rakho (2-8 lines, jab tak tafseel na mangi jaye). Kabhi Devanagari script istemal na karo. User apna star batayega (misal "leo", "meen"), us ka aaj ka sitara/haal batao — fun aur positive.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await sendCard(sock, jid, msg, 'HOROSCOPE', [], { sub: text.slice(0, 40), desc: ans.slice(0, 260), accent: '#c084fc' }, ans);
  },
},
loveletter: {
  desc: 'Pyaara love letter likho',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}loveletter <naam>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User jise chahta hai us ke naam par pyaara sa love letter likho (Roman Urdu, dil se).';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
comeback: {
  desc: 'Tez funny comeback likho',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}comeback <baat>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User batayega kisi ne kya kaha (mazaak/teasing), us ka tez funny jawab (comeback) likh do — 3 options.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
rewrite: {
  desc: 'Text behtar andaz mein dobara likho',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}rewrite <text>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User ka text behtar, saaf aur asar-daar andaz mein dobara likho. Matlab na badlo.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
grammar: {
  desc: 'Grammar/spelling theek karo',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}grammar <text>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Jawab mukhtasir aur dilchasp rakho (2-8 lines, jab tak tafseel na mangi jaye). Kabhi Devanagari script istemal na karo. User ke text ki grammar/spelling theek karo aur sahi version do. Roman Urdu ya English dono chalega.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
congrats: {
  desc: 'Dil ko chhune wala mubarakbad paigham',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}congrats <khushi>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User batayega kis khushi par mubarakbad deni hai, dil ko chhune wala mubarakbad paigham likho.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
sorry: {
  desc: 'Dil se maafi ka paigham',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}sorry <ghalti>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User batayega kya ghalti hui, us par sachche dil se maafi mangne wala paigham likho.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
breakup: {
  desc: 'Funny breakup message likho',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}breakup <naam>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. Funny/dramatic andaz mein breakup message likho — user jise chhorna chahta hai us ke naam par. Thoda humor bhi ho.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
interview: {
  desc: 'Interview ki tayyari karao',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}interview <job>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User job title dega, us ke liye interview ki tayyari karao: 5 aam sawal + behtareen jawab.';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},
dialogue: {
  desc: 'Filmy style dialogue likho',
  run: async (sock, msg, args, { jid, sender }) => {
    const text = args.join(' ').trim();
    if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}dialogue <topic>*`);
    const sys = 'Tum Nexa ho, NEXORA-MD WhatsApp bot ki friendly female AI assistant. Hamesha Roman Urdu (Latin script) mein jawab do, feminine grammar (rahi hoon, karongi). Kabhi Devanagari script istemal na karo. User ke topic par filmy style ka dialogue likho — hero wala andaz!';
    const ans = await chatComplete(sys, text);
    if (!ans) return reply(sock, jid, msg, '❌ AI se jawab nahi mila, dobara try karein.');
    await reply(sock, jid, msg, ans);
  },
},

block: {
  desc: 'Kisi number ko block karo (owner)',
  run: async (sock, msg, args, { jid, sender }) => {
    if (!isOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Ye command sirf owner chala sakta hai.');
    let target = ctxOf(msg)?.participant;
    if (!target && args[0]) {
      const d = num(args[0]);
      if (d.length >= 7) target = d + '@s.whatsapp.net';
    }
    if (!target) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}block* (kisi ke message ka reply) ya *${config.prefix}block <number>*`);
    const me = num(sender);
    const botNum = sock.user ? num(sock.user.id) : '';
    if (num(target) === me || (botNum && num(target) === botNum)) return reply(sock, jid, msg, '❌ Khud ko block nahi kar sakte.');
    try {
      await sock.updateBlockStatus(target, 'block');
      return reply(sock, jid, msg, `🚫 *Blocked:* ${num(target)}`);
    } catch (e) {
      return reply(sock, jid, msg, '❌ Block nahi ho saka.');
    }
  },
},
unblock: {
  desc: 'Kisi number ko unblock karo (owner)',
  run: async (sock, msg, args, { jid, sender }) => {
    if (!isOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Ye command sirf owner chala sakta hai.');
    let target = ctxOf(msg)?.participant;
    if (!target && args[0]) {
      const d = num(args[0]);
      if (d.length >= 7) target = d + '@s.whatsapp.net';
    }
    if (!target) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}unblock* (kisi ke message ka reply) ya *${config.prefix}unblock <number>*`);
    const me = num(sender);
    const botNum = sock.user ? num(sock.user.id) : '';
    if (num(target) === me || (botNum && num(target) === botNum)) return reply(sock, jid, msg, '❌ Khud ko block nahi kar sakte.');
    try {
      await sock.updateBlockStatus(target, 'unblock');
      return reply(sock, jid, msg, `✅ *Unblocked:* ${num(target)}`);
    } catch (e) {
      return reply(sock, jid, msg, '❌ Unblock nahi ho saka.');
    }
  },
},

audio: {
  desc: 'YouTube se audio — naam likho 🎵',
  run: async (sock, msg, args, { jid, sender }) => {
    const query = (args || []).join(' ').trim();
    if (!query) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}audio <gaane ka naam>*\nMasalan: *${config.prefix}audio pasoori*`);
    await reply(sock, jid, msg, '🎵 Dhoond rahi hoon...');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const { execFile } = require('child_process');
    const tmpBase = path.join(os.tmpdir(), 'song_' + Date.now());
    const YTDLP_BIN = '/home/hatch/workspace/ytvenv/bin/yt-dlp'; // pip venv: curl_cffi + bgutil PO-token plugin (2026-09-22)
    // 2026-09-26 speed: 2 parallel attempts race (pehle sequence mein 3 attempts + 10s sleeps the)
    let ok = false, songMeta = null, outFile = null;
    await serializedYtdlp(async () => {
      const win = await raceYtDownload({ mode: 'audio', target: 'ytsearch1:' + query, dlBase: os.tmpdir(), bin: YTDLP_BIN });
      if (win) { ok = true; songMeta = win.meta; outFile = win.path; }
    });
    if (!ok) { console.error('[song] download fail:', query); throw new Error('dl-fail'); }
    try {
      const buf = fs.readFileSync(outFile);
      try { fs.unlinkSync(outFile); } catch (e) {}
      // WhatsApp audio par caption render NAHI karta (Boss ka phone test 2026-09-23) —
      // is liye details alag khoobsurat message mein
      await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mp4', fileName: query.slice(0, 60) + '.m4a' }, { quoted: msg });
      await reply(sock, jid, msg, ytDetailsCaption('🎵', songMeta, query));
    } catch (e) {
      try { fs.unlinkSync(tmpBase + '.m4a'); } catch (ee) {}
      console.error('[song] download fail:', query, '-', (e && e.message) || e);
      return reply(sock, jid, msg, '❌ Gaana nahi mil saka, naam check karke dobara try karein 💗');
    }
  },
},
video: {
  desc: 'Video download — naam ya link (TikTok/IG/FB/X/YouTube)',
  run: async (sock, msg, args, { jid, sender }) => {
    const input = (args || []).join(' ').trim();
    if (!input) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}video <naam ya link>*\nMasalan: *${config.prefix}video pasoori*`);
    const low = input.toLowerCase();
    const isLink = /^https?:\/\//.test(low);
    if (isLink) {
      if (/tiktok\.com/.test(low)) { await sendDownload(sock, jid, msg, input, 'TikTok', '🎬'); return; }
      if (/instagram\.com/.test(low)) { await sendDownload(sock, jid, msg, input, 'Instagram', '📸'); return; }
      if (/facebook\.com|fb\.watch/.test(low)) { await sendDownload(sock, jid, msg, input, 'Facebook', '📘'); return; }
      if (/twitter\.com|x\.com/.test(low)) { await sendDownload(sock, jid, msg, input, 'X', '🐦'); return; }
    }
    // YouTube link ya naam se search — seedha download
    const target = isLink ? input : 'ytsearch1:' + input;
    await reply(sock, jid, msg, '🎬 Video la rahi hoon...');
    const dlBase = getSetting('delpath') || '/tmp';
    const tmpBase = path.join(dlBase, 'vid_' + Date.now() + '_' + crypto.randomInt(9999));
    const cleanup = () => { const b = path.basename(tmpBase); try { fs.readdirSync(dlBase).forEach(f => { if (f.startsWith(b)) try { fs.unlinkSync(path.join(dlBase, f)); } catch (e) {} }); } catch (e) {} };
    const YTDLP_BIN2 = '/home/hatch/workspace/ytvenv/bin/yt-dlp'; // pip venv: curl_cffi + bgutil PO-token plugin (2026-09-22)
    const runExec = (bin, a, timeoutMs) => new Promise((res, rej) => {
      execFile(bin, a, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { err.ytStderr = String(stderr || '').slice(-600); return rej(err); }
        res(String(stdout || '').trim());
      });
    });
    // 2026-09-23: WhatsApp sirf H.264+AAC wali mp4 chalata hai — opus/av1 wali file par
    // "something is wrong with the video file" error aata hai. Is liye avc1+m4a pehli pasand;
    // jo bhi format aaye, ffprobe se check karke zaroorat par h264+aac mp4 mein convert karo.
    const probeCodecs = (p) => new Promise((res) => {
      execFile('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'csv', p], { timeout: 20000 }, (err, stdout) => {
        if (err) return res(null);
        const out = { v: null, a: null };
        String(stdout || '').split('\n').forEach(line => {
          const m = line.match(/^stream,([^,]+),(video|audio)/);
          if (m && m[2] === 'video' && !out.v) out.v = m[1];
          if (m && m[2] === 'audio' && !out.a) out.a = m[1];
        });
        res(out);
      });
    });
    const toWhatsAppMp4 = (src, tmpB) => new Promise((res, rej) => {
      const dst = tmpB + '.wa.mp4';
      execFile('/usr/bin/ffmpeg', ['-y', '-v', 'error', '-i', src, '-c:v', 'libx264', '-preset', 'veryfast',
        '-b:v', '800k', '-maxrate', '1200k', '-bufsize', '2400k', '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart', dst], { timeout: 300000 }, (err) => {
        if (err) return rej(err);
        try { if (fs.existsSync(dst) && fs.statSync(dst).size >= 100 * 1024) return res(dst); } catch (e) {}
        rej(new Error('transcode-fail'));
      });
    });
    const cleanWin = (tmpB) => { if (!tmpB) return; const b = path.basename(tmpB); try { fs.readdirSync(dlBase).forEach((f) => { if (f.startsWith(b)) try { fs.unlinkSync(path.join(dlBase, f)); } catch (e) {} }); } catch (e) {} };
    // 2026-09-26 speed: raceYtDownload — 2 parallel attempts (dash + progressive), pehle sequence mein 3 attempts + 10s sleeps the
    let ok = false, vidMeta = null, finalPath = null, winTmp = null;
    await serializedYtdlp(async () => {
      const win = await raceYtDownload({ mode: 'video', target, dlBase, bin: YTDLP_BIN2 });
      if (win) { ok = true; finalPath = win.path; vidMeta = win.meta; winTmp = win.tmp; }
    });
    if (!ok || !finalPath) { cleanup(); console.error('[video] download fail:', input); return reply(sock, jid, msg, '❌ Video download nahi ho saka, naam/link check karein 💗'); }
    try {
      // WhatsApp-compatible check: sirf h264 video + aac audio wali mp4 bhejo, warna convert karo
      const codecs = await probeCodecs(finalPath);
      const playable = codecs && (codecs.v === 'h264' || codecs.v === 'avc1') && codecs.a === 'aac' && finalPath.endsWith('.mp4');
      if (!playable) {
        try {
          const conv = await toWhatsAppMp4(finalPath, winTmp);
          try { fs.unlinkSync(finalPath); } catch (e) {}
          finalPath = conv;
          console.log('[video] transcoded to h264+aac for WhatsApp:', input);
        } catch (e) { console.error('[video] transcode fail:', (e && e.message) || e); }
      }
      const caption = ytDetailsCaption('🎬', vidMeta, isLink ? 'Video' : input);
      await sock.sendMessage(jid, { video: fs.readFileSync(finalPath), caption }, { quoted: msg });
    } finally { cleanup(); cleanWin(winTmp); }
  },
},

  // ── ip ──
  ip: {
    desc: 'IP ya domain ki location maloomat',
    run: async (sock, msg, args, { jid }) => {
      let q = (args[0] || '').trim();
      const um = q.match(/^(?:https?:\/\/)?([^\/\s?#]+)/i);
      if (um) q = um[1]; // poora URL diya ho to sirf domain nikalo
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}ip <ip-ya-domain>*\nMasalan: *${config.prefix}ip 8.8.8.8*`);
      try {
        const r = await fetch(`http://ip-api.com/json/${encodeURIComponent(q)}?fields=status,message,country,regionName,city,isp,org,query`, { signal: AbortSignal.timeout(12000) });
        const d = await r.json();
        if (d?.status !== 'success') return reply(sock, jid, msg, `❌ IP nahi mila${d?.message ? ': _' + d.message + '_' : ''}.`);
        await reply(sock, jid, msg,
          `🌐 *IP Lookup* 💗\n\n🔢 IP: *${d.query}*\n🏳️ Mulk: *${d.country || '?'}*\n🏙️ Sheher: *${d.city || '?'}*${d.regionName ? ' (' + d.regionName + ')' : ''}\n🏢 ISP: ${d.isp || '?'}\n🏭 Org: ${d.org || '?'}`);
      } catch {
        await reply(sock, jid, msg, '❌ IP lookup nahi ho saka, thodi der baad try karo.');
      }
    },
  },

  // ── fact ── (purana uselessfacts API wala hata diya 2026-09-23 — naya Roman Urdu local pool upar hai)

  // ── truth ──
  truth: {
    desc: 'Truth sawal (game)',
    run: async (sock, msg, args, { jid }) => {
      const T = [
        'Tumhari sab se bari khwahish kya hai? 😳',
        'Aakhri dafa kab roye thay, aur kyun? 🥺',
        'Koi aisi baat jo tumne kabhi kisi ko nahi batayi? 🤫',
        'Tumhara crush kaun hai? 👀',
        'Zindagi ka sab se sharmnaak lamha kaunsa tha? 😅',
        'Agar 1 crore mil jayein to sab se pehle kya karoge? 💰',
        'Kisi se jhoot bola aur pakre gaye? 😬',
        'Phone mein sab se ajeeb photo kaunsi hai? 📱',
        'Kis cheez se sab se zyada dar lagta hai? 😨',
        'Koi secret talent jo kisi ko nahi pata? ✨',
        'Zindagi ka sab se bara pachtawa kya hai? 💭',
        'Aakhri dafa kis par gussa aaya tha? 😤',
      ];
      const q = T[Math.floor(Math.random() * T.length)];
      await suspense(sock, jid, msg, '😳 Tumhare liye ek khatarnaak sawal chun rahi hoon... 💗');
      await reply(sock, jid, msg, `😳 *TRUTH* 💗\n\n${q}\n\n_Sach sach jawab dena, jhoot pakra gaya to dare milega! 😄_`);
    },
  },

  // ── dare ──
  dare: {
    desc: 'Dare challenge (safe/mazaq)',
    run: async (sock, msg, args, { jid }) => {
      const D = [
        'Apni DP 1 ghante ke liye kisi cartoon character ki lagao! 🐰',
        'Zor se "Main sab se cute hoon!" bolo aur voice note bhejo! 🎤',
        '10 push-ups karo aur video bhejo! 💪',
        'Ek minute tak murga bano! 🐓',
        'Apni gallery ki 5vi photo status par lagao! 🖼️',
        'Aankhein band karke apna naam likho aur photo bhejo! ✍️',
        '5 minute tak sirf emoji mein baat karo! 😜',
        'Kisi dost ko call karke bolo "tum best ho"! 📞',
        'Chai banao aur photo bhejo! ☕',
        'Apne naam ka funny matlab banao aur sab ko batao! 🤣',
        'Seedhe khare ho kar 10 chakkar ghoomo! 🌀',
        'Apne favourite gaane ki 2 linein gaa kar voice note bhejo! 🎶',
      ];
      const q = D[Math.floor(Math.random() * D.length)];
      await suspense(sock, jid, msg, '😈 Tumhare liye ek shararti challenge soch rahi hoon... 💗');
      await reply(sock, jid, msg, `😈 *DARE* 💗\n\n${q}\n\n_Himmat hai to karke dikhao, warna truth qabool karo! 😜_`);
    },
  },

  // ── roll ──
  roll: {
    desc: 'Pasa phenko (NdM)',
    run: async (sock, msg, args, { jid }) => {
      let n = 1, m = 6;
      const a = (args[0] || '').toLowerCase();
      if (a) {
        const mm = a.match(/^(\d{1,2})d(\d{1,3})$/);
        if (!mm) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}roll [NdM]*\nMasalan: *${config.prefix}roll* ya *${config.prefix}roll 2d20* 🎲`);
        n = Math.min(parseInt(mm[1], 10), 20); m = Math.min(parseInt(mm[2], 10), 100);
        if (n < 1 || m < 2) return reply(sock, jid, msg, '❌ Ghalat format. Masalan: `.roll 2d20` 🎲');
      }
      try {
        const rolls = [];
        for (let i = 0; i < n; i++) rolls.push(1 + Math.floor(Math.random() * m));
        const total = rolls.reduce((x, y) => x + y, 0);
        const dice = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
        const faces = (m === 6) ? rolls.map((r) => dice[r - 1]).join(' ') : rolls.join(' + ');
        await suspense(sock, jid, msg, '🎲 Pasa hawa mein uchhal rahi hoon... 💗');
        await reply(sock, jid, msg, `🎲 *Roll ${n}d${m}* 💗\n\n${faces}\n\n✨ Total: *${total}*`);
      } catch {
        await reply(sock, jid, msg, '❌ Pasa nahi phenka ja saka.');
      }
    },
  },

  // ── coin ──
  coin: {
    desc: 'Sikka uchhalo (head/tail)',
    run: async (sock, msg, args, { jid }) => {
      try {
        const head = Math.random() < 0.5;
        await suspense(sock, jid, msg, '🪙 Sikka uchhal rahi hoon... 💗');
        await reply(sock, jid, msg, head ? '🪙 *HEAD!* 💗\n\n🎉 Jeet gaye! Kismat chamak rahi hai!' : '🪙 *TAIL!* 💗\n\n🍀 Koi baat nahi, agli baar pakka!');
      } catch {
        await reply(sock, jid, msg, '❌ Sikka nahi uchhal saka.');
      }
    },
  },

  // ── play ──
  play: {
    desc: 'YouTube par gaana dhoondo',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ');
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}play <gaane-ka-naam>*\nMasalan: *${config.prefix}play tere sang yaara*`);
      await reply(sock, jid, msg, wline(['🔍 Gaana dhoond rahi hoon... 🎵', '🎵 Aapka gana talash kar rahi hoon... 💗', '🔍 Music ki duniya mein gayi... ek minute! ✨']));
      // Piped instances sab dead hain (2026-09-23 test) — ab yt-dlp se search (bot ka apna working setup)
      const YTDLP_PLAY = '/home/hatch/workspace/ytvenv/bin/yt-dlp';
      try {
        const out = await new Promise((res, rej) => {
          execFile(YTDLP_PLAY, ['--impersonate', 'chrome', '--extractor-args', 'youtube:player_client=mediaconnect',
            '--skip-download', '--no-warnings', '--socket-timeout', '20',
            '--print', '%(id)s | %(title)s', 'ytsearch1:' + q],
            { timeout: 60000 }, (err, stdout) => (err ? rej(err) : res(String(stdout || '').trim())));
        });
        const line = out.split('\n').map(s => s.trim()).filter(Boolean).pop() || '';
        const m = line.match(/^([A-Za-z0-9_-]{11}) \| (.+)$/);
        if (m) {
          const link = `https://youtu.be/${m[1]}`;
          const thumb = `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg`;
          await sock.sendMessage(jid, { image: { url: thumb }, caption: `🎵 *${m[2]}*\n\n▶️ Suno: ${link}\n_— ${config.botName} 💗_` }, { quoted: msg });
          return;
        }
        throw new Error('no-result');
      } catch {
        const sLink = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
        await reply(sock, jid, msg, `🎵 *${q}*\n\n🔍 Search results yahan dekho:\n${sLink}`);
      }
    },
  },

  // ── vote ──
  vote: {
    desc: 'Foran 👍/👎 vote',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ');
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}vote <sawal>*\nMasalan: *${config.prefix}vote chai ya coffee?*`);
      await reply(sock, jid, msg, `🗳️ *VOTE* 💗\n\n❓ ${q}\n\n👍 = Haan\n👎 = Nahi\n\n_Apna vote react karke do!_`);
    },
  },

  // ── 8d ──
  '8d': {
    desc: 'Reply audio par 8D effect',
    run: async (sock, msg, args, { jid }) => {
      const q = ctxOf(msg)?.quotedMessage?.audioMessage || msg.message?.audioMessage;
      if (!q) return await reply(sock, jid, msg, '❌ Kisi voice note ya audio ke reply mein *' + config.prefix + '8d* likhein. 🎧');
      const rand = crypto.randomBytes(6).toString('hex');
      const inp = '/tmp/8d_' + rand + '.ogg';
      const out = '/tmp/8d_' + rand + '.mp3';
      try {
        await reply(sock, jid, msg, '⏳ 8D effect laga rahi hoon... 🎧💗');
        const buf = await downloadMediaMessage({ key: msg.key, message: { audioMessage: q } }, 'buffer', {});
        fs.writeFileSync(inp, buf);
        await new Promise((resolve, reject) => {
          execFile('ffmpeg', ['-y', '-i', inp, '-filter:a', 'apulsator=hz=0.125', '-c:a', 'libmp3lame', '-q:a', '4', out], { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
        });
        await sock.sendMessage(jid, { audio: fs.readFileSync(out), mimetype: 'audio/mpeg' }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, '❌ 8D effect nahi lag saka. Audio lambi ya kharab to nahi?');
      } finally {
        try { fs.unlinkSync(inp); } catch {}
        try { fs.unlinkSync(out); } catch {}
      }
    },
  },

  // ── bassboost ──
  bassboost: {
    desc: 'Reply audio par bass boost',
    run: async (sock, msg, args, { jid }) => {
      const q = ctxOf(msg)?.quotedMessage?.audioMessage || msg.message?.audioMessage;
      if (!q) return await reply(sock, jid, msg, '❌ Kisi voice note ya audio ke reply mein *' + config.prefix + 'bassboost* likhein. 🔊');
      const rand = crypto.randomBytes(6).toString('hex');
      const inp = '/tmp/bb_' + rand + '.ogg';
      const out = '/tmp/bb_' + rand + '.mp3';
      try {
        await reply(sock, jid, msg, '⏳ Bass boost kar rahi hoon... 🔊💗');
        const buf = await downloadMediaMessage({ key: msg.key, message: { audioMessage: q } }, 'buffer', {});
        fs.writeFileSync(inp, buf);
        await new Promise((resolve, reject) => {
          execFile('ffmpeg', ['-y', '-i', inp, '-filter:a', 'bass=g=12', '-c:a', 'libmp3lame', '-q:a', '4', out], { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
        });
        await sock.sendMessage(jid, { audio: fs.readFileSync(out), mimetype: 'audio/mpeg' }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, '❌ Bass boost nahi ho saka. Audio lambi ya kharab to nahi?');
      } finally {
        try { fs.unlinkSync(inp); } catch {}
        try { fs.unlinkSync(out); } catch {}
      }
    },
  },

  // ── gif ──
  gif: {
    desc: 'Reply video → GIF',
    run: async (sock, msg, args, { jid }) => {
      const q = ctxOf(msg)?.quotedMessage;
      const media = q?.videoMessage;
      if (!media) return reply(sock, jid, msg, `❌ Kisi video ke reply mein *${config.prefix}gif* likhein. 🎞️`);
      await reply(sock, jid, msg, '⏳ GIF ban raha hai... 🎞️💗');
      const rand = crypto.randomBytes(6).toString('hex');
      const inp = `/tmp/gif_${rand}.mp4`;
      const out = `/tmp/gif_${rand}.mp4`;
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { videoMessage: media } }, 'buffer', {});
        fs.writeFileSync(inp, buf);
        await new Promise((resolve, reject) => {
          execFile('ffmpeg', ['-y', '-i', inp, '-t', '6', '-vf', 'fps=10,scale=320:-1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', out], { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
        });
        await sock.sendMessage(jid, { video: fs.readFileSync(out), gifPlayback: true, caption: `🎞️ GIF — _${config.botName} 💗_` }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ GIF nahi ban saka. Video lambi to nahi? (pehle 6 second)');
      } finally {
        try { fs.unlinkSync(inp); } catch {}
        try { fs.unlinkSync(out); } catch {}
      }
    },
  },

  // ── wanted ──
  wanted: {
    desc: 'Photo par WANTED poster',
    run: async (sock, msg, args, { jid }) => {
      const img = ctxOf(msg)?.quotedMessage?.imageMessage || msg.message?.imageMessage;
      if (!img) return reply(sock, jid, msg, `❌ Kisi photo ke reply mein *${config.prefix}wanted* likhein. 🤠`);
      await reply(sock, jid, msg, '⏳ WANTED poster ban raha hai... 🤠💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: img } }, 'buffer', {});
        const photo = await sharp(buf).resize(560, 560, { fit: 'cover' }).grayscale().toBuffer();
        const svg =
          `<svg width="640" height="840" xmlns="http://www.w3.org/2000/svg">` +
          `<rect width="640" height="840" fill="#e8d5a3"/>` +
          `<rect x="18" y="18" width="604" height="804" fill="none" stroke="#5a3a1a" stroke-width="6"/>` +
          `<text x="320" y="105" text-anchor="middle" font-family="Georgia,serif" font-size="84" font-weight="bold" fill="#3a2410" letter-spacing="8">WANTED</text>` +
          `<text x="320" y="150" text-anchor="middle" font-family="Georgia,serif" font-size="26" fill="#5a3a1a">DEAD OR ALIVE</text>` +
          `<text x="320" y="795" text-anchor="middle" font-family="Georgia,serif" font-size="34" font-weight="bold" fill="#3a2410">REWARD: 1,000</text>` +
          `</svg>`;
        const poster = await sharp(Buffer.from(svg))
          .composite([{ input: photo, top: 180, left: 40 }])
          .png().toBuffer();
        await sock.sendMessage(jid, { image: poster, caption: `🤠 *WANTED!* — _${config.botName} 💗_` }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ WANTED poster nahi ban saka.');
      }
    },
  },

  // ── barcode ──
  barcode: {
    desc: 'Text → barcode image',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').slice(0, 40);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}barcode <text>*\nMasalan: *${config.prefix}barcode NEXORA123*`);
      await reply(sock, jid, msg, '⏳ Barcode bana rahi hoon... 📊💗');
      try {
        let png = null;
        try {
          png = await new Promise((res, rej) => {
            require('bwip-js').toBuffer({ bcid: 'code128', text, scale: 3, height: 12, includetext: true, textxalign: 'center' }, (e, b) => (e ? rej(e) : res(b)));
          });
        } catch { /* fallback neeche */ }
        if (!png) {
          const r = await fetch(`https://barcode.tec-it.com/barcode.ashx?data=${encodeURIComponent(text)}&code=Code128&dpi=96`, { signal: AbortSignal.timeout(12000) });
          if (!r.ok) throw new Error('tec-it fail');
          png = Buffer.from(await r.arrayBuffer());
        }
        await sock.sendMessage(jid, { image: png, caption: `📊 *Barcode:* ${text}\n_— ${config.botName} 💗_` }, { quoted: msg });
      } catch {
        await reply(sock, jid, msg, '❌ Barcode nahi ban saka.');
      }
    },
  },

  // ── dadjoke ──
  dadjoke: {
    desc: 'Dad joke sunao',
    run: async (sock, msg, args, { jid }) => {
      const LOCAL = [
        'Papa ne poocha "beta parhai kaisi chal rahi?" — beta: "bilkul bijli jaisi, kabhi aati hai kabhi jaati hai!" 😂',
        'Doctor: "tumhe araam ki zaroorat hai." Patient: "kitne din?" Doctor: "jitne din biwi maike gayi hai!" 😂',
        'Ustad: "kal sab apne abba ko school laayein." Bacha: "kyun sir?" Ustad: "taake unhein pata chale unka beta kitna nalaiq hai!" 😂',
        'Biwi: "suniye, bijli ka bill aaya hai." Shohar: "to main kya karoon?" Biwi: "kuch nahi, bas roshni daal rahi thi!" 😂',
        'Dost: "yaar tu itna mota kaise ho gaya?" — "Bhai, khushi ke maare phool raha hoon!" 😂',
      ];
      try {
        const r = await fetch('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json', 'User-Agent': 'NEXORA-MD' }, signal: AbortSignal.timeout(12000) });
        const d = await r.json();
        if (d?.joke) return reply(sock, jid, msg, `😂 *Dad Joke* 💗\n\n${d.joke}`);
        throw new Error('empty');
      } catch {
        const j = LOCAL[Math.floor(Math.random() * LOCAL.length)];
        await reply(sock, jid, msg, `😂 *Dad Joke* 💗\n\n${j}\n\n_Hansi aayi to ek aur mangwana! 😄_`);
      }
    },
  },

  // ── uwu ──
  uwu: {
    desc: 'Text ko uwu banao',
    run: async (sock, msg, args, { jid }) => {
      const t = args.join(' ');
      if (!t) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}uwu <text>* 🥺`);
      try {
        const KAOMOJI = ['(・`ω´・)', 'UwU', '(●´ω｀●)', 'owo', '(￣ω￣)', '(´･ω･`)', '(˘･_･˘)'];
        let s = t.replace(/[rl]/g, 'w').replace(/[RL]/g, 'W').replace(/ove/g, 'uv').replace(/OVE/g, 'UV');
        s = s.replace(/n([aeiou])/g, 'ny$1').replace(/N([aeiou])/g, 'Ny$1');
        s = s.replace(/!/g, '!!11');
        s += ' ' + KAOMOJI[Math.floor(Math.random() * KAOMOJI.length)];
        await reply(sock, jid, msg, `🥺 *uwu* 💗\n\n${s}`);
      } catch {
        await reply(sock, jid, msg, '❌ uwu nahi ho saka.');
      }
    },
  },

  // ── paheli ──
  paheli: {
    desc: 'Urdu paheli + jawab',
    run: async (sock, msg, args, { jid }) => {
      const P = [
        ['Aisi kaunsi cheez hai jise jitna nikalo utna barhta hai?', 'Garha (khadda) 🕳️'],
        ['Wo kaun hai jo bolta nahi, phir bhi sab ko jawab deta hai?', 'Aaina (sheesha) 🪞'],
        ['Wo kya hai jo tumhara hai, lekin doosre tum se zyada istemal karte hain?', 'Tumhara naam 📛'],
        ['Jitna baanto utna barhta hai — wo kya hai?', 'Ilm aur mohabbat 📚💗'],
        ['Kaatti hai magar khoon nahi nikalta?', 'Kainchi ✂️'],
        ['Paani mein rehti hai, paani nahi peeti?', 'Kashti ⛵'],
        ['Lal qile mein safed mahal?', 'Munh mein daant 🦷'],
        ['Bin pankh ke urta hai?', 'Waqt ⏰'],
        ['Mere paas sheher hain lekin ghar nahi, darya hain lekin paani nahi — main kaun?', 'Naqsha 🗺️'],
        ['Ek thali mein do laddu, ek meetha ek namkeen?', 'Suraj aur chand 🌞🌙'],
      ];
      try {
        const [q, a] = P[Math.floor(Math.random() * P.length)];
        await reply(sock, jid, msg, `🧩 *Paheli* 💗\n\n${q}\n\n_Socho socho... jawab 8 second mein aa raha hai!_ ⏳`);
        setTimeout(() => { reply(sock, jid, msg, `💡 *Jawab:* ${a}`).catch(() => {}); }, 8000);
      } catch {
        await reply(sock, jid, msg, '❌ Paheli nahi mil saki.');
      }
    },
  },
};

// .insta = .ig ka alias
commands.insta = { ...commands.ig, desc: 'Instagram download (ig ka alias) 📸' };
// .song = .audio ka silent alias (purani aadat)
commands.song = { ...commands.audio, desc: 'Audio (song ka alias) 🎵' };

// ─── 📖 QURAN helpers: 114 surah names + audio download ───
const QURAN_SURAHS = ["Fatiha","Baqarah","Aal-e-Imran","Nisa","Maidah","Anam","Araf","Anfal","Taubah","Yunus","Hud","Yusuf","Rad","Ibrahim","Hijr","Nahl","Bani Israil","Kahf","Maryam","Taha","Anbiya","Hajj","Muminun","Nur","Furqan","Shuara","Naml","Qasas","Ankabut","Rum","Luqman","Sajdah","Ahzab","Saba","Fatir","Yaseen","Saffat","Sad","Zumar","Mumin","Fussilat","Shura","Zukhruf","Dukhan","Jasiyah","Ahqaf","Muhammad","Fath","Hujurat","Qaf","Zariyat","Tur","Najm","Qamar","Rahman","Waqia","Hadid","Mujadila","Hashr","Mumtahanah","Saff","Jumuah","Munafiqun","Taghabun","Talaq","Tahrim","Mulk","Qalam","Haqqah","Maarij","Nuh","Jinn","Muzammil","Muddassir","Qiyamah","Insan","Mursalat","Naba","Naziat","Abasa","Takwir","Infitar","Mutaffifin","Inshiqaq","Buruj","Tariq","Ala","Ghashiyah","Fajr","Balad","Shams","Lail","Duha","Sharh","Tin","Alaq","Qadr","Bayyinah","Zalzalah","Adiyat","Qariah","Takasur","Asr","Humazah","Fil","Quraish","Maun","Kausar","Kafirun","Nasr","Lahab","Ikhlas","Falaq","Naas"];
const QURAN_ALIASES = { yaseen:36, yasin:36, waqia:56, waqiah:56, rahman:55, mulk:67, kahf:18, kahaf:18, muzammil:73, muzzammil:73, muddassir:74, fatiha:1, fateha:1, ikhlas:112, naas:114, nas:114, falaq:113, kafirun:109, kausar:108, kauthar:108, duha:93, zoha:93, qadr:97, fil:105, feel:105, maryam:19, taha:20, taaha:20, hajj:22, nur:24, noor:24, shura:42, dukhan:44, fath:48, fateh:48, qaf:50, najm:53, najam:53, qamar:54, hadid:57, hashr:59, jumuah:62, juma:62, munafiqun:63, talaq:65, tahrim:66, qalam:68, haqqah:69, nuh:71, nooh:71, jinn:72, qiyamah:75, qiyamat:75, insan:76, naba:78, naziat:79, abasa:80, takwir:81, infitar:82, buruj:85, tariq:86, ala:87, aala:87, ghashiyah:88, fajr:89, fajar:89, balad:90, shams:91, lail:92, sharh:94, inshirah:94, tin:95, teen:95, alaq:96, bayyinah:98, zalzalah:99, zilzal:99, adiyat:100, qariah:101, takasur:102, asr:103, humazah:104, quraish:106, maun:107, maoon:107, nasr:110, lahab:111, masad:111, anam:6, araf:7, anfal:8, taubah:9, yunus:10, hud:11, yusuf:12, raad:13, rad:13, ibrahim:14, hijr:15, nahl:16, anbiya:21, muminun:23, furqan:25, shuara:26, naml:27, qasas:28, ankabut:29, rum:30, luqman:31, sajdah:32, sajda:32, ahzab:33, saba:34, fatir:35, saffat:37, zumar:39, fussilat:41, zukhruf:43, jasiyah:45, ahqaf:46, muhammad:47, hujurat:49, zariyat:51, tur:52, mujadila:58, mumtahanah:60, saff:61, taghabun:64, maarij:70, mursalat:77, mutaffifin:83, inshiqaq:84 };
function quranSurahNum(q) {
  if (!q) return 0;
  const t = String(q).trim();
  if (/^\d+$/.test(t)) { const n = parseInt(t, 10); return (n >= 1 && n <= 114) ? n : 0; }
  const norm = t.toLowerCase().replace(/[^a-z]/g, '');
  if (QURAN_ALIASES[norm]) return QURAN_ALIASES[norm];
  for (let i = 0; i < QURAN_SURAHS.length; i++) {
    if (QURAN_SURAHS[i].toLowerCase().replace(/[^a-z]/g, '') === norm) return i + 1;
  }
  return 0;
}
const qRun = (bin, args, timeoutMs) => new Promise((res, rej) => {
  execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return rej(err);
    res(String(stdout || '').trim());
  });
});
async function quranSurahDl(sn) {
  const url = `https://server8.mp3quran.net/afs/${String(sn).padStart(3, '0')}.mp3`;
  const out = `/tmp/qsurah_${sn}.mp3`;
  await qRun('curl', ['-sL', '--max-time', '150', '-o', out, url], 160000);
  const st = fs.statSync(out);
  if (!st || st.size < 50 * 1024) throw new Error('dl-fail');
  return { path: out, size: st.size, buf: fs.readFileSync(out) };
}

// ─── 📖 QURANMENU + 🎙️ QARI PACK (Boss: 2026-09-25) ───
// Har surah ki ayat-count (Madani mushaf)
const QURAN_AYAHS = [7,286,200,176,120,165,206,75,129,109,123,111,43,52,99,128,111,110,98,135,112,78,118,64,77,227,93,88,69,60,34,30,73,54,45,83,182,88,75,85,54,53,89,59,37,35,38,29,18,45,60,49,62,55,78,96,29,22,24,13,14,11,11,18,12,12,30,52,52,44,28,28,20,56,40,31,50,40,46,42,29,19,36,25,22,17,19,26,30,20,15,21,11,8,8,19,5,8,8,11,11,8,3,9,5,4,7,3,6,3,5,4,5,6];
const QARI_URLS = {
  alafasy: 'https://server8.mp3quran.net/afs/',
  basit: 'https://server7.mp3quran.net/basit/',
  ghamdi: 'https://server7.mp3quran.net/s_gmd/',
  shuraim: 'https://server7.mp3quran.net/shur/',
};
async function quranQariDl(sn, qari) {
  const url = QARI_URLS[qari] + String(sn).padStart(3, '0') + '.mp3';
  const out = `/tmp/qari_${qari}_${sn}.mp3`;
  await qRun('curl', ['-sL', '--max-time', '150', '-o', out, url], 160000);
  const st = fs.statSync(out);
  if (!st || st.size < 50 * 1024) throw new Error('dl-fail');
  return { path: out, size: st.size, buf: fs.readFileSync(out) };
}
async function qariSurah(sock, msg, jid, qariKey, qariName, q) {
  const sn = quranSurahNum(q);
  if (!sn) return reply(sock, jid, msg, `❌ Surah nahi mili.\nUsage: *${config.prefix}${qariKey} <naam/number>*\nMasalan: *${config.prefix}${qariKey} Yaseen*`);
  const sname = QURAN_SURAHS[sn - 1];
  await reply(sock, jid, msg, `🎙️ *Surah ${sname}* — ${qariName} ki awaz mein la rahi hoon... 🎧`);
  try {
    const f = await quranQariDl(sn, qariKey);
    const cap = `📖 *Surah ${sname}* — ${qariName} 🎧`;
    if (f.size > 45 * 1024 * 1024) {
      await sock.sendMessage(jid, { document: f.buf, mimetype: 'audio/mpeg', fileName: `Surah-${sname}-${qariKey}.mp3`, caption: cap }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, { audio: f.buf, mimetype: 'audio/mpeg', fileName: `Surah-${sname}-${qariKey}.mp3` }, { quoted: msg });
      await reply(sock, jid, msg, cap);
    }
    try { fs.unlinkSync(f.path); } catch {}
  } catch { return reply(sock, jid, msg, '❌ Audio nahi mil saki, dobara try karein.'); }
}
Object.assign(commands, {
  quranmenu: {
    desc: '114 suraton ki list 📖 (.quranmenu)',
    run: async (sock, msg, args, { jid }) => {
      const lines = QURAN_SURAHS.map((n, i) => `${i + 1}. ${n} (${QURAN_AYAHS[i]})`);
      const txt = `📖 *QURAN MAJEED — 114 SURATEIN* 📖\n\n${lines.join('\n')}\n\n_🎧 Sunne ke liye:_ \`${config.prefix}quran surah <naam>\`\n_🎙️ Pasandeeda qari:_ \`${config.prefix}alafasy | ${config.prefix}basit | ${config.prefix}ghamdi | ${config.prefix}shuraim <surah>\` ✨`;
      await reply(sock, jid, msg, txt);
    },
  },
  alafasy: {
    desc: 'Mishary Alafasy ki tilawat 🎙️ (.alafasy <surah>)',
    run: async (sock, msg, args, { jid }) => { await qariSurah(sock, msg, jid, 'alafasy', 'Mishary Rashid Alafasy', args.join(' ')); },
  },
  basit: {
    desc: 'Abdul Basit ki tilawat 🎙️ (.basit <surah>)',
    run: async (sock, msg, args, { jid }) => { await qariSurah(sock, msg, jid, 'basit', 'Qari Abdul Basit', args.join(' ')); },
  },
  ghamdi: {
    desc: 'Saad Al-Ghamdi ki tilawat 🎙️ (.ghamdi <surah>)',
    run: async (sock, msg, args, { jid }) => { await qariSurah(sock, msg, jid, 'ghamdi', 'Saad Al-Ghamdi', args.join(' ')); },
  },
  shuraim: {
    desc: 'Saud Al-Shuraim ki tilawat 🎙️ (.shuraim <surah>)',
    run: async (sock, msg, args, { jid }) => { await qariSurah(sock, msg, jid, 'shuraim', 'Saud Al-Shuraim', args.join(' ')); },
  },
});

// ═══════════ ⬡ NX UTILITY PACK — 23 commands (Boss order 2026-09-25) ═══════════
// Download/tools + AI/chat + group-admin + info + fun/util.
// Sab try/catch, Roman Urdu replies, koi nayi npm dependency nahi.

// ── shared helpers ──
function nxBlockHost(u) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::|169\.254\.)/.test(h) || h === '::1';
  } catch { return true; }
}
async function nxFetch(u, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(u, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', ...(opts.headers || {}) } });
  } finally { clearTimeout(t); }
}
// size-cap ke saath download → { buf, type, disp } (zyada bara ho to throw)
async function nxDownloadBuf(u, capBytes, timeoutMs = 90000) {
  const r = await nxFetch(u, {}, timeoutMs);
  if (!r.ok) throw new Error('http ' + r.status);
  const len = parseInt(r.headers.get('content-length') || '0', 10);
  if (len && len > capBytes) throw new Error('too-big');
  const ab = await r.arrayBuffer();
  if (ab.byteLength > capBytes) throw new Error('too-big');
  if (ab.byteLength < 100) throw new Error('empty');
  return { buf: Buffer.from(ab), type: (r.headers.get('content-type') || '').split(';')[0].trim(), disp: r.headers.get('content-disposition') || '' };
}
function nxFileName(u, disp, fallback) {
  const m = /filename\*?=(?:UTF-8''|")?([^";\n]+)/i.exec(disp || '');
  if (m) { try { return decodeURIComponent(m[1].replace(/"/g, '').trim()); } catch {} }
  try {
    const p = new URL(u).pathname.split('/').pop();
    if (p && /\.[a-z0-9]{2,5}$/i.test(p)) return decodeURIComponent(p);
  } catch {}
  return fallback;
}
// Pakistani mobile prefixes → network (sirf network/region, koi personal data nahi)
const PK_NETWORKS = [
  [/^030\d/, 'Jazz (Mobilink)'], [/^031\d/, 'Zong'], [/^032\d/, 'Jazz (Warid)'],
  [/^033\d/, 'Ufone'], [/^034\d/, 'Telenor'],
];
function nxPkInfo(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (/^92/.test(d)) d = '0' + d.slice(2);
  if (d.length !== 11 || !/^03/.test(d)) return null;
  for (const [re, name] of PK_NETWORKS) if (re.test(d)) return { num: d, net: name };
  return { num: d, net: 'Pakistan (unknown network)' };
}
// AES-256-CBC — fixed bot-side key, IV har encryption par random (iv:ciphertext)
const NX_VAULT_KEY = crypto.createHash('sha256').update('NEXORA-MD::nexa-vault::v1').digest();
function nxEncryptText(t) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', NX_VAULT_KEY, iv);
  return iv.toString('hex') + ':' + Buffer.concat([c.update(String(t), 'utf8'), c.final()]).toString('hex');
}
function nxDecryptText(s) {
  const parts = String(s || '').split(':');
  if (parts.length !== 2 || !/^[0-9a-f]{32}$/i.test(parts[0])) throw new Error('bad-format');
  const d = crypto.createDecipheriv('aes-256-cbc', NX_VAULT_KEY, Buffer.from(parts[0], 'hex'));
  return Buffer.concat([d.update(Buffer.from(parts[1], 'hex')), d.final()]).toString('utf8');
}
// Google Translate TTS → ogg/opus voice note buffer (.say jaisa, shared helper)
async function nxTtsBuffer(q, lang) {
  const chunks = q.match(/[\s\S]{1,180}(?=\s|$)|[\s\S]{1,180}/g) || [q];
  const parts = [];
  for (const ch of chunks) {
    const url = 'https://translate.google.com/translate_tts?ie=UTF-8&q=' + encodeURIComponent(ch) + `&tl=${lang}&client=tw-ob`;
    const r = await nxFetch(url, {}, 20000);
    if (!r.ok) throw new Error('tts http ' + r.status);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length < 500) throw new Error('tts empty');
    parts.push(b);
  }
  const stamp = Date.now() + '_' + Math.floor(Math.random() * 9999);
  const mp3p = `/tmp/nxtts_${stamp}.mp3`, oggp = `/tmp/nxtts_${stamp}.ogg`;
  fs.writeFileSync(mp3p, Buffer.concat(parts));
  try {
    await new Promise((res, rej) => execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp3p, '-c:a', 'libopus', '-b:a', '64k', oggp], { timeout: 30000 }, (e) => e ? rej(e) : res()));
    return fs.readFileSync(oggp);
  } finally { try { fs.unlinkSync(mp3p); } catch {} try { fs.unlinkSync(oggp); } catch {} }
}
async function nxIsGroupAdmin(sock, jid, sender) {
  try {
    const meta = await sock.groupMetadata(jid);
    const sNum = num(sender);
    return (meta.participants || []).some((p) => p.admin && [num(p.id), num(p.phoneNumber)].includes(sNum));
  } catch { return false; }
}
// per-chat/per-group toggle state
if (!STATE.antibot || typeof STATE.antibot !== 'object') STATE.antibot = {};
if (!STATE.antitag || typeof STATE.antitag !== 'object') STATE.antitag = {};
if (!STATE.autosticker || typeof STATE.autosticker !== 'object') STATE.autosticker = {};
if (!STATE.abwarn || typeof STATE.abwarn !== 'object') STATE.abwarn = {};
const _nxStickerAt = {};
// incoming-message guards: antibot / antitag / autosticker (chatbot aichat 'on' se chalta hai)
async function nxAutoGuards(sock, msg, sender, jid, text) {
  try {
    const fromMe = !!msg.key.fromMe;
    const isGroup = jid.endsWith('@g.us');
    if (fromMe || isOwnSessionMsg(msg, sender, jid)) return false;
    // 🛡️ antibot — doosre bots ke command-prefix wale messages
    if (isGroup && STATE.antibot[jid]) {
      const t = (text || '').trim();
      const foreign = ['!', '#', '/'].filter((p) => p !== config.prefix);
      if (t && foreign.some((p) => t.startsWith(p)) && !isOwnerMsg(msg, sender, jid) && !(await nxIsGroupAdmin(sock, jid, sender))) {
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
        const key = jid + '|' + num(sender);
        const n = (STATE.abwarn[key] || 0) + 1;
        STATE.abwarn[key] = n;
        if (Object.keys(STATE.abwarn).length > 500) STATE.abwarn = {};
        saveState();
        if (n >= 2) {
          try { await sock.groupParticipantsUpdate(jid, [sender], 'remove'); } catch {}
          delete STATE.abwarn[key]; saveState();
          await reply(sock, jid, msg, `🛡️ @${num(sender)} ko doosre bot ke commands par group se nikaal diya.`);
        } else {
          await sock.sendMessage(jid, { text: `⚠️ @${num(sender)} — is group mein doosre bots ke commands allowed nahi! (warning ${n}/2)`, mentions: [sender] });
        }
        return true;
      }
    }
    // 🚫 antitag — mass mention block
    if (isGroup && STATE.antitag[jid]) {
      const men = ctxOf(msg)?.mentionedJid || [];
      if (men.length >= 6 && !isOwnerMsg(msg, sender, jid) && !(await nxIsGroupAdmin(sock, jid, sender))) {
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
        await sock.sendMessage(jid, { text: `🚫 @${num(sender)} — mass-tagging allowed nahi hai!`, mentions: [sender] });
        return true;
      }
    }
    // 🎭 autosticker — har incoming photo ka sticker
    if (STATE.autosticker[jid] && msg.message?.imageMessage && !isOwnMsgId(msg.key?.id)) {
      const now = Date.now();
      if (now - (_nxStickerAt[jid] || 0) < 8000) return false;
      _nxStickerAt[jid] = now;
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: msg.message }, 'buffer', {});
        const webp = await imgToSticker(buf);
        await sock.sendMessage(jid, { sticker: await withStickerExif(webp) }, { quoted: msg });
      } catch {}
      return false; // flow jaari — caption wale commands bhi chalein
    }
  } catch {}
  return false;
}

const NX_PACK = {
  // ── download / tools ──
  alldown: {
    desc: 'Kisi bhi video link se download (TikTok/IG/FB/YouTube/X)',
    run: async (sock, msg, args, { jid }) => {
      const url = (args[0] || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}alldown <video-link>*\nMasalan: *${config.prefix}alldown https://www.tiktok.com/...*`);
      const u = url.toLowerCase();
      const [label, emoji] = /tiktok/.test(u) ? ['TikTok', '🎬']
        : /instagram/.test(u) ? ['Instagram', '📸']
        : /facebook|fb\.watch|fb\.com/.test(u) ? ['Facebook', '📘']
        : /youtube|youtu\.be/.test(u) ? ['YouTube', '▶️']
        : /x\.com|twitter/.test(u) ? ['X', '🐦'] : ['Video', '🎬'];
      await sendDownload(sock, jid, msg, url, label, emoji);
    },
  },

  apifetch: {
    desc: 'Kisi API URL ka JSON/text lao',
    run: async (sock, msg, args, { jid }) => {
      let u = (args[0] || '').trim();
      if (!u) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}apifetch <url>*\nMasalan: *${config.prefix}apifetch https://api.github.com/users/octocat*`);
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      if (nxBlockHost(u)) return reply(sock, jid, msg, '❌ Ye URL allowed nahi hai.');
      await reply(sock, jid, msg, '🌐 API se data la rahi hoon... 💗');
      try {
        const r = await nxFetch(u, {}, 25000);
        if (!r.ok) throw new Error('http ' + r.status);
        let txt = await r.text();
        try { txt = JSON.stringify(JSON.parse(txt), null, 2); } catch {}
        await reply(sock, jid, msg, `🌐 *API result*\n\n\`\`\`\n${txt.slice(0, 3000)}\n\`\`\``);
      } catch { await reply(sock, jid, msg, '❌ API se data nahi mil saka. URL check karo.'); }
    },
  },

  get: {
    desc: 'Direct link se file download karke bhejo (50MB tak)',
    run: async (sock, msg, args, { jid }) => {
      let u = (args[0] || '').trim();
      if (!u) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}get <file-link>*`);
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      if (nxBlockHost(u)) return reply(sock, jid, msg, '❌ Ye URL allowed nahi hai.');
      await reply(sock, jid, msg, '📥 File download ho rahi hai... 💗');
      try {
        const { buf, disp } = await nxDownloadBuf(u, 50 * 1024 * 1024);
        const name = nxFileName(u, disp, `file_${Date.now()}`);
        await sock.sendMessage(jid, { document: buf, fileName: name, mimetype: 'application/octet-stream' }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, e.message === 'too-big' ? '❌ File 50MB se bari hai, nahi bhej sakti.' : '❌ File download nahi ho saki. Link check karo.');
      }
    },
  },

  mediafire: {
    desc: 'Mediafire link se file download karo',
    run: async (sock, msg, args, { jid }) => {
      const link = (args[0] || '').trim();
      if (!link || !/mediafire\.com/i.test(link)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}mediafire <mediafire-link>*`);
      await reply(sock, jid, msg, '📥 Mediafire se nikal rahi hoon... 💗');
      try {
        const page = await nxFetch(link, {}, 25000);
        const html = await page.text();
        const m = html.match(/https?:\/\/download\d*\.mediafire\.com\/[^"'\\\s<>]+/i);
        if (!m) throw new Error('no-direct');
        const durl = m[0].replace(/\\u0026/g, '&');
        const { buf, disp } = await nxDownloadBuf(durl, 50 * 1024 * 1024);
        const name = nxFileName(link, disp, `mediafire_${Date.now()}`);
        await sock.sendMessage(jid, { document: buf, fileName: name, mimetype: 'application/octet-stream', caption: `📥 *Mediafire* — ${name}` }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, e.message === 'too-big' ? '❌ File 50MB se bari hai.' : '❌ Mediafire link se file nahi nikli (private/deleted link?).');
      }
    },
  },

  gdrive: {
    desc: 'Google Drive share link se file download karo',
    run: async (sock, msg, args, { jid }) => {
      const link = (args[0] || '').trim();
      const m1 = link.match(/\/d\/([-\w]{20,})/), m2 = link.match(/[?&]id=([-\w]{20,})/);
      const id = m1 ? m1[1] : (m2 ? m2[1] : null);
      if (!id) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}gdrive <drive-share-link>*\nLink mein file ID nahi mili.`);
      await reply(sock, jid, msg, '📥 Drive se la rahi hoon... 💗');
      try {
        let durl = `https://drive.google.com/uc?export=download&id=${id}`;
        let r = await nxFetch(durl, {}, 60000);
        if (/text\/html/i.test(r.headers.get('content-type') || '')) {
          const html = await r.text();
          const cm = html.match(/\/uc\?export=download[^"'<> ]*confirm=[^"'<> ]+/);
          const cm2 = html.match(new RegExp('confirm=([0-9A-Za-z_-]+)[^"\'<>]*id=' + id));
          if (cm) durl = 'https://drive.google.com' + cm[0].replace(/&amp;/g, '&');
          else if (cm2) durl = `https://drive.google.com/uc?export=download&confirm=${cm2[1]}&id=${id}`;
          else throw new Error('need-confirm');
          r = await nxFetch(durl, {}, 60000);
        }
        const len = parseInt(r.headers.get('content-length') || '0', 10);
        if (len > 50 * 1024 * 1024) throw new Error('too-big');
        const ab = await r.arrayBuffer();
        if (ab.byteLength > 50 * 1024 * 1024) throw new Error('too-big');
        if (ab.byteLength < 100) throw new Error('empty');
        const name = nxFileName(durl, r.headers.get('content-disposition') || '', `gdrive_${id.slice(0, 8)}`);
        await sock.sendMessage(jid, { document: Buffer.from(ab), fileName: name, mimetype: 'application/octet-stream', caption: `📥 *Google Drive* — ${name}` }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, e.message === 'too-big' ? '❌ File 50MB se bari hai.' : '❌ Drive se download nahi ho saka (link "Anyone with the link" par public hai?).');
      }
    },
  },

  gitclone: {
    desc: 'GitHub repo ka zip download karo',
    run: async (sock, msg, args, { jid }) => {
      let q = (args[0] || '').trim().replace(/\/$/, '');
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}gitclone <owner/repo>*\nMasalan: *${config.prefix}gitclone torvalds/linux*`);
      const gm = q.match(/github\.com\/([^/]+\/[^/]+)/i);
      if (gm) q = gm[1];
      if (!/^[^/\s]+\/[^/\s]+$/.test(q)) return reply(sock, jid, msg, `❌ Format: *owner/repo* — masalan *${config.prefix}gitclone torvalds/linux*`);
      await reply(sock, jid, msg, '📦 Repo ka zip bana rahi hoon... 💗');
      try {
        const info = await (await nxFetch(`https://api.github.com/repos/${q}`, {}, 20000)).json();
        if (info.message) throw new Error('no-repo');
        const branch = info.default_branch || 'main';
        const { buf } = await nxDownloadBuf(`https://codeload.github.com/${q}/zip/refs/heads/${branch}`, 50 * 1024 * 1024);
        const [, rname] = q.split('/');
        await sock.sendMessage(jid, { document: buf, fileName: `${rname}-${branch}.zip`, mimetype: 'application/zip', caption: `📦 *${q}* (${branch})\n⭐ ${info.stargazers_count || 0} stars` }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, e.message === 'too-big' ? '❌ Repo 50MB se bara hai.' : '❌ Repo nahi mila. Naam check karo (owner/repo).');
      }
    },
  },

  ssweb: {
    desc: 'Website ka HD screenshot',
    run: async (sock, msg, args, { jid }) => {
      let u = (args[0] || '').trim();
      if (!u) return reply(sock, jid, msg, `📸 Usage: *${config.prefix}ssweb <link>*\nMasalan: *${config.prefix}ssweb google.com*`);
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      if (nxBlockHost(u)) return reply(sock, jid, msg, '❌ Ye URL allowed nahi hai.');
      await reply(sock, jid, msg, '📸 Screenshot le rahi hoon... 💗');
      try {
        let buf = null;
        try {
          const r = await nxFetch('https://image.thum.io/get/width/900/crop/700/noanimate/' + u, {}, 60000);
          const b = Buffer.from(await r.arrayBuffer());
          if (r.ok && b.length > 5000) buf = b;
        } catch {}
        if (!buf) {
          const r = await nxFetch(`https://api.microlink.io/?url=${encodeURIComponent(u)}&screenshot=true&meta=false`, {}, 45000);
          const j = await r.json();
          const shot = j && j.data && j.data.screenshot && j.data.screenshot.url;
          if (!shot) throw new Error('no-shot');
          const img = await nxFetch(shot, {}, 45000);
          const b = Buffer.from(await img.arrayBuffer());
          if (b.length < 5000) throw new Error('bad-img');
          buf = b;
        }
        await sock.sendMessage(jid, { image: buf, caption: `📸 *${u}*` }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Screenshot nahi le saki. Link check karo.'); }
    },
  },

  remini: {
    desc: 'Photo enhance karo (reply mein photo)',
    run: async (sock, msg, args, { jid }) => {
      const img = ctxOf(msg)?.quotedMessage?.imageMessage || msg.message?.imageMessage;
      if (!img) return reply(sock, jid, msg, `❌ Kisi photo ke reply mein *${config.prefix}remini* likhein.`);
      await reply(sock, jid, msg, '✨ Photo nikhaar rahi hoon... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: img } }, 'buffer', {});
        const out = await sharp(buf).sharpen({ sigma: 1.2 }).normalize().modulate({ brightness: 1.04, saturation: 1.15 }).jpeg({ quality: 92 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '✨ *Enhanced* — roshni, rang aur sharpness behtar' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Enhance nahi ho saki, dobara try karein.'); }
    },
  },

  // ── AI / chat ──
  chatbot: {
    desc: 'AI auto-reply on/off (is chat mein)',
    run: async (sock, msg, args, { jid }) => {
      const v = (args[0] || '').toLowerCase();
      if (!STATE.aichat || typeof STATE.aichat !== 'object' || Array.isArray(STATE.aichat)) STATE.aichat = {};
      if (v === 'on') {
        STATE.aichat[jid] = 'on'; saveState(); writeGlobalAichat(jid, 'on');
        return reply(sock, jid, msg, '🤖 *Chatbot: ✅ ON* 💗\n\nAb is chat ke har message ka jawab dungi!');
      }
      if (v === 'off') {
        STATE.aichat[jid] = 'off'; if (STATE.aihist) delete STATE.aihist[jid]; saveState(); writeGlobalAichat(jid, 'off');
        return reply(sock, jid, msg, '🤖 *Chatbot: ⛔ OFF*\n\nAb auto-reply band — sirf commands chalenge.');
      }
      const cur = STATE.aichat[jid];
      return reply(sock, jid, msg, `🤖 *Chatbot* abhi *${cur === 'on' ? 'ON ✅' : 'OFF ⛔'}* hai.\n\nUsage: *${config.prefix}chatbot on* ya *${config.prefix}chatbot off*`);
    },
  },

  tts: {
    desc: 'Text → voice note',
    run: async (sock, msg, args, { jid }) => {
      let lang = 'ur', q = args.join(' ').trim();
      const first = (args[0] || '').toLowerCase();
      if (first === 'en' || first === 'english') { lang = 'en'; q = args.slice(1).join(' ').trim(); }
      else if (first === 'ur' || first === 'urdu') { q = args.slice(1).join(' ').trim(); }
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}tts <text>*\nMasalan: *${config.prefix}tts Assalam o Alaikum*`);
      q = q.slice(0, 400);
      await reply(sock, jid, msg, '🎙 Awaz bana rahi hoon... 💗');
      try {
        const ogg = await nxTtsBuffer(q, lang);
        await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Awaz nahi ban saki, thodi der baad try karein.'); }
    },
  },

  autosticker: {
    desc: 'Har photo ka auto-sticker on/off (is chat mein)',
    run: async (sock, msg, args, { jid }) => {
      const v = (args[0] || '').toLowerCase();
      if (v === 'on') { STATE.autosticker[jid] = true; saveState(); return reply(sock, jid, msg, '🎭 *Autosticker: ✅ ON* 💗\n\nAb har photo ka sticker khud ban jayega!'); }
      if (v === 'off') { delete STATE.autosticker[jid]; saveState(); return reply(sock, jid, msg, '🎭 *Autosticker: ⛔ OFF*'); }
      return reply(sock, jid, msg, `🎭 *Autosticker* abhi *${STATE.autosticker[jid] ? 'ON ✅' : 'OFF ⛔'}* hai.\n\nUsage: *${config.prefix}autosticker on* ya *${config.prefix}autosticker off*`);
    },
  },

  // ── group admin ──
  antibot: {
    desc: 'Doosre bots ke commands block karo (group)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const v = (args[0] || '').toLowerCase();
      if (v === 'on') { STATE.antibot[jid] = true; saveState(); return reply(sock, jid, msg, '🛡️ *Antibot: ✅ ON* 💗\n\nDoosre bots ke commands delete honge — 2 warnings par kick!'); }
      if (v === 'off') { delete STATE.antibot[jid]; saveState(); return reply(sock, jid, msg, '🛡️ *Antibot: ⛔ OFF*'); }
      return reply(sock, jid, msg, `🛡️ *Antibot* abhi *${STATE.antibot[jid] ? 'ON ✅' : 'OFF ⛔'}* hai.\n\nUsage: *${config.prefix}antibot on* ya *${config.prefix}antibot off*`);
    },
  },

  antifake: {
    desc: 'Fake (ghair-Pakistani) numbers auto-kick karo (group) 🛡️',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf groups mein chalti hai.');
      const v = (args[0] || '').toLowerCase();
      STATE.antifake = STATE.antifake || {};
      if (v === 'on') { STATE.antifake[jid] = true; saveState(); return reply(sock, jid, msg, '🛡️ *Antifake: ✅ ON* 💗\n\nAb ghair-Pakistani (+92 ke baghair) number join karte hi kick honge!'); }
      if (v === 'off') { delete STATE.antifake[jid]; saveState(); return reply(sock, jid, msg, '🛡️ *Antifake: ⛔ OFF*'); }
      return reply(sock, jid, msg, `🛡️ *Antifake* abhi *${STATE.antifake[jid] ? 'ON ✅' : 'OFF ⛔'}* hai.\n\nUsage: *${config.prefix}antifake on* ya *${config.prefix}antifake off*`);
    },
  },

  antitag: {
    desc: 'Mass-tagging block karo (group)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const v = (args[0] || '').toLowerCase();
      if (v === 'on') { STATE.antitag[jid] = true; saveState(); return reply(sock, jid, msg, '🚫 *Antitag: ✅ ON* 💗\n\nAb mass-tag wale messages delete honge!'); }
      if (v === 'off') { delete STATE.antitag[jid]; saveState(); return reply(sock, jid, msg, '🚫 *Antitag: ⛔ OFF*'); }
      return reply(sock, jid, msg, `🚫 *Antitag* abhi *${STATE.antitag[jid] ? 'ON ✅' : 'OFF ⛔'}* hai.\n\nUsage: *${config.prefix}antitag on* ya *${config.prefix}antitag off*`);
    },
  },

  acceptall: {
    desc: 'Saari group join requests accept karo (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      let list = [];
      try { list = await sock.groupRequestParticipantsList(jid); } catch { return reply(sock, jid, msg, '❌ Requests nahi mil sakin (bot admin hai?).'); }
      if (!list || !list.length) return reply(sock, jid, msg, '✅ Koi pending request nahi 💗');
      let ok = 0, fail = 0;
      for (const v of list) {
        const pj = v.jid || v.participant;
        if (!pj) { fail++; continue; }
        try { await sock.groupRequestParticipantsUpdate(jid, [pj], 'approve'); ok++; } catch { fail++; }
        await new Promise((r) => setTimeout(r, 400));
      }
      await reply(sock, jid, msg, `✅ *Acceptall mukammal*\n\nApprove: ${ok}\nFail: ${fail}`);
    },
  },

  rejectall: {
    desc: 'Saari group join requests reject karo (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      let list = [];
      try { list = await sock.groupRequestParticipantsList(jid); } catch { return reply(sock, jid, msg, '❌ Requests nahi mil sakin (bot admin hai?).'); }
      if (!list || !list.length) return reply(sock, jid, msg, '✅ Koi pending request nahi 💗');
      let ok = 0, fail = 0;
      for (const v of list) {
        const pj = v.jid || v.participant;
        if (!pj) { fail++; continue; }
        try { await sock.groupRequestParticipantsUpdate(jid, [pj], 'reject'); ok++; } catch { fail++; }
        await new Promise((r) => setTimeout(r, 400));
      }
      await reply(sock, jid, msg, `🚫 *Rejectall mukammal*\n\nReject: ${ok}\nFail: ${fail}`);
    },
  },

  // ── info ──
  phoneinfo: {
    desc: 'Number se network maloom karo (PK)',
    run: async (sock, msg, args, { jid }) => {
      const info = nxPkInfo(args[0] || '');
      if (!info) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}phoneinfo <number>*\nMasalan: *${config.prefix}phoneinfo 03011234567*\n\n(Sirf Pakistani mobile numbers — network/region, koi personal data nahi)`);
      await reply(sock, jid, msg, `📲 *Phone info*\n\nNumber: \`${info.num}\`\nNetwork: *${info.net}*\nMulk: Pakistan 🇵🇰`);
    },
  },

  praytime: {
    desc: 'Namaz ke auqat (Pakistan)',
    run: async (sock, msg, args, { jid }) => {
      const city = args.join(' ').trim() || 'Lahore';
      await reply(sock, jid, msg, `🕌 *${city}* ke auqat la rahi hoon... 💗`);
      try {
        const r = await nxFetch(`https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=Pakistan&method=2`, {}, 20000);
        const j = await r.json();
        const t = j && j.data && j.data.timings;
        if (!t || !t.Fajr) throw new Error('no-data');
        const hh = (s) => String(s || '').split(' ')[0];
        await reply(sock, jid, msg, `🕌 *Namaz ke auqat — ${city}*\n\n🌅 Fajr: ${hh(t.Fajr)}\n☀️ Sunrise: ${hh(t.Sunrise)}\n🌤️ Dhuhr: ${hh(t.Dhuhr)}\n🌇 Asr: ${hh(t.Asr)}\n🌆 Maghrib: ${hh(t.Maghrib)}\n🌙 Isha: ${hh(t.Isha)}`);
      } catch { await reply(sock, jid, msg, '❌ Auqat nahi mil sake. Sheher ka naam check karo.'); }
    },
  },

  quran: {
    desc: 'Quran: ayat tarjuma / poori surah / poora para (audio) 📖',
    run: async (sock, msg, args, { jid }) => {
      const P = config.prefix;
      const sub = String(args[0] || '').toLowerCase();
      const OPTS = `📖 *QURAN MAJEED* 📖\n\nKya sunna chahte ho?\n\n1️⃣ *Mukammal Surah* — *${P}quran surah <naam/number>*\n   Masalan: *${P}quran surah Yaseen*\n2️⃣ *Mukammal Para* — *${P}quran para <1-30>*\n   Masalan: *${P}quran para 30*\n3️⃣ *Ayat ka tarjuma* — *${P}quran <surah>:<ayat>*\n   Masalan: *${P}quran 56:62*\n4️⃣ *Random Ayat* — *${P}quran random*\n\n🎧 Audio: Mishary Alafasy`;
      if (!args.length) return reply(sock, jid, msg, OPTS);
      // ── 1️⃣ poori surah ki audio ──
      if (sub === 'surah' || sub === 'surat') {
        const q = args.slice(1).join(' ').trim();
        const sn = quranSurahNum(q);
        if (!sn) return reply(sock, jid, msg, `❌ Surah nahi mili.\nUsage: *${P}quran surah <naam/number>*\nMasalan: *${P}quran surah Yaseen* ya *${P}quran surah 36*`);
        const sname = QURAN_SURAHS[sn - 1];
        await reply(sock, jid, msg, `📖 *Surah ${sname}* ki audio la rahi hoon... 🎧`);
        try {
          const f = await quranSurahDl(sn);
          const cap = `📖 *Surah ${sname}* — Mishary Alafasy 🎧`;
          if (f.size > 45 * 1024 * 1024) {
            await sock.sendMessage(jid, { document: f.buf, mimetype: 'audio/mpeg', fileName: `Surah-${sname}.mp3`, caption: cap + `\n\n_⚠️ File bari thi (${(f.size / 1048576).toFixed(0)} MB), is liye document ke tor par bheji hai._` }, { quoted: msg });
          } else {
            await sock.sendMessage(jid, { audio: f.buf, mimetype: 'audio/mpeg', fileName: `Surah-${sname}.mp3` }, { quoted: msg });
            await reply(sock, jid, msg, cap);
          }
          try { fs.unlinkSync(f.path); } catch {}
        } catch { return reply(sock, jid, msg, '❌ Audio nahi mil saki, dobara try karein.'); }
        return;
      }
      // ── 2️⃣ poore pare ki audio (ayah MP3s jor kar) ──
      if (sub === 'para' || sub === 'juz' || sub === 'sipara') {
        const n = parseInt(args[1], 10);
        if (!n || n < 1 || n > 30) return reply(sock, jid, msg, `❌ Usage: *${P}quran para <1-30>*\nMasalan: *${P}quran para 30*`);
        await reply(sock, jid, msg, `📖 *Para ${n}* ki audio tayyar kar rahi hoon... ⏳\n_(sab ayatein jor rahi hoon, thoda waqt lagega)_`);
        const cleanup = [];
        try {
          const r = await nxFetch(`https://api.alquran.cloud/v1/juz/${n}/ar.alafasy`, {}, 30000);
          const jj = await r.json();
          const ayahs = jj && jj.data && jj.data.ayahs;
          if (!Array.isArray(ayahs) || !ayahs.length) throw new Error('no-ayahs');
          let urls = ayahs.map(a => a.audio).filter(Boolean);
          const headSz = async (u) => { try { const h = await nxFetch(u, { method: 'HEAD' }, 15000); return parseInt(h.headers.get('content-length') || '0', 10) || 0; } catch { return 0; } };
          const sumHeads = async (us) => {
            // 30 evenly-spaced samples -> extrapolate (poore 564 HEADs bohat slow thay)
            const idx = []; const step = Math.max(1, Math.floor(us.length / 30));
            for (let i = 0; i < us.length && idx.length < 30; i += step) idx.push(i);
            const rs = await Promise.all(idx.map(i => headSz(us[i])));
            const good = rs.filter(x => x > 0);
            const avg = good.reduce((a, b) => a + b, 0) / Math.max(1, good.length);
            return avg * us.length;
          };
          let total = await sumHeads(urls);
          if (total > 45 * 1024 * 1024) { urls = urls.map(u => u.replace('/audio/128/', '/audio/64/')); total = await sumHeads(urls); }
          const files = [];
          for (let i = 0; i < urls.length; i += 12) {
            const rs = await Promise.all(urls.slice(i, i + 12).map(async (u, k) => {
              const p = `/tmp/qpara${n}_${i + k}.mp3`; cleanup.push(p);
              try { await qRun('curl', ['-sL', '--max-time', '60', '-o', p, u], 70000); if (fs.statSync(p).size > 1024) return p; } catch {}
              return null;
            }));
            rs.forEach(p => { if (p) files.push(p); });
          }
          if (!files.length) throw new Error('dl-fail');
          const listP = `/tmp/qpara${n}_list.txt`; cleanup.push(listP);
          fs.writeFileSync(listP, files.map(f => `file '${f}'`).join('\n'));
          const out = `/tmp/qpara${n}_full.mp3`; cleanup.push(out);
          await qRun('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listP, '-c', 'copy', out], 120000);
          const buf = fs.readFileSync(out);
          if (!buf.length) throw new Error('concat-fail');
          const cap = `📖 *Para ${n}* — mukammal tilawat 🎧\n_Mishary Alafasy_`;
          if (buf.length > 45 * 1024 * 1024) {
            await sock.sendMessage(jid, { document: buf, mimetype: 'audio/mpeg', fileName: `Para-${n}.mp3`, caption: cap + `\n\n_⚠️ File bari thi (${(buf.length / 1048576).toFixed(0)} MB), document ke tor par bheji hai._` }, { quoted: msg });
          } else {
            await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', fileName: `Para-${n}.mp3` }, { quoted: msg });
            await reply(sock, jid, msg, cap);
          }
        } catch { await reply(sock, jid, msg, '❌ Para ki audio tayyar nahi ho saki, dobara try karein.'); }
        cleanup.forEach(p => { try { fs.unlinkSync(p); } catch {} });
        return;
      }
      // ── 4️⃣ random ayat (purana behavior — bilkul waisa hi) ──
      if (sub === 'random') {
        await reply(sock, jid, msg, '📖 Ayat la rahi hoon... 💗');
        try {
          const nn = Math.floor(Math.random() * 6236) + 1;
          const r = await nxFetch(`https://api.alquran.cloud/v1/ayah/${nn}/editions/quran-uthmani,ur.jalandhry`, {}, 20000);
          const j = await r.json();
          const d = j && j.data;
          if (!Array.isArray(d) || d.length < 2) throw new Error('no-data');
          const surah = (d[1].surah && d[1].surah.englishName) || '', ayah = d[1].numberInSurah || '';
          await reply(sock, jid, msg, `📖 *Surah ${surah} — Ayat ${ayah}*\n\n${d[0].text}\n\n_"${String(d[1].text || '').slice(0, 600)}"_`);
        } catch { await reply(sock, jid, msg, '❌ Ayat nahi mil saki, dobara try karein.'); }
        return;
      }
      // ── 3️⃣ makhsoos ayat: <surah>:<ayat> ──
      const m = args.join(' ').match(/(\d+)\s*[:.\-\s]\s*(\d+)/);
      if (m) {
        const sn = parseInt(m[1], 10), an = parseInt(m[2], 10);
        if (sn < 1 || sn > 114) return reply(sock, jid, msg, `❌ Surah number 1-114 ke darmiyan ho.\nMasalan: *${P}quran 56:62*`);
        await reply(sock, jid, msg, '📖 Ayat la rahi hoon... 💗');
        try {
          const r = await nxFetch(`https://api.alquran.cloud/v1/surah/${sn}/editions/quran-uthmani,ur.jalandhry`, {}, 25000);
          const j = await r.json();
          const dd = j && j.data;
          if (!Array.isArray(dd) || dd.length < 2) throw new Error('no-data');
          const ay = (dd[0].ayahs || []).find(a => a.numberInSurah === an);
          const ayU = (dd[1].ayahs || []).find(a => a.numberInSurah === an);
          if (!ay) throw new Error('no-ayah');
          const sname = (dd[0].englishName) || QURAN_SURAHS[sn - 1];
          await reply(sock, jid, msg, `📖 *Surah ${sname} — Ayat ${an}*\n\n${ay.text}\n\n_"${String((ayU && ayU.text) || '').slice(0, 600)}"_`);
        } catch { await reply(sock, jid, msg, '❌ Ye ayat nahi mili, number check karein.'); }
        return;
      }
      return reply(sock, jid, msg, OPTS);
    },
  },

  movie: {
    desc: 'Film/show ki maloomat',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim();
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}movie <naam>*\nMasalan: *${config.prefix}movie 3 idiots*`);
      await reply(sock, jid, msg, '🎬 Maloomat dhoond rahi hoon... 💗');
      try {
        const r = await nxFetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`, {}, 20000);
        const j = await r.json();
        const s = j && j[0] && j[0].show;
        if (!s) throw new Error('no-tvmaze');
        const summary = String(s.summary || '').replace(/<[^>]+>/g, '').trim().slice(0, 400);
        const cap = `🎬 *${s.name}*\n\n⭐ Rating: ${(s.rating && s.rating.average) || 'N/A'}\n🎭 Genre: ${(s.genres || []).join(', ') || 'N/A'}\n📅 Premiered: ${s.premiered || 'N/A'}\n\n${summary}`;
        if (s.image && s.image.medium) {
          try {
            const im = await nxFetch(s.image.medium, {}, 20000);
            const b = Buffer.from(await im.arrayBuffer());
            if (b.length > 2000) { await sock.sendMessage(jid, { image: b, caption: cap }, { quoted: msg }); return; }
          } catch {}
        }
        await reply(sock, jid, msg, cap);
      } catch {
        try {
          const r2 = await nxFetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`, {}, 20000);
          const w = await r2.json();
          if (!w || !w.extract) throw new Error('no-wiki');
          await reply(sock, jid, msg, `🎬 *${w.title}*\n\n${String(w.extract).slice(0, 700)}`);
        } catch { await reply(sock, jid, msg, '❌ Ye film/show nahi mila. Naam check karo.'); }
      }
    },
  },

  gitstalk: {
    desc: 'GitHub profile dekho',
    run: async (sock, msg, args, { jid }) => {
      const u = (args[0] || '').trim().replace(/^@/, '');
      if (!u || !/^[a-z0-9-]+$/i.test(u)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}gitstalk <username>*\nMasalan: *${config.prefix}gitstalk torvalds*`);
      await reply(sock, jid, msg, '🔍 Profile dhoond rahi hoon... 💗');
      try {
        const r = await nxFetch(`https://api.github.com/users/${encodeURIComponent(u)}`, {}, 20000);
        const j = await r.json();
        if (j.message) throw new Error('no-user');
        const cap = `💻 *${j.login}*${j.name ? ` (${j.name})` : ''}\n\n📝 ${j.bio || '—'}\n📦 Repos: ${j.public_repos}\n👥 Followers: ${j.followers} | Following: ${j.following}\n📅 Joined: ${String(j.created_at || '').slice(0, 10)}`;
        try {
          const im = await nxFetch(j.avatar_url, {}, 20000);
          const b = Buffer.from(await im.arrayBuffer());
          if (b.length > 2000) { await sock.sendMessage(jid, { image: b, caption: cap }, { quoted: msg }); return; }
        } catch {}
        await reply(sock, jid, msg, cap);
      } catch { await reply(sock, jid, msg, '❌ Ye GitHub user nahi mila.'); }
    },
  },

  ipstalk: {
    desc: 'IP/domain ki maloomat',
    run: async (sock, msg, args, { jid }) => {
      const q = (args[0] || '').trim();
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}ipstalk <ip ya domain>*\nMasalan: *${config.prefix}ipstalk 8.8.8.8*`);
      await reply(sock, jid, msg, '🔍 Maloomat nikal rahi hoon... 💗');
      try {
        const r = await nxFetch(`http://ip-api.com/json/${encodeURIComponent(q)}?fields=status,message,country,regionName,city,isp,org,as,query`, {}, 20000);
        const j = await r.json();
        if (j.status !== 'success') throw new Error(j.message || 'fail');
        await reply(sock, jid, msg, `🌐 *IP info — ${j.query}*\n\n🏳️ Mulk: ${j.country || 'N/A'}\n📍 Sheher: ${j.city || 'N/A'}${j.regionName ? `, ${j.regionName}` : ''}\n🏢 ISP: ${j.isp || 'N/A'}\n🏛️ Org: ${j.org || 'N/A'}\n🔌 AS: ${j.as || 'N/A'}`);
      } catch { await reply(sock, jid, msg, '❌ Maloomat nahi mil sakin. IP/domain check karo.'); }
    },
  },

  npmstalk: {
    desc: 'npm package ki info',
    run: async (sock, msg, args, { jid }) => {
      const p = (args[0] || '').trim().toLowerCase();
      if (!p || !/^[@a-z0-9][@a-z0-9/._-]*$/i.test(p)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}npmstalk <package>*\nMasalan: *${config.prefix}npmstalk express*`);
      await reply(sock, jid, msg, '📦 Package dhoond rahi hoon... 💗');
      try {
        const r = await nxFetch(`https://registry.npmjs.org/${encodeURIComponent(p).replace('%2F', '/')}/latest`, {}, 20000);
        if (!r.ok) throw new Error('no-pkg');
        const j = await r.json();
        await reply(sock, jid, msg, `📦 *${j.name}* v${j.version}\n\n📝 ${String(j.description || '—').slice(0, 400)}\n⚖️ License: ${j.license || 'N/A'}${j.homepage ? `\n🏠 ${j.homepage}` : ''}`);
      } catch { await reply(sock, jid, msg, '❌ Ye npm package nahi mila.'); }
    },
  },

  // ── fun / util ──
  encrypt: {
    desc: 'Text ko secret code mein badlo',
    run: async (sock, msg, args, { jid }) => {
      const t = args.join(' ').trim();
      if (!t) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}encrypt <text>*`);
      try {
        await reply(sock, jid, msg, `🔐 *Encrypted*\n\n\`${nxEncryptText(t).slice(0, 1500)}\`\n\nWapas kholne ke liye: *${config.prefix}decrypt <code>*`);
      } catch { await reply(sock, jid, msg, '❌ Encrypt nahi ho saka.'); }
    },
  },

  decrypt: {
    desc: 'Secret code wapas kholo',
    run: async (sock, msg, args, { jid }) => {
      const t = args.join(' ').trim();
      if (!t) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}decrypt <code>*`);
      try {
        await reply(sock, jid, msg, `🔓 *Decrypted*\n\n${nxDecryptText(t).slice(0, 1500)}`);
      } catch { await reply(sock, jid, msg, '❌ Code ghalat hai ya khul nahi saka.'); }
    },
  },
};
Object.assign(commands, NX_PACK);

// ─── ⚙️ settings helpers ───
function getSetting(k, def) { const v = (STATE.settings || {})[k]; return v === undefined ? def : v; }
function setSetting(k, v) { if (!STATE.settings || typeof STATE.settings !== 'object') STATE.settings = {}; STATE.settings[k] = v; saveState(); }
function maskNum(d) { d = num(d); return d ? '...' + d.slice(-4) : '?'; }

// owner settings toggle helper (autoread, antilink, antistatus, recording, statusview, anticall, adminaction, autotyping, mentionreply)
async function settingsToggle(sock, msg, jid, args, key, label) {
  const v = (args[0] || '').toLowerCase();
  if (v === 'on' || v === 'off') {
    setSetting(key, v === 'on');
    await reply(sock, jid, msg, `${label}: ${v === 'on' ? '✅ ON' : '⛔ OFF'}`);
  } else {
    await reply(sock, jid, msg, `${label} abhi *${getSetting(key) ? 'ON ✅' : 'OFF ❌'}* hai.\n\nUsage: *${config.prefix}${key} on* ya *${config.prefix}${key} off*`);
  }
}

// ─── TikTok keyword search (tikwm + public mirrors) ───
async function tiktokSearch(q) {
  const base = `https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(q)}&count=6&cursor=0&HD=1`;
  const urls = [base,
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(base),
    'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(base),
  ];
  for (const u of urls) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
      const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://www.tikwm.com/', 'Accept': 'application/json' }, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const j = await res.json();
      const data = j && j.data && j.data.videos;
      if (Array.isArray(data) && data.length) {
        return data.slice(0, 6).map((v) => ({
          title: v.title || '',
          author: (v.author && (v.author.unique_id || v.author.nickname)) || 'tiktok',
          play: v.play || v.wmplay || '',
          url: v.video_id ? `https://www.tiktok.com/@${(v.author && v.author.unique_id) || 'tiktok'}/video/${v.video_id}` : '',
          likes: v.digg_count || 0,
          plays: v.play_count || 0,
        })).filter((v) => v.play);
      }
    } catch {}
  }
  return [];
}
async function fetchBuf(url) {
  if (!url) return null;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch { clearTimeout(t); return null; }
}
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ─── sticker EXIF (pack name) — node-webpmux optional ───
let _webpmux = null;
async function withStickerExif(buf) {
  try {
    const pack = getSetting('stickername');
    if (!pack) return buf;
    if (_webpmux === null) { try { _webpmux = require('node-webpmux'); } catch { _webpmux = false; } }
    if (!_webpmux) return buf;
    const img = new _webpmux.Image();
    await img.load(buf);
    const json = { 'sticker-pack-id': 'nexora-md', 'sticker-pack-name': pack, 'sticker-pack-publisher': config.botName, 'android-app-store-link': '', 'ios-app-store-link': '' };
    const jb = Buffer.from(JSON.stringify(json), 'utf8');
    const little = Buffer.alloc(2); little.writeUInt16LE(jb.length, 0);
    const head = Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    img.exif = Buffer.concat([head, little, jb]);
    return await img.save(null);
  } catch { return buf; }
}

// ═══════════ 34 NAYE COMMANDS ═══════════
const NEW_COMMANDS_34 = {
  tiktoksearch: {
    desc: 'TikTok par video search karo',
    run: async (sock, msg, args, { jid }) => {
      const q = (args || []).join(' ').trim();
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}tiktoksearch <lafz>*\nMasalan: *${config.prefix}tiktoksearch funny cats*`);
      await reply(sock, jid, msg, `🔍 TikTok par *"${q}"* dhoondh rahi hoon... 💗`);
      const vids = await tiktokSearch(q);
      if (!vids.length) return reply(sock, jid, msg, '❌ TikTok search se kuch nahi mila — thodi der baad dobara try karein.');
      const lines = vids.slice(0, 3).map((v, i) => `${i + 1}. @${v.author} — ❤️ ${fmtNum(v.likes)} · ▶️ ${fmtNum(v.plays)}\n   📝 ${(v.title || '').slice(0, 80)}\n   🔗 ${v.url}`);
      const caption = `🎵 *TikTok Search:* ${q}\n\n${lines.join('\n')}`;
      try {
        const buf = await fetchBuf(vids[0].play);
        if (buf && buf.length > 150 * 1024) {
          await sock.sendMessage(jid, { video: buf, caption }, { quoted: msg });
          return;
        }
      } catch {}
      await reply(sock, jid, msg, caption + '\n\n_(pehli video download nahi ho saki — link khol kar dekhein)_');
    },
  },

  blocklist: {
    desc: 'Blocked numbers ki list (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      try {
        const list = await sock.fetchBlocklist();
        if (!list || !list.length) return reply(sock, jid, msg, '✅ Blocklist khaali hai — koi blocked number nahi.');
        const lines = list.map((x, i) => `${i + 1}. ${maskNum(x)}`);
        await reply(sock, jid, msg, `🚫 *Blocked:* ${list.length}\n\n${lines.join('\n')}`);
      } catch { await reply(sock, jid, msg, '❌ Blocklist nahi mil saki.'); }
    },
  },

  getbio: {
    desc: 'Kisi number ki bio dekho',
    run: async (sock, msg, args, { jid }) => {
      let target = ctxOf(msg)?.participant;
      if (!target && args[0]) { const d = num(args[0]); if (d.length >= 7) target = d + '@s.whatsapp.net'; }
      if (!target) target = sock.user?.id;
      if (!target) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}getbio* (kisi ke message ka reply) ya *${config.prefix}getbio <number>*`);
      try {
        const res = await sock.fetchStatus(target);
        const st = Array.isArray(res) ? res[0] : res;
        let bio = '', when = '';
        if (st) {
          if (st.status && typeof st.status === 'object') { bio = st.status.status || ''; when = st.status.setAt || ''; }
          else { bio = st.status || ''; when = st.setAt || ''; }
        }
        const whenTxt = when ? new Date(when).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' }) : '';
        await reply(sock, jid, msg, `📝 *Bio:* ${maskNum(target)}\n\n${bio || '_(koi bio nahi lagi)_'}${whenTxt ? `\n\n🕐 Set: ${whenTxt}` : ''}`);
      } catch { await reply(sock, jid, msg, '❌ Bio nahi mil saki.'); }
    },
  },

  getprivacy: {
    desc: 'Bot ki privacy settings dekho (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      try {
        const p = await sock.fetchPrivacySettings(true);
        const L = { last: '👁 Last seen', online: '🟢 Online status', profile: '🖼 Profile photo', status: '📝 About/Status', readreceipts: '✔✔ Read receipts', groupadd: '👥 Group add', calladd: '📞 Calls' };
        const val = (v) => ({ all: 'Everyone', contacts: 'My contacts', contact_blacklist: 'Contacts except...', none: 'Nobody', match_last_seen: 'Same as last seen' }[v] || v);
        const lines = Object.keys(L).filter((k) => p && p[k] !== undefined).map((k) => `${L[k]}: *${val(p[k])}*`);
        await reply(sock, jid, msg, `🔐 *Privacy settings*\n\n${lines.join('\n') || '_(kuch nahi mila)_'}`);
      } catch { await reply(sock, jid, msg, '❌ Privacy settings nahi mil saki.'); }
    },
  },

  groupsprivacy: {
    desc: 'Group-add privacy dekho/set karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const map = { everyone: 'all', contacts: 'contacts', nobody: 'contact_blacklist' };
      const v = (args[0] || '').toLowerCase();
      try {
        if (map[v]) {
          await sock.updateGroupsAddPrivacy(map[v]);
          return reply(sock, jid, msg, `✅ Group-add privacy: *${v}*`);
        }
        const p = await sock.fetchPrivacySettings(true);
        await reply(sock, jid, msg, `👥 *Group-add privacy:* ${p?.groupadd || '?'}\n\nChange: *${config.prefix}groupsprivacy <everyone|contacts|nobody>*`);
      } catch { await reply(sock, jid, msg, '❌ Privacy update nahi ho saki.'); }
    },
  },

  setppall: {
    desc: 'Bot ki DP change karo — photo ke reply mein (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const img = ctxOf(msg)?.quotedMessage?.imageMessage || msg.message?.imageMessage;
      if (!img) return reply(sock, jid, msg, `❌ Kisi photo ke reply mein *${config.prefix}setppall* likhein.`);
      await reply(sock, jid, msg, '⏳ DP update kar rahi hoon... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: img } }, 'buffer', {});
        await sock.updateProfilePicture(sock.user.id, buf);
        await reply(sock, jid, msg, '✅ Bot ki DP change ho gayi! 💗');
      } catch { await reply(sock, jid, msg, '❌ DP change nahi ho saki.'); }
    },
  },

  setonline: {
    desc: 'Bot ko online dikhao (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      try { await sock.sendPresenceUpdate('available'); await reply(sock, jid, msg, '🟢 Ab main *online* dikhoongi.'); }
      catch { await reply(sock, jid, msg, '❌ Online status set nahi ho saka.'); }
    },
  },

  setname: {
    desc: 'Bot ka WhatsApp naam change karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const name = (args || []).join(' ').trim().slice(0, 25);
      if (!name) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}setname <naya naam>*`);
      try { await sock.updateProfileName(name); await reply(sock, jid, msg, `✅ Bot ka naam: *${name}*`); }
      catch { await reply(sock, jid, msg, '❌ Naam change nahi ho saka.'); }
    },
  },

  updatebio: {
    desc: 'Bot ki bio/about change karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const bio = (args || []).join(' ').trim().slice(0, 139);
      if (!bio) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}updatebio <nayi bio>*`);
      try { await sock.updateProfileStatus(bio); await reply(sock, jid, msg, `✅ Bio update ho gayi:\n_${bio}_`); }
      catch { await reply(sock, jid, msg, '❌ Bio update nahi ho saki.'); }
    },
  },

  botdp: {
    desc: 'Bot ki apni DP dekho',
    run: async (sock, msg, args, { jid }) => {
      try {
        const url = await sock.profilePictureUrl(sock.user.id, 'image');
        if (!url) return reply(sock, jid, msg, '🖼 Bot ki koi DP nahi lagi.');
        await sock.sendMessage(jid, { image: { url }, caption: `💗 *${config.botName}* ki DP` }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ DP nahi mil saki.'); }
    },
  },

  welcome: {
    desc: 'Group welcome message on/off (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const v = (args[0] || '').toLowerCase();
      const cur = !!((STATE.settings || {}).welcome || {})[jid];
      if (v === 'on' || v === 'off') {
        if (!STATE.settings.welcome) STATE.settings.welcome = {};
        STATE.settings.welcome[jid] = v === 'on'; saveState();
        await reply(sock, jid, msg, v === 'on' ? '🎉 Welcome: ✅ ON' : '🎉 Welcome: ⛔ OFF');
      } else {
        await reply(sock, jid, msg, `🎉 Welcome abhi *${cur ? 'ON ✅' : 'OFF ❌'}* hai.\n\nUsage: *${config.prefix}welcome on/off*\nText badlo: *${config.prefix}setwelcome <text>* (@user = naam)`);
      }
    },
  },

  goodbye: {
    desc: 'Group goodbye message on/off (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const v = (args[0] || '').toLowerCase();
      const cur = !!((STATE.settings || {}).goodbye || {})[jid];
      if (v === 'on' || v === 'off') {
        if (!STATE.settings.goodbye) STATE.settings.goodbye = {};
        STATE.settings.goodbye[jid] = v === 'on'; saveState();
        await reply(sock, jid, msg, v === 'on' ? '👋 Goodbye: ✅ ON' : '👋 Goodbye: ⛔ OFF');
      } else {
        await reply(sock, jid, msg, `👋 Goodbye abhi *${cur ? 'ON ✅' : 'OFF ❌'}* hai.\n\nUsage: *${config.prefix}goodbye on/off*\nText badlo: *${config.prefix}setgoodbye <text>* (@user = naam)`);
      }
    },
  },

  setwelcome: {
    desc: 'Welcome ka custom text set karo (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const t = (args || []).join(' ').trim().slice(0, 300);
      if (!t) {
        const cur = ((STATE.settings || {}).welcomeText || {})[jid];
        return reply(sock, jid, msg, `📝 Maujooda welcome text:\n_${cur || '(default)'}_\n\nSet karo: *${config.prefix}setwelcome Khush aamdeed @user! 💗*\n(@user = naye member ka naam)`);
      }
      if (!STATE.settings.welcomeText) STATE.settings.welcomeText = {};
      STATE.settings.welcomeText[jid] = t; saveState();
      await reply(sock, jid, msg, `✅ Welcome text set:\n_${t}_`);
    },
  },

  setgoodbye: {
    desc: 'Goodbye ka custom text set karo (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      const t = (args || []).join(' ').trim().slice(0, 300);
      if (!t) {
        const cur = ((STATE.settings || {}).goodbyeText || {})[jid];
        return reply(sock, jid, msg, `📝 Maujooda goodbye text:\n_${cur || '(default)'}_\n\nSet karo: *${config.prefix}setgoodbye Allah hafiz @user! 👋*\n(@user = jaane wale ka naam)`);
      }
      if (!STATE.settings.goodbyeText) STATE.settings.goodbyeText = {};
      STATE.settings.goodbyeText[jid] = t; saveState();
      await reply(sock, jid, msg, `✅ Goodbye text set:\n_${t}_`);
    },
  },

  autoread: {
    desc: 'Messages par foran blue tick (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'autoread', '👁 Autoread'); },
  },

  // (antilink: naya per-group version "14 naye commands" block mein hai — 2026-09-23)

  antistatus: {
    desc: 'Status updates ignore karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'antistatus', '📵 Antistatus'); },
  },

  ghost: {
    desc: 'Ghost mode: status chupke dekho, kisi ko pata na chale (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'ghost', '👻 Ghost mode'); },
  },

  ghostchat: {
    desc: 'Ghost chat: DM ki copy inbox mein, blue tick na jaye (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'ghostchat', '👻 Ghost chat'); },
  },

  // ─── 👑 owner power batch (Boss: 2026-09-25) ───
  restart: {
    desc: 'Bot restart karo (owner) 🔄',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      await reply(sock, jid, msg, '🔄 *Restart ho raha hai...* 5 second mein wapas! 💗');
      setTimeout(() => { try { process.exit(0); } catch {} }, 900); // start.sh loop khud relaunch karega
    },
  },

  broadcast: {
    desc: 'Sab DM users ko paigham bhejo (owner) 📢',
    owner: true,
    run: async (sock, msg, args, { jid, sender }) => {
      const text = args.join(' ').trim();
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}broadcast <paigham>*`);
      const seen = new Set(), targets = [];
      const meNum = num(sock.user?.id), ownNum = num(sender);
      for (const e of ACT) {
        if (!e || e.g !== 'private' || !e.u) continue;
        const u = String(e.u).replace(/\D/g, '');
        if (!u || seen.has(u) || u === meNum || u === ownNum) continue;
        seen.add(u); targets.push(u);
      }
      if (!targets.length) return reply(sock, jid, msg, '📭 Broadcast ke liye koi user nahi mila.');
      await reply(sock, jid, msg, `📢 *Broadcast shuru* — ${targets.length} users... ⏳`);
      let ok = 0, fail = 0;
      for (const u of targets) {
        try {
          await sock.sendMessage(u + '@s.whatsapp.net', { text: `📢 *NEXORA-MD* 📢\n\n${text}\n\n_— Nexa 💗_` });
          ok++;
        } catch { fail++; }
        await sleep(500); // anti-ban waqfa
      }
      await reply(sock, jid, msg, `✅ *Broadcast mukammal*\n\n📨 Pahuncha: ${ok}\n❌ Fail: ${fail}`);
    },
  },

  join: {
    desc: 'Invite link se group join karo (owner) 🔗',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const link = (args[0] || '').trim();
      const m = /chat\.whatsapp\.com\/([A-Za-z0-9]+)/.exec(link);
      if (!m) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}join <whatsapp-group-invite-link>*`);
      try {
        await reply(sock, jid, msg, '🔗 Group join kar rahi hoon... 💗');
        await sock.groupAcceptInvite(m[1]);
        await reply(sock, jid, msg, '✅ *Group join ho gaya!* 🎉');
      } catch { await reply(sock, jid, msg, '❌ Join nahi ho saka — link ghalat ya expired hai.'); }
    },
  },

  setmenuimage: {
    desc: 'Menu ka banner badlo — photo ke reply mein (owner) 🖼️',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const q = ctxOf(msg)?.quotedMessage;
      const img = q?.imageMessage || msg.message?.imageMessage;
      if (!img && !q) return reply(sock, jid, msg, `❌ Kisi *photo ke reply* mein *${config.prefix}setmenuimage* likhein.`);
      const media = img || q?.imageMessage;
      if (!media) return reply(sock, jid, msg, `❌ Kisi *photo ke reply* mein *${config.prefix}setmenuimage* likhein.`);
      await reply(sock, jid, msg, '🖼️ Menu banner badal rahi hoon... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: media } }, 'buffer', {});
        if (!buf || !buf.length) throw new Error('empty');
        const bannerPath = path.join(__dirname, '..', 'assets', 'nexora-banner.jpg');
        const bakPath = path.join(__dirname, '..', 'assets', 'nexora-banner.orig.jpg');
        if (!fs.existsSync(bakPath) && fs.existsSync(bannerPath)) fs.copyFileSync(bannerPath, bakPath); // pehli baar backup
        const jpg = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
        fs.writeFileSync(bannerPath, jpg);
        await sock.sendMessage(jid, { image: jpg, caption: '✅ *Menu banner badal gaya!*\n\nAb `.menu` isi photo ke saath ayega 💗' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Banner nahi badal saka.'); }
    },
  },

  recording: {
    desc: 'Command par recording presence (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'recording', '🎙 Recording presence'); },
  },

  statusview: {
    desc: 'Statuses auto-view karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'statusview', '👀 Status auto-view'); },
  },

  anticall: {
    desc: 'Incoming calls auto-reject (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'anticall', '📞 Anticall'); },
  },

  anticallmsg: {
    desc: 'Call reject par message set karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const t = (args || []).join(' ').trim().slice(0, 200);
      if (!t) return reply(sock, jid, msg, `📵 Maujooda anticall message:\n_${getSetting('anticallmsg') || '(default)'}_\n\nSet: *${config.prefix}anticallmsg <text>*`);
      setSetting('anticallmsg', t);
      await reply(sock, jid, msg, `✅ Anticall message set:\n_${t}_`);
    },
  },

  adminaction: {
    desc: 'Group admin actions ki khabar (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'adminaction', '🛡️ Admin-action notice'); },
  },

  autotyping: {
    desc: 'Command par typing presence (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'autotyping', '⌨️ Autotyping'); },
  },

  prefix: {
    desc: 'Command prefix change karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const p = (args[0] || '').trim();
      if (!p) return reply(sock, jid, msg, `⌨️ Maujooda prefix: *${config.prefix}*\n\nChange: *${config.prefix}prefix <naya>* (ek character, masalan !)`);
      if (p.length !== 1 || /\s/.test(p)) return reply(sock, jid, msg, '❌ Prefix sirf *ek* character ho (bina space).');
      config.prefix = p; setSetting('prefix', p);
      await reply(sock, jid, msg, `✅ Prefix ab *${p}* hai!\n⚠️ Ab commands *${p}* se shuru honge (masalan *${p}menu*).`);
    },
  },

  botname: {
    desc: 'Bot ka naam change karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const n = (args || []).join(' ').trim().slice(0, 30);
      if (!n) return reply(sock, jid, msg, `🤖 Maujooda naam: *${config.botName}*\n\nChange: *${config.prefix}botname <naam>*`);
      config.botName = n; setSetting('botname', n);
      await reply(sock, jid, msg, `✅ Bot ka naam ab *${n}* hai! 💗`);
    },
  },

  ownername: {
    desc: 'Owner ka naam (menu mein) change karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const n = (args || []).join(' ').trim().slice(0, 30);
      if (!n) return reply(sock, jid, msg, `👑 Maujooda owner naam: *${getSetting('ownername') || 'NEXORA'}*\n\nChange: *${config.prefix}ownername <naam>*`);
      setSetting('ownername', n);
      await reply(sock, jid, msg, `✅ Owner naam ab *${n}* hai!`);
    },
  },

  ownernumber: {
    desc: 'Owner number set karo (owner) — number kabhi show nahi hota',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const d = num(args[0] || '');
      if (!d) return reply(sock, jid, msg, `👑 *Owner number:* 🔒 private hai — kabhi show nahi hota.\n\nChange: *${config.prefix}ownernumber <digits>*\n⚠️ Sirf apna number likhein — ghalat number par owner access chala jayega!`);
      if (d.length < 7 || d.length > 15) return reply(sock, jid, msg, '❌ Number sahi nahi lag raha (7–15 digits).');
      config.owner = d;
      try { fs.writeFileSync(path.join(__dirname, '..', '.owner'), d + '\n', { mode: 0o600 }); }
      catch { return reply(sock, jid, msg, '❌ .owner file write nahi ho saki — number change nahi hua.'); }
      await reply(sock, jid, msg, `✅ Owner number update ho gaya!\n_(restart ke baad bhi mehfooz rahega)_`);
    },
  },

  description: {
    desc: 'Bot ki description set karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const t = (args || []).join(' ').trim().slice(0, 200);
      if (!t) return reply(sock, jid, msg, `📝 Maujooda description:\n_${getSetting('description') || '(koi nahi)'}_\n\nSet: *${config.prefix}description <text>*`);
      setSetting('description', t);
      await reply(sock, jid, msg, `✅ Description set:\n_${t}_`);
    },
  },

  stickername: {
    desc: 'Sticker pack ka naam set karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const t = (args || []).join(' ').trim().slice(0, 40);
      if (!t) return reply(sock, jid, msg, `🏷️ Maujooda sticker naam: *${getSetting('stickername') || '(koi nahi)'}*\n\nSet: *${config.prefix}stickername <naam>*`);
      setSetting('stickername', t);
      await reply(sock, jid, msg, `✅ Sticker pack naam: *${t}*\n_(naye stickers par lagega)_`);
    },
  },

  delpath: {
    desc: 'Download folder ka path (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const t = (args[0] || '').trim();
      if (!t) return reply(sock, jid, msg, `📁 Maujooda download path:\n*${getSetting('delpath') || '/tmp'}*\n\nSet: *${config.prefix}delpath /tmp/downloads*`);
      try { fs.mkdirSync(t, { recursive: true }); } catch { return reply(sock, jid, msg, '❌ Ye path usable nahi hai.'); }
      setSetting('delpath', t);
      await reply(sock, jid, msg, `✅ Download path: *${t}*`);
    },
  },

  reactemojis: {
    desc: 'Auto-react ke emojis set karo (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      if (!args.length) return reply(sock, jid, msg, `💗 Maujooda react emojis: ${(getSetting('reactemojis') || REACT_EMOJIS).join(' ')}\n\nSet: *${config.prefix}reactemojis* 💗 🔥 😍`);
      const list = args.slice(0, 12);
      setSetting('reactemojis', list);
      await reply(sock, jid, msg, `✅ React emojis set: ${list.join(' ')}`);
    },
  },

  owneremojis: {
    desc: 'Owner naam ke saath emoji (menu mein)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const e = (args[0] || '').trim();
      if (!e) return reply(sock, jid, msg, `👑 Maujooda owner emoji: *${getSetting('owneremoji') || '👑'}*\n\nSet: *${config.prefix}owneremojis* 💎`);
      setSetting('owneremoji', e);
      await reply(sock, jid, msg, `${e} Owner emoji set ho gaya!`);
    },
  },

  mentionreply: {
    desc: 'Group replies mein sender mention (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'mentionreply', '💬 Mention-reply'); },
  },

  settings: {
    desc: 'Saari bot settings dekho (owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const st = STATE.settings || {};
      const on = (k) => (st[k] ? 'ON ✅' : 'OFF ❌');
      const lines = [
        `⌨️ Prefix: *${config.prefix}*`,
        `🤖 Bot naam: *${config.botName}*`,
        `👑 Owner: ${st.owneremoji || '👑'} *${st.ownername || 'NEXORA'}* 🔒`,
        `📝 Description: ${st.description ? '_' + String(st.description).slice(0, 60) + '_' : '(koi nahi)'}`,
        `🏷️ Sticker naam: *${st.stickername || '(koi nahi)'}*`,
        `📁 Download path: *${st.delpath || '/tmp'}*`,
        `💗 React emojis: ${(st.reactemojis || REACT_EMOJIS).join(' ')}`,
        `💬 Mention reply: ${on('mentionreply')}`,
        `👁 Autoread: ${on('autoread')}`,
        `🔗 Antilink: ${on('antilink')}`,
        `📵 Antistatus: ${on('antistatus')}`,
        `👀 Status view: ${on('statusview')}`,
        `👻 Ghost mode: ${on('ghost')}`,
        `👻 Ghost chat: ${on('ghostchat')}`,
        `🎙 Recording: ${on('recording')}`,
        `⌨️ Autotyping: ${on('autotyping')}`,
        `📞 Anticall: ${on('anticall')}`,
        `🛡️ Admin action: ${on('adminaction')}`,
        `📵 Anticall msg: ${st.anticallmsg ? '_' + String(st.anticallmsg).slice(0, 50) + '_' : '(default)'}`,
      ];
      await reply(sock, jid, msg, `⚙️ *NEXORA-MD Settings*\n\n${lines.join('\n')}`);
    },
  },
};

// ─── group/call/status hooks (index.js se wired) ───
async function handleGroupUpdate(sock, u) {
  try {
    const jid = u && u.id;
    if (!jid || !jid.endsWith('@g.us')) return;
    const st = STATE.settings || {};
    const powerOff = globalPower() === false; // power off → welcome/goodbye/admin-action bhi khamosh
    if (!powerOff && typeof NEXUS !== 'undefined') await NEXUS.onGroupUpdate(sock, u).catch(() => {}); // ⬡ NEXUS .event join rules
    if (!powerOff && typeof GROUPKIT !== 'undefined') await GROUPKIT.onGroupUpdate(sock, u).catch(() => {}); // 👥 GROUP KIT (welcome/goodbye maujooda handler bhejta hai — duplicate nahi)
    for (const p of u.participants || []) {
      const tag = '@' + num(p);
      // 🛡️ antifake: ghair-Pakistani number join karte hi kick (Boss: 2026-09-25)
      if (u.action === 'add' && !powerOff && (STATE.antifake || {})[jid]) {
        const pj = String(p || ''), digits = num(p);
        if (!pj.includes('@lid') && digits && !digits.startsWith('92')) {
          await sock.groupParticipantsUpdate(jid, [p], 'remove').catch(() => {});
          await sock.sendMessage(jid, { text: `🛡️ *Antifake:* ${tag} — ghair-Pakistani number kick kar diya.` }).catch(() => {});
          continue;
        }
      }
      if (u.action === 'add' && !powerOff && (st.welcome || {})[jid]) {
        const txt = String((st.welcomeText || {})[jid] || '🎉 Khush aamdeed @user! Group mein welcome 💗').replace(/@user/g, tag);
        await sock.sendMessage(jid, { text: txt, mentions: [p] }).catch(() => {});
      } else if (u.action === 'remove' && !powerOff && (st.goodbye || {})[jid]) {
        const txt = String((st.goodbyeText || {})[jid] || '👋 @user group chhor kar chala gaya. Allah hafiz!').replace(/@user/g, tag);
        await sock.sendMessage(jid, { text: txt, mentions: [p] }).catch(() => {});
      } else if ((u.action === 'promote' || u.action === 'demote') && !powerOff && st.adminaction) {
        await sock.sendMessage(jid, { text: `🛡️ *Admin action:* ${tag} ko ${u.action === 'promote' ? 'admin bana diya ✅' : 'admin se hata diya ❌'}`, mentions: [p] }).catch(() => {});
      }
    }
  } catch {}
}

async function handleCallEvent(sock, calls) {
  try {
    const st = STATE.settings || {};
    if (!st.anticall) return;
    for (const c of calls || []) {
      if (!c || c.status !== 'offer') continue;
      try { await sock.rejectCall(c.id, c.from); } catch {}
      const txt = st.anticallmsg || '📵 Sorry, main calls receive nahi karti. Message kar dein 💗';
      try { await sock.sendMessage(c.from, { text: txt }); } catch {}
    }
  } catch {}
}

async function ghostSaveStatus(sock, m) {
  // 👻 Ghost mode: status download karke owner ko bhejo — read receipt NA bhejo, taake poster ko pata na chale
  try {
    if (!m || !m.key || m.key.fromMe) return;
    const ownerJid = config.owner ? num(config.owner) + '@s.whatsapp.net' : null;
    if (!ownerJid) return;
    const who = String(m.key.participant || '');
    const whoNum = who.replace(/@.*/, '') || 'unknown';
    const name = m.pushName || whoNum;
    const inner = m.message || {};
    const cap = `👻 *Status* — ${name} (${whoNum})`;
    const sendCap = (extra) => cap + (extra ? `\n\n📝 ${extra}` : '');
    try {
      if (inner.imageMessage) {
        const buf = await downloadMediaMessage(m, 'buffer', {});
        await sock.sendMessage(ownerJid, { image: buf, caption: sendCap(inner.imageMessage.caption) });
      } else if (inner.videoMessage) {
        const buf = await downloadMediaMessage(m, 'buffer', {});
        await sock.sendMessage(ownerJid, { video: buf, caption: sendCap(inner.videoMessage.caption) });
      } else if (inner.audioMessage) {
        const buf = await downloadMediaMessage(m, 'buffer', {});
        await sock.sendMessage(ownerJid, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true });
        await sock.sendMessage(ownerJid, { text: cap + ' 🎙️' });
      } else {
        const txt = inner.conversation || (inner.extendedTextMessage && inner.extendedTextMessage.text) || '(status)';
        await sock.sendMessage(ownerJid, { text: `${cap}\n\n📝 ${txt}` });
      }
    } catch { await sock.sendMessage(ownerJid, { text: `${cap}\n\n⚠️ Media download nahi ho saka.` }); }
  } catch {}
}

async function ghostChatForward(sock, msg, jid) {
  // 👻 Ghost chat: DM ki copy owner ke inbox mein — original chat khole baghair parho, blue tick nahi jayega
  try {
    if (!getSetting('ghostchat')) return;
    if (!msg || !msg.key || msg.key.fromMe) return;
    if (String(jid).endsWith('@g.us')) return; // sirf DM
    const ownerJid = config.owner ? num(config.owner) + '@s.whatsapp.net' : null;
    if (!ownerJid || jid === ownerJid) return;
    const sender = String(msg.key.participant || jid);
    if (num(sender) === num(config.owner)) return;
    const sNum = num(sender);
    const name = msg.pushName || sNum;
    const inner = msg.message || {};
    const cap = `👻 *Ghost chat* — ${name} (${sNum})`;
    try {
      if (inner.imageMessage) {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        await sock.sendMessage(ownerJid, { image: buf, caption: cap + (inner.imageMessage.caption ? `\n\n📝 ${inner.imageMessage.caption}` : '') });
      } else if (inner.videoMessage) {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        await sock.sendMessage(ownerJid, { video: buf, caption: cap + (inner.videoMessage.caption ? `\n\n📝 ${inner.videoMessage.caption}` : '') });
      } else if (inner.audioMessage || inner.pttMessage) {
        const aM = inner.audioMessage || inner.pttMessage;
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        await sock.sendMessage(ownerJid, { audio: buf, mimetype: aM.mimetype || 'audio/ogg; codecs=opus', ptt: !!aM.ptt });
        await sock.sendMessage(ownerJid, { text: cap + ' 🎙️' });
      } else if (inner.stickerMessage) {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        await sock.sendMessage(ownerJid, { sticker: buf });
        await sock.sendMessage(ownerJid, { text: cap + ' 🎭' });
      } else if (inner.documentMessage) {
        const buf = await downloadMediaMessage(msg, 'buffer', {});
        await sock.sendMessage(ownerJid, { document: buf, fileName: (inner.documentMessage.fileName) || 'file', mimetype: inner.documentMessage.mimetype || 'application/octet-stream', caption: cap });
      } else {
        const txt = (inner.conversation || (inner.extendedTextMessage && inner.extendedTextMessage.text) || '').trim();
        if (!txt) return;
        await sock.sendMessage(ownerJid, { text: `${cap}\n\n📝 ${txt}` });
      }
    } catch { /* media fail → khamoshi */ }
  } catch {}
}

async function handleStatusBroadcast(sock, m) {
  try {
    const st = STATE.settings || {};
    if (st.ghost) { await ghostSaveStatus(sock, m); return; } // 👻 stealth: no read receipt, no ❤️ react
    if (st.antistatus) return; // statuses bilkul ignore
    if (st.statusview && m && m.key && !m.key.fromMe) {
      await sock.readMessages([{ remoteJid: 'status@broadcast', id: m.key.id, participant: m.key.participant }]).catch(() => {});
    }
    // ❤️ statuslike: har status par auto ❤️ react (owner setting)
    await statusLikeHook(sock, m);
  } catch {}
}

Object.assign(commands, NEW_COMMANDS_34);

// ─── 🆕 Boss-approved: .gactive + .track (2026-09-25) ──
// 📊 gactive: per-group message counts — har group message par increment, 60s throttled save
function trackGactive(msg, jid, sender) {
  try {
    if (!jid || !String(jid).endsWith('@g.us') || msg.key?.fromMe) return;
    const snum = num(sender);
    if (!snum) return;
    if (!STATE.gactive || typeof STATE.gactive !== 'object') STATE.gactive = {};
    const gg = STATE.gactive[jid] || (STATE.gactive[jid] = {});
    const e = gg[snum] || (gg[snum] = { c: 0, n: '' });
    e.c = (e.c || 0) + 1;
    if (msg.pushName) e.n = String(msg.pushName).slice(0, 40);
    const ks = Object.keys(gg);
    if (ks.length > 200) { // cap: sab se kam active wala nikalo
      let mk = null, mv = Infinity;
      for (const k of ks) { const cc = (gg[k] && gg[k].c) || 0; if (k !== snum && cc < mv) { mv = cc; mk = k; } }
      if (mk) delete gg[mk];
    }
    const now = Date.now();
    if (!trackGactive._t || now - trackGactive._t > 60000) { trackGactive._t = now; saveState(); }
  } catch {}
}

// 🟢 track: presence.update handler — tracked number online aaye to owner ko khabar
async function handlePresenceUpdate(sock, u) {
  try {
    const tracked = STATE.tracked || {};
    if (!Object.keys(tracked).length) return;
    const prs = (u && u.presences) || {};
    const ownerJid = config.owner ? num(config.owner) + '@s.whatsapp.net' : null;
    if (!ownerJid) return;
    for (const [pj, pr] of Object.entries(prs)) {
      const d = num(pj);
      if (!d || !tracked[d]) continue;
      const p = String((pr && (pr.lastKnownPresence || pr.presence)) || '').toLowerCase();
      const onlineish = p === 'available' || p === 'composing' || p === 'recording' || p === 'paused';
      if (!onlineish) continue;
      const rec = tracked[d] || (tracked[d] = {});
      const now = Date.now();
      if (rec.last && now - rec.last < 10 * 60 * 1000) continue; // 10 min throttle (flap-spam se bachao)
      rec.last = now; saveState();
      await sock.sendMessage(ownerJid, { text: `🟢 *${d}* online aaya! 💗` });
    }
  } catch {}
}

// 🟢 track: startup par tamam tracked numbers ko presence-subscribe karo
async function subscribeTrackedPresence(sock) {
  try {
    const tracked = STATE.tracked || {};
    for (const d of Object.keys(tracked)) {
      try { await sock.presenceSubscribe(d + '@s.whatsapp.net'); } catch {}
    }
  } catch {}
}

const NEW_CMDS_TG = {
  gactive: {
    desc: 'Top 10 active members (group) 🏆',
    run: async (sock, msg, args, { jid }) => {
      if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf group mein chalti hai.');
      const gg = (STATE.gactive || {})[jid] || {};
      const entries = Object.entries(gg).filter(([, e]) => e && e.c > 0).sort((a, b) => b[1].c - a[1].c).slice(0, 10);
      if (!entries.length) return reply(sock, jid, msg, '📊 Abhi data jama ho raha hai — thode messages aane do, phir dobara try karein 💗');
      const lines = entries.map(([n2, e], i) => `${i + 1}. ${e.n ? e.n + ' ' : ''}@${n2} — *${e.c}* msgs`);
      await sock.sendMessage(jid, {
        text: `🏆 *Top 10 Active Members*\n\n${lines.join('\n')}\n\n— Nexa 💗`,
        mentions: entries.map(([n2]) => n2 + '@s.whatsapp.net'),
      }, { quoted: msg });
    },
  },

  track: {
    desc: 'Online tracker: .track <number> / list / del (owner) 🟢',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      if (!STATE.tracked || typeof STATE.tracked !== 'object') STATE.tracked = {};
      const sub = (args[0] || '').toLowerCase();
      const ks = Object.keys(STATE.tracked);
      if (sub === 'list') {
        if (!ks.length) return reply(sock, jid, msg, `🟢 Track list khaali hai.\n\nUsage: *${config.prefix}track <number>*`);
        return reply(sock, jid, msg, `🟢 *Tracked (${ks.length}):*\n` + ks.map((k, i) => `${i + 1}. ${k}`).join('\n'));
      }
      if (sub === 'del' || sub === 'remove' || sub === 'off') {
        const t = num(args[1] || '');
        if (!t) {
          if (sub === 'off') { STATE.tracked = {}; saveState(); return reply(sock, jid, msg, '🟢 Tracking sab ke liye *OFF* ⛔'); }
          return reply(sock, jid, msg, `❌ Usage: *${config.prefix}track del <number>*`);
        }
        delete STATE.tracked[t]; saveState();
        return reply(sock, jid, msg, `⛔ *${t}* ko track list se hata diya.`);
      }
      const t = num(args[0] || '');
      if (!t) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}track <number>*\nMasalan: *${config.prefix}track 923001234567*\n\nList: *${config.prefix}track list* · Hatane ke liye: *${config.prefix}track del <number>*`);
      STATE.tracked[t] = STATE.tracked[t] || {};
      saveState();
      try { await sock.presenceSubscribe(t + '@s.whatsapp.net'); } catch {}
      return reply(sock, jid, msg, `🟢 *${t}* track ho raha hai!\n\nOnline aate hi khabar dungi 💗\n_Note: presence un numbers ke liye behtar kaam karta hai jin se haal mein baat hui ho._`);
    },
  },
};
Object.assign(commands, NEW_CMDS_TG);

// ─── 🆕 Boss-approved 6: tovideo, collage, tictactoe, ud, cat/dog, fakechat (2026-09-25) ──

// ⭕ Tic-tac-toe helpers
function tttRender(b) {
  const s = (i) => (b[i] === 'X' ? '❌' : b[i] === 'O' ? '⭕' : '⬜');
  return `${s(0)}${s(1)}${s(2)}\n${s(3)}${s(4)}${s(5)}\n${s(6)}${s(7)}${s(8)}`;
}
const TTT_WIN = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
function tttWinner(b) {
  for (const [a, c, d] of TTT_WIN) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every((x) => x) ? 'D' : null;
}
function tttBotMove(b) {
  const empty = b.map((x, i) => (x ? null : i)).filter((x) => x !== null);
  for (const i of empty) { b[i] = 'O'; if (tttWinner(b) === 'O') return i; b[i] = ''; } // jeet sakti to jeeto
  for (const i of empty) { b[i] = 'X'; if (tttWinner(b) === 'X') { b[i] = 'O'; return i; } b[i] = ''; } // warna roko
  const i = empty[Math.floor(Math.random() * empty.length)];
  b[i] = 'O'; return i;
}

const NEW_CMDS_6 = {
  tovideo: {
    desc: 'Photo → Ken Burns video (reply) 🎬',
    run: async (sock, msg, args, { jid }) => {
      const img = ctxOf(msg)?.quotedMessage?.imageMessage || msg.message?.imageMessage;
      if (!img) return reply(sock, jid, msg, `❌ Kisi photo ke reply mein *${config.prefix}tovideo* likhein.`);
      await reply(sock, jid, msg, '🎬 Video bana rahi hoon... 💗');
      const tag = crypto.randomBytes(6).toString('hex');
      const inp = `/tmp/tv_${tag}.jpg`, out = `/tmp/tv_${tag}.mp4`;
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: img } }, 'buffer', {});
        if (!buf || buf.length < 500) throw new Error('empty');
        if (buf.length > 15 * 1024 * 1024) throw new Error('too-big');
        fs.writeFileSync(inp, buf);
        await new Promise((res, rej) => {
          execFile('/usr/bin/ffmpeg', ['-y', '-loop', '1', '-i', inp, '-vf', "scale=1280:720,zoompan=z='min(zoom+0.0015,1.3)':d=125:s=1280x720:fps=25", '-t', '5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out],
            { timeout: 120000 }, (e) => (e ? rej(e) : res()));
        });
        const ob = fs.readFileSync(out);
        if (!ob.length) throw new Error('empty-out');
        await sock.sendMessage(jid, { video: ob, mimetype: 'video/mp4', caption: '🎬 *Ken Burns video* 💗' }, { quoted: msg });
      } catch (e) {
        await reply(sock, jid, msg, e.message === 'too-big' ? '❌ Photo bohat bari hai.' : '❌ Video nahi ban saki, dobara try karein.');
      } finally {
        try { fs.unlinkSync(inp); } catch {}
        try { fs.unlinkSync(out); } catch {}
      }
    },
  },

  collage: {
    desc: 'Aakhri photos ka collage (2-4) 🖼️',
    run: async (sock, msg, args, { jid }) => {
      let n = parseInt(args[0], 10) || 4;
      n = Math.max(2, Math.min(4, n));
      const imgs = [];
      for (const k of [...msgCache.keys()].reverse()) {
        if (!k.startsWith(jid + '|')) continue;
        const e = msgCache.get(k);
        if (e && e.mediaKind === 'imageMessage' && e.buffer && e.buffer.length > 1000) imgs.push(e.buffer);
        if (imgs.length >= n) break;
      }
      if (imgs.length < 2) return reply(sock, jid, msg, `🖼️ Pehle kuch photos bhejo, phir *${config.prefix}collage* likho 💗`);
      await reply(sock, jid, msg, '🖼️ Collage bana rahi hoon... 💗');
      try {
        const T = 640, GAP = 10;
        const cols = imgs.length <= 2 ? imgs.length : 2;
        const rows = Math.ceil(imgs.length / cols);
        const W = cols * T + (cols + 1) * GAP, H = rows * T + (rows + 1) * GAP;
        const thumbs = await Promise.all(imgs.map((b) => sharp(b).resize(T, T, { fit: 'cover' }).jpeg({ quality: 88 }).toBuffer()));
        const comp = thumbs.map((b, i) => ({ input: b, left: GAP + (i % cols) * (T + GAP), top: GAP + Math.floor(i / cols) * (T + GAP) }));
        const out = await sharp({ create: { width: W, height: H, channels: 3, background: '#0b141a' } }).composite(comp).jpeg({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: `🖼️ *Collage* — ${imgs.length} photos 💗` }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Collage nahi ban saka.'); }
    },
  },

  tictactoe: {
    desc: 'Bot se tic-tac-toe khelo ⭕',
    run: async (sock, msg, args, { jid }) => {
      if (!STATE.tictactoe || typeof STATE.tictactoe !== 'object') STATE.tictactoe = {};
      STATE.tictactoe[jid] = { board: Array(9).fill(''), over: false };
      saveState();
      await reply(sock, jid, msg, `⭕ *Tic-Tac-Toe* — tum ❌, main ⭕\n\n${tttRender(STATE.tictactoe[jid].board)}\n\nChaal chalo: *${config.prefix}ttt <1-9>*\n\n1️⃣ 2️⃣ 3️⃣\n4️⃣ 5️⃣ 6️⃣\n7️⃣ 8️⃣ 9️⃣`);
    },
  },

  ttt: {
    desc: 'Tic-tac-toe chaal (1-9)',
    run: async (sock, msg, args, { jid }) => {
      const g = (STATE.tictactoe || {})[jid];
      if (!g || g.over) return reply(sock, jid, msg, `❌ Pehle *${config.prefix}tictactoe* se game shuru karo.`);
      const pos = parseInt(args[0], 10);
      if (!pos || pos < 1 || pos > 9) return reply(sock, jid, msg, `❌ *${config.prefix}ttt <1-9>* likho.`);
      const i = pos - 1;
      if (g.board[i]) return reply(sock, jid, msg, '❌ Ye khana bhara hai — koi aur chuno.');
      g.board[i] = 'X';
      let w = tttWinner(g.board);
      if (w === 'X') { g.over = true; saveState(); return reply(sock, jid, msg, `🎉 *Jeet gaye!* Mubarak ho 💗\n\n${tttRender(g.board)}`); }
      if (w === 'D') { g.over = true; saveState(); return reply(sock, jid, msg, `🤝 *Draw!* Achha khela 💗\n\n${tttRender(g.board)}`); }
      tttBotMove(g.board);
      w = tttWinner(g.board);
      if (w === 'O') { g.over = true; saveState(); return reply(sock, jid, msg, `😎 *Main jeet gayi!* Phir kheloge? *${config.prefix}tictactoe*\n\n${tttRender(g.board)}`); }
      if (w === 'D') { g.over = true; saveState(); return reply(sock, jid, msg, `🤝 *Draw!*\n\n${tttRender(g.board)}`); }
      saveState();
      await reply(sock, jid, msg, `⭕ *Tic-Tac-Toe*\n\n${tttRender(g.board)}\n\nTumhari baari: *${config.prefix}ttt <1-9>*`);
    },
  },

  ud: {
    desc: 'Urban Dictionary meaning 📖',
    run: async (sock, msg, args, { jid }) => {
      const term = args.join(' ').trim().slice(0, 100);
      if (!term) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}ud <word>*\nMasalan: *${config.prefix}ud vibe*`);
      await reply(sock, jid, msg, '📖 Dhoond rahi hoon... 💗');
      try {
        const r = await nxFetch('https://api.urbandictionary.com/v0/define?term=' + encodeURIComponent(term), {}, 20000);
        const j = await r.json();
        const e = j && j.list && j.list[0];
        if (!e) throw new Error('no-def');
        const clean = (s) => String(s || '').replace(/\[|\]/g, '').replace(/\r/g, '').trim().slice(0, 500);
        await reply(sock, jid, msg, `📖 *${term}*\n\n${clean(e.definition)}\n\n💬 _"${clean(e.example)}"_\n\n👍 ${e.thumbs_up || 0}   👎 ${e.thumbs_down || 0}`);
      } catch { await reply(sock, jid, msg, '❌ Is lafz ka matlab nahi mila.'); }
    },
  },

  cat: {
    desc: 'Cute cat pic 🐱',
    run: async (sock, msg, args, { jid }) => {
      try {
        const { buf } = await nxDownloadBuf('https://cataas.com/cat?type=square', 10 * 1024 * 1024, 30000);
        await sock.sendMessage(jid, { image: buf, caption: '🐱 *Meow!* 💗' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Billi nahi mili 😿'); }
    },
  },

  dog: {
    desc: 'Cute dog pic 🐶',
    run: async (sock, msg, args, { jid }) => {
      try {
        const r = await nxFetch('https://dog.ceo/api/breeds/image/random', {}, 20000);
        const j = await r.json();
        const url = j && j.message;
        if (!url || typeof url !== 'string') throw new Error('no-url');
        const { buf } = await nxDownloadBuf(url, 10 * 1024 * 1024, 30000);
        await sock.sendMessage(jid, { image: buf, caption: '🐶 *Woof!* 💗' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Dog pic nahi mili 🐶'); }
    },
  },

  fakechat: {
    desc: 'Fake WhatsApp chat screenshot 😄',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      const name = (parts[0] || '').slice(0, 30), text = (parts[1] || '').slice(0, 300);
      if (!name || !text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}fakechat <naam> | <paigham>*\nMasalan: *${config.prefix}fakechat Ali | kal party hai!*`);
      try {
        const escX = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const words = escX(text).split(' ');
        const lines = []; let cur = '';
        for (const w of words) { if ((cur + ' ' + w).trim().length > 42) { lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
        if (cur.trim()) lines.push(cur.trim());
        const lh = 28, padT = 46, padB = 34;
        const bubH = padT + lines.length * lh + padB;
        const W = 1080, H = Math.max(620, bubH + 240);
        const textEls = lines.map((ln, i) => `<text x="90" y="${padT + 44 + i * lh}" font-family="sans-serif" font-size="24" fill="#e9edef">${ln}</text>`).join('');
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">` +
          `<rect width="${W}" height="${H}" fill="#0b141a"/>` +
          `<rect x="0" y="0" width="${W}" height="90" fill="#1f2c34"/>` +
          `<circle cx="55" cy="45" r="28" fill="#3b4a54"/>` +
          `<text x="100" y="55" font-family="sans-serif" font-size="28" fill="#e9edef">${escX(name)}</text>` +
          `<rect x="40" y="130" width="660" height="${bubH}" rx="14" fill="#1f2c34"/>` +
          `<text x="70" y="170" font-family="sans-serif" font-size="22" font-weight="bold" fill="#53bdeb">${escX(name)}</text>` +
          textEls +
          `<text x="590" y="${130 + bubH - 16}" font-family="sans-serif" font-size="20" fill="#8696a0">${time} ✓✓</text>` +
          `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '😄 _100% mazaak hai — asli chat nahi!_' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Screenshot nahi ban saka.'); }
    },
  },
};
Object.assign(commands, NEW_CMDS_6);

// ═══ NEW COMMANDS (2026-09-25) — STYLE BATCH (10 commands) ═══
const NEW_CMDS_10 = {
  typewriter: {
    desc: 'Typewriter effect — harf-ba-harf likha jata hai ✍️',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 120);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}typewriter <text>*`);
      try {
        const sent = await sock.sendMessage(jid, { text: '▍' }, { quoted: msg });
        let broke = false;
        for (let i = 2; i <= text.length; i += 2) {
          await new Promise((r) => setTimeout(r, 120));
          try { await sock.sendMessage(jid, { text: text.slice(0, i) + '▍', edit: sent.key }); }
          catch { broke = true; break; }
        }
        if (!broke) { try { await sock.sendMessage(jid, { text, edit: sent.key }); } catch { await sock.sendMessage(jid, { text }, { quoted: msg }); } }
        else { await sock.sendMessage(jid, { text }, { quoted: msg }); }
      } catch { await reply(sock, jid, msg, '❌ Typewriter effect nahi chal saka.'); }
    },
  },
  disappear: {
    desc: 'Khud mitne wala message 💨',
    run: async (sock, msg, args, { jid }) => {
      let secs = 10, rest = args.slice();
      const maybe = parseInt(args[0], 10);
      if (!isNaN(maybe)) { secs = Math.max(3, Math.min(60, maybe)); rest = args.slice(1); }
      const text = rest.join(' ').trim().slice(0, 500);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}disappear [seconds] <text>*\nMasalan: *${config.prefix}disappear 15 ye aik raz hai*`);
      try {
        const sent = await sock.sendMessage(jid, { text }, { quoted: msg });
        setTimeout(() => { sock.sendMessage(jid, { delete: sent.key }).catch(() => {}); }, secs * 1000);
      } catch { await reply(sock, jid, msg, '❌ Message nahi bheja ja saka.'); }
    },
  },
  fancy: {
    desc: '8 stylish unicode fonts ✨',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 60);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}fancy <text>*`);
      const uf = (c, a, b, base) => { const x = c.codePointAt(0); return (x >= a && x <= b) ? String.fromCodePoint(base + (x - a)) : null; };
      const styles = [
        ['𝐁𝐨𝐥𝐝', (c) => uf(c, 97, 122, 0x1D41A) || uf(c, 65, 90, 0x1D400) || uf(c, 48, 57, 0x1D7CE) || c],
        ['𝐼𝑡𝑎𝑙𝑖𝑐', (c) => uf(c, 97, 122, 0x1D44E) || uf(c, 65, 90, 0x1D434) || c],
        ['𝙼𝚘𝚗𝚘𝚜𝚙𝚊𝚌𝚎', (c) => uf(c, 97, 122, 0x1D68A) || uf(c, 65, 90, 0x1D670) || uf(c, 48, 57, 0x1D7F6) || c],
        ['𝒮𝒸𝓇𝒾𝓅𝓉', (c) => uf(c, 97, 122, 0x1D4B6) || uf(c, 65, 90, 0x1D49C) || c],
        ['𝔉𝔯𝔞𝔨𝔱𝔲𝔯', (c) => uf(c, 97, 122, 0x1D51E) || uf(c, 65, 90, 0x1D504) || c],
        ['𝔻𝕠𝕦𝕓𝕝𝕖', (c) => uf(c, 97, 122, 0x1D552) || uf(c, 65, 90, 0x1D538) || uf(c, 48, 57, 0x1D7D8) || c],
        ['Ⓒⓘⓡⓒⓛⓔⓓ', (c) => { const x = c.codePointAt(0); if (x >= 97 && x <= 122) return String.fromCodePoint(0x24D0 + (x - 97)); if (x >= 65 && x <= 90) return String.fromCodePoint(0x24B6 + (x - 65)); if (x === 48) return '⓪'; if (x >= 49 && x <= 57) return String.fromCodePoint(0x2460 + (x - 49)); return c; }],
        ['Ｖａｐｏｒ', (c) => { const x = c.codePointAt(0); if (x === 32) return '　'; if (x >= 97 && x <= 122) return String.fromCodePoint(0xFF41 + (x - 97)); if (x >= 65 && x <= 90) return String.fromCodePoint(0xFF21 + (x - 65)); if (x >= 48 && x <= 57) return String.fromCodePoint(0xFF10 + (x - 48)); return c; }],
      ];
      const out = styles.map(([name, fn], i) => `*${i + 1}.* ${name}:\n${[...text].map(fn).join('')}`).join('\n\n');
      await reply(sock, jid, msg, `✨ *Fancy Styles* 💗\n\n${out}`);
    },
  },
  autobio: {
    desc: 'Auto time bio ON/OFF (owner) 🕐',
    ownerOnly: true,
    run: async (sock, msg, args, { jid }) => {
      const sub = (args[0] || '').toLowerCase();
      if (!['on', 'off'].includes(sub)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}autobio <on|off>*`);
      settingsToggle('autobio', sub === 'on');
      ensureAutobio();
      await reply(sock, jid, msg, sub === 'on'
        ? '✅ *Auto-bio ON* 🕐\nAb har minute profile status mein waqt update hoga 💗'
        : '✅ *Auto-bio OFF* — timer rok diya.');
    },
  },
  filter: {
    desc: 'Photo filters (reply) 🎨',
    run: async (sock, msg, args, { jid }) => {
      const style = (args[0] || '').toLowerCase();
      const img = ctxOf(msg)?.quotedMessage?.imageMessage || msg.message?.imageMessage;
      if (!img || !['vintage', 'pink', 'dark', 'bw', 'sepia'].includes(style))
        return reply(sock, jid, msg, `❌ Kisi photo ke reply mein likhein:\n*${config.prefix}filter <vintage|pink|dark|bw|sepia>*`);
      await reply(sock, jid, msg, '🎨 Filter laga rahi hoon... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: img } }, 'buffer', {});
        let p = sharp(buf);
        if (style === 'vintage') p = p.modulate({ brightness: 1.05, saturation: 0.85, hue: 10 }).tint('#e8c39e');
        else if (style === 'pink') p = p.modulate({ brightness: 1.08, saturation: 1.3 }).tint('#ffb6c1');
        else if (style === 'dark') p = p.modulate({ brightness: 0.75, saturation: 0.9 }).linear(1.15, -10);
        else if (style === 'bw') p = p.grayscale();
        else if (style === 'sepia') p = p.recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]);
        const out = await p.jpeg({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: `🎨 *${style} filter* — NEXORA-MD 💗` }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Filter nahi lag saka.'); }
    },
  },
  qimg: {
    desc: 'Aesthetic quote card 💬',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 200);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}qimg <text>*`);
      try {
        const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const words = esc.split(/\s+/), lines = []; let cur = '';
        for (const w of words) { if ((cur + ' ' + w).trim().length > 30) { if (cur.trim()) lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
        if (cur.trim()) lines.push(cur.trim());
        const W = 1080, H = 1080, lh = 58;
        const startY = H / 2 - (lines.length * lh) / 2 + 20;
        const textEls = lines.slice(0, 10).map((ln, i) => `<text x="540" y="${startY + i * lh}" text-anchor="middle" font-family="Georgia, serif" font-size="44" font-style="italic" fill="#ffffff">${ln}</text>`).join('');
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f2027"/><stop offset="0.5" stop-color="#203a43"/><stop offset="1" stop-color="#2c5364"/></linearGradient></defs>`
          + `<rect width="${W}" height="${H}" fill="url(#g)"/>`
          + `<text x="540" y="210" text-anchor="middle" font-family="Georgia, serif" font-size="140" fill="#50E8F4" opacity="0.45">“</text>`
          + textEls
          + `<text x="540" y="${H - 120}" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#7FA3A7">— NEXORA-MD 💗</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '💬 *Quote Card* 💗' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Quote card nahi ban saka.'); }
    },
  },
  circle: {
    desc: 'Photo → gol circle (reply) ⭕',
    run: async (sock, msg, args, { jid }) => {
      const img = ctxOf(msg)?.quotedMessage?.imageMessage || msg.message?.imageMessage;
      if (!img) return reply(sock, jid, msg, `❌ Kisi photo ke reply mein *${config.prefix}circle* likhein.`);
      await reply(sock, jid, msg, '⭕ Gol bana rahi hoon... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: img } }, 'buffer', {});
        const S = 512;
        const mask = Buffer.from(`<svg width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg"><circle cx="${S / 2}" cy="${S / 2}" r="${S / 2}" fill="white"/></svg>`);
        const out = await sharp(buf).resize(S, S, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
        await sock.sendMessage(jid, { image: out, mimetype: 'image/png', caption: '⭕ *Circle* 💗' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Circle nahi ban saka.'); }
    },
  },
  wasted: {
    desc: 'WASTED meme (reply photo) 💀',
    run: async (sock, msg, args, { jid }) => {
      const img = ctxOf(msg)?.quotedMessage?.imageMessage || msg.message?.imageMessage;
      if (!img) return reply(sock, jid, msg, `❌ Kisi photo ke reply mein *${config.prefix}wasted* likhein.`);
      await reply(sock, jid, msg, '💀 WASTED... 💗');
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: img } }, 'buffer', {});
        const meta = await sharp(buf).metadata();
        const W = Math.min(1080, meta.width || 1080);
        const H = Math.round(W * (meta.height || 720) / (meta.width || 1080));
        const base = await sharp(buf).resize(W, H, { fit: 'cover' }).grayscale().toBuffer();
        const fs2 = Math.max(60, Math.round(W / 5));
        const overlay = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, serif" font-weight="bold" font-size="${fs2}" fill="#cc0000" fill-opacity="0.85" stroke="#141414" stroke-width="${Math.max(2, Math.round(fs2 / 18))}">WASTED</text></svg>`);
        const out = await sharp(base).composite([{ input: overlay }]).jpeg({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '💀' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ WASTED nahi ho saka.'); }
    },
  },
  glitch: {
    desc: 'Zalgo glitch text 👾',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 40);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}glitch <text>*`);
      const zalgo = [...text].map((c) => {
        if (c === ' ') return c;
        let s = c;
        const nUp = 2 + Math.floor(Math.random() * 4);
        const nDn = 2 + Math.floor(Math.random() * 4);
        for (let i = 0; i < nUp; i++) s += String.fromCodePoint(0x0300 + Math.floor(Math.random() * 0x70));
        for (let i = 0; i < nDn; i++) s += String.fromCodePoint(0x0316 + Math.floor(Math.random() * 0x20));
        return s;
      }).join('');
      await reply(sock, jid, msg, zalgo);
    },
  },
  pfp: {
    desc: 'DiceBear avatar generator 🎨',
    run: async (sock, msg, args, { jid }) => {
      const seed = args.join(' ').trim().slice(0, 50) || num(msg.key?.participant || jid) || 'nexora';
      try {
        const { buf } = await nxDownloadBuf(`https://api.dicebear.com/9.x/adventurer/png?seed=${encodeURIComponent(seed)}&size=512`, 5 * 1024 * 1024, 30000);
        await sock.sendMessage(jid, { image: buf, caption: '🎨 *Aapka avatar* 💗' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Avatar nahi ban saka.'); }
    },
  },
};
Object.assign(commands, NEW_CMDS_10);

// ─── 🎭 PRANK PACK — 20 commands (Boss approved 2026-09-25) ──
const _pkXesc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const _pkWrap = (text, maxLen) => {
  const words = String(text).split(/\s+/), lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > maxLen) { if (cur.trim()) lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
  if (cur.trim()) lines.push(cur.trim()); return lines;
};
const _pkFoot = '\n\n_😂 prank hai, ghabrana nahi_ 💗';
const NEW_CMDS_PRANK = {

  // ── chat pranks ──
  ghosttype: {
    desc: 'Typing prank — kuch bheje baghair 👻',
    run: async (sock, msg, args, { jid }) => {
      let secs = parseInt(args[0], 10); if (isNaN(secs)) secs = 30;
      secs = Math.max(5, Math.min(60, secs));
      const t0 = Date.now();
      while (Date.now() - t0 < secs * 1000) {
        try { await sock.sendPresenceUpdate('composing', jid); } catch {}
        await new Promise((r) => setTimeout(r, 5000));
      }
      await reply(sock, jid, msg, '😜 *Ho gaya prank!* — itni der typing dekhi, kuch aaya hi nahi 😂💗');
    },
  },
  fakedelete: {
    desc: 'Fake "message deleted" prank 🚫',
    run: async (sock, msg, args, { jid }) => {
      await sock.sendMessage(jid, { text: '🚫 _This message was deleted._' });
    },
  },
  fakepreview: {
    desc: 'Fake link preview card 🔗',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2])
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}fakepreview <title> | <desc> | <url>*\nMasalan: *${config.prefix}fakepreview Tum jeet gaye! | iPhone 16 hasil karo | https://example.com*`);
      const title = parts[0].slice(0, 120), bdy = parts[1].slice(0, 200), url = parts[2].slice(0, 300);
      await sock.sendMessage(jid, {
        text: '👀 *ye dekho!*',
        contextInfo: { externalAdReply: { title, body: bdy, mediaType: 1, sourceUrl: url, showAdAttribution: true } },
      }, { quoted: msg });
    },
  },
  fakenews: {
    desc: 'Dost ke naam ki breaking news 📰',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      if (parts.length < 2 || !parts[0] || !parts[1])
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}fakenews <naam> | <khabar>*\nMasalan: *${config.prefix}fakenews Ahmed | 10 plate biryani akeli kha gaya*`);
      const naam = parts[0].slice(0, 50), khabar = parts[1].slice(0, 300);
      await reply(sock, jid, msg, `🔴 *BREAKING NEWS* 🔴\n\n📰 *${khabar}*\n\n_— mutasir shakhs: ${naam}_\n\n😂 _mazak hai, dil par na lo_ 💗`);
    },
  },
  voiceprank: {
    desc: 'Shararti voice note bhejo 🎤',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 200);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}voiceprank <text>*\nMasalan: *${config.prefix}voiceprank Ahmed ne aaj paanch kilo mithai akeli kha li*`);
      await reply(sock, jid, msg, '🎤 _Shararat record ho rahi hai..._ 😈');
      try {
        const ogg = await nxTtsBuffer(q, 'ur');
        await sock.sendMessage(jid, { audio: ogg, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Voice nahi ban saki. Thodi der baad try karo.'); }
    },
  },

  // ── scare pranks ──
  fakeupdate: {
    desc: 'Fake WhatsApp expire alert 📲',
    run: async (sock, msg, args, { jid }) => {
      await reply(sock, jid, msg, `⚠️ *WHATSAPP UPDATE ZAROORI* ⚠️\n\nTumhara WhatsApp version *aaj raat 12 baje EXPIRE* ho raha hai!\nAbhi update karo warna chats band! 📲${_pkFoot}`);
    },
  },
  fakebattery: {
    desc: 'Fake low battery alert 🔋',
    run: async (sock, msg, args, { jid }) => {
      let n = parseInt(args[0], 10); if (isNaN(n)) n = 1; n = Math.max(1, Math.min(20, n));
      await reply(sock, jid, msg, `🔋 *BATTERY KHATAM!* 🔋\n\nSirf *${n}%* baqi — phone 60 second mein band ho jayega!\nCharger lagao jaldi! ⚡${_pkFoot}`);
    },
  },
  fakeresult: {
    desc: 'Fake BISE result 🎓',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      if (parts.length < 2 || !parts[0] || !/^(pass|fail)$/i.test(parts[1]))
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}fakeresult <naam> | <pass/fail>*\nMasalan: *${config.prefix}fakeresult Ahmed | fail*`);
      const naam = parts[0].slice(0, 50), pass = /^pass$/i.test(parts[1]);
      await reply(sock, jid, msg, pass
        ? `🎓 *BISE RESULT 2026* 🎓\n\nNaam: *${naam}*\nNateeja: *PASS* — 1050/1100! 🎉\nMubarak ho, mithai banto! 🍬${_pkFoot}`
        : `🎓 *BISE RESULT 2026* 🎓\n\nNaam: *${naam}*\nNateeja: *FAIL* 😭\nSupply ki tayyari karo... 📚${_pkFoot}`);
    },
  },
  missedcall: {
    desc: 'Fake missed calls panic 📲',
    run: async (sock, msg, args, { jid }) => {
      const naam = args.join(' ').trim().slice(0, 50) || 'Ammi';
      await reply(sock, jid, msg, `📲 *47 missed calls!* 📲\n\n_${naam}_ — itni calls?! Khair to hai?! 😨${_pkFoot}`);
    },
  },
  fakeatm: {
    desc: 'Fake ATM withdrawal alert 🏧',
    run: async (sock, msg, args, { jid }) => {
      await reply(sock, jid, msg, `🏧 *BANK ALERT* 🏧\n\nTumhare ATM card se *Rs 25,000* nikale gaye hain.\nAgar ye tum ne nahi kiya to foran bank se rabta karo! 😱${_pkFoot}`);
    },
  },
  fakebill: {
    desc: 'Fake bijli ka bill 💡',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      const naam = (parts[0] || 'Aap').slice(0, 50), amt = (parts[1] || '45,000').slice(0, 20);
      await reply(sock, jid, msg, `💡 *BIJLI KA BILL* 💡\n\nNaam: *${naam}*\nBill: *Rs ${amt}*\nAakhri tareekh: *kal* 😭${_pkFoot}`);
    },
  },
  fakeban: {
    desc: 'Fake game account ban 🚫',
    run: async (sock, msg, args, { jid }) => {
      const game = args.join(' ').trim().slice(0, 40) || 'PUBG';
      await reply(sock, jid, msg, `🚫 *ACCOUNT BAN* 🚫\n\nTumhara *${game}* account *PERMANENT BAN* kar diya gaya hai.\nWajah: too much noob gameplay 😂${_pkFoot}`);
    },
  },
  fakescore: {
    desc: 'Fake cricket score 🏏',
    run: async (sock, msg, args, { jid }) => {
      await reply(sock, jid, msg, `🏏 *LIVE SCORE* 🏏\n\n🇵🇰 Pakistan: *600/0* (50 overs)\n🇮🇳 India ko jeetne ke liye *601* chahiye 😎\n\n_...khwaab mein_ 😂${_pkFoot}`);
    },
  },

  // ── image card pranks ──
  shaadi: {
    desc: 'Fake shaadi card 💍',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      if (parts.length < 2 || !parts[0] || !parts[1])
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}shaadi <dulha> | <dulhan>*\nMasalan: *${config.prefix}shaadi Ahmed | Ayesha*`);
      const a = _pkXesc(parts[0].slice(0, 40)), b = _pkXesc(parts[1].slice(0, 40));
      try {
        const W = 1080, H = 1350;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<rect width="${W}" height="${H}" fill="#FFF8E7"/>`
          + `<rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="#C9A227" stroke-width="6"/>`
          + `<rect x="55" y="55" width="${W - 110}" height="${H - 110}" fill="none" stroke="#C9A227" stroke-width="2"/>`
          + `<text x="540" y="230" text-anchor="middle" font-size="110">💒</text>`
          + `<text x="540" y="350" text-anchor="middle" font-family="Georgia, serif" font-size="64" fill="#8B6914">SHAADI MUBARAK</text>`
          + `<text x="540" y="570" text-anchor="middle" font-family="Georgia, serif" font-size="84" fill="#333">${a}</text>`
          + `<text x="540" y="690" text-anchor="middle" font-family="Georgia, serif" font-size="72" font-style="italic" fill="#B8860B">&amp;</text>`
          + `<text x="540" y="810" text-anchor="middle" font-family="Georgia, serif" font-size="84" fill="#333">${b}</text>`
          + `<text x="540" y="970" text-anchor="middle" font-family="sans-serif" font-size="40" fill="#666">Ba-izzat dawat di jati hai</text>`
          + `<text x="540" y="1070" text-anchor="middle" font-family="Georgia, serif" font-size="48" fill="#8B6914">Jald hi...</text>`
          + `<text x="540" y="1240" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#999">— NEXORA-MD 💗</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '💍 *Shaadi Mubarak!* 😂 _(mazak hai)_' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Card nahi ban saka.'); }
    },
  },
  challan: {
    desc: 'Fake traffic challan 🧾',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      if (!parts[0]) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}challan <naam> | <amount>*\nMasalan: *${config.prefix}challan Ahmed | 2000*`);
      const naam = _pkXesc(parts[0].slice(0, 40)), amt = _pkXesc((parts[1] || '2000').slice(0, 20));
      const no = 'CH-' + Math.floor(100000 + Math.random() * 900000);
      const dt = new Date().toLocaleDateString('en-GB');
      try {
        const W = 1080, H = 1400;
        const row = (y, k, v) => `<text x="90" y="${y}" font-family="monospace" font-size="40" fill="#333">${k}</text><text x="990" y="${y}" text-anchor="end" font-family="monospace" font-size="40" fill="#111">${v}</text>`;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<rect width="${W}" height="${H}" fill="#ffffff"/>`
          + `<rect width="${W}" height="200" fill="#1a3a5c"/>`
          + `<text x="540" y="95" text-anchor="middle" font-family="sans-serif" font-size="56" font-weight="bold" fill="#fff">🚔 TRAFFIC CHALLAN</text>`
          + `<text x="540" y="155" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#cde">City Traffic Police</text>`
          + row(320, 'Challan No:', no)
          + row(400, 'Tareekh:', dt)
          + `<line x1="60" y1="450" x2="1020" y2="450" stroke="#999" stroke-width="2" stroke-dasharray="10,8"/>`
          + row(540, 'Naam:', naam)
          + row(620, 'Khilaf warzi:', 'Overspeeding')
          + row(700, 'Jur mana:', 'Rs ' + amt)
          + `<line x1="60" y1="750" x2="1020" y2="750" stroke="#999" stroke-width="2" stroke-dasharray="10,8"/>`
          + `<text x="540" y="880" text-anchor="middle" font-family="monospace" font-size="46" fill="#111">Kul: Rs ${amt}</text>`
          + `<text x="540" y="980" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#666">7 din mein ada karo warna</text>`
          + `<text x="540" y="1040" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#666">license cancel!</text>`
          + `<text x="540" y="1180" text-anchor="middle" font-family="sans-serif" font-size="42" font-weight="bold" fill="#c00">😂 MAZAK HAI!</text>`
          + `<text x="540" y="1300" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#999">— NEXORA-MD 💗</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '🧾 *Challan ho gaya!* 😂' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Challan nahi ban saka.'); }
    },
  },
  faketv: {
    desc: 'Fake news breaking strip 📺',
    run: async (sock, msg, args, { jid }) => {
      const head = args.join(' ').trim().slice(0, 120);
      if (!head) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}faketv <headline>*\nMasalan: *${config.prefix}faketv Ahmed ne aaj school mein top kiya*`);
      try {
        const lines = _pkWrap(_pkXesc(head), 34).slice(0, 3);
        const W = 1280, H = 720, lh = 78, startY = 400 - (lines.length * lh) / 2 + 30;
        const tels = lines.map((ln, i) => `<text x="640" y="${startY + i * lh}" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ffffff">${ln}</text>`).join('');
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<rect width="${W}" height="${H}" fill="#0a1628"/>`
          + `<rect x="0" y="0" width="${W}" height="130" fill="#cc0000"/>`
          + `<text x="60" y="88" font-family="sans-serif" font-size="72" font-weight="bold" fill="#fff">🔴 BREAKING NEWS</text>`
          + tels
          + `<rect x="980" y="620" width="240" height="60" rx="8" fill="#cc0000"/>`
          + `<text x="1100" y="662" text-anchor="middle" font-family="sans-serif" font-size="36" font-weight="bold" fill="#fff">NEXORA NEWS</text>`
          + `<circle cx="60" cy="650" r="14" fill="#ff0000"/><text x="85" y="662" font-family="sans-serif" font-size="32" font-weight="bold" fill="#fff">LIVE</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '📺 *Breaking!* 😂 _(mazak hai)_' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Strip nahi ban saki.'); }
    },
  },
  fakeorder: {
    desc: 'Fake pizza order 🍕',
    run: async (sock, msg, args, { jid }) => {
      const naam = args.join(' ').trim().slice(0, 50) || 'Aap';
      try {
        const W = 1080, H = 1080;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<rect width="${W}" height="${H}" fill="#1c0f0a"/>`
          + `<text x="540" y="200" text-anchor="middle" font-size="150">🍕</text>`
          + `<text x="540" y="360" text-anchor="middle" font-family="sans-serif" font-size="72" font-weight="bold" fill="#4caf50">ORDER CONFIRMED!</text>`
          + `<text x="540" y="500" text-anchor="middle" font-family="sans-serif" font-size="52" fill="#fff">5 Large Pizzas</text>`
          + `<text x="540" y="590" text-anchor="middle" font-family="sans-serif" font-size="52" fill="#fff">Naam: ${_pkXesc(naam)}</text>`
          + `<text x="540" y="700" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ff9800">Total: Rs 8,500</text>`
          + `<text x="540" y="820" text-anchor="middle" font-family="sans-serif" font-size="44" fill="#ccc">🛵 30 min mein delivery!</text>`
          + `<text x="540" y="960" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#888">😂 mazak hai — pizza nahi aa raha</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '🍕 *Pizza aa raha hai!* 😂' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Order nahi ban saka.'); }
    },
  },
  fakeparcel: {
    desc: 'Fake COD parcel 📦',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      const naam = _pkXesc((parts[0] || 'Aap').slice(0, 50)), amt = _pkXesc((parts[1] || '4,999').slice(0, 20));
      try {
        const W = 1080, H = 1080;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<rect width="${W}" height="${H}" fill="#2b1d0e"/>`
          + `<text x="540" y="200" text-anchor="middle" font-size="150">📦</text>`
          + `<text x="540" y="350" text-anchor="middle" font-family="sans-serif" font-size="72" font-weight="bold" fill="#ff9800">PARCEL AYA HAI!</text>`
          + `<text x="540" y="490" text-anchor="middle" font-family="sans-serif" font-size="52" fill="#fff">Naam: ${naam}</text>`
          + `<text x="540" y="590" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ff5252">COD: Rs ${amt}</text>`
          + `<text x="540" y="720" text-anchor="middle" font-family="sans-serif" font-size="48" fill="#fff">🛵 Rider bahar khara hai!</text>`
          + `<text x="540" y="850" text-anchor="middle" font-family="sans-serif" font-size="40" fill="#ccc">Paise do, parcel lo 😄</text>`
          + `<text x="540" y="960" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#888">😂 mazak hai — koi parcel nahi</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '📦 *Parcel wala bahar hai!* 😂' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Parcel nahi ban saka.'); }
    },
  },
  fakeholiday: {
    desc: 'Fake chhutti ka elaan 🏫',
    run: async (sock, msg, args, { jid }) => {
      try {
        const W = 1080, H = 1080;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0d47a1"/><stop offset="1" stop-color="#1976d2"/></linearGradient></defs>`
          + `<rect width="${W}" height="${H}" fill="url(#hg)"/>`
          + `<text x="540" y="220" text-anchor="middle" font-size="150">🏫</text>`
          + `<text x="540" y="400" text-anchor="middle" font-family="sans-serif" font-size="80" font-weight="bold" fill="#ffeb3b">CHHUTTI KA ELAAN!</text>`
          + `<text x="540" y="560" text-anchor="middle" font-size="120">🎉</text>`
          + `<text x="540" y="710" text-anchor="middle" font-family="sans-serif" font-size="60" font-weight="bold" fill="#fff">Kal school/office</text>`
          + `<text x="540" y="800" text-anchor="middle" font-family="sans-serif" font-size="60" font-weight="bold" fill="#fff">BAND rahega!</text>`
          + `<text x="540" y="915" text-anchor="middle" font-family="sans-serif" font-size="40" font-style="italic" fill="#cde">— wazir-e-taleem</text>`
          + `<text x="540" y="1005" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#9cf">😂 mazak hai — kal jana parega</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '🎉 *Chhutti!* 😂' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Elaan nahi ban saka.'); }
    },
  },
  fakenotif: {
    desc: 'Koi bhi fake notification 🔔',
    run: async (sock, msg, args, { jid }) => {
      const parts = args.join(' ').split('|').map((s) => s.trim());
      if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2])
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}fakenotif <app> | <title> | <text>*\nMasalan: *${config.prefix}fakenotif WhatsApp | Ayesha | tum se baat karni hai*`);
      const app = parts[0].slice(0, 30), title = parts[1].slice(0, 60), body = parts[2].slice(0, 120);
      try {
        const pal = ['#25D366', '#0088cc', '#ff5252', '#ff9800', '#9c27b0', '#03a9f4'];
        const col = pal[[...app].reduce((a, c) => a + c.codePointAt(0), 0) % pal.length];
        const letter = _pkXesc(app.trim()[0].toUpperCase());
        const blines = _pkWrap(_pkXesc(body), 42).slice(0, 2);
        const btels = blines.map((ln, i) => `<text x="250" y="${300 + i * 52}" font-family="sans-serif" font-size="40" fill="#ccc">${ln}</text>`).join('');
        const W = 1080, H = 460;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<rect width="${W}" height="${H}" rx="48" fill="#1c1c1e"/>`
          + `<circle cx="130" cy="120" r="62" fill="${col}"/>`
          + `<text x="130" y="143" text-anchor="middle" font-family="sans-serif" font-size="64" font-weight="bold" fill="#fff">${letter}</text>`
          + `<text x="250" y="110" font-family="sans-serif" font-size="34" fill="#888">${_pkXesc(app)} • abhi</text>`
          + `<text x="250" y="200" font-family="sans-serif" font-size="52" font-weight="bold" fill="#fff">${_pkXesc(title)}</text>`
          + btels
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).png().toBuffer();
        await sock.sendMessage(jid, { image: out, caption: '🔔 *Notification!* 😂 _(mazak hai)_' }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Notification nahi ban saki.'); }
    },
  },
};
Object.assign(commands, NEW_CMDS_PRANK);

// ─── 🕌 NEW_CMDS_ISLAMIC (Boss order 2026-09-25: .naat; .dua aur .hijri pehle se maujood thay — skip) ───
const NEW_CMDS_ISLAMIC = {
  naat: {
    desc: 'Naat suno — naam likho 🎤',
    run: async (sock, msg, args, ctx) => {
      const { jid } = ctx;
      const q = (args || []).join(' ').trim();
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}naat <naat ka naam>*\nMasalan: *${config.prefix}naat fizzaon ka tayyaba*`);
      await reply(sock, jid, msg, '🎤 *Naat* la rahi hoon... 💗');
      // .audio ka exact pipeline reuse (YouTube search + download)
      return commands.audio.run(sock, msg, [...args, 'naat'], ctx);
    },
  },
};
Object.assign(commands, NEW_CMDS_ISLAMIC);


// ─── 🆕 NEW_COMMANDS_16 (Boss ki demand: JAWAD/NAVEED/JUTT wale best commands) ──
const NEW_COMMANDS_16 = {

  // ── aliases ──
  screenshot: {
    desc: 'Website screenshot (ss ka alias) 📸',
    run: async (sock, msg, args, ctx) => commands.ss.run(sock, msg, args, ctx),
  },
  webshot: {
    desc: 'Website screenshot (ss ka alias) 📸',
    run: async (sock, msg, args, ctx) => commands.ss.run(sock, msg, args, ctx),
  },
  getdp: {
    desc: 'Profile photo nikalo (getpp ka alias)',
    run: async (sock, msg, args, ctx) => commands.getpp.run(sock, msg, args, ctx),
  },
  marriage: {
    desc: 'Shaadi fun (shadi ka alias) 💒',
    run: async (sock, msg, args, ctx) => commands.shadi.run(sock, msg, args, ctx),
  },
  whish: {
    desc: 'Wish card (wish ka alias) 💌',
    run: async (sock, msg, args, ctx) => commands.wish.run(sock, msg, args, ctx),
  },

  // ── 👑 sudo system (extra owners) ──
  sudo: {
    desc: 'Kisi number ko sudo/owner banao (sirf main owner)',
    owner: true,
    run: async (sock, msg, args, { jid, sender }) => {
      if (!isMainOwner(sender) && !isMainOwnerMsg(msg, sender, jid))
        return reply(sock, jid, msg, '❌ Sirf main owner kisi ko sudo bana sakta hai.');
      const digits = String(args[0] || '').replace(/\D/g, '');
      const short = digits.slice(-10);
      const mainShort = String(config.owner || '').replace(/\D/g, '').slice(-10);
      if (short === mainShort) return reply(sock, jid, msg, '✅ Ye number pehle se main owner hai.');
      const list = loadExtraOwners();
      if (list.includes(short)) return reply(sock, jid, msg, `✅ *${digits}* pehle se sudo hai.`);
      list.push(short); saveExtraOwners(list);
      await reply(sock, jid, msg, `👑 *${digits}* ko *sudo* bana diya!\n\nAb ye number owner commands chala sakta hai 💗\n\n🤫 _Hatane ke liye: *${config.prefix}delsudo* ${digits}_`);
    },
  },
  delsudo: {
    desc: 'Kisi ko sudo se hatao (sirf main owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const sender = msg.key.participant || jid;
      if (!isMainOwner(sender) && !isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner sudo hata sakta hai.');
      const digits = String(args[0] || '').replace(/\D/g, '');
      if (digits.length < 7) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}delsudo <number>*`);
      const short = digits.slice(-10);
      const list = loadExtraOwners();
      const i = list.indexOf(short);
      if (i === -1) return reply(sock, jid, msg, `❌ *${digits}* sudo list mein nahi hai.`);
      list.splice(i, 1); saveExtraOwners(list);
      await reply(sock, jid, msg, `✅ *${digits}* ko sudo se hata diya.`);
    },
  },
  listsudo: {
    desc: 'Sudo numbers ki list (sirf main owner)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const sender = msg.key.participant || jid;
      if (!isMainOwner(sender) && !isMainOwnerMsg(msg, sender, jid)) return reply(sock, jid, msg, '❌ Sirf main owner list dekh sakta hai.');
      const list = loadExtraOwners();
      if (!list.length) return reply(sock, jid, msg, '📋 Sudo list khaali hai.\n\nKisi ko sudo banane ke liye: *' + config.prefix + 'sudo <number>*');
      await reply(sock, jid, msg, `👑 *Sudo List* (${list.length})\n\n` + list.map((n, i) => `${i + 1}. ${n}`).join('\n'));
    },
  },

  // ── 🔇 group mute/unmute ──
  mute: {
    desc: 'Group mute — sirf admin likh sakein (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      try {
        await sock.groupSettingUpdate(jid, 'announcement');
        await reply(sock, jid, msg, '🔇 *Group muted* — ab sirf admin likh sakte hain.\n\nUnmute ke liye: *' + config.prefix + 'unmute*');
      } catch { await reply(sock, jid, msg, '❌ Mute nahi ho saka (bot admin hai?).'); }
    },
  },
  unmute: {
    desc: 'Group unmute — sab likh sakein (admin)',
    admin: true,
    run: async (sock, msg, args, { jid }) => {
      try {
        await sock.groupSettingUpdate(jid, 'not_announcement');
        await reply(sock, jid, msg, '🔊 *Group unmuted* — ab sab likh sakte hain 💗');
      } catch { await reply(sock, jid, msg, '❌ Unmute nahi ho saka (bot admin hai?).'); }
    },
  },

  // ── 💒 shadi fun ──
  shadi: {
    desc: 'Do logon ki shaadi karao (fun) 💒',
    run: async (sock, msg, args, { jid }) => {
      const ctx = ctxOf(msg);
      const mentioned = (ctx && ctx.mentionedJid) || [];
      const raw = args.join(' ').trim();
      let a = null, b = null;
      if (mentioned.length >= 2) { a = '@' + num(mentioned[0]); b = '@' + num(mentioned[1]); }
      else if (mentioned.length === 1 && raw.replace(/@\d+/g, '').trim()) { a = '@' + num(mentioned[0]); b = raw.replace(/@\d+/g, '').trim().split(/\s+&\s+|\s+/)[0]; }
      else {
        const parts = raw.split(/\s*&\s*|\s+/).filter(Boolean);
        if (parts.length >= 2) { a = parts[0]; b = parts.slice(1).join(' '); }
      }
      if (!a || !b) return reply(sock, jid, msg, `💒 Usage: *${config.prefix}shadi <naam1> & <naam2>*\nMasalan: *${config.prefix}shadi Ali & Sara*\n(ya do logon ko tag karo)`);
      const R = (arr) => arr[Math.floor(Math.random() * arr.length)];
      const date = `${Math.floor(Math.random() * 28) + 1} ${R(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'])} 2027`;
      const venue = R(['Badshahi Mosque ke lawn mein 🏰', 'nani ke ghar ke sehan mein 🏠', 'DHA Phase 5 ke marquee mein 💎', 'WhatsApp group mein (online shaadi) 📱', 'Minar-e-Pakistan ke saaye mein 🕌', 'Lahore Fort ke deewan-e-khaas mein 👑', 'chai wale dhabe par ☕', 'Neelum Valley ki wadiyon mein 🏔️']);
      const meher = R(['1 rupiya aur 2 samose 🥟', '5000 rupay aur ek bakra 🐐', 'iPhone 17 Pro Max 📱', '7 tola sona 💍', 'ek plot DHA mein 🏡', 'dill ka sukoon 💗 (priceless)']);
      const guests = Math.floor(Math.random() * 900) + 100;
      const khana = R(['biryani + qorma 🍛', 'desi ghee ke parathe 🫓', 'BBQ platter 🍖', 'daal chawal (budget shaadi) 🍚', 'pizza party 🍕']);
      const tabsira = R(['Qazi sahab bole: "Mubarak ho, nikah ho gaya!" 🤲', 'Dulhan ke abba ne aansu ponchhe 😢', 'Dulhe ke doston ne bhangra daal diya 💃', 'Mehmaan bole: "Khana to kamaal tha!" 😋', 'Nexa ne bhi mubarakbad di 💗', 'Photographer ne 500 photo le lein 📸']);
      const mentions = mentioned.filter(Boolean);
      await sock.sendMessage(jid, {
        text: `💒 *SHADI MUBARAK!* 💒\n\n🤵 *Dulha:* ${a}\n👰 *Dulhan:* ${b}\n\n📅 *Tareekh:* ${date}\n🏛️ *Muqam:* ${venue}\n💰 *Meher:* ${meher}\n👥 *Mehmaan:* ${guests}\n🍽️ *Khana:* ${khana}\n\n💬 _${tabsira}_\n\n🎉 Allah jodi salamat rakhe! Ameen 🤲💗\n_— ${config.botName}_`,
        mentions,
      }, { quoted: msg });
    },
  },

  // ── 💘 ship ──
  ship: {
    desc: 'Do naamon ki love compatibility 💘',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ').trim();
      const parts = raw.split(/\s*\|\s*|\s+&\s+/).filter(Boolean);
      if (parts.length < 2) return reply(sock, jid, msg, `💘 Usage: *${config.prefix}ship <naam1> | <naam2>*\nMasalan: *${config.prefix}ship Ali | Sara*`);
      const a = parts[0].slice(0, 30), b = parts.slice(1).join(' ').slice(0, 30);
      const h = crypto.createHash('md5').update(a.toLowerCase() + '❤' + b.toLowerCase()).digest('hex');
      const pct = parseInt(h.slice(0, 4), 16) % 101;
      const filled = Math.round(pct / 10);
      const bar = '❤️'.repeat(filled) + '🤍'.repeat(10 - filled);
      let comment;
      if (pct >= 90) comment = 'Perfect jodi! Shaadi pakki samjho 💒🔥';
      else if (pct >= 70) comment = 'Baat ban sakti hai, thodi mehnat karo 😍';
      else if (pct >= 50) comment = '50-50... qismat aazma lo 🎲';
      else if (pct >= 30) comment = 'Mushkil hai dost, dil chhota na karo 💔';
      else comment = 'Bhai rehne de, dosti hi behtar hai 🙏😅';
      await reply(sock, jid, msg, `💘 *Love Meter* 💘\n\n*${a}* ❤️ *${b}*\n\n${bar}\n*${pct}%* compatible\n\n💬 _${comment}_\n_— ${config.botName}_`);
    },
  },

  // ── 👁️ vv3: view-once isi chat mein ──
  vv3: {
    desc: 'View-once unlock — media ISI chat mein bhejo (reply)',
    run: async (sock, msg, args, { jid }) => {
      const quoted = ctxOf(msg)?.quotedMessage;
      const vo = extractViewOnce(quoted);
      if (!vo) return reply(sock, jid, msg, `❌ Kisi view-once photo/video/voice ke reply mein *${config.prefix}vv3* likhein.\n\n_(vv/vv2 media aapki private chat mein bhejte hain — vv3 isi chat mein bhejta hai)_`);
      const { imgM, vidM, audM } = vo;
      try {
        const caption = `👁️ *View-once unlocked (vv3)*\n_— ${config.botName}_`;
        if (audM) {
          const buf = await downloadMediaMessage({ key: msg.key, message: { audioMessage: audM } }, 'buffer', {});
          await sock.sendMessage(jid, { audio: buf, ptt: true, mimetype: audM.mimetype || 'audio/ogg; codecs=opus' }, { quoted: msg });
        } else if (imgM) {
          const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: imgM } }, 'buffer', {});
          await sock.sendMessage(jid, { image: buf, caption }, { quoted: msg });
        } else {
          const buf = await downloadMediaMessage({ key: msg.key, message: { videoMessage: vidM } }, 'buffer', {});
          await sock.sendMessage(jid, { video: buf, caption }, { quoted: msg });
        }
      } catch {
        await reply(sock, jid, msg, '❌ View-once khol nahi saka, dobara try karein.');
      }
    },
  },

  // ── 🎵 ttmp3: TikTok audio ──
  ttmp3: {
    desc: 'TikTok video ka audio (MP3) 🎵',
    run: async (sock, msg, args, { jid }) => {
      const url = (args[0] || '').trim();
      if (!url || !/tiktok\.com/i.test(url)) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}ttmp3 <tiktok-link>*`);
      await reply(sock, jid, msg, wline(['🎵 TikTok audio nikal rahi hoon... 💗', '🎧 Audio alag kar rahi hoon... ✨', '🎵 Dhun pakad rahi hoon... ek second! 💫']));
      const tmpTT = `/tmp/ttmp3-${Date.now()}`;
      try {
        const r = await cobalt(url);
        let fileUrl = r.url;
        if (r.status === 'picker' && Array.isArray(r.picker) && r.picker.length) {
          fileUrl = (r.picker.find((p) => p.type === 'video') || r.picker[0]).url;
        }
        if (!fileUrl) throw new Error('no-url');
        const dl = await fetch(fileUrl, { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        const buf = Buffer.from(await dl.arrayBuffer());
        if (buf.length < 20000) throw new Error('bad-file');
        // video bytes ko seedha audio bhej diya tha (ghalat) — ab ffmpeg se ASAL audio extract (2026-09-23)
        fs.writeFileSync(`${tmpTT}.mp4`, buf);
        await new Promise((res, rej) => {
          execFile('/usr/bin/ffmpeg', ['-y', '-i', `${tmpTT}.mp4`, '-vn', '-c:a', 'aac', '-b:a', '128k', `${tmpTT}.m4a`], (e) => (e ? rej(e) : res()));
        });
        const audio = fs.readFileSync(`${tmpTT}.m4a`);
        if (audio.length < 10000) throw new Error('bad-audio');
        await sock.sendMessage(jid, { audio, mimetype: 'audio/mp4', fileName: 'tiktok_audio.m4a' }, { quoted: msg });
        await reply(sock, jid, msg, `🎵 *TikTok audio* — ${config.botName} 💗`);
      } catch {
        await reply(sock, jid, msg, '❌ Audio nahi nikal saka, link check karke dobara try karein.');
      } finally {
        try { fs.unlinkSync(`${tmpTT}.mp4`); } catch {}
        try { fs.unlinkSync(`${tmpTT}.m4a`); } catch {}
      }
    },
  },

  // ── 💬 mentionme: mention par AI jawab (JAWAD wala mentionreply) ──
  // Note: 'mentionreply' naam pehle se maujood hai (group replies mein sender
  // mention) — takrao se bachne ke liye naye feature ka naam 'mentionme' hai.
  mentionme: {
    desc: 'Bot ko mention karo to AI jawab de (on/off) 💬',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'mentionme', '💬 Mention-me'); },
  },

  // ── ❤️ statuslike ──
  statuslike: {
    desc: 'Status par auto ❤️ like (on/off)',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'statuslike', '❤️ Status-like'); },
  },

  // ── 🟢 alwaysonline ──
  alwaysonline: {
    desc: 'Bot hamesha online dikhe (on/off) 🟢',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'alwaysonline', '🟢 Always-online'); },
  },

  // ── 🎙 voicecmd: voice note se command (default OFF — aam voice note par khamoshi) ──
  voicecmd: {
    desc: 'Voice note sun kar command chalao (on/off) 🎙',
    owner: true,
    run: async (sock, msg, args, { jid }) => { await settingsToggle(sock, msg, jid, args, 'voicecmd', '🎙 Voice-command'); },
  },

  // ── 📢 gcstatusall: tamam groups mein broadcast ──
  gcstatusall: {
    desc: 'Ek paigham tamam groups mein bhejo (sirf owner) 📢',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim();
      const q = ctxOf(msg)?.quotedMessage;
      const imgQ = q?.imageMessage, vidQ = q?.videoMessage;
      if (!text && !imgQ && !vidQ) {
        return reply(sock, jid, msg, `📢 Usage: *${config.prefix}gcstatusall <paigham>*\n(ya kisi photo/video ke reply mein likhein)\n\nYe paigham aapke *tamam groups* mein jayega.`);
      }
      let groups = [];
      try {
        const all = await sock.groupFetchAllParticipating();
        groups = Object.keys(all || {});
      } catch { return reply(sock, jid, msg, '❌ Groups ki list nahi mil saki.'); }
      if (!groups.length) return reply(sock, jid, msg, '❌ Koi group nahi mila.');
      let content;
      try {
        if (imgQ || vidQ) {
          const buf = await downloadMediaMessage({ key: msg.key, message: imgQ ? { imageMessage: imgQ } : { videoMessage: vidQ } }, 'buffer', {});
          const cap = `📢 *${config.botName}*\n\n${text}`;
          content = imgQ ? { image: buf, caption: cap } : { video: buf, caption: cap };
        } else {
          content = { text: `📢 *${config.botName} Broadcast*\n\n${text}` };
        }
      } catch { return reply(sock, jid, msg, '❌ Media download nahi ho saka.'); }
      await reply(sock, jid, msg, `📢 Broadcast shuru — *${groups.length}* groups...`);
      let ok = 0;
      for (const g of groups) {
        try { await sock.sendMessage(g, content); ok++; } catch {}
        await new Promise((r) => setTimeout(r, 700)); // anti-ban waqfa
      }
      await reply(sock, jid, msg, `✅ Broadcast mukammal: *${ok}/${groups.length}* groups mein bhej diya 📢`);
    },
  },
};

// ── aliases jo commands object par depend karte hain ──
Object.assign(commands, NEW_COMMANDS_16);
commands.screenshot = { ...commands.ss, desc: 'Website screenshot (ss jaisa) 📸' };
commands.webshot = { ...commands.ss, desc: 'Website screenshot (ss jaisa) 📸' };
commands.getdp = { ...commands.getpp, desc: 'Profile photo nikalo (getpp jaisa) 🖼️' };
commands.marriage = { ...commands.shadi, desc: 'Shaadi fun (shadi jaisa) 💒' };

// ─── 😄 HACKER-PRANK batch (2026-09-23): sab 100% MAZAK — har command mein disclaimer lazmi ───
const HACK_PRANK_DISCLAIMER = '😄 *Ye sirf mazak tha!*';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// fake target: mentioned user, warna khud
function prankTarget(msg, sender) {
  const ci = getContextInfo(msg);
  const mentioned = (ci && ci.mentionedJid) || [];
  return mentioned[0] || sender;
}

Object.assign(commands, {

  hack: {
    desc: 'Fake hacking prank 💻😄 (.hack @user)',
    run: async (sock, msg, args, { jid, sender }) => {
      const target = prankTarget(msg, sender);
      const who = num(target);
      const seq = [
        `💻 *Connecting to server...*\n_🎯 Target: ${who}_`,
        `🔓 *Bypassing security...*\n████████████ 60%`,
        `📥 *Downloading data...*\n████████████████ 100%`,
        `✅ *ACCESS GRANTED!*`,
      ];
      for (const s of seq) { await reply(sock, jid, msg, s, { nosig: true }); await sleep(800); } // staged steps — signature nahi
      const secrets = [
        '🤫 Raaz: fridge mein chhup kar ice-cream khata hai!',
        '🤫 Raaz: neend mein mobile chehre par gir chuka hai!',
        '🤫 Raaz: chai mein cheeni ki jagah namak daal chuka hai!',
        '🤫 Raaz: khud se baatein karta hai aur khud hi hansta hai!',
        '🤫 Raaz: "bas 5 minute" wala game 2 ghante khelta hai!',
        '🤫 Raaz: daant parne par bhi hansi aa jati hai!',
      ];
      const pick = secrets[Math.floor(Math.random() * secrets.length)];
      await sock.sendMessage(jid, {
        text: `🕵️ *HACKED DATA — @${who}* 🕵️\n\n📛 Naam: @${who}\n🍗 Pasandeeda khana: *Biryani*\n😴 Kamzori: *Neend*\n${pick}\n\n${HACK_PRANK_DISCLAIMER} Koi data chori nahi hua — sab fake tha 💗`,
        mentions: [target],
      }, { quoted: msg });
    },
  },

  virus: {
    desc: 'Fake virus alert prank 🦠😄',
    run: async (sock, msg, args, { jid, sender }) => {
      await reply(sock, jid, msg,
        `🦠 *WARNING!* 😱\n\nAapke phone mein *3 virus* mile hain!\n\n` +
        `📛 Virus 1: _Bhook-Lagne-Wala Trojan_\n` +
        `📛 Virus 2: _Neend-Urane-Wala Worm_\n` +
        `📛 Virus 3: _Biryani-Khane-Wala Malware_\n\n` +
        `⏳ Phone *10 second* mein blast hone wala hai... 💥`, { nosig: true });
      await sleep(1500);
      await reply(sock, jid, msg,
        `${HACK_PRANK_DISCLAIMER} Aapka phone bilkul theek hai — koi virus nahi, bas thodi bhook lagi hogi 😋💗`);
    },
  },

  trace: {
    desc: 'Fake trace prank 📡😄 (.trace @user)',
    run: async (sock, msg, args, { jid, sender }) => {
      const target = prankTarget(msg, sender);
      const who = num(target);
      const devices = ['Dabba Phone 3000 📱', 'Nokia 3310 (Amar) 📱', 'Chori ka iPhone (mazak!) 🍎', 'Calculator watch ⌚'];
      const acts = ['Biryani ki photo dekh raha tha 🍗', 'Status par "busy" likh kar game khel raha tha 🎮', 'Ammi se charger maang raha tha 🔌', 'Khud ki DP zoom kar raha tha 🤳'];
      const dev = devices[Math.floor(Math.random() * devices.length)];
      const act = acts[Math.floor(Math.random() * acts.length)];
      await reply(sock, jid, msg, '📡 *TRACE INITIATED...*\n_Signal pakad rahi hoon..._ 💗');
      await sleep(1000);
      await sock.sendMessage(jid, {
        text: `📡 *TRACE COMPLETE — @${who}* 📍\n\n🌐 IP: *192.168.mazaak.1*\n📍 Location: *Ammi ke paas — Kitchen mein*\n📱 Device: *${dev}*\n🍗 Aakhri activity: *${act}*\n\n${HACK_PRANK_DISCLAIMER} Koi trace nahi hua — sab fake tha 💗`,
        mentions: [target],
      }, { quoted: msg });
    },
  },

  spy: {
    desc: 'Fake spy report 🕵️😄 (.spy @user)',
    run: async (sock, msg, args, { jid, sender }) => {
      const target = prankTarget(msg, sender);
      const who = num(target);
      const neend = 2 + Math.floor(Math.random() * 7);
      const moods = ['Bhookha 🍕', 'Neend mein 😴', 'Game mode 🎮', 'Chai chahiye ☕', 'Filmy 🎬'];
      const battery = 5 + Math.floor(Math.random() * 90);
      const lastmsgs = ['"bas 2 minute mein aaya" _(2 ghante pehle)_', '"kal se pakka diet" _(kal bhi yehi kaha tha)_', '"mera net slow hai" _(game mein busy)_', '"so raha hoon" _(online tha)_'];
      await sock.sendMessage(jid, {
        text: `🕵️ *SPY REPORT — @${who}* 🕵️\n\n😴 Neend: *${neend} ghante* (kal raat game mein)\n🍕 Mood: *${moods[Math.floor(Math.random() * moods.length)]}*\n🔋 Battery: *${battery}%* (charger dhoondh raha hai)\n💬 Aakhri message: ${lastmsgs[Math.floor(Math.random() * lastmsgs.length)]}\n\n${HACK_PRANK_DISCLAIMER} Main koi jasoos nahi hoon 💗`,
        mentions: [target],
      }, { quoted: msg });
    },
  },

  jailbreak: {
    desc: 'Fake phone jailbreak prank 🔓😄',
    run: async (sock, msg, args, { jid }) => {
      await reply(sock, jid, msg, '🔓 *Jailbreak shuru...*\n📲 Phone detect: _Aapka Pyaara Phone_', { nosig: true });
      await sleep(900);
      await reply(sock, jid, msg, '⚙️ *Exploit laga raha hoon...*\n████████ 45%', { nosig: true });
      await sleep(900);
      await reply(sock, jid, msg, '🧩 *System files patch...*\n████████████████ 90%', { nosig: true });
      await sleep(900);
      await reply(sock, jid, msg, `✅ *Jailbreak complete!* 🎉\n\n😄 *(mazak 😄 — kuch nahi hua!)* Aapka phone bilkul mehfooz hai 💗`);
    },
  },

  matrix: {
    desc: 'Text ko Matrix style 🟩 (.matrix <text>)',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 200);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}matrix <text>*\nMasalan: *${config.prefix}matrix main hacker hoon*`);
      const kata = 'アイウルエオカキクケコサシスセソタチツテトナニヌネノ0123456789';
      const lines = [...q].map(ch => {
        if (ch === ' ' || ch === '\n') return ch;
        const bin = ch.codePointAt(0).toString(2).padStart(8, '0');
        const k = kata[ch.codePointAt(0) % kata.length];
        return `${k} ${bin}`;
      });
      await reply(sock, jid, msg, `🟩 *MATRIX MODE* 🟩\n\n\`\`\`\n${lines.join('\n').slice(0, 1500)}\n\`\`\`\n\n${HACK_PRANK_DISCLAIMER} 💗`);
    },
  },

  secret: {
    desc: 'Fake military encryption 🔐😄 (.secret <text>)',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 200);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}secret <text>*\nMasalan: *${config.prefix}secret mera raaz*`);
      const em = ['🔐', '💀', '⚡', '🌀', '👾', '🛡️', '💠', '🔥', '🌐', '⚛️'];
      const enc = [...q].map(ch => {
        if (ch === ' ' || ch === '\n') return '  ';
        const bin = ch.codePointAt(0).toString(2).padStart(8, '0');
        return `${em[ch.codePointAt(0) % em.length]}${bin}`;
      }).join(' ');
      await reply(sock, jid, msg,
        `🔐 *MILITARY-GRADE ENCRYPTION* 🔐\n\n\`\`\`\n${enc.slice(0, 1500)}\n\`\`\`\n\n_⚠️ Warning: is cipher ko sirf NEXORA-MD samajh sakti hai_\n\n${HACK_PRANK_DISCLAIMER} Ye koi asal encryption nahi 💗`);
    },
  },
});

// ─── 💗 DILKHUSH — dil khush kar dene wala surprise card (Boss: 2026-09-25) ───
Object.assign(commands, {
  dilkhush: {
    desc: 'Dil khush karne wala surprise card 💗 (.dilkhush @user)',
    run: async (sock, msg, args, { jid, sender }) => {
      await reply(sock, jid, msg, '💗 Dil khush kar rahi hoon... ✨');
      try {
        const ci = (typeof getContextInfo === 'function' ? getContextInfo(msg) : null) || {};
        const mentioned = ci.mentionedJid || [];
        let target = mentioned[0] || ci.participant || null;
        if (!target || target === sender) target = null;
        const who = target ? num(target) : null;

        const happy = [
          'Tumhari muskurahat kisi ki dua ka jawab ho sakti hai — muskurate raho!',
          'Aaj ka din tumhare naam — khush raho, abaad raho!',
          'Tum jaisa dil sab ke paas nahi hota — apni qadar karo!',
          'Chhoti chhoti khushiyan hi asal khazana hain.',
          'Tumhari mehnat zaroor rang layegi — bas himmat na haaro!',
          'Koi tumhein yaad karke muskurata hai — socho kitne khaas ho!',
          'Dil saaf rakho, duniya khud khoobsurat lagne lagegi.',
          'Tumhari ek achhi baat kisi ka poora din bana sakti hai.',
          'Mushkilein aati hain, lekin tum un se zyada mazboot ho!',
          'Aaj kuch achha karo — dil ko sukoon milega.',
          'Tumhari duaen kabhi zaya nahi jatin.',
          'Zindagi khoobsurat hai — bas dekhne ka andaz badlo.',
          'Tum jahan hote ho, wahan roshni hoti hai!',
          'Apne aap se pyaar karo — tum iske haqdaar ho.',
          'Har subah nayi ummeed lekar aati hai.',
          'Tumhari kahani abhi khatam nahi hui — behtareen safhaat baqi hain.',
          'Doston ka saath aur apnon ki dua — tum ameer ho!',
          'Muskurahat muft hai, lekin uski qeemat sab se zyada hai.',
          'Tum kisi ke liye poori duniya ho — ye mat bhoolo.',
          'Khush raho, khushiyan baanto — yehi zindagi hai!',
        ];
        const pick = happy[Math.floor(Math.random() * happy.length)];
        const esc = pick.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const words = esc.split(/\s+/), lines = []; let cur = '';
        for (const w of words) { if ((cur + ' ' + w).trim().length > 26) { if (cur.trim()) lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
        if (cur.trim()) lines.push(cur.trim());

        const W = 1080, H = 1080;
        const bigHeart = 'M540,330 C520,290 470,270 430,270 C370,270 330,315 330,375 C330,450 430,505 540,570 C650,505 750,450 750,375 C750,315 710,270 650,270 C610,270 560,290 540,330 Z';
        const miniHeart = (x, y, s, o) => `<g transform="translate(${x} ${y}) scale(${s})" opacity="${o}"><path d="M0,20 C0,5 -15,-5 -28,-5 C-45,-5 -55,8 -55,22 C-55,42 -25,58 0,72 C25,58 55,42 55,22 C55,8 45,-5 28,-5 C15,-5 0,5 0,20 Z" fill="#ffd166"/></g>`;
        const sparkle = (x, y, r, o) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${o}"/>`;
        const lh = 64, startY = 690;
        const textEls = lines.slice(0, 6).map((ln, i) => `<text x="540" y="${startY + i * lh}" text-anchor="middle" font-family="Georgia, serif" font-size="44" font-style="italic" fill="#ffffff" stroke="#a4133c" stroke-width="5" paint-order="stroke">${ln}</text>`).join('');
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<defs><linearGradient id="dhg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a4133c"/><stop offset="0.55" stop-color="#ff4d6d"/><stop offset="1" stop-color="#ff8fa3"/></linearGradient>`
          + `<radialGradient id="dhglow" cx="0.5" cy="0.38" r="0.45"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>`
          + `<rect width="${W}" height="${H}" fill="url(#dhg)"/>`
          + `<rect width="${W}" height="${H}" fill="url(#dhglow)"/>`
          + miniHeart(140, 180, 1.1, 0.75) + miniHeart(940, 220, 0.9, 0.6) + miniHeart(120, 900, 0.8, 0.55) + miniHeart(960, 880, 1.2, 0.7) + miniHeart(880, 120, 0.6, 0.5)
          + sparkle(250, 320, 7, 0.7) + sparkle(830, 420, 6, 0.6) + sparkle(200, 700, 5, 0.5) + sparkle(890, 700, 7, 0.6) + sparkle(540, 120, 6, 0.55) + sparkle(420, 950, 5, 0.5) + sparkle(660, 950, 6, 0.5)
          + `<g transform="translate(540 385) scale(1.12) translate(-540 -385)" opacity="0.35"><path d="${bigHeart}" fill="#ff8fa3"/></g>`
          + `<path d="${bigHeart}" fill="#e63956" stroke="#ffffff" stroke-width="10"/>`
          + `<text x="540" y="640" text-anchor="middle" font-family="Georgia, serif" font-weight="bold" font-size="58" letter-spacing="10" fill="#ffffff" opacity="0.95">DIL KHUSH</text>`
          + textEls
          + `<text x="540" y="1015" text-anchor="middle" font-family="Georgia, serif" font-size="32" font-style="italic" fill="#ffffff" opacity="0.9">Nexa ki taraf se  |  NEXORA-MD</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        const cap = `💗 *Dil Khush!* 💗\n\n_${pick}_\n\n` + (who ? `@${who} — ye khaas tumhare liye! 🫶` : `Sab ke liye dher saara pyaar! 🫶`);
        await sock.sendMessage(jid, { image: out, caption: cap, mentions: who ? [target] : [] }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Dil khush card nahi ban saka.'); }
    },
  },
});

// ─── 💐 COMPLIMENT + ✨ TEXTMAKER + 💥 SHOCK GIFs (Boss: 2026-09-25) ───
// shared text-FX helper — neon/glow se mukhtalif looks (fire/ice/thunder/metal)
function makeTextFX(text, o) {
  const t = String(text || 'NEXORA').slice(0, 24).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const W = 1080, H = 640;
  const fs = t.length > 14 ? 80 : t.length > 9 ? 100 : 124;
  const gid = 'fx' + Math.random().toString(36).slice(2, 8);
  const stops = o.stops.map((s, i) => `<stop offset="${(i / (o.stops.length - 1)).toFixed(2)}" stop-color="${s}"/>`).join('');
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
    + `<defs><linearGradient id="${gid}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${o.bg1}"/><stop offset="1" stop-color="${o.bg2}"/></linearGradient>`
    + `<linearGradient id="${gid}t" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>`
    + `<filter id="${gid}g" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="16" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`
    + `<rect width="${W}" height="${H}" fill="url(#${gid}b)"/>`
    + (o.extra || '')
    + `<text x="540" y="${Math.round(H / 2 + fs * 0.35)}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${fs}" font-weight="900" fill="url(#${gid}t)" stroke="${o.stroke}" stroke-width="5" filter="url(#${gid}g)">${t}</text>`
    + `<text x="540" y="${H - 44}" text-anchor="middle" font-family="Georgia, serif" font-size="28" font-style="italic" fill="#ffffff" opacity="0.75">NEXORA-MD</text>`
    + `</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const TEXTFX_STYLES = {
  firetext: { stops: ['#ff3d00', '#ff9100', '#ffea00'], stroke: '#5d0a00', bg1: '#1a0500', bg2: '#3d0f00' },
  icetext: { stops: ['#e8fbff', '#7fdcff', '#2e9bff'], stroke: '#0b3d66', bg1: '#02141f', bg2: '#06303f' },
  thundertext: {
    stops: ['#fffde7', '#ffd93d', '#ff9d00'], stroke: '#4d2c00', bg1: '#140b2e', bg2: '#3a1052',
    extra: '<polygon points="180,80 130,260 190,260 140,480 260,220 195,220 240,80" fill="#ffd93d" opacity="0.85"/>'
      + '<polygon points="900,120 860,260 905,260 865,440 955,240 900,240 930,120" fill="#ffd93d" opacity="0.7"/>',
  },
  metalfire: { stops: ['#f5f5f5', '#ffb300', '#c11e00'], stroke: '#3d0c00', bg1: '#101010', bg2: '#2b2b2b' },
};
Object.assign(commands, {
  compliment: {
    desc: 'Kisi ki taareef wala khoobsurat card 💐 (.compliment @user)',
    run: async (sock, msg, args, { jid, sender }) => {
      await reply(sock, jid, msg, '💐 Taareef tayyar kar rahi hoon... ✨');
      try {
        const ci = (typeof getContextInfo === 'function' ? getContextInfo(msg) : null) || {};
        const mentioned = ci.mentionedJid || [];
        let target = mentioned[0] || ci.participant || null;
        if (!target || target === sender) target = null;
        const who = target ? num(target) : null;
        const taarif = [
          'Tumhari soch hi tumhein sab se alag karti hai!',
          'Tum jaisa dost milna kismat ki baat hai!',
          'Tumhari mehnat dekh kar dil khush ho jata hai!',
          'Tumhari muskurahat se mehfil roshan ho jati hai!',
          'Tum mein jo baat hai, wo kisi mein nahi!',
          'Tumhare alfaz dil ko chhu lete hain!',
          'Tumhari himmat ko salaam!',
          'Tum jahan jate ho, khushiyan le jate ho!',
          'Tumhara dil sona hai — apni qadar karo!',
          'Tumhari kamyabi door nahi, bas thoda sabar!',
          'Tum se mil kar lagta hai achhe log ab bhi hain!',
          'Tumhari ada hi nirali hai!',
          'Tum har mushkil ko aasan bana lete ho!',
          'Tumhari wafa ki misaal nahi!',
          'Tum jaisa saathi sab ko naseeb nahi hota!',
          'Tumhari baaton mein jaadu hai!',
          'Tum roshni ho andheron mein!',
          'Tumhari lagan dekh kar fakhr hota hai!',
          'Tum dil ke ameer ho!',
          'Tum ho to mehfil hai!',
        ];
        const pick = taarif[Math.floor(Math.random() * taarif.length)];
        const esc = pick.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const words = esc.split(/\s+/), lines = []; let cur = '';
        for (const w of words) { if ((cur + ' ' + w).trim().length > 26) { if (cur.trim()) lines.push(cur.trim()); cur = w; } else cur += ' ' + w; }
        if (cur.trim()) lines.push(cur.trim());
        const W = 1080, H = 1080;
        const star = (x, y, r, o) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffd166" opacity="${o}"/>`;
        const lh = 64, startY = 700;
        const textEls = lines.slice(0, 6).map((ln, i) => `<text x="540" y="${startY + i * lh}" text-anchor="middle" font-family="Georgia, serif" font-size="44" font-style="italic" fill="#ffffff" stroke="#00332c" stroke-width="5" paint-order="stroke">${ln}</text>`).join('');
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<defs><linearGradient id="cpg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#00332c"/><stop offset="0.55" stop-color="#00796b"/><stop offset="1" stop-color="#26a69a"/></linearGradient>`
          + `<radialGradient id="cpgl" cx="0.5" cy="0.35" r="0.45"><stop offset="0" stop-color="#ffffff" stop-opacity="0.3"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs>`
          + `<rect width="${W}" height="${H}" fill="url(#cpg)"/>`
          + `<rect width="${W}" height="${H}" fill="url(#cpgl)"/>`
          + star(150, 200, 9, 0.8) + star(930, 180, 7, 0.65) + star(110, 880, 6, 0.55) + star(950, 860, 10, 0.7) + star(870, 130, 5, 0.5) + star(300, 120, 6, 0.6) + star(700, 940, 6, 0.55)
          + `<g transform="translate(540 300)" opacity="0.95">`
          + `<circle cx="55" cy="0" r="30" fill="#ffd166"/><circle cx="39" cy="39" r="30" fill="#ffd166"/><circle cx="0" cy="55" r="30" fill="#ffd166"/><circle cx="-39" cy="39" r="30" fill="#ffd166"/><circle cx="-55" cy="0" r="30" fill="#ffd166"/><circle cx="-39" cy="-39" r="30" fill="#ffd166"/><circle cx="0" cy="-55" r="30" fill="#ffd166"/><circle cx="39" cy="-39" r="30" fill="#ffd166"/>`
          + `<circle cx="0" cy="0" r="34" fill="#ff8c42" stroke="#ffffff" stroke-width="6"/>`
          + `</g>`
          + `<text x="540" y="560" text-anchor="middle" font-family="Georgia, serif" font-weight="bold" font-size="72" letter-spacing="12" fill="#ffd166">WAAH!</text>`
          + textEls
          + `<text x="540" y="1015" text-anchor="middle" font-family="Georgia, serif" font-size="32" font-style="italic" fill="#ffffff" opacity="0.9">Nexa ki taraf se  |  NEXORA-MD</text>`
          + `</svg>`;
        const out = await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
        const cap = `💐 *WAAH! Kya baat hai!* 💐\n\n_${pick}_\n\n` + (who ? `@${who} — ye taareef tumhare naam! 🌟` : `Sab ke liye pyaar bhari taareef! 🌟`);
        await sock.sendMessage(jid, { image: out, caption: cap, mentions: who ? [target] : [] }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Taareef card nahi ban saka.'); }
    },
  },

  firetext: {
    desc: 'Aag wala stylish text 🔥 (.firetext <text>)',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 24);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}firetext <text>*`);
      try { const png = await makeTextFX(text, TEXTFX_STYLES.firetext); await sock.sendMessage(jid, { image: png, caption: `🔥 *${text}*` }, { quoted: msg }); }
      catch { await reply(sock, jid, msg, '❌ Fire text nahi ban saka.'); }
    },
  },
  icetext: {
    desc: 'Barf wala stylish text 🧊 (.icetext <text>)',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 24);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}icetext <text>*`);
      try { const png = await makeTextFX(text, TEXTFX_STYLES.icetext); await sock.sendMessage(jid, { image: png, caption: `🧊 *${text}*` }, { quoted: msg }); }
      catch { await reply(sock, jid, msg, '❌ Ice text nahi ban saka.'); }
    },
  },
  thundertext: {
    desc: 'Bijli wala stylish text ⚡ (.thundertext <text>)',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 24);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}thundertext <text>*`);
      try { const png = await makeTextFX(text, TEXTFX_STYLES.thundertext); await sock.sendMessage(jid, { image: png, caption: `⚡ *${text}*` }, { quoted: msg }); }
      catch { await reply(sock, jid, msg, '❌ Thunder text nahi ban saka.'); }
    },
  },
  metalfire: {
    desc: 'Metal-fire stylish text 🔥 (.metalfire <text>)',
    run: async (sock, msg, args, { jid }) => {
      const text = args.join(' ').trim().slice(0, 24);
      if (!text) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}metalfire <text>*`);
      try { const png = await makeTextFX(text, TEXTFX_STYLES.metalfire); await sock.sendMessage(jid, { image: png, caption: `🔥 *${text}*` }, { quoted: msg }); }
      catch { await reply(sock, jid, msg, '❌ Metal-fire text nahi ban saka.'); }
    },
  },

  dhamaka: {
    desc: 'Text ka dhamaka — animated blast 💥 (.dhamaka <text>)',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ').trim().slice(0, 24) || 'DHAMAKA';
      const text = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      await reply(sock, jid, msg, '💥 Dhamaka tayyar ho raha hai... 💗');
      const rand = crypto.randomBytes(6).toString('hex');
      const W = 1080, H = 640, N = 12;
      const frames = [], out = `/tmp/dham_${rand}.mp4`;
      try {
        const parts = [];
        for (let k = 0; k < 28; k++) {
          parts.push({ a: (k / 28) * Math.PI * 2 + Math.random() * 0.4, sp: 26 + Math.random() * 42, r: 6 + Math.random() * 10, c: ['#ffea00', '#ff9100', '#ff3d00', '#ffffff'][k % 4] });
        }
        for (let i = 0; i < N; i++) {
          const p = i / (N - 1);
          const fs = Math.round(110 * (0.6 + p * 1.3));
          const top = p < 0.55 ? 1 : Math.max(0, 1 - (p - 0.55) / 0.45);
          const dots = parts.map((pt) => {
            const rr = pt.sp * p * 9;
            return `<circle cx="${Math.round(W / 2 + Math.cos(pt.a) * rr)}" cy="${Math.round(H / 2 + Math.sin(pt.a) * rr * 0.7)}" r="${Math.max(1, Math.round(pt.r * (1 - p * 0.5)))}" fill="${pt.c}" opacity="${(1 - p).toFixed(2)}"/>`;
          }).join('');
          const flash = p < 0.3 ? `<circle cx="${W / 2}" cy="${H / 2}" r="${Math.round(60 + p * 600)}" fill="#ffffff" opacity="${(0.55 * (1 - p / 0.3)).toFixed(2)}"/>` : '';
          const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
            + `<rect width="${W}" height="${H}" fill="#0a0a14"/>`
            + flash + dots
            + `<text x="${W / 2}" y="${Math.round(H / 2 + fs * 0.35)}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${fs}" font-weight="900" fill="#ffea00" stroke="#7a0e00" stroke-width="6" opacity="${top.toFixed(2)}">${text}</text>`
            + `</svg>`;
          const fp = `/tmp/dham_${rand}_${String(i).padStart(2, '0')}.png`;
          await sharp(Buffer.from(svg)).png().toFile(fp);
          frames.push(fp);
        }
        await new Promise((res, rej) => {
          execFile('ffmpeg', ['-y', '-framerate', '12', '-i', `/tmp/dham_${rand}_%02d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=480:-1', out], { timeout: 120000 }, (e) => (e ? rej(e) : res()));
        });
        const ob = fs.readFileSync(out);
        if (!ob.length) throw new Error('empty-out');
        await sock.sendMessage(jid, { video: ob, gifPlayback: true, caption: `💥 *${raw}* 💥\n_— ${config.botName}_` }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Dhamaka nahi ho saka.'); }
      finally { for (const f of frames) { try { fs.unlinkSync(f); } catch {} } try { fs.unlinkSync(out); } catch {} }
    },
  },

  sammohan: {
    desc: 'Sammohan spiral — hypnotic animation 😵‍💫 (.sammohan [text])',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ').trim().slice(0, 30);
      await reply(sock, jid, msg, '😵‍💫 Sammohan shuru... dekho aur kho jao! 💗');
      const rand = crypto.randomBytes(6).toString('hex');
      const W = 640, H = 640, N = 12;
      let d = '';
      for (let a = 0; a <= Math.PI * 10; a += 0.12) {
        const r = 6 + a * 9;
        d += (a === 0 ? 'M' : 'L') + (320 + r * Math.cos(a)).toFixed(1) + ' ' + (320 + r * Math.sin(a)).toFixed(1);
      }
      const frames = [], out = `/tmp/sam_${rand}.mp4`;
      try {
        for (let i = 0; i < N; i++) {
          const label = raw ? `<text x="320" y="610" text-anchor="middle" font-family="Georgia, serif" font-size="40" font-style="italic" fill="#ffffff" opacity="0.9">${raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</text>` : '';
          const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
            + `<rect width="${W}" height="${H}" fill="#000000"/>`
            + `<g transform="rotate(${i * 30} 320 320)"><path d="${d}" fill="none" stroke="#ffffff" stroke-width="15"/></g>`
            + `<circle cx="320" cy="320" r="20" fill="#ff2d78"/>` + label + `</svg>`;
          const fp = `/tmp/sam_${rand}_${String(i).padStart(2, '0')}.png`;
          await sharp(Buffer.from(svg)).png().toFile(fp);
          frames.push(fp);
        }
        await new Promise((res, rej) => {
          execFile('ffmpeg', ['-y', '-framerate', '10', '-i', `/tmp/sam_${rand}_%02d.png`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out], { timeout: 120000 }, (e) => (e ? rej(e) : res()));
        });
        const ob = fs.readFileSync(out);
        if (!ob.length) throw new Error('empty-out');
        await sock.sendMessage(jid, { video: ob, gifPlayback: true, caption: `😵‍💫 *SAMMOHAN* 😵‍💫\n\nDekho... aur kho jao...\n_— Nexa 🔮_` }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Sammohan nahi ho saka.'); }
      finally { for (const f of frames) { try { fs.unlinkSync(f); } catch {} } try { fs.unlinkSync(out); } catch {} }
    },
  },
});

// ─── 🔮 JADU — zehen parhne wala hairan-kun magic (Boss: 2026-09-25) ───
Object.assign(commands, {
  jadu: {
    desc: 'Nexa tumhara zehen parhegi — hairan kun jadu! 🔮 (.jadu)',
    run: async (sock, msg, args, { jid }) => {
      try {
        const tricks = [
          {
            steps: [
              '🧠 Zehen mein *1 se 20* tak koi adad socho...\n_(kisi ko batana mat!)_',
              '✖️ Ab us adad ko *2 se zarb* do...',
              '➕ Ab us mein *8 jama* karo...',
              '➗ Ab usay *2 se taqseem* karo (aadha kar do)...',
              '➖ Ab apna *original adad* us mein se *minus* kar do...',
              '🔮 Ruko... Nexa tumhare zehen mein jhaank rahi hai...',
            ],
            waits: [3500, 3000, 3000, 3000, 3000, 3200],
            answer: '4',
          },
          {
            steps: [
              '🧠 Zehen mein *1 se 30* tak koi adad socho...\n_(kisi ko batana mat!)_',
              '✖️ Ab us adad ko *2 se zarb* do...',
              '➕ Ab us mein *14 jama* karo...',
              '➗ Ab usay *2 se taqseem* karo (aadha kar do)...',
              '➖ Ab apna *original adad* us mein se *minus* kar do...',
              '🔮 Ruko... Nexa tumhare zehen mein jhaank rahi hai...',
            ],
            waits: [3500, 3000, 3000, 3000, 3000, 3200],
            answer: '7',
          },
          {
            steps: [
              '🔢 Zehen mein *3 hindson* ka koi adad socho jiska *pehla hindsa aakhri se bara* ho...\n_(masalan 752, 931, 421)_',
              '🔄 Ab us adad ko *ulta* likho... (752 → 257)',
              '➖ Ab *baray* adad mein se *chhota* adad *minus* karo...',
              '🔄 Jo jawab aaya, usay *ulta* likho...',
              '➕ Ab dono ko *aapas mein jama* kar do...',
              '🔮 Ruko... Nexa tumhare zehen mein jhaank rahi hai...',
            ],
            waits: [4000, 3000, 3500, 3000, 3000, 3200],
            answer: '1089',
          },
          {
            // 👟 SHOE-AGE trick: ((s*5+50)*20+YYYY)-birthyear = 100s + age
            steps: [
              '👟 Apne *joote ka number* socho (poora number, jaise 9)...\n_(kisi ko batana mat!)_',
              '✖️ Ab usay *5 se zarb* do...',
              '➕ Ab us mein *50 jama* karo...',
              '✖️ Ab usay *20 se zarb* do...',
              `➕ Ab us mein *${new Date().getFullYear() - 1000}* jama karo...`,
              '🎂 Ab apna *paidaish ka saal* minus kar do... (jaise 2000)',
              '🔮 Ruko... Nexa tumhare zehen mein jhaank rahi hai...',
            ],
            waits: [3500, 3000, 3000, 3000, 3000, 3000, 3200],
            answer: null,
            reveal: '🎯 *JADU KHUL GAYA!* 🎯\n\n👟 Tumhare final jawab ke *pehle hindse* = tumhare *joote ka size*\n🎂 Aur *aakhri 2 hindse* = tumhari *umar*!\n\n😱😱 Hairan ho gaye na?!\nYe hai *NEXORA-MD* ka jadu! 💗🔮',
          },
          {
            // 🐘 DENMARK-ELEPHANT: n*9 → digit sum = 9 → -5 = 4 = D → Denmark → E → Elephant
            steps: [
              '🧠 Zehen mein *1 se 10* tak koi adad socho...\n_(kisi ko batana mat!)_',
              '✖️ Ab usay *9 se zarb* do...',
              '🔢 Ab jawab ke *hindse aapas mein jama* karo... (jaise 18 → 1+8=9)',
              '➖ Ab us mein se *5 minus* karo...',
              '🔤 Ab gino: *1=A, 2=B, 3=C...* — tumhare jawab ka harf kaun sa bana?',
              '🌍 Ab us *harf se* shuru hone wala koi *European mulk* socho...',
              '🐾 Ab us mulk ke *doosre harf* se shuru hone wala koi *janwar* socho...',
              '🔮 Ruko... Nexa tumhare zehen mein jhaank rahi hai...',
            ],
            waits: [3500, 3000, 3500, 3000, 3500, 4000, 4000, 3200],
            answer: 'Denmark ka haathi! 🐘',
          },
        ];
        const t = tricks[Math.floor(Math.random() * tricks.length)];
        const W = 1080, H = 1080;
        const star = (x, y, r, o) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${o}"/>`;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
          + `<defs><linearGradient id="jbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12002b"/><stop offset="0.6" stop-color="#3d0066"/><stop offset="1" stop-color="#6a0dad"/></linearGradient>`
          + `<radialGradient id="jorb" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ffffff"/><stop offset="0.35" stop-color="#9be8ff"/><stop offset="0.7" stop-color="#4a90ff" stop-opacity="0.8"/><stop offset="1" stop-color="#4a90ff" stop-opacity="0"/></radialGradient></defs>`
          + `<rect width="${W}" height="${H}" fill="url(#jbg)"/>`
          + star(120,150,5,0.8) + star(300,90,4,0.6) + star(700,120,6,0.7) + star(920,200,4,0.6) + star(180,700,5,0.6) + star(900,750,6,0.7) + star(540,80,5,0.7) + star(80,450,4,0.5) + star(1000,450,5,0.5) + star(420,200,3,0.6) + star(660,220,3,0.6)
          + `<circle cx="540" cy="430" r="230" fill="url(#jorb)"/>`
          + `<circle cx="540" cy="430" r="150" fill="#dff6ff" opacity="0.9"/>`
          + `<ellipse cx="540" cy="700" rx="180" ry="26" fill="#ffd166" opacity="0.85"/>`
          + `<rect x="500" y="690" width="80" height="40" fill="#b8860b"/>`
          + `<text x="540" y="840" text-anchor="middle" font-family="Georgia, serif" font-weight="bold" font-size="66" letter-spacing="8" fill="#ffd166">NEXA KA JADU</text>`
          + `<text x="540" y="905" text-anchor="middle" font-family="Georgia, serif" font-size="38" font-style="italic" fill="#ffffff" opacity="0.9">zehen parhne wala jadu</text>`
          + `<text x="540" y="1015" text-anchor="middle" font-family="Georgia, serif" font-size="30" font-style="italic" fill="#ffffff" opacity="0.7">NEXORA-MD</text>`
          + `</svg>`;
        const orb = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { image: orb, caption: '🔮 *NEXA KA JADU* 🔮\n\nMain tumhara _zehen parh_ sakti hoon... himmat hai to aazmao! 😏' }, { quoted: msg });
        for (let i = 0; i < t.steps.length; i++) {
          await sleep(t.waits[i] || 3000);
          await reply(sock, jid, msg, t.steps[i]);
        }
        await sleep(1800);
        const revealTxt = t.reveal || `🎯 *TUMHARA JAWAB HAI: ${t.answer}* 🎯\n\n😱😱 Hairan ho gaye na?!\nYe hai *NEXORA-MD* ka jadu! 💗🔮`;
        await sock.sendMessage(jid, { text: `${revealTxt}\n\n_Dobara aazmana ho to_ \`.jadu\` _likho!_` }, { quoted: msg });
      } catch { await reply(sock, jid, msg, '❌ Jadu nahi ho saka.'); }
    },
  },
});

// ─── ✨ WOW batch (2026-09-23): capsule/aadat/antakshari/tilawat/qibla/allah/sauda/adalat/interview/kahani/trip/sorry ───
Object.assign(commands, {

  capsule: {
    desc: 'Time capsule ⏳ (.capsule YYYY-MM-DD <paigham>)',
    run: async (sock, msg, args, { jid, sender }) => {
      const date = (args[0] || '').trim();
      const text = args.slice(1).join(' ').trim().slice(0, 500);
      const today = pktDateStr();
      const okDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !isNaN(Date.parse(date + 'T00:00:00+05:00'));
      if (!okDate || !text) {
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}capsule <YYYY-MM-DD> <paigham>*\nMasalan: *${config.prefix}capsule 2027-01-01 Naya saal mubarak!*\n\n_Tareekh aaj (${today}) se aage ki ho._ 💗`);
      }
      if (date <= today) return reply(sock, jid, msg, `❌ Tareekh aaj (${today}) se *aage* ki honi chahiye. Guzra waqt wapas nahi aata 😄💗`);
      const all = loadCapsules();
      all.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), jid, who: sender || jid, by: num(sock.user?.id || ''), date, text, due: Date.parse(date + 'T08:00:00+05:00'), at: Date.now() });
      saveCapsules(all);
      await reply(sock, jid, msg, `⏳ *Time Capsule band!* 📬💗\n\n📅 *${date}* ko subah ye paigham khud-ba-khud khulega:\n_"${text.slice(0, 200)}"_\n\nDekhne ke liye: *${config.prefix}capsules*`);
    },
  },

  capsules: {
    desc: 'Mere time capsules dekho ⏳',
    run: async (sock, msg, args, { jid, sender }) => {
      const mine = loadCapsules().filter(c => c.jid === jid && (c.who || '') === (sender || jid)).sort((a, b) => a.due - b.due);
      if (!mine.length) return reply(sock, jid, msg, `⏳ Koi capsule nahi.\n\nBanayein: *${config.prefix}capsule 2027-01-01 <paigham>* 💗`);
      await reply(sock, jid, msg, `⏳ *Aapke Time Capsules* 💗\n\n` + mine.map((c, i) => `*${i + 1}.* 📅 ${c.date}\n    _${c.text.slice(0, 80)}_`).join('\n\n') + `\n\nHatane ke liye: *${config.prefix}delcapsule <number>*`);
    },
  },

  delcapsule: {
    desc: 'Time capsule hatao 🗑',
    run: async (sock, msg, args, { jid, sender }) => {
      const n = parseInt(args[0], 10);
      const all = loadCapsules();
      const mine = all.filter(c => c.jid === jid && (c.who || '') === (sender || jid));
      if (!n || n < 1 || n > mine.length) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}delcapsule <number>* (1 se ${mine.length} tak)`);
      const gone = mine[n - 1];
      saveCapsules(all.filter(c => c !== gone));
      await reply(sock, jid, msg, `🗑 Capsule hata diya (${gone.date}) 💗`);
    },
  },

  aadat: {
    desc: 'Habit tracker 🌱 (.aadat <naam>)',
    run: async (sock, msg, args, { jid, sender }) => {
      const name = args.join(' ').trim().slice(0, 40);
      if (!name) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}aadat <naam>*\nMasalan: *${config.prefix}aadat warzish*\n\nSab dekho: *${config.prefix}aadatein* 🌱`);
      const key = sender || jid;
      const all = loadHabits();
      const mine = all[key] || {};
      const hk = name.toLowerCase();
      const today = pktDateStr();
      const h = mine[hk] || { name, dates: [] };
      if (h.dates.includes(today)) {
        const st = habitStreak(h.dates);
        return reply(sock, jid, msg, `🌱 *${h.name}* — aaj ka check-in *ho gaya* hai! ✅\n\n🔥 Streak: *${st} din*\n\nKal phir aana 💗`);
      }
      h.dates.push(today);
      mine[hk] = h; all[key] = mine; saveHabits(all);
      const st = habitStreak(h.dates);
      const haout = `🌱 *${h.name}* — aaj ka check-in ✅\n\n🔥 Streak: *${st} din*\n\nShabash! Kal bhi yaad rakhungi 💗`;
      await sendCard(sock, jid, msg, 'AADAT TRACKER', [
        ['Aadat', h.name],
        ['Streak', `${st} din`],
        ['Kul check-in', `${h.dates.length}`],
      ], { hero: `${st} din streak`, sub: h.name, accent: '#4ade80' }, haout);
    },
  },

  aadatein: {
    desc: 'Sab aadatein + streaks 🌱',
    run: async (sock, msg, args, { jid, sender }) => {
      const mine = loadHabits()[sender || jid] || {};
      const list = Object.values(mine);
      if (!list.length) return reply(sock, jid, msg, `🌱 Koi aadat nahi.\n\nShuru karein: *${config.prefix}aadat warzish* 💗`);
      await reply(sock, jid, msg, `🌱 *Aapki Aadatein* 💗\n\n` + list.map(h => {
        const st = habitStreak(h.dates);
        return `*${h.name}* — 🔥 ${st} din streak${st >= 7 ? ' 🏆' : ''}`;
      }).join('\n'));
    },
  },

  antakshari: {
    desc: 'Bot ke saath antakshari 🎶',
    run: async (sock, msg, args, { jid }) => {
      const all = loadAntak();
      if (isStopWord(args[0])) {
        const st = all[jid];
        delete all[jid]; saveAntak(all);
        return reply(sock, jid, msg, `🎶 *Antakshari khatam!* 🎶\n\nAapne *${(st && st.rounds) || 0} round* khele! 🎤\n\nPhir khelein: *${config.prefix}antakshari* 💗`);
      }
      const st = all[jid];
      if (st && st.on) return reply(sock, jid, msg, `🎶 Antakshari pehle se chal rahi hai!\n\n*${st.need.toUpperCase()}* harf se gana gao 🎤\n(Khatam: *${config.prefix}antakshari khatam*)`);
      const mine = ANTAK_SONGS[Math.floor(Math.random() * ANTAK_SONGS.length)];
      all[jid] = { on: true, rounds: 0, need: songEdge(mine, false) };
      saveAntak(all);
      await reply(sock, jid, msg, `🎶 *Antakshari shuru!* 🎶💗\n\n🎤 Mera misra:\n_"${mine}"_\n\nAb aap *${all[jid].need.toUpperCase()}* harf se koi gana gao! 🎤\n_(Khatam karne ke liye: *${config.prefix}antakshari khatam*)_`);
    },
  },

  tilawat: {
    desc: 'Quran tilawat audio 🎧 (.tilawat 2:255)',
    run: async (sock, msg, args, { jid }) => {
      const m = (args[0] || '').trim().match(/^(\d{1,3}):(\d{1,3})$/);
      if (!m) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}tilawat <surah>:<ayat>*\nMasalan: *${config.prefix}tilawat 2:255* (Ayat-ul-Kursi)\n*${config.prefix}tilawat 112:1* 🤲`);
      const sn = +m[1];
      if (sn < 1 || sn > 114) return reply(sock, jid, msg, '❌ Surah 1 se 114 ke darmiyan honi chahiye.');
      const s = String(sn).padStart(3, '0'), a = String(+m[2]).padStart(3, '0');
      const url = `https://everyayah.com/data/Alafasy_128kbps/${s}${a}.mp3`;
      await reply(sock, jid, msg, '🎧 Tilawat la rahi hoon... 💗');
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error('http-' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 10000) throw new Error('short-audio');
        await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg });
        await reply(sock, jid, msg, `🎧 *Surah ${sn}, Ayat ${+m[2]}* — Qari Mishary Alafasy 🤲💗`);
      } catch (e) {
        console.error('[tilawat] fail:', e.message);
        await reply(sock, jid, msg, '❌ Tilawat nahi mil saki — surah:ayat check karke dobara try karein.');
      }
    },
  },

  qibla: {
    desc: 'Qibla direction 🧭 (.qibla <sheher>)',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 80);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}qibla <sheher>*\nMasalan: *${config.prefix}qibla Lahore*`);
      await reply(sock, jid, msg, `🧭 *${q}* se Qibla compass bana rahi hoon... 🎬💗`);
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
          signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'NEXORA-MD/1.0' },
        });
        if (!res.ok) throw new Error('http-' + res.status);
        const arr = await res.json();
        if (!arr.length) throw new Error('notfound');
        const lat1 = parseFloat(arr[0].lat), lon1 = parseFloat(arr[0].lon);
        const la1 = lat1 * Math.PI / 180, la2 = 21.4225 * Math.PI / 180;
        const dL = (39.8262 - lon1) * Math.PI / 180;
        const y = Math.sin(dL);
        const x = Math.cos(la1) * Math.tan(la2) - Math.sin(la1) * Math.cos(dL);
        let deg = Math.atan2(y, x) * 180 / Math.PI;
        deg = ((deg % 360) + 360) % 360;
        const cityName = String(arr[0].display_name).split(',').slice(0, 2).join(',');
        const vidCap = `🧭 *Qibla: ${deg.toFixed(1)}°* 🕋\n\n📍 ${cityName}\n_Sui ghoom kar Qibla ki taraf ruk gayi — namaz mein is rukh par khare hon_ 🤲\n\n💗 _${config.botName}_`;
        let sentMedia = false;
        try { // 🎬 animated compass video
          const t0 = Date.now();
          const { buf, dir } = await qiblaVideo(cityName, deg);
          console.log(`[qibla] video ${(buf.length / 1024).toFixed(0)}KB in ${Date.now() - t0}ms`);
          await sock.sendMessage(jid, { video: buf, caption: vidCap }, { quoted: msg });
          sentMedia = true;
          fs.rmSync(dir, { recursive: true, force: true });
        } catch (vidErr) { console.error('[qibla] video fail:', vidErr.message); }
        if (!sentMedia) try { // static PNG fallback
          const png = await qiblaCompass(cityName, deg);
          await sock.sendMessage(jid, { image: png, caption: vidCap.replace('Sui ghoom kar Qibla ki taraf ruk gayi', 'Sui Qibla ki taraf ishara kar rahi hai') }, { quoted: msg });
        } catch (imgErr) {
          console.error('[qibla] img fail:', imgErr.message);
          await reply(sock, jid, msg, `🧭 *Qibla Direction* 🕋\n\n📍 ${cityName}\n🧭 *${deg.toFixed(1)}°* _(shumaal se mashriq ki taraf, ghari ki sui jaisa)_\n\n🤲 Namaz mein ye rukh ikhtiyar karein 💗`);
        }
      } catch (e) {
        console.error('[qibla] fail:', e.message);
        await reply(sock, jid, msg, e.message === 'notfound' ? `❌ *${q}* nahi mila 💗` : '❌ Qibla nahi nikal saka, thodi der baad try karein.');
      }
    },
  },

  allah: {
    desc: 'Allah ke 99 naam ✨ (.allah <1-99>)',
    run: async (sock, msg, args, { jid }) => {
      const raw = (args[0] || '').trim();
      let n;
      if (!raw) n = 1 + Math.floor(Math.random() * 99);
      else {
        n = parseInt(raw, 10);
        if (!n || n < 1 || n > 99) return reply(sock, jid, msg, `❌ Number 1 se 99 ke darmiyan ho.\nMasalan: *${config.prefix}allah 27* ✨`);
      }
      const [tr, ar, ur] = ALLAH_NAMES[n - 1];
      const aout = `✨ *${n}. ${tr}* (${ar})\n_${ur}_`;
      await sendCard(sock, jid, msg, 'ALLAH KE NAAM', [], {
        hero: ar, sub: `#${n} — ${tr}`, desc: ur, accent: '#ffd166',
      }, aout);
    },
  },

  sauda: {
    desc: 'Dukandaar se mol-bhaav 🛒 (.sauda <cheez> <qeemat>)',
    run: async (sock, msg, args, { jid }) => {
      const all = loadSauda();
      const raw = args.join(' ').trim();
      if (isStopWord(raw)) {
        delete all[jid]; saveSauda(all);
        return reply(sock, jid, msg, '🛒 Sauda khatam! Phir aana, ache daam lagaunga 😄💗');
      }
      const st = all[jid];
      // offer: sirf number + active sauda
      if (st && st.on && /^\d+$/.test(raw)) {
        const offer = parseInt(raw, 10);
        st.rounds = (st.rounds || 0) + 1;
        if (offer >= st.target) {
          delete all[jid]; saveSauda(all);
          return reply(sock, jid, msg, `🎉 *SAUDA PAKKA!* 🎉\n\n🛒 *${st.item}* — *${offer}* mein aapka hua!\n\n_${st.rounds} round mein manaya dukandaar ko 😄_\n\n💗 _${config.botName}_`);
        }
        saveSauda(all);
        if (offer < st.price * 0.5) return reply(sock, jid, msg, `😂 *Arey bhai mazak na karo!* Itne mein to is ki dibbi bhi nahi milegi!\n\n🛒 *${st.item}* (qeemat: ${st.price}) — thoda aur barhao!`);
        if (offer >= st.target * 0.9) return reply(sock, jid, msg, `🔥 *Bohat qareeb ho!* Bas thoda sa aur barhao, de dunga!\n\n🛒 *${st.item}* (qeemat: ${st.price})`);
        const tease = ['😏 Thoda aur barhao, de dunga!', '🤔 Hmm... itne mein nahi hoga bhai. Aur lagao!', '😅 Bas thoda sa aur! Qareeb aa rahe ho!', '🙄 Is daam mein to main khud khareed loon!'];
        return reply(sock, jid, msg, `${tease[Math.floor(Math.random() * tease.length)]}\n\n🛒 *${st.item}* (qeemat: ${st.price}) — bolo aakhri daam?`);
      }
      // naya sauda: aakhri token qeemat
      const toks = raw.split(/\s+/).filter(Boolean);
      const price = parseInt(toks[toks.length - 1], 10);
      const item = toks.slice(0, -1).join(' ').slice(0, 60);
      if (!item || !price || price <= 0) {
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}sauda <cheez> <qeemat>*\nMasalan: *${config.prefix}sauda purana mobile 5000*\n\nPhir sirf apni offer likho: *${config.prefix}sauda 3000*\nKhatam: *${config.prefix}sauda khatam* 🛒`);
      }
      const target = Math.round(price * (0.6 + Math.random() * 0.2));
      all[jid] = { on: true, item, price, target, rounds: 0 };
      saveSauda(all);
      await reply(sock, jid, msg, `🛒 *Dukaan khul gayi!* 😄\n\n📦 Cheez: *${item}*\n💰 Meri qeemat: *${price}*\n\nBolo, kitne doge? (sirf number likho)\nMasalan: *${config.prefix}sauda ${Math.round(price * 0.7)}*`);
    },
  },

  adalat: {
    desc: 'Funny adalat faisla ⚖️ (.adalat <muqadma>)',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 300);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}adalat <muqadma>*\nMasalan: *${config.prefix}adalat dost ne mera khana kha liya* ⚖️`);
      await reply(sock, jid, msg, '⚖️ *Adalat ka faisla aa raha hai...* 👨‍⚖️💗');
      try {
        const ans = await askNexa(`Tum ek MAZAHIYA judge ho. Is muqadme ka funny faisla sunao Roman Urdu mein, 4-5 lines: muqadma: "${q}". Saza bhi funny ho (jaise "mujrim ko 1 hafte tak chai pilani hogi"). Judge wali tone, emojis ke saath.`);
        if (!ans || !ans.trim()) throw new Error('empty');
        await reply(sock, jid, msg, `⚖️ *ADALAT KA FAISLA* ⚖️\n\n${ans.trim().slice(0, 1500)}\n\n😄 _Ye adalat sirf hansi ke liye hai!_ 💗`);
      } catch (e) {
        console.error('[adalat] fail:', e.message);
        await reply(sock, jid, msg, '❌ Judge sahab so rahe hain, thodi der baad try karein 😄');
      }
    },
  },

  interview: {
    desc: 'AI mock interview 🎤 (.interview <field>)',
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ').trim();
      const all = loadInterview();
      if (isStopWord(raw)) {
        const st = all[jid];
        delete all[jid]; saveInterview(all);
        const rounds = (st && st.count) || 0;
        if (!st || !st.on) return reply(sock, jid, msg, '🎤 Koi interview chal hi nahi raha 😄');
        await reply(sock, jid, msg, '🎤 *Interview khatam!* Tajziya bana rahi hoon... 💗');
        try {
          const fb = await askNexa(`Mock interview khatam. Field: "${st.field}". Candidate ne ${rounds} jawab diye. Roman Urdu mein mukhtasir tajziya do: 3 strong points, 2 behtri ki jagah, 1 aakhri mashwara. Kul 8-10 lines.`);
          if (fb && fb.trim()) await reply(sock, jid, msg, `🎤 *Interview Tajziya — ${st.field}* 📝\n\n${fb.trim().slice(0, 1500)}\n\n💗 _${config.botName}_`);
        } catch (e) { console.error('[interview] fb fail:', e.message); }
        return;
      }
      if (!raw) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}interview <field>*\nMasalan: *${config.prefix}interview teacher*\n\nKhatam: *${config.prefix}interview khatam* 🎤`);
      all[jid] = { on: true, field: raw.slice(0, 60), count: 0, last: Date.now() };
      saveInterview(all);
      await reply(sock, jid, msg, `🎤 *Mock Interview shuru — ${raw.slice(0, 60)}* 💗\n\nPehla sawal aa raha hai... jawab seedha likhna (command nahi) 🙂`);
      try {
        const q = await askNexa(`Tum ek professional interviewer ho. Field: "${raw.slice(0, 60)}". Is candidate ka MOCK INTERVIEW lo. Abhi PEHLA sawal pucho — Roman Urdu mein, 2-3 lines. Sirf sawal, koi lambi intro nahi.`);
        if (q && q.trim()) await reply(sock, jid, msg, `🎤 *Sawal 1:*\n\n${q.trim().slice(0, 1200)}`);
      } catch (e) { console.error('[interview] start fail:', e.message); }
    },
  },

  stopall: {
    desc: 'Sab auto-modes ek saath band karo (owner) 🛑',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const stopped = [];
      try {
        const ai = loadInterview();
        if (Object.keys(ai).length) stopped.push(`🎤 interview (${Object.keys(ai).length} chat)`);
        saveInterview({});
      } catch {}
      try {
        const an = loadAntak();
        if (Object.keys(an).length) stopped.push(`🎶 antakshari (${Object.keys(an).length} chat)`);
        saveAntak({});
      } catch {}
      try {
        const n = Object.keys(STATE.aichat || {}).filter(k => STATE.aichat[k] === 'on').length;
        STATE.aichat = {}; saveState();
        if (n) stopped.push(`🤖 aichat (${n} chat)`);
      } catch {}
      await reply(sock, jid, msg, stopped.length
        ? `🛑 *Sab auto-modes band!*\n\n${stopped.join('\n')}\n\nAb koi khud-ba-khud reply nahi ayega 💗`
        : `🛑 Pehle se sab band hai — koi auto-mode on nahi tha 🙂`);
    },
  },

  setlang: {
    desc: 'Bot ki language set karo (owner) 🌍',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      const raw = args.join(' ').trim().slice(0, 40);
      const cur = getSetting('lang', 'Roman Urdu');
      if (!raw) return reply(sock, jid, msg, `🌍 *Bot Language*\n\nMaujooda: *${cur}*\n\nSet karo: *${config.prefix}setlang <language>*\nMasalan: *${config.prefix}setlang english*\n\nMashhoor: Roman Urdu, English, Hindi, Punjabi, Arabic, French, Spanish, German, Turkish\n\n_Koi bhi language likh sakte ho — Nexa ki AI guftagu usi mein hogi 💗_`);
      setSetting('lang', raw);
      await reply(sock, jid, msg, `🌍 *Language set!* Ab Nexa *${raw}* mein baat karegi 💗\n\nCheck karo: *${config.prefix}ai salam*`);
    },
  },

  kahani: {
    desc: 'Chhoti kahani 📖 (.kahani <topic>)',
    run: async (sock, msg, args, { jid }) => {
      const q = args.join(' ').trim().slice(0, 200);
      if (!q) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}kahani <topic>*\nMasalan: *${config.prefix}kahani imaandaar lakadhara* 📖`);
      await reply(sock, jid, msg, '📖 Kahani likh rahi hoon... 💗');
      try {
        const ans = await askNexa(`"${q}" par ek chhoti dilchasp kahani likho Roman Urdu mein, 150-250 alfaz. Kahani mein koi sabaq (moral) ho. Sirf kahani, koi intro/outro nahi.`);
        if (!ans || !ans.trim()) throw new Error('empty');
        await reply(sock, jid, msg, `📖 *${q.slice(0, 60)}*\n\n${ans.trim().slice(0, 2000)}\n\n💗 _${config.botName}_`);
      } catch (e) {
        console.error('[kahani] fail:', e.message);
        await reply(sock, jid, msg, '❌ Kahani nahi ban saki, thodi der baad try karein.');
      }
    },
  },

  trip: {
    desc: 'Safar plan ✈️ (.trip <jagah> <din>)',
    run: async (sock, msg, args, { jid }) => {
      const toks = args.map(t => t.trim()).filter(Boolean);
      const days = parseInt(toks[toks.length - 1], 10);
      const place = toks.slice(0, -1).join(' ').slice(0, 60);
      if (!place || !days || days < 1 || days > 30) {
        return reply(sock, jid, msg, `❌ Usage: *${config.prefix}trip <jagah> <din>*\nMasalan: *${config.prefix}trip naran 3* ✈️`);
      }
      await reply(sock, jid, msg, `✈️ *${place}* ka ${days}-din ka plan bana rahi hoon... 💗`);
      try {
        const ans = await askNexa(`"${place}" ke ${days} din ke safar ka plan banao Roman Urdu mein: har din ka program (subah/dopehar/shaam), khanay ki mashhoor jagah, aur aakhir mein 2-3 kaam ke mashware. Mukhtasir aur practical, kul 15-20 lines.`);
        if (!ans || !ans.trim()) throw new Error('empty');
        await reply(sock, jid, msg, `✈️ *Trip Plan — ${place} (${days} din)* 🗺️\n\n${ans.trim().slice(0, 2200)}\n\n💗 _${config.botName}_`);
      } catch (e) {
        console.error('[trip] fail:', e.message);
        await reply(sock, jid, msg, '❌ Plan nahi ban saka, thodi der baad try karein.');
      }
    },
  },

  sorry: {
    desc: 'Maafi-nama 🥺 (.sorry <naam> <wajah>)',
    run: async (sock, msg, args, { jid }) => {
      const toks = args.map(t => t.trim()).filter(Boolean);
      if (toks.length < 2) return reply(sock, jid, msg, `❌ Usage: *${config.prefix}sorry <naam> <wajah>*\nMasalan: *${config.prefix}sorry Ali tumhara khana kha liya* 🥺`);
      const name = toks[0].slice(0, 40);
      const reason = toks.slice(1).join(' ').slice(0, 200);
      await reply(sock, jid, msg, '🥺 Maafi-nama likh rahi hoon... 💗');
      try {
        const ans = await askNexa(`"${name}" ke liye ek heartfelt maafi-nama (sorry message) likho Roman Urdu mein. Wajah: "${reason}". Jazbaati, sachche dil se, naam shamil ho. 5-7 lines. Sirf message, koi intro nahi.`);
        if (!ans || !ans.trim()) throw new Error('empty');
        await reply(sock, jid, msg, `🥺 *${name} ke liye maafi-nama* 💌\n\n${ans.trim().slice(0, 1500)}\n\n💗 _${config.botName}_`);
      } catch (e) {
        console.error('[sorry] fail:', e.message);
        await reply(sock, jid, msg, '❌ Maafi-nama nahi ban saka, thodi der baad try karein.');
      }
    },
  },
});

// ─── 💬 mentionme hook: group mein bot mention → AI jawab ───
function isBotMentioned(sock, msg) {
  try {
    const ci = getContextInfo(msg);
    const mentioned = (ci && ci.mentionedJid) || [];
    const botNum = num(sock.user?.id || '');
    if (!botNum || botNum.length < 7) return false;
    return mentioned.some((m) => num(m).slice(-10) === botNum.slice(-10));
  } catch { return false; }
}
async function mentionMeHook(sock, msg, sender, jid) {
  try {
    if (!getSetting('mentionme')) return false;
    if (!jid.endsWith('@g.us')) return false;
    if (msg.key.fromMe) return false;
    if (isOwnMsgId(msg.key?.id)) return false;
    if (!isBotMentioned(sock, msg)) return false;
    const text = (getText(msg) || '').replace(/@\d+/g, '').trim();
    if (!text || text.startsWith(config.prefix)) return false;
    if (typeof aiModeFor === 'function' && aiModeFor(jid) === 'on') return false; // autoAI khud jawab dega
    if (typeof aiModeFor === 'function' && aiModeFor(jid) === 'off') return false; // ⛔ aichat off = mention par bhi khamoshi
    if (aiReplyClaimed(msg.key?.id)) return true;
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const ans = await askBossChat(text, []);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});
    if (!ans) { aiReplyUnclaim(msg.key?.id); return true; }
    await reply(sock, jid, msg, ans, { nosig: true }); // mention hook chat — signature nahi
    return true;
  } catch { return true; }
}

// ─── ❤️ statuslike hook (handleStatusBroadcast mein lagana hai) ───
async function statusLikeHook(sock, m) {
  try {
    if (!getSetting('statuslike')) return;
    if (!m?.key || m.key.fromMe) return;
    await sock.sendMessage('status@broadcast', { react: { text: '❤️', key: m.key } }).catch(() => {});
  } catch {}
}

// ─── 🔊 SOUND BOARD (.sound1 … .sound16) ───
const SOUND_DIR = path.join(__dirname, '..', 'assets', 'sounds');
const SOUND_NAMES = {
  1: '📯 Airhorn', 2: '😐 Bruh', 3: '💥 Vine Boom', 4: '🎺 Sad Trombone',
  5: '🥁 Rimshot', 6: '🌀 Boing', 7: '👏 Applause', 8: '😂 Laugh Track',
  9: '💨 Fart', 10: '🚨 Wrong Buzzer', 11: '🔔 Taco Bell Ding', 12: '🎵 Record Scratch',
  13: '🦗 Crickets', 14: '🚔 FBI Open Up', 15: '🔧 Metal Pipe', 16: '⚖️ Dun-Dun',
};
async function sendSound(sock, jid, msg, n) {
  const f = path.join(SOUND_DIR, `s${n}.mp3`);
  try {
    if (!fs.existsSync(f)) throw new Error('missing');
    const buf = fs.readFileSync(f);
    if (buf.length < 1000) throw new Error('bad');
    await sock.sendMessage(jid, { audio: buf, mimetype: 'audio/mpeg', ptt: false, fileName: `sound${n}.mp3` }, { quoted: msg });
    await reply(sock, jid, msg, `🔊 *${SOUND_NAMES[n]}* — ${config.botName} 💗`);
  } catch {
    await reply(sock, jid, msg, '❌ Sound file nahi mili.');
  }
}
const _soundCmds = {};
_soundCmds.sound = {
  desc: 'Random funny sound 🔊 (ya .sound1-16)',
  run: async (sock, msg, args, { jid }) => {
    const arg = (args[0] || '').toLowerCase().trim();
    if (arg === 'list') {
      return reply(sock, jid, msg,
        `🔊 *Sound Board* — ${config.botName} 💗\n\n` +
        Object.entries(SOUND_NAMES).map(([n, nm]) => `• *${config.prefix}sound${n}* — ${nm}`).join('\n') +
        `\n\n💡 *${config.prefix}sound* = random sound`);
    }
    const n = Math.floor(Math.random() * 16) + 1;
    await sendSound(sock, jid, msg, n);
  },
};
for (let i = 1; i <= 16; i++) {
  _soundCmds['sound' + i] = {
    desc: `Funny sound: ${SOUND_NAMES[i]}`,
    run: async (sock, msg, args, { jid }) => sendSound(sock, jid, msg, i),
  };
}
Object.assign(commands, _soundCmds);

// ─── 📺 DRAMA: Pakistani drama episode finder (YouTube official uploads) ───
// Download nahi — full episode 500MB+ hota hai (WhatsApp limit 64MB).
// yt-dlp search se official full-episode link resolve karke bhejo;
// WhatsApp link ko thumbnail preview card ke saath unfurl karta hai.
const _dramaCmds = {};
_dramaCmds.drama = {
  desc: 'Pakistani drama ka full episode dhoondo 📺',
  run: async (sock, msg, args, { jid }) => {
    const raw = (args || []).join(' ').trim();
    if (!raw) return reply(sock, jid, msg, `📺 Usage: *${config.prefix}drama <drama ka naam> ep <number>*\nMasalan: *${config.prefix}drama kabhi main kabhi tum ep 4*`);
    const epM = raw.match(/\bep(?:isode)?\s*0*(\d{1,3})\b/i);
    const ep = epM ? parseInt(epM[1], 10) : null;
    let name = raw.replace(/\bep(?:isode)?\s*0*\d{1,3}\b/i, '').trim();
    if (!name) return reply(sock, jid, msg, `📺 Drama ka naam bhi likhein.\nMasalan: *${config.prefix}drama kabhi main kabhi tum ep 4*`);
    await reply(sock, jid, msg, wline(['📺 Drama dhoond rahi hoon... 💗', '🎭 Aapka drama talash kar rahi hoon... ✨', '📺 Channel badal badal kar dhoondh rahi hoon... 💫']));
    // typo sudharo (masalan "roposh" → "ruposh") — Google suggest, bina key
    let corrected = '';
    try {
      const sr = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&q=' + encodeURIComponent(name), {
        signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const sj = await sr.json();
      const top = Array.isArray(sj) && Array.isArray(sj[1]) && sj[1][0] ? String(sj[1][0]) : '';
      if (top && top.toLowerCase() !== name.toLowerCase()) { corrected = top; name = top; }
    } catch (e) {}
    const { execFile } = require('child_process');
    const query = ep ? `${name} episode ${ep} full episode` : `${name} latest full episode`;
    const runSearch = () => new Promise((resolve) => {
      // ytvenv wala yt-dlp + chrome impersonation + mediaconnect (bina is ke
      // YouTube "sign in to confirm you're not a bot" error deta hai)
      execFile('/home/hatch/workspace/ytvenv/bin/yt-dlp',
        ['--impersonate', 'chrome', '--extractor-args', 'youtube:player_client=mediaconnect',
         '--no-playlist', '--no-warnings', '--socket-timeout', '20',
         '--print', '%(id)s\t%(title)s\t%(duration)s\t%(uploader)s',
         `ytsearch8:${query}`],
        { timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
    let out = '';
    for (let attempt = 0; attempt < 2 && !out.trim(); attempt++) {
      out = await runSearch();
      if (!out.trim() && attempt === 0) await new Promise((r) => setTimeout(r, 3000));
    }
    const vids = out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [id, title, dur, uploader] = l.split('\t');
      return { id: (id || '').trim(), title: (title || '').trim(), dur: parseInt(dur, 10) || 0, uploader: (uploader || '').trim() };
    }).filter((v) => v.id && /^[A-Za-z0-9_-]{6,}$/.test(v.id));
    if (!vids.length) return reply(sock, jid, msg, '❌ Drama nahi mila. Naam check karke dobara try karein 💗');
    const OFFICIAL = [/hum\s*tv/i, /ary\s*digital/i, /har\s*pal\s*geo/i, /geo\s*tv/i, /green\s*tv/i];
    const isOfficial = (v) => OFFICIAL.some((re) => re.test(v.uploader || '') || re.test(v.title || ''));
    const epRe = ep ? new RegExp(`\\bep(?:isode)?\\s*0*${ep}\\b`, 'i') : null;
    // NAAM MATCH lazmi — warna kisi aur drama ka episode uth ata hai (masalan "ruposh" par "Jhoom")
    const nameWords = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const nameHit = (v) => {
      const t = (v.title || '').toLowerCase();
      return !nameWords.length || nameWords.every((w) => t.includes(w));
    };
    const named = vids.filter(nameHit);
    if (!named.length) {
      const alts = vids.slice(0, 3).map((v) => `• ${v.title.slice(0, 60)}`).join('\n');
      return reply(sock, jid, msg, `❌ *${name}* ka episode nahi mila — naam check karein.\n\nQareeb tareen results:\n${alts}`);
    }
    // 1) official + naam + episode match + lambi duration (full episode)
    let pick = named.find((v) => v.dur >= 1200 && isOfficial(v) && (!epRe || epRe.test(v.title)));
    // 2) naam + lambi video + episode match
    if (!pick) pick = named.find((v) => v.dur >= 1200 && (!epRe || epRe.test(v.title)));
    // 3) naam + official lambi video (episode match na bhi ho — telefilm waghera)
    if (!pick) pick = named.find((v) => v.dur >= 1200 && isOfficial(v));
    // 4) naam wali sab se lambi video (fallback)
    if (!pick) pick = named.slice().sort((a, b) => b.dur - a.dur)[0];
    const mins = pick.dur ? `${Math.floor(pick.dur / 60)} min` : 'NA';
    const link = `https://www.youtube.com/watch?v=${pick.id}`;
    const exact = epRe ? epRe.test(pick.title) : true;
    const dramaLabel = `${name}${ep ? ` — Episode ${ep}` : ''}`;
    // Link fallback (download fail / file bohat bari ho to)
    const linkReply = () =>
      `📺 *${dramaLabel}*\n` +
      (corrected ? `_Aapka matlab *${corrected}* tha?_ 😉\n` : '') + `\n` +
      `🎬 ${pick.title.slice(0, 80)}\n` +
      `⏱ ${mins} · 📡 ${pick.uploader || 'YouTube'}\n` +
      `▶️ ${link}\n` +
      (exact ? '' : `\n⚠️ _Exact episode confirm nahi — ye closest full episode hai._`) +
      `\n\n_Link par tap karein — YouTube app mein HD mein dekhein_ 💗`;
    // ── 📥 VIDEO DOWNLOAD + DOCUMENT SEND (360p) ──
    const LOCK = '/tmp/.drama_dl.lock';
    try {
      const st = fs.statSync(LOCK);
      if (Date.now() - st.mtimeMs > 60 * 60 * 1000) { try { fs.unlinkSync(LOCK); } catch {} } // stale lock
    } catch {}
    if (fs.existsSync(LOCK)) {
      return reply(sock, jid, msg, `⏳ Ek episode pehle se download ho rahi hai, thoda wait karein... 💗`);
    }
    fs.writeFileSync(LOCK, String(process.pid));
    const vid = pick.id.replace(/[^A-Za-z0-9_-]/g, '');
    // NOTE: /tmp sirf 512MB tmpfs hai — bari files bot dir ke scratch mein
    const DLDIR = path.join(__dirname, '..', '.drama-dl');
    try { fs.mkdirSync(DLDIR, { recursive: true }); } catch {}
    const outTmpl = path.join(DLDIR, `drama_${vid}.%(ext)s`);
    // Quality: HD (720p) default — agar ~1GB se bari ho to 360p (Boss ka hukm)
    let q = '360p', qh = 360;
    try {
      const probe = await new Promise((resolve) => {
        execFile('/home/hatch/workspace/ytvenv/bin/yt-dlp',
          ['--impersonate', 'chrome', '--extractor-args', 'youtube:player_client=mediaconnect',
           '--no-playlist', '--no-warnings', '--skip-download',
           '--print', '%(filesize_approx)s',
           '-f', 'bv*[height<=720]+ba/b[height<=720]/b',
           `https://www.youtube.com/watch?v=${vid}`],
          { timeout: 60000, maxBuffer: 1024 * 1024 },
          (err, stdout) => resolve(err ? '' : String(stdout || '').trim()));
      });
      const approx = parseInt(probe, 10);
      if (approx && approx <= 1024 * 1024 * 1024) { q = '720p HD'; qh = 720; }
    } catch {}
    await reply(sock, jid, msg, `📥 *${dramaLabel}* download kar rahi hoon (${q})... ⏳\nBari file hai, 10-30 min lag sakte hain — milte hi bhej dungi 💗`);
    const runDl = (client, height) => new Promise((resolve) => {
      execFile('/home/hatch/workspace/ytvenv/bin/yt-dlp',
        ['--impersonate', 'chrome', '--extractor-args', `youtube:player_client=${client}`,
         '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '30',
         '--throttled-rate', '3M',
         '-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b`, '--merge-output-format', 'mp4',
         '--no-playlist', '--no-warnings', '-o', outTmpl,
         `https://www.youtube.com/watch?v=${vid}`],
        { timeout: 45 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
        (err) => resolve(!err));
    });
    const wipeDlFiles = () => {
      try {
        for (const f of fs.readdirSync(DLDIR)) {
          if (f.startsWith(`drama_${vid}.`)) { try { fs.unlinkSync(path.join(DLDIR, f)); } catch {} }
        }
      } catch {}
    };
    const cleanupDl = () => { wipeDlFiles(); try { fs.unlinkSync(LOCK); } catch {} };
    const findDlFile = () => {
      try {
        for (const f of fs.readdirSync(DLDIR)) {
          if (f.startsWith(`drama_${vid}.`) && !f.endsWith('.part') && /\.(mp4|mkv|webm)$/i.test(f)) return path.join(DLDIR, f);
        }
      } catch {}
      return null;
    };
    const downloadQuality = async (height) => {
      wipeDlFiles();
      for (const client of ['mediaconnect', 'android']) {
        if (await runDl(client, height)) { const f = findDlFile(); if (f) return f; }
      }
      return findDlFile();
    };
    const MAXSZ = 1536 * 1024 * 1024;
    try {
      let file = await downloadQuality(qh);
      let finalQ = q;
      if (!file) throw new Error('download-failed');
      if (qh === 720 && fs.statSync(file).size > MAXSZ) {
        wipeDlFiles();
        await reply(sock, jid, msg, `📉 _HD file bohat bari thi, 360p mein dobara download kar rahi hoon..._ ⏳`);
        file = await downloadQuality(360);
        finalQ = '360p';
        if (!file) throw new Error('download-failed');
      }
      const size = fs.statSync(file).size;
      if (size > MAXSZ) {
        cleanupDl();
        return reply(sock, jid, msg, `⚠️ _File bohat bari thi (${Math.round(size / 1048576)}MB), is liye link de rahi hoon_ 💗\n\n${linkReply()}`);
      }
      const safeName = `${name.replace(/[^\w\s-]/g, '').trim().slice(0, 30) || 'drama'}${ep ? ` EP${ep}` : ''} (${finalQ}).mp4`;
      // video jaisi thumbnail — document par poster frame lage (WhatsApp video msg limit 16MB hai, is liye file hi jayegi)
      let thumb = null;
      try {
        const thumbPath = path.join(DLDIR, `drama_${vid}.thumb.jpg`);
        await new Promise((resolve) => {
          execFile('ffmpeg', ['-y', '-ss', '30', '-i', file, '-vframes', '1', '-q:v', '4', thumbPath],
            { timeout: 60000 }, () => resolve());
        });
        if (fs.existsSync(thumbPath)) thumb = fs.readFileSync(thumbPath);
      } catch {}
      await sock.sendMessage(jid, {
        document: { url: file },
        fileName: safeName,
        mimetype: 'video/mp4',
        ...(thumb ? { jpegThumbnail: thumb } : {}),
        caption: `📺 *${pick.title.slice(0, 80)}*\n${finalQ} • ${mins} 💗\n— Nexa 💗`,
      });
      cleanupDl();
    } catch (e) {
      cleanupDl();
      await reply(sock, jid, msg, `⚠️ _Video download nahi ho saki, is liye link de rahi hoon_ 💗\n\n${linkReply()}`);
    }
  },
};
Object.assign(commands, _dramaCmds);

// ─── 📱 ZIP2APK: website ZIP → installable APK ───
// ─── 📱 ZIP2APK wizard — website ZIP → APK (naam + icon pooch kar) ───
const zip2apkSessions = new Map(); // sender -> { step, workdir, siteRoot, appName, iconDir, ts }
const ZIP2APK_TIMEOUT = 5 * 60 * 1000;

function zip2apkSweep() {
  const now = Date.now();
  for (const [k, s] of zip2apkSessions) {
    if (now - s.ts > ZIP2APK_TIMEOUT) {
      try { fs.rmSync(s.workdir, { recursive: true, force: true }); } catch {}
      zip2apkSessions.delete(k);
    }
  }
}

// ZIP download + validate + extract + index.html (recursive) — build se pehle ka kaam
// website ZIP validate + extract (zip2apk aur zip2host dono ke liye)
async function unzipWebsite(sock, msg, doc, tmpPrefix) {
  const q = ctxOf(msg)?.quotedMessage;
  const buf = await downloadMediaMessage(
    { key: msg.key, message: q ? { documentMessage: doc } : msg.message }, 'buffer', {});
  if (!buf || !buf.length) throw new Error('ZIP download nahi ho saki — dobara bhejein.');
  if (buf.length > 50 * 1024 * 1024) throw new Error('ZIP 50MB se bari hai — chhoti file bhejein.');
  if (buf[0] !== 0x50 || buf[1] !== 0x4B) throw new Error('Ye asal ZIP file nahi lag rahi.');
  const workdir = fs.mkdtempSync('/tmp/' + tmpPrefix);
  try {
    const zipPath = path.join(workdir, 'site.zip');
    fs.writeFileSync(zipPath, buf);
    const list = await new Promise((resolve, reject) => {
      execFile('/usr/bin/unzip', ['-Z1', zipPath], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => err ? reject(err) : resolve(String(stdout).split('\n').map((s) => s.trim()).filter(Boolean)));
    });
    if (!list.length) throw new Error('ZIP khaali hai.');
    if (list.length > 2000) throw new Error('ZIP mein bohat zyada files hain (2000+).');
    for (const e of list) {
      if (e.startsWith('/') || e.startsWith('\\') || e.includes('\\') || /(^|\/)\.\.(\/|$)/.test(e))
        throw new Error('ZIP mein ghalat paths hain.');
    }
    const siteDir = path.join(workdir, 'site');
    fs.mkdirSync(siteDir);
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/unzip', ['-q', zipPath, '-d', siteDir], { timeout: 60000 },
        (err) => err ? reject(err) : resolve());
    });
    const findIndex = (dir, depth) => {
      if (depth > 4) return null;
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { return null; }
      if (entries.find((f) => /^index\.html?$/i.test(f))) return dir;
      const dirs = entries.filter((f) => {
        if (f.startsWith('.')) return false;
        try { return fs.statSync(path.join(dir, f)).isDirectory(); } catch { return false; }
      }).sort();
      for (const d of dirs) {
        const hit = findIndex(path.join(dir, d), depth + 1);
        if (hit) return hit;
      }
      return null;
    };
    const root = findIndex(siteDir, 0);
    if (!root) {
      const top = fs.readdirSync(siteDir).slice(0, 12).map((f) => `• ${f}`).join('\n');
      throw new Error(`ZIP mein index.html nahi mili.\n\nZIP ke andar ye hai:\n${top}\n\n_index.html wali website ZIP karke bhejein_`);
    }
    const fn = String(doc.fileName || '').replace(/\.zip$/i, '');
    const defaultName = fn.replace(/[^\w\s-]/g, '').trim().slice(0, 20) || 'MyApp';
    return { workdir, siteRoot: root, defaultName };
  } catch (e) {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

// icon image → mipmap-* PNGs (saare screen sizes ke liye)
async function zip2apkMakeIcons(workdir, imgBuf) {
  const iconDir = path.join(workdir, 'iconres');
  const sizes = { 'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96, 'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192 };
  for (const [d, sz] of Object.entries(sizes)) {
    const out = path.join(iconDir, d);
    fs.mkdirSync(out, { recursive: true });
    await sharp(imgBuf).resize(sz, sz, { fit: 'cover' }).png().toFile(path.join(out, 'ic_launcher.png'));
  }
  return iconDir;
}

// asal build + send (lock ka wait bhi karta hai)
async function zip2apkBuild(sock, jid, refMsg, sess) {
  const LOCK = '/tmp/.zip2apk.lock';
  const cleanup = () => {
    try { fs.rmSync(sess.workdir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(LOCK); } catch {}
  };
  try {
    const t0 = Date.now();
    let waited = false;
    while (fs.existsSync(LOCK)) {
      try {
        const st = fs.statSync(LOCK);
        if (Date.now() - st.mtimeMs > 20 * 60 * 1000) { try { fs.unlinkSync(LOCK); } catch {} break; }
      } catch { break; }
      if (!waited) { await reply(sock, jid, refMsg, `⏳ Ek APK pehle se ban rahi hai — line mein laga diya... 💗`); waited = true; }
      if (Date.now() - t0 > 5 * 60 * 1000) throw new Error('Bohat der se line mein hoon — thodi der baad dobara try karein.');
      await new Promise((r) => setTimeout(r, 10000));
    }
    fs.writeFileSync(LOCK, String(process.pid));
    const appName = sess.appName;
    const hash = crypto.createHash('md5').update(appName + Date.now()).digest('hex').slice(0, 6);
    const pkg = `com.nexora.zip2apk.a${hash}`; // a-prefix: aakhri segment hamesha letter se shuru (digit-start Android mein invalid hai)
    const apkFile = `${appName.replace(/\s+/g, '') || 'app'}.apk`;
    const outApk = path.join(sess.workdir, apkFile);
    await reply(sock, jid, refMsg, `🔨 *${appName}* build ho rahi hai... ⏳`);
    await new Promise((resolve, reject) => {
      execFile('/bin/bash', ['/home/hatch/workspace/zip2apk/build.sh', sess.siteRoot, appName, pkg, outApk, sess.iconDir || ''],
        { timeout: 10 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => err ? reject(new Error('Build fail: ' + String(stderr || err.message).slice(-200))) : resolve());
    });
    if (!fs.existsSync(outApk)) throw new Error('Build fail ho gayi.');
    const apkBuf = fs.readFileSync(outApk);
    await sock.sendMessage(jid, {
      document: apkBuf,
      fileName: apkFile,
      mimetype: 'application/vnd.android.package-archive',
      caption: `📱 *${appName}* tayyar hai! Install karke kholo 💗\n— Nexa 💗`,
    });
    cleanup();
  } catch (e) {
    cleanup();
    await reply(sock, jid, refMsg, `❌ ${e.message || 'APK nahi ban saki.'}`);
  }
}

// icon image nikalo — is msg ki image, ya quoted image (image document bhi)
async function zip2apkTakeIcon(sock, msg, sess) {
  const q = ctxOf(msg)?.quotedMessage;
  let wrap = null;
  if (msg.message?.imageMessage) wrap = { imageMessage: msg.message.imageMessage };
  else if (msg.message?.documentMessage && /^image\//i.test(msg.message.documentMessage.mimetype || ''))
    wrap = { documentMessage: msg.message.documentMessage };
  else if (q?.imageMessage) wrap = { imageMessage: q.imageMessage };
  else if (q?.documentMessage && /^image\//i.test(q.documentMessage.mimetype || ''))
    wrap = { documentMessage: q.documentMessage };
  if (!wrap) throw new Error('img nahi mili');
  const ibuf = await downloadMediaMessage({ key: msg.key, message: wrap }, 'buffer', {});
  if (!ibuf || !ibuf.length) throw new Error('img download nahi hui');
  sess.iconDir = await zip2apkMakeIcons(sess.workdir, ibuf);
  return true;
}

// wizard hook — naam/icon ke jawab yahan pakre jate hain (handleMessage se call hota hai)
async function zip2apkHook(sock, msg, sender, jid) {
  if (isOwnMsgId(msg.key?.id)) return false; // bot ke apne reply ka echo — loop protection
  zip2apkSweep();
  const sess = zip2apkSessions.get(sender);
  if (!sess) return false;
  sess.n = (sess.n || 0) + 1; // safety cap — kahin loop phans jaye to session khatam
  if (sess.n > 12) {
    try { fs.rmSync(sess.workdir, { recursive: true, force: true }); } catch {}
    zip2apkSessions.delete(sender);
    await reply(sock, jid, msg, `⚠️ Session khatam ho gayi — dobara *${config.prefix}zip2apk* se shuru karein.`);
    return true;
  }
  const text = (getText(msg) || '').trim();
  const img = msg.message?.imageMessage;
  const doc = msg.message?.documentMessage;
  const isImgDoc = !!(doc && /^image\//i.test(doc.mimetype || ''));
  if (text.startsWith(config.prefix)) { // naya command → wizard cancel, normal flow chalne do
    try { fs.rmSync(sess.workdir, { recursive: true, force: true }); } catch {}
    zip2apkSessions.delete(sender);
    return false;
  }
  if (sess.step === 'name') {
    if (img || isImgDoc) { // naam ki jagah image bhej di → default naam + ye icon
      try { await zip2apkTakeIcon(sock, msg, sess); await reply(sock, jid, msg, `🖼️ Icon mil gayi! Naam default rakha: *${sess.appName}* ✅`); }
      catch { sess.iconDir = null; }
      zip2apkSessions.delete(sender);
      await zip2apkBuild(sock, jid, msg, sess);
      return true;
    }
    let nm = text.replace(/[^\w\s-]/g, '').trim().slice(0, 20);
    if (!nm) nm = sess.appName;
    sess.appName = nm; sess.step = 'icon'; sess.ts = Date.now();
    await reply(sock, jid, msg, `📝 Naam: *${nm}* ✅\n\n🖼️ Ab icon ke liye apni *image* bhejo\nya _skip_ likho (default icon lagega)`);
    return true;
  }
  if (sess.step === 'icon') {
    if (img || isImgDoc) {
      try { await zip2apkTakeIcon(sock, msg, sess); await reply(sock, jid, msg, `🖼️ Icon lag gayi! ✅`); }
      catch { sess.iconDir = null; await reply(sock, jid, msg, `⚠️ Image samajh nahi aayi — default icon lagega.`); }
      zip2apkSessions.delete(sender);
      await zip2apkBuild(sock, jid, msg, sess);
      return true;
    }
    if (/^skip$/i.test(text)) {
      zip2apkSessions.delete(sender);
      await zip2apkBuild(sock, jid, msg, sess);
      return true;
    }
    const nm = text.replace(/[^\w\s-]/g, '').trim().slice(0, 20);
    if (nm) { // text aaya → naam samjho, dobara icon poocho
      sess.appName = nm; sess.ts = Date.now();
      await reply(sock, jid, msg, `📝 Naam badal diya: *${nm}* ✅\n\n🖼️ Ab icon ki image bhejo ya _skip_ likho`);
      return true;
    }
    await reply(sock, jid, msg, `🖼️ Icon ke liye *image* bhejo ya _skip_ likho 💗`);
    return true;
  }
  return false;
}
// ─── 🌐 ZIP2HOST — naam wizard (user apni marzi ka naam rakhe) ───
const zip2hostSessions = new Map(); // sender -> { workdir, siteRoot, defaultName, ts, n }

function zip2hostSweep() {
  const now = Date.now();
  for (const [k, s] of zip2hostSessions) {
    if (now - s.ts > ZIP2APK_TIMEOUT) { // 5 min — zip2apk wala hi timeout
      try { fs.rmSync(s.workdir, { recursive: true, force: true }); } catch {}
      zip2hostSessions.delete(k);
    }
  }
}

// surge subdomain sanitize: lowercase, sirf a-z0-9-, aagay/peeche - nahi, max 30 chars
function surgeName(raw, fallback) {
  let nm = String(raw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  if (!nm) nm = String(fallback || 'site');
  return nm;
}

async function zip2hostPublish(sock, jid, refMsg, sess, wantName) {
  const name = surgeName(wantName, sess.defaultName);
  // 2026-09-23: bot ka DEDICATED surge account (~/workspace/.surge-bot-home/.netrc);
  // ~/.netrc mein account #2 hai — is liye HOME override zaroori hai.
  const BOT_HOME = `${process.env.HOME}/workspace/.surge-bot-home`;
  const surgeEnv = { ...process.env, PATH: `${process.env.HOME}/workspace/npm-global/bin:${process.env.PATH}`, HOME: BOT_HOME };
  // pehle pasand ka naam, phir taken hua to 2 random fallback
  const candidates = [`${name}.surge.sh`];
  for (let i = 0; i < 2; i++) candidates.push(`${name}-${crypto.randomBytes(2).toString('hex')}.surge.sh`);
  let url = null, lastErr = '';
  for (const domain of candidates) {
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('surge', [sess.siteRoot, domain], { timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: surgeEnv },
          (err, stdout, stderr) => {
            const txt = String(stdout || '') + String(stderr || '');
            if (err) return reject(new Error(txt.trim().slice(0, 300) || String(err).slice(0, 300)));
            if (!/success/i.test(txt)) return reject(new Error(txt.trim().slice(0, 300) || 'publish failed'));
            resolve(txt);
          });
      });
      void out;
      url = `https://${domain}`;
      break;
    } catch (e) { lastErr = e.message || String(e); }
  }
  try { fs.rmSync(sess.workdir, { recursive: true, force: true }); } catch {}
  if (!url) return reply(sock, jid, refMsg, `❌ Host nahi ho saki.\n${lastErr}`);
  const takenNote = url === `https://${name}.surge.sh` ? '' : `\n_(pasand ka naam taken tha, ye wala mil gaya)_`;
  return reply(sock, jid, refMsg, `🌐 Website *live* ho gayi! 🎉\n\n🔗 ${url}${takenNote}\n\nKisi ko bhi bhejo — browser mein khul jayegi 💗`);
}

// wizard hook — site ke naam ka jawab yahan pakra jata hai (handleMessage se call hota hai)
async function zip2hostHook(sock, msg, sender, jid) {
  if (isOwnMsgId(msg.key?.id)) return false; // bot ke apne reply ka echo — loop protection
  zip2hostSweep();
  const sess = zip2hostSessions.get(sender);
  if (!sess) return false;
  sess.n = (sess.n || 0) + 1; // safety cap — kahin loop phans jaye to session khatam
  if (sess.n > 12) {
    try { fs.rmSync(sess.workdir, { recursive: true, force: true }); } catch {}
    zip2hostSessions.delete(sender);
    await reply(sock, jid, msg, `⚠️ Session khatam ho gayi — dobara *${config.prefix}zip2host* se shuru karein.`);
    return true;
  }
  const text = (getText(msg) || '').trim();
  if (text.startsWith(config.prefix)) { // naya command → wizard cancel, normal flow chalne do
    try { fs.rmSync(sess.workdir, { recursive: true, force: true }); } catch {}
    zip2hostSessions.delete(sender);
    return false;
  }
  if (!text) { // khaali msg (sticker waghera) → dobara poocho
    await reply(sock, jid, msg, `🌐 Site ka *naam* likh kar bhejo ya _skip_ likho_\n_(default: *${sess.defaultName}*)_`);
    return true;
  }
  const wantName = /^skip$/i.test(text) ? sess.defaultName : text;
  zip2hostSessions.delete(sender);
  await reply(sock, jid, msg, `🌐 *${surgeName(wantName, sess.defaultName)}* host ho rahi hai... ⏳`);
  await zip2hostPublish(sock, jid, msg, sess, wantName);
  return true;
}

const _zip2apkCmds = {};
_zip2apkCmds.zip2apk = {
  desc: 'ZIP website → APK 📱 (naam + icon pooch kar)',
  run: async (sock, msg, args, { jid }) => {
    const sender = msg.key.fromMe ? (sock.user?.id || jid) : (msg.key.participant || jid);
    zip2apkSweep();
    const pend = zip2apkSessions.get(sender);
    const q = ctxOf(msg)?.quotedMessage;
    const rawDoc = (q && q.documentMessage) || msg.message?.documentMessage;
    const docIsImage = !!(rawDoc && /^image\//i.test(rawDoc.mimetype || ''));
    const doc = rawDoc && !docIsImage ? rawDoc : null; // ZIP candidate (image nahi)
    const hasImage = !!(msg.message?.imageMessage || docIsImage || q?.imageMessage);

    // wizard chal rahi ho aur image command ke saath aayi ho → icon lagao, build karo
    if (pend && !doc && hasImage) {
      try {
        await zip2apkTakeIcon(sock, msg, pend);
        await reply(sock, jid, msg, pend.step === 'name'
          ? `🖼️ Icon mil gayi! Naam default rakha: *${pend.appName}* ✅`
          : `🖼️ Icon lag gayi! ✅`);
      } catch { pend.iconDir = null; await reply(sock, jid, msg, `⚠️ Image samajh nahi aayi — default icon lagega.`); }
      zip2apkSessions.delete(sender);
      await zip2apkBuild(sock, jid, msg, pend);
      return;
    }

    if (!doc) {
      if (pend && pend.step === 'name')
        return reply(sock, jid, msg, `📱 App ka *naam* likh kar bhejo ya _skip_ likho_\n_(default: *${pend.appName}*)_`);
      if (pend && pend.step === 'icon')
        return reply(sock, jid, msg, `🖼️ Icon ke liye *image* bhejo ya _skip_ likho_\n_(naam: *${pend.appName}*)_`);
      return reply(sock, jid, msg, `❌ ZIP file ke saath caption *${config.prefix}zip2apk* likhein,\nya kisi ZIP ke reply mein *${config.prefix}zip2apk* likhein.`);
    }
    if (pend) { try { fs.rmSync(pend.workdir, { recursive: true, force: true }); } catch {} zip2apkSessions.delete(sender); }
    let prep;
    try {
      await reply(sock, jid, msg, `📦 ZIP mil gayi — check kar rahi hoon... ⏳💗`);
      prep = await unzipWebsite(sock, msg, doc, 'zip2apk-');
    } catch (e) {
      await reply(sock, jid, msg, `❌ ${e.message || 'ZIP theek nahi.'}`);
      return;
    }
    let appName = (args || []).join(' ').replace(/[^\w\s-]/g, '').trim().slice(0, 20);
    if (!appName) appName = prep.defaultName;
    const hasName = (args || []).length > 0;
    const sess = { step: hasName ? 'icon' : 'name', workdir: prep.workdir, siteRoot: prep.siteRoot, appName, iconDir: null, ts: Date.now() };
    zip2apkSessions.set(sender, sess);
    if (sess.step === 'name') {
      await reply(sock, jid, msg, `✅ Website mil gayi!\n\n📱 App ka *naam* kya rakhoon?\nDefault: *${appName}*\n_Naam likh kar bhejo ya _skip_ likho_`);
    } else {
      await reply(sock, jid, msg, `✅ Website mil gayi!\n📝 Naam: *${appName}*\n\n🖼️ Ab icon ke liye apni *image* bhejo\nya _skip_ likho (default icon lagega)`);
    }
  },
};
_zip2apkCmds.zip2host = {
  desc: 'ZIP website → live link 🌐 (naam apni marzi ka)',
  usage: `${config.prefix}zip2host [naam]`,
  run: async (sock, msg, args, { jid }) => {
    const sender = msg.key.fromMe ? (sock.user?.id || jid) : (msg.key.participant || jid);
    zip2hostSweep();
    const q = ctxOf(msg)?.quotedMessage;
    const doc = (q && q.documentMessage) || msg.message?.documentMessage;
    const pend = zip2hostSessions.get(sender);
    if (!doc) {
      if (pend) return reply(sock, jid, msg, `🌐 Site ka *naam* kya rakhoon?\nLink banega: *naam*.surge.sh\n_(default: *${pend.defaultName}*)_\nNaam likh kar bhejo ya _skip_ likho`);
      return reply(sock, jid, msg, `❌ ZIP file ke saath caption *${config.prefix}zip2host* likhein,\nya kisi ZIP ke reply mein *${config.prefix}zip2host* likhein.`);
    }
    if (pend) { try { fs.rmSync(pend.workdir, { recursive: true, force: true }); } catch {} zip2hostSessions.delete(sender); }
    let prep;
    try {
      await reply(sock, jid, msg, `📦 ZIP mil gayi — check kar rahi hoon... ⏳💗`);
      prep = await unzipWebsite(sock, msg, doc, 'zip2host-');
    } catch (e) { return reply(sock, jid, msg, `❌ ${e.message || e}`); }
    const defaultName = surgeName(prep.defaultName, 'site');
    const sess = { workdir: prep.workdir, siteRoot: prep.siteRoot, defaultName, ts: Date.now() };
    const inlineName = (args || []).join(' ').trim();
    if (inlineName) { // .zip2host myname → seedha publish, poochna nahi
      await reply(sock, jid, msg, `🌐 *${surgeName(inlineName, defaultName)}* host ho rahi hai... ⏳`);
      await zip2hostPublish(sock, jid, msg, sess, inlineName);
      return;
    }
    zip2hostSessions.set(sender, sess);
    await reply(sock, jid, msg, `✅ Website mil gayi!\n\n🌐 Site ka *naam* kya rakhoon?\nLink banega: *naam*.surge.sh\n_(default: *${defaultName}*)_\nNaam likh kar bhejo ya _skip_ likho`);
  },
};
Object.assign(commands, _zip2apkCmds);

// ─── 📷 QR GENERATOR — 8 types ka wizard ───
const QRCode = require('qrcode');
const qrSessions = new Map(); // sender -> { step, type, data, ts, n }

function qrSweep() {
  const now = Date.now();
  for (const [k, s] of qrSessions) {
    if (now - s.ts > 5 * 60 * 1000) qrSessions.delete(k); // 5 min timeout
  }
}

const QR_MENU = '📷 *QR Generator* 📷\n\nKis cheez ka QR banao? 👇\n\n1️⃣ Website URL 🌐\n2️⃣ Text 📝\n3️⃣ Phone Number 📞\n4️⃣ Email 📧\n5️⃣ SMS 💬\n6️⃣ WiFi 📶\n7️⃣ Contact 👤\n8️⃣ Location 📍\n\n_Number_ bhejo (1–8) 💗';

// number ya naam dono se type pehchano
function qrPickType(t) {
  t = String(t || '').trim().toLowerCase();
  const m = { '1': 'url', '2': 'text', '3': 'phone', '4': 'email', '5': 'sms', '6': 'wifi', '7': 'vcard', '8': 'loc',
    url: 'url', website: 'url', link: 'url', web: 'url',
    text: 'text', msg: 'text', message: 'text',
    phone: 'phone', number: 'phone', call: 'phone', tel: 'phone',
    email: 'email', mail: 'email',
    sms: 'sms',
    wifi: 'wifi', 'wi-fi': 'wifi',
    vcard: 'vcard', contact: 'vcard', card: 'vcard',
    loc: 'loc', location: 'loc', map: 'loc', geo: 'loc' };
  return m[t] || null;
}

const QR_ASK = {
  url: '🌐 Website ka *URL* bhejo\n_(masalan: google.com ya https://merisite.com)_',
  text: '📝 *Text* bhejo — jo QR mein chahiye',
  phone: '📞 *Phone number* bhejo\n_(masalan: 03001234567)_',
  email: '📧 *Email address* bhejo',
  sms_num: '💬 SMS ke liye *number* bhejo',
  sms_msg: '✉️ *Message* likho\nya _skip_ likho (khali SMS)',
  wifi_ssid: '📶 WiFi ka *naam (SSID)* bhejo',
  wifi_pass: '🔑 WiFi ka *password* bhejo\nya _skip_ likho (open network — bina password)',
  vc_name: '👤 Contact ka *naam* bhejo',
  vc_phone: '📞 Contact ka *number* bhejo\nya _skip_ likho',
  vc_email: '📧 Contact ki *email* bhejo\nya _skip_ likho',
  loc: '📍 *Location* bhejo — lat,lng format mein\n_(masalan: 31.5204,74.3587)_',
};

const QR_LABEL = { url: '🌐 Website', text: '📝 Text', phone: '📞 Phone', email: '📧 Email', sms: '💬 SMS', wifi: '📶 WiFi', vcard: '👤 Contact', loc: '📍 Location' };

// WiFi special chars escape (\ ; , : " — spec ke mutabiq)
const qrWifiEsc = (s) => String(s || '').replace(/([\\;,:"])/g, '\\$1');

// final payload banao — null = invalid input
function qrBuildPayload(sess) {
  const d = sess.data, t = sess.type;
  if (t === 'url') {
    let u = String(d.url || '').trim();
    if (!u) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
    try { new URL(u); } catch { return null; }
    return u;
  }
  if (t === 'text') { const x = String(d.text || '').trim(); return x || null; }
  if (t === 'phone') {
    const p = String(d.phone || '').replace(/[^\d+]/g, '');
    return p.length >= 7 ? `tel:${p}` : null;
  }
  if (t === 'email') {
    const e = String(d.email || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? `mailto:${e}` : null;
  }
  if (t === 'sms') {
    const p = String(d.num || '').replace(/[^\d+]/g, '');
    if (p.length < 7) return null;
    const m = String(d.msg || '').trim();
    return m ? `SMSTO:${p}:${m}` : `SMSTO:${p}`;
  }
  if (t === 'wifi') {
    const ssid = String(d.ssid || '').trim();
    if (!ssid) return null;
    const pw = String(d.pass || '');
    return pw ? `WIFI:T:WPA;S:${qrWifiEsc(ssid)};P:${qrWifiEsc(pw)};;`
              : `WIFI:T:nopass;S:${qrWifiEsc(ssid)};;`;
  }
  if (t === 'vcard') {
    const nm = String(d.name || '').trim();
    if (!nm) return null;
    let v = 'BEGIN:VCARD\nVERSION:3.0\nFN:' + nm.replace(/[\r\n;]/g, ' ');
    const p = String(d.phone || '').replace(/[^\d+]/g, '');
    if (p.length >= 7) v += '\nTEL;TYPE=CELL:' + p;
    const e = String(d.email || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) v += '\nEMAIL:' + e;
    return v + '\nEND:VCARD';
  }
  if (t === 'loc') {
    const m = String(d.loc || '').trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const la = parseFloat(m[1]), ln = parseFloat(m[2]);
    if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
    return `geo:${la},${ln}`;
  }
  return null;
}

async function qrSend(sock, jid, msg, payload, label) {
  if (!payload) return reply(sock, jid, msg, '❌ Ye input samajh nahi aayi — dobara sahi format mein bhejo.');
  if (payload.length > 1500) return reply(sock, jid, msg, '❌ Text bohat lamba hai (max ~1500 characters) — chhota karke bhejo.');
  try {
    const png = await QRCode.toBuffer(payload, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
    await sock.sendMessage(jid, { image: png, caption: `📷 *${label}* ka QR tayyar! ✅\nScan karo 📱\n— Nexa 💗` }, { quoted: msg });
  } catch { await reply(sock, jid, msg, '❌ QR nahi ban saka — dobara try karo.'); }
}

// wizard hook — QR type/value ke jawab yahan pakre jate hain (handleMessage se call hota hai)
async function qrHook(sock, msg, sender, jid) {
  if (isOwnMsgId(msg.key?.id)) return false; // bot ke apne reply ka echo — loop protection
  qrSweep();
  const sess = qrSessions.get(sender);
  if (!sess) return false;
  sess.n = (sess.n || 0) + 1; // safety cap
  if (sess.n > 12) {
    qrSessions.delete(sender);
    await reply(sock, jid, msg, `⚠️ Session khatam ho gayi — dobara *${config.prefix}qr* se shuru karein.`);
    return true;
  }
  const text = (getText(msg) || '').trim();
  if (text.startsWith(config.prefix)) { // naya command → wizard cancel, normal flow chalne do
    qrSessions.delete(sender);
    return false;
  }
  const ask = async (step) => { sess.step = step; sess.ts = Date.now(); await reply(sock, jid, msg, QR_ASK[step]); };

  if (sess.step === 'pick') {
    const type = qrPickType(text);
    if (!type) {
      await reply(sock, jid, msg, '❌ 1 se 8 tak *number* bhejo\n_ya naam likho (masalan: wifi)_');
      return true;
    }
    sess.type = type; sess.data = {}; sess.ts = Date.now();
    const first = { url: 'url', text: 'text', phone: 'phone', email: 'email', sms: 'sms_num', wifi: 'wifi_ssid', vcard: 'vc_name', loc: 'loc' }[type];
    await ask(first);
    return true;
  }

  const d = sess.data, t = sess.type;
  const skip = /^skip$/i.test(text);
  const done = async () => {
    qrSessions.delete(sender);
    await reply(sock, jid, msg, '📷 QR bana rahi hoon... ⏳💗');
    await qrSend(sock, jid, msg, qrBuildPayload(sess), QR_LABEL[t]);
  };

  if (t === 'url') { d.url = text; await done(); return true; }
  if (t === 'text') { d.text = text.slice(0, 1000); await done(); return true; }
  if (t === 'phone') { d.phone = text; await done(); return true; }
  if (t === 'email') { d.email = text; await done(); return true; }
  if (t === 'sms') {
    if (sess.step === 'sms_num') { d.num = text; await ask('sms_msg'); return true; }
    d.msg = skip ? '' : text.slice(0, 300); await done(); return true;
  }
  if (t === 'wifi') {
    if (sess.step === 'wifi_ssid') { d.ssid = text.slice(0, 32); await ask('wifi_pass'); return true; }
    d.pass = skip ? '' : text.slice(0, 64); await done(); return true;
  }
  if (t === 'vcard') {
    if (sess.step === 'vc_name') { d.name = text.slice(0, 60); await ask('vc_phone'); return true; }
    if (sess.step === 'vc_phone') { d.phone = skip ? '' : text; await ask('vc_email'); return true; }
    d.email = skip ? '' : text; await done(); return true;
  }
  if (t === 'loc') { d.loc = text; await done(); return true; }
  return false;
}

const _qrCmds = {
  qr: {
    desc: 'QR code banao 📷 (8 types — website, text, phone, email, SMS, WiFi, contact, location)',
    run: async (sock, msg, args, { jid }) => {
      const sender = msg.key.fromMe ? (sock.user?.id || jid) : (msg.key.participant || jid);
      qrSweep();
      const quick = (args || []).join(' ').trim().slice(0, 1000);
      if (quick) { // .qr <text> → seedha text QR
        await reply(sock, jid, msg, '📷 QR bana rahi hoon... ⏳💗');
        await qrSend(sock, jid, msg, quick, '📝 Text');
        return;
      }
      qrSessions.delete(sender);
      qrSessions.set(sender, { step: 'pick', type: null, data: {}, ts: Date.now() });
      await reply(sock, jid, msg, QR_MENU);
    },
  },
};
Object.assign(commands, _qrCmds);

// ─── 🔄 CREACT — channel post par REACTION CYCLER ───
// WhatsApp ka rule: ek account, ek post par sirf *1* reaction rakhta hai —
// har naya emoji puranay ko REPLACE karta hai. Is liye "flood" namumkin hai;
// ye command emojis ko cycle karti hai taake dekhne walon ko reaction
// badalta nazar aaye. Aakhir mein aakhri emoji laga rehta hai.
// Channel ki forwarded post (caption .creact) ya us par reply (.creact)
const CREACT_DEFAULT = ['🔥', '❤️', '😂', '😮', '👏', '💯', '🥳', '🤯', '👑', '🚀', '😍', '🙌'];
const CREACT_MAX = 30;   // ek cycle mein max itne emojis (zyada ka faida nahi — sirf aakhri bachta hai)
const CREACT_GAP = 3000; // har emoji ke darmiyan waqfa — flip nazar aaye
// Kuch channels sirf 6 basic emojis allow karte hain (reaction_codes: BASIC) —
// wahan non-basic emoji bhejo to server use silent DROP (ya reaction hata) deta hai.
const CREACT_BASIC = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
// Channel ka reaction mode: 'BASIC' (sirf 6) ya 'ALL'. Parh na sakoon to BASIC (safe).
async function creactReactionMode(sock, nlJid, linkMeta) {
  try {
    const meta = linkMeta || await sock.newsletterMetadata('jid', nlJid);
    const v = meta?.thread_metadata?.settings?.reaction_codes?.value;
    return v === 'BASIC' ? 'BASIC' : 'ALL';
  } catch { return 'BASIC'; }
}
// Bara count manga to yahan se different emojis uthte hain
const CREACT_POOL = [...new Set([
  ...CREACT_DEFAULT,
  '😀', '😁', '🤣', '😊', '😉', '😋', '😎', '🤩', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🫡', '🤔', '🫣', '🥹', '😢', '😭', '😤', '😡', '🥶', '🥵', '😱', '😳', '🥺', '😴', '🤤', '🤐', '🤨', '😐', '🙄', '😬', '🤥', '😌', '😔', '😷', '🤒', '🤕', '🤠', '🥸', '😇', '🤡', '👻', '💀', '👽', '🤖',
  '💖', '💘', '💝', '💓', '💞', '💕', '❣️', '💟', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '❤️‍🔥', '💔',
  '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👋', '🤙', '💪', '🙏', '✍️', '👀', '💋', '🫶', '🤝', '👊', '✊', '🤛', '🤜', '🫵', '👆', '👇', '👉', '🖐️', '✋', '🤚',
  '🎉', '🎊', '🎈', '🎁', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '⭐', '🌟', '✨', '💫', '💥', '‼️', '⁉️', '✅', '🎵', '🎶', '🎧', '🎤', '🎸', '🥁',
  '🌹', '🌷', '🌸', '🌺', '🌻', '🌞', '🌝', '🌈', '⚡', '❄️', '💧', '🌊', '🌍', '🌙', '☀️', '🌠', '🎆', '🎇', '🧨',
  '🍕', '🍔', '🍟', '🌮', '🍩', '🍪', '🍫', '🍿', '🧋', '☕', '🍺', '🥂', '🍾',
])];
function creactFindInfo(msg) {
  const buckets = [];
  if (msg.message) buckets.push(msg.message);
  const q = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (q) buckets.push(q);
  for (const m of buckets) {
    if (!m || typeof m !== 'object') continue;
    for (const k of Object.keys(m)) {
      const ci = m[k]?.contextInfo;
      const fni = ci?.forwardedNewsletterMessageInfo;
      if (fni && fni.newsletterJid && fni.serverMessageId != null) return fni;
    }
  }
  return null;
}
function creactParseEmojis(args) {
  const joined = (args || []).join(' ');
  const found = joined.match(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic}+)*/gu) || [];
  const uniq = [...new Set(found)].slice(0, CREACT_MAX);
  return uniq.length ? uniq : CREACT_DEFAULT.slice();
}
// Channel post link: https://whatsapp.com/channel/<inviteCode>/<msgId>
function creactParseLink(args) {
  const joined = (args || []).join(' ');
  const m = joined.match(/whatsapp\.com\/channel\/([A-Za-z0-9]+)\/(\d+)/i);
  return m ? { code: m[1], serverId: m[2] } : null;
}
const _creactCmds = {
  creact: {
    desc: 'Channel post par reaction cycler 🔄 (link/forward/reply)',
    owner: true,
    run: async (sock, msg, args, { jid }) => {
      let nlJid = null, serverId = null, linkMeta = null;
      const info = creactFindInfo(msg);
      if (info) {
        nlJid = info.newsletterJid;
        serverId = String(info.serverMessageId);
      } else {
        // Link wala tareeqa: .creact <channel post link> [emojis]
        const link = creactParseLink(args);
        if (link) {
          await reply(sock, jid, msg, '🔗 Link se channel dhoond rahi hoon... ⏳💗');
          try {
            const meta = await sock.newsletterMetadata('invite', link.code);
            if (meta?.id) { nlJid = meta.id; serverId = link.serverId; linkMeta = meta; }
          } catch {}
          if (!nlJid) return reply(sock, jid, msg, '❌ Link se channel nahi mila. Link poora aur sahi bhejo.\nMasalan: *https://whatsapp.com/channel/0029VaXXXX/123*');
        }
      }
      if (!nlJid) {
        return reply(sock, jid, msg,
          `🔄 *Channel Reaction Cycler*\n\n` +
          `WhatsApp ka rule: ek account, ek post par sirf *1* reaction rakhta hai — har naya emoji puranay ko *replace* karta hai. Is liye ye command emojis *cycle* karti hai: dekhne walon ko reaction badalta nazar aata hai, aakhir mein *aakhri emoji* laga rehta hai. 😌\n\n` +
          `*Tareeqa 1 — Link:*\n*${config.prefix}creact* https://whatsapp.com/channel/XXXX/123\n\n` +
          `*Tareeqa 2 — Forward:*\nChannel ki post mujhe *forward* karo, caption mein:\n*${config.prefix}creact*\n\n` +
          `*Tareeqa 3 — Reply:*\nForward ki hui post par reply karke:\n*${config.prefix}creact* 🔥❤️😂\n\n` +
          `Apne emojis bhi de sakte ho (max ${CREACT_MAX}):\n*${config.prefix}creact* <link> 🥳🤯👑\n` +
          `*Count wala cycle:*\n*${config.prefix}creact* <link> 20 _(max ${CREACT_MAX})_\n` +
          `_(kuch na likho to default 12 emojis cycle honge — har 3 second mein ek)_\n` +
          `_(note: kuch channels sirf 6 basic emojis 👍❤️😂😮😢🙏 allow karte hain — wahan baqi ignore ho jate hain)_\n` +
          `_(zyada reactions? ek account = 1 reaction. Jitne numbers bot se connected honge, sab ka 1-1 reaction jayega 👥)_ 💗`);
      }
      // Count wala tareeqa: .creact <link> 20 → 20 emojis cycle (BASIC channel par 6 repeat)
      const countArg = (args || []).find((a) => /^\d{1,4}$/.test(a));
      const wantCount = countArg ? parseInt(countArg, 10) : 0;
      const mode = await creactReactionMode(sock, nlJid, linkMeta);
      const pool = mode === 'BASIC' ? CREACT_BASIC : CREACT_POOL;
      const modeNote = mode === 'BASIC' ? `\n_(ye channel sirf 6 basic emojis allow karta hai: ${CREACT_BASIC.join(' ')})_` : '';
      let emojis, countNote = '';
      if (wantCount > 0) {
        const n = Math.min(wantCount, CREACT_MAX);
        emojis = [];
        for (let i = 0; i < n; i++) emojis.push(pool[i % pool.length]);
        if (wantCount > CREACT_MAX) {
          countNote = `\nℹ️ ${wantCount} manga tha — max *${CREACT_MAX}* cycle kar sakti hoon (zyada ka faida nahi, WhatsApp sirf aakhri rakhta hai).`;
        }
      } else {
        const rawFound = ((args || []).join(' ').match(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic}+)*/gu) || []);
        if (!rawFound.length) {
          // default cycle: pool se 12 (BASIC channel par 6 basics repeat)
          emojis = [];
          for (let i = 0; i < 12; i++) emojis.push(pool[i % pool.length]);
        } else {
          emojis = [...new Set(rawFound)].slice(0, CREACT_MAX);
          if (mode === 'BASIC') {
            const filtered = emojis.filter((e) => CREACT_BASIC.includes(e));
            if (filtered.length < emojis.length) {
              countNote = `\nℹ️ Tumhare kuch emojis is channel par allowed nahi — sirf basic wale cycle kiye.`;
            }
            emojis = filtered.length ? filtered : CREACT_BASIC.slice();
          }
        }
      }
      await reply(sock, jid, msg, `🔄 *${emojis.length}* emojis cycle kar rahi hoon — har 3 second mein reaction badlega... ⏳💗` + modeNote);
      try { await sock.newsletterFollow(nlJid); } catch {} // follow na ho to pehle follow
      let done = 0, failed = 0, lastOk = null;
      for (let i = 0; i < emojis.length; i++) {
        const e = emojis[i];
        try { await sock.newsletterReactMessage(nlJid, serverId, e); done++; lastOk = e; }
        catch { failed++; }
        if (done % 10 === 0 && done < emojis.length) {
          await reply(sock, jid, msg, `🔄 ${done}/${emojis.length}...`).catch(() => {});
        }
        if (i < emojis.length - 1) await new Promise((r) => setTimeout(r, CREACT_GAP));
      }
      if (!done) {
        return reply(sock, jid, msg, '❌ Reaction nahi lag saka. Shayad channel ne reactions band kiye hain ya post purani hai.');
      }
      // 👥 MULTI-ACCOUNT: baqi connected numbers se bhi 1-1 reaction (tally barhane ka wahid tareeqa —
      // ek account ek post par sirf 1 reaction rakh sakta hai, repeat se count nahi barhta)
      let fanNote = '';
      if (CREACT_FANOUT && lastOk) {
        try {
          const res = await CREACT_FANOUT(nlJid, serverId, lastOk);
          const okOnes = (res || []).filter((r) => r.ok);
          if (okOnes.length) {
            fanNote = `\n👥 *${okOnes.length + 1} accounts* ne react kiya (tumhara main + ${okOnes.length} connected) — post par *${lastOk}* × ${okOnes.length + 1}!`;
          } else if ((res || []).length) {
            fanNote = `\nℹ️ Baqi connected numbers se react nahi ho saka (unke WhatsApp connected nahi). Zyada reactions ke liye aur numbers pair karo.`;
          }
        } catch { /* fan-out optional — main reaction ho gaya */ }
      }
      await reply(sock, jid, msg,
        `🔄 *Cycle complete!* ${done} emojis ghoom gaye 💫\n` +
        `👉 Ab post par *${lastOk}* laga hua hai — WhatsApp ek waqt mein sirf *1* reaction rakhta hai, har naya puranay ko replace karta hai.` +
        (failed ? `\n⚠️ ${failed} beech mein reh gaye.` : '') + countNote + fanNote);
    },
  },
};
Object.assign(commands, _creactCmds);

// ─── 🤲 DUA COLLECTION (authentic duas — Arabic + Urdu tarjuma) ───
const DUAS = {
  enterhome: { t: 'Ghar mein dakhil hone ki dua 🏠',
    ar: 'بِسْمِ اللَّهِ وَلَجْنَا، وَبِسْمِ اللَّهِ خَرَجْنَا، وَعَلَى رَبِّنَا تَوَكَّلْنَا',
    ur: 'اللہ کے نام سے ہم داخل ہوئے، اللہ کے نام سے ہم نکلیں گے، اور اپنے رب پر ہم نے بھروسا کیا۔' },
  leavehome: { t: 'Ghar se nikalne ki dua 🚶',
    ar: 'بِسْمِ اللَّهِ، تَوَكَّلْتُ عَلَى اللَّهِ، وَلَا حَوْلَ وَلَا قُوَّةَ إِلَّا بِاللَّهِ',
    ur: 'اللہ کے نام سے، میں نے اللہ پر بھروسا کیا، گناہ سے بچنے کی طاقت اور نیکی کی توفیق صرف اللہ ہی سے ہے۔' },
  sick: { t: 'Bimar ki ayadat ki dua 🤒',
    ar: 'أَذْهِبِ الْبَأْسَ رَبَّ النَّاسِ، اِشْفِ أَنْتَ الشَّافِي، لَا شِفَاءَ إِلَّا شِفَاؤُكَ، شِفَاءً لَا يُغَادِرُ سَقَمًا',
    ur: 'اے لوگوں کے رب! تکلیف دور فرما، شفا عطا فرما، تو ہی شفا دینے والا ہے، تیری شفا کے سوا کوئی شفا نہیں، ایسی شفا جو کوئی بیماری باقی نہ چھوڑے۔' },
  shifa: { t: 'Shifa ki dua (حضرت ایوبؑ) 🌿',
    ar: 'أَنِّي مَسَّنِيَ الضُّرُّ وَأَنْتَ أَرْحَمُ الرَّاحِمِينَ',
    ur: 'بے شک مجھے تکلیف پہنچی ہے اور تو سب سے بڑھ کر رحم کرنے والا ہے۔ (سورۃ الانبیاء)' },
  marhoom: { t: 'Marhoom ke liye dua 🕊️',
    ar: 'اَللَّهُمَّ اغْفِرْ لَهُ وَارْحَمْهُ وَعَافِهِ وَاعْفُ عَنْهُ',
    ur: 'اے اللہ! اسے بخش دے، اس پر رحم فرما، اسے عافیت دے اور اس سے درگزر فرما۔' },
  janaza: { t: 'Namaz-e-Janaza ki dua 🤲',
    ar: 'اَللَّهُمَّ اغْفِرْ لِحَيِّنَا وَمَيِّتِنَا وَشَاهِدِنَا وَغَائِبِنَا وَصَغِيرِنَا وَكَبِيرِنَا وَذَكَرِنَا وَأُنْثَانَا',
    ur: 'اے اللہ! ہمارے زندوں اور مردوں، حاضر اور غائب، چھوٹے اور بڑے، مرد اور عورت — سب کو بخش دے۔' },
  rizq: { t: 'Rizq mein barkat ki dua 💰',
    ar: 'اَللَّهُمَّ اكْفِنِي بِحَلَالِكَ عَنْ حَرَامِكَ وَأَغْنِنِي بِفَضْلِكَ عَمَّنْ سِوَاكَ',
    ur: 'اے اللہ! مجھے اپنے حلال سے کافی کر دے حرام سے بچا کر، اور اپنے فضل سے مجھے اپنے سوا سب سے بے نیاز کر دے۔' },
  barkat: { t: 'Khane ke baad ki dua 🍛',
    ar: 'اَلْحَمْدُ لِلَّهِ الَّذِي أَطْعَمَنَا وَسَقَانَا وَجَعَلَنَا مُسْلِمِينَ',
    ur: 'تمام تعریفیں اللہ کے لیے ہیں جس نے ہمیں کھلایا پلایا اور مسلمان بنایا۔' },
  qarz: { t: 'Qarz se nijat ki dua 📉',
    ar: 'اَللَّهُمَّ إِنِّي أَعُوذُ بِكَ مِنَ الْمَأْثَمِ وَالْمَغْرَمِ',
    ur: 'اے اللہ! میں گناہ اور قرض (کے بوجھ) سے تیری پناہ چاہتا ہوں۔' },
  nazar: { t: 'Nazar-e-bad se hifazat 🧿',
    ar: 'أَعُوذُ بِكَلِمَاتِ اللَّهِ التَّامَّةِ مِنْ كُلِّ شَيْطَانٍ وَهَامَّةٍ وَمِنْ كُلِّ عَيْنٍ لَامَّةٍ',
    ur: 'میں اللہ کے کامل کلمات کی پناہ چاہتا ہوں، ہر شیطان اور زہریلے جانور سے، اور ہر لگنے والی (بری) نظر سے۔' },
  hifazat: { t: 'Subah-shaam ki hifazat 🛡️',
    ar: 'بِسْمِ اللَّهِ الَّذِي لَا يَضُرُّ مَعَ اسْمِهِ شَيْءٌ فِي الْأَرْضِ وَلَا فِي السَّمَاءِ وَهُوَ السَّمِيعُ الْعَلِيمُ',
    ur: 'اللہ کے نام سے، جس کے نام کے ساتھ زمین و آسمان کی کوئی چیز نقصان نہیں پہنچا سکتی، اور وہ سننے والا، جاننے والا ہے۔ (صبح شام 3 بار)' },
  safar: { t: 'Safar ki dua ✈️',
    ar: 'سُبْحَانَ الَّذِي سَخَّرَ لَنَا هَذَا وَمَا كُنَّا لَهُ مُقْرِنِينَ وَإِنَّا إِلَى رَبِّنَا لَمُنْقَلِبُونَ',
    ur: 'پاک ہے وہ ذات جس نے اس (سواری) کو ہمارے تابع کیا، حالانکہ ہم اس پر قابو نہ رکھتے تھے، اور بے شک ہم اپنے رب کی طرف لوٹنے والے ہیں۔' },
  subha: { t: 'Subah ki dua 🌅',
    ar: 'اَللَّهُمَّ بِكَ أَصْبَحْنَا وَبِكَ أَمْسَيْنَا وَبِكَ نَحْيَا وَبِكَ نَمُوتُ وَإِلَيْكَ النُّشُورُ',
    ur: 'اے اللہ! تیرے (فضل) سے ہم نے صبح کی، تیرے (فضل) سے ہم شام کریں گے، تیرے (حکم) سے ہم جیتے ہیں اور تیرے (حکم) سے ہم مریں گے، اور تیری ہی طرف اٹھنا ہے۔' },
  shaam: { t: 'Shaam ki dua 🌇',
    ar: 'اَللَّهُمَّ بِكَ أَمْسَيْنَا وَبِكَ أَصْبَحْنَا وَبِكَ نَحْيَا وَبِكَ نَمُوتُ وَإِلَيْكَ الْمَصِيرُ',
    ur: 'اے اللہ! تیرے (فضل) سے ہم نے شام کی، تیرے (فضل) سے ہم صبح کریں گے، تیرے (حکم) سے ہم جیتے ہیں اور مریں گے، اور تیری ہی طرف لوٹنا ہے۔' },
  neend: { t: 'Sone ki dua 😴',
    ar: 'بِاسْمِكَ اللَّهُمَّ أَمُوتُ وَأَحْيَا',
    ur: 'تیرے نام سے اے اللہ! میں (نیند کی صورت) مرتا ہوں اور (بیداری کی صورت) جیتا ہوں۔' },
  uthna: { t: 'Neend se jaagne ki dua ⏰',
    ar: 'اَلْحَمْدُ لِلَّهِ الَّذِي أَحْيَانَا بَعْدَ مَا أَمَاتَنَا وَإِلَيْهِ النُّشُورُ',
    ur: 'تمام تعریفیں اللہ کے لیے ہیں جس نے ہمیں موت (نیند) کے بعد زندہ کیا، اور اسی کی طرف اٹھ کر جانا ہے۔' },
  khana: { t: 'Khana shuru karne ki dua 🍽️',
    ar: 'بِسْمِ اللَّهِ',
    ur: 'اللہ کے نام سے۔ (اگر شروع میں بھول جائیں تو یاد آنے پر پڑھیں: بِسْمِ اللَّهِ فِي أَوَّلِهِ وَآخِرِهِ)' },
  wazu: { t: 'Wazu ke baad ki dua 💧',
    ar: 'أَشْهَدُ أَنْ لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ وَأَشْهَدُ أَنَّ مُحَمَّدًا عَبْدُهُ وَرَسُولُهُ',
    ur: 'میں گواہی دیتا ہوں کہ اللہ کے سوا کوئی معبود نہیں، وہ اکیلا ہے اس کا کوئی شریک نہیں، اور میں گواہی دیتا ہوں کہ محمد ﷺ اس کے بندے اور رسول ہیں۔' },
  parishani: { t: 'Parishani aur gham ki dua 😔',
    ar: 'اَللَّهُمَّ إِنِّي أَعُوذُ بِكَ مِنَ الْهَمِّ وَالْحَزَنِ وَالْعَجْزِ وَالْكَسَلِ وَالْبُخْلِ وَالْجُبْنِ وَضَلَعِ الدَّيْنِ وَغَلَبَةِ الرِّجَالِ',
    ur: 'اے اللہ! میں فکر و غم، عاجزی و سستی، بخل و بزدلی، قرض کے بوجھ اور لوگوں کے غلبے سے تیری پناہ چاہتا ہوں۔' },
  maghfirat: { t: 'Maghfirat ki dua (حضرت آدمؑ) 🤲',
    ar: 'رَبَّنَا ظَلَمْنَا أَنْفُسَنَا وَإِنْ لَمْ تَغْفِرْ لَنَا وَتَرْحَمْنَا لَنَكُونَنَّ مِنَ الْخَاسِرِينَ',
    ur: 'اے ہمارے رب! ہم نے اپنی جانوں پر ظلم کیا، اور اگر تو نے ہمیں نہ بخشا اور ہم پر رحم نہ فرمایا تو ہم ضرور خسارہ پانے والوں میں سے ہوں گے۔' },
  duniya: { t: 'Duniya-o-Aakhirat ki جامع dua 🌍',
    ar: 'رَبَّنَا آتِنَا فِي الدُّنْيَا حَسَنَةً وَفِي الْآخِرَةِ حَسَنَةً وَقِنَا عَذَابَ النَّارِ',
    ur: 'اے ہمارے رب! ہمیں دنیا میں بھلائی عطا فرما اور آخرت میں بھی بھلائی عطا فرما، اور ہمیں آگ کے عذاب سے بچا۔' },
  qubool: { t: 'Qubooliyat ki dua ✅',
    ar: 'رَبَّنَا تَقَبَّلْ مِنَّا إِنَّكَ أَنْتَ السَّمِيعُ الْعَلِيمُ',
    ur: 'اے ہمارے رب! ہم سے (یہ عمل) قبول فرما، بے شک تو سننے والا، جاننے والا ہے۔' },
  ayatqursi: { t: 'Ayat-ul-Kursi 📖',
    ar: 'اللَّهُ لَا إِلَهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ، لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ، لَهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ، مَنْ ذَا الَّذِي يَشْفَعُ عِنْدَهُ إِلَّا بِإِذْنِهِ، يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ، وَلَا يُحِيطُونَ بِشَيْءٍ مِنْ عِلْمِهِ إِلَّا بِمَا شَاءَ، وَسِعَ كُرْسِيُّهُ السَّمَاوَاتِ وَالْأَرْضَ، وَلَا يَئُودُهُ حِفْظُهُمَا، وَهُوَ الْعَلِيُّ الْعَظِيمُ',
    ur: 'اللہ، اس کے سوا کوئی معبود نہیں، زندہ ہے، قائم رکھنے والا ہے۔ اسے نہ اونگھ آتی ہے نہ نیند۔ اسی کا ہے جو آسمانوں اور زمین میں ہے۔ کون ہے جو اس کی اجازت کے بغیر اس کے پاس سفارش کرے؟ وہ جانتا ہے جو ان کے آگے ہے اور جو ان کے پیچھے ہے، اور وہ اس کے علم میں سے کسی چیز کا احاطہ نہیں کر سکتے مگر جتنا وہ چاہے۔ اس کی کرسی آسمانوں اور زمین کو گھیرے ہوئے ہے، اور ان کی حفاظت اسے تھکاتی نہیں، اور وہ بلند و عظیم ہے۔ (سورۃ البقرۃ)' },
  pakistan: { t: 'Pakistan ke liye dua 🇵🇰', ar: '',
    ur: 'اے اللہ! پاکستان کی حفاظت فرما۔ اسے امن و امان کا گہوارہ بنا۔ اس کے دشمنوں کے ارادے ناکام فرما۔ یہاں کے لوگوں کو خوشحال، متحد اور اپنے دین پر قائم رکھ۔ آمین ثم آمین۔ 🤲🇵🇰' },
};
function formatDua(d) {
  return `🤲 *${d.t}*\n_— ${config.botName} 💗_\n\n${d.ar ? d.ar + '\n\n' : ''}💬 _"${d.ur}"_`;
}
const _duaCmds = {};
_duaCmds.dua = {
  desc: 'Islami duaein — list ya naam se 🤲',
  run: async (sock, msg, args, { jid }) => {
    const q = (args[0] || '').toLowerCase().replace(/^dua/, '');
    if (q && DUAS[q]) return reply(sock, jid, msg, formatDua(DUAS[q]));
    const names = Object.keys(DUAS);
    await reply(sock, jid, msg,
      `🤲 *Islami Dua Collection* (${names.length} duaein)\n_— ${config.botName} 💗_\n\n` +
      names.map((n) => `• *${config.prefix}dua${n}* — ${DUAS[n].t}`).join('\n') +
      `\n\n💡 Masalan: *${config.prefix}duasick* ya *${config.prefix}dua sick*`);
  },
};
for (const [k, d] of Object.entries(DUAS)) {
  if (k === 'pakistan') {
    _duaCmds['dua' + k] = { desc: d.t, run: async (sock, msg, args, { jid }) => reply(sock, jid, msg, formatDua(d)) };
    continue;
  }
  _duaCmds['dua' + k] = { desc: d.t, run: async (sock, msg, args, { jid }) => reply(sock, jid, msg, formatDua(d)) };
}
// .duaname <naam> — kisi ke naam ke saath dua
_duaCmds.duaname = {
  desc: 'Kisi ke naam wali dua 🤲',
  run: async (sock, msg, args, { jid }) => {
    const name = args.join(' ').trim().slice(0, 30);
    if (!name) return reply(sock, jid, msg, `🤲 Usage: *${config.prefix}duaname <naam>*\nMasalan: *${config.prefix}duaname Ali*`);
    await reply(sock, jid, msg,
      `🤲 *${name} ke liye dua* 🤲\n_— ${config.botName} 💗_\n\n` +
      `بَارَكَ اللَّهُ لَكَ يَا ${name} وَبَارَكَ عَلَيْكَ وَجَمَعَ بَيْنَكُمَا فِي خَيْرٍ\n\n` +
      `💬 _"اے ${name}! اللہ تمہیں برکت دے، تم پر برکت نازل فرمائے، تمہیں ہر خیر میں کامیاب کرے، تمہاری عمر دراز ہو، رزق میں برکت ہو اور ہر مشکل آسان ہو۔ آمین ثم آمین 🤲💗"_`);
  },
};
Object.assign(commands, _duaCmds);

// ─── auto-react (har message par random emoji) ─────────────────────
const REACT_EMOJIS = ['💗', '❤️', '🔥', '👍', '😍', '🥰', '✨', '👏', '😮', '🎉', '💯', '🤗'];
async function autoReact(sock, msg) {
  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  if (msg.message?.protocolMessage) return; // revoke waghera par react nahi
  const pool = getSetting('reactemojis');
  const list = Array.isArray(pool) && pool.length ? pool : REACT_EMOJIS;
  const emoji = list[Math.floor(Math.random() * list.length)];
  await sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
}

// ─── contact reply relay (anonymous two-way) ─────────────────────
// Banda .contact kare → forward Boss ke inbox mein (id map mein).
// Boss us forward ka REPLY kare → jawab bande ke inbox mein, Boss ka
// number/identity kabhi zahir nahi hoti (bande ko sirf bot ka number dikhta hai).
function getContextInfo(msg) {
  const m = msg.message || {};
  for (const k of Object.keys(m)) {
    const ci = m[k]?.contextInfo;
    if (ci) return ci;
  }
  return null;
}
function pruneContactMap() {
  const cm = STATE.contactMap || {};
  const ids = Object.keys(cm);
  if (ids.length <= 200) return;
  ids.sort((a, b) => (cm[a].at || 0) - (cm[b].at || 0));
  for (const id of ids.slice(0, ids.length - 200)) delete cm[id];
}
async function relayContactReply(sock, msg, sender, jid) {
  try {
    if (!isOwnerMsg(msg, sender, jid) || !config.owner) return false;
    const ci = getContextInfo(msg);
    const qid = ci?.stanzaId;
    if (!qid) return false;
    const target = (STATE.contactMap || {})[qid];
    if (!target || !target.member) return false;
    const text = getText(msg);
    if (text && text.startsWith(config.prefix)) return false; // command hai → normal flow
    const memberJid = target.member;
    // UNIQUE marking (Boss ka hukm): bande ko foran pata chale —
    // "maine owner ko paigham bheja tha, YE usi ka reply hai" 👑
    const head = '👑 *Owner ka jawab* 💗\n_Aap ne owner ko paigham bheja tha — ye usi ka reply hai_\n\n— — —\n';
    const m = msg.message || {};
    if (m.imageMessage) {
      const buf = await downloadMediaMessage({ key: msg.key, message: m }, 'buffer', {});
      await sock.sendMessage(memberJid, { image: buf, caption: head + (m.imageMessage.caption || '') });
    } else if (m.videoMessage) {
      const buf = await downloadMediaMessage({ key: msg.key, message: m }, 'buffer', {});
      await sock.sendMessage(memberJid, { video: buf, caption: head + (m.videoMessage.caption || '') });
    } else if (m.audioMessage) {
      const buf = await downloadMediaMessage({ key: msg.key, message: m }, 'buffer', {});
      await sock.sendMessage(memberJid, { text: head.trim() }); // voice note se pehle unique header
      await sock.sendMessage(memberJid, { audio: buf, ptt: !!m.audioMessage.ptt, mimetype: m.audioMessage.mimetype || 'audio/ogg; codecs=opus' });
    } else if (m.stickerMessage) {
      const buf = await downloadMediaMessage({ key: msg.key, message: m }, 'buffer', {});
      await sock.sendMessage(memberJid, { sticker: buf });
    } else if (text) {
      await sock.sendMessage(memberJid, { text: head + text });
    } else return false;
    // Boss ko halki si tasdeeq (reaction) — chat mein koi msg nahi
    try { await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } }); } catch {}
    return true;
  } catch { return false; }
}

// ─── dispatcher ─────────────────────────────────────────

// ─── 💗 Per-command reactions (Boss: jo command chale, us ke mutabiq react) ───
// Har command par us ki munasibat se emoji reaction. Secret (hidden) commands
// par react nahi hota — koi nishan nahi chhorte.
const CMD_REACT_EXACT = {
  ping: '🏓', alive: '💗', menu: '📜', help: '📜', list: '📜',
  sticker: '✨', take: '😎', steal: '😎', toimg: '🖼️', tovid: '🎬',
  song: '🎵', audio: '🎵', play: '🎵', music: '🎵', video: '🎬',
  imagine: '🎨', dp: '🖼️', logo: '✒️', wallpaper: '🌄',
  quran: '📖', dua: '🤲', hadith: '📜', naat: '🎤',
  tagall: '📢', hidetag: '📢', kick: '🦵', promote: '⬆️', demote: '⬇️',
  ss: '📸', qr: '🔳', translate: '🌐', weather: '🌤️', news: '📰',
  joke: '😂', meme: '🤣', shayari: '💔', lyrics: '🎼', quiz: '🧠',
  tiktok: '📱', insta: '📸', reel: '🎬', contact: '📩',
  ghost: '👻', vv: '👁️', vvl: '👁️', calc: '🧮', time: '🕐',
  voiceai: '🎙️', pmenu: '📊', find: '🔍', briefing: '🌅',
  apk: '📦', ai: '💗', nexa: '💗', ask: '💗',
  funnel: '🎯', clabel: '🏷️', clabels: '🏷️', cnote: '📝', cnotes: '📝',
};
const CMD_REACT_PATTERNS = [
  [/^(ping|speed|latency|pong)/, '🏓'],
  [/^(alive|nexa|gpt|bot|info|stats)/, '💗'],
  [/^(menu|help|cmd|command)/, '📜'],
  [/^(stick|toimg|tovid|emojimix)/, '✨'],
  [/^(song|audio|play|music|mp3|spotify|saavn)/, '🎵'],
  [/^(video|mp4|tiktok|reel|short|tube|fbvid)/, '🎬'],
  [/^(insta|ig|fb|twitter|pint|pin)/, '📸'],
  [/^(imag|draw|paint|art|photo|pic|dp|logo|wall)/, '🎨'],
  [/^(quran|dua|hadith|naat|darood|wazifa|namaz|roza)/, '🤲'],
  [/^(antakshari|sauda|truth|dare|slot|rps|tictac|hangman|scramble)/, '🎮'],
  [/^(interview|quiz|riddle|puzzle)/, '🧠'],
  [/^(tag|kick|ban|unban|promot|demot|antilink|warn|mute|unmute|group)/, '👥'],
  [/^(ss|screenshot|qr|translat|calc|weather|news|lyric|dict|meaning)/, '🔧'],
  [/^(owner|sudu|sudo|dev|king)/, '👑'],
  [/^(contact|demo|perm|trial|buy|price|plan)/, '🎫'],
  [/^(ghost|hide|stealth|vv|viewonce|antidelete|unsend)/, '👻'],
  [/^(voice|tts|speak|say|effect|bass|chipmunk)/, '🎙️'],
  [/^(apk|zip|host|deploy|web)/, '📦'],
  [/^(joke|meme|fun|funny|laugh|comedy)/, '😂'],
  [/^(shayari|poetry|sad|love|romantic)/, '💔'],
  [/^(cricket|football|score|match)/, '🏏'],
  [/^(crypto|stock|price|forex|gold)/, '💹'],
  [/^(time|date|day|calendar|clock)/, '🕐'],
  [/^(dl|download|save|get)/, '⬇️'],
  [/^(search|google|find|lookup)/, '🔍'],
];
function cmdReact(name) {
  const n = String(name || '').toLowerCase();
  if (CMD_REACT_EXACT[n]) return CMD_REACT_EXACT[n];
  for (const [re, e] of CMD_REACT_PATTERNS) if (re.test(n)) return e;
  return '⚡';
}
async function handleMessage(sock, msg) {
  try {
    const jid = msg.key?.remoteJid;
    if (!jid || jid === 'status@broadcast') return;
    REM_SOCK = sock; // reminder checker isi session ka sock istemal kare
    ensureAutobio();

    // ⚙️ autoread: har incoming message par foran blue tick
    if (getSetting('autoread') && !msg.key.fromMe) {
      sock.readMessages([{ remoteJid: jid, id: msg.key.id, participant: msg.key.participant }]).catch(() => {});
    }

    // 👻 ghostchat: DM ki khamosh copy owner inbox mein (blue tick nahi jata)
    if (getSetting('ghostchat')) ghostChatForward(sock, msg, jid).catch(() => {});

    // Anti-delete: delete-for-everyone pakro (sab se pehle)
    if (await checkRevoke(sock, msg, jid)) return;
    // Anti-delete cache (fire-and-forget — revoke se pehle save hona chahiye)
    cacheMessage(msg, jid);
    // 👁️ View-Once Saver: view-once aate hi foran disk par save (fire-and-forget)
    cacheViewOnce(msg, jid);

    // fromMe (khud ke bheje hue) messages ka sender bot khud hai
    const sender = msg.key.fromMe ? (sock.user?.id || jid) : (msg.key.participant || jid);

    // Stealth view-once: owner ne view-once ke reply mein koi sticker/word
    // bheja (bina .vv likhe) → unlocked media khamoshi se owner inbox mein.
    if (await stealthViewOnce(sock, msg, sender)) return;

    // 📩 Contact reply relay: owner ne contact-forward ka reply kiya
    // → jawab bande ke inbox mein (identity private rehti hai).
    if (await relayContactReply(sock, msg, sender, jid)) return;

    // Owner ne is private chat mein khud likha → known contact (unknown-auto ke liye)
    if (msg.key.fromMe) noteOwnerChat(jid);

    // 🔌 POWER SWITCH (owner): power OFF ho to non-owner ke liye MUKAMMAL khamoshi —
    // na command reply, na auto-AI, na autoreact, na wizard/game. Sirf owner ke commands chalte hain.
    if (globalPower() === false && !isOwnerMsg(msg, sender, jid)) return;

    // 🎶 antakshari / 🎤 interview: game/mode active ho to saada text uska hissa hai (auto-AI se pehle)
    if (await antakshariHook(sock, msg, sender, jid)) return;
    if (await interviewHook(sock, msg, sender, jid)) return;
    // 🎯 lead funnel: active session ho ya keyword mile to uska jawab
    if (typeof EXCLUSIVE !== 'undefined' && await EXCLUSIVE.exclusiveHook(sock, msg, sender, jid)) return;
    // 📱 zip2apk wizard: naam/icon ka jawab pending ho to pehle usko do
    if (await zip2apkHook(sock, msg, sender, jid)) return;
    // 🌐 zip2host wizard: site ke naam ka jawab pending ho to pehle usko do
    if (await zip2hostHook(sock, msg, sender, jid)) return;
    // 📷 qr wizard: QR type/value ka jawab pending ho to pehle usko do
    if (await qrHook(sock, msg, sender, jid)) return;
    // 💬 webchat: owner ke bare "1"/"2"/"3" → aakhri AI quick-reply bhejo
    if (await WEBCHAT.webchatHook(sock, msg, sender, jid)) return;

    // Auto AI chat (manual on / smart unknown-auto)
    // 💬 mentionme: group mein bot ko mention kiya → AI jawab (owner setting)
    if (await mentionMeHook(sock, msg, sender, jid)) return;
    // 💤 afk: AFK user ko mention → auto-reply (flow nahi rokta)
    await afkHook(sock, msg, sender, jid);
    if (await autoAI(sock, msg, sender, jid)) return;

    // 💗 Auto-react: har incoming message par random pyaara emoji react
    // (apne sessions ke aapas ke personal chats mein bilkul khamoshi — koi shor nahi)
    if (STATE.autoreact && !msg.key.fromMe && !isOwnSessionMsg(msg, sender, jid)) autoReact(sock, msg).catch(() => {});

    let text = getText(msg);

    // ⬡ NEXUS hook: sock update + message log + curse/triggers/void/chaos/media
    NEXUS.setSock(sock);
    WEBCHAT.setSock(sock);
    await NEXUS.onMessage(sock, msg, jid, sender, text);
    if (typeof GROUPKIT !== 'undefined') { GROUPKIT.setSock(sock); await GROUPKIT.onMessage(sock, msg, jid, sender, text); } // 👥 activity track + antilink warn
    trackGactive(msg, jid, sender); // 📊 gactive: per-group message counts (60s throttled save)

    // ⚙️ antilink: per-group (.antilink on) ya legacy global setting
    const antilinkOn = getSetting('antilink') || !!loadAntilink()[jid];
    if (antilinkOn && jid.endsWith('@g.us') && !msg.key.fromMe && /https?:\/\/|www\.|chat\.whatsapp\.com|t\.me\/|wa\.me\//i.test(text || '')) {
      const sNum = num(sender);
      let isAdm = isOwnerMsg(msg, sender, jid);
      try {
        const meta = await sock.groupMetadata(jid);
        isAdm = isAdm || (meta.participants || []).some((pt) => pt.admin && [num(pt.id), num(pt.phoneNumber)].includes(sNum));
      } catch {}
      if (!isAdm) {
        try { await sock.sendMessage(jid, { delete: msg.key }); } catch {}
        await reply(sock, jid, msg, `⚠️ @${sNum} — is group mein links allowed nahi hain!`);
        return;
      }
    }

    // ⬡ NX auto-guards: antibot / antitag / autosticker (Boss order 2026-09-25)
    if (await nxAutoGuards(sock, msg, sender, jid, text)) return;

    // 🎙 Voice note command: bolo, bot sun kar command chaleyega!
    // (ptt = voice note; normal audio file par nahi chalta)
    const am = msg.message?.audioMessage;
    // voice-note command mapping default OFF hai (.voicecmd on se on) —
    // aam voice note par bot khamosh rahe, kuch na bheje
    if (!text && am?.ptt && getSetting('voicecmd') && !isOwnSessionMsg(msg, sender, jid)) {
      const secs = am.seconds || 0;
      if (secs > 90) {
        await reply(sock, jid, msg, '🎙 90 second se lambi voice note nahi sun sakta Boss! Chhoti si bolo 🙂');
        return;
      }
      try {
        const buf = await downloadMediaMessage({ key: msg.key, message: msg.message }, 'buffer', {});
        if (!buf || !buf.length) return;
        const tmp = path.join('/tmp', `vn_${Date.now()}.ogg`);
        fs.writeFileSync(tmp, buf);
        const heard = await transcribeVoice(tmp);
        try { fs.unlinkSync(tmp); } catch {}
        if (!heard || !heard.text) {
          await reply(sock, jid, msg, '🎙 Suna to, par samajh nahi aaya. Ek baar phir saaf bolo 🙂');
          return;
        }
        const mapped = mapVoiceToCommand(heard.text);
        if (!mapped) {
          await reply(sock, jid, msg, `🎙 Suna: "${heard.text}"\n\nYe wali command samajh nahi aayi. ".menu" bolo ya likho 🙂`);
          return;
        }
        await reply(sock, jid, msg, `🎙 Samjha: "${heard.text}"`);
        text = mapped; // neeche normal command flow (prefix/rate-limit/owner-check) chalega
      } catch { return; }
    }

    // 💬 autoreply: is chat ke liye auto-reply set hai aur ye command nahi → jawab do
    if (await autoreplyHook(sock, msg, sender, jid)) return;

    if (!text.startsWith(config.prefix)) return;

    const [raw, ...args] = text.slice(config.prefix.length).trim().split(/\s+/);
    const cmd = commands[(raw || '').toLowerCase()];

    // 🎬 Demo videos: .dxxx → .xxx command ki demo video bhejo
    // (Boss ka order 2026-09-22: har command ki demo video, real feel)
    if (!cmd) {
      const dname = (raw || '').toLowerCase();
      if (dname.startsWith('d') && dname.length > 1) {
        const base = dname.slice(1);
        if (commands[base]) {
          const vpath = `demo-gen/videos/d${base}.mp4`;
          try {
            const vbuf = fs.readFileSync(vpath);
            await sock.sendMessage(jid, {
              video: vbuf, mimetype: 'video/mp4',
              caption: `🎬 *Demo: .${base}*\n_${commands[base].desc || ''}_\n\n— ${config.botName} 💗`
            }, { quoted: msg });
          } catch {
            await reply(sock, jid, msg, `🎬 *Demo: .${base}*\nVideo abhi tayyar ho rahi hai, thodi der mein try karein! 💗`);
          }
          return;
        } else {
          // .dxxx lekin xxx command maujood nahi — helpful message do, khamosh mat raho
          await reply(sock, jid, msg, `❌ *".${base}"* naam ki koi command nahi hai.\n\n🎬 Demo ke liye sahi format: *${config.prefix}d<command>*\nMasalan: *${config.prefix}dvv*, *${config.prefix}dmenu*, *${config.prefix}dsticker*\n\n📋 Poori list ke liye *${config.prefix}menu* likhein 💗`);
          return;
        }
      }
      return;
    }

    // self mode mein bhi .contact sab ke liye khula (owner se rabta)
    const cmdName = (raw || '').toLowerCase();
    if (MODE === 'self' && !isOwnerMsg(msg, sender, jid) && cmdName !== 'contact') return;

    if (cmd.owner && !isOwnerMsg(msg, sender, jid)) {
      if (cmd.silentDeny) return; // .oc jaisi secret: gair-owner ko khabar tak na ho
      await reply(sock, jid, msg, '❌ Ye command sirf owner ke liye hai.');
      return;
    }

    if (cmd.admin) {
      const err = await requireAdmin(sock, msg, sender);
      if (err) { await reply(sock, jid, msg, err); return; }
    }

    // ⬡ NEXUS: panic/lockdown/permission/plugin blocks
    const blk = NEXUS.cmdBlocked(cmdName, sender, jid, msg);
    if (blk === 'panic') { await reply(sock, jid, msg, '🔴 *PANIC MODE* — sirf owner ke commands chal rahe hain.'); return; }
    if (blk === 'lockdown') { await reply(sock, jid, msg, '🟠 *LOCKDOWN* — ye command abhi band hai.'); return; }
    if (blk === 'perm-owner') { await reply(sock, jid, msg, '🔐 Ye command owner-only hai.'); return; }
    if (blk === 'off' || blk === 'cat') { await reply(sock, jid, msg, '🚫 Ye command/module abhi disabled hai.'); return; }
    NEXUS.audit(cmdName, jid, sender);

    // Anti-ban: non-owner ko rate-limit karo (owner mustasna)
    if (!isOwnerMsg(msg, sender, jid)) {
      const rl = rateLimitCheck(sender);
      if (rl === 'slow' || rl === 'quota' || rl === 'muted') return; // khamoshi se ignore — spam nahi
      if (rl === 'quota-warn') {
        await reply(sock, jid, msg, '⚠️ *Zara aahista!* ⏳\n\nTum ne 5 minute mein 25 commands ki limit cross kar li hai. Thori dair ruk kar dobara try karo 💗\n\n🛡️ _Ye limit is liye hai taake WhatsApp hamara number *ban* na kar de — zyada tez istemal se sab ka bot band ho jayega._');
        return;
      }
      if (rl === 'muted-warn') {
        await reply(sock, jid, msg, '🚫 *Abhi break chal raha hai!*\n\nBar-bar limit torne par tum 10 minute ke liye mute ho. Thora sabar karo 💗');
        return;
      }
      if (rl === 'muted-new') {
        await reply(sock, jid, msg, '🚫 *10 minute ka break!*\n\nTum ne baar-baar limit tori hai, is liye 10 minute tak tumhare commands nahi chalenge.\n\n🛡️ _Zyada tez istemal se WhatsApp hamara number *ban* kar sakta hai — ye sab ki bhalai ke liye hai._');
        // 📢 Main owner ko ittila — kaun spam kar raha tha
        try {
          const ownerNum = String(config.owner || '').replace(/\D/g, '');
          if (ownerNum.length >= 7) {
            const who = String(sender || '').split('@')[0].replace(/:\d+$/, '').replace(/\D/g, '') || 'unknown';
            await sock.sendMessage(ownerNum + '@s.whatsapp.net', { text: `⚠️ *Spam alert* 🛡️\n\n*${who}* ne baar-baar command limit tori — 10 minute ke liye mute kar diya gaya.\n\n_Jaldi chhutkara dena ho to reply mein likhein:_ *.unmute* ${who}` });
          }
        } catch {}
        return;
      }
    }

    // Activity log: owner dekh sake kaun kya chala raha hai
    logActivity(sender, raw || '', jid);

    // ⚙️ presence: recording / typing (owner settings)
    try {
      if (getSetting('recording')) await sock.sendPresenceUpdate('recording', jid);
      else if (getSetting('autotyping')) await sock.sendPresenceUpdate('composing', jid);
    } catch {}

    // 💗 Har command par us ke mutabiq reaction — secret (hidden) par khamoshi
    if (!cmd.hidden) {
      try { await sock.sendMessage(jid, { react: { text: cmdReact(cmdName), key: msg.key } }); } catch {}
    }

    await cmd.run(sock, msg, args, { sender, jid });
  } catch (e) {
    console.error('[cmd error]', e.message);
  }
}

// ⬡ NEXUS PACK — build + register (Boss order 2026-09-23)
const NEXUS = buildNexus({ reply, chatComplete, askNexa, config, isOwner, isOwnerMsg, downloadMediaMessage, ctxOf, getText, num, commands, STATE, saveState });
Object.assign(commands, NEXUS.commands);

// 👥 GROUP KIT — group management commands (Boss order 2026-09-24)
const GROUPKIT = buildGroupKit({ reply, config, isOwner, isOwnerMsg, ctxOf, getText, num, downloadMediaMessage });
// ── 📊 Poll menu ke liye: buildMenu ke CURATED boxes se categories ──
// Har command SAHI category mein — regex guess nahi, Boss-approved menu (2026-09-27)
function getMenuCategories() {
  let fn = '';
  try { fn = buildMenu.toString(); } catch { return []; }
  const cats = [];
  const boxRe = /\$\{box\('([^']*)',\s*\[([\s\S]*?)\]\)\s*\}/g;
  let m;
  while ((m = boxRe.exec(fn))) {
    const label = m[1].trim();
    if (/APNA BOT BANWANA/i.test(label)) continue; // promo box skip
    const cmds = [];
    const cmdRe = /\$\{p\}([a-z0-9_]+)/gi;
    let cm;
    while ((cm = cmdRe.exec(m[2]))) { const n = cm[1].toLowerCase(); if (!cmds.includes(n)) cmds.push(n); }
    if (cmds.length) cats.push({ label, cmds });
  }
  return cats;
}

Object.assign(commands, GROUPKIT.commands);

// 🎯 NEXORA EXCLUSIVE PACK — Phase 1-3 (Boss order 2026-09-27)
const EXCLUSIVE = buildExclusive({ reply, config, isOwner, isOwnerMsg, ctxOf, getText, num, commands,
  handleMessage, pnDigitsOfLid, getMenuCategories,
  aiChatOn: (jid) => { try { if (!STATE.aichat || typeof STATE.aichat !== 'object' || Array.isArray(STATE.aichat)) STATE.aichat = {}; STATE.aichat[jid] = 'on'; saveState(); writeGlobalAichat(jid, 'on'); } catch {} },
});
Object.assign(commands, EXCLUSIVE.commands);

// ─── 💬 NEXORA WebChat bridge (bot side) ───
const { buildWebchat } = require('./webchat');
const WEBCHAT = buildWebchat({
  reply, askNexa, aiPrompt: (q, jid, sender) => NEXUS.aiPrompt(q, jid, sender),
  config, isOwnerMsg, num, getText, recordOwnMsgId, isOwnMsgId, transcribeVoice,
});
Object.assign(commands, WEBCHAT.commands);

module.exports = { commands, handleMessage, isOwner, buildMenu, getMenuCategories, sendFullMenu, askNexa, askBossChat, getMode: () => MODE, handleGroupUpdate, handleCallEvent, handleStatusBroadcast, recordOwnMsgId, isOwnMsgId, setKnownLids, saveLeadIn, saveLeadOut, markLeadRead, getLeadStats, getLeadInbox, getLeadThread, recordDisconnect, getDisconnected, getSetting, qiblaVideo, qiblaCompass, qiblaSVG, setCreactFanout, webchat: WEBCHAT, groupkit: GROUPKIT, handlePresenceUpdate, subscribeTrackedPresence, pnDigitsOfLid };
