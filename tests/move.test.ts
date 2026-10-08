import { describe, expect, it } from "vitest";
import { sequentialIds } from "#/engine/model";
import {
  applyGroupMove, buildMoveGroup, computeDropTarget, getTrackAtY, planChangesAnything, resolveGroupMove, dropLineY,
  type TrackLayout, type DropTarget,
} from "#/engine/timeline";
import { allElements } from "#/engine/timeline/tracks";
import { audio, sec, text, tracksWith, video } from "./helpers";

const layout = (heights: number[]): TrackLayout => ({ heights, gap: 6 });
const existingTarget = (trackIndex: number): DropTarget => ({ trackIndex, isNewTrack: false, insertPosition: null, xPosition: 0 as never, targetElement: null });
const newTarget = (trackIndex: number): DropTarget => ({ trackIndex, isNewTrack: true, insertPosition: "above", xPosition: 0 as never, targetElement: null });
const ref = (trackId: string, elementId: string) => ({ trackId, elementId });

describe("getTrackAtY", () => {
  const l = layout([25, 65, 50]);
  it("finds rows and handles the 6px gaps by drag direction", () => {
    expect(getTrackAtY({ layout: l, y: 10, direction: null })).toEqual({ index: 0, relativeY: 10 });
    expect(getTrackAtY({ layout: l, y: 31 + 5, direction: null })).toEqual({ index: 1, relativeY: 5 });
    expect(getTrackAtY({ layout: l, y: 27, direction: "up" })).toEqual({ index: 0, relativeY: 24 });
    expect(getTrackAtY({ layout: l, y: 27, direction: "down" })).toEqual({ index: 1, relativeY: 0 });
    expect(getTrackAtY({ layout: l, y: 500, direction: null })).toBeNull();
  });
  it("drop line sits between tracks", () => {
    expect(dropLineY({ layout: l, trackIndex: 0 })).toBe(0);
    expect(dropLineY({ layout: l, trackIndex: 1 })).toBe(25 + 3);
  });
});

describe("computeDropTarget", () => {
  const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("x", 0, 4)] }], main: [video("m", 0, 10)] });
  const l = layout([65, 65]);
  it("reuses a free track and reports the frame time", () => {
    const t = computeDropTarget({ tracks, elementType: "video", mouseY: 20, startTime: sec(5), duration: sec(1), layout: l, verticalDirection: null });
    expect(t).toMatchObject({ trackIndex: 0, isNewTrack: false, xPosition: sec(5) });
  });
  it("overlapping the hovered track creates a new track instead of overwriting", () => {
    const t = computeDropTarget({ tracks, elementType: "video", mouseY: 20, startTime: sec(1), duration: sec(1), layout: l, verticalDirection: null });
    expect(t).toMatchObject({ isNewTrack: true, trackIndex: 0, insertPosition: "above" });
  });
  it("hovering above the first track or below the last forces a new track", () => {
    const above = computeDropTarget({ tracks, elementType: "video", mouseY: -10, startTime: sec(20), duration: sec(1), layout: l, verticalDirection: null });
    expect(above).toMatchObject({ isNewTrack: true, trackIndex: 0 });
    const below = computeDropTarget({ tracks, elementType: "audio", mouseY: 999, startTime: 0, duration: sec(1), layout: l, verticalDirection: null });
    expect(below).toMatchObject({ isNewTrack: true, insertPosition: "below" });
  });
  it("targets a clip under the cursor when asked (effect drops)", () => {
    const t = computeDropTarget({ tracks, elementType: "effect", mouseY: 90, startTime: sec(2), duration: sec(1), layout: l, verticalDirection: null,
      targetElementTypes: ["video"] });
    expect(t?.targetElement).toEqual({ elementId: "m", trackId: "main" });
  });
});

