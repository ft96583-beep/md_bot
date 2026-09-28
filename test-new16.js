/** Mock dispatch test for the 16 new commands (Boss ki demand wali). */
const { commands } = require('./lib/commands.js');

function mockSock() {
  const sent = [];
  return {
    sent,
    user: { id: '923448072653@s.whatsapp.net' },
    async sendMessage(jid, content, opts) {
      const keys = Object.keys(content || {});
      let type = keys.join(',');
      if (content.text) type = 'text:' + content.text.slice(0, 120).replace(/\n/g, ' ');
      if (content.image) type = 'image:' + (content.caption || '').slice(0, 80);
      if (content.video) type = 'video:' + (content.caption || '').slice(0, 80);
      if (content.audio) type = 'audio';
      sent.push({ jid, type });
      return { key: { id: 'm' + Date.now() } };
    },
    async sendPresenceUpdate() {},
    async readMessages() {},
    async groupSettingUpdate() { return true; },
    async updateBlockStatus() { return true; },
    async groupFetchAllParticipating() {
      return { 'g1@g.us': {}, 'g2@g.us': {}, 'g3@g.us': {} };
    },
    async profilePictureUrl() { return 'https://example.com/pp.jpg'; },
  };
}
function mockMsg(text, extra = {}) {
  return {
    key: { remoteJid: '923448072653@s.whatsapp.net', fromMe: true, id: 't' + Math.random().toString(36).slice(2), participant: undefined },
    message: { conversation: text },
    messageTimestamp: Date.now() / 1000,
    ...extra,
  };
}
const JID = '923448072653@s.whatsapp.net';
const SENDER = '923448072653@s.whatsapp.net';

async function run(name, argStr, msgExtra) {
  const cmd = commands[name];
  if (!cmd) return { name, status: 'MISSING' };
  const sock = mockSock();
  const text = '.' + name + (argStr ? ' ' + argStr : '');
  const msg = mockMsg(text, msgExtra);
  const args = argStr ? argStr.split(' ') : [];
  try {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 60s')), 60000));
    await Promise.race([cmd.run(sock, msg, args, { sender: SENDER, jid: JID }), timeout]);
    return { name, status: 'OK', sent: sock.sent.map((s) => s.type) };
  } catch (e) {
    return { name, status: 'FAIL: ' + e.message, sent: sock.sent.map((s) => s.type) };
  }
}

(async () => {
  const tests = [
    // [name, args, msgExtra]
    ['screenshot', 'google.com'],
    ['webshot', 'google.com'],
    ['getdp', ''],
    ['sudo', ''],                       // usage error expected (no number) -> still OK path
    ['delsudo', ''],
    ['listsudo', ''],
    ['mute', ''],
    ['unmute', ''],
    ['shadi', 'Ali & Sara'],
    ['marriage', 'Ali & Sara'],
    ['ship', 'Ali | Sara'],
    ['vv3', ''],                        // no quoted view-once -> usage error path
    ['ttmp3', ''],                      // usage error path (no link)
    ['mentionme', ''],
    ['statuslike', ''],
    ['alwaysonline', ''],
    ['gcstatusall', 'Test broadcast message'],
    ['dua', ''],
    ['dua', 'sick'],
    ['duasick', ''],
    ['duaayatqursi', ''],
    ['duaname', 'Ali'],
    ['duapakistan', ''],
    ['sound', 'list'],
    ['sound', ''],
    ['sound1', ''],
    ['sound16', ''],
    ['drama', 'kabhi main kabhi tum ep 4'],
  ];
  let pass = 0, fail = 0;
  for (const [n, a, x] of tests) {
    const r = await run(n, a, x);
    const ok = r.status === 'OK';
    if (ok) pass++; else fail++;
    console.log((ok ? '✅' : '❌') + ' .' + n + (a ? ' ' + a : '') + ' → ' + r.status + (r.sent && r.sent.length ? ' | sent: ' + r.sent.join(' / ') : ''));
  }
  console.log(`\nRESULT: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
