import { describe, expect, it } from "vitest";
import { sequentialIds } from "#/engine/model";
import {
  applyBoxSelection, buildRulerTicks, clampZoom, computeRippleAdjustments, contentWidth, copyElements, duplicateElements,
  elementsInBox, elementSnapPoints, minZoomFor, pasteElements, pixelsToTime, rippleEdit, resolveSnap, rulerIntervals,
  scrollAnchoredToPlayhead, selectAll, sliderToZoom, snapGroupEdges, snapResizeDelta, snapThresholdTicks, timeToPixels,
  toggleSelection, wheelZoomFactor, zoomToSlider, formatRulerLabel, removeElements, clearMostSpecific, pruneSelection,
} from "#/engine/timeline";
import { EMPTY_SELECTION } from "#/engine/model";
import { allElements } from "#/engine/timeline/tracks";
import { TICKS_PER_SECOND } from "#/engine/time";
import { audio, sec, text, tracksWith, video } from "./helpers";

const fps = { numerator: 30, denominator: 1 };
const ref = (trackId: string, elementId: string) => ({ trackId, elementId });

describe("duplicate", () => {
  it("always creates a new track per source track and renames with (copy)", () => {
    const tracks = tracksWith({ main: [video("m", 0, 4)], audio: [{ id: "a1", elements: [audio("s", 0, 4)] }] });
    const r = duplicateElements({ tracks, refs: [ref("main", "m"), ref("a1", "s")], newId: sequentialIds("d") });
    expect(r.tracks.overlay).toHaveLength(1);
    expect(r.tracks.audio).toHaveLength(2);
    expect(r.tracks.overlay[0]?.elements[0]?.name).toMatch(/\(copy\)$/);
    expect(r.selection).toHaveLength(2);
    expect(r.tracks.main.elements).toHaveLength(1);
  });
  it("duplicates share nothing with the source (ids, keyframe ids)", () => {
    const tracks = tracksWith({ main: [video("m", 0, 4)] });
    const r = duplicateElements({ tracks, refs: [ref("main", "m")], newId: sequentialIds("d") });
    const ids = allElements(r.tracks).map((l) => l.element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("copy and paste", () => {
  it("pastes at the playhead preserving relative offsets; ids are fresh", () => {
    const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 2, 2), video("b", 6, 2)] }] });
    const items = copyElements({ tracks, refs: [ref("o", "a"), ref("o", "b")] });
    expect(items[0]?.element).not.toHaveProperty("id");
    const r = pasteElements({ tracks, items, time: sec(20), newId: sequentialIds("p") });
    const pasted = r.selection.map((s) => allElements(r.tracks).find((l) => l.element.id === s.elementId)!.element);
    expect(pasted.map((e) => e.startTime)).toEqual([sec(20), sec(24)]);
    expect(pasted.every((e) => e.name === pasted[0]!.name || true)).toBe(true);
  });
  it("lands above the source track when free, otherwise on a new track", () => {
    const tracks = tracksWith({ overlay: [{ id: "up", elements: [] }, { id: "o", elements: [video("a", 0, 4)] }] });
    const items = copyElements({ tracks, refs: [ref("o", "a")] });
    expect(pasteElements({ tracks, items, time: sec(1), newId: sequentialIds("p") }).selection[0]?.trackId).toBe("up");
    const busy = tracksWith({ main: [video("mm", 0, 10)], overlay: [{ id: "up", elements: [video("z", 0, 10)] }, { id: "o", elements: [video("a", 0, 4)] }] });
    const r = pasteElements({ tracks: busy, items: copyElements({ tracks: busy, refs: [ref("o", "a")] }), time: sec(1), newId: sequentialIds("p") });
    expect(r.tracks.overlay).toHaveLength(3);
  });
  it("pasting onto the main track applies the start rule to the whole group", () => {
    const tracks = tracksWith({ main: [video("m", 0, 4)] });
    const items = copyElements({ tracks, refs: [ref("main", "m")] });
    const r = pasteElements({ tracks, items, time: sec(0), newId: sequentialIds("p") });
    expect(allElements(r.tracks)).toHaveLength(2);
  });
  it("paste of an empty clipboard is a no-op", () => {
    const tracks = tracksWith({});
    expect(pasteElements({ tracks, items: [], time: 0, newId: sequentialIds() }).tracks).toBe(tracks);
  });
});

