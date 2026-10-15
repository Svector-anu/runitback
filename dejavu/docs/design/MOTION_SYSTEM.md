# Motion System

Status: current behavior and constants are **confirmed by repository** (verified 2026-10-11). Terminal behavior, mappings marked "proposed", and budgets are **proposed**.

## Principles

1. **Cause and effect.** Every effect answers "what just happened?". The spider activates the world; the world does not animate on its own.
2. **One thing at a time.** Alternate movement with stillness. The headline reveal ends before the spider enters; the background is nearly still while the user reads or works.
3. **Priority of attention:** (1) critical content, (2) the spider, (3) meaningful graph motion, (4) atmosphere, (5) decoration. Lower levels yield to higher ones.
4. **Layers are independent:** background video, terrain light, spider, typography, and UI state never reach into each other. They share only events.
5. **Idle is quiet.** With no interaction, the terrain draws nothing animated and the frame loop stops (verified).
6. **No unbounded accumulation.** Caps on strikes, segments, strands, and links.
7. **Reduced motion is a designed state**, not a disabled one.

## Layer stack (confirmed)

| z | Layer | Source | Animates? |
|---|---|---|---|
| 0 | `.bg` + `<video class="bg-video">` + scrim `::after` + scroll dim `::before` | `js/background.js`, `styles.css` | video loops (original: 10 s, calm); dim changes with scroll |
| 0 (after) | `#terrain-canvas` | `js/terrain/` | only while light exists |
| 1 | `.page` content | `index.html`, `styles.css` | entrance + scroll reveals |
| 5 | `#spider-canvas` | `js/spider/` | continuously while moving |

Canvases have `pointer-events: none` and `aria-hidden="true"`. Verified: clicks and keyboard reach the page.

## Animation inventory (confirmed)

| Animation | Trigger | Meaning | Duration / timing | Reduced motion |
|---|---|---|---|---|
| Header slide-down | load | arrival | 0.7 s | removed |
| Eyebrow wipe | load | first read | 0.8 s, delay 0.1 s | final state |
| Headline line unmask (clipped rise + brief blur resolve) | load | the story is uncovered | 1.0 s each, delays 0.3 s and 0.45 s, ease `cubic-bezier(.16,1,.3,1)` | final state |
| Subhead, buttons, capability row fade-rise | load | follow-up content | 0.8 s, delays 0.85 / 1.05 / 1.3 s | final state |
| Section title unmask, content reveal | scroll into view (IntersectionObserver, once) | new section | 1.1 s mask, 0.9 s content, 110 ms stagger | final state |
| Story graph: nodes fade, edges draw | step reaches mid-screen | the workflow builds | 0.9 s fade, 1.4 s draw | fully drawn |
| Step active highlight | same | current step | 0.6 s | static |
| Scroll dim of the background | scroll (rAF-throttled) | focus shifts to content | continuous, max 0.45 | off |
| Mobile menu overlay, sheet, link stagger | open menu | disclosure | 0.28 / 0.38 s | final state |
| Hover/press on buttons | pointer | affordance | 0.2 to 0.3 s | none |
| Spider locomotion | always (ambient) | presence and attention | see below | static pose, teleport to target |
| Spider silk, highlight outline, connection links | spider touch, link | what it examined | strands 1.8 s, highlight 1.4 s, link 12 s | highlight only, brief |
| Terrain strikes, scans, connection path | foot plant, deliberate arrival, link | contact, inspection, relationship | see terrain section | no strikes or scans; static path only |

Removed in the 2026-10-11 refinement: background parallax, the filament-burst pulse on every touch, the per-element continuous loops.

## Spider (confirmed: `js/spider/`)

**Rendering.** Fixed full-viewport Canvas 2D, DPR capped at 2, coordinates stored in document space and drawn relative to scroll. Legs: 8 legs, 3 bones each (lengths 18, 28, 30, scaled by `SCALE = 1.35`), solved with FABRIK (`ik.js`) with a seeded outward bend. Gait: tetrapod groups; a foot swings when its distance to its ideal rest point exceeds `18 * SCALE`, blocked while the opposite group swings; swing duration 0.08 to 0.22 s. Body: two ellipses plus markings, breathing scale. Lift widens line width during swing.

