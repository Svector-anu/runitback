# 09 - Architecture review (staff-level, read-only)

Scope: `origin/main` at `bc50e2b`, reviewed in a detached worktree. The primary checkout has uncommitted edits to `src/app/agent/loop.ts`, `session.ts`, `evals/*` and others; they are not covered here. Method: code reads, greps, a Tarjan cycle scan over the import graph (289 files), `vitest run` (88 files, 1367 tests, 19 s, all pass), `tsx evals/run.ts` (75/75 policy runs as declared, 1.3 s), `vite build` (inspected the bundle), and a tool-registry dump. No model calls, no keys.

Effort scale: S under a day, M one to three days, L a week or more.

## 1. Executive summary

The foundation is stronger than most projects this age. The pure engine, command/transaction model, shared `FramePlan` for preview and export, integer-tick time, per-asset derived-data stamps (`version` + `model`), the Node-side MCP bridge with token/origin/loopback checks, and a 1367-test unit suite that runs in 19 s are real assets. The import graph has **zero cycles** and the engine really runs in Node (the eval harness does it).

What will be expensive later, in order:

1. **Derived data is never cleaned up.** Six IndexedDB databases exist. Transcripts, embeddings, faces and analysis have `delete()` methods that nothing calls. Deleting an asset or a project leaves vectors and transcripts behind forever, with no quota accounting. For a hosted product this is both a storage leak and a privacy defect (deleted footage still has searchable text and face boxes on disk).
2. **Nothing is portable.** There is no project export/import, no `navigator.storage.persist()`, and no backup. The browser is the only copy of the user's media and edits. A hosted product needs sync or at least a bundle; the data model is not shaped for either yet (assets keyed by id only, derived stores keyed by `assetId` across databases, project JSON embeds a base64 thumbnail).
3. **"Headless" means headless Chromium, not Node.** The pure engine and the agent loop are Node-ready. The exporter is not: it uses `CanvasSource` (WebCodecs), `OffscreenCanvas`, `OfflineAudioContext`, `createImageBitmap`, and imports `platform/` decoders directly (`src/export/exporter.ts:14-16`). The docs say "headless mode = engine + export"; that is only true in a browser. A server render farm or native desktop export needs a real seam, not a claim.
4. **Agent cost and context growth.** About 58 tools plus 2 plan tools (about 10k tokens of schemas and prompt per call, extrapolated from a measured 5.2k for the 33 core tools), history is never compacted, each result may carry 8k chars of JSON, and measured real runs cost 15-17k input tokens per call. Prompt caching exists (verified in `model-client.ts`), which softens but does not remove the growth. This is the main unit-economics risk for a hosted agent.
5. **The agent contract is Anthropic-shaped and split across three composition sites.** The tool registry is assembled by hand in `session.ts`, `agent-bridge-wiring.ts` and `evals/harness.ts`; they have already drifted. MCP clients get no transaction grouping and no plan gate (each tool call is its own undo step), so "same surface, one turn one undo" holds only for the in-app agent.
6. **Security posture is acceptable for a local tool, not for a hosted one.** No CSP, API key in `localStorage` readable by any script, a Google Fonts stylesheet loaded at runtime, unpinned Hugging Face model revisions, a nightly ONNX runtime pin.
7. **Test pyramid is top-heavy where it matters and thin where it rots.** Production-build e2e is one test; six real-model/real-footage specs are opt-in with no schedule; the evals score scripted policies against stubbed perception, so they test the checks, not the agent.
8. **Docs drift is already material** (tool counts 33 / ~40 / actual 58; 1196 vs 1367 tests; "real model not done" vs "14/14 real"). Several docs contradict each other on facts a new contributor will rely on.

## 2. Findings (ranked)

### P0 - fix before anything is hosted for other people

