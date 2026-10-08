# OpenCut classic: timeline subsystem notes

Root: `apps/web/src` (abbreviated `src/`) in `/private/tmp/claude-502/-Users-mac-Desktop-coding-oss/df69066e-3e6c-4409-9706-c5dd5916da46/scratchpad/ref-classic/repo`. Rust time crate: `rust/crates/time/src/`.
All claims come from files I actually read. Line refs are given where I captured them; otherwise function names. "UNREAD" marks things I did not open.

---------------------------------------------------------------------
## 0. Headline surprises (read first)

1. Time unit is an integer tick, `TICKS_PER_SECOND = 120_000` (rust/crates/time/src/media_time.rs:9; TS re-export `src/wasm/media-time.ts`). `MediaTime` is a branded integer (`number & {__mediaTime}`); constructing a non-integer throws. All rounding goes through `roundMediaTime`/`mediaTimeFromSeconds`. 120000 is divisible by 23.976/24/25/29.97/30/48/50/59.94/60/120 fps frame sizes (ticks per frame: 5005, 5000, 4800, 4004, 4000, 2500, 2400, 2002, 2000, 1000; frame_rate.rs tests). `FrameRate` = `{numerator, denominator}`; `ticks_per_frame` returns None (so TS falls back to unrounded time) if 120000*den % num != 0.
2. Track model is NOT a flat array: `SceneTracks = { overlay: OverlayTrack[]; main: VideoTrack; audio: AudioTrack[] }`. Exactly one "main" video track that can never be deleted; display order top-to-bottom = `[...overlay, main, ...audio]`. Overlay index 0 is the TOPMOST layer (renderer reverses it: `scene-builder.ts:238-243`, bottom-to-top = reversed [overlay..., main]).
3. There is NO overlap resolution by pushing/trimming/overwriting. If a drag/move/insert would overlap on a track, the system falls back to creating a NEW track (or refuses). Overlap = strict interval intersection (`start < otherEnd && end > otherStart`); touching edges are allowed.
4. The main track has a "must start at 0" rule only: if the requested start is <= the earliest other main-track element's start (or the track is empty) the start is forced to 0. It is NOT magnetic and does not close gaps.
5. Ripple editing exists but is implemented as a generic post-command diff (`ripple/`), toggled in the store/toolbar, with NO default keyboard shortcut. It only reacts to deleted elements or shortened end-times (see section 9).
6. Delete does not ripple unless ripple mode is on. Duplicate and Copy/Paste NEVER overlap-resolve onto the same track: duplicates always go on a brand-new track.
7. Speed ("retime") is a constant rate only (`RetimeConfig {rate, maintainPitch?}`); rate clamp [0.01, 5]. There is a leftover hook for `mode === "curve"` in audio-manager but no type for it. Changing rate changes element `duration` (not trims).
8. Split keeps both halves' `name` suffixed " (left)" / " (right)"; duplicate suffixes " (copy)"; paste does NOT rename.
9. Snap threshold is 10 screen px converted to ticks (zoom-dependent). Shift disables snapping for drag, resize, scrub.
10. Undo history entry per command; drag-move/resize/volume use a preview overlay that is committed as one command (`TracksSnapshotCommand` for `commitPreview`, `UpdateElementsCommand` for resize).

---------------------------------------------------------------------
## 1. Core data types (copied from `src/timeline/types.ts`)

```ts
export type ElementRef = { trackId: string; elementId: string };

export interface Bookmark {
  time: MediaTime;
  note?: string;
  color?: string;
  duration?: MediaTime;
}

export interface TScene {
  id: string; name: string; isMain: boolean;
  tracks: SceneTracks; bookmarks: Bookmark[];
  createdAt: Date; updatedAt: Date;
}

export type TrackType = "video" | "text" | "audio" | "graphic" | "effect";
interface BaseTrack { id: string; name: string }
export interface VideoTrack   extends BaseTrack { type:"video";   elements:(VideoElement|ImageElement)[]; muted:boolean; hidden:boolean }
export interface TextTrack    extends BaseTrack { type:"text";    elements:TextElement[]; hidden:boolean }
export interface AudioTrack   extends BaseTrack { type:"audio";   elements:AudioElement[]; muted:boolean }
export interface GraphicTrack extends BaseTrack { type:"graphic"; elements:(StickerElement|GraphicElement)[]; hidden:boolean }
export interface EffectTrack  extends BaseTrack { type:"effect";  elements:EffectElement[]; hidden:boolean }
export type OverlayTrack = VideoTrack | TextTrack | GraphicTrack | EffectTrack;
export interface SceneTracks { overlay: OverlayTrack[]; main: VideoTrack; audio: AudioTrack[] }

export interface RetimeConfig { rate: number; maintainPitch?: boolean }

interface BaseTimelineElement {
  id: string; name: string;
  duration: MediaTime;      // on-timeline length
  startTime: MediaTime;     // timeline position
  trimStart: MediaTime;     // SOURCE-time amount cut from head
  trimEnd: MediaTime;       // SOURCE-time amount cut from tail
  sourceDuration?: MediaTime;
  animations?: ElementAnimations;
  params: ParamValues;      // e.g. volume (dB), muted, opacity, transform.*, text params
}
VideoElement  { type:"video"; mediaId; isSourceAudioEnabled?; hidden?; retime?; effects?; masks? }
ImageElement  { type:"image"; mediaId; hidden?; effects?; masks? }
TextElement   { type:"text"; hidden?; effects? }
StickerElement{ type:"sticker"; stickerId; intrinsicWidth?; intrinsicHeight?; hidden?; effects? }
GraphicElement{ type:"graphic"; definitionId; hidden?; effects?; masks? }
EffectElement { type:"effect"; effectType: string }            // no hidden flag
AudioElement  = {type:"audio"; buffer?: AudioBuffer; retime?} & ({sourceType:"upload"; mediaId} | {sourceType:"library"; sourceUrl})

// Capability groups
MASKABLE_ELEMENT_TYPES  = video, image, graphic
RETIMABLE_ELEMENT_TYPES = video, audio
VISUAL_ELEMENT_TYPES    = video, image, text, sticker, graphic   (only these can be hidden / have effects)

// Drag / drop
interface DropTarget { trackIndex:number; isNewTrack:boolean; insertPosition:"above"|"below"|null; xPosition:MediaTime; targetElement:{elementId;trackId}|null }
type ElementDragView = {kind:"idle"} | {kind:"dragging"; anchorElementId; trackId; memberTimeOffsets: ReadonlyMap<string,MediaTime>; startMouseX/Y; startElementTime; clickOffsetTime; currentTime; currentMouseX/Y; dropTarget: DropTarget|null}
```

Element -> track-type mapping (`placement/compatibility.ts`): audio->audio, text->text, sticker->graphic, graphic->graphic, effect->effect, video->video, image->video. An element can only live on a track of its mapped type. (Note: video track holds video+image; graphic track holds sticker+graphic.)

Total duration (`timeline/index.ts calculateTotalDuration`) = max over all tracks/elements of `startTime + duration` (0 if none). Note hidden/muted do not affect it.

Scene defaults (`timeline/scenes.ts buildDefaultScene`): `overlay: [], main: {name:"Main Track", type:"video", elements:[], muted:false, hidden:false}, audio: [], bookmarks: []`. Exactly one scene must be `isMain`; main scene cannot be deleted ("Cannot delete main scene"); fallback after delete = main scene. Scene selector lives in the toolbar centre.

Default track names (`timeline/tracks.ts`): "Video track", "Text track", "Audio track", "Graphic track", "Effect track". Main track name constant `MAIN_TRACK_NAME = "Main Track"`.

Persisted view state (`project/types.ts:38 TTimelineViewState`): `{zoomLevel, scrollLeft, playheadTime}`; default `{zoomLevel:1, scrollLeft:0, playheadTime:0}` (`timeline/defaults.ts`). Project default fps `DEFAULT_FPS = 30/1` (`src/fps/defaults.ts`).

---------------------------------------------------------------------
## 2. Constants

