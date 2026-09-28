// ─── NEXORA-MD · WhatsApp MD bot with web pairing ──────
// Flow: page par apna number dalo → 8-digit pairing code milega →
// WhatsApp > Linked devices > "Link a device" > "Link with phone number instead"
// mein code dalo → bot active. Session save rehti hai, dobara pair nahi karna.

const express = require('express');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('./config');
const { handleMessage, sendFullMenu, getMode, handleGroupUpdate, handleCallEvent, handleStatusBroadcast, recordOwnMsgId, setKnownLids, saveLeadIn, saveLeadOut, markLeadRead, getLeadStats, getLeadInbox, getLeadThread, recordDisconnect, getDisconnected, getSetting } = require('./lib/commands');
const { queuePanelPush } = require('./lib/panel-push'); // 📣 Owner Panel push notifications

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@chaeulso/baileys');
const { useRedisAuthState, makeRedisClient, redisConfigured } = require('./lib/redis-auth');
const QRCode = require('qrcode'); // /api/qr ke liye QR PNG data-URL banana
const { spawn } = require('child_process'); // multi-session: har number ke liye alag worker process

const log = pino({ level: 'info' });

// Proxy support: sandboxed networks block direct WSS — route the WA socket
// through the HTTPS proxy when one is configured (Baileys `agent` option).
let proxyAgent = null;
try {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyUrl) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    proxyAgent = new HttpsProxyAgent(proxyUrl);
    log.info('[net] using HTTPS proxy for WhatsApp socket');
  }
} catch (e) { log.warn({ err: String(e) }, '[net] proxy agent unavailable'); }

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sock = null;
let liveOpen = false; // HAQEEQI live connection — sirf 'open' event par true. sock.user akela jhooth bol sakta hai (stale creds).
let authState = null; // creds/state module scope mein — /api/pair yahi se check karega
let starting = false;
let lastPairingCode = null;
let lastCodeAt = 0;        // aakhri code kab issue hua (tez dobara-click guard)
let lastPairNumber = null; // wo number jis ke liye aakhri code issue hua
let pairQueue = [];        // GLOBAL FIFO: poori app mein ek waqt mein sirf ek requestPairingCode
let pairProcessing = false; // queue pump chal rahi hai ya nahi
const PAIR_JOB_TTL = 120000; // 120s se zyada queue mein para job stale → drop
let reconnectTimer = null;  // poori app mein sirf EK reconnect timer (overlap guard)
let throttleStreak = 0;     // lagatar 401-throttle count — backoff barhane ke liye
let pairPaceAt = 0;         // aakhri requestPairingCode kab hua (15s pacing)
let lastUserCutThrough = 0; // user-button ne backoff kab toda (90s mein sirf ek baar)
let cooldownUntil = 0;     // 401 ke baad reconnect backoff (pairing par koi rok nahi)
let blockCount = 0;        // 401 blocks ki ginti — har block par cooldown double
let lastCloseAt = 0;
let failStreak = 0;        // lagatar quick closes (reconnect storm guard)
let socketOpenedAt = 0;    // WS kab se musalsal open hai — pairing ke liye stability gate
let socketEpoch = 0;       // har socket close par +1 — purane socket ka code bekaar
let lastCodeEpoch = -1;    // aakhri code kis socket-epoch par issue hua
let identityEverOpened = false; // is identity ne kabhi HAQEEQI 'open' dekha (genuine link)
let lastQR = null;   // aakhri QR string (QR-pairing path ke liye)
let lastQRAt = 0;    // aakhri QR kab aaya
let qrEpoch = -1;    // aakhri QR kis socket-epoch ka hai
let bootRegistered = false; // process start par session/creds.json registered:true tha (restored linked session?)
let bootRegStrikes = 0;     // us restored session par lagatar 401-loggedOut count (3 par dead → auto-clear)
const IS_WORKER = !!process.env.WORKER; // multi-session worker process? (manager = main process)

