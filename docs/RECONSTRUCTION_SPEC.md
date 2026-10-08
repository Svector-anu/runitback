# RunItBack Specification (reconstructed from OpenCut)

Product-level specification derived from source archaeology of:

- **OpenCut (current)** `OpenCut-app/OpenCut` @ `e668010` — a ground-up rewrite that is, today, a scaffold (see §I).
- **opencut-classic** `OpenCut-app/opencut-classic` @ `cf5e79e` — the full historical editor (~91k lines TS + Rust/WASM compositor). It is the only usable source of product behavior.

Detailed evidence (file paths, constants, pseudo-code, uncertainty flags) lives in `docs/research/01..06-*.md`. This document is the product-level synthesis and records every *decision* where we deliberately differ.
Source hierarchy followed: source code → tests → subsystem docs → current repo → classic → README → inference. Where classic docs were stale (`docs/keyframes.md`, `docs/actions.md`) the code won.

---

## A. Product overview

RunItBack is a free, local-first, in-browser non-linear video editor. A user creates a **project**, imports **video / image / audio** files (never uploaded; stored in the browser), arranges them as **elements** on a multi-track **timeline**, adds **text, graphics, effects, masks, keyframe animation**, previews the composition live on a canvas, and **exports** MP4/WebM. Editing is non-destructive and undoable. The project survives refresh (IndexedDB + OPFS), autosaved.

