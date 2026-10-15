# Handoff

Read `CLAUDE.md` and `docs/DECISIONS.md` first. The canonical documents are in `docs/`:
- product and journey: `docs/product/PRODUCT_BRIEF.md`, `EXPERIENCE_MAP.md`
- terminal wireframes, interactions, states, spider and Calm: `docs/product/TERMINAL_SPEC.md` (section 8)
- hero choreography and text motion: `docs/design/MOTION_SYSTEM.md` ("Choreography")
- visual hierarchy, type, color, responsive rules: `docs/design/DESIGN_SYSTEM.md`
- architecture and its reconciliation with the design: `docs/architecture/TECHNICAL_ARCHITECTURE.md` (section 4); data model, Verified rule: `DATA_MODEL_AND_PROVENANCE.md`
- slices in dependency order with acceptance criteria: `docs/roadmap/IMPLEMENTATION_ROADMAP.md`
- Harmonic study and other references: `docs/research/REFERENCE_LIBRARY.md`

Status: the workspace (slices S1 to S3 plus the controller, bridge, and Calm) shipped on 2026-10-12. Approvals and what is still proposed are in `docs/DECISIONS.md` ("Approvals and build status").

## What this is
OpenCrawl landing page plus investigation terminal. Static HTML, CSS and vanilla ES modules, no build step. The looping CloudFront video background and the dot-matrix display type are kept from the original page.

## Run
`python3 serve.py` from this folder (a no-cache static server; plain `http.server` caches edited modules), then open http://localhost:3003/. The workspace is `#/investigate`. Checks: `node tests/model.check.mjs`.

## Layout
- `index.html`, `styles.css`, `main.js`: page, styles and entry point.
- `js/spider/ik.js`: FABRIK solver.
- `js/spider/spider.js`: canvas renderer, steering, tetrapod gait, silk, highlights, links.
- `js/spider/targets.js`: DOM target discovery and resolution. Positions come from live bounding rects.
- `js/spider/events.js`: agent event contract and bus (JSDoc at the top of the file).
- `js/spider/choreography.js`: intro, ambient wandering, pointer and click reactions, agent-event handling, landing-to-terminal transition.
- `js/investigation.js` and `js/simulation.js`: cue store and the guided landing tour (demo-only).
- `js/model/`, `js/investigation/`, `js/workspace/`: the investigation workspace (canonical demo model and Verified rule, controller and domain events, SVG graph and inspector). Details in `docs/product/TERMINAL_SPEC.md` section 9.
- `js/router.js`, `js/preferences.js`: hash router and the Calm preference.

## Background
One setting controls it: `BACKGROUND` in `js/background.js` (`enabled`, `video`, `poster`). It currently uses the original video, `assets/reference/background.mp4`, with `assets/reference/background-frame.png` as the poster. After side-by-side testing, the original composes better: the calm sky and dark dunes leave the headline and spider as the focus. The Firefly alternative is `public/opencrawl-background-loop.mp4` (seamless-loop version of the Firefly video) with `assets/background-poster.jpg`. To switch, change `video` and `poster`. Set `enabled: false` for plain black. Mobile cropping uses `--bg-focus` in `styles.css`.

## Motion
- Hero entrance (CSS only, ~2.8s): eyebrow wipe, headline lines unmask upward (`.line` clips `.line-inner`), subhead, buttons, capability row. The spider enters after the headline settles (`INTRO_DELAY` in `js/spider/choreography.js`).
- `js/motion.js`: scroll reveals (`[data-reveal]`), a gentle scroll dim (`--dim` on `.bg`, no parallax), and the story graph that follows the "How it works" steps. Each step wakes nodes and edges (`data-from`) and sends the spider to a node (`choreography.visit`).
- The spider parks beside elements (`EDGE_PAD` in `js/spider/targets.js`) instead of on top of text. The spider is rendered at `SCALE = 1.35` in `js/spider/spider.js`.
- Reduced motion: no entrance, no parallax, no spider travel, graph fully drawn.

