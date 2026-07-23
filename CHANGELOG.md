## v0.3.13 — 2026-07-23
### Added
- Notification center: sound on new critical/warn notification (Web Audio API)
- Unread count badge (orange pill) in sidebar, separate from total count
- "Mark read" button in notification panel + "Mark all read" API
- Notification grouping by title+type (collapses duplicates with count badge)
- Unread highlight (left accent border, bold title) on notification items
- Side-by-side "Mark read" / "Dismiss all" buttons in notification card

## v0.3.12 — 2026-07-23
### Added
- Server health monitoring: checks disk, CPU temp, CPU load, memory every 5 min
- Configurable thresholds in Settings → Notifications → Server health monitoring
- Push notifications + external alerts (ntfy/Telegram) on threshold breach
- Deduplication with hysteresis: 1 hour cooldown per metric, resets on recovery
- Theme card collapsed behavior fixed (now matches other cards)

## v0.5.0 — 2026-07-23
### Added
- "Quiet Panel" theme — minimal mobile UI without glass cards/blur
- `tokens.css` — shared CSS variables shared between main app and login page
- Hero section with single power number + solar/battery/grid stats
- Mini sparkline chart (7 bars) — tap opens bottom-sheet with full Chart.js
- Device strip — first 4 devices as flat rows with quick toggle
- Theme toggle in Settings: Comfortable (default) / Quiet Panel
- Bottom nav on mobile: 4 icons with dot indicator (no pill/badge background)
- Server and Notifications moved out of bottom nav (bell in topbar, Server in Settings)
- `data-theme="quiet"` attribute toggles CSS overrides + loads copper accent (#c98a4f)
- Login page now respects chosen accent + theme via tokens.css
### Fixed
- `var(--primary)` in Chart.js datasets resolved via getComputedStyle
### Changed
- `loadStatus()` updates hero values in quiet mode
- `loadTuyaDevices()` populates device strip

## v0.3.11 — 2026-07-23
### Added
- Theme/color switcher in Settings tab
- 6 accent color palettes: Purple (default), Blue, Green, Orange, Pink, Cyan
- Color swatches with active indicator
- Preference persisted in localStorage (`ecmAccent`)
- `data-accent` attribute on `<html>` with CSS variable overrides

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

