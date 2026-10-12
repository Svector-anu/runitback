import { expect, test } from "@playwright/test";
import { callAgentTool, near, openCcHarness, rampColor, savePng, type Point, type Rgb } from "./cc-support";

test.use({ channel: "chrome" });

const RED: Rgb = [255, 0, 0];
const GRAY: Rgb = [128, 128, 128];
const BLACK: Rgb = [0, 0, 0];
const sample = (page: import("@playwright/test").Page, seconds: number, points: Point[]): Promise<Rgb[]> =>
  page.evaluate(({ seconds, points }) => window.__cc.renderAt(seconds, points), { seconds, points });
const shot = (page: import("@playwright/test").Page, name: string, seconds: number): Promise<void> =>
  page.evaluate((s) => window.__cc.pngAt(s), seconds).then((url) => savePng(name, url));

test("crop removes the chosen sides, leaves the rest in place, and applies before the transform", async ({ page }) => {
  await openCcHarness(page, [{ color: "#000000", seconds: 3, pattern: "bands" }]);
  const probes: Point[] = [[40, 90], [120, 90], [200, 90], [280, 90]];
  const [r, g, b, gray] = (await sample(page, 1, probes)) as Rgb[];
  expect(near(r!, RED) && near(gray!, GRAY, 12)).toBe(true);
  expect(g![1]).toBeGreaterThan(200);
  expect(b![2]).toBeGreaterThan(200);

  expect((await callAgentTool(page, "set_crop", { elementIds: ["clip-0"], left: 0.5 })).ok).toBe(true);
  const [r2, g2, b2, gray2] = (await sample(page, 1, probes)) as Rgb[];
  expect(near(r2!, BLACK, 12) && near(g2!, BLACK, 12)).toBe(true);
  expect(b2![2]).toBeGreaterThan(200);
  expect(near(gray2!, GRAY, 12)).toBe(true);
  await shot(page, "crop-left-half", 1);

  await callAgentTool(page, "set_crop", { elementIds: ["clip-0"], reset: true, top: 0.5 });
  const [top, bottom] = (await sample(page, 1, [[40, 30], [40, 150]])) as Rgb[];
  expect(near(top!, BLACK, 12)).toBe(true);
  expect(near(bottom!, RED)).toBe(true);

  await callAgentTool(page, "set_crop", { elementIds: ["clip-0"], reset: true, left: 0.5 });
  await callAgentTool(page, "set_params", { elementId: "clip-0", params: { "transform.scaleX": 2, "transform.scaleY": 2 } });
  const [scaled] = (await sample(page, 1, [[20, 90]])) as Rgb[];
  expect(near(scaled!, BLACK, 12)).toBe(true);
  const [scaledBlue, scaledFarBlue, left] = (await sample(page, 1, [[170, 90], [300, 90], [100, 90]])) as Rgb[];
  expect(scaledBlue![2]).toBeGreaterThan(200);
  expect(scaledFarBlue![2]).toBeGreaterThan(200);
  expect(near(left!, BLACK, 12)).toBe(true);
  await shot(page, "crop-left-half-scaled", 1);
});

test("freeze frame holds one source frame, moves the rest later, and export shows the same", async ({ page }) => {
  await openCcHarness(page, [{ color: "#000000", seconds: 4, pattern: "ramp" }]);
  const centre: Point[] = [[160, 90]];
  const live = (await sample(page, 1, centre))[0] as Rgb;
  expect(near(live, rampColor(1), 40)).toBe(true);

  const result = await callAgentTool(page, "freeze_frame", { elementId: "clip-0", at: 1, duration: 2 });
  expect(result.ok, result.error).toBe(true);
  const frozen = await Promise.all([1.0, 1.9, 2.8].map(async (t) => (await sample(page, t, centre))[0] as Rgb));
  for (const px of frozen) expect(near(px, live, 40)).toBe(true);
  await shot(page, "freeze-frame-held", 2);

  const resumed = (await sample(page, 3.5, centre))[0] as Rgb;
  expect(near(resumed, rampColor(1.5), 40)).toBe(true);
  expect(near(resumed, live, 20)).toBe(false);

  const out = await page.evaluate(() => window.__cc.exportAt({ times: [1.5, 2.5, 4], points: [[160, 90]] }));
  expect(out.durationSeconds).toBeCloseTo(6, 1);
  expect(near(out.samples[0]![0] as Rgb, rampColor(1), 50)).toBe(true);
  expect(near(out.samples[1]![0] as Rgb, rampColor(1), 50)).toBe(true);
  expect(near(out.samples[2]![0] as Rgb, rampColor(2), 50)).toBe(true);
});
