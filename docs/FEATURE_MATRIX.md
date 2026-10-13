# Feature Matrix

> Implementation status of every row below is tracked in `IMPLEMENTATION_AUDIT.md`.

Status: **CORE** (must ship, editor unusable without) · **ADVANCED** (ship, depends on core) · **OPTIONAL** (ship if time permits) · **LEGACY** (classic only, not rebuilt; reason given) · **PLANNED** (current-repo intent only) · **UNIMPLEMENTED** (exists nowhere; will not be faked) · **UNKNOWN** (source unclear).
Source column: **C** = opencut-classic, **N** = current OpenCut. Paths are under `apps/web/src/` of classic. Evidence for each row is in `docs/research/` (file noted in last column). "Impl" is updated in `IMPLEMENTATION_AUDIT.md`.

## 1. Project & persistence

| Feature | Status | Src | Observed behavior / acceptance criteria | Ref |
|---|---|---|---|---|
| Project create | CORE | C | Default: Main scene, 1920×1080, 30 fps, `#000`. AC: persisted, opens in editor. | 02§8 |
| Project list page | CORE | C | Grid/list, sort (createdAt/updatedAt/name/duration, asc/desc), name filter, multi-select (shift range), persisted view prefs. | 02§8, 05 |
| Rename / duplicate / delete project | CORE | C | Duplicate name `(N) base`; copies media; delete confirms. | 02§8 |
| Autosave | CORE | C | 800 ms debounce; pause during load; flush on exit; beforeunload prompt when dirty. Ours: retry on failure. | 02§5 |
| Reopen restores view | CORE | C | zoom, scrollLeft, playhead stored per project. | 01§3 |
| Thumbnail from t=0 | ADVANCED | C | Generated on exit/when missing. | 02§5 |
| Schema versioning/migrations | ADVANCED | C | Additive-only; ours starts at v1. | 02§5 |
| Storage quota handling / persist request | ADVANCED | C | 50 MiB headroom; toast on quota; `navigator.storage.persist()`. | 02§5 |
| Scenes (multiple) | ADVANCED | C | Create/rename/delete/switch; main scene undeletable. | 01§1 |
| Server auth/DB/feedback | LEGACY | C | Unused by editor; local-first rebuild omits. | 02§9 |
| Blog/changelog/landing pages | LEGACY/OPTIONAL | C | Landing minimal only. | 05 |

## 2. Media

| Feature | Status | Src | Behavior / AC | Ref |
|---|---|---|---|---|
| Import video/audio/image | CORE | C | Type by MIME; probe duration/size/fps/hasAudio; thumbnail; OPFS+IDB. AC: refresh keeps assets. | 04 |
| Asset panel (grid, search, remove) | CORE | C | Drag source; remove deletes dependent elements (one undo). | 05 |
| Reveal media from clip | ADVANCED | C | Scrolls assets, highlights 1.5 s. | 01§5 |
| Paste media | OPTIONAL | C | Ctrl+V with empty clipboard ingests files. | 02§4 |
| Waveform | CORE | C | Peaks cached per asset; drawn in audio clips (1px bars). | 04 |
| Video thumbnails on clips | CORE | C | Tile = trackHeight×16/9. | 01§5 |
| Sounds library (Freesound) | LEGACY | C | Needs server API key; excluded (documented). | 02§9 |
| Stickers (254 flag assets) | LEGACY | C | Asset bundle; shapes covered by Graphics. | 03 |

## 3. Timeline

| Feature | Status | Ref |
|---|---|---|
| Track model overlay/main/audio, display order, main undeletable | CORE | 01§0-1 |
| Time = integer ticks (120 000/s), frame rounding, FrameRate | CORE | 01§3 |
| Pixel↔time (`50·zoom` px/s), device-pixel snapping | CORE | 01§3 |
| Zoom: wheel/buttons×1.7/slider, bounds, playhead anchor, persisted | CORE | 01§3 |
| Ruler: adaptive labels `MM:SS`/`Nf`, virtualized | CORE | 01§7.4 |
| Playhead: handle drag, ruler scrub, click-seek, keyboard ±frame, follow on play | CORE | 01§7.4 |
| Selection: click/toggle/box/all/Esc peel | CORE | 01§5 |
| Placement resolver (explicit/firstAvailable/preferIndex/aboveSource/alwaysNew) | CORE | 01§6 |
| Move (group, drop target, new track fallback, revert) | CORE | 01§7.1 |
| Resize/trim (group, neighbours, source cap, min 1 frame, preview→commit) | CORE | 01§7.2 |
| Split S/Q/W with retime-aware math | CORE | 01§7.3 |
| Delete, duplicate (new track), copy/paste (aboveSource) | CORE | 01§7.7-8 |
| Snapping (10 px, edges/playhead/bookmark/keyframe, Shift off, N toggle) | CORE | 01§7.5 |
| Auto-prune empty tracks reactor | CORE | 02§1 |
| Track hide/mute, element hide/mute | CORE | 01§7.9 |
| Track context menu / element context menu | ADVANCED | 01§4-5 |
| Ripple editing (per-track diff, off by default) | ADVANCED | 01§9 |
| Bookmarks (add/drag/edit/note on preview) | ADVANCED | 01§7.12 |
| Edge auto-scroll while dragging | ADVANCED | 01§2 |
| Extract/recover source audio | ADVANCED | 01§7.10 |
| Empty-track dashed placeholder, drop line, snap indicator | CORE | 01§4 |
| Keyframe lanes expand/collapse, diamonds, drag | ADVANCED | 01§7.13 |
| Freeze frame (image-like still of the source frame, ripple insert) | ADVANCED (CapCut parity; classic had a disabled stub) | `docs/CAPCUT_PARITY.md` |
| Replace media | UNIMPLEMENTED | C stub | 01§5 |
| Transitions (dissolve, fade through black, slide L/R, wipe L/R, zoom) | ADVANCED (CapCut parity; new, not in classic) | `docs/CAPCUT_PARITY.md` |

