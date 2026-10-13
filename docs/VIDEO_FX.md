# Video FX: chroma key, speed ramps, background removal, tracking and stabilisation

Status of each feature, what was measured, what it cannot do, and the open-source decisions behind it. Every number below was measured on the build in this checkout (real Chrome through Playwright on an Apple-silicon Mac, other heavy jobs running at the same time, so treat timings as upper-ish bounds). Specs: `e2e/vfx-*.spec.ts`; unit tests: `tests/chroma-key.test.ts`, `speed-ramp.test.ts`, `segmentation.test.ts`, `tracking.test.ts`, `motion-tools.test.ts`, `vfx-tools.test.ts`, `ui-speed-curve-logic.test.ts`; evals `green-screen-overlay` and `speed-ramp-hero`.

| Feature | Status | How it was verified |
| --- | --- | --- |
| Chroma key (green screen) | Built, verified | Pure maths in Node; real Chrome pixel specs for GPU and CPU paths, GPU/CPU parity, decoded WebM export, eyedropper in the real editor |
| Speed ramps | Built, verified | 40 seeded fuzz runs of random ramp/split/resize/speed edits; real Chrome frame-id decode of preview and export; exported audio length and pitch decoded |
| Background removal | Built, verified on a still, on a video clip and on the model's speed | Real MediaPipe model on MediaPipe's public `portrait.jpg` in preview and decoded export; fake-backend tests for the video/indexing path |
| Track point | Built, verified | Synthetic moving texture: tracked graphic within 0.75 px of ground truth in real Chrome, through the real worker |
| Stabilisation (translation only) | Built, verified | Synthetic hand-shake: residual jitter of a marker in the rendered picture drops 91% in real Chrome |

## Open-source decisions (checked before building, per `docs/research/07-oss-reuse-audit.md`)

| Need | Candidates looked at | Decision |
| --- | --- | --- |
| Chroma key | No maintained, permissively licensed, tiny library found (`seriously` ISC but unmaintained since 2022 and a whole WebGL compositor; `gl-react` MIT, a React renderer). | Built: about 100 lines of maths (`src/engine/render/chroma.ts`) plus one WebGL2 shader that mirrors it. |
| Speed curves | Nothing relevant; the time-stretch audit already concluded to keep the in-repo WSOLA (`src/engine/audio/stretch.ts`). | Built; audio reuses WSOLA per piece. |
| Person segmentation | MediaPipe Image Segmenter (Apache-2.0 code, already a dependency and already self-hosted for faces). | Adopted: `selfie_segmenter.tflite` and `selfie_segmenter_landscape.tflite` self-hosted next to the face model. |
| Motion tracking / stabilisation | OpenCV.js (`@techstark/opencv-js` 5.0.0, Apache-2.0, 14.7 MB unpacked) could do optical flow and homography; `tracking` (BSD, last published 2022) is a 2012-era API; no maintained video-stabiliser package exists on npm. MediaPipe tracks faces/hands/objects, not arbitrary points. | Built ourselves, translation only (about 350 lines, pure, in `src/engine/tracking`): normalised cross-correlation search with Lucas-Kanade sub-pixel refinement. OpenCV.js stays rejected: 10+ MB for rotation/zoom/rolling-shutter models we do not ship. |

### Licences and sizes

| Asset | Licence | Size | Note |
| --- | --- | --- | --- |
| `public/mediapipe/selfie_segmenter.tflite` (256x256, float16) | Believed Apache-2.0 (Google MediaPipe) | 249,537 bytes | **Not fully confirmed.** MediaPipe's code and docs are Apache-2.0; the "MediaPipe Selfie Segmentation" model card PDF links to the Apache licence, but its text could not be machine-read here, so the sentence was not quoted. Confirm against the model card before relying on it (same open item as the BlazeFace model in `docs/LICENSING.md`). |
| `public/mediapipe/selfie_segmenter_landscape.tflite` (144x256) | same | 250,177 bytes | Used for footage wider than 1.3:1. |
| MediaPipe wasm runtime | Apache-2.0 | 11.7 MB (already shipped for faces) | Shared, not duplicated. |

No new npm dependency was added. Model hashes are recorded in `docs/SUPPLY_CHAIN.md` and asserted by `tests/supply-chain.test.ts`.

## 1. Chroma key

Effect `chroma-key` on video and image clips (clip-only: it is not offered as a scene-wide effect layer). Parameters: key colour (default `#00ff00`), similarity (0-100, default 30), edge smoothness (0-100, default 10), spill suppression (0-100, default 50).

