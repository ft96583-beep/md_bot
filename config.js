// ─── Boss MD Bot · config ─────────────────────────────
module.exports = {
  botName: 'NEXORA-MD',
  prefix: '.',
  // Bot owner number (digits only, with country code, no +).
  owner: process.env.OWNER_NUMBER || '',
  port: process.env.PORT || 3000,
  sessionDir: process.env.SESSION_DIR || './session',
};
