import { expect, test, type Page, type Route } from "@playwright/test";
import { MOBILE_VIEWPORTS, expectNoHorizontalScroll, mobileContext, openSheet } from "./mobile-support";

/**
 * The Generate panel against a faked Surplus gateway: every request to api.surplusintelligence.ai is answered by
 * Playwright route interception, so no real network and no real key is involved.
 */
const SHOTS = "e2e/.artifacts/gen";
const KEY = "inf_e2e_fake_key_0001";

const CATALOG = {
  data: [
    { id: "chat", name: "Chat", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "1", completion: "1" } },
    {
      id: "e2e-image", name: "E2E Image", architecture: { input_modalities: ["text"], output_modalities: ["image"] }, pricing: { image: "0.02", media_unit: "image" },
      supported_features: ["image"], sizes: ["1024x1024", "1536x1024"],
    },
    {
      id: "e2e-video", name: "E2E Video", architecture: { input_modalities: ["text"], output_modalities: ["video"] }, pricing: { image: "0.32", media_unit: "job" },
      supported_features: ["video", "async", "text-to-video"], aspect_ratios: ["16:9", "9:16"], durations_seconds: [4, 8],
    },
    {
      id: "e2e-voice", name: "E2E Voice", architecture: { input_modalities: ["text"], output_modalities: ["audio"] }, pricing: { image: "0.0035", media_unit: "1K characters" },
      supported_features: ["audio", "voices"], voices: ["alloy", "echo"],
    },
  ],
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,content-type,idempotency-key,x-job-token",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
};

interface Gateway { requests: Array<{ method: string; path: string; auth: string | undefined; body: unknown }>; imageStatus: number }

async function drawPng(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    const gradient = ctx.createLinearGradient(0, 0, 640, 360);
    gradient.addColorStop(0, "#f97316");
    gradient.addColorStop(1, "#6366f1");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 640, 360);
    return canvas.toDataURL("image/png").split(",")[1] ?? "";
  });
}

async function fakeGateway(page: Page): Promise<Gateway> {
  const png = await drawPng(page);
  const gateway: Gateway = { requests: [], imageStatus: 200 };
  await page.route("https://api.surplusintelligence.ai/**", async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: CORS }); return; }
    gateway.requests.push({ method: request.method(), path, auth: request.headers().authorization, body: request.postDataJSON() as unknown });
    const reply = (status: number, body: unknown): Promise<void> => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (path === "/v1/models") return reply(200, CATALOG);
    if (path === "/v1/buyer/me") return request.headers().authorization === `Bearer ${KEY}` ? reply(200, { balance: "1" }) : reply(401, { error: { code: "unauthorized", message: "no" } });
    if (path === "/v1/images/generations") {
      return gateway.imageStatus === 200
        ? reply(200, { created: 1, data: [{ b64_json: png }] })
        : reply(gateway.imageStatus, { error: { code: "insufficient_credit", message: "Add credit to continue" } });
    }
    return reply(404, { error: { code: "not_found", message: path } });
  });
  return gateway;
}

async function createProject(page: Page, tap = false): Promise<void> {
  await page.goto("/#/projects");
  const create = page.getByRole("button", { name: "Create your first project" });
  await (tap ? create.tap() : create.click());
  await expect(page).toHaveURL(/#\/editor\//);
}

test("generate an image with your own Surplus key and find it in Assets", async ({ page }) => {
  const gateway = await fakeGateway(page);
  await createProject(page);
  await page.getByRole("tab", { name: "Generate" }).click();
  const panel = page.getByTestId("generate-panel");

  await expect(panel.getByLabel("Surplus API key")).toHaveAttribute("type", "password");
  await expect(panel.getByRole("link", { name: "Get a key" })).toHaveAttribute("href", "https://www.surplusintelligence.ai");
  await expect(panel.getByTestId("generate-hosted")).toContainText("Hosted credits, sponsored by us: coming soon");
  await expect(panel.getByTestId("generate-hosted")).toContainText("Want free generations? Bring your own Surplus key for now.");
  await expect(panel.getByRole("button", { name: "Generate with hosted credits" })).toBeDisabled();
  await expect(panel.getByTestId("generate-privacy")).toContainText("leaves this device");
  expect(gateway.requests, "nothing is sent before a key is saved").toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/1-no-key.png` });

  await panel.getByLabel("Surplus API key").fill(KEY);
  await panel.getByRole("button", { name: "Test key" }).click();
  await expect(panel.getByTestId("generate-key-result")).toContainText("Key works");
  await expect(panel.getByLabel("Model")).toContainText("E2E Image - $0.02 per image");
  await expect(panel.getByLabel("Model").locator("option")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();

  await panel.getByLabel("Prompt").fill("A foggy harbor at sunrise");
  await expect(panel.getByTestId("generate-estimate")).toContainText("$0.02");
  await panel.getByLabel("Size").selectOption("1536x1024");
  await page.screenshot({ path: `${SHOTS}/2-ready.png` });
  await panel.getByRole("button", { name: "Generate", exact: true }).click();

  await expect(panel.getByTestId("generate-result")).toContainText("Added generated-a-foggy-harbor-at-sunrise.png to Assets");
  const post = gateway.requests.find((r) => r.method === "POST" && r.path === "/v1/images/generations");
  expect(post?.auth).toBe(`Bearer ${KEY}`);
  expect(post?.body).toEqual({ model: "e2e-image", prompt: "A foggy harbor at sunrise", n: 1, response_format: "b64_json", size: "1536x1024" });
  await page.screenshot({ path: `${SHOTS}/3-generated.png` });

  await panel.getByRole("button", { name: "Show in Assets" }).click();
  const tile = page.locator("[data-asset-id]").first();
  await expect(tile).toContainText("Generated");
  await expect(tile.getByTestId("generated-tag")).toHaveAttribute("title", /e2e-image: A foggy harbor at sunrise/);
  await expect(page.getByRole("button", { name: /Add generated-a-foggy.*to timeline/ })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/4-in-assets.png` });

  await page.getByRole("tab", { name: "Generate" }).click();
  await panel.getByRole("button", { name: "Forget key" }).click();
  await expect(panel.getByLabel("Surplus API key")).toHaveValue("");
  expect(await page.evaluate(() => localStorage.getItem("runitback:surplus-api-key"))).toBe('""');
});

