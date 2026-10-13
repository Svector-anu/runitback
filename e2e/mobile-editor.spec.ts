import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";
import {
  MOBILE_VIEWPORTS, centerOf, closeSheet, expectInsideViewport, expectNoHorizontalScroll, expectTouchTarget, mobileContext, openSheet, shot,
  touchDrag, touchPinch,
} from "./mobile-support";

async function createProject(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).tap();
  await expect(page).toHaveURL(/#\/editor\//);
}

async function importClip(page: Page, name: string, hue: number): Promise<void> {
  await makeWebm(page, { seconds: 3, hue, name, withAudio: true });
  await importGenerated(page);
  await expect(page.getByRole("button", { name: `Add ${name} to timeline` })).toBeVisible({ timeout: 20_000 });
}

async function installScriptedPlanModel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    type Request = import("../src/app/agent/model-client").ModelRequest;
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    const resultText = (request: Request): string => {
      const last = request.messages[request.messages.length - 1];
      const block = last?.role === "user" ? last.content[0] : undefined;
      const inner = block?.type === "tool_result" ? block.content[0] : undefined;
      return inner?.type === "text" ? inner.text : "";
    };
    let assetId = "";
    const model = new ScriptedModelClient([
      { content: [use("c1", "list_assets", {})] },
      (request: Request) => {
        const data = JSON.parse(resultText(request).split("\n")[1] ?? "{}") as { assets: Array<{ id: string; usedOnTimeline: boolean }> };
        assetId = data.assets.find((a) => !a.usedOnTimeline)?.id ?? "";
        const steps = {
          summary: "Append the second clip to the main track.",
          steps: [{ intent: "Add the second clip after the first", tools: ["insert_media"], targets: [`asset ${assetId}`], check: "get_timeline lists the new clip" }],
        };
        return { content: [use("c2", "propose_plan", steps)] };
      },
      () => ({ content: [use("c3", "update_plan_step", { step: 1, status: "running" }), use("c4", "insert_media", { assetId })] }),
      { content: [use("c5", "update_plan_step", { step: 1, status: "done", note: "timeline has a new clip" })] },
      { content: [{ type: "text", text: "Added the clip.\nVerification: the new clip is on the timeline." }] },
    ]);
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = model;
  });
}

const playheadSeconds = async (page: Page): Promise<number> => Number(await page.getByRole("slider", { name: "Playhead" }).getAttribute("aria-valuenow"));

