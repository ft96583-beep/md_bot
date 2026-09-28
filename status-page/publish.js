#!/usr/bin/env node
// NEXORA-MD live status page publisher.
// Polls the localhost-only manager API, shows FULL numbers (Boss ka hukm —
// URL secret hai, sirf Boss ke paas), generates a Rexai-themed static page
// and publishes it to surge.sh on a secret path. Run every 5 minutes via cron.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const PUBLIC_DIR = path.join(DIR, 'public');
const SECRET_FILE = path.join(DIR, '.secret');
const LAST_GOOD = path.join(DIR, 'last-good.json');
const STATE_FILE = path.join(DIR, '.publish-state.json');
const DOMAIN = 'nexora-md-status.surge.sh'; // 2026-09-23: purana domain account #2 ka tha (token overwrite ho gaya) — ab bot ke naye surge account par
const API = 'http://127.0.0.1:3000/api/accounts';

// Surge rate-limit backoff (2026-09-22): surge "Try again in N hours" de to
// us window mein push skip karo — har 5 min retry se ban extend ho sakta hai.
function getBackoffUntil() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return s.surge_backoff_until || 0;
  } catch { return 0; }
}
function setBackoffUntil(ts, note) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  s.surge_backoff_until = ts;
  if (note) s.surge_rate_limit_note = note;
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s), { mode: 0o600 }); } catch {}
}

function getSecret() {
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const s = crypto.randomBytes(10).toString('hex');
  fs.writeFileSync(SECRET_FILE, s + '\n', { mode: 0o600 });
  return s;
}

// 2026-09-24: page ab PUBLIC domain root par hai, is liye numbers HAMESHA
// masked — poora number kabhi public page par nahi. (Pehle secret URL thi,
// tab full numbers theek thay; ab nahi.)
const showNum = (num) => {
  const d = String(num || '').replace(/\D/g, '');
  if (!d) return '—';
  if (d.length <= 6) return d.slice(0, 2) + '••••';
  return d.slice(0, 4) + ' •••••• ' + d.slice(-2);
};

const pkTime = (ts) => new Date(ts).toLocaleString('en-GB', {
  timeZone: 'Asia/Karachi', day: '2-digit', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: true,
});

function hueFor(s){ let h=0; s=String(s||'?'); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))%360; return h; }

function card(a, i) {
  const on = !!a.connected;
  const h = hueFor(a.num);
  const roleCls = a.role === 'MAIN' ? 'main' : 'worker';
  const roleIcon = a.role === 'MAIN' ? '👑' : '🤖';
  const stTxt = on ? '💚 ONLINE' : '💤 OFFLINE';
  return `
  <div class="card ${on ? 'on' : 'off'}" style="animation-delay:${(i * 0.09).toFixed(2)}s">
    <div class="crow">
      <div class="cav" style="background:linear-gradient(135deg,hsl(${h},75%,62%),hsl(${(h + 50) % 360},70%,48%))">${roleIcon}</div>
      <div class="cinfo">
        <div class="cnum">${a.num}</div>
        <div class="crole"><span class="role ${roleCls}">${a.role}</span><span class="meta">${a.extra}</span></div>
      </div>
      <div class="spill ${on ? 'on' : 'off'}">${stTxt}</div>
    </div>
  </div>`;
}

const NEXA_LINES = [
  'Boss, sab accounts meri nazar mein hain 👀💗',
  'Koi account offline ho to foran bataungi! 🔔',
  'Ye page har 5 min mein khud update hota hai ✨',
  'NEXORA-MD hamesha ready, hamesha cute 💎',
];

