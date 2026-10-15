# Build Report: what shipped

Project: OpenCrawl (`/Users/mac/Desktop/coding/oss/dejavu`). Period: 2026-10-04 to 2026-10-12. Written 2026-10-12.

## Summary

A static, dependency-free web app (HTML, CSS, vanilla ES modules): a cinematic landing page with a living procedural spider, a terrain light layer that reacts to the spider, a guided demo tour, a brand kit, and an investigation workspace (graph, filters, findings, inspector, timeline, provenance, recent leads) running on a clearly labeled demo dataset. No live data and no real agent are connected.

Size: about 5,700 lines of code (index.html, styles.css, main.js, serve.py, js/, tests/) and about 1,800 lines of documentation. Zero third-party dependencies. Git: nothing committed; the folder sits inside the unrelated `oss` (RunItBack) repo.

## 1. Landing page (implemented)

| Piece | What it does | Files |
|---|---|---|
| Hero | eyebrow wipe, masked line-by-line headline, subhead, CTAs, capability row, about 2.2 s total | `index.html`, `styles.css` |
| Sections | How it works (5 steps plus a story graph that builds on scroll), What works today (honest status), final CTA | same, `js/motion.js` |
| Navigation | quiet glass pill, mobile burger sheet, scroll anchors | same, `main.js` |
| Copy | no invented metrics or social proof; says what is real, demo, and not connected | `index.html` |
| Background | original grainy dune video, poster fallback, one-line config, Firefly alternative kept | `js/background.js` |
| Brand | spider logo (SVG), badge and light/dark marks, banner and OG sources | `assets/logo.svg`, `assets/brand/` |
| Type | pixel display face for brand moments, Inter for UI | `styles.css` |

## 2. Procedural spider (implemented)

Canvas 2D, FABRIK three-bone legs, tetrapod gait, silk, trail, bracket-style highlights, scale 1.35. Behaviors: intro walk after the headline, ambient wandering (parks beside elements, not on text), curiosity toward the cursor, flee from nearby clicks, visits matching story-graph nodes while scrolling, takes over for events (`agent.*` cues), leads the transition into the workspace. Real gait events are exposed (`onFootPlant`, `onTouch`, `onLink`). Files: `js/spider/` (about 1,100 lines).

## 3. Terrain light layer (implemented, original background only)

A hand-placed ridge network (about 274 nodes, 385 edges) mapped to the video with the same cover math. Foot contact produces a short strike along a ridge; deliberate arrival produces a scan wave; a link lights a dashed demo path for 14 s. It idles to zero cost and is off in the workspace. Files: `js/terrain/`.

## 4. Investigation workspace (implemented, demo-only)

| Piece | Detail | Files |
|---|---|---|
| Canonical model | entities, relationships, observations, sources, ids; `demo-v1` dataset (13 entities, 15 relationships, mixed statuses, one conflict, one stale item, one unavailable attribute) | `js/model/` |
| Verified rule | pure function; strict (live, direct, primary source, fresh, no conflict); demo can never verify | `js/model/queries.js` |
| Domain events and controller | open, expand (capped, banner), select, reset; reducer from events | `js/investigation/` |
| Motion bridge | domain events to spider cues, bounded queue | `js/investigation/motion-bridge.js` |
| Graph canvas | SVG, select node and edge with corner brackets, expand, fit, root, zoom, pan, list view, labels scale with zoom | `js/workspace/graph-view.js` |
| Inspector | entity and relationship views, provenance details, conflicts, not-verified verdict, "not scored" confidence | `js/workspace/inspector.js` |
| Intake | detected-type chip, open demo, honest "Not supported yet" for anything else | `js/investigation/demo-adapter.js` |
| Calm | spider confined to the canvas, parked, auto-yields, toggle `C`, persisted, default on for phones and reduced motion | `main.js`, `js/preferences.js` |
| Mobile | Graph, Activity, Inspector tabs; inspector bottom sheet | `styles.css` |

## 5. Documentation (implemented)

Root `CLAUDE.md` (rules for every future session), `HANDOFF.md`, `docs/` with product brief, experience map, terminal spec with annotated wireframes, design system, motion system with the choreography, technical architecture, data model with the Verified definition, roadmap in dependency order, reference library (Harmonic study, GMUNK x4, Chainalysis, Arkham, Nansen, WebCrawlerMY, MDN, Motion), and 26 logged decisions.

## 6. Tooling

`serve.py` no-cache dev server; `tests/model.check.mjs` (11 checks, built-in `node:assert`); `assets/brand/render.sh` brand renderer (run by hand).

## 7. Naming and repo

Product name is OpenCrawl (owner decision, DEC-001). A misread briefly switched it to OpiumCrawl and was reverted. Old briefs and the Firefly exports keep their file names.