// ─── SESSION_ID import (portal flow — JAWAD style) ───
// Pair portal se mili SESSION_ID (base64 creds.json) env mein do:
//   SESSION_ID="...." ./start.sh
// Sirf tab import hoti hai jab koi live registered session NA ho aur pehle
// kabhi import na hui ho (state.sessionIdImported) — taake dead session ka
// dobara-import loop na bane. Zabardasti: FORCE_SESSION_ID=1.
function maybeImportSessionId() {
  const sid = (process.env.SESSION_ID || '').trim();
  if (!sid) return;
  const statePath = process.env.STATE_FILE || path.join(__dirname, 'state.json');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  if (st.sessionIdImported && !process.env.FORCE_SESSION_ID) {
    log.info('[auth] SESSION_ID pehle import ho chuki — skip');
    return;
  }
  const sessDir = path.join(__dirname, config.sessionDir);
  const credsPath = path.join(sessDir, 'creds.json');
  let live = false;
  try { live = JSON.parse(fs.readFileSync(credsPath, 'utf8')).registered === true; } catch {}
  if (live) { log.info('[auth] live registered session hai — SESSION_ID import skip'); return; }
  try {
    const creds = JSON.parse(Buffer.from(sid, 'base64').toString('utf8'));
    if (!creds || typeof creds !== 'object' || !creds.noiseKey || !creds.signedIdentityKey) throw new Error('creds incomplete');
    try { fs.rmSync(sessDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(credsPath, JSON.stringify(creds));
    st.sessionIdImported = true;
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
    log.info('[auth] SESSION_ID import OK (portal flow) — ab seedha connect hoga, pairing nahi hogi');
  } catch (e) {
    log.warn('[auth] SESSION_ID import fail: ' + (e && e.message));
  }
}
maybeImportSessionId();

// Boot check: kya session pehle se REGISTERED linked session hai (backup restore)?
// Agar haan aur ye lagatar 401 de → device WhatsApp ki taraf se revoke ho chuka
// hai; 3 strikes par khud clear ho jayegi taake fresh identity ban sake.
try {
  const bootCreds = JSON.parse(fs.readFileSync(path.join(__dirname, config.sessionDir, 'creds.json'), 'utf8'));
  bootRegistered = !!(bootCreds && bootCreds.registered === true);
  if (bootRegistered) log.info('[auth] boot: REGISTERED session mili (restore?) — 401 aaya to dead-session check lagega');
} catch { /* koi session nahi / corrupt — fresh identity banegi */ }

// Har second WS ki asal haalat note karo (Baileys 'open' unpaired socket par
// kabhi fire nahi hota, is liye ws.isOpen hi sab se saccha signal hai).
setInterval(() => {
  if (sock?.ws?.isOpen) { if (!socketOpenedAt) socketOpenedAt = Date.now(); }
  else socketOpenedAt = 0;
}, 1000);

// 🟢 alwaysonline: owner ne on kiya ho to har 20s 'available' presence bhejo
// taake bot hamesha online dikhe (WhatsApp presence timeout se bachne ke liye).
setInterval(() => {
  try {
    if (getSetting('alwaysonline', false) && sock?.ws?.isOpen) {
      sock.sendPresenceUpdate('available').catch(() => {});
    }
  } catch {}
}, 20000);

// Logout endpoint ki hifazat ke liye random admin token (sirf server logs mein)
const ADMIN_TOKEN = crypto.randomBytes(16).toString('hex');

// Owner Panel internal token — stable, .internal_token file mein (chmod 600).
// Manager isay workers ko env mein deta hai; Nostr relay bhi isi file se parhta hai.
const INTERNAL_TOKEN_PATH = path.join(__dirname, '.internal_token');
let INTERNAL_TOKEN = '';
try { INTERNAL_TOKEN = String(fs.readFileSync(INTERNAL_TOKEN_PATH, 'utf8')).trim(); } catch {}
if (!/^[A-Za-z0-9_-]{16,}$/.test(INTERNAL_TOKEN)) {
  INTERNAL_TOKEN = crypto.randomBytes(24).toString('base64url');
  try { fs.writeFileSync(INTERNAL_TOKEN_PATH, INTERNAL_TOKEN, { mode: 0o600 }); } catch {}
}
const checkInternal = (req) => {
  const t = req.headers['x-internal-token'] || req.headers['x-admin-token'] || req.query.token;
  return t && (t === INTERNAL_TOKEN || t === ADMIN_TOKEN);
};
const localOnly = (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!/127\.0\.0\.1|::1/.test(ip)) { res.status(403).json({ error: 'local only' }); return false; }
  return true;
};

let clearAuthState = null; // session saaf karne wala fn (redis ya file — jo active ho)

// Auth state: Upstash Redis (Render, persistent) preferred —
// UPSTASH_REDIS_REST_URL/TOKEN na hon to local file auth fallback (default).
async function getAuthState() {
  if (redisConfigured()) {
    log.info('[auth] using Upstash Redis auth state');
    const { state, saveCreds, clearAll } = await useRedisAuthState(makeRedisClient());
    clearAuthState = clearAll;
    return { state, saveCreds };
  }
  log.info('[auth] using local file auth state');
  clearAuthState = async () => {
    try { fs.rmSync(config.sessionDir, { recursive: true, force: true }); } catch {}
  };
  // 🛡️ Crash-proof creds: koi crash saveCreds ke dauran process mare to aadhi
  // likhi/0-byte creds.json session WIPE kar deti hai (dobara pairing padti hai).
  // Har save se pehle healthy creds ka .bak rakho; boot par kharab file mile to
  // backup se wapas lao — session bach jati hai.
  const credsPath = path.join(config.sessionDir, 'creds.json');
  const credsBak = credsPath + '.bak';
  const backupCreds = () => {
    try {
      const cur = fs.readFileSync(credsPath, 'utf8');
      if (cur.trim().length > 10) { JSON.parse(cur); fs.copyFileSync(credsPath, credsBak); }
    } catch {}
  };
  try {
    const cur = fs.readFileSync(credsPath, 'utf8');
    JSON.parse(cur);
    if (cur.trim().length < 10) throw new Error('empty');
  } catch {
    try {
      const b = fs.readFileSync(credsBak, 'utf8');
      JSON.parse(b);
      fs.copyFileSync(credsBak, credsPath);
      log.warn('[auth] creds.json kharab/0-byte thi — backup se restore ki, dobara pairing nahi padegi');
    } catch {}
  }
  const mfs = await useMultiFileAuthState(config.sessionDir);
  const rawSave = mfs.saveCreds;
  const saveCreds = async () => { backupCreds(); return rawSave(); };
  return { state: mfs.state, saveCreds };
}

// Session saaf karo (logout / 401 par) — redis keys bhi delete hon.
async function clearSession() {
  try { if (clearAuthState) await clearAuthState(); }
  catch (e) { log.warn({ err: String(e) }, '[auth] session clear failed'); }
  try { fs.unlinkSync(path.join(config.sessionDir, '.welcome_sent')); } catch {}
  authState = null;
  identityEverOpened = false; // nayi identity — pehle kabhi link nahi hui
  bootRegistered = false; // restored-session ka dead-check reset
  bootRegStrikes = 0;
  lastPairingCode = null;
  lastCodeEpoch = -1;
}

// Har successful connect par session ka backup — agar creds corrupt hon
// to session-backup/ se wapas la sakte hain (dobara pair nahi karna padega)
function backupSession() {
  try {
    if (redisConfigured()) return; // redis khud persistent hai
    const src = path.join(__dirname, config.sessionDir);
    const dst = path.join(__dirname, 'session-backup');
    if (!fs.existsSync(src)) return;
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
    fs.writeFileSync(path.join(dst, '.backup_at'), new Date().toISOString());
    log.info('[auth] session backup saved');
  } catch (e) { log.warn({ err: String(e) }, '[auth] session backup failed'); }
}

// Pehli baar connect (fresh pairing) → apne "Message yourself" mein NEXORA banner + poori commands list
// Main bot: Boss ke Message yourself mein. Worker: CUSTOMER ke apne Message yourself mein
// (worker ka config.owner ASLI owner = Boss ka number hota hai, is liye worker ka apna
// number SESSION_DIR `s_<digits>` se nikalte hain — warna menu ghalat jagah jayega).
async function sendWelcomeOnce(sock) {
  try {
    const marker = path.join(config.sessionDir, '.welcome_sent');
    if (fs.existsSync(marker)) return;
    let selfDigits;
    if (IS_WORKER) {
      const m = String(config.sessionDir || '').match(/s_(\d+)/);
      selfDigits = m ? m[1] : null;
      // Fallback: live socket se apna number
      if (!selfDigits) {
        try { selfDigits = String(sock?.user?.id || '').split(':')[0].replace(/\D/g, ''); } catch {}
      }
    } else {
      selfDigits = String(config.owner || '').replace(/\D/g, '');
    }
    if (!selfDigits) return;
    const selfJid = selfDigits + '@s.whatsapp.net';
    const who = IS_WORKER ? 'worker/customer' : 'main/Boss';
    // Boss (2026-09-25): pehle chhota pyara welcome + banner, neeche .menu ka ishara (poora menu nahi)
    const BANNER = path.join(__dirname, 'assets', 'nexora-banner.jpg');
    const caption = `🎉 *NEXORA-MD mein khush aamdeed!* 💗\n\nAssalam o Alaikum! Main *Nexa* hoon ✨\nAap *NEXORA-MD* ke saath connect ho gaye ho — aapka bot ab live hai! 🚀\n\n*Saare commands dekhne ke liye:*\n👉 *.menu* likh kar bhejein\n\n💡 Madad chahiye? *.help* likhein\n\n— *Nexa* 💗`;
    try {
      if (fs.existsSync(BANNER)) await sock.sendMessage(selfJid, { image: fs.readFileSync(BANNER), caption });
      else await sock.sendMessage(selfJid, { text: caption });
    } catch {}
    fs.writeFileSync(marker, Date.now().toString());
    log.info(`[wa] welcome sent to self (${who}): ${selfJid}`);
  } catch (e) { log.warn({ err: String(e) }, '[wa] welcome failed'); }
}

// --- WhatsApp connection ------------------------------------
async function connectWA() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await getAuthState();
    authState = state;
    // NOTE: fetchLatestWaWebVersion (asal current WA Web version) istemal karo —
    // fetchLatestBaileysVersion purana version deta hai jis par WhatsApp
    // "Couldn't link device" keh kar pairing refuse kar deta hai.
    const { version } = await fetchLatestWaWebVersion();
    // NOTE (2026-09-21): custom platform name ['NEXORA-MD', ...] par WhatsApp
    // fresh registrations ko 401 de kar refuse kar raha tha ("Couldn't link
    // device"). 16:54 ko macOS/Chrome par kamyab link hua tha — is liye wapas
    // standard identity. Bot ka naam/menu/persona phir bhi NEXORA-MD hai.
    const browser = Browsers.macOS('Chrome');
    log.info(`[wa] version ${version.join('.')} | browser ${browser.join(' ')}`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser,
      markOnlineOnConnect: true,
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    });

    sock.ev.on('creds.update', saveCreds);

    // ⚙️ settings hooks: welcome/goodbye/adminaction + anticall
    sock.ev.on('group-participants.update', (u) => handleGroupUpdate(sock, u).catch(() => {}));
    sock.ev.on('call', (calls) => handleCallEvent(sock, calls).catch(() => {}));

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect } = u;
      log.info({ connection }, '[wa] connection.update');
      // QR capture (QR-pairing path): WhatsApp har ~20s naya QR bhejta hai —
      // taaza tareen wala hamesha note rakho taake /api/qr de sake.
      if (u.qr) { lastQR = u.qr; lastQRAt = Date.now(); qrEpoch = socketEpoch; }
      if (connection === 'open') {
        log.info(`[wa] Connected as ${sock?.user?.id}`);
        liveOpen = true;
        try { require('./lib/commands').webchat.setSock(sock); } catch {} // WebChat queue: pehle msg ka intezaar nahi
        if (!IS_WORKER) { try { require('./lib/commands').subscribeTrackedPresence(sock); } catch {} } // 🟢 .track: tracked numbers subscribe
        identityEverOpened = true; // is identity ne genuine link dekha — ab 401 = revoke
        bootRegistered = false; // session zinda hai — restored-dead check khatam
        bootRegStrikes = 0;
        lastPairingCode = null;
        lastQR = null; // link ho gaya — QR bekaar
        failStreak = 0;
        blockCount = 0;
        throttleStreak = 0;
        cooldownUntil = 0;
        backupSession(); // session ka fresh backup
        // LID cache: owner + workers ke PN→LID resolve karo taake LID-only
        // messages mein bhi owner/apne sessions pehchane jayein (silent personal chats).
        const cacheLids = async (attempt) => {
          try {
            const lm = sock.signalRepository?.lidMapping;
            if (!lm?.getLIDForPN) { if (attempt < 3) setTimeout(() => cacheLids(attempt + 1), 30000); return; }
            const fullDigits = (v) => String(v || '').replace(/\D/g, '');
            const shortDigits = (v) => fullDigits(v).slice(-10);
            const map = {};
            const pns = new Set();
            if (process.env.OWNER_NUMBER) pns.add(fullDigits(process.env.OWNER_NUMBER));
            try {
              const reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sessions', 'registry.json'), 'utf8'));
              for (const k of Object.keys(reg || {})) pns.add(fullDigits(k));
            } catch {}
            for (const pn of pns) {
              if (pn.length < 7) continue;
              try {
                const lid = await lm.getLIDForPN(pn + '@s.whatsapp.net');
                const ld = shortDigits(lid);
                if (ld.length >= 7 && ld !== shortDigits(pn)) map[shortDigits(pn)] = ld;
              } catch {}
            }
            if (Object.keys(map).length) { setKnownLids(map); log.info('[lid] cache: ' + Object.keys(map).length + ' mappings'); }
            else if (attempt < 3) setTimeout(() => cacheLids(attempt + 1), 30000);
          } catch (e) { log.warn('[lid] cache fail: ' + (e?.message || e)); }
        };
        cacheLids(0);
        // Fresh pairing → owner inbox mein welcome (banner + menu)
        sendWelcomeOnce(sock).catch(() => {});
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        log.warn({ code, loggedOut }, '[wa] connection closed');
        sock = null;
        socketEpoch++; // is socket ka code/QR ab bekaar — dobara mangne par FRESH milega
        lastQR = null;
        liveOpen = false;
        starting = false;
        const now = Date.now();
        const quickClose = now - lastCloseAt < 15000;
        lastCloseAt = now;
        failStreak = quickClose ? failStreak + 1 : 0;
        if (loggedOut) {
          // 401 = teen surat:
          // (a) PENDING CODE — user abhi code daal raha hai (2 min ke andar code
          //     issue hua) → session WIPNA MANA HAI, warna code bekaar.
          // (b) DEAD SESSION — ye identity kabhi HAQEEQI 'open' dekh chuki hai
          //     (genuine link hua tha) aur ab WhatsApp 401 de raha hai = device
          //     revoke/unlink ho gaya. Ye session KABHI connect nahi hoga —
          //     foran saaf karo taake fresh identity baney.
          //     (Purana code sirf 'creds.me' dekhta tha — magar requestPairingCode
          //     bhi creds.me likh deta hai, is liye throttle ko ghalat "dead"
          //     samajh kar session wipe ho jati thi. Ab sirf everOpened = dead.)
          // (c) FRESH THROTTLE — nayi identity par WhatsApp ki rok → session
          //     rakho, quiet exponential backoff (60s→2m→4m→8m→10m cap).
          const codePending = now - lastCodeAt < 120000;
          blockCount += 1;
          let backoffSec;
          if (codePending) {
            throttleStreak += 1;
            backoffSec = Math.min(60 * Math.pow(2, throttleStreak - 1), 600);
            log.warn(`[wa] 401 aaya magar code pending hai (user daal raha ho sakta hai) — session KEPT. ${backoffSec}s backoff.`);
          } else if (identityEverOpened) {
            await clearSession();
            throttleStreak = 0;
            backoffSec = 60;
            log.warn(`[wa] 401 — DEAD session (device revoke/unlink ho gaya tha), session cleared #${blockCount}. Fresh identity par 60s baad retry. Pair dobara karein.`);
          } else {
            throttleStreak += 1;
            // RESTORED-DEAD check: boot par ye session REGISTERED thi (backup se
            // restore), kabhi 'open' nahi hui aur lagatar 401 de rahi hai →
            // device WhatsApp ki taraf se REVOKE ho chuka hai, ye throttle nahi.
            // 3 strikes par khud clear ho jao taake fresh identity ban kar nayi
            // pairing ka rasta khule (warna hamesha 401 loop mein phansi rahegi).
            if (bootRegistered && !identityEverOpened) bootRegStrikes += 1;
            // DEEP QUIET: lagatar 5+ throttle aur koi user code pending nahi —
            // WhatsApp ko lambi saans lene do. Har retry rok ko lamba karta hai,
            // is liye 45 min khamoshi. User ka button (/api/pair cut-through)
            // phir bhi foran attempt kar sakta hai.
            const recentUserAction = Date.now() - lastCodeAt < 10 * 60 * 1000;
            if (bootRegistered && !identityEverOpened && bootRegStrikes >= 3) {
              log.warn(`[wa] restored session ${bootRegStrikes} lagatar 401 — REVOKED/dead hai. Session clear, fresh identity banegi.`);
              await clearSession(); // bootRegistered/bootRegStrikes reset ho jayenge
              throttleStreak = 0;
              backoffSec = 60;
            } else if (throttleStreak >= 5 && !recentUserAction && !identityEverOpened && !bootRegistered) {
              backoffSec = 45 * 60;
              log.warn(`[wa] DEEP QUIET — ${throttleStreak} lagatar 401, koi user action nahi. 45 min khamoshi taake WhatsApp ki rok khule.`);
            } else {
              backoffSec = Math.min(60 * Math.pow(2, throttleStreak - 1), 600);
              const tag = bootRegistered ? `restored session strike ${bootRegStrikes}/3` : 'fresh identity';
              log.warn(`[wa] 401 throttle #${throttleStreak} (${tag}) — session KEPT. ${backoffSec}s quiet backoff.`);
            }
          }
          cooldownUntil = now + backoffSec * 1000;
          scheduleReconnect(backoffSec * 1000 + 5000);
        } else if (Date.now() < cooldownUntil) {
          // 60s backoff ke dauran socket ko haath mat lagao; phir ek reconnect.
          const wait = cooldownUntil - Date.now() + 5000;
          log.warn(`[wa] 60s backoff — reconnect single timer par`);
          scheduleReconnect(wait);
        } else {
          // Unpaired socket ka idle-close (408) normal hai — lekin code pending ho
          // to foran reconnect karo (5s): phone abhi isi code se pairing kar
          // raha ho sakta hai; door rehne se code bekaar ho jata hai aur phone
          // ghumta rehta hai. Bina code ke normal 3s.
          const sinceCode = now - lastCodeAt;
          let delay = 3000;
          if (sinceCode < 3 * 60 * 1000) delay = 5000;
          if (failStreak >= 3) delay = Math.max(delay, 30000);
          scheduleReconnect(delay);
        }
      }
    });

    // Hamare bot ke bheje hue har msg ka ID record karo — doosra session
    // jab wahi msg dekhe to autoAI us par jawab nahi degi (bot-to-bot echo band, LID-proof)
    try {
      const _origSend = sock.sendMessage.bind(sock);
      sock.sendMessage = async (...a) => {
        const r = await _origSend(...a);
        try { if (r?.key?.id) recordOwnMsgId(r.key.id); } catch {}
        return r;
      };
    } catch {}

    sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const m of messages) {
        if (m.key?.remoteJid === 'status@broadcast') { handleStatusBroadcast(sock, m); continue; }
        handleMessage(sock, m); // fromMe bhi — owner apne phone se command de sakta hai
      }
    });
    // 📊 EXCLUSIVE Phase 2b: poll votes — is fork mein votes messages.upsert mein
    // pollUpdateMessage (encrypted) ban kar aate hain; messages.update rasta band hai
    sock.ev.on('messages.upsert', ({ messages }) => { try { require('./lib/exclusive').handlePollVote(sock, messages || []).catch(() => {}); } catch {} });
    if (!IS_WORKER) {
      // 🟢 .track online tracker (sirf manager — workers se duplicate khabar nahi)
      sock.ev.on('presence.update', (u) => { try { require('./lib/commands').handlePresenceUpdate(sock, u); } catch {} });
    }
  } catch (e) {
    log.error(e, '[wa] connect failed');
    sock = null;
  } finally {
    starting = false;
  }
}

