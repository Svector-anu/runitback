import { resample } from "./resample";

/** RNNoise works on 10 ms frames of 48 kHz mono audio. */
export const DENOISE_SAMPLE_RATE = 48_000;
export const DENOISE_FRAME_SAMPLES = 480;
/** The recurrent model delays its output by one frame; the output is shifted back by this much. */
export const DENOISE_LATENCY_SAMPLES = DENOISE_FRAME_SAMPLES;
const YIELD_EVERY_FRAMES = 200;

/** One stateful denoiser per channel: feed consecutive frames of `DENOISE_FRAME_SAMPLES`, samples in [-1, 1]. */
export interface FrameDenoiser {
  process(frame: Float32Array): Float32Array;
  dispose(): void;
}

export interface DenoiseInput {
  channels: ReadonlyArray<Float32Array>;
  sampleRate: number;
  createDenoiser: () => FrameDenoiser;
  /** Lets the host breathe between batches of frames (the loop is CPU bound). */
  yieldNow?: () => Promise<void>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

function runChannel(input: { samples: Float32Array; denoiser: FrameDenoiser; signal: AbortSignal | undefined; yieldNow: () => Promise<void>; report: (done: number) => void }): Promise<Float32Array> {
  return (async () => {
    const { samples, denoiser } = input;
    const frames = Math.ceil((samples.length + DENOISE_LATENCY_SAMPLES) / DENOISE_FRAME_SAMPLES);
    const out = new Float32Array(frames * DENOISE_FRAME_SAMPLES);
    const frame = new Float32Array(DENOISE_FRAME_SAMPLES);
    for (let f = 0; f < frames; f++) {
      input.signal?.throwIfAborted();
      frame.fill(0);
      frame.set(samples.subarray(f * DENOISE_FRAME_SAMPLES, (f + 1) * DENOISE_FRAME_SAMPLES));
      out.set(denoiser.process(frame), f * DENOISE_FRAME_SAMPLES);
      if ((f + 1) % YIELD_EVERY_FRAMES === 0) {
        input.report(f + 1);
        await input.yieldNow();
      }
    }
    input.report(frames);
    return out.subarray(DENOISE_LATENCY_SAMPLES, DENOISE_LATENCY_SAMPLES + samples.length);
  })();
}

/**
 * The fully denoised signal (strength 1) for each channel, at the input's sample rate and length. Channels are
 * resampled to 48 kHz, denoised independently (each with its own recurrent state), delay-compensated and resampled
 * back. Mix with the dry signal by `mixDenoised` for partial strength.
 */
export async function denoiseChannels(input: DenoiseInput): Promise<Float32Array[]> {
  const yieldNow = input.yieldNow ?? (() => Promise.resolve());
  const total = input.channels.reduce((n, c) => n + Math.ceil(((c.length * DENOISE_SAMPLE_RATE) / input.sampleRate + DENOISE_LATENCY_SAMPLES) / DENOISE_FRAME_SAMPLES), 0);
  let finished = 0;
  const results: Float32Array[] = [];
  for (const channel of input.channels) {
    input.signal?.throwIfAborted();
    const native = input.sampleRate === DENOISE_SAMPLE_RATE;
    const at48k = native ? channel : resample({ samples: channel, fromRate: input.sampleRate, toRate: DENOISE_SAMPLE_RATE });
    const denoiser = input.createDenoiser();
    const base = finished;
    try {
      const wet = await runChannel({
        samples: at48k, denoiser, signal: input.signal, yieldNow,
        report: (done) => input.onProgress?.(Math.min(1, (base + done) / total)),
      });
      finished += Math.ceil((at48k.length + DENOISE_LATENCY_SAMPLES) / DENOISE_FRAME_SAMPLES);
      if (native) {
        results.push(wet);
      } else {
        const back = resample({ samples: wet, fromRate: DENOISE_SAMPLE_RATE, toRate: input.sampleRate });
        const aligned = new Float32Array(channel.length);
        aligned.set(back.subarray(0, channel.length));
        results.push(aligned);
      }
    } finally {
      denoiser.dispose();
    }
  }
  input.onProgress?.(1);
  return results;
}

/** `dry * (1 - strength) + wet * strength`, sample by sample, written to `out` (which may be `dry`). */
export function mixDenoised(input: { dry: Float32Array; wet: Float32Array; strength: number; out: Float32Array }): void {
  const s = Math.min(1, Math.max(0, input.strength));
  const n = Math.min(input.dry.length, input.out.length);
  for (let i = 0; i < n; i++) input.out[i] = (input.dry[i] as number) * (1 - s) + (input.wet[i] ?? 0) * s;
}

const FLOOR_WINDOW_SECONDS = 0.02;
const FLOOR_PERCENTILE = 0.1;
const FLOOR_SILENCE_DB = -120;

/**
 * Noise floor estimate in dBFS: the 10th percentile of 20 ms RMS levels, with channels averaged in power. Speech sits
 * far above it and pauses define it, so it follows what a listener hears between words.
 */
export function noiseFloorDb(input: { channels: ReadonlyArray<Float32Array>; sampleRate: number }): number {
  const frame = Math.max(1, Math.round(input.sampleRate * FLOOR_WINDOW_SECONDS));
  const length = input.channels[0]?.length ?? 0;
  const levels: number[] = [];
  for (let start = 0; start + frame <= length; start += frame) {
    let power = 0;
    for (const channel of input.channels) for (let i = start; i < start + frame; i++) power += (channel[i] as number) ** 2;
    levels.push(10 * Math.log10(Math.max(power / (frame * input.channels.length), 1e-12)));
  }
  if (levels.length === 0) return FLOOR_SILENCE_DB;
  levels.sort((a, b) => a - b);
  return levels[Math.min(levels.length - 1, Math.floor(levels.length * FLOOR_PERCENTILE))] as number;
}
