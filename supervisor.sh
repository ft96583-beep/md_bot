#!/bin/bash
# NEXORA-MD supervisor — long-lived session se chalta hai, cron-watchdog ke
# short-lived launches (jo runtime reap kar deta hai) ka permanent hal.
# Har 60s /api/health check; dead ho to start.sh se relaunch (flock guard
# duplicate wrapper rokta hai).
cd /home/hatch/workspace/whatsapp-md-bot
echo "[$(date '+%F %T')] supervisor started (pid $$)" >> supervisor.log
while true; do
  if ! curl -s --max-time 8 http://127.0.0.1:3000/api/health 2>/dev/null | grep -q '"ok":true'; then
    echo "[$(date '+%F %T')] bot down — relaunching via start.sh" >> supervisor.log
    setsid nohup ./start.sh >> bot-run.log 2>&1 < /dev/null &
  fi
  sleep 60
done
