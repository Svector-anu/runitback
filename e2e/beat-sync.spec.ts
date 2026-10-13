import { expect, test, type Page } from "@playwright/test";
import { clickTrack, importWav } from "./audio-support";
import { importGenerated, makeWebm } from "./media";

const TICKS = 120_000;
const BPM = 100;
const PHASE = 0.15;
const OFF_BEAT_CUTS = [2.05, 4.45, 6.85, 8.65];

interface Clip { id: string; start: number; duration: number; trimStart: number; trimEnd: number }

async function setup(page: Page): Promise<number[]> {
  const track = clickTrack({ bpm: BPM, phase: PHASE, seconds: 10 });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeWebm(page, { seconds: 10, hue: 20, name: "footage.webm" });
  await importGenerated(page);
  await importWav(page, { name: "track.wav", samples: track.samples, sampleRate: track.sampleRate });
  await page.getByRole("button", { name: "Add footage.webm to timeline" }).click({ force: true });
  await page.getByRole("button", { name: "Add track.wav to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(2);
  return track.beats;
}

/** Splits the main-track clip at each time through the same command the Split button runs. */
async function splitAt(page: Page, seconds: number[]): Promise<void> {
  await page.evaluate(async (times) => {
    const url = "/src/app/services.ts";
    const { getServices } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/services");
    const cmdUrl = "/src/engine/commands/index.ts";
    const { splitCommand, currentScene } = (await import(/* @vite-ignore */ cmdUrl)) as typeof import("../src/engine/commands");
    const { editor } = getServices();
    for (const t of times) {
      const main = currentScene(editor.getState().doc).tracks.main;
      const target = main.elements.find((e) => e.startTime < t * 120_000 && e.startTime + e.duration > t * 120_000);
      if (!target) throw new Error(`no clip at ${t}`);
      editor.execute(splitCommand({ refs: [{ trackId: main.id, elementId: target.id }], splitTime: Math.round(t * 120_000) }));
    }
    editor.setSelection({ elements: [], keyframes: [], keyframeAnchor: null });
  }, seconds);
}

async function mainClips(page: Page): Promise<Clip[]> {
  return page.evaluate(async () => {
    const url = "/src/app/services.ts";
    const { getServices } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/services");
    const cmdUrl = "/src/engine/commands/index.ts";
    const { currentScene } = (await import(/* @vite-ignore */ cmdUrl)) as typeof import("../src/engine/commands");
    const main = currentScene(getServices().editor.getState().doc).tracks.main;
    return [...main.elements].sort((a, b) => a.startTime - b.startTime).map((e) => ({ id: e.id, start: e.startTime, duration: e.duration, trimStart: e.trimStart, trimEnd: e.trimEnd }));
  });
}

const cutsOf = (clips: Clip[]): number[] => clips.slice(1).map((c) => c.start / TICKS);
const distanceToBeat = (cut: number, beats: number[]): number => Math.min(...beats.map((b) => Math.abs(b - cut)));

test("Snap cuts to beat moves every cut onto the detected beat, keeps length and source mapping, and is one undo step", async ({ page }) => {
  const beats = await setup(page);
  await splitAt(page, OFF_BEAT_CUTS);
  const before = await mainClips(page);
  expect(cutsOf(before)).toHaveLength(4);
  for (const cut of cutsOf(before)) expect(distanceToBeat(cut, beats)).toBeGreaterThan(0.08);
  const lengthBefore = (before.at(-1)?.start ?? 0) + (before.at(-1)?.duration ?? 0);

  await page.getByRole("button", { name: "Snap cuts to beat" }).click();
  await expect(page.getByText(/Snapped 4 of 4 cuts to the beat/)).toBeVisible({ timeout: 30_000 });

  const after = await mainClips(page);
  const worst = Math.max(...cutsOf(after).map((c) => distanceToBeat(c, beats)));
  console.info(`beat-sync: cuts ${cutsOf(before).map((c) => c.toFixed(3)).join(", ")} -> ${cutsOf(after).map((c) => c.toFixed(3)).join(", ")}; worst distance to a true beat ${(worst * 1000).toFixed(1)} ms`);
  expect(worst).toBeLessThanOrEqual(1 / 30 / 2 + 0.005);
  expect((after.at(-1)?.start ?? 0) + (after.at(-1)?.duration ?? 0)).toBe(lengthBefore);
  for (let i = 1; i < after.length; i++) {
    const a = after[i - 1] as Clip;
    const b = after[i] as Clip;
    expect(b.start).toBe(a.start + a.duration);
    expect(Math.abs(b.trimStart - (a.trimStart + a.duration))).toBeLessThanOrEqual(2);
  }
  expect(after.reduce((sum, c) => sum + c.trimEnd + c.trimStart + c.duration, 0) / after.length).toBeGreaterThan(0);

  await page.keyboard.press("ControlOrMeta+z");
  expect(cutsOf(await mainClips(page))).toEqual(cutsOf(before));
});

test("beat ticks on the ruler sit on the detected beats and follow the toggle and zoom", async ({ page }) => {
  const beats = await setup(page);
  await expect(page.getByTestId("ruler-beat")).toHaveCount(0);
  await page.getByRole("button", { name: /Show beats on the ruler/ }).click();
  await expect.poll(() => page.getByTestId("ruler-beat").count(), { timeout: 30_000 }).toBeGreaterThan(8);
  const lefts = await page.getByTestId("ruler-beat").evaluateAll((els) => els.map((e) => Number.parseFloat((e as HTMLElement).style.left)));
  const spacing = lefts.slice(1).map((x, i) => x - (lefts[i] as number));
  const zoomPxPerSecond = (lefts[1] as number) - (lefts[0] as number);
  const expectedPerBeat = zoomPxPerSecond;
  expect(Math.max(...spacing) - Math.min(...spacing)).toBeLessThan(1.5);
  const pxPerSecond = expectedPerBeat / (60 / BPM);
  expect(Math.abs((lefts[0] as number) / pxPerSecond - beats[0]!)).toBeLessThan(0.04);
  await page.getByRole("button", { name: /Hide beats on the ruler|Finding beats/ }).click();
  await expect(page.getByTestId("ruler-beat")).toHaveCount(0);
});
