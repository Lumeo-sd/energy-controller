# Strum — API Reference

Довідник по HTTP API бекенду (`lib/routes.js`), щоб писати/змінювати фронтенд без
розсинхрону з бекендом (як це вже раз сталось із 7 ендпоінтами).

> Джерело правди — сам `lib/routes.js`. Цей файл треба оновлювати руками щоразу,
> коли додаєш/перейменовуєш маршрут. Раз на якийсь час можна звірити автоматично —
> дивись розділ **"Як перевірити, що фронт і бек не розійшлись"** в кінці.

---

## 1. Транспорт і базові конвенції

- Все — на одному порту (`config.webPort`, за замовчуванням `8583`), HTTPS із
  самопідписаним сертифікатом.
- Тіло запиту/відповіді — завжди JSON, крім `/api/metrics` (Prometheus text format)
  і `/api/logs` (текст всередині JSON-поля).
- Формат відповіді **не уніфікований жорстко**, але переважна більшість роутів
  повертають об'єкт з `success: true|false`. Виключення: `/api/status`,
  `/api/tuya-devices`, `/api/scenes`, `/healthz`, `/api/system-info` — там немає
  обгортки `success`, вони віддають дані напряму. **Завжди дивись конкретний
  роут у таблиці нижче**, не покладайся на єдиний формат.
- HTTP-статус і `success:false` — не одне й те саме. Багато мутуючих роутів (Tuya,
  NetBird, restore) навмисно повертають **200** навіть при логічній помилці, і
  кладуть причину в `message`. Перевіряй `success`, а не тільки `res.ok`.

## 2. Автентифікація і CSRF

1. `POST /login` → `{username, password}` → якщо ок, ставить cookie `ecm_session`
   (httpOnly) і повертає `{success:true, csrfToken, mustChangePassword}`.
2. Збережи `csrfToken` (фронтенд кладе його в `window._csrf`, див. `public/app.js:9`).
3. На **кожен** `POST/PATCH/DELETE` до `/api/*` додавай заголовок
   `X-CSRF-Token: <csrfToken>`. Без нього — `403 {success:false, message:'CSRF token invalid'}`.
4. `GET /api/status` теж повертає свіжий `csrfToken` у відповіді — можна
   освіжати токен при кожному пулінгу статусу (фронт так і робить, `app.js:800`).
5. Логін-спроби обмежені: 5 невдалих за 60 сек з однієї IP → `429`.
6. Усі `/api/*` (крім `/api/metrics`) обмежені загальним rate-limit'ом — реалізація
   в `lib/router.js` / `rateLimit()`; при перевищенні — `429 {success:false, message:'Rate limit exceeded...'}`.

Мінімальний клієнтський хелпер (спрощена версія того, що вже є в `app.js`):

```js
window._csrf = '';
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (window._csrf) headers['X-CSRF-Token'] = window._csrf;
  const r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { ...headers, ...opts.headers } });
  const data = await r.json().catch(() => null);
  if (data?.csrfToken) window._csrf = data.csrfToken;
  return data;
}
```

## 3. Публічні (без сесії) маршрути

Whitelist з `authMiddleware` (`lib/server.js`) — доступні без cookie:

| Маршрут | Призначення |
|---|---|
| `GET /login`, `POST /login` | сторінка/дія логіну |
| `GET /healthz` | health-check (для systemd/моніторингу) |
| `GET /sw.js`, `GET /manifest.json` | PWA |
| `GET /icon-*` | іконки PWA (генеруються на льоту, SVG) |
| `/vendor/*` | статичні вендор-файли (Chart.js, Bootstrap Icons) |
| `GET /api/metrics?token=...` | Prometheus-метрики, окрема авторизація через `?token=` (не cookie) |

Все інше під `/api/*` без валідної сесії → `401`. Все інше поза `/api/*` без сесії
→ `302 → /login`.

---

## 4. Довідник маршрутів

### Auth / сесія

