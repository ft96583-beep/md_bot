// ═══════════════════════════════════════════════════════════════
// NEXORA GROUP KIT — group management commands (Boss order 2026-09-24)
// Factory: buildGroupKit(deps) → { commands, onMessage, onGroupUpdate, setSock, groupKitMenuBox }
// NOTE: .antilink / .welcome / .setwelcome / .goodbye / .setgoodbye / .poll /
// .mute / .unmute pehle se commands.js mein maujood hain — unhein dobara
// NAHI banaya (Object.assign overwrite se purana behavior toot jata).
// Yahan sirf NAYE commands hain. Antilink ka "warn" hissa onMessage hook
// mein add hota hai (delete wala hissa commands.js ka maujooda hook karta hai).
// Welcome/goodbye handleGroupUpdate ka maujooda handler bhejta hai.
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

function buildGroupKit(deps) {
  const { reply, config, isOwner, isOwnerMsg, ctxOf, getText, num, downloadMediaMessage } = deps;
  const P = config.prefix || '.';
  const BOTNAME = config.botName || 'NEXORA-MD';
  let SOCK = null;
  const setSock = (s) => { SOCK = s; };

  // ── per-process state (nexus pattern: STATE_FILE ke folder mein) ──
  const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '..', 'state.json');
  const DATA = path.join(path.dirname(STATE_FILE), 'groupkit');
  try { fs.mkdirSync(DATA, { recursive: true }); } catch {}
  const jread = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { return d; } };
  const jwrite = (f, v) => { try { fs.writeFileSync(path.join(DATA, f), JSON.stringify(v)); } catch {} };

  // activity: memory mein, 60s par disk flush (har message par write nahi)
  let ACT = jread('activity.json', {});
  let actFlushAt = 0;
  const flushAct = () => {
    const now = Date.now();
    if (now - actFlushAt > 60000) { actFlushAt = now; jwrite('activity.json', ACT); }
  };

  const LINK_RE = /https?:\/\/|www\.|chat\.whatsapp\.com|t\.me\/|wa\.me\//i;
  // commands.js wala legacy per-group antilink store (sirf READ — delete wahan hota hai)
  const ANTILINK_FILE = path.join(__dirname, '..', 'data', 'antilink.json');
  const legacyAntilink = () => { try { return JSON.parse(fs.readFileSync(ANTILINK_FILE, 'utf8')); } catch { return {}; } };

  const esc = (s) => String(s || '').slice(0, 1500);
  const gstate = (gid) => {
    const all = jread('groups.json', {});
    if (!all[gid]) all[gid] = { warns: {}, rules: '' };
    return { all, st: all[gid] };
  };
  const saveG = (all) => jwrite('groups.json', all);

  // ── group/admin guards (requireAdmin commands.js mein local hai — yahan apna) ──
  async function metaOf(sock, jid) { try { return await sock.groupMetadata(jid); } catch { return null; } }
  function adminSets(sock, meta, sender) {
    const sNum = num(sender);
    const meNum = num(sock.user?.id);
    let senderAdmin = false, botAdmin = false;
    for (const p of meta.participants || []) {
      if (!p.admin) continue;
      const pNums = [num(p.id), num(p.phoneNumber)];
      if (pNums.includes(sNum)) senderAdmin = true;
      if (pNums.includes(meNum)) botAdmin = true;
    }
    return { senderAdmin, botAdmin };
  }
  async function needAdmin(sock, msg, sender, jid, needBot = true) {
    if (!jid.endsWith('@g.us')) return '❌ Ye command sirf group mein chalti hai.';
    const meta = await metaOf(sock, jid);
    if (!meta) return '❌ Group ki maloomat nahi mil saki.';
    const { senderAdmin, botAdmin } = adminSets(sock, meta, sender);
    if (!senderAdmin && !isOwnerMsg(msg, sender, jid)) return '❌ Sirf group admin ye command chala sakta hai.';
    if (needBot && !botAdmin) return '❌ Pehle bot ko group admin banayein.';
    return null;
  }
  function targetOf(msg) {
    const ctx = ctxOf(msg);
    return ctx?.mentionedJid?.[0] || ctx?.participant || null;
  }
  async function addWarn(sock, jid, target, reason) {
    // returns {count, kicked}
    const gid = jid;
    const tnum = num(target);
    const { all, st } = gstate(gid);
    const w = st.warns[tnum] || { count: 0, reasons: [] };
    w.count += 1;
    w.reasons.push({ r: String(reason || 'koi wajah nahi').slice(0, 120), ts: Date.now() });
    if (w.reasons.length > 10) w.reasons = w.reasons.slice(-10);
    st.warns[tnum] = w;
    saveG(all);
    let kicked = false;
    if (w.count >= 3) {
      try { await sock.groupParticipantsUpdate(jid, [target], 'remove'); kicked = true; } catch {}
      delete st.warns[tnum];
      saveG(all);
    }
    return { count: w.count, kicked };
  }

  const commands = {
    gname: {
      desc: 'Group ka naam badlo (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        const t = args.join(' ').trim().slice(0, 100);
        if (!t) return reply(sock, jid, msg, `❌ Usage: *${P}gname <naya naam>*`);
        try {
          await sock.groupUpdateSubject(jid, t);
          await reply(sock, jid, msg, `✅ Group ka naam badal diya: *${esc(t)}* 💗`);
        } catch { await reply(sock, jid, msg, '❌ Naam nahi badal saka (bot admin hai?).'); }
      },
    },
    gdesc: {
      desc: 'Group ki tafseel badlo (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        const t = args.join(' ').trim().slice(0, 500);
        if (!t) return reply(sock, jid, msg, `❌ Usage: *${P}gdesc <nayi tafseel>*`);
        try {
          await sock.groupUpdateDescription(jid, t);
          await reply(sock, jid, msg, `✅ Group ki tafseel update ho gayi 💗`);
        } catch { await reply(sock, jid, msg, '❌ Tafseel nahi badal saki (bot admin hai?).'); }
      },
    },
    gpic: {
      desc: 'Group photo badlo — image par reply (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        const q = ctxOf(msg)?.quotedMessage;
        const imgM = q?.imageMessage;
        if (!imgM) return reply(sock, jid, msg, `❌ Kisi image ke reply mein *${P}gpic* likhein.`);
        try {
          const buf = await downloadMediaMessage({ key: msg.key, message: { imageMessage: imgM } }, 'buffer', {});
          if (!buf?.length) throw new Error('empty');
          await sock.updateProfilePicture(jid, { img: buf });
          await reply(sock, jid, msg, '✅ Group photo badal di 💗');
        } catch { await reply(sock, jid, msg, '❌ Photo nahi badal saki (bot admin hai?).'); }
      },
    },
    warn: {
      desc: 'Member ko warning do — 3 par auto-kick (admin)',
      admin: true,
      run: async (sock, msg, args, { sender, jid }) => {
        const target = targetOf(msg);
        if (!target) return reply(sock, jid, msg, `❌ Tag karein ya reply karein: *${P}warn @user [wajah]*`);
        if (isOwner(target)) return reply(sock, jid, msg, '❌ Owner ko warn nahi kar sakte!');
        if (num(target) === num(sock.user?.id)) return reply(sock, jid, msg, '❌ Khud ko warn nahi kar sakti 😄');
        const reason = args.filter((a) => !a.startsWith('@')).join(' ').trim() || 'koi wajah nahi';
        const { count, kicked } = await addWarn(sock, jid, target, reason);
        if (kicked) {
          await sock.sendMessage(jid, { text: `👢 @${num(target)} ko 3 warnings par group se nikaal diya.\n\n— Nexa 💗`, mentions: [target] });
        } else {
          await sock.sendMessage(jid, { text: `⚠️ @${num(target)} ko warning *${count}/3* mili.\nWajah: ${esc(reason)}\n\n3 par auto-kick! — Nexa 💗`, mentions: [target] });
        }
      },
    },
    warns: {
      desc: 'Warnings dekho',
      run: async (sock, msg, args, { jid }) => {
        if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf group mein chalti hai.');
        const { st } = gstate(jid);
        const target = targetOf(msg);
        if (target) {
          const w = st.warns[num(target)];
          if (!w) return sock.sendMessage(jid, { text: `✅ @${num(target)} ki koi warning nahi. 💗`, mentions: [target] });
          const list = w.reasons.map((r, i) => `${i + 1}. ${esc(r.r)}`).join('\n');
          return sock.sendMessage(jid, { text: `⚠️ @${num(target)} — warnings: *${w.count}/3*\n${list}\n\n— Nexa 💗`, mentions: [target] });
        }
        const entries = Object.entries(st.warns);
        if (!entries.length) return reply(sock, jid, msg, '✅ Is group mein kisi ko warning nahi mili. Sab shareef hain 💗');
        const lines = entries.slice(0, 20).map(([n, w]) => `• @${n} — *${w.count}/3* (${esc(w.reasons[w.reasons.length - 1]?.r || '')})`);
        await sock.sendMessage(jid, { text: `⚠️ *Group warnings*\n\n${lines.join('\n')}\n\n— Nexa 💗`, mentions: entries.slice(0, 20).map(([n]) => n + '@s.whatsapp.net') });
      },
    },
    resetwarn: {
      desc: 'Kisi ki warnings saaf karo (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        const target = targetOf(msg);
        if (!target) return reply(sock, jid, msg, `❌ Tag karein ya reply karein: *${P}resetwarn @user*`);
        const { all, st } = gstate(jid);
        if (!st.warns[num(target)]) return sock.sendMessage(jid, { text: `✅ @${num(target)} ki koi warning thi hi nahi. 💗`, mentions: [target] });
        delete st.warns[num(target)];
        saveG(all);
        await sock.sendMessage(jid, { text: `🧹 @${num(target)} ki warnings saaf kar di. Nayi shuruaat! 💗`, mentions: [target] });
      },
    },
    inactive: {
      desc: 'Ghayab members ki list — .inactive [din]',
      run: async (sock, msg, args, { jid }) => {
        if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf group mein chalti hai.');
        const days = Math.max(1, Math.min(365, parseInt(args[0], 10) || 30));
        const meta = await metaOf(sock, jid);
        if (!meta) return reply(sock, jid, msg, '❌ Group ki maloomat nahi mil saki.');
        const cutoff = Date.now() - days * 86400000;
        const gact = ACT[jid] || {};
        const admins = new Set((meta.participants || []).filter((p) => p.admin).map((p) => num(p.id)));
        const list = [];
        for (const p of meta.participants || []) {
          const n = num(p.id);
          if (n === num(sock.user?.id) || admins.has(n)) continue;
          const last = gact[n] || 0;
          if (last < cutoff) list.push({ n, last });
        }
        if (!list.length) return reply(sock, jid, msg, `✅ Pichhle ${days} din mein sab active rahe! Koi ghayab nahi 💗`);
        list.sort((a, b) => a.last - b.last);
        const show = list.slice(0, 25);
        const lines = show.map((x, i) => `${i + 1}. @${x.n} — ${x.last ? Math.floor((Date.now() - x.last) / 86400000) + ' din pehle' : 'kabhi nahi dekha'}`);
        await sock.sendMessage(jid, {
          text: `😴 *${days} din se ghayab (${list.length})*\n\n${lines.join('\n')}${list.length > 25 ? `\n…aur ${list.length - 25} mazeed` : ''}\n\nNikalne ke liye: *${P}kickinactive ${days}*\n— Nexa 💗`,
          mentions: show.map((x) => x.n + '@s.whatsapp.net'),
        });
      },
    },
    kickinactive: {
      desc: 'Ghayab members nikalo — pehle list, phir confirm (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        const days = Math.max(1, Math.min(365, parseInt(args[0], 10) || 0));
        if (!days) return reply(sock, jid, msg, `❌ Usage: *${P}kickinactive <din>*\nMasalan: *${P}kickinactive 30*\n\nPehle list dikhaongi, phir *${P}kickinactive ${days || 30} yes* se confirm karna.`);
        const meta = await metaOf(sock, jid);
        if (!meta) return reply(sock, jid, msg, '❌ Group ki maloomat nahi mil saki.');
        const cutoff = Date.now() - days * 86400000;
        const gact = ACT[jid] || {};
        const admins = new Set((meta.participants || []).filter((p) => p.admin).map((p) => num(p.id)));
        const targets = [];
        for (const p of meta.participants || []) {
          const n = num(p.id);
          if (n === num(sock.user?.id) || admins.has(n) || isOwner(p.id)) continue;
          if ((gact[n] || 0) < cutoff) targets.push(p.id);
        }
        if (!targets.length) return reply(sock, jid, msg, `✅ ${days} din mein sab active — nikalne ko koi nahi 💗`);
        if ((args[1] || '').toLowerCase() !== 'yes') {
          const show = targets.slice(0, 20).map((t) => num(t));
          return sock.sendMessage(jid, {
            text: `⚠️ *${targets.length} members* ${days} din se ghayab hain:\n\n${show.map((n, i) => `${i + 1}. @${n}`).join('\n')}${targets.length > 20 ? `\n…aur ${targets.length - 20} mazeed` : ''}\n\nPakka nikalna hai? To likhein:\n*${P}kickinactive ${days} yes*\n\n— Nexa 💗`,
            mentions: show.map((n) => n + '@s.whatsapp.net'),
          });
        }
        let ok = 0, fail = 0;
        for (const t of targets) {
          try { await sock.groupParticipantsUpdate(jid, [t], 'remove'); ok++; }
          catch { fail++; }
          await new Promise((r) => setTimeout(r, 800));
        }
        await reply(sock, jid, msg, `👢 *Kickinactive mukammal*\nNikaale: ${ok} ✅\nNa ho sake: ${fail} ❌\n\n— Nexa 💗`);
      },
    },
    rules: {
      desc: 'Group ke usool dekho',
      run: async (sock, msg, args, { jid }) => {
        if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf group mein chalti hai.');
        const { st } = gstate(jid);
        if (!st.rules) return reply(sock, jid, msg, `📋 Is group ke koi usool set nahi.\nAdmin set kare: *${P}setrules <usool>*`);
        await reply(sock, jid, msg, `📋 *Group ke usool*\n\n${esc(st.rules)}\n\n— Nexa 💗`);
      },
    },
    setrules: {
      desc: 'Group ke usool set karo (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        const t = args.join(' ').trim().slice(0, 1500);
        if (!t) return reply(sock, jid, msg, `❌ Usage: *${P}setrules <usool>*\nMasalan: *${P}setrules 1. Izzat se baat karein 2. Link mana hai*`);
        const { all, st } = gstate(jid);
        st.rules = t;
        saveG(all);
        await reply(sock, jid, msg, '✅ Group ke usool set ho gaye 💗');
      },
    },
    ginfo: {
      desc: 'Group ki poori maloomat',
      run: async (sock, msg, args, { jid }) => {
        if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf group mein chalti hai.');
        const meta = await metaOf(sock, jid);
        if (!meta) return reply(sock, jid, msg, '❌ Group ki maloomat nahi mil saki.');
        const parts = meta.participants || [];
        const admins = parts.filter((p) => p.admin);
        const created = meta.creation ? new Date(meta.creation * 1000).toLocaleDateString('en-GB') : 'maloom nahi';
        let invite = '';
        try { invite = `\n🔗 Link: https://chat.whatsapp.com/${await sock.groupInviteCode(jid)}`; } catch {}
        await reply(sock, jid, msg,
          `👥 *${esc(meta.subject)}*\n\n📝 Tafseel: ${esc(meta.desc || 'koi nahi')}\n👤 Members: ${parts.length} (admins: ${admins.length})\n📅 Bana: ${created}${invite}\n\n— Nexa 💗`);
      },
    },
    staff: {
      desc: 'Admins ki list',
      run: async (sock, msg, args, { jid }) => {
        if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf group mein chalti hai.');
        const meta = await metaOf(sock, jid);
        if (!meta) return reply(sock, jid, msg, '❌ Group ki maloomat nahi mil saki.');
        const admins = (meta.participants || []).filter((p) => p.admin);
        if (!admins.length) return reply(sock, jid, msg, '❌ Koi admin nahi mila.');
        const lines = admins.map((p, i) => `${i + 1}. @${num(p.id)}${p.admin === 'superadmin' ? ' 👑' : ''}`);
        await sock.sendMessage(jid, { text: `🛡️ *Group staff (${admins.length})*\n\n${lines.join('\n')}\n\n— Nexa 💗`, mentions: admins.map((p) => p.id) });
      },
    },
    pending: {
      desc: 'Join requests dekho (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        let list = [];
        try { list = await sock.groupRequestParticipantsList(jid); } catch { return reply(sock, jid, msg, '❌ Requests nahi mil sakin (bot admin hai?).'); }
        if (!list?.length) return reply(sock, jid, msg, '✅ Koi pending join request nahi 💗');
        const nums = list.map((v) => num(v.jid || v.participant || ''));
        const lines = nums.slice(0, 25).map((n, i) => `${i + 1}. @${n}`);
        await sock.sendMessage(jid, {
          text: `⏳ *Pending requests (${list.length})*\n\n${lines.join('\n')}${list.length > 25 ? `\n…aur ${list.length - 25} mazeed` : ''}\n\nSab approve: *${P}approveall*\n— Nexa 💗`,
          mentions: nums.slice(0, 25).map((n) => n + '@s.whatsapp.net'),
        });
      },
    },
    approveall: {
      desc: 'Saari join requests approve karo (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        let list = [];
        try { list = await sock.groupRequestParticipantsList(jid); } catch { return reply(sock, jid, msg, '❌ Requests nahi mil sakin (bot admin hai?).'); }
        if (!list?.length) return reply(sock, jid, msg, '✅ Koi pending request nahi 💗');
        const jids = list.map((v) => v.jid || v.participant).filter(Boolean);
        let ok = 0, fail = 0;
        for (const pj of jids) {
          try { await sock.groupRequestParticipantsUpdate(jid, [pj], 'approve'); ok++; } catch { fail++; }
          await new Promise((r) => setTimeout(r, 500));
        }
        await reply(sock, jid, msg, `✅ *Approveall mukammal*\nApprove: ${ok}\nFail: ${fail}\n\n— Nexa 💗`);
      },
    },
    pin: {
      desc: 'Message pin karo — reply mein (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        const ci = ctxOf(msg)?.contextInfo || ctxOf(msg);
        const stanzaId = ci?.stanzaId;
        const participant = ci?.participant;
        if (!stanzaId) return reply(sock, jid, msg, `❌ Kisi message ke reply mein *${P}pin* likhein.`);
        try {
          await sock.sendMessage(jid, { pin: { remoteJid: jid, id: stanzaId, participant: participant || jid, fromMe: false }, type: 1 });
          await reply(sock, jid, msg, '📌 Message pin kar diya 💗');
        } catch { await reply(sock, jid, msg, '❌ Pin nahi ho saka (bot admin hai?).'); }
      },
    },
    unpin: {
      desc: 'Pinned message hatao — reply mein (admin)',
      admin: true,
      run: async (sock, msg, args, { jid }) => {
        const ci = ctxOf(msg)?.contextInfo || ctxOf(msg);
        const stanzaId = ci?.stanzaId;
        const participant = ci?.participant;
        if (!stanzaId) return reply(sock, jid, msg, `❌ Pinned message ke reply mein *${P}unpin* likhein.`);
        try {
          await sock.sendMessage(jid, { pin: { remoteJid: jid, id: stanzaId, participant: participant || jid, fromMe: false }, type: 2 });
          await reply(sock, jid, msg, '📌 Pin hata diya 💗');
        } catch { await reply(sock, jid, msg, '❌ Unpin nahi ho saka.'); }
      },
    },
    report: {
      desc: 'Admins ko report karo — .report @user <wajah>',
      run: async (sock, msg, args, { sender, jid }) => {
        if (!jid.endsWith('@g.us')) return reply(sock, jid, msg, '❌ Ye command sirf group mein chalti hai.');
        const target = targetOf(msg);
        if (!target) return reply(sock, jid, msg, `❌ Tag karein ya reply karein: *${P}report @user <wajah>*`);
        const reason = args.filter((a) => !a.startsWith('@')).join(' ').trim() || 'koi wajah nahi';
        const meta = await metaOf(sock, jid);
        if (!meta) return reply(sock, jid, msg, '❌ Group ki maloomat nahi mil saki.');
        const admins = (meta.participants || []).filter((p) => p.admin).map((p) => p.id);
        if (!admins.length) return reply(sock, jid, msg, '❌ Koi admin nahi mila.');
        await sock.sendMessage(jid, {
          text: `🚨 *REPORT*\n\n👤 Report karne wala: @${num(sender)}\n🎯 Reported: @${num(target)}\n📝 Wajah: ${esc(reason)}\n\nAdmins tawajjo dein! — Nexa 💗`,
          mentions: [sender, target, ...admins],
        });
      },
    },
  };

  // ── menu box (nexus pattern) ──
  function groupKitMenuBox() {
    const box = (title, cmds) => `╭━━━〔 ${title} 〕━━━\n${cmds.map((c) => `┃ ⬡ ${c}`).join('\n')}\n╰━━━━━━━━━━━━━━━━━━`;
    return box('👥 GROUP KIT', [
      `${P}gname / ${P}gdesc / ${P}gpic — group setting 🛠️`,
      `${P}warn / ${P}warns / ${P}resetwarn — warning system ⚠️`,
      `${P}inactive / ${P}kickinactive — ghayab members 😴`,
      `${P}rules / ${P}setrules — group usool 📋`,
      `${P}ginfo / ${P}staff — maloomat 👥`,
      `${P}pending / ${P}approveall — join requests ⏳`,
      `${P}pin / ${P}unpin — reply par 📌`,
      `${P}report — admins ko report 🚨`,
      `_(.antilink .welcome .poll .mute pehle se live hain ✅)_`,
    ]);
  }

  // ── message hook: activity tracking + antilink warn ──
  async function onMessage(sock, msg, jid, sender, text) {
    try {
      if (!jid?.endsWith('@g.us') || msg.key?.fromMe) return;
      const snum = num(sender);
      // activity
      const g = ACT[jid] || (ACT[jid] = {});
      g[snum] = Date.now();
      flushAct();
      // antilink warn (delete commands.js ka maujooda hook karta hai — yahan sirf warn)
      const t = String(text || '');
      if (!t || t.startsWith(P)) return;
      if (!LINK_RE.test(t)) return;
      if (!legacyAntilink()[jid]) return; // is group mein antilink on nahi
      const meta = await metaOf(sock, jid);
      if (!meta) return;
      const { senderAdmin } = adminSets(sock, meta, sender);
      if (senderAdmin || isOwnerMsg(msg, sender, jid)) return;
      const target = sender;
      if (isOwner(target)) return;
      const { count, kicked } = await addWarn(sock, jid, target, 'link bheja (antilink)');
      if (kicked) {
        await sock.sendMessage(jid, { text: `👢 @${snum} ko link par 3 warnings par nikaal diya.\n\n— Nexa 💗`, mentions: [target] });
      } else {
        await sock.sendMessage(jid, { text: `🔗 @${snum} — link mana hai! Warning *${count}/3* ⚠️\n\n— Nexa 💗`, mentions: [target] });
      }
    } catch {}
  }

  // ── group update hook: welcome/goodbye commands.js ka handler bhejta hai ──
  // (duplicate send se bachne ke liye yahan kuch nahi — sirf extension point)
  async function onGroupUpdate(sock, u) {
    try {
      if (!u || !u.id?.endsWith('@g.us')) return;
      // welcome/goodbye → commands.js handleGroupUpdate (STATE.settings) — yahan repeat nahi
    } catch {}
  }

  return { commands, onMessage, onGroupUpdate, setSock, groupKitMenuBox };
}

module.exports = { buildGroupKit };