- **Maths** (`src/engine/render/chroma.ts`): BT.601 Cb/Cr distance to the key, with the chroma divided by the pixel's brightness (floor 0.08) so a shadowed screen keys almost like a lit one while near-black pixels are not amplified into matches; a smoothstep from "similarity" to "similarity + smoothness" gives the matte; spill removes the component of the pixel's chroma along the key's direction (luma kept).
- **Where it runs**: the `Compositor` keys the clip's own layer after it is drawn, so it works on overlay clips over any lower track, in preview and export alike (invariant 6). WebGL2 shader on an `OffscreenCanvas` (`src/render/chroma-gpu.ts`) with a Canvas2D pixel-pass fallback when WebGL2 is unavailable (`Compositor` option `chromaBackend: "auto" | "gpu" | "cpu"` pins one for tests).
- **Cost, one 1080p frame** (composite of a full-frame keyed layer, measured in `vfx-chroma.spec.ts`): no key 0.5-0.7 ms, **GPU 5.2-5.7 ms**, **CPU fallback 97-158 ms** (two runs, machine under load). The fallback is correct but not real-time at 1080p; it only matters where WebGL2 cannot start.
- **Parity**: over 480 sampled pixels the GPU and CPU results differ by at most 6 levels per channel (rounding); the spec asserts that bound.
- **Eyedropper**: "Pick from preview" in the effect card reads the average of a 5x5 patch of the clip's own source frame (before any effect), mapping the click through the layer transform (`canvasPointToSourceUv`, unit-tested including rotation, flips and crop).
- **Agent tool**: `set_chroma_key` (one effect per clip, repeated calls edit it; `remove: true` deletes it; warns when the clip is on the main track, where the keyed area shows the project background).
- **Limits**: hard edges from video compression show a faint fringe; there is no matte choke/erode, no garbage matte, no per-channel despill modes. A screen with strong shadows needs a higher similarity.

## 2. Speed ramps

`RetimeConfig.curve = { points: [{ at, rate }] }`, 2 to 6 points, `at` in absolute SOURCE ticks, rate 0.01 to 5, linear between points, flat outside them.

- **The mapping** (`src/engine/timeline/speed-curve.ts`, `retime.ts`): with `T(s) = integral of ds / rate(s)` (closed form per linear segment, `(b - a) / (rb - ra) * ln(rb / ra)`), timeline time to play source `[a, b]` is `T(b) - T(a)` and the source position after time `t` is `T^-1(T(s0) + t)` (exponential in time, also closed form). `sourceTimeAt`, `sourceSpanAtClipTime`, `timelineDurationForSourceSpan` and `clipTimeAtSource` are the single definition used by `buildFramePlan`, split, resize, the update pipeline, the freeze-frame command and the audio scheduler. A constant rate takes the old path unchanged.
- **Why the curve is tied to the source, not the clip**: trims, splits and resizes only move the visible window along the same curve, so a split is exact (both halves keep the whole curve) and the ramp never slides off the moment it was set on. A split-then-join differs from the original mapping by at most a couple of ticks, far inside one frame (tested at 60 random split points).
- **Invariant 2** (`trimStart + duration * rate + trimEnd == sourceDuration`) holds with `rate` defined as the derived mean (visible source / duration); `withDerivedRate` re-derives it at the end of every update and split. `sceneViolations` also checks the curve (valid points, and duration equal to the integral to within the source-tick rounding).
- **Rounding, honestly**: all times are integer ticks, so rounding the cut or trim to a whole source tick inside a very slow stretch (0.1x) shifts later footage by a few ticks of timeline time (tens of microseconds). Split re-derives each half's tail trim from the curve so the invariant still holds; the right half may give up a few ticks at its far end.
- **Neighbour clamping**: a ramp that makes the clip longer stops at the next clip and trims the source tail instead (`limitedByNeighbour`), the same rule as constant speed.
- **Audio**: a ramped clip is scheduled as consecutive constant-rate pieces whose ends lie exactly on the curve (at most 0.5 s long and 15% rate change each). Preview scheduling and the offline export mix both consume the same pieces. With "Change pitch" off each piece is WSOLA time-stretched at its own rate. Measured in a decoded export of a 6 s tone clip with the Hero preset: audio length 7.53 s equals the picture, the 440 Hz tone reads 440 Hz at the slow moment with pitch kept, and drops to 120 Hz (0.25x) with pitch following the speed. Very steep ramps can sound slightly steppy at piece boundaries.
- **Presets**: Montage, Hero time, Bullet, Jump cut ease (`SPEED_RAMP_PRESETS`). Properties > Speed has a small SVG curve editor (drag, add by double-click, delete with double-click or Delete, up to 6 points, keyboard-adjustable) and "Reset to 1x"; the number field shows the average speed while a ramp is active.
- **Agent tool**: `set_speed_ramp` (`preset`, or `points` as `{position 0-1, speed}`, or `clear`). Setting a constant speed replaces a ramp.
- **Tests**: 25 in `speed-ramp.test.ts` including a seeded fuzz of 40 seeds x 30 random edits (ramps, splits, resizes, constant speeds) asserting no invariant violation and `duration == integral`; `vfx-speed.spec.ts` decodes real preview and export frames (a 10-bit frame-id picture) and checks every sampled frame against the curve within one frame.
- **Limits**: reverse is not supported. Tools that map source time to timeline time with one number (transcript search, temporal index, face tools, waveform thumbnails, `analyze_timeline`) use the clip's mean rate and are therefore only approximate on a ramped clip. Keyframes on a ramped clip are in timeline time, so changing the ramp moves them relative to the footage.