| Method | Path | Body → | Response |
|---|---|---|---|
| POST | `/login` | `{username, password}` | `{success, csrfToken, mustChangePassword}` / `401` / `429` |
| POST | `/api/logout` | — | `{success:true}` |
| POST | `/api/change-password` | `{currentPassword, newPassword}` (мін. 6 симв.) | `{success, mustChangePassword}` |

### Статус / метрики

| Method | Path | Body → | Response |
|---|---|---|---|
| GET | `/api/status` | — | великий об'єкт стану: `csrfToken, costToday, tariff, dailyRecords, gridPower, batterySOC, pvPower, loadPower, ..., tuyaDevices[], scenes[]` (без обгортки `success`) |
| GET | `/api/metrics?token=` | — | Prometheus text exposition |
| GET | `/api/system-info` | — | `{hostname, cpuTemp, cpuFreq, totalMem, freeMem, diskInfo, ...}` (без `success`) |
| GET | `/api/app-version` | — | `{success, version, gitHash, gitBranch, gitRemote, isGit}` |

### Tuya (розумні розетки)

| Method | Path | Body → | Response |
|---|---|---|---|
| GET | `/api/tuya-devices` | — | масив пристроїв (без обгортки) |
| POST | `/api/tuya-control` | `{deviceId, value:boolean}` | `{success, message}` |
| POST | `/api/sync-tuya` **(канонічний)** / `/api/tuya-sync` **(аліас для фронту)** | — | `{success, count}` |
| GET | `/api/tuya-mode` | — | `{success, mode:'auto'|'local'|'cloud'}` |
| POST | `/api/tuya-mode` | `{mode:'auto'|'local'|'cloud'}` | `{success, mode}` |
| PATCH | `/api/tuya-devices/:id/group` | `{group}` | `{success, group}` |

### Інвертор

| Method | Path | Body → | Response |
|---|---|---|---|
| POST | `/api/inverter/scan` | — (потребує `cfg.inverter.mac`) | `{success, ip, updated}` |
| GET | `/api/inverter/autoscan` | — | `{success, enabled, mac, resolveAfterFails}` |
| POST | `/api/inverter/autoscan` | `{enabled?, mac?, resolveAfterFails?}` | `{success, enabled}` |
| POST | `/api/inverter/scan-mode` | `{mode:'auto'|'off'}` — thin-wrapper над тим самим `cfg.inverter.autoResolve`, що й `autoscan` | `{success, mode, enabled}` |

> `autoscan` і `scan-mode` пишуть **в одне й те саме поле конфігу**
> (`cfg.inverter.autoResolve`). Це історично два UI-елементи на один прапорець;
> не дивуйся, якщо зміна одного відобразиться в стані іншого.

### NetBird VPN

| Method | Path | Body → | Response |
|---|---|---|---|
| GET | `/api/netbird/status` | — | `{success, status, enabled}` |
| POST | `/api/netbird/up` **(канонічний)** / `/api/netbird/connect` **(аліас)** | — (потребує `cfg.netbird.setupKey`) | `{success, message}` |
| POST | `/api/netbird/down` **(канонічний)** / `/api/netbird/disconnect` **(аліас)** | — | `{success, message}` |

### Тариф

| Method | Path | Body → | Response |
|---|---|---|---|
| POST | `/api/tariff` | `{day?, night?}` → пише `cfg.tariff.dayRate`/`nightRate` | `{success, tariff}` |

> Повний тариф (валюта, тип flat/daynight, часи зміни дня/ночі) редагується тільки
> через `/api/plugin-config` (нижче) — `/api/tariff` це навмисно вузький швидкий тумблер.

### Сповіщення (ntfy / Telegram)

