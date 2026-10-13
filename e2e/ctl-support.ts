import { expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { importGenerated, mediabunnyModuleUrl } from "./media";

export type Rgb = [number, number, number];

export const CTL_ARTIFACTS = "e2e/.artifacts/ctl";

export interface CtlClip { name: string; color: string; seconds: number; pattern?: "bands" | "ramp" }

/** Builds a static-colour WebM in the page (real VP9 encode) and queues it for `importGenerated`. */
async function makeStaticWebm(page: Page, clip: CtlClip): Promise<void> {
  const url = await mediabunnyModuleUrl(page);
  await page.evaluate(async ({ clip, url }) => {
    const { Output, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_HIGH } = (await import(url)) as typeof import("mediabunny");
    const W = 320, H = 180;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const video = new CanvasSource(canvas, { codec: "vp9", bitrate: QUALITY_HIGH });
    output.addVideoTrack(video, { frameRate: 30 });
    await output.start();
    for (let i = 0; i < Math.round(clip.seconds * 30); i++) {
      ctx.fillStyle = clip.pattern === "ramp" ? `hsl(${(i * 3) % 360} 85% 50%)` : clip.color;
      ctx.fillRect(0, 0, W, H);
      if (clip.pattern === "bands") {
        ["#ff0000", "#00ff00", "#0000ff", "#808080"].forEach((c, band) => { ctx.fillStyle = c; ctx.fillRect(band * (W / 4), 0, W / 4, H); });
      }
      await video.add(i / 30, 1 / 30);
    }
    await output.finalize();
    const file = new File([(output.target as InstanceType<typeof BufferTarget>).buffer as ArrayBuffer], clip.name, { type: "video/webm" });
    (window as unknown as { __files?: File[] }).__files = [...((window as unknown as { __files?: File[] }).__files ?? []), file];
  }, { clip, url });
}

/** New project in the real editor with the given clips imported and added back to back on the main track. */
export async function openEditorWithClips(page: Page, clips: CtlClip[]): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  for (const clip of clips) await makeStaticWebm(page, clip);
  await importGenerated(page);
  for (const clip of clips) await expect(page.getByRole("button", { name: `Add ${clip.name} to timeline` })).toBeVisible({ timeout: 30_000 });
  let at = 0;
  for (const [index, clip] of clips.entries()) {
    await seekSeconds(page, at);
    at += clip.seconds;
    await page.getByRole("button", { name: `Add ${clip.name} to timeline` }).click({ force: true });
    await expect(page.locator("[data-clip-id]")).toHaveCount(index + 1);
    await expect(page.locator("[data-clip-id]").filter({ hasText: clip.name })).toHaveCount(1);
  }
  await expect(page.locator("[data-clip-id]")).toHaveCount(clips.length);
}

export const clipAt = (page: Page, index: number): Locator => page.locator("[data-clip-id]").nth(index);

export async function selectClip(page: Page, index: number): Promise<void> {
  await clipAt(page, index).click();
  await expect(clipAt(page, index)).toHaveAttribute("data-selected", "true");
}

export async function openPropertyTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tablist", { name: "Property tabs" }).getByRole("tab", { name, exact: true }).click();
  await expect(page.locator(".properties").getByRole("tabpanel", { name })).toBeVisible();
}

/** Samples the live preview canvas at fractional positions (0-1) of its width and height. */
export function previewPixels(page: Page, points: Array<[number, number]>): Promise<Rgb[]> {
  return page.evaluate((pts) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
    if (!canvas) throw new Error("no preview canvas");
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    return pts.map(([fx, fy]) => {
      const d = ctx.getImageData(Math.floor(fx * (canvas.width - 1)), Math.floor(fy * (canvas.height - 1)), 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as Rgb;
    });
  }, points);
}

/** Counts preview pixels where `test(r, g, b)` holds (the predicate is serialised into the page). */
export function countPreviewPixels(page: Page, predicate: string): Promise<number> {
  return page.evaluate((source) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
    if (!canvas) throw new Error("no preview canvas");
    const test = new Function("r", "g", "b", `return (${source});`) as (r: number, g: number, b: number) => boolean;
    const data = (canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (test(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)) n++;
    return n;
  }, predicate);
}

export async function seekSeconds(page: Page, seconds: number): Promise<void> {
  await page.evaluate(async (s) => {
    const url = "/src/app/services.ts";
    const { getServices } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/services");
    getServices().editor.playback.seek(Math.round(s * 120_000));
  }, seconds);
}

export async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  mkdirSync(CTL_ARTIFACTS, { recursive: true });
  const path = `${CTL_ARTIFACTS}/${name}.png`;
  if (target) await target.screenshot({ path });
  else await page.screenshot({ path });
}

/** Sets a range slider the way a user ends a drag: input events while moving, one change on release. */
export async function setSlider(page: Page, name: string, value: number): Promise<void> {
  await page.getByRole("slider", { name }).fill(String(value));
}

/** Reads the project document from the running editor. */
export function readElements(page: Page): Promise<Array<{ id: string; type: string; startTime: number; duration: number; params: Record<string, unknown>; effects?: Array<{ type: string; params: Record<string, number> }>; transition?: { type: string; duration: number }; textAnimation?: Record<string, { preset: string; duration: number }>; animations?: Record<string, unknown> }>> {
  return page.evaluate(async () => {
    const services = "/src/app/services.ts";
    const commands = "/src/engine/commands/index.ts";
    const timeline = "/src/engine/timeline/index.ts";
    const { getServices } = (await import(/* @vite-ignore */ services)) as typeof import("../src/app/services");
    const { currentScene } = (await import(/* @vite-ignore */ commands)) as typeof import("../src/engine/commands");
    const { allElements } = (await import(/* @vite-ignore */ timeline)) as typeof import("../src/engine/timeline");
    const tracks = currentScene(getServices().editor.getState().doc).tracks;
    return allElements(tracks).map((l) => l.element) as never;
  });
}

/** Undo with the keyboard, after leaving any field so the shortcut is not suspended for typing. */
export async function undo(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+z");
}

export const spread = (c: Rgb): number => Math.max(...c) - Math.min(...c);
