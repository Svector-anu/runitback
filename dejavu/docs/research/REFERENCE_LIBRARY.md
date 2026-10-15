# Reference Library

Status: research notes, fetched 2026-10-11. Each entry separates **observed** (what the source says or shows) from **inference** (our reading), then states the principle, the OpenCrawl decision it informs, and what must not be copied.

Method and limits: pages were read through a fetch tool that returns a model-summarised version of the page, so wording is not verbatim. No images, GIFs, or videos could be viewed in the web references (alt text and filenames only). Vendor marketing claims are listed as claims, not facts. The WebCrawlerMY source was cloned and read directly. Screen recordings were inspected by sampling frames. Not read: Motion `useScroll` and GSAP ScrollTrigger (named in the master brief, not needed while the stack stays vanilla).

---

## 1. GMUNK, TRON: Ares, Computer Vision
URL: https://gmunk.com/TRON-Ares-Computer-Vision (read 2026-10-11)

**Observed.** GMUNK Studio, October 2025, a team of about 20 artists, 60+ shots. The concept is the world seen through machine perception: the system tracks many events, predicts trajectories, measures distance, and re-evaluates continuously; density is framed as the result of awareness rather than decoration. Described behaviors: networked elements (point clouds, fine fibrous linework, reactive data), scanning and tracking over live plates, hard structures dissolving into point fields, scan pulses crossing a lattice, and a pulsing countdown that reacts to its surroundings. Process described: study each plate for composition, depth and story; run it through custom square-packing into a hierarchical cell grid; choose points of interest by asking what a character needs to understand; then attach trackers, measurements, code, and data. Work is additive: scan, track, connect, populate, animate; large structures set the architecture and small details add texture; the goal is cause and effect (the world changes, the system perceives, the interface responds). Not on the page: palette, typography, timings, the algorithm details, media captions.

**Principles (inference).** Density must be earned by something the system knows. Hierarchy by scale. Annotate only where the viewer needs to understand something. Order effects as scan, track, connect.

**OpenCrawl decisions.** Terrain light stays dormant until the spider touches something (terrain state A to E in MOTION_SYSTEM). Annotation appears only at points the investigation acted on. The effect order scan, then strike, then connection mirrors scan, track, connect.

**Do not copy.** Countdown motif, derezz language and effects, the square-packing cell-grid look, Ares or Athena imagery, the lattice scan over live-action plates.

## 2. GMUNK, TRON: Legacy
URL: https://gmunk.com/TRON-Legacy (read 2026-10-11)

**Observed.** 2010, with Digital Domain, 12+ minutes of holographic graphics. Sequences described: Solar Sailor (organic forms under a structural rulebook; influences named include Haeckel, fractals, hex meshes, Voronoi, isometric surfaces), Throne Room (data packets forming concentric rings from a defrag diagram), Disc Game (a 2D texture library on proxy geometry in 30+ shots; a bracket scoreboard; custom tools named "Tronlines" and an "Egyptian" linework algorithm), Board Room (live-playable asset libraries), Rectifier Globe (prototyped in openFrameworks, ported to Houdini, simplified for a fast read), Arena Fireworks (14 designs saved as XML presets), Portal Climax (concept work stated as not used in the film), Opening Titles (kept clean to avoid dating). The master brief notes a dense globe sequence was simplified because too much detail confused the read; the fetched summary supports "simplified for a fast read".

**Principles (inference).** A strict rulebook with organic variation. Prototype in code, then simplify for readability. Presets and libraries make a system reusable. Restraint ages better. Familiar metaphors keep abstract motion meaningful.

**OpenCrawl decisions.** The terrain graph is a rule-based network (contours plus sparse cross-links) with variation in strikes. Effect parameters live in named constants (a motion token system, see MOTION_SYSTEM). Prefer sparse linework to effect overload.

**Do not copy.** The globe, concentric-ring extraction look, bracket scoreboard, de-rezz or Tronlines linework, light-wall city wireframe, light-cycle and disc motifs, the TRON grid and glow aesthetic.

## 2b. GMUNK, TRON: Opening Titles
URL: https://gmunk.com/TRON-Opening-Titles (read 2026-10-12 through the fetch tool; page text only)