**P0-1. Derived data leaks on asset/project delete; deleted media stays searchable.**
Evidence: `IdbTranscriptStore.delete`, `IdbVisualStore.delete`, `IdbFaceStore.delete`, `IdbAnalysisStore.delete` exist (`src/platform/transcribe/store.ts:24`, `visual/store.ts:25`, `visual/face-store.ts`, `analysis/store.ts:31`). `grep` finds no caller of any of them outside tests. `ProjectsService.delete` / `collectOrphans` / `sweepOrphans` (`src/engine/persistence/projects.ts:70-112`) only touch `AssetRepository`. Style profiles (`runitback-style`) are global and never scoped to a project.
Why it matters: unbounded storage growth (Float32 vectors for a CLIP index at 2 s sampling are about 1 MB per 10 min), orphaned transcripts of footage the user deleted, and `project duplicate` shares asset ids so naive deletion would break the copy.
Change: introduce a `DerivedDataRegistry` in `engine/persistence` (interface: `purge(assetId)`, `list()`), implemented over all five stores in `platform`. `ProjectsService.collectOrphans` and `delete` call it, with reference counting by asset id across projects (duplicate shares ids). Add a test that creates derived data, deletes the asset, and asserts all stores are empty. Effort M.

**P0-2. No durable-storage request, no backup, no project export/import.**
Evidence: `grep storage.persist src` is empty; no export/import code outside video export; `ProjectRepository` stores one JSON string per project (`src/platform/repositories.ts:40-60`).
Why it matters: browsers may evict origin storage under pressure (and Safari expires it); for a local-first editor that is silent total loss. A hosted launch will hit this in week one.
Change: call `navigator.storage.persist()` after first import and surface the result in Settings (S). Define a `.runitback` bundle (zip: `project.json` with `schemaVersion`, `assets/` originals, `derived/` with model/version stamps, `manifest.json`) plus import with the existing `migrateProject`/`repairProject` (M-L). A round-trip test with real bytes is the acceptance criterion. Currently a project does **not** round-trip with media or derived data because no path exists.

**P0-3. No CSP and the agent key sits in `localStorage` (`runitback:agent-api-key`).**
Evidence: `vercel.json` sets only nosniff, no-referrer, Permissions-Policy. `src/platform/prefs.ts:55-56`; `src/app/agent/session.ts:93,126-129`; `AnthropicModelClient` uses `dangerouslyAllowBrowser: true` (`model-client.ts:186`).
Why it matters: any XSS or any third-party script exfiltrates the user's Anthropic key. There is currently no script from third parties, which is why this is not worse; a CSP makes that property enforced instead of accidental.
Change: add a strict CSP in `vercel.json` (`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://api.anthropic.com https://huggingface.co https://*.hf.co; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:`), self-host fonts (see P1-7) and verify with the production e2e. For a hosted product, move the key behind a thin server proxy; until then document the browser-key risk in-product. Effort S for CSP, M for proxy.

### P1 - before public launch

**P1-1. Agent cost: no history compaction, big tool surface, large per-result payloads.**
Evidence: `src/app/agent/loop.ts` `limitImages` only trims images; `MAX_RESULT_DATA_CHARS = 8000` per result; `DEFAULT_TOKEN_BUDGET = 1_000_000`; `DEFAULT_MAX_STEPS = 30`. Registry dump: 33 engine core tools = 18.6k chars (about 5.2k tokens), largest schemas `insert_text` 1.7k chars, `set_params` 1.1k; plus about 25 app-layer tools; system prompt 3.8k chars (6.1k with the plan protocol). `docs/E2E_REAL.md` measured 15-17k input tokens per call and $0.04-$0.20 per request on Haiku. Caching: `AnthropicModelClient` places `cache_control` on system, last tool and the newest message, so repeated prefix is cheap; growth is still linear.
Change, in order of payoff: (a) tool-result compaction: replace results older than N steps with their one-line `summary` (the `ToolResult` already has `summary` separate from `data`) (S-M); (b) load tool groups lazily by intent (core always; temporal/visual/face/reference/transcript behind a `request_tools` or by intent from the first turn) to cut about 40% of schema tokens (M); (c) cross-request history summarization after a run ends (M); (d) per-request budget defaults (1M tokens is a $3-15 ceiling on a frontier model) tied to the model price table (S).