## 4. Playback & preview

| Feature | Status | Ref |
|---|---|---|
| Play/pause/seek/stop, ends at duration, restart from 0 | CORE | 02§1 |
| Frame-accurate composition from project state at *t* | CORE | 03 |
| Video source-time mapping `trimStart + clipTime·rate` | CORE | 01§8 |
| Audio scheduling, master volume/mute, limiter | CORE | 04 |
| Canvas size presets 1920×1080/1080×1920/1080×1080/1440×1080 + custom | CORE | 03 |
| Preview zoom 0.25–16× over fit | ADVANCED | 03 |
| Transform handles (4 corners, left/right/bottom, rotate), 8 px snap, 90° snap, Shift disables | ADVANCED | 03 |
| Guides overlay (grid 1–24, platform safe zones) | OPTIONAL | 01§13 |
| Background color / blur | ADVANCED | 03 |
| Timecode display, ratio selector | CORE | 05 |
| Bookmark note overlay | OPTIONAL | 01§7.12 |

## 5. Elements & inspector

| Feature | Status | Ref |
|---|---|---|
| Transform: position X/Y, scale X/Y (link), rotation | CORE | 03 |
| Opacity, blend mode (17) | CORE | 03 |
| Volume dB, mute (clip), volume line drag | CORE | 01§7.11 |
| Speed 0.01–5×, maintain pitch | ADVANCED | 01§8 |
| Text element + properties | CORE | 03 |
| Graphics: rectangle, ellipse, polygon, star | ADVANCED | 03 |
| Effects: `blur` per clip + effect track element | ADVANCED | 03 |
| Masks (rectangle, ellipse, split, cinematic-bars, heart, diamond, star; feather/invert/stroke) | ADVANCED (basic set) / OPTIONAL (text, freeform) | 03 |
| Captions: SRT/ASS import → text elements | ADVANCED | 03 |
| Whisper transcription | OPTIONAL | 03 (needs ~100 MB model download; deferred, documented) |
| Crop (normalized edges, before transform) | ADVANCED (CapCut parity; new) | `docs/CAPCUT_PARITY.md` |
| Text stroke, drop shadow, typewriter reveal, in/out animation presets | ADVANCED (CapCut parity; new) | `docs/CAPCUT_PARITY.md` |
| Colour adjust effect (brightness, contrast, saturation, exposure, temperature, tint, vignette, sharpen) + 8 filter presets | ADVANCED (CapCut parity; new, not in classic) | `docs/CAPCUT_PARITY.md` |
| Project templates: versioned JSON recipe (slots, texts, beats, repeat groups, captions style), pure planner, one-undo apply, 8 shipped templates with generated previews, agent tools `list_templates` / `describe_template` / `apply_template` | ADVANCED (new; gallery UI separate) | `docs/TEMPLATES.md` |

## 6. Animation

| Feature | Status | Ref |
|---|---|---|
| Keyframe model: scalar/discrete/composite colour | CORE | 04 |
| Add/remove keyframe at playhead; value bakes on last removal | CORE | 02§3 |
| Interpolation linear/hold/bezier (bisection on time) | CORE | 04 |
| Retime keyframes (drag), copy/paste (fixed rebase) | ADVANCED | 04, 02§6 |
| Graph editor with 6 presets | OPTIONAL | 04 |
| Clip split subdivides curves exactly | ADVANCED | 04 |

## 7. Commands, history, shortcuts

| Feature | Status | Ref |
|---|---|---|
| Command objects + undo/redo snapshots, Batch, preview/commit | CORE | 02§2 |
| Default shortcut table (23 actions) | CORE | 02§4 |
| Typable/overlay/loading guards, physical-key letters | CORE | 02§4 |
| Rebindable shortcuts, import/export, dialog | ADVANCED | 02§4 |

## 8. Export

| Feature | Status | Ref |
|---|---|---|
| MP4 (avc/aac) and WebM (vp9/opus) via WebCodecs (mediabunny) | CORE | 04 |
| Quality presets ×4, audio toggle, project res/fps | CORE | 04 |
| Progress, cancel, download | CORE | 04 |
| Audio mix 44.1 kHz stereo, limiter, retime/volume/mute/keyframes honored | CORE | 04 |
| Export resolution picker | UNIMPLEMENTED in C (we may add; OPTIONAL) | 04 |

## 9. UI shell

| Feature | Status | Ref |
|---|---|---|
| Resizable panel layout + persisted sizes | CORE | 05 |
| Light/dark themes with classic tokens | CORE | 05 |
| Toasts, tooltips (500/200 ms), dialogs, dropdown menus (a11y) | CORE | 05 |
| Empty/loading/error states (project load, GPU degraded, migration) | CORE | 05 |
| Responsive drawer fallback | ADVANCED | spec§C |
| Rust/desktop/mobile shells | PLANNED | N |
| Editor API / plugins / MCP / headless | PLANNED | N (engine kept headless-capable) |