**Observed.** Dated November 2010. GMUNK (Bradley G. Munkowitz) led a Digital Domain team. Director's brief (Joseph Kosinski): evoke the original light-bike battle, let light-walls evolve gradually into more complex multi-dimensional patterns, and reveal a city wireframe that flows into a skyline. The linework was drawn flat in Illustrator, given depth in Maya, and each path was animated by hand. The design follows a strict grid framework. Animation was synced to the voiceover. The director kept the sequence clean because he feared an overly detailed sequence would date quickly; a 3D grid structure and a blanket of data point clouds were explored and rejected. Tools named: Illustrator, Maya, Cinema 4D with MoGraph, V-Ray. Not on the page: typography, any statement about type pacing, specs, or timings.

**Principles (inference).** One line vocabulary with complexity added in steps toward a single reveal. Restraint chosen deliberately. A hidden grid keeps complexity ordered. Hand-authored connections beat scattered particles. A flat line with modest depth is enough.

**OpenCrawl decisions.** One vocabulary of thin lines (dormant network, strikes, scans, connection paths); complexity escalates with event importance (foot contact, then scan, then confirmed relationship). The terrain network is a hand-placed rule-based grid of ridges, not random lines. The pacing of linework follows real events rather than a timer. No point clouds or particle blankets.

**Do not copy.** TRON visuals (neon cyan or orange, light-walls, city wireframe, holographic look), any recreation of the sequence, the voiceover-driven structure. Do not attribute type or pacing rules to GMUNK: the page states none.

## 3. Chainalysis Reactor
URL: https://www.chainalysis.com/product/reactor/ (read 2026-10-11)

**Observed (page text).** Traces funds from first deposit to final cash-out; the page cites 27+ chains, 40M+ assets, 300+ bridges and DEXs including mixers (vendor claims). Swaps, bridges, mixers, and complex contract activity are auto-interpreted into human-readable steps. Customizable layouts and annotations; off-chain context (entities, communication channels, documents) can be attached to subjects and services. Alerts hand off with risk score and context; integrations named include Cellebrite, Siren, i2. Findings can be shared for briefings or court; no export formats named. Attribution sources named: vetted blockchain data, OSINT, proprietary datasets, AI insights; the FAQ mentions clustering and "ground-truth attributions". Screenshot alt text names an investigations UI, an entity profiler, a graph close-up, a zoomed-out graph of thousands of nodes, and a transaction-interpretation overlay (not viewable).

**Not on the page:** node and edge encodings, relationship types, expand and trace mechanics, labeling workflow, time filter, confidence or provenance per label, limitations, empty or error states.

**Marketing claims (not verified):** "most accurate in the industry", "$34B+ frozen and recovered", graphs "load in seconds and update in real-time", a rating figure.

**Principles (inference).** A trace-oriented graph needs human-readable interpretation of multi-hop activity. Analyst context (annotations, documents) is a separate layer from machine attribution.

**OpenCrawl decisions.** Inspector separates provider/machine claims from user notes (data model: `provider_labeled` vs `user_note`). The timeline summarizes steps in plain language instead of raw logs.

**Do not copy or claim.** Their branding, label datasets and counts, accuracy or recovery claims, court-grade or ground-truth framing, integrations and compliance features we do not have.

## 4. Arkham Visualizer
URL: https://codex.arkm.com/the-intelligence-platform/visualizer (read 2026-10-11; most concrete UI documentation of the three)

**Observed.** Top-left search adds addresses or entities to the graph. A "More Info" button opens a filter panel that works like the profiler's transaction log. A bottom time-filter bar sets the range and shows transaction volume. Clicking a transaction opens an info panel on the left. Nodes are addresses or entities; edges are transactions. Edge colors: white for internal transactions between selected entities, green for inflow, red for outflow. Interactions: drag nodes; an expand cursor or the E key splits an entity into addresses; hovering an edge shows total value; clicking an edge opens the transaction panel; clicking the date opens a block explorer; filters by time, token value, or USD value and by token or amount. **Stated limit:** by default only the most recent 1,000 transactions are shown. Not covered: tracing, clustering, labeling, alerts, export, confidence, provenance, error states.

**Principles (inference).** The filtered edge set should drive both canvas and lists. Always disclose truncation. A bottom time bar doubling as a filter is learnable. Colors alone are not enough.

**OpenCrawl decisions.** Filters apply to the canonical edge set. A "showing N of M" banner whenever results are capped (TERMINAL_SPEC partial state). Keyboard expand (`E`) and edge hover preview. Redundant encodings (arrowheads, line styles) beside any color.

**Do not copy.** The green/red/white scheme as a signature look, the layout, branding, label data.

