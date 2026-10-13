import { sourceWindow, type AudioClip } from "#/engine/audio";
import {
  createClipGain, createMasterChain, scheduleClipWindow, type AudioSinkCache,
} from "#/platform/audio-scheduler";

export const EXPORT_SAMPLE_RATE = 44100;
/** Length of one offline render. Peak PCM memory is bounded by this, not by the project length. */
export const MIX_CHUNK_SECONDS = 15;
/** Audio rendered before each chunk (after the first) and discarded, so the limiter has settled when the chunk starts. */
export const MIX_PREROLL_SECONDS = 0.5;

interface MixInput {
  clips: AudioClip[];
  durationSeconds: number;
  sinks: AudioSinkCache;
  sampleRate?: number;
  chunkSeconds?: number;
  signal?: AbortSignal;
}

type MixClip = { clip: AudioClip; sink: NonNullable<Awaited<ReturnType<AudioSinkCache["forClip"]>>> };

export interface AudioMix {
  sampleRate: number;
  chunkCount: number;
  /** Consecutive stereo chunks that tile [0, durationSeconds]. Each is rendered only when pulled. */
  chunks: AsyncGenerator<AudioBuffer, void, undefined>;
}

/**
 * Renders the clips through the same master limiter used in playback, one bounded chunk at a time. Each chunk is
 * its own OfflineAudioContext, started `MIX_PREROLL_SECONDS` early so the limiter state carries over the seam, and
 * the caller consumes (encodes) a chunk before the next one is rendered. Pitch preservation lives in
 * `scheduleClipWindow`, which is called unchanged, so export and live playback share one code path
 * (see tests/audio-mix.test.ts). Returns null when nothing is audible.
 */
export async function openAudioMix(input: MixInput): Promise<AudioMix | null> {
  const sampleRate = input.sampleRate ?? EXPORT_SAMPLE_RATE;
  if (input.clips.length === 0 || input.durationSeconds <= 0) return null;

  const mixClips: MixClip[] = [];
  for (const clip of input.clips) {
    input.signal?.throwIfAborted();
    const sink = await input.sinks.forClip(clip).catch(() => null);
    if (sink) mixClips.push({ clip, sink });
  }
  if (mixClips.length === 0) return null;

  const totalSamples = Math.ceil(input.durationSeconds * sampleRate);
  const chunkSamples = Math.max(1, Math.round((input.chunkSeconds ?? MIX_CHUNK_SECONDS) * sampleRate));
  const chunkCount = Math.ceil(totalSamples / chunkSamples);
  return {
    sampleRate, chunkCount,
    chunks: renderChunks({ mixClips, sampleRate, totalSamples, chunkSamples, signal: input.signal }),
  };
}

async function* renderChunks(input: {
  mixClips: MixClip[]; sampleRate: number; totalSamples: number; chunkSamples: number; signal?: AbortSignal;
}): AsyncGenerator<AudioBuffer, void, undefined> {
  const { sampleRate, totalSamples, chunkSamples } = input;
  const prerollSamples = Math.round(MIX_PREROLL_SECONDS * sampleRate);
  for (let start = 0; start < totalSamples; start += chunkSamples) {
    input.signal?.throwIfAborted();
    const end = Math.min(totalSamples, start + chunkSamples);
    const preroll = Math.min(start, prerollSamples);
    yield await renderChunk({
      mixClips: input.mixClips, sampleRate, signal: input.signal,
      renderStart: (start - preroll) / sampleRate, preroll, length: end - start,
    });
  }
}

async function renderChunk(input: {
  mixClips: MixClip[]; sampleRate: number; renderStart: number; preroll: number; length: number; signal?: AbortSignal;
}): Promise<AudioBuffer> {
  const { sampleRate, renderStart, preroll, length } = input;
  const renderEnd = renderStart + (preroll + length) / sampleRate;
  const ctx = new OfflineAudioContext(2, preroll + length, sampleRate);
  const master = createMasterChain(ctx);
  master.output.connect(ctx.destination);
  for (const { clip, sink } of input.mixClips) {
    if (!sourceWindow({ clip, from: renderStart, to: renderEnd })) continue;
    input.signal?.throwIfAborted();
    await scheduleClipWindow({
      ctx, scheduled: createClipGain(ctx, master.input), clip, sink, from: renderStart, to: renderEnd,
      toContext: (t) => t - renderStart, shouldStop: () => input.signal?.aborted === true,
    });
  }
  input.signal?.throwIfAborted();
  const rendered = await ctx.startRendering();
  if (preroll === 0) return rendered;
  const trimmed = ctx.createBuffer(rendered.numberOfChannels, length, sampleRate);
  for (let c = 0; c < rendered.numberOfChannels; c++) trimmed.copyToChannel(rendered.getChannelData(c).subarray(preroll, preroll + length), c);
  return trimmed;
}

/**
 * Whole mix as one buffer. Only suitable for short projects and tests: the result holds every sample, so the
 * exporter streams `openAudioMix` chunks instead.
 */
export async function mixTimelineAudio(input: MixInput): Promise<AudioBuffer | null> {
  const mix = await openAudioMix(input);
  if (!mix) return null;
  const parts: AudioBuffer[] = [];
  for await (const chunk of mix.chunks) parts.push(chunk);
  const [first] = parts;
  if (!first || parts.length === 1) return first ?? null;
  const joined = new AudioBuffer({
    length: parts.reduce((n, p) => n + p.length, 0), numberOfChannels: first.numberOfChannels, sampleRate: mix.sampleRate,
  });
  let offset = 0;
  for (const part of parts) {
    for (let c = 0; c < joined.numberOfChannels; c++) joined.copyToChannel(part.getChannelData(c), c, offset);
    offset += part.length;
  }
  return joined;
}
