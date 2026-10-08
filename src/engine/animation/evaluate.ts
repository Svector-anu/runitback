import type {
  AnimationBinding, Channel, DiscreteChannel, ElementAnimations, ScalarChannel, ScalarKey,
} from "#/engine/model";
import { cubicPoint, lerp, solveParameterForX, type Point } from "./bezier";
import { formatLinearRgba, parseHexToLinearRgba } from "./color";

export function isScalarChannel(channel: Channel): channel is ScalarChannel {
  return channel.kind === "scalar";
}

interface Segment {
  left: ScalarKey;
  right: ScalarKey;
  p0: Point; p1: Point; p2: Point; p3: Point;
}

/** Builds the bezier control polygon for a segment, clamping handles so x stays monotone. */
export function segmentControlPoints(left: ScalarKey, right: ScalarKey): Segment {
  const span = Math.max(1, right.time - left.time);
  const rh = left.rightHandle ?? { dt: span / 3, dv: (right.value - left.value) / 3 };
  const lh = right.leftHandle ?? { dt: -span / 3, dv: -(right.value - left.value) / 3 };
  const rdt = Math.min(span, Math.max(0, rh.dt));
  const ldt = Math.min(0, Math.max(-span, lh.dt));
  return {
    left, right,
    p0: { x: left.time, y: left.value },
    p1: { x: left.time + rdt, y: left.value + rh.dv },
    p2: { x: right.time + ldt, y: right.value + lh.dv },
    p3: { x: right.time, y: right.value },
  };
}

function evaluateSegment(left: ScalarKey, right: ScalarKey, time: number): number {
  if (left.segmentToNext === "step") return left.value;
  if (left.segmentToNext === "linear") {
    const span = Math.max(1, right.time - left.time);
    return lerp(left.value, right.value, Math.min(1, Math.max(0, (time - left.time) / span)));
  }
  const seg = segmentControlPoints(left, right);
  const u = solveParameterForX(seg.p0, seg.p1, seg.p2, seg.p3, time);
  return cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, u).y;
}

function sortedKeys(channel: ScalarChannel): ScalarKey[] {
  const keys = channel.keys;
  for (let i = 1; i < keys.length; i++) {
    if ((keys[i] as ScalarKey).time < (keys[i - 1] as ScalarKey).time) {
      return [...keys].sort((a, b) => a.time - b.time);
    }
  }
  return keys;
}

function extrapolate(edge: ScalarKey, neighbour: ScalarKey | undefined, time: number, mode: "hold" | "linear"): number {
  if (mode === "hold" || !neighbour) return edge.value;
  const dt = neighbour.time - edge.time;
  if (dt === 0) return edge.value;
  return edge.value + ((neighbour.value - edge.value) / dt) * (time - edge.time);
}

export function evaluateScalarChannel(channel: ScalarChannel | undefined, time: number, fallback: number): number {
  if (!channel || channel.keys.length === 0) return fallback;
  const keys = sortedKeys(channel);
  const first = keys[0] as ScalarKey;
  const last = keys[keys.length - 1] as ScalarKey;
  if (time < first.time) return extrapolate(first, keys[1], time, channel.extrapolation?.before ?? "hold");
  if (time === first.time) return first.value;
  if (time > last.time) return extrapolate(last, keys[keys.length - 2], time, channel.extrapolation?.after ?? "hold");
  if (time === last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const left = keys[i] as ScalarKey;
    const right = keys[i + 1] as ScalarKey;
    if (time >= left.time && time < right.time) return evaluateSegment(left, right, time);
  }
  return last.value;
}

export function evaluateDiscreteChannel<T extends boolean | string>(
  channel: DiscreteChannel | undefined, time: number, fallback: T,
): T {
  if (!channel) return fallback;
  let result: T = fallback;
  let resultTime = -Infinity;
  for (const key of channel.keys) {
    if (key.time <= time && key.time >= resultTime) {
      result = key.value as T;
      resultTime = key.time;
    }
  }
  return result;
}

export function hasKeyframes(binding: AnimationBinding | undefined): boolean {
  if (!binding) return false;
  if (binding.kind === "channel") return binding.channel.keys.length > 0;
  return binding.channels.a.keys.length > 0 || binding.channels.r.keys.length > 0;
}

export function resolveNumberAtTime(animations: ElementAnimations | undefined, path: string, localTime: number, fallback: number): number {
  const binding = animations?.[path];
  if (binding?.kind !== "channel" || !isScalarChannel(binding.channel)) return fallback;
  return evaluateScalarChannel(binding.channel, Math.max(0, localTime), fallback);
}

export function resolveColorAtTime(animations: ElementAnimations | undefined, path: string, localTime: number, fallback: string): string {
  const binding = animations?.[path];
  if (binding?.kind !== "color") return fallback;
  const base = parseHexToLinearRgba(fallback) ?? { r: 0, g: 0, b: 0, a: 1 };
  const t = Math.max(0, localTime);
  return formatLinearRgba({
    r: evaluateScalarChannel(binding.channels.r, t, base.r),
    g: evaluateScalarChannel(binding.channels.g, t, base.g),
    b: evaluateScalarChannel(binding.channels.b, t, base.b),
    a: evaluateScalarChannel(binding.channels.a, t, base.a),
  });
}

export function resolveDiscreteAtTime<T extends boolean | string>(
  animations: ElementAnimations | undefined, path: string, localTime: number, fallback: T,
): T {
  const binding = animations?.[path];
  if (binding?.kind !== "channel" || isScalarChannel(binding.channel)) return fallback;
  return evaluateDiscreteChannel(binding.channel, Math.max(0, localTime), fallback);
}

