import { mediaTime, type MediaTime } from "#/engine/time";
import {
  buildDefaultEffect, buildDefaultMask, InvalidInputError, PARAM, TEXT_ANIMATION_PRESETS, TEXT_DEFAULTS, type TextAnimationSpec, type TextAnimationState, type TransitionType, clampParams, clampToLimit, isMaskable, limitForPath, limitsForEffect, limitsForMask, isVisualElement, type AnimationInterpolation, type ElementRef, type Effect, type Mask,
  type MaskType, type ParamValue, type TimelineElement, type ParamValues,
} from "#/engine/model";
import {
  applyTextAnimation, autoZoomAnimations, autoZoomProblem, cursorAnimations, cursorPathProblem, TEXT_ANIMATION_PATHS, type AutoZoom, type CursorWaypoint, keyframeIdAtTime, maxTextAnimationDuration, removeKeyframe, removePathAnimation, retimeKeyframe, updateScalarCurve, upsertKeyframe,
  type ScalarCurvePatch,
} from "#/engine/animation";
import {
  canHaveTransition, getBaseValue, getElement, isTransitionType, maxTransitionDuration, replaceElement, requireFiniteParams,
  requireTick, resolvePathValue, setBaseValue, transitionPartner, withoutTransition,
} from "#/engine/timeline";
import { inferCount } from "#/engine/render";
import { mapCurrentTracks, type Command, type CommandContext, type EditorDocument } from "./types";
import { updateElements } from "./timeline";

type WithEffects = TimelineElement & { effects?: Effect[]; masks?: Mask[] };

function editElement(
  doc: EditorDocument, ctx: CommandContext, ref: ElementRef, fn: (el: TimelineElement) => TimelineElement,
): EditorDocument {
  return mapCurrentTracks(doc, ctx, (tracks) => {
    const el = getElement(tracks, ref);
    if (!el) return tracks;
    const next = fn(el);
    return next === el ? tracks : replaceElement(tracks, ref, next);
  });
}

// ---- Keyframes -----------------------------------------------------------------------------------------------

export function upsertKeyframeCommand(input: {
  ref: ElementRef; path: string; time: number; value: ParamValue; interpolation?: AnimationInterpolation; keyframeId?: string;
}): Command {
  return {
    label: "Add keyframe",
    run(doc, ctx) {
      requireFiniteParams({ value: input.value });
      return { doc: editElement(doc, ctx, input.ref, (el) => {
        const time = mediaTime(Math.min(Math.max(0, Math.round(input.time)), el.duration));
        const limit = typeof input.value === "number" ? limitForPath(el, input.path) : null;
        const value = limit && typeof input.value === "number" ? clampToLimit(input.value, limit) : input.value;
        const animations = upsertKeyframe({
          animations: el.animations, path: input.path, time, value,
          interpolation: input.interpolation, keyframeId: input.keyframeId, newId: ctx.newId,
        });
        const keyed = { ...el, animations };
        // A parameter older clips never stored has no base value, and animated values are only read for parameters that have one.
        return getBaseValue(el, input.path) === undefined ? setBaseValue(keyed, input.path, value) : keyed;
      }) };
    },
  };
}

/** Removing the last key of a path bakes the value at `localTime` into the static value so nothing jumps. */
export function removeKeyframeCommand(input: { ref: ElementRef; path: string; keyframeId: string; localTime: number }): Command {
  return {
    label: "Remove keyframe",
    run(doc, ctx) {
      return { doc: editElement(doc, ctx, input.ref, (el) => {
        const baked = resolvePathValue(el, input.path, input.localTime);
        const animations = removeKeyframe({ animations: el.animations, path: input.path, keyframeId: input.keyframeId });
        let next: TimelineElement = { ...el };
        if (animations) next.animations = animations;
        else delete next.animations;
        if (!animations?.[input.path] && baked !== undefined) next = setBaseValue(next, input.path, baked);
        return next;
      }) };
    },
  };
}

export function retimeKeyframeCommand(input: { ref: ElementRef; path: string; keyframeId: string; nextTime: number }): Command {
  return {
    label: "Move keyframe",
    run(doc, ctx) {
      return { doc: editElement(doc, ctx, input.ref, (el) => {
        const nextTime = mediaTime(Math.min(Math.max(0, Math.round(input.nextTime)), el.duration));
        return { ...el, animations: retimeKeyframe({ animations: el.animations, path: input.path, keyframeId: input.keyframeId, nextTime }) };
      }) };
    },
  };
}

