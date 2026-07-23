# Energy Controller

Standalone energy conservation controller for Raspberry Pi. Zero npm dependencies.

## Features

- Solarman V5 Modbus TCP inverter monitoring (read-only)
- Tuya Cloud smart plug control
- Automation engine (grid/battery/time/weekday triggers, AND/OR logic, notify actions)
- Notifications via ntfy.sh / Telegram
- Power history charts (Day/Week/Month/Year), fixed-size ring-buffer storage
- Self-consumption / autonomy / grid cost estimates
- Prometheus metrics endpoint + Home Assistant REST integration
- PWA support (install on phone)
- Git-based updates (tag-based, signed checkout)

## Install from Git

```bash
git clone https://github.com/Lumeo-sd/energy-controller.git
cd energy-controller
sudo ./install.sh
```

## Install from Local Copy

```bash
scp -r "energy-controller/" pi@raspberry:~/
ssh pi@raspberry
cd ~/energy-controller
sudo ./install.sh --local
```

Open `http://<pi-ip>:8583` in browser.

**Login:** username `admin`, password is randomly generated on first run and printed once to the console/`journalctl` during install (look for "Initial admin password"). You'll be forced to change it on first login.

## Update from Git

After initial install via `git clone`, updates are available from the Settings tab:
- **Check for Updates** — fetches latest from GitHub
- **Update & Restart** — pulls changes and restarts the service

## Commands

```bash
sudo systemctl status energy-controller
sudo systemctl restart energy-controller
sudo journalctl -u energy-controller -f
```

## Uninstall

```bash
sudo ./uninstall.sh
```

## Files

```
/opt/energy-controller/
├── index.js          # App (single file, zero dependencies)
├── package.json      # ES module support
└── data/             # NOT in git — your config & credentials
    ├── config.json   # Inverter + Tuya + Web settings
    ├── auth.json     # Login credentials
    └── scenes.json   # Automation rules
```

## Configuration

After install, open Settings in the web UI to configure:
- Inverter IP and serial number
- Tuya Cloud API credentials
- Web port
- Admin password
- Tariff (day/night rate) for grid cost estimates
- Notifications (ntfy.sh / Telegram)

## Automations

Automations live under the Automations tab. Each one has:
- **IF** — one or more conditions (grid up/down, battery SOC threshold, time-of-day window, day-of-week), combined with **AND** or **OR**.
- **THEN** — one or more actions: toggle a Tuya device (optionally for a fixed duration, or with a minimum interval between triggers), or send a **notification**.

Use **Run now** on any automation card to apply its actions immediately, without waiting for its conditions to be true — useful for testing.

## PWA (iPhone)

After installing, open `http://<pi-ip>:8583` on iPhone → Share → Add to Home Screen.

## License

MIT
