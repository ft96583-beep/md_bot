/**
 * Nostr relay client for YouTube audio downloads.
 * Publishes a job to the private AllVid relay worker and waits for the result.
 * The worker downloads via yt-dlp (android client, IPv6/IPv4 alternation) and
 * uploads the m4a to Catbox, then publishes the URL back.
 */
const WebSocket = require('ws');
const NT = require('nostr-tools');
const { HttpsProxyAgent } = require('https-proxy-agent');

const RELAYS = ['wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.snort.social'];
const JOB_TAG = 'allvid-pk-job';
const RES_TAG = 'allvid-pk-res';
const WORKER_PUBKEY = '152115bf704d9ffa0b52081716751ccb8d580ff90a80e58aa369ac3c82d25d6f';

// Proxy support: Node ws doesn't use env proxies automatically, but Python does.
// Use the proxy for WSS connections so Nostr works from the bot.
function getProxyAgent() {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy;
  if (proxy) {
    try { return new HttpsProxyAgent(proxy); } catch (e) {}
  }
  return undefined;
}

function randHex(n) {
  return require('crypto').randomBytes(n).toString('hex');
}

/**
 * Request audio download of a YouTube search query.
 * @param {string} query - search text, e.g. "moye moye"
 * @param {number} timeoutMs - max wait (default 180s)
 * @returns {Promise<{url, title}>} - direct Catbox/uguu URL to the m4a
 */
async function requestSong(query, timeoutMs = 180000) {
  // Step 1: resolve search -> real YouTube URL (relay ALLOWED only accepts http URLs)
  const { execFile } = require('child_process');
  const videoUrl = await new Promise((resolve, reject) => {
    execFile('/usr/local/bin/yt-dlp', ['--force-ipv6', 'ytsearch1:' + query, '--skip-download', '--print', '%(webpage_url)s', '--no-warnings'],
      { timeout: 60000 }, (err, stdout) => {
        if (err) return reject(err);
        const u = String(stdout || '').trim().split('\n').filter(Boolean)[0];
        if (u && /^https?:\/\//.test(u)) resolve(u);
        else reject(new Error('no-url'));
      });
  });

  const sk = NT.generateSecretKey();
  const pk = NT.getPublicKey(sk);
  const jobId = randHex(8);

  return new Promise((resolve, reject) => {
    let done = false;
    const conns = [];
    const cleanup = () => {
      clearTimeout(timer);
      for (const w of conns) { try { w.close(); } catch (e) {} }
    };
    const timer = setTimeout(() => {
      if (!done) { done = true; cleanup(); reject(new Error('relay.timeout')); }
    }, timeoutMs);

    const job = NT.finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', JOB_TAG], ['id', jobId]],
      content: JSON.stringify({ id: jobId, url: videoUrl, audio: true, from: Buffer.from(pk).toString('hex') }),
      pubkey: Buffer.from(pk).toString('hex'),
    }, sk);

    const sub = JSON.stringify(['REQ', 'song' + jobId, {
      kinds: [1], '#t': [RES_TAG], since: Math.floor(Date.now() / 1000) - 10,
    }]);
    const pub = JSON.stringify(['EVENT', job]);

    let opened = 0;
    const agent = getProxyAgent();
    for (const r of RELAYS) {
      let ws;
      try { ws = new WebSocket(r, { handshakeTimeout: 15000, agent }); }
      catch (e) { continue; }
      conns.push(ws);
      ws.on('open', () => {
        opened++;
        try { ws.send(sub); ws.send(pub); } catch (e) {}
      });
      ws.on('message', (data) => {
        if (done) return;
        try {
          const m = JSON.parse(data.toString());
          if (m[0] === 'EVENT' && m[2] && m[2].pubkey === WORKER_PUBKEY) {
            const c = JSON.parse(m[2].content || '{}');
            if (c && c.id === jobId) {
              done = true; cleanup();
              if (c.error) reject(new Error('relay.' + c.error));
              else if (c.file || c.url) resolve({ url: c.file || c.url, title: c.title || c.name || query });
              else reject(new Error('relay.empty'));
            }
          }
        } catch (e) {}
      });
      ws.on('error', () => {});
    }
    // if no relay connects at all, fail fast-ish
    setTimeout(() => {
      if (!done && opened === 0 && conns.length > 0) {
        // still waiting for first open; let the main timer handle it
      }
    }, 20000);
  });
}

module.exports = { requestSong };
