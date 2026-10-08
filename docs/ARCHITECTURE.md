# Architecture

One TypeScript package, strict layering enforced by an automated boundary test (`tests/architecture.test.ts`). Dependencies point **downward only**.

```
src/
  ui/            React components, hooks, CSS. Only layer that imports react/DOM-for-UI.
  app/           Composition root: wires engine + platform adapters; React bindings (useEditor).
  platform/      Browser adapters: IndexedDB, OPFS, Web Audio, WebCodecs/mediabunny, File probing, localStorage.
  render/        Compositor(Canvas2D), frame builder, text rasterizer, effects/masks/blend, preview frame source.
  export/        Export pipeline (frame loop, audio mixdown, mediabunny muxing).
  engine/        PURE. No DOM, no React, no I/O. Everything testable in node.
    time/        MediaTime ticks, FrameRate, snapping math
    model/       Types: Project, Scene, Track, Element, Asset, Effect, Mask, Keyframe
    timeline/    placement, move, resize, split, duplicate, paste, ripple, snapping, selection hit-tests
    animation/   channels, interpolation, split/clamp
    commands/    Command interface, CommandManager (history), concrete commands
    editor/      Editor (facade/state container), playback state machine, selection, clipboard
    audio/       gain math (dB), retime math, mix planning (pure)
    persistence/ Repository interfaces + serialization + migrations (pure; adapters live in platform/)
    captions/    SRT/ASS parsing
```

Allowed imports: `ui → app → (platform, render, export, engine)`; `render, export → engine`; `platform → engine` (types/interfaces only); `engine → engine`. `engine/**` must not reference `window`, `document`, `React`, `indexedDB`, `AudioContext`.

## Key rules

1. **Single source of truth**: `Editor` (engine) holds immutable `EditorState` (`project`, `selection`, `playback`, `preview overlay`). UI subscribes with `useSyncExternalStore`; no component keeps document state.
2. **All mutations are commands.** `editor.execute(cmd)` records `{before, after}` tracks snapshot (structural sharing; cheap), selection override, then runs reactors (prune empty tracks, optional ripple) *inside the same history entry*. Undo restores the snapshot for the command's `sceneId`.
3. **Preview/commit** for continuous gestures: `editor.timeline.preview(updates)` → overlay (not in history/autosave); `commit()` pushes one entry; `discard()` drops it.
4. **Time is an integer tick**; seconds appear only at I/O boundaries. Pixels are derived: `px = ticks/120000 · 50 · zoom`.
5. **Rendering is a pure function of state and time**: `buildFrame(project, t, assets) → FramePlan` (ordered draw list with resolved params). `Compositor.draw(plan, sources)` consumes it. Preview and export share both; they differ only in the `FrameSourceProvider` (live `<video>` vs decoded frames).
6. **Persistence through repositories** (`ProjectRepository`, `AssetRepository`, `PrefsStore`); in-memory fakes used in tests. `SaveManager` (debounce, retry) lives in engine and talks to the repository interface.
7. **Side effects have owners with dispose()**: object URLs (`MediaUrlRegistry`), AudioContext, video pool, workers. Project close disposes all.
8. **Rust/WASM seam**: `Compositor` and `TimeMath` are interfaces; the WASM compositor classic ships can implement them without engine changes. Headless mode = engine + export with an offscreen `Compositor` (no UI imports).

## Data flow (drag a clip)

mousedown → `ElementDragController` (ui) → on move: `engine/timeline/computeMove(...)` (pure) → `editor.timeline.previewMove` → state overlay → React rerenders only affected clip → mouseup → `MoveElementsCommand` executed → history entry, reactors, `SaveManager.markDirty` → debounce → `ProjectRepository.save`.

## Dependencies (minimal)

React 19, Vite, TypeScript (strict), Vitest, fake-indexeddb (test), mediabunny (probing/decoding/encoding/muxing — replaces ffmpeg for browser), Playwright (browser E2E). No UI kit, no state library, no router library (tiny hash router).
