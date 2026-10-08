# Implementation Audit

Audit of the implementation against **both** reference repositories:

- `OpenCut-app/OpenCut` @ `e668010` (current rewrite): a scaffold. It contributes direction (Rust core, Editor API, plugins, MCP, headless), not behavior. None of its README promises exist in code (`research/06`).
- `OpenCut-app/opencut-classic` @ `cf5e79e`: the product. All behavior comparisons below are against it.

Evidence: `pnpm typecheck`, `pnpm lint`, `pnpm test` (286 unit/integration tests), `pnpm build`, `pnpm e2e` (13 Playwright tests in Chromium, real decode/encode), and a clean-checkout install/test/build. Columns: **Impl** = ✅ implemented, ◐ partial, ✖ not implemented (reason).

## 1. Feature audit

### Projects and persistence

| Feature | Expected (classic) | Implemented | Impl | Tests | Limits / notes |
|---|---|---|---|---|---|
| Create/open/rename/duplicate/delete | Default 1080p/30fps project; duplicate names `(N) base` and copies media | Same; delete confirms; rename+delete also reachable from the editor menu (classic's were unreachable) | ✅ | `persistence`, `platform-storage`, e2e projects | Typed "DELETE" confirmation omitted (it was unwired in classic) |
| Projects page | grid/list, sort, search, multi-select, empty/no-result/loading states | Same incl. shift-range select and persisted view prefs | ✅ | e2e (rename/dup/search/delete) | Info dialog shows duration/dates/id |
| Autosave | 800 ms debounce, paused while loading, flush on exit | Same, plus retry with backoff, error status in header, flush on hide. `flush()` waits for an in-flight save, saves again until nothing is pending and rejects with `SaveFailedError` if the last save fails; `closeProject()` propagates that rejection and keeps the project open. View-only changes (scroll, zoom, playhead) use a separate `onViewChanged` channel and a 5 s debounce, never flag the project unsaved and never restart audio | ✅ | `regress-save-manager` ("waits for an in-flight save and also persists the edit made during it", "rejects when the final save fails instead of reporting success", "counts a save in flight as unsaved for the beforeunload guard", P1-4 tests), `regress-services` ("keeps the project open and its media when saving fails", "view-state writes do not restart audio during playback"), `hardening-state` ("setViewState fires onViewChanged but never onCommitted") | Classic dropped failed saves; ours retries. An earlier version of this row claimed "flush on exit" without handling an in-flight or failing save: it could close the project with the last edit unwritten |
| Persistence layout | project in IndexedDB, bytes in OPFS, prefs in localStorage | Same; IndexedDB-blob fallback if no OPFS (toast) | ✅ | `platform-storage` (both stores), e2e reload | OPFS class itself only exercised by Chromium e2e |
| Reopen restores view | zoom, scroll, playhead | Saved and restored | ✅ | e2e reload (clips); zoom/scroll by code path | Playhead/zoom restore asserted indirectly |
| Schema migrations | additive v31 chain | Runner + additive policy, schema v1 | ✅ | `persistence` | No historical chain (new schema) |
| Quota handling | 50 MiB headroom, toast | Same | ✅ | `persistence` (quota) | `navigator.storage.persist()` prompt not implemented |
| Project thumbnail | frame at t=0 | Rendered on close | ✅ | indirect (projects e2e) | |
| Scenes | create/rename/delete/switch, main undeletable | Same via dialog; switching is saved, not undoable | ✅ | `editor` (create/delete/main guard) | |
| Server auth/DB/feedback/blog | Next API, Postgres, Redis | Intentionally absent (editor never used them) | ✖ | – | Documented in spec §D/§I |

### Media

| Feature | Expected | Implemented | Impl | Tests | Limits |
|---|---|---|---|---|---|
| Import video/audio/image | MIME type, probe duration/size/fps/hasAudio, thumbnail, OPFS+IDB | Same (thumbnail 480×270 JPEG, not 1280×720); button, drag-drop onto panel or timeline, paste | ✅ | e2e (generated WebM), `platform-storage` | Image/audio probe only exercised via code path in e2e (video + audio-in-video) |
| fps handling | integer-rounded (29.97→30) | Rational NTSC kept | ✅ | `time` | Project fps comes from first media only (no later "ratchet up") |
| Asset panel | grid/list, sort, select, context delete, reveal, add button | Same | ✅ | e2e (add button, group role) | Lists are not virtualized |
| Waveform | peaks cache, 1px bars, volume line | Same | ✅ | `waveform` (peaks) | Drawn at ≤2048 px canvas width, stretched at extreme zoom |
| Remove asset | deletes dependent clips, one undo | Same; bytes and decoder caches are kept until the project closes so undo restores the clips *and* the asset | ✅ | `invariants-commands` ("removing an asset is one undoable step: undo restores asset and clips, redo removes them again", E7, E7b, "assetIds never drop an asset a scene still references") | Imports are never rewound by undo: history entries carry only the assets that command removed |
| Sounds library, stickers/flags | Freesound proxy, 254 SVG flags | Not built | ✖ | – | Need an API key / asset bundle; shapes covered by Graphics |

### Timeline

| Feature | Expected | Implemented | Impl | Tests | Limits |
|---|---|---|---|---|---|
| Track model, ordering, main permanent | `{overlay, main, audio}` | Same | ✅ | `placement`, `editor` | |
| Placement strategies, new-track fallback, no-overlap | 5 strategies | Same, all unit tested | ✅ | `placement`, `move` | |
| Select (click/toggle/box/all/Esc) | yes | yes; box select auto-scrolls | ✅ | `clipboard-ripple-snap`, e2e (click selects) | Shift is toggle, not range (as classic) |
| Move (group, snap, drop line, new track, revert, Esc) | yes | Live preview of the resolved result; one undo step | ✅ | `move`, e2e drag-overlap | Dragged clip snaps into rows instead of following Y pixel-exactly |
| Trim/resize (group, neighbours, source cap, min 1 frame) | yes | Same | ✅ | `split-resize`, e2e trim | |
| Split S/Q/W, retime-aware | yes | Same; animations subdivided exactly | ✅ | `split-resize`, `animation`, e2e | |
| Duplicate / copy / paste / delete | yes | Same | ✅ | `clipboard-ripple-snap`, `editor` | |
| Ripple | per-track diff, off by default | Same, one history step | ✅ | `clipboard-ripple-snap`, `editor` | |
| Snapping | 10 px, edges/playhead/keyframes/bookmarks, Shift, N | Same | ✅ | `clipboard-ripple-snap` | Scrub snapping ignores the toggle (as classic) |
| Zoom (wheel, buttons ×1.7, slider, anchor, persisted) | yes | Same | ✅ | `clipboard-ripple-snap` (math), e2e ruler | Button zoom asserted in e2e; wheel/slider gestures not driven |
| Ruler, playhead, click-seek, scrub, auto-follow | yes | Same | ✅ | `clipboard-ripple-snap`, e2e | |
| Track mute/hide, clip mute/hide, extract/recover audio | yes | Same | ✅ | `editor` | |
| Bookmarks (add, drag, note, colour, duration) | yes | Same (notes are not drawn on the preview) | ◐ | `editor` | Preview note overlay not built |
| Keyframe lanes/diamonds, drag, expand | yes | Diamonds on selected clip, drag-retime, expandable lanes, easing presets | ◐ | e2e (diamond+undo), `animation` | Box-select of keyframes and the free-form bezier handle editor are not built (presets only) |
| Context menus (clip, track) | yes | Same | ✅ | indirect | Replace media / freeze frame omitted (stubs in classic) |
| Transitions | none in either repo | none | ✖ | – | Not invented |

### Preview and playback

| Feature | Expected | Implemented | Impl | Tests | Limits |
|---|---|---|---|---|---|
| Frame from project state | scene graph → compositor | `buildFramePlan` → Canvas2D | ✅ | `frame-plan`, e2e pixels | GPU compositor not built (seam documented) |
| Source-time mapping, speed, trims | yes | yes | ✅ | `frame-plan`, `split-resize` | |
| Play/pause/seek, frame-snapped clock, ends at duration | yes | yes | ✅ | `captions-audio-playback` (Playback), e2e play | |
| Audio playback | WebAudio, 2 s lookahead, limiter | Same | ✅ | `audio-clips`, e2e (buffers scheduled) | A/V are not clock-locked (same as classic); no pitch preservation |
| Canvas presets/custom, background colour/blur | yes | yes (presets 16:9, 9:16, 1:1, 4:3, custom) | ✅ | e2e (aspect ratio + background colour) | Gradient backgrounds not implemented (solid colours + blur) |
| Preview zoom/pan/fullscreen | yes | yes | ✅ | none automated | Manual only |
| Transform handles, move, scale, rotate, snap | yes | corners, left/right/bottom, rotate handle, 8 px snap, 90° snap, Shift | ✅ | `preview-geometry` | Handle gestures not driven by e2e |
| Text inline edit | double-click | yes | ◐ | none automated | |
| Guides overlay, snapshot save/copy, bookmark notes, mask canvas handles | yes (partly commented out in classic) | not built | ✖ | – | OPTIONAL |

### Elements and inspector

| Feature | Implemented | Impl | Tests | Limits |
|---|---|---|---|---|
| Transform (pos/scale/rotate), opacity, 17 blend modes | all drive the frame plan; keyframable | ✅ | `frame-plan`, e2e opacity | Blend via `globalCompositeOperation` (Chromium supports all) |
| Volume dB, mute, volume line drag | yes | ✅ | `captions-audio-playback`, `audio-clips` | |
| Speed 0.01–5× | yes; duration re-derived, clamped by neighbour | ✅ | `split-resize` | "Change pitch" (maintainPitch) **not built**; field stored, UI hidden |
| Text (all classic properties) | yes | ✅ | `render-geometry`, e2e | Fonts beyond system list load from Google Fonts at runtime (needs network) |
| Graphics (rect, ellipse, polygon, star + stroke align) | yes | ✅ | `render-geometry` | |
| Effects: blur (clip + scene layer, reorder, toggle) | yes | ✅ | `frame-plan`, `editor` | Blur is isotropic `filter: blur()` (avg of x/y sigma) |
| Masks (rect, ellipse, diamond, heart, star, split, cinematic bars; feather/invert/stroke) | yes, first mask only | ◐ | `render-geometry`, e2e | Text and freeform masks not built; feather ≈ gaussian |
| Captions import SRT/ASS | yes; one command (`insertElementsOnLanes`), one undo step; overlapping cues get their own text tracks, 24 h / 5 MB caps | ✅ | `captions-*`, `regress-captions`, `hardening-state` ("caption import lands overlapping cues on separate tracks"), e2e `regressions-2` | Whisper transcription not built (≈100 MB model, worker) |
| Keyframes (linear/hold/bezier, colours in linear light) | yes | ✅ | `animation`, e2e | |

### History, shortcuts, export

| Feature | Implemented | Impl | Tests |
|---|---|---|---|
| Undo/redo, batch, preview/commit | document snapshots for tracks/scenes/settings, scene-aware, cleared on project load, capped at 500 entries. The asset list is **not** part of the snapshot (that was the original bug: undoing past an import dropped the asset): `removedAssets` travels with each history entry. Malformed or invariant-breaking commands are refused with a typed `EngineError` and leave state untouched; the UI uses `tryExecute` / `tryCommitPreview` and toasts `error.message` | ✅ | `editor`, `invariants-commands`, `invariants-fuzz`, `hardening-state` ("tryCommitPreview returns the rejection..."), `hardening-ui` ("toasts the error message and leaves the document untouched"), e2e |
| Shortcuts (all classic defaults, typable/overlay guards, rebind, reset) | yes; per-user bindings persisted | ✅ | `editor` (actions), e2e rebind |
| Export MP4 (H.264/AAC) / WebM (VP9/Opus), quality, audio toggle, progress, cancel, error+retry | yes | ✅ | `export-plan`, e2e (decoded output) | 
| Export resolution/fps | project canvas (even-rounded) / project fps | ◐ | `export-plan` | No picker (none in classic either) |

## 2. Source-to-product answers (final audit questions)

- **Does every major UI action produce a real domain-state change?** Yes: UI calls `editor.tryExecute/preview/tryCommitPreview` (through `runEdit`/`commitEdit`, which toast the engine's `error.message`) with commands; the architecture test forbids document state in `ui/`. Cosmetic-only controls: none shipped (freeze frame, replace media, transcription were omitted instead of stubbed).
- **Timeline time ↔ preview time?** Playback snaps to frames; `PreviewRenderer` renders `min(playhead, lastFrame)`; clip positions derive from `ticks → px`. Zoom changes only scale (unit-tested; e2e after zoom-driven layout changes).
- **Preview ↔ project state?** Preview consumes the same `effectiveDoc` (committed or in-gesture preview). e2e asserts pixels change for mask, invert, opacity, text colour/size, playback.
- **Undo restores state?** Snapshot identity of tracks, settings and scenes is asserted (`toBe`), including canvas/fps adoption, ripple, empty-track pruning, scene switching. Undo does **not** restore the asset registry from a snapshot: an earlier claim that it did was wrong and let undo drop freshly imported media. Today undo re-adds only assets removed by the undone command (`invariants-commands`: E7 "undoing past an import keeps the asset and its id in the saved project", E7b, "removing an asset is one undoable step", rollback tests) and the saved `assetIds` also include every asset a scene references or undo can restore.
- **Persistence restores projects?** Round trip unit-tested; e2e reloads and finds all clips. A project that is already damaged on disk (negative starts, null/NaN params, duplicate ids, overlapping clips, unreadable clips, impossible fps/canvas) still opens: `deserializeProject` repairs what is safely repairable, drops what cannot be read, saves the repaired project and the editor shows a one-time "Repaired N issues" toast (`hardening-state` P1-14 tests incl. a 300-case mutation fuzz, `hardening-services`, e2e `regressions-2` P1-14). Limitation: trim/source-length mismatches are tolerated, not repaired.
- **Multiple tracks coexist, clips move/trim?** Yes (unit + e2e).
- **Splitting preserves source-time semantics?** Invariant `trimStart + duration·rate + trimEnd == source` asserted for plain and retimed clips.
- **Derived resources cleaned up?** `MediaRuntime.dispose` releases decoders, bitmaps, object URLs, waveform caches; `AudioEngine.dispose` closes its context; exporter disposes its own caches in `finally`. No object URLs are created by the UI today (thumbnails are data URLs). Not verified with a heap profiler.
- **Race conditions?** Preview renders are coalesced (`busy/pending`); per-asset decoder access is serialised. Open and close are serialised through one queue in `AppServices` (the earlier statement that a project switch "awaits closeProject" was not true: two quick switches interleaved). Now the last requested project wins, a failed open does not wedge the queue, and each open project holds a cross-tab Web Lock. Imports are bound to the session that started them. Proof: `regress-services` ("the last requested project wins even when an earlier load finishes last", "StrictMode shape open, close, open ends with the project open exactly once", "a failed open does not wedge the queue and releases its lock", "refuses to open a project another tab holds", "does not register into a project opened while the import was probing"), `regress-locks-projects`, e2e `regressions.spec.ts` (P0-5, P1-2). The save manager serialises saves and re-queues edits made mid-save (`regress-save-manager`). Pointer gestures end on `pointerup`, `pointercancel` or window blur exactly once (`hardening-ui` "pointer gestures"; e2e `regressions-2` P1-9).
- **Seeking accuracy?** Seeks snap to the frame grid; `VideoFrameCache` returns the frame covering the requested source time. Verified via e2e pixel sampling after seek, not frame-number assertions.
- **Export represents the actual composition?** The e2e decodes the exported file: duration equals the *edited* 2 s (source 4 s), project dimensions, audio track present, frame colour matches the source at that time. Export reuses `buildFramePlan` and `Compositor`.

## 3. Known limitations (honest list)

1. No pitch-preserving speed change; audio at ≠1× plays/exports with pitch shift (like classic's streaming path).
2. No transcription, sounds library, stickers/flags, guides overlay, snapshot save, mask canvas handles, free-form easing editor, keyframe box-select, bookmark notes on preview, GPU/WASM compositor.
3. Export mixes the whole timeline's audio in memory (44.1 kHz stereo float): a 10-minute project needs ≈210 MB.
4. Browser support is Chromium-first (WebCodecs, OPFS, `ctx.filter`, `roundRect`). Firefox/Safari untested; unsupported codecs surface as an export/import error message.
5. Video frames are decoded sequentially per asset; the same asset used twice at once (different source times) thrashes its iterator.
6. Blur and mask feather are approximations of classic's GPU shaders (visually close, not pixel-identical).
7. Landing/marketing pages are minimal by design (blog, changelog, roadmap, sponsors are not part of the editor product).
8. e2e covers the main flows; preview handle gestures, wheel zoom, box select and keyframe dragging are covered only at the engine/geometry level.
9. Numeric parameters are clamped to per-definition bounds in the engine (`param-limits.ts`, the same table the inspector uses): blur 100, font size 500, canvas <= 8192 per side / 33 MP, fps 1..240. Font names must be plain family names; anything else is replaced with Arial and never requested from Google Fonts, and a font request gives up after 3 s (`hardening-state` P1-15, `hardening-ui` P1-16). Not done: an allowlist of Google families (a design decision), and the compositor itself does not re-clamp values it reads.

## 4. Architecture notes

- Engine is pure and headless-capable (`tests/architecture.test.ts` proves no DOM/React/storage); export already runs without UI imports, so a batch/headless entry point is a thin wrapper.
- Defects found in classic and fixed rather than copied are listed in `RECONSTRUCTION_SPEC.md` §D; defects found in *this* implementation by tests during development: click did not select a clip; playback clock never ticked; hover-only add buttons were `display:none` (removed from the accessibility tree); `<button>` nested in `<button>` (section headers) and interactive children inside `role=button` cards.
