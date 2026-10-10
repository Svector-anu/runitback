import { describe, expect, it } from "vitest";
import type { MediaAssetInfo } from "#/engine/model";
import { STAGE_IDS, runUnderstanding, type ModelDownload, type StageId, type UnderstandEvent, type UnderstandStage } from "#/engine/understand";
import { UnderstandService, type UnderstandConsent } from "#/app/understand-service";

const video = (id: string, hasAudio = true): MediaAssetInfo => ({ id, name: `${id}.webm`, type: "video", size: 1, lastModified: 0, hasAudio });

interface Fake {
  stages: UnderstandStage[];
  log: string[];
  done: Set<string>;
  failing: Set<StageId>;
  gates: Partial<Record<StageId, Promise<void>>>;
}

function fakeStages(): Fake {
  const fake: Fake = { stages: [], log: [], done: new Set(), failing: new Set(), gates: {} };
  fake.stages = STAGE_IDS.map((id): UnderstandStage => ({
    id,
    async has(asset) { return fake.done.has(`${asset.id}:${id}`); },
    async run({ asset, signal, onProgress }) {
      fake.log.push(`${asset.id}:${id}`);
      onProgress(0.5);
      await fake.gates[id];
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (fake.failing.has(id)) throw new Error(`${id} exploded`);
      fake.done.add(`${asset.id}:${id}`);
    },
  }));
  return fake;
}

