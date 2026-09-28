// ─── 📣 panel-push — Owner Panel push notification queue ───
// Jab koi owner ko paigham bheje (.contact lead save ho), to Owner Panel
// (khula ho to) foran notification dikhaye. Ye module sirf ek JSONL queue
// file mein line append karta hai; owner-relay.py usay parh kar Nostr par
// encrypted push event publish karta hai (panel secret se encrypted).
// Manager + worker dono se require ho sakta hai — likhna hamesha bot BASE
// dir mein hota hai (absolute path), is liye worker se bhi safe hai.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUEUE_FILE = path.join(__dirname, '..', 'owner-push.jsonl');

function queuePanelPush(payload) {
  try {
    const line = JSON.stringify({
      mid: crypto.randomBytes(8).toString('hex'),
      at: Date.now(),
      ...(payload || {}),
    });
    fs.appendFileSync(QUEUE_FILE, line + '\n');
    // Queue file barhne na paye — 500KB se upar ho to purani lines saaf
    try {
      const st = fs.statSync(QUEUE_FILE);
      if (st.size > 500 * 1024) {
        const lines = fs.readFileSync(QUEUE_FILE, 'utf8').trim().split('\n');
        fs.writeFileSync(QUEUE_FILE, lines.slice(-200).join('\n') + '\n');
      }
    } catch {}
    return true;
  } catch {
    return false;
  }
}

module.exports = { queuePanelPush, QUEUE_FILE };
