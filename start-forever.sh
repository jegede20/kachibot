#!/usr/bin/env bash
# KACHIBOT — minimal crash-loop launcher (no pm2/systemd needed).
# Restarts the bot whenever it exits. Logs to data/kachibot.log.
# Ctrl+C stops it for real.
cd "$(dirname "$0")"   # project root (this file lives there)
mkdir -p data
while true; do
  echo "[$(date '+%F %T')] starting kachibot…" >> data/kachibot.log
  node dist/index.js >> data/kachibot.log 2>&1
  code=$?
  echo "[$(date '+%F %T')] kachibot exited ($code) — restarting in 3s" >> data/kachibot.log
  sleep 3
done