## Terrain light layer
`js/terrain/` draws a separate canvas (`#terrain-canvas`) between the background video and the page content. It is driven by the spider, never baked into a video.
- `contours.js` holds hand-placed ridge curves in video space (1920x1080), matched to the original `assets/reference/background.mp4` through the same `object-fit: cover` and `--bg-focus` mapping the video uses. `graph.js` turns them into a network of nodes and edges (contours plus a few curved cross-links). If you swap in a different background, set `BACKGROUND.terrain` to `false` in `js/background.js`, or redraw the contours.
- Contact: `Spider.onFootPlant` fires from the gait code when a swinging leg finishes its swing, with the foot's rendered screen position. This is the gait model's landing event, not physics-engine collision. About 1 in 5 plants produces a strike (cooldown, a cap of 3 at once, and a 110px reach to the nearest node).
- Strike: a short lead from the foot to the nearest node, then a light head travels along the contour (about 7 hops, rare branches) and fades. Dormant filaments are drawn once at very low alpha.
- Investigation: `Spider.touch(..., { scan: true })` fires `onTouch`, which triggers a local expanding wave plus a longer two-way strike. Findings are larger than selections.
- Connection: `Spider.link(a, b)` fires `onLink`, which finds the shortest path along the network between the nearest nodes to the two elements and keeps it lit for 14s as a dashed lavender line. Dashed marks demo data. A real relationship would use a solid line (`demo: false`), which nothing sets yet.
- Idle: the frame loop stops when no light remains. Reduced motion: no strikes, scans or waves; only the static network and connection paths.

## Market terminal
The workspace opens on a real market chart (`#/investigate`, Market view; Network view is the address graph). `js/market/binance.js` reads Binance public candles and tickers (DEC-029); `market.js` holds state, history paging, polling and `market.*` domain events; `detect.js` computes derived events (DEC-032); `chart.js` is the canvas chart and owns the markers; `chart-light.js` draws strikes along the real close path; `market-cues.js` maps market events to spider cues (DEC-031); `market-view.js` wires the DOM. Typing a symbol such as BTC or ETH opens it; a Bitcoin address switches to Network. Checks: `node tests/market.check.mjs`. Built and unit-tested in a session where the browser extension was not connected: the page itself had not been looked at when this was written, so verify it in Chrome first.

## Live data
Paste a Bitcoin address in the workspace (for example `1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa`). `js/investigation/bitcoin-adapter.js` reads it from the public Blockstream API (no key, no backend), `controller.js` builds the live graph, and relationships can be Verified (rules: `docs/architecture/DATA_MODEL_AND_PROVENANCE.md`, DEC-019, DEC-027, DEC-028). Turn it off with `BITCOIN.enabled = false`. Tests run offline with a stubbed `fetch`.

## Brand kit
`assets/brand/`: `opencrawl-icon.svg` (dark app tile, used as the favicon) with PNGs `icon-1024/512/192/32.png` and `apple-touch-icon.png`; `opencrawl-badge.svg` (white circle, as in the header); `opencrawl-mark-light.svg` and `opencrawl-mark-dark.svg`; `opencrawl-banner-preview.jpg`. Banner (1500x500) and social card (1200x630) sources are in `assets/brand/src/`; `assets/brand/render.sh` renders them to PNG with headless Chrome (not run in the build session). Reports are in `docs/reports/`.

## Agent integration
`window.OpenCrawl.dispatch(event)` accepts any event built with `createEvent` from `js/spider/events.js`. A real agent only needs to emit events with `target.id` matching a `data-spider-id` in the page. Only events with `initiator: "user"` may scroll the page. No real agent is connected. The `src/app/agent` code in the surrounding `oss` repo belongs to a different product and was not wired in.

## Status
- Verified in Chrome: spider appears on load and walks with stepping legs, intro and ambient wandering, guided tour with page scroll, CTA transition into the terminal, simulated run (log, findings, links, failures), 390px layout (checked via iframe), reduced-motion path (teleport, render loop stops).
- Not verified: click-to-flee and cursor-following by hand, real touch devices, Safari and Firefox.
- No market data, charts, wallet data or agent exist. Everything in simulated runs is labeled as demonstration data.
- `assets/logo.svg` is the spider logo (hand-built SVG).
- The header "Sign in" pill became "Open terminal" because there is no auth.
- `KAW8qq-EfhNOR8AM.mp4` in this folder is not part of the page. It looks like the @rybinfx reference clip.
- Not committed. This folder sits inside the `oss` repo, which has many unrelated uncommitted changes.
