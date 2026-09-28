#!/bin/bash
# ─── NEXORA-MD auto-restart wrapper ───
# node crash ho ya process mar jaye to 5 second baad khud dobara start.
# Isko aise chalao:  setsid nohup ./start.sh > bot-run.log 2>&1 < /dev/null &
cd "$(dirname "$0")"
# Singleton guard: agar ek wrapper pehle se chal raha ho to duplicate launch
# foran nikle (watchdog double-start se EADDRINUSE crash-loop hota tha).
exec 9>./.start.lock
if ! flock -n 9; then
  echo "[$(date '+%F %T')] ⚠ start.sh pehle se chal raha hai — duplicate launch roka." >> bot-run.log
  exit 0
fi
# owner number har restart/watchdog par survive kare (owner features + rate-limit exemption)
[ -f .owner ] && OWNER_NUMBER="$(cat .owner)"
if [ -z "$OWNER_NUMBER" ]; then
  echo "[$(date '+%F %T')] ⚠ .owner file nahi mili — OWNER_NUMBER khaali; owner-only features band rahein ge." >> bot-run.log
fi
export OWNER_NUMBER="${OWNER_NUMBER:-}"
export PORT="${PORT:-3000}"
while true; do
  echo "[$(date '+%F %T')] ▶ NEXORA-MD starting..." >> bot-run.log
  node index.js >> bot-run.log 2>&1
  code=$?
  echo "[$(date '+%F %T')] ■ exited (code $code) — 5s mein restart" >> bot-run.log
  sleep 5
done
