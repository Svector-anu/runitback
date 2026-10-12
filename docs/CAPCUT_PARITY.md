# CapCut parity

Owner feedback: the editor must feel like CapCut. This lists what shipped for the CapCut-class basics, how each one fits the invariants, and what is still missing. Everything here is new relative to OpenCut classic (see `FEATURE_MATRIX.md`). Engine, render and agent tools are done; the UI wiring list at the end is what still has to be hooked up in `src/ui`.

## Shipped

| Feature | Model | Render | Agent tools | Tests |
|---|---|---|---|---|
| Transitions: cross dissolve, fade through black, slide left/right, wipe left/right, zoom | optional `transition { type, duration }` on the incoming video/image clip; at most half the shorter neighbour; touching clips only | `buildFramePlan` emits both clips with a `LayerTransition` (role + eased progress), window centred on the cut, source held on its first/last frame without handles; `transitionLook` is the one set of maths; `Compositor` applies alpha, shift, scale, darkness, reveal | `set_transition`, `add_transition`, `remove_transition` | `transitions`, fuzz, e2e `cc-transitions` (pixel + export decode) |
| Colour adjust + 8 filters (vivid, mono, warm, cool, fade, noir, teal-orange, sepia) | `adjust` effect definition (shows up in the inspector effect list and params automatically); presets are `FILTER_PRESETS` parameter bundles | `adjustPlan`: CSS filter chain (brightness/contrast/saturate), colour casts, vignette gradient, overlay high-pass sharpen; no pixel readback | `set_color_adjust`, `apply_filter` | `color-adjust`, fuzz, e2e `cc-color` |
| Text stroke, drop shadow, background box, letter spacing, line height | `stroke.*`, `shadow.*` params (box, spacing and line height already existed) | `drawTextLayout` | `set_text_style` | `text-style`, e2e `cc-text` |
| Text animation presets in/out: fade, slide-up, pop, typewriter | `textAnimation { in, out }` record + real keyframes on opacity, position Y, scale X/Y, `reveal` | existing keyframe resolution; `reveal` shows a fraction of the characters anchored at their final position | `set_text_animation` | `text-style`, e2e `cc-text` |
| Crop | `crop.left/top/right/bottom` params (fractions, 0-0.95, keyframeable) | cut from the source before the transform; the remainder stays in place | `set_crop` | `crop-freeze`, e2e `cc-crop-freeze` |
| Freeze frame | image clip with `freezeAt` pointing at the video asset | plan emits a `video` layer at the fixed source time | `freeze_frame` | `crop-freeze`, e2e `cc-crop-freeze` |

Schema: version 2 (transitions), 3 (adjust effect), 4 (text params, `textAnimation`), 5 (crop params, `freezeAt`). All migrations are additive and change no data.

### Decisions

- **Transition on the incoming clip, centred on the cut.** Nothing moves, so no invariant changes. A clip with no source beyond its edge holds its first or last frame for the half-window. The `reconcileTransitions` reactor runs in `CommandManager.settle`, so moving, trimming, splitting or deleting so that the clips no longer touch removes the transition in the same undo step; the right half of a split and pasted/duplicated clips start without one.
- **Freeze frame is an image clip, not a retime hold.** A retime hold would need a rate of 0 (the engine's minimum is 0.01, which still drifts a frame) and would break `trimStart + duration * rate + trimEnd == sourceDuration`. An image clip has no source mapping to break, accepts any length, carries effects/masks/crop/transition, and is the same thing a user would build by hand. The insert ripples only the clip's own track.
- **Colour stays a regular effect**, so keyframes, enable/disable, reordering and the inspector already work; filters are not a second concept.
- **Typewriter is a `reveal` fraction**, not per-character content keyframes, so editing the text afterwards keeps working.

## Still missing versus CapCut

Stickers and emoji, templates, speed curves / ramps (only constant speed), reverse, beat sync (beat detection exists in analysis; no snap-to-beat editing UI), chroma key, background removal, tracking, keyframe graph editor beyond easing presets, LUT import, curves/HSL/colour wheels, split-tone grading (teal-orange here is a single cast), masks beyond the first, audio crossfade to match a transition, audio effects (denoise, voice changer, EQ), text-to-speech, auto captions styling presets and word-level highlight animation, text templates and curved text, transitions beyond the seven (glitch, spin, blur, light leaks), per-clip transition in/out distinction, multi-clip compound clips, proxy media, cloud/team features.

## UI wiring still needed (not done; `src/ui` and `src/app/agent` are owned elsewhere)

- Inspector: effect list already shows `Colour adjust` and its eight sliders from the definition. Missing: a filter picker (use `FILTER_PRESETS`, apply with `addClipEffect` + `updateClipEffectParams` as `apply_filter` does).
- Inspector, video/image: four crop sliders (`crop.*`, 0-0.95). Text: stroke width/colour, shadow (enabled, colour, blur, offsets), `reveal` is animation-only.
- Text animation picker: call `setTextAnimationCommand({ ref, in, out })`.
- Transition UI: a handle at a cut between touching clips calling `setTransitionCommand({ ref: incomingClip, transition: { type, duration } | null })`; `TRANSITION_NAMES` has labels, `maxTransitionDuration` the cap.
- Freeze frame: the context-menu stub should call `freezeFrameCommand({ ref, at: playhead, duration })`.
- Agent system prompt (`src/app/agent/system-prompt.ts`): mention the new tools if it lists tools by name.
- Canvas selection box and hit-testing ignore crop, stroke and shadow (`src/render/bounds.ts` is untouched so scale gestures stay correct).