export function updateKeyframeCurveCommand(input: { ref: ElementRef; path: string; keyframeId: string; patch: ScalarCurvePatch; component?: "r" | "g" | "b" | "a" | "value" }): Command {
  return {
    label: "Edit easing",
    run: (doc, ctx) => ({ doc: editElement(doc, ctx, input.ref, (el) => ({
      ...el, animations: updateScalarCurve({ animations: el.animations, path: input.path, component: input.component, keyframeId: input.keyframeId, patch: input.patch }),
    })) }),
  };
}

export function clearPathAnimationCommand(input: { ref: ElementRef; path: string; localTime: number }): Command {
  return {
    label: "Remove animation",
    run: (doc, ctx) => ({ doc: editElement(doc, ctx, input.ref, (el) => {
      const baked = resolvePathValue(el, input.path, input.localTime);
      const animations = removePathAnimation(el.animations, input.path);
      let next: TimelineElement = { ...el };
      if (animations) next.animations = animations;
      else delete next.animations;
      if (baked !== undefined) next = setBaseValue(next, input.path, baked);
      return next;
    }) }),
  };
}

export interface KeyframeClipboardItem {
  path: string;
  timeOffset: number;
  value: ParamValue;
  interpolation: AnimationInterpolation;
}

/** Keyframes paste relative to the target element's start, so the playhead is converted to element-local time. */
export function pasteKeyframesCommand(input: { ref: ElementRef; playhead: number; items: ReadonlyArray<KeyframeClipboardItem> }): Command {
  return {
    label: "Paste keyframes",
    run(doc, ctx) {
      return { doc: editElement(doc, ctx, input.ref, (el) => {
        let animations = el.animations;
        for (const item of input.items) {
          if (getBaseValue(el, item.path) === undefined) continue;
          const local = Math.min(Math.max(0, input.playhead - el.startTime + item.timeOffset), el.duration);
          animations = upsertKeyframe({ animations, path: item.path, time: mediaTime(Math.round(local)), value: item.value, interpolation: item.interpolation, newId: ctx.newId });
        }
        return { ...el, animations };
      }) };
    },
  };
}

export function keyframeIdAt(el: TimelineElement, path: string, time: MediaTime): string | undefined {
  return keyframeIdAtTime(el.animations, path, time);
}

// ---- Params --------------------------------------------------------------------------------------------------

export function setElementParams(input: { refs: ReadonlyArray<ElementRef>; params: ParamValues; label?: string }): Command {
  return updateElements(input.refs.map((ref) => ({ ref, patch: { params: input.params } })), input.label ?? "Edit properties");
}

// ---- Effects -------------------------------------------------------------------------------------------------

export function addClipEffect(input: { ref: ElementRef; effectType: string; effectId?: string }): Command {
  return {
    label: "Add effect",
    run(doc, ctx) {
      const effect = buildDefaultEffect(input.effectType, input.effectId ?? ctx.newId());
      return { doc: editElement(doc, ctx, input.ref, (el) =>
        isVisualElement(el) ? ({ ...el, effects: [...(el.effects ?? []), effect] } as TimelineElement) : el) };
    },
  };
}

function editEffects(ref: ElementRef, label: string, fn: (effects: Effect[]) => Effect[]): Command {
  return {
    label,
    run: (doc, ctx) => ({ doc: editElement(doc, ctx, ref, (el) => {
      const effects = (el as WithEffects).effects;
      if (!effects) return el;
      return { ...el, effects: fn(effects) } as TimelineElement;
    }) }),
  };
}

export const removeClipEffect = (ref: ElementRef, effectId: string): Command =>
  editEffects(ref, "Remove effect", (list) => list.filter((e) => e.id !== effectId));
export const toggleClipEffect = (ref: ElementRef, effectId: string): Command =>
  editEffects(ref, "Toggle effect", (list) => list.map((e) => (e.id === effectId ? { ...e, enabled: !e.enabled } : e)));
export const updateClipEffectParams = (ref: ElementRef, effectId: string, params: ParamValues): Command =>
  editEffects(ref, "Edit effect", (list) => (requireFiniteParams(params), list).map((e) => (e.id === effectId
    ? { ...e, params: clampParams({ ...e.params, ...params }, limitsForEffect(e)) } : e)));
export function reorderClipEffects(ref: ElementRef, fromIndex: number, toIndex: number): Command {
  return editEffects(ref, "Reorder effects", (list) => {
    if (fromIndex === toIndex || fromIndex < 0 || fromIndex >= list.length) return list;
    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(Math.min(Math.max(0, toIndex), next.length), 0, moved as Effect);
    return next;
  });
}

// ---- Masks ---------------------------------------------------------------------------------------------------

