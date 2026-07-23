## v0.3.10 — 2026-07-23
### Added
- Haptic feedback (vibration): device toggle, scene run, toast, pull-to-refresh, swipe
- Swipe gestures: horizontal swipe to switch between tabs on mobile
- Improved pull-to-refresh with haptic threshold indicator
- `haptic()` utility function wrapping `navigator.vibrate`
- CSS `slideInRight`/`slideInLeft` keyframe animations

## v0.3.9 — 2026-07-23
### Added
- Device grouping: assign devices to rooms/categories via group field
- Group headers in devices tab with collapsible sections
- Pencil icon on device cards to edit group assignment
- `PATCH /api/tuya-devices/:id/group` endpoint
- `group` field persisted in `data/devices.json`

# Changelog

## v0.3.7 (2026-07-23)
- Modular refactor: extract 15 modules into `lib/` (server, routes, app-state, auth, config, router, logger, notifications, rrd, solarman, tuya-sign, crypto, crc16, rate-limit)
- Extract frontend HTML/CSS/JS from inline template literals into `public/` static files
- Fix: scenes reference bug — `loadScenes` reassigned array, exported reference stayed empty
- Fix: app.js syntax error — `\\'` → `\'` in onclick handlers (~15 places)
- Fix: `/icon-*.png` 302 redirect → whitelist in authMiddleware, handle before route matcher
- Fix: DELETE scene handler used `filter` instead of `splice`, breaking reference to shared scenes array
- Fix: `loadDailyRecords` / `loadDevicesFromDisk` also reassigned arrays instead of mutating in-place
- Remove leftover `.bak` files from repo
- Update README Files section to reflect modular structure

## v0.3.5 (2026-07-??)
- Auto-resolve inverter IP with ARP/ping sweep
- Persistent notifications with server-side event history
- Scene traces ring buffer (last 200 events)
- Cooldown interval for scene actions

## v0.3.4
- Notifications tab with in-app dismiss
- Transparent SVG node centers with glow effect

## v0.3.3
- Pin sidebar footer to bottom
- Battery animation: dual dots for charge/discharge

## v0.3.2
- Notification channel toggles (ntfy.sh, Telegram, Critical-only)
- Grid Outage Report notification
- Flat tariff support + daily cost tracking

## v0.3.1
- Tariff cost tracking
- Prometheus metrics endpoint
- Notify actions in scenes
- Tile detail charts (per-register debug grid)

## v0.3.0
- Initial tagged release
- RRD-style history with ring buffers
- AND/OR logic + time/weekday conditions for automations
- ntfy.sh / Telegram notifications
- Energy flow SVG + self-consumption metrics
- Branch/tag-based update system
- Tuya Cloud smart plug control
- Solarman V5 Modbus TCP inverter monitoring
- PWA support
- Zero npm dependencies

