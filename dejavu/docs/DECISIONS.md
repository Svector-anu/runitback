# Decisions

The decision log for OpenCrawl. **Read this first.** Every substantive change in product identity, stack, scope, data semantics, or motion principles needs an entry here before or with the code.

Source documents: `OPIUMCRAWL_MASTER_DESIGN_BRIEF.md` (baseline brief) and `OPIUMCRAWL_CLAUDE_BOOTSTRAP_PROMPT.md` at the project root were split into the `docs/` set and `CLAUDE.md` during Phase 0. They are kept unchanged for history; the `docs/` set is now authoritative and wins on any difference.

Status vocabulary:
- **confirmed by repository**: true of the code or assets as inspected on 2026-10-11.
- **confirmed by owner**: the owner said so explicitly in a task, with the date.
- **proposed**: recommended by Phase 0 design work; not yet approved. Do not treat as implemented.
- **requires owner approval**: a real fork where the default below is only a recommendation.

Capability vocabulary used across docs: `implemented`, `partial`, `planned`, `demo-only`.

---

## DEC-001: Product name
- Date: 2026-10-12
- Status: **confirmed by owner**
- Context: Early briefs, the master brief, and the Firefly export filenames use "OpiumCrawl". On 2026-10-11 the owner instructed "name is opencrawl, change it now" and the UI was switched to "OpenCrawl". A later message ("opium crawal is what i will use") was read as OpiumCrawl and the UI was briefly switched back; the owner then clarified they meant **OpenCrawl**.
- Decision: the product name is **OpenCrawl** (wordmark `OPENCRAWL`). The UI, page title, logo label, copy, `window.OpenCrawl`, `HANDOFF.md`, `CLAUDE.md`, and the docs use it. Existing media and brief files keep their original names (`OPIUMCRAWL_*.md`, the Firefly exports, `public/opencrawl-background-loop.mp4`), per the no-rename rule.
- Alternatives: OpiumCrawl (the name in earlier briefs); a codename/public-name split.
- Consequences: any future name change is a decision entry first; when a name message is ambiguous, ask which spelling before changing the UI.
- Affected: `index.html`, `main.js`, `assets/logo.svg`, `HANDOFF.md`, `CLAUDE.md`, all docs.

## DEC-002: Background asset
- Date: 2026-10-11
- Status: **confirmed by owner** (preference) and **confirmed by repository** (evidence)
- Context: Original background `assets/reference/background.mp4` versus Adobe Firefly export `public/Firefly ... OpiumCrawl w copy.mp4` and its seamless-loop re-encode `public/opencrawl-background-loop.mp4`.
- Evidence: measured on 2026-10-11 with ffmpeg: Firefly motion (mean frame difference) about 3.45 versus 0.30 for the original, about 10x; original seam SSIM 0.87 versus Firefly 0.28 (a visible loop jump; fixed in the re-encode); Firefly 30.1 MB versus original 13.9 MB. The Firefly video has its luminous veins baked in, which cannot react to the spider and competes with the typography and spider. Contrast behind the headline zone was higher for Firefly (83% of pixels at or above 4.5:1 under a 45% scrim versus 52%), but the original won in the actual page because its calm sky and dark dunes make the headline and spider the focus.
- Decision: the **original** is the active background (`BACKGROUND.video` in `js/background.js`). The Firefly files stay as unused alternatives.
- Consequences: the terrain light layer (`js/terrain/`) is calibrated to the original only. Switching background requires `BACKGROUND.terrain = false` or redrawn contours.
- Affected: `js/background.js`, `js/terrain/contours.js`.

## DEC-003: Stack stays vanilla HTML, CSS, ES modules
- Date: 2026-10-11
- Status: **confirmed by repository**; keeping it for the next slices is **proposed**
- Context: no `package.json`, no bundler, no framework, no tests. Served statically (`python3 -m http.server 3003`). ES modules loaded directly by the browser.
- Decision (proposed): keep vanilla ES modules through Phase 2. Introduce a build step or framework only if Phase 2 reveals a concrete need (for example graph rendering at a size SVG cannot handle, or a backend proxy requiring a toolchain).
- Alternatives: React/Vite or similar now; Web Components.
- Consequences: no new dependencies in Phase 0 or Phase 1. Tests will need a minimal runner decision (DEC-012).

