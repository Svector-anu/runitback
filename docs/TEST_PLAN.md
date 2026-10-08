# Test Plan

Runner: Vitest (node env for `engine`, jsdom/happy-dom for UI units), Playwright for browser flows. Classic had tests only for placement, retime, params, fps, math, sticker id, mask snap (see research/06); the rebuild covers the areas it left untested: split, move, resize, ripple, snapping, ruler, drop target, interpolation, export planning, persistence.

## Layers

| Layer | Focus | Files (tests/…) |
|---|---|---|
| time | tick rounding, frame grid, rational fps (23.976/29.97/59.94 divide 120000), snapped seek, last frame | `time.test.ts` |
| model/factories | project/asset/element creation defaults, ids | `model.test.ts` |
| placement | all 5 strategies, main-track rule, insert indices, audio/overlay zones | `placement.test.ts` |
| move | group move, overlap→new track, revert, type compat, negative clamp, main start 0 | `move.test.ts` |
| resize | neighbours, source cap, min 1 frame, group delta, retime source delta, invariant `trimStart+dur·rate+trimEnd=src` | `resize.test.ts` |
| split | both/left/right, retime, names, animation subdivision, boundary no-op | `split.test.ts` |
| duplicate/paste/delete | new track, aboveSource, main rule, selection results | `clipboard.test.ts` |
| ripple | delete, shorten, moved-out ignored, joined subtract, per-track, split-left | `ripple.test.ts` |
| snapping | sources, threshold by zoom, closest wins, shift, toggle | `snapping.test.ts` |
| selection | click/toggle/box/all/peel | `selection.test.ts` |
| history | execute/undo/redo, batch order, redo cleared, preview/commit, scene-scoped, cleared on project switch, reactors | `history.test.ts` |
| playback mapping | playhead→visible elements, source-time, speed, overlapping tracks, hidden | `frame-plan.test.ts` |
| animation | linear/hold/bezier, extrapolation, colour linear-light, split/clamp, bake on last removal, paste rebase | `animation.test.ts` |
| params/inspector | each inspector setter yields command + frame-plan change | `inspector.test.ts` |
| audio | dB↔linear, effective gain (mute/track mute), retime source mapping, mix plan | `audio.test.ts` |
| serialization | roundtrip, date rehydration, audio buffer stripping, fps/hasAudio persisted, migrations | `serialization.test.ts` |
| persistence | repositories against fake-indexeddb + in-memory OPFS fake; save manager debounce/retry/pause/flush | `persistence.test.ts` |
| captions | SRT/ASS parse edge cases | `captions.test.ts` |
| render | compositor on `OffscreenCanvas`/node-canvas-free pure planning; pixel tests run in browser tests | `frame-plan.test.ts`, e2e |
| export | export plan (frame count/timestamps, audio mix length), cancel, mocked encoder; real encode in browser | `export-plan.test.ts`, e2e |
| architecture | forbidden imports per layer; no `any`; no localStorage outside `PrefsStore` | `architecture.test.ts` |
| ui | timeline math components (ruler ticks, drop line), shortcut dispatcher guards, panels | `ui/*.test.tsx` |

## Browser E2E (Playwright, Chromium with fake media)

`IMPORT → TIMELINE → EDIT → PLAY → EXPORT`: generated test media (synthetic MP4/WAV/PNG created in-test via mediabunny/Canvas), import, drag to timeline, split/move/trim, undo/redo, play and assert preview canvas pixels change with timeline time, reload and verify persistence, export and verify the downloaded file's duration/dimensions via mediabunny probe and a frame-sample check (not a re-download of the input).

## Gates

`pnpm typecheck && pnpm lint && pnpm test && pnpm build` must pass; `pnpm e2e` before the final audit.
