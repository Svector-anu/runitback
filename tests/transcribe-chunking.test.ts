import { describe, expect, it } from "vitest";
import { ChunkAssembler, WHISPER_SAMPLE_RATE, mergeChunkWords, type AudioChunk, type ChunkWords } from "#/platform/transcribe";
import { createWhisperEngine, wordsFromPipelineOutput, type AsrPipeline } from "#/platform/transcribe";

const RATE = WHISPER_SAMPLE_RATE;
const ramp = (seconds: number, from = 0): Float32Array => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => from + i);

function assemble(totalSeconds: number, pushSeconds: number): AudioChunk[] {
  const assembler = new ChunkAssembler();
  const chunks: AudioChunk[] = [];
  for (let t = 0; t < totalSeconds; t += pushSeconds) {
    const length = Math.min(pushSeconds, totalSeconds - t);
    chunks.push(...assembler.push(ramp(length, Math.round(t * RATE))));
  }
  chunks.push(...assembler.finish());
  return chunks;
}

describe("ChunkAssembler", () => {
  it("emits nothing for empty input", () => {
    expect(assemble(0, 10)).toEqual([]);
  });

  it("keeps a short recording in one window whose core is unbounded", () => {
    const [only, ...rest] = assemble(12, 4);
    expect(rest).toEqual([]);
    expect(only?.samples.length).toBe(12 * RATE);
    expect(only?.coreStartSeconds).toBe(0);
    expect(only?.coreEndSeconds).toBe(Infinity);
  });

  it("windows are 30 s with 5 s of context and cores tile the timeline exactly", () => {
    const chunks = assemble(65, 7);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((c) => c.coreStartSeconds)).toEqual([0, 20, 40, 60]);
    expect(chunks.map((c) => c.coreEndSeconds)).toEqual([20, 40, 60, Infinity]);
    expect(chunks.map((c) => c.startSeconds)).toEqual([0, 15, 35, 55]);
    expect(chunks.map((c) => c.samples.length / RATE)).toEqual([25, 30, 30, 10]);
  });

  it("slices the right samples regardless of how the input is pushed", () => {
    const coarse = assemble(65, 30);
    const fine = assemble(65, 1);
    expect(fine.length).toBe(coarse.length);
    fine.forEach((chunk, i) => {
      const other = coarse[i] as AudioChunk;
      expect(chunk.samples.length).toBe(other.samples.length);
      expect(chunk.samples[0]).toBe(Math.round(chunk.startSeconds * RATE));
      expect(chunk.samples[chunk.samples.length - 1]).toBe(other.samples[other.samples.length - 1]);
    });
  });
});

describe("mergeChunkWords", () => {
  const word = (text: string, start: number, end: number) => ({ text, startSeconds: start, endSeconds: end });

  it("keeps a word in the overlap exactly once, from the window that owns it", () => {
    const chunks: ChunkWords[] = [
      { coreStartSeconds: 0, coreEndSeconds: 20, words: [word("a", 1, 1.5), word("edge", 21, 21.4)] },
      { coreStartSeconds: 20, coreEndSeconds: Infinity, words: [word("edge", 21, 21.4), word("b", 30, 30.5)] },
    ];
    expect(mergeChunkWords(chunks).map((w) => w.text)).toEqual(["a", "edge", "b"]);
  });

  it("assigns a word straddling a core boundary by its midpoint", () => {
    const chunks: ChunkWords[] = [
      { coreStartSeconds: 0, coreEndSeconds: 20, words: [word("left", 19.7, 20.1)] },
      { coreStartSeconds: 20, coreEndSeconds: Infinity, words: [word("right", 19.9, 20.5)] },
    ];
    expect(mergeChunkWords(chunks).map((w) => w.text)).toEqual(["left", "right"]);
  });

  it("returns words ordered by time", () => {
    const merged = mergeChunkWords([
      { coreStartSeconds: 20, coreEndSeconds: Infinity, words: [word("late", 25, 26)] },
      { coreStartSeconds: 0, coreEndSeconds: 20, words: [word("early", 2, 3)] },
    ]);
    expect(merged.map((w) => w.text)).toEqual(["early", "late"]);
  });
});

describe("wordsFromPipelineOutput", () => {
  it("trims text, drops non-speech tags and closes open-ended words", () => {
    const words = wordsFromPipelineOutput({
      chunks: [
        { text: " Hello", timestamp: [0.1, 0.4] },
        { text: " [BLANK_AUDIO]", timestamp: [0.5, 0.9] },
        { text: " world", timestamp: [1, null] },
        { text: "  ", timestamp: [2, 2.2] },
      ],
    }, 1.2);
    expect(words).toEqual([
      { text: "Hello", startSeconds: 0.1, endSeconds: 0.4 },
      { text: "world", startSeconds: 1, endSeconds: 1.2 },
    ]);
  });

  it("tolerates malformed output", () => {
    expect(wordsFromPipelineOutput(null, 1)).toEqual([]);
    expect(wordsFromPipelineOutput({ text: "x" }, 1)).toEqual([]);
  });
});

describe("createWhisperEngine", () => {
  it("loads the pipeline once, asks for word timestamps and omits language for English-only models", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let loads = 0;
    const engine = createWhisperEngine({
      loadPipeline: async () => {
        loads++;
        const pipe: AsrPipeline = async (_audio, options) => {
          calls.push(options);
          return { chunks: [{ text: " hi", timestamp: [0, 0.2] }] };
        };
        return pipe;
      },
    });
    const input = { samples: new Float32Array(RATE), sampleRate: RATE, language: "en" };
    await engine.recognise({ ...input, model: "x/whisper-tiny.en_timestamped" });
    await engine.recognise({ ...input, model: "x/whisper-tiny.en_timestamped" });
    await engine.recognise({ ...input, model: "x/whisper-tiny" });
    expect(loads).toBe(2);
    expect(calls[0]).toEqual({ return_timestamps: "word" });
    expect(calls[2]).toEqual({ return_timestamps: "word", language: "en" });
  });

  it("retries loading after a failed load", async () => {
    let attempts = 0;
    const engine = createWhisperEngine({
      loadPipeline: async () => {
        attempts++;
        if (attempts === 1) throw new Error("offline");
        return async () => ({ chunks: [] });
      },
    });
    const input = { samples: new Float32Array(RATE), sampleRate: RATE, model: "m" };
    await expect(engine.recognise(input)).rejects.toThrow("offline");
    await expect(engine.recognise(input)).resolves.toEqual([]);
  });
});