## DEC-004: Two event vocabularies, layered
- Date: 2026-10-11
- Status: **proposed**
- Context: the repository already has a presentation-oriented contract `agent.*` (9 types in `js/spider/events.js`) used by the spider and the investigation store. The master brief proposes domain events (`entity.discovered`, `relationship.verified`, ...).
- Decision: keep both, layered. Domain events are canonical and come from the investigation controller. A motion bridge maps domain events to `agent.*` presentation cues that the spider and terrain consume. UI state derives from domain events and the canonical graph, never from presentation cues. See `docs/architecture/TECHNICAL_ARCHITECTURE.md`.
- Alternatives: one flat vocabulary; rename `agent.*`.

## DEC-005: Demo data is always labeled and deterministic
- Date: 2026-10-11
- Status: **proposed** (matches current behavior in `js/simulation.js`)
- Decision: every entity, relationship, and event carries `origin: "demo" | "live"`. Demo data uses obviously fictional identifiers and a fixed seed. UI shows a persistent Demo badge. Live adapters never write `origin: "demo"` and the demo adapter never writes `live`.

## DEC-006: Terminal is a visual workbench, not a CLI
- Date: 2026-10-11
- Status: **proposed**
- Decision: top bar with search, left activity and filters rail, central graph canvas, right inspector, collapsible bottom timeline. See `docs/product/TERMINAL_SPEC.md`.
- Alternatives: command-line style prompt; wizard flow.

## DEC-007: First graph renderer
- Date: 2026-10-11
- Status: **requires owner approval**
- Default: hand-written SVG with a deterministic precomputed layout for the demo dataset (up to about 150 nodes). No new dependency, DOM nodes are focusable, and selection and accessibility come for free. Revisit a Canvas or WebGL library (candidates not evaluated in Phase 0: Cytoscape.js, Sigma.js, d3-force with Canvas) when live data or size demands it.
- Trade-off: SVG scales poorly past a few hundred nodes; a library adds weight and an integration surface.

## DEC-008: Live data needs a server-side component
- Date: 2026-10-11
- Status: **requires owner approval**
- Context: the project is fully static. Provider API keys must never reach the browser, and many providers block browser origins.
- Default: Phase 4 adds a thin backend-for-frontend (one small service) that holds credentials, calls providers, normalizes to the canonical model, and streams domain events. Until then the UI is demo-only and says so.
- Alternatives: bring-your-own-key stored locally (acceptable only for low-risk keys); public providers called directly from the browser where CORS allows.

## DEC-009: Spider scope per surface
- Date: 2026-10-11
- Status: **proposed**
- Decision: the landing page spider keeps today's full behavior. In the terminal, the spider is calmer: it is anchored to the canvas and graph edges, travels only to nodes the investigation acts on, never crosses the inspector or timeline, and has a visible "calm" toggle. See `docs/design/MOTION_SYSTEM.md`.

## DEC-010: Repository placement
- Date: 2026-10-11
- Status: **requires owner approval**
- Context: this project lives in `/Users/mac/Desktop/coding/oss/dejavu/`, inside a git repository whose remote is `runitback` (a different product, with its own `CLAUDE.md`, pnpm toolchain, and many unrelated uncommitted changes). Nothing here is committed.
- Default: move the project to its own repository before the first commit. Until then, do not stage unrelated paths and do not run the parent's commands.
- Consequences: `CLAUDE.md` in this folder explicitly scopes itself away from the parent's.

## DEC-011: Persistence
- Date: 2026-10-11
- Status: **proposed**
- Decision: first slice has no persistence beyond the current page session. Recent-session state in `sessionStorage` or `localStorage` is a later, small, separate slice. Saved investigations and sharing are deferred.

## DEC-012: Test and check tooling
- Date: 2026-10-11
- Status: **requires owner approval**
- Context: there is no build, lint, or test tooling. Phase 0 baseline checks were `node --check` per module and manual browser verification.
- Default: before Phase 2, add the smallest runnable checks: a Node-based test for pure model and reducer code (no DOM), and a scripted browser smoke test. Choose tools then; do not install anything in Phase 0.

## DEC-013: Confidence scores
- Date: 2026-10-11
- Status: **proposed**
- Decision: no numeric confidence or risk score is shown until a documented method exists. Relationship `status` (direct, provider-labeled, derived, hypothesis, demo) carries meaning instead.

---

# Design review decisions (2026-10-12)

All **proposed** unless stated. Evidence: `docs/research/REFERENCE_LIBRARY.md` (Harmonic motion study, GMUNK), `docs/design/MOTION_SYSTEM.md` (choreography), `docs/product/TERMINAL_SPEC.md` section 8.

