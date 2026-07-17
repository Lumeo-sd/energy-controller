# Energy Controller

Standalone energy conservation controller for Raspberry Pi. Zero npm dependencies.

## Features

- Solarman V5 Modbus TCP inverter monitoring
- Tuya Cloud smart plug control
- Automation engine (grid/battery triggers)
- Power history charts (Day/Week/Month/Year)
- PWA support (install on phone)
- Git-based updates

## Install from Git

```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/energy-controller.git
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

**Login:** `admin` / `admin` (change immediately in Settings)

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

## PWA (iPhone)

After installing, open `http://<pi-ip>:8583` on iPhone → Share → Add to Home Screen.

## License

MIT
