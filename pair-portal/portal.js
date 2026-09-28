// ─── NEXORA-MD · Pair Portal (JAWAD-style) ─────────────────────────────
// Sirf pairing karta hai — phone link hote hi SESSION_ID deta hai.
// SESSION_ID ko bot mein env mein do → bot seedha connect hoga,
// dobara pairing kabhi nahi mangega. Bot khud fresh pairing nahi karta.
//
// Chalao:  npm install && node portal.js   (PORT env, default 3001)
// Deploy:  Render/Railway par Node web service (free tier kaafi hai).

const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  Browsers,
  DisconnectReason,
} = require('@chaeulso/baileys');

const PORT = process.env.PORT || 3001;
const SESS_ROOT = path.join(__dirname, 'sessions');
const MAX_SESSIONS = 8;
const SESSION_TTL_MS = 20 * 60 * 1000;

// Proxy support: sandboxed networks block direct WSS — route the WA socket
// through the HTTPS proxy when one is configured (Baileys `agent` option).
let proxyAgent = null;
try {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxyUrl) {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    proxyAgent = new HttpsProxyAgent(proxyUrl);
    console.log('[portal] using HTTPS proxy for WhatsApp socket');
  }
} catch (e) { console.log('[portal] proxy agent unavailable:', e.message); }
const SOCK_OPTS = () => ({
  browser: Browsers.macOS('Chrome'), // standard identity — custom naam par WhatsApp refuse kar sakta hai
  printQRInTerminal: false, syncFullHistory: false, markOnlineOnConnect: false,
  ...(proxyAgent ? { agent: proxyAgent } : {}),
});

const sessions = new Map(); // id -> session object
fs.mkdirSync(SESS_ROOT, { recursive: true });

const newId = () => crypto.randomBytes(8).toString('hex');
const waitFor = (fn, ms) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const t = setInterval(() => {
      let v = false;
      try { v = fn(); } catch {}
      if (v) { clearInterval(t); resolve(true); }
      else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error('TIMEOUT')); }
    }, 500);
  });

function cleanup(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.sock?.end(); } catch {}
  try { s.sock?.ws?.close(); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
  sessions.delete(id);
}

// Purani / de di gayi sessions saaf karo
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS || (s.delivered && now - s.deliveredAt > 2 * 60 * 1000)) {
      console.log(`[portal] sweep ${id.slice(0, 6)}…`);
      cleanup(id);
    }
  }
}, 60 * 1000);

function attachSocket(s) {
  const { sock } = s;
  sock.ev.on('creds.update', s.saveCreds);
  sock.ev.on('connection.update', async (u) => {
    try {
      if (u.qr && u.qr !== s.qr) {
        s.qr = u.qr;
        s.qrDataUrl = await QRCode.toDataURL(u.qr).catch(() => null);
      }
      const { connection, lastDisconnect } = u;
      if (connection === 'open' && !s.ready) {
        // creds.json mein registered:true ka intezar (max ~10s)
        const credsPath = path.join(s.dir, 'creds.json');
        let ok = false;
        for (let i = 0; i < 20; i++) {
          try {
            const c = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
            if (c && c.registered === true) { ok = true; break; }
          } catch {}
          await new Promise((r) => setTimeout(r, 500));
        }
        if (ok) {
          const raw = fs.readFileSync(credsPath, 'utf8');
          s.sessionId = Buffer.from(raw, 'utf8').toString('base64');
          s.ready = true;
          console.log(`[portal] ${s.id.slice(0, 6)}… linked — SESSION_ID tayyar`);
        } else {
          s.error = 'LINK_OK_BUT_CREDS_MISSING';
        }
        try { sock.end(); } catch {}
      }
      if (connection === 'close' && !s.ready && !s.error) {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          // 401: WhatsApp ne is waqt fresh registration rok rakhi hai
          s.error = 'WHATSAPP_THROTTLE';
        } else if (code === DisconnectReason.restartRequired && (s.retries = (s.retries || 0) + 1) <= 3) {
          // 515: pairing ke baad normal — nayi socket, wahi creds
          console.log(`[portal] ${s.id.slice(0, 6)}… 515 restart (${s.retries})`);
          try { await useMultiFileAuthState(s.dir); } catch {}
          const { state, saveCreds } = await useMultiFileAuthState(s.dir);
          s.saveCreds = saveCreds;
          const nsock = makeWASocket({
            version: s.version, auth: state,
            ...SOCK_OPTS(),
          });
          s.sock = nsock;
          attachSocket(s);
        } else if (code !== DisconnectReason.restartRequired) {
          s.error = 'CONNECTION_CLOSED';
        }
      }
    } catch (e) { console.log('[portal] conn.update:', e.message); }
  });
}

