import { expect, test, type Page } from "@playwright/test";
import { callAgentTool, decodeFrameId, frameIdPoints, openVfxHarness, type Rgb } from "./vfx-support";

test.use({ channel: "chrome" });

const FPS = 30;
const CLIP_SECONDS = 6;

/** Frame index the source should show at timeline second `t`, from the same mapping the engine uses. */
const expectedFrameAt = (page: Page, t: number): Promise<number> =>
  page.evaluate((seconds) => {
    const { editor, mods } = window.__vfx;
    const el = editor.tracks().main.elements[0] as import("../src/engine/model").VideoElement;
    const source = mods.timeline.sourceTimeAt({ trimStart: el.trimStart, clipTime: Math.round(seconds * 120_000), retime: el.retime });
    return Math.floor((source / 120_000) * 30 + 1e-6);
  }, t);

async function previewFrameId(page: Page, t: number): Promise<number> {
  const samples = await page.evaluate(({ t, points }) => window.__vfx.renderAt(t, points), { t, points: frameIdPoints() });
  return decodeFrameId(samples as Rgb[]);
}

test.beforeEach(async ({ page }) => {
  await openVfxHarness(page, [{ color: "#000000", seconds: CLIP_SECONDS, pattern: "frameid", fps: FPS }]);
});

test("without a ramp the frame id equals clip time x fps (sanity of the fixture)", async ({ page }) => {
  for (const t of [0, 1, 2.5, 5.9]) expect(Math.abs((await previewFrameId(page, t)) - Math.floor(t * FPS))).toBeLessThanOrEqual(1);
});

test("hero ramp: the preview shows the source frame the curve says, across the whole clip", async ({ page }) => {
  const r = await callAgentTool(page, "set_speed_ramp", { elementId: "clip-0", preset: "hero" });
  expect(r.ok, r.error).toBe(true);
  const duration = await page.evaluate(() => window.__vfx.editor.tracks().main.elements[0]!.duration / 120_000);
  expect(duration).toBeGreaterThan(CLIP_SECONDS + 0.4);
  const slowFrames: number[] = [];
  let previous = -1;
  for (let t = 0.05; t < duration - 0.1; t += 0.23) {
    const actual = await previewFrameId(page, t);
    const expected = await expectedFrameAt(page, t);
    expect(Math.abs(actual - expected), `t=${t.toFixed(2)} expected ${expected} got ${actual}`).toBeLessThanOrEqual(1);
    expect(actual).toBeGreaterThanOrEqual(previous);
    previous = actual;
    slowFrames.push(actual);
  }
  const steps = slowFrames.slice(1).map((v, i) => v - (slowFrames[i] as number));
  expect(Math.min(...steps)).toBeLessThanOrEqual(3);
  expect(Math.max(...steps)).toBeGreaterThan(Math.min(...steps));
});

test("decoded export of a ramped clip: length equals the integral and frames follow the curve", async ({ page }) => {
  await callAgentTool(page, "set_speed_ramp", { elementId: "clip-0", points: [{ position: 0, speed: 2 }, { position: 0.4, speed: 2 }, { position: 0.5, speed: 0.25 }, { position: 0.6, speed: 2 }, { position: 1, speed: 2 }] });
  const integral = await page.evaluate(() => {
    const { editor, mods } = window.__vfx;
    const el = editor.tracks().main.elements[0] as import("../src/engine/model").VideoElement;
    const curve = el.retime!.curve!;
    return (mods.timeline.curveTime(curve, el.trimStart + (el.sourceDuration! - el.trimStart - el.trimEnd)) - mods.timeline.curveTime(curve, el.trimStart)) / 120_000;
  });
  const times = [0.2, 0.9, 1.6, 2.2, 2.6, 3.2, 3.8].filter((t) => t < integral - 0.1);
  const out = await page.evaluate(({ times, points }) => window.__vfx.exportAt({ times, points }), { times, points: frameIdPoints() });
  expect(Math.abs(out.durationSeconds - integral)).toBeLessThanOrEqual(1 / FPS + 0.02);
  expect(Math.abs(out.frames - Math.round(integral * FPS))).toBeLessThanOrEqual(1);
  for (const [i, t] of times.entries()) {
    const actual = decodeFrameId(out.samples[i] as Rgb[]);
    const expected = await expectedFrameAt(page, t);
    expect(Math.abs(actual - expected), `export t=${t} expected ${expected} got ${actual}`).toBeLessThanOrEqual(2);
  }
});

