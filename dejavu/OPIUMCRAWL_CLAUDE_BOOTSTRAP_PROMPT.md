# Claude Code Bootstrap Prompt — OpiumCrawl Design Lock

Paste the entire prompt below into Claude Code at the root of the existing OpiumCrawl repository.

---

You are the principal product designer, creative technologist, and software architect helping establish OpiumCrawl's design and technical source of truth. We are planning the full product—including the landing page, procedural spider, motion system, investigation terminal, data model, and architecture—before major coding begins.

## Non-negotiable instruction

**Do not begin implementation of product features in this task.** This is Phase 0: inspect, research, specify, map, and document. You may create or update documentation and small static diagrams/mockups if the existing tools support them, but do not rewrite application code, change behavior, rename/move/delete assets, or install dependencies. The user wants to review the plan before coding the actual architecture and terminal.

## Begin with the existing project

1. Read `HANDOFF.md` if present, the existing `CLAUDE.md`, the project README/package/config, and all relevant docs.
2. Inspect the whole project tree, routes/entry points, `index.html`, `main.js`, `styles.css`, assets, background videos, spider implementation, and existing interactions. Do not assume a framework; verify the real stack.
3. Play/inspect relevant media where possible and distinguish the original background from the Adobe Firefly export(s). Identify them by contents and metadata; do not rename or move anything.
4. Run the current app and baseline checks if doing so is safe. Record what works, what is broken, and what cannot be verified.
5. Inspect the user-provided screen-recording references if accessible in this session/repository. If unavailable, say so rather than pretending to have inspected them.

## Research — read original sources

Browse and inspect, not merely list, these references:
- GMUNK, TRON: Ares Computer Vision: https://gmunk.com/TRON-Ares-Computer-Vision
- GMUNK, TRON: Legacy: https://gmunk.com/TRON-Legacy
- Chainalysis Reactor: https://www.chainalysis.com/product/reactor/
- Arkham Visualizer: https://codex.arkm.com/the-intelligence-platform/visualizer
- Nansen Profiler: https://academy.nansen.ai/en/help/articles/0002013-nansen-profiler-101
- WebCrawlerMY procedural spider: https://github.com/felixyu9722/WebCrawlerMY
- Motion scroll animations: https://motion.dev/docs/react-scroll-animations
- MDN Canvas optimization: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas
- MDN reduced motion: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion
- MDN animation performance: https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Animation_performance_and_frame_rate

Add other strong references only where they materially help. For every reference, write: what was actually observed, the useful principle, the specific OpiumCrawl decision it informs, and what must not be copied. Do not confuse a reference's marketing claims with independent verification.

## Product interpretation

Baseline positioning to validate:

“OpiumCrawl is an interactive intelligence and investigation workspace that helps people follow relationships between financial assets, wallets, transactions, and information found across the web. A procedural spider gives the system a visible presence and helps make the act of investigation understandable.”

Design thesis:
- World: restrained dark, grainy, violet/indigo terrain with a lavender-pink and restrained warm horizon.
- Creature: an independently rendered procedural spider, visible and expressive but not obstructing content.
- Intelligence layer: fine strikes, trails, graph links, and scanning cues activated by meaningful interactions.
- Workspace: serious, legible investigation terminal with graph/canvas, selected-entity inspector, provenance, filters, and ordered activity.
- Motion must communicate cause-and-effect. The spider should not be just a mascot; background effects must not be unrelated random decoration.
- The user's instinct is that the original background may be stronger than the Adobe video because the Adobe export introduced too much simultaneous movement. Verify side-by-side in the actual page; do not assume the Adobe video must be kept.
- GMUNK / TRON is a reference for integrated visual systems, careful hierarchy, scan/track/connect behavior, and reactive linework—not for copying TRON graphics.

## The terminal has not yet been designed

Design the investigation workspace from first principles and explain the trade-offs. Treat it as a user-facing investigation workbench, not a fake CLI.

At minimum specify:
- Top bar, global search/intake, workspace/subject identity, scope and time controls.
- Left contextual investigation/activity or query panel.
- Central network/evidence canvas with root focus, select/expand, edge details, filters, fit-to-view and empty states.
- Right entity/relationship inspector with provenance.
- Collapsible bottom activity timeline/event history.
- Agent state/status and user approval/ambiguity/error states.
- Desktop and mobile behavior.
- All relevant empty/loading/partial/error/blocked/conflicting/stale/demo states.

Do not assume every domain or real data integration already exists. Reconcile desired functionality with current implementation and data access. Mark each capability `implemented`, `partial`, `planned`, or `demo-only`.

## Create or reconcile the repository documentation

Use existing docs when they already fill a role. Otherwise create and populate these source-of-truth documents:

- Root `CLAUDE.md`: permanent rules requiring every future Claude task to read this file plus the relevant design/product/architecture docs before changing code; start by reading `docs/DECISIONS.md`; inspect real code; name the source files and docs that govern the task; follow current design decisions; never silently change product identity, stack, scope or motion principles; update docs/decisions when approved implementation changes meaning; and verify the result. It must be concise enough to be followed every session.
- `docs/product/PRODUCT_BRIEF.md`
- `docs/design/DESIGN_SYSTEM.md`
- `docs/product/EXPERIENCE_MAP.md`
- `docs/product/TERMINAL_SPEC.md`
- `docs/design/MOTION_SYSTEM.md`
- `docs/architecture/TECHNICAL_ARCHITECTURE.md`
- `docs/architecture/DATA_MODEL_AND_PROVENANCE.md`
- `docs/roadmap/IMPLEMENTATION_ROADMAP.md`
- `docs/research/REFERENCE_LIBRARY.md`
- `docs/DECISIONS.md`

A supplied `OPIUMCRAWL_MASTER_DESIGN_BRIEF.md` may exist in the repo or be added by the user. Treat it as the baseline and split it into the documents above, improving it with verified repository facts and research. Don't create duplicate parallel docs with different answers. If that brief is not in the repository, produce equivalent documentation from this prompt and your research.

## Include clear maps

At minimum, the docs must contain:
1. A product sitemap and primary user journey.
2. A terminal layout map.
3. A data/interaction architecture map showing UI, investigation controller, canonical graph, provider adapters, provenance, event stream, spider, and reactive effects.
4. A phased dependency/implementation roadmap with exit criteria.

Use Mermaid diagrams where possible. Diagrams must match the written specifications.

## Deliverables and quality bar

The resulting docs should allow a new engineer or Claude session to answer:
- What are we building and for whom?
- What is included in the first working slice, and what is explicitly deferred?
- What should landing page and terminal look like, and why?
- What are the exact entity/relationship/inspector models and states?
- What can each visual effect mean, and what triggers it?
- How will a real data adapter connect without coupling it to the view?
- Which references support each design decision?
- What is the first implementation sequence and how is each phase accepted?
- What is unknown or requires user approval?

Document the decisions as **proposed**, **confirmed by repository**, or **requires owner approval**. Do not pretend a proposal is already implemented. Use actual repo paths and identify media assets exactly, without renaming them.

## Final output from this task

1. Summarize the repository facts discovered.
2. Describe the proposed complete product and terminal design in a concise review summary.
3. Give an experience map and architecture map.
4. List the docs created/updated.
5. Identify unresolved decisions, recommending a default for each.
6. State explicitly that no product implementation changes were made.
7. Recommend the single next implementation slice, but do not start it.

The design must balance originality and readability. Use the landscape as atmosphere, the spider as a guide to attention, and the terminal as the place where users investigate real relationships. Make the effects beautiful because they explain something—not merely because they move.
