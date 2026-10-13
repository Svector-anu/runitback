import { expect, test, type Page } from "@playwright/test";

const TICKS = 120_000;

/** Test doubles for the speech and translation models, through the dev-only hooks; no model is downloaded. */
async function installDoubles(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = globalThis as unknown as { __speechEngine?: unknown; __translator?: unknown; __speechCalls?: string[]; __translateCalls?: string[][] };
    host.__speechCalls = [];
    host.__translateCalls = [];
    host.__speechEngine = {
      async synthesize(input: { text: string; voiceId: string }) {
        host.__speechCalls?.push(`${input.voiceId}:${input.text}`);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const rate = 16_000;
        const length = Math.round(input.text.length * 0.06 * rate);
        return { sampleRate: rate, samples: Float32Array.from({ length }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate)) };
      },
    };
    host.__translator = {
      async translate(input: { texts: string[]; source: string; target: string }) {
        host.__translateCalls?.push(input.texts);
        return input.texts.map((t) => `[${input.target}] ${t}`);
      },
    };
  });
}

async function newProject(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await installDoubles(page);
}

test("Text to speech: a script becomes a stored audio asset and an audio clip at the playhead; undo removes the clip", async ({ page }) => {
  await newProject(page);
  await page.getByRole("tab", { name: "Text" }).click();
  await expect(page.getByTestId("tts-panel")).toContainText("clearly synthetic");
  const generate = page.getByRole("button", { name: "Generate voice-over" });
  await expect(generate).toBeDisabled();
  await page.getByLabel("Voice-over script").fill("Hello there. This is a voice-over test.");
  await page.getByLabel("Voice").selectOption({ label: "Male, US (bdl)" }).catch(async () => {
    await page.getByRole("combobox", { name: "Voice" }).selectOption("bdl");
  });
  await generate.click();
  await expect(page.getByText("Voice-over added")).toBeVisible({ timeout: 20_000 });
  const clip = page.locator("[data-clip-id]");
  await expect(clip).toHaveCount(1);
  const calls = await page.evaluate(() => (globalThis as unknown as { __speechCalls: string[] }).__speechCalls);
  expect(calls).toEqual(["bdl:Hello there.", "bdl:This is a voice-over test."]);
  const expectedSeconds = (("Hello there.".length + "This is a voice-over test.".length) * 0.06) + 0.28;
  const duration = Number(await clip.first().getAttribute("data-duration")) / TICKS;
  expect(Math.abs(duration - expectedSeconds)).toBeLessThan(0.1);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("[data-clip-id]")).toHaveCount(0);
});

test("Translate captions: a new caption track with the same timing, originals kept, one undo step, honest note", async ({ page }) => {
  await newProject(page);
  await page.evaluate(async () => {
    const { getServices } = (await import(/* @vite-ignore */ ("/src/app/services.ts" as string))) as typeof import("../src/app/services");
    const { insertElementsOnLanes } = (await import(/* @vite-ignore */ ("/src/engine/commands/index.ts" as string))) as typeof import("../src/engine/commands");
    const { captionElement } = (await import(/* @vite-ignore */ ("/src/engine/agent/captions.ts" as string))) as typeof import("../src/engine/agent/captions");
    const { editor } = getServices();
    const canvas = editor.getState().doc.settings.canvasSize;
    const elements = ["Welcome to the show.", "See you next time."].map((text, i) =>
      captionElement({ cue: { text, startTime: (i * 3 * 120_000) as never, duration: (2 * 120_000) as never }, index: i, id: editor.newId(), canvas, startTime: (i * 3 * 120_000) as never, duration: (2 * 120_000) as never }));
    editor.execute(insertElementsOnLanes({ elements, index: 0, label: "Captions" }));
  });
  await expect(page.locator("[data-clip-id]")).toHaveCount(2);
  await page.getByRole("tab", { name: "Captions" }).click();
  const panel = page.getByTestId("translate-captions");
  await expect(panel).toContainText("Machine translation");
  await expect(panel).toContainText("Always read the result before publishing");
  await panel.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByText("Translated 2 captions")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-clip-id]")).toHaveCount(4);
  const starts = await page.locator("[data-clip-id]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))).sort((a, b) => a - b));
  expect(starts).toEqual([0, 0, 3 * 120_000, 3 * 120_000]);
  const calls = await page.evaluate(() => (globalThis as unknown as { __translateCalls: string[][] }).__translateCalls);
  expect(calls).toEqual([["Welcome to the show.", "See you next time."]]);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator("[data-clip-id]")).toHaveCount(2);
});
