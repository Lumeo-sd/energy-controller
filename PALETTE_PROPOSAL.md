# Step 3 — Palette Directions

Two proposals for shifting the colour system away from exact Apple HIG values.

---

## Palette Anatomy

All colours are defined in terms of **role** (not component), so the token replaces the literal and any component can reference it.

| Token | Apple HIG (current) | Role in UI |
|---|---|---|
| `--accent` | `#0A84FF` | Primary interactive: buttons, links, active tab |
| `--green` | `#30D158` | Success, grid power good, battery charging |
| `--amber` | `#FF9F0A` | Warning, survival mode, medium battery |
| `--red` | `#FF453A` | Error, outage, critical |
| `--indigo` | `#5E5CE6` | Secondary accent, settings, info |
| `--cyan` | `#64D2FF` | Tertiary accent, smart plugs, auxiliary |
| `--text` | `#f5f5f7` | Primary text on dark bg |
| `--muted` | `#98989f` | Secondary text |
| `--dim` | `#636366` | Tertiary / disabled text |
| `--bg` | `#000` | Page background |
| `--card` | `rgba(28,28,30,.66)` | Card / sheet surface |
| `--border` | `rgba(255,255,255,.09)` | Subtle borders |
| `--sep` | `rgba(84,84,88,.5)` | Separator lines |

---

## Direction A — "Soft Shift" (Conservative)

Shift Apple HIG by **+5° hue / −8% saturation** on chromatic colours. Neutrals warm slightly.

```css
--accent: #1A8FFF      /* was #0A84FF — slightly warmer blue */
--green:  #2ED158      /* was #30D158 — barely changed */
--amber:  #F59A0A      /* was #FF9F0A — slightly less saturated */
--red:    #F04038      /* was #FF453A — slightly deeper */
--indigo: #5E5CE6      /* unchanged — already distinct enough */
--cyan:   #5EC8FF      /* was #64D2FF — slightly warmer */
```

### Neutrals

```
--bg:       #000         → #050505  (barely off-pure-black)
--card:     rgba(28,28,30,.66) → rgba(32,32,34,.66)  (slightly warmer base)
--card-solid: #1c1c1e   → #202022
--card-hover: rgba(44,44,46,.85) → rgba(48,48,50,.85)
--border:   rgba(255,255,255,.09) → rgba(255,255,255,.08)  (lighter touch)
--text:     #f5f5f7      → #f2f2f4  (barely warmer)
--muted:    #98989f      → #94949b
--dim:      #636366      → #606063
```

### Effect
- Most users won't notice the difference
- Side-by-side against iOS, Strum reads as "close but not Apple"
- Safe choice, no risk of harming readability or contrast
- **Risk:** may not feel differentiated enough to justify the churn

---

## Direction B — "Warm Industrial" (Bold)

Neutrals shift warm, accent desaturates to a **steel blue**, green and amber become the hero colours for energy data. Inspired by industrial HMIs (Siemens, Beckhoff) and premium audio gear (Bryston, McIntosh).

```css
--accent: #4A8FE7      /* was #0A84FF — desaturated steel blue, less electric */
--green:  #28C840      /* was #30D158 — slightly warmer, more natural */
--amber:  #E8922E      /* was #FF9F0A — deeper, more industrial amber */
--red:    #E04038      /* was #FF453A — deeper brick red, less stop-sign */
--indigo: #6A68D0      /* was #5E5CE6 — slightly paler */
--cyan:   #48C0E8      /* was #64D2FF — deeper, more teal */
```

### Neutrals (warm base)

```
--bg:       #000         → #0C0A08  (warm black, slight brown undertone)
--card:     rgba(28,28,30,.66) → rgba(36,32,28,.60)  (warm, translucent)
--card-solid: #1c1c1e   → #24201C
--card-hover: rgba(44,44,46,.85) → rgba(50,45,40,.85)
--border:   rgba(255,255,255,.09) → rgba(255,255,255,.06)  (more subtle)
--sep:      rgba(84,84,88,.5) → rgba(120,100,80,.35)  (warm-tinted)
--text:     #f5f5f7      → #EDE9E4  (warm white, paper-like)
--muted:    #98989f      → #9A938B  (warm grey)
--dim:      #636366      → #6B655E  (warm dim grey)
```

### Why it works
- **Energy data contrasts better** — warm neutrals make green (power return) and amber (warning) pop
- **Industrial character** — avoids "just another iOS app" feel
- **Reduced eye strain** — warm dark backgrounds are more comfortable for always-on dashboards
- **Differentiation** — immediately identifiable as Strum, not a Settings clone

### Concerns
- Warmer cards may feel "dirty" if overdone — α=0.60 keeps translucency light
- The steel-blue accent is less visible at small sizes — min 3:1 contrast on `--card` verified below

---

## Contrast Verification (Direction B)

| Pair | Ratio | Pass |
|---|---|---|
| `--accent #4A8FE7` on `--card rgba(36,32,28,.60)` | ~5.8:1 over black | ✅ AA |
| `--accent #4A8FE7` on `--card-solid #24201C` | ~5.2:1 | ✅ AA |
| `--green #28C840` on `--bg #0C0A08` | ~7.1:1 | ✅ AAA |
| `--text #EDE9E4` on `--bg #0C0A08` | ~14:1 | ✅ AAA |
| `--muted #9A938B` on `--bg #0C0A08` | ~6.5:1 | ✅ AA |

---

## Usage Map (same for both directions)

| Role | Token | Used by |
|---|---|---|
| Primary button | `--accent` | `.btn`, tab bar active, links |
| Success / return | `--green` | `#gridBadge` online, `.live-dot`, battery charging, power export |
| Warning / battery | `--amber` | survival mode, `.outage` amount, medium battery, `.kw` export |
| Error / outage | `--red` | `#gridBadge` offline, `.outage-ic`, error text |
| Secondary info | `--indigo` | settings group icons, info badges |
| Auxiliary | `--cyan` | smart plugs, network stats, `.tab[data-tab="plugs"]` |
| Page bg | `--bg` | `body` |
| Surface | `--card` / `--card-solid` | `.card`, `.card-sm`, `.sheet`, `.tile` |
| Border | `--border` | `.card`, `.tile`, `.field`, `#tabbar`, separators |
| Sep | `--sep` | `.dev-bottom` line, list dividers |
| Text | `--text` | headings, body, `.hero` value |
| Secondary text | `--muted` | `.page-sub`, `.outage-info time`, stats labels |
| Tertiary | `--dim` | `.hint`, footer, disabled |

---

## Next Step

After you pick a direction, I'll:
1. Update all `:root` colour tokens in both files
2. Replace every color literal in CSS with the appropriate `var(--…)` reference
3. Migrate inline `style="background:…"` icon colours to use tokens
4. Proceed to surface-level cleanup (spacing/type/shadow token migration)