async function startPairing({ mode, number }) {
  if (sessions.size >= MAX_SESSIONS) { const e = new Error('SERVER_BUSY'); e.code = 'SERVER_BUSY'; throw e; }
  if (mode === 'code' && !/^\d{10,15}$/.test(number || '')) { const e = new Error('BAD_NUMBER'); e.code = 'BAD_NUMBER'; throw e; }

  const id = newId();
  const dir = path.join(SESS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: undefined }));
  const sock = makeWASocket({
    version, auth: state,
    ...SOCK_OPTS(),
  });
  const s = {
    id, number: number || null, mode, dir, sock, saveCreds, version,
    code: null, qr: null, qrDataUrl: null,
    ready: false, sessionId: null, delivered: false, deliveredAt: 0,
    error: null, retries: 0, createdAt: Date.now(),
  };
  sessions.set(id, s);
  attachSocket(s);

  if (mode === 'code') {
    await waitFor(() => sock.ws && sock.ws.isOpen, 45000); // stability gate
    await new Promise((r) => setTimeout(r, 3000));          // pace — foran code na mango
    s.code = await sock.requestPairingCode(number);
    console.log(`[portal] ${id.slice(0, 6)}… code jari (${String(number).slice(0, 4)}…)`);
  }
  return s;
}

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, portal: 'NEXORA-MD', active: sessions.size }));

app.post('/api/start', async (req, res) => {
  try {
    const { mode, number } = req.body || {};
    if (mode !== 'code' && mode !== 'qr') return res.status(400).json({ ok: false, error: 'BAD_MODE' });
    const s = await startPairing({ mode, number: String(number || '').replace(/\D/g, '') });
    res.json({ ok: true, id: s.id, code: s.code || null });
  } catch (e) {
    try { if (e.code === 'BAD_NUMBER') return res.status(400).json({ ok: false, error: 'BAD_NUMBER' }); } catch {}
    const code = e.code || (String(e.message).includes('TIMEOUT') ? 'SOCKET_TIMEOUT' : 'START_FAILED');
    console.log('[portal] start fail:', e.message);
    res.status(503).json({ ok: false, error: code });
  }
});

app.get('/api/state', (req, res) => {
  const s = sessions.get(String(req.query.id || ''));
  if (!s) return res.status(404).json({ ok: false, error: 'NO_SESSION' });
  const out = { ok: true, ready: s.ready, code: s.code, qr: s.qrDataUrl, error: s.error };
  if (s.ready && s.sessionId && !s.delivered) {
    out.session_id = s.sessionId; // SIRF EK BAAR — dobara nahi milegi
    s.delivered = true;
    s.deliveredAt = Date.now();
    s.sessionId = null; // memory se mitao
  } else if (s.ready && s.delivered) {
    out.error = 'ALREADY_DELIVERED';
  }
  res.json(out);
});

app.get('/', (req, res) => res.send(PAGE));
app.listen(PORT, () => console.log(`[portal] NEXORA-MD pair portal :${PORT}`));

