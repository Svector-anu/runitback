import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { importWav } from "./audio-support";
import { importGenerated, makeWebm } from "./media";
import { speechPlusNoise } from "../tests/speech-fixture";

/**
 * Runs against `vite preview` (PLAYWRIGHT_TARGET=production), which serves the exact headers from vercel.json. Every
 * test records `securitypolicyviolation` events (document and worker scopes) and console CSP errors, and the app must
 * produce none. Control tests prove the recorder would notice: if they fail, a green run means nothing.
 */
test.skip(process.env.PLAYWRIGHT_TARGET !== "production", "needs the production build served with the vercel.json headers (PLAYWRIGHT_TARGET=production)");

interface Recorder {
  violations: () => string[];
  /** Hosts that actually answered a request (blocked requests never do). */
  hosts: () => string[];
}

async function record(page: Page): Promise<Recorder> {
  const seen: string[] = [];
  const hosts = new Set<string>();
  const note = (text: string): void => { if (/Content Security Policy|Refused to |violates the following/i.test(text)) seen.push(`console: ${text}`); };
  page.on("console", (message) => note(message.text()));
  page.on("worker", (worker) => worker.on("console", (message) => note(message.text())));
  page.on("requestfailed", (request) => {
    if (/BLOCKED_BY_CSP/.test(request.failure()?.errorText ?? "")) seen.push(`blocked by CSP: ${request.url()}`);
  });
  page.on("response", (response) => { if (response.url().startsWith("http")) hosts.add(new URL(response.url()).host); });
  await page.addInitScript(() => {
    const log = (event: Event): void => {
      const violation = event as SecurityPolicyViolationEvent;
      const host = window as unknown as { __cspViolations?: string[] };
      (host.__cspViolations ??= []).push(`${violation.violatedDirective} blocked=${violation.blockedURI} source=${violation.sourceFile}`);
    };
    document.addEventListener("securitypolicyviolation", log);
  });
  return {
    violations: () => seen,
    hosts: () => [...hosts].sort(),
  };
}

async function documentViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []);
}

async function allViolations(page: Page, recorder: Recorder): Promise<string[]> {
  return [...(await documentViolations(page)), ...recorder.violations()];
}

const ORIGIN_HOST = (page: Page): string => new URL(page.url()).host;

function directives(header: string): Map<string, string[]> {
  return new Map(header.split(";").map((part) => part.trim().split(/\s+/)).filter((tokens) => tokens[0]).map(([name, ...values]) => [name as string, values]));
}

