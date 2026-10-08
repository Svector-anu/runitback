import { mediaTime, roundMediaTime, type MediaTime } from "#/engine/time";
import type {
  AnimationBinding, AnimationInterpolation, Channel, CurveHandle, DiscreteChannel, DiscreteKey, ElementAnimations,
  IdGenerator, ParamValue, ScalarChannel, ScalarKey, SegmentType, TangentMode,
} from "#/engine/model";
import { solveParameterForX, subdivideCubic } from "./bezier";
import { formatLinearRgba, parseHexToLinearRgba } from "./color";
import { evaluateScalarChannel, isScalarChannel, segmentControlPoints } from "./evaluate";

const COLOR_COMPONENTS = ["r", "g", "b", "a"] as const;
type ColorComponent = (typeof COLOR_COMPONENTS)[number];

function segmentFor(interpolation: AnimationInterpolation): SegmentType {
  return interpolation === "hold" ? "step" : interpolation;
}

function sortKeys<T extends { time: number }>(keys: T[]): T[] {
  return [...keys].sort((a, b) => a.time - b.time);
}

export function isColorPath(path: string, value: ParamValue): boolean {
  return typeof value === "string" && (path === "color" || path.endsWith(".color")) && parseHexToLinearRgba(value) !== null;
}

function isEmptyBinding(binding: AnimationBinding): boolean {
  return binding.kind === "channel"
    ? binding.channel.keys.length === 0
    : COLOR_COMPONENTS.every((c) => binding.channels[c].keys.length === 0);
}

