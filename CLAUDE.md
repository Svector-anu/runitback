# CLAUDE.md

A local-first, in-browser video editor reconstructed from OpenCut (classic). Product spec and evidence live in `docs/` (start with `docs/RECONSTRUCTION_SPEC.md`; raw archaeology notes in `docs/research/`).

## Commands

```sh
pnpm install
pnpm dev            # http://localhost:5173
pnpm typecheck      # tsc --noEmit (strict, noUncheckedIndexedAccess)
pnpm lint           # eslint src tests e2e
pnpm test           # vitest: engine, persistence, render geometry, ui lib, architecture
pnpm e2e            # Playwright (Chromium): import -> edit -> play -> persist -> export
pnpm build          # typecheck + production bundle
```
`pnpm exec playwright install chromium` once before `pnpm e2e`. Gate before declaring work done: typecheck, lint, test, build, e2e.

## Architecture (see `docs/ARCHITECTURE.md`)

Layers, imports point downward only (enforced by `tests/architecture.test.ts`):

`engine` (pure) ← `render` ← `platform` ← `export` ← `app` ← `ui`

- `src/engine/` is framework- and DOM-free: time, model, timeline operations, animation, commands/history, `Editor`, playback state machine, persistence interfaces + save manager, captions, audio math, `buildFramePlan`. It must run in Node (headless).
- `src/render/` Canvas2D compositor, text/graphics/mask rasterizers. Consumes a `FramePlan`.
- `src/platform/` browser adapters: IndexedDB/OPFS, mediabunny probing/decoding, Web Audio scheduling, prefs (the only `localStorage` user).
- `src/export/` export pipeline (frame loop + offline audio mix + mux).
- `src/app/` composition root (`AppServices`), hooks, shortcuts wiring, preview renderer.
- `src/ui/` React components and CSS. No document state lives here.

## Domain model

`Project { metadata, scenes[], settings, timelineViewState, assetIds }`. `Scene.tracks = { overlay[], main, audio[] }` (display order overlay[0] top → main → audio). Elements: video, image, audio, text, graphic, effect; all have `startTime, duration, trimStart, trimEnd, sourceDuration?, params, animations?`. Media bytes are stored apart from the project (`AssetRepository`).

## Invariants — do not break

1. **Time is integer ticks** (`TICKS_PER_SECOND = 120_000`, branded `MediaTime`). Seconds only at I/O. Pixels derive from time: `px = ticks/120000 * 50 * zoom`; changing zoom never changes project time.
2. **Source mapping**: `sourceTime = trimStart + (t - startTime) * rate`; `trimStart + duration*rate + trimEnd == sourceDuration` for media with a source. `trimStart/trimEnd` are in source time, `duration` in timeline time.
3. **No overlap on a track.** Moves/inserts that would overlap create a new track or revert; nothing pushes or overwrites neighbours. Touching edges are fine. Main track: a clip at/before the earliest other clip starts at 0.
4. **Every document change is a `Command`** run through `Editor.execute`. Undo restores a whole-document snapshot (scene-aware). Continuous gestures use `editor.preview(cmd)` then `commitPreview()`/`discardPreview()`: previews are never in history or autosave.
5. **Reactors run inside the command**: ripple (when enabled) and pruning of empty overlay/audio tracks, so undo is one step.
6. **Preview and export share `buildFramePlan` + `Compositor`.** Never add rendering logic to only one of them.
7. **History is cleared on project load/close.**
8. **Persist through repositories only.** No `localStorage` outside `platform/prefs.ts`. Asset `fps`/`hasAudio` are persisted.
9. **Resources have owners**: object URLs, decoders, bitmaps, AudioContext are released in `MediaRuntime.dispose()` / engine `dispose()`.
10. No `any`, `@ts-ignore`, `console.log`. Functions with several parameters take an object.

## Media pipeline

Import: `probeMedia` (mediabunny) → quota check → `AssetRepository.save` (OPFS bytes + IndexedDB metadata) → `MediaRuntime.setBlob` → `editor.registerAsset`. Preview: `buildFramePlan` → `PreviewRenderer` → `Compositor.render` using `VideoFrameCache` (mediabunny `CanvasSink`, forward iteration within 2 s, else seek). Audio: `collectAudioClips` → `AudioEngine` schedules decoded buffers on the AudioContext clock (2 s lookahead, master limiter). Export: same plan per frame → `CanvasSource`; audio mixed with `OfflineAudioContext` through the same limiter → `AudioBufferSource`; MP4 (avc/aac) or WebM (vp9/opus).

## Editor state rules

- Read via `useEditorState` / `useTracks`; the effective document is `preview ?? doc`.
- Inspector/canvas edits go through `paramEditCommand`: a parameter with keyframes gets a keyframe at the playhead, otherwise its static value changes.
- Shortcuts are defined once in `engine/editor/actions.ts` and run by `runAction`; the UI calls `invokeAction`. They are suspended while typing, with an overlay open, or while rebinding.
- Schema changes need an additive migration in `engine/persistence/serialization.ts` (never delete/rename persisted fields) and a bump of `PROJECT_SCHEMA_VERSION`.

## Testing workflow

Write engine tests first (`tests/*.test.ts`, helpers in `tests/helpers.ts`: `tracksWith`, `video`, `makeEditor`). UI gestures and pixels are covered by Playwright (`e2e/`), which generates real media in the page (`e2e/media.ts`) — never mock the decoder or exporter. Fix the cause, not the assertion.