## 8. Added in the final pass (2026-10-12)

| Piece | Detail | Files |
|---|---|---|
| Filters | connection type and status chips, active count, Clear all; excluded edges, nodes, findings and list rows are dimmed (never deleted) | `js/workspace/workspace.js`, `graph-view.js` |
| Findings | ordered list of connections found, with status and Demo tags, click selects | `workspace.js` |
| Bottom timeline | one-line summary, expands to the event list; key `T` | `index.html`, `workspace.js` |
| Disambiguation | "Which did you mean?" when text matches several demo items; nothing is fetched until the user picks | `js/investigation/demo-adapter.js`, `controller.js`, `reducer.js` |
| Recent | last five leads, reopen with one click, stored locally | `js/investigation/recents.js` |
| Landing polish | corner-bracket attention mark replaces outlines; spider scale 1.0 below 720 px; headline exits through its mask on Start; whole sequence skippable by any key or click, capped at about 3 s | `js/spider/spider.js`, `choreography.js`, `styles.css` |
| Reduced motion | page reloads into the right mode when the system setting changes | `main.js` |
| Cleanup | unused Font Awesome stylesheet removed; favicon, Apple touch icon, theme color and social tags added | `index.html` |
| Brand kit | spider badge, light and dark marks, dark app icon (SVG and PNG at 1024, 512, 192, 180, 32), banner and social-card sources, banner preview image, `render.sh` to re-render the banner and social card with Chrome | `assets/brand/` |
| Tests | 14 checks (added ambiguity and Recent) | `tests/model.check.mjs` |

## 9. Completed under "finish all" (2026-10-12)

| Piece | Detail | Files |
|---|---|---|
| Live data, first vertical | Bitcoin mainnet addresses via the public Blockstream API: recent transactions, counterparties, balance, expansion, links to each transaction | `js/investigation/bitcoin-adapter.js`, `controller.js` |
| Verified, live | strict rule applied to real data; pending transactions never verify; Verified chip, white edge, and a legend entry | `js/model/queries.js`, `workspace.js`, `graph-view.js`, `inspector.js` |
| Honest origin everywhere | Live or Demo badge, chips, labels, and aria text follow each record's origin | `workspace.js`, `inspector.js` |
| Layout for unknown graphs | ring placement with collision avoidance for nodes without a hand-placed position | `js/workspace/graph-view.js` |
| Failure handling | provider failure shows an error banner and leaves the graph unchanged | `controller.js`, `reducer.js` |
| Contact tear | one-time headline slice flicker on the spider's first touch (pink and violet) | `styles.css`, `choreography.js` |
| Walk-around zone | spider routes around the headline with a sticky waypoint | `js/spider/spider.js`, `main.js` |
| Regression fixed | page load no longer cancels the spider's intro walk | `js/spider/choreography.js` |
| Accessibility | skip link, mobile legend, Live and Demo in element labels | `index.html`, `styles.css`, `graph-view.js` |
| Brand finals | banner (1456x485) and social card (1200x630) PNGs captured from the real rendering | `assets/brand/opencrawl-banner.png`, `opencrawl-og.png` |
| Tests | 19 checks, including the Bitcoin adapter, Verified on live data, and the live flow against a stubbed network | `tests/model.check.mjs` |

## 10. Market terminal (2026-10-15)

| Piece | Detail | Files |
|---|---|---|
| Real market data | Binance public candles, 24h ticker, ten-symbol watchlist; polling live updates with backoff; history paging to 5000 bars; impossible candles refused | `js/market/binance.js`, `series.js`, `market.js` |
| Interactive chart | canvas candles or line, volume, UTC axes, crosshair readout, wheel zoom, drag pan, pinch, keyboard, forming candle, table view | `js/market/chart.js` |
| Derived events | volume spike, large move, range breakout or breakdown, loaded high and low; each labeled Derived with its rule and inputs | `js/market/detect.js` |
| Spider bound to the chart | markers placed from candle time and price are the spider's targets; strikes run along the real close path; linked events light the path between two bars | `chart.js`, `chart-light.js`, `market-cues.js`, `js/spider/*` (small hooks) |
| Workspace | Market view is the default; Network view keeps the address graph; inspector shows bar or event provenance with a link to the raw provider record | `market-view.js`, `market-inspector.js`, `index.html`, `styles.css` |
| Tests | 23 checks in `tests/market.check.mjs` (adapter, series, detection, controller with a stubbed network) | `tests/market.check.mjs` |

Decisions: DEC-029 to DEC-032. Not yet looked at in a browser (the extension was not connected); see the QA report.

## 11. Not built yet

Scope and time controls (no data to scope yet); other chains, equities, and web sources; a real agent; a backend for sources that need API keys; moving the project to its own repository; committing; a screen-reader pass; Safari, Firefox, and real-phone testing.