| Method | Path | Body → | Response |
|---|---|---|---|
| GET | `/api/notifications` | — | `{success, notifications[], unread}` |
| POST | `/api/notifications/dismiss` | `{id}` або `{title, type}` | `{success}` |
| POST | `/api/notifications/dismiss-all` | — | `{success}` |
| POST | `/api/notifications/mark-read` | `{id}` / `{title,type}` / `{}` (все) | `{success}` |
| POST | `/api/notifications/add` | `{title, message, type}` | `{success}` |
| POST | `/api/test-notification` | — | `{success, results[]}` — шле у **всі** увімкнені канали |
| POST | `/api/ntfy` | `{enabled:boolean}` → `cfg.notifications.ntfyEnabled` | `{success, enabled}` |
| POST | `/api/ntfy/test` | — | `{success, results[]}` — ⚠️ насправді ідентичний `/api/test-notification`, шле у все увімкнене, не тільки ntfy |
| POST | `/api/tg` | `{enabled:boolean}` → `cfg.notifications.telegramEnabled` | `{success, enabled}` |
| POST | `/api/tg/test` | — | `{success, results[]}` — та сама примітка, що й вище |

### Конфіг (повний, вкладений об'єкт)

| Method | Path | Body → | Response |
|---|---|---|---|
| GET | `/api/plugin-config` | — | `{success, config}` — секрети замінені на `••••••••` |
| POST | `/api/plugin-config` | `{config:{inverter?, tuya?, webPort?, notifications?, healthAlerts?, netbird?, tariff?}}` — **весь об'єкт `config`, не діф**; поля з `••••••••` або `''` ігноруються (не перезаписують секрет) | `{success, message}` |

> Це "важкий" ендпоінт для сторінки Settings цілком. Точкові тумблери (`/api/tariff`,
> `/api/ntfy`, `/api/tg`, `/api/tuya-mode`, `/api/inverter/autoscan`) існують окремо,
> щоб не ганяти весь конфіг заради одного прапорця.

### Сцени / автоматизації

| Method | Path | Body → | Response |
|---|---|---|---|
| GET | `/api/scenes` | — | масив сцен (без обгортки) |
| POST | `/api/scenes` | об'єкт сцени (`enabled` форсується в `true`) | `{success}` |
| PATCH | `/api/scenes/:name` | `{enabled:boolean}` | `{success, enabled}` / `404` |
| DELETE | `/api/scenes/:name` | — | `{success}` |
| POST | `/api/scenes/:name/run` | — (ручний запуск) | `{success, results[]}` / `404` |
| GET | `/api/scene-traces?last=N` | — | `{success, traces:{sceneName:[...]}}` |

### Історія / графіки

| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/history` | `?period=1h\|3h\|6h\|12h\|day\|week\|month\|year` | `{success, period, points[]}` — RRD-агрегація |
| GET | `/api/socket-history` | те саме `?period=` | `{success, period, points[], deviceNames}` |

### Мережа / діагностика

| Method | Path | Body/Query → | Response |
|---|---|---|---|
| GET | `/api/device-ping/:ip` | — (валідний IPv4) | `{success, ip, online}` |
| GET | `/api/logs` | — | `{success, logs:string}` |

### Система / оновлення / бекап

| Method | Path | Body → | Response |
|---|---|---|---|
| POST | `/api/restart` | — | `{success, message}`, рестарт сервісу через 500мс |
| POST | `/api/update-check` | — | `{success, isGit, tags[], currentTag, currentBranch, branches[], local}` |
| POST | `/api/update-apply` | `{tag}` **або** `{branch}` (взаємовиключно) | `{success, message}` — стрімить checkout + рестарт асинхронно |
| POST | `/api/backup` | `{scope:['config','auth','scenes','history','devices']}` | `{success, backup:{version, createdAt, gitHash, data}}` |
| POST | `/api/backup/restore` | `{data, overwrite?:[...], confirmPassword?}` — `confirmPassword` обов'язковий, якщо відновлюєш `auth` | `{success, message}` |

### Користувачі та особисті налаштування

| Method | Path | Body → | Response |
|---|---|---|---|
| GET | `/api/user-prefs` | — | `{success, username, role, prefs}` |
| POST | `/api/user-prefs` | `{prefs:{...}}` (мерджиться з існуючим) | `{success}` |
| GET | `/api/users` | — (тільки `admin`) | `{success, users:{name:{role,createdAt}}}` |
| POST | `/api/users` | `{username, password, role?}` (тільки `admin`) | `{success}` / `409` якщо існує |
| DELETE | `/api/users/:username` | — (тільки `admin`, не можна `admin`) | `{success}` |

---

## 5. Типові патерни в кодовій базі

- **Query-параметри парсяться вручну** через `req.url.split('period=')[1]`, а не
  `URLSearchParams` (крім `/api/metrics`, там нормальний `URL`). Якщо додаєш новий
  query-параметр — глянь на сусідній роут для консистентності, або краще
  переходь на `new URL(req.url, 'http://localhost')`.
- **Секрети ніколи не повертаються в чистому вигляді** — `GET /api/plugin-config`
  підміняє `tuya.password`, `tuya.accessKey`, `notifications.telegramToken`,
  `netbird.setupKey` на `••••••••`. При `POST` те саме значення `••••••••`
  (або порожній рядок) означає "не змінювати" — не намагайся послати назад
  замасковане значення як нове.
- **Мутуючі POST повертають 200 навіть на невдачу** в багатьох місцях (Tuya,
  NetBird, restore) — дивись `success`, а не HTTP-статус.
- **`:param` у шляху** підтримується (`/api/scenes/:name`, `/api/tuya-devices/:id/group`,
  `/api/users/:username`, `/api/device-ping/:ip`) — доступно як `req.params.name` і т.д.

## 6. Як перевірити, що фронт і бек не розійшлись

Саме так я знайшов ті 7 битих кнопок минулого разу — порівняв усі виклики `api(...)`
у `public/app.js`/`public/login.js` з усіма зареєстрованими `route(...)` у
`lib/routes.js`. Швидкий скрипт (Python), можна ганяти перед кожним релізом:

```bash
python3 -c "
import re
fe = set()
for f in ['public/app.js','public/login.js']:
    txt = open(f, encoding='utf-8', errors='ignore').read()
    for m in re.finditer(r'api\(([\'\"])(.*?)\1', txt):
        p = re.sub(r'\\\$\{[^}]+\}', '*', m.group(2))
        fe.add(p.split('?')[0])
be = set()
txt = open('lib/routes.js', encoding='utf-8', errors='ignore').read()
for m in re.finditer(r\"route\('[A-Z]+',\s*'([^']+)'\", txt):
    be.add(m.group(1))
def matches(fpath, bpath):
    pb, pf = bpath.split('/'), fpath.split('/')
    if len(pb) != len(pf): return False
    return all(a.startswith(':') or a == b or b == '*' for a, b in zip(pb, pf))
missing = [f for f in sorted(fe) if not any(matches(f, b) for b in be)]
print('Frontend calls with no backend match:', missing or 'none 🎉')
"
```

Якщо список не порожній — або додай роут у `lib/routes.js`, або виправ шлях у
`public/app.js`, перед тим як комітити.

## 7. Чеклист при додаванні нового ендпоінта

1. Дай назву шляху в **`/api/<domain>[/<action>]`** стилі — тримайся вже наявних
   груп (`tuya-*`, `inverter/*`, `netbird/*`, `notifications/*`), не вигадуй нову
   схему іменування для суміжної фічі.
2. Реєструй у `lib/routes.js` через `route(METHOD, path, handler)`. Мутуючі —
   `POST/PATCH/DELETE` (авто-захищені CSRF-мідлваром, нічого додатково робити не треба).
3. Відповідь — завжди `{success: boolean, ...}`, навіть при помилці
   (`sendJson(res, 200 або 4xx/5xx, {success:false, message:'...'})`).
4. Якщо ендпоінт читає/пише `config.json` — прогони через `loadConfig()`/`saveConfig()`,
   не працюй з файлом напряму (там же і шифрування секретів, і атомарний запис).
5. У фронтенді виклик — тільки через хелпер `api(path, opts)`, ніколи голий `fetch`.
6. Онови цей файл — таблицю відповідного розділу.
7. Перед комітом — прожени скрипт з розділу 6.
