# Roadmap

Living document. Re-planned at the end of every milestone from the repository's actual state (`PROJECT_STATE.md`, `IMPLEMENTATION_AUDIT.md`), not from memory.

## Product thesis

An **agent-native video editor**: an agent can *see* footage, *understand* references, *edit* the real project through typed tools, and *verify* the result by rendering and measuring it — the way Claude Code works on a codebase. The editor is a normal, good, local-first editor for humans; the agent is a first-class user of the same commands, undo stack and renderer.

Why the current codebase is a good foundation: every change is a `Command`; the engine is pure and headless-capable; preview and export share one frame plan; whole-document undo makes an agent turn reversible; time is exact integer ticks.

## Principles

1. **Tools, not scripts.** The agent only acts through a small, typed, validated tool surface. Same surface for the in-app chat, MCP clients and tests.
2. **Verify, don't trust.** Every agent edit can be checked by tools: render a frame, measure loudness, read the timeline back. Agent work is evaluated by a deterministic harness, not by vibes.
3. **One agent turn = one undo step.** A user can always revert what the agent did.
4. **Local-first.** Media never leaves the machine; only what the user chooses to send to a model (frames, summaries) does, with the user's own key.
5. **Evidence over claims.** A milestone is done when tests + an observed run prove the claim (Epoch loop).

## Milestones

| # | Milestone | Claim that must be provable | Status |
|---|---|---|---|
| M0 | Editor reconstruction | Import → edit → play → persist → export works; 286 unit + 13 e2e green | done |
| M1 | **Agent tool surface** (`engine/agent`) | Every core edit is available as a validated tool; a scripted tool sequence builds the same project as human commands; one turn = one undo step; errors are model-readable | done: 33 tools, transactions, 152 tests |
| M2 | **Perception** (`engine/analysis`, `platform/analysis`) | Silence, scene cuts, loudness, onsets and pacing are measured from real media and match known ground truth; contact sheets render | done: analysis tests + real-media e2e |
| M3 | **Bridge + MCP server** (`tools/mcp`) | An external MCP client can list tools, edit the live editor, render a frame image and export, over a local socket | done: token handshake, `render_frame`, `export_project`, 3 e2e |
| M4 | **In-app agent** (chat panel, Claude tool loop, vision) | Given a goal and footage, the agent produces a rough cut, then self-corrects after inspecting rendered frames | done: chat panel, Claude tool loop, vision, scripted + real model clients; real-model quality unmeasured (needs API key) |
| M5 | **Agent eval harness** | Scripted briefs ("remove silences", "cut to the beat", "add captions") are scored automatically against ground truth; regressions block merges | done: 10 cases, 37 mutations, `pnpm eval`, docs/EVALS.md; real-model run needs an API key |
| M6 | **Reference intelligence** | From a reference video: pacing, shot rhythm, caption style, audio energy → a reusable style profile the agent applies to new footage | engine + opt-in tools + storage done; no real-footage evaluation yet |
| M7 | Speech: transcription + transcript-driven editing | Word-level captions; "delete this sentence" edits the timeline | done: engine, agent tools, local Whisper + consent + Transcribe UI (see TRANSCRIPTS.md). WebGPU path and production ORT asset hosting unverified; word-level caption styling still to do |
| M7b | **Review hardening** | Independent review's P0/P1 findings closed with regression tests | P0 done; remaining P1/P2 in progress |
| M8 | Product hardening | Virtualized timeline, crash-safe persistence, cross-browser matrix, GPU compositor, pitch-preserving speed, accessibility audit | ongoing |
| M7c | **Temporal index** | One queryable timeline joining words, shots, faces, audio energy and embeddings per asset, so the agent searches footage instead of re-analyzing it | partly done: shots, loudness, silence, speech sentences and beat grid on one source-time axis, with `describe_footage` / `find_moments` / `cut_to_moments` (see `docs/TEMPORAL_INDEX.md`). Faces and embeddings are not built (no models yet); the `tracks` shape is ready for them Visual search is built: on-device CLIP (`Xenova/clip-vit-base-patch32`, int8, ~156 MB, MIT) embeds sampled frames into `tracks.visual`, with `index_visuals` / `find_visual_moments` and an Index visuals action (see `docs/VISUAL_SEARCH.md`). Faces are not built |
| M7d | Forced-alignment captions | Caption timing from word alignment, accurate to a frame | proposed |
| M7e | Verifier rules | Post-edit checks (no dead air, caption safe zones, loudness targets) the agent runs before reporting done | proposed |
| M8b | Native desktop export | Faster-than-realtime export outside the browser sandbox, same `FramePlan` seam | proposed |
| M9 | Ship | Hosted static build, onboarding, privacy statement, telemetry-free error reporting | later |