## 5. Nansen Profiler 101
URL: https://academy.nansen.ai/en/help/articles/0002013-nansen-profiler-101 (read 2026-10-11)

**Observed.** No standard landing page; three search-driven modes: Profiler (address overview, counterparties, transactions, profit and loss), Wallet Profiler for Token (balance history, entry and exit points, trading patterns, transfers, position changes), and Wallet Pair Profiler (two addresses in; direct and indirect transactions, shared counterparties, network relationships, volume, common tokens, interaction frequency). Entity types named: whales, funds, influencers. A claim of 500M+ labeled addresses (unverified) with nothing on how labels are assigned. Not covered: graph encodings, filters, time controls, export, alerts, limitations, states.

**Principles (inference).** Search-led entry with no mandatory dashboard. A two-subject mode answers "how are A and B connected" directly and can be a summary, not only a drawn graph.

**OpenCrawl decisions.** Intake is a single search field (TERMINAL_SPEC). A pair mode is a planned later slice, not in slice 1.

**Do not copy or claim.** Coverage numbers, label counts, brand.

**Gap all three vendors leave open (design opportunity, our recommendation, not something they demonstrated):** none of the pages documents per-label or per-edge confidence or provenance, nor stale and conflicting states. OpenCrawl's data model makes source, method, time, and status first-class on every claim.

## 6. WebCrawlerMY (procedural spider)
URL: https://github.com/felixyu9722/WebCrawlerMY (cloned and read 2026-10-11; read-only in a temp directory)

**Observed.** One 217 KB `index.html` with all JS and CSS inline in a single IIFE; no build, no dependencies; one external request (Google Fonts). README states "License: MIT" and credits the concept to @rybinfx, but **no LICENSE file exists**, so the licence is unbacked. Rendering: one fullscreen 2D canvas sized to the window, no devicePixelRatio handling, no layered canvases, full redraw each frame. 36 uses of `shadowBlur`. Legs: 8 legs with an analytic two-bone law-of-cosines IK (`solve2SegmentIK`), not FABRIK. Gait: two alternating groups switching every few ticks; stepping is frame-count based, not time-based. DOM targeting: `querySelectorAll('.crawled-target')` with `getBoundingClientRect`, refreshed every 45 frames. It toggles classes on DOM nodes to show scanning and auto-scrolls the page with `window.scrollBy`. No public events or hooks, no `prefers-reduced-motion`, no IntersectionObserver, no pause when hidden.

**Principles (inference).** The idea (a spider that scans real page elements) is sound; the implementation is a feature reference, not an engineering model.

**OpenCrawl decisions.** Keep our own FABRIK 3-bone solver and time-based gait; keep the foot-plant hook; invalidate target rects on scroll and resize instead of polling; avoid per-frame `shadowBlur`; never auto-scroll without a user-initiated journey (already enforced).

**Do not copy.** Any source code (no verifiable licence), scroll hijacking, global audio, the identity of the creature or its overlays.

## 7. Motion: scroll animations (React docs)
URL: https://motion.dev/docs/react-scroll-animations (read 2026-10-11)

**Observed.** Separates scroll-triggered (`whileInView`, `viewport={{ once: true }}`, `useInView`, backed by a pooled IntersectionObserver) from scroll-linked (`useScroll` returning progress values with `target` and `offset`, `useTransform`, `useSpring`, parallax, clip-path reveals, sticky horizontal scroll). States scroll-linked animation uses the native ScrollTimeline when available with a JS fallback. All APIs are React; Ticker is paid. No reduced-motion guidance on the page.

**Principles.** Use each kind where it adds meaning; one pooled observer; unobserve after first intersect; drive scroll-linked values from one scroll read.

**OpenCrawl decisions.** Already followed in `js/motion.js` (IntersectionObserver reveals with unobserve; one rAF-throttled scroll listener for the dim). Parallax was removed after testing (DEC-002 context). CSS `animation-timeline: scroll()/view()` is a possible later progressive enhancement; browser support was not verified.

**Do not adopt.** The library or its React hooks (stack decision DEC-003).

## 8. MDN, Optimizing canvas
URL: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas (read 2026-10-11)

**Observed.** Pre-render repeated primitives to an offscreen canvas; avoid fractional coordinates for `drawImage`; avoid scaling in `drawImage`; layer stacked canvases by update rate; CSS backgrounds for large static content; scale with CSS transforms; `alpha: false` for opaque canvases; HiDPI by setting backing size from `devicePixelRatio` and CSS size separately; also batch calls, avoid state changes, redraw only differences, avoid `shadowBlur` and text, use `requestAnimationFrame`.