function editMasks(ref: ElementRef, label: string, fn: (masks: Mask[], ctx: CommandContext) => Mask[]): Command {
  return {
    label,
    run: (doc, ctx) => ({ doc: editElement(doc, ctx, ref, (el) => {
      if (!isMaskable(el)) return el;
      return { ...el, masks: fn((el as WithEffects).masks ?? [], ctx) } as TimelineElement;
    }) }),
  };
}

export const addMask = (ref: ElementRef, type: MaskType): Command =>
  editMasks(ref, "Add mask", (masks, ctx) => [...masks, buildDefaultMask(type, ctx.newId())]);
export const removeMask = (ref: ElementRef, maskId: string): Command =>
  editMasks(ref, "Remove mask", (masks) => masks.filter((m) => m.id !== maskId));
export const updateMaskParams = (ref: ElementRef, maskId: string, params: ParamValues): Command =>
  editMasks(ref, "Edit mask", (masks) => (requireFiniteParams(params), masks).map((m) => (m.id === maskId
    ? { ...m, params: clampParams({ ...m.params, ...params }, limitsForMask(m)) } : m)));
export const toggleMaskInverted = (ref: ElementRef, maskId: string): Command =>
  editMasks(ref, "Invert mask", (masks) => masks.map((m) => (m.id === maskId ? { ...m, params: { ...m.params, inverted: m.params.inverted !== true } } : m)));


// ---- Transitions ---------------------------------------------------------------------------------------------

/**
 * Sets (or with `null` removes) the transition INTO a clip from the clip that ends exactly where it starts.
 * Requested lengths above half of the shorter clip are clamped; a clip with no touching predecessor is rejected.
 */
export function setTransitionCommand(input: { ref: ElementRef; transition: { type: TransitionType; duration: number } | null }): Command {
  return {
    label: input.transition ? "Set transition" : "Remove transition",
    run(doc, ctx) {
      const { transition } = input;
      if (transition) {
        if (!isTransitionType(transition.type)) throw new InvalidInputError(`Unknown transition type "${String(transition.type)}"`);
        requireTick("transition duration", Math.round(transition.duration), 1);
      }
      return { doc: mapCurrentTracks(doc, ctx, (tracks) => {
        const element = getElement(tracks, input.ref);
        if (!element) throw new InvalidInputError(`No element ${input.ref.elementId} on track ${input.ref.trackId}`);
        if (!canHaveTransition(element)) throw new InvalidInputError(`A ${element.type} clip cannot have a transition (video and image clips only)`);
        if (!transition) {
          if (!element.transition) return tracks;
          return replaceElement(tracks, input.ref, withoutTransition(element));
        }
        const siblings = [...tracks.overlay, tracks.main].find((t) => t.id === input.ref.trackId)?.elements as TimelineElement[] | undefined;
        const partner = siblings ? transitionPartner(siblings, element) : null;
        if (!partner) throw new InvalidInputError(`Clip ${element.id} has no clip ending exactly where it starts on its track, so there is nothing to transition from`);
        const duration = Math.min(Math.round(transition.duration), maxTransitionDuration(partner, element));
        if (duration < 1) throw new InvalidInputError("The neighbouring clips are too short for a transition");
        return replaceElement(tracks, input.ref, { ...element, transition: { type: transition.type, duration: mediaTime(duration) } } as TimelineElement);
      }) };
    },
  };
}

// ---- Text animation presets ----------------------------------------------------------------------------------

/**
 * The params a text animation needs to find in place: defaults for every parameter a preset keys (so there is a base value
 * to animate to), the caret for `type-caret`, and the number read out of the text for `count-up`.
 */
function textAnimationParams(el: Extract<TimelineElement, { type: "text" }>, state: TextAnimationState): ParamValues {
  let params = el.params;
  const missing = Object.entries(TEXT_DEFAULTS).filter(([key]) => (TEXT_ANIMATION_PATHS as readonly string[]).includes(key) && params[key] === undefined);
  if (missing.length > 0) params = { ...params, ...Object.fromEntries(missing) };
  const presets = [state.in?.preset, state.out?.preset];
  if (presets.includes("type-caret")) params = { ...params, [PARAM.caret]: true };
  if (presets.includes("count-up") && params[PARAM.countEnabled] !== true) {
    const inferred = inferCount(String(params[PARAM.content] ?? ""));
    if (!inferred) throw new InvalidInputError("Count up needs a number in the text, like 1,200 or $5");
    params = {
      ...params, [PARAM.countEnabled]: true, [PARAM.countValue]: inferred.value, [PARAM.countFormat]: inferred.format,
      [PARAM.countDecimals]: inferred.decimals, [PARAM.countPrefix]: inferred.prefix, [PARAM.countSuffix]: inferred.suffix,
    };
  }
  return params;
}

