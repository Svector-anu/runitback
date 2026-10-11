# Architecture

One TypeScript package, strict layering enforced by an automated boundary test (`tests/architecture.test.ts`). Dependencies point **downward only**.

```
src/
  engine/        PURE. No DOM, no React, no I/O; runs in Node. Enforced by tests/architecture.test.ts.
    time/        MediaTime ticks (120 000/s), rational FrameRate, frame snapping, timecode
    model/       Project/Scene/Track/Element/Asset types, param keys + defaults, factories, effect/graphic/mask definitions
    timeline/    tracks queries, placement, update pipeline, split, resize, group move + drop target, duplicate/paste,
                 ripple, snapping, selection hit-tests, zoom/ruler math, animation targets
    animation/   channels, bezier/linear/step evaluation, linear-light colour, split/clamp/clone, easing presets
    commands/    Command + CommandManager (history, reactors) and the concrete commands
    editor/      Editor facade (state, preview/commit, clipboard), Playback state machine, shortcut registry + runAction
    audio/       dB/gain math, audio clip collection, gain envelopes, source windows
    persistence/ repository interfaces, serialization + migrations, SaveManager, ProjectsService, quota, in-memory fakes
    captions/    SRT/ASS parsing, transcript chunking
    temporal/    per-asset temporal index (shots, loudness, silence, speech, rhythm on one source-time axis), `findMoments`, source-to-timeline mapping
    visual/      frame-embedding records, cosine ranking, frame spans and moment merging, frame sampling plan (no model code)
    render/      buildFramePlan: pure description of the frame at time t (shared by preview and export)
  render/        Canvas2D Compositor, text layout/draw, graphics, masks, preview bounds/snapping, caption elements
  platform/      Browser adapters: IndexedDB, OPFS, mediabunny probe + video/audio decoding, Web Audio scheduler/engine, fonts, prefs,
                 transcribe/ (on-device Whisper in a module worker; transcript store),
                 visual/ (on-device CLIP image+text encoders in a module worker; frame sampling via VideoFrameCache; embedding store)
  export/        planExport, offline audio mix, exportProject (mediabunny encode + mux)
  app/           Composition root (AppServices), hooks, router, shortcuts wiring, PreviewRenderer, param edit, insert helpers
  ui/            React components + CSS (editor, timeline, preview, assets, properties, pages, primitives)
```

Allowed imports (`engine <- render <- platform <- export <- app <- ui`): a layer may import from itself and layers to its left only.

## Key rules

1. **Single source of truth**: `Editor` holds immutable `EditorState` (`doc`, `preview`, `selection`, `viewState`, toggles). `doc = { scenes, currentSceneId, settings, assets }`. The UI subscribes with `useSyncExternalStore`; no component keeps document state. Playback time lives in `editor.playback` (separate store, high frequency).
2. **All mutations are commands.** `editor.execute(cmd)` runs `cmd.run(doc)`, then the reactors (ripple when enabled, pruning of empty overlay/audio tracks) in the same step, and records `{before, after}` whole-document snapshots (structural sharing). Undo/redo swap snapshots and switch to the scene that was edited.
3. **Preview/commit** for continuous gestures: `editor.preview(cmd)` evaluates the command against the committed doc into `state.preview` (not in history, not saved); `commitPreview()` executes the same command as one history entry; `discardPreview()` drops it.
4. **Time is an integer tick**; seconds appear only at I/O boundaries. Pixels derive from time: `px = ticks/120000 · 50 · zoom`.
5. **Rendering is a pure function of state and time**: `buildFramePlan({tracks, canvas, background, assets, time}) → FramePlan` (ordered draw items with every animated value resolved). `Compositor.render(plan, FrameSources)` draws it. Preview and export share both; they differ only in the `FrameSources` instance (separate decoder caches) and in what drives the clock.
6. **Persistence through repositories** (`ProjectRepository`, `AssetRepository`, `PrefsStore`) with in-memory fakes for tests. `SaveManager` (engine) debounces, retries with backoff, pauses while loading, flushes on exit. Assets are listed on the project (`assetIds`); bytes are swept only after a clean close.
7. **Side effects have owners with dispose()**: `MediaRuntime` (blobs, object URLs, video/image/audio decoders, waveform cache), `AudioEngine`, `PreviewRenderer`, `AppServices` (project lifecycle).
8. **Rust/WASM seam**: `Compositor.render(plan, sources)` and the frame plan are the boundary; a wgpu/WASM compositor can implement it without engine changes. Headless mode = engine + export (the exporter already runs on an `OffscreenCanvas` and takes plain `getBlob`).

