import { describe, expect, it } from "vitest";
import {
  applyPlacement, canPlaceSpans, defaultInsertIndex, enforceMainTrackStart, highestInsertIndex, resolveTrackPlacement,
} from "#/engine/timeline/placement";
import { createTrack } from "#/engine/model";
import { audio, sec, text, tracksWith, video, mustTrack } from "./helpers";

const span = (start: number, duration: number, excludeElementId?: string) => ({ start: sec(start), duration: sec(duration), excludeElementId });

describe("insert indices", () => {
  const tracks = tracksWith({
    overlay: [{ id: "o1", elements: [] }, { id: "o2", elements: [] }],
    audio: [{ id: "a1", elements: [] }],
  });
  it("places new tracks next to their own kind", () => {
    expect(defaultInsertIndex(tracks, "video")).toBe(2);
    expect(defaultInsertIndex(tracks, "text")).toBe(2);
    expect(defaultInsertIndex(tracks, "effect")).toBe(0);
    expect(defaultInsertIndex(tracks, "audio")).toBe(4);
    expect(highestInsertIndex(tracks, "video")).toBe(0);
    expect(highestInsertIndex(tracks, "audio")).toBe(3);
  });
});

describe("main track start rule", () => {
  const tracks = tracksWith({ main: [video("m1", 5, 3)] });
  it("pins a clip to zero when it would start at or before the earliest other clip", () => {
    expect(enforceMainTrackStart({ tracks, trackId: "main", requestedStart: sec(5) })).toBe(0);
    expect(enforceMainTrackStart({ tracks, trackId: "main", requestedStart: sec(2) })).toBe(0);
  });
  it("keeps starts after the earliest clip and ignores the moving element itself", () => {
    expect(enforceMainTrackStart({ tracks, trackId: "main", requestedStart: sec(6) })).toBe(sec(6));
    expect(enforceMainTrackStart({ tracks, trackId: "main", requestedStart: sec(9), excludeElementId: "m1" })).toBe(0);
  });
  it("does not apply to other tracks", () => {
    const t = tracksWith({ overlay: [{ id: "o", elements: [video("x", 1, 1)] }] });
    expect(enforceMainTrackStart({ tracks: t, trackId: "o", requestedStart: sec(0.5) })).toBe(sec(0.5));
  });
});

describe("overlap", () => {
  it("touching edges are not overlaps", () => {
    const t = tracksWith({ main: [video("a", 0, 5)] });
    expect(canPlaceSpans(t.main, [span(5, 2)])).toBe(true);
    expect(canPlaceSpans(t.main, [span(4.99, 2)])).toBe(false);
  });
  it("ignores the excluded element", () => {
    const t = tracksWith({ main: [video("a", 0, 5)] });
    expect(canPlaceSpans(t.main, [span(1, 2, "a")])).toBe(true);
  });
});