**P1-2. Three hand-maintained registry composition sites; MCP path has no turn semantics.**
Evidence: `src/app/agent/session.ts:226-237` and `src/app/agent-bridge-wiring.ts:38-52` both repeat `createAgentTools` + platform + transcript + temporal + visual + face + understand; `evals/harness.ts:34` and `evals/browser-entry.ts:122` are two more with stubs. `src/platform/agent-bridge.ts:182` `call_tool` runs a tool with no `beginTransaction`; every MCP call is a separate undo step and there is no `propose_plan` gate (plan tools live only inside `loop.ts`, not in the registry).
Change: one `createAppToolRegistry({ editor, runtime, signal, onExport })` in `src/app/agent/` that all callers use (S). Add two bridge-level tools or a bridge convention (`begin_turn` / `end_turn`, auto-closed on disconnect or after N seconds idle) mapped to `editor.beginTransaction`, so MCP clients also get one-undo-per-turn (M). Move plan state out of `loop.ts` into `engine/agent/plan.ts` so the gate can be shared (M).

**P1-3. Headless/native export is blocked, and the docs overstate readiness.**
Evidence: `src/export/exporter.ts` imports `#/platform/audio-scheduler`, `#/platform/frame-sources`, `#/platform/video-frames`; uses `CanvasSource`, `AudioBufferSource`, `OfflineAudioContext` (`src/platform/transcribe/audio-source.ts:16`, `src/export/audio-mix.ts`); `src/render/canvas.ts:4-8` falls back to `document.createElement`. `docs/ARCHITECTURE.md` rule 8: "Headless mode = engine + export".
What does work in Node: engine, agent loop, tools (stubbed perception), evals, MCP server.
Change: define `FrameSource` / `AudioSource` / `EncoderSink` ports in `export/` (or a new `engine/export-plan` layer) and make `exporter.ts` depend only on them; keep the mediabunny/WebCodecs implementation in `platform/`. This gives a clean seam for a Rust/ffmpeg/GPU render service. Until then, say "headless Chromium" in the docs. Effort L; the doc fix is S.

**P1-4. Layer enforcement has holes; app/ui are a mutual dependency.**
Evidence (`tests/architecture.test.ts`): (a) only matches `from "#/<layer>"` via regex, so relative imports (`../platform/x`), side-effect imports and dynamic `import("#/ui/...")` pass undetected. Today there are zero relative cross-layer imports, so this is hygiene, not a live bug. (b) `ALLOWED.app` includes `ui`, and it is used: `src/app/actions.ts:5-10`, `insert.ts:9`, `agent-bridge-wiring.ts:6` import from `#/ui/...`, while `ui` imports `app` in 66 `getServices()` sites. That is a real two-way coupling inside the top two layers. (c) `engine` is type-checked with `lib: DOM`, so DOM types compile inside the engine; only a word regex (`window|document|...`) guards it and it ignores `Blob`, `File`, `fetch`, `DOMException`. (d) `tools/mcp/*` imports `src/platform/agent-bridge-protocol` (a pure protocol file living in the browser layer).
Change: replace the regex test with `dependency-cruiser` or `eslint-plugin-boundaries` rules incl. dynamic imports (S); make `app` not import `ui` (move `interactionStore`, `overlay-store`, `toast`, `DragPayload`, `BridgeStatus` types down to `app/` or `engine/`) (M); add `tsconfig.engine.json` with `lib: ["ES2023"]` and no DOM, included in `typecheck` (S); move `agent-bridge-protocol.ts` to `engine/agent` or a `shared/` layer (S).