## Data flow (drag a clip)

pointerdown on a clip → `startClipDrag` (ui/timeline/controllers) → each move: `computeDropTarget` + `resolveGroupMove` (engine, pure) → `editor.preview(moveElements(plan))` → only affected clips re-render → pointerup: `commitPreview()` executes `moveElements` → history entry, reactors → `SaveManager.markDirty` → 800 ms debounce → `ProjectRepository.save`. Escape or a refused plan calls `discardPreview()`.

## Speech-to-text (local-first)

`platform/transcribe` implements the engine's `Transcriber`: mediabunny decodes the asset's audio to 16 kHz mono blocks, `ChunkAssembler` cuts 30 s windows (20 s core + 5 s context each side, so memory stays bounded), a dedicated module worker runs `@huggingface/transformers` Whisper (`onnx-community/whisper-tiny.en_timestamped`, word timestamps, WebGPU else WASM), and `mergeChunkWords` keeps each word in the window whose core holds its midpoint. Aborting terminates the worker. The `_timestamped` export is required: the plain `whisper-tiny.en` export has no cross-attention outputs, so word timestamps fail. Transcripts persist in IndexedDB `runitback-transcripts` (`IdbTranscriptStore`). transformers.js is imported only inside the worker, so the main bundle is unaffected; the ONNX runtime wasm is served from this origin (`onnxruntime-web` is a direct dependency pinned to the version transformers.js expects) instead of the library's default CDN.

The model files come from Hugging Face on first use; that is the only network access and audio never leaves the device. `app/transcribe-service.ts` owns the consent gate: the Transcribe action (assets panel) shows a confirm dialog (model, approximate size, audio stays on device) and records consent in prefs; the agent's `transcribe_asset` goes through the same `gatedTranscriber` and fails with an "ask the user to press Transcribe" error until the model is cached or consent is given. E2E replaces the recogniser through the dev-only `window.__transcriber` hook; no model is downloaded in tests.

## Dependencies (minimal)

Runtime: react, react-dom, mediabunny (probing, decoding, encoding, muxing), @huggingface/transformers + onnxruntime-web (lazy, worker-only; local Whisper). Dev: vite, vitest, typescript 5.9 (typescript-eslint does not yet support TS 7), eslint, fake-indexeddb, happy-dom, Playwright. No UI kit, state library or router library (own primitives, external-store hooks, hash router).

## Decisions that differ from classic

See `docs/RECONSTRUCTION_SPEC.md` §D table. In addition: whole-document undo snapshots (not per-scene tracks); asset ids are persisted on the project; preview/commit uses the same command that is later executed, so redo and commit cannot diverge; the rendering seam is `Compositor`/`FramePlan` rather than a wgpu descriptor, so a WASM compositor can replace Canvas2D without touching the engine.

## Visual search (local-first)

`platform/visual` implements the engine's `VisualIndexer` and `VisualSearcher` with the same shape as speech: a module worker runs `@huggingface/transformers` CLIP (`Xenova/clip-vit-base-patch32`, int8, WASM, ONNX runtime self-hosted), `planFrameTimes` (engine) picks one frame per shot midpoint plus one every 2 s, `VideoFrameCache` decodes them, and normalised Float32 embeddings persist in IndexedDB `runitback-visual`. `app/visual-service.ts` owns the consent gate (shared `ModelConsent` with the transcribe service) and the Index visuals action; the agent's `index_visuals` / `find_visual_moments` use the same gated indexer and searcher. E2E replaces the models through the dev-only `window.__visual` hook. Details, model sizes, licence and score calibration: `docs/VISUAL_SEARCH.md`.

## Persistence additions

Derived per-asset data is purged through `DerivedDataRegistry` (platform) when media bytes are swept or a project is deleted, and projects export/import as `.runitback` bundles (`engine/persistence/bundle.ts` pure format and id remap; `platform/bundle*.ts` zip, hashing, orchestration). See `docs/PERSISTENCE.md`.
