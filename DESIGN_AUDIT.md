# Design System Audit — Strum Energy Controller

Generated 2026-07-29 by automated analysis of `public/index.html` and `public/login.html`.

---

## 1. File Overview

| File | Size | `:root` tokens | CSS `var()` refs | `@media` | `@keyframes` | ID selectors | `!important` |
|---|---|---|---|---|---|---|---|
| `index.html` | 129 KB | 23 | 191 | 7 | 9 | 27 | 1 |
| `login.html` | 4 KB | 0 (no `:root`) | 0 | 0 | 3 | 6 | 0 |

**Total inline `style=""` attributes in index.html: 111**
**Total inline `style=""` attributes in login.html: 2**

---

## 2. Existing `:root` Tokens (index.html)

### Colors
```
--bg:#000
--card:rgba(28,28,30,.66)
--card-solid:#1c1c1e
--card-hover:rgba(44,44,46,.85)
--border:rgba(255,255,255,.09)
--sep:rgba(84,84,88,.5)
--text:#f5f5f7
--muted:#98989f
--dim:#636366
--accent:#0A84FF
--accent-rgb:10,132,255
--green:#30D158
--amber:#FF9F0A
--red:#FF453A
--indigo:#5E5CE6
--cyan:#64D2FF
```

### Radii
```
--r-xl:32px
--r-lg:24px
--r-md:16px
```

### Motion
```
--spring:cubic-bezier(.34,1.56,.64,1)
--ease:cubic-bezier(.25,.8,.25,1)
```

### Typography
```
--font:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Manrope Variable','Manrope',system-ui,sans-serif
--mono:'JetBrains Mono Variable','JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace
```

### Safe-area
```
--sat, --sab, --sal, --sar
```

### Notable gaps
- No spacing/scale tokens (no `--space-*`)
- No type scale tokens (no `--fs-*`, `--lh-*`, `--fw-*`)
- No shadow tokens (no `--shadow-*`)
- Only 3 radius tokens — 13 **un-tokenized** radius values in use
- No `--color-` prefixed aliases for text/surface states

---

## 3. border-radius — Literals vs Tokens

**Current token coverage:** `--r-xl:32px`, `--r-lg:24px`, `--r-md:16px` (3 tokens)

**Distinct literal values found (16):**

| Value | Count | Sample locations |
|---|---|---|
| 9px | 4 | `.seg`, device rows |
| 3px | 3 | misc small corners |
| 24px | 3 | `.app-icon`, login icon |
| 14px | 3 | `.field input` (login), misc |
| 980px | 3 | `.btn`, `.chip` (pill shape) |
| 10px | 2 | `.btn-xs`, `.ibtn` |
| 12px | 2 | `.seg`, `.ibtn` |
| 18px | 2 | `.outage-ic`, `.hstat.sm` |
| 26px | 2 | misc |
| 30px | 2 | misc |
| 16px | 2 | `.field` (login), misc |
| 20px, 22px, 7px, 31px, 32px | 1 each | single-use |

**Recommendation:** Map to 4–5 semantic radius levels (xs, sm, md, lg, pill) via `--r-*` tokens.

---

## 4. font-size — Literals Only (no type scale tokens)

**Distinct values found (25):**

| Value | Count | Typical use |
|---|---|---|
| 11px | 11 | `.lbl`, `.kw`, `.badge`, meta labels |
| 13px | 10 | `.sub`, `.login-hint`, `.outage-info` |
| 15px | 10 | `.btn`, `.nav-label`, various body |
| 12px | 8 | tertiary, hints |
| 12.5px | 6 | `.seg` buttons |
| 14px | 5 | `.card-title`, field labels |
| 16px | 6 | body, inputs |
| 10px | 4 | tiny badges |
| 10.5px | 3 | extra small labels |
| 13.5px | 3 | fine print, stats |
| 17px | 3 | `.outage-info b`, section headers |
| 19px | 3 | subtitle-ish |
| 11.5px, 18px | 2 each | misc |
| 21px, 26px | 2 each | larger stats |
| 24px, 28px, 29px, 32px, 34px, 40px, 44px, 52px | 1 each | hero values, SOC center |

**Recommendation:** 8–9 step type scale (`--fs-xs` through `--fs-xxl`). The 25 distinct values collapse to ~9 steps.

---

## 5. Padding / Spacing — No Tokens

**42 distinct padding values** — all literal.

Common patterns:
- `calc(…)` with safe-area inset — 3 occurrences (correct, tokenize the `calc`)
- `6px 12px` — 2x (chip)
- `13px 15px` — 2x (button-size)
- `18px` — 2x (card padding)
- `6px 0` — 2x
- `3px 8px`, `3px 9px`, `4px 11px`, `7px 10px`, `7px 14px`, `8px 10px 6px`, etc. — 1x each

**Margin distinct values:** 12 — all literal.

**Recommendation:** Introduce `--space-3xs` through `--space-3xl` (4px/6px/8px/12px/16px/20px/24px/32px).

---

## 6. box-shadow

**24 declarations** — all literal. No shadow tokens.

