import type { AudioClip } from "#/engine/audio";
import type { Playback } from "#/engine/editor";
import { TICKS_PER_SECOND } from "#/engine/time";
import {
  createClipGain, createMasterChain, scheduleClipWindow, stopClip, type AudioSinkCache, type ScheduledClip,
} from "./audio-scheduler";

export const LOOKAHEAD_SECONDS = 2;
export const SCHEDULE_INTERVAL_MS = 250;
const START_LATENCY_SECONDS = 0.05;

/** Live playback: schedules decoded audio on the AudioContext clock from an anchor set at play/seek. */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: ReturnType<typeof createMasterChain> | null = null;
  private anchorTimeline = 0;
  private anchorContext = 0;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private cursors = new Map<string, number>();
  private disposed = false;
  private readonly clips = new Map<string, ScheduledClip>();
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: {
    playback: Playback; getClips: () => AudioClip[]; sinks: AudioSinkCache;
  }) {}

  attach(): void {
    const { playback } = this.deps;
    this.unsubscribe.push(
      playback.subscribe(() => this.sync()),
      playback.onSeek(() => this.restart()),
    );
    this.sync();
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = createMasterChain(this.ctx);
      this.master.output.connect(this.ctx.destination);
      this.applyVolume();
    }
    return this.ctx;
  }

  private applyVolume(): void {
    if (!this.master || !this.ctx) return;
    const { volume, muted } = this.deps.playback.getState();
    this.master.volume.gain.setValueAtTime(muted ? 0 : volume, this.ctx.currentTime);
  }

  private sync(): void {
    const state = this.deps.playback.getState();
    this.applyVolume();
    const shouldRun = state.isPlaying && !state.isScrubbing;
    if (shouldRun && !this.running) this.restart();
    if (!shouldRun && this.running) this.stop();
  }

  /** Re-anchor at the current playhead; used on seek, play, and when the timeline changes mid-playback. */
  restart(): void {
    this.stop();
    if (this.disposed) return;
    const state = this.deps.playback.getState();
    if (!state.isPlaying || state.isScrubbing) return;
    const ctx = this.ensureContext();
    void ctx.resume();
    this.running = true;
    this.generation++;
    this.anchorTimeline = state.currentTime / TICKS_PER_SECOND;
    this.anchorContext = ctx.currentTime + START_LATENCY_SECONDS;
    this.timer = setInterval(() => void this.tick(), SCHEDULE_INTERVAL_MS);
    void this.tick();
  }

  private toContext = (timelineSeconds: number): number => this.anchorContext + (timelineSeconds - this.anchorTimeline);

  private async tick(): Promise<void> {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.running) return;
    const generation = this.generation;
    const cursors = this.cursors;
    const nowTimeline = this.anchorTimeline + Math.max(0, ctx.currentTime - this.anchorContext);
    const horizon = nowTimeline + LOOKAHEAD_SECONDS;
    for (const clip of this.deps.getClips()) {
      if (generation !== this.generation) return;
      if (clip.start + clip.duration <= nowTimeline || clip.start >= horizon) continue;
      const from = Math.max(cursors.get(clip.key) ?? nowTimeline, nowTimeline);
      if (from >= horizon) continue;
      cursors.set(clip.key, horizon);
      let scheduled = this.clips.get(clip.key);
      if (!scheduled) {
        scheduled = createClipGain(ctx, master.input);
        this.clips.set(clip.key, scheduled);
      }
      const sink = await this.deps.sinks.get(clip.mediaId).catch(() => null);
      if (!sink || generation !== this.generation) continue;
      try {
        await scheduleClipWindow({
          ctx, scheduled, clip, sink, from, to: horizon, toContext: this.toContext, shouldStop: () => generation !== this.generation,
        });
      } catch (error) {
        console.warn(`Audio scheduling failed for ${clip.key}`, error);
      }
    }
  }

  stop(): void {
    this.running = false;
    this.generation++;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const scheduled of this.clips.values()) stopClip(scheduled);
    this.clips.clear();
    this.cursors = new Map();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
  }
}