test.use({ channel: "chrome" });

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`mobile editor ${viewport.name}`, () => {
    test.use(mobileContext(viewport));

    test("landing page has no horizontal scroll and its nav fits", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("h1").first()).toBeVisible();
      await expectNoHorizontalScroll(page);
      await shot(page, viewport, "00-landing");
    });

    test("projects page and a fresh editor fit the screen, with the one-time phone notice", async ({ page }) => {
      await page.goto("/#/projects");
      await expect(page.getByRole("button", { name: "Create your first project" })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectTouchTarget(page.getByRole("button", { name: "Create your first project" }), "create project");
      await expectTouchTarget(page.getByRole("button", { name: "Import project" }), "import project");
      await expectInsideViewport(page, page.getByRole("button", { name: "New project" }));
      await shot(page, viewport, "01-projects-empty");

      await page.getByRole("button", { name: "Create your first project" }).tap();
      await expect(page).toHaveURL(/#\/editor\//);
      await expect(page.getByTestId("mobile-layout")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expect(page.locator(".editor")).toHaveCSS("overflow", "hidden");

      const notice = page.getByTestId("mobile-notice");
      if (viewport.width < 600) {
        await expect(notice).toContainText("RunItBack works best on desktop Chrome; mobile is limited");
        await shot(page, viewport, "02-editor-empty-with-notice");
        await notice.getByRole("button", { name: "Dismiss notice" }).tap();
        await expect(notice).toHaveCount(0);
        await page.reload();
        await expect(page.getByTestId("mobile-layout")).toBeVisible();
        await expect(notice).toHaveCount(0);
      } else {
        await expect(notice).toHaveCount(0);
        await shot(page, viewport, "02-editor-empty");
      }
      await expect(page.getByTestId("mobile-sheet")).toHaveAttribute("data-tab", "assets");
      await expectNoHorizontalScroll(page);
    });

    test("import, add with +, play, split, sheets, agent plan approval and export", async ({ page }) => {
      await createProject(page);
      await importClip(page, "mob-a.webm", 200);
      await importClip(page, "mob-b.webm", 20);
      await shot(page, viewport, "03-assets-sheet-with-media");

      const add = page.getByRole("button", { name: "Add mob-a.webm to timeline" });
      await expectTouchTarget(add, "Add to timeline (+)");
      await add.tap();
      await expect(page.locator("[data-clip-id]")).toHaveCount(1);
      await closeSheet(page);
      await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await shot(page, viewport, "04-timeline-with-clip");

      // Hit targets on the always-visible controls.
      await expectTouchTarget(page.getByRole("button", { name: "Play", exact: true }), "Play");
      await expectTouchTarget(page.getByRole("button", { name: "Split", exact: true }), "Split");
      await expectTouchTarget(page.getByRole("button", { name: "Project menu" }), "Project menu");
      await expectTouchTarget(page.getByRole("button", { name: "Help and tips" }), "Help");
      await expectTouchTarget(page.getByRole("button", { name: "Export", exact: true }), "Export");
      for (const name of ["Assets", "Properties", "Agent"]) await expectTouchTarget(page.getByRole("tab", { name }), `${name} tab`);

      // Play advances the playhead.
      await page.getByRole("button", { name: "Play", exact: true }).tap();
      await expect.poll(() => playheadSeconds(page), { timeout: 5000 }).toBeGreaterThan(0.2);
      await page.getByRole("button", { name: "Pause", exact: true }).tap();
      const stoppedAt = await playheadSeconds(page);
      expect(stoppedAt).toBeGreaterThan(0);

      // Split with the toolbar button at the playhead.
      await page.getByRole("button", { name: "Split", exact: true }).tap();
      await expect(page.locator("[data-clip-id]")).toHaveCount(2);

      // Space still plays and pauses: keyboard shortcuts are unaffected by the layout.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
      await page.keyboard.press("Space");
      await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();

      // Every sheet opens without covering the playback controls, and dismisses.
      for (const tab of ["Assets", "Properties", "Agent"] as const) {
        await openSheet(page, tab);
        const sheet = page.getByTestId("mobile-sheet");
        await expect(sheet).toBeVisible();
        const play = await page.getByRole("button", { name: "Play", exact: true }).boundingBox();
        const sheetBox = await sheet.boundingBox();
        const sheetHeight = sheetBox?.height ?? 0;
        expect(play && sheetBox ? play.y + play.height <= sheetBox.y + 0.5 : false, `${tab} sheet must sit below the play button`).toBe(true);
        expect(sheetHeight).toBeGreaterThan(viewport.height * 0.25);
        expect(sheetHeight).toBeLessThanOrEqual(viewport.height * 0.6);
        await expectNoHorizontalScroll(page);
        await shot(page, viewport, `05-sheet-${tab.toLowerCase()}`);
      }
      await page.getByRole("tab", { name: "Agent" }).tap();
      await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);

      // Agent: scripted plan turn, plan card actions reachable, Approve runs it.
      await openSheet(page, "Agent");
      await installScriptedPlanModel(page);
      const panel = page.getByTestId("agent-panel");
      await panel.getByLabel("Message to the agent").fill("Add the other clip after the first one");
      await expectTouchTarget(panel.getByRole("button", { name: "Send" }), "Send");
      await panel.getByRole("button", { name: "Send" }).tap();
      const plan = panel.getByTestId("agent-plan");
      await expect(plan).toHaveAttribute("data-status", "awaiting");
      for (const name of ["Approve", "Edit", "Reject"]) {
        const button = plan.getByRole("button", { name, exact: true });
        await expectTouchTarget(button, `plan ${name}`);
        await expectInsideViewport(page, button);
      }
      await shot(page, viewport, "06-agent-plan-awaiting");
      await closeSheet(page);
      await expect(page.getByRole("tab", { name: /Agent/ }).getByRole("img", { name: "Plan waiting for approval" })).toBeVisible();
      await shot(page, viewport, "07-agent-tab-attention-dot");
      await openSheet(page, "Agent");
      await plan.getByRole("button", { name: "Approve", exact: true }).tap();
      await expect(plan).toHaveAttribute("data-status", "approved");
      await expect(plan.getByTestId("agent-plan-step")).toHaveAttribute("data-status", "done");
      await shot(page, viewport, "08-agent-plan-approved");
      await closeSheet(page);
      await expect(page.locator("[data-clip-id]")).toHaveCount(3);

      // Export popover fits the screen and produces a file.
      await page.getByRole("button", { name: "Export", exact: true }).tap();
      const dialog = page.getByRole("dialog", { name: "Export project" });
      await expect(dialog).toBeVisible();
      await expectInsideViewport(page, dialog);
      await expectNoHorizontalScroll(page);
      await shot(page, viewport, "09-export-popover");
      const download = page.waitForEvent("download", { timeout: 90_000 });
      await dialog.getByRole("button", { name: "Export", exact: true }).tap();
      await shot(page, viewport, "10-export-running");
      expect((await download).suggestedFilename()).toBe("New project.mp4");
    });

    test("touch: tap selects, trim handle drags, ruler scrubs, pinch zooms, and the page never scrolls", async ({ page }) => {
      await createProject(page);
      await importClip(page, "mob-t.webm", 120);
      await importClip(page, "mob-u.webm", 300);
      await page.getByRole("button", { name: "Add mob-t.webm to timeline" }).tap();
      await page.getByRole("button", { name: "Add mob-u.webm to timeline" }).tap();
      await closeSheet(page);
      await expect(page.locator("[data-clip-id]")).toHaveCount(2);
      const clip = page.getByRole("button", { name: /^video mob-t\.webm/ });
      const other = page.getByRole("button", { name: /^video mob-u\.webm/ });

      // Unselected clips scroll with the timeline; the selected one takes drags. Tap selects.
      await expect(other).toHaveAttribute("data-selected", "true");
      await expect(other).toHaveCSS("touch-action", "none");
      await expect(clip).toHaveAttribute("data-selected", "false");
      await expect(clip).toHaveCSS("touch-action", "pan-x pan-y");
      await clip.tap();
      await expect(clip).toHaveAttribute("data-selected", "true");
      await expect(clip).toHaveCSS("touch-action", "none");

      const right = clip.getByRole("button", { name: "Right resize handle" });
      await expectTouchTarget(right, "right trim handle");
      await expectTouchTarget(clip.getByRole("button", { name: "Left resize handle" }), "left trim handle");
      const before = Number(await clip.getAttribute("data-duration"));
      const from = await centerOf(right);
      await touchDrag(page, from, { x: from.x - 60, y: from.y + 6 });
      await expect.poll(async () => Number(await clip.getAttribute("data-duration"))).toBeLessThan(before);
      expect(await page.evaluate(() => window.scrollY + document.documentElement.scrollTop)).toBe(0);
      await shot(page, viewport, "11-after-trim-drag");

      // Dragging on the ruler scrubs the playhead with touch.
      const ruler = page.locator(".timeline__ruler");
      const rulerBox = await ruler.boundingBox();
      if (!rulerBox) throw new Error("no ruler");
      const y = rulerBox.y + rulerBox.height / 2;
      const startX = rulerBox.x + 30;
      const seconds0 = await playheadSeconds(page);
      await touchDrag(page, { x: startX, y }, { x: startX + 90, y });
      await expect.poll(() => playheadSeconds(page)).toBeGreaterThan(seconds0);
      expect(await page.evaluate(() => window.scrollY + document.documentElement.scrollTop)).toBe(0);

      // The playhead knob has a 44 px hit area and drags.
      const knob = page.getByRole("slider", { name: "Playhead" });
      const knobBox = await knob.boundingBox();
      if (!knobBox) throw new Error("no knob");
      const hit = await knob.evaluate((el) => {
        const r = getComputedStyle(el, "::after");
        return { width: parseFloat(r.width), height: parseFloat(r.height) };
      });
      expect(hit.width).toBeGreaterThanOrEqual(44);
      expect(hit.height).toBeGreaterThanOrEqual(44);

      // Pinch on the timeline changes zoom through the timeline's own zoom path.
      const zoom = page.getByRole("slider", { name: "Timeline zoom" });
      const zoomBefore = Number(await zoom.inputValue());
      const scroll = await centerOf(page.locator(".timeline__scroll"));
      await touchPinch(page, scroll, 60, 200);
      await expect.poll(async () => Number(await zoom.inputValue())).toBeGreaterThan(zoomBefore);
      await expectNoHorizontalScroll(page);
      await shot(page, viewport, "12-after-pinch-zoom");
    });

    test("dialogs, the guided tour and the help menu fit the screen", async ({ page }) => {
      await createProject(page);
      await importClip(page, "mob-d.webm", 60);

      // The Understand consent dialog (model download) is a bottom sheet that stays on screen.
      await page.getByRole("button", { name: "Understand mob-d.webm" }).tap();
      const consent = page.getByRole("dialog").first();
      await expect(consent).toBeVisible();
      await expectInsideViewport(page, consent);
      for (const button of await consent.getByRole("button").all()) await expectTouchTarget(button, "dialog button");
      await expectNoHorizontalScroll(page);
      await shot(page, viewport, "13-consent-dialog");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // Guided tour: every card is fully inside the viewport and steps move the sheet to the highlighted control.
      await page.getByRole("button", { name: "Help and tips" }).tap();
      await page.getByRole("menuitem", { name: "Take the tour" }).tap();
      const tour = page.getByTestId("tour");
      for (let step = 0; step < 5; step++) {
        await expect(tour).toBeVisible();
        await expect(tour).toHaveAttribute("data-step", /./);
        await expectInsideViewport(page, tour);
        if (step === 0) await expect(page.getByTestId("mobile-sheet")).toHaveAttribute("data-tab", "assets");
        if (step === 3) await expect(page.getByTestId("mobile-sheet")).toHaveCount(0);
        await shot(page, viewport, `14-tour-step-${step + 1}`);
        await tour.getByRole("button", { name: /Next|Done/ }).tap();
      }
      await expect(tour).toHaveCount(0);
      await expectNoHorizontalScroll(page);
    });
  });
}
