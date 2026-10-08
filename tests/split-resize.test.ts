import { describe, expect, it } from "vitest";
import { sequentialIds, type VideoElement } from "#/engine/model";
import { mediaTime, TICKS_PER_SECOND } from "#/engine/time";
import { splitElements } from "#/engine/timeline/split";
import { applyElementUpdate } from "#/engine/timeline/update-pipeline";
import { buildResizeMembers, computeGroupResize } from "#/engine/timeline/resize";
import { elementsStrictlyAt, getElement, totalDuration } from "#/engine/timeline/tracks";
import { upsertKeyframe, resolveNumberAtTime } from "#/engine/animation";
import { sec, text, tracksWith, video, audio } from "./helpers";

const fps30 = { numerator: 30, denominator: 1 };
const main = (tracks: ReturnType<typeof tracksWith>) => tracks.main.elements as VideoElement[];

describe("splitElements", () => {
  it("splits a clip into left and right with source-time continuity", () => {
    const tracks = tracksWith({ main: [video("a", 2, 10)] });
    const r = splitElements({ tracks, refs: [{ trackId: "main", elementId: "a" }], splitTime: sec(6), newId: sequentialIds("n") });
    const [left, right] = main(r.tracks);
    expect(left).toMatchObject({ id: "a", startTime: sec(2), duration: sec(4), trimStart: 0, trimEnd: sec(6), name: "asset-a.mp4 (left)".replace("asset-a.mp4", "asset-a.mp4") });
    expect(right).toMatchObject({ startTime: sec(6), duration: sec(6), trimStart: sec(4), trimEnd: 0 });
    expect(right?.id).not.toBe("a");
    expect(left!.trimStart + left!.duration + left!.trimEnd).toBe(sec(10));
    expect(right!.trimStart + right!.duration + right!.trimEnd).toBe(sec(10));
    expect(r.selection).toEqual([{ trackId: "main", elementId: right!.id }]);
  });
  it("is retime aware: source spans scale by rate and sum exactly", () => {
    const base = video("a", 0, 10, { retime: { rate: 2 }, duration: sec(5) });
    const tracks = tracksWith({ main: [base] });
    const r = splitElements({ tracks, refs: [{ trackId: "main", elementId: "a" }], splitTime: sec(2), newId: sequentialIds("n") });
    const [left, right] = main(r.tracks);
    expect(left!.trimEnd).toBe(sec(6));
    expect(right!.trimStart).toBe(sec(4));
    expect(right!.retime).toEqual({ rate: 2 });
    expect(left!.trimStart + left!.duration * 2 + left!.trimEnd).toBe(sec(10));
    expect(right!.trimStart + right!.duration * 2 + right!.trimEnd).toBe(sec(10));
  });
  it("ignores boundaries and elements that are not targeted", () => {
    const tracks = tracksWith({ main: [video("a", 0, 4), video("b", 4, 4)] });
    const refs = [{ trackId: "main", elementId: "a" }];
    expect(splitElements({ tracks, refs, splitTime: sec(0), newId: sequentialIds() }).changed).toBe(false);
    expect(splitElements({ tracks, refs, splitTime: sec(4), newId: sequentialIds() }).changed).toBe(false);
    const r = splitElements({ tracks, refs, splitTime: sec(2), newId: sequentialIds() });
    expect(main(r.tracks)).toHaveLength(3);
  });
  it("retain left keeps only the head; retain right keeps only the tail under a new id", () => {
    const tracks = tracksWith({ main: [video("a", 0, 10)] });
    const refs = [{ trackId: "main", elementId: "a" }];
    const l = splitElements({ tracks, refs, splitTime: sec(4), retainSide: "left", newId: sequentialIds("n") });
    expect(main(l.tracks)).toHaveLength(1);
    expect(main(l.tracks)[0]).toMatchObject({ id: "a", duration: sec(4) });
    const rr = splitElements({ tracks, refs, splitTime: sec(4), retainSide: "right", newId: sequentialIds("n") });
    expect(main(rr.tracks)).toHaveLength(1);
    expect(main(rr.tracks)[0]).toMatchObject({ startTime: sec(4), duration: sec(6), trimStart: sec(4) });
    expect(main(rr.tracks)[0]?.id).not.toBe("a");
  });
  it("does not touch trims on elements without a source (text)", () => {
    const tracks = tracksWith({ overlay: [{ id: "t", type: "text", elements: [text("x", 0, 6)] }] });
    const r = splitElements({ tracks, refs: [{ trackId: "t", elementId: "x" }], splitTime: sec(2), newId: sequentialIds("n") });
    const els = r.tracks.overlay[0]!.elements;
    expect(els.map((e) => [e.trimStart, e.trimEnd])).toEqual([[0, 0], [0, 0]]);
  });
  it("splits animation so the value at the cut matches on both halves", () => {
    let anim = upsertKeyframe({ animations: undefined, path: "opacity", time: mediaTime(0), value: 0, newId: sequentialIds("k") });
    anim = upsertKeyframe({ animations: anim, path: "opacity", time: sec(10), value: 1, newId: sequentialIds("k2") });
    const tracks = tracksWith({ main: [video("a", 0, 10, { animations: anim })] });
    const r = splitElements({ tracks, refs: [{ trackId: "main", elementId: "a" }], splitTime: sec(5), newId: sequentialIds("n") });
    const [left, right] = main(r.tracks);
    expect(resolveNumberAtTime(left!.animations, "opacity", sec(5), -1)).toBeCloseTo(0.5);
    expect(resolveNumberAtTime(right!.animations, "opacity", 0, -1)).toBeCloseTo(0.5);
    expect(resolveNumberAtTime(right!.animations, "opacity", sec(5), -1)).toBeCloseTo(1);
  });
  it("elementsStrictlyAt excludes elements that merely touch the time", () => {
    const tracks = tracksWith({ main: [video("a", 0, 4), video("b", 4, 4)], audio: [{ id: "a1", elements: [audio("s", 1, 6)] }] });
    expect(elementsStrictlyAt(tracks, sec(4)).map((l) => l.element.id)).toEqual(["s"]);
  });
});