**Behavior states** (`js/spider/choreography.js`):

| State | Entered when | Behavior |
|---|---|---|
| intro | page load | enters from the left edge after `INTRO_DELAY` 1.3 s, walks to the headline's side, then the CTA's side |
| ambient | after intro | picks a visible target (weighted: headings, steps, CTA higher), walks to its **side** (`EDGE_PAD` 62 px) not over its text, touches it, rests 0.8 to 2 s |
| curious | pointer moves within 520 px, 35% chance, 3.5 s cooldown | follows the pointer for 1.6 to 2.4 s at about 80 px distance |
| startled | pointer down within 200 px | runs about 320 px away at 2.8x speed |
| visiting | story graph step reached | walks (2.2x) to the step's node, touches with scan |
| agent | any `agent.*` event | takes over; queue processes events in order; resumes ambient 0.7 s after `investigation_completed` |
| transition | CTA press | walks to the button, touches with scan, crosses to the center, then the view changes and it walks to the search field |

Scrolling: only `agent.*` events with `initiator: "user"` may scroll the page (`ensureVisible`). Ambient behavior never scrolls.

Constants: cruise speed 150 px/s, turn rate 5.5 rad/s, acceleration 4/s.

**Contact event (confirmed).** `Spider.onFootPlant({x, y, speed})` fires when a swinging leg finishes its swing, with the foot's rendered screen position. This is the gait model's landing event, not physics collision. `Spider.onTouch({x, y, tone, scan})` fires on touch; `Spider.onLink(a, b)` fires on link.

## Terrain light (confirmed: `js/terrain/`)

A separate canvas between video and content. A hand-placed network (about 274 nodes, 385 edges, seven ridge contours plus sparse cross-links) in video space, mapped to the screen with the same cover/`--bg-focus` math as the video. It exists only for `assets/reference/background.mp4` (`BACKGROUND.terrain`).

| State | Trigger | Visual | Meaning | Limits |
|---|---|---|---|---|
| A. Dormant | always | network at alpha 0.025 to 0.1, drawn once | a hidden structure | static |
| B. Foot contact | foot plant within 110 px of a node | tiny pink-white flash + short curved lead to nearest node | the creature touched the terrain | cooldown 0.14 s, 50% of eligible plants, max 3 simultaneous leads; measured about 20% of plants over 14 s |
| C. Movement trail | the strike's head travels | one thin line along the contour, about 7 hops, rare branches (5%), fades by hop distance and age | local activation, no persistence | at most 10 heads, 360 segments |
| D. Investigation | touch with `scan: true` (deliberate arrival: CTA, selected target, finding, story step) | an expanding wave reveals edges within 250 px (360 px for findings) plus a longer two-way strike | the spider examined something | one wave per touch, 1.5 to 2 s |
| E. Connection | `Spider.link(a, b)` | shortest network path between the nodes nearest the two elements stays lit, dashed lavender, end rings | a selected or confirmed relationship; dashed = demo | 14 s, max 4 paths |

Idle: when no light remains, the frame loop stops (verified `raf === 0`).

Important truth rules:
- Terrain strikes are decorative-but-causal: they show contact and attention. They never imply a financial relationship.
- Only state E may relate to data, and only when driven by a domain relationship (proposed binding below). Today `link()` is called by simulated `evidence_linked` events and is rendered dashed (demo). A solid style is reserved for `origin: live` verified relationships and is unused.

## Event mapping (proposed bridge)

Domain events (see TECHNICAL_ARCHITECTURE) map to presentation cues. The current `agent.*` contract is the cue vocabulary.

