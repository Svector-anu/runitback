import type { AudioSinkCache } from "./audio-scheduler";

/** Peak buckets per second of source audio; enough to draw a clip at the highest timeline zoom. */
export const PEAKS_PER_SECOND = 100;

/** Reduces decoded audio to per-bucket peak amplitude (mono, 0..1). Pure so it can be tested. */
export function accumulatePeaks(input: {
  peaks: Float32Array; channels: ReadonlyArray<Float32Array>; sampleRate: number; startSeconds: number;
}): void {
  const { peaks, channels, sampleRate } = input;
  const length = channels[0]?.length ?? 0;
  for (let i = 0; i < length; i++) {
    const bucket = Math.floor((input.startSeconds + i / sampleRate) * PEAKS_PER_SECOND);
    if (bucket < 0 || bucket >= peaks.length) continue;
    let max = 0;
    for (const channel of channels) max = Math.max(max, Math.abs(channel[i] ?? 0));
    if (max > (peaks[bucket] as number)) peaks[bucket] = max;
  }
}

/** Resample peaks to `count` columns covering [startSeconds, endSeconds) of the source. */
export function peaksForRange(input: { peaks: Float32Array; startSeconds: number; endSeconds: number; count: number }): Float32Array {
  const out = new Float32Array(input.count);
  const span = (input.endSeconds - input.startSeconds) * PEAKS_PER_SECOND;
  if (span <= 0 || input.count <= 0) return out;
  for (let i = 0; i < input.count; i++) {
    const from = Math.floor(input.startSeconds * PEAKS_PER_SECOND + (i / input.count) * span);
    const to = Math.max(from + 1, Math.ceil(input.startSeconds * PEAKS_PER_SECOND + ((i + 1) / input.count) * span));
    let max = 0;
    for (let b = Math.max(0, from); b < Math.min(input.peaks.length, to); b++) max = Math.max(max, input.peaks[b] as number);
    out[i] = max;
  }
  return out;
}

/** Decodes each asset's audio once and keeps its peak summary. */
export class WaveformCache {
  private readonly entries = new Map<string, Promise<Float32Array | null>>();

  constructor(private readonly sinks: AudioSinkCache) {}

  get(mediaId: string, durationSeconds: number): Promise<Float32Array | null> {
    let entry = this.entries.get(mediaId);
    if (!entry) {
      entry = this.compute(mediaId, durationSeconds).catch((error: unknown) => {
        console.warn(`Could not build waveform for ${mediaId}`, error);
        return null;
      });
      this.entries.set(mediaId, entry);
    }
    return entry;
  }

  private async compute(mediaId: string, durationSeconds: number): Promise<Float32Array | null> {
    const sink = await this.sinks.get(mediaId);
    if (!sink) return null;
    const peaks = new Float32Array(Math.ceil(durationSeconds * PEAKS_PER_SECOND) + 2);
    for await (const wrapped of sink.buffers()) {
      const channels = Array.from({ length: wrapped.buffer.numberOfChannels }, (_, c) => wrapped.buffer.getChannelData(c));
      accumulatePeaks({ peaks, channels, sampleRate: wrapped.buffer.sampleRate, startSeconds: wrapped.timestamp });
    }
    return peaks;
  }

  release(mediaId: string): void {
    this.entries.delete(mediaId);
  }

  clear(): void {
    this.entries.clear();
  }
}
