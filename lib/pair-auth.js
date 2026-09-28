// ─── 🔐 NEXORA-MD password pairing auth (shared module) ───
// Demo mode:  ek global password, har 5 minute mein rotate (`.demo-secret` se
// HMAC-SHA256 derive). Pichli window ka password mazeed 5 minute valid rehta hai.
// Permanent: ek fixed password (`.permpass <password>` se set).
// Dono modes mein number pehle se authorized hona LAZMI hai.
//
// pair-auth.json (chmod 600, atomic writes):
// {
//   "permPassword": "....",
//   "demo": { "<digits>": { durationMin, status: "active|stopped|expired",
//                           authorizedAt, pairedAt, expiresAt } },
//   "perm": { "<digits>": { status: "active", authorizedAt } }
// }
//
// .demo-secret ko KABHI regenerate/overwrite mat karna — isi se dono
// (Node + Python relay) same rotating password derive karte hain.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = path.join(__dirname, '..');
const AUTH_PATH = path.join(BASE, 'pair-auth.json');
const SECRET_PATH = path.join(BASE, '.demo-secret');
const WINDOW_SEC = 300; // 5 minute

let _secret = null;
function getSecret() {
  if (_secret) return _secret;
  // Raw file bytes — Python relay bhi EXACTLY yahi bytes parhta hai.
  _secret = fs.readFileSync(SECRET_PATH);
  return _secret;
}

// HMAC-SHA256(secret, "nexora-demo-v1:<window>") -> pehle 4 bytes % 1e6 -> 6 digit
function demoPasswordForWindow(win) {
  const h = crypto.createHmac('sha256', getSecret())
    .update('nexora-demo-v1:' + win, 'utf8')
    .digest();
  const n = h.readUInt32BE(0) % 1000000;
  return String(n).padStart(6, '0');
}
function currentWindow() { return Math.floor(Date.now() / 1000 / WINDOW_SEC); }

function currentDemoPassword() { return demoPasswordForWindow(currentWindow()); }
function previousDemoPassword() { return demoPasswordForWindow(currentWindow() - 1); }

// Dono windows accept (grace). Constant-time compare.
function demoPasswordOk(pw) {
  const p = String(pw || '').trim();
  if (!/^\d{6}$/.test(p)) return false;
  const a = Buffer.from(p), b = Buffer.from(currentDemoPassword()), c = Buffer.from(previousDemoPassword());
  return (a.length === b.length && crypto.timingSafeEqual(a, b)) ||
         (a.length === c.length && crypto.timingSafeEqual(a, c));
}

function defaultAuth() { return { permPassword: '', demo: {}, perm: {} }; }

function loadAuth() {
  try {
    const o = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    if (!o || typeof o !== 'object') return defaultAuth();
    if (typeof o.permPassword !== 'string') o.permPassword = '';
    if (!o.demo || typeof o.demo !== 'object') o.demo = {};
    if (!o.perm || typeof o.perm !== 'object') o.perm = {};
    return o;
  } catch { return defaultAuth(); }
}

function saveAuth(o) {
  const tmp = AUTH_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 1));
  try { fs.chmodSync(tmp, 0o600); } catch {}
  fs.renameSync(tmp, AUTH_PATH); // atomic
}

function cleanNum(s) { return String(s || '').replace(/\D/g, ''); }
function validNum(d) { return d.length >= 10 && d.length <= 15; }

function activeDemoCount(auth) {
  return Object.values(auth.demo).filter(e => e && e.status === 'active').length;
}

// mode: 'demo' | 'perm'. Returns {ok, error}
function validatePairRequest(mode, password, number) {
  const digits = cleanNum(number);
  if (!validNum(digits)) return { ok: false, error: 'Sahi WhatsApp number likhein (country code ke saath).' };
  const auth = loadAuth();
  if (mode === 'demo') {
    if (!demoPasswordOk(password))
      return { ok: false, error: '❌ Demo password ghalat hai. Owner se maujooda password lein.' };
    const e = auth.demo[digits];
    if (!e || e.status !== 'active')
      return { ok: false, error: '❌ Ye number demo ke liye authorized nahi. Owner se rabta karein.' };
    return { ok: true, entry: e };
  }
  if (mode === 'perm') {
    const stored = String(auth.permPassword || '');
    const p = String(password || '');
    if (!stored)
      return { ok: false, error: '❌ Permanent password abhi set nahi hua. Owner se rabta karein.' };
    if (p.length !== stored.length || !crypto.timingSafeEqual(Buffer.from(p), Buffer.from(stored)))
      return { ok: false, error: '❌ Permanent password ghalat hai.' };
    const e = auth.perm[digits];
    if (!e || e.status !== 'active')
      return { ok: false, error: '❌ Ye number permanent access ke liye authorized nahi. Owner se rabta karein.' };
    return { ok: true, entry: e };
  }
  return { ok: false, error: 'Ghalat mode.' };
}

module.exports = {
  WINDOW_SEC,
  AUTH_PATH,
  loadAuth, saveAuth, defaultAuth,
  cleanNum, validNum,
  currentDemoPassword, previousDemoPassword, demoPasswordOk, demoPasswordForWindow, currentWindow,
  activeDemoCount,
  validatePairRequest,
};
