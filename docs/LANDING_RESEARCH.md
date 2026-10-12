# Landing research: Framer template study

Method: real Chrome driven by Playwright (`channel: 'chrome'`), 1440x900 and 390x844 (mobile emulation), scrolled end to end to trigger lazy content and scroll reveals, `document.fonts.ready` awaited, full-page screenshots, then values read with `getComputedStyle` and `document.getAnimations()`. Screenshots are in `e2e/.artifacts/landing/ref/` (git-ignored): `<site>-1440.png`, `<site>-1440-fold.png`, `<site>-390.png`, raw measurements in `measured.json`. Nothing here copies another site's copy, images, logos or code; only structure, rhythm, hierarchy and motion principles are taken.

Sites studied (Framer marketplace categories AI / SaaS / Software, plus the owner's reference):

| Site | URL | Page height @1440 | Character |
| --- | --- | --- | --- |
| Zenon (owner reference, video editing service) | zenon.framer.website | 11 558 px | warm grey, grain, dashed frames, pill buttons |
| Landio (AI automation) | landio.framer.website | 12 332 px | near-black, Inter 80/500, inset-highlight cards, ambient blur background |
| Fluence AI | fluence.framer.website | 11 525 px | full-bleed illustration hero, chat-box as hero product, orange accent, warm off-white body (#f6f4f1) |
| Ionyx | ionyx.framer.website | 9 403 px | dark, expanded grotesque, particle sphere, glow outline pills (radius 50) |
| Aigent | aigentx.framer.website | 9 362 px | dark teal, mono eyebrow tags, floating boxed nav, logo marquee |
| Alter | alter.framer.website | 8 437 px | light, Plus Jakarta Sans 72/400, soft blue shadows (0 15px 30px), 16 px radius cards |

No mobile page overflows horizontally (all six measure `scrollWidth` 390 at 390 wide).

## What the owner's reference (Zenon) is, measured

### Section inventory and rhythm (1440)

Everything lives in a 1360 px column (40 px page gutter). Sections are separated by about 100 px of empty space, not by rules; the "frame" is the divider.

| # | Section | y / height | Notes |
| --- | --- | --- | --- |
| nav | logo left, black pill CTA with white circle arrow, round black menu button | 72 high, `header` padding 0 40 | not blurred, transparent over the grain |
| 001 hero | large rounded container, 1px dashed border, radius ~24 | 72 to 1462 | status pill, H1, sub, two pills, rating line, strip of rounded media cards bleeding off both edges, soft blur fading the strip bottom |
| logo strip | "Editing for creators and brands like these" label, 4 cells divided by dashed lines | inside hero frame bottom | |
| 002 About | eyebrow tag, H2 left, 2 line grey paragraph right; 3-card row inside a dashed frame (dark photo card, chart card, stat card) | 1462 to 2243 | |
| 003 Work | H2 + segmented filter pill on the right; 4x2 grid of 9:16 cards in a dashed frame; counter marquee strip with dashed cell dividers | 2243 to 3924 | |
| 004 Services | H2 + paragraph; tab list left (4 outlined rows), detail panel right with image | 3924 to 4811 | |
| 005 Process | sticky-ish left copy; right stack of 4 accordion rows with numbers `/01` | 4811 to 5455 | |
| 006 Why | comparison table, last column a black card | 5455 to 6380 | |
| 007 Case study | full black rounded panel (radius ~28) with before/after slider | 6380 to 7258 | the one dark moment, a strong rhythm break |
| 008 Reviews | H2 + prev/next round buttons with `01 / 05`; horizontal carousel of dashed cards | 7258 to 8020 | |
| 009 Pricing | monthly/yearly segmented pill; 3 cards, middle one black; "need something different" strip | 8020 to 9167 | |
| 010 FAQ | numbered accordion `01..07` left, contact card right | ~9300 to 10400 | round +/- buttons |
| CTA | dashed frame, status pill, H2, form card | ~10400 to 11000 | |
| footer | dashed frame: logo + tagline, two link columns, contact card; copyright row below | ~11100 to 11558 | |

Every section opens with the same two-part header: a numbered eyebrow pill `/ 002 / ABOUT` (mono-ish uppercase, 11.2 px, tracking 0.67 px, dashed outline) and a 60 px H2, with the supporting paragraph pushed to the right column at the H2 baseline.

### Typography (computed)

Fonts loaded: Host Grotesk 400/500/600 (SIL OFL, on Google Fonts) and Geist Mono 500 (OFL). Both are available from `@fontsource-variable/*` under OFL and can be self-hosted.

| Role | Size / line height | Weight | Tracking | Colour |
| --- | --- | --- | --- | --- |
| H1 | 72 / 79.2 (1.1) | 600 | -2.16 px (-0.03em) | #121212 |
| H2 | 60 / 66 (1.1) | 600 | -1.5 px (-0.025em) | #121212 |
| H3 / card title | 24 / 26.4 | 600 | -0.48 px (-0.02em) | #121212 |
| FAQ question | 19.2 / 24.96 | 600 | -0.384 px | #121212 |
| Body / sub | ~18 / 1.45 | 400 | normal | #4f4f4f |
| Button | 15 / 18 | 500 | -0.075 px | on-dark #f0f0f0 |
| Status pill | 14.4 / 18.7 | 500 | normal | #121212 |
| Eyebrow, micro label | 11.2 / 13.4 | 600, uppercase | +0.672 px (0.06em) | #121212 / #4f4f4f |
| Mono data (stats, handles, counters) | ~11 | 500 | uppercase, wide | #4f4f4f |
| Mobile H1 | 40 / 44 | 600 | -1.2 px | |

Heading colour is not black (#121212), body is a mid grey (#4f4f4f): the hierarchy is mostly value contrast, not size alone.

### Colour tokens (from Framer's `--token-*` variables)

| Role | Value |
| --- | --- |
| page | #f0f0f0 |
| surface (cards, tabs, FAQ rows) | #e5e5e5 |
| ink | #121212 |
| soft ink | #4f4f4f |
| dark surface (case panel, pricing middle, table column) | #080808 |
| text on dark, muted on dark | #f0f0f0 / #a1a1a1 |
| dashed hairline | rgba(0,0,0,0.2), 1 px dashed |
| on-dark hairline | rgba(255,255,255,0.15) |
| accent (circle behind arrow, stars) | #f24202 (hover #fc4823) |
| status green | #00ba1f |

The page is a single flat colour; the "warm" feel comes from an overlaid film grain (an `feTurbulence`-type noise layer) and from surfaces being only 6% darker than the page.

### Spacing, radii, borders, shadows

- Gutter 40 px (mobile 15 px). Section gap about 100 to 140 px. Frame inner padding 8 px (cards sit 8 px inside the dashed border; the frame hugs its children).
- Radii: frame ~24, cards 20 to 24, dark case panel ~28, pills 999.
- Borders are always 1 px dashed at 20% black; no box shadows anywhere (confirmed: `box-shadow: none` on every card). Depth is surface value (#f0f0f0 vs #e5e5e5 vs #080808), never shadow.
- Selected states (active tab, open FAQ row, "All" filter) = surface fill #e5e5e5 with the dashed border removed or kept; inactive = transparent with dashed border.

### Buttons

- Primary: height 52, radius 999, background #121212, padding `0 7px 0 24px`, 15/500 label, a 38 px circle at the right holding a 12 px `↗` arrow, circle fill #f24202 in the hero (white in nav and on dark panels, black on light-on-dark).
- Nav primary: height 42, padding `0 6px 0 20px`, circle white with black arrow.
- Secondary: height 52, radius 999, transparent, 1 px dashed border, padding `0 24px`, ink label.
- Menu button: 42 px circle, #121212, two white lines.
- Segmented filters: dashed pill container, active item has #e5e5e5 pill fill, count in mono, 11 px, 50% opacity.
- Round +/- FAQ toggles: 36 px circle, dashed border; open state fills black with a white minus.

### Motion

- Entrance reveals: WAAPI, 520 ms, `cubic-bezier(0.22, 1, 0.36, 1)` (an ease-out-quint family), staggered by 105 ms per child (delays 0, 105, 210, 315 ...), fade plus short upward translate.
- Hero card strip is a 5 s linear marquee/sweep (`vcr2fsweep`); counters and the metric ticker run as marquees.
- Hover: buttons and rows use `transition: all`; the arrow circle shifts on hover (accent #fc4823).
- Scroll: no parallax; blur-fade mask at the bottom of the hero strip (CSS mask gradient) is the only scroll-adjacent effect.
- Accordions animate height and swap +/- glyph.

### What makes it feel premium

1. One flat neutral plus a grain overlay: it reads as paper, not as a screen.
2. A single typeface at two weights (500 and 600) with very tight tracking and 1.1 line height on display sizes; secondary info in a tiny uppercase mono.
3. Dashed 20% hairlines as the only structure: lightweight, "blueprint" feeling, and everything aligns to the same 1360 px frame.
4. Pills everywhere, with one consistent affordance: circle-arrow.
5. A single warm accent used only on action circles and stars; one black full-bleed panel for rhythm.
6. Numbered eyebrow system (`/ 002 / ABOUT`) gives an editorial table-of-contents feel.
7. Generous vertical rhythm and tiny, consistent motion (one easing, one duration, one stagger).

## Other templates: what to borrow, what not

| Site | Typography (computed) | Colour | Components worth emulating | Notes |
| --- | --- | --- | --- | --- |
| Landio | Inter, H1 80/96 weight 500 tracking -1.6 px, H2 44/52.8 500 | #04070d page, text #e4e9f2, muted rgba(184,199,217,.5) | cards radius 20 with `inset 0 2px 1px rgba(207,231,255,.2)` top highlight; centered pill nav in a bordered capsule; a hero icon tile with glow; a serif-italic accent word in the H1 | motion: slow ambient background; radius 8 buttons |
| Fluence | General Sans (not OFL, not usable), H1 56/66 500, H2 44/52.8, H4 24 | #f6f4f1 body, #0b0b09 ink, accent #fc5725 | the hero product is a working-looking prompt box (our "tell it what to do" parallel); suggestion chips below it; radius 8 solid buttons | strongest "AI input as hero" idea |
| Ionyx | Zalando Sans Expanded 68/74 600 tracking -2.72 px; Inter 28/34 600 for list items | #0a0a0f, violet #7b61ff | glowing outlined pill CTAs (radius 50, 64 high); big expanded headline | too heavy/gimmicky for a tool, skip the glow |
| Aigent | TASA Orbiter 68/70 600 tracking -2 px, H2 46/49 700 | dark teal, off-white body #fafafa | mono uppercase eyebrow with bracket ticks; floating boxed nav; "trusted by" marquee (we do not have logos) | nav as a floating bordered bar is nice at mobile |
| Alter | Plus Jakarta Sans 72/86.4 400 tracking -0.72 px | white, ink #0e1c29 | soft blue shadow cards `0 15px 30px rgba(94,120,143,.35)`, 16 px radius; "Integrates with" row | light and airy; weight 400 display |

Common to all six: single-viewport hero with H1 plus one primary CTA, product visual immediately below or beside, H1 sizes 56 to 80 px with tracking -0.01 to -0.04em and line height 1.0 to 1.2, section H2 44 to 60 px, buttons 36 to 64 px high, entrance reveal around 0.5 s ease-out, nav 60 to 104 px high with a single filled CTA, a sticky or floating nav, a cards-with-product-UI feature grid and a numbered or iconised process section.

## Decisions for RunItBack

Owner brief: match Zenon visibly. Adopted:

- Page #f0f0f0 (dark theme: #0c0c0c) with an inline-SVG `feTurbulence` grain layer (data URI, fixed, pointer-events none, 6% opacity, multiply in light, screen in dark).
- Host Grotesk variable (OFL) + Geist Mono variable (OFL), self-hosted in `public/fonts` (licences vendored, see `docs/SUPPLY_CHAIN.md`), loaded only by the landing chunk. Inter stays the editor font.
- 1360 px dashed frames, 20% hairlines, 24 px radius, 999 pills, black pill + orange arrow circle, dashed secondary pill, numbered eyebrows, 60 px H2 / 72 px H1 with the measured tracking, 520 ms `cubic-bezier(0.22,1,0.36,1)` reveals with 105 ms stagger.
- Hero strip of real editor screenshots bleeding off the frame with a bottom blur mask; one black panel (the plan/undo section) for rhythm.
- Left out on purpose: fake logos, ratings, testimonials, pricing tables, case-study metrics, a contact form (no invented social proof; the product is free and local). Where Zenon has stars the page has a truthful trust line.
- From the other templates: Fluence's "prompt box as the hero product" idea informs the bento's "Edit with words" card; Landio's inset top highlight informs the dark panel's edge; Aigent's floating nav is the mobile nav idea.
- Shared tokens and classes live in `src/ui/styles/zenon-tokens.css` so the editor shell can adopt the language later.
