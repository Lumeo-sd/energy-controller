# Step 2 — Token System Proposal

Extend the existing `:root` block in `public/index.html` with five new token families. Login.html will get its own `:root` that inherits index's tokens at runtime (or gets a copy).

---

## 2.1 Spacing Scale — `--space-*`

Replaces the 42 distinct literal padding values and 12 literal margin values.

```css
--space-3xs: 3px;    /* seg inner, minor gaps */
--space-xxs: 4px;    /* tiny badge pad */
--space-xs:  6px;    /* chip gap, switch inset */
--space-sm:  8px;    /* btn gap, small inset */
--space-md:  12px;   /* chip pad-x, field inner, button pad-y */
--space-lg:  16px;   /* card inner, field inner, gap between sections */
--space-xl:  20px;   /* page pad-x, card outer gap */
--space-2xl: 24px;   /* sheet inner, large card pad */
--space-3xl: 32px;   /* login card pad-x, wide section padding */
```

### Mapping notes
- Values that fall between steps (e.g. 10px, 14px, 18px, 22px) map to the nearest step. The 10px gap in `.field` becomes `--space-sm` (8px) — a 2px reduction, visually negligible.
- Safe-area `calc()` expressions stay but reference `--space-*` for the fixed portion, e.g. `calc(var(--space-lg) + var(--sat))`.

---

## 2.2 Type Scale — `--fs-*`

Replaces the 25 distinct literal `font-size` values.

```css
--fs-2xs: 10px;   /* tiny badges, legal */
--fs-xs:  11px;   /* .lbl, .kw, meta labels (11×) */
--fs-sm:  13px;   /* .sub, secondary text (10×) */
--fs-base: 15px;  /* body, buttons (10×) */
--fs-md:  17px;   /* section headers, .outage-info b (3×) */
--fs-lg:  20px;   /* subsection titles (3×) */
--fs-xl:  24px;   /* card titles (1×) */
--fs-2xl: 28px;   /* h1, page headings (1×) */
--fs-3xl: 34px;   /* .page-title (1×) */
--fs-4xl: 44px;   /* large hero numbers */
--fs-5xl: 52px;   /* SOC center value (1×) */
```

### Mapping notes
- 25 → 11 steps. Odd intermediate values (10.5px, 11.5px, 12.5px, 13.5px, 14.5px) collapse to the nearest step.
- The `.seg` buttons at 12.5px become `--fs-xs` (11px) — a 1.5px reduction that keeps the segmented control visually subordinate.
- 14px (field labels, card titles, 5×) becomes `--fs-sm` (13px) — a 1px reduction.

---

## 2.3 Shadow System — `--shadow-*`

Replaces the 24 literal `box-shadow` declarations. Uses `--accent-rgb` so the brand glow stays in sync.

```css
--shadow-sm:  0 1px 3px rgba(0,0,0,.35);            /* card/tile subtle edge */
--shadow-md:  0 4px 16px rgba(0,0,0,.30);           /* card hover, tile raised */
--shadow-lg:  0 8px 24px rgba(0,0,0,.35);           /* sheet, modal */
--shadow-xl:  0 14px 34px rgba(var(--accent-rgb),.45); /* .btn primary, login icon */
--shadow-inner: inset 0 0 0 1px rgba(255,255,255,.06); /* card inner border stand-in */
--shadow-glow-green: 0 0 8px var(--green);          /* live-dot, active indicator */
```

### Mapping notes
- Focus rings (`0 0 0 3px rgba(10,132,255,.22)`) remain inline — they're accent-colour specific and only appear on 1–2 elements.
- The login icon glow (`0 14px 34px rgba(10,132,255,.45)`) maps to `--shadow-xl`.

---

## 2.4 Extended Radii — `--r-*`

Adds three new levels to the existing three.

```css
/* existing */
--r-md:  16px;
--r-lg:  24px;
--r-xl:  32px;

/* new */
--r-xs:  8px;     /* .seg, small components */
--r-sm:  12px;    /* .ibtn, small cards */
--r-pill: 980px;  /* .btn, .chip (currently literal) */
```

### Mapping notes
- 9px (seg, device rows, 4×) → `--r-xs` (8px). A 1px reduction, visually identical.
- 3px (misc, 3×) → `--r-xs` or kept as `3px` if only used on truly minor elements.
- 10px → `--r-xs` (8px) or `--r-sm` (12px) depending on component.
- 14px (field input) → `--r-sm` (12px). A 2px reduction.
- 18px → `--r-md` (16px). A 2px reduction.
- 20px, 22px, 26px, 30px → `--r-lg` (24px) or `--r-xl` (32px).
- 980px (pill shape) → `--r-pill`. Stays 980px — the exact value ensures a true pill at any size.

---

## 2.5 Blur / Filter Tokens — `--blur-*`

Replaces the 5 distinct `backdrop-filter` blur values (6 declarations).

```css
--blur-sm: 6px;    /* .restart-ov overlay */
--blur-md: 20px;   /* .tile, .card-sm, .sheet-bd */
--blur-lg: 30px;   /* .card, #tabbar */
```

The `saturate()` component stays literal since it varies per element (170%, 160%, 180%).

---

## 2.6 Summary: Token Additions

| Family | New tokens | Replaces |
|---|---|---|
| `--space-*` | 9 | ~54 literal spacing values |
| `--fs-*` | 11 | ~75 literal font-size declarations |
| `--shadow-*` | 6 | ~24 literal box-shadow declarations |
| `--r-*` | 3 (+3 existing) | ~16 literal border-radius values |
| `--blur-*` | 3 | ~5 literal blur values |
| **Total** | **32 new tokens** | **~130 literal declarations** |

---

## 2.7 Next: Palette Directions

Before any bulk replacements, Step 3 will propose two palette directions:

1. **"Soft shift"** — current Apple HIG colours shifted 5–10% in hue/sat, keeping the same general feel.
2. **"Warm industrial"** — warmer neutrals, slightly desaturated accent, amber/green tones for energy data.

Each will come with a swatch table and a usage map showing which components get which colour role.