test("the document is served with a strict CSP and the security headers", async ({ request }) => {
  const response = await request.get("/");
  const policy = directives(response.headers()["content-security-policy"] ?? "");
  expect(policy.get("default-src")).toEqual(["'self'"]);
  expect(policy.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(policy.get("style-src")).toEqual(["'self'"]);
  expect(policy.get("object-src")).toEqual(["'none'"]);
  expect(policy.get("base-uri")).toEqual(["'self'"]);
  expect(policy.get("form-action")).toEqual(["'self'"]);
  expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  expect(policy.get("connect-src")).toEqual(expect.arrayContaining(["'self'", "https://huggingface.co", "https://*.hf.co", "https://api.anthropic.com", "https://api.surplusintelligence.ai"]));
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});

test("only the two MediaPipe workers (face detector, segmenter) may evaluate code, because MediaPipe's loader needs an indirect eval", async ({ request }) => {
  const scripts = readdirSync("dist/assets").filter((name) => name.endsWith(".js"));
  const mediapipeWorkers = scripts.filter((name) => name.startsWith("face-worker-"));
  expect(mediapipeWorkers, "vite emits assets/face-worker-<hash>.js and face-worker-segmenter-<hash>.js; vercel.json matches the face-worker- prefix").toHaveLength(2);
  for (const name of scripts) {
    const policy = directives((await request.get(`/assets/${name}`)).headers()["content-security-policy"] ?? "");
    const evalAllowed = policy.get("script-src")?.includes("'unsafe-eval'") ?? false;
    expect(evalAllowed, name).toBe(mediapipeWorkers.includes(name));
  }
  expect(readFileSync("dist/index.html", "utf8")).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
});

test("control: the recorder sees blocked inline scripts, third-party requests and third-party styles", async ({ page }) => {
  const recorder = await record(page);
  await page.goto("/");
  await page.evaluate(async () => {
    const inline = document.createElement("script");
    inline.textContent = "window.__inlineRan = true";
    document.head.appendChild(inline);
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = "https://fonts.googleapis.com/css2?family=Roboto";
    document.head.appendChild(sheet);
    await fetch("https://example.com/", { mode: "no-cors" }).catch(() => undefined);
  });
  await expect.poll(() => documentViolations(page).then((all) => all.length)).toBeGreaterThanOrEqual(3);
  const all = (await documentViolations(page)).join("\n");
  expect(all).toMatch(/script-src/);
  expect(all).toMatch(/style-src/);
  expect(all).toMatch(/connect-src.*example\.com/);
  expect(await page.evaluate(() => (window as unknown as { __inlineRan?: boolean }).__inlineRan)).toBeUndefined();
  expect(recorder.hosts().filter((host) => host !== ORIGIN_HOST(page))).toEqual([]);
});

const PROBE_URLS = {
  hub: "https://huggingface.co/probe",
  cdn: "https://us.aws.cdn.hf.co/probe",
  anthropic: "https://api.anthropic.com/v1/probe",
  surplus: "https://api.surplusintelligence.ai/v1/probe",
  thirdParty: "https://example.com/probe",
};

/** Fetches every probe URL from `scope` and returns which ones the browser let through; also returns scope-level CSP violation events. */
const PROBE_SOURCE = `
  const urls = ${JSON.stringify(PROBE_URLS)};
  const violations = [];
  self.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective + " " + event.blockedURI));
  const reached = {};
  for (const [name, url] of Object.entries(urls)) {
    reached[name] = await fetch(url).then((response) => response.ok, () => false);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { reached, violations };
`;

async function stubProbeHosts(page: Page): Promise<void> {
  for (const url of Object.values(PROBE_URLS)) {
    await page.route(url, (route) => route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, body: "ok" }));
  }
}

interface ProbeResult { reached: Record<keyof typeof PROBE_URLS, boolean>; violations: string[] }

test("connect-src lets the page reach Hugging Face, its CDN and the Anthropic API, the Surplus gateway, and nothing else", async ({ page }) => {
  await stubProbeHosts(page);
  await page.goto("/");
  const result = await page.evaluate(async (source) => {
    const run = new (Object.getPrototypeOf(async () => undefined).constructor as new (code: string) => () => Promise<ProbeResult>)(source);
    return run();
  }, PROBE_SOURCE.replace("self.addEventListener", "document.addEventListener"));
  expect(result.reached).toEqual({ hub: true, cdn: true, anthropic: true, surplus: true, thirdParty: false });
  expect(result.violations.map((violation) => violation.split(" ")[1])).toEqual([PROBE_URLS.thirdParty]);
});

test("a blob worker inherits the same connect-src, and the control proves worker violations are detectable", async ({ page }) => {
  await stubProbeHosts(page);
  await page.goto("/");
  const result = await page.evaluate(async (source) => {
    const script = `(async () => { const run = async () => { ${source} }; postMessage(await run()); })()`;
    const worker = new Worker(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
    return new Promise<ProbeResult>((resolve) => { worker.onmessage = (event) => resolve(event.data as ProbeResult); });
  }, PROBE_SOURCE);
  expect(result.reached).toEqual({ hub: true, cdn: true, anthropic: true, surplus: true, thirdParty: false });
  expect(result.violations.map((violation) => violation.split(" ")[1])).toEqual([PROBE_URLS.thirdParty]);
});

test("create, import, edit, play and export-prep run with no CSP violations and no third-party request", async ({ page }) => {
  const recorder = await record(page);
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: 3, hue: 30, name: "clip.webm", withAudio: true });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add clip.webm to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);

  const seconds = (): Promise<number> => page.evaluate(() => Number(document.querySelector(".playhead")?.getAttribute("data-seconds")));
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Home");
  const before = await seconds();
  await page.keyboard.press("Space");
  await expect.poll(seconds, { timeout: 10_000 }).toBeGreaterThan(before + 0.3);
  await page.keyboard.press("Space");

  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.locator("[data-clip-id]")).toHaveCount(1, { timeout: 20_000 });

  expect(await allViolations(page, recorder)).toEqual([]);
  expect(recorder.hosts().filter((host) => host !== ORIGIN_HOST(page))).toEqual([]);
});

