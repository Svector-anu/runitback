import { describe, expect, it } from "vitest";
import { cursorAnimations, cursorPathProblem, CURSOR_CLICK_PATH, CURSOR_CLICK_TICKS } from "#/engine/animation";
import { insertElement, setCursorPathCommand } from "#/engine/commands";
import { GRAPHIC_DEFINITIONS, PARAM, buildGraphicElement, defaultsOf, sequentialIds, type GraphicElement } from "#/engine/model";
import { buildFramePlan, type MediaLayer } from "#/engine/render";
import { TICKS_PER_SECOND } from "#/engine/time";
import { allElements, resolveElementParams } from "#/engine/timeline";
import { drawCursor, drawWindowFrame } from "#/render/graphic-symbols";
import { setupAgent } from "./agent-harness";
import { makeEditor, sec, tracksWith } from "./helpers";

const ids = sequentialIds("k");
const clip = sec(6);

describe("cursorAnimations", () => {
  const path = [{ time: 0, x: -200, y: 100 }, { time: sec(1), x: 100, y: -50, click: true }, { time: sec(3), x: 100, y: -50 }, { time: sec(4), x: 300, y: 200 }];
  const animations = cursorAnimations({ animations: undefined, waypoints: path, clipDuration: clip, newId: ids });
  const element = { animations, params: { [PARAM.positionX]: 0, [PARAM.positionY]: 0, click: 0 } } as unknown as GraphicElement;
  const at = (seconds: number) => resolveElementParams(element, sec(seconds));

  it("hits every stop exactly and eases between them without overshoot", () => {
    expect(at(0)).toMatchObject({ [PARAM.positionX]: -200, [PARAM.positionY]: 100 });
    expect(at(1)).toMatchObject({ [PARAM.positionX]: 100, [PARAM.positionY]: -50 });
    expect(at(4)).toMatchObject({ [PARAM.positionX]: 300, [PARAM.positionY]: 200 });
    const mid = at(0.5)[PARAM.positionX] as number;
    expect(mid).toBeGreaterThan(-200);
    expect(mid).toBeLessThan(100);
    for (let s = 0; s <= 6; s += 0.1) {
      const x = at(s)[PARAM.positionX] as number;
      expect(x).toBeGreaterThanOrEqual(-200 - 1e-6);
      expect(x).toBeLessThanOrEqual(300 + 1e-6);
    }
  });
  it("dwells where two stops share a place", () => {
    expect(at(2)).toMatchObject({ [PARAM.positionX]: 100, [PARAM.positionY]: -50 });
    expect(at(2.99)[PARAM.positionX]).toBeCloseTo(100, 6);
  });
  it("plays the click ripple once after the clicking stop and rests at 1 (no ripple)", () => {
    expect(at(0.9).click).toBe(0);
    expect(at(1).click).toBe(0);
    expect(at(1.25).click).toBeCloseTo(0.5, 2);
    expect(at(1 + CURSOR_CLICK_TICKS / TICKS_PER_SECOND).click).toBe(1);
    expect(at(5).click).toBe(1);
  });
  it("replaces earlier cursor keyframes and keeps other paths", () => {
    const withOther = cursorAnimations({ animations: cursorAnimations({ animations: { opacity: { kind: "channel", channel: { kind: "scalar", keys: [] } } }, waypoints: path, clipDuration: clip, newId: ids }), waypoints: [{ time: 0, x: 5, y: 6 }], clipDuration: clip, newId: ids });
    expect(withOther[CURSOR_CLICK_PATH]).toBeUndefined();
    expect(Object.keys(withOther).sort()).toEqual([PARAM.positionX, PARAM.positionY].sort());
  });
  it("shortens a ripple that the next click would overlap, and drops one that cannot fit", () => {
    const quick = cursorAnimations({ animations: undefined, waypoints: [{ time: 0, x: 0, y: 0, click: true }, { time: sec(0.2), x: 0, y: 0, click: true }, { time: clip, x: 0, y: 0, click: true }], clipDuration: clip, newId: ids });
    const probe = { animations: quick, params: { click: 0 } } as unknown as GraphicElement;
    const values = [0, 0.1, 0.19, 0.2, 0.3, 0.6, 5.9].map((s) => resolveElementParams(probe, sec(s)).click as number);
    expect(values[1]).toBeGreaterThan(0);
    expect(values[2]).toBeGreaterThan(0.9);
    expect(values[3]).toBe(0);
    expect(values[4]).toBeGreaterThan(0);
    expect(values[6]).toBe(1);
  });
  it("rejects unusable paths", () => {
    const problem = (waypoints: Parameters<typeof cursorPathProblem>[0]["waypoints"]) => cursorPathProblem({ waypoints, clipDuration: clip });
    expect(problem([])).toMatch(/no points/);
    expect(problem([{ time: 0, x: 0, y: 0 }, { time: 0, x: 1, y: 1 }])).toMatch(/not later/);
    expect(problem([{ time: clip + 1, x: 0, y: 0 }])).toMatch(/outside the clip/);
    expect(problem([{ time: 0, x: Number.NaN, y: 0 }])).toMatch(/finite/);
    expect(problem(Array.from({ length: 65 }, (_, i) => ({ time: i, x: 0, y: 0 })))).toMatch(/limit/);
    expect(problem([{ time: 0, x: 1, y: 2 }])).toBeNull();
  });
});

