# CapCut parity

Owner feedback: the editor must feel like CapCut. This lists what shipped for the CapCut-class basics, how each one fits the invariants, and what is still missing. Everything here is new relative to OpenCut classic (see `FEATURE_MATRIX.md`). Engine, render, agent tools and the editor controls are done; the list at the end records where each control lives.

## Shipped

| Feature | Model | Render | Agent tools | Tests |
|---|---|---|---|---|
| Transitions: cross dissolve, fade through black, slide left/right, wipe left/right, zoom | optional `transition { type, duration }` on the incoming video/image clip; at most half the shorter neighbour; touching clips only | `buildFramePlan` emits both clips with a `LayerTransition` (role + eased progress), window centred on the cut, source held on its first/last frame without handles; `transitionLook` is the one set of maths; `Compositor` applies alpha, shift, scale, darkness, reveal | `set_transition`, `add_transition`, `remove_transition` | `transitions`, fuzz, e2e `cc-transitions` (pixel + export decode) |
| Colour adjust + 8 filters (vivid, mono, warm, cool, fade, noir, teal-orange, sepia) | `adjust` effect definition (shows up in the inspector effect list and params automatically); presets are `FILTER_PRESETS` parameter bundles | `adjustPlan`: CSS filter chain (brightness/contrast/saturate), colour casts, vignette gradient, overlay high-pass sharpen; no pixel readback | `set_color_adjust`, `apply_filter` | `color-adjust`, fuzz, e2e `cc-color` |
| Text stroke, drop shadow, background box, letter spacing, line height | `stroke.*`, `shadow.*` params (box, spacing and line height already existed) | `drawTextLayout` | `set_text_style` | `text-style`, e2e `cc-text` |
| Text animation presets in/out: fade, slide-up, pop, typewriter, blur-in, word by word (stagger-words), typing caret (type-caret), count up | `textAnimation { in, out }` record + real keyframes on opacity, position Y, scale X/Y, `reveal`, `blur`, `wordReveal`, `countValue`; `type-caret` sets `caret`, `count-up` reads the number, prefix and suffix out of the text | existing keyframe resolution; `reveal` shows a fraction of the characters anchored at their final position; `blur` is the shared blur effect; `render/text.ts` draws words (stagger, highlight), the blinking caret and the formatted number | `set_text_animation`, `set_params` | `text-style`, `text-effects`, `count-up`, e2e `cc-text`, `fx-text` |
| Word highlight (accent word, karaoke sweep) | `highlightWord` (keyframable, stepped), `highlightColor`, `highlightSweep` text params | per-word drawing in `render/text.ts` | `set_params`; `add_captions_from_transcript` with `highlight` writes the stepped keys from the transcript word times | `caption-highlight`, `text-effects`, e2e `fx-text` |
| Transitions: blur dissolve, flash, glitch | the same optional `transition` record, three more types | `transitionLook` adds `blur`, `lightness` and a deterministic `glitch` (slices and channel split); flash and glitch show one clip per half like fade-black | `set_transition`, `add_transition` | `transition-effects`, e2e `fx-transitions` |
| Gradient and mesh canvas backgrounds | `Background { type: "gradient", style, colors, angle, motion }`, validated on every load and edit | `FramePlan.backgroundGradient`, painted under all layers from the plan time so preview and export match | `set_project` (`backgroundGradient`) | `gradient-background`, e2e `fx-background` |
| Cursor with click ripple | `cursor` graphic (`style`, colours, `click` 0-1); `setCursorPathCommand` writes eased position keys and click keys | sized graphic drawn at its laid-out size | `insert_cursor`, `set_cursor_path` | `cursor`, e2e `fx-graphics` |
| App frame (desktop, browser, plain card) | `app-frame` graphic (`style`, `fill`, `barColor`, `stroke`, `cornerRadius`) | sized graphic: corners and buttons stay round at any box | `insert_graphic` | `cursor`, e2e `fx-graphics` |
| Perspective tilt, drop shadow, rounded cards | `transform.rotateX/rotateY/perspective` params; `shadow` clip effect; `cornerRadius` on the rectangle mask | tilt is a triangle-mesh warp in the `Compositor` (per-triangle affine maps); the shadow is applied after mask and tilt | `set_params`, `add_effect`, `add_mask` | `tilt-shadow`, e2e `fx-cards` |
| Auto zoom | keyframes on scale and position written by `autoZoomCommand` (eased in, hold, eased back; several per clip) | ordinary keyframes | `auto_zoom` | `auto-zoom`, e2e `fx-cards` |
| Crop | `crop.left/top/right/bottom` params (fractions, 0-0.95, keyframeable) | cut from the source before the transform; the remainder stays in place | `set_crop` | `crop-freeze`, e2e `cc-crop-freeze` |
| Chroma key (green screen) with eyedropper | `chroma-key` clip effect (key colour, similarity, smoothness, spill) | WebGL2 shader in the `Compositor`, Canvas2D fallback | `set_chroma_key` | `chroma-key.test.ts`, `e2e/vfx-chroma.spec.ts`, `e2e/vfx-ui.spec.ts`, eval `green-screen-overlay` |
| Speed ramps (Montage, Hero time, Bullet, Jump cut ease, custom 2-6 points) | `retime.curve` over source time; duration is the integral | frame plan and audio pieces share `sourceTimeAt` | `set_speed_ramp` | `speed-ramp.test.ts` (fuzz), `e2e/vfx-speed.spec.ts`, eval `speed-ramp-hero` |
| Background removal (person) | `remove-background` clip effect, masks in IndexedDB | mask matte in the `Compositor` | `remove_background` | `segmentation.test.ts`, `e2e/vfx-segmentation.spec.ts` |
| Track a point, stabilise (translation only) | position keyframes on the following / stabilised clip | ordinary keyframes | `track_point`, `stabilize_clip` | `tracking.test.ts`, `motion-tools.test.ts`, `e2e/vfx-motion.spec.ts` |
| Freeze frame | image clip with `freezeAt` pointing at the video asset | plan emits a `video` layer at the fixed source time | `freeze_frame` | `crop-freeze`, e2e `cc-crop-freeze` |

