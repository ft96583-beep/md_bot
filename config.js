// ─── Boss MD Bot · config ─────────────────────────────
module.exports = {
  botName: 'NEXORA-MD',
  prefix: '.',
  // Bot owner number (digits only, with country code, no +).
  // Owner-only commands (.kick, .tagall etc.) sirf isi number se chalenge.
  owner: process.env.OWNER_NUMBER || '',
  // Web pairing page ka port
  port: process.env.PORT || 3000,
  // Session folder (login state yahan save hota hai — dobara pair nahi karna padta)
  // Multi-session worker apna folder env se leta hai: SESSION_DIR=./sessions/s_<number>
  sessionDir: process.env.SESSION_DIR || './session',
};