test("an out-of-credit answer is explained and nothing is added", async ({ page }) => {
  const gateway = await fakeGateway(page);
  gateway.imageStatus = 402;
  await page.addInitScript((key) => localStorage.setItem("runitback:surplus-api-key", JSON.stringify(key)), KEY);
  await createProject(page);
  await page.getByRole("tab", { name: "Generate" }).click();
  const panel = page.getByTestId("generate-panel");
  await panel.getByLabel("Prompt").fill("anything");
  await panel.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(panel.getByTestId("generate-error")).toContainText("Not enough Surplus credit (402)");
  await page.screenshot({ path: `${SHOTS}/5-out-of-credit.png` });
  await page.getByRole("tab", { name: "Media" }).click();
  await expect(page.locator("[data-asset-id]")).toHaveCount(0);
});

test("a video job is submitted, polled, can be cancelled, and uses the job token", async ({ page }) => {
  const calls: string[] = [];
  await page.addInitScript((key) => localStorage.setItem("runitback:surplus-api-key", JSON.stringify(key)), KEY);
  await page.route("https://api.surplusintelligence.ai/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers: CORS }); return; }
    calls.push(`${request.method()} ${path}${request.headers()["x-job-token"] ? " (token)" : ""}`);
    const json = (status: number, body: unknown): Promise<void> => route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (path === "/v1/models") return json(200, CATALOG);
    if (path === "/v1/video/generations" && request.method() === "POST") {
      return json(202, { id: "job-1", status: "queued", poll_url: "/v1/video/generations/job-1", job_token: "mjt_x", estimated_cost_usdc: "320000", max_cost_usdc: "640000", expires_at: 4_102_444_800 });
    }
    if (path === "/v1/video/generations/job-1" && request.method() === "GET") return json(202, { id: "job-1", status: "running", progress: 0.3 });
    if (path === "/v1/video/generations/job-1" && request.method() === "DELETE") return json(200, {});
    return json(404, {});
  });
  await createProject(page);
  await page.getByRole("tab", { name: "Generate" }).click();
  const panel = page.getByTestId("generate-panel");
  await panel.getByRole("tab", { name: "Video" }).click();
  await panel.getByLabel("Prompt").fill("waves on a beach");
  await expect(panel.getByTestId("generate-estimate")).toContainText("About $0.32");
  await panel.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(panel.getByTestId("generate-progress")).toContainText("Surplus quote $0.32, at most $0.64");
  await page.screenshot({ path: `${SHOTS}/6-video-progress.png` });
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(panel.getByTestId("generate-progress")).toHaveCount(0);
  await expect(panel.getByTestId("generate-error")).toHaveCount(0);
  expect(calls).toContain("POST /v1/video/generations");
  expect(calls).toContain("DELETE /v1/video/generations/job-1 (token)");
});

for (const viewport of MOBILE_VIEWPORTS.slice(0, 2)) {
  test.describe(`mobile ${viewport.name}`, () => {
    test.use(mobileContext(viewport));
    test("the Generate panel fits and works with touch", async ({ page }) => {
      await fakeGateway(page);
      await page.addInitScript((key) => localStorage.setItem("runitback:surplus-api-key", JSON.stringify(key)), KEY);
      await createProject(page, true);
      await openSheet(page, "Assets");
      await page.getByRole("tab", { name: "Generate" }).tap();
      const panel = page.getByTestId("generate-panel");
      await panel.getByLabel("Prompt").fill("A foggy harbor");
      await expect(panel.getByRole("button", { name: "Generate", exact: true })).toBeEnabled();
      await expectNoHorizontalScroll(page);
      await page.screenshot({ path: `${SHOTS}/mobile-${viewport.name}.png` });
    });
  });
}