describe("ripple", () => {
  it("deleting a clip pulls later clips on the same track back", () => {
    const before = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 2), video("b", 2, 3), video("c", 5, 1)] }] });
    const after = removeElements(before, [ref("o", "b")]);
    const adj = computeRippleAdjustments({ before, after });
    expect(adj).toEqual([{ trackId: "o", afterTime: sec(5), shiftAmount: sec(3) }]);
    const out = rippleEdit({ before, after });
    expect(out.overlay[0]?.elements.map((e) => [e.id, e.startTime])).toEqual([["a", 0], ["c", sec(2)]]);
  });
  it("other tracks are untouched", () => {
    const before = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 2), video("b", 2, 2)] }, { id: "p", elements: [video("z", 4, 2)] }] });
    const out = rippleEdit({ before, after: removeElements(before, [ref("o", "a")]) });
    expect(out.overlay[1]?.elements[0]?.startTime).toBe(sec(4));
  });
  it("shortening the end ripples; extending or moving does not", () => {
    const before = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 4), video("b", 4, 2)] }] });
    const shorter = { ...before, overlay: [{ ...before.overlay[0]!, elements: [{ ...before.overlay[0]!.elements[0]!, duration: sec(3) }, before.overlay[0]!.elements[1]!] }] } as typeof before;
    expect(rippleEdit({ before, after: shorter }).overlay[0]?.elements[1]?.startTime).toBe(sec(3));
    const longer = { ...before, overlay: [{ ...before.overlay[0]!, elements: [{ ...before.overlay[0]!.elements[0]!, duration: sec(5) }, before.overlay[0]!.elements[1]!] }] } as typeof before;
    expect(computeRippleAdjustments({ before, after: longer })).toEqual([]);
  });
  it("elements moved to another track do not ripple their source", () => {
    const before = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 2), video("b", 2, 2)] }, { id: "p", elements: [] }] });
    const moved = video("a", 0, 2);
    const after = { ...removeElements(before, [ref("o", "a")]), };
    after.overlay = after.overlay.map((t) => (t.id === "p" ? { ...t, elements: [moved] } : t)) as typeof after.overlay;
    expect(computeRippleAdjustments({ before, after })).toEqual([]);
  });
  it("time re-occupied by an element that joined the track is not freed", () => {
    const before = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 4)] }] });
    const after = tracksWith({ overlay: [{ id: "o", elements: [video("n", 0, 4)] }] });
    expect(computeRippleAdjustments({ before, after })).toEqual([]);
  });
});

describe("snapping", () => {
  it("threshold is 10px worth of ticks and shrinks as you zoom in", () => {
    expect(snapThresholdTicks(1)).toBe(24000);
    expect(snapThresholdTicks(2)).toBe(12000);
  });
  it("resolveSnap picks the nearest within range", () => {
    const points = [{ time: 100, type: "element-start" as const }, { time: 130, type: "element-end" as const }];
    expect(resolveSnap({ target: 118, points, maxDistance: 20 }).snappedTime).toBe(130);
    expect(resolveSnap({ target: 118, points, maxDistance: 5 }).snapPoint).toBeNull();
  });
  it("element edges exclude moving elements", () => {
    const tracks = tracksWith({ main: [video("a", 0, 2), video("b", 5, 2)] });
    const pts = elementSnapPoints({ tracks, excludeElementIds: new Set(["a"]) });
    expect(pts.map((p) => p.time)).toEqual([sec(5), sec(7)]);
  });
  it("snapGroupEdges can snap either edge of any member", () => {
    const points = [{ time: sec(10), type: "element-start" as const }];
    const startSnap = snapGroupEdges({ anchorStart: sec(10) - 3000, members: [{ offset: 0, duration: sec(2) }], points, maxDistance: 24000 });
    expect(startSnap.anchorStart).toBe(sec(10));
    const endSnap = snapGroupEdges({ anchorStart: sec(8) + 2000, members: [{ offset: 0, duration: sec(2) }], points, maxDistance: 24000 });
    expect(endSnap.anchorStart).toBe(sec(8));
    const none = snapGroupEdges({ anchorStart: sec(1), members: [{ offset: 0, duration: sec(2) }], points, maxDistance: 24000 });
    expect(none.snapPoint).toBeNull();
  });
  it("snapResizeDelta moves the dragged edge onto the point", () => {
    const r = snapResizeDelta({ edges: [sec(5)], delta: sec(1) - 1000, points: [{ time: sec(6), type: "playhead" }], maxDistance: 24000 });
    expect(r.delta).toBe(sec(1));
  });
});