| Domain event | Cue (`agent.*`) | Spider | Terrain |
|---|---|---|---|
| `input.resolved` | `observing` | walk to the subject node/field, touch | scan (small) |
| `source.requested` | `navigating` | walk to the source/lane node | none |
| `source.observed` | `action_completed` | touch | strike |
| `entity.discovered` | `target_selected` | walk to new node, touch | scan |
| `relationship.discovered` | `finding_discovered` | touch endpoints | scan (large) |
| `relationship.verified` / user selects edge | `evidence_linked` | stand at the midpoint | connection path (state E) |
| `relationship.disputed` | `action_failed` | recoil | fail tone, no path |
| `agent.blocked` / error | `action_failed` | recoil | fail tone |
| `investigation.completed` | `investigation_completed` | return to ambient after 0.7 s | quiet |

Rules: effects trigger only from real or explicitly simulated events; no cue without an event; all demo cues carry demo styling.

## Surface contracts

- **Landing:** current behavior, plus the sequence: background already visible, then eyebrow, headline lines, subhead, buttons, spider enters (about 1.3 s after load, as the headline settles).
- **Workspace (proposed):** spider confined to the canvas region (DEC-009); parks at the canvas edge; moves only to nodes that an event acts on; never crosses the inspector or timeline; terrain light is absent (the workspace uses a flat surface). Graph motion (focus, expand) is the primary motion; the spider follows it. A "calm" control hides the spider and silences strikes. Default off on mobile.

## Choreography (design review, proposed, awaiting owner approval)

Source: Harmonic study in `docs/research/REFERENCE_LIBRARY.md`, plus the measurements in this document. Decisions DEC-014 to DEC-023 in `docs/DECISIONS.md`. Everything in this section is **proposed** unless it says "current".

Design stance: composed over time, not constantly animated. Moments of motion are short and separated by stillness. Atmosphere is slow; type is still once read; the spider and terrain move only for a reason.

### The eight moments

| # | Moment | Trigger | Visual change | Duration | Easing | Layer relationships | Reduced motion |
|---|---|---|---|---|---|---|---|
| 1 | Initial state | document ready | original background visible (poster then video, 0.8 s opacity fade, current), page dark violet, header slides down 0.7 s (current) | 0 to 0.7 s | `ease` / `cubic-bezier(.22,1,.36,1)` | nothing else moves; terrain dormant | poster only, header static |
| 2 | Headline reveal | t = 0.30 s and 0.45 s | each line rises from a clipping mask, 115% to 0, blur 3 px to 0 (current) | 1.0 s per line, 0.15 s stagger | `cubic-bezier(.16,1,.3,1)` | eyebrow wipe finishes first (0.1 s to 0.9 s); spider offscreen | final state |
| 3 | Supporting copy and CTA | 0.85 s subhead, 1.05 s CTA pair, 1.3 s capability row | rise 14 px and fade (current) | 0.8 s each | same ease-out | after the headline is legible; CTA arrives last among primary content | final state |
| 4 | Spider activation | t = 1.3 s (current `INTRO_DELAY`) | spider enters from the left edge, walks to the headline's **side**, touches it, then goes to the CTA's side (current) | about 4 to 7 s | gait-driven | strike layer awake; the first touch produces the first terrain strike; optional headline tear (see below) | no walking; static pose near the CTA |
| 5 | Idle interaction | no input | ambient visits, curiosity, flee (current) | continuous but sparse: rests 0.8 to 2 s per target | gait-driven | terrain only reacts to contacts; text does not move | none |
| 6 | Scroll-driven transition | section enters the viewport / step reaches mid-screen | title unmask, content reveal once, story graph draws, spider visits the matching node (current) | 0.9 to 1.4 s | ease-out | background dim 0 to 0.45 over two viewport heights (current); no parallax | everything final |
| 7 | Investigation activation | click Start an investigation | exit choreography below | 1.2 s | see below | spider leads | cut to workspace, 120 ms fade |
| 8 | Terminal arrival | route change | workspace regions appear in order: top bar, left rail, canvas, inspector placeholder | 0.8 s total | ease-out, 60 ms stagger | spider arrives at the search field; terrain is not drawn behind the workspace | regions appear at once |