## 3. Background removal

Effect `remove-background` (parameters: edge softness, "keep background instead"), applied to video and image clips.

- **Model**: MediaPipe Selfie Segmenter (CPU delegate), run in a dedicated worker (`src/platform/segmentation/face-worker-segmenter.ts`) following the face pattern: runtime and models self-hosted under `public/mediapipe`, nothing downloaded, so no consent dialog (consent exists for downloaded models only). The worker file gets the same `'unsafe-eval'` CSP carve-out as the face worker (`vercel.json` is unchanged: the worker is named `face-worker-segmenter` so the existing `/assets/face-worker-` rule matches it; the supply-chain test asserts both scripts).
- **Pipeline**: Properties > Effects > Add effect > Remove background (or the `remove_background` tool) analyses the media once: frames are decoded at the clip's frame rate capped at 12 fps and 1800 frames, scaled to at most 384 px, segmented in batches of 6 (progress and Cancel in the effect card), and stored as 8-bit person-confidence masks in IndexedDB (`runitback-masks`, keyed by asset). At render time the two nearest masks are blended by time, turned into an alpha matte (smoothstep around 0.5, width from "softness"), drawn through the same transform as the clip and used as `destination-in` (`Compositor`). Preview, export, agent frame grabs and the bridge all read masks from one shared `MaskProvider`, so they render identically.
- **Cost**: model inference measured in real Chrome after warm-up: **12-14 ms per frame** (384x216 landscape model) and **19-20 ms per frame** (288x384 portrait model) over two runs. Analysing a still image, including worker start, wasm init and model load, took 0.3-1.3 s. A 30 s clip at 12 fps is 360 masks, so roughly 4-7 s of inference plus decoding. Compositing a mask is a 83-118k pixel conversion on the CPU plus one extra draw per frame (not separately timed).
- **Storage**: one mask is 83 KB (384x216) to 118 KB (308x384, a portrait); 360 masks are about 30-43 MB per analysed 30 s clip, which is why 12 fps and 1800 frames are the caps. Masks of deleted media are not yet purged (this store is not registered with the derived-data registry, which would also put the masks into project bundles); they are a recomputable cache.
- **Verification**: MediaPipe's public `portrait.jpg` (not committed; `e2e/vfx-segmentation.spec.ts` uses `PORTRAIT_IMAGE`, `e2e/.fixtures/portrait.jpg` or downloads it, and skips offline): with a magenta project background all five room points (curtains, flag, desk) became magenta and all four person points kept the photo, in the preview and in a decoded export; the effect card toggle restores the room. A video clip is covered end to end too: a 2 s 24 fps clip of the photo swaying on grey was analysed with the real model in 0.8 s (48 frames) and at three moments in the preview and at two in a decoded export the room was transparent and the person intact. Sampling plan, batching, progress, cancel, mask interpolation and tool behaviour also have unit tests with a fake backend.
- **Quality, honestly**: it is a 256x256 segmentation model. Edges are soft and can flicker on fast motion and fine hair; between sampled frames (12 fps) masks are blended, so quick movement can ghost; every person in the frame is kept, and objects a person holds may be cut off; it does not segment arbitrary objects; unusual poses or very small subjects may be missed. The UI says this under the effect.
- **Agent tool**: `remove_background` (analyses on first use and reports when no person was found).

## 4. Tracking and stabilisation

### Research result

A credible in-browser approach exists **for translation only**, and was built and verified. OpenCV.js was the only library that would add more (rotation/scale, optical-flow stabilisation) but costs 10+ MB for models that are not in scope; MediaPipe does not offer a generic point tracker. Not built, and not claimed: rotation or zoom correction, rolling-shutter correction, 3D camera solves, planar tracking, object re-identification.

### Engine (`src/engine/tracking`, pure, runs in Node)