**P1-5. Singletons and test hooks: 13 module-level singletons, two `getFaceStore`, four different hook shapes.**
Evidence: `getServices()` 66 call sites across ui/app; `getTranscribeService`, `getVisualService`, `getUnderstandService`, `getTranscriptStore`, `getVisualStore`, `getStyleProfileStore`, `sharedAnalysisStore` all `let x ??=` at module scope. `getFaceStore` exists twice (`src/app/understand-stages.ts:72`, `src/app/agent/face-wiring.ts:10`) with separate instances over the same IndexedDB. Test hooks: `__transcriber`, `__visual`, `__faces`, `__agentModel` each with its own `TestHookHost` interface (`transcribe-service.ts:127`, `visual-service.ts:144`, `understand-stages.ts:61`, `session.ts:65`). Verified safe: all four are guarded by `import.meta.env.DEV` and are absent from the production bundle (`vite build` grep).
Why it matters: `AppServices` itself is a reasonable composition root (336 lines, one session object, serialized open/close queue, project lock). The problem is everything else bypassing it, which makes multi-project, multi-tab, worker and per-test isolation painful, and it is what will block a server or desktop shell reusing `app/`.
Change: make the singletons fields of one `AppContainer` built by `createAppContainer(deps)`, expose via a React context plus a single `getContainer()` for non-React code; collapse the four hooks into one `app/test-hooks.ts` with a typed `window.__runitback` object (S-M). Delete the duplicate `getFaceStore` (S).

**P1-6. Schema versioning is unproven; IndexedDB upgrade path cannot migrate data.**
Evidence: `PROJECT_SCHEMA_VERSION = 1`, `PROJECT_MIGRATIONS = []` (`serialization.ts:12`): the migration loop has never run on real data and there is no golden fixture of a persisted project in `tests/`. `openDatabase` (`src/platform/idb.ts:7-26`) only creates missing stores; there is no `oldVersion` switch, no `onversionchange` handler (so a second tab holding the DB blocks upgrades and the code rejects with "blocked"). Each derived DB has `*_DB_VERSION = 1` with a separate version constant to keep in sync with the stored `version` field in the record.
Change: add checked-in golden project JSONs per schema version plus a test that loads each through `deserializeProject` and asserts equality with the current shape (S). Give `openDatabase` an `upgrade(db, oldVersion, tx)` callback and handle `onversionchange` by closing the connection (S). Treat the project JSON as an interchange format: add `app: "runitback"`, `schemaVersion`, and `createdWith` in the bundle (see P0-2).

**P1-7. Third-party and unpinned network dependencies.**
Evidence: `index.html:8-10` and `src/platform/fonts.ts:29` load `fonts.googleapis.com` at runtime (every text element with a non-system font triggers a request; export correctness depends on that third party being reachable, and fonts are not stored with the project). Hugging Face models load with default revision (`main`) and no integrity check (`whisper-worker.ts:26-33`, `clip-worker.ts:16-19`): a changed upstream model silently changes embeddings while the stored `model` string stays the same. `onnxruntime-web` is pinned to a nightly (`1.31.0-dev.20260914-8d85527a0`, `package.json`), while `@huggingface/transformers@4.3.0` resolves a different dev build for `onnxruntime-common` (lockfile has `1.30.0` and `1.31.0-dev.20260911`), and the self-hosted WASM is 26.9 MB (6.8 MB gzip) in the asset chunk.
Change: self-host a curated font set (bundle woff2 for the 10-20 families offered; store `fontFamily` + `fontSource` in the element params) (M); pin model repos by commit hash (`revision`) and include that hash in the stored `model` string so cached derived data invalidates when the model changes (S); host models on your own bucket/CDN for a hosted product (M); move off the nightly ORT or record why not (S).

**P1-8. Provenance and license.**
Evidence: no `LICENSE` file; `PROJECT_STATE.md` lists license as an owner-only decision; the product is "reconstructed from OpenCut" with `docs/research/01-06` describing the reference's internals by file and line. Mediabunny is MPL-2.0 (file-level copyleft; fine for bundling unmodified, note it).
Change: owner decides license; confirm the reference's license permits the derivation and add attribution/NOTICE; add a dependency license check to CI (S, owner action).

