# Strum App

Standalone energy conservation controller for Raspberry Pi. Monitors solar inverter via Solarman V5 Modbus TCP, controls Tuya smart plugs locally or via cloud, runs automations, sends push notifications. Zero npm dependencies.

**Stack:** Node.js 22, ES modules, vanilla frontend (no framework), Bootstrap Icons, Chart.js, systemd service.

---

## Table of Contents

- [Features](#features)
- [Hardware Requirements](#hardware-requirements)
- [Quick Install](#quick-install)
- [Manual Install (step by step)](#manual-install-step-by-step)
- [Configuration](#configuration)
  - [Inverter (Solarman V5)](#inverter-solarman-v5)
  - [Tuya Cloud API](#tuya-cloud-api)
  - [Tuya Local Control](#tuya-local-control)
  - [Notifications (ntfy.sh)](#notifications-ntfysh)
  - [Notifications (Telegram)](#notifications-telegram)
  - [Tariff / Cost Tracking](#tariff--cost-tracking)
  - [Netbird VPN](#netbird-vpn)
- [Automations / Scenes](#automations--scenes)
  - [Condition Types](#condition-types)
  - [Action Types](#action-types)
  - [Presets](#presets)
- [Architecture](#architecture)
- [API Reference](#api-reference)
- [Integrations (Prometheus / Home Assistant)](#integrations-prometheus--home-assistant)
- [PWA (Install on Phone)](#pwa-install-on-phone)
- [Watchdog & System Health](#watchdog--system-health)
- [Development](#development)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Inverter monitoring** — Solarman V5 Modbus TCP protocol, reads PV power, battery SOC, grid status, daily energy, temperatures via local network (port 8899)
- **Smart plug control** — Tuya Cloud API + local LAN control (AES-128-GCM v3.5 protocol, port 6668), retry logic with state verification
- **Automation engine** — IF conditions (battery, grid, time, weekday, CPU, disk, memory, inverter status) + THEN actions (control devices, send notifications), AND/OR logic
- **Notifications** — ntfy.sh push, Telegram bot, in-app notification center with grouping, unread badges, sound alerts
- **Power history** — Ring-buffer storage (1m/15m/1h resolution), Chart.js charts (Day/Week/Month/Year), self-consumption / autonomy metrics
- **Cost tracking** — Day/night tariff or flat rate, daily cost estimates, currency configurable
- **Server health** — CPU temperature, CPU load, disk space, RAM monitoring with configurable thresholds
- **Watchdog** — Heartbeat system with cron-based stale detection
- **Prometheus metrics** — `/api/metrics?token=<token>` endpoint for Grafana
- **Home Assistant** — RESTful sensor integration via `/api/status`
- **PWA** — Installable on iOS/Android home screen
- **Self-signed TLS** — Auto-generated certificates
- **Auth** — Session-based with CSRF protection, rate limiting, auto-generated admin password

---

## Hardware Requirements

- **Raspberry Pi** — any model running Raspbian 12 (Bookworm) or later. Tested on Pi 3B+, Pi 4, Pi 5
- **Solar inverter** with Solarman V5 Wi-Fi stick (e.g. Growatt, Deye, Solis, Goodwe)
- **Tuya smart plugs** — 4x T34-Smart Plug+ (or any Tuya WiFi plugs with power monitoring DP)

---

## Quick Install

```bash
# 1. Clone the repo
git clone https://github.com/Lumeo-sd/strum-app.git /opt/energy-controller
cd /opt/energy-controller

# 2. Run installer (creates systemd service, user, permissions)
sudo ./install.sh
```

Open `http://<pi-ip>:8583` in your browser.

Login: username `admin`, password is randomly generated on first run and printed to journal:
```bash
sudo journalctl -u energy-controller | grep "Initial admin"
```

You will be forced to change the password on first login.

---

## Manual Install (step by step)

### 1. Install Node.js 22

```bash
# Option A: NodeSource (recommended)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Option B: Manual install to /opt/node22
wget https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-armv7l.tar.xz
sudo tar -xf node-v22.23.1-linux-armv7l.tar.xz -C /opt/
sudo mv /opt/node-v22.23.1-linux-armv7l /opt/node22
```

Verify:
```bash
node --version  # should show v22.x+
```

### 2. Clone and install

```bash
git clone https://github.com/Lumeo-sd/strum-app.git /opt/energy-controller
cd /opt/energy-controller

# Install dependencies (none needed — zero npm deps)
# Create data directory
mkdir -p data

# Create system user
sudo useradd --system --no-create-home hb-service 2>/dev/null || true
sudo chown -R hb-service:hb-service /opt/energy-controller
```

### 3. Create systemd service

```bash
sudo tee /etc/systemd/system/energy-controller.service << 'EOF'
[Unit]
Description=Energy Controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hb-service
Group=hb-service
ExecStart=/usr/bin/node /opt/energy-controller/index.js
ExecStartPre=/bin/sleep 10
Restart=always
RestartSec=5
WorkingDirectory=/opt/energy-controller
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# If using /opt/node22, change ExecStart to:
# ExecStart=/opt/node22/bin/node --dns-result-order=ipv4first /opt/energy-controller/index.js

sudo systemctl daemon-reload
sudo systemctl enable energy-controller
sudo systemctl start energy-controller
```

### 4. Grant sudo for service restart from web UI

```bash
echo "hb-service ALL=(root) NOPASSWD: /bin/systemctl restart energy-controller" | sudo tee /etc/sudoers.d/energy-controller
sudo chmod 440 /etc/sudoers.d/energy-controller
```

### 5. WiFi power save fix (prevents disconnects)

```bash
sudo iw dev wlan0 set power_save off
```

---

## Configuration

All configuration is done through the **Settings** tab in the web UI. Config is stored in `data/config.json`.

### Inverter (Solarman V5)

The inverter connects via **Solarman V5 Modbus TCP** protocol on **port 8899**.

| Field | Description |
|-------|-------------|
| `inverter.ip` | Local IP address of the inverter's Wi-Fi stick |
| `inverter.serial` | Device serial number (decimal, found on inverter label or in Solarman portal) |
| `inverter.port` | TCP port, default `8899` |
| `inverter.mac` | MAC address (auto-captured on first connect, used for IP re-resolution) |
| `inverter.autoResolve` | Auto-detect IP changes via ARP scan (if inverter gets new DHCP lease) |
| `inverter.resolveAfterFails` | How many consecutive poll failures before attempting IP re-resolution (default: 10) |

**Protocol details:**
- V5 frame: start byte `0xa5`, end byte `0x15`, CRC16 checksum
- Modbus function `0x03` (Read Holding Registers) with slave ID `1`
- Auto-handles keep-alive frames (protocol codes `0x41`, `0x42`, `0x43`, `0x47`, `0x48`)
- Connection is per-command (connect → query → disconnect), no persistent connection

**Finding your inverter serial:**
- Physical label on the inverter (usually on the side or under the cover)
- Solarman Cloud portal: https://usis.solarmancloud.com
- Solarman app → device info

**Finding your inverter IP:**
- Router admin panel → DHCP client list
- Use `scripts/tuya-diag.js` or `scripts/tuya-disc-probe.js` for network scanning
- Enable `autoResolve` — the app will auto-detect IP changes

### Tuya Cloud API

The Tuya Cloud API is used to:
1. **Discover device local keys** (needed for local control)
2. **Sync device names and status** from cloud
3. **Fallback control** if local control fails

**How to get Tuya API credentials:**

1. Go to [Tuya IoT Platform](https://iot.tuya.com/)
2. Create an account (or log in with your Tuya Smart / Smart Life app credentials)
3. Create a new **Cloud Project**:
   - Go to **Cloud** → **Development** → **Create Cloud Project**
   - Name it anything (e.g. "Strum Controller")
   - Select your data center region (Europe → `tuyaeu.com`)
   - Under **API Explorer**, subscribe to these APIs:
     - `Smart Home Devices API` (device management)
     - `Smart Home Scene API` (scene management)
     - `Smart Home Device Status Notification` (optional, for real-time status)
4. **Link your Tuya Smart / Smart Life app:**
   - In Cloud Project → **Devices** → **Link Tuya App Account**
   - Scan QR code with Tuya Smart / Smart Life app
5. **Get API credentials:**
   - In Cloud Project → **Overview** → copy `Access ID` and `Access Secret`

| Field | Description |
|-------|-------------|
| `tuya.accessId` | Access ID from Tuya IoT Platform |
| `tuya.accessKey` | Access Secret from Tuya IoT Platform |
| `tuya.countryCode` | Country code for login (e.g. `48` for Poland, `380` for Ukraine, `1` for US) |
| `tuya.username` | Your Tuya Smart / Smart Life app username (email or phone) |
| `tuya.password` | Your Tuya Smart / Smart Life app password (encrypted at rest) |
| `tuya.appSchema` | App schema: `tuyaSmart` (default) or `smartlife` |
| `tuya.controlMode` | `local` = LAN only (2x attempts, no cloud fallback), `cloud` = cloud only, `auto` = 1x local → cloud fallback |

**How to add your plugs:**
1. Set up your Tuya plugs in the **Tuya Smart** or **Smart Life** app (iOS/Android)
2. Enter your Tuya API credentials in Settings
3. Click **Sync** in the Devices tab — this fetches all devices from your Tuya account
4. The app automatically discovers local keys via the cloud API
5. Assign each plug to a group (Critical / Secondary / custom) for automation targeting

### Tuya Local Control

Local control communicates directly with plugs over LAN using the **Tuya v3.5 AES-GCM encrypted protocol** on **port 6668**.

| Field | Description |
|-------|-------------|
| Port | `6668` (default for Tuya v3.5 devices) |
| Encryption | AES-128-GCM with handshake-derived session key |
| Handshake | 3-step HMAC-SHA256 challenge-response (SESS_START → SESS_RESP → SESS_FINISH) |

**How it works:**
1. TCP connect to `<device-ip>:6668`
2. 3-step handshake with device's `localKey` (16-byte key, discovered via cloud API)
3. Session key derived from XOR of nonces + AES encryption
4. Commands sent as encrypted v3.5 frames
5. After each control command, app queries device state to verify the change took effect

**Retry logic:**
- Query: 3 attempts with 1s delay between retries
- Control: 3 full cycles, each with 2 verification queries
- Connect-per-command model (no persistent TCP connection)

**Finding device local keys:**
- The app fetches them from Tuya Cloud API automatically after sync
- Manually: use `scripts/tuya-fetch-keys.mjs` or `scripts/tuya-test-api.mjs`

**Network requirements:**
- Raspberry Pi and Tuya plugs must be on the **same LAN/subnet**
- UDP broadcast on port `6667` must be allowed (device discovery)
- TCP port `6668` must be reachable to each plug

### Notifications (ntfy.sh)

[ntfy.sh](https://ntfy.sh) is a simple HTTP-based push notification service. Free tier available.

**Setup:**
1. Install ntfy app on your phone ([iOS](https://apps.apple.com/app/ntfy/id1625396347) / [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy))
2. Subscribe to a topic (pick any unique name, e.g. `energy-myhome-abc123`)
3. In Settings → Notifications → enter the topic name in the **ntfy Topic** field
4. Enable ntfy toggle

**How it works:**
- App sends HTTP POST to `https://ntfy.sh` with JSON body `{ topic, title, message, priority }`
- Priority 4 = high (shows as urgent notification on phone)
- 3 retry attempts with 2s delay between retries
- ntfy topic is also used for grid status reporting (if enabled)

### Notifications (Telegram)

**Setup:**
1. Message [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → copy the bot token
2. Start a chat with your new bot
3. Get your chat ID:
   - Message the bot, then open: `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Find `"chat":{"id":123456789}`
4. In Settings → Notifications → enter token and chat ID, enable Telegram toggle

**How it works:**
- Sends Markdown-formatted message via Telegram Bot API
- 3 retry attempts with 2s delay
- Messages formatted as `*Title*\nMessage body`

### Tariff / Cost Tracking

Configure your electricity tariff in Settings → Tariff to enable daily cost estimates.

| Field | Description |
|-------|-------------|
| `tariff.currency` | Currency symbol displayed (e.g. `UAH`, `EUR`, `$`) |
| `tariff.type` | `flat` = single rate, `daynight` = day/night rates |
| `tariff.flatRate` | Price per kWh for flat tariff |
| `tariff.dayRate` | Price per kWh during day hours |
| `tariff.nightRate` | Price per kWh during night hours |
| `tariff.dayStart` | Day period start time (e.g. `07:00`) |
| `tariff.nightStart` | Night period start time (e.g. `23:00`) |

### Netbird VPN

Optional built-in Netbird VPN management for remote access.

| Field | Description |
|-------|-------------|
| `netbird.enabled` | Enable Netbird integration |
| `netbird.setupKey` | Netbird setup key (from Netbird admin console) |
| `netbird.managementUrl` | Netbird management server URL |

Requires `netbird` CLI installed on the Pi and `sudo` access for the service user.

---

## Automations / Scenes

Scenes are the core automation engine. Each scene has **IF** conditions and **THEN** actions.

### Condition Types

| Type | Description | Parameters |
|------|-------------|------------|
| `battery` | Battery SOC threshold | `operator` (`<` or `>`), `value` (percentage) |
| `grid` | Grid power state | `value` (`true` = ON, `false` = OFF) |
| `time` | Time-of-day window | `after` (HH:MM), `before` (HH:MM) |
| `grid_restored` | Grid comes back after outage | Tracks outage duration, SOC change, energy consumed |
| `inverter_offline` | Inverter unreachable | `minFailures` (consecutive fails threshold) |
| `weekday` / `weekend` | Day of week | Type determines weekday vs weekend |
| `disk_free` | Disk space below/above threshold | `operator`, `value` (%) |
| `cpu_temp` | CPU temperature above/below threshold | `operator`, `value` (°C) |
| `cpu_load` | CPU load average above/below | `operator`, `value` (1/5/15 min avg) |
| `memory_free` | Available RAM below/above threshold | `operator`, `value` (%) |

Multiple conditions can be combined with **AND** or **OR** logic.

### Action Types

| Type | Description | Parameters |
|------|-------------|------------|
| `tuya` | Control a Tuya device | `device` (ID), `value` (true/false), `duration` (min, 0=indefinite), `interval` (min between triggers) |
| `notify` | Send push notification | `title`, `message`, `critical` (boolean, affects notification priority) |

**Notification template variables** (for notify actions in scenes):
- `{{duration}}` — formatted outage duration (e.g. "2h 15m")
- `{{duration_h}}` / `{{duration_m}}` — duration in hours/minutes
- `{{soc_start}}` / `{{soc_end}}` — SOC at start/end of event
- `{{soc_used}}` — SOC consumed during event
- `{{energy}}` — energy consumed during event

### Presets

Pre-configured scenes available in the UI (one-tap create):

| Preset | Condition | Action |
|--------|-----------|--------|
| Survival Mode | SOC < 20% | Turn off all secondary devices + critical notification |
| Low Battery Alert | SOC < 15% | Critical notification |
| Grid Down Alert | Grid OFF | Critical notification |
| Grid Restored Report | Grid restored | Notification with duration/SOC/energy details |
| Inverter Offline | 5+ consecutive poll fails | Critical notification |
| Low Disk | Disk < 20% free | Critical notification |
| CPU Overheat | CPU > 80°C | Critical notification |
| High CPU | Load > 5 | Warning notification |
| Low RAM | RAM < 15% free | Critical notification |

---

## Architecture

```
energy-controller/
├── index.js                  # Entry point — wires modules, starts server
├── package.json              # ES module support ("type": "module")
├── lib/
│   ├── app-state.js          # Core: inverter polling, Tuya devices, scene engine
│   ├── routes.js             # All HTTP route handlers (API + pages)
│   ├── server.js             # TLS server, auth middleware, static file serving
│   ├── auth.js               # Session management, password hashing (scrypt)
│   ├── config.js             # Config file load/save with encrypted secrets
│   ├── router.js             # URL pattern matcher, JSON/HTML response helpers
│   ├── logger.js             # Buffered logger (200 entries in memory)
│   ├── notifications.js      # ntfy.sh + Telegram push with retry
│   ├── rrd.js                # Ring-buffer history (1m/15m/1h resolution)
│   ├── solarman.js           # Solarman V5 Modbus TCP client
│   ├── tuya-sign.js          # Tuya Cloud API HMAC-SHA256 signing
│   ├── tuya-local.js         # Tuya v3.5 local AES-128-GCM control
│   ├── tuya-discovery.js     # UDP broadcast device discovery (port 6667)
│   ├── crypto.js             # AES-256-GCM encrypt/decrypt for secrets
│   ├── crc16.js              # Modbus CRC16 calculation
│   ├── rate-limit.js         # IP-based token bucket rate limiter
│   └── watchdog.js           # Heartbeat writer (every 5 min)
├── scripts/
│   ├── check-watchdog.sh     # Cron script for stale heartbeat detection
│   ├── tuya-diag.js          # Tuya diagnostic tool
│   ├── tuya-fetch-keys.mjs   # Fetch device local keys from cloud
│   ├── tuya-test-api.mjs     # Test Tuya API connection
│   └── tuya-disc-*.js        # Network discovery/probe/decrypt tools
├── public/
│   ├── index.html            # Single-page app (dashboard + all views)
│   ├── manifest.json         # PWA manifest
│   └── icons/                # PWA icons (192px, 512px)
├── data/                     # Runtime data (NOT in git)
│   ├── config.json           # Main configuration
│   ├── auth.json             # Admin credentials
│   ├── sessions.json         # Active sessions
│   ├── scenes.json           # Automation definitions
│   ├── scene-timers.json     # Scene cooldown/duration timers
│   ├── devices.json          # Device state cache
│   ├── notifications.json    # Notification history (200 max)
│   ├── watchdog.log          # Heartbeat log
│   ├── secret.key            # AES-256 master encryption key
│   ├── cert.pem / key.pem   # Self-signed TLS certificates
│   ├── history_*.json        # Ring-buffer power history
│   └── sockets_*.json        # Ring-buffer per-device history
├── install.sh                # Installer (systemd, user, permissions)
├── uninstall.sh              # Uninstaller
├── dev.js                    # Dev mode (auto-restart on file change)
└── energy-controller.service # Systemd unit file
```

### Data Flow

```
Inverter (Solarman V5 TCP:8899)
    ↓ readHoldingRegisters()
    ↓ gridPower, batterySOC, pvPower, loadPower, temperatures...
    ↓
app-state.js (pollInverter every 5s)
    ↓ stores in inverterData object
    ↓ writes to ring-buffer history (rrd.js)
    ↓
    ↓ checkScenes() — evaluates scene conditions
    ↓ → triggers actions (device control, notifications)
    ↓
routes.js (/api/status) → polled by frontend every 5s
    ↓
index.html (renderStatus, charts, energy flow animation)

Tuya Plugs (Cloud API or Local TCP:6668)
    ↑ controlDevice() — on/off commands
    ↑ fetchDeviceStatuses() — polls power/switch state
    ↑ tuya-discovery.js — UDP:6667 for IP changes
```

### Ring-Buffer History (rrd.js)

History is stored in fixed-size JSON ring buffers with 3 resolutions:

| File | Resolution | Max entries | Retention |
|------|-----------|-------------|-----------|
| `history_1m.json` | 1 minute | ~1000 | ~16 hours |
| `history_15m.json` | 15 minutes | ~672 | 7 days |
| `history_1h.json` | 1 hour | ~720 | 30 days |

Same structure for `sockets_*.json` (per-device power).

---

## API Reference

All endpoints require session cookie (`ecm_session`) + CSRF header (`X-CSRF-Token`) for POST/PATCH/DELETE, except:
- `GET /healthz` — public health check
- `POST /login` — public
- `GET /api/metrics` — requires `token` query param
- Static assets

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/healthz` | Health check (uptime, memory, inverter status) |
| `POST` | `/login` | Login, returns session cookie |
| `POST` | `/logout` | Destroy session |
| `GET` | `/api/status` | Full system status (inverter + devices + scenes) |
| `GET` | `/api/power-history?level=1h&points=168` | Power history data |
| `GET` | `/api/socket-history?deviceId=X&level=1h` | Per-device power history |
| `GET` | `/api/notifications` | Notification list |
| `POST` | `/api/notifications/dismiss` | Dismiss notification(s) |
| `POST` | `/api/notifications/mark-read` | Mark notification(s) as read |
| `GET` | `/api/scenes` | List all scenes |
| `POST` | `/api/scenes` | Create scene |
| `PATCH` | `/api/scenes/:name` | Update scene (enable/disable) |
| `DELETE` | `/api/scenes/:name` | Delete scene |
| `POST` | `/api/scenes/:name/run` | Manually run scene |
| `GET` | `/api/scene-traces?last=5` | Recent scene execution traces |
| `POST` | `/api/tuya-control` | Control Tuya device (`{ deviceId, value }`) |
| `GET` | `/api/tuya-devices` | List Tuya devices |
| `PATCH` | `/api/tuya-devices/:id/group` | Set device group |
| `POST` | `/api/sync-tuya` | Sync devices from Tuya Cloud |
| `POST` | `/api/tuya-mode` | Switch Tuya access mode |
| `GET` | `/api/plugin-config` | Get full config |
| `POST` | `/api/plugin-config` | Save config |
| `GET` | `/api/metrics?token=X` | Prometheus metrics (no auth cookie needed) |
| `POST` | `/api/restart` | Restart the service |
| `GET` | `/api/version` | App version info |
| `GET` | `/api/log` | Recent log entries |

---

## Integrations (Prometheus / Home Assistant)

### Prometheus / Grafana

Scrape endpoint: `GET /api/metrics?token=<metricsToken>`

Token is shown in Settings → Integrations.

Example `prometheus.yml`:
```yaml
scrape_configs:
  - job_name: energy-controller
    metrics_path: /api/metrics
    params:
      token: ['<your-metrics-token>']
    static_configs:
      - targets: ['192.168.0.100:8583']
```

### Home Assistant

RESTful sensor (no auth required on LAN):
```yaml
sensor:
  - platform: rest
    resource: http://<pi-ip>:8583/api/status
    name: Energy Controller
    value_template: "{{ value_json.batterySOC }}"
    json_attributes:
      - gridPower
      - pvPower
      - loadPower
      - dayPV
      - batteryPower
    scan_interval: 15
```

---

## PWA (Install on Phone)

1. Open `http://<pi-ip>:8583` on your phone
2. **iOS:** Share → Add to Home Screen
3. **Android:** Menu → Add to Home Screen / Install App

The app works offline in read-only mode (shows last cached data).

---

## Watchdog & System Health

### Watchdog Heartbeat

The app writes a heartbeat to `data/watchdog.log` every 5 minutes with PID and RSS memory.

Cron job checks for stale heartbeats:
```bash
# Installed at /etc/cron.d/watchdog-check
*/10 * * * * hb-service /opt/energy-controller/scripts/check-watchdog.sh
```

Alerts written to `data/watchdog-alert.txt` if:
- Last heartbeat > 15 minutes ago (ungraceful death)
- Last entry was SHUTDOWN (service should be restarting)

### Server Health Monitoring

Built-in monitoring of:
- **Disk space** — threshold in % free (default: 20%)
- **CPU temperature** — threshold in °C (default: 80)
- **CPU load** — threshold for load average (default: 5)
- **Available RAM** — threshold in % free (default: 15%)

Configurable in Settings → Notifications → Server health monitoring. Each metric has a 1-hour cooldown after triggering, resets when metric recovers.

### System Info Commands

```bash
# Service status
sudo systemctl status energy-controller

# Live logs
sudo journalctl -u energy-controller -f

# Last 50 lines
sudo journalctl -u energy-controller -n 50 --output cat

# Memory usage
cat /proc/$(pidof node)/status | grep VmRSS
```

---

## Development

```bash
# Dev mode: auto-restart on file change
node dev.js

# Or run directly
node index.js
```

**Dev tools** (in `scripts/`):
```bash
node scripts/tuya-diag.js           # Tuya connection diagnostics
node scripts/tuya-fetch-keys.mjs    # Fetch device local keys
node scripts/tuya-test-api.mjs      # Test Tuya API credentials
node scripts/tuya-disc-test.js      # Test UDP discovery
node scripts/tuya-disc-probe.js     # Probe network for Tuya devices
node scripts/tuya-disc-decrypt.js   # Decrypt discovery packets
node scripts/tuya-disc-gcm.js       # GCM discovery decryption
node scripts/tuya-single.js         # Query single device
```

---

## Updating

### From Git

After initial install via `git clone`:
```bash
cd /opt/energy-controller
git pull origin main
sudo systemctl restart energy-controller
```

Or from the web UI: Settings → System → Check for Updates → Update & Restart.

### From Local Copy

```bash
# On your machine
scp -r energy-controller/ pi@raspberry:~/energy-controller/

# On Pi
cd ~/energy-controller
sudo ./install.sh --local
```

---

## Uninstalling

```bash
sudo ./uninstall.sh
```

This stops the service, removes the systemd unit, and optionally deletes all files.

---

## Troubleshooting

### Inverter not connecting

1. Check IP is correct: `ping <inverter-ip>`
2. Check port 8899 is reachable: `nc -zv <inverter-ip> 8899`
3. Check serial number matches (decimal, not hex)
4. Enable autoResolve in case IP changed
5. Check logs: `journalctl -u energy-controller | grep -i inverter`

### Tuya devices not responding

1. Verify devices are online in Tuya Smart / Smart Life app
2. Re-sync from cloud: Devices → Sync
3. Check control mode: `local` requires same LAN subnet
4. For local control, check port 6668: `nc -zv <plug-ip> 6668`
5. Check logs: `journalctl -u energy-controller | grep -i tuya`

### Notifications not arriving

1. Test ntfy: `curl -d "Test" ntfy.sh/<your-topic>`
2. Test Telegram: `curl "https://api.telegram.org/bot<TOKEN>/sendMessage" -d chat_id=<ID> -d text="Test"`
3. Check notification is enabled in Settings
4. Check if notification is being blocked by cooldown

### Service won't start

```bash
sudo journalctl -u energy-controller -n 30 --output cat
sudo systemctl status energy-controller
```

Common issues:
- Port 8583 already in use → change `webPort` in config
- Node.js not found → update `ExecStart` in service file
- Permission denied → check `chown -R hb-service:hb-service /opt/energy-controller`

---

## License

MIT