## Risks and decisions to revisit

- **Browser as the runtime.** Perception and rendering live in the page (WebCodecs, Canvas). A headless agent therefore needs a browser (Playwright) or the bridge to a user's open tab. Decision: bridge first; a Node/WASM render path only if evals demand it.
- **Model access.** Browser → Anthropic API needs the user's key (stored locally) and CORS opt-in header; MCP path needs none. Both supported.
- **Cost/latency of vision.** Contact sheets (many frames per image) and cached analysis keep token use bounded.
- **Safety.** Tools cannot delete assets bytes, export to disk, or call the network except via explicit user-approved tools.

## Rules for choosing the next milestone

Pick the item that most reduces the risk that the thesis is wrong (can an agent actually produce a good edit end to end?), then the item that unblocks the most other work, then polish. Re-order this table when evidence changes.


## Execution plan 2026-10-10 (supersedes ordering above)

Priority rule: P0/P1 (reliability, long media) before P2/P3 features; the end-to-end loop on real footage is the acceptance test for everything.

| ID | Milestone | Claim that must be provable | Owner (paths) | Status |
|---|---|---|---|---|
| N1 | Long-media and large-project hardening (P0/P1) | A 10-min source, 60+ clips and a 5-min export complete without freezing the UI or exhausting memory; clip rendering is windowed; export audio mix is chunked | `src/ui/timeline/**`, `src/export/**`, `src/platform/video-frames*` | in progress |
| N2 | One-action "Understand footage" | One button runs analysis + transcript + visual index (+ faces) per asset with progress, cancel, one consent, resumable; agent tools report index readiness | `src/app/understand*`, `src/ui/assets/**` | in progress |
| N3 | Faces in the temporal index and agent | `find_face_moments`, face presence/size/position queries, auto-reframe target data; eval case | `src/engine/temporal/**`, `src/engine/face/**`, `src/engine/agent/tools-face.ts`, `src/app/agent/face-wiring.ts` | in progress |
| N4 | Plan-then-execute | The agent shows a plan the user can approve or edit before edits run; each step is verified; failures are explained | `src/app/agent/**` (loop, session, prompt), `src/ui/agent/**` | in progress |
| N5 | Provider-independent agent | A second provider (OpenAI-compatible tool calling) passes the same evals through the same `ModelClient` | `src/app/agent/model-client-openai.ts`, `evals/real.ts` | Epoch order |
| N6 | Landing page `/` + app at `/app` | Thin product page ("Tell your video editor what to do") around the real app; hash routes keep working | `src/ui/pages/Landing.tsx`, router | Epoch order |
| N7 | Real-footage end-to-end acceptance | Import real footage, understand, instruct, plan, execute, verify, export; run by an automated script and recorded in `docs/E2E_REAL.md` | `e2e/`, docs | after N2-N4 |
| N8 | Adversarial QA + final audit | A breaker agent and an architecture reviewer find nothing P0/P1 open; clean install/build/test/e2e; a11y and responsive pass | review agents | last |
| N9 | Word-level captions render | Compositor rich-text path; animated word highlight | `src/render/**`, captions | later |
| N10 | Reference workflow in the UI | Pick a reference video, see its style profile, apply to a timeline, verify | `src/app/agent`, `src/ui` | later |
