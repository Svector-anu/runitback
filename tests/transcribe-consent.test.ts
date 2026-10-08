import { describe, expect, it } from "vitest";
import { callTool, createTranscriptTools } from "#/engine/agent";
import { TRANSCRIPT_VERSION, createMemoryTranscriptStore, type Transcriber, type Transcript } from "#/engine/transcript";
import { PrefsStore } from "#/platform/prefs";
import { WHISPER_SAMPLE_RATE, createWhisperTranscriber, type WhisperBackend } from "#/platform/transcribe";
import { ConsentRequiredError, TRANSCRIBE_CONSENT_PREF, TranscribeService } from "#/app/transcribe-service";
import { makeEditor } from "./helpers";
import { ASSETS } from "./agent-harness";

const memoryPrefs = (): PrefsStore => {
  const data = new Map<string, string>();
  return new PrefsStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
};

const result = (assetId: string): Transcript => ({
  version: TRANSCRIPT_VERSION, assetId, language: "en", model: "whisper-tiny.en", words: [{ text: "hi", startSeconds: 0, endSeconds: 0.3 }],
});

function setup(options: { cached?: boolean } = {}) {
  const runs: string[] = [];
  const store = createMemoryTranscriptStore();
  const prefs = memoryPrefs();
  const inner: Transcriber = {
    async transcribe({ assetId, onProgress }) {
      runs.push(assetId);
      onProgress?.(0.5);
      return result(assetId);
    },
  };
  const service = new TranscribeService({ store, transcriber: () => inner, prefs, model: "m/whisper-tiny.en", isModelCached: async () => options.cached === true });
  return { service, store, prefs, runs };
}

describe("TranscribeService consent gate", () => {
  it("refuses to run (and never touches the transcriber) until the user consents", async () => {
    const { service, runs } = setup();
    expect(await service.needsConsent()).toBe(true);
    await expect(service.gatedTranscriber.transcribe({ assetId: "a1" })).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(await service.begin("a1")).toEqual({ status: "needs-consent" });
    expect(runs).toEqual([]);
  });

  it("runs after consent is granted, persists consent via prefs, and saves the transcript", async () => {
    const { service, store, prefs, runs } = setup();
    service.grantConsent();
    expect(prefs.read(TRANSCRIBE_CONSENT_PREF, "", (v): v is string => typeof v === "string")).toBe("m/whisper-tiny.en");
    const outcome = await service.begin("a1");
    expect(outcome.status).toBe("done");
    expect(runs).toEqual(["a1"]);
    expect((await store.get("a1"))?.words).toHaveLength(1);
    expect(await service.needsConsent()).toBe(false);
  });

  it("does not ask again when the model is already cached on the device", async () => {
    const { service, runs } = setup({ cached: true });
    expect(await service.needsConsent()).toBe(false);
    expect((await service.begin("a1")).status).toBe("done");
    expect(runs).toEqual(["a1"]);
  });

  it("consent for a different model does not carry over", async () => {
    const { service, prefs } = setup();
    prefs.write(TRANSCRIBE_CONSENT_PREF, "other/model");
    expect(await service.needsConsent()).toBe(true);
  });

  it("tracks progress while running and clears it afterwards", async () => {
    const { service } = setup();
    service.grantConsent();
    const seen: number[] = [];
    service.state.subscribe(() => { const v = service.state.get().jobs.a1; if (v !== undefined) seen.push(v); });
    await service.begin("a1");
    expect(seen).toContain(0.5);
    expect(service.state.get().jobs).toEqual({});
  });

  it("maps an abort to a cancelled outcome", async () => {
    const store = createMemoryTranscriptStore();
    const service = new TranscribeService({
      store, prefs: memoryPrefs(), model: "m", isModelCached: async () => true,
      transcriber: () => ({ transcribe: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))) }),
    });
    const pending = service.begin("a1");
    await new Promise((r) => setTimeout(r, 0));
    service.cancel("a1");
    expect(await pending).toEqual({ status: "cancelled" });
    expect(service.state.get().jobs).toEqual({});
  });

  it("the agent's transcribe_asset tool fails with a message telling it to ask the user, and nothing is downloaded", async () => {
    const { service, runs } = setup();
    const { editor } = makeEditor({ assets: ASSETS });
    const tools = new Map(createTranscriptTools({ store: service.store, transcriber: service.gatedTranscriber }).map((t) => [t.name, t]));
    const out = await callTool({ tools, name: "transcribe_asset", args: { assetId: "music" }, ctx: { editor, nowMs: () => 0 } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/press Transcribe/);
    expect(runs).toEqual([]);

    service.grantConsent();
    const again = await callTool({ tools, name: "transcribe_asset", args: { assetId: "music" }, ctx: { editor, nowMs: () => 0 } });
    expect(again.ok).toBe(true);
    expect(runs).toEqual(["music"]);
  });
});

describe("createWhisperTranscriber with a fake backend", () => {
  const RATE = WHISPER_SAMPLE_RATE;
  const source = (seconds: number) => async () => ({
    durationSeconds: seconds,
    async *blocks() { for (let t = 0; t < seconds; t += 30) yield new Float32Array(Math.round(Math.min(30, seconds - t) * RATE)); },
    dispose() {},
  });

  function fakeBackend(log: { windows: number; disposed: number }): WhisperBackend {
    return {
      async recognise({ samples }) {
        log.windows++;
        return [{ text: `w${log.windows}`, startSeconds: samples.length / RATE / 2, endSeconds: samples.length / RATE / 2 + 0.2 }];
      },
      dispose() { log.disposed++; },
    };
  }

  it("windows long audio, offsets word times into source time and reports monotonic progress", async () => {
    const log = { windows: 0, disposed: 0 };
    const transcriber = createWhisperTranscriber({ getAudio: () => new Blob(), createBackend: () => fakeBackend(log), openAudio: async () => source(65)() });
    const progress: number[] = [];
    const t = await transcriber.transcribe({ assetId: "a1", onProgress: (f) => progress.push(f) });
    expect(log.windows).toBe(4);
    expect(log.disposed).toBe(1);
    expect(t.words.map((w) => w.text)).toEqual(["w1", "w2", "w3", "w4"]);
    expect(t.words[1]?.startSeconds).toBeCloseTo(15 + 15, 3);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress[progress.length - 1]).toBe(1);
    expect(t.model).toBe("whisper-tiny.en_timestamped");
  });

  it("stops and releases the worker when aborted", async () => {
    const log = { windows: 0, disposed: 0 };
    const controller = new AbortController();
    const backend: WhisperBackend = {
      recognise: async () => { controller.abort(); throw new DOMException("terminated", "AbortError"); },
      dispose() { log.disposed++; },
    };
    const transcriber = createWhisperTranscriber({ getAudio: () => new Blob(), createBackend: () => backend, openAudio: async () => source(65)() });
    await expect(transcriber.transcribe({ assetId: "a1", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(log.disposed).toBeGreaterThanOrEqual(1);
  });

  it("rejects media without audio and unknown assets", async () => {
    const t = createWhisperTranscriber({ getAudio: (id) => (id === "a1" ? new Blob() : undefined), createBackend: () => fakeBackend({ windows: 0, disposed: 0 }), openAudio: async () => null });
    await expect(t.transcribe({ assetId: "a1" })).rejects.toThrow(/no audio/);
    await expect(t.transcribe({ assetId: "zzz" })).rejects.toThrow(/not loaded/);
  });
});
