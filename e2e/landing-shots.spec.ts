import { expect, test, type Page } from "@playwright/test";
import { mediabunnyModuleUrl } from "./media";

/**
 * Opt-in generator for the landing page product shots (`LANDING_SHOTS=1 pnpm exec playwright test landing-shots`).
 * It drives the real editor with procedurally drawn but really encoded footage and writes PNGs to
 * e2e/.artifacts/landing/shots; `docs/LANDING.md` explains the cwebp step that produces public/landing/*.webp.
 */
const OUT = "e2e/.artifacts/landing/shots";
const ENABLED = process.env.LANDING_SHOTS === "1";

interface Scene { sky: [string, string, string]; sun: [number, number]; hills: [string, string]; name: string }

const SCENES: Scene[] = [
  { name: "dunes.webm", sky: ["#2b3a67", "#e8836a", "#ffd9a0"], sun: [0.68, 0.62], hills: ["#5b3a4a", "#2a1c2b"] },
  { name: "coast.webm", sky: ["#2f6f9f", "#8ec5d6", "#f3e3c3"], sun: [0.3, 0.55], hills: ["#2f5d62", "#173a42"] },
  { name: "night-market.webm", sky: ["#0b1026", "#3a2a5c", "#c9658a"], sun: [0.5, 0.7], hills: ["#1c1633", "#0a0818"] },
];

async function makeScene(page: Page, scene: Scene): Promise<void> {
  const url = await mediabunnyModuleUrl(page);
  await page.evaluate(async ({ scene, url }) => {
    const { Output, WebMOutputFormat, BufferTarget, CanvasSource, QUALITY_MEDIUM } = (await import(url)) as typeof import("mediabunny");
    const W = 640, H = 360;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const video = new CanvasSource(canvas, { codec: "vp9", bitrate: QUALITY_MEDIUM });
    output.addVideoTrack(video, { frameRate: 30 });
    await output.start();
    const frames = 90;
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, scene.sky[0]); sky.addColorStop(0.55, scene.sky[1]); sky.addColorStop(1, scene.sky[2]);
      ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
      const sx = (scene.sun[0] + t * 0.06) * W, sy = scene.sun[1] * H;
      const glow = ctx.createRadialGradient(sx, sy, 4, sx, sy, 150);
      glow.addColorStop(0, "rgba(255,245,220,0.95)"); glow.addColorStop(0.2, "rgba(255,220,170,0.5)"); glow.addColorStop(1, "rgba(255,200,150,0)");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
      scene.hills.forEach((color, layer) => {
        ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 8) ctx.lineTo(x, H * (0.68 + layer * 0.12) - 34 * Math.sin(x / (110 - layer * 30) + layer * 2 + t * 1.5));
        ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      });
      await video.add(i / 30, 1 / 30);
    }
    await output.finalize();
    const file = new File([(output.target as InstanceType<typeof BufferTarget>).buffer as ArrayBuffer], scene.name, { type: "video/webm" });
    (window as unknown as { __files?: File[] }).__files = [...((window as unknown as { __files?: File[] }).__files ?? []), file];
  }, { scene, url });
}

async function setupEditor(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.addStyleTag({ content: ".toaster { display: none !important; }" });
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  for (const scene of SCENES) await makeScene(page, scene);
  await page.waitForSelector('input[aria-label="Import media files"]', { state: "attached" });
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Import media files"]');
    if (!input) throw new Error("import input not found");
    const dt = new DataTransfer();
    for (const f of (window as unknown as { __files: File[] }).__files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  for (const scene of SCENES) await expect(page.getByRole("button", { name: `Add ${scene.name} to timeline` })).toBeVisible({ timeout: 30_000 });
  for (const scene of SCENES) await page.getByRole("button", { name: `Add ${scene.name} to timeline` }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(3);
  await page.waitForTimeout(1200);
}

async function proposePlan(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByLabel("Anthropic API key").fill("sk-ant-demo-not-a-real-key");
  const settingsDone = page.getByTestId("agent-panel").getByRole("button", { name: "Done", exact: true });
  if (await settingsDone.count()) await settingsDone.click();
  await page.evaluate(async () => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    const plan = {
      summary: "Tighten the sequence to about six seconds and add a title over the first clip.",
      steps: [
        { intent: "Trim the tail of the first clip so the cut lands on the sunset.", tools: ["trim"], targets: ["clip 1 (0-3.0s)"], check: "Read the timeline back and confirm no gap." },
        { intent: "Add a short title over the opening.", tools: ["insert_text"], targets: ["overlay track, 0.2-2.2s"], check: "Render the frame at 1s and look at the title." },
        { intent: "Check the whole sequence once more before you export.", tools: ["get_timeline"], targets: [], check: "Total length is near six seconds." },
      ],
    };
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = new ScriptedModelClient([
      { content: [{ type: "tool_use", id: "p1", name: "propose_plan", input: plan }] },
    ]);
  });
  const panel = page.getByTestId("agent-panel");
  await panel.getByLabel("Message to the agent").fill("Tighten this to six seconds and add a title");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByTestId("agent-plan")).toBeVisible({ timeout: 15_000 });
  const hint = panel.getByTestId("plan-hint").getByRole("button");
  if (await hint.count()) await hint.first().click();
  await panel.getByTestId("agent-plan").evaluate((el) => el.scrollIntoView({ block: "start" }));
}

test.describe("landing product shots (opt-in)", () => {
  test.skip(!ENABLED, "set LANDING_SHOTS=1 to regenerate public/landing screenshots");
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  test("capture editor, plan, timeline and media shots", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("runitback:tour-seen", "true");
      localStorage.setItem("runitback:panel-sizes", JSON.stringify({ horizontal: [22, 46, 32], vertical: [78, 22] }));
      localStorage.setItem("runitback:hints-seen", JSON.stringify(["understand-intro", "first-clip", "plan"]));
    });
    await setupEditor(page);
    await page.screenshot({ path: `${OUT}/editor-light.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/editor-dark.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    await proposePlan(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/editor-plan-light.png` });
    await page.getByTestId("agent-panel").screenshot({ path: `${OUT}/panel-plan.png` });
    const timeline = page.locator("[data-clip-id]").first().locator("xpath=ancestor::*[contains(@class,'timeline')][1]");
    if (await timeline.count()) await timeline.first().screenshot({ path: `${OUT}/timeline.png` });
  });
});