**P1-9. Deploy is not gated by CI.**
Evidence: `.github/workflows/smoke.yml` header states Vercel's native integration deploys every push to `main`; `deploy.yml` (CI-gated, token-based) is still present and active on `workflow_run`, so two deploy paths coexist; `smoke` is post-deploy only and silently skips without `VERCEL_AUTOMATION_BYPASS_SECRET`.
Change: pick one path. For a public product use CI-gated promotion (Vercel "deploy on CI success" or `deploy.yml` with Git integration set to preview only) and delete the other (S).

### P2 - important, schedule it

**P2-1. ModelClient boundary is honest at the wire, leaky at the edges.**
Evidence: `ModelClient`, message types, `DEFAULT_AGENT_MODEL` ("claude-sonnet-5-5") and `redactSecrets` live in `model-client.ts`, which also imports `@anthropic-ai/sdk`; `loop.ts` imports from it, so the loop transitively pulls in the SDK in Node and browser alike. Message shape is Anthropic's (`tool_use` / `tool_result` blocks); the OpenAI client translates and degrades images to text (`IMAGES_OMITTED_NOTE`). `OpenAiModelClient` and `model-providers.ts` are not imported anywhere in `src/` (only evals/tests), so "provider-independent agent" (N5) is not a user-visible capability, and `MODEL_PROVIDERS["openai-compatible"].defaultBaseUrl` is a third-party reseller (`api.surplusintelligence.ai`) that would receive keys if anyone wires the provider into the UI.
Change: split `model-client.ts` into `model-types.ts` (pure, no SDK; belongs in `engine/agent`) and `anthropic-client.ts`; move `runAgent` to `engine/agent/loop.ts` (it needs only `Editor`, `ModelClient`, tools; today it sits in `app/` only because of file placement); make the default base URL the vendor's own or require explicit configuration (S-M). Then the loop is headless-reusable by a server and by evals with no SDK import.

**P2-2. Tool surface naming and schema consistency.**
Evidence: names mix bare verbs (`move`, `split`, `trim`, `delete`, `duplicate`, `select`, `seek`, `undo`, `redo`) with namespaced `verb_noun` (`insert_media`, `set_params`, `get_timeline`); `understand_media` vs `get_understanding_status` vs `describe_footage` vs `describe_faces`; `add_captions_from_transcript` vs `import_captions`; `add_*`/`insert_*`/`import_*` overlap. `propose_plan` / `update_plan_step` exist only in the loop, not in the registry. The JSON-schema subset (`JsonSchema` in `engine/agent/types.ts`) lacks `anyOf`/`default`/`const`, forcing prose in descriptions.
Why it matters: ~58 flat tools is at the edge of reliable selection; each new one costs tokens on every call (P1-1).
Change: adopt `<domain>_<verb>` (`clip_move`, `clip_split`, `timeline_get`, `footage_find_moments`), keep old names as aliases for one release, write a lint test that fails on duplicate or inconsistent prefixes and on schema size over a budget (S for the test; M for the rename). Consider merging `set_params`-family and `insert_*` into fewer generic tools.

**P2-3. Plan/transaction semantics have known gaps.**
Evidence: `docs/PROJECT_STATE.md` known failures: after a re-plan one run can produce more than one undo step; a manual edit made during an approved run is rolled back if the run fails. `loop.ts` uses `doc` object identity (`undoableDoc`, `docAfter`) to decide whether undo is safe; this works for a single-user local editor and does not survive collaborative or multi-writer futures. `unplannedEdits` limit is enforced by `readOnly` flag only: a mis-flagged tool bypasses the gate.
Change: tag history entries with a `turnId` (editor-level) and let undo-by-turn operate on that, instead of identity comparisons; write property tests that any interleaving of user edits and agent turns never loses user edits (M). Add an eval that asserts every non-`readOnly` tool actually changes `doc` (and vice versa) (S).