describe("setCursorPathCommand", () => {
  function setup() {
    const { editor } = makeEditor();
    const definition = GRAPHIC_DEFINITIONS["cursor"]!;
    const element = { ...buildGraphicElement({ id: "c", startTime: sec(0), definitionId: "cursor", params: defaultsOf(definition.params) }), duration: clip };
    editor.execute(insertElement({ element, placement: { mode: "newTrack", index: 0, trackId: "g" } }));
    return { editor, ref: { trackId: "g", elementId: "c" } };
  }
  const get = (editor: ReturnType<typeof setup>["editor"]) => allElements(editor.tracks()).find((l) => l.element.id === "c")!.element as GraphicElement;

  it("moves the cursor, sets the static position to the first stop and undoes in one step", () => {
    const { editor, ref } = setup();
    editor.execute(setCursorPathCommand({ ref, waypoints: [{ time: 0, x: 40, y: 50 }, { time: sec(2), x: -40, y: -50, click: true }] }));
    expect(get(editor).params).toMatchObject({ [PARAM.positionX]: 40, [PARAM.positionY]: 50, click: 0 });
    expect(resolveElementParams(get(editor), sec(2))[PARAM.positionX]).toBe(-40);
    editor.undo();
    expect(get(editor).animations).toBeUndefined();
  });
  it("refuses other clips and bad paths without changing anything", () => {
    const { editor, ref } = setup();
    expect(() => editor.execute(setCursorPathCommand({ ref, waypoints: [] }))).toThrow(/no points/);
    expect(get(editor).animations).toBeUndefined();
  });
});

