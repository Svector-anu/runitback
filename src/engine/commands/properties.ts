import { mediaTime, type MediaTime } from "#/engine/time";
import {
  buildDefaultEffect, buildDefaultMask, isMaskable, isVisualElement, type AnimationInterpolation, type ElementRef, type Effect, type Mask,
  type MaskType, type ParamValue, type TimelineElement, type ParamValues,
} from "#/engine/model";
import {
  keyframeIdAtTime, removeKeyframe, removePathAnimation, retimeKeyframe, updateScalarCurve, upsertKeyframe,
  type ScalarCurvePatch,
} from "#/engine/animation";
import { getBaseValue, requireFiniteParams, getElement, replaceElement, resolvePathValue, setBaseValue } from "#/engine/timeline";
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
        const animations = upsertKeyframe({
          animations: el.animations, path: input.path, time, value: input.value,
          interpolation: input.interpolation, keyframeId: input.keyframeId, newId: ctx.newId,
        });
        return { ...el, animations };
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
  editEffects(ref, "Edit effect", (list) => (requireFiniteParams(params), list).map((e) => (e.id === effectId ? { ...e, params: { ...e.params, ...params } } : e)));
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
  editMasks(ref, "Edit mask", (masks) => (requireFiniteParams(params), masks).map((m) => (m.id === maskId ? { ...m, params: { ...m.params, ...params } } : m)));
export const toggleMaskInverted = (ref: ElementRef, maskId: string): Command =>
  editMasks(ref, "Invert mask", (masks) => masks.map((m) => (m.id === maskId ? { ...m, params: { ...m.params, inverted: m.params.inverted !== true } } : m)));