test("the bundled font is the only font requested, from this origin", async ({ page }) => {
  const recorder = await record(page);
  const fontUrls: string[] = [];
  page.on("request", (request) => { if (request.resourceType() === "font") fontUrls.push(request.url()); });
  await page.goto("/");
  await page.evaluate(() => document.fonts.load('400 16px "Inter"'));
  expect(fontUrls.length).toBeGreaterThan(0);
  for (const url of fontUrls) expect(new URL(url).host).toBe(ORIGIN_HOST(page));
  expect(await page.evaluate(() => document.fonts.check('400 16px "Inter"'))).toBe(true);
  expect(await allViolations(page, recorder)).toEqual([]);
});

test("Understand starts the real workers; the model hub is reachable and the face detector runs under the CSP", async ({ page }) => {
  const recorder = await record(page);
  const hits = { hub: 0 };
  await page.route("https://huggingface.co/**", (route) => {
    hits.hub += 1;
    return route.fulfill({ status: 404, body: "stub" });
  });

  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: 2, hue: 200, name: "talk.webm", withAudio: true });
  await importGenerated(page);

  const tile = page.locator("[data-asset-id]").first();
  await tile.hover();
  await page.getByRole("button", { name: "Understand talk.webm" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Download and understand" }).click();

  const chip = tile.locator(".media-item__status");
  await expect(chip).toHaveAttribute("data-state", /partial|understood|failed/, { timeout: 90_000 });
  expect(hits.hub, "the model hub was contacted").toBeGreaterThan(0);
  expect(await chip.getAttribute("title")).not.toMatch(/faces failed/);
  expect(await allViolations(page, recorder)).toEqual([]);
  expect(recorder.hosts().filter((host) => host !== ORIGIN_HOST(page))).toEqual(expect.arrayContaining(["huggingface.co"]));
});

test("noise removal runs the vendored RNNoise wasm under the CSP: no violation, no third-party request", async ({ page }) => {
  const recorder = await record(page);
  const fixture = speechPlusNoise({ seconds: 3 });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await importWav(page, { name: "speech.wav", samples: fixture.mixed, sampleRate: fixture.sampleRate });
  await page.getByRole("button", { name: "Add speech.wav to timeline" }).click({ force: true });
  await page.locator("[data-clip-id]").first().click();
  await page.getByRole("tab", { name: "Audio" }).click();
  await page.getByRole("slider", { name: "Noise removal" }).fill("1");
  const note = page.getByTestId("denoise-note");
  await expect(note).toHaveAttribute("data-state", /ready|error/, { timeout: 60_000 });
  expect(await note.getAttribute("data-state"), (await note.textContent()) ?? "").toBe("ready");
  expect(await allViolations(page, recorder)).toEqual([]);
  expect(recorder.hosts().filter((host) => host !== ORIGIN_HOST(page))).toEqual([]);
});