describe("cursor in the frame plan", () => {
  it("carries the animated click and position into the drawn layer", () => {
    const definition = GRAPHIC_DEFINITIONS["cursor"]!;
    const base = { ...buildGraphicElement({ id: "c", startTime: sec(0), definitionId: "cursor", params: defaultsOf(definition.params) }), duration: clip };
    const element: GraphicElement = { ...base, animations: cursorAnimations({ animations: undefined, waypoints: [{ time: 0, x: 0, y: 0 }, { time: sec(2), x: 300, y: 100, click: true }], clipDuration: clip, newId: ids }) };
    const tracks = tracksWith({ overlay: [{ id: "g", type: "graphic", elements: [element] }] });
    const layer = buildFramePlan({ tracks, canvas: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" }, assets: [], time: sec(2.25) }).items[0] as MediaLayer;
    expect(layer.source).toMatchObject({ type: "graphic", definitionId: "cursor" });
    expect((layer.source as { params: Record<string, number> }).params.click).toBeCloseTo(0.5, 2);
    expect(layer.transform.centerX).toBe(960 + 300);
    expect(layer.transform.centerY).toBe(540 + 100);
  });
});

type Call = [string, ...unknown[]];
function recorder(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy({}, {
    get(_t, prop: string) {
      if (typeof state[prop] !== "undefined") return state[prop];
      return (...args: unknown[]) => { calls.push([prop, ...args, state.globalAlpha, state.fillStyle]); };
    },
    set(_t, prop: string, value) { state[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe("cursor and window drawing", () => {
  const params = (extra: Record<string, number | string> = {}) => ({ ...defaultsOf(GRAPHIC_DEFINITIONS["cursor"]!.params), ...extra });
  it("draws the pointer at the centre and no ripple while the click is at rest", () => {
    for (const click of [0, 1]) {
      const { ctx, calls } = recorder();
      drawCursor(ctx, params({ click }), 400, 300);
      expect(calls.find((c) => c[0] === "translate")?.slice(1, 3)).toEqual([200, 150]);
      expect(calls.filter((c) => c[0] === "arc")).toHaveLength(0);
    }
  });
  it("draws an expanding, fading ripple mid-click", () => {
    const radius = (click: number): number => {
      const { ctx, calls } = recorder();
      drawCursor(ctx, params({ click }), 400, 400);
      return calls.find((c) => c[0] === "arc")?.[3] as number;
    };
    expect(radius(0.2)).toBeLessThan(radius(0.6));
    const { ctx, calls } = recorder();
    drawCursor(ctx, params({ click: 0.9 }), 400, 400);
    expect(calls.find((c) => c[0] === "fill")?.[1]).toBeCloseTo(0.025, 3);
  });
  it("draws hand and dot styles differently", () => {
    const sequence = (style: string): string => {
      const r = recorder();
      drawCursor(r.ctx, params({ style }), 300, 300);
      return r.calls.map((c) => c[0]).join(",");
    };
    expect(new Set(["arrow", "hand", "dot"].map(sequence)).size).toBe(3);
  });
  it("lays a window frame out from the box: bar, three lights, address pill only for browsers", () => {
    const frame = (style: string) => {
      const { ctx, calls } = recorder();
      drawWindowFrame(ctx, { ...defaultsOf(GRAPHIC_DEFINITIONS["window-frame"]!.params), style }, { width: 800, height: 500, canvasHeight: 1080 });
      return calls;
    };
    expect(frame("mac").filter((c) => c[0] === "arc")).toHaveLength(3);
    expect(frame("plain").filter((c) => c[0] === "arc")).toHaveLength(0);
    expect(frame("browser").filter((c) => c[0] === "roundRect").length).toBe(frame("mac").filter((c) => c[0] === "roundRect").length + 1);
  });
});

describe("agent cursor tools", () => {
  it("insert_cursor places a sized cursor and animates it; set_cursor_path re-routes it", async () => {
    const h = setupAgent();
    const out = await h.data<{ elementId: string }>("insert_cursor", {
      points: [{ time: 0, x: -300, y: 200 }, { time: 1.5, x: 200, y: -100, click: true }], start: 1, params: { style: "hand", rippleColor: "#ff0000" },
    });
    const get = () => allElements(h.editor.tracks()).find((l) => l.element.id === out.elementId)!.element as GraphicElement;
    expect(get().definitionId).toBe("cursor");
    expect(get().params).toMatchObject({ style: "hand", rippleColor: "#ff0000", [PARAM.positionX]: -300, "transform.scaleX": 0.45 });
    expect(resolveElementParams(get(), sec(1.5))[PARAM.positionX]).toBe(200);
    expect(get().duration).toBe(sec(2.5));
    await h.data("set_cursor_path", { elementId: out.elementId, points: [{ time: 0, x: 0, y: 0 }, { time: 2, x: 50, y: 50 }] });
    expect(resolveElementParams(get(), sec(2))[PARAM.positionX]).toBe(50);
    expect(get().animations?.[CURSOR_CLICK_PATH]).toBeUndefined();
  });
  it("explains bad input and leaves the timeline alone", async () => {
    const h = setupAgent();
    const before = JSON.stringify(h.editor.tracks());
    expect((await h.failure("insert_cursor", { points: [] })).hint).toContain("stop");
    expect((await h.failure("insert_cursor", { points: [{ time: 0, x: "a", y: 0 }] })).error).toContain("points[0].x");
    expect((await h.failure("insert_cursor", { points: [{ time: 3, x: 0, y: 0 }], duration: 1 })).hint).toContain("duration");
    expect((await h.failure("insert_cursor", { points: [{ time: 0, x: 0, y: 0 }], params: { style: "laser" } })).error).toContain("style");
    expect((await h.failure("set_cursor_path", { elementId: "nope", points: [{ time: 0, x: 0, y: 0 }] })).error.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.editor.tracks())).toBe(before);
  });
});
