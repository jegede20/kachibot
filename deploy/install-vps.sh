#!/usr/bin/env bash
# KACHIBOT — one-shot VPS installer (Ubuntu 22.04/24.04 on Oracle Cloud ARM).
# Bootstraps Node 20 if missing, installs the project to /opt/kachibot,
# builds it, and registers a systemd service: auto-start on boot,
# auto-restart on crash. Re-run safe.
#
# Usage on a fresh Oracle Cloud instance:
#   tar xzf kachibot-bundle.tar.gz
#   cd kachibot
#   sudo bash deploy/install-vps.sh
set -euo pipefail

APP=/opt/kachibot
SRC="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$SRC" = "$APP" ]; then
  echo "==> already installed at $APP — skipping file copy, continuing with build/service"
  SKIP_COPY=1
else
  SKIP_COPY=0
fi

echo "==> [1/6] Node.js check"
if ! command -v node >/dev/null 2>&1; then
  echo "    installing Node 20 (NodeSource)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y nodejs >/dev/null 2>&1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
echo "    node $(node -v)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "    Node >=18 required (got $NODE_MAJOR). Install Node 20:"
  echo "      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi

echo "==> [2/6] copying project to $APP"
if [ "$SKIP_COPY" = "0" ]; then
  sudo mkdir -p "$APP"
  sudo cp -a "$SRC/." "$APP/"
fi
sudo rm -rf "$APP/node_modules" "$APP/dist" 2>/dev/null || true
# never wipe an existing .env on re-runs
if [ ! -f "$APP/.env" ]; then sudo rm -f "$APP/.env" 2>/dev/null || true; fi

echo "==> [3/6] .env"
if [ ! -f "$APP/.env" ]; then
  cp "$APP/.env.example" "$APP/.env"
  echo "!!!  $APP/.env was created from the example."
  echo "!!!  Fill it with your real keys NOW:"
  echo "        sudo nano $APP/.env"
  echo "!!!  then run this installer again:"
  echo "        sudo bash $APP/deploy/install-vps.sh"
  exit 1
fi
echo "    .env present."

echo "==> [4/6] dependencies + build (a few minutes on ARM)"
cd "$APP"
sudo chown -R "$(whoami)":"$(whoami)" "$APP" 2>/dev/null || true
npm install 2>&1 | tail -2
npm run build

echo "==> [5/6] systemd service"
sudo cp "$APP/deploy/kachibot.service" /etc/systemd/system/kachibot.service
sudo systemctl daemon-reload
sudo systemctl enable kachibot

echo "==> [6/6] start"
sudo systemctl restart kachibot
sleep 3
sudo systemctl --no-pager --lines=10 status kachibot || true

echo
echo "DONE. Management:"
echo "  sudo journalctl -u kachibot -f     # live logs"
echo "  sudo systemctl restart kachibot    # after .env/code changes"
echo "  sudo systemctl status kachibot     # health"