describe("applyElementUpdate", () => {
  it("speed change re-derives duration from visible source", () => {
    const tracks = tracksWith({ main: [video("a", 0, 10)] });
    const out = applyElementUpdate({ tracks, ref: { trackId: "main", elementId: "a" }, patch: { retime: { rate: 2 } }, newId: sequentialIds() });
    expect(getElement(out, { trackId: "main", elementId: "a" })?.duration).toBe(sec(5));
    const slow = applyElementUpdate({ tracks: out, ref: { trackId: "main", elementId: "a" }, patch: { retime: { rate: 0.5 } }, newId: sequentialIds() });
    expect(getElement(slow, { trackId: "main", elementId: "a" })?.duration).toBe(sec(20));
  });
  it("integer durations after fractional rates", () => {
    const tracks = tracksWith({ main: [video("a", 0, 10, { duration: mediaTime(10), sourceDuration: mediaTime(10) })] });
    const out = applyElementUpdate({ tracks, ref: { trackId: "main", elementId: "a" }, patch: { retime: { rate: 1.5 } }, newId: sequentialIds() });
    expect(getElement(out, { trackId: "main", elementId: "a" })?.duration).toBe(7);
  });
  it("a slow-down that would hit the next clip is limited and the tail is trimmed instead of overlapping", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 4), video("b", 6, 4)] }] });
    const out = applyElementUpdate({ tracks, ref: { trackId: "o", elementId: "a" }, patch: { retime: { rate: 0.5 } }, newId: sequentialIds() });
    const a = getElement(out, { trackId: "o", elementId: "a" }) as VideoElement;
    expect(a.startTime + a.duration).toBeLessThanOrEqual(sec(6));
    expect(a.trimStart + a.duration * 0.5 + a.trimEnd).toBeCloseTo(sec(4), -1);
  });
  it("shortening duration clamps animation to the new end", () => {
    let anim = upsertKeyframe({ animations: undefined, path: "opacity", time: mediaTime(0), value: 0, newId: sequentialIds("k") });
    anim = upsertKeyframe({ animations: anim, path: "opacity", time: sec(10), value: 1, newId: sequentialIds("k2") });
    const tracks = tracksWith({ main: [video("a", 0, 10, { animations: anim })] });
    const out = applyElementUpdate({ tracks, ref: { trackId: "main", elementId: "a" }, patch: { duration: sec(5) }, newId: sequentialIds("c") });
    const a = getElement(out, { trackId: "main", elementId: "a" });
    expect(resolveNumberAtTime(a?.animations, "opacity", sec(5), -1)).toBeCloseTo(0.5);
  });
  it("start time is clamped to zero and obeys the main-track rule", () => {
    const tracks = tracksWith({ main: [video("a", 3, 2), video("b", 6, 2)] });
    const out = applyElementUpdate({ tracks, ref: { trackId: "main", elementId: "b" }, patch: { startTime: sec(1) }, newId: sequentialIds() });
    expect(getElement(out, { trackId: "main", elementId: "b" })?.startTime).toBe(0);
    const neg = applyElementUpdate({ tracks, ref: { trackId: "main", elementId: "a" }, patch: { startTime: mediaTime(-5) }, newId: sequentialIds() });
    expect(getElement(neg, { trackId: "main", elementId: "a" })?.startTime).toBe(0);
  });
  it("merges params rather than replacing them", () => {
    const tracks = tracksWith({ main: [video("a", 0, 2)] });
    const out = applyElementUpdate({ tracks, ref: { trackId: "main", elementId: "a" }, patch: { params: { opacity: 0.3 } }, newId: sequentialIds() });
    const params = getElement(out, { trackId: "main", elementId: "a" })?.params;
    expect(params?.opacity).toBe(0.3);
    expect(params?.["transform.scaleX"]).toBe(1);
  });
  it("total duration is the furthest end", () => {
    expect(totalDuration(tracksWith({ main: [video("a", 0, 4)], audio: [{ id: "x", elements: [audio("s", 2, 9)] }] }))).toBe(sec(11));
    expect(totalDuration(tracksWith({}))).toBe(0);
    expect(TICKS_PER_SECOND).toBe(120000);
  });
});