Schema: version 2 (transitions), 3 (adjust effect), 4 (text params, `textAnimation`), 5 (crop params, `freezeAt`), 6 (speed curves, chroma key, background removal), 7 (the template effects above). All migrations are additive and change no data.

### Decisions

- **Transition on the incoming clip, centred on the cut.** Nothing moves, so no invariant changes. A clip with no source beyond its edge holds its first or last frame for the half-window. The `reconcileTransitions` reactor runs in `CommandManager.settle`, so moving, trimming, splitting or deleting so that the clips no longer touch removes the transition in the same undo step; the right half of a split and pasted/duplicated clips start without one.
- **Freeze frame is an image clip, not a retime hold.** A retime hold would need a rate of 0 (the engine's minimum is 0.01, which still drifts a frame) and would break `trimStart + duration * rate + trimEnd == sourceDuration`. An image clip has no source mapping to break, accepts any length, carries effects/masks/crop/transition, and is the same thing a user would build by hand. The insert ripples only the clip's own track.
- **Colour stays a regular effect**, so keyframes, enable/disable, reordering and the inspector already work; filters are not a second concept.
- **Typewriter is a `reveal` fraction**, not per-character content keyframes, so editing the text afterwards keeps working. Count-up is the same idea: `countValue` is a number that is keyframed, and the displayed digits are formatted from it at draw time.
- **Tilt warps the finished layer.** The compositor cuts the layer's content box into small triangles and paints each through the affine transform that matches the projection at its corners, so video, images, graphics and text tilt the same way. The canvas selection box and hit-testing ignore the tilt.
- **A keyframe on a parameter an older clip never stored creates its base value**, so new keyframeable parameters (tilt, blur, highlight) work on projects saved before they existed.

## Still missing versus CapCut

Stickers and emoji, text templates and curved text (project templates exist: `docs/TEMPLATES.md`), speed curves / ramps (only constant speed), reverse, beat sync (beat detection exists in analysis; no snap-to-beat editing UI), chroma key, background removal, tracking, keyframe graph editor beyond easing presets, LUT import, curves/HSL/colour wheels, split-tone grading (teal-orange here is a single cast), masks beyond the first, audio crossfade to match a transition, audio effects (denoise, voice changer, EQ), text-to-speech, auto captions styling presets and word-level highlight animation, transitions beyond the ten (spin, light leaks), per-clip transition in/out distinction, multi-clip compound clips, proxy media, cloud/team features.
Stickers and emoji, templates, reverse, beat sync (beat detection exists in analysis; no snap-to-beat editing UI), rotation/zoom stabilisation and planar tracking (speed ramps, chroma key, background removal, translation-only point tracking and stabilisation are in: `docs/VIDEO_FX.md`), keyframe graph editor beyond easing presets, LUT import, curves/HSL/colour wheels, split-tone grading (teal-orange here is a single cast), masks beyond the first, audio crossfade to match a transition, audio effects (denoise, voice changer, EQ), text-to-speech, auto captions styling presets (word highlight exists as an option and a text parameter, not as a preset or a button), text templates and curved text, transitions beyond the ten (spin, light leaks), per-clip transition in/out distinction, multi-clip compound clips, proxy media, cloud/team features.

## UI wiring (done in the editor, usable by hand)

| Control | Where | Wiring | e2e |
|---|---|---|---|
| Filter picker (Vivid, Mono, Warm, Cool, Fade, Noir, Teal-Orange, Sepia, None) with live swatches drawn from the clip's own thumbnail through `adjustPlan`, plus an intensity slider | Properties > Adjust > Filters (`src/ui/properties/AdjustPanel.tsx`) | `adjustCommand` = `addClipEffect` + `updateClipEffectParams` exactly like `apply_filter` (one `adjust` effect per clip, presets scaled and rounded the same way); None removes the effect; the picker recognises a look from the stored parameters (`matchPreset`), so a moved slider shows as "Custom" | `ctl-adjust` |
| Brightness, contrast, saturation, exposure, temperature, tint, vignette, sharpen sliders with reset | Properties > Adjust > Adjust | same effect; `editor.preview` while dragging, one committed command on release | `ctl-adjust` |
| Crop left/top/right/bottom sliders (0-95 %) with keyframe diamonds | Properties > Transform > Crop (video and image) | `CROP_FIELDS` through `ParamControl`, so `paramEditCommand` and the shared keyframe toggle apply | `ctl-crop-text` |
| Text stroke width/colour and shadow (enable, colour, blur, offset X/Y) | Properties > Style (text) | `STROKE_FIELDS` / `SHADOW_FIELDS` through `ParamControl` (keyframable, `paramEditCommand`) | `ctl-crop-text` |
| Text in/out animation pickers (None, Fade, Slide up, Pop, Typewriter, Blur, Word by word, Typing caret, Count up) with a length slider | Properties > Style > Animation | `setTextAnimationCommand` for one side at a time (`text-animation-logic.ts`) | `ctl-crop-text` |
| Transition handle at every cut between touching clips, filled when the cut has a transition; popover with the 10 types, a duration slider capped by `maxTransitionDuration`, remove | Timeline (`TransitionHandle.tsx`, cuts from `findCuts`) | `setTransitionCommand` on the incoming clip; the slider previews then commits | `ctl-transitions` |
| Freeze frame (default 2 s) | Clip context menu entry and a timeline toolbar button (video clip, playhead inside it) | `freezeFrameCommand({ ref, at: playhead, duration: 2 s })`; the still is an ordinary image clip, trim it to change the length | `ctl-freeze` |

Gesture rules: sliders fire `editor.preview` on `input` and one command on the native `change` (`SliderField`), so a drag is one undo step; discrete choices run one command. Unit tests: `tests/ui-adjust-logic.test.ts`, `tests/ui-timeline-controls.test.ts`.

| Text effects: blur, word reveal, typing caret, count-up number (format, decimals, before/after text), highlight word and colour | Properties > Style > Text effects | `TEXT_EFFECT_FIELDS` through `ParamControl` (keyframable where it makes sense) | `fx-text` |
| Tilt X/Y and perspective sliders with keyframe diamonds | Properties > Transform (any visual clip) | `TRANSFORM_FIELDS` | `fx-cards` |
| Drop shadow, rounded rectangle mask | Properties > Effects, Masks | the `shadow` effect definition and the rectangle mask's `cornerRadius` show up through the same definition-driven panels | `fx-cards` |
| Gradient background: presets, linear / radial / mesh, angle, motion | Settings > Background > Gradient | `updateSettings({ background })`; sliders preview then commit | `fx-background` |
| Cursor and app frame tiles | Assets > Graphics | `GRAPHIC_DEFINITIONS` (the inspector shows their parameters; the cursor path is set by the agent tools or by keyframing position and click) | `fx-graphics` |
| Auto zoom: amount and hold sliders, "Zoom into a spot in the preview" | Properties > Motion (video, image) | click the picture at the playhead; `autoZoomCommand` (`app/zoom-pick.ts`, `ZoomPickCapture.tsx`) | unit `auto-zoom` |

Still not wired in the UI: a length prompt for freeze frames (default only), a per-property curve editor for text animations, a cursor path editor (the agent tools and keyframes do it), and a button for word highlight on captions.

Still open elsewhere:

- Agent system prompt (`src/app/agent/system-prompt.ts`): mention the new tools if it lists tools by name.
- Canvas selection box and hit-testing ignore crop, stroke and shadow (`src/render/bounds.ts` is untouched so scale gestures stay correct).
