# Context for AI Sessions

## Project
**Strum** — frontend (index.html) + temporary dev server (server.js) for backup power monitoring and smart plug control.

## Architecture
- **Current dev server** — Express server (`server.js`, port 3000). Temporary, for UI debugging.
- **Final backend** — `Strum-server` (repo at `/home/p3/Projects/GitHub/Strum-server/`). API documented in `API.md` (copy in project root).
- **UI** — single-page app, all HTML+CSS+JS in `index.html`. Style: macOS/iOS, dark/light theme.

## What's Been Done
### Bug Fixes
- **Syntax error** in `setupPWA()` — missing closing `}` of function body.
- **Syntax error** in `renderStatus()` — extra `)` inside drop-shadow string.
- **Added**: localStorage for CSRF token, cookie auth (`ecm_token`), logging.

### Netbird VPN Integration
- **Settings section** — `Netbird VPN` after Tariff, before Appearance.
- **Toggle on/off** — `toggleNetbird()` → `POST /api/netbird/{up,down}`.
- **Fields**: Setup Key, Management URL.
- **Status button** — `checkNetbird()` → `GET /api/netbird/status`.
- **Config save** — `saveNetbird()` → `POST /api/plugin-config`.

#### Behavior (matches Strum-server)
- `POST /api/netbird/up` — reads `setupKey` from `config.netbird.setupKey` (not from body).
  If key not saved → `{success: false, message: "Setup Key not configured..."}`.
  On success sets `config.netbird.enabled = true`.
- `POST /api/netbird/down` — runs `netbird down`, sets `enabled = false`.
- `GET /api/netbird/status` → `{success, enabled, status, connected?, peerIp?}`.
- `GET /api/plugin-config` — masks `netbird.setupKey` as `••••••••`.
- `POST /api/plugin-config` — skips saving `setupKey` if value is `••••••••` or `''`.
- `POST /api/netbird/{connect,disconnect}` — aliases to `{up,down}`.

#### Differences from Previous Version
- `toggleNetbird()` no longer sends `setupKey` in body — server reads from config
- `enterSettings()` shows `••••••••` as field value (not placeholder) when key is configured
- On focus, `••••••••` clears for entering a new key
- Key masking in GET responses
- Handling `••••••••` on save — doesn't overwrite existing key
- `normalizeMgmtUrl()` — fixes `app.netbird.io` → `api.netbird.io`
- SSO error detection: "originally enrolled" → clear message with instructions
- Timeout reduced from 15s to 10s

## Installation & Running

### System Requirements
- Node.js 18+
- Netbird (optional, for VPN)

### Installing Netbird (for debugging)
```bash
curl -fsSL https://pkgs.netbird.io/install.sh | sh
```
Binary installed to `~/.local/bin/netbird`. For daemon:
```bash
sudo /home/p3/.local/bin/netbird service install
sudo systemctl start netbird
```
❗ If service doesn't start:
```bash
sudo ln -sf /home/p3/.local/bin/netbird /usr/bin/netbird && sudo systemctl restart netbird
```

### Resetting Netbird State (if peer was registered via SSO)
```bash
sudo /usr/bin/netbird service stop && sudo rm -rf /var/lib/netbird && sudo /usr/bin/netbird service start
```

### Running Dev Server
```bash
systemctl --user enable strum-server    # one-time
systemctl --user restart strum-server   # start / restart
```
Server at `http://localhost:3000`, login `admin` / `admin`.

### Log File
```bash
journalctl --user -u strum-server -f   # follow logs
```

### Data Files
- `/home/p3/Documents/Strum-Qwen-UI/data/config.json` — configuration
- `/home/p3/Documents/Strum-Qwen-UI/data/devices.json` — Tuya devices
- `/home/p3/Documents/Strum-Qwen-UI/data/scenes.json` — scenes
