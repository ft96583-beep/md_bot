# NEXORA-MD · Pair Portal

JAWAD-style pairing: ye chhota server **sirf pairing** karta hai. Phone link hote
hi **SESSION_ID** deta hai — usay bot mein env mein do, bot seedha connect hoga.
Bot khud kabhi fresh pairing nahi karta.

## Deploy (Render free tier)

1. Is folder ko GitHub repo mein push karo (ya ZIP upload).
2. Render dashboard → New → Web Service → repo select karo.
3. Build: `npm install` · Start: `node portal.js` · Plan: **Free**.
4. Deploy hote hi URL kholo → number likho → code/QR se WhatsApp link karo.
5. **SESSION_ID** copy karo (sirf ek baar milti hai).

## Bot mein lagao

Bot server par:

```bash
SESSION_ID="paste-yahan" ./start.sh
```

Ya hosting dashboard mein env variable `SESSION_ID` set kar do.

- SESSION_ID sirf tab import hoti hai jab koi live linked session na ho.
- Ek baar import ho jaye to dobara import nahi hoti (dead-session loop se bachat).
- Zabardasti dobara import: `FORCE_SESSION_ID=1 SESSION_ID="..." ./start.sh`
- ⚠️ SESSION_ID kisi ko mat do — is se tumhara WhatsApp account khulta hai.