**OpenCrawl decisions.** Already layered (terrain vs spider canvases) and DPR-aware (capped at 2). Planned: replace `shadowBlur` with pre-rendered glow sprites; batch leg strokes; draw the dormant terrain from an offscreen canvas (already done). `alpha: false` is not applicable to transparent overlays.

## 9. MDN, prefers-reduced-motion
URL: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion (read 2026-10-11; the last part of the page was not read)

**Observed.** Values `no-preference` and `reduce`; widely available; aims to remove or replace motion (scaling, zooming, panning are vestibular triggers); the example replaces a scale pulse with an opacity dissolve; JavaScript reads `matchMedia` and can listen for `change`; test with OS settings or Firefox `ui.prefersReducedMotion`. Our summary added: keep the reduced experience complete and consider an in-page control (partly the summariser's inference).

**OpenCrawl decisions.** Reduced motion is a designed state (MOTION_SYSTEM matrix). Add a live `change` listener and a visible Calm control (currently missing). Replace motion with opacity or instant state, not removal of function.

## 10. MDN, Animation performance and frame rate
URL: https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Animation_performance_and_frame_rate (read 2026-10-11)

**Observed.** Prefer CSS animations; aim for steady 60 fps (about 16.7 ms per frame including scripts, style, layout, paint); avoid animating layout-triggering properties; `transform` and `opacity` composite without repaint; script-driven animation (canvas, JS) costs CPU even with small bandwidth; measure with DevTools. The page does not discuss `requestAnimationFrame` or `will-change`.

**OpenCrawl decisions.** CSS reveals animate only transform, opacity, clip-path, and filter on short elements; canvas budgets are defined and must be measured (MOTION_SYSTEM). No fixed FPS promise until measured.

---

## Additional references

### A. Harmonic: motion study (https://www.harmonic.fun/)

Studied 2026-10-12 in three ways: the supplied screen recordings (frames sampled at 4 fps over whole clips, then 20 fps around a page load), the live site in Chrome (computed styles, `document.getAnimations()`, keyframe rules, screenshots), and the page's own CSS. Recordings are at `assets/reference/Screen Recording 2026-10-11 at 12.22.33 PM.mov` (Harmonic, 23.7 s) and on the owner's Desktop (`12.21.51 PM` Harmonic, 14.5 s; `12.20.34 PM` the OpenCrawl page, 13.2 s).

**Important: the recordings and the live site are different versions.** The recordings show the older home page; the live site today is a different home page. Both are described below and labeled.

#### Observed: live site, 2026-10-12 (viewport 1456x835, DPR 2)
- One non-scrolling scene: the home section is `h-dvh` and the document height equals the viewport height. Scrolling does nothing.
- Centered stack: nav (HOME, NEWS, ABOUT, CAREERS, and a white square-cornered CTA) at the top; H1; a subtitle; a white CTA; then the graphic; footer text bottom-left; social icons bottom-right.
- Headline: `<h1>` set in JetBrains Mono, weight 400, 45 px, line-height 56.25 px (1.25), letter-spacing normal, no text-transform, centered, one line at this width, white. Subtitle ("Reasoning you can verify"): 26 px, letter-spacing 0.26 px (0.01 em), same family. Body family is the same monospace throughout: a single type voice.
- **Headline motion technique (read from CSS):** the H1 contains `span.hero-subtitle-glitch` with a `data-text` attribute. Its `::before` (color `rgb(41,194,255)`) and `::after` (color `rgb(0,255,65)`) pseudo-elements duplicate the text. Animation `harmonicSubtitleGlitch`, 3.9 s, infinite, linear: opacity 0 from 0 to 78 % of the cycle, then from about 79 % to about 90 % a burst of `clip-path: inset(...)` slices with `translate` of roughly plus or minus 3 to 5 px, then back to 0. A second animation `harmonicSubtitleJitter` (3.9 s, infinite) runs on the element. Net effect: the headline is perfectly still for about 3 s of every 3.9 s, then a roughly half-second tear. No mask-rise, no per-word or per-character movement, no scale or blur on the text.
- Graphic: two full-viewport canvases (backing size 2940 x 1670), one named `hero-torus-canvas`, drawing a dotted torus/ellipse structure. Entrance `hero-media-reveal` is 600 ms, 80 ms delay, linear, one iteration. The graphic keeps moving slowly: two screenshots taken seconds apart show different ring tilt.
- Background: blue-to-white vertical gradient, heavy film grain, and a very faint tiled repetition of the headline text (a texture, not content). Corner bracket ticks at the four viewport corners and small edge ticks at mid-sides; the active nav item is framed by corner brackets.
- The site is a Next.js application (`/_next/static/...`).

#### Observed: recordings (older Harmonic home and other pages)
- `12.21.51` (14.5 s): headline "BUILDING THE WORLD'S MOST ADVANCED REASONING ENGINE" in uppercase monospace, left-aligned in the right half; a large ring graphic on the left that slowly changes tilt over the whole clip (the ring appears to precess; cause, time-based or pointer or scroll, is not determinable from video). A dated list of milestones (year label at left, uppercase title). As the pointer moves over an item, that item expands in place with a short description and a LEARN MORE button, and neighbors shift to make room. Around 4 s a seventh item (MATHEMATICIAN RESEARCH SPONSORSHIPS ANNOUNCED) is present at the top where there were six earlier, i.e. the list changes during the clip.
- `12.22.33` (23.7 s): nav to CAREERS and NEWS. Between pages there is a light screen with a small spinner and the word LOADING for about 0.4 to 0.5 s (about t = 14.0 to 14.4 s), then the next page. At 20 fps around t = 14.2 to 15.6 s the new page's headline ("THE FUTURE OF INTELLIGENCE IS VERIFIED") and CTA are present **fully formed in the first content frame**, with no partial reveal in the following 8 frames. Wave-line background is static or nearly so. The NEWSROOM page is a light, conventional layout (a different mood from the dark-blue pages).
- The OpenCrawl recording (`12.20.34`) shows the page after the entrance has finished: headline still, the spider walking, terrain light along ridges.

#### Not determined (limitations)
- The first-load entrance of the live home page could not be captured: screenshots lag the page by about a second, and the 600 ms graphic reveal and any text entrance are over by then. Only the CSS-declared 600 ms media reveal is known.
- The tail of the glitch keyframes was truncated in extraction; timings after about 86 % are inferred from the pattern.
- Mobile behavior was not inspected: browser window resize did not change the viewport in this session.
- Whether the torus is driven by time, pointer, or both was not isolated.
- The live site differs from the recordings, so the list-expansion and scroll-linked ideas seen in the recordings could not be re-verified live.

#### Interpretation (not observed)
- Harmonic's hierarchy comes from stillness and a single voice, not from entrance choreography: one monospace face, a short stack, a calm graphic that does the atmospheric work, and one brief periodic tear on the headline.
- The framing details (corner brackets, edge ticks, bracketed active nav item) read as "targeting" or "instrument" cues and make the page feel like a viewfinder.
- Page changes use a visible loading beat, then the page appears whole; there is no staggered per-element entrance observed.

#### What OpenCrawl borrows
1. **Stillness as the default:** headline and copy are fully still after a short entrance; any recurring text effect is rare (see decision DEC-015).
2. **One brief tear, not a loop of entrances:** motion on type is a rare event, not decoration. For us the trigger is the spider's contact (cause and effect), not a timer.
3. **Bracketed framing for attention:** corner brackets as the target-lock mark when the spider or an investigation attends to an element (DEC-016).
4. **A graphic reveal that is plain and quick:** 600 ms linear class of reveal for atmospheric layers; no theatrical entrance for the landscape.
5. **A single type voice per surface:** pixel display for the brand moment, one UI face for data; do not mix more.
6. **Visible loading beat between views** when work happens (our terminal arrival uses a short status line, not a spinner theatre).

#### What stays original and must not be copied
Harmonic's blue palette, torus/ring graphic, tiled text pattern as a signature, cyan and green glitch colors, JetBrains Mono as our brand voice, the exact bracket-frame composition, copy, and layout. OpenCrawl keeps the dark grainy landscape, the spider, terrain strikes, and the workspace.

### B. @rybinfx crawling-spider clip
File: `KAW8qq-EfhNOR8AM.mp4` (1440x1440, 60 fps, 16.7 s, with audio). Shows a spider with cyan lines crawling over a page of references. Authorship and licence are unverified (the identification comes from the owner's briefs and the WebCrawlerMY README). Used as inspiration only.

### C. Own measurements
Background comparison and baseline measurements are in `docs/DECISIONS.md` (DEC-002) and `docs/design/MOTION_SYSTEM.md`.