**P2-4. Temporal index contract is a good start, thin for the next kinds.**
Evidence: `src/engine/temporal/types.ts`. Strengths: single source-time axis in seconds, `TemporalEvent {start,end,label?,score?}`, open `tracks[kind]` map, `sources` flags, `version`. Weaknesses: (a) no producer provenance per track (model id/version/revision); stamps exist per store record (`Transcript.model`, `VisualEmbeddings.model`, `FaceDetections.model`) but `TemporalIndex` itself drops them, so the agent cannot say "from whisper-tiny.en, low confidence on music"; (b) no `speaker`, no `trackId` (faces are per-frame boxes with no identity across frames: `FaceFrame.boxes`), no bbox/geometry on `TemporalEvent`, no `text` for OCR, no embedding handle; (c) `TemporalIndex` is rebuilt in memory from separate stores on each tool call (`tools-temporal.ts:71`, `tools-face.ts:215`) in two places with different inputs, not a persisted/joined artifact; (d) seconds-as-float for source time next to integer ticks on the timeline, with conversion in `placement.ts`: acceptable, but pick and document one rounding rule (floor to frame) at the boundary.
Change: add `provenance: { producer, model, revision, version }` to each track and carry it into `describe_footage` output (S); extend `TemporalEvent` with optional `speakerId?`, `trackId?`, `box?`, `text?` (additive) (S); build the index through one `TemporalIndexBuilder` that all tools call (S-M); a golden fixture per kind (words, shots, faces, OCR, objects) with a round-trip test (S). Embeddings stay in their own store, referenced by `{store, assetId, model}`.

**P2-5. Derived data invalidation when models change is only half done.**
Evidence: `isUsableEmbeddings(embeddings, model)` and `isUsableFaceDetections` compare `version` and `model` and the Understand stage `has()` re-runs when stale (`understand-stages.ts`), good. Missing: transcripts have `model` but no revision; analysis cache key is `${id}:${size}:${lastModified}` with `version` inside the value; superseded records are overwritten in place with no tombstone, so a failed re-index leaves no data; and old versions are never garbage-collected across schema bumps.
Change: stamp `revision` (P1-7), write new derived data to a staging key and swap on success, add a "stale derived data" count to Settings with a purge action (M).

**P2-6. Performance architecture: models in workers, everything else on the main thread.**
Evidence: Whisper, CLIP and MediaPipe run in module workers (good). Compositing (`Compositor` using Canvas2D, a layer and a scratch canvas sized to the project, `src/render/compositor.ts:37-39`), video decode (`VideoFrameCache`), analysis (`platform/analysis/analyze-media.ts`, `AudioBufferSink` on the main thread), export (`exporter.ts`, main thread) and the audio engine all run in the page. `docs/PERFORMANCE.md` covers clip windowing and chunked audio mix (good, measured on dev server only); `PROJECT_STATE` lists whole-timeline compositing cost and 4K as untested for long projects.
Why it matters: a long export or analysis competes with the editor UI; whole-timeline compositing is O(visible layers) per frame, which is fine, but each mask and effect allocates scratch canvases per frame (`masks.ts:121,139`).
Change: move export into a worker with `OffscreenCanvas` (the `createCanvas` seam already supports it) so UI stays live (M-L); pool the per-frame scratch canvases in `Compositor` (S); move `analyzeMedia` to a worker (M); record production-build numbers, not dev-server numbers (S).

**P2-7. Test pyramid and rot.**
Evidence: 88 unit files, 1367 tests, 19 s (excellent); about 78 e2e tests, `workers: 1`, `fullyParallel: false`, 120 s timeout, run serially in one CI job (`ci.yml`), then the build and e2e are repeated in `e2e-production`, which contains **one** spec with one test (`e2e/production/core.spec.ts`). Main e2e runs against the Vite dev server, where `__*` hooks and React dev behaviour differ from production. Six specs are opt-in (`agent-real`, `real-footage`, `face-real`, `visual-real`, `visual-footage`, `smoke-live`) with env gates and no scheduled workflow: they will rot, and the only evidence of real-model behaviour (docs/E2E_REAL.md) came from manual runs. Evals: `pnpm eval` verifies 75/75 policy runs behave as declared (oracle solves, mutations are caught); `evals/stub-tools.ts` returns the declared ground truth for analysis, so perception errors cannot fail an eval; in CI no model is ever called. This validates the *checks*, not the *agent*.
Change: (a) weekly scheduled workflow for the opt-in specs with a small budget and a committed result file (S-M); (b) grow `e2e/production` to cover import, edit, export on the built bundle, and shard e2e across 3-4 jobs (M); (c) add a nightly real-model eval pass with fixed seeds and a cost cap, tracked over time (M); (d) browser-level smoke for Firefox/Safari to learn the real support matrix (M); (e) golden-file tests for persistence (P1-6).