## DEC-014: Hero typography
- Context: Harmonic uses one monospace voice at 45 px and a centered stack. OpenCrawl's pixel display headline is the brand moment.
- Decision: keep the pixel display face for the headline and section titles only; UI face for everything else; mono for identifiers. Test tracking `-0.02em` against `-0.04em` at 1440 and 390 px during implementation (dot-matrix glyphs can merge when tracked tight). No per-character or per-word motion.
- Alternatives: switch the hero to a monospace like Harmonic (loses the brand), or enlarge the pixel face further (readability risk).
- Status: proposed.

## DEC-015: Headline motion and the "contact tear"
- Observed: Harmonic's headline is still about 3 s of every 3.9 s, then has a roughly half-second clip-path glitch loop. No mask-rise.
- Decision: keep the clipped line-by-line reveal (current). Never loop an effect on type. Optional, once per page load: a 0.4 s tear on the headline when the spider first touches it (accent pink and violet layers). Everything else on type is still.
- Alternatives: no tear at all (simplest); a periodic glitch like Harmonic (rejected: violates "quiet at rest").
- Status: proposed; the optional tear **requires owner approval**.

## DEC-016: One attention mark, corner brackets
- Decision: replace the rounded-rectangle highlight with four corner brackets everywhere: spider attention on landing, selected node or edge in the workspace, active nav item. One mark, one meaning: "attended here".
- Alternatives: keep outlines; use glow only (fails the not-color-alone rule).
- Status: proposed (inspired by Harmonic's bracket framing; not a copy of its layout).

## DEC-017: Landing spider boundaries
- Decision: scale 1.35 at 720 px and wider, 1.0 below; ambient paths route around the headline text rectangle (no-walk zone); parking beside targets (current); never scroll without a user-initiated journey (current).
- Alternatives: leave as is (spider crosses text and is large on phones).
- Status: proposed.

## DEC-018: Workspace spider and Calm control
- Decision: spider clipped to the graph region at 1.0 scale, moves only for event-targeted nodes, auto-yields (35% opacity, holds) during direct manipulation and 4 s after, no terrain light behind the workspace. Top-bar toggle `Spider: On / Calm`, key `C`, persisted per viewer, default Calm for reduced motion and viewports under 720 px.
- Alternatives: no spider in the workspace; same behavior as landing (rejected: costs usability).
- Status: proposed; refines DEC-009.

## DEC-019: Definition of Verified
- Decision: computed, strict (live origin, direct primary record, resolvable fresh source, no conflict). Rules in `docs/architecture/DATA_MODEL_AND_PROVENANCE.md`. Only verified relationships use the solid style and the Verified chip. Demo data can never be verified.
- Status: proposed; **requires owner approval** because it constrains what live adapters can claim.

## DEC-020: Data pace is decoupled from animation pace
- Context: the current simulation waits for the spider between events.
- Decision: the controller emits at data speed; the motion bridge keeps a bounded cue queue and drops older ambient cues when more than 6 are pending; the demo adapter may opt into paced playback.
- Status: proposed.

## DEC-021: Start-an-investigation exit choreography
- Decision: about 2.2 s: spider scan on the CTA, headline lines exit through their masks, spider crosses, route change at 1.4 s, workspace regions arrive in order. Skippable by any key or click. Starting does not submit a lead.
- Alternatives: instant route change with a short fade; a full-screen wipe (rejected: theatrical).
- Status: proposed.

## DEC-022: Landing composition vs Harmonic's single scene
- Observed: Harmonic's home is one non-scrolling scene.
- Decision: keep a scrolling landing page (explanation and honesty about status are part of the product) but treat the hero as one composed scene; the rest of the page is revealed once and then still.
- Status: proposed.

## DEC-023: Returning to a prior investigation
- Decision: keep a Recent list of five entries storing `{input, adapterId, datasetVersion, createdAt}` in `localStorage`. Demo investigations are rebuilt deterministically by replay. Live investigations cannot be restored this way; storing observations is deferred.
- Alternatives: persist full event logs now; no recents.
- Status: proposed; refines DEC-011.

## Unresolved questions (owner)

1. ~~Product name~~ settled: OpenCrawl (DEC-001, 2026-10-12).
2. Is the optional contact tear approved (DEC-015)?
3. Approve the strict definition of Verified (DEC-019)?
4. First live vertical and provider (data model open questions).
5. Whether the workspace spider is on by default on desktop (recommended: on, Calm one keypress away).
6. Whether to move the project to its own repository before the first commit (DEC-010).


---

# Approvals and build status (2026-10-12)

The owner said "keep shipping" and asked why the terminal had not been built, after the design review. I treated my recommended defaults for the terminal as approved so slices S1 to S3 could ship. Recorded here so nothing is implicit:

| Decision | Status now | Notes |
|---|---|---|
| DEC-001 name | **confirmed by owner: OpenCrawl** | (see its entry) |
| DEC-003 stack | accepted | still vanilla ES modules, no dependency added |
| DEC-004 two vocabularies | **accepted, implemented** | domain events in `js/spider/events.js` (`DOMAIN_EVENT_TYPES`), cues stay `agent.*`, bridge in `js/investigation/motion-bridge.js` |
| DEC-005 demo labeled | **accepted, implemented** | every entity, relationship, and chip says Demo |
| DEC-006 visual workbench | **accepted, partly implemented** | see `docs/product/TERMINAL_SPEC.md` section 9 |
| DEC-007 renderer | **accepted: hand-written SVG** | `js/workspace/graph-view.js` |
| DEC-009 / DEC-018 workspace spider | **accepted, partly implemented** | clipped to the canvas, parked, event-driven only, auto-yield, Calm toggle (`C`), persisted; default Calm under 720 px or reduced motion |
| DEC-011 persistence | unchanged | none yet |
| DEC-012 tooling | **accepted** | plain Node scripts using `node:assert`, no install: `node tests/model.check.mjs` (11 checks) |
| DEC-016 bracket mark | **accepted for the workspace, implemented**; landing part still proposed | selected node and edge get corner brackets |
| DEC-019 Verified | **accepted, implemented as a pure function** | `verification()` in `js/model/queries.js`, covered by tests; nothing live exists, so nothing is ever verified |
| DEC-020 data pace vs animation | **accepted, implemented** | controller emits at data speed; the bridge drops ambient cues when more than 6 are pending |
| DEC-016 bracket mark (landing) | **implemented** | spider highlights are now corner brackets |
| DEC-017 spider boundaries | partly implemented | scale 1.0 below 720 px done; the walk-around-the-headline zone is not built |
| DEC-021 exit choreography | **implemented** | headline exits through masks; skippable; capped at about 3 s |
| DEC-023 Recent | **implemented (demo)** | five leads in `localStorage`, replayed on click |
| DEC-015 contact tear | **implemented** | one 0.4 s slice flicker on the first spider touch of the headline, pink and violet, never on a timer, off in reduced motion |
| DEC-017 walk-around zone | **implemented, imperfect** | spider detours around the headline; measured 1.8 to 2.8 s of a 20 s window still inside it, mostly while leaving |
| DEC-008 backend | **not needed for the first live source** | Blockstream is called directly from the browser (DEC-027); a backend is still required for any source with an API key |
| DEC-010 repo, DEC-014, DEC-022 | still proposed or requiring approval | not built |

## DEC-024: Dev server without caching
- Status: accepted, implemented.
- Context: browsers cached edited ES modules from `python3 -m http.server`, so changes seemed missing or half-loaded.
- Decision: `serve.py` (Python standard library) serves the same files with `Cache-Control: no-store`. Run `python3 serve.py` from the project folder (port 3003, 127.0.0.1).

## DEC-025: The workspace hides the landscape
- Status: accepted, implemented.
- Decision: in the workspace the background, its video, and the terrain canvas are not displayed and the video is paused. The surface is flat near-black violet (DESIGN_SYSTEM). Returning to the landing page restores and resumes them.

## DEC-026: Intake honesty
- Status: accepted, implemented.
- Decision: input that the demo dataset cannot resolve shows "Not supported yet" and an Open the demo action. It never runs a fake investigation on arbitrary text (this replaces the earlier behavior where any text started a canned run).

## DEC-027: First live source is Bitcoin mainnet via Blockstream
- Date: 2026-10-12
- Status: accepted (owner said "finish all"; reversible with one setting), implemented.
- Context: the roadmap needed one real vertical. A keyless, CORS-open, public source exists for Bitcoin addresses: the Blockstream Esplora API (`https://blockstream.info/api`). No backend is required.
- Decision: pasting a Bitcoin address in the workspace reads that address's recent transactions and builds a live graph. `BITCOIN.enabled` in `js/investigation/bitcoin-adapter.js` turns it off (then only the demo is available). The adapter is pure for normalization (`normalizeAddress`) and takes an injectable `fetch` so tests run offline.
- Privacy and trust: the visitor's browser sends the pasted public address to blockstream.info (their IP is visible to that host). Nothing else is sent. No key or secret is involved. This is a third-party network call and is recorded here per the project rules.
- Consequences: any other chain or provider with credentials still needs the backend (DEC-008).

## DEC-028: What a live relationship means
- Date: 2026-10-12
- Status: accepted, implemented.
- Decision: a Bitcoin relationship is type `interacts_with`, status `direct`, directed from an input address to an output address of one transaction, with the output value as the amount (BTC). It claims only "these two addresses appear in the same transaction", which is a direct chain observation. It does **not** claim that one party paid the other (multi-input transactions make that undeterminable). Several transactions between the same pair are merged into one relationship with all observations attached.
- Verified: such a relationship is Verified (DEC-019) only if at least one of its observations is from a confirmed transaction fetched within the last hour. Unconfirmed transactions are recorded as partial and never verify.
- Consequences: the UI shows Live, Verified, and a link to the transaction for every connection; a connection backed only by pending transactions says "Not verified: there is no confirmed primary record".

## DEC-029: Market data source is Binance Spot public market data
- Date: 2026-10-15
- Status: accepted (owner asked for a real market terminal backed by a real market-data API), implemented, reversible with `BINANCE.enabled` in `js/market/binance.js`.
- Context: the owner wants the primary surface to be an interactive chart on real data. A keyless, CORS-open source is needed so no backend or secret is required. `https://data-api.binance.vision/api/v3` (klines, 24h ticker) answered with `access-control-allow-origin: *` from a plain request. Coinbase Exchange and Kraken were unreachable from the build machine, so they were not used.
- Decision: candles (`/klines`), the 24h ticker (`/ticker/24hr`) and a fixed ten-symbol watchlist come straight from the browser. Live updates are polling (every 5 s, backoff on failure, paused when the tab is hidden), not a WebSocket. The data is spot USDT pairs only.
- Privacy and trust: the visitor's browser sends the chosen symbol and interval to the provider (their IP is visible to that host). Nothing else is sent. No key or secret is involved. This is a third-party network call recorded per project rules.
- Integrity rules: the provider's numbers are drawn as received. A response with impossible candles (high below low, non-positive prices, out-of-order times) is refused and nothing is drawn. Provider failure shows an error or a "Live updates are paused" banner and the age of the data; no fallback or invented data exists. Every bar links to its raw provider record.
- Consequences: only crypto spot markets exist; equities and derivatives need other adapters. Rate limits and uptime belong to the provider.

## DEC-030: The chart is hand-written canvas, no dependency
- Date: 2026-10-15
- Status: accepted, implemented (`js/market/chart.js`).
- Decision: candles or line, volume, price and time axes (UTC), crosshair readout, wheel zoom, drag pan, pinch, keyboard control, live forming candle, on-demand history paging when panned left (up to 5000 bars), and a table view as the accessible alternative. Layout is time-based, so real gaps in the data stay visible. No charting library is added.

## DEC-031: The spider is bound to chart coordinates through markers
- Date: 2026-10-15
- Status: accepted, implemented (`js/market/chart.js` markers, `market-cues.js`, `chart-light.js`).
- Decision: every data point the spider can act on is a small DOM marker whose position is computed from the candle's own time and price (`data-spider-id="mk:<candle open time>"`). The existing event contract is unchanged: domain events `market.*` become `agent.*` cues through the motion bridge, and cue targets are derived only from real candle times. The spider walks to the marker (stand-off `data-spider-pad`), brackets it, and its touch (`spider.onTouch`, now carrying the target element) starts a light strike at that bar. The strike runs along the actual close-price path of neighbouring bars; a scan draws that bar's price level and time; linking two markers (an event and the bar that set the level it broke) lights the real close path between them.
- Integrity rule: data renders immediately and never waits for the animation. The spider never moves, adds, hides or changes a data point; markers read the chart's transform every frame, so panning or zooming moves them with the data. Calm and reduced motion remove the creature and the light but never the markers, selection or readouts. Terrain light stays landing-only (DEC-025).

## DEC-032: Market events are derived, fixed-rule observations
- Date: 2026-10-15
- Status: accepted, implemented and tested (`js/market/detect.js`, `tests/market.check.mjs`).
- Decision: from closed candles only: volume at least 3x the previous 20-bar average; a close-to-close log return at least 3 standard deviations (previous 50 bars); a close beyond the previous 30-bar high or low on the first bar of a run (linked to the bar that set the level); highest and lowest price among loaded bars. Each event is labeled Derived, shows its rule and the numbers used, and says it is not a provider statement or a recommendation. On open, the spider walks to the four strongest events inside the visible range, replayed in time order; live events found later are announced the same way.
