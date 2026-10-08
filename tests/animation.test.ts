import { describe, expect, it } from "vitest";
import { mediaTime, type MediaTime } from "#/engine/time";
import { sequentialIds, type ElementAnimations } from "#/engine/model";
import {
  clampAnimationsToDuration, cloneAnimations, evaluateScalarChannel, formatLinearRgba, keyframeIdAtTime, listKeyframes,
  parseHexToLinearRgba, removeKeyframe, resolveColorAtTime, resolveDiscreteAtTime, resolveNumberAtTime, retimeKeyframe,
  splitAnimationsAtTime, updateScalarCurve, upsertKeyframe,
} from "#/engine/animation";

const t = (n: number): MediaTime => mediaTime(n);

function numberAnim(points: Array<[number, number]>, interpolation?: "linear" | "hold" | "bezier"): ElementAnimations {
  const newId = sequentialIds("k");
  let a: ElementAnimations | undefined;
  for (const [time, value] of points) a = upsertKeyframe({ animations: a, path: "opacity", time: t(time), value, interpolation, newId });
  return a ?? {};
}

describe("scalar interpolation", () => {
  it("returns the fallback with no channel", () => {
    expect(resolveNumberAtTime(undefined, "opacity", 50, 0.7)).toBe(0.7);
  });
  it("linearly interpolates between keys", () => {
    const a = numberAnim([[0, 0], [1000, 10]]);
    expect(resolveNumberAtTime(a, "opacity", 0, 99)).toBe(0);
    expect(resolveNumberAtTime(a, "opacity", 250, 99)).toBeCloseTo(2.5);
    expect(resolveNumberAtTime(a, "opacity", 1000, 99)).toBe(10);
  });
  it("holds before the first and after the last key by default", () => {
    const a = numberAnim([[100, 2], [200, 4]]);
    expect(resolveNumberAtTime(a, "opacity", 50, 0)).toBe(2);
    expect(resolveNumberAtTime(a, "opacity", 900, 0)).toBe(4);
  });
  it("step segments hold the left value until the next key", () => {
    const a = numberAnim([[0, 1], [1000, 5]], "hold");
    expect(resolveNumberAtTime(a, "opacity", 999, 0)).toBe(1);
    expect(resolveNumberAtTime(a, "opacity", 1000, 0)).toBe(5);
  });
  it("supports linear extrapolation", () => {
    const a = numberAnim([[0, 0], [100, 10]]);
    const b = a.opacity;
    if (b?.kind !== "channel" || b.channel.kind !== "scalar") throw new Error("scalar expected");
    const ch = { ...b.channel, extrapolation: { before: "linear" as const, after: "linear" as const } };
    expect(evaluateScalarChannel(ch, 200, 0)).toBeCloseTo(20);
    expect(evaluateScalarChannel(ch, -100, 0)).toBeCloseTo(-10);
  });
  it("default bezier handles are collinear so equal linear", () => {
    const a = numberAnim([[0, 0], [1000, 10]], "bezier");
    expect(resolveNumberAtTime(a, "opacity", 500, 0)).toBeCloseTo(5, 3);
    expect(resolveNumberAtTime(a, "opacity", 250, 0)).toBeCloseTo(2.5, 3);
  });
  it("ease-in handles lag behind linear in the first half", () => {
    let a = numberAnim([[0, 0], [1000, 10]], "bezier");
    const [first, second] = listKeyframes(a);
    if (!first || !second) throw new Error("keys expected");
    a = updateScalarCurve({ animations: a, path: "opacity", keyframeId: first.id, patch: { rightHandle: { dt: 800, dv: 0 } } }) ?? a;
    a = updateScalarCurve({ animations: a, path: "opacity", keyframeId: second.id, patch: { leftHandle: { dt: -200, dv: 0 } } }) ?? a;
    expect(resolveNumberAtTime(a, "opacity", 250, 0)).toBeLessThan(2.5);
    expect(resolveNumberAtTime(a, "opacity", 1000, 0)).toBe(10);
  });
  it("evaluation is monotone in time for a monotone ease curve", () => {
    let a = numberAnim([[0, 0], [1000, 10]], "bezier");
    const [first, second] = listKeyframes(a);
    a = updateScalarCurve({ animations: a, path: "opacity", keyframeId: first!.id, patch: { rightHandle: { dt: 1500, dv: 0 } } }) ?? a;
    a = updateScalarCurve({ animations: a, path: "opacity", keyframeId: second!.id, patch: { leftHandle: { dt: -1500, dv: 0 } } }) ?? a;
    let prev = -Infinity;
    for (let time = 0; time <= 1000; time += 50) {
      const v = resolveNumberAtTime(a, "opacity", time, 0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("colour and discrete channels", () => {
  it("round-trips hex through linear light", () => {
    const rgba = parseHexToLinearRgba("#ff0000");
    expect(rgba).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(formatLinearRgba({ r: 1, g: 0, b: 0, a: 1 })).toBe("#ff0000");
    expect(formatLinearRgba(parseHexToLinearRgba("#336699")!)).toBe("#336699");
    expect(parseHexToLinearRgba("nope")).toBeNull();
  });
  it("interpolates colour in linear light, not sRGB", () => {
    const newId = sequentialIds();
    let a = upsertKeyframe({ animations: undefined, path: "color", time: t(0), value: "#000000", newId });
    a = upsertKeyframe({ animations: a, path: "color", time: t(1000), value: "#ffffff", newId });
    const mid = resolveColorAtTime(a, "color", 500, "#123456");
    expect(mid).toBe("#bcbcbc");
    expect(mid).not.toBe("#808080");
  });
  it("discrete channels hold the latest key and fall back before the first", () => {
    const newId = sequentialIds();
    let a = upsertKeyframe({ animations: undefined, path: "background.enabled", time: t(100), value: true, newId });
    a = upsertKeyframe({ animations: a, path: "background.enabled", time: t(300), value: false, newId });
    expect(resolveDiscreteAtTime(a, "background.enabled", 50, false)).toBe(false);
    expect(resolveDiscreteAtTime(a, "background.enabled", 100, false)).toBe(true);
    expect(resolveDiscreteAtTime(a, "background.enabled", 299, false)).toBe(true);
    expect(resolveDiscreteAtTime(a, "background.enabled", 300, true)).toBe(false);
  });
});

describe("keyframe mutation", () => {
  it("upsert at an existing time updates in place instead of duplicating", () => {
    const a = numberAnim([[0, 1], [0, 3]]);
    expect(listKeyframes(a)).toHaveLength(1);
    expect(listKeyframes(a)[0]?.value).toBe(3);
  });
  it("remove deletes the key and drops an emptied path", () => {
    const a = numberAnim([[0, 1]]);
    const id = keyframeIdAtTime(a, "opacity", 0)!;
    expect(removeKeyframe({ animations: a, path: "opacity", keyframeId: id })).toBeUndefined();
  });
  it("retime moves and re-sorts keys", () => {
    const a = numberAnim([[0, 1], [100, 2]]);
    const first = keyframeIdAtTime(a, "opacity", 0)!;
    const moved = retimeKeyframe({ animations: a, path: "opacity", keyframeId: first, nextTime: t(500) })!;
    expect(listKeyframes(moved).map((k) => k.time)).toEqual([100, 500]);
  });
  it("colour keyframes share an id across components", () => {
    const newId = sequentialIds();
    const a = upsertKeyframe({ animations: undefined, path: "color", time: t(0), value: "#ff8800", newId });
    expect(listKeyframes(a)).toHaveLength(1);
    expect(listKeyframes(a)[0]?.value).toBe("#ff8800");
  });
  it("clone regenerates ids consistently", () => {
    const a = numberAnim([[0, 1], [10, 2]]);
    const cloned = cloneAnimations({ animations: a, regenerateIds: sequentialIds("n") })!;
    expect(listKeyframes(cloned).map((k) => k.id)).toEqual(["n-1", "n-2"]);
    expect(listKeyframes(a).map((k) => k.id)).not.toEqual(listKeyframes(cloned).map((k) => k.id));
  });
});

describe("split and clamp", () => {
  it("rebases the right half and preserves the value at the cut on both sides", () => {
    const a = numberAnim([[0, 0], [1000, 10]]);
    const { left, right } = splitAnimationsAtTime({ animations: a, splitTime: 400, newId: sequentialIds("s") });
    expect(resolveNumberAtTime(left, "opacity", 400, -1)).toBeCloseTo(4);
    expect(resolveNumberAtTime(right, "opacity", 0, -1)).toBeCloseTo(4);
    expect(resolveNumberAtTime(right, "opacity", 600, -1)).toBeCloseTo(10);
    expect(listKeyframes(right).map((k) => k.time)).toEqual([0, 600]);
  });
  it("bezier subdivision keeps the curve shape on both halves", () => {
    let a = numberAnim([[0, 0], [1000, 10]], "bezier");
    const [k0, k1] = listKeyframes(a);
    a = updateScalarCurve({ animations: a, path: "opacity", keyframeId: k0!.id, patch: { rightHandle: { dt: 700, dv: 1 } } })!;
    a = updateScalarCurve({ animations: a, path: "opacity", keyframeId: k1!.id, patch: { leftHandle: { dt: -200, dv: -6 } } })!;
    const { left, right } = splitAnimationsAtTime({ animations: a, splitTime: 400, newId: sequentialIds("s") });
    for (const time of [50, 150, 300]) {
      expect(resolveNumberAtTime(left, "opacity", time, 0)).toBeCloseTo(resolveNumberAtTime(a, "opacity", time, 0), 1);
    }
    for (const time of [450, 600, 900]) {
      expect(resolveNumberAtTime(right, "opacity", time - 400, 0)).toBeCloseTo(resolveNumberAtTime(a, "opacity", time, 0), 1);
    }
  });
  it("a split exactly on a key does not duplicate values", () => {
    const a = numberAnim([[0, 0], [500, 5], [1000, 10]]);
    const { left, right } = splitAnimationsAtTime({ animations: a, splitTime: 500, newId: sequentialIds("s") });
    expect(listKeyframes(left).map((k) => k.time)).toEqual([0, 500]);
    expect(listKeyframes(right).map((k) => k.time)).toEqual([0, 500]);
  });
  it("clamp to shorter duration keeps the value at the new end", () => {
    const a = numberAnim([[0, 0], [1000, 10]]);
    const clamped = clampAnimationsToDuration({ animations: a, duration: 500, newId: sequentialIds("c") })!;
    expect(resolveNumberAtTime(clamped, "opacity", 500, -1)).toBeCloseTo(5);
    expect(listKeyframes(clamped).every((k) => k.time <= 500)).toBe(true);
  });
  it("clamp returns the same object when nothing is out of range and undefined for zero duration", () => {
    const a = numberAnim([[0, 0], [100, 1]]);
    expect(clampAnimationsToDuration({ animations: a, duration: 500, newId: sequentialIds() })).toBe(a);
    expect(clampAnimationsToDuration({ animations: a, duration: 0, newId: sequentialIds() })).toBeUndefined();
  });
  it("discrete split carries the held value into the right half", () => {
    const newId = sequentialIds();
    const a = upsertKeyframe({ animations: undefined, path: "background.enabled", time: t(100), value: true, newId });
    const { right } = splitAnimationsAtTime({ animations: a, splitTime: 500, newId });
    expect(resolveDiscreteAtTime(right, "background.enabled", 0, false)).toBe(true);
  });
});

import { EASING_PRESETS, curveToPatch, matchPreset, segmentToCurve } from "#/engine/animation";

describe("easing presets", () => {
  const keys = (): { left: import("#/engine/model").ScalarKey; right: import("#/engine/model").ScalarKey } => {
    const a = numberAnim([[0, 0], [1000, 10]]);
    const channel = (a.opacity as { channel: { keys: import("#/engine/model").ScalarKey[] } }).channel;
    return { left: channel.keys[0]!, right: channel.keys[1]! };
  };
  it("linear clears handles; other presets produce monotone handles inside the segment", () => {
    const { left, right } = keys();
    expect(curveToPatch({ left, right, curve: [0, 0, 1, 1] })).toEqual({ segmentToNext: "linear", rightHandle: null, leftHandle: null });
    const patch = curveToPatch({ left, right, curve: [0.4, 0, 0.2, 1] })!;
    expect(patch.segmentToNext).toBe("bezier");
    expect(patch.rightHandle).toEqual({ dt: 400, dv: 0 });
    expect(patch.leftHandle).toEqual({ dt: -800, dv: 0 });
  });
  it("round-trips through segmentToCurve and matches the named preset", () => {
    const { left, right } = keys();
    for (const preset of EASING_PRESETS) {
      const patch = curveToPatch({ left, right, curve: preset.curve })!;
      const curve = segmentToCurve({
        left: { ...left, segmentToNext: patch.segmentToNext, ...(patch.rightHandle ? { rightHandle: patch.rightHandle } : {}) },
        right: { ...right, ...(patch.leftHandle ? { leftHandle: patch.leftHandle } : {}) },
      })!;
      expect(matchPreset(curve)?.id).toBe(preset.id);
    }
  });
  it("flat spans and hold segments cannot be eased", () => {
    const flat = numberAnim([[0, 5], [1000, 5]]);
    const channel = (flat.opacity as { channel: { keys: import("#/engine/model").ScalarKey[] } }).channel;
    expect(curveToPatch({ left: channel.keys[0]!, right: channel.keys[1]!, curve: [0.4, 0, 0.2, 1] })).toBeNull();
    const hold = numberAnim([[0, 0], [1000, 10]], "hold");
    const hk = (hold.opacity as { channel: { keys: import("#/engine/model").ScalarKey[] } }).channel.keys;
    expect(segmentToCurve({ left: hk[0]!, right: hk[1]! })).toBeNull();
  });
  it("applied bezier preset really eases the evaluated value", () => {
    const { left, right } = keys();
    const patch = curveToPatch({ left, right, curve: [0.8, 0, 1, 1] })!;
    const eased = { ...left, segmentToNext: patch.segmentToNext, rightHandle: patch.rightHandle! };
    const channel = { kind: "scalar" as const, keys: [eased, { ...right, leftHandle: patch.leftHandle! }] };
    expect(evaluateScalarChannel(channel, 500, 0)).toBeLessThan(2);
    expect(evaluateScalarChannel(channel, 1000, 0)).toBe(10);
  });
});
