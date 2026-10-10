# Project state

_Updated at the end of every milestone. Read this first when resuming._ Last updated: 2026-10-10.

## North star
An agent-native video editor ("a Claude for video editors"): understands footage and references, edits the real project through typed tools, verifies its own work. See `ROADMAP.md` and `PRODUCT_MAP.md`.

## Current milestone
**P2/P3 closure on real footage.** The smallest complete loop (import → understand → instruct → plan → execute → verify → export) exists in pieces; this phase makes it one reliable flow and hardens long-media behaviour. Milestone list and order are in `ROADMAP.md` ("Execution plan 2026-10-10").

## Completed (evidence)
- Editor M0: timeline, preview, keyframes, text, masks, captions, undo, autosave, MP4/WebM export. e2e on dev server and on the production build.
- Agent: ~40 typed tools, one-turn-one-undo transactions, MCP bridge, in-app chat agent, `ModelClient` boundary. Real model passes 14/14 evals (Sonnet 4.5; Haiku 4.5 after a prompt fix) and a real-browser QA (e2e/agent-real.spec.ts).
- Perception: silence, true BS.1770 LUFS, onsets, tempo, scene cuts. Speech: local Whisper (consent-gated). Visual: CLIP search (5/9 top-1 on real UI footage), MediaPipe face detection (detection + storage only). Temporal index + find/cut moments.
- Pitch-preserving speed, measured on real exported audio (440 Hz stays 440 Hz at 2x).
- Ship: CI (typecheck, lint, unit, eval, build, e2e, production-build e2e), Vercel native auto-deploy of `main`, post-deploy smoke workflow, release checklist (`RELEASE.md`).
- Fixed from real use: first clip dropped on an empty timeline now starts at 0 (was black preview).
- Gate at HEAD: typecheck, lint, 1196 unit tests, `pnpm eval` (all policy runs as declared), production build, 48+ e2e.

## Active work
See the table in `ROADMAP.md`. Owners are partitioned by path; agents never edit the same files.

## Known failures / limitations
- Faces are in the index and agent tools (N3) but untested on real MediaPipe output in the app. Word-level captions have data plumbing only; the compositor has no rich-text path.
- Understand footage (N2) works with test doubles; real models through it and a mid-run reload are not browser-verified.
- Plan approval exists (N4); after a re-plan one run can have more than one undo step, and a manual edit made while an approved plan executes is rolled back if the run fails.
- Long media / large projects are untested: whole-timeline audio mix in memory, no clip virtualization, 4K decode.
- Chromium only. WebGPU speech path and Firefox/Safari untested. In-app agent calling Anthropic directly from the browser with a pasted key is untested against the real API.
- Visual search is weak on text-heavy UI footage and on absence queries.

## Architectural decisions
- Layering engine ← render ← platform ← export ← app ← ui, enforced by `tests/architecture.test.ts`. Engine is pure and headless.
- Agent and UI use the same commands; tools take seconds and element ids, not pixels.
- Models are replaceable behind `ModelClient`, `Transcriber`, `VisualSearcher`, `AnalysisProvider`; model downloads need explicit consent; the API key never enters the page in tests (Node-side bridge).
- Temporal data contract: per-asset index on a source-time axis with extensible `tracks`.
- Deploy: Vercel GitHub integration on push to `main`. Epoch (Aeon instance `Svector-anu/svectors-lab`) plans/builds/reviews orders; local agents build in parallel where Aeon is slow.
- Build vs buy: see `research/07-oss-reuse-audit.md`; check OSS before building.

## Next highest-leverage tasks
See "Execution plan 2026-10-10" in `ROADMAP.md`.

## Verification status
Evidence lives in CI runs, `docs/EVALS.md`, `docs/VISUAL_SEARCH.md` (measured results) and `e2e/`. Not yet verified: items listed under Known failures.

## Owner-only decisions
License (none chosen), making the site public (Vercel Deployment Protection is on), `VERCEL_AUTOMATION_BYPASS_SECRET` for the smoke check, API keys.
