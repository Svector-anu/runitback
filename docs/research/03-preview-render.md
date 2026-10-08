# OpenCut classic: preview / render / effects / masks / text / captions / graphics notes

Repo root R = `/private/tmp/claude-502/-Users-mac-Desktop-coding-oss/df69066e-3e6c-4409-9706-c5dd5916da46/scratchpad/ref-classic/repo`. Paths below are relative to R. `W` = `apps/web/src`. Line refs are `file:line` from `cat -n` / `grep -n` of the files read. Items marked **[?]** are uncertain / not verified.

## 0. Headline facts (read first)

- Only ONE effect is registered: `blur` (`W/effects/definitions/index.ts:4`). There is NO effects catalog beyond Gaussian blur (no color grading, glow, etc.). `docs/effects-renderer.md` describes a plug-in system but only blur exists.
- Text elements have NO stroke, NO shadow, NO masks. Only: font, size, color, align, weight/style/decoration, letterSpacing, lineHeight, background box (+ transform/opacity/blend/effects). (`W/params/registry.ts:164-296`, `W/timeline/types.ts:135-139`). Stroke helpers (`strokeMeasuredTextLayout`) exist only for the text *mask* (`W/text/primitives.ts:215`).
- No crop feature exists (grep "crop" in W: no hits). Framing = per-axis scale + position + masks.
- Whole pipeline: TS builds a scene graph, rasterizes non-video content with Canvas2D (text, graphics, masks, gradients, stickers), uploads textures to Rust/wgpu (WebGPU, WebGL fallback) which does transform/opacity/effects/mask-feather/blend-mode compositing on GPU and presents on a canvas that is mounted directly in the DOM.
- Preview renders at the project's native canvas resolution (e.g. 1920x1080), CSS-scaled to fit. No separate low-res preview path (only images are downscaled to max 2048 in preview: `W/services/renderer/scene-builder.ts:21,102-104`).
- Playback video clock = `performance.now()` + rAF; audio is scheduled on a separate WebAudio clock anchored once at start (no continuous sync loop).

## 1. Frame composition pipeline

Files: `W/services/renderer/{scene-builder,resolve,canvas-renderer}.ts`, `W/services/renderer/compositor/{frame-descriptor,types,wasm-compositor}.ts`, `W/services/renderer/nodes/*`, `rust/crates/compositor/src/*`.

### 1.1 Scene build (`scene-builder.ts`)
- `buildScene({canvasSize,tracks,mediaAssets,duration,background,isPreview})` (:226) returns `RootNode{duration}`.
- Track order (:237-242): `visibleTracks = [...tracks.overlay (hidden filtered), tracks.main (if !hidden)]` then `.reverse()` => bottom-to-top draw order: main track first (bottom), then overlay[last] ... overlay[0] (top). Audio tracks not involved.
- Within a track (:23-31): visible (not `hidden`) elements sorted by `startTime` asc, tie-break `id.localeCompare`. So later-starting elements on the same track draw on top.
- Background nodes are added to root BEFORE all track nodes (:251-266):
  - `background.type === "blur"` -> one `BlurBackgroundNode` per video/image element on the MAIN track only (cover-fit scaled copy of the clip, Gaussian blurred). `blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY (10)`.
  - `background.type === "color"` and color !== "transparent" -> `ColorNode{color}` (full canvas; color may be a CSS gradient string, see 6).
- Node kinds: `VideoNode, ImageNode, TextNode, StickerNode, GraphicNode, ColorNode, BlurBackgroundNode, EffectLayerNode` (+RootNode). Element -> node mapping at :49-161. Video/image skipped if media asset lacks `file`/`url` (:63-66).
- Each visual node gets: `transform = buildTransformFromParams(params)` (`W/rendering/index.ts:36-53`: keys `transform.scaleX/scaleY` fallback 1, `transform.positionX/positionY` fallback 0, `transform.rotate` fallback 0), `opacity = params.opacity ?? 1`, `blendMode = params.blendMode` if valid else "normal" (`rendering/index.ts:55-70`), `effects` (array), `masks` (video/image/graphic only), `animations`.
- Effect *elements* (`type:"effect"`, on effect tracks) -> `EffectLayerNode{effectType,effectParams,timeOffset,duration}` (:50-60).

### 1.2 Resolve per time `t` (`resolve.ts`)
- `resolveRenderTree` walks nodes; sets `node.resolved` (null => not drawn at t).
- Active range: `0 <= t - timeOffset < duration` (:142-145; text uses `startTime` same test :322-327; effect layer has ±1e-6 tolerance :458-463).
- `localTime = getElementLocalTime(timelineTime, start, duration)` clamped to `[0,duration]` (`W/animation/resolve.ts:13-32`).
- Transform/opacity/color/background fields resolved from keyframe channels at `localTime` (`W/rendering/animation-values.ts`, `resolveOpacityAtTime`, `resolveColorAtTime`). Animatable paths: `transform.positionX/Y, scaleX/Y, rotate, opacity, volume, color, background.color, background.paddingX/Y, background.offsetX/Y, background.cornerRadius`, plus `params.<key>` for graphics and `effects.<id>.params.<key>` for effect params (`W/animation/types.ts:4-24`). Interpolation: linear | hold | bezier (scalar segments `step|linear|bezier`, tangent modes auto|aligned|broken|flat, extrapolation hold|linear) (`animation/types.ts:48-110`).
- Video frame: `sourceTime = trimStart + clipTime * retime.rate` (`retime/resolve.ts:8-16`; rate clamped 0.01..5 `retime/rate.ts`, in audio path); frame fetched by `videoCache.getFrameAt({mediaId,file,time})` (:199-209). `VideoCache` uses mediabunny `CanvasSink`, iterates forward if target within 2.0 s of last frame else seeks, prefetches next frame (`W/services/video-cache/service.ts:55-110`).
- Effects per element: `resolveEffectPassGroups` (:99-129): only `effect.enabled`; params resolved with keyframes; then `resolveEffectPasses({definition,effectParams,width,height})` with width/height = `round(|sourceW * containScale * scaleX|)` x same for Y (:162-171) — i.e. blur sigma scales with the element's drawn size, not canvas. Text uses canvas size (:362-368).

