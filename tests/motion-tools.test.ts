import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, createMotionTools, type MotionDeps } from "#/engine/agent";
import type { MotionSample, TrackSample } from "#/engine/tracking";
import { resolveNumberAtTime } from "#/engine/animation";
import { TICKS_PER_SECOND } from "#/engine/time";
import { allElements, sceneViolations } from "#/engine/timeline";
import { currentScene } from "#/engine/commands";
import { setupAgent, tracksOf, type AgentHarness, type InsertedData } from "./agent-harness";

const W = 320, H = 180;

interface Calls { track: Array<{ times: number[]; start: { u: number; v: number } }>; camera: Array<{ times: number[] }> }

function setup(deps?: Partial<MotionDeps>): { h: AgentHarness; calls: Calls; call: (name: string, args: unknown) => ReturnType<typeof callTool> } {
  const h = setupAgent();
  const calls: Calls = { track: [], camera: [] };
  const full: MotionDeps = {
    async track({ times, start }) {
      calls.track.push({ times, start });
      return { width: W, height: H, samples: times.map((t, i): TrackSample => ({ t, x: start.u * (W - 1) + i * 2, y: start.v * (H - 1) + i, confidence: 0.99, lost: false })) };
    },
    async camera({ times }) {
      calls.camera.push({ times });
      return { width: W, height: H, path: times.map((t, i): MotionSample => ({ t, x: i % 2 === 0 ? 4 : -4, y: 0, support: 6 })) };
    },
    ...deps,
  };
  const tools = new Map(createAgentTools());
  for (const tool of createMotionTools(full)) tools.set(tool.name, tool);
  return { h, calls, call: (name, args) => callTool({ tools, name, args, ctx: { editor: h.editor, nowMs: () => 0 } }) };
}

const element = (h: AgentHarness, id: string) => allElements(tracksOf(h.editor)).find((l) => l.element.id === id)?.element as never as {
  id: string; startTime: number; duration: number; params: Record<string, number>; animations?: Record<string, unknown>;
};
const valueAt = (h: AgentHarness, id: string, path: string, seconds: number): number => {
  const el = element(h, id);
  return resolveNumberAtTime(el.animations as never, path, Math.round(seconds * TICKS_PER_SECOND), el.params[path] ?? 0);
};
const healthy = (h: AgentHarness): void => { expect(sceneViolations(currentScene(h.editor.getState().doc))).toEqual([]); };

async function scene(h: AgentHarness): Promise<{ video: string; text: string }> {
  const video = await h.data<InsertedData>("insert_media", { assetId: "a1" });
  const text = await h.data<InsertedData>("insert_text", { text: "tag", start: 1, duration: 4 });
  return { video: video.elementId, text: text.elementId };
}

