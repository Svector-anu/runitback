import { expect, test, type Page } from "@playwright/test";
import { importGenerated, mediabunnyModuleUrl } from "./media";

test.use({ channel: "chrome" });
test.setTimeout(180_000);

type Pattern = "greenscreen" | "frameid" | "texture";

async function makeClip(page: Page, name: string, pattern: Pattern, seconds: number): Promise<void> {
  const url = await mediabunnyModuleUrl(page);
  await page.evaluate(async ({ name, pattern, seconds, url }) => {
    const mb = (await import(/* @vite-ignore */ url)) as typeof import("mediabunny");
    const W = 320, H = 180, FPS = 30;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
    const video = new mb.CanvasSource(canvas, { codec: "vp9", bitrate: 12_000_000 });
    output.addVideoTrack(video, { frameRate: FPS });
    await output.start();
    let world: OffscreenCanvas | null = null;
    const PAD = 80;
    if (pattern === "texture") {
      world = new OffscreenCanvas(W + 2 * PAD, H + 2 * PAD);
      const wctx = world.getContext("2d") as OffscreenCanvasRenderingContext2D;
      wctx.fillStyle = "#808080"; wctx.fillRect(0, 0, world.width, world.height);
      let state = 12345;
      const rnd = (): number => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
      for (let b = 0; b < 700; b++) {
        const x = rnd() * world.width, y = rnd() * world.height, r = 2 + rnd() * 5, v = rnd() < 0.5 ? 0 : 255;
        const g = wctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${v},${v},${v},0.95)`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
        wctx.fillStyle = g; wctx.fillRect(x - r, y - r, 2 * r, 2 * r);
      }
    }
    let jitterState = 777;
    const jitter = (): number => { jitterState = (jitterState * 1664525 + 1013904223) % 4294967296; return (jitterState / 4294967296 - 0.5) * 12; };
    for (let i = 0; i < Math.round(seconds * FPS); i++) {
      if (pattern === "texture" && world) {
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(world, 0.25 * i + jitter() - PAD, 0.05 * i + jitter() - PAD);
      } else if (pattern === "greenscreen") {
        ctx.fillStyle = "#00ff00"; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#c83232"; ctx.fillRect(110, 40, 100, 100);
      } else {
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = "#fff";
        for (let bit = 0; bit < 10; bit++) if ((i >> bit) & 1) ctx.fillRect(bit * 32, 0, 32, H);
      }
      await video.add(i / FPS, 1 / FPS);
    }
    await output.finalize();
    const file = new File([(output.target as InstanceType<typeof mb.BufferTarget>).buffer as ArrayBuffer], name, { type: "video/webm" });
    (window as unknown as { __files?: File[] }).__files = [...((window as unknown as { __files?: File[] }).__files ?? []), file];
  }, { name, pattern, seconds, url });
}

async function openEditor(page: Page, name: string, pattern: Pattern, seconds: number): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeClip(page, name, pattern, seconds);
  await importGenerated(page);
  await page.getByRole("button", { name: `Add ${name} to timeline` }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1, { timeout: 30_000 });
  await page.locator("[data-clip-id]").first().click();
}

const clipState = (page: Page): Promise<{ duration: number; retime?: { rate: number; curve?: { points: Array<{ at: number; rate: number }> } }; effects?: Array<{ type: string; params: Record<string, unknown> }> }> =>
  page.evaluate(async () => {
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const { getServices } = await load<typeof import("../src/app/services")>("/src/app/services.ts");
    const { currentScene } = await load<typeof import("../src/engine/commands")>("/src/engine/commands/index.ts");
    const { allElements } = await load<typeof import("../src/engine/timeline")>("/src/engine/timeline/index.ts");
    return allElements(currentScene(getServices().editor.getState().doc).tracks)[0]?.element as never;
  });

const tab = (page: Page, name: string) => page.getByRole("tablist", { name: "Property tabs" }).getByRole("tab", { name, exact: true });

const previewAt = (page: Page, points: Array<[number, number]>): Promise<Array<[number, number, number]>> =>
  page.evaluate((pts) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview__scene canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    return pts.map(([fx, fy]) => { const d = ctx.getImageData(Math.floor(fx * (canvas.width - 1)), Math.floor(fy * (canvas.height - 1)), 1, 1).data; return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as [number, number, number]; });
  }, points);

const isMagenta = (c: [number, number, number]): boolean => c[0] > 200 && c[1] < 60 && c[2] > 200;

test("chroma key in the real editor: add from Effects, eyedropper picks the screen colour from the preview", async ({ page }) => {
  await openEditor(page, "green.webm", "greenscreen", 3);
  await page.evaluate(async () => {
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const { getServices } = await load<typeof import("../src/app/services")>("/src/app/services.ts");
    const commands = await load<typeof import("../src/engine/commands")>("/src/engine/commands/index.ts");
    getServices().editor.execute(commands.updateSettings({ background: { type: "color", color: "#ff00ff" } }));
  });
  const corners: Array<[number, number]> = [[0.04, 0.05], [0.95, 0.05], [0.05, 0.95], [0.95, 0.95]];
  await expect.poll(async () => (await previewAt(page, corners)).filter((c) => c[1] > 200 && c[0] < 40).length).toBe(4);

  await tab(page, "Effects").click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("menuitem", { name: "Chroma key" }).click();
  await expect.poll(async () => (await previewAt(page, corners)).filter(isMagenta).length).toBe(4);

  const keyField = page.getByRole("textbox", { name: "Key colour", exact: true });
  await keyField.fill("#ff0000");
  await keyField.press("Enter");
  await expect.poll(async () => (await previewAt(page, corners)).filter((c) => c[1] > 200).length).toBe(4);

  await page.getByRole("button", { name: /Pick from preview/ }).click();
  await expect(page.getByTestId("color-pick-capture")).toBeVisible();
  const box = await page.locator(".preview__scene canvas").boundingBox();
  if (!box) throw new Error("no preview canvas");
  await page.mouse.click(box.x + box.width * 0.06, box.y + box.height * 0.08);
  await expect(page.getByTestId("color-pick-capture")).toHaveCount(0);
  await expect.poll(async () => (await clipState(page)).effects?.[0]?.params.keyColor).toMatch(/^#0[0-9a-f]ff0[0-9a-f]$|^#00[ef][0-9a-f]00$|^#0[0-9a-f]f[0-9a-f]0[0-9a-f]$/);
  await expect.poll(async () => (await previewAt(page, corners)).filter(isMagenta).length).toBe(4);
  const [subject] = await previewAt(page, [[0.5, 0.5]]);
  expect(subject?.[0]).toBeGreaterThan(150);
  expect(subject?.[1]).toBeLessThan(110);
  await page.locator(".preview__scene canvas").screenshot({ path: "e2e/.artifacts/vfx/ui-chroma.png" });

  await page.getByRole("button", { name: /Pick from preview/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("color-pick-capture")).toHaveCount(0);
});

test("speed curve editor in the real editor: presets, dragging a point, deleting it, reset, undo", async ({ page }) => {
  await openEditor(page, "ids.webm", "frameid", 6);
  const initial = await clipState(page);
  await tab(page, "Speed").click();

  await page.getByRole("button", { name: "Hero time" }).click();
  await expect(page.getByRole("button", { name: "Hero time" })).toHaveAttribute("aria-pressed", "true");
  const hero = await clipState(page);
  expect(hero.retime?.curve?.points).toHaveLength(5);
  expect(hero.duration).toBeGreaterThan(initial.duration);

  const svg = page.getByTestId("speed-curve");
  const point = page.getByTestId("speed-point-2");
  await svg.scrollIntoViewIfNeeded();
  const p = await point.boundingBox();
  const s = await svg.boundingBox();
  if (!p || !s) throw new Error("curve editor not laid out");
  await page.mouse.move(p.x + p.width / 2, p.y + p.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width / 2, s.y + s.height * 0.12, { steps: 6 });
  await page.mouse.up();
  const dragged = await clipState(page);
  const centre = dragged.retime?.curve?.points[2];
  expect(centre?.rate).toBeGreaterThan(2);
  expect(dragged.duration).toBeLessThan(hero.duration);

  await point.focus();
  await page.keyboard.press("Delete");
  expect((await clipState(page)).retime?.curve?.points).toHaveLength(4);

  await page.getByRole("button", { name: "Reset to 1x" }).click();
  const reset = await clipState(page);
  expect(reset.retime).toBeUndefined();
  expect(reset.duration).toBe(initial.duration);

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("ControlOrMeta+z");
  expect((await clipState(page)).retime?.curve?.points).toHaveLength(4);
  await page.locator(".properties").screenshot({ path: "e2e/.artifacts/vfx/ui-speed-curve.png" });
});

test("Motion tab in the real editor: Stabilize runs with progress, and a text clip follows a point picked in the preview", async ({ page }) => {
  await openEditor(page, "shaky.webm", "texture", 3);
  await tab(page, "Motion").click();
  await page.getByRole("button", { name: "Stabilize clip" }).click();
  await expect.poll(async () => Object.keys((await clipState(page) as { animations?: object }).animations ?? {}).length, { timeout: 60_000 }).toBe(2);
  const stabilised = await clipState(page) as unknown as { params: Record<string, number> };
  expect(stabilised.params["transform.scaleX"]).toBeGreaterThan(1);

  await page.evaluate(async () => {
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const { getServices } = await load<typeof import("../src/app/services")>("/src/app/services.ts");
    const agent = await load<typeof import("../src/engine/agent")>("/src/engine/agent/index.ts");
    const result = await agent.callTool({ tools: agent.createAgentTools(), name: "insert_text", args: { text: "follow me", start: 0, duration: 3 }, ctx: { editor: getServices().editor, nowMs: () => 0 } });
    if (!result.ok) throw new Error(result.error);
  });
  await page.locator("[data-clip-id]").filter({ hasText: "follow me" }).first().click();
  await tab(page, "Motion").click();
  await page.getByRole("button", { name: "Pick a point in the preview" }).click();
  await expect(page.getByTestId("point-pick-capture")).toBeVisible();
  const box = await page.locator(".preview__scene canvas").boundingBox();
  if (!box) throw new Error("no preview canvas");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.getByTestId("point-pick-capture")).toHaveCount(0);
  await expect.poll(async () => {
    const text = await page.evaluate(async () => {
      const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
      const { getServices } = await load<typeof import("../src/app/services")>("/src/app/services.ts");
      const { currentScene } = await load<typeof import("../src/engine/commands")>("/src/engine/commands/index.ts");
      const { allElements } = await load<typeof import("../src/engine/timeline")>("/src/engine/timeline/index.ts");
      const el = allElements(currentScene(getServices().editor.getState().doc).tracks).find((l) => l.element.type === "text")?.element;
      return Object.keys(el?.animations ?? {});
    });
    return text.sort().join(",");
  }, { timeout: 60_000 }).toBe("transform.positionX,transform.positionY");
  await page.locator(".properties").screenshot({ path: "e2e/.artifacts/vfx/ui-motion.png" });
});
