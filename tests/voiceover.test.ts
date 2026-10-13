import { describe, expect, it } from "vitest";
import { callTool, createVoiceoverTools, type AgentTool } from "#/engine/agent";
import { encodeWav } from "#/engine/audio";
import { currentScene } from "#/engine/commands";
import type { MediaAssetInfo } from "#/engine/model";
import { sceneViolations } from "#/engine/timeline";
import {
  MAX_VOICEOVER_CHARS, normalizeForSpeech, numberToWords, planPassages, synthesizeVoiceover, type SpeechEngine,
} from "#/engine/voiceover";
import { makeEditor, sec } from "./helpers";

const RATE = 16_000;

/** One second of a 220 Hz tone per 10 characters, so durations are predictable. */
const toneEngine = (seen: string[] = []): SpeechEngine => ({
  async synthesize({ text, voiceId }) {
    seen.push(`${voiceId}:${text}`);
    const length = Math.round((text.length / 10) * RATE);
    return { sampleRate: RATE, samples: Float32Array.from({ length }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE)) };
  },
});

describe("speech text planning", () => {
  it("spells out numbers, percent and ampersands", () => {
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(42)).toBe("forty-two");
    expect(numberToWords(1999)).toBe("one thousand nine hundred ninety-nine");
    expect(normalizeForSpeech("Save 20% & get 3,500 points")).toBe("Save twenty percent and get three thousand five hundred points");
  });

  it("splits at sentences, then clauses, then words, never beyond the limit", () => {
    const text = "First sentence here. Second one is a little longer, with a comma, and then some more words to push it over the limit for sure. Third!";
    const passages = planPassages(text, 60);
    expect(passages[0]).toBe("First sentence here.");
    expect(passages.at(-1)).toBe("Third!");
    for (const p of passages) expect(p.length).toBeLessThanOrEqual(60);
    expect(passages.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    expect(planPassages("...  !!! ")).toEqual([]);
    const oneLongWord = planPassages("a".repeat(100), 30);
    expect(oneLongWord.length).toBeGreaterThanOrEqual(1);
  });
});

describe("synthesizeVoiceover", () => {
  it("joins passages with pauses, reports progress, and applies speed with pitch preserved", async () => {
    const seen: string[] = [];
    const progress: number[] = [];
    const base = await synthesizeVoiceover({ engine: toneEngine(seen), text: "Hello there. How are you doing today?", voiceId: "slt", speed: 1, onProgress: (f) => progress.push(f) });
    expect(seen).toEqual(["slt:Hello there.", "slt:How are you doing today?"]);
    expect(progress).toEqual([0.5, 1]);
    const expected = ((12 + 24) / 10) * RATE + 0.28 * RATE;
    expect(Math.abs(base.samples.length - expected)).toBeLessThan(2);
    const fast = await synthesizeVoiceover({ engine: toneEngine(), text: "Hello there. How are you doing today?", voiceId: "slt", speed: 2 });
    expect(fast.samples.length / base.samples.length).toBeGreaterThan(0.45);
    expect(fast.samples.length / base.samples.length).toBeLessThan(0.55);
  });

  it("validates its inputs", async () => {
    await expect(synthesizeVoiceover({ engine: toneEngine(), text: "x".repeat(MAX_VOICEOVER_CHARS + 1), voiceId: "slt", speed: 1 })).rejects.toThrow(/limited/);
    await expect(synthesizeVoiceover({ engine: toneEngine(), text: "hi", voiceId: "slt", speed: 3 })).rejects.toThrow(/Speed/);
    await expect(synthesizeVoiceover({ engine: toneEngine(), text: "?!", voiceId: "slt", speed: 1 })).rejects.toThrow(/nothing to say/i);
  });
});

describe("encodeWav", () => {
  it("writes a canonical 16-bit PCM header and clipped samples", () => {
    const bytes = encodeWav({ channels: [Float32Array.from([0, 1, -1, 2])], sampleRate: 16_000 });
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
  });
});

describe("generate_voiceover", () => {
  function setup(engine: SpeechEngine = toneEngine()) {
    const { editor } = makeEditor();
    const imported: Array<{ name: string; bytes: number }> = [];
    const tools = new Map<string, AgentTool>(createVoiceoverTools({
      engine,
      async importAudio({ name, wav }) {
        imported.push({ name, bytes: wav.length });
        const seconds = (wav.length - 44) / 2 / RATE;
        const asset: MediaAssetInfo = { id: `vo${imported.length}`, name, type: "audio", size: wav.length, lastModified: 0, duration: sec(seconds) };
        editor.registerAsset(asset);
        return asset;
      },
    }).map((t) => [t.name, t]));
    const call = (name: string, args: unknown = {}) => callTool({ tools, name, args, ctx: { editor, nowMs: () => 0 } });
    return { editor, imported, call };
  }

  it("synthesizes, stores a WAV asset and places an audio clip of the right length in one undo step", async () => {
    const h = setup();
    const doc = h.editor.getState().doc;
    const result = await h.call("generate_voiceover", { text: "Welcome to the show.", start: 1 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const clip = currentScene(h.editor.getState().doc).tracks.audio[0]?.elements[0];
    expect(clip?.type).toBe("audio");
    expect(clip?.startTime).toBe(sec(1));
    expect(clip?.duration).toBe(sec(2));
    expect(h.imported[0]?.name).toBe("Voice-over: Welcome to the show..wav");
    expect(sceneViolations(currentScene(h.editor.getState().doc))).toEqual([]);
    h.editor.undo();
    expect(currentScene(h.editor.getState().doc).tracks.audio.flatMap((t) => t.elements)).toHaveLength(0);
    expect(h.editor.getState().doc.assets.length).toBe(doc.assets.length + 1);
  });

  it("lists voices, rejects unknown ones and surfaces engine failures without editing", async () => {
    const h = setup();
    const voices = await h.call("list_voices");
    expect(voices.ok && (voices.data as { voices: unknown[] }).voices.length).toBeGreaterThan(3);
    const bad = await h.call("generate_voiceover", { text: "hi", voice: "nope" });
    expect(bad.ok).toBe(false);
    const failing = setup({ synthesize: async () => { throw new Error("The speech model is not downloaded and the user has not approved the download."); } });
    const result = await failing.call("generate_voiceover", { text: "hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not approved/);
    expect(failing.imported).toHaveLength(0);
  });
});