**P2-8. Storage quota handling is reactive.**
Evidence: `canStoreFile` checks `navigator.storage.estimate()` with 50 MiB headroom only at import; derived data and exports (OPFS `runitback-exports`, cleaned after an hour) are not counted. `IdbProjectRepository.list()` deserializes and validates every project's full JSON (including a base64 thumbnail inside the project record) to render the list; cost grows with total project size.
Change: store thumbnails as separate blobs and keep a small `projectIndex` store for listing (S-M); show a storage breakdown (media / derived / exports) with one-click purge (M).

**P2-9. IndexedDB database sprawl.**
List: `runitback` (stores `projects`, `assets`, `blobs`), `runitback-style`, `runitback-analysis`, `runitback-transcripts`, `runitback-visual`, `runitback-faces`, plus OPFS (asset bytes, `runitback-exports`), `localStorage` (`runitback:*` prefs incl. API key and consent), and the legacy `opencut` / `opencut-style` copies (`legacy-migration.ts`, never deleted by design). Six connections, six version counters, no cross-store transaction, and no shared purge. Rationale in code ("so the project database version never changes") is sound short-term and creates the leak in P0-1.
Change: fold the four derived stores into one `runitback-derived` DB with one store per kind keyed by `[assetId, kind]` and a single `schemaVersion` (M, with a copy-migration); keep `runitback` separate. Do this together with P0-1.

### P3 - hygiene

- **P3-1. Dead/near-dead code**: `src/app/agent/model-providers.ts` and `model-client-openai.ts` (eval-only), `legacy-migration.ts` (one-time rename path; fine to keep until public, then remove), `tools/mcp/server.ts` still reads `OPENCUT_*` env names, `docs/research/` has 8 files of archaeology that are 80% stale against the code.
- **P3-2. Docs drift** (verified): `ROADMAP.md` M1 "33 tools", `PROJECT_STATE.md` "~40 typed tools", actual 58 plus 2 plan tools; `PROJECT_STATE.md` "1196 unit tests" vs 1367; `PRODUCT_MAP.md` "46 e2e", "70 scripted policy runs", "real-model run not done" vs `PROJECT_STATE.md` "Real model passes 14/14 evals" vs `evals` run reporting 75; `ARCHITECTURE.md` rule 8 "Headless mode = engine + export". Fix: generate counts in CI (`docs/METRICS.md` written by a script) and delete numbers from prose (S).
- **P3-3. `deploy.yml` vs Vercel native** contradictory comment ("DISABLED" in `smoke.yml`, active trigger in `deploy.yml`) - resolved by P1-9.
- **P3-4. `exactOptionalPropertyTypes: false`** with many `...(x ? { x } : {})` spreads: pick one policy (S).
- **P3-5. Duplicate `getFaceStore`** (see P1-5).
- **P3-6. Token in the bridge URL** (`#/projects?agent=PORT&token=...`): hash is not sent to servers and `Referrer-Policy: no-referrer` is set, but it lands in browser history; strip it after reading (`agent-bridge-wiring.ts:134` already deletes the param in one path; verify all paths) (S).

## 3. Do now / before public launch / later