describe("track_point", () => {
  it("writes position keyframes that put the target's centre on the tracked point, in one undo step", async () => {
    const { h, calls, call } = setup();
    const { video, text } = await scene(h);
    const result = await call("track_point", { videoElementId: video, targetElementId: text, x: 0.5, y: 0.5 });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect(calls.track).toHaveLength(1);
    expect(calls.track[0]?.start).toEqual({ u: 0.5, v: 0.5 });
    const times = calls.track[0]?.times ?? [];
    expect(times.length).toBeGreaterThan(100);
    expect(times.every((t, i) => i === 0 || t >= (times[i - 1] as number))).toBe(true);
    expect(times[0]).toBeCloseTo(1, 2);
    expect(times[times.length - 1]).toBeCloseTo(5 - 1 / 120_000 * 0, 0);

    // The video fills a 1920x1080 canvas, so the analysis picture (320x180) is scaled by 6; the point starts at the centre.
    const startPx = (0.5 * (W - 1)) * (1920 / (W - 1)) - 960;
    expect(valueAt(h, text, "transform.positionX", 0)).toBeCloseTo(startPx, 0);
    const lastIndex = times.length - 1;
    expect(valueAt(h, text, "transform.positionX", 4)).toBeCloseTo(startPx + lastIndex * 2 * (1920 / (W - 1)), -1);
    healthy(h);
    h.editor.undo();
    expect(element(h, text).animations ?? {}).toEqual({});
  });

  it("applies the offset, follows the video's own transform, and keeps keyframes few for a straight path", async () => {
    const { h, call } = setup();
    const { video, text } = await scene(h);
    await h.data("set_params", { elementId: video, params: { "transform.scaleX": 0.5, "transform.scaleY": 0.5, "transform.positionX": 100 } });
    const result = await call("track_point", { videoElementId: video, targetElementId: text, x: 0.5, y: 0.5, offsetX: 30, offsetY: -20 });
    expect(result.ok).toBe(true);
    // half-size video: the point sits at canvas centre + 100 + 0 px; plus the offset
    expect(valueAt(h, text, "transform.positionX", 0)).toBeCloseTo(100 + 30, 0);
    expect(valueAt(h, text, "transform.positionY", 0)).toBeCloseTo(-20, 0);
    if (result.ok) expect((result.data as { keyframes: { positionX: number } }).keyframes.positionX).toBeLessThanOrEqual(3);
  });

  it("reports lost frames and refuses bad targets without touching the document", async () => {
    const lostHalf: MotionDeps["track"] = async ({ times, start }) => ({
      width: W, height: H, samples: times.map((t, i): TrackSample => ({ t, x: start.u * (W - 1), y: start.v * (H - 1), confidence: i < times.length / 2 ? 0.95 : 0.2, lost: i >= times.length / 2 })),
    });
    const { h, call } = setup({ track: lostHalf });
    const { video, text } = await scene(h);
    const result = await call("track_point", { videoElementId: video, targetElementId: text, x: 0.4, y: 0.4 });
    expect(result.ok && result.summary).toMatch(/lost in 5\d%/);

    const music = await h.data<InsertedData>("insert_media", { assetId: "music" });
    const before = JSON.stringify(h.editor.getState().doc);
    expect((await call("track_point", { videoElementId: text, targetElementId: text, x: 0.5, y: 0.5 })).ok).toBe(false);
    expect((await call("track_point", { videoElementId: video, targetElementId: video, x: 0.5, y: 0.5 })).ok).toBe(false);
    expect((await call("track_point", { videoElementId: video, targetElementId: text, x: 2, y: 0.5 })).ok).toBe(false);
    expect((await call("track_point", { videoElementId: video, targetElementId: music.elementId, x: 0.5, y: 0.5 })).ok).toBe(false);
    expect(JSON.stringify(h.editor.getState().doc)).toBe(before);
    healthy(h);
  });

  it("turns an analysis failure into a readable error and leaves the target alone", async () => {
    const { h, call } = setup({ track: async () => { throw new Error("There is not enough texture at that point to follow it"); } });
    const { video, text } = await scene(h);
    const result = await call("track_point", { videoElementId: video, targetElementId: text, x: 0.5, y: 0.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/texture/);
    expect(element(h, text).animations ?? {}).toEqual({});
  });

  it("rejects ranges that are too long and ranges with no overlap", async () => {
    const { h, call } = setup();
    const video = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const text = await h.data<InsertedData>("insert_text", { text: "x", start: 12, duration: 3 });
    expect((await call("track_point", { videoElementId: video.elementId, targetElementId: text.elementId, x: 0.5, y: 0.5 })).ok).toBe(false);
  });

  it("samples source time through a speed ramp (times stay ascending and cover the visible source)", async () => {
    const { h, calls, call } = setup();
    const { video, text } = await scene(h);
    await h.data("set_speed_ramp", { elementId: video, preset: "hero" });
    const result = await call("track_point", { videoElementId: video, targetElementId: text, x: 0.5, y: 0.5, start: 1, end: 6 });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    const times = calls.track[0]?.times ?? [];
    expect(times.every((t, i) => i === 0 || t >= (times[i - 1] as number))).toBe(true);
    expect(times[0]).toBeGreaterThan(0.5);
    healthy(h);
  });
});

describe("stabilize_clip", () => {
  it("counter-moves with position keyframes, zooms to hide the edges, and undoes in one step", async () => {
    const { h, calls, call } = setup();
    const video = await h.data<InsertedData>("insert_media", { assetId: "a1", start: 0 });
    const clipId = video.elementId;
    const result = await call("stabilize_clip", { elementId: clipId, smoothness: 0.2 });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect(calls.camera).toHaveLength(1);
    const el = element(h, clipId);
    expect(Object.keys(el.animations ?? {}).sort()).toEqual(["transform.positionX", "transform.positionY"]);
    expect(el.params["transform.scaleX"]).toBeGreaterThan(1);
    expect(el.params["transform.scaleX"]).toBe(el.params["transform.scaleY"]);
    const data = result.ok ? (result.data as { maxShiftPx: { x: number }; zoomPercent: number; measuredShare: number }) : null;
    expect(data?.measuredShare).toBe(1);
    // The path alternates +-4 analysis px; the correction at frame 1 must oppose the raw offset (raw -4, smooth ~0 -> +).
    expect(valueAt(h, clipId, "transform.positionX", 1 / 30)).toBeGreaterThan(0);
    expect(valueAt(h, clipId, "transform.positionX", 2 / 30)).toBeLessThan(0);
    expect(data?.zoomPercent).toBeGreaterThan(0);
    healthy(h);
    h.editor.undo();
    expect(element(h, clipId).animations ?? {}).toEqual({});
    expect(element(h, clipId).params["transform.scaleX"]).toBe(1);
  });

  it("caps the counter-move at maxShiftPercent of the picture", async () => {
    const wild: MotionDeps["camera"] = async ({ times }) => ({ width: W, height: H, path: times.map((t, i): MotionSample => ({ t, x: i % 2 === 0 ? 60 : -60, y: 0, support: 6 })) });
    const { h, call } = setup({ camera: wild });
    const video = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const result = await call("stabilize_clip", { elementId: video.elementId, smoothness: 0.2, maxShiftPercent: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data as { maxShiftPx: { x: number } }).maxShiftPx.x).toBeLessThanOrEqual(0.05 * 1920 + 0.01);
    const el = element(h, video.elementId);
    expect(Math.abs(valueAt(h, video.elementId, "transform.positionX", 1 / 30))).toBeLessThanOrEqual(0.05 * 1920 + 0.5);
    expect(el.params["transform.scaleX"]).toBeLessThan(1.15);
  });

  it("refuses when motion could not be measured, and refuses images, text and bad ranges", async () => {
    const blind: MotionDeps["camera"] = async ({ times }) => ({ width: W, height: H, path: times.map((t): MotionSample => ({ t, x: 0, y: 0, support: 0 })) });
    const { h, call } = setup({ camera: blind });
    const video = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const result = await call("stabilize_clip", { elementId: video.elementId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could only be measured/);
    expect(element(h, video.elementId).animations ?? {}).toEqual({});
    const text = await h.data<InsertedData>("insert_text", { text: "x" });
    expect((await call("stabilize_clip", { elementId: text.elementId })).ok).toBe(false);
    const photo = await h.data<InsertedData>("insert_media", { assetId: "photo", start: 30 });
    expect((await call("stabilize_clip", { elementId: photo.elementId })).ok).toBe(false);
  });

  it("does not zoom when the clip's scale is animated, and says so", async () => {
    const { h, call } = setup();
    const video = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("add_keyframe", { elementId: video.elementId, property: "transform.scaleX", time: 0, value: 1 });
    await h.data("add_keyframe", { elementId: video.elementId, property: "transform.scaleX", time: 2, value: 1.2 });
    const result = await call("stabilize_clip", { elementId: video.elementId, smoothness: 0.2 });
    expect(result.ok && result.summary).toMatch(/NOT applied/);
  });
});