// SINGLE RECONNECT TIMER: poori app mein ek hi timer. Purana timer ho to pehle
// clear karo, phir naya lagao — overlapping reconnects WhatsApp ko spam karte
// hain aur throttle barhate hain. Timer fire par cooldown baqi hua to dobara
// schedule (reconnect kabhi lost nahi hota, kabhi double nahi hota).
function scheduleReconnect(delayMs) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const wait = Math.max(0, Math.round(delayMs));
  log.info(`[wa] reconnect ${Math.ceil(wait / 1000)}s mein (single timer)`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (Date.now() >= cooldownUntil - 1000) connectWA();
    else scheduleReconnect(cooldownUntil - Date.now() + 1000);
  }, wait);
}

// --- API -----------------------------------------------------

// Socket tab tak wait karo jab tak WhatsApp ka WS waqai OPEN na ho.
// Pairing code sirf live socket par mangwana chahiye — warna "Connection Closed".
async function waitForOpenSocket(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (sock?.ws?.isOpen) return sock;
    // Cooldown mein reconnect bilkul nahi — warna block lamba hota hai.
    if (!sock && !starting && Date.now() >= cooldownUntil) connectWA();
    await new Promise((r) => setTimeout(r, 1000));
  }
  return sock?.ws?.isOpen ? sock : null;
}

function cooldownInfo() {
  const ms = Math.max(0, cooldownUntil - Date.now());
  return { cooldownSeconds: Math.ceil(ms / 1000), coolingDown: ms > 0 };
}

app.get('/api/status', (req, res) => {
  const connected = liveOpen; // sirf HAQEEQI 'open' — stale creds par jhooth nahi
  const cd = cooldownInfo();
  const sockUp = !!(sock?.ws?.isOpen);
  res.json({
    connected,
    user: liveOpen ? sock?.user?.id || null : null,
    botName: config.botName,
    needsPairing: !connected,
    hasOwner: !!config.owner,
    canPair: !connected,
    cooldownSeconds: cd.cooldownSeconds,
    socketLive: sockUp,
    socketStable: !!(sockUp && socketOpenedAt && Date.now() - socketOpenedAt >= 10000),
    // aakhri code abhi WhatsApp mein daalne ke qabil hai ya bekaar ho chuka
    codeAlive: !!(lastPairingCode && lastCodeEpoch === socketEpoch && sockUp && Date.now() - lastCodeAt < 90000),
    // QR scan ke qabil hai ya nahi (page ka QR tab isi se chalta hai)
    qrReady: !!(lastQR && qrEpoch === socketEpoch && sockUp && Date.now() - lastQRAt < 45000),
    // multi-session: ye process manager hai ya worker (jitne marzi numbers)
    multi: !IS_WORKER,
    isWorker: IS_WORKER,
    // bot ka mode: public (sab) ya self (sirf connected number)
    mode: (() => { try { return getMode(); } catch { return 'public'; } })(),
  });
});

// Pairing code — body: { number: "923001234567" }
// GLOBAL PAIRING QUEUE — FIFO. Ek waqt mein sirf ek job chalti hai, baqi
// line mein khari rehti hain. Stale (120s+) jobs drop ho jati hain taake
// queue kabhi atak kar na reh jaye.
function enqueuePairing(number, jobFn) {
  const now = Date.now();
  while (pairQueue.length && now - pairQueue[0].queuedAt > PAIR_JOB_TTL) {
    const stale = pairQueue.shift();
    stale.reject({ status: 503, friendly: 'Request expire ho gayi — dobara try karein.' });
  }
  return new Promise((resolve, reject) => {
    pairQueue.push({ number, jobFn, resolve, reject, queuedAt: now });
    pumpPairQueue();
  });
}

async function pumpPairQueue() {
  if (pairProcessing) return;
  pairProcessing = true;
  try {
    while (pairQueue.length) {
      const j = pairQueue.shift();
      if (Date.now() - j.queuedAt > PAIR_JOB_TTL) {
        j.reject({ status: 503, friendly: 'Request expire ho gayi — dobara try karein.' });
        continue;
      }
      try {
        j.resolve(await j.jobFn());
      } catch (e) {
        j.reject(e);
      }
    }
  } finally {
    pairProcessing = false;
  }
}

