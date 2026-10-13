import { describe, expect, it } from "vitest";
import { GenerateService, type GenerateServiceDeps } from "#/app/generate/service";
import { generateDeps } from "#/app/agent/generate-wiring";
import { GenerateError } from "#/app/generate/client";
import type { MediaAssetInfo } from "#/engine/model";
import { PrefsStore } from "#/platform/prefs";
import { CATALOG_BODY, KEY, PNG_B64, bytes, fakeFetch, json } from "./generate-fixtures";

function memoryPrefs(): { prefs: PrefsStore; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return { prefs: new PrefsStore({ getItem: (k) => raw.get(k) ?? null, setItem: (k, v) => void raw.set(k, v) }), raw };
}

function setup(options: { key?: string; routes?: Parameters<typeof fakeFetch>[0]; hasProject?: boolean; importFails?: boolean } = {}) {
  const { prefs, raw } = memoryPrefs();
  if (options.key !== undefined) prefs.write("surplus-api-key", options.key);
  const net = fakeFetch({ "GET /v1/models": () => json(200, CATALOG_BODY), ...options.routes });
  const imported: Array<{ file: File; generated: unknown }> = [];
  const asset = (file: File): MediaAssetInfo => ({ id: "asset-1", name: file.name, type: file.type.startsWith("image") ? "image" : "video", size: file.size, lastModified: 0 });
  const deps: GenerateServiceDeps = {
    prefs, fetch: net.fetch, now: () => Date.parse("2026-10-13T12:00:00Z"), hasProject: () => options.hasProject ?? true,
    sleep: async (_ms, signal) => { if (signal?.aborted) throw new GenerateError("cancelled", "Cancelled."); },
    importFile: async (file, generated) => {
      imported.push({ file, generated });
      return options.importFails ? { imported: [], failures: [{ name: file.name, message: "Storage is full." }] } : { imported: [asset(file)], failures: [] };
    },
  };
  return { service: new GenerateService(deps), net, raw, imported };
}

describe("GenerateService key and prefs", () => {
  it("stores the key through prefs only, trimmed, and forgets it", () => {
    const { service, raw } = setup();
    service.setApiKey(`  ${KEY} \n`);
    expect(service.state.get().apiKey).toBe(KEY);
    expect(raw.get("runitback:surplus-api-key")).toBe(JSON.stringify(KEY));
    service.forgetKey();
    expect(service.hasKey).toBe(false);
    expect(raw.get("runitback:surplus-api-key")).toBe('""');
  });

  it("restores kind and per-kind model choices", () => {
    const first = setup({ key: KEY });
    first.service.setKind("video");
    first.service.setModel("image", "img-dear");
    const { prefs } = memoryPrefs();
    for (const [k, v] of first.raw) prefs.write(k.replace("runitback:", ""), JSON.parse(v));
    const second = new GenerateService({ prefs, hasProject: () => true, importFile: async () => ({ imported: [], failures: [] }) });
    expect(second.state.get()).toMatchObject({ kind: "video", chosen: { image: "img-dear" }, apiKey: KEY });
  });
});

describe("GenerateService catalog", () => {
  it("caches the catalog and reloads on force", async () => {
    const { service, net } = setup({ key: KEY });
    await service.loadCatalog();
    await service.loadCatalog();
    expect(net.calls.filter((c) => c.url.endsWith("/v1/models"))).toHaveLength(1);
    await service.loadCatalog({ force: true });
    expect(net.calls.filter((c) => c.url.endsWith("/v1/models"))).toHaveLength(2);
    expect(service.selectedModel("image")?.id).toBe("img-cheap");
  });

  it("keeps a failure in state and lets the user retry", async () => {
    const { service } = setup({ key: KEY, routes: { "GET /v1/models": [() => new Response("", { status: 503 }), () => json(200, CATALOG_BODY)] } });
    await service.loadCatalog();
    expect(service.state.get().catalog.status).toBe("error");
    await service.loadCatalog({ force: true });
    expect(service.state.get().catalog.status).toBe("ready");
  });

  it("falls back to the default when the chosen model disappears", async () => {
    const { service } = setup({ key: KEY });
    await service.loadCatalog();
    service.setModel("image", "gone");
    expect(service.selectedModel("image")?.id).toBe("img-cheap");
    service.setModel("image", "img-dear");
    expect(service.selectedModel("image")?.id).toBe("img-dear");
  });
});