| Constant | Value | File |
|---|---|---|
| TICKS_PER_SECOND | 120000 | rust media_time.rs:9 |
| BASE_TIMELINE_PIXELS_PER_SECOND | 50 | timeline/scale.ts |
| TIMELINE_ZOOM_MIN (fallback only) | 0.1 | scale.ts |
| TIMELINE_ZOOM_MAX | 100 | scale.ts |
| Track heights (px) | video 65, text 25, audio 50, graphic 25, effect 25 | components/layout.ts |
| KEYFRAME_LANE_HEIGHT_PX | 20 | layout.ts |
| KEYFRAME_DIAMOND_SIZE_PX | 14 | layout.ts |
| EXPANDED_GROUP_HEADER_HEIGHT_PX | 18 (unused in what I read) | layout.ts |
| TIMELINE_TRACK_GAP_PX | 6 | layout.ts |
| TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX | 112 | layout.ts |
| TIMELINE_RULER_HEIGHT_PX | 22 | layout.ts |
| TIMELINE_BOOKMARK_ROW_HEIGHT_PX | 16 | layout.ts |
| TIMELINE_SCROLLBAR_SIZE_PX | 12 | layout.ts |
| TIMELINE_CONTENT_TOP_PADDING_PX | 2 | layout.ts |
| TIMELINE_DRAG_THRESHOLD_PX | 5 | components/interaction.ts |
| TIMELINE_HORIZONTAL_WHEEL_STEP_PX | 40 (per-event clamp) | interaction.ts |
| TIMELINE_ZOOM_BUTTON_FACTOR | 1.7 | interaction.ts |
| TIMELINE_ZOOM_ANCHOR_PLAYHEAD_THRESHOLD | 0.15 (slider fraction) | interaction.ts |
| Snap threshold | 10 px => `10 / (50*zoom) * 120000` ticks | snapping/threshold.ts |
| TIMELINE_INDICATOR_LINE_WIDTH_PX (playhead, snap line) | 2 | pixel-utils.ts |
| Z-layers | trackContent 10, dragLine 20, playhead 30, snapIndicator 40 | components/layers.ts |
| TRACKS_CONTAINER_MAX_HEIGHT | 800 px (tracks area height clamp) | components/index.tsx |
| FALLBACK_CONTAINER_WIDTH | 1000 px | index.tsx, zoom-utils |
| DEFAULT_NEW_ELEMENT_DURATION | 5 s (600000 ticks) | creation.ts |
| Min element duration on resize | exactly 1 frame: `round(120000*fps.den/fps.num)` ticks | group-resize/compute-resize.ts |
| RETIME: DEFAULT 1, MIN 0.01, MAX 5 | | retime/rate.ts |
| VOLUME_DB_MIN / MAX | -60 / +20 dB (default volume 0 dB) | timeline/audio-constants.ts, defaults.ts |
| Edge auto-scroll | threshold 100 px, max speed 15 px/frame (rAF), linear intensity | hooks/use-edge-auto-scroll.ts |
| Keyframe indicator min element width | 40 px (below that, indicators hidden) | timeline-element.tsx |
| ELEMENT_RING_WIDTH_PX | 1.5 | timeline-element.tsx |
| THUMBNAIL_ASPECT_RATIO | 16/9 (tile width = trackHeight*16/9) | timeline-element.tsx |
| Scroll-state save debounce | 300 ms | zoom-controller.ts |
| Seek click gesture | dx<=5, dy<=5, dt<=500ms | seek-controller.ts |
| Ruler: MIN_LABEL_SPACING_PX 120, MIN_TICK_SPACING_PX 18 | | ruler-utils.ts |
| Waveform: BAR_WIDTH 1, BAR_GAP 1, gain sample count 200, burn colour rgba(255,110,20,.9) | | audio-waveform.tsx |

Element colours (`components/theme.ts`): video/image = transparent (thumbnail tiles), text `#5DBAA0`, audio `#8F5DBA`, graphic/sticker `#BA5D7A`, effect `#5d93ba`. Waveform `rgba(255,255,255,0.7)`. Selected track row bg `bg-accent/50`. Default bookmark colour `#009dff`.

---------------------------------------------------------------------
## 3. Coordinate / time math

```
pixelsPerSecond = 50 * zoom
timeToPixels(ticks, zoom) = ticks/120000 * pixelsPerSecond
snapPixelToDeviceGrid(px) = round(px*dpr)/dpr        // all element lefts/ticks/playhead use this
playhead/snap line left = centerPx - 1 (2px wide, centred)
mouseTime(clientX) = max(0, (clientX - containerRect.left + scrollLeft)/(50*zoom)) * 120000, rounded
contentWidth = timeToPixels(totalDuration, zoom)
dynamicTimelineWidth = max(contentWidth + paddingPx, containerWidth)
```

Zoom bounds (`zoom-utils.ts`):
```
minZoom = min(100, (containerWidth*0.25) / (max(durationSec,1) * 50))   // content fills 25% of width at min zoom
paddingPx(zoom) : zoomPercent = (zoom-minZoom)/(100-minZoom)
                  t = min(zoomPercent/0.2, 1)
                  ratio = 0.75 - (0.75-0.15)*t        // 75% of viewport padding at min zoom -> 15% at >=20% zoom
                  padding = containerWidth*ratio
slider (0..1, step .005) <-> zoom exponential: zoom = minZoom * (100/minZoom)^p ;  p = ln(zoom/minZoom)/ln(100/minZoom)
```
Initial zoom = saved view-state zoom clamped, else minZoom. Zoom is clamped to [minZoom, 100] on every set; if minZoom grows above current zoom (timeline shrinks), zoom is pushed up.

Zoom inputs:
- Ctrl/Cmd + wheel (non-passive capture listener on timeline; prevents browser zoom): `delta = deltaMode===1 ? dy*16 : dy; accumulate per rAF; capped = sign*min(|d|,30); zoom *= exp(-capped/300)`.
- Toolbar zoom buttons: x1.7 / ÷1.7 (clamped). Slider in toolbar (w-28).
- Shift or |dx|>|dy| wheel => horizontal scroll, `clamp ±40px` per event. Plain wheel => vertical scroll of tracks. Ruler/labels scroll followers are synced imperatively.
- Zoom anchoring (`zoom-controller.applyZoomLayout`): when slider fraction >= 0.15, scroll is adjusted so the PLAYHEAD keeps its viewport offset (`nextScrollLeft = playheadPxAfter - (playheadPxBefore - scrollLeft)`, clamped). Crossing from >=0.15 down to <0.15 restores the scroll saved when it was crossed upward. Below 0.15, scrollLeft is unchanged.
- On first mount with tracks, tracks scroll to the bottom (`use-initial-scroll-bottom.ts`).
- Persist `{zoom, scrollLeft, playheadTime}` to project: on zoom change immediately; on scroll debounced 300ms; on scrub end / click-seek.
- Restoring: seek playhead to saved `playheadTime` once; restore scrollLeft once scrollWidth > 0 (ResizeObserver).

Frame rounding helpers (rust `media_time.rs`):
- `round_to_frame`: nearest frame, ties up (remainder*2 >= tpf).
- `snapped_seek_time(time, duration, fps) = clamp(round_to_frame(time), 0, duration)`. NOTE: can land on `duration` exactly (end of timeline), not last frame.
- `last_frame_time(duration) = floor_to_frame(duration-1 tick)` (0 if <=0). Used by `timeline.getLastFrameTime()` (e.g. for playback end).

---------------------------------------------------------------------
## 4. Layout of the timeline UI (`timeline/components/index.tsx`)

