# Design System

Status: current tokens are **confirmed by repository** (`styles.css` `:root`). Semantic tokens, type styles, node/edge encodings, and workspace components are **proposed**.

## Creative thesis

A living digital terrain of inquiry. Three independent layers: **world** (the original grainy dune video, dark violet foreground, lavender-pink horizon), **creature** (the procedural spider), **intelligence layer** (fine strikes, scans, graph links, annotations that respond to real events). Most pixels stay dark. Accent color says what is active, selected, new, or important.

The workspace is quieter than the landing page: a near-black flat surface for precision work. The terrain is used selectively as a transition or edge texture, not behind dense data.

## Color

Current tokens (confirmed):

| Token | Value | Use today |
|---|---|---|
| `--bg` | `#000000` | page fallback |
| `--ink` | `#0d0614` | near-black violet: scrim, panels, spider body |
| `--accent` / `--accent-rgb` | `#e070b0` / `224,112,176` | pink: active nav dot, focus, highlights, strikes |
| `--violet` / `--violet-rgb` | `#8a6bd8` / `138,107,216` | secondary accent: linked nodes, glow |
| `--muted` | `#8e8e8e` | secondary text |
| `--trust-text` | `#c4c2c3` | tertiary text (name is legacy) |
| `--pill-dark` | `#28282a` | burger, mobile sign-in pill |

Legacy tokens still present but unused or misnamed: `--text`, `--nav-text`, `--sign-in-text` (used), `--nav-shadow`, `--trust-bg`, `--trust-border` (used widely as a hairline). Rename in a cleanup pass (proposed; not a Phase 0 change).

Proposed semantic layer (to introduce with the workspace; values to be sampled and tuned in browser against the approved background):

| Semantic token | Role | Starting value |
|---|---|---|
| `bg-0` | page, workspace base | `#0d0614` |
| `bg-1` | deep plum for gradients | sampled from background poster |
| `surface-1` | panels | `rgba(13,6,20,.66)` today (glass); flat `#14091d` proposed for workspace |
| `line-1` | hairlines | `rgba(255,255,255,.14)` |
| `line-accent` | selected, active outline | `--accent` at .28 to 1 |
| `text-1` | primary | near-white `#f1edf6` |
| `text-2` | secondary | `#c4c2c3` |
| `text-3` | metadata | `#8e8e8e` |
| `accent-violet` | linked, secondary | `#8a6bd8` |
| `accent-magenta` | active trace | `#e070b0` |
| `accent-warm` | rare horizon highlight | burnt orange sampled from the horizon (about `#d06040`, unverified) |
| `signal-hot` | contact flash, critical focus only | pink-white `rgb(255,238,250)` |
| `success`, `warning`, `danger` | functional states | to define with contrast tests; current fail tone `rgb(255,100,100)` |

Rules: no bright magenta on whole surfaces. Meaning is never carried by color alone (pair with shape, line style, label). Accessibility contrast for text on the video is a measured concern (see "Contrast" below).

## Typography

Current (confirmed): display `BubbledotICG-FinePos` from `db.onlinewebfonts.com` (a third-party CDN; loaded in the 2026-10-11 session), fallback `Geist Pixel Circle` (local `fonts/GeistPixel-Circle.woff2`, not loaded because the primary loaded), then `monospace`. UI `Inter` 400/500/600 from Google Fonts. Font Awesome 6.5.2 CSS is still linked in `index.html` but no `fa-` icon is used (dead third-party request; cleanup proposed).

Proposed styles:

| Style | Use | Face | Notes |
|---|---|---|---|
| Display | hero headline, section titles | pixel display | brand accent only, never for data; sizes `clamp(30px, 6.9vw, 96px)` hero today; no letter-by-letter effects |
| Page title | workspace title | Inter 600 | in the workspace, avoid pixel face |
| Section title | panel headings | Inter 600 13px | sentence case |
| Body | explanations | Inter 400 15px, line-height 1.55 | measure under 80 characters |
| Metadata | timestamps, chips | Inter 500 12px | |
| Code / address | hashes, addresses, URLs | a monospace face (to choose; not in repo) | always copyable, truncated in the middle with full value on focus |
| Numeric | amounts, values | Inter with tabular figures | right-aligned in tables |
| Status | agent state, badges | Inter 500 11-12px | color plus icon plus text |

Voice: sentence case, plain verbs, specific, no invented numbers, no marketing superlatives. Buttons say exactly what happens ("Start an investigation", "Expand connections"). Errors explain what happened and what to do and do not apologize. Demo wording: "Demonstration data".

## Layout and spacing

- Landing: centered hero (max width 1200 px, headline unmasked per line), content sections max 920 px, glass sections with `backdrop-filter: blur(14px)`.
- Workspace: grid of top bar, left rail, canvas, inspector, timeline per TERMINAL_SPEC.
- 4 px base spacing unit (proposed); breakpoints today: 420, 720, and `max-height: 700`. Proposed workspace breakpoints: 720 (mobile tabs), 1100 (collapse inspector by default).

## Components

Current (implemented): header with brand, quiet glass nav pill, ghost "Open terminal" button; primary CTA (white pill with pink-violet glow); secondary CTA; capability row (`.cap`); section with title mask reveal; steps list with active state; story graph (SVG); status grid; tour status; terminal panels; log; findings; web node; mobile menu sheet.

Proposed (workspace): search/intake field with detected-type chip; scope chips; time-range control; mode badge; agent status pill; filter chips with active count; graph controls; node and edge primitives; inspector sections; provenance item; timeline row; banners (partial, stale, blocked); empty-state block with example button; bottom sheet (mobile).