- `trackPoint`: a patch is cut at the clicked point; every frame is matched against the previous frame's patch (normalised cross-correlation within 14 analysis px, refined to sub-pixel by Gauss-Newton Lucas-Kanade on the zero-mean unit-variance patch) and re-checked against the original patch within 2 px; an anchor match at 0.75 correlation or better overrides the drifting estimate, so the path does not drift. Below 0.7 correlation the point is lost: it holds its last position, is flagged, and is searched for again only near where its velocity would have taken it (correlation 0.9 or better to be accepted; give up after 90 frames).
- `textureScore` refuses flat patches and straight edges (smaller eigenvalue of the gradient structure tensor), because those slide along themselves unseen.
- `estimateShift` / `cameraPath`: a 4x3 grid of blocks each match the previous frame; the largest group of votes that agree within a pixel wins, so a subject crossing part of the frame does not pull the estimate.
- `stabilize`: Gaussian smoothing of the cumulative path (sigma in samples) returns the correction to apply; `thinSeries` (Ramer-Douglas-Peucker, 0.4 px) keeps keyframes few.

Measured on synthetic textures with exact ground truth (`tests/tracking.test.ts`): clean path over 240 frames within 0.2 px; with sensor noise and exposure drift within 0.5 px; 300 frames of slow motion end within 0.3 px; a target hidden for 6 frames is flagged lost and found again; a target leaving the frame is flagged lost without jumping to a look-alike; the camera path after 90 frames of shake is within 1 px; the stabiliser removes at least 75% of the shake's frame-to-frame change while the slow pan survives.

### Platform and app

- `src/platform/tracking`: greyscale frames decoded at at most 320 px on the long edge (`VideoFrameCache`), analysed in a worker (`tracker-worker.ts`); at most 900 frames per call (30 s at 30 fps); cancel terminates the worker. Cost measured in real Chrome for 121 frames of 320x180: **about 1.7 s for tracking and 1.8 s for stabilising**, including decoding. Analysis resolution is 320 px, so a pixel there is six in a 1080p frame; sub-pixel refinement keeps the visible error small (below).
- **Track a point** (`track_point`, and Properties > Motion > "Follow a point" on text, graphic, image and video clips): click a point on the video in the preview; the clip gets `transform.positionX/Y` keyframes (thinned) so its centre sits on the point through the video's own transform at every sampled time, including retiming and ramps (sampling is in timeline time and mapped to source time through the speed curve). Existing position keyframes on the target are replaced. One undo step.
- **Stabilise** (`stabilize_clip`, and Properties > Motion > Stabilize): counter-moves the clip with position keyframes (capped at 8% of the picture by default) and sets a static scale increase just large enough to hide the edges. If the clip's scale is animated the zoom is not applied and the result says so.
- **Measured in the real editor** (`vfx-motion.spec.ts`, real analyser and worker, 4 s clip at 30 fps): a magenta graphic tracking a point on an orbiting texture stays within **0.75 px** (worst of eight sampled moments, centroid of the rendered preview versus the generator's ground truth; 83 + 22 keyframes for 121 frames); stabilising a clip with a 0.25 px/frame pan plus +-6 px random shake reduced the frame-to-frame jitter of a marker in the rendered picture by **91% in x and in y**, kept 60-150% of the pan, and zoomed 7.5%.
- **Honest limits**: translation only (no rotation, zoom or rolling-shutter correction); the point must have corner-like detail (flat sky, plain walls and straight edges are refused or lost); a hard cut inside a stabilised clip confuses the camera estimate (stabilise one shot at a time); heavy motion blur, objects leaving the frame, occlusion and look-alike patterns lose the point; the zoom crops the picture; smoothing cannot tell shake from an intentional move shorter than the smoothing span.

## Schema and persistence

Project schema version 5 -> 6 (additive, no data rewritten): optional `retime.curve`, and the `chroma-key` and `remove-background` effect types. `repairProject` drops an invalid curve (keeping the average speed) and says so. A project saved by this build is rejected by older builds as "saved by a newer version", as for any bump.

## Files

`src/engine/render/{chroma,pick}.ts`, `src/render/{chroma-gpu,segmentation}.ts`, `src/engine/timeline/{speed-curve,speed-ramp,retime}.ts`, `src/engine/segmentation`, `src/platform/segmentation`, `src/engine/tracking`, `src/platform/tracking`, `src/engine/agent/{tools-vfx,tools-background,tools-motion}.ts`, `src/app/{background-removal,motion-analysis,color-pick,point-pick}.ts`, `src/ui/properties/{SpeedCurveEditor,BackgroundRemovalStatus,MotionTab}.tsx`, `src/ui/preview/{PickLayer,ColorPickCapture,PointPickCapture}.tsx`.
