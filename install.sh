#!/bin/bash
# ============================================================
# Energy Controller — Installer for Raspberry Pi
#
# Install from git:
#   sudo ./install.sh
#
# Or from local copy:
#   sudo ./install.sh --local
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="/opt/energy-controller"
SERVICE_NAME="energy-controller"
REPO_URL="https://github.com/YOUR_USERNAME/energy-controller.git"

echo -e "${CYAN}"
echo "  Energy Controller Installer"
echo "  ==========================="
echo -e "${NC}"

# Check root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: Run with sudo${NC}"
  echo "Usage: sudo ./install.sh"
  exit 1
fi

# Detect node
if [ -f "/opt/node22/bin/node" ]; then
  NODE_PATH="/opt/node22/bin/node"
  NODE_VER=$($NODE_PATH --version 2>/dev/null || echo "unknown")
  echo -e "${GREEN}✓${NC} Node.js found: $NODE_VER ($NODE_PATH)"
else
  if command -v node &>/dev/null; then
    NODE_PATH=$(command -v node)
    NODE_VER=$($NODE_PATH --version)
    echo -e "${GREEN}✓${NC} Node.js found: $NODE_VER ($NODE_PATH)"
  else
    echo -e "${RED}✗${NC} Node.js not found!"
    echo "  Install Node.js 22+ first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
  fi
fi

NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo -e "${YELLOW}Warning: Node.js $NODE_VER detected, version 18+ recommended${NC}"
fi

# Stop existing service if running
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo -e "${YELLOW}⟳${NC} Stopping existing service..."
  systemctl stop "$SERVICE_NAME"
fi

# Install from git or local
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$1" = "--local" ]; then
  echo -e "${CYAN}📁${NC} Installing from local copy..."
  mkdir -p "$INSTALL_DIR/data"
  cp "$SCRIPT_DIR/index.js" "$INSTALL_DIR/index.js"
  cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/package.json"
else
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo -e "${CYAN}⟳${NC} Updating existing installation via git pull..."
    cd "$INSTALL_DIR"
    git pull origin main
  else
    echo -e "${CYAN}📦${NC} Cloning repository..."
    rm -rf "$INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
  # Ensure data directory exists
  mkdir -p "$INSTALL_DIR/data"
fi

# Create default data files if they don't exist
if [ ! -f "$INSTALL_DIR/data/config.json" ]; then
  echo '{"inverter":{"ip":"","serial":"","port":8899},"tuya":{"accessId":"","accessKey":"","countryCode":48,"username":"","password":"","appSchema":"tuyaSmart"},"webPort":8583}' > "$INSTALL_DIR/data/config.json"
  echo -e "  ${GREEN}✓${NC} Created default config.json — configure via Settings"
fi

if [ ! -f "$INSTALL_DIR/data/scenes.json" ]; then
  echo '[]' > "$INSTALL_DIR/data/scenes.json"
fi

# Create hb-service system user (if not exists)
if ! id -u hb-service &>/dev/null; then
  useradd --system --no-create-home hb-service
  echo -e "  ${GREEN}✓${NC} Created system user 'hb-service'"
fi

# Set ownership (git clone as root sets root:root, fix that)
chown -R hb-service:hb-service "$INSTALL_DIR"

# Download vendor static files (Chart.js, Bootstrap, Bootstrap Icons)
mkdir -p "$INSTALL_DIR/public/vendor/fonts"
echo -e "${CYAN}📦${NC} Downloading vendor assets..."
[ ! -f "$INSTALL_DIR/public/vendor/chart.umd.min.js" ] && \
  curl -fsSL "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js" \
    -o "$INSTALL_DIR/public/vendor/chart.umd.min.js"
[ ! -f "$INSTALL_DIR/public/vendor/bootstrap.min.css" ] && \
  curl -fsSL "https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" \
    -o "$INSTALL_DIR/public/vendor/bootstrap.min.css"
[ ! -f "$INSTALL_DIR/public/vendor/bootstrap-icons.css" ] && \
  curl -fsSL "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css" \
    -o "$INSTALL_DIR/public/vendor/bootstrap-icons.css"
[ ! -f "$INSTALL_DIR/public/vendor/fonts/bootstrap-icons.woff2" ] && \
  curl -fsSL "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/fonts/bootstrap-icons.woff2" \
    -o "$INSTALL_DIR/public/vendor/fonts/bootstrap-icons.woff2"
echo -e "  ${GREEN}✓${NC} Vendor assets ready"

# Grant narrow sudo permission for systemctl restart only
echo "hb-service ALL=(root) NOPASSWD: /bin/systemctl restart $SERVICE_NAME" \
  > /etc/sudoers.d/energy-controller
chmod 440 /etc/sudoers.d/energy-controller
echo -e "  ${GREEN}✓${NC} Sudoers rule added (restart only)"

# Create systemd service
echo -e "${CYAN}🔧${NC} Creating systemd service..."
cat > /etc/systemd/system/"$SERVICE_NAME".service << EOF
[Unit]
Description=Energy Controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hb-service
Group=hb-service
ExecStart=$NODE_PATH $INSTALL_DIR/index.js
ExecStartPre=/bin/sleep 10
Restart=always
RestartSec=5
WorkingDirectory=$INSTALL_DIR
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# WiFi power save fix
if command -v iwconfig &>/dev/null; then
  IW=$(iwconfig 2>/dev/null | grep -oP 'wlan\d' | head -1)
  if [ -n "$IW" ]; then
    sudo iw dev "$IW" set power_save off 2>/dev/null || true
  fi
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" 2>/dev/null

echo -e "${CYAN}🚀${NC} Starting service..."
systemctl start "$SERVICE_NAME"

sleep 3

if systemctl is-active --quiet "$SERVICE_NAME"; then
  IP=$(hostname -I | awk '{print $1}')

  echo ""
  echo -e "${GREEN}✓${NC} Energy Controller installed and running!"
  echo ""
  echo -e "  Web UI:  ${CYAN}http://$IP:8583${NC}"
  echo -e "  Login:   ${YELLOW}admin${NC} / see password in journal:"
  echo -e "           ${CYAN}sudo journalctl -u $SERVICE_NAME | grep 'Initial admin'${NC}"
  echo ""
  echo -e "  Commands:"
  echo -e "    sudo systemctl status $SERVICE_NAME"
  echo -e "    sudo systemctl restart $SERVICE_NAME"
  echo -e "    sudo journalctl -u $SERVICE_NAME -f"
  echo ""
  echo -e "  To enable git updates, edit $INSTALL_DIR/index.js"
  echo -e "  and set REPO_URL to your repository URL."
  echo ""
else
  echo -e "${RED}✗${NC} Service failed to start!"
  echo "  Check logs: sudo journalctl -u $SERVICE_NAME -n 20"
  systemctl status "$SERVICE_NAME" --no-pager
  exit 1
fi
