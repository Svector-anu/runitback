import { describe, expect, it } from "vitest";
import { parseCatalog } from "#/app/generate/catalog";
import { GenerateError, POLL_MAX_MS, POLL_START_MS, checkSurplusKey, fetchCatalog, generateMedia, type GenerateRequest } from "#/app/generate/client";
import { BASE, CATALOG_BODY, KEY, PNG_B64, bytes, fakeFetch, json } from "./generate-fixtures";

const models = parseCatalog(CATALOG_BODY);
const model = (id: string) => models.find((m) => m.id === id)!;
const imageRequest: GenerateRequest = { kind: "image", model: model("img-cheap"), prompt: "a harbor", size: "1024x1024" };
const videoRequest: GenerateRequest = { kind: "video", model: model("vid-t2v"), prompt: "waves", aspectRatio: "16:9", durationSeconds: 4 };
const noSleep = async (): Promise<void> => undefined;

async function failureOf(promise: Promise<unknown>): Promise<GenerateError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GenerateError) return error;
    throw error;
  }
  throw new Error("expected a GenerateError");
}

const job = (extra: Record<string, unknown> = {}) => ({
  id: "job-1", object: "media.job", kind: "video", status: "queued", expires_at: 4_102_444_800, estimated_cost_usdc: "320000", max_cost_usdc: "640000",
  poll_url: "/v1/video/generations/job-1", job_token: "mjt_secret", ...extra,
});