Principles carried into the rebuild: local-first/private; engine logic is pure and UI-agnostic (classic's own migration direction: "apps are UI shells, logic is never in components"); all editor mutations are commands; time is an integer tick count.

## B. Core user journeys

| # | Journey | Observed behavior (classic) |
|---|---|---|
| 1 | Open app | `/` landing → `/projects`. Editor lives at `/editor/:id`. Missing id → auto-create "Untitled Project". |
| 2 | Create project | "New project" creates default project (Main scene, 1920×1080, 30 fps, black bg), persists, navigates to editor. |
| 3 | Import media | Drag OS files onto assets panel or timeline, or "Import" button, or paste. Type from MIME prefix. Probe metadata (duration, size, fps, hasAudio, thumbnail). Bytes→OPFS, metadata→IndexedDB. |
| 4 | Add to timeline | Drag asset onto track / new-track drop line. Empty timeline + visual asset → main track at playhead, and project canvas/fps adopt asset's. |
| 5 | Select | Click selects one; Shift/Ctrl/Cmd-click toggles; box-select from track background (additive with modifier); Ctrl+A; Esc peels selection kinds. |
| 6 | Move | Drag >5 px; time from mouse − grab offset; frame-rounded; snaps to element edges / playhead / keyframes within 10 px; Shift disables; overlap ⇒ falls onto a *new* track or reverts. Multi-selection moves as a group. |
| 7 | Trim / resize | Handles on selected clip; group-resize; capped by neighbours and un-trimmed source; min 1 frame; preview then single history entry. |
| 8 | Split | S at playhead (selected, or all under playhead); Q split+drop left; W split+drop right. Names " (left)"/" (right)". Retime-aware source spans. |
| 9 | Delete / duplicate / copy / paste | Delete; Ctrl+D onto brand-new track; Ctrl+C / Ctrl+V at playhead (in-memory clipboard). Empty overlay/audio tracks auto-pruned by a reactor. |
| 10 | Tracks | Add via drop; hide/mute per track; delete track (not main); display order overlay↓, main, audio. |
| 11 | Playhead / transport | Space/K play, J/L ±1 s, ←/→ frame, Shift+←/→ ±5 s, Home/End; drag handle or ruler to scrub; click empty area seeks. |
| 12 | Zoom | Ctrl/Cmd+wheel (exp), toolbar ×1.7 buttons, slider (exponential); playhead-anchored; scroll persisted. |
| 13 | Audio | Per-clip volume dB (−60…+20), mute, extract/recover source audio, waveform + volume line drag, master volume. |
| 14 | Text | Add text clip; edit content, font, size, color, align, weight/style/decoration, spacing, line height, background box; transform on canvas. |
| 15 | Effects | `blur` (intensity 0–100) as per-clip effect or scene-wide effect element. |
| 16 | Keyframes | Per-property diamonds at the playhead; linear / hold / bezier; drag in time; copy/paste; graph editor. |
| 17 | Undo/redo | Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y; snapshot of tracks per command; drags are preview→commit one entry. |
| 18 | Save / reopen | Autosave 800 ms debounce; projects page lists/sorts/filters/duplicates/deletes; reopening restores timeline + zoom/scroll/playhead. |
| 19 | Export | Dialog: format (mp4/webm), quality preset, audio toggle; progress, cancel; downloads file. |

## C. UI architecture

Editor page = header + 3-column × 2-row resizable panel layout (react-resizable-panels in classic; we build our own splitter).

| Region | Default size | Min/Max | Purpose |
|---|---|---|---|
| Header | h≈44 px | – | Project name (inline rename), menu (rename/duplicate/delete/export/shortcuts/exit), Export button (gradient `#2567EC→#37B6F7`), theme |
| Tools (left) | 25 % w | 15/40 | Tab rail: Assets, Text, Graphics (stickers), Effects, Sounds, Captions, Settings |
| Preview (center) | 50 % w | min 30 | Canvas with transform handles, guides, transport, timecode, zoom, canvas-size/ratio |
| Properties (right) | 25 % w | 15/40 | Inspector: tabs per element type (transform, text, speed, audio, effects, masks, keyframes) |
| Main content / Timeline | 50 / 50 % h | main 30–85, timeline 15–70 | Timeline: toolbar (h40), labels column 112 px, ruler 22 px, bookmarks row 16 px, tracks |

Panel sizes persist (`panel-sizes`). Resize handle: 1 px line, 4 px hit area. Fonts: Inter; scale xs .72rem / sm .79rem / base .92rem; radii .35/.65/.82 rem; primary `hsl(200 90% 52%)`; `.panel` surfaces slightly offset from page. Full token sets in `research/05-ui-design.md`. Icons: one icon set (we use inline SVG icons authored in-repo to avoid a heavy dependency).

Shortcut table: `research/02-core-persistence.md §4` (adopted verbatim; including "disabled in typable targets / overlays / loading").

Responsive: desktop-first. Below ~900 px width the panel layout collapses to preview + timeline stacked with the tools/properties in switchable drawers; the editor never reflows into a mobile-style single-column timeline. Classic shows a "mobile not supported" acknowledgement; we retain desktop-first and add the drawer fallback.

## D. Domain model

Adopted from classic (types in `research/02 §7`), with decisions:

```
Project { metadata{id,name,thumbnail?,duration,createdAt,updatedAt}, scenes[], currentSceneId,
          settings{fps:FrameRate, canvasSize, canvasSizeMode, originalCanvasSize?, background}, version, timelineViewState }
Scene   { id,name,isMain,tracks:SceneTracks,bookmarks[] }
SceneTracks { overlay: OverlayTrack[]; main: VideoTrack; audio: AudioTrack[] }   // display: overlay[0..], main, audio[0..]
Track   { id,name,type: video|text|audio|graphic|effect, elements[], muted?/hidden? }
Element { id,name,startTime,duration,trimStart,trimEnd,sourceDuration?,params,animations?, retime?, effects?, masks? }
  kinds: video | image | audio(upload|library) | text | sticker | graphic | effect
MediaAsset { id,name,type,size,lastModified,width?,height?,duration?(s),fps?,hasAudio?,thumbnailUrl? , file }
Effect {id,type,params,enabled}   Mask {id,type,params}
Animation: per-path channels (scalar keys w/ bezier handles | discrete), composite colour channels
Bookmark {time,note?,color?,duration?}
Selection {elements[],keyframes[],anchor,maskPoints}
History: command stack of whole-tracks snapshots; Playback: {isPlaying,currentTime,volume,muted,isScrubbing}
ExportJob {options{format,quality,includeAudio}, progress, state, result}
```

`Sequence` in the task's vocabulary ≙ classic `Scene`. `AudioAsset/ImageAsset/VideoAsset` ≙ `MediaAsset.type`. `Marker` ≙ `Bookmark`. `Transition` **does not exist in classic** (UNIMPLEMENTED; we do not invent it).

### Decisions diverging from classic (defects we will not reproduce)

| Classic behavior | Decision |
|---|---|
| History never cleared on project switch | History is scoped to the open project; cleared on load/close. |
| Tracks-snapshot undo writes into whichever scene is active | Commands carry `sceneId`; undo targets that scene (and switching scene is also a command-free state change that does not leak). |
| `fps`, `hasAudio` not persisted for assets | Persisted. Test: round-trip. |
| First-element canvas/fps change outside history | Folded into the same command (single undo step restores). |
| Failed autosave dropped silently | Dirty flag preserved on failure; retry with backoff; surfaced in UI. |
| Keyframe paste uses playhead as element-local time | Subtract element start. |
| Migration runner adapter bug | Own persistence layer, versioned, additive migrations. |
| Imported video fps rounded to integer (29.97→30) | Keep rational fps where `120000 % tpf == 0`. |
| "N elements selected.0", unwired "Type DELETE", unreachable rename/delete dialogs, unused font picker | Fixed / wired. |
| Changing speed can create overlaps (no guard) | Speed change that would overlap is clamped to neighbour (documented). |

## E. State transitions (representative)

```
IMPORT VIDEO
 → File → type by MIME → probe (mediabunny): duration, display size, fps, hasAudio, canDecode
 → thumbnail (JPEG q0.8 ≤1280×720)
 → quota check (50 MiB headroom) → OPFS write bytes → IndexedDB metadata → add to MediaStore (+object URL)
 → appears in Assets panel
DROP ON TIMELINE
 → resolveDropTarget(y, x, type) → resolveTrackPlacement(strategy) → [AddTrack?]+InsertElement (BatchCommand)
 → element{startTime=frameRound(x), duration=asset.duration ticks, trims 0, sourceDuration=duration}
 → first visual element: canvasSize/fps adopt asset (same command)
 → reactor prunes empty tracks; save manager marked dirty → 800 ms → persist
 → preview re-renders (frame at playhead), duration recomputed
```
All other transitions: see `research/01` (move, resize, split, ripple, duplicate, paste, delete, extract audio) and `research/02 §3` (command semantics). They are normative.

## F. Rendering model

Frame at time *t* (classic `scene-builder`/compositor, summarized from `research/03`):
1. Layer order bottom→top: main track then overlay tracks reversed (overlay[0] is top); within a track by `startTime`. Hidden tracks/elements skipped.
2. Visible if `start ≤ t < start+duration`. Video source time = `trimStart + (t − start)·rate`.
3. Per layer: transform (position in canvas px from center, scale 1 = contain-fit, rotate°, scaleX/Y), opacity, per-clip effects, mask (first mask only), blend mode (17 modes).
4. Scene-wide `effect` elements apply to everything drawn so far.
5. Background: color or blurred first video. Clear color opaque black.
6. Text: font size scaled by `canvasHeight/90`.
7. All animated params resolved at element-local time before drawing.

Our implementation: a `Compositor` interface with a **Canvas2D** implementation (`globalCompositeOperation` for blends, `ctx.filter` for blur, offscreen canvas `destination-in` for masks). The interface is the seam where the Rust/wgpu/WASM compositor classic used can later be dropped in (§Phase 3 of the task).

Preview sources: `HTMLVideoElement` pool per asset, seeked to mapped source time during scrub; during playback driven by a frame scheduler. Preview and export share the same `buildFrame(project, t)` pure function (resolves *what* to draw) and differ only in how pixels for each source are acquired (live video element vs. mediabunny decoded frame).

Playback clock: wall clock (`performance.now()` + rAF) snapped to the frame grid; audio scheduled on `AudioContext` clock from an anchor at play/seek (2 s lookahead), master limiter. (Classic's two clocks are not locked; we resync audio on drift > 80 ms.)

## G. Persistence model

| Data | Store | When |
|---|---|---|
| Project document | IndexedDB `projects` (`ProjectRepository`) | autosave 800 ms debounce; create/rename/duplicate |
| Media bytes | OPFS dir per project (`AssetRepository`) | on import |
| Media metadata | IndexedDB per project (`AssetRepository`) | on import |
| UI prefs (panel sizes, snapping, ripple, keybindings, view mode) | localStorage via one `PrefsStore` | on change |
| History, clipboard, selection, playback | memory only | – |

`ProjectRepository`, `AssetRepository` are interfaces with IndexedDB/OPFS implementations and in-memory fakes (tests, and fallback if OPFS unavailable, with a visible warning). Project schema versioned (`version`), additive migrations only. `HistoryRepository` is in-memory (classic does not persist history; decision: keep).

## H. Performance model

- Timeline elements and ruler ticks are virtualized (ruler: visible range ± buffer); playhead moves imperatively during playback.
- Thumbnails: JPEG data URLs; timeline clip tiles via asset thumbnail repeat.
- Waveforms: decode audio once per asset, cache peak summary (cache cleared when asset removed).
- Video element + decoded-frame caches keyed by asset id; released on asset removal / project close; object URLs revoked.
- Preview renders at project canvas size scaled with CSS; previews use the same engine function as export.
- Autosave debounced; media saved immediately and not through autosave.

## I. Compatibility gaps (current rewrite vs classic)

The current repo (verified in `research/06`) implements none of its README promises: web = TanStack Start `/` (hello world) and `/editor` ("Coming soon") + shadcn primitives; api = Elysia `/`, `/health`, `/echo`; desktop = GPUI window with four empty panels; `crates/media` = FFmpeg 8.1.3 pin/setup only; no tests, no lint config; Cargo workspace crates commented out. Absent vs classic: **every editor feature**, projects pages, storage, the Rust time/compositor/effects/masks/gpu crates, blog/changelog, Postgres/Auth/Redis, 31 storage migrations. Therefore classic defines the product; the current repo contributes only direction (Rust core, plugin/MCP/headless intentions → we keep engine UI-free and command-based so an Editor API/headless mode can be added).

Things classic never implemented (will not be faked): transitions, freeze frame, reverse, speed ramps, crop, text stroke/shadow, per-clip color grading beyond opacity/blend, effects other than blur, multi-mask, proxy media, collaborative editing.