/**
 * Sets the in and/or out animation preset of a text clip (`undefined` keeps that side, `null` removes it). The presets
 * are written as ordinary keyframes on opacity, position Y, scale and `reveal`, replacing whatever keyframes those
 * parameters had; lengths clamp to half of the clip. One undo step.
 */
export function setTextAnimationCommand(input: { ref: ElementRef; in?: TextAnimationSpec | null; out?: TextAnimationSpec | null }): Command {
  return {
    label: "Text animation",
    run(doc, ctx) {
      for (const spec of [input.in, input.out]) {
        if (!spec) continue;
        if (!(TEXT_ANIMATION_PRESETS as readonly string[]).includes(spec.preset)) throw new InvalidInputError(`Unknown text animation "${String(spec.preset)}"`);
        requireTick("text animation duration", Math.round(spec.duration), 1);
      }
      return { doc: editElement(doc, ctx, input.ref, (el) => {
        if (el.type !== "text") throw new InvalidInputError(`Text animations apply to text clips, not ${el.type}`);
        const limit = maxTextAnimationDuration(el.duration);
        if (limit < 1) throw new InvalidInputError("The clip is too short for a text animation");
        const clamp = (spec: TextAnimationSpec): TextAnimationSpec => ({ preset: spec.preset, duration: mediaTime(Math.min(Math.round(spec.duration), limit)) });
        const next: TextAnimationState = {};
        const incoming = input.in === undefined ? el.textAnimation?.in : input.in;
        const outgoing = input.out === undefined ? el.textAnimation?.out : input.out;
        if (incoming) next.in = clamp(incoming);
        if (outgoing) next.out = clamp(outgoing);
        const params = textAnimationParams(el, next);
        const animations = applyTextAnimation({
          animations: el.animations, state: next, clipDuration: el.duration, params, canvasHeight: doc.settings.canvasSize.height, newId: ctx.newId,
        });
        const out: TimelineElement = { ...el, params };
        if (animations) out.animations = animations; else delete out.animations;
        if (next.in || next.out) (out as { textAnimation?: TextAnimationState }).textAnimation = next;
        else delete (out as { textAnimation?: TextAnimationState }).textAnimation;
        return out;
      }) };
    },
  };
}

// ---- Cursor path ---------------------------------------------------------------------------------------------

/**
 * Moves a cursor graphic through `waypoints` (ticks from the clip start, px from the canvas centre) and plays the click
 * ripple at the clicking stops. The static position becomes the first stop. One undo step.
 */
export function setCursorPathCommand(input: { ref: ElementRef; waypoints: ReadonlyArray<CursorWaypoint> }): Command {
  return {
    label: "Cursor path",
    run(doc, ctx) {
      return { doc: editElement(doc, ctx, input.ref, (el) => {
        if (el.type !== "graphic" || el.definitionId !== "cursor") throw new InvalidInputError("A cursor path applies to cursor graphics");
        const problem = cursorPathProblem({ waypoints: input.waypoints, clipDuration: el.duration });
        if (problem) throw new InvalidInputError(`Cannot apply the cursor path: ${problem}`);
        const first = input.waypoints[0] as CursorWaypoint;
        const animations = cursorAnimations({ animations: el.animations, waypoints: input.waypoints, clipDuration: el.duration, newId: ctx.newId });
        return { ...el, animations, params: { ...el.params, [PARAM.positionX]: first.x, [PARAM.positionY]: first.y, click: 0 } };
      }) };
    },
  };
}

// ---- Auto zoom -----------------------------------------------------------------------------------------------

/**
 * Pushes a video, image or graphic clip in on points of its picture, easing in, holding and easing back (see `autoZoomAnimations`).
 * Replaces the clip's keyframes on scale and position. One undo step.
 */
export function autoZoomCommand(input: { ref: ElementRef; zooms: ReadonlyArray<AutoZoom> }): Command {
  return {
    label: "Auto zoom",
    run(doc, ctx) {
      return { doc: editElement(doc, ctx, input.ref, (el) => {
        if (el.type !== "video" && el.type !== "image" && el.type !== "graphic") throw new InvalidInputError("Auto zoom applies to video, image and graphic clips");
        const problem = autoZoomProblem({ zooms: input.zooms, clipDuration: el.duration });
        if (problem) throw new InvalidInputError(`Cannot apply auto zoom: ${problem}`);
        return { ...el, animations: autoZoomAnimations({ animations: el.animations, params: el.params, zooms: input.zooms, newId: ctx.newId }) };
      }) };
    },
  };
}