describe("resolveTrackPlacement", () => {
  const base = tracksWith({
    overlay: [{ id: "o1", elements: [video("x", 0, 4)] }],
    main: [video("m", 0, 10)],
    audio: [{ id: "a1", elements: [audio("s", 0, 3)] }],
  });

  it("explicit: returns a compatible track, rejects missing or mismatched types", () => {
    expect(resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)], strategy: { kind: "explicit", trackId: "o1" } }))
      .toMatchObject({ kind: "existingTrack", trackId: "o1", trackIndex: 0 });
    expect(resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)], strategy: { kind: "explicit", trackId: "nope" } })).toBeNull();
    expect(resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)], strategy: { kind: "explicit", trackId: "a1" } })).toBeNull();
  });
  it("firstAvailable: first compatible non-overlapping track, otherwise a new highest track", () => {
    expect(resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(5, 1)], strategy: { kind: "firstAvailable" } }))
      .toMatchObject({ kind: "existingTrack", trackId: "o1" });
    expect(resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)], strategy: { kind: "firstAvailable" } }))
      .toMatchObject({ kind: "newTrack", insertIndex: 0 });
    expect(resolveTrackPlacement({ tracks: base, elementType: "audio", spans: [span(1, 1)], strategy: { kind: "firstAvailable" } }))
      .toMatchObject({ kind: "newTrack", trackType: "audio", insertIndex: 2 });
  });
  it("firstAvailable on main reports an adjusted start of zero", () => {
    const empty = tracksWith({ main: [video("m", 4, 2)] });
    const r = resolveTrackPlacement({ tracks: empty, elementType: "video", spans: [span(1, 1)], strategy: { kind: "firstAvailable" } });
    expect(r).toMatchObject({ kind: "existingTrack", trackId: "main", adjustedStartTime: 0 });
  });
  it("preferIndex: uses the hovered track if it fits", () => {
    expect(resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(5, 1)],
      strategy: { kind: "preferIndex", trackIndex: 0, hoverDirection: "above" } })).toMatchObject({ kind: "existingTrack", trackId: "o1" });
  });
  it("preferIndex: otherwise creates an overlay above/below the hovered overlay but never below main", () => {
    const above = resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)],
      strategy: { kind: "preferIndex", trackIndex: 0, hoverDirection: "above" } });
    expect(above).toMatchObject({ kind: "newTrack", insertIndex: 0, insertPosition: "above" });
    const belowMain = resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)],
      strategy: { kind: "preferIndex", trackIndex: 1, hoverDirection: "below" } });
    expect(belowMain).toMatchObject({ kind: "newTrack", insertIndex: 1, insertPosition: "above" });
  });
  it("preferIndex: audio is always inserted below main", () => {
    const r = resolveTrackPlacement({ tracks: base, elementType: "audio", spans: [span(1, 1)],
      strategy: { kind: "preferIndex", trackIndex: 0, hoverDirection: "above" } });
    expect(r).toMatchObject({ kind: "newTrack", insertIndex: 2, insertPosition: "below" });
  });
  it("preferIndex: incompatible hover track follows the vertical drag direction", () => {
    const up = resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)],
      strategy: { kind: "preferIndex", trackIndex: 2, hoverDirection: "below", verticalDragDirection: "up" } });
    const down = resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)],
      strategy: { kind: "preferIndex", trackIndex: 2, hoverDirection: "above", verticalDragDirection: "down" } });
    expect(up).toMatchObject({ insertPosition: "above" });
    expect(down).toMatchObject({ insertPosition: "above", insertIndex: 1 });
  });
  it("createNewTrackOnly never reuses the hovered track", () => {
    const r = resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(5, 1)],
      strategy: { kind: "preferIndex", trackIndex: 0, hoverDirection: "above", createNewTrackOnly: true } });
    expect(r?.kind).toBe("newTrack");
  });
  it("aboveSource: reuses the track above the source if it fits, else any fitting track, else a new one", () => {
    expect(resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(5, 1)], strategy: { kind: "aboveSource", sourceTrackIndex: 1 } }))
      .toMatchObject({ kind: "existingTrack", trackId: "o1" });
    expect(resolveTrackPlacement({ tracks: base, elementType: "video", spans: [span(1, 1)], strategy: { kind: "aboveSource", sourceTrackIndex: 1 } }))
      .toMatchObject({ kind: "newTrack", insertIndex: 0, insertPosition: null });
  });
  it("alwaysNew picks highest or default slot", () => {
    expect(resolveTrackPlacement({ tracks: base, elementType: "audio", spans: [], strategy: { kind: "alwaysNew", position: "highest" } }))
      .toMatchObject({ insertIndex: 2 });
    expect(resolveTrackPlacement({ tracks: base, elementType: "audio", spans: [], strategy: { kind: "alwaysNew", position: "default" } }))
      .toMatchObject({ insertIndex: 3 });
  });
  it("a batch of spans is rejected by a track if any span overlaps", () => {
    const r = resolveTrackPlacement({ tracks: base, elementType: "audio", spans: [span(4, 1), span(1, 1)], strategy: { kind: "firstAvailable" } });
    expect(r).toMatchObject({ kind: "newTrack", insertIndex: 2 });
  });
  it("text goes to text tracks only", () => {
    const t = tracksWith({ overlay: [{ id: "tx", type: "text", elements: [] }] });
    expect(resolveTrackPlacement({ tracks: t, elementType: "text", spans: [span(0, 1)], strategy: { kind: "firstAvailable" } }))
      .toMatchObject({ kind: "existingTrack", trackId: "tx" });
    expect(resolveTrackPlacement({ tracks: t, elementType: "video", spans: [span(0, 1)], strategy: { kind: "firstAvailable" } }))
      .toMatchObject({ kind: "existingTrack", trackId: "main" });
  });
});

describe("applyPlacement", () => {
  it("creates overlay and audio tracks in their zones", () => {
    const tracks = tracksWith({ overlay: [{ id: "o1", elements: [video("x", 0, 1)] }], audio: [{ id: "a1", elements: [audio("s", 0, 1)] }] });
    const withAudio = applyPlacement({ tracks, placement: { kind: "newTrack", trackType: "audio", insertIndex: 2, insertPosition: "below" },
      elements: [audio("n", 0, 1)], newTrack: createTrack("audio", "a0") });
    expect(withAudio.audio.map((t) => t.id)).toEqual(["a0", "a1"]);
    const withText = applyPlacement({ tracks, placement: { kind: "newTrack", trackType: "text", insertIndex: 0, insertPosition: "above" },
      elements: [text("t", 0)], newTrack: createTrack("text", "tx") });
    expect(withText.overlay.map((t) => t.id)).toEqual(["tx", "o1"]);
  });
  it("appends to an existing track", () => {
    const tracks = tracksWith({ main: [video("a", 0, 1)] });
    const next = applyPlacement({ tracks, placement: { kind: "existingTrack", trackId: "main", trackIndex: 0, trackType: "video" }, elements: [video("b", 1, 1)] });
    expect(mustTrack(next, "main").elements.map((e) => e.id)).toEqual(["a", "b"]);
  });
  it("requires a track instance for new-track placements", () => {
    expect(() => applyPlacement({ tracks: tracksWith({}), placement: { kind: "newTrack", trackType: "audio", insertIndex: 1, insertPosition: null }, elements: [] })).toThrow();
  });
});