### 1.3 Frame descriptor (`frame-descriptor.ts`)
Produces `FrameDescriptor{width,height,clear:{color:[0,0,0,1]},items[]}` (:54-64) + texture uploads. Items appended in tree order (= draw order):
- `layer{textureId, transform:{centerX,centerY,width,height,rotationDegrees,flipX,flipY}, opacity, blendMode, effectPassGroups:EffectPass[][], mask:{textureId,feather,inverted}|null}`
- `sceneEffect{effectPassGroups}` (from EffectLayerNode, :123-132): applies to everything drawn so far (scene texture).
- Visual placement (`computeVisualTransform` :327-356): `containScale = min(canvasW/srcW, canvasH/srcH)`; `w = srcW*containScale*scaleX`, `h = srcH*containScale*scaleY`; center = `(canvasW/2 + positionX, canvasH/2 + positionY)`; rotation in DEGREES; negative scale => flipX/flipY (abs size). **Position unit = canvas pixels offset from canvas center**; scale 1 = "contain" fit.
- Graphics: source is a 512x512 OffscreenCanvas (`DEFAULT_GRAPHIC_SOURCE_SIZE=512`, `graphics/types.ts:3`), treated like an image (contain-fit into canvas, so a default graphic is a square of min(canvasW,canvasH) side). Cached by JSON of resolved params (`nodes/graphic-node.ts:43-48`).
- Stickers: `<img>` loaded via `resolveStickerId(width:200,height:200)`; source dims = `intrinsicWidth/Height ?? natural`.
- Text (`collectTextNode` :279-325): text is drawn by Canvas2D into a FULL-canvas texture (transform applied in 2D: translate to `canvasCenter+position`, scale(scaleX,scaleY), rotate(deg) — `nodes/text-node.ts:40-49`), then added as a full-canvas layer with opacity/blend/effects. contentHash = JSON of params+resolved (re-rasterize only on change).
- Textures: `external` (cached by source identity) vs `rendered` (cached by `contentHash`; redraw into persistent OffscreenCanvas) (`compositor/types.ts:53-74`, `wasm-compositor.ts:99-182`). Unused ids released each frame (:72-88).
- Mask texture (`buildMaskArtifacts` :372-534): **only `masks[0]` is used** (:388). `definition.isActive?.(params)===false` => skip (freeform not closed). Mask drawn white into an element-sized canvas then placed with the element transform onto a full-canvas texture; alpha channel is the mask. `feather` forced to 0 for `drawWithFeather` bodies (split mask does it analytically); otherwise GPU SDF feather. Mask stroke (`strokeWidth>0` and stroke renderer exists) emits a SEPARATE normal-blend, full-opacity layer drawn right after the element (:515-523), un-masked.
- Blur background (:134-179): cover-fit draw of source into canvas-sized texture, layer with `effectPassGroups:[blurPasses]`; sigma = `(intensity/5) * (res/ref)` with ref 1920 (x) / 1080 (y) (`resolve.ts:395-408`, `effects/definitions/blur.ts:57-61`).

### 1.4 GPU compositing (Rust) (`rust/crates/compositor/src/compositor.rs`)
Per frame (`render_frame`/`render_frame_to_texture` :293-405):
1. `scene` = cleared texture (clear color from descriptor = opaque black).
2. For each item:
   - Layer: `render_layer` (:407-483): (a) draw source quad into transparent full-canvas texture via `layer.wgsl` (inverse-rotate pixel about center, UV from size, out-of-quad => transparent, flip by 1-uv, linear sampler, ClampToEdge; `rgb` unchanged, `a *= opacity`); (b) effect groups in order (`apply_effect_groups`, each group = list of passes; texture copy between); (c) mask: if `feather>0` -> JFA signed-distance feather of mask texture else copy; then `mask.wgsl`: `alpha = mask.a` (or `1-mask.a` if inverted); `out = vec4(layer.rgb, layer.a*alpha)`. (d) `blend_texture(scene, layer, blendMode)` -> new scene.
   - SceneEffect: apply passes to whole scene.
3. Present: blit scene to surface (WebGPU) or `render_frame_to_texture` + present (WebGL fallback). Texture format `Rgba8Unorm` / `Bgra8Unorm` (`gpu/src/context.rs:67-69`); surface `premultiplied_alpha: false` (:527).
- Opacity is a straight alpha multiply BEFORE effects/mask/blend (order: transform+opacity -> effects -> mask -> blend).
- Texture pool keyed by (w,h), recycled each frame (`texture_pool.rs`).

### 1.5 Blend modes (17) — `rust/crates/compositor/src/shaders/blend.wgsl`, codes in `blend_mode.rs:26-46`
normal(0) darken(1) multiply(2) color-burn(3) lighten(4) screen(5) plus-lighter(6) color-dodge(7) overlay(8) soft-light(9) hard-light(10) difference(11) exclusion(12) hue(13) saturation(14) color(15) luminosity(16). UI labels/order: `W/params/registry.ts:70-88`. Formula (blend.wgsl:130-141):
`out_a = L.a + B.a*(1-L.a)`; `out_rgb = (1-L.a)*B.rgb + L.a*((1-B.a)*L.rgb + B.a*blend(B.rgb,L.rgb))`, clamp 0..1. Non-separable modes use lum weights (0.3,0.59,0.11) with SetLum/SetSat/ClipColor (W3C compositing spec). Soft-light = W3C formula (D(Cb) piecewise). Overlay = hard-light with swapped args. color-dodge/burn use 0.0001 epsilon. **[?]** Treats textures as straight (non-premultiplied) alpha.
- For a Canvas2D port: `ctx.globalCompositeOperation` values map 1:1 for all except plus-lighter ("lighter"/"plus-lighter" supported in modern browsers).

