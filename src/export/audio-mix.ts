import type { AudioClip } from "#/engine/audio";
import {
  createClipGain, createMasterChain, scheduleClipWindow, type AudioSinkCache,
} from "#/platform/audio-scheduler";

export const EXPORT_SAMPLE_RATE = 44100;

/** Renders every clip through the same master limiter used in playback into one stereo buffer. */
export async function mixTimelineAudio(input: {
  clips: AudioClip[]; durationSeconds: number; sinks: AudioSinkCache; sampleRate?: number; signal?: AbortSignal;
}): Promise<AudioBuffer | null> {
  const sampleRate = input.sampleRate ?? EXPORT_SAMPLE_RATE;
  if (input.clips.length === 0 || input.durationSeconds <= 0) return null;
  const length = Math.ceil(input.durationSeconds * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const master = createMasterChain(ctx);
  master.output.connect(ctx.destination);

  let scheduledAny = false;
  for (const clip of input.clips) {
    input.signal?.throwIfAborted();
    const sink = await input.sinks.get(clip.mediaId).catch(() => null);
    if (!sink) continue;
    const scheduled = createClipGain(ctx, master.input);
    await scheduleClipWindow({
      ctx, scheduled, clip, sink, from: 0, to: input.durationSeconds, toContext: (t) => t, shouldStop: () => input.signal?.aborted === true,
    });
    scheduledAny = true;
  }
  if (!scheduledAny) return null;
  input.signal?.throwIfAborted();
  return ctx.startRendering();
}