describe("GenerateService.run", () => {
  it("generates an image and imports it labelled with its prompt and model", async () => {
    const { service, imported } = setup({ key: KEY, routes: { "POST /v1/images/generations": () => json(200, { data: [{ b64_json: PNG_B64 }] }) } });
    await service.loadCatalog();
    const request = service.withDefaults({ kind: "image", model: service.selectedModel("image")!, prompt: "A foggy harbor, 4k!" });
    expect(request.size).toBe("1024x1024");
    const outcome = await service.run(request);
    expect(outcome.ok).toBe(true);
    expect(imported).toHaveLength(1);
    expect(imported[0]?.file.name).toBe("generated-a-foggy-harbor-4k.png");
    expect(imported[0]?.file.type).toBe("image/png");
    expect(imported[0]?.generated).toEqual({ prompt: "A foggy harbor, 4k!", model: "img-cheap", provider: "Surplus Intelligence", createdAt: "2026-10-13T12:00:00.000Z" });
    expect(service.state.get()).toMatchObject({ job: null, error: null, result: { assetId: "asset-1", kind: "image" } });
  });

  it("surfaces an out-of-credit failure and imports nothing", async () => {
    const { service, imported } = setup({ key: KEY, routes: { "POST /v1/images/generations": () => json(402, { error: { code: "insufficient_credit", message: "top up" } }) } });
    await service.loadCatalog();
    const outcome = await service.run(service.withDefaults({ kind: "image", model: service.selectedModel("image")!, prompt: "x" }));
    expect(outcome).toMatchObject({ ok: false, code: "insufficient-credit" });
    expect(imported).toHaveLength(0);
    expect(service.state.get().error).toMatch(/Not enough Surplus credit/);
    expect(service.state.get().job).toBeNull();
  });

  it("refuses without a project and while another generation runs", async () => {
    const noProject = setup({ key: KEY, hasProject: false });
    await noProject.service.loadCatalog();
    expect(await noProject.service.run({ kind: "image", model: noProject.service.selectedModel("image")!, prompt: "x" })).toMatchObject({ ok: false, code: "no-project" });

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const busy = setup({ key: KEY, routes: { "POST /v1/images/generations": async () => { await gate; return json(200, { data: [{ b64_json: PNG_B64 }] }); } } });
    await busy.service.loadCatalog();
    const request = { kind: "image" as const, model: busy.service.selectedModel("image")!, prompt: "x" };
    const first = busy.service.run(request);
    expect(await busy.service.run(request)).toMatchObject({ ok: false, code: "busy" });
    release();
    expect((await first).ok).toBe(true);
  });

  it("reports a failed import honestly, noting the generation may have been billed", async () => {
    const { service } = setup({ key: KEY, importFails: true, routes: { "POST /v1/images/generations": () => json(200, { data: [{ b64_json: PNG_B64 }] }, { "x-si-buyer-cost-micro": "10000" }) } });
    await service.loadCatalog();
    const outcome = await service.run(service.withDefaults({ kind: "image", model: service.selectedModel("image")!, prompt: "x" }));
    expect(outcome).toMatchObject({ ok: false, code: "import" });
    expect(outcome.ok === false && outcome.error).toMatch(/Storage is full.*billed/);
  });

  it("cancel aborts a running video job without surfacing an error banner", async () => {
    const { service, net } = setup({
      key: KEY,
      routes: {
        "POST /v1/video/generations": () => json(202, { id: "j", status: "queued", poll_url: "/v1/video/generations/j", job_token: "t", expires_at: 4_102_444_800 }),
        "GET /v1/video/generations/j": () => { service.cancel(); return json(202, { id: "j", status: "running" }); },
        "DELETE /v1/video/generations/j": () => json(200, {}),
      },
    });
    await service.loadCatalog();
    const outcome = await service.run(service.withDefaults({ kind: "video", model: service.selectedModel("video")!, prompt: "waves" }));
    expect(outcome).toMatchObject({ ok: false, code: "cancelled" });
    expect(service.state.get().error).toBeNull();
    expect(net.calls.some((c) => c.method === "DELETE")).toBe(true);
  });
});

describe("agent wiring", () => {
  it("quotes the catalog price and refuses an agent call above the allowance", async () => {
    const { service } = setup({ key: KEY });
    await service.loadCatalog();
    const deps = generateDeps(service, () => undefined);
    expect(deps.prepare({ kind: "image", prompt: "x" })).toMatchObject({ modelId: "img-cheap", costText: "$0.01" });
    const dear = deps.prepare({ kind: "image", prompt: "x", model: "img-dear" });
    expect(dear).toMatchObject({ modelId: "img-dear", refusal: expect.stringContaining("above the $1.00") });
    expect(deps.prepare({ kind: "video", prompt: "x" })).toMatchObject({ costText: "About $0.32" });
    expect(deps.prepare({ kind: "image", prompt: "x", model: "nope" })).toMatchObject({ error: expect.stringContaining("nope"), hint: expect.stringContaining("img-cheap") });
  });

  it("does not offer prices before the catalog loads", () => {
    const { service } = setup({ key: KEY });
    expect(generateDeps(service, () => undefined).prepare({ kind: "image", prompt: "x" })).toHaveProperty("error");
  });

  it("generates through the shared service and reports the charge", async () => {
    const { service, imported } = setup({ key: KEY, routes: { "POST /v1/images/generations": () => json(200, { data: [{ b64_json: PNG_B64 }] }, { "x-si-buyer-cost-micro": "10000" }) } });
    await service.loadCatalog();
    const made = await generateDeps(service, () => undefined).generate({ kind: "image", prompt: "a cat" });
    expect(made).toMatchObject({ assetId: "asset-1", type: "image", chargeText: expect.stringContaining("$0.01") });
    expect(imported).toHaveLength(1);
    const failing = setup({ key: KEY, routes: { "POST /v1/images/generations": () => bytes("", "text/plain", 500) } });
    await failing.service.loadCatalog();
    await expect(generateDeps(failing.service, () => undefined).generate({ kind: "image", prompt: "a cat" })).rejects.toThrow(/unavailable/);
  });
});