**Do now (this week, all S-M)**
1. Wire derived-data purge to asset and project delete, with the test (P0-1).
2. Request persistent storage and show the state (P0-2, first half).
3. Add a CSP and self-host fonts (P0-3, P1-7), run it through the production e2e.
4. One shared tool-registry factory; delete the duplicate `getFaceStore` (P1-2, P1-5).
5. Replace the architecture test with a real boundary tool, add the engine no-DOM tsconfig (P1-4).
6. Golden persisted-project fixtures and an `openDatabase` upgrade callback (P1-6).
7. Fix doc numbers and the "headless" claim (P3-2, P1-3 wording).

**Before public launch**
1. Project bundle export/import with media and derived data, round-trip tested (P0-2).
2. Tool-result compaction, lazy tool groups, a priced per-request budget (P1-1).
3. Turn semantics for MCP clients (P1-2) and `turnId` undo (P2-3).
4. Pin model revisions, host models and ORT yourself, drop the nightly pin (P1-7).
5. CI-gated deploy only (P1-9); license and provenance decision (P1-8).
6. Production-build e2e of the core loop, sharded; scheduled real-model and real-footage runs (P2-7).
7. If a hosted key flow is offered: server-side proxy so the browser never holds the key (P0-3).
8. Consolidate derived stores and a storage breakdown UI (P2-8, P2-9).

**Later**
1. Export ports (`FrameSource`, `AudioSource`, `EncoderSink`) and a worker/Node/native renderer (P1-3, P2-6).
2. Move `runAgent` and the model types into `engine/agent` and split the Anthropic SDK out (P2-1).
3. Temporal index provenance, speaker/track ids, OCR text, one index builder (P2-4).
4. Tool renaming to `<domain>_<verb>` with aliases (P2-2).
5. Worker-based analysis and export; canvas pooling (P2-6).
6. Cross-browser matrix and a sync story (CRDT or server of record) once bundles exist.

## 4. What is already solid (keep, do not rewrite)

- **Layering in practice**: zero import cycles over 289 files (Tarjan scan), no relative cross-layer imports, no `platform`/`export`/`render` imports of `app`/`ui`, `engine` has no `#/platform|render|app|ui` imports. The engine runs in Node today (`evals/harness.ts` builds a headless `Editor` and runs the real loop and tools).
- **Command model**: every document change is a `Command`; whole-document snapshots make agent turns reversible; reactors run inside the command; preview/commit uses the same command. Fuzz and invariant suites exist (`invariants-fuzz`, `temporal-fuzz`, `face-fuzz`, `visual-fuzz`, `transcript-fuzz`).
- **Same primitives for UI and agent**: tools validate against a schema subset (`defineTool` + `validateInput`), speak seconds and ids, translate failures into model-readable `{ok:false, error, hint}`, and cannot throw (`callTool`, `defineTool`).
- **Resource ownership**: `AppServices` serializes open/close through a queue, uses a Web Locks project lock, flushes saves before close, aborts exports on close, sweeps orphaned media only after a clean flush, and disposes `MediaRuntime`.
- **Persistence robustness**: `repairProject` lets damaged projects open with notes; quota checks; save manager with retry/backoff; legacy rename migration copies rather than moves.
- **Derived-data stamps**: `version` + `model` + `dimensions` validation (`isUsableEmbeddings`, `isUsableFaceDetections`) and the Understand stage `has()` check give a correct invalidation pattern, just not yet complete (P2-5).
- **Security of the local bridge**: loopback bind, `Host` check, origin allow-list, per-process random token compared in constant time, hello timeout, 32 MB frame cap, explicit user "Allow"; model downloads gated by a consent dialog; no `localStorage` outside `prefs.ts` (enforced); test hooks stripped from production (verified in the built bundle).
- **Prompt caching and usage accounting** are implemented in the Anthropic client; budget and step caps exist; secrets are redacted in errors.
- **Test speed**: 1367 unit tests in 19 s, evals in 1.3 s; strict TS with `noUncheckedIndexedAccess`; no `any`/`@ts-ignore` (enforced).
- **Performance work is evidence-based** (`docs/PERFORMANCE.md`): clip windowing, chunked offline audio mix, preview decode capped to 1920, streamed export to OPFS.