Stillness rule: after moment 3 finishes (about 2.2 s), nothing in the text layer moves again until a user event or scroll.

### Headline and text motion (specific, not generic)

| Element | Entrance | Exit | Notes |
|---|---|---|---|
| Eyebrow | left-to-right clip wipe, 0.8 s, 0.1 s delay (current) | fades with the page | single line, accent-tinted |
| Hero headline lines | clipped vertical rise per line, blur resolve, 1.0 s, stagger 0.15 s (current) | reverse: each line rises out of the mask, 0.45 s, stagger 0.06 s, last line first | no per-character or per-word motion; lines are the unit because the pixel display face is hard to read when characters move independently |
| Subhead, CTA pair, capability row | 14 px rise and fade, 0.8 s, staggered (current) | fade 0.3 s | never blur |
| Section headings | same clipped rise as the headline, triggered once by IntersectionObserver (current) | none | one per section |
| Body and list content | rise 22 px and fade, 0.9 s, 110 ms stagger, once (current) | none | cap the stagger at 5 items |
| Graph nodes (workspace) | fade and scale 0.9 to 1, 240 ms, ease-out; new neighbors emerge from the parent position, 40 ms stagger capped at 8 | fade 160 ms | at rest nothing animates |
| Graph edges (workspace) | stroke draws from source to target, 400 ms, ease-out | fade 160 ms | direction visible while drawing |
| Selection mark | four corner brackets snap onto the element, 120 ms | brackets retract 120 ms | the same mark the spider uses to show attention (DEC-016) |
| Investigation status message | old text fades out 100 ms, new text rises 4 px and fades in 160 ms; at most one status change per 400 ms | | single line in the run-state chip; no typing effect |
| Activity log row | appears with a 180 ms fade, no movement | | log is functional, not decorative |
| Finding row | 240 ms fade plus a thin underline draw (accent), once | | demo findings carry the Demo tag from the first frame |

Optional text event (DEC-015, proposed): a **contact tear**. When the spider touches the headline (moment 4 only, once per page load), the headline shows a single 0.4 s clip-path slice flicker in two tinted layers (accent pink and violet, not cyan and green), then returns to still. This borrows Harmonic's principle (long stillness, one brief tear) but ties the tear to a cause. It must never run on a timer. Reduced motion: none.

### Exit choreography when the user starts an investigation

1. t = 0: click; if the CTA is off-screen the page scrolls it into view (at most 0.6 s).
2. 0 to 0.6 s: the spider walks to the CTA's side (speed 2x) and touches it with a scan (terrain wave and a strike).
3. 0.6 to 1.0 s: headline lines rise out through their masks; other content fades 0.3 s; the background dims toward the workspace surface.
4. 0.6 to 1.4 s: the spider crosses to the viewport center.
5. 1.4 s: route changes to `#/investigate`; the workspace regions arrive (moment 8) while the spider walks to the search field; the first status reads Resolving only after a subject is submitted (the landing CTA does not submit anything).
Total about 2.2 s from click to a usable workspace. The sequence is skippable: any key press or click during it completes it immediately.

### Guided tour ("Watch the spider work")

Stays on the landing page. The simulated events (labeled Simulated) scroll the page (initiator `user`), the spider visits each step, and connection paths light dashed. At the end the status line says what the tour was and offers "Open this demo in the workspace" (proposed). Terrain strikes follow the same rules as everywhere else; the tour uses the same effects at the same strengths.

### Resting state (everything finished)

Headline, copy and buttons still and fully legible. Background video looping slowly (original: nearly still). Terrain dormant (barely visible filaments). The spider parked or slowly visiting content sides, never over text. No lit paths older than 14 s. No pulsing, no looping text effect. Quiet is the intended default.

### Spider boundaries

- **Landing:** scale 1.35 at 720 px and wider, 1.0 below (proposed; current is 1.35 everywhere). Parks at the side of targets (current, 62 px). Ambient walking avoids crossing the headline text rectangle: paths route around it where possible (proposed no-walk zone; today it can cross). It never stops on text or on a control. It never scrolls the page without a user-initiated journey (current).
- **Workspace:** see `docs/product/TERMINAL_SPEC.md` ("Spider and Calm control").