// ─── 🎫 Demo/Perm link API (Boss ka trial system) ───
const DEMO_LINKS_PATH_API = path.join(__dirname, 'demo-links.json');
function loadDemoLinksApi() {
  try { const o = JSON.parse(fs.readFileSync(DEMO_LINKS_PATH_API, 'utf8')); return (o && typeof o === 'object') ? o : {}; }
  catch { return {}; }
}
function saveDemoLinksApi(o) {
  try { fs.writeFileSync(DEMO_LINKS_PATH_API, JSON.stringify(o, null, 1)); } catch {}
}
// Demo/perm page token validate karegi
app.get('/api/demo/validate', (req, res) => {
  const token = String(req.query.token || '').trim();
  const kind = String(req.query.kind || 'demo').trim(); // demo | perm
  const links = loadDemoLinksApi();
  const l = links[token];
  if (!l || l.status !== 'active') return res.json({ ok: false, error: 'Ye link khatam ho gaya hai ya ghalat hai.' });
  if (kind === 'perm' && l.type !== 'perm') return res.json({ ok: false, error: 'Ghalat link.' });
  if (kind === 'demo' && l.type !== 'demo') return res.json({ ok: false, error: 'Ghalat link.' });
  if (l.type === 'demo') {
    if (l.pairedNumber) return res.json({ ok: false, error: 'Ye demo link pehle istemal ho chuka hai.' });
    return res.json({ ok: true, type: 'demo', durationMin: l.durationMin });
  }
  // perm
  return res.json({ ok: true, type: 'perm', lockedNumber: l.lockedNumber, paired: !!l.pairedAt });
});
// Pairing page: number check (perm ke liye locked number verify)
app.post('/api/demo/check', (req, res) => {
  const token = String(req.body?.token || '').trim();
  const kind = String(req.body?.kind || 'demo').trim();
  const number = String(req.body?.number || '').replace(/\D/g, '');
  const links = loadDemoLinksApi();
  const l = links[token];
  if (!l || l.status !== 'active') return res.status(400).json({ ok: false, error: 'Ye link khatam ho gaya hai.' });
  if (l.type === 'perm' && l.lockedNumber !== number && l.lockedNumber !== number.slice(-10))
    return res.status(403).json({ ok: false, error: `❌ Ye link sirf ${l.lockedNumber} number ke liye hai 💗` });
  if (l.type === 'demo' && l.pairedNumber)
    return res.status(400).json({ ok: false, error: 'Ye demo link pehle istemal ho chuka hai.' });
  return res.json({ ok: true });
});
// Pairing kamyab hui (page poll karke batayegi) → demo timer start
app.post('/api/demo/paired', (req, res) => {
  const token = String(req.body?.token || '').trim();
  const number = String(req.body?.number || '').replace(/\D/g, '');
  const links = loadDemoLinksApi();
  const l = links[token];
  if (!l || l.status !== 'active') return res.status(400).json({ ok: false });
  if (l.type === 'demo') {
    if (l.pairedNumber) return res.json({ ok: true, already: true });
    l.pairedNumber = number; l.pairedAt = Date.now();
    l.expiresAt = Date.now() + (l.durationMin * 60000);
    saveDemoLinksApi(links);
    return res.json({ ok: true, expiresAt: l.expiresAt });
  }
  l.pairedAt = Date.now(); l.pairedNumber = number;
  saveDemoLinksApi(links);
  return res.json({ ok: true, permanent: true });
});

app.post('/api/pair', async (req, res) => {
  try {
    const number = String(req.body?.number || '').replace(/\D/g, '');
    if (number.length < 10 || number.length > 15) {
      return res.status(400).json({ error: 'Sahi number likhein (country code ke saath, bina + ke). Masalan: 923001234567' });
    }
    // NOTE (Boss ka hukm): pairing sab ke liye khuli hai — koi owner-number
    // lock nahi. Jo number page par likhega, bot usi se pair hoga.
    // MULTI-SESSION: ek process = ek WhatsApp account (WhatsApp ka rule).
    // Main apne number se linked hai aur koi AUR number aaya → us ke liye
    // alag worker process uthao, code wahan se lao. Har account ka apna bot.
    const myUser = (liveOpen && sock?.user) ? String(sock.user.id).split(':')[0].replace(/\D/g, '') : null;
    if (myUser && myUser === number) return res.json({ alreadyConnected: true, user: sock.user.id });
    if (!IS_WORKER && myUser && myUser !== number) {
      try {
        const entry = await spawnWorker(number);
        try { // warmup wala worker ab asal pairing mein lag gaya — reap se bachao
          const reg2 = readRegistry();
          if (reg2[number] && !reg2[number].usedAt) { reg2[number].usedAt = Date.now(); writeRegistry(reg2); }
        } catch {}
        const wr = await fetch(`http://127.0.0.1:${entry.port}/api/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ number }),
          signal: AbortSignal.timeout(170000),
        });
        const wj = await wr.json().catch(() => ({}));
        return res.status(wr.status).json(wj);
      } catch (e) {
        return res.status(e?.status || 500).json({ error: e?.friendly || 'Session worker se code nahi mil saka — dobara koshish karein.' });
      }
    }

    // NOTE (Boss ka hukm): koi cooldown/block gate nahi — 401 aaya to seedha
    // WhatsApp ka jawab user tak jayega, apni taraf se koi "N min ruko" nahi.
    const now = Date.now();

    // 90 second ke andar dobara click — pehla code abhi valid hai, wahi do
    // (sirf usi number ke liye jis ke liye code nikla tha, AUR sirf usi socket
    // par jo abhi zinda hai — socket girne par WhatsApp purana code bekaar
    // kar deta hai, is liye epoch mismatch par hamesha FRESH code issue karo)
    if (lastPairingCode && lastPairNumber === number && now - lastCodeAt < 90000
        && lastCodeEpoch === socketEpoch && sock?.ws?.isOpen) {
      return res.json({ code: lastPairingCode, reused: true, expiresIn: 75 });
    }

    // GLOBAL QUEUE (neeche enqueuePairing): poori app mein ek waqt mein sirf
    // ek requestPairingCode — alag numbers ki parallel requests aapas mein
    // takrati thin (doosra code pehle ko bekaar kar deta tha). Ab FIFO.
    let code;
    try {
      code = await enqueuePairing(number, async () => {
      // USER CUT-THROUGH: user ne khud button dabaya — backoff ke bawajood
      // foran ek attempt ki ijazat (90s mein sirf ek baar, taake button-mash
      // se WhatsApp ki rok lambi na ho).
      if (Date.now() - lastUserCutThrough > 90000) {
        lastUserCutThrough = Date.now();
        cooldownUntil = 0;
      }
      if (!sock && !starting && Date.now() >= cooldownUntil) connectWA();
      // CUT-THROUGH RECONNECT (2026-09-22): user abhi button daba kar wait kar
      // raha hai — purana backoff timer tor kar FORAN reconnect karo. Warna
      // 401-dead-session ke baad 65s backoff mein 25s wait kar ke "tayar nahi"
      // error aa jata hai (user ko dobara dabana parta hai). connectWA() ka
      // 'starting' guard duplicate socket rokta hai; stale timer clear karne
      // se open socket par dobara connect ka khatra bhi khatam.
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (!sock?.ws?.isOpen && !starting) connectWA();
      // Fresh spawn/boot mein node + WhatsApp connect mein 20-40s lag sakte
      // hain — 25s par haar manne ke bajaye 60s tak wait karo. User ke liye
      // thora aur wait, error se behter hai.
      const ready = await waitForOpenSocket(60000);
      if (!ready) {
        throw { status: 503, friendly: 'WhatsApp link abhi tayar nahi ho saka — 15 second ruk kar dobara dabayein (button ko baar-baar mat dabayein).' };
      }

      // STABILITY GATE (v2.2): socket kam-se-kam 10 second se musalsal open ho —
      // flapping socket par code issue karne se phone par "could not link" aata
      // hai aur WhatsApp 401 block laga deta hai. Yahi pichli baar hua tha.
      {
        const t1 = Date.now();
        let stable = false;
        while (Date.now() - t1 < 30000) {
          const sf = socketOpenedAt ? Date.now() - socketOpenedAt : 0;
          if (sock?.ws?.isOpen && sf >= 10000) { stable = true; break; }
          if (!sock?.ws?.isOpen) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        if (!stable) {
          throw { status: 503, friendly: 'WhatsApp link abhi stable nahi — 15 second ruk kar dobara dabayein (button ko baar-baar mat dabayein).' };
        }
      }

      if (authState?.creds?.registered) return 'ALREADY';

      // PACING: do requestPairingCode calls mein kam-se-kam 15s waqfa —
      // tez requests par WhatsApp 401 throttle lagata hai.
      const paceWait = 15000 - (Date.now() - pairPaceAt);
      if (paceWait > 0) await new Promise((r) => setTimeout(r, paceWait));
      pairPaceAt = Date.now();

      const c = await sock.requestPairingCode(number);
      lastPairingCode = c;
      lastPairNumber = number;
      lastCodeAt = Date.now();
      lastCodeEpoch = socketEpoch; // ye code isi socket par valid hai
      throttleStreak = 0; // code mil gaya → throttle toota, backoff reset
      log.info({ number: number.slice(0, 4) + '***' }, '[wa] pairing code issued');
      return c;
      });
    } catch (e) {
      return res.status(e?.status || 500).json({ error: e?.friendly || 'Pairing code nahi mil saka' });
    }
    if (code === 'ALREADY') return res.json({ alreadyConnected: true });
    res.json({ code, expiresIn: 75 });
  } catch (e) {
    log.error(e, '[wa] pairing failed');
    const m = e.message || '';
    const friendly = /Connection Closed|428|Precondition/i.test(m)
      ? 'WhatsApp link abhi tayar nahi — 10 second ruk kar dobara dabayein (button ko baar-baar mat dabayein).'
      : 'Pairing code nahi mil saka: ' + (m || 'unknown error');
    res.status(500).json({ error: friendly });
  }
});

// CODE-ALIVE: page har 8s poochta hai — code abhi valid hai ya mar gaya?
// (socket girne/reconnect hone par purana code bekaar ho jata hai aur phone
// ghumta rehta hai — user ko foran pata chalna chahiye, na ke infinite spin.)
app.get('/api/pair-alive', async (req, res) => {
  try {
    const number = String(req.query?.number || '').replace(/\D/g, '');
    if (!number) return res.status(400).json({ error: 'bad number' });
    const myUser = (liveOpen && sock?.user) ? String(sock.user.id).split(':')[0].replace(/\D/g, '') : null;
    if (!IS_WORKER && myUser && myUser !== number) {
      const reg = readRegistry();
      const entry = reg[number];
      if (!entry) return res.json({ alive: false, registered: false, reason: 'no-worker' });
      try {
        const wr = await fetch(`http://127.0.0.1:${entry.port}/api/pair-alive?number=${encodeURIComponent(number)}`,
          { signal: AbortSignal.timeout(10000) });
        return res.status(wr.status).json(await wr.json().catch(() => ({})));
      } catch { return res.json({ alive: false, registered: false, reason: 'worker-down' }); }
    }
    const registered = !!(authState?.creds?.registered);
    const alive = !registered && !!(lastPairingCode && lastPairNumber === number
      && Date.now() - lastCodeAt < 180000
      && lastCodeEpoch === socketEpoch && sock?.ws?.isOpen);
    return res.json({ alive, registered, number });
  } catch (e) { return res.status(500).json({ error: 'fail' }); }
});