describe("group resize", () => {
  const ref = (id: string) => ({ trackId: "o", elementId: id });
  it("extends right up to the neighbour and the remaining source", () => {
    const a = video("a", 0, 4, { trimEnd: sec(3), duration: sec(4), sourceDuration: sec(7) });
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [a, video("b", 6, 2)] }] });
    const members = buildResizeMembers({ tracks, refs: [ref("a")] });
    expect(computeGroupResize({ members, side: "right", delta: sec(1), fps: fps30 }).delta).toBe(sec(1));
    expect(computeGroupResize({ members, side: "right", delta: sec(10), fps: fps30 }).delta).toBe(sec(2));
    const full = buildResizeMembers({ tracks: tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 4)] }] }), refs: [ref("a")] });
    expect(computeGroupResize({ members: full, side: "right", delta: sec(3), fps: fps30 }).delta).toBe(0);
  });
  it("trims from the right shrinking duration and growing trimEnd, never below one frame", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 4)] }] });
    const members = buildResizeMembers({ tracks, refs: [ref("a")] });
    const r = computeGroupResize({ members, side: "right", delta: -sec(1), fps: fps30 });
    expect(r.patches[0]?.patch).toMatchObject({ duration: sec(3), trimEnd: sec(1) });
    const min = computeGroupResize({ members, side: "right", delta: -sec(100), fps: fps30 });
    expect(min.patches[0]?.patch.duration).toBe(4000);
  });
  it("left trim moves start, shrinks duration, grows trimStart", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 2, 4)] }] });
    const members = buildResizeMembers({ tracks, refs: [ref("a")] });
    const r = computeGroupResize({ members, side: "left", delta: sec(1), fps: fps30 });
    expect(r.patches[0]?.patch).toMatchObject({ startTime: sec(3), duration: sec(3), trimStart: sec(1) });
  });
  it("left extension is limited by previous neighbour and by already-trimmed source", () => {
    const a = video("a", 5, 3, { trimStart: sec(1), duration: sec(3), sourceDuration: sec(4) });
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("p", 0, 4), a] }] });
    const members = buildResizeMembers({ tracks, refs: [ref("a")] });
    expect(computeGroupResize({ members, side: "left", delta: -sec(5), fps: fps30 }).delta).toBe(-sec(1));
  });
  it("speed scales the source delta", () => {
    const a = video("a", 0, 10, { retime: { rate: 2 }, duration: sec(5) });
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [a] }] });
    const members = buildResizeMembers({ tracks, refs: [ref("a")] });
    const r = computeGroupResize({ members, side: "right", delta: -sec(1), fps: fps30 });
    expect(r.patches[0]?.patch).toMatchObject({ duration: sec(4), trimEnd: sec(2) });
  });
  it("applies one delta to every member, limited by the tightest one", () => {
    const tracks = tracksWith({ overlay: [
      { id: "o", elements: [video("a", 0, 4, { trimEnd: sec(2), sourceDuration: sec(6) })] },
      { id: "o2", elements: [video("b", 0, 4, { trimEnd: sec(1), sourceDuration: sec(5) })] },
    ] });
    const members = buildResizeMembers({ tracks, refs: [ref("a"), { trackId: "o2", elementId: "b" }] });
    expect(computeGroupResize({ members, side: "right", delta: sec(2), fps: fps30 }).delta).toBe(sec(1));
  });
  it("text and images extend freely to the right", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", type: "text", elements: [text("x", 0, 2)] }] });
    const members = buildResizeMembers({ tracks, refs: [ref("x")] });
    expect(computeGroupResize({ members, side: "right", delta: sec(30), fps: fps30 }).delta).toBe(sec(30));
  });
  it("frame-snaps the delta once", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", type: "text", elements: [text("x", 0, 2)] }] });
    const members = buildResizeMembers({ tracks, refs: [ref("x")] });
    expect(computeGroupResize({ members, side: "right", delta: 5000, fps: fps30 }).delta % 4000).toBe(0);
  });
});