function buildHtml(accounts, updatedAt, stale) {
  const cards = accounts.map(card).join('\n');
  const total = accounts.length;
  const onCount = accounts.filter((a) => a.connected).length;
  const pct = total ? Math.round((onCount / total) * 100) : 0;
  const C = 2 * Math.PI * 52;
  const dash = (pct / 100 * C).toFixed(1);
  const ringCol = pct === 100 ? '#3ddc84' : pct > 0 ? '#ffd166' : '#ff5d5d';
  const vibe = !total ? 'Abhi koi account registered nahi 😶'
    : pct === 100 ? 'Sab theek hai Boss! 💗'
    : onCount > 0 ? 'Kuch accounts araam farma rahe hain 😴'
    : 'Bot offline lag raha hai 🔴';
  const vibeCls = pct === 100 ? 'happy' : onCount > 0 ? 'sleepy' : 'down';
  const nexa = NEXA_LINES[Math.floor(updatedAt / 300000) % NEXA_LINES.length];
  const livePill = onCount > 0
    ? '<span class="pill live"><span class="ldot"></span>LIVE</span>'
    : '<span class="pill dead">OFFLINE</span>';
  return `<!DOCTYPE html>
<html lang="ur"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>NEXORA-MD • Status 💗</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--primary:#50E8F4;--gold:#ffd166;--mint:#6DD5C4;--muted:#7FA3A7;--soft:#DFF6F0;--text:#EAF7F8;--danger:#ff5d5d;--line:#50e8f42e}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,sans-serif;color:var(--text);min-height:100vh;-webkit-tap-highlight-color:transparent}
/* ═══ Cinematic background ═══ */
.bg{position:fixed;inset:0;z-index:-1;overflow:hidden;
  background:radial-gradient(1100px 550px at 50% -12%, #07444d 0%, #001619 55%, #000d0f 100%)}
.orb{position:absolute;border-radius:50%;filter:blur(70px);opacity:.35;animation:drift 14s ease-in-out infinite alternate}
.orb.a{width:340px;height:340px;left:-90px;top:-70px;background:#0e7d8c}
.orb.b{width:280px;height:280px;right:-80px;top:22%;background:#0a5a4a;animation-delay:-5s}
.orb.c{width:300px;height:300px;left:20%;bottom:-120px;background:#0b4a5e;animation-delay:-9s}
@keyframes drift{from{transform:translate(0,0) scale(1)}to{transform:translate(40px,30px) scale(1.12)}}
.stars{position:absolute;inset:0}
.stars i{position:absolute;width:3px;height:3px;border-radius:50%;background:#C7F8FE;opacity:.5;animation:tw 3s infinite}
@keyframes tw{0%,100%{opacity:.15;transform:scale(.8)}50%{opacity:.8;transform:scale(1.2)}}
.grid{position:absolute;inset:0;opacity:.05;
  background-image:linear-gradient(#50e8f4 1px,transparent 1px),linear-gradient(90deg,#50e8f4 1px,transparent 1px);
  background-size:44px 44px;
  -webkit-mask-image:radial-gradient(600px 400px at 50% 0%, #000 30%, transparent 75%);
          mask-image:radial-gradient(600px 400px at 50% 0%, #000 30%, transparent 75%)}
.wrap{width:100%;max-width:480px;margin:0 auto;padding:20px 16px 56px;animation:rise .5s ease both}
@keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
/* ═══ Header ═══ */
header{display:flex;align-items:center;gap:14px;padding:16px 2px 0}
.emblem{width:62px;height:62px;border-radius:22px;flex-shrink:0;position:relative;
  background:conic-gradient(from 200deg,#0a3038,#0e4a53,#0a3038);
  border:1px solid #50e8f455;display:flex;align-items:center;justify-content:center;font-size:32px;
  box-shadow:0 0 28px #50e8f466, inset 0 0 18px #50e8f422;animation:floaty 4s ease-in-out infinite}
@keyframes floaty{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-6px) rotate(2deg)}}
.emblem::after{content:'';position:absolute;inset:-4px;border-radius:26px;
  border:1px solid #50e8f433;animation:pulse 2.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.4;transform:scale(1)}50%{opacity:1;transform:scale(1.05)}}
.htitle h1{margin:0;font-size:22px;letter-spacing:.4px;font-weight:800;
  background:linear-gradient(100deg,#fff 20%,var(--primary) 55%,var(--mint) 90%);
  -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.htitle .sub{display:flex;align-items:center;gap:6px;margin-top:6px;flex-wrap:wrap}
.pill{font-size:9px;font-weight:800;letter-spacing:1.6px;padding:4px 10px;border-radius:20px;display:inline-flex;align-items:center;gap:6px}
.pill.st{color:var(--primary);background:#50e8f422;border:1px solid #50e8f444}
.pill.ver{color:var(--mint);background:#6dd5c422;border:1px solid #6dd5c444}
.pill.prem{color:#2a1c00;background:linear-gradient(135deg,var(--gold),#ff9f5a);border:1px solid #ffd16688;
  box-shadow:0 0 14px #ffd16655}
.pill.live{color:#7df0a8;background:#3ddc8422;border:1px solid #3ddc8455}
.pill.dead{color:#ff9b9b;background:#ff5d5d22;border:1px solid #ff5d5d55}
.ldot{width:7px;height:7px;border-radius:50%;background:#3ddc84;box-shadow:0 0 8px #3ddc84;animation:blink 1.6s infinite}
@keyframes blink{50%{opacity:.4}}
/* ═══ Health overview ═══ */
.hero{margin-top:18px;background:linear-gradient(165deg,#0b323acc,#062529ee);
  border:1px solid var(--line);border-radius:26px;padding:20px;
  display:flex;align-items:center;gap:18px;
  box-shadow:0 12px 40px #0008, inset 0 1px 0 #ffffff14;backdrop-filter:blur(10px)}
.ring{position:relative;width:118px;height:118px;flex-shrink:0}
.ring svg{transform:rotate(-90deg)}
.ring .pct{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring .pct b{font-family:'Space Grotesk',sans-serif;font-size:22px}
.ring .pct span{font-size:9px;color:var(--muted);letter-spacing:1.2px}
.hinfo{flex:1;min-width:0}
.hinfo .vibe{font-size:16px;font-weight:700;line-height:1.5}
.hinfo .vibe.happy{color:#7df0a8}.hinfo .vibe.sleepy{color:var(--gold)}.hinfo .vibe.down{color:#ff9b9b}
.hinfo .ago{margin-top:8px;font-size:12px;color:var(--muted)}
.hinfo .ago b{color:var(--primary)}
/* ═══ Nexa bubble ═══ */
.nexa{margin-top:14px;display:flex;gap:10px;align-items:flex-start;animation:rise .5s .15s ease both}
.nexa .npic{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  font-size:20px;background:linear-gradient(135deg,#ff9ecf,#b388ff);box-shadow:0 0 16px #ff9ecf66}
.nexa .nbub{background:#0b323acc;border:1px solid var(--line);border-radius:4px 18px 18px 18px;
  padding:11px 14px;font-size:13.5px;line-height:1.6;color:var(--soft);box-shadow:0 8px 24px #0006}
/* ═══ Account cards ═══ */
.sec{margin:20px 2px 0;font-size:11px;font-weight:800;letter-spacing:2.2px;color:var(--muted)}
.card{background:linear-gradient(165deg,#0b323acc,#062529ee);
  border:1px solid var(--line);border-radius:22px;padding:16px;margin-top:12px;
  box-shadow:0 12px 40px #0008, inset 0 1px 0 #ffffff14;backdrop-filter:blur(10px);
  animation:rise .5s ease both;transition:transform .2s, box-shadow .2s}
.card:hover{transform:translateY(-2px);box-shadow:0 16px 44px #000a,0 0 24px #50e8f422}
.card.on{border-color:#3ddc8444}
.card.off{opacity:.85}
.crow{display:flex;align-items:center;gap:12px}
.cav{width:48px;height:48px;border-radius:16px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
  font-size:22px;box-shadow:0 0 14px #0008}
.cinfo{flex:1;min-width:0}
.cnum{font-family:'Space Grotesk',sans-serif;font-size:18px;font-weight:700;letter-spacing:1px}
.crole{margin-top:6px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.role{font-size:9px;font-weight:800;letter-spacing:1.6px;padding:3px 10px;border-radius:999px}
.role.main{color:#2a1c00;background:linear-gradient(135deg,var(--gold),#ff9f5a);box-shadow:0 0 12px #ffd16644}
.role.worker{color:var(--primary);background:#50e8f422;border:1px solid #50e8f444}
.meta{color:var(--muted);font-size:11.5px}
.spill{font-size:10.5px;font-weight:800;letter-spacing:1px;padding:7px 13px;border-radius:999px;white-space:nowrap;flex-shrink:0}
.spill.on{color:#7df0a8;background:#3ddc8422;border:1px solid #3ddc8455;box-shadow:0 0 14px #3ddc8433;animation:blink 2.4s infinite}
.spill.off{color:#ff9b9b;background:#ff5d5d1a;border:1px solid #ff5d5d44}
.empty{color:var(--muted);background:linear-gradient(165deg,#0b323acc,#062529ee);
  border:1px dashed #50e8f444;border-radius:22px;padding:24px;text-align:center;font-size:14px;margin-top:12px;line-height:1.8}
.stale{margin-top:14px;background:#3a2a0a99;border:1px solid #ffd16655;color:#ffd9a0;
  border-radius:16px;padding:12px 16px;font-size:13px;text-align:center;line-height:1.6}
.foot{margin-top:26px;color:#5c7a7e;font-size:12px;text-align:center;line-height:2}
.foot .sig{color:var(--primary);font-weight:700}
</style></head><body>
<div class="bg"><div class="orb a"></div><div class="orb b"></div><div class="orb c"></div>
<div class="stars" id="stars"></div><div class="grid"></div></div>
<div class="wrap">
<header>
  <div class="emblem">🤖</div>
  <div class="htitle">
    <h1>NEXORA-MD</h1>
    <div class="sub">${livePill}<span class="pill st">STATUS</span><span class="pill prem">✦ PREMIUM</span></div>
  </div>
</header>
<div class="hero">
  <div class="ring">
    <svg width="118" height="118" viewBox="0 0 118 118">
      <circle cx="59" cy="59" r="52" fill="none" stroke="#0e3a42" stroke-width="10"/>
      <circle cx="59" cy="59" r="52" fill="none" stroke="${ringCol}" stroke-width="10" stroke-linecap="round"
        stroke-dasharray="${dash} ${C.toFixed(1)}" style="filter:drop-shadow(0 0 6px ${ringCol});transition:stroke-dasharray 1s"/>
    </svg>
    <div class="pct"><b>${onCount}/${total}</b><span>ONLINE</span></div>
  </div>
  <div class="hinfo">
    <div class="vibe ${vibeCls}">${vibe}</div>
    <div class="ago"><span id="ago">abhi</span> update hua • agla <b id="next">2:00</b> mein</div>
  </div>
</div>
<div class="nexa"><div class="npic">💗</div><div class="nbub">${nexa}</div></div>
${stale ? '<div class="stale">⚠️ Bot se rabta nahi ho saka — ye aakhri maloom halat hai.</div>' : ''}
<div class="sec">ACCOUNTS</div>
${cards || '<div class="empty">💤 Abhi koi account registered nahi.<br>Bot restart hote hi yahan nazar aayenge.</div>'}
<div class="foot">Last update: ${pkTime(updatedAt)} (PKT)<br>
Page har 2 min khud refresh hota hai • data har 5 min update hota hai<br>
<span class="sig">— Nexa 💗 NEXORA-MD</span></div>
</div>
<script>
(function(){
  var upd=${updatedAt};
  function agoStr(){
    var s=Math.max(0,Math.floor((Date.now()-upd)/1000));
    if(s<10) return 'abhi';
    if(s<60) return s+' sec pehle';
    var m=Math.floor(s/60); return m+(m===1?' min pehle':' min pehle');
  }
  var t0=Date.now();
  setInterval(function(){
    var a=document.getElementById('ago'); if(a) a.textContent=agoStr();
    var left=Math.max(0,120-Math.floor((Date.now()-t0)/1000));
    var n=document.getElementById('next');
    if(n) n.textContent=Math.floor(left/60)+':'+('0'+(left%60)).slice(-2);
  },1000);
  var st=document.getElementById('stars');
  if(st){ var h=''; for(var i=0;i<28;i++){
    h+='<i style="left:'+(Math.random()*100).toFixed(1)+'%;top:'+(Math.random()*100).toFixed(1)+'%;animation-delay:'+(Math.random()*3).toFixed(1)+'s"></i>';
  } st.innerHTML=h; }
})();
</script>
</body></html>`;
}
async function main() {
  const secret = getSecret();
  let data = null;
  let stale = false;
  try {
    const r = await fetch(API, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('bad status ' + r.status);
    const d = await r.json();
    const accounts = [{
      num: showNum(d.main && d.main.number),
      connected: !!(d.main && d.main.connected),
      role: 'MAIN', extra: 'mode: ' + ((d.main && d.main.mode) || '—'),
    }];
    for (const w of (d.workers || [])) {
      accounts.push({
        num: showNum(w.number), connected: !!w.connected,
        role: 'WORKER', extra: 'port :' + (w.port || '—') + ' • mode: ' + (w.mode || '—'),
      });
    }
    data = { accounts, updatedAt: Date.now() };
    fs.writeFileSync(LAST_GOOD, JSON.stringify(data), { mode: 0o600 });
  } catch (e) {
    stale = true;
    if (fs.existsSync(LAST_GOOD)) data = JSON.parse(fs.readFileSync(LAST_GOOD, 'utf8'));
    else data = { accounts: [], updatedAt: Date.now() };
  }
  // Boss ka hukm (2026-09-21): page domain ROOT par ho — chhota URL, koi hash path nahi.
  // NOTE: ab yeh public hai — jis ke paas link hoga woh full numbers dekh sakega.
  const outDir = PUBLIC_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), buildHtml(data.accounts, data.updatedAt, stale));
  // Rate-limit backoff: window active ho to push skip (HTML local build ho chuka).
  const backoffUntil = getBackoffUntil();
  if (Date.now() < backoffUntil) {
    console.log('surge backoff active until ' + new Date(backoffUntil).toISOString() + ' — push skipped, local HTML rebuilt');
    return;
  }
  try {
    // 2026-09-23: status domain BOT ke dedicated surge account ki ownership mein hai;
    // ~/.netrc mein account #2 hai, is liye bot HOME override zaroori hai.
    const botHome = path.resolve(DIR, '..', '..', '.surge-bot-home');
    execFileSync('surge', [PUBLIC_DIR, DOMAIN], {
      stdio: 'pipe', timeout: 90000,
      env: { ...process.env, HOME: botHome, PATH: `${process.env.HOME || '/home/hatch'}/workspace/npm-global/bin:${process.env.PATH || ''}` },
    });
  } catch (e) {
    // 2026-09-26 fix: e.stderr/e.stdout execFileSync errors mein Buffer hote hain —
    // khaali Buffer bhi truthy hota hai, is liye (e.stderr || e.stdout) khaali
    // stderr par atak kar stdout ka message (jahan surge kabhi 'try again in N
    // hours' likhta hai) gira deta tha. Dono ko hamesha joro.
    const stderrS = e.stderr ? String(e.stderr) : '';
    const stdoutS = e.stdout ? String(e.stdout) : '';
    const msg = (stderrS + ' ' + stdoutS + ' ' + (e.message || '')).trim();
    // 2026-09-24: surge kabhi stderr truncate kar deta hai ya hang ho kar timeout
    // deta hai — "Aborted - Rate limited ... try again in 17 hours" har lafz mein
    // na bhi aaye to "try again" + "aborted" combo ko bhi rate-limit mano.
    // 2026-09-26: "Verify email or try again in 16 hours" phrasing bhi cooldown
    // hi hai — baghair 'aborted'/'rate limit' lafzon ke bhi pakro.
    const m = msg.match(/try again in (\d+)\s*hours?/i);
    const rateLimited = /rate.?limit/i.test(msg)
      || (/aborted/i.test(msg) && /try again/i.test(msg))
      || /try again in \d+\s*hours?/i.test(msg);
    if (rateLimited) {
      const hours = m ? parseInt(m[1], 10) : 17;
      const until = Date.now() + (hours * 3600 + 600) * 1000; // 10 min buffer
      setBackoffUntil(until, "surge says '" + msg.trim().slice(0, 120) + "' as of " + new Date().toISOString());
      console.log('surge rate-limited — backoff until ' + new Date(until).toISOString() + ', push skipped');
      return; // backoff lag gaya: ye failure nahi, scheduled wait hai
    }
    throw e;
  }
  setBackoffUntil(0); // kamyab push: purana backoff saaf
  console.log('published: https://' + DOMAIN + '/  stale=' + stale);
}

main().catch((e) => { console.error('publish failed:', e.message); process.exit(1); });
