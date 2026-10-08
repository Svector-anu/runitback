# Test Plan

Runner: Vitest (node env for `engine`, jsdom/happy-dom for UI units), Playwright for browser flows. Classic had tests only for placement, retime, params, fps, math, sticker id, mask snap (see research/06); the rebuild covers the areas it left untested: split, move, resize, ripple, snapping, ruler, drop target, interpolation, export planning, persistence.

## Unit and integration layers (Vitest, 286 tests)

| Area | File | What is asserted |
|---|---|---|
| time | `time.test.ts` | integer ticks, rounding, NTSC rates stay rational, frame snapping, seek clamp, last frame, timecode |
| placement | `placement.test.ts` | all five strategies, main-track start rule, insert indices, overlap, new-track zones |
| move | `move.test.ts` | track-at-y with gaps, drop targets, group move (offsets, mixed types, collisions → new track, revert), apply |
| split/resize/pipeline | `split-resize.test.ts` | retime-aware split, trims invariant, left/right retain, animation split, speed re-derivation + neighbour clamp, group resize bounds, frame snap |
| clipboard/ripple/snap/scale/ruler/selection | `clipboard-ripple-snap.test.ts` | duplicate, copy/paste placement, ripple diff, snap thresholds, zoom/slider/wheel math, ruler labels, box select |
| animation | `animation.test.ts` | linear/hold/bezier, extrapolation, linear-light colour, upsert/remove/retime, split subdivision, clamp, easing presets |
| editor + history | `editor.test.ts` | insert adopts canvas/fps in one step, undo/redo exactness, batch, preview/commit, reactors, ripple in one step, scene-aware undo, actions |
| persistence | `persistence.test.ts` | serialization round trip, validation, migrations, quota, ProjectsService, SaveManager debounce/retry/pause/flush |
| platform storage | `platform-storage.test.ts` | IndexedDB repositories (fake-indexeddb) with file store and blob fallback, fps/hasAudio persisted, prefs validation |
| audio | `captions-audio-playback.test.ts`, `audio-clips.test.ts`, `waveform.test.ts` | dB gain, volume line mapping, clip collection, envelopes, source windows, peaks, Playback state machine |
| captions | `captions-audio-playback.test.ts`, `captions-elements.test.ts` | SRT/ASS parsing, transcript chunking, caption element layout |
| frame plan | `frame-plan.test.ts` | active elements, source-time mapping, draw order, hidden, multi-track, effects/masks, blur sigma |
| render/preview geometry | `render-geometry.test.ts`, `preview-geometry.test.ts` | text layout, shape/mask geometry, blend mapping, hit testing, snapping |
| export plan | `export-plan.test.ts` | frame counts incl. NTSC, even dimensions, file names |
| ui lib | `ui/lib.test.ts` | expression evaluator, scrub sensitivity, split clamping |
| architecture | `architecture.test.ts` | layer imports, engine purity, localStorage ownership, no `any`/`@ts-ignore`/`console.log` |

## Browser E2E (Playwright, Chromium, 12 tests)

Media is generated inside the page with mediabunny (real VP9/Opus WebM), so the real decoder, compositor, audio scheduler and encoder run.

- `smoke`: create project, import, asset appears.
- `editor`: import → add to timeline → preview pixel → split (S) → undo/redo → delete → undo → play (playhead advances, frame changes) → autosave → reload restores; trim handle and drag-overlap → new track, undo.
- `features`: mask/invert/opacity change canvas pixels; text colour/size via inspector change pixels; keyframe diamond and undo; ruler seek + shortcuts + rebinding; projects page rename/duplicate/search/delete; playback schedules audio buffers; narrow viewport + dark theme.
- `export`: WebM export of an edited timeline decoded back (duration ≈ 2 s of a 4 s source, 320×180, audio present, sampled frame colour); MP4 (H.264) export when the browser can encode it.

## Gates

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm e2e`.