Structure (top to bottom): panel with border, rounded-sm.
1. Toolbar (h-10, border-b, scroll-hidden): LEFT buttons, CENTRE scene selector (SplitButton: scene name + Layers icon opening scenes list), RIGHT snapping/ripple/zoom.
2. Body: left column `TrackLabelsPanel` (112px, border-r) + right main area.
3. Right area: ruler row (22px) then bookmark row (16px) (both live in one horizontally-scrolled header div that follows the tracks' scrollLeft), then tracks ScrollArea, then playhead overlay (absolute), SelectionBox, two DragLine overlays, and `SnapIndicator` (absolute on the whole timeline body).
4. Track rows are absolutely positioned: `top = 2 + sum(prevTrackHeights + extra + 6 gap)`. Track container height = clamp(totalTracksHeight, 0..800) + 2. A flex-1 "gutter" under tracks catches clicks (clear selection / box select).
5. Rows that contain dragged elements are sorted to the END of the render list so dragged clips paint on top.
6. Empty track renders a dashed `border-2 border-dashed border-muted/30` placeholder (pointer-events none).

Toolbar buttons (left, tooltip delay 500/200 ms): Split element (S), Split left (Q), Split right (W), Extract/Recover audio (toggle-source-audio; disabled unless exactly 1 selected element and `canToggleSourceAudio`; icon Link/Unlink), Duplicate element, Freeze frame ("coming soon", disabled), Delete element | divider | Bookmark toggle (active state when bookmark at playhead; tooltip "Add bookmark"/"Remove bookmark") + Graph-editor popover (keyframe bezier curve editor; disabled unless a curve is editable). Right: Auto snapping (magnet, `isActive` => secondary variant), Ripple editing (ripple icon, `isActive`), divider, zoom out, slider, zoom in.

Disabled toolbar buttons: `cursor-not-allowed opacity-50` wrapped in a span so tooltip works.

Track label column (per track): height = baseHeight + expansion; background `bg-accent/50` if it contains any selected element; right-aligned icons (gap-2 px-3): volume icon (video+audio tracks; red `text-destructive` + VolumeOff when muted, otherwise muted-foreground), eye icon (all but audio; red + ViewOffSlash when hidden), track-type icon (video, text "T", audio note, shapes, magic wand). Keyframe property-name rows (20px each, `bg-muted/50`) appear below when elements are expanded. Bottom spacer equals scrollbar height (12px) only if a horizontal scrollbar exists.

Track row context menu (right click on empty track area, 160px / w-40): "Paste elements" (invokes paste-copied), "Mute track"/"Unmute track", "Hide track"/"Show track", "Delete track" (destructive; not shown for main track).

Track-row selected highlight: `bg-accent/50` + `transition-colors` for tracks containing selected elements.

---------------------------------------------------------------------
## 5. Selection model

State lives in `SelectionManager` (`core/managers/selection-manager.ts`): `selectedElements: ElementRef[]`, `selectedKeyframes`, `keyframeSelectionAnchor`, `selectedMaskPoints`. Setting elements clears keyframes/mask points; setting keyframes clears mask points; setting mask points clears keyframes. `getActiveSelectionKind()` priority: mask-points > keyframes > elements. `clearMostSpecificSelection()` clears only the top kind (Escape / deselect-all peel one layer at a time).

Click rules on an element (`element-interaction-controller.ts`):
- mousedown (left): `stopPropagation`; if Ctrl/Cmd/Shift held -> toggle this element in selection (shift is treated the same as ctrl: toggle, NOT range select, in the timeline). Records pending session with `selectedElements = isSelected(ref) ? currentSelection : [ref]` (so dragging an unselected clip drags just that clip; the selection itself is changed on click).
- mousedown (right): does NOT stopPropagation (context menu needs it); if element not already selected, select only it.
- click (after mouseup): ignored if the gesture was a drag; ignored when a modifier is held; if element not selected OR multiple selected -> `select(ref)` (collapses to this element); else just clears keyframe selection.
- On drag start, if the anchor isn't selected it is selected.
- Click on empty track/gutter background (a "click gesture") = clear element selection AND seek playhead to that x (see 7.4).
- Box select (`selection/hooks/use-box-select` UNREAD, used by timeline): mousedown on a track background/gutter starts; additive if Shift/Ctrl/Meta held (merges with existing selection, de-duped); non-additive replaces. Intersection test (`selection-hit-testing.ts`): rectangle-vs-rectangle in content coordinates using element `[left,right]` from times and track `[top,bottom]` from heights (ignores expanded keyframe lanes); touching counts as intersecting (uses `<`/`>` so equal edges intersect). Selection box style: `border border-foreground/50 bg-foreground/5 z-50 pointer-events-none`. `shouldIgnoreClick` prevents the box-select mouseup from clearing/seeking.
- Select all (Ctrl+A) selects every element across all tracks.
- `cancel-interaction` (Escape): runs and clears all registered cancellers (drag, resize, keyframe drag, etc). If nothing was active, falls back to `deselect-all`. `deselect-all` first tries `clearActiveScope()` (cross-panel selection scope arbitration, `selection/scope.ts`: activating a new scope clears the previous scope's selection), else `clearMostSpecificSelection`.
- `SelectableSurface/SelectableItem` (`selection/*.tsx`) is a separate generic list-selection widget (click replace, Ctrl/Meta toggle, Shift range with anchor, Ctrl+Shift additive range, right-click selects unselected item, Enter/Space/Escape keys, selected style `ring-1 ring-primary rounded-sm bg-primary/10`, reveal highlight for 1500ms). Used for asset panels, not the timeline (confirmed: timeline imports only `SelectionBox` and `useBoxSelect`).

Visual states of an element (`timeline-element.tsx`):
- Selected: 1.5px `var(--primary)` ring (box-shadow) around the clip; resize handles appear (left & right, only when selected); keyframe diamonds appear on the clip.
- Hidden element (`hidden:true`) or being a drop-target for an effect/media drop: header block gets `opacity-50`.
- Being dragged: `transform: translate3d(0, dragOffsetY, 0)` (follows mouse Y pixel-exactly), left = time-based position at `dragView.currentTime + memberOffset`.
- Resize handles: 8px wide (`w-2`) buttons at `-left-1`/`-right-1`, cursors `w-resize`/`e-resize`, aria-labels "Left/Right resize handle"; click is swallowed.
- Expanded (keyframes) clip: background becomes `bg-background`, body shows property lanes under the 65/25/50px header.
- Media clip content: video/image = tiled thumbnail (`repeat-x`, tile = trackHeight*16/9 wide, bg `--muted`), header overlay 20px high with name `text-[0.6rem] text-white/75` on a `from-black/30` gradient, plus effects button (magic wand 12px) if the clip has effects (clicking it selects the clip and opens Properties effects tab). If no thumbnail URL, shows the element name truncated. Text clip shows `params.content`; effect clip shows wand icon + name; sticker/graphic show a 16px preview image + name; audio shows name header + waveform + volume line.

Context menu on element (w-64): Split (S), Copy (Ctrl C), Duplicate (Ctrl D; only if exactly 1 selected), Mute/Unmute (if element can have audio AND its media has audio; icon VolumeMute when multi-selected), Extract audio / Recover audio (only when exactly this 1 element selected and `canToggleSourceAudio`), Show/Hide (visual elements), Expand/Collapse keyframes (only if element has keyframes), Reveal media (single selected media element; scrolls assets panel and highlights 1.5s), Replace media (disabled stub), separator, Delete (destructive, label "Delete N elements" if multi selected and this is part of it else "Delete text"/"Delete clip"). Shortcut hints are rendered from default shortcuts: first default shortcut with `+` replaced by space, uppercased (e.g. "CTRL C").

---------------------------------------------------------------------
## 6. Placement and collision rules (`timeline/placement/*`)

`resolveTrackPlacement({tracks, (elementType|trackType), timeSpans[], strategy})` returns `{kind:"existingTrack", trackId, trackIndex, trackType, adjustedStartTime?}` or `{kind:"newTrack", trackType, insertIndex, insertPosition:"above"|"below"|null}` or `null`. `trackIndex`/`insertIndex` are DISPLAY indices over `[...overlay, main, ...audio]`.

Pseudo-code:
```
overlap(a,b) = a.start < b.end && a.end > b.start          // strict
canPlace(track, spans) = every span: no element (except span.excludeElementId) overlaps
trackType = placement.trackType ?? typeFor(elementType)

strategy explicit{trackId}: find track; missing or type mismatch -> null; else existingTrack  (NO overlap check!)
strategy firstAvailable: first track of right type where canPlace(all spans) -> existingTrack
                          else newTrack at getHighestInsertIndex
strategy preferIndex{trackIndex, hoverDirection, verticalDragDirection?, createNewTrackOnly?}:
   preferred = ordered[trackIndex]; compatible = preferred.type == trackType
   if !createNewTrackOnly && compatible && canPlace(preferred) -> existingTrack
   else newTrack at resolvePreferredNewTrackPlacement(direction = getInsertDirection(
            hoverDirection, verticalDragDirection only if preferred track was INCOMPATIBLE))
strategy aboveSource{sourceTrackIndex}:
   above = ordered[source-1]; if compatible && canPlace -> use it
   else first available track of type; else newTrack at highest insert index
strategy alwaysNew{position: highest|default}: newTrack, insertPosition null

existingTrack result on main track: adjustedStartTime = enforceMainTrackStart(...) (see below), only included when it differs from requested.
```
`getDefaultInsertIndexForTrack`: audio -> `overlay.length + 1 + audio.length` (bottom of audio zone); effect -> 0 (top of everything); every other overlay type (video/text/graphic) -> `overlay.length` (directly above main). `getHighestInsertIndexForTrack`: audio -> `overlay.length + 1` (directly below main); all others -> 0 (top).
`resolvePreferredNewTrackPlacement`: clamp preferredIndex into [0, trackCount-1]; mainIdx = overlay.length.
 - audio: if preferred <= mainIdx -> insert at `mainIdx+1`, "below"; else insert at `above ? preferred : preferred+1`.
 - non-audio: insertIndex = above ? preferred : preferred+1; if insertIndex > mainIdx -> insertIndex = mainIdx, "above" (overlay tracks can't be placed below main); else `(insertIndex, direction)`.
 - Always zero tracks: insert 0 with position "below" for audio else null.
`applyPlacement`: newTrack audio -> inserted into `audio[insertIndex - overlay.length - 1]` (clamped 0..audio.length); other types -> `overlay.splice(clamp(insertIndex,0,overlay.length))`. Existing track -> append elements.

Main track rule (`placement/main-track.ts`, also `update-pipeline.ts` enforce startTime rule, `group-move/resolve-move.ts clampAnchorStartTime`):
```
enforceMainTrackStart(requested, excludeElementId):
   if target != main: requested
   earliest = earliest-start main element excluding the moving one
   if none: 0
   if requested <= earliest.startTime: 0
   else requested
```
Meaning a clip dropped before/at the earliest clip on main snaps to t=0; there is no gap-closing. `applyElementUpdate` applies the same rule when `startTime` is patched on a main track element and always clamps `startTime >= 0`.

Track creation commands: `AddTrackCommand({type,index?})`, default index per above; audio index uses `max(0, insertIndex - overlay.length - 1)`; overlay uses `min(index, overlay.length)`. `RemoveTrackCommand` filters overlay and audio only (cannot remove main; also removes its elements, no confirmation). Empty tracks are NOT auto-removed after a move empties them (I saw no code doing so; UNCERTAIN whether any other reactor does).

Hidden/mute track toggles (`toggle-track-*.ts`): flip `muted` only if track type video/audio (`canTrackHaveAudio`), flip `hidden` only if not audio (`canTrackBeHidden`).

Placement tests (`placement/__tests__/resolve.test.ts`, 14 tests): explicit returns compatible track, rejects missing/incompatible; firstAvailable picks first compatible non-overlapping, else new track; preferIndex: uses preferred track if fits, new overlay track above main (index 0 insert, "above"), audio stays below main (index 2 "below"), vertical drag direction used when hovered track incompatible; aboveSource tries track above then any compatible, else new overlay track at index 0 with position null; alwaysNew highest(1)/default(2) for audio; batch spans reject a track if ANY span overlaps (new audio track at index 1); main-only/empty timelines (`createNewTrackOnly` on empty scene -> index 0 "above"); existingTrack on main reports `adjustedStartTime: 0`.

---------------------------------------------------------------------
## 7. Interactions

### 7.1 Moving clips (drag within timeline) — `controllers/element-interaction-controller.ts`, `group-move/*`, `components/drop-target.ts`
State machine: `idle -> pending (mousedown) -> dragging (moved >5px in x OR y from origin) -> idle`.

Per mouse move while dragging:
```
mouseTime      = (clientX - scrollRect.left + scrollLeft)/(50*zoom) -> ticks (>=0)
anchorStart    = max(0, mouseTime - clickOffsetTime)     // clickOffsetTime = where in the clip you grabbed it (captured at mousedown, rounded ticks)
frameSnapped   = roundFrameTime(anchorStart, fps)
snap (if snapping enabled AND shift NOT held): snapGroupEdges(...)  (7.5)
dropTarget     = computeDropTarget({elementType of ANCHOR, mouseX, mouseY(relative to scroll + header), startTimeOverride: snappedTime, excludeElementId: anchor, verticalDragDirection})
groupMoveResult= resolveGroupMoveForDrop(...)
```
`verticalDirection` = "up" if currentY < startY, "down" if >, else null (relative to mousedown Y; used for gap hover and for choosing above/below).

`computeDropTarget` (pseudo):
```
orderedTracks = [...overlay, main, ...audio]
x = startTimeOverride ?? (isExternalDrop ? playhead : mouseX->ticks)
if no tracks: preferIndex(0, below, createNewTrackOnly) -> new track
trackAtMouse = getTrackAtY(mouseY): walks cumulative heights, each row [top, top+height), gaps of 6px between;
     in a gap: if verticalDragDirection=="up" -> track above (relativeY = h-1) else track below (relativeY 0); with no direction in a gap -> null
if null: mouseY<0 -> new track preferIndex(0, "above", createNewTrackOnly); else preferIndex(last, "below", createNewTrackOnly)
if targetElementTypes (effects / media drops onto clips): hit-test the element under mouseX on that track (start <= t < end) -> DropTarget{targetElement}
else preferIndex(trackIndex, hoverDirection = relativeY < height/2 ? "above" : "below", verticalDragDirection)
   existingTrack -> DropTarget{trackIndex, isNewTrack:false, xPosition: adjustedStartTime ?? x}
   newTrack      -> DropTarget{trackIndex: insertIndex, isNewTrack:true, insertPosition}
```
Group move (`group-move/`):
- `buildMoveGroup`: members = anchor + selection (dedup, anchor first); each member stores `timeOffset = member.start - anchor.start`, `trackSection` (overlay|main|audio), `displayIndex`, `elementType`, `duration`.
- `resolveGroupMove`:
  - Existing-track target: members sorted by displayIndex; anchor goes to target track; members above anchor are assigned to compatible-type tracks scanning upward (skipping used tracks), members below scan downward. If any member can't find a compatible unused track -> null. Then `clampAnchorStartTime`: anchor start >= `max(-memberOffset)` so no member goes negative; if a member lands on main and its requested start <= earliest stationary main clip start, anchor is shifted so that member starts at 0 (or as far as min allows). Then `canApplyMovesToExistingTracks`: moving members must not overlap each other on the same target track and must not overlap stationary elements on that track (moving elements are excluded from the stationary set). Fail -> null.
  - New-track target (`isNewTrack`, or fallback when existing-track resolution returned null): needs `newTrackIds.length >= members.length`; refuses mixed audio + non-audio groups (returns null); one new track PER MEMBER (types by element type), inserted as a contiguous block starting at `anchorInsertIndex - anchorMemberIndex` (clamped to overlay zone or audio zone). Ids are pre-minted per drag session (`reservedNewTrackIds`) so the drop line doesn't churn.
- `drag.dropTarget` shown to UI = anchorDropTarget forced `isNewTrack:true` when move result was null (fallback) or the target is new; otherwise null (no line).
- Mouse up: if cursor is back within 5px of origin -> treat as cancel (no move). If `groupMoveResult` null -> nothing happens (drag silently reverts). Commits only if some member changed track or start. `MoveElementCommand`: creates tracks (sorted by index) first, validates type compatibility per move (throws if invalid), removes moved elements from all tracks, appends them (at end of `elements` array) to target tracks. Returns selection = moved refs (selection follows elements to new track ids). No ripple unless ripple mode.
- Escape during drag cancels (via `registerCanceller`/session reset). Edge auto-scroll is active during drag (100px zone).
- Drop line (`DragLine`): 2px `bg-primary` line across the tracks at `getDropLineY`: sum of heights+gaps of tracks above `trackIndex` (+ header height). Shown for element drags whenever any drag is in progress (`isVisible=isElementDragging`, uses dropTarget which is null when dropping on an existing track -> no line). During external drags it hides when over an element target.
- Note the "ghost": there is no separate ghost; the real clips move with `translate3d` in Y and recomputed left in X. Original track slot is not hollowed out.

### 7.2 Resizing / trimming — `controllers/resize-controller.ts`, `group-resize/compute-resize.ts`
- Handles appear only on selected clips. Mousedown on handle: stopPropagation+preventDefault; if the clip is part of the selection, all selected clips resize together (same side); else just this one. Requires fps (else aborts). Cancel via Escape.
- Members get `leftNeighborBound` = max end of non-selected elements on the same track that end at or before element.start (null if none); `rightNeighborBound` = min start of non-selected elements at or after element end (null if none).
- Mouse move: `rawDelta = round((clientX - startX)/(50*zoom)*120000)`. If snapping on and shift not held: for each member take the dragged edge (left: `start`; right: `start+duration`) + rawDelta, snap to nearest of {other element edges, playhead, keyframe times} within threshold, keep the CLOSEST snap across members; delta becomes `snapped - baseEdge`. Reports snap point for the indicator.
- `computeGroupResize` (pseudo):
```
minDur = round(120000*fps.den/fps.num)   // 1 frame
for each member:
  left side:
     minDelta = max(leftNeighbor? neighborEnd - start : -start,
                    sourceDuration known ? -(extra clip duration obtainable by un-trimming = durationFor(visibleSourceSpan(duration)+trimStart) - duration) : -inf)
     maxDelta = duration - minDur
  right side:
     minDelta = minDur - duration
     maxDelta = min(rightNeighbor? neighborStart - end : +inf,
                    sourceDuration known ? durationFor(sourceDuration - trimStart) - duration : +inf)
delta = clamp(delta, max(all mins), min(all maxes))       // group-wide
delta = roundFrameTicks(delta, fps)                       // snapped to a frame ONCE
delta = re-clamp(delta)                                   // bounds win over frame alignment
per member: sourceDelta = retime ? round(sign * sourceSpanAt(|delta|, retime)) : delta
  left : trimStart=max(0,trimStart+sourceDelta), trimEnd same, startTime+=delta, duration-=delta
  right: trimEnd=max(0,trimEnd-sourceDelta), trimStart same, startTime same, duration+=delta
```
  Invariant maintained: `trimStart + duration*rate + trimEnd == sourceDuration`. Elements WITHOUT `sourceDuration` (text, sticker, graphic, effect, image) can be extended indefinitely rightwards (limited only by neighbour) and leftward (limited only by neighbour/0). Video/audio with `sourceDuration` are capped by un-trimmed source. Note: resizing never bumps neighbours, it just stops at them (no overlap, no ripple).
- Live preview: `previewElements` overlay (not in history); on mouseup, preview is discarded and (if any field changed) `UpdateElementsCommand` is executed with the patches -> one undo step; rules in `update-pipeline` then run (clamp animations to duration, main start rule).
- `animations` are clamped to new `duration` by `clampAnimationsToDuration` whenever `duration` is in the patch (UNREAD details of the clamp).
- Image `sourceDuration` is undefined => images stretch freely. Library audio and uploads have `sourceDuration = duration` at creation.

### 7.3 Split — `commands/timeline/element/split-elements.ts`
Targets: selected elements, or if none selected, all elements under the playhead (`getElementsAtTime`: strictly `start < t < end`, across all tracks including audio). Hidden/disabled elements are included.
```
if splitTime <= start || splitTime >= end: element unchanged (silently skipped)
rel = splitTime - start; rightDur = duration - rel
leftSrc  = round(sourceSpanAt(rel, retime))        // rate * rel
totalSrc = round(sourceSpanAt(duration, retime))
rightSrc = totalSrc - leftSrc                      // derived once to keep exact sum
left : {duration: rel, trimEnd: trimEnd + rightSrc, name: name+" (left)", animations: leftAnims}
right: {id: newUUID, startTime: splitTime, duration: rightDur, trimStart: trimStart + leftSrc, name: name+" (right)", animations: rightAnims}
retime copied to both (same rate)
animations split by splitAnimationsAtTime(rel, shouldIncludeSplitBoundary: true) (a keyframe at the cut is included on both sides; exact function UNREAD)
retainSide: "both" (default, S) | "left" (keep left only: element keeps id, trimmed) | "right" (keep right only: NEW id, moved to splitTime)
```
Actions: `split` (S) -> both. `split-left` (Q) = "Split and remove left" -> retainSide "right" (after it, if ripple is enabled, playhead seeks to the new right element's startTime; ripple then closes the gap through the command manager). `split-right` (W) = "Split and remove right" -> retainSide "left". Returns the right-side refs; command selection result selects the right-hand elements (`createElementSelectionResult`) for "both"/"right".
Note labelling: names for all three modes get the suffix of the retained side(s).

### 7.4 Playhead, ruler, seeking
- Playhead: 2px `bg-primary` vertical line spanning full timeline height (minus scrollbar), with a 12px circular handle (`size-3`, `border-2`, `cursor-col-resize`) at top-1; handle is `bg-primary border-primary` while snapping to playhead, else `border-primary/50`. Line itself `pointer-events-none`; only handle is interactive. Keyboard on focused playhead: Left/Right = +/- one frame (clamped 0..duration). ARIA slider.
- Scrubbing (`controllers/playhead-controller.ts`): mousedown on handle or ruler (left button only; ruler ignores presses on the handle). `scrub`: raw time from ruler-rect x clamped to `[0, contentWidth]`, then `snapSeekMediaTime` (frame round, clamp to duration). Element-edge/bookmark/keyframe snapping is applied (threshold 10px) only when not shift AND `isElementSnappingEnabled`; ruler mousedown does NOT snap on the first click ("avoids jarring jump"), later moves do; plain ruler click-without-drag does a final non-snapped seek on mouseup. Note: scrub snapping IGNORES the global snapping toggle (it checks only shift) - uses `buildTimelineSnapPoints([elementEdges, bookmarks, animationKeyframes])`; the playhead isn't a snap source for itself. `setScrubbing(true/false)` toggles `playback.isScrubbing`; mouseup persists view state.
- Edge auto-scroll active during scrubbing (100px/15px).
- During playback the playhead moves imperatively (DOM left updated on playback events, no React re-render). Auto-follow: if playhead leaves visible range and playing and not scrubbing, scroll so playhead is at viewport CENTER (`playheadPx - viewportWidth/2`, clamped).
- Click-to-seek (`seek-controller.ts`): clicks (down+up within 5px/5px/500ms, left button) on ruler or track background/gutter: clears element selection, seeks to frame-snapped x (clamped to duration), persists view state. Clicking inside the labels column just clears selection (no seek). Ignored while box-selecting or when target inside the playhead.
- Ruler (`timeline-ruler.tsx`, `ruler-utils.ts`): role slider, height 22. Ticks virtualised: visible range ± buffer `max(200, (scrollLeft+viewport)*0.15)` px. Tick = `border-l border-muted-foreground/25 h-1.5 top-1.5`; label = `text-[10px] text-muted-foreground/85 top-1`. Label text: on whole-second boundary `MM:SS` (or `H:MM:SS` if >=1h), otherwise `{frame}f` (frame within the second = round(frac*fps)). Interval selection:
```
pxPerFrame = 50*zoom/fps
labelFrames = [2,3,5,10,15]; tickFrames = [1,2,3,5,10,15]
secondSteps = [1,2,3,5,10,15,30,60,120,300,600,900,1800,3600]
findOptimalInterval(minSpacing): first frame interval with pxPerFrame*n >= minSpacing; else first secondStep with pxPerSecond*s >= minSpacing; else 60
label min spacing 120px, tick min spacing 18px
ensureTickDividesLabel: if labelFrames % tickFrames != 0, search tickFrames then secondSteps that divide the label interval with spacing >= 18; fallback = label interval (no sub-ticks)
```
  Ruler width = dynamicTimelineWidth; ticks generated up to `max(duration, visibleDuration)`.
- Playhead position is not clamped to timeline duration by wheel/keys except where noted (`goto-end` = totalDuration; seek-forward clamps to total duration).

### 7.5 Snapping — `timeline/snapping/*`, `element-snap-source.ts`, `playhead-snap-source.ts`, `animation-snap-points.ts`, `bookmarks/snap-source.ts`
```
SnapPoint {time, type: "element-start"|"element-end"|"playhead"|"bookmark"|"keyframe", elementId?, trackId?}
sources: () => Iterable<SnapPoint>      buildTimelineSnapPoints concatenates
resolveTimelineSnap(target, points, maxDistance): nearest point with |d| <= max (ties: first wins because strict <); returns {snappedTime, snapPoint|null, snapDistance}
maxDistance = 10px converted to ticks at current zoom
```
Used by:
- Element drag (`snapGroupEdges`): sources = other elements' start/end (excluding moving ones), playhead, keyframes (absolute time = element.start + keyframe.time, excluding moving elements' keyframes). For EACH member test both its start and its end; choose the globally closest hit; anchor start = snapped - member offset (- member duration for end). Bookmarks are NOT included for element drags.
- Resize: same sources (no bookmarks); closest across selected members, for the edge being dragged.
- Playhead scrub: element edges + bookmarks + keyframes (no playhead).
- Bookmark drag: element edges, playhead, other bookmarks (excluding itself), keyframes.
Toggle: `useTimelineStore.snappingEnabled` (persisted, default true, key `timeline-store`); keyboard N; toolbar magnet. Shift temporarily disables for drag/resize/bookmark. Snap indicator: 2px `bg-primary/40` line at `LABELS_WIDTH(112) + snappedPx - scrollLeft`, full height - 8, `opacity-80`, only visible while snapping enabled AND a snap point exists AND (element drag | bookmark drag | resizing). Frame rounding happens BEFORE snapping for drags (so snapped result may be off-frame if the target is off-frame; exact rounding not re-applied - UNCERTAIN whether off-frame times can result: element edges are frame aligned normally).

### 7.6 Drag and drop from panels / OS — `controllers/drag-drop-controller.ts`, `drag-source.ts`, `hooks/use-timeline-drag-drop.ts`
- Payload types (`timeline/drag.ts`): media (image|video|audio, optional `targetElementTypes`), text{content}, sticker{stickerId}, graphic{definitionId, params}, effect{effectType, targetElementTypes: VisualElement types}. Payload is JSON in `application/x-timeline-drag` and ALSO kept in `TimelineDragSource` (because `getData` is unavailable during dragover); `effectAllowed = copy`.
- Enter counter handles nested enter/leave; accepts only if drag source active or `Files` in types.
- dragover: elementType from payload (media -> its media type); duration = media asset duration or 5s; `computeDropTarget` with `isExternalDrop = hasFiles && !dragData` (x = playhead for OS files, mouse for in-app drags); `xPosition` frame-rounded; `dropEffect=copy`. NOTE: in-app asset drags do NOT snap to edges and do not clamp collisions beyond the placement rules (drops that overlap push to a new track via preferIndex logic).
- Drop with asset: text -> text track (`buildTextElement`), sticker/graphic -> graphic track, media -> video (image/video) or audio track, effect -> if over a compatible clip (`targetElement`) adds a clip effect to it, else creates an `effect` element on the FIRST existing effect track (explicit placement, ignores overlap rules? - explicit strategy skips overlap check but `InsertElementCommand` uses explicit only after resolve; overlap is NOT checked for explicit -> overlapping effect elements possible; UNCERTAIN whether UI later prevents) or a new effect track. Media dropped on a `targetElement` = "replace media" -> no-op (stub).
- `insertAtTarget`: if `target.isNewTrack` -> `BatchCommand([AddTrackCommand(type,index), InsertElementCommand(explicit new track)])` (one undo step) else `InsertElementCommand` explicit on `orderedTracks[trackIndex]`.
- OS file drop: each file processed (`processMediaAssets`), added to project media, then sequentially placed. Special case: if timeline completely empty (no overlay, no audio, empty main) and asset isn't audio -> goes onto the main track at playhead. Else `computeDropTarget` at drop mouse position with `isExternalDrop` (x = playhead) and inserted with `insertAtTarget`. Upload toast shown (`showMediaUploadToast`).
- `InsertElementCommand`: auto placement uses `firstAvailable` (new element on first non-overlapping compatible track; else a new track at the "highest" index); `explicit` ignores overlap. Selection after insert = the new element. First-ever visual media in an empty project resizes project `canvasSize` to the asset size (and sets `originalCanvasSize` once) and fps to the video's fps (`floatToFrameRate`), without history.
- Element defaults at creation: duration `toElementDurationTicks(asset.duration)` else 5s; `trimStart/trimEnd 0`; video/audio `sourceDuration = duration`; video `isSourceAudioEnabled: true`, `hidden:false`; text default content "Default text" etc. (`timeline/defaults.ts`: fontSize 15, Arial, #ffffff, center, letterSpacing 0, lineHeight 1.2, background disabled #000 padding 30/42, transform identity, opacity 1, blendMode normal; element name "Text"; the generic text builder uses `DEFAULTS.text.element.name`).
- Sticker default name from id: `stickerId.split(":").slice(1).pop().replaceAll("-"," ")`. Graphic name capitalised definitionId. Effect name capitalised effect type.
- Drag indicators: `DragLine` visible when `isDragOver && !dropTarget.targetElement`; element-target drops highlight the target clip with `opacity-50`.

### 7.7 Duplicate, copy/paste
- Duplicate (`duplicate-elements.ts`, Ctrl+D; toolbar; context menu only when 1 selected, but action works for any selection): for each source track, clones its selected elements (new ids, name+" (copy)", same startTime, animations cloned with regenerated keyframe ids), and places them all on a BRAND-NEW track of the same type via `alwaysNew "highest"` (overlay types: index 0 i.e. top of stack; audio: directly below main). Multiple source tracks => one new track per source track. Selection becomes the duplicates. (So duplicating a main-track clip creates a new video overlay at the top.)
- Copy (Ctrl+C): stores `{type:"elements", items:[{trackId, trackType, element(no id)}]}` in `ClipboardManager` (in-memory only, not system clipboard). `ClipboardHandler` registry also supports keyframe copy/paste (`clipboard/handlers/keyframes.ts` UNREAD); which handler runs depends on active selection kind (UNREAD `clipboard/index.ts`).
- Paste (Ctrl+V; also "Paste elements" in track context menu; time = playhead): `minStart` = earliest copied start; each element start = `max(0, playhead + (start - minStart))`; new ids; animations cloned with new keyframe ids; grouped by SOURCE trackId; per group `resolveTrackPlacement(aboveSource{sourceTrackIndex})` -> reuse the track just above the source track if it fits (type compatible and no overlap for ALL spans), else any compatible track that fits, else a new track at the highest slot. If landing on main, apply `enforceMainTrackStart` using the group's earliest element and shift the whole group by the same delta. Selection = pasted elements. Note: the source-track index is looked up at paste time; if the source track was deleted `findIndex` returns -1 (aboveSource then looks at index -2; falls through to firstAvailable/new track).

### 7.8 Delete
`delete-selected` (Backspace/Delete, toolbar, context menu): depends on active selection kind: mask-points -> delete mask points; keyframes -> `removeKeyframes` (pre-samples value at playhead so deleting all keyframes bakes the current value); elements -> `DeleteElementsCommand` (removes from all tracks; selection cleared; tracks left empty are kept). With ripple on, `CommandManager` closes the gaps (section 9).

### 7.9 Hide / mute elements & tracks
- Element hide: `toggleElementsVisibility` - if ANY selected visual element is currently visible, hide all; else show all. Element mute: `params.muted` boolean on audio/video elements; same "any not muted -> mute all" rule. These actions have NO default shortcut. Muting an element via menu requires media to have audio.
- Track hide/mute: per-track booleans (label icons/context menu). Renderer skips hidden elements and hidden tracks (`scene-builder.ts:25,238`).
- Effective audio gain: `0 if track.muted || element.params.muted else dBToLinear(clampDb(volume dB, animated))`; `dBToLinear = 10^(db/20)`.

### 7.10 Extract / recover audio (`audio-separation/index.ts`, `commands/.../toggle-source-audio-separation.ts`)
- Allowed when element is video AND (source audio currently separated OR (source audio enabled AND media asset exists AND `hasAudio !== false`)).
- Extract: create an upload-audio element copying mediaId, name, startTime, duration, trimStart/End, sourceDuration, volume & muted params, retime (rate+maintainPitch), and volume animations (cloned with regenerated ids); placed with `firstAvailable` on audio tracks at the same time span (new audio track if overlap); sets video `isSourceAudioEnabled:false`. Recover: sets `isSourceAudioEnabled:true` only; DOES NOT delete the extracted audio element (it stays). Labels: "Extract audio" / "Recover audio".

### 7.11 Audio volume line and waveform
- Audio clip shows waveform (canvas, 1px bars, 1px gap, rendered only for visible portion, summary per source key; retime and trimStart considered via props `retime`, `sourceStartSec`) with a horizontal volume line overlay (white 50% -> 80% on group hover -> 100% while dragging). Hit area 14px tall, `cursor-ns-resize`, title "Drag to adjust clip volume". Hidden if volume is keyframed (`hasAnimatedVolume`).
- Position mapping (`audio-display.ts`): line% from dB: `n = (10^(db/20) - 10^(-3)) / (10^1 - 10^-3)` (linear gain normalised between -60 dB and +20 dB), `progress = n^(1/2)`, `percent = (1 - progress)*100`; inverse for drags; result snapped to 0.1 dB step and clamped [-60,20]. Tooltip near cursor `"{x.x} dB"` (portal, black/75%). Pointer down selects the clip, previews via `previewElements({params:{volume}})`, commits on pointer up (`commitPreview` => one history entry) if value changed; cancel discards.
- Waveform bar height: `fraction = ((dB(amplitude*gain) - (-40))/40)^1.5`, 0 below -40 dB. Gain samples (200 per clip) are used to reflect volume/keyframes (and clip "burn" colour above 0 dBFS).
- Playback: audio-manager schedules `AudioBufferSourceNode`s with `playbackRate = clampRate(rate)`; when `maintainPitch` or animated volume (or curve retime), a prepared buffer is rendered offline (`retime/audio-stretch.ts`: SoundTouch `PitchShifter` tempo=rate pitch=1 with frame size 4096; otherwise linear-interpolation resample of `trimStart + clipTime*rate`; stereo max 2 channels).

### 7.12 Bookmarks (`timeline/bookmarks/*`)
- Row between ruler and tracks (16px). Marker: 12x15px pentagon (clip-path `polygon(50% 100%, 12% 72%, 12% 10%, 88% 10%, 88% 72%)`), 1px background-colour border, fill = bookmark.color or `#009dff`; if `duration > 0` and its pixel width > 2px, a translucent `opacity-30` span (height 12.5px) is drawn between two marker halves.
- Add/remove: `toggle-bookmark` action (no default shortcut) / toolbar button toggles a bookmark at the playhead, keyed by frame-rounded time (`frameTime`); stored sorted by time. Identity of a bookmark = its exact `time` (equality), no ids; two bookmarks at same frame can't exist.
- Click: seek playhead to bookmark (frame-snapped, clamped to duration). Double click (`event.detail === 2`): open popover (w-64): Note text input, Color picker (hex, reset arrow button appears when colour differs from default), Duration number input in seconds (min 0, step .1, clamped to `timelineDuration - time`), Delete button (destructive). Keyboard Enter/Space seeks.
- Drag: mousedown pending, >5px starts drag; time = mouse time clamped to total duration, frame-rounded, snapped (see 7.5; shift disables). On mouseup `MoveBookmarkCommand(from,to)`; edge auto-scroll active.
- Bookmark notes are drawn on the preview canvas overlay ("Show bookmark notes", default visible) for bookmarks active at the playhead (`time <= playhead <= time + duration`): dark pill `rgb(0 0 0/0.5)`, `backdrop-blur-sm`, left border 3px in bookmark colour (fallback `var(--primary)`), max width `min(200px, 50vw)`, `text-xs text-white`.

### 7.13 Keyframes on the timeline (summary; animation internals belong to another notes file)
- Selected clip shows keyframe diamonds on its header (grouped by identical time; hidden if clip < 40px wide); diamond = 14px (`size-3.5`) `KeyframeIcon`, black stroke 1.5, white fill, `fill-primary` when selected; `cursor-grab`.
- Context menu "Expand keyframes"/"Collapse keyframes" toggles per-element expansion (`expandedElementIds` store; NOT persisted); expanded clip grows by 20px per property row (rows grouped/ordered: transform.*/opacity, volume/color, background.*, params.*, effects.*). Track height = base + max expansion among its expanded elements. Property labels (`Position X`, `Scale X`, `Rotation`, `Opacity`, `Volume`, `Color`, `BG Color`, `BG Pad X`...). Label column shows rows on the left.
- Click on diamond: seeks playhead to that keyframe (frame-snapped) and selects (toggle with Ctrl/Meta; Shift = range using time-then-path ordering). Mouse-down on already-selected keyframe drags the whole selected set; unselected without modifier first selects just it.
- Drag: after 5px, `deltaTicks = frameRound(dx/pxPerSec*120000)`; commit on mouseup as `RetimeKeyframeCommand` per keyframe in a `BatchCommand`, clamped to `[0, element.duration]`; escape cancels.
- Box-select inside lanes via `useKeyframeBoxSelect` (UNREAD internals).

---------------------------------------------------------------------
## 8. Retime / speed / source-time mapping (`src/retime/*`, `src/speed/components/speed-tab.tsx`)

```
rate = clamp(rate): non-finite or <=0 -> 1; else clamp(rate, 0.01, 5)
sourceTimeAtClipTime(clipTime)  = clipTime * rate
clipTimeAtSourceTime(srcTime)   = srcTime / rate
timelineDurationForSourceSpan(span) = span<=0 ? 0 : span / rate
sourceSpanAtClipTime(t) = max(0, t*rate)
render source frame for video (services/renderer/resolve.ts:199): src = trimStart + (timelineTime - element.startTime)*rate  (valid while 0 <= clipTime < duration)
audio start offset (audio-manager.ts:262): trimStart + (iteratorStart - clip.startTime)*rate
splitRetime / trimChange: constant retime passes through unchanged (identity functions)
```
- `trimStart`/`trimEnd` are in SOURCE time (unaffected by speed); `duration` is in TIMELINE time. Invariant: `trimStart + duration*rate + trimEnd == sourceDuration` (when sourceDuration known).
- Changing rate (update-pipeline derive rule on `retime`): 
```
origSourceDuration = element.sourceDuration ?? (orig.trimStart + sourceSpan(orig.duration, orig.retime) + orig.trimEnd)
visibleSource = max(0, origSourceDuration - trimStart - trimEnd)
newDuration   = roundMediaTime(visibleSource / newRate)
rate clamped; retime may be set undefined
```
  Start time is kept; the end moves (no neighbour clamping and no overlap check! changing speed can create overlaps - UNCERTAIN whether UI guards). Test: 10-tick clip, `{rate:1.5}` -> duration 7 (rounded from 6.67) and integer.
- Speed UI (Properties panel "Speed" tab for video/audio): number field with `x` suffix, step 0.01, scrub ranges: 0.01-1 at 160 px/unit, 1-5 at 48 px/unit, clamp [0.01,5], reset button, plus "Change pitch" switch (checked = pitch changes = `maintainPitch:false`; disabled only for invalid rate). Preview during typing/scrub via `previewElements`; commit on blur/scrub end creates history. If rate==1 and !maintainPitch the retime object is removed (`undefined`).
- Tests: `retime/__tests__/resolve.test.ts` (2x: 5->10; 0.5x: 4->2; no retime identity 7; inverse 10 src @2x = 5; effective rate 2 / 1; duration for 10 source span: 2x->5, 0.5x->20; rate 0 and -1 treated as 1; rate 100 capped to 5 i.e. 5->25 and span 10 -> 2). `retime/__tests__/split.test.ts` (source span at clipTime 5 @2x = 10; non-positive -> 0; split passes same retime reference to both halves; undefined when none).
- Toolbar "Freeze frame" is disabled "coming soon" - no freeze-frame feature. Reverse playback and speed ramps (curve mode) are not implemented in types.

---------------------------------------------------------------------
## 9. Ripple editing (`src/ripple/*`, `core/managers/commands.ts`)

State: `useTimelineStore.rippleEditingEnabled` (persisted, default false); the editor provider mirrors it into `editor.command.isRippleEnabled`. Toolbar button (ripple icon, active state) and action `toggle-ripple-editing` (NO default shortcut).

`CommandManager.execute/redo`: snapshot `beforeTracks` if ripple on; run command; then `computeRippleAdjustments(before, after)`; if any, `applyRippleAdjustments` -> `timeline.updateTracks`. The ripple result is part of the same history entry (undo restores the command's own saved state, which predates ripple, so a single undo reverts both).

```
for each track in before:
  vacated = []; joined = []
  for each element in before:
     if missing in after (by id on that track):
         if the element id exists anywhere in after (moved to another track): ignore  (moves do not ripple the source track)
         else vacated += [start, end)          // deletion
     elif before.end > after.end: vacated += [after.end, before.end)   // shortened from right (or trimmed)
  for each element in after not present in before on that track: joined += [start, end)   // new/moved-in elements
  freed = merge(vacated) minus merge(joined)         // interval subtraction
  for each freed interval: adjustment {trackId, afterTime: interval.end, shiftAmount: interval.length}
apply per track: sort adjustments by afterTime DESC; for each: every element with startTime >= afterTime has startTime -= shiftAmount
```
Properties: ripple is PER TRACK (other tracks do not shift); left-trim (changing start) is not detected as vacated (only end shrink or deletion trigger); extending an element or moving elements never shifts neighbours; split-left (Q) in ripple mode deletes the left part -> vacated interval is `[start, splitTime)` -> the right part (starting at splitTime == afterTime) shifts back by the vacated amount, then playhead seeks to the right element's new start. NOTE: element `startTime >= afterTime` shift ignores whether main-track "start at 0" rule is satisfied (no re-enforcement).
Gotcha: ripple uses raw numbers (not MediaTime) and rely on integer arithmetic; subtraction is exact in ticks.
No tests exist for ripple.

---------------------------------------------------------------------
## 10. Commands/history facts

- Every mutation is a `Command` with `execute()` saving `savedState = activeScene.tracks` and `undo()` restoring it wholesale (snapshot-based undo; no inverse ops). `BatchCommand([...])` groups.
- `CommandManager.history/redoStack`; selection is snapshotted per entry (`previousSelection`) and on undo only restored when the command had a `selectionOverride` (commands that return `{selection}` via `createElementSelectionResult` or an explicit selection); on `execute` a new command clears redo. `push({command})` records without executing (used by `commitPreview` with `TracksSnapshotCommand{before, after}`).
- Live preview (volume drag, speed field, resize): `TimelineManager.previewElements` keeps an overlay Map<elementId, partial>; `getPreviewTracks()` returns overlaid tracks (`previewTracks`) to renderers (timeline element uses `useElementPreview`); `commitPreview` / `discardPreview`; `updateTracks()` clears preview.
- `updateElementTrim`, `updateElementRetime`, `updateElements({updates, pushHistory})` funnel through `applyElementUpdate`: derive rules (retime -> duration) then enforce rules (duration -> clamp animations; startTime -> clamp >= 0 and main-start rule).

---------------------------------------------------------------------
## 11. Keyboard shortcuts relevant to timeline (defaults from `actions/definitions.ts`)

`ctrl` also means macOS Cmd; shortcuts are disabled while typing in inputs.
| Action | Keys |
|---|---|
| toggle-play | Space, K |
| seek-forward / seek-backward (1s) | L / J |
| frame-step forward/back | Right / Left |
| jump-forward/backward (5s) | Shift+Right / Shift+Left |
| goto-start | Home, Enter |
| goto-end | End |
| split / split-left (remove left) / split-right (remove right) | S / Q / W |
| delete-selected | Backspace, Delete |
| copy / paste | Ctrl+C / Ctrl+V |
| duplicate-selected | Ctrl+D |
| toggle-snapping | N |
| select-all | Ctrl+A |
| cancel-interaction | Escape |
| undo / redo | Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y |
| stop-playback (pause + seek 0), toggle-ripple-editing, toggle-source-audio, toggle-bookmark, toggle-elements-muted-selected, toggle-elements-visibility-selected, deselect-all, remove-media-asset(s) | no default shortcut |
Seeks clamp to `[0, totalDuration]`; frame = `round(120000*den/num)` ticks. Modifier+pointer: Shift/Ctrl/Cmd click toggles selection; Shift while dragging/resizing/scrubbing disables snapping; Ctrl/Cmd+wheel zooms; Shift+wheel scrolls horizontally. Keybindings are user-customisable (`keybindings-store`, JSON import/export with strict parsing; persistence tests in `actions/keybindings/__tests__/persistence.test.ts` - UNREAD).

---------------------------------------------------------------------
## 12. Existing tests relevant to the timeline

- `timeline/placement/__tests__/resolve.test.ts` (681 lines, described in section 6).
- `timeline/__tests__/update-pipeline.test.ts`: one test - retime 1.5 on a 10-tick video element with no trims yields integer duration 7.
- `retime/__tests__/resolve.test.ts`, `retime/__tests__/split.test.ts` (section 8).
- `fps/__tests__/fps.test.ts`, `utils/__tests__/math.test.ts`, `masks/__tests__/snap.test.ts`, `animation/__tests__/animated-params.test.ts` exist but UNREAD / not timeline-specific.
- Rust: `rust/crates/time/src/frame_rate.rs` (ticks-per-frame table, invalid rates), `media_time.rs` (last frame time and snapped seek: 5fps, 10s: last frame = 9.8 s; seeking 10.0 s stays 10.0 s).
- NO tests for: split, move/group-move, group-resize, ripple, snapping, ruler config, drop target. These are the highest-value things to cover in a rewrite.

---------------------------------------------------------------------
## 13. Guides module (`src/guides/*`) - not timeline

Preview-canvas overlay guides, not timeline snapping: registry `[grid, tiktok, igReels, ytShorts, spotlight]` (custom guide commented out). Grid config rows/cols in [1, 24], default 3x3. Each guide has `renderPreview`, `renderTriggerIcon`, `renderOverlay({width,height})`, optional `renderOptions`. Details of platform safe-zone geometry in `guides/definitions/platforms.tsx` / `tiktok-layout.tsx` UNREAD.

---------------------------------------------------------------------
## 14. Unread / uncertain list

- `selection/hooks/use-box-select.ts` and keyframe box-select/selection hooks, `hooks/use-scroll-sync.ts`, `hooks/use-scroll-position.ts`, `components/graph-editor/*` (bezier curve editor popover), `clipboard/index.ts` & `handlers/keyframes.ts`, `animation/*` internals (`splitAnimationsAtTime`, `clampAnimationsToDuration`, `cloneAnimations`), `commands/base-command.ts`, other track/effect/mask commands, `core/managers/scenes-manager.ts` body, playback manager.
- Whether any code removes tracks that become empty after moves/deletes: I found none.
- Whether changing speed can overlap neighbours: no guard seen in `update-pipeline`.
- `explicit` placement and `InsertElementCommand` explicit mode do not check overlaps (confirmed in `resolveTrackPlacement` explicit branch); behaviour of effect drops onto an existing effect track at an overlapping time is therefore unguarded.
- Right-edge behaviour for dropping beyond timeline end: allowed (no clamp); `getMouseTimeFromClientX` only clamps at 0.