const PAGE = `<!DOCTYPE html><html lang="ur"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NEXORA-MD · Pair Portal</title>
<style>
*{box-sizing:border-box;margin:0}body{background:#001619;color:#EAF7F8;font-family:system-ui;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#062529;border:1px solid #0e3a40;border-radius:20px;padding:28px;max-width:440px;width:100%;box-shadow:0 0 60px #50e8f422}
h1{font-size:22px;color:#50E8F4;margin-bottom:4px}.sub{color:#7FA3A7;font-size:13px;margin-bottom:18px}
.tabs{display:flex;gap:8px;margin-bottom:16px}.tab{flex:1;padding:10px;border-radius:12px;border:1px solid #0e3a40;background:#03181c;color:#7FA3A7;cursor:pointer;font-size:14px}
.tab.on{background:#50E8F4;color:#001619;font-weight:700;border-color:#50E8F4}
input{width:100%;padding:13px;border-radius:12px;border:1px solid #0e3a40;background:#03181c;color:#EAF7F8;font-size:16px;margin-bottom:12px}
button.go{width:100%;padding:13px;border-radius:999px;border:0;background:#50E8F4;color:#001619;font-weight:800;font-size:16px;cursor:pointer}
.code{font-size:34px;letter-spacing:6px;text-align:center;background:#03181c;border:1px dashed #50E8F4;border-radius:14px;padding:16px;margin:14px 0;color:#50E8F4;font-weight:800}
.qrbox{text-align:center;margin:14px 0}.qrbox img{width:230px;border-radius:14px;border:1px solid #0e3a40;background:#fff;padding:8px}
.status{font-size:13px;color:#7FA3A7;text-align:center;margin-top:10px;min-height:20px}
textarea{width:100%;height:90px;background:#03181c;color:#6DD5C4;border:1px solid #0e3a40;border-radius:12px;padding:10px;font-size:11px;margin:10px 0}
.steps{font-size:13px;color:#C7F8FE;background:#03181c;border-radius:12px;padding:12px;margin-top:10px;line-height:1.7}
.err{color:#ff8a8a;font-size:13px;text-align:center;margin-top:10px}
.hidden{display:none}
</style></head><body><div class="card">
<h1>💗 NEXORA-MD</h1><div class="sub">Pair Portal — link karo, SESSION_ID lo, bot mein lagao</div>
<div class="tabs"><div class="tab on" id="tCode" onclick="tab('code')">🔢 Code</div><div class="tab" id="tQr" onclick="tab('qr')">📷 QR Scan</div></div>
<div id="paneCode"><input id="num" inputmode="numeric" placeholder="WhatsApp number (92 se shuru, bina +)"><button class="go" onclick="start('code')">Code Hasil Karo</button></div>
<div id="paneQr" class="hidden"><button class="go" onclick="start('qr')">QR Dikhao</button></div>
<div id="out"></div><div class="status" id="st"></div>
<script>
let mode='code',sid=null,timer=null;
function tab(m){mode=m;tCode.classList.toggle('on',m=='code');tQr.classList.toggle('on',m=='qr');paneCode.classList.toggle('hidden',m!='code');paneQr.classList.toggle('hidden',m=='qr');}
async function start(m){
  out.innerHTML='';st.textContent='Jor rahi hoon…';
  const body={mode:m};if(m=='code')body.number=num.value;
  const r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  if(!r.ok){st.innerHTML='<span class=err>'+err(r.error)+'</span>';return;}
  sid=r.id;
  if(r.code)out.innerHTML='<div class=code>'+r.code+'</div><div class=status>WhatsApp → Linked devices → Link with phone number mein ye code 30 second ke andar dalo</div>';
  st.textContent='Intezar…';poll();
}
function err(e){return{ BAD_NUMBER:'Number ghalat hai (10-15 hindse, country code ke saath)',SERVER_BUSY:'Server masroof hai — 2 min baad try karo',SOCKET_TIMEOUT:'WhatsApp se rabta na ho saka — dobara try karo',WHATSAPP_THROTTLE:'WhatsApp ne is waqt nayi pairing rok rakhi hai — kuch der baad dobara try karo',CONNECTION_CLOSED:'Connection toot gaya — dobara try karo',START_FAILED:'Shuru na ho saka — dobara try karo'}[e]||e;}
async function poll(){
  clearInterval(timer);timer=setInterval(async()=>{
    const r=await fetch('/api/state?id='+sid).then(r=>r.json());if(!r.ok){clearInterval(timer);return;}
    if(r.error&&!r.ready){st.innerHTML='<span class=err>'+err(r.error)+'</span>';clearInterval(timer);return;}
    if(r.qr&&mode=='qr')out.innerHTML='<div class=qrbox><img src="'+r.qr+'"></div><div class=status>WhatsApp → Linked devices → Link a device se scan karo</div>';
    if(r.ready&&r.session_id){
      clearInterval(timer);
      out.innerHTML='<div class=status style=color:#6DD5C4>✅ Link ho gaya!</div><textarea id=ses readonly>'+r.session_id+'</textarea><button class=go onclick="navigator.clipboard.writeText(ses.value);this.textContent=\'Copy ho gaya ✓\'">SESSION_ID Copy Karo</button><div class=steps>1️⃣ Upar SESSION_ID copy karo<br>2️⃣ Bot server par <b>SESSION_ID="..."</b> env laga kar bot start karo<br>3️⃣ Bot seedha connect hoga — dobara pairing nahi<br>⚠️ Ye kisi ko mat do — is se tumhara WhatsApp khulta hai</div>';
      st.textContent='';
    }
  },3000);
}
</script></div></body></html>`;