test.describe("real audio models (opt-in: REAL_CSP=1 downloads about 220 MB from Hugging Face)", () => {
  test.skip(process.env.REAL_CSP !== "1", "set REAL_CSP=1");
  test.setTimeout(1_500_000);

  test("text to speech and caption translation run ONNX Runtime WASM in workers under the CSP, from the pinned revisions", async ({ page }) => {
    const recorder = await record(page);
    const modelRequests: string[] = [];
    page.on("request", (request) => { if (/huggingface\.co|\.hf\.co/.test(request.url())) modelRequests.push(request.url()); });
    await page.goto("/#/projects");
    await page.getByRole("button", { name: "Create your first project" }).click();
    await expect(page.getByLabel("Project name")).toBeVisible();
    await page.getByRole("tab", { name: "Text" }).click();
    await page.getByLabel("Voice-over script").fill("Welcome to the show.");
    await page.getByRole("button", { name: "Generate voice-over" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Download and generate" }).click();
    await expect(page.getByText("Voice-over added")).toBeVisible({ timeout: 1_400_000 });
    const speech = [...new Set(modelRequests.map((url) => new URL(url).pathname))];
    expect(speech.some((path) => path.includes("speecht5_tts") && path.includes("1723781b8ce2d02f0400c8337be04ae8ee3d6d56") && path.endsWith("q4f16.onnx"))).toBe(true);
    expect(speech.some((path) => path.includes("speecht5_hifigan") && path.includes("cf980c3610d7b7f20919960031066ef7905737bd") && path.endsWith(".onnx"))).toBe(true);
    await page.getByRole("tab", { name: "Captions" }).click();
    await page.getByLabel("Import subtitle file").setInputFiles({
      name: "lines.srt", mimeType: "text/plain",
      buffer: Buffer.from("1\n00:00:00,000 --> 00:00:02,000\nWelcome to the show.\n\n2\n00:00:02,500 --> 00:00:05,000\nToday we talk about editing video.\n"),
    });
    await expect(page.getByText("Added 2 captions")).toBeVisible();
    await page.getByTestId("translate-captions").getByRole("button", { name: "Translate", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Download and translate" }).click();
    await expect(page.getByText("Translated 2 captions")).toBeVisible({ timeout: 1_400_000 });
    const translation = [...new Set(modelRequests.map((url) => new URL(url).pathname))];
    expect(translation.some((path) => path.includes("opus-mt-en-es") && path.includes("4b002a4c7edd54a7ced58877258b87f7efd3f892") && path.endsWith("encoder_model_quantized.onnx"))).toBe(true);
    expect(await allViolations(page, recorder)).toEqual([]);
    console.log("hosts", recorder.hosts().join(","));
  });
});

test.describe("real models (opt-in: REAL_CSP=1 downloads about 210 MB from Hugging Face)", () => {
  test.skip(process.env.REAL_CSP !== "1", "set REAL_CSP=1");
  test.setTimeout(900_000);

  test("Understand downloads the pinned models and runs ONNX Runtime WASM under the CSP", async ({ page }) => {
    const recorder = await record(page);
    const modelRequests: string[] = [];
    page.on("request", (request) => { if (/huggingface\.co|\.hf\.co/.test(request.url())) modelRequests.push(request.url()); });
    await page.goto("/#/projects");
    await page.getByRole("button", { name: "Create your first project" }).click();
    await makeWebm(page, { seconds: 3, hue: 200, name: "talk.webm", withAudio: true });
    await importGenerated(page);
    const tile = page.locator("[data-asset-id]").first();
    await tile.hover();
    await page.getByRole("button", { name: "Understand talk.webm" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Download and understand" }).click();
    const chip = tile.locator(".media-item__status");
    await expect(chip).toHaveAttribute("data-state", /partial|understood|failed/, { timeout: 800_000 });
    console.log("chip", await chip.getAttribute("data-state"), await chip.getAttribute("title"));
    console.log("hosts", recorder.hosts().join(","));
    const hub = modelRequests.filter((url) => url.startsWith("https://huggingface.co/"));
    expect(hub.length).toBeGreaterThan(0);
    const paths = [...new Set(hub.map((url) => new URL(url).pathname))];
    const atMain = paths.filter((path) => path.includes("/resolve/main/"));
    // transformers.js 4.3.0 `pipeline()` probes a few small json files at `main` to plan the file list; every model byte and every
    // CLIP file is requested at the pinned commit (the hub rewrites /resolve/<hash>/ to /api/resolve-cache/models/<id>/<hash>/).
    expect(atMain.every((path) => path.startsWith("/onnx-community/whisper-tiny.en_timestamped/") && path.endsWith(".json"))).toBe(true);
    expect(paths.some((path) => path.includes("whisper-tiny.en_timestamped") && path.includes("aeaa13760958b03fac5062f457d317d3319c3168") && path.endsWith(".onnx"))).toBe(true);
    expect(paths.some((path) => path.includes("clip-vit-base-patch32") && path.includes("d15189d7028b43f1d3e65039190477f6af591c2a") && path.endsWith(".onnx"))).toBe(true);
    expect(await allViolations(page, recorder)).toEqual([]);
    expect(await chip.getAttribute("data-state")).toBe("understood");
  });
});