### 1.6 Interface TS <-> Rust (wasm-bindgen, package `opencut-wasm`)
- `initCompositor(w,h)`, `resizeCompositor(w,h)`, `getCompositorCanvas()` (HTMLCanvasElement; on WebGL reuses wgpu's GL canvas), `uploadTexture({id,source:OffscreenCanvas,width,height})`, `releaseTexture(id)`, `renderFrame(frameDescriptor)` (serde_wasm_bindgen; camelCase; `FrameItemDescriptor` tag `type`), `getLastFrameProfile()` (`rust/wasm/src/compositor.rs:27,72,96,109,140,154`, `perf.rs:32`).
- Legacy/aux: `initializeGpu()` (`wasm/src/gpu.rs:40`), `applyEffectPasses({source,width,height,passes:[{shader,uniforms:[{name,value:number[]}]}]})` -> OffscreenCanvas (`wasm/src/effects.rs:35`; used for background blur previews), `applyMaskFeather({mask,width,height,feather})` -> OffscreenCanvas (`wasm/src/masks.rs:19`).
- Time crate also exposed (see 9). Rust types mirror TS: `rust/crates/compositor/src/frame.rs:9-83`.
- Rust owns: device/textures, layer quad draw, blend, mask apply, effect passes (WGSL), JFA feather. TS owns: scene graph, timing, keyframe resolution, ALL rasterization of text/graphics/masks/gradients/stickers/video decode, hashing/cache, effect parameter -> uniform conversion.
- For our TS-only rebuild: Canvas2D can replace the layer shader (setTransform+rotate+drawImage with globalAlpha), blend modes (globalCompositeOperation), masks (destination-in with the mask canvas, feather via `ctx.filter='blur()'` or SDF), blur effect (`ctx.filter`).

## 2. Playback clock & audio sync

`W/core/managers/playback-manager.ts`, `audio-manager.ts`, `preview/components/index.tsx`.
- State: `isPlaying, currentTime (MediaTime ticks), volume(1), muted, previousVolume, isScrubbing`. `TICKS_PER_SECOND = 120_000` (`rust/crates/time/src/media_time.rs:9`).
- `play()` (:42-55): no-op if total duration <= 0; restart from 0 if `currentTime >= maxTime`.
- Clock (:213-239): rAF loop; `raw = playbackStartTime + (performance.now()-playbackStartWallTime)/1000` (via `mediaTimeFromSeconds`); `newTime = roundFrameTime(raw, fps)` (snapped to project frame grid); at `>= duration` pause, set `currentTime=duration`, notify seek. `seek()` re-anchors wall clock if playing (:71-79). Time clamped `[0,totalDuration]`.
- Preview render loop (`preview/components/index.tsx:135-160`): `useRafLoop(render)`; skip when `renderingRef` busy; `renderTime = min(playback.currentTime, timeline.getLastFrameTime())`; `ticksPerFrame = round(TICKS_PER_SECOND*fps.den/fps.num)`; `frame=floor(renderTime/ticksPerFrame)`; skip if frame and render tree unchanged. Render is async (decode frame awaited) — frames can be dropped, no catch-up logic.
- Audio (`AudioManager`):
  - Subscribes to playback state/seek and timeline/media changes. On play: `startPlayback(time sec)`: ensure `AudioContext` (resume if suspended), `collectAudioClips` (tracks+media), record `playbackStartTime` (timeline sec) and `playbackStartContextTime = audioContext.currentTime` (:149-180). `getPlaybackTime() = startTime + (ctx.currentTime - startCtxTime)`.
  - Scheduler: every `scheduleIntervalMs=500`, schedules clips whose range intersects `[now, now+lookaheadSeconds=2]` (:182-211).
  - Two paths: (a) streaming via mediabunny `AudioBufferSink.buffers(sourceStart)` -> one `AudioBufferSourceNode` per decoded chunk started at `startCtxTime + latencyComp + (timelineTime - playbackStartTime)`; if late, start with offset; after 5 consecutive dropped buffers, add latency compensation up to 0.25 s and resync the iterator (:234-350); throttles to ≤1 s ahead (:340-345). (b) "prepared buffer" path (`renderRetimedBuffer`, full-decode to 2ch at ctx sample rate) used when retime curve mode, animated volume, or maintain-pitch retime (:457-470); applies gain automation via `linearRampToValueAtTime` points (:477-518).
  - Per-clip gain node (`clip.volume`) -> master gain (`playback.volume`) -> master chain: DynamicsCompressor limiter threshold -1 dB, knee 0, ratio 20, attack 0.001 s, release 0.12 s, then output gain 0.98 (`W/media/audio-mastering.ts:1-6,28-48`).
  - Retimed streaming clips: `node.playbackRate = clampRetimeRate(rate)` (pitch not preserved on this path).
  - Scrub (`isScrubbing`) or paused seek => `stopPlayback()` (no audio scrubbing). Timeline change while playing => restart audio.
- Video and audio are NOT locked to a shared clock: video follows wall time, audio follows AudioContext time from a common anchor at start/seek; drift only handled by the dropped-buffer resync. Export uses offline `createTimelineAudioBuffer` instead.

## 3. Preview canvas sizing, aspect ratios, zoom

- Canvas presets (`W/canvas/sizes.ts`): `1920x1080, 1080x1920, 1080x1080, 1440x1080`; default `1920x1080`. UI labels derived by reduced ratio: 16:9, 9:16, 1:1, 4:3 (`views/settings/index.tsx:41-46`, `utils/geometry.ts dimensionToAspectRatio` = gcd reduce). Custom width/height number fields (mode `"custom"`; `lastCustomCanvasSize` remembered). Settings: `TProjectSettings{fps, canvasSize, canvasSizeMode?:"preset"|"custom", lastCustomCanvasSize?, originalCanvasSize?, background}` (`W/project/types.ts:30-37`).
- FPS: default 30/1 (`W/fps/defaults.ts`); presets 24,25,30,60,120 (`fps/presets.ts`); Rust `FrameRate` constants also include 23.976, 29.97, 48, 50, 59.94 (`time/src/frame_rate.rs`).
- Auto canvas from first media: when inserting the FIRST element into an empty timeline and it is video/image, canvasSize := asset width/height (and `originalCanvasSize` set once if unset); video also sets fps from asset (`W/commands/timeline/element/insert-element.ts:76-110`).
- Default new project: canvas 1920x1080 preset mode, bg `{type:"color", color:"#000000"}`, fps 30 (`project-manager.ts:94-104`).
- Viewport (`preview/components/preview-viewport.tsx`): `fitScale = min(viewportW/canvasW, viewportH/canvasH)` (:167-188); `viewportScale = fitScale * zoom`; `zoom` state 1 = Fit, clamp `[0.25, 16]`, button step x1.25 (`preview/zoom.ts`); toolbar presets `25,50,75,100,150,200` (%) which set `zoom = percent/100/fitScale` (:333-339); "Fit" label when `|zoom-1|<0.001`; label otherwise `round(viewportScale*100)%`. Scene rect: `sceneWidth=canvasW*scale`, `sceneLeft = viewportW/2 - center.x*scale`. Pan only when zoom>1 (middle-mouse drag or wheel delta; center clamped so canvas covers viewport) (:107-132, 265-291, 395-444). Ctrl/Cmd+wheel zoom: `factor = exp(-clamp(deltaY,±30)/300)` coalesced per rAF (`index.tsx:196-216`). Zoom/pan reset when canvas size changes (:466-474).
- Canvas element: compositor canvas appended into a div positioned `left/top/width/height = scene*`, CSS `width/height:100%`; div background = project bg color (transparent for blur bg) with 1px border (`index.tsx:96-111,290-309`). Fullscreen via `useFullscreen`.
- Coordinate transforms (`preview/preview-coords.ts`): `screenToCanvas = center + (client - viewportRect.left - viewportW/2)/scale`; `canvasToOverlay`; `positionToOverlay(pos) = canvasToOverlay(canvas/2 + pos)`; snap thresholds converted from screen px via `/scale`.
- Toolbar (`toolbar.tsx`): timecode `HH:MM:SS:FF` editable + total, play/pause, zoom select, fullscreen. Grid/guide popover is commented out ("v0.4.0").
- Context menu + overlays + snapshot: `RendererManager.saveSnapshot/copySnapshot` renders current frame to PNG named `<project>-<timecode with ':'->'-'>.png` (`renderer-manager.ts:42-139`).

## 4. Preview interactions (drag / scale / rotate / snap / text edit)

Files: `W/preview/controllers/preview-interaction-controller.ts`, `transform-handle-controller.ts`, `preview-snap.ts`, `hit-test.ts`, `element-bounds.ts`, `components/{transform-handles,handle-primitives,snap-guides,preview-interaction-overlay,text-edit-overlay}.tsx`.
- Layering in viewport: [compositor canvas] -> overlay plane "under-interaction" -> interaction overlay (pointer capture div, handles, snap guides) -> "over-interaction" overlay plane. Overlay mounts: `hud(anchor)`, `scene`, `viewport` (`preview/overlays.ts`). Guides (`guides/registry.tsx`): grid (default 3x3, rows/cols 1..24 — `guides/grid.ts`), TikTok layout, IG Reels, YT Shorts, Snapchat Spotlight (only TikTok has a drawn overlay; others `renderOverlay: null`). Preview store persisted as `preview-settings` v6 (activeGuide, overlays, gridConfig).
- Hit-testing (`hit-test.ts`): rotated-rect point test in canvas coords; iterate elements top-to-bottom (reverse draw order); bounds from `element-bounds.ts`: visual elements `w=srcW*contain*scaleX`, `h=srcH*contain*scaleY`, center = canvas/2+position, rotation; sticker fallback size 200 (`stickers/intrinsic-size.ts`); graphic 512; text uses measured `visualRect` (text+bg) transformed by scale then rotation about element origin (:73-96). Bounds ignore effects and masks (policy comment :99-105). Only elements active at playhead time are hit-testable; audio/effect/hidden excluded.
- Click: pointer down -> pending; move >0.5 canvas px (`MIN_DRAG_DISTANCE`) -> drag; click without drag selects topmost hit (or clears selection on empty) (`preview-interaction-controller.ts:33, 340-378`). Drag target = hit among already-selected elements preferred, else topmost; multi-select drag moves all selected visual elements by same delta (snapping computed from the first). Updates are *preview* patches (`previewElements`) committed on pointer up, discarded on cancel (undo-friendly).
- Position snap (`snapPosition` `preview-snap.ts:73-137`): targets x in {0, -W/2, +W/2}, y in {0, -H/2, +H/2}; candidates = element center on target, element AABB edge (rotation-aware half extents `halfW=(w|cos|+h|sin|)/2`) on target, closest within threshold wins per axis; threshold `SNAP_THRESHOLD_SCREEN_PIXELS = 8` screen px (converted to canvas units). Guide line = 1px `bg-white/70` full-length. **Hold Shift = disable snapping** (all gestures).
- Handles (`transform-handles.tsx`, `handle-primitives.tsx`): 4 corner handles + 3 edge handles (`right`, `left`, `bottom` ONLY — no top) + rotation icon handle offset `ROTATION_HANDLE_OFFSET = 24` px above top-center along rotated up-axis; sizes `HANDLE_SIZE=10`, hit area 18, edge thin/thick 6/14, icon radius 10; resize cursor chosen from handle angle (ew/ns/nwse/nesw).
- Corner scale (`previewCornerScale` :596-640): uniform factor `dist(pointer, centerOfBounds)/initialDistance`, applied to both scaleX & scaleY; `snapScale` snaps edges to canvas edges/center within threshold; clamp `|scale| >= MIN_SCALE = 0.01` keeping sign (:168-170). Scaling is about the element center (position unchanged).
- Edge scale (:640-745): projects pointer delta onto the element's rotated local axis; `scale = projection / (baseDim/2)` for that axis only (scaleX for left/right, scaleY for bottom); symmetric about center; `snapScaleAxes`.
- Rotation (:747-775): angle = atan2 from bounds center; `delta` normalized to ±180; `newRotate = initial + delta`; snaps to multiples of 90° within 5° (`ROTATION_SNAP_STEP_DEGREES=90`, `ROTATION_SNAP_THRESHOLD_DEGREES=5`); Shift disables.
- If the scale property has keyframes the gesture clears scale animation (`shouldClearScaleAnimation`) **[?] exact semantic**.
- Double-click on a text element enters inline edit (`TextEditOverlay`): contentEditable div positioned/scaled with the element transform, transparent text + caret color = text color; each input previews `params.content = innerText`; commit on blur/Escape or when playback starts (`text-edit-overlay.tsx`, controller :245-268, :411-417). Mask mode (properties tab "masks" active) disables normal drag/click and shows `MaskHandles` instead of transform handles (`preview-interaction-overlay.tsx:21-33,95-101`).

## 5. Effects

### 5.1 Model (`W/effects/types.ts`)
`Effect{id,type,params:ParamValues,enabled}`; `EffectDefinition{type,name,keywords,params:ParamDefinition[],renderer:{passes:EffectPassTemplate[], buildPasses?(…)}}`; `EffectPass{shader:string, uniforms:Record<string,number|number[]>}`. `buildDefaultEffectInstance` -> uuid + default params + `enabled:true` (`effects/index.ts:33-47`). Effects can attach to video/image/text/sticker/graphic (`EFFECT_TARGET_ELEMENT_TYPES = VISUAL_ELEMENT_TYPES`) as an ordered list (drag-reorder UI in `effects-tab.tsx`, enable/disable eye, delete), or be standalone "effect" elements on an effect track (applies to the whole scene below it, for its time range).

### 5.2 Catalog (complete)
| type | name | keywords | params |
|---|---|---|---|
| `blur` | Blur | blur, soft, defocus | `intensity`: number, default **15**, min 0, max 100, step 1 |
That is all (`W/effects/definitions/blur.ts:68-109`).

### 5.3 Blur algorithm (copy exactly)
- `intensityToSigma(intensity,res,ref) = (intensity/5) * (res/ref)`; sigmaX uses width/1920, sigmaY height/1080 (`blur.ts:57-61,102-108`).
- `buildGaussianBlurPasses(sigmaX,sigmaY)`: if `max<0.001` -> no passes. Constants `MAX_SINGLE_PASS_SIGMA=10, MAX_STEP=4, MAX_EFFECTIVE_SIGMA=40, MAX_ITERATIONS=8`. `iterations = clamp(ceil(maxSigma²/40²),1,8)`; per-pass sigma = sigma/√iterations; `step = max(1, perPassSigma/10)`. Emit for each iteration a horizontal pass `{u_sigma:σx, u_step:stepX, u_direction:[1,0]}` then vertical `{u_sigma:σy,u_step:stepY,u_direction:[0,1]}`; shader id `"gaussian-blur"` (:10-55).
- WGSL (`rust/crates/effects/src/shaders/gaussian_blur.wgsl`): 61 taps (`index -30..30`), `pos = index*step`, weight `exp(-pos²/(2σ²))`, sample at `uv + texel*direction*pos`, normalized by total weight; bilinear sampler. Uniform buffer `{resolution:vec2, direction:vec2, scalars:vec4(sigma, step,0,0)}` (`effects/src/pipeline.rs:49-53, 152-169`). Unknown shader id / missing uniform => error (`EffectsError`).
- Edge handling: ClampToEdge sampler; effect texture is the full-canvas layer texture (element is transparent outside its quad), so blur bleeds alpha at edges **[?]**.
- Background blur presets (Settings > Background): Light 100, Medium 200, Heavy 500 (`W/background/blur.ts`) but `DEFAULT_BACKGROUND_BLUR_INTENSITY = 10` — presets exceed the effect param's 0..100 range (not clamped for background). Preview thumbnails rendered by `effectPreviewService` (160x160 using `/effects/preview.jpg`, uniform dims 1920x1080) (`services/renderer/effect-preview.ts`).

## 6. Background

- `TBackground = {type:"color", color:string} | {type:"blur", blurIntensity:number}` (`project/types.ts:5-13`). Default `#000000` (`background/color.ts`).
- Color may be hex or CSS `linear-gradient/radial-gradient/repeating-*` (multi-layer, vendor prefixes ok). `drawCssBackground` parses with its own CSS gradient parser (`W/gradients/parser.ts`, `gradients/canvas.ts:52-76`), paints layers in reverse order (CSS bottom layer first), supports linear + radial (circle/ellipse, extent keywords, `at` position); conic not supported **[?]**. Colors panel offers: solid `colors`, `pattern-craft` gradients, `syntax-ui` gradients (`W/data/colors/*`), plus custom color picker; color changes preview with `pushHistory:false` and commit with history on release (`settings/background.tsx`).
- Blur bg: composited from main-track clips only (one node per clip, same time range as the clip, retime-aware).

## 7. Masks

Files: `W/masks/*`, `rust/crates/masks/*`.
- Applies to: `video`, `image`, `graphic` only (`MASKABLE_ELEMENT_TYPES`, `timeline/types.ts:181`). Element stores `masks?: Mask[]` but renderer uses only the first (`frame-descriptor.ts:388`). UI = "Masks" properties tab with add-mask dropdown, per-mask param fields, delete; canvas handles (`masks/use-mask-handles.ts`, `preview/components/mask-handles.tsx`).
- Types: `split, cinematic-bars, rectangle, ellipse, heart, diamond, star, text` (builtin) + `freeform` (`masks/types.ts:11-21`). Registered in this order/icon in `masks/builtin/definitions/index.ts:41-77`.
- Base params (all masks; `registry.ts:30-58` + `box-like.ts:97-105`): `feather` number default 0, min 0, max `MAX_FEATHER=1000`, step 1 (unit "percent" in the param def but value is canvas-pixel feather width in shader — **[?] label vs semantics**); `inverted` boolean false; `strokeColor` "#ffffff"; `strokeWidth` 0 (0..100); `strokeAlign` "inside"|"center"|"outside" default "center".
- Geometry coordinates: `centerX/centerY` are fractions of the ELEMENT's drawn bounds (0 = element center; UI range -100..100 shown x100 as %); `width/height` fractions of element width/height (default 0.6; min 1 in UI param def i.e. 1% displayed… `min:1`; code floors to `MIN_MASK_DIMENSION = 0.01`); `rotation` degrees 0..360; `scale` default 1 (1..500 UI) **[?] `scale` is stored/edited but `getBoxLikeGeometry` (`box-like.ts:148-164`) does not use it for box shapes**.
- Box-like (rectangle, ellipse, diamond, heart, star, cinematic-bars) share `BOX_LIKE_MASK_PARAMS` (`box-like.ts:29-95`): centerX 0, centerY 0, width 0.6, height 0.6, rotation 0, scale 1, strokeAlign. Defaults: `getDefaultSquareMaskParams` -> a square of side `0.6*min(elemW,elemH)` expressed as width/height fractions (`DEFAULT_SHAPE_MASK_SHORT_SIDE_RATIO=0.6`, `masks/dimensions.ts`).
  - rectangle: filled rotated rect (`rectangle.ts:12-46`). ellipse: `Path2D.ellipse(cx,cy,w/2,h/2,rot)`. diamond: 4-point. star: 10 vertices (5-point), inner radius ratio `0.45`, start angle -90° (`star.ts:11-12,35-37`). heart: bezier with control points at ±halfW, y factors -0.475/-1.225/-0.125/0.725 (`heart.ts`). All `fillPath`; stroke via `strokeFromPath` using path expanded by `getStrokeOffset` (inside -w/2, outside +w/2, center 0) with min half-size 1.
  - cinematic-bars: default `width = max(diagonal/elemW, 1)` (covers rotated), `height 0.6`, sizeMode height-only; path always at least element-wide (`max(width*W, W)`), band `max(height,0.01)*H` (`cinematic-bars.ts:15-36, 99-113`). (Used for letterbox; use `inverted` to get the bars instead of the band.)
- split: params `centerX, centerY, rotation` (default 0); half-plane mask defined by a line through center with normal `(cos r, sin r)`; feather implemented analytically with a canvas linear gradient of total width `feather` (±feather/2) so GPU feather is skipped (`split.ts:1-60, 200-300`). Position drag clamped to canvas bounds. Not "active"-gated.
- text mask: params `content "Mask", fontSize 15 (MIN_FONT_SIZE 5..MAX 300), fontFamily "Arial", fontWeight, fontStyle, textDecoration, letterSpacing, lineHeight, centerX, centerY, rotation, scale` (+ base) (`text.ts:345-367`); text drawn (centered) as mask via text layout primitives; stroke uses `strokeMeasuredTextLayout`; `isActive` gates empty content **[?]**.
- freeform: bezier path `FreeformPathPoint{id,x,y,inX,inY,outX,outY}`, `closed:boolean`, `centerX/centerY/rotation/scale`; default `path:[]`, `closed:false`; `isActive = closed` (an open path = no mask). Pen-tool editing: add points, drag handles, insert on segment, remove points (`freeform/path.ts`, `freeform/definition.ts:407-430`).
- Feather rendering (Rust): `MaskFeatherPipeline.apply_mask_feather_with_encoder` -> JFA (jump flooding) SDF twice (inside seeds & outside seeds) then `jfa_distance.wgsl`: `signed = dist_to_outside - dist_to_inside; alpha = smoothstep(-feather/2, +feather/2, signed)` in frame pixel units (`jfa_distance.wgsl:30-50`, uniform `feather_half = feather/2` `feather.rs`). Seeds encoded in RGBA8 as 16-bit x/y (`decode_seed`). JS equivalent: blur the mask alpha or compute a distance transform.
- Mask interaction handles: position, rotation, feather (offset = base offset + `feather * FEATHER_HANDLE_SCALE(0.11)`), edge (left/right/top/bottom), corner, scale, freeform anchors/segments. Handle offsets `LINE_HANDLE_OFFSET_SCREEN_PX=20`, `BOX_HANDLE_OFFSET_SCREEN_PX=20` (`handle-positions.ts:14-16`). Feather drag: `feather = clamp(round(start + projection/0.11), 0, 1000)` (`param-update.ts`). Mask snapping reuses `snapPosition/snapScale/snapRotation` (`masks/snap.ts`).

## 8. Text elements

### 8.1 Param schema (`W/params/registry.ts:164-296`, defaults `W/timeline/defaults.ts:12-55`)
| key | type | default | notes |
|---|---|---|---|
| `content` | text | "Default text" | not keyframable |
| `fontFamily` | font | "Arial" | not keyframable |
| `fontSize` | number | 15 | param min 1, step 1; MIN_FONT_SIZE 5 / MAX 300 in `text/typography.ts` (used by mask UI) **[?] which one the properties panel enforces** |
| `color` | color | "#ffffff" (default element) | keyframable. `DEFAULT_TEXT_COLOR` const is "#000000" but unused for defaults |
| `textAlign` | select | center | left/center/right |
| `fontWeight` | select | normal | normal/bold only |
| `fontStyle` | select | normal | normal/italic |
| `textDecoration` | select | none | none/underline/line-through |
| `letterSpacing` | number | 0 | min -100, step 0.1 (px, via `ctx.letterSpacing`) |
| `lineHeight` | number | 1.2 | min 0.1, step 0.1 |
| `background.enabled` | boolean | false | |
| `background.color` | color | "#000000" | keyframable |
| `background.cornerRadius` | number | 0 | 0..100 (percent of half the min side) |
| `background.paddingX` | number | 30 | min 0 |
| `background.paddingY` | number | 42 | min 0 |
| `background.offsetX/offsetY` | number | 0 | min -100000 |
+ visual params: `transform.positionX/positionY` (default 0, min -100000, step 1), `transform.scaleX/scaleY` (1, min 0.01, step 0.01), `transform.rotate` (0, -360..360, step 1), `opacity` (1, 0..1, step 0.01), `blendMode` (normal; not keyframable).
Default new text element duration = 5 s (`DEFAULT_NEW_ELEMENT_DURATION`, `timeline/creation.ts`); text panel offers only "Default text" draggable (`text/components/assets-view.tsx`).

### 8.2 Layout/render algorithm (`W/text/primitives.ts`, `layout.ts`, `measure-element.ts`)
- Font size scaling: `scaledFontSize = fontSize * (canvasHeight / 90)` (`FONT_SIZE_SCALE_REFERENCE = 90`, `typography.ts:9`) — font size 15 on a 1080-high canvas = 180 px. `fontSizeRatio = fontSize / 15` (scales background padding).
- Font string: `${style} ${weight} ${scaledPx}px "${family}", sans-serif`; `textBaseline = "middle"`; `lineHeightPx = scaledFontSize * lineHeight`; lines = `content.split("\n")` (no auto-wrap).
- Block: `maxWidth = max(line width)`, `height = lines * lineHeightPx`, `visualCenterOffset = (lines-1)*lineHeightPx/2`. Text rect: left = {left:0, center:-maxW/2, right:-maxW}, top = -height/2. Line y = `i*lineHeightPx - visualCenterOffset` (`primitives.ts:200`), x = 0 with `ctx.textAlign = align`.
- Background rect = text rect expanded by `padding*fontSizeRatio` on each side, shifted by offset; `roundRect` with `radius = (min(w,h)/2) * clamp(cornerRadius,0,100)/100`; drawn only if enabled and color not "transparent" (`layout.ts:100-141`, `primitives.ts:162-198`). Whole-block visual rect = union of text rect and bg rect (used for bounds/hit-test).
- Underline: rect at `lineY + descent + thickness`; line-through at `lineY - (ascent-descent)*0.35`; `thickness = max(1, scaledFont*0.07)` (`layout.ts:22-23,185-226`).
- Transform: draw origin = canvas center + position; `scale(scaleX, scaleY)` then rotate(deg) (`nodes/text-node.ts:40-49`) — scale applied as 2D canvas scale (not re-layout).
- Text is anchored at its center (middle baseline) regardless of align; align only shifts the block relative to the anchor.
- Fonts: system set `Arial, Helvetica, Times New Roman, Courier New, Verdana, Georgia, monospace, sans-serif, serif` (`fonts/system-fonts.ts`); everything else treated as Google Font loaded on demand via `<link href="https://fonts.googleapis.com/css2?family=<Family+Name>:wght@400;700&display=swap">` + `document.fonts.load("<w> 16px \"Family\"")` (`fonts/google-fonts.ts:60-82`); font picker uses a pre-baked sprite atlas `/fonts/font-atlas.json` + `/fonts/font-chunk-N.avif` (`FontAtlas{fonts:{[family]:{x,y,w,ch,s[]}}}`). `FontOption.category: system|google|custom`. **[?]** Font load not awaited before measuring in the render path (text may render fallback until loaded); not verified.
- Cache key for the text texture is JSON(params+resolved measured layout) so animation of any property triggers re-raster.

## 9. Subtitles / captions

Files: `W/subtitles/*`, `W/transcription/*`, `W/services/transcription/*`, `W/media/{audio,mediabunny}.ts`.
- Output of both import and transcription = a NEW text track inserted at index 0 (top) with one text element per cue, named `Caption N`, via one undoable `BatchCommand([AddTrackCommand{type:"text",index:0}, ...InsertElementCommand{explicit trackId}])` (`subtitles/insert.ts:10-40`).
- `CaptionChunk{text,startTime(s),duration(s)}`; `SubtitleCue = CaptionChunk & {style?: SubtitleStyleOverrides}` (`transcription/types.ts:43-47`, `subtitles/types.ts`). Start/duration converted with `mediaTimeFromSeconds`.
- Cue -> text element (`build-subtitle-text-element.ts`):
  - defaults: fontFamily Arial, **fontSize 5** (app units => 5*H/90 px; 60 px on 1080p), color #ffffff, align center, **fontWeight bold**, italic none, no decoration, letterSpacing 0, lineHeight 1.2, background disabled (bg defaults from `DEFAULTS.text.background`), placement bottom.
  - ASS size: `fontSize = fontSizeRatioOfPlayHeight * 90` where ratio = `round(fontsize/PlayResY * 1000)/1000` (:143-146, `ass.ts:376`).
  - wrap: max width = 80% of canvas width (`SUBTITLE_MAX_WIDTH_RATIO=0.8`), or `canvasW*(1-marginL-marginR)` if ASS margins given; greedy word wrap using `ctx.measureText` on a 4096² measurement canvas; existing `\n` kept (:45-85).
  - position (px from canvas center): bottom: `H - margin - (visualRect.top+height) - H/2` with `margin = H * (marginVerticalRatio ?? 0.05)`; top/middle analogous; x by align using margins (:190-253). Position written to `transform.positionX/Y`.
- SRT (`srt.ts`): normalize CRLF, split blocks on blank lines; ≥2 non-empty lines; timestamp line is line 0 or 1; regex `HH:MM:SS[,.]ms{1,3}` ; ms padded right to 3 digits; skip cue if duration <= 0 or non-finite or empty text; `skippedCueCount`. No HTML tag stripping **[?]**.
- ASS (`ass.ts`, 514 lines): parses `[Script Info]` PlayResX/Y (default 384x288), `[V4 Styles]/[V4+ Styles]` (Format/Style), `[Events]` (Format/Dialogue). Style mapping: Fontname, Fontsize (ratio of PlayResY), PrimaryColour (ABGR `&HAABBGGRR` -> css; alpha = 1 - aa/255, rgba when <1), Bold/Italic (nonzero), Underline/StrikeOut -> textDecoration, Spacing -> letterSpacing, Alignment 1-9 numpad -> textAlign + verticalAlign (`ALIGNMENT_MAP`), MarginL/R/V -> ratios of PlayResX/Y, BackColour only if BorderStyle==3 -> text background box. Ignored (warn): outline, shadow, angle, scale≠100, BorderStyle not 1/3, underline+strikeout together. Dialogue text: strip `{...}` override tags, `\N`/`\n`->newline, `\h`->space; timestamps `H:MM:SS.cc|ccc` (`H+`). Event `Effect` ignored (warn), non-Dialogue events skipped (warn), missing style falls back to `Default` style. Result `{captions, skippedCueCount, warnings[]}`; `parseSubtitleFile` dispatches by extension (`.srt`/`.ass`; others throw "Unsupported subtitle format") (`parse.ts`).
- Captions panel UI (`subtitles/components/assets-view.tsx`): Import button (`accept=".srt,.ass"`), Language select (`auto` + en, es, it, fr, de, pt, ru, ja, zh — `transcription/languages.ts`), "Generate transcript" button (disabled while processing or when diagnostic `transcription.no_audio` active: "No audio detected. Add a clip with audio to the timeline first."). Progress strings: "Extracting audio...", "Preparing audio...", "Loading model N%", "Transcribing...", "Generating captions...". Warnings listed in amber; errors in destructive box.
- Transcription flow: (1) `extractTimelineAudio` mixes whole timeline audio to a 44.1 kHz stereo 16-bit WAV blob (`media/mediabunny.ts:82-135`); (2) `decodeAudioToFloat32(sampleRate=16000)` -> mono average Float32 (`media/audio.ts:62-90`; `DEFAULT_TRANSCRIPTION_SAMPLE_RATE=16000`); (3) `transcriptionService.transcribe` -> Web Worker running `@huggingface/transformers` `pipeline("automatic-speech-recognition", hfModelId, {dtype:"q4", device:"auto"})`, messages `init/transcribe/cancel`; options `chunk_length_s=30, stride_length_s=5, return_timestamps:true, language: undefined for auto` (`services/transcription/worker.ts:60-62,137-142`); segments from `result.chunks[].timestamp [start,end]`; (4) `buildCaptionChunks` (`transcription/caption.ts`): per segment split words by whitespace into groups of `DEFAULT_WORDS_PER_CAPTION = 3`; per-chunk duration `max(MIN_CAPTION_DURATION_SECONDS=0.8, chunkWords / (segmentWords/segmentDuration))`; start = max(running chunk start, previous caption end) so captions never overlap (global `globalEndTime`) — note words/second timing is uniform interpolation, not word timestamps; (5) insert as text track.
- Models (`transcription/models.ts`): `whisper-tiny` (onnx-community/whisper-tiny, "Fastest, lower accuracy"), `whisper-small` (DEFAULT, "Good balance"), `whisper-medium`, `whisper-large-v3-turbo` ("Best accuracy, requires WebGPU"). The Captions UI does NOT expose model choice (service default used). Model download progress aggregated across files (sum loaded/total, floored %).
- Subtitle style is baked into per-element params (no global caption style, no per-word highlight/karaoke, no export of SRT in this snapshot **[?] export not searched**).

## 10. Stickers & graphics

### 10.1 Graphics (vector shapes; `W/graphics/*`) — element type `graphic{definitionId, params, effects?, masks?}`
Registered: `rectangle, ellipse, polygon, star` (`definitions/index.ts:7-12`). Each renders into 512x512 canvas (inside render `clearRect`, fill, optional aligned stroke). Common params: `fill` color default "#ffffff"; `stroke` color "#000000" (group stroke); `strokeWidth` number 0..64 step 1 default 0; `strokeAlign` select inside|center|outside default center. Stroke align implementation (`graphics/stroke.ts:40-101`): center = plain stroke; inside = clip to path + stroke width*2; outside = stroke width*2 on temp canvas then `destination-out` fill of path; shapes inset by `strokeWidth/2` when align=center.
- rectangle: + `cornerRadius` 0..50 step 1 default 0 (percent: `radius = min(w,h)/2 * pct/50`). keywords rectangle, square, box.
- ellipse: no extra. keywords ellipse, circle, oval.
- polygon: + `sides` 3..12 step 1 default 5; `cornerRadius` 0..50 default 0 (rounded vertices via tangent arcs, max offset = half shortest adjacent edge; `maxCornerRadius = r*sin(pi/sides)`); first vertex at -90° (`angle = -pi/2 + i*2pi/sides`). keywords polygon, triangle, pentagon, hexagon, diamond.
- star: + `points` 3..12 default 5; `depth` 1..99 default 45 (inner radius = outer * depth/100). Vertex angle `-pi/2 + i*pi/points`. keywords star, sparkle, burst.
- New graphic element: `buildGraphicElement({definitionId,name,startTime,params})` default duration 5 s; params = visual params + graphic params (`graphics/index.ts:51-61`; params animatable as `params.<key>`).

### 10.2 Stickers (`W/stickers/*`) — element type `sticker{stickerId:"provider:value", intrinsicWidth?, intrinsicHeight?}`
- Provider registry: `logos` (stub: returns empty; `resolveUrl` returns id as-is; category commented out "v0.4.0"), `flags`, `shapes` (`providers/index.ts`). Categories shown: All, Flags, Shapes (`categories.ts`). Sticker id format `providerId:providerValue` (`sticker-id.ts`).
- Flags: 254 country records in `providers/countries-data.ts` (`{name, code(ISO2), languages[], flag_colors[], region}`); image URL `/flags/<code lowercase>.svg` (static SVG assets served by the app); search by name/code/region/language/colors with region aliases; 19 REGIONS (Western/Eastern/Northern/Southern Europe, South Asia, Southeast Asia, East Asia, Central Asia, Middle East, North/Sub-Saharan Africa, North/South/Central America, Caribbean, Oceania, Antarctica, Atlantic Ocean, North Atlantic) + groups europe/asia/africa/america (`countries-data.ts:1-30`; docs/countries-search.md). Default browse limit 12 per section, search limit 100 (`stickers/index.ts`).
- Shapes provider: list = every graphic definition (rectangle, ellipse, polygon, star) + legacy presets (square, circle, triangle=polygon sides 3, hexagon=polygon sides 6, diamond=polygon sides 4, star). **Adding a shape sticker creates a `graphic` element, not a `sticker`** (`stickers/components/assets-view.tsx:350-362`); non-shape stickers: measure intrinsic size (`resolveStickerIntrinsicSize`), create `sticker` element, add id to a persisted "recent stickers" list (`stickers-store.ts`).
- Sticker raster: `<img>` of the SVG at request size 200x200; drawn into texture at source size, contain-fit scaled. Fallback intrinsic = 200.

## 11. Rust/WASM vs TS summary & the time crate

- Rust crates: `compositor` (frame descriptor, layer/blend/mask shaders, texture pool/store), `effects` (gaussian blur pipeline), `masks` (JFA SDF + distance feather), `gpu` (wgpu context WebGPU->WebGL fallback, fullscreen quad, blit), `time` (MediaTime/FrameRate/timecode), `bridge` (`#[export]` macro -> wasm_bindgen camelCase), `wasm` (cdylib wiring + `perf` frame profile).
- `time` exports (TS wrappers in `W/wasm/media-time.ts`): `TICKS_PER_SECOND()`=120000, `mediaTimeFromSeconds`, `mediaTimeToSeconds`, `mediaTimeFromFrame`, `mediaTimeToFrame`, `roundToFrame`, `floorToFrame`, `isFrameAligned`, `lastFrameTime`, `snappedSeekTime`, `mediaTimeAdd/Sub/Min/Max/Clamp`, `formatTimecode({time,format,rate})`, `parseTimecode`, `guessTimecodeFormat` (`rust/crates/time/src/*.rs`). `MediaTime` = integer ticks (branded number in TS). Timecode format used in preview: `HH:MM:SS:FF`. FrameRate = `{numerator,denominator}` rational.
- Export (`SceneExporter`, `scene-exporter.ts:82-170`): renders each frame `i * ticksPerFrame` (frameCount = floor(duration/ticksPerFrame)) through the same CanvasRenderer, feeds compositor canvas to mediabunny `CanvasSource` (codec vp9 for webm / avc for mp4; bitrate presets QUALITY_LOW/MEDIUM/HIGH/VERY_HIGH = ui low|medium|high|very_high); audio from offline-mixed AudioBuffer (aac via mp4a.40.2 @192k test else opus; webm opus). Formats mp4/webm.
- What must be re-implemented for a pure browser rebuild: scene graph + resolve (TS already), per-layer transform/opacity (Canvas2D or WebGL), 17 blend modes (use `globalCompositeOperation`), Gaussian blur (`ctx.filter = blur(px)` where px = sigma), mask compositing (`destination-in`) + feather (blur or SDF), scene-effect layers, text/graphics/gradient rasterization (already Canvas2D in the reference), video decode (mediabunny WebCodecs), audio scheduling (WebAudio).

## 12. Uncertainties / gotchas collected
1. Only blur effect exists; any "effects catalog" must be invented by us.
2. Mask `scale` param is defined but unused in box mask geometry (`box-like.ts:148-164`) — verify in UI before copying.
3. `feather` param labelled `unit: "percent"` (max 1000) but consumed as pixel width in shaders.
4. Background blur presets (100/200/500) vs default 10 vs effect param max 100.
5. Text `fontSize` min: param registry 1 vs `MIN_FONT_SIZE` 5.
6. Corner-scale handle scales both axes by the same factor even if scaleX != scaleY (preserves ratio); no top edge handle.
7. Clear color is opaque black; `background.color:"transparent"` cannot produce transparent export (ColorNode skipped; clear stays black) **[?]**.
8. Opacity is applied before effects (blur of a semi-transparent layer).
9. Only `masks[0]` used though UI may list several.
10. Text/graphic element effects: blur sigma for text uses canvas size, for visuals uses drawn element size.
11. Animation of `fontSize`, `letterSpacing`, `lineHeight` is registered as keyframable in param defs but ANIMATION_PROPERTY_PATHS only lists color/background/transform/opacity/volume — treat as not animatable **[?]**.
12. Keyframe/bezier curve details and timeline/track semantics belong to other notes; only referenced here (see `docs/keyframes.md`, `W/animation/*`).