describe("fetchCatalog", () => {
  it("reads the public catalog without a key", async () => {
    const { fetch, calls } = fakeFetch({ "GET /v1/models": () => json(200, CATALOG_BODY) });
    const result = await fetchCatalog({ fetch });
    expect(result.map((m) => m.id)).toContain("img-cheap");
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it("fails clearly when nothing usable comes back or the network is down", async () => {
    const empty = fakeFetch({ "GET /v1/models": () => json(200, { data: [] }) });
    expect((await failureOf(fetchCatalog({ fetch: empty.fetch }))).code).toBe("bad-response");
    const down = { fetch: (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch };
    expect((await failureOf(fetchCatalog(down))).code).toBe("network");
  });
});

describe("checkSurplusKey", () => {
  it("uses the authenticated profile endpoint, not the public catalog", async () => {
    const { fetch, calls } = fakeFetch({ "GET /v1/buyer/me": () => json(200, {}) });
    expect(await checkSurplusKey({ apiKey: KEY, fetch })).toEqual({ ok: true });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("maps a rejected key and a dead network to readable results", async () => {
    const rejected = fakeFetch({ "GET /v1/buyer/me": () => json(401, { error: { code: "unauthorized", message: "Authentication required" } }) });
    expect(await checkSurplusKey({ apiKey: KEY, fetch: rejected.fetch })).toMatchObject({ ok: false, reason: "unauthorized", message: expect.stringContaining("401") });
    const down = (async () => { throw new TypeError(`Failed to fetch ${KEY}`); }) as typeof fetch;
    const result = await checkSurplusKey({ apiKey: KEY, fetch: down });
    expect(result).toMatchObject({ ok: false, reason: "network" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("image generation", () => {
  it("posts one b64_json request with the key only in the header and returns a PNG blob", async () => {
    const { fetch, calls } = fakeFetch({ "POST /v1/images/generations": () => json(200, { data: [{ b64_json: PNG_B64 }] }, { "x-si-buyer-cost-micro": "10000" }) });
    const media = await generateMedia({ apiKey: KEY, request: imageRequest, fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body).toEqual({ model: "img-cheap", prompt: "a harbor", n: 1, response_format: "b64_json", size: "1024x1024" });
    expect(JSON.stringify(calls[0]?.body)).not.toContain(KEY);
    expect(media).toMatchObject({ kind: "image", mimeType: "image/png", extension: "png", modelId: "img-cheap", chargedUsd: 0.01 });
    expect(media.blob.size).toBeGreaterThan(40);
  });

  it("rejects data that is not an image, and an empty answer", async () => {
    const text = fakeFetch({ "POST /v1/images/generations": () => json(200, { data: [{ b64_json: btoa("not an image") }] }) });
    expect((await failureOf(generateMedia({ apiKey: KEY, request: imageRequest, fetch: text.fetch }))).code).toBe("bad-response");
    const none = fakeFetch({ "POST /v1/images/generations": () => json(200, { data: [] }) });
    expect((await failureOf(generateMedia({ apiKey: KEY, request: imageRequest, fetch: none.fetch }))).code).toBe("bad-response");
  });

  it("requires a key and a prompt before any request", async () => {
    const { fetch, calls } = fakeFetch({});
    expect((await failureOf(generateMedia({ apiKey: " ", request: imageRequest, fetch }))).code).toBe("unauthorized");
    expect((await failureOf(generateMedia({ apiKey: KEY, request: { ...imageRequest, prompt: "  " }, fetch }))).code).toBe("invalid-request");
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, { error: { code: "unauthorized", message: "bad key" } }, "unauthorized", /401/],
    [402, { error: { code: "insufficient_credit", message: "top up" } }, "insufficient-credit", /Not enough Surplus credit \(402\)/],
    [400, { error: { code: "insufficient_balance", message: "balance too low" } }, "insufficient-credit", /credit/i],
    [400, { error: { code: "invalid_request", message: "prompt rejected" } }, "invalid-request", /prompt rejected/],
    [404, { error: { code: "no_sellers_for_model", message: "none" } }, "no-sellers", /another model/],
    [429, { error: { code: "rate_limited", message: "slow" } }, "rate-limited", /429/],
    [503, { error: { code: "no_healthy_sellers", message: "none healthy" } }, "unavailable", /503/],
  ] as const)("maps HTTP %i (%j) to %s", async (status, body, code, message) => {
    const { fetch } = fakeFetch({ "POST /v1/images/generations": () => json(status, body) });
    const error = await failureOf(generateMedia({ apiKey: KEY, request: imageRequest, fetch }));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
  });

  it("never echoes the key from provider text or network errors", async () => {
    const leaky = fakeFetch({ "POST /v1/images/generations": () => json(400, { error: { code: "invalid_request", message: `key ${KEY} is odd` } }) });
    expect((await failureOf(generateMedia({ apiKey: KEY, request: imageRequest, fetch: leaky.fetch }))).message).not.toContain(KEY);
    const down = (async () => { throw new TypeError(`boom ${KEY}`); }) as typeof fetch;
    const error = await failureOf(generateMedia({ apiKey: KEY, request: imageRequest, fetch: down }));
    expect(error.code).toBe("network");
    expect(error.message).not.toContain(KEY);
  });

  it("reports cancellation without leaving a half result", async () => {
    const controller = new AbortController();
    const slow = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      controller.abort();
    })) as typeof fetch;
    expect((await failureOf(generateMedia({ apiKey: KEY, request: imageRequest, fetch: slow, signal: controller.signal }))).code).toBe("cancelled");
  });
});

describe("video generation (async job)", () => {
  const succeeded = (extra: Record<string, unknown> = {}) => json(200, {
    ...job({ status: "succeeded" }), progress: 1,
    results: [{ artifact_index: 0, url: `${BASE}/v1/media/artifacts/job-1/0`, content_type: "video/mp4", duration_seconds: 4 }],
    usage: { buyer_cost_usdc: "330000" }, ...extra,
  });

  it("submits, polls with backoff and the job token, then downloads the artifact", async () => {
    const sleeps: number[] = [];
    const progress: string[] = [];
    const { fetch, calls } = fakeFetch({
      "POST /v1/video/generations": () => json(202, job()),
      "GET /v1/video/generations/job-1": [
        () => json(202, job({ status: "queued" })),
        () => json(202, job({ status: "running", progress: 0.4 })),
        () => succeeded(),
      ],
      "GET /v1/media/artifacts/job-1/0": () => bytes("VIDEOBYTES", "video/mp4"),
    });
    const media = await generateMedia({
      apiKey: KEY, request: videoRequest, fetch, sleep: async (ms) => { sleeps.push(ms); },
      onProgress: (p) => progress.push(`${p.phase}${p.fraction === undefined ? "" : `:${p.fraction}`}`), newIdempotencyKey: () => "idem-1",
    });
    const submit = calls[0]!;
    expect(submit.headers["idempotency-key"]).toBe("idem-1");
    expect(submit.body).toEqual({ model: "vid-t2v", prompt: "waves", duration_seconds: 4, aspect_ratio: "16:9" });
    expect(calls.slice(1, 4).every((c) => c.headers["x-job-token"] === "mjt_secret" && c.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(sleeps).toEqual([POLL_START_MS, 3000, 4500]);
    expect(sleeps.every((ms) => ms <= POLL_MAX_MS)).toBe(true);
    expect(progress).toEqual(["submitting", "queued", "queued", "running:0.4", "downloading"]);
    expect(media).toMatchObject({ kind: "video", mimeType: "video/mp4", extension: "mp4", quotedUsd: 0.32, chargedUsd: 0.33 });
    expect(await media.blob.text()).toBe("VIDEOBYTES");
  });

  it("does not send our credentials to a provider-hosted artifact URL", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /v1/video/generations": () => json(202, job()),
      "GET /v1/video/generations/job-1": () => succeeded({ results: [{ url: "https://cdn.provider.example/x.mp4", content_type: "video/mp4" }] }),
      "GET https://cdn.provider.example/x.mp4": () => bytes("V", "video/mp4"),
    });
    await generateMedia({ apiKey: KEY, request: videoRequest, fetch, sleep: noSleep });
    const download = calls.find((c) => c.url.includes("provider.example"));
    expect(download).toBeDefined();
    expect(download?.headers.authorization).toBeUndefined();
    expect(download?.headers["x-job-token"]).toBeUndefined();
  });

  it.each([
    ["failed", { error: { type: "provider_error", message: "model crashed", retryable: true } }, "failed", /model crashed.*not charged.*another model/s],
    ["failed", { error: { type: "invalid_request", message: "bad prompt", retryable: false } }, "failed", /Change the prompt/],
    ["expired", {}, "expired", /expired/],
    ["canceled", {}, "cancelled", /cancelled/],
  ] as const)("surfaces a %s job", async (state, extra, code, message) => {
    const { fetch } = fakeFetch({
      "POST /v1/video/generations": () => json(202, job()),
      "GET /v1/video/generations/job-1": () => json(200, { ...job({ status: state }), ...extra }),
    });
    const error = await failureOf(generateMedia({ apiKey: KEY, request: videoRequest, fetch, sleep: noSleep }));
    expect(error.code).toBe(code);
    expect(error.message).toMatch(message);
  });

  it("explains an out-of-credit submit before any job exists", async () => {
    const { fetch, calls } = fakeFetch({ "POST /v1/video/generations": () => json(402, { error: { code: "insufficient_credit", message: "max_cost exceeds balance" } }) });
    const error = await failureOf(generateMedia({ apiKey: KEY, request: videoRequest, fetch, sleep: noSleep }));
    expect(error.code).toBe("insufficient-credit");
    expect(error.message).toContain("nothing was charged");
    expect(calls).toHaveLength(1);
  });

  it("cancels the job on the gateway when the user aborts, and polls no more", async () => {
    const controller = new AbortController();
    const { fetch, calls } = fakeFetch({
      "POST /v1/video/generations": () => json(202, job()),
      "GET /v1/video/generations/job-1": () => json(202, job({ status: "running" })),
      "DELETE /v1/video/generations/job-1": () => json(200, {}),
    });
    let sleeps = 0;
    const sleep = async (_ms: number, signal?: AbortSignal): Promise<void> => {
      if (++sleeps === 2) controller.abort();
      if (signal?.aborted) throw new GenerateError("cancelled", "Cancelled.");
    };
    const error = await failureOf(generateMedia({ apiKey: KEY, request: videoRequest, fetch, sleep, signal: controller.signal }));
    expect(error.code).toBe("cancelled");
    expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(calls[2]?.headers["x-job-token"]).toBe("mjt_secret");
  });

  it("gives up after the job's own deadline, cancels it and says nothing was lost", async () => {
    let clock = 0;
    const { fetch, calls } = fakeFetch({
      "POST /v1/video/generations": () => json(202, job({ expires_at: 600 })),
      "GET /v1/video/generations/job-1": () => json(202, job({ status: "running" })),
      "DELETE /v1/video/generations/job-1": () => json(200, {}),
    });
    const error = await failureOf(generateMedia({
      apiKey: KEY, request: videoRequest, fetch, now: () => clock, sleep: async (ms) => { clock += ms * 100; },
    }));
    expect(error.code).toBe("timeout");
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("retries transient poll failures but gives up after repeated ones", async () => {
    const flaky = fakeFetch({
      "POST /v1/video/generations": () => json(202, job()),
      "GET /v1/video/generations/job-1": [() => json(503, {}), () => succeeded()],
      "GET /v1/media/artifacts/job-1/0": () => bytes("V", "video/mp4"),
    });
    expect((await generateMedia({ apiKey: KEY, request: videoRequest, fetch: flaky.fetch, sleep: noSleep })).kind).toBe("video");
    const dead = fakeFetch({ "POST /v1/video/generations": () => json(202, job()), "GET /v1/video/generations/job-1": () => json(503, {}) });
    expect((await failureOf(generateMedia({ apiKey: KEY, request: videoRequest, fetch: dead.fetch, sleep: noSleep }))).code).toBe("unavailable");
  });

  it("refuses a download that is not the right media type", async () => {
    const { fetch } = fakeFetch({
      "POST /v1/video/generations": () => json(202, job()),
      "GET /v1/video/generations/job-1": () => succeeded({ results: [{ url: `${BASE}/v1/media/artifacts/job-1/0`, content_type: "text/html" }] }),
      "GET /v1/media/artifacts/job-1/0": () => bytes("<html>", "text/html"),
    });
    expect((await failureOf(generateMedia({ apiKey: KEY, request: videoRequest, fetch, sleep: noSleep }))).code).toBe("bad-response");
  });

  it("maps an expired artifact to a clear download error", async () => {
    const { fetch } = fakeFetch({
      "POST /v1/video/generations": () => json(202, job()),
      "GET /v1/video/generations/job-1": () => succeeded(),
      "GET /v1/media/artifacts/job-1/0": () => new Response("gone", { status: 404 }),
    });
    const error = await failureOf(generateMedia({ apiKey: KEY, request: videoRequest, fetch, sleep: noSleep }));
    expect(error).toMatchObject({ code: "download" });
    expect(error.message).toMatch(/expire/);
  });
});

describe("music and speech", () => {
  it("runs music through its own route", async () => {
    const { fetch, calls } = fakeFetch({
      "POST /v1/music/generations": () => json(202, job({ kind: "music", poll_url: "/v1/music/generations/job-1" })),
      "GET /v1/music/generations/job-1": () => json(200, { ...job({ status: "succeeded" }), results: [{ url: `${BASE}/v1/media/artifacts/job-1/0`, content_type: "audio/mpeg" }] }),
      "GET /v1/media/artifacts/job-1/0": () => bytes("MP3", "audio/mpeg"),
    });
    const media = await generateMedia({ apiKey: KEY, request: { kind: "music", model: model("mus-a"), prompt: "lofi", durationSeconds: 60 }, fetch, sleep: noSleep });
    expect(calls[0]?.url).toBe(`${BASE}/v1/music/generations`);
    expect(calls[0]?.body).toEqual({ model: "mus-a", prompt: "lofi", duration_seconds: 60 });
    expect(media).toMatchObject({ kind: "music", extension: "mp3" });
  });

  it("returns speech bytes from the synchronous route", async () => {
    const { fetch, calls } = fakeFetch({ "POST /v1/audio/speech": () => bytes("MP3", "audio/mpeg") });
    const media = await generateMedia({ apiKey: KEY, request: { kind: "speech", model: model("tts-a"), prompt: "Hello there", voice: "echo" }, fetch });
    expect(calls[0]?.body).toEqual({ model: "tts-a", input: "Hello there", response_format: "mp3", voice: "echo" });
    expect(media).toMatchObject({ kind: "speech", mimeType: "audio/mpeg", extension: "mp3" });
  });

  it("rejects an answer that is JSON instead of audio", async () => {
    const { fetch } = fakeFetch({ "POST /v1/audio/speech": () => json(200, { hello: "world" }) });
    expect((await failureOf(generateMedia({ apiKey: KEY, request: { kind: "speech", model: model("tts-a"), prompt: "Hi" }, fetch }))).code).toBe("bad-response");
  });
});