describe("runUnderstanding", () => {
  it("runs applicable stages in order and reports monotonic overall progress", async () => {
    const fake = fakeStages();
    const events: UnderstandEvent[] = [];
    const summary = await runUnderstanding({ asset: video("a"), stages: fake.stages, signal: new AbortController().signal, onEvent: (e) => events.push(e) });
    expect(fake.log).toEqual(["a:analysis", "a:transcript", "a:visual", "a:faces"]);
    expect(Object.values(summary.outcomes)).toEqual(["done", "done", "done", "done"]);
    const overall = events.map((e) => e.overall);
    expect([...overall].sort((x, y) => x - y)).toEqual(overall);
    expect(overall.at(-1)).toBe(1);
  });

  it("skips the transcript for silent video", async () => {
    const fake = fakeStages();
    const summary = await runUnderstanding({ asset: video("a", false), stages: fake.stages, signal: new AbortController().signal });
    expect(fake.log).toEqual(["a:analysis", "a:visual", "a:faces"]);
    expect(summary.outcomes.transcript).toBe("not-applicable");
  });

  it("skips stages that are already stored (resume)", async () => {
    const fake = fakeStages();
    fake.done.add("a:analysis");
    fake.done.add("a:visual");
    const summary = await runUnderstanding({ asset: video("a"), stages: fake.stages, signal: new AbortController().signal });
    expect(fake.log).toEqual(["a:transcript", "a:faces"]);
    expect(summary.outcomes).toMatchObject({ analysis: "skipped", visual: "skipped", transcript: "done", faces: "done" });
  });

  it("records a failing stage and still runs the rest", async () => {
    const fake = fakeStages();
    fake.failing.add("transcript");
    const summary = await runUnderstanding({ asset: video("a"), stages: fake.stages, signal: new AbortController().signal });
    expect(summary.outcomes).toMatchObject({ analysis: "done", transcript: "failed", visual: "done", faces: "done" });
    expect(summary.errors).toEqual({ transcript: "transcript exploded" });
    expect(summary.cancelled).toBe(false);
  });

  it("stops at the stage that was running when cancelled and leaves later stages not-run", async () => {
    const fake = fakeStages();
    const controller = new AbortController();
    let release: () => void = () => undefined;
    fake.gates.transcript = new Promise<void>((resolve) => { release = resolve; });
    const run = runUnderstanding({ asset: video("a"), stages: fake.stages, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    release();
    const summary = await run;
    expect(summary.outcomes).toMatchObject({ analysis: "done", transcript: "cancelled", visual: "not-run", faces: "not-run" });
    expect(summary.cancelled).toBe(true);
    expect(fake.log).toEqual(["a:analysis", "a:transcript"]);
  });

  it("reports an unwired stage as failed without throwing", async () => {
    const summary = await runUnderstanding({ asset: video("a"), stages: [], signal: new AbortController().signal });
    expect(summary.outcomes.analysis).toBe("failed");
  });
});

function setupService(assets: MediaAssetInfo[], approved = false) {
  const fake = fakeStages();
  const downloads: ModelDownload[] = [
    { stage: "transcript", model: "whisper", approxMegabytes: 50 },
    { stage: "visual", model: "clip", approxMegabytes: 156 },
  ];
  let granted = approved;
  const consent: UnderstandConsent = {
    async pending(stages) { return granted ? [] : downloads.filter((d) => stages.includes(d.stage)); },
    grant() { granted = true; },
  };
  const service = new UnderstandService({ getAsset: (id) => assets.find((a) => a.id === id), stages: fake.stages, consent });
  return { service, fake, consent };
}

describe("UnderstandService", () => {
  it("asks for one combined consent and starts nothing until it is granted", async () => {
    const { service, fake } = setupService([video("a")]);
    const outcome = await service.begin(["a"]);
    expect(outcome.status).toBe("needs-consent");
    if (outcome.status === "needs-consent") {
      expect(outcome.downloads.map((d) => d.stage)).toEqual(["transcript", "visual"]);
      service.grantConsent(outcome.downloads);
    }
    expect(fake.log).toEqual([]);
    const started = await service.begin(["a"]);
    expect(started.status).toBe("started");
    if (started.status === "started") await started.runs[0]?.completion;
    expect(fake.log).toEqual(["a:analysis", "a:transcript", "a:visual", "a:faces"]);
  });

  it("does not ask for consent when the model stages are already stored", async () => {
    const { service, fake } = setupService([video("a")]);
    fake.done.add("a:transcript");
    fake.done.add("a:visual");
    const outcome = await service.begin(["a"]);
    expect(outcome.status).toBe("started");
    if (outcome.status === "started") await outcome.runs[0]?.completion;
    expect(fake.log).toEqual(["a:analysis", "a:faces"]);
  });

  it("derives status from the stores and reports nothing-to-do when understood", async () => {
    const { service, fake } = setupService([video("a")], true);
    for (const id of STAGE_IDS) fake.done.add(`a:${id}`);
    await service.refresh([video("a")]);
    expect(service.state.get().statuses["a"]?.state).toBe("understood");
    expect((await service.begin(["a"])).status).toBe("nothing-to-do");
  });

  it("runs assets one at a time, in order, and shows the second as queued", async () => {
    const { service, fake } = setupService([video("a"), video("b")], true);
    let release: () => void = () => undefined;
    fake.gates.analysis = new Promise<void>((resolve) => { release = resolve; });
    const outcome = await service.begin(["a", "b"]);
    if (outcome.status !== "started") throw new Error("expected start");
    await new Promise((r) => setTimeout(r, 0));
    expect(service.state.get().runs["a"]?.queued).toBe(false);
    expect(service.state.get().runs["b"]?.queued).toBe(true);
    expect(fake.log).toEqual(["a:analysis"]);
    release();
    await Promise.all(outcome.runs.map((r) => r.completion));
    expect(fake.log.map((l) => l.split(":")[0])).toEqual(["a", "a", "a", "a", "b", "b", "b", "b"]);
    expect(service.state.get().runs).toEqual({});
    expect(service.state.get().statuses["b"]?.state).toBe("understood");
  });

  it("cancels a queued asset without running it, and keeps finished stages for resume", async () => {
    const { service, fake } = setupService([video("a"), video("b")], true);
    let release: () => void = () => undefined;
    fake.gates.analysis = new Promise<void>((resolve) => { release = resolve; });
    const outcome = await service.begin(["a", "b"]);
    if (outcome.status !== "started") throw new Error("expected start");
    service.cancel("b");
    service.cancel("a");
    release();
    const [a, b] = await Promise.all(outcome.runs.map((r) => r.completion));
    expect(a?.cancelled).toBe(true);
    expect(b?.outcomes.analysis).toBe("not-run");
    expect(fake.log).toEqual(["a:analysis"]);

    const resumed = await service.begin(["a"]);
    if (resumed.status !== "started") throw new Error("expected start");
    await resumed.runs[0]?.completion;
    expect(fake.log).toEqual(["a:analysis", "a:analysis", "a:transcript", "a:visual", "a:faces"]);
  });

  it("keeps a stage failure as the reason for a partial status", async () => {
    const { service, fake } = setupService([video("a")], true);
    fake.failing.add("faces");
    const outcome = await service.begin(["a"]);
    if (outcome.status !== "started") throw new Error("expected start");
    await outcome.runs[0]?.completion;
    const state = service.state.get();
    expect(state.statuses["a"]?.state).toBe("partial");
    expect(state.failures["a"]).toEqual({ faces: "faces exploded" });
  });

  it("joins a request for an asset that is already running instead of starting twice", async () => {
    const { service, fake } = setupService([video("a")], true);
    let release: () => void = () => undefined;
    fake.gates.analysis = new Promise<void>((resolve) => { release = resolve; });
    const first = await service.start("a");
    const second = await service.start("a");
    release();
    if (first.status !== "started" || second.status !== "started") throw new Error("expected start");
    await Promise.all([first.completion, second.completion]);
    expect(fake.log.filter((l) => l === "a:analysis")).toHaveLength(1);
  });
});