Guidance: thin borders, open layouts, glass sparingly, panels not cards everywhere, one radius per tier (pill 999, panel 20, small 8).

## Node and edge encoding (proposed)

| Entity kind | Shape | Icon |
|---|---|---|
| Wallet | circle | wallet |
| Token | rounded square | coin |
| Transaction | small diamond | arrow |
| Contract / Protocol | hexagon | brackets |
| Equity / Market event | square | chart |
| Web page / Source | document | page |
| Organization or service | rounded rectangle | building |

| Relationship status | Line style |
|---|---|
| direct observation | solid |
| provider-labeled association | long dash |
| derived | dotted |
| hypothesis | dash-dot, lighter |
| demo | dashed, tagged Demo (current terrain connection paths follow this) |

Direction by arrowhead; direction and amount also in the label. A legend is always available. Selected state: outline plus glow plus label plus inspector open (not color alone). Active direction colors (in/out) must also have shape or marker redundancy; do not copy Arkham's green/red/white scheme as a signature (see REFERENCE_LIBRARY).

## Contrast and legibility

- Measured on 2026-10-11 (ffmpeg luma over the headline zone, assuming a 45% scrim): share of pixels giving white text at least 4.5:1: original 52%, Firefly 83%. The original relies on local treatment: headline text-shadow, a radial dark band behind the subhead, a top-down violet scrim (`.bg::after`), and a scroll dim (`--dim`).
- Rule: essential copy sits on calm or darkened areas. Brightest effects stay away from copy. Verify any new text placement against the actual video, desktop and about 390 px.

## Imagery and iconography

Logo: `assets/logo.svg` (hand-built top-down black widow, pink hourglass). Poster fallback for the background: `assets/reference/background-frame.png` (original) and `assets/background-poster.jpg` (Firefly). No stock imagery. No invented logos for integrations.

## Final visual hierarchy and rules (design review, proposed)

**Hierarchy on the landing hero, in order of attention.** (1) The headline: largest, brightest, still. (2) The primary CTA: the only solid white element with a glow. (3) The spider: the only moving thing after the entrance. (4) Subhead. (5) Secondary CTA and capability row. (6) Navigation: quiet glass. (7) Background: slow, calm. If something outside this order competes, it is wrong.

**Surface rule.** Landing: landscape visible, content on glass or directly on the scrimmed video. Workspace: flat near-black violet surface (`surface-1`), terrain absent, hairlines instead of cards. The two surfaces share tokens and type but not backgrounds.

**Color roles** (area budget is a proposal to verify by sampling): near-black violet carries at least 90% of any screen; pink `--accent` marks "active or attended" and covers at most about 3% of the viewport at any moment; violet `--violet` marks linked or secondary; warm orange appears only if the landscape itself contributes it; pink-white `signal-hot` appears only in contact flashes and a selected node's core. Functional colors (success, warning, danger) are used only in the workspace for status, always with an icon and a label.

**Typography rules.**
- Pixel display face: headline, section titles, empty-state headings only. Never for data, buttons, labels, or any text under 24 px. Tracking: keep the current negative tracking only if dots stay separated; test `-0.02em` against `-0.04em` on the hero at 1440 and 390 px during implementation (unmeasured; the dot-matrix glyphs merge when tracked tight).
- UI face (Inter): everything else. Addresses, hashes, and URLs use a monospace face (to be chosen; none in the repo). One display face and one UI face per screen, plus mono for identifiers.
- Measure: body copy under 80 characters; hero subhead about 52 characters.
- Sizes (current, confirmed): hero headline `clamp(30px, 6.9vw, 96px)`, section titles `clamp(24px, 4vw, 44px)`, subhead 15.5 to 18.5 px, body 14 to 15 px, metadata 11 to 12.5 px. Workspace body is 13 to 14 px; nothing below 11 px.

**Spacing.** 4 px base unit. Landing sections separated by 48 to 96 px (current `clamp(48px, 9vh, 96px)`); panel padding 18 px; workspace gaps 8 to 14 px. Hero must keep the CTA pair above the fold at 1440x800 and 390x760 (verified at 1456x827 and 390x760 on 2026-10-11).

**Contrast.** Rule: essential text meets 4.5:1 (3:1 for large display text) against the worst frame of the video under the scrim, not against the average. Test method: sample luma of the text zone over the whole loop, apply the scrim, compute the ratio; record the number in this document when measured. Last measured (2026-10-11, assumed 45% scrim): original 52% of text-zone pixels reach 4.5:1 without local treatment, hence the headline shadow, the subhead band, and the scroll dim. Re-measure with the real scrim before approving the hero.

**Responsive rules.**
| Range | Landing | Workspace |
|---|---|---|
| 1100 px and up | centered hero, one-line headline lines, 3-column capability row, story graph beside steps | full four-region layout |
| 720 to 1099 | same, 2-column story, nav pill kept | inspector collapses to a drawer; left rail collapsible |
| under 720 | burger nav, stacked sections, graph above steps, spider scale 1.0 and calmer | tab bar: Graph, Activity, Inspector; sheets |
| under 420 | tighter tracking, buttons full width | same, 44 px targets |
| height under 700 | tighter hero spacing (current) | timeline defaults collapsed |

**Selection and attention mark.** Four corner brackets (proposed, DEC-016): used for the spider's attention on landing elements, for the selected node or edge in the workspace, and for the active nav item. One mark, one meaning: "attended here". Replaces the current full rounded-rectangle highlight outline.

## Open design questions

- Monospace face for addresses (none selected).
- Whether the pixel display face may appear in the workspace (default: no).
- Final semantic color values after sampling.
