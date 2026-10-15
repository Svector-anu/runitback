# CLAUDE.md: OpenCrawl

This folder is **OpenCrawl** (name confirmed by the owner, DEC-001; the older briefs and some media files say OpiumCrawl and keep their names). It is **not** RunItBack. The parent repo's `CLAUDE.md`, pnpm commands, `src/` layers, and `docs/` do not apply here. Do not edit anything outside this folder.

Stack today: static HTML, CSS and vanilla ES modules, no build step, no dependencies. Run it with `python3 serve.py` from this folder (no-cache static server, port 3003) and open http://localhost:3003/. Check the pure logic with `node tests/model.check.mjs` and `node tests/market.check.mjs`.

## Before you change anything

1. Read `docs/DECISIONS.md` first, then `HANDOFF.md`.
2. Read the docs that govern your task:
   - product, scope, who it is for: `docs/product/PRODUCT_BRIEF.md`
   - pages and journeys: `docs/product/EXPERIENCE_MAP.md`
   - the investigation workspace: `docs/product/TERMINAL_SPEC.md`
   - look, type, color, components: `docs/design/DESIGN_SYSTEM.md`
   - animation, spider, terrain light, reduced motion: `docs/design/MOTION_SYSTEM.md`
   - code boundaries, events, adapters: `docs/architecture/TECHNICAL_ARCHITECTURE.md`
   - entities, relationships, provenance: `docs/architecture/DATA_MODEL_AND_PROVENANCE.md`
   - order of work, slices, and acceptance criteria: `docs/roadmap/IMPLEMENTATION_ROADMAP.md`
   - approved (or pending) interaction design: terminal wireframes and states in `docs/product/TERMINAL_SPEC.md` section 8; landing and workspace choreography in `docs/design/MOTION_SYSTEM.md` "Choreography"; architecture reconciliation in `docs/architecture/TECHNICAL_ARCHITECTURE.md` section 4
   - why a reference was used: `docs/research/REFERENCE_LIBRARY.md`
3. Inspect the real code and assets. Do not assume a framework, a library, or a feature exists. Verify.
4. In your first message of the task, name the source files and docs that govern it.

## Rules

- **Identity:** never silently change the product name, stack, scope, or motion principles. If the task requires it, stop, say so, and record a decision.
- **Follow current decisions.** `proposed` means not yet approved: do not build it unless the task says to. `requires owner approval` means ask. Check the status of the decision you are about to implement in `docs/DECISIONS.md` first; when the owner approves or changes one, update that entry and the governing doc in the same task.
- **Demo is never disguised as live.** Anything simulated is labeled and deterministic. Never invent market numbers, relationships, or capabilities. Every material claim in the UI needs a source or a visible Demo label.
- **Layers stay independent:** background video, terrain light, spider, typography, and application state do not reach into each other. Communication goes through the event contract in `js/spider/events.js` (see architecture doc).
- **Motion has a reason:** it explains cause and effect, one thing moves at a time, and `prefers-reduced-motion` has a deliberate fallback. No new continuous loops, particles, or pulsing without a decision.
- **Assets:** never rename, move, delete, or overwrite files in `assets/`, `public/`, `fonts/`, or the Firefly or reference media. Add new files beside them instead. The background is chosen in `js/background.js` only.
- **No new dependencies, build step, or network calls to third parties** without a decision entry (live calls today: Blockstream for pasted Bitcoin addresses, DEC-027, and Binance public market data for charts, DEC-029). No secrets in browser code.
- **Bugfixes are minimal.** Do not refactor while fixing.
- **Comments** only explain non-obvious why. Match the surrounding style.

## Finish the task

- Verify in the browser at desktop and about 390px width, check the console, and check reduced motion. Run `node --check` on every changed module. Say what you could not verify.
- If behavior or meaning changed, update the governing doc and `docs/DECISIONS.md` and `HANDOFF.md` in the same task.
- Do not commit unless asked. This folder has no repository of its own yet (DEC-010); never stage paths outside it.
