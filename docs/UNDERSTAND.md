# Understand footage (roadmap N2)

One action per asset ("Understand", wand icon on a media tile, "Understand footage" in the tile context menu) and one for all media that still misses something ("Understand all" in the Assets header). The older **Transcribe** and **Index visuals** buttons stay as advanced actions and share the same stores, consent and progress services.

## Stages (fixed order)

| Stage | Source | Needs download | Applies to | "Has result" means |
|---|---|---|---|---|
| analysis | `platform/analysis` (silence, loudness, onsets, scene cuts) | no | video, audio | analysis cache entry for `id:size:lastModified` at `MEDIA_ANALYSIS_VERSION` |
| transcript | local Whisper | yes (~50 MB) | audio, video unless `hasAudio === false` | transcript store has the asset |
| visual | CLIP index | yes (~156 MB) | video | embeddings usable by the current searcher model |
| faces | MediaPipe BlazeFace (bundled, local files) | no | video | detections usable for `DEFAULT_FACE_MODEL` |

Images have nothing to do and show no chip.

## Behaviour

- **Status is derived, never stored.** `understandStatus` (`src/engine/understand/status.ts`) maps "which stages have stored results" plus the asset's type/audio to `not-understood | partial | understood | not-applicable`. The app asks each stage's `has()` (the four stores), so state survives a reload and an interrupted run resumes.
- **Resume:** a stage whose result is stored is skipped. Cancelling or a failure leaves finished stages in place; pressing Understand again does only the rest.
- **One consent.** Before anything is queued the service collects the model downloads still needed by missing model stages (`transcript`, `visual`) and asks once in one dialog. Already-cached or previously approved models are not listed. Granting stores the same per-model prefs the Transcribe / Index visuals buttons use. The stage services still enforce their own gate, so no path can download unapproved.
- **Serial, non-blocking.** Assets run one at a time (a promise chain in `UnderstandService`); heavy work is in the existing workers. Other assets show "Queued".
- **Progress.** Per-stage progress is combined into one overall fraction by stage weight (analysis .15, transcript .35, visual .35, faces .15; skipped and non-applicable stages count as done). The tile chip shows `n%` / `Queued` / `Understood` / `Partial`; the chip tooltip names the stage and the reason (failure message, or "missing transcript").
- **Per-stage errors.** A failing stage is recorded, the rest still run, and the asset ends `partial`. The failure messages are kept in memory for the session (the reason after a reload is "missing X").
- **Cancel.** The tile button turns into "Cancel understanding" while the asset is queued or running. Abort stops after the current stage unwinds; later stages are `not-run`.
- "Understand all" is explicit; nothing starts automatically on import (a download needs consent).

## Code map

- `src/engine/understand/status.ts`: stage ids, applicability, `understandStatus`, `describeStatus`, `modelStagesToRun`.
- `src/engine/understand/pipeline.ts`: `runUnderstanding` (pure orchestrator over `UnderstandStage`), `ModelDownload`, `UnderstandStartResult`.
- `src/app/understand-service.ts`: queue, store state (`runs`, `statuses`, `failures`), combined consent.
- `src/app/understand-stages.ts`: real stages and `getUnderstandService()`. Dev/test-only hook `globalThis.__faces = { indexer }` replaces the face detector (Vite strips it from production); `__transcriber` and `__visual` already exist.
- `src/ui/assets/`: `UnderstandChip`, `UnderstandDialog`, `understand-action.ts`, tile/header/context-menu wiring in `MediaView.tsx`.
- `src/engine/agent/tools-understand.ts`: `get_understanding_status`, `understand_media`.

## Agent tools

`createUnderstandTools({ status, start? })`. `status.stored(asset)` and `start(assetId)` are satisfied by `UnderstandService` (`stored` / `start`). `understand_media` waits for the run by default (`wait:false` returns at once), and without consent returns a `ToolError` telling the agent to ask the user to press Understand.

## Tests

`tests/understand-status.test.ts`, `tests/understand-pipeline.test.ts` (order, skip-done, cancel, failure isolation, consent gate, serialization), `tests/understand-tools.test.ts`, `e2e/understand.spec.ts` (test doubles, real analysis; never downloads a model).

## Not covered

Real Whisper/CLIP/MediaPipe through this button (each is covered by its own real-model spec), long media, and the pipeline across a page reload in a browser (status derivation is unit-tested; the e2e does not reload).
