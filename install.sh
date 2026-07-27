#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="strum-server"
SERVICE_FILE="$HOME/.config/systemd/user/$SERVICE_NAME.service"

echo "=== Strum — Installation ==="

# 1. Dependencies
if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install Node.js 18+."
  exit 1
fi
echo "Node.js: $(node --version)"

# 2. Create data directory
mkdir -p "$APP_DIR/data"

# 3. Install npm deps if needed
if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "Installing npm dependencies..."
  cd "$APP_DIR"
  npm init -y --silent 2>/dev/null || true
  npm install express --save --silent
fi

# 4. Setup systemd user service
mkdir -p "$HOME/.config/systemd/user"
cat > "$SERVICE_FILE" << SVC
[Unit]
Description=Strum — Backup Power Monitor
Documentation=https://github.com/anomalyco/strum-server
After=network.target

[Service]
ExecStart=/usr/bin/node $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
SVC

systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user restart "$SERVICE_NAME"

echo ""
echo "=== Done ==="
echo "Server: http://localhost:3000"
echo "Login:  admin / admin"
echo ""
echo "Management:"
echo "  systemctl --user restart $SERVICE_NAME   # restart"
echo "  systemctl --user stop $SERVICE_NAME      # stop"
echo "  journalctl --user -u $SERVICE_NAME -f    # logs"
echo ""