function dropEmpty(animations: ElementAnimations): ElementAnimations | undefined {
  const next: ElementAnimations = {};
  for (const [path, binding] of Object.entries(animations)) {
    if (binding && !isEmptyBinding(binding)) next[path] = binding;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function bindingChannels(binding: AnimationBinding): Channel[] {
  return binding.kind === "channel" ? [binding.channel] : COLOR_COMPONENTS.map((c) => binding.channels[c]);
}

function mapBinding(binding: AnimationBinding, fn: <C extends Channel>(channel: C) => C): AnimationBinding {
  if (binding.kind === "channel") return { kind: "channel", channel: fn(binding.channel) };
  const c = binding.channels;
  return { kind: "color", channels: { r: fn(c.r), g: fn(c.g), b: fn(c.b), a: fn(c.a) } };
}

function findKeyframeIdAtTime(binding: AnimationBinding | undefined, time: number): string | undefined {
  if (!binding) return undefined;
  for (const channel of bindingChannels(binding)) {
    const hit = channel.keys.find((k) => k.time === time);
    if (hit) return hit.id;
  }
  return undefined;
}

export function keyframeIdAtTime(animations: ElementAnimations | undefined, path: string, time: number): string | undefined {
  return findKeyframeIdAtTime(animations?.[path], time);
}

function upsertScalarKey(channel: ScalarChannel | undefined, input: {
  time: MediaTime; value: number; id: string; segment: SegmentType | undefined;
}): ScalarChannel {
  const keys = channel?.keys ?? [];
  const existing = keys.find((k) => k.id === input.id || k.time === input.time);
  const next: ScalarKey = existing
    ? { ...existing, time: input.time, value: input.value, segmentToNext: input.segment ?? existing.segmentToNext }
    : { id: input.id, time: input.time, value: input.value, segmentToNext: input.segment ?? "linear", tangentMode: "flat" };
  const others = keys.filter((k) => k !== existing);
  return { ...channel, kind: "scalar", keys: sortKeys([...others, next]) };
}

function upsertDiscreteKey(channel: DiscreteChannel | undefined, input: { time: MediaTime; value: boolean | string; id: string }): DiscreteChannel {
  const keys = channel?.keys ?? [];
  const existing = keys.find((k) => k.id === input.id || k.time === input.time);
  const next: DiscreteKey = { id: existing?.id ?? input.id, time: input.time, value: input.value };
  return { kind: "discrete", keys: sortKeys([...keys.filter((k) => k !== existing), next]) };
}

export function upsertKeyframe(input: {
  animations: ElementAnimations | undefined;
  path: string;
  time: MediaTime;
  value: ParamValue;
  interpolation?: AnimationInterpolation;
  keyframeId?: string;
  newId: IdGenerator;
}): ElementAnimations {
  const animations: ElementAnimations = { ...input.animations };
  const existing = animations[input.path];
  const id = input.keyframeId ?? findKeyframeIdAtTime(existing, input.time) ?? input.newId();
  const segment = input.interpolation ? segmentFor(input.interpolation) : undefined;
  const { value } = input;

  if (typeof value === "number") {
    const channel = existing?.kind === "channel" && isScalarChannel(existing.channel) ? existing.channel : undefined;
    animations[input.path] = { kind: "channel", channel: upsertScalarKey(channel, { time: input.time, value, id, segment }) };
    return animations;
  }
  if (isColorPath(input.path, value)) {
    const rgba = parseHexToLinearRgba(value as string);
    if (!rgba) return animations;
    const base = existing?.kind === "color" ? existing.channels : undefined;
    animations[input.path] = {
      kind: "color",
      channels: {
        r: upsertScalarKey(base?.r, { time: input.time, value: rgba.r, id, segment }),
        g: upsertScalarKey(base?.g, { time: input.time, value: rgba.g, id, segment }),
        b: upsertScalarKey(base?.b, { time: input.time, value: rgba.b, id, segment }),
        a: upsertScalarKey(base?.a, { time: input.time, value: rgba.a, id, segment }),
      },
    };
    return animations;
  }
  const channel = existing?.kind === "channel" && !isScalarChannel(existing.channel) ? existing.channel : undefined;
  animations[input.path] = {
    kind: "channel",
    channel: upsertDiscreteKey(channel, { time: input.time, value: value as boolean | string, id }),
  };
  return animations;
}

export function removeKeyframe(input: { animations: ElementAnimations | undefined; path: string; keyframeId: string }): ElementAnimations | undefined {
  const binding = input.animations?.[input.path];
  if (!input.animations || !binding) return input.animations;
  const next = mapBinding(binding, (channel) => ({ ...channel, keys: channel.keys.filter((k) => k.id !== input.keyframeId) }) as typeof channel);
  return dropEmpty({ ...input.animations, [input.path]: next });
}

export function removePathAnimation(animations: ElementAnimations | undefined, path: string): ElementAnimations | undefined {
  if (!animations) return undefined;
  const rest = { ...animations };
  delete rest[path];
  return dropEmpty(rest);
}

export function retimeKeyframe(input: { animations: ElementAnimations | undefined; path: string; keyframeId: string; nextTime: MediaTime }): ElementAnimations | undefined {
  const binding = input.animations?.[input.path];
  if (!input.animations || !binding) return input.animations;
  const next = mapBinding(binding, (channel) => {
    const keys = channel.keys.map((k) => (k.id === input.keyframeId ? { ...k, time: input.nextTime } : k));
    return { ...channel, keys: sortKeys(keys) } as typeof channel;
  });
  return { ...input.animations, [input.path]: next };
}

export interface ScalarCurvePatch {
  leftHandle?: CurveHandle | null;
  rightHandle?: CurveHandle | null;
  segmentToNext?: SegmentType;
  tangentMode?: TangentMode;
}

export function updateScalarCurve(input: {
  animations: ElementAnimations | undefined; path: string; component?: ColorComponent | "value";
  keyframeId: string; patch: ScalarCurvePatch;
}): ElementAnimations | undefined {
  const binding = input.animations?.[input.path];
  if (!input.animations || !binding) return input.animations;
  const apply = (channel: ScalarChannel): ScalarChannel => ({
    ...channel,
    keys: channel.keys.map((k) => {
      if (k.id !== input.keyframeId) return k;
      const { leftHandle, rightHandle, ...rest } = input.patch;
      const next: ScalarKey = { ...k, ...rest };
      if (leftHandle === null) delete next.leftHandle;
      else if (leftHandle) next.leftHandle = leftHandle;
      if (rightHandle === null) delete next.rightHandle;
      else if (rightHandle) next.rightHandle = rightHandle;
      return next;
    }),
  });
  if (binding.kind === "channel") {
    if (!isScalarChannel(binding.channel)) return input.animations;
    return { ...input.animations, [input.path]: { kind: "channel", channel: apply(binding.channel) } };
  }
  const only = input.component && input.component !== "value" ? input.component : undefined;
  const pick = (name: ColorComponent): ScalarChannel => (!only || only === name ? apply(binding.channels[name]) : binding.channels[name]);
  return { ...input.animations, [input.path]: { kind: "color", channels: { r: pick("r"), g: pick("g"), b: pick("b"), a: pick("a") } } };
}

export interface FlatKeyframe {
  path: string;
  id: string;
  time: MediaTime;
  value: ParamValue;
  interpolation: AnimationInterpolation;
}

export function listKeyframes(animations: ElementAnimations | undefined): FlatKeyframe[] {
  const out: FlatKeyframe[] = [];
  for (const [path, binding] of Object.entries(animations ?? {})) {
    if (!binding) continue;
    if (binding.kind === "color") {
      for (const key of binding.channels.a.keys) {
        const t = key.time;
        const value = formatLinearRgba({
          r: evaluateScalarChannel(binding.channels.r, t, 0),
          g: evaluateScalarChannel(binding.channels.g, t, 0),
          b: evaluateScalarChannel(binding.channels.b, t, 0),
          a: evaluateScalarChannel(binding.channels.a, t, 1),
        });
        out.push({ path, id: key.id, time: t, value, interpolation: key.segmentToNext === "step" ? "hold" : key.segmentToNext });
      }
    } else if (isScalarChannel(binding.channel)) {
      for (const key of binding.channel.keys) {
        out.push({ path, id: key.id, time: key.time, value: key.value, interpolation: key.segmentToNext === "step" ? "hold" : key.segmentToNext });
      }
    } else {
      for (const key of binding.channel.keys) out.push({ path, id: key.id, time: key.time, value: key.value, interpolation: "hold" });
    }
  }
  return out.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
}

export function cloneAnimations(input: { animations: ElementAnimations | undefined; regenerateIds?: IdGenerator }): ElementAnimations | undefined {
  if (!input.animations) return undefined;
  const regen = input.regenerateIds;
  const out: ElementAnimations = {};
  for (const [path, binding] of Object.entries(input.animations)) {
    if (!binding) continue;
    const idMap = new Map<string, string>();
    const remap = (id: string): string => {
      if (!regen) return id;
      let mapped = idMap.get(id);
      if (!mapped) {
        mapped = regen();
        idMap.set(id, mapped);
      }
      return mapped;
    };
    out[path] = mapBinding(binding, (channel) => ({
      ...channel,
      keys: (channel.keys as Array<{ id: string }>).map((k) => ({ ...k, id: remap(k.id) })),
    }) as typeof channel);
  }
  return out;
}

function rebase(keys: ScalarKey[], by: number): ScalarKey[] {
  return keys.map((k) => ({ ...k, time: mediaTime(k.time - by) }));
}

function stripEdgeHandles(keys: ScalarKey[]): ScalarKey[] {
  return keys.map((k, i) => {
    const next = { ...k };
    if (i === 0) delete next.leftHandle;
    if (i === keys.length - 1) delete next.rightHandle;
    return next;
  });
}

type SplitIds = { left: string; right: string };

function splitScalarChannel(channel: ScalarChannel, at: number, include: boolean, ids: SplitIds): [ScalarChannel | undefined, ScalarChannel | undefined] {
  const keys = sortKeys(channel.keys);
  const exact = keys.find((k) => k.time === at);
  let leftKeys = keys.filter((k) => k.time < at);
  let rightKeys = keys.filter((k) => k.time > at);
  const prev = leftKeys[leftKeys.length - 1];
  const next = rightKeys[0];

  if (include) {
    if (exact) {
      leftKeys = [...leftKeys, exact];
      rightKeys = [{ ...exact, id: ids.right }, ...rightKeys];
    } else {
      const value = evaluateScalarChannel(channel, at, 0);
      const t = mediaTime(at);
      let leftEnd: ScalarKey = { id: ids.left, time: t, value, segmentToNext: "linear", tangentMode: "flat" };
      let rightStart: ScalarKey = { id: ids.right, time: t, value, segmentToNext: "linear", tangentMode: "flat" };
      if (prev && next) {
        if (prev.segmentToNext === "bezier") {
          const seg = segmentControlPoints(prev, next);
          const u = solveParameterForX(seg.p0, seg.p1, seg.p2, seg.p3, at);
          const { left, right } = subdivideCubic(seg.p0, seg.p1, seg.p2, seg.p3, u);
          const rel = (p: { x: number; y: number }, o: { x: number; y: number }): CurveHandle => ({ dt: roundMediaTime(p.x - o.x), dv: p.y - o.y });
          leftKeys = leftKeys.map((k) => (k.id === prev.id ? { ...k, rightHandle: rel(left[1], left[0]) } : k));
          leftEnd = { ...leftEnd, leftHandle: rel(left[2], left[3]) };
          rightStart = { ...rightStart, segmentToNext: "bezier", rightHandle: rel(right[1], right[0]) };
          rightKeys = rightKeys.map((k) => (k.id === next.id ? { ...k, leftHandle: rel(right[2], right[3]) } : k));
        } else {
          rightStart = { ...rightStart, segmentToNext: prev.segmentToNext };
        }
      }
      leftKeys = [...leftKeys, leftEnd];
      rightKeys = [rightStart, ...rightKeys];
    }
  } else if (exact) {
    rightKeys = [exact, ...rightKeys];
  }

  const left = leftKeys.length > 0 ? { ...channel, keys: stripEdgeHandles(leftKeys) } : undefined;
  const right = rightKeys.length > 0 ? { ...channel, keys: stripEdgeHandles(rebase(rightKeys, at)) } : undefined;
  return [left, right];
}

function splitDiscreteChannel(channel: DiscreteChannel, at: number, include: boolean, ids: SplitIds): [DiscreteChannel | undefined, DiscreteChannel | undefined] {
  const keys = sortKeys(channel.keys);
  const leftKeys = keys.filter((k) => k.time < at || (include && k.time === at));
  let rightKeys = keys.filter((k) => k.time >= at);
  if (include && !rightKeys.some((k) => k.time === at)) {
    const held = [...keys].reverse().find((k) => k.time <= at);
    if (held) rightKeys = [{ id: ids.right, time: mediaTime(at), value: held.value }, ...rightKeys];
  }
  const shifted = rightKeys.map((k) => ({ ...k, time: mediaTime(k.time - at) }));
  return [
    leftKeys.length ? { kind: "discrete", keys: leftKeys } : undefined,
    shifted.length ? { kind: "discrete", keys: shifted } : undefined,
  ];
}

export function splitAnimationsAtTime(input: {
  animations: ElementAnimations | undefined; splitTime: number; includeBoundary?: boolean; newId: IdGenerator;
}): { left: ElementAnimations | undefined; right: ElementAnimations | undefined } {
  if (!input.animations) return { left: undefined, right: undefined };
  const include = input.includeBoundary ?? true;
  const left: ElementAnimations = {};
  const right: ElementAnimations = {};
  for (const [path, binding] of Object.entries(input.animations)) {
    if (!binding) continue;
    const ids: SplitIds = { left: input.newId(), right: input.newId() };
    if (binding.kind === "channel") {
      const [l, r] = isScalarChannel(binding.channel)
        ? splitScalarChannel(binding.channel, input.splitTime, include, ids)
        : splitDiscreteChannel(binding.channel, input.splitTime, include, ids);
      if (l) left[path] = { kind: "channel", channel: l };
      if (r) right[path] = { kind: "channel", channel: r };
      continue;
    }
    const split = {
      r: splitScalarChannel(binding.channels.r, input.splitTime, include, ids),
      g: splitScalarChannel(binding.channels.g, input.splitTime, include, ids),
      b: splitScalarChannel(binding.channels.b, input.splitTime, include, ids),
      a: splitScalarChannel(binding.channels.a, input.splitTime, include, ids),
    };
    const [lr, rr] = split.r;
    const [lg, rg] = split.g;
    const [lb, rb] = split.b;
    const [la, ra] = split.a;
    if (lr && lg && lb && la) left[path] = { kind: "color", channels: { r: lr, g: lg, b: lb, a: la } };
    if (rr && rg && rb && ra) right[path] = { kind: "color", channels: { r: rr, g: rg, b: rb, a: ra } };
  }
  return { left: dropEmpty(left), right: dropEmpty(right) };
}

/** Keeps animation inside `[0, duration]`, preserving the value at the new end. */
export function clampAnimationsToDuration(input: { animations: ElementAnimations | undefined; duration: number; newId: IdGenerator }): ElementAnimations | undefined {
  if (!input.animations) return undefined;
  if (input.duration <= 0) return undefined;
  const beyond = Object.values(input.animations).some(
    (b) => b && bindingChannels(b).some((c) => (c.keys as Array<{ time: number }>).some((k) => k.time > input.duration)),
  );
  if (!beyond) return input.animations;
  return splitAnimationsAtTime({ animations: input.animations, splitTime: input.duration, includeBoundary: true, newId: input.newId }).left;
}