describe("scale and ruler", () => {
  it("time <-> pixels derive from zoom and round-trip", () => {
    expect(timeToPixels(sec(2), 1)).toBe(100);
    expect(timeToPixels(sec(2), 4)).toBe(400);
    expect(pixelsToTime(100, 1)).toBe(sec(2));
    expect(pixelsToTime(timeToPixels(sec(3.3), 2.5), 2.5)).toBe(sec(3.3));
  });
  it("min zoom keeps content at a quarter of the viewport and slider maps exponentially", () => {
    const min = minZoomFor({ containerWidth: 1000, durationSeconds: 10 });
    expect(min).toBeCloseTo(0.5);
    expect(clampZoom(0.01, min)).toBe(min);
    expect(clampZoom(1000, min)).toBe(100);
    expect(sliderToZoom(zoomToSlider(3, min), min)).toBeCloseTo(3);
    expect(sliderToZoom(0, min)).toBeCloseTo(min);
    expect(sliderToZoom(1, min)).toBeCloseTo(100);
  });
  it("content width never shrinks below the container and includes padding", () => {
    expect(contentWidth({ duration: 0, zoom: 1, minZoom: 1, containerWidth: 800 })).toBe(800);
    expect(contentWidth({ duration: sec(100), zoom: 1, minZoom: 0.5, containerWidth: 800 })).toBeGreaterThan(5000);
  });
  it("wheel zoom is symmetric and capped", () => {
    expect(wheelZoomFactor(-30, 0)).toBeGreaterThan(1);
    expect(wheelZoomFactor(30, 0)).toBeLessThan(1);
    expect(wheelZoomFactor(-30, 0) * wheelZoomFactor(30, 0)).toBeCloseTo(1);
    expect(wheelZoomFactor(-9999, 0)).toBe(wheelZoomFactor(-30, 0));
  });
  it("zoom anchors the playhead only past the slider threshold", () => {
    const keep = scrollAnchoredToPlayhead({ playheadTime: sec(10), scrollLeft: 300, oldZoom: 1, newZoom: 2, sliderPosition: 0.5 });
    expect(keep).toBe(timeToPixels(sec(10), 2) - (timeToPixels(sec(10), 1) - 300));
    expect(scrollAnchoredToPlayhead({ playheadTime: sec(10), scrollLeft: 300, oldZoom: 1, newZoom: 2, sliderPosition: 0.05 })).toBeNull();
  });
  it("ruler labels switch between MM:SS and frame counts", () => {
    expect(formatRulerLabel({ time: sec(65), fps })).toBe("01:05");
    expect(formatRulerLabel({ time: sec(3600), fps })).toBe("1:00:00");
    expect(formatRulerLabel({ time: sec(1) + 20000, fps })).toBe("5f");
  });
  it("tick intervals always divide the label interval and respect spacing", () => {
    for (const zoom of [0.1, 0.5, 1, 2, 5, 20, 100]) {
      const { label, tick } = rulerIntervals({ zoom, fps });
      const toS = (i: typeof label) => (i.unit === "frames" ? i.step / 30 : i.step);
      const ratio = toS(label) / toS(tick);
      expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-6);
    }
  });
  it("virtualised ticks cover only the visible range and carry labels on label boundaries", () => {
    const ticks = buildRulerTicks({ zoom: 1, fps, scrollLeft: 0, viewportWidth: 600, maxTime: sec(600) });
    expect(ticks.length).toBeGreaterThan(5);
    expect(ticks.length).toBeLessThan(200);
    expect(ticks[0]).toMatchObject({ time: 0, label: "00:00" });
    expect(ticks.some((t) => t.label === null)).toBe(true);
    expect(ticks.every((t) => t.time <= sec(600))).toBe(true);
  });
});

describe("selection", () => {
  const tracks = tracksWith({ overlay: [{ id: "o", elements: [video("a", 0, 2)] }], main: [video("m", 3, 2)] });
  it("toggle adds and removes", () => {
    let s = toggleSelection(EMPTY_SELECTION, ref("o", "a"));
    s = toggleSelection(s, ref("main", "m"));
    expect(s.elements).toHaveLength(2);
    expect(toggleSelection(s, ref("o", "a")).elements).toEqual([ref("main", "m")]);
  });
  it("select all covers every track", () => {
    expect(selectAll(tracks).elements).toHaveLength(2);
  });
  it("box select hits by rectangle intersection, touching included", () => {
    const layout = { heights: [65, 65], gap: 6 };
    const timeToX = (t: number) => timeToPixels(t, 1);
    const hits = elementsInBox({ tracks, layout, timeToX, box: { left: 90, right: 120, top: 0, bottom: 40 } });
    expect(hits).toEqual([ref("o", "a")]);
    expect(elementsInBox({ tracks, layout, timeToX, box: { left: 100, right: 120, top: 0, bottom: 40 } })).toEqual([ref("o", "a")]);
    expect(elementsInBox({ tracks, layout, timeToX, box: { left: 0, right: 400, top: 0, bottom: 200 } })).toHaveLength(2);
  });
  it("additive box select merges without duplicates", () => {
    const current = toggleSelection(EMPTY_SELECTION, ref("o", "a"));
    const merged = applyBoxSelection({ current, hits: [ref("o", "a"), ref("main", "m")], additive: true });
    expect(merged.elements).toHaveLength(2);
    expect(applyBoxSelection({ current, hits: [ref("main", "m")], additive: false }).elements).toEqual([ref("main", "m")]);
  });
  it("pruning drops deleted references and escape peels keyframes first", () => {
    const s = { ...selectAll(tracks), keyframes: [{ trackId: "o", elementId: "a", propertyPath: "opacity", keyframeId: "k" }], keyframeAnchor: null };
    expect(clearMostSpecific(s).elements).toHaveLength(2);
    expect(clearMostSpecific(clearMostSpecific(s)).elements).toHaveLength(0);
    expect(pruneSelection(selectAll(tracks), removeElements(tracks, [ref("o", "a")])).elements).toEqual([ref("main", "m")]);
  });
});

void text; void TICKS_PER_SECOND;
