/**
 * Comprehensive command tester for NEXORA-MD.
 * Tests each command with mocked sock/msg and captures real outputs.
 * Usage: node test-all-commands.js
 */
const { commands } = require('./lib/commands.js');
const fs = require('fs');

// Mock sock that captures all sent messages
function createMockSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(jid, content, opts) {
      sent.push({ jid, content: summarizeContent(content), opts });
      return { key: { id: 'mock_' + Date.now() } };
    },
    async sendPresenceUpdate() {},
    async readMessages() {},
  };
}

function summarizeContent(content) {
  if (!content) return { type: 'empty' };
  if (content.text) return { type: 'text', text: content.text.slice(0, 500) };
  if (content.video) return { type: 'video', caption: (content.caption || '').slice(0, 200) };
  if (content.image) return { type: 'image', caption: (content.caption || '').slice(0, 200) };
  if (content.audio) return { type: 'audio' };
  if (content.sticker) return { type: 'sticker' };
  if (content.document) return { type: 'document' };
  return { type: Object.keys(content).join(',') };
}

function createMockMsg(cmdName, args = []) {
  return {
    key: {
      remoteJid: '923448072653@s.whatsapp.net',
      fromMe: true,
      id: 'mockmsg_' + Date.now(),
    },
    message: {
      extendedTextMessage: {
        text: '.' + cmdName + (args.length ? ' ' + args.join(' ') : ''),
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

async function testCommand(name, cmd) {
  const sock = createMockSock();
  const msg = createMockMsg(name);
  const jid = '923448072653@s.whatsapp.net';
  const sender = '923448072653@s.whatsapp.net';

  const result = {
    name,
    desc: cmd.desc || '',
    owner: !!cmd.owner,
    admin: !!cmd.admin,
    status: 'unknown',
    outputs: [],
    error: null,
  };

  try {
    // Provide sensible test args for commands that need them
    let args = [];
    const descLower = (cmd.desc || '').toLowerCase();
    const nameLower = name.toLowerCase();

    // Heuristic: provide example args based on command type
    if (/sticker/.test(nameLower) && !/toimg|tovid/.test(nameLower)) args = [];
    else if (/song|play/.test(nameLower)) args = ['pasoori'];
    else if (/tiktok|ig|fb|insta/.test(nameLower)) args = [];
    else if (/ai|gpt|ask/.test(nameLower)) args = ['hello'];
    else if (/translate|trt/.test(nameLower)) args = ['hello'];
    else if (/weather/.test(nameLower)) args = ['karachi'];

    const timeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('TIMEOUT_30s')), 30000)
    );

    await Promise.race([
      cmd.run(sock, msg, args, { jid, sender, sock }),
      timeout,
    ]);

    result.status = 'ok';
    result.outputs = sock.sent.slice(0, 3); // first 3 outputs
  } catch (e) {
    result.status = 'failed';
    result.error = String(e.message || e).slice(0, 200);
    result.outputs = sock.sent.slice(0, 3);
  }

  return result;
}

async function main() {
  const keys = Object.keys(commands).sort();
  console.log(`Testing ${keys.length} commands...\n`);

  const results = [];
  let ok = 0, failed = 0;

  for (const name of keys) {
    const cmd = commands[name];
    if (!cmd || typeof cmd.run !== 'function') {
      results.push({ name, status: 'no-run', desc: cmd?.desc || '' });
      continue;
    }

    const r = await testCommand(name, cmd);
    results.push(r);
    if (r.status === 'ok') ok++;
    else failed++;

    if (r.status === 'failed') {
      console.log(`❌ ${name}: ${r.error}`);
    }
    // Small delay to avoid overwhelming
    await new Promise(res => setTimeout(res, 100));
  }

  console.log(`\n========== SUMMARY ==========`);
  console.log(`Total: ${keys.length} | OK: ${ok} | Failed: ${failed}`);

  // Save detailed results
  fs.writeFileSync('/tmp/command_test_results.json', JSON.stringify(results, null, 2));
  console.log('Results saved to /tmp/command_test_results.json');

  // List failed commands
  if (failed > 0) {
    console.log('\nFailed commands:');
    results.filter(r => r.status === 'failed').forEach(r => {
      console.log(`  - ${r.name}: ${r.error}`);
    });
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