### Terrain strength budget

| Event | Strength | Visible |
|---|---|---|
| foot plant (about 1 in 5) | flash 0.24 s, strike about 7 hops | under 1 s |
| touch without scan | one strike, 9 hops | under 1 s |
| scan (deliberate arrival) | wave 250 px for 1.5 s plus a two-way 16-hop strike | about 2 s |
| finding | wave 360 px for 2 s, 22-hop strike | about 2 s |
| connection | path stays lit 14 s, dashed when demo | 14 s then fades over 2 s |
Only the last row is persistent. No relationship is illuminated unless an event names it. An unverified relationship never uses the solid style (see `docs/architecture/DATA_MODEL_AND_PROVENANCE.md`, "Verified").

## Reduced motion

Source of truth is `matchMedia('(prefers-reduced-motion: reduce)')`, read once in `main.js` and mirrored by a CSS media block.

| Element | Reduced form |
|---|---|
| Entrance and reveals | final state immediately |
| Spider | no ambient or intro walking; static pose; on events it jumps to the target and highlights (outline for 1.4 s) |
| Silk, trail | none |
| Terrain | dormant network only; no strikes or scans; connection path appears without animation |
| Background | poster image only (video removed) |
| Parallax / dim | none |
| Scroll | smooth scrolling off |
| Story graph | fully drawn |

Gaps: the choice is read once (no live `change` listener), there is no in-page toggle, and the reduced path was verified by code path and unit-style checks, not by an actual system setting. Proposed: add a `change` listener and a visible Calm control.

## Performance

Confirmed constraints in code: `requestAnimationFrame` only; DPR capped at 2; canvases resized on `resize`; terrain stops when idle; reveals use one IntersectionObserver per call and unobserve after first intersect; transforms and opacity for CSS motion.

Measured 2026-10-11 in the controlled Chrome tab (1470x779 CSS px, DPR 2, spider ambient): about 30 frames per second over 6 s with a longest frame of 35 ms, heap about 116 MB. This tab was driven by browser automation, so absolute numbers may understate real hardware. Treat as a **baseline to re-measure** with DevTools Performance, not a pass or fail.

Known costs and fixes (from MDN guidance, see REFERENCE_LIBRARY):
- `shadowBlur` is used 3 times in `js/spider/spider.js` (strands, links, highlights) and 4 times in `js/terrain/terrain.js` (paths, heads). MDN advises avoiding it; replace with pre-rendered glow sprites.
- Spider legs are stroked per bone per pass (48 strokes per frame); batch into fewer paths.
- The animation loop does not pause on `visibilitychange` (rAF pauses in background tabs by itself in browsers, but timers in the choreography continue).
- Background video: original 13.9 MB; the Firefly export 30.1 MB; the loop re-encode 7.9 MB.

Proposed budgets (to confirm by measurement): spider update + draw under 4 ms per frame on a mid-range laptop; terrain draw under 2 ms while active; no layout reads inside the animation loop except cached target rects; video under 15 MB.

## Known issues (confirmed or reproduced)

1. Any external call to `spider.cancelGoal()` that is not through `choreography.begin()` ends the ambient loop permanently (the cancellation rejection is swallowed). Reproduced during testing. Fix: make the ambient loop resilient.
2. The terrain network is aligned to an average frame; the video's dunes drift slightly, so strikes can sit a few pixels off the ridge.
3. At 390 px width the spider (scale 1.35) covers a large share of the viewport and passes over copy while walking. Proposed: smaller scale below 720 px.
4. The network lives only in the dune half; feet in the sky do nothing (intended).
5. The connection path is under the page content, so it is hidden behind opaque panels in the workspace.

## Verification checklist for any motion change

Desktop and 390 px; headline readable; spider never parked on text or controls; console clean; idle terrain draws nothing; reduced motion path; cap checks (strikes, segments); frame time sampled; docs updated.
