import type { WrappedAudioBuffer } from "mediabunny";
import { denoiseChannels, mixDenoised, noiseFloorDb } from "#/engine/audio";
import { sharedRnnoise, type RnnoiseRuntime } from "./rnnoise";

/**
 * Channel-minutes of audio one asset may hold in memory after denoising (stereo counts double): 10 minutes is about 115 MB
 * of floats at 48 kHz, and peak use while processing is two to four times that.
 */
export const MAX_DENOISE_CHANNEL_SECONDS = 10 * 60;

export class DenoiseTooLongError extends Error {
  constructor(seconds: number) {
    super(`Noise removal supports up to ${MAX_DENOISE_CHANNEL_SECONDS / 60} channel-minutes of audio per file (stereo counts double); this file has ${Math.round(seconds / 60)}.`);
    this.name = "DenoiseTooLongError";
  }
}

/** The source a clip schedules from: anything that yields decoded buffers for a source-time window. */
export interface BufferSource {
  buffers(startTimestamp?: number, endTimestamp?: number): AsyncGenerator<WrappedAudioBuffer, void, unknown>;
}

export interface DenoisedAudio {
  sampleRate: number;
  /** Fully denoised channels, indexed by `round(timestamp * sampleRate)`. */
  channels: Float32Array[];
  /** Estimated noise floor (dBFS) of the source and of the fully denoised signal. */
  noiseFloorDb: { before: number; after: number };
}

export type DenoiseStatus =
  | { state: "idle" }
  | { state: "running"; progress: number }
  | { state: "ready"; noiseFloorDb: { before: number; after: number } }
  | { state: "error"; message: string };

interface Entry {
  status: DenoiseStatus;
  promise: Promise<DenoisedAudio> | null;
  result: DenoisedAudio | null;
  controller: AbortController;
}

export interface DenoiseCacheDeps {
  runtime?: () => Promise<RnnoiseRuntime>;
  yieldNow?: () => Promise<void>;
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const IDLE: DenoiseStatus = { state: "idle" };

/**
 * Denoised copies of whole audio sources, keyed by the media blob so a preview and an export of the same file share one
 * result. The strength-1 signal is stored; partial strength is a dry/wet mix applied while scheduling, so moving the
 * slider never recomputes anything. Entries are released with `release(blob)` by the owner of the blob.
 */
export class DenoiseCache {
  private readonly entries = new Map<Blob, Entry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: DenoiseCacheDeps = {}) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  status(blob: Blob | undefined): DenoiseStatus {
    return (blob && this.entries.get(blob)?.status) || IDLE;
  }

  /** The finished result, or undefined while it is not ready (never starts work). */
  peek(blob: Blob): DenoisedAudio | undefined {
    return this.entries.get(blob)?.result ?? undefined;
  }

  /** Starts (once) and awaits the denoised audio of `source`. A failed run can be retried by calling again. */
  ensure(blob: Blob, source: BufferSource): Promise<DenoisedAudio> {
    const existing = this.entries.get(blob);
    if (existing?.promise) return existing.promise;
    const entry: Entry = { status: { state: "running", progress: 0 }, promise: null, result: null, controller: new AbortController() };
    this.entries.set(blob, entry);
    entry.promise = this.run(entry, source).then(
      (result) => {
        entry.result = result;
        this.set(entry, { state: "ready", noiseFloorDb: result.noiseFloorDb });
        return result;
      },
      (error: unknown) => {
        entry.promise = null;
        if (this.entries.get(blob) === entry) this.set(entry, { state: "error", message: error instanceof Error ? error.message : String(error) });
        throw error;
      },
    );
    entry.promise.catch(() => undefined);
    this.emit();
    return entry.promise;
  }

  release(blob: Blob | undefined): void {
    if (!blob) return;
    const entry = this.entries.get(blob);
    if (!entry) return;
    entry.controller.abort();
    this.entries.delete(blob);
    this.emit();
  }

  dispose(): void {
    for (const blob of [...this.entries.keys()]) this.release(blob);
    this.listeners.clear();
  }

  private set(entry: Entry, status: DenoiseStatus): void {
    entry.status = status;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private async run(entry: Entry, source: BufferSource): Promise<DenoisedAudio> {
    const { signal } = entry.controller;
    const decoded = await decodeAll(source, signal);
    const runtime = await (this.deps.runtime ?? sharedRnnoise)();
    const wet = await denoiseChannels({
      channels: decoded.channels, sampleRate: decoded.sampleRate, signal,
      createDenoiser: () => runtime.createDenoiser(),
      yieldNow: this.deps.yieldNow ?? macrotask,
      onProgress: (fraction) => this.set(entry, { state: "running", progress: fraction }),
    });
    return {
      sampleRate: decoded.sampleRate, channels: wet,
      noiseFloorDb: {
        before: noiseFloorDb({ channels: decoded.channels, sampleRate: decoded.sampleRate }),
        after: noiseFloorDb({ channels: wet, sampleRate: decoded.sampleRate }),
      },
    };
  }
}

async function decodeAll(source: BufferSource, signal: AbortSignal): Promise<Pick<DenoisedAudio, "sampleRate" | "channels">> {
  const chunks: Array<{ index: number; data: Float32Array[] }> = [];
  let sampleRate = 0;
  let channelCount = 0;
  let length = 0;
  for await (const wrapped of source.buffers()) {
    signal.throwIfAborted();
    const buffer = wrapped.buffer;
    sampleRate = buffer.sampleRate;
    channelCount = buffer.numberOfChannels;
    const index = Math.round(wrapped.timestamp * sampleRate);
    const data = Array.from({ length: channelCount }, (_, c) => Float32Array.from(buffer.getChannelData(c)));
    chunks.push({ index, data });
    length = Math.max(length, index + buffer.length);
    if ((length / sampleRate) * channelCount > MAX_DENOISE_CHANNEL_SECONDS) throw new DenoiseTooLongError((length / sampleRate) * channelCount);
  }
  if (chunks.length === 0 || sampleRate === 0) throw new Error("This media has no decodable audio to clean up");
  const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
  for (const chunk of chunks) chunk.data.forEach((samples, c) => (channels[c] as Float32Array).set(samples, chunk.index));
  return { sampleRate, channels };
}

export interface DenoisedSourceDeps {
  makeBuffer: (input: { length: number; numberOfChannels: number; sampleRate: number }) => AudioBuffer;
}

/** `base` buffers with the clip's dry/wet mix applied: what both live playback and the export mix schedule. */
export function denoisedSource(input: { base: BufferSource; audio: DenoisedAudio; strength: number; makeBuffer?: DenoisedSourceDeps["makeBuffer"] }): BufferSource {
  const make = input.makeBuffer ?? ((o) => new AudioBuffer(o));
  return {
    async *buffers(startTimestamp?: number, endTimestamp?: number) {
      for await (const wrapped of input.base.buffers(startTimestamp, endTimestamp)) {
        const { buffer } = wrapped;
        const offset = Math.round(wrapped.timestamp * input.audio.sampleRate);
        const out = make({ length: buffer.length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const wet = (input.audio.channels[Math.min(c, input.audio.channels.length - 1)] as Float32Array).subarray(offset, offset + buffer.length);
          const mixed = new Float32Array(buffer.length);
          mixDenoised({ dry: buffer.getChannelData(c), wet, strength: input.strength, out: mixed });
          out.copyToChannel(mixed, c);
        }
        yield { ...wrapped, buffer: out };
      }
    },
  };
}

export const sharedDenoiseCache = new DenoiseCache();
