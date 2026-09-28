#!/bin/bash
# BOXXAXMD live watchdog — bot + serveo tunnel ko zinda rakhta hai.
# Har 10 min cron se chalta hai. URL change ya failure stdout par batata hai.
DIR="$HOME/workspace/whatsapp-md-bot"
URLFILE="$DIR/live-url.txt"

# --- 1. Bot check ---
if ! curl -s -m 8 http://localhost:3000/api/health 2>/dev/null | grep -q '"ok":true'; then
  echo "BOT DOWN — restarting..."
  if [ -f "$DIR/bot.pid" ]; then kill "$(cat "$DIR/bot.pid")" 2>/dev/null; fi
  # purani atki hui node processes — SIRF is bot wali (cwd match).
  # Kabhi seedha `pkill -f "node index.js"` mat chalao — woh ghalat process maar sakta hai.
  for p in $(pgrep -f "^node index\.js$" 2>/dev/null); do
    [ "$(readlink /proc/$p/cwd 2>/dev/null)" = "$DIR" ] && kill "$p" 2>/dev/null
  done
  sleep 2
  # setsid ZAROORI hai — warna system nohup process ko chand minute baad maar deta hai.
  cd "$DIR" && OWNER_NUMBER=923448072653 PORT=3000 setsid nohup node index.js >> bot.log 2>&1 < /dev/null &
  # nohup ke baad asal node process dhoondho
  sleep 3
  NEWPID=$(pgrep -f "^node index\.js" 2>/dev/null | head -1)
  [ -n "$NEWPID" ] && echo "$NEWPID" > "$DIR/bot.pid"
  sleep 10
  if curl -s -m 8 http://localhost:3000/api/health 2>/dev/null | grep -q '"ok":true'; then
    echo "BOT restarted OK"
  else
    echo "BOT RESTART FAILED — check bot.log"
  fi
fi

# --- 2. Tunnel check ---
if ! pgrep -f "ssh.*serveo\.net" >/dev/null 2>&1; then
  echo "TUNNEL DOWN — restarting..."
  if [ -f "$DIR/tunnel.pid" ]; then kill "$(cat "$DIR/tunnel.pid")" 2>/dev/null; fi
  pkill -f "ssh.*serveo\.net" 2>/dev/null
  cd "$DIR" && nohup ./tunnel-ssh.sh serveo.net 22 "80:localhost:3000" > serveo.log 2>&1 &
  echo $! > "$DIR/tunnel.pid"
  sleep 25
fi

# --- 3. Public URL ---
URL=$(grep -oE "https://[a-zA-Z0-9.-]+\.serveousercontent\.com" "$DIR/serveo.log" 2>/dev/null | tail -1)
if [ -n "$URL" ]; then
  OLD=$(cat "$URLFILE" 2>/dev/null)
  if [ "$URL" != "$OLD" ]; then
    echo "$URL" > "$URLFILE"
    echo "URL CHANGED: ${OLD:-none} -> $URL"
    # Permanent link (boxxaxmd-pair.surge.sh) GitHub se live-url.txt parhta hai —
    # is liye tabdeeli ko push karo taake permanent link taaza rahe.
    (cd "$DIR" && git add live-url.txt 2>/dev/null && git commit -m "live-url update: $URL" 2>/dev/null && git push origin master 2>&1 | tail -1)
  fi
  if curl -s -m 20 "$URL/api/health" 2>/dev/null | grep -q '"ok":true'; then
    echo "PUBLIC OK: $URL"
  else
    echo "PUBLIC NOT RESPONDING: $URL"
  fi
else
  echo "NO PUBLIC URL in serveo.log yet"
fi