// WARMUP (Boss ka hukm: code mein koi delay na ho) — pairing page number
// likhte hi bhejta hai. Naye number ka worker pehle se spawn karke uska
// WhatsApp socket connect karwana shuru kar deta hai, taake "Code Hasil Karo"
// dabane par socket pehle se tayar ho aur code foran mile (naye socket ka
// ~15s handshake user ke number likhne ke dauran hi ho chuka hota hai).
// Koi pairing-code request NAHI hoti — sirf tayari, is liye WhatsApp ki
// pacing/throttle par koi asar nahi.
app.post('/api/warmup', async (req, res) => {
  try {
    if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
    const number = String(req.body?.number || '').replace(/\D/g, '');
    if (number.length < 10 || number.length > 15) return res.status(400).json({ error: 'bad number' });
    const myUser = (liveOpen && sock?.user) ? String(sock.user.id).split(':')[0].replace(/\D/g, '') : null;
    if (myUser && myUser === number) return res.json({ ready: true });
    if (myUser && myUser !== number) {
      try {
        const entry = await spawnWorker(number);
        const reg = readRegistry();
        if (reg[number] && !reg[number].usedAt && !reg[number].warmedAt) {
          reg[number].warmedAt = Date.now();
          writeRegistry(reg);
        }
        return res.json({ warming: true, port: entry.port });
      } catch (e) {
        return res.status(e?.status || 500).json({ error: e?.friendly || 'warmup fail' });
      }
    }
    // Main socket abhi linked nahi — warmup ka faida nahi, seedha pair karega.
    return res.json({ ready: false });
  } catch (e) {
    return res.status(500).json({ error: 'warmup fail' });
  }
});

// QR pairing — WhatsApp > Linked devices > "Link a device" se QR scan karo.
// Research (Baileys #2691/#2702): jahan pairing-code par WhatsApp 401-throttle
// laga de, wahan QR usi IP/server par kaam kar sakta hai — is liye pairing page
// par dono raste hain. QR har ~20s refresh hota hai; page poll karke naya leta rahe.
app.get('/api/qr', async (req, res) => {
  try {
    if (liveOpen && sock?.user) return res.json({ alreadyConnected: true, user: sock.user.id });
    const now = Date.now();
    // USER CUT-THROUGH: user ne khud QR manga — /api/pair wali hi policy
    // (90s mein sirf ek baar backoff toro, taake button-mash rok na barhaye).
    if (now - lastUserCutThrough > 90000) { lastUserCutThrough = now; cooldownUntil = 0; }
    if (!sock && !starting && now >= cooldownUntil) connectWA();
    const ready = await waitForOpenSocket(25000);
    if (!ready) return res.status(503).json({ error: 'WhatsApp link tayar nahi — thori dair baad dobara koshish karein.' });
    // QR ka intezar (max ~20s)
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (lastQR && qrEpoch === socketEpoch && sock?.ws?.isOpen && Date.now() - lastQRAt < 45000) break;
      await new Promise((r) => setTimeout(r, 1000));
      if (!sock?.ws?.isOpen) break;
    }
    if (!(lastQR && qrEpoch === socketEpoch && sock?.ws?.isOpen && Date.now() - lastQRAt < 45000)) {
      return res.status(503).json({ error: 'QR tayar nahi ho saka — page refresh karke dobara koshish karein.' });
    }
    const dataUrl = await QRCode.toDataURL(lastQR, { width: 320, margin: 1 });
    res.json({ qr: dataUrl, expiresIn: 20 });
  } catch (e) {
    log.error(e, '[wa] qr failed');
    res.status(500).json({ error: 'QR nahi mil saka' });
  }
});

// Probe — WhatsApp throttle check (sirf localhost se). Ek connect attempt
// taake pata chale rok khuli ya nahi. Cron har ~40 min mein bulata hai;
// user ka pairing button bhi isi tarah cut-through karta hai.

app.post('/api/probe', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || '';
  if (!/127\.0\.0\.1|::1/.test(ip)) return res.status(403).json({ error: 'local only' });
  if (liveOpen) return res.json({ ok: true, alreadyConnected: true });
  cooldownUntil = 0; // deep quiet ko ek baar toro — sirf is probe ke liye
  if (!sock && !starting) connectWA();
  res.json({ ok: true, probing: true });
});

// Logout — sirf admin token ke saath (server logs mein milta hai)
app.post('/api/logout', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Admin token ghalat hai.' });
  try { if (sock) await sock.logout(); } catch {}
  await clearSession();
  sock = null;
  res.json({ ok: true });
});