test("a split ramp plays through the cut without a jump", async ({ page }) => {
  await callAgentTool(page, "set_speed_ramp", { elementId: "clip-0", preset: "montage" });
  const cutAt = await page.evaluate(() => window.__vfx.editor.tracks().main.elements[0]!.duration / 120_000 * 0.4);
  const split = await callAgentTool(page, "split", { elementIds: ["clip-0"], at: cutAt });
  expect(split.ok, split.error).toBe(true);
  const frames: number[] = [];
  for (const dt of [-0.12, -0.06, -0.02, 0.02, 0.06, 0.12]) frames.push(await previewFrameId(page, cutAt + dt));
  for (let i = 1; i < frames.length; i++) {
    const step = (frames[i] as number) - (frames[i - 1] as number);
    expect(step, `frames around the cut ${frames.join(",")}`).toBeGreaterThanOrEqual(0);
    expect(step).toBeLessThanOrEqual(12);
  }
  const total = await page.evaluate(() => window.__vfx.editor.tracks().main.elements.reduce((n, e) => n + e.duration, 0) / 120_000);
  expect(total).toBeGreaterThan(0);
});


/** Dominant frequency of a mono window by counting rising zero crossings. */
function frequencyOf(samples: Float32Array, sampleRate: number, fromSeconds: number, toSeconds: number): number {
  const a = Math.floor(fromSeconds * sampleRate), b = Math.min(samples.length, Math.floor(toSeconds * sampleRate));
  let crossings = 0;
  for (let i = a + 1; i < b; i++) if ((samples[i - 1] as number) < 0 && (samples[i] as number) >= 0) crossings++;
  return crossings / (toSeconds - fromSeconds);
}

test.describe("audio follows the ramp", () => {
  test("exported soundtrack of a ramped clip is as long as the picture and keeps its pitch with Change pitch off", async ({ page }) => {
    await openVfxHarness(page, [{ color: "#000000", seconds: 6, pattern: "frameid", fps: 30, audio: true }]);
    const r = await callAgentTool(page, "set_speed_ramp", { elementId: "clip-0", preset: "hero", maintainPitch: true });
    expect(r.ok, r.error).toBe(true);
    const out = await page.evaluate(() => window.__vfx.exportAudio());
    expect(out.audioSeconds).toBeGreaterThan(0);
    expect(Math.abs(out.audioSeconds - out.durationSeconds)).toBeLessThan(0.15);
    expect(out.durationSeconds).toBeGreaterThan(6.4);
    let energy = 0;
    for (const v of out.samples) energy += v * v;
    expect(Math.sqrt(energy / out.samples.length)).toBeGreaterThan(0.1);
    const slowMoment = out.durationSeconds * 0.5;
    const pitch = frequencyOf(out.samples, out.sampleRate, slowMoment - 0.15, slowMoment + 0.15);
    const start = frequencyOf(out.samples, out.sampleRate, 0.3, 0.6);
    console.log("AUDIO pitch at start", start.toFixed(0), "Hz; at the slow moment", pitch.toFixed(0), "Hz; length", out.audioSeconds.toFixed(2), "s vs picture", out.durationSeconds.toFixed(2), "s");
    expect(Math.abs(start - 440)).toBeLessThan(30);
    expect(Math.abs(pitch - 440)).toBeLessThan(60);
  });

  test("with Change pitch on, the slow part is lower in pitch (it follows the curve)", async ({ page }) => {
    await openVfxHarness(page, [{ color: "#000000", seconds: 6, pattern: "frameid", fps: 30, audio: true }]);
    await callAgentTool(page, "set_speed_ramp", { elementId: "clip-0", preset: "hero", maintainPitch: false });
    const out = await page.evaluate(() => window.__vfx.exportAudio());
    const slowMoment = out.durationSeconds * 0.5;
    const pitch = frequencyOf(out.samples, out.sampleRate, slowMoment - 0.1, slowMoment + 0.1);
    console.log("AUDIO (pitch changes) at the slow moment", pitch.toFixed(0), "Hz");
    expect(pitch).toBeLessThan(300);
  });
});
