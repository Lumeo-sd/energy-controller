#!/bin/bash
# ============================================================
# Energy Controller — Uninstaller
# Usage: sudo ./uninstall.sh
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SERVICE_NAME="energy-controller"
INSTALL_DIR="/opt/energy-controller"

echo -e "${CYAN}"
echo "  ⚡ Energy Controller Uninstaller"
echo "  ================================"
echo -e "${NC}"

if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Error: Run with sudo${NC}"
  exit 1
fi

# Stop and disable service
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
  echo -e "${YELLOW}⟳${NC} Stopping service..."
  systemctl stop "$SERVICE_NAME"
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
  systemctl disable "$SERVICE_NAME" 2>/dev/null
  echo -e "${GREEN}✓${NC} Service disabled"
fi

# Remove service file
if [ -f "/etc/systemd/system/$SERVICE_NAME.service" ]; then
  rm "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload
  echo -e "${GREEN}✓${NC} Service file removed"
fi

# Ask about data
echo ""
echo -e "${YELLOW}Remove application files?${NC}"
echo "  Location: $INSTALL_DIR"
echo -e "  ${RED}This includes config, auth, and scenes data.${NC}"
read -p "  Remove everything? [y/N]: " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
  rm -rf "$INSTALL_DIR"
  echo -e "${GREEN}✓${NC} Application files removed"
else
  echo -e "${CYAN}-${NC} Application files kept at $INSTALL_DIR"
fi

echo ""
echo -e "${GREEN}✓${NC} Energy Controller uninstalled"
echo ""