// ─── Secret owner backend: .accounts / .disconnect (localhost-only) ───
// Ye endpoints sirf 127.0.0.1 par bind hain — bahar se koi nahi pahunch sakta.
// Commands menu mein NAHI hain (hidden), sirf owner chala sakta hai.
async function probeWorkerStatus(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
app.get('/api/accounts', async (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  let mainNum = '';
  try { mainNum = (liveOpen && sock?.user) ? String(sock.user.id).split(':')[0].replace(/\D/g, '') : (config.owner || ''); } catch {}
  const out = { main: { number: mainNum, connected: !!liveOpen, mode: (() => { try { return getMode(); } catch { return 'public'; } })(), port: config.port }, workers: [] };
  const reg = readRegistry();
  for (const digits of Object.keys(reg)) {
    const e = reg[digits] || {};
    const st = await probeWorkerStatus(e.port);
    out.workers.push({
      number: digits, port: e.port,
      connected: !!(st && st.connected), socketStable: !!(st && st.socketStable),
      mode: (st && st.mode) || '-', pidAlive: pidAlive(e.pid),
    });
  }
  res.json(out);
});

// ─── 👥 Owner Panel API (manager only · localhost + internal/admin token) ───
// Worker .contact lead bhejta hai; panel yahin se stats/inbox parhta hai aur
// reply bhejta hai (manager sahi worker ke zariye WhatsApp par bhejta hai).
app.post('/api/owner/lead', (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  const { userJid, name, phone, worker, text } = req.body || {};
  if (!userJid || !text) return res.status(400).json({ error: 'userJid+text chahiye' });
  const ok = saveLeadIn({ userJid, name, phone, worker, text });
  // 📣 Naya lead → Owner Panel (khula ho to) foran notification
  if (ok) queuePanelPush({ type: 'new_lead', name: String(name || 'Unknown').slice(0, 60), phone: String(phone || ''), worker: String(worker || ''), text: String(text || '').slice(0, 140), jid: String(userJid) });
  res.json({ ok });
});
app.get('/api/owner/stats', (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  res.json({ ok: true, stats: getLeadStats() });
});
app.get('/api/owner/inbox', (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  res.json({ ok: true, inbox: getLeadInbox() });
});
app.get('/api/owner/thread', (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  const jid = String(req.query.jid || '');
  const messages = getLeadThread(jid);
  if (!messages) return res.status(404).json({ error: 'user nahi mila' });
  markLeadRead(jid);
  res.json({ ok: true, jid, messages });
});
// ─── Owner Panel: connected accounts + disconnect (sirf worker accounts) ───
// Main/owner account ko panel se disconnect NAHI kar sakte — ghalti se bhi nahi.
app.get('/api/owner/accounts', async (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  let mainNum = '';
  try { mainNum = (liveOpen && sock?.user) ? String(sock.user.id).split(':')[0].replace(/\D/g, '') : (config.owner || ''); } catch {}
  const out = { main: { number: mainNum, connected: !!liveOpen, mode: (() => { try { return getMode(); } catch { return 'public'; } })(), port: config.port }, workers: [] };
  const reg = readRegistry();
  for (const digits of Object.keys(reg)) {
    const e = reg[digits] || {};
    const st = await probeWorkerStatus(e.port);
    out.workers.push({
      number: digits, port: e.port,
      connected: !!(st && st.connected), socketStable: !!(st && st.socketStable),
      mode: (st && st.mode) || '-', pidAlive: pidAlive(e.pid),
    });
  }
  out.disconnected = getDisconnected();
  res.json({ ok: true, ...out });
});
app.post('/api/owner/disconnect', async (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  const digits = String(req.body?.number || '').replace(/\D/g, '');
  if (!digits) return res.status(400).json({ error: 'number chahiye.' });
  let mainNum = '';
  try { mainNum = (liveOpen && sock?.user) ? String(sock.user.id).split(':')[0].replace(/\D/g, '') : ''; } catch {}
  const same = (a, b) => a && b && (a === b || (a.length >= 7 && b.length >= 7 && a.slice(-10) === b.slice(-10)));
  if (same(digits, mainNum)) {
    // Safety lock: main/owner account panel se disconnect nahi ho sakta.
    return res.status(403).json({ error: 'Main account ko panel se disconnect nahi kar sakte.' });
  }
  const reg = readRegistry();
  const key = Object.keys(reg).find((k) => same(digits, k));
  if (!key) return res.status(404).json({ error: 'Ye number connected accounts mein nahi mila.' });
  const e = reg[key] || {};
  delete reg[key];
  writeRegistry(reg); // sweep dobara nahi uthayega
  recordDisconnect({ number: key, via: 'panel' }); // masked audit log + count
  // 5s baad kill — taake in-flight reply nikal jaye, phir session bhi saaf
  setTimeout(() => {
    try { if (e.pid) process.kill(e.pid, 'SIGTERM'); } catch {}
    try { fs.rmSync(path.join(SESSIONS_ROOT, `s_${key}`), { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(path.join(__dirname, `worker-${key}.log`)); } catch {}
  }, 5000);
  res.json({ ok: true, which: 'worker', number: key, port: e.port });
});
// Manager se worker ke zariye user ko WhatsApp message bhejo
// Panel reply: pehle lead ke APNE worker se bhejo; woh zinda na ho to kisi bhi
// zinda worker se try karo. Manager (Boss ka main number) se KABHI nahi —
// owner number leak protection barkarar hai.
async function panelTryWorkerSend(port, toJid, text) {
  const r = await fetch(`http://127.0.0.1:${port}/api/worker/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify({ to: toJid, text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    const jb = await r.json().catch(() => ({}));
    throw new Error(jb.error || ('HTTP ' + r.status));
  }
  return true;
}
async function panelSendReply(lead, toJid, text) {
  const reg = readRegistry();
  const order = [];
  const orig = String((lead && lead.worker) || '');
  if (orig && reg[orig] && reg[orig].port && !reg[orig].disabled) order.push(orig);
  for (const [digits, e] of Object.entries(reg)) {
    if (digits === orig || order.includes(digits)) continue;
    if (!e || !e.port || e.disabled) continue;
    order.push(digits);
  }
  let lastErr = 'koi worker session maujood nahi';
  for (const digits of order) {
    try {
      await panelTryWorkerSend(reg[digits].port, toJid, text);
      return { ok: true, via: digits };
    } catch (err) {
      let m = String((err && err.message) || err);
      // Technical JS lafz Boss ko mat dikhao — saaf Roman Urdu mein badlo
      if (/cannot read propert|undefined/i.test(m)) m = 'worker ka WhatsApp socket tayyar nahi';
      else if (/fetch failed|ECONNREFUSED|not pahuncha/i.test(m)) m = 'worker process se rabta nahi ho saka';
      lastErr = m;
    }
  }
  return { ok: false, error: 'koi worker online nahi (' + lastErr + ') — WhatsApp reconnect ho raha hai, thodi der baad try karein' };
}
// 👥 Multi-account .creact fan-out (manager only): har live worker se 1 reaction.
// WhatsApp ka rule: ek account, ek post par sirf 1 reaction — tally barhane ka wahid tareeqa.
async function creactFanout(jid, serverId, emoji) {
  const reg = readRegistry();
  const out = [];
  for (const [digits, e] of Object.entries(reg)) {
    if (!e || !e.port) continue;
    try {
      const r = await fetch(`http://127.0.0.1:${e.port}/api/worker/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: JSON.stringify({ jid, serverId, emoji }),
        signal: AbortSignal.timeout(25000),
      });
      const jb = await r.json().catch(() => ({}));
      out.push({ number: digits, ok: !!(r.ok && jb.ok) });
    } catch { out.push({ number: digits, ok: false }); }
  }
  return out;
}
if (!IS_WORKER) { try { require('./lib/commands').setCreactFanout(creactFanout); } catch {} }
// 💬 WebChat bridge poller (manager only): sessions/webchat/to_boss.jsonl → owner WhatsApp
if (!IS_WORKER) { try { require('./lib/commands').webchat.start(); } catch (e) { console.error('[webchat] start fail:', e.message); } }
app.post('/api/owner/reply', async (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  const { jid, text } = req.body || {};
  const msg = String(text || '').trim().slice(0, 1000);
  if (!jid || !msg) return res.status(400).json({ error: 'jid+text chahiye' });
  const inbox = getLeadInbox();
  const lead = inbox.find((l) => l.jid === String(jid).toLowerCase());
  if (!lead) return res.status(404).json({ error: 'user nahi mila' });
  const out = `👑 *Owner ka jawab* 💗\n\n${msg}`;
  // Defensive: lead.jid mein kabhi ":device" suffix aa jaye to saaf kar do —
  // us par bheja reply deliver nahi hota (silent fail).
  const toJid = String(lead.jid || '').replace(/:\d+@/, '@');
  const sent = await panelSendReply(lead, toJid, out);
  if (!sent.ok) return res.status(502).json({ error: sent.error });
  saveLeadOut({ userJid: lead.jid, text: msg, kind: 'reply' });
  res.json({ ok: true, via: sent.via });
});
// 👑 Main owner badlo — sirf manager par. `.mainowner <number>` command (manager ya
// worker se) yahan aata hai. Purana main owner extra-owners mein reh jata hai taake
// uski access na khoye. Phir workers maar kar khud exit — start.sh 5s mein naye
// OWNER_NUMBER (.owner file) ke saath wapas layega; sweep workers ko dobara uthayega.
app.post('/api/owner/mainowner', async (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  const digits = String((req.body || {}).digits || '').replace(/\D/g, '');
  if (digits.length < 7) return res.status(400).json({ error: 'sahi number likhein' });
  const oldMain = String(config.owner || '').replace(/\D/g, '');
  if (digits === oldMain) return res.status(400).json({ error: 'ye pehle se main owner hai' });
  // 1. purane main owner ko extra owners mein rakho (access barkarar)
  try {
    const p = path.join(__dirname, 'extra-owners.json');
    let list = [];
    try { const a = JSON.parse(fs.readFileSync(p, 'utf8')); if (Array.isArray(a)) list = a.map(x => String(x).replace(/\D/g, '').slice(-10)).filter(x => x.length >= 7); } catch {}
    const oldShort = oldMain.slice(-10);
    if (oldShort.length >= 7 && !list.includes(oldShort)) { list.push(oldShort); try { fs.writeFileSync(p, JSON.stringify(list, null, 1)); } catch {} }
  } catch {}
  // 2. .owner file — start.sh har restart par isi se OWNER_NUMBER uthata hai
  try { fs.writeFileSync(path.join(__dirname, '.owner'), digits + '\n', { mode: 0o600 }); }
  catch { return res.status(500).json({ error: 'owner file nahi likh saki' }); }
  // 3. saare workers maar do — sweep unhein naye owner ke saath dobara uthayega
  let killed = 0;
  try {
    const reg = readRegistry();
    for (const d of Object.keys(reg)) {
      const pid = reg[d] && reg[d].pid;
      if (pid && pidAlive(pid)) { try { process.kill(pid, 'SIGTERM'); killed++; } catch {} }
    }
  } catch {}
  res.json({ ok: true, oldMain, newMain: digits, workersKilled: killed });
  // 4. khud exit — start.sh 5s mein restart karega (reply nikalne ka waqt de kar)
  setTimeout(() => { try { process.exit(0); } catch {} }, 3000);
});
// Worker ka send endpoint — worker ke apne number se user ko message
app.post('/api/worker/send', async (req, res) => {
  if (!IS_WORKER) return res.status(403).json({ error: 'worker only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  const { to, text } = req.body || {};
  if (!to || !text) return res.status(400).json({ error: 'to+text chahiye' });
  if (!sock) return res.status(503).json({ error: 'WhatsApp connected nahi — reconnect ho raha hai' });
  try {
    const r = await sock.sendMessage(to, { text: String(text).slice(0, 1500) });
    try { recordOwnMsgId(r?.key?.id); } catch {}
    res.json({ ok: true, id: r?.key?.id });
  } catch (err) { res.status(500).json({ error: String(err && err.message || err) }); }
});
// 👥 Worker se channel post par reaction (multi-account .creact fan-out)
app.post('/api/worker/react', async (req, res) => {
  if (!IS_WORKER) return res.status(403).json({ error: 'worker only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  const { jid, serverId, emoji } = req.body || {};
  if (!jid || !serverId || !emoji) return res.status(400).json({ error: 'jid+serverId+emoji chahiye' });
  try {
    if (!sock) return res.status(503).json({ ok: false, error: 'WhatsApp connected nahi' });
    await sock.newsletterFollow(jid).catch(() => {});
    await sock.newsletterReactMessage(jid, String(serverId), String(emoji));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: String(err && err.message || err) }); }
});
app.post('/api/disconnect', async (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  const digits = String(req.body?.number || '').replace(/\D/g, '');
  if (!digits) return res.status(400).json({ error: 'number chahiye.' });
  let mainNum = '';
  try { mainNum = (liveOpen && sock?.user) ? String(sock.user.id).split(':')[0].replace(/\D/g, '') : ''; } catch {}
  const same = (a, b) => a && b && (a === b || (a.length >= 7 && b.length >= 7 && a.slice(-10) === b.slice(-10)));
  if (same(digits, mainNum)) {
    // Main/owner account ko yahan se disconnect karna HARD-BLOCKED hai
    // (panel route ki tarah) — ghalti se bhi Boss ka session na urey.
    return res.status(403).json({ error: 'Main/owner account ko disconnect nahi kar sakte.' });
  }
  const reg = readRegistry();
  const key = Object.keys(reg).find((k) => same(digits, k));
  if (!key) return res.status(404).json({ error: 'Ye number connected accounts mein nahi mila.' });
  const e = reg[key] || {};
  delete reg[key];
  writeRegistry(reg); // sweep dobara nahi uthayega
  // 5s baad kill — taake in-flight reply nikal jaye, phir session bhi saaf
  setTimeout(() => {
    try { if (e.pid) process.kill(e.pid, 'SIGTERM'); } catch {}
    try { fs.rmSync(path.join(SESSIONS_ROOT, `s_${key}`), { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(path.join(__dirname, `worker-${key}.log`)); } catch {}
  }, 5000);
  res.json({ ok: true, which: 'worker', number: key, port: e.port });
});

// Say — bot ke WhatsApp se kisi number ko message (online notice / E2E test).// Sirf admin token ke saath. Body: { to: "923001234567", text: "..." }
app.post('/api/setdp', async (req, res) => {
  if (IS_WORKER) return res.status(403).json({ error: 'manager only' });
  if (!localOnly(req, res)) return;
  if (!checkInternal(req)) return res.status(401).json({ error: 'token ghalat hai' });
  if (!liveOpen || !sock) return res.status(503).json({ error: 'Bot abhi WhatsApp se connected nahi.' });
  const p = String(req.body?.path || '');
  if (!p) return res.status(400).json({ error: 'path chahiye.' });
  const abs = path.isAbsolute(p) ? p : path.join(__dirname, p);
  if (!abs.startsWith(__dirname)) return res.status(400).json({ error: 'ghalat path' });
  try {
    const buf = fs.readFileSync(abs);
    if (!buf.length) return res.status(400).json({ error: 'khaali file' });
    await sock.updateProfilePicture(sock.user.id, buf);
    try { const url = await sock.profilePictureUrl(sock.user.id, 'image'); return res.json({ ok: true, url }); } catch {}
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ error: 'DP set nahi ho saki: ' + (e?.message || e) }); }
});
app.post('/api/say', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Admin token ghalat hai.' });
  const text = String(req.body?.text || '').slice(0, 1000);
  const to = String(req.body?.to || '').replace(/\D/g, '');
  if (!text || to.length < 10) return res.status(400).json({ error: 'text aur to (number) chahiye.' });
  if (!liveOpen) return res.status(503).json({ error: 'Bot abhi WhatsApp se connected nahi.' });
  try {
    await sock.sendMessage(to + '@s.whatsapp.net', { text });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Message nahi gaya: ' + (e.message || 'unknown') });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true, bot: config.botName }));

// ─── 📁 /api/sayfile — bari file document ke tor par WhatsApp par bhejo ───
// (video message ki 16MB limit se bachne ke liye document use hota hai)
app.post('/api/sayfile', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Admin token ghalat hai.' });
  const rel = String(req.body?.path || '');
  const filename = String(req.body?.filename || 'file.mp4').replace(/[\\/]/g, '_').slice(0, 120) || 'file.mp4';
  const caption = String(req.body?.caption || '').slice(0, 1000);
  let to = String(req.body?.to || '').replace(/\D/g, '');
  if (!to) to = String(config.owner || '').replace(/\D/g, '');
  if (!rel || to.length < 10) return res.status(400).json({ error: 'path aur to chahiye.' });
  const abs = path.resolve(rel);
  const BOTDIR = path.resolve(__dirname);
  const okDir = abs === BOTDIR || abs.startsWith(BOTDIR + path.sep) || abs.startsWith('/tmp' + path.sep);
  if (!okDir) return res.status(400).json({ error: 'path sirf /tmp ya bot dir ke andar ho sakta hai.' });
  let st; try { st = fs.statSync(abs); } catch {}
  if (!st || !st.isFile() || st.size < 1) return res.status(400).json({ error: 'file nahi mili.' });
  if (st.size > 1900 * 1024 * 1024) return res.status(400).json({ error: 'file bohat bari hai.' });
  if (!liveOpen) return res.status(503).json({ error: 'Bot abhi WhatsApp se connected nahi.' });
  try {
    await sock.sendMessage(to + '@s.whatsapp.net', {
      document: { url: abs },
      fileName: filename,
      mimetype: 'video/mp4',
      caption: caption || undefined,
    });
    res.json({ ok: true, size: st.size });
  } catch (e) {
    res.status(500).json({ error: 'File nahi gayi: ' + (e.message || 'unknown') });
  }
});


// ─── MULTI-SESSION MANAGER (Boss ka hukm: jitne marzi numbers connect hon) ───
// WhatsApp ka rule: ek Node process = ek linked account. Is liye har extra
// number ke liye alag worker process chalta hai:
//   WORKER=1 SESSION_DIR=./sessions/s_<digits> STATE_FILE=./sessions/s_<digits>/state.json
//   PORT=<pool 3101-3115> OWNER_NUMBER=<digits> node index.js
// /api/pair khud faisla karta hai: apna number → main session; koi aur number
// → us ka worker (spawn + code proxy). Relay aur page mein koi change nahi.
const SESSIONS_ROOT = path.join(__dirname, 'sessions');
const REGISTRY_PATH = path.join(SESSIONS_ROOT, 'registry.json');
const WORKER_PORT_START = 3101, WORKER_PORT_END = 3115, MAX_WORKERS = 15;
function readRegistry() { try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch { return {}; } }
function writeRegistry(r) {
  try { fs.mkdirSync(SESSIONS_ROOT, { recursive: true }); fs.writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2)); }
  catch (e) { log.warn('[multi] registry write fail: ' + e.message); }
}
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
// ONLINE = worker process zinda AUR WhatsApp socket connected.
// (Boss ka hukm: jo offline hai woh 15 ke count mein shamil NAHI hoga.)
function entryOnline(e) {
  if (!pidAlive(e.pid)) return false;
  return e.connected !== false; // sweep har 60s /api/status se 'connected' update karta hai
}
function pickWorkerPort(reg) {
  const used = new Set(Object.values(reg).map(e => e.port));
  for (let p = WORKER_PORT_START; p <= WORKER_PORT_END; p++) if (!used.has(p)) return p;
  return null;
}
async function waitForWorker(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}
async function spawnWorker(digits) {
  let reg = readRegistry();
  const entry = reg[digits];
  // 🔐 Blocked/disabled number (demo stop/expire ya permdel) — kabhi respawn nahi.
  if (entry && entry.disabled) {
    throw { status: 403, friendly: 'Is number ki access khatam ho chuki hai — owner se rabta karein.' };
  }
  if (entry && pidAlive(entry.pid) && await waitForWorker(entry.port, 4000)) return entry;
  if (!entry) {
    // Cap sirf ONLINE numbers par — offline count nahi hote.
    const online = Object.values(reg).filter(entryOnline).length;
    if (online >= MAX_WORKERS) {
      throw { status: 429, friendly: `Abhi ${online} numbers online active hain (limit ${MAX_WORKERS}) — offline numbers count nahi hote. Thori dair baad dobara koshish karein.` };
    }
  }
  const port = (entry && entry.port) || pickWorkerPort(reg);
  if (!port) throw { status: 429, friendly: 'Koi free slot nahi — thori dair baad dobara koshish karein.' };
  const sessDir = path.join(SESSIONS_ROOT, `s_${digits}`);
  try { fs.mkdirSync(sessDir, { recursive: true }); } catch {}
  const env = {
    ...process.env,
    WORKER: '1',
    SESSION_DIR: `./sessions/s_${digits}`,
    STATE_FILE: path.join(sessDir, 'state.json'),
    PORT: String(port),
    // Worker ka OWNER_NUMBER hamesha ASLI owner (manager ka .owner wala number) —
    // worker ka apna number NAHI. Warna .contact forward owner ki bajaye
    // worker ko khud chala jata hai aur owner ko kuch nahi milta.
    OWNER_NUMBER: process.env.OWNER_NUMBER || digits,
    MANAGER_PORT: String(config.port), // worker secret commands ke liye manager se baat kare
    INTERNAL_TOKEN, // worker → manager lead API ke liye
  };
  delete env.SESSION_ID; delete env.FORCE_SESSION_ID; // worker ko main ka session kabhi na mile
  const logFd = fs.openSync(path.join(__dirname, `worker-${digits}.log`), 'a');
  const child = spawn('node', ['index.js'], { cwd: __dirname, env, detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref();
  reg = readRegistry(); // dobara parho — sweep parallel chal sakta hai
  const prev = reg[digits] || {};
  reg[digits] = { port, pid: child.pid, addedAt: prev.addedAt || Date.now(),
                  warmedAt: prev.warmedAt, usedAt: prev.usedAt,
                  disabled: prev.disabled || undefined };
  writeRegistry(reg);
  log.info(`[multi] worker ${digits.slice(0, 4)}***${digits.slice(-2)} → port ${port} pid ${child.pid}`);
  const ok = await waitForWorker(port, 30000);
  if (!ok) throw { status: 503, friendly: 'Session worker start nahi ho saka — dobara koshish karein.' };
  return reg[digits];
}
// Boot + har 60s: mara hua worker wapas uthao — linked session bina dobara
// pairing ke wapas aati hai (auth state sessions/s_<digits>/ mein rehti hai).
async function managerSweep() {
  const reg = readRegistry();
  let changed = false;
  for (const digits of Object.keys(reg)) {
    const e = reg[digits];
    // 🔐 Disabled (demo stop/expire, permdel) — sweep isay chhue bhi nahi: na
    // respawn, na status update. Dubara authorize hone par command khud unblock karega.
    if (e.disabled) continue;
    // REAP: warmup to hua par 10 min mein pairing kabhi start nahi hui
    // (ghalat/adhoora number likh kar chhor diya) — slot khali karo.
    if (e.warmedAt && !e.usedAt && Date.now() - e.warmedAt > 10 * 60 * 1000) {
      try { if (e.pid) process.kill(e.pid, 'SIGTERM'); } catch {}
      try { fs.rmSync(path.join(SESSIONS_ROOT, `s_${digits}`), { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(path.join(__dirname, `worker-${digits}.log`)); } catch {}
      delete reg[digits];
      changed = true;
      log.info(`[multi] sweep: bekaar warmed worker ${digits.slice(0, 4)}*** saaf kiya`);
      continue;
    }
    if (!pidAlive(e.pid)) {
      log.info(`[multi] sweep: worker ${digits.slice(0, 4)}*** dobara start ho raha hai`);
      try { await spawnWorker(digits); } catch (e2) { log.warn('[multi] sweep respawn fail: ' + (e2?.friendly || e2?.message)); }
    }
    // ONLINE TRACKING: har worker ka asal WhatsApp link state registry mein rakho,
    // taake slot cap (spawnWorker) sirf ONLINE numbers gine — offline count nahi hote.
    // (fresh read — upar respawn hua ho to stale PID na pakre.)
    const fresh = readRegistry()[digits];
    if (!fresh) continue;
    let stOnline = null;
    if (pidAlive(fresh.pid)) {
      try {
        const r = await fetch(`http://127.0.0.1:${fresh.port}/api/status`, { signal: AbortSignal.timeout(2500) });
        if (r.ok) stOnline = (await r.json()).connected === true;
      } catch {}
    } else stOnline = false;
    if (stOnline !== null && fresh.connected !== stOnline) {
      reg[digits] = fresh;
      reg[digits].connected = stOnline;
      reg[digits].stateAt = Date.now();
      changed = true;
    }
  }
  if (changed) writeRegistry(reg);
}

// --- boot ----------------------------------------------------
// NOTE (Boss ka hukm): restart par purane 401 cooldown bahal NAHI honge.
// Pehle yahan bot.log se purana cooldown uthaya jata tha — wahi wajah thi
// ke "pehli baar hi block" nazar aata tha. Ab fresh boot = koi rok nahi.

// Multi-session sweep sirf manager (main process) par — worker apne kaam se kaam rakhe.
if (!IS_WORKER) {
  setTimeout(managerSweep, 15000);
  setInterval(managerSweep, 60000);
  // ─── 🎫 Demo expiry checker (har 60s) ───
  // Demo time khatam → number disconnect + link dead + owner & customer dono ko message.
  setInterval(async () => {
    try {
      const links = loadDemoLinksApi();
      let changed = false;
      for (const [token, l] of Object.entries(links)) {
        // ── Naya proper method: number-locked demo auto-detect ──
        // Agar demo active hai, timer start nahi hua, aur lockedNumber ka worker online hai
        // → pairing ho gayi! Timer start karo.
        if (l.type === 'demo' && l.status === 'active' && !l.expiresAt && l.lockedNumber) {
          try {
            const reg = readRegistry();
            const entry = reg[l.lockedNumber];
            if (entry && entryOnline(entry)) {
              l.pairedAt = Date.now();
              l.expiresAt = Date.now() + (l.durationMin * 60000);
              changed = true;
              log.info(`[demo] Timer auto-start: ${l.lockedNumber} (${l.durationMin}m)`);
            }
          } catch {}
        }
        if (l.type !== 'demo' || l.status !== 'active' || !l.expiresAt) continue;
        if (Date.now() < l.expiresAt) continue;
        // ⏰ Demo khatam!
        l.status = 'expired'; changed = true;
        const num = l.lockedNumber || l.pairedNumber;
        log.info(`[demo] Demo khatam: ${num} (token ${token})`);
        const cleanNum = String(num).replace(/\D/g, '');
        const custJid = cleanNum + '@s.whatsapp.net';
        const mins = l.durationMin;
        const tstr = mins >= 1440 ? (mins/1440)+' din' : mins >= 60 ? (mins/60)+' ghante' : mins+' minute';
        const custMsg = `🎫 *Aapka ${tstr} ka demo khatam ho gaya!*\n\nNEXORA-MD pasand aaya? 💗\nPermanent access ke liye owner se rabta karein:\n*${config.prefix}contact* <aapka paigham>`;
        // 1) Customer ko uske "Message yourself" mein — worker ke APNE session se
        //    (main number se DM nahi jayega; worker kill se PEHLE bhejo)
        let workerPort = null, workerPid = null;
        try {
          const reg = readRegistry();
          const entry = reg[num] || reg[cleanNum];
          if (entry) { workerPid = entry.pid; workerPort = entry.port; }
        } catch {}
        if (workerPort) {
          try {
            const r = await fetch(`http://127.0.0.1:${workerPort}/api/worker/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
              body: JSON.stringify({ to: custJid, text: custMsg }),
              signal: AbortSignal.timeout(10000),
            });
            if (r.ok) log.info(`[demo] customer msg "yourself" mein bhej diya: ${cleanNum}`);
            else log.warn('[demo] worker-self send fail: HTTP ' + r.status);
          } catch (e) { log.warn('[demo] worker-self send fail: ' + e.message); }
        } else {
          log.warn('[demo] worker port nahi mila, customer msg skip: ' + cleanNum);
        }
        // 2) Worker disconnect karo
        if (workerPid) { try { process.kill(workerPid, 'SIGTERM'); } catch {} }
        // 3) Owner ko DM (main socket se — ye theek hai)
        try {
          const ownerJid = String(config.owner || '').replace(/\D/g, '') + '@s.whatsapp.net';
          if (sock && liveOpen) {
            await sock.sendMessage(ownerJid, { text: `🎫 *Demo khatam!*\n\n📱 Number: *${num}*\n⏱ Duration: ${tstr}\n\nBot disconnect kar diya gaya hai. Customer ko permanent link dena ho to:\n*${config.prefix}permlink* ${num}` });
          }
        } catch (e) { log.warn('[demo] owner msg fail: ' + e.message); }
      }
      if (changed) saveDemoLinksApi(links);
    } catch (e) { log.warn('[demo] expiry checker: ' + e.message); }
  }, 60000);

  // ─── 🔐 Password pairing system: demo expiry checker (har 60s) ───
  // pair-auth.json ke demo auths: pairing detect hote hi timer auto-start,
  // time khatam → registry block (persistent, respawn nahi) + exact worker
  // disconnect + owner & customer dono ko message. Main account kabhi nahi chhuegi.
  const pairAuth = require('./lib/pair-auth');
  const MAIN_DIGITS = String(config.owner || '').replace(/\D/g, '');
  setInterval(async () => {
    try {
      const auth = pairAuth.loadAuth();
      let changed = false;
      for (const [digits, d] of Object.entries(auth.demo || {})) {
        if (!d || d.status !== 'active') continue;
        if (MAIN_DIGITS && (digits === MAIN_DIGITS || digits.endsWith(MAIN_DIGITS.slice(-10)))) continue; // safety
        const clean = String(digits).replace(/\D/g, '');
        // ── Timer auto-start: worker genuinely online = pairing ho gayi ──
        if (!d.expiresAt) {
          try {
            const reg = readRegistry();
            const entry = reg[clean];
            if (entry && !entry.disabled && entryOnline(entry)) {
              d.pairedAt = Date.now();
              d.expiresAt = Date.now() + (d.durationMin * 60000);
              changed = true;
              log.info(`[pass] Demo timer auto-start: ${clean} (${d.durationMin}m)`);
            }
          } catch {}
        }
        if (!d.expiresAt || Date.now() < d.expiresAt) continue;
        // ⏰ Demo khatam!
        d.status = 'expired'; changed = true;
        log.info(`[pass] Demo khatam: ${clean}`);
        const custJid = clean + '@s.whatsapp.net';
        const tstr = fmtTime(d.durationMin);
        const custMsg = `🎫 *Aapka ${tstr} ka demo khatam ho gaya!*\n\nNEXORA-MD pasand aaya? 💗\nPermanent access ke liye owner se rabta karein.`;
        // 1) Customer ko uske "Message yourself" mein — worker ke APNE session se
        //    (main number se DM nahi jayega; registry block/kill se PEHLE bhejo)
        let pid = null, wport = null;
        try {
          const reg0 = readRegistry();
          const e0 = reg0[clean];
          if (e0) { pid = e0.pid; wport = e0.port; }
        } catch {}
        if (wport) {
          try {
            const r = await fetch(`http://127.0.0.1:${wport}/api/worker/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
              body: JSON.stringify({ to: custJid, text: custMsg }),
              signal: AbortSignal.timeout(10000),
            });
            if (r.ok) log.info(`[pass] customer msg "yourself" mein bhej diya: ${clean}`);
            else log.warn('[pass] worker-self send fail: HTTP ' + r.status);
          } catch (e) { log.warn('[pass] worker-self send fail: ' + e.message); }
        } else {
          log.warn('[pass] worker port nahi mila, customer msg skip: ' + clean);
        }
        // 2) Registry block (persistent — sweep dobara respawn na kare)
        try {
          const reg = readRegistry();
          const entry = reg[clean];
          if (entry) {
            pid = entry.pid;
            entry.disabled = true;
            writeRegistry(reg);
          }
        } catch {}
        // 3) Phir SIRF isi number ka exact worker khatam karo
        if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
        // 4) Owner ko DM (main socket se — ye theek hai)
        try {
          const ownerJid = MAIN_DIGITS + '@s.whatsapp.net';
          if (sock && liveOpen) {
            await sock.sendMessage(ownerJid, { text: `🎫 *Demo khatam!*\n\n📱 Number: *${clean}*\n⏱ Duration: ${tstr}\n\nBot disconnect kar diya gaya hai. Permanent dena ho to:\n*${config.prefix}permauth* ${clean}` });
          }
        } catch (e) { log.warn('[pass] owner msg fail: ' + e.message); }
      }
      if (changed) pairAuth.saveAuth(auth);
    } catch (e) { log.warn('[pass] expiry checker: ' + e.message); }
  }, 60000);
}

function fmtTime(min) {
  if (min >= 1440) return (min / 1440) + ' din';
  if (min >= 60) return (min / 60) + ' ghante';
  return min + ' minute';
}

app.listen(config.port, '127.0.0.1', () => {
  log.info(`[web] Pairing page: http://localhost:${config.port}${IS_WORKER ? ' (worker)' : ' (manager)'}`);
  log.info('[web] ADMIN TOKEN (logout ke liye — kisi ko na dein): ' + ADMIN_TOKEN);
  connectWA();
});