Patterns:
- `0 0 8px var(--green)` — glow on live-dot
- `0 8px 22px rgba(…)` — `.btn` primary
- `0 0 0 3px rgba(…)` — focus ring (`.field:focus-within`)
- `0 -2px 12px rgba(…)` — sheet header shadow
- `0 4px 24px rgba(…)` — sheet container, modal overlay
- `0 14px 34px rgba(…)` — login icon (login.html)
- Various `0 1px …` / `0 2px …` — card/tile inner borders

**Recommendation:** 4–5 semantic shadow levels (`--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--shadow-glow`).

---

## 7. backdrop-filter

**6 declarations** (12 lines counting `-webkit-` prefix pairs):

| Selector | Filter |
|---|---|
| `.card` | `blur(30px) saturate(170%)` |
| `.card-sm` | `blur(24px) saturate(160%)` |
| `.tile` | `blur(20px)` |
| `#tabbar` | `blur(26px) saturate(180%)` |
| `.sheet-bd` | `blur(24px)` (overlay) |
| `.restart-ov` | `blur(6px)` (overlay) |

**Observation:** 5 distinct blur values. Could be reduced to 3 (`--blur-sm`, `--blur-md`, `--blur-lg`).

---

## 8. Gradients

**12 occurrences:**

| Context | Type |
|---|---|
| `.bgfx` background | `radial-gradient` (2x) |
| Background orbs `.o1`, `.o2` | `radial-gradient` (2x) |
| `.app-icon` | `linear-gradient(145deg,#5E5CE6,#0A84FF)` |
| Login `.icon` | `linear-gradient(145deg,#5E5CE6,#0A84FF)` |
| `.hero::after` | `radial-gradient` |
| `.survive` | `linear-gradient` |
| `select.sh-input` | `linear-gradient(45deg,…)` (chevron) |
| `.skel` | `linear-gradient` (skeleton shimmer) |
| `.outage` | `linear-gradient` (implied in HTML) |

**Recommendation:** Tokens only for brand gradient (login icon / app-icon). Others are decorative and can stay literal if unique, or be tokenized to `--grad-brand`.

---

## 9. Color Literals in CSS

- `rgba()`: **96** occurrences
- `hex`: **33** occurrences
- `rgb()`: **0**
- `hsl()`: **0**

**Hardcoded inline `style="background:#…"` (non-var):**
```
#fff        — 1x
#101012     — 1x
#FF5A5F     — 2x  (srow sic)
#229ED9     — 3x  (srow sic — Telegram brand)
#0A84FF     — 1x  (srow sic)
```

**Hex-to-var gaps:** `#FF5A5F` (Airbnb red) and `#229ED9` (Telegram blue) are brand-specific .srow icons — could become `--color-telegram`, `--color-airbnb`, or be left as-is since they represent third-party services.

---

## 10. Component Surface Count

| Component | Count | Notes |
|---|---|---|
| Cards (`.card`, `.card-sm`) | ~8 | Backdrop-filter cards |
| Tiles (`.tile`) | ~10 | Minor cards with blur |
| Sheet panels | 2 | Bottom-sheet, fullscreen overlay |
| Bottom tab bar | 1 | `#tabbar` |
| Buttons (`.btn`, `.btn-sm`, `.btn-xs`, `.btn-ghost`, `.ibtn`) | ~5 classes | |
| Chips (`.chip`, `.chip-green`, etc.) | ~3 classes | |
| Segmented control | 1 | `.seg` |
| Device rows (`.srow`, `.sl`, `.sic`) | ~30 rows | Icon+label+value layout |
| Outage banner | 1 | `.outage` |
| Survival mode bar | 1 | `.survive` |
| Hero (SOC center) | 1 | `.hero` |
| Stats (`.hstat`) | ~6 | Home stats |
| Switch (`.sw`) | ~6 | Toggle switches |

---

## 11. Summary of Opportunities

| Area | Current state | Target |
|---|---|---|
| Radius tokens | 3 tokens, 16 literal values | 5 tokens (xs, sm, md, lg, pill) |
| Type scale tokens | 0 tokens, 25 literal values | 9 tokens (xs→xxl) |
| Spacing tokens | 0 tokens, 42+12 literal values | 8 tokens (3xs→3xl) |
| Shadow tokens | 0 tokens, 24 literal declarations | 5 tokens (sm→xl, glow) |
| `backdrop-filter` tokens | 0 tokens, 5 distinct values | 3 tokens (sm, md, lg) |
| Gradient tokens | 0 tokens, 12 declarations | 1–2 tokens (brand-brand) |
| Inline `style=""` | 111 attributes | ≤40 (only dynamic/unique) |
| Color literal count | 96 rgba + 33 hex | Reduce by ~50% via var() |
| Apple HIG palette | All 6 semantic colors are exact Apple values | Shift hue/sat 5–10% off Apple |
| `!important` | 1 | 0 |

**Token reduction potential:** ~130 literal declarations → ~30 `var()` references
**Inline style reduction potential:** 111 → ≤40

