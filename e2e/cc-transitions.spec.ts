import { expect, test } from "@playwright/test";
import { near, openCcHarness, savePng, type Point, type Rgb } from "./cc-support";

test.use({ channel: "chrome" });

const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const BLACK: Rgb = [0, 0, 0];
const LEFT: Point = [80, 90];
const RIGHT: Point = [240, 90];
const CENTER: Point = [160, 90];
const CORNER: Point = [3, 3];

test.beforeEach(async ({ page }) => {
  await openCcHarness(page, [{ color: "#ff0000", seconds: 4 }, { color: "#0000ff", seconds: 4 }]);
});

async function setTransition(page: import("@playwright/test").Page, type: string, seconds: number): Promise<void> {
  await page.evaluate(({ type, seconds }) => {
    const { editor, mods } = window.__cc;
    editor.execute(mods.commands.setTransitionCommand({
      ref: { trackId: editor.tracks().main.id, elementId: "clip-1" },
      transition: { type: type as never, duration: mods.time.mediaTimeFromSeconds(seconds) },
    }));
  }, { type, seconds });
}

const sample = (page: import("@playwright/test").Page, seconds: number, points: Point[]): Promise<Rgb[]> =>
  page.evaluate(({ seconds, points }) => window.__cc.renderAt(seconds, points), { seconds, points });
const shot = (page: import("@playwright/test").Page, name: string, seconds: number): Promise<void> =>
  page.evaluate((seconds) => window.__cc.pngAt(seconds), seconds).then((url) => savePng(name, url));

test("without a transition the cut is hard", async ({ page }) => {
  expect(near((await sample(page, 3.9, [CENTER]))[0] as Rgb, RED)).toBe(true);
  expect(near((await sample(page, 4.1, [CENTER]))[0] as Rgb, BLUE)).toBe(true);
});

test("cross dissolve blends red into blue across a window centred on the cut", async ({ page }) => {
  await setTransition(page, "dissolve", 1);
  expect(near((await sample(page, 3.4, [CENTER]))[0] as Rgb, RED)).toBe(true);
  const [start] = await sample(page, 3.55, [CENTER]);
  expect(start![0]).toBeGreaterThan(200);
  const [mid] = await sample(page, 4.0, [CENTER]);
  expect(near(mid as Rgb, [127, 0, 127], 35)).toBe(true);
  const [late] = await sample(page, 4.4, [CENTER]);
  expect(late![2]).toBeGreaterThan(200);
  expect(near((await sample(page, 4.6, [CENTER]))[0] as Rgb, BLUE)).toBe(true);
  await shot(page, "transition-dissolve-mid", 4.0);
});

test("slide-left pushes the red clip out to the left", async ({ page }) => {
  await setTransition(page, "slide-left", 1);
  const [l, r] = await sample(page, 4.0, [LEFT, RIGHT]);
  expect(near(l as Rgb, RED)).toBe(true);
  expect(near(r as Rgb, BLUE)).toBe(true);
  await shot(page, "transition-slide-left-mid", 4.0);
});

test("slide-right is the mirror image", async ({ page }) => {
  await setTransition(page, "slide-right", 1);
  const [l, r] = await sample(page, 4.0, [LEFT, RIGHT]);
  expect(near(l as Rgb, BLUE)).toBe(true);
  expect(near(r as Rgb, RED)).toBe(true);
});

test("wipe-left reveals blue from the right edge, wipe-right from the left", async ({ page }) => {
  await setTransition(page, "wipe-left", 1);
  let [l, r] = await sample(page, 4.0, [LEFT, RIGHT]);
  expect(near(l as Rgb, RED)).toBe(true);
  expect(near(r as Rgb, BLUE)).toBe(true);
  await shot(page, "transition-wipe-left-mid", 4.0);
  await setTransition(page, "wipe-right", 1);
  [l, r] = await sample(page, 4.0, [LEFT, RIGHT]);
  expect(near(l as Rgb, BLUE)).toBe(true);
  expect(near(r as Rgb, RED)).toBe(true);
});

test("fade through black goes dark at the cut", async ({ page }) => {
  await setTransition(page, "fade-black", 1);
  const [early] = await sample(page, 3.7, [CENTER]);
  expect(early![0]).toBeLessThan(230);
  expect(early![0]).toBeGreaterThan(30);
  expect(near((await sample(page, 4.0, [CENTER]))[0] as Rgb, BLACK, 20)).toBe(true);
  const [late] = await sample(page, 4.3, [CENTER]);
  expect(late![2]).toBeGreaterThan(30);
  expect(late![2]).toBeLessThan(230);
  await shot(page, "transition-fade-black-mid", 4.0);
});

test("zoom grows the incoming clip while the outgoing one scales up", async ({ page }) => {
  await setTransition(page, "zoom", 1);
  const [centre, corner] = await sample(page, 4.0, [CENTER, CORNER]);
  expect(near(centre as Rgb, [127, 0, 127], 35)).toBe(true);
  expect(near(corner as Rgb, RED)).toBe(true);
  await shot(page, "transition-zoom-mid", 4.0);
});

test("export decodes the same blend as the preview, with unchanged length", async ({ page }) => {
  await setTransition(page, "dissolve", 1);
  const out = await page.evaluate(() => window.__cc.exportAt({ times: [2, 4.0, 6], points: [[160, 90]] }));
  expect(out.durationSeconds).toBeCloseTo(8, 1);
  const [a, mid, b] = out.samples.map((s) => s[0] as Rgb);
  expect(near(a as Rgb, RED, 40)).toBe(true);
  expect(near(mid as Rgb, [127, 0, 127], 50)).toBe(true);
  expect(near(b as Rgb, BLUE, 40)).toBe(true);
});
