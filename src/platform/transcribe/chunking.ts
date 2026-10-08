import type { TranscriptWord } from "#/engine/transcript/types";

export const WHISPER_SAMPLE_RATE = 16_000;
/** Each window handed to Whisper is the 20 s "core" plus 5 s of context on both sides: 30 s, Whisper's native window. */
export const CORE_SECONDS = 20;
export const OVERLAP_SECONDS = 5;

export interface AudioChunk {
  index: number;
  /** Absolute time of `samples[0]` in the source. */
  startSeconds: number;
  samples: Float32Array;
  /** Words whose midpoint falls in [coreStartSeconds, coreEndSeconds) belong to this chunk. */
  coreStartSeconds: number;
  coreEndSeconds: number;
}

export interface ChunkWords {
  coreStartSeconds: number;
  coreEndSeconds: number;
  /** Absolute (source-time) words. */
  words: TranscriptWord[];
}

interface AssemblerOptions {
  sampleRate?: number;
  coreSeconds?: number;
  overlapSeconds?: number;
}

/**
 * Cuts a stream of mono samples into overlapping windows without holding the whole recording:
 * samples before the next window are dropped as soon as a window is emitted.
 */
export class ChunkAssembler {
  private readonly sampleRate: number;
  private readonly core: number;
  private readonly overlap: number;
  private buffer = new Float32Array(0);
  private bufferStart = 0;
  private received = 0;
  private next = 0;

  constructor(options: AssemblerOptions = {}) {
    this.sampleRate = options.sampleRate ?? WHISPER_SAMPLE_RATE;
    this.core = Math.round((options.coreSeconds ?? CORE_SECONDS) * this.sampleRate);
    this.overlap = Math.round((options.overlapSeconds ?? OVERLAP_SECONDS) * this.sampleRate);
  }

  push(samples: Float32Array): AudioChunk[] {
    const merged = new Float32Array(this.buffer.length + samples.length);
    merged.set(this.buffer);
    merged.set(samples, this.buffer.length);
    this.buffer = merged;
    this.received += samples.length;
    const ready: AudioChunk[] = [];
    while (this.received >= (this.next + 1) * this.core + this.overlap) ready.push(this.take(this.next));
    return ready;
  }

  /** Emits the remaining windows; call once after the last `push`. */
  finish(): AudioChunk[] {
    const rest: AudioChunk[] = [];
    while (this.next * this.core < this.received) rest.push(this.take(this.next));
    return rest;
  }

  private take(index: number): AudioChunk {
    const coreStart = index * this.core;
    const coreEnd = (index + 1) * this.core;
    const from = Math.max(0, coreStart - this.overlap);
    const to = Math.min(this.received, coreEnd + this.overlap);
    const samples = this.buffer.slice(from - this.bufferStart, to - this.bufferStart);
    const chunk: AudioChunk = {
      index,
      startSeconds: from / this.sampleRate,
      samples,
      coreStartSeconds: coreStart / this.sampleRate,
      coreEndSeconds: coreEnd < this.received ? coreEnd / this.sampleRate : Infinity,
    };
    this.next = index + 1;
    const keepFrom = Math.max(0, this.next * this.core - this.overlap);
    if (keepFrom > this.bufferStart) {
      this.buffer = this.buffer.slice(keepFrom - this.bufferStart);
      this.bufferStart = keepFrom;
    }
    return chunk;
  }
}

/** Joins per-window words into one ordered list; each word is kept only by the window whose core contains its midpoint. */
export function mergeChunkWords(chunks: ReadonlyArray<ChunkWords>): TranscriptWord[] {
  const kept: TranscriptWord[] = [];
  for (const chunk of chunks) {
    for (const word of chunk.words) {
      const mid = (word.startSeconds + word.endSeconds) / 2;
      if (mid >= chunk.coreStartSeconds && mid < chunk.coreEndSeconds) kept.push(word);
    }
  }
  return kept.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
}