describe("group move", () => {
  const ids = () => sequentialIds("nt")();
  it("moves a single clip to a free spot on the same track", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 2)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("o", "a"), selection: [ref("o", "a")] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(0), anchorStart: sec(10), newTrackIds: [ids()] })!;
    expect(plan.moves).toEqual([{ ref: ref("o", "a"), toTrackId: "o", startTime: sec(10) }]);
    const out = applyGroupMove({ tracks, plan });
    expect(out.tracks.overlay[0]?.elements[0]?.startTime).toBe(sec(10));
  });
  it("collision on the target track falls back to a fresh track", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 4), video("b", 6, 4)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("o", "a"), selection: [] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(0), anchorStart: sec(5), newTrackIds: ["N1"] })!;
    expect(plan.createTracks).toHaveLength(1);
    const out = applyGroupMove({ tracks, plan });
    expect(out.tracks.overlay.map((t) => t.id)).toEqual(["o", "N1"]);
    expect(out.moved).toEqual([{ trackId: "N1", elementId: "a" }]);
  });
  it("moving across tracks keeps source times and trims untouched", () => {
    const tracks = tracksWith({ overlay: [{ id: "o1", elements: [video("a", 0, 3, { trimStart: sec(1), duration: sec(3), sourceDuration: sec(5) })] }, { id: "o2", elements: [] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("o1", "a"), selection: [] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(1), anchorStart: sec(2), newTrackIds: [] })!;
    const out = applyGroupMove({ tracks, plan }).tracks;
    const moved = out.overlay[1]!.elements[0]!;
    expect(moved).toMatchObject({ id: "a", startTime: sec(2), trimStart: sec(1), duration: sec(3) });
    expect(out.overlay[0]!.elements).toHaveLength(0);
  });
  it("negative starts are clamped so no member leaves the timeline", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 2, 2), video("b", 5, 2)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("o", "b"), selection: [ref("o", "a"), ref("o", "b")] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(0), anchorStart: sec(-4), newTrackIds: ["x", "y"] })!;
    const starts = plan.moves.map((m) => m.startTime);
    expect(Math.min(...starts)).toBe(0);
    expect(starts[0]! - starts[1]!).toBe(sec(3));
  });
  it("group members keep their relative offsets", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 2), video("b", 3, 2)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("o", "a"), selection: [ref("o", "a"), ref("o", "b")] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(0), anchorStart: sec(10), newTrackIds: ["x", "y"] })!;
    const byId = Object.fromEntries(plan.moves.map((m) => [m.ref.elementId, m.startTime]));
    expect(byId).toEqual({ a: sec(10), b: sec(13) });
  });
  it("main track pins a clip dropped before the earliest clip to zero", () => {
    const tracks = tracksWith({ main: [video("m", 4, 2)], overlay: [{ id: "o", elements: [video("a", 0, 2)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("o", "a"), selection: [] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(1), anchorStart: sec(1), newTrackIds: ["n"] })!;
    expect(plan.moves[0]).toMatchObject({ toTrackId: "main", startTime: 0 });
  });
  it("incompatible target (video onto audio) with no fallback space still resolves to new tracks, never crosses types", () => {
    const tracks = tracksWith({ main: [video("m", 0, 5)], audio: [{ id: "a1", elements: [audio("s", 0, 5)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("main", "m"), selection: [] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(1), anchorStart: sec(0), newTrackIds: ["n"] })!;
    expect(plan.createTracks[0]?.type).toBe("video");
  });
  it("mixed audio and video groups cannot move to new tracks", () => {
    const tracks = tracksWith({ main: [video("m", 0, 5)], audio: [{ id: "a1", elements: [audio("s", 0, 5)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("main", "m"), selection: [ref("main", "m"), ref("a1", "s")] })!;
    expect(resolveGroupMove({ tracks, members, target: newTarget(0), anchorStart: sec(1), newTrackIds: ["x", "y"] })).toBeNull();
  });
  it("multi-track groups map each source track onto a matching destination type above and below the anchor", () => {
    const tracks = tracksWith({
      overlay: [{ id: "t", type: "text", elements: [text("tx", 0, 2)] }, { id: "o2", elements: [] }, { id: "o3", elements: [] }],
      main: [video("m", 0, 2)],
    });
    const members = buildMoveGroup({ tracks, anchor: ref("main", "m"), selection: [ref("t", "tx"), ref("main", "m")] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(2), anchorStart: sec(5), newTrackIds: [] })!;
    expect(Object.fromEntries(plan.moves.map((m) => [m.ref.elementId, m.toTrackId]))).toEqual({ m: "o3", tx: "t" });
  });
  it("a group needing a text track that does not exist falls back to new tracks", () => {
    const tracks = tracksWith({ overlay: [{ id: "o2", elements: [] }, { id: "o3", elements: [] }], main: [video("m", 0, 2)] });
    const withText = { ...tracks, overlay: [{ id: "t", name: "t", type: "text" as const, elements: [text("tx", 0, 2)], hidden: false }, ...tracks.overlay] };
    const members = buildMoveGroup({ tracks: withText, anchor: ref("main", "m"), selection: [ref("t", "tx"), ref("main", "m")] })!;
    const plan = resolveGroupMove({ tracks: withText, members, target: existingTarget(0), anchorStart: sec(5), newTrackIds: ["n1", "n2"] });
    expect(plan?.createTracks.length).toBe(2);
  });
  it("planChangesAnything is false for a no-op", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 3, 2)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("o", "a"), selection: [] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(0), anchorStart: sec(3), newTrackIds: [] })!;
    expect(planChangesAnything({ tracks, plan })).toBe(false);
  });
  it("applyGroupMove keeps element count constant", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 4), video("b", 6, 4)] }] });
    const members = buildMoveGroup({ tracks, anchor: ref("o", "a"), selection: [] })!;
    const plan = resolveGroupMove({ tracks, members, target: existingTarget(0), anchorStart: sec(5), newTrackIds: ["N"] })!;
    expect(allElements(applyGroupMove({ tracks, plan }).tracks)).toHaveLength(2);
  });
});
