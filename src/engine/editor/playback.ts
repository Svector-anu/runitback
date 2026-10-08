import { TICKS_PER_SECOND, clampTime, floorToFrame, mediaTime, roundMediaTime, snappedSeekTime, type FrameRate, type MediaTime } from "#/engine/time";

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: MediaTime;
  volume: number;
  muted: boolean;
  isScrubbing: boolean;
}

export interface PlaybackDeps {
  getDuration: () => MediaTime;
  getFps: () => FrameRate;
}

type Listener = () => void;

/**
 * Transport state machine. Time is advanced by `tick(nowMs)` from an external clock (rAF in the browser,
 * a fake clock in tests), so it has no timers or DOM dependencies.
 */
export class Playback {
  private state: PlaybackState = { isPlaying: false, currentTime: mediaTime(0), volume: 1, muted: false, isScrubbing: false };
  private listeners = new Set<Listener>();
  private seekListeners = new Set<(time: MediaTime) => void>();
  private anchorTime: MediaTime = mediaTime(0);
  private anchorWall: number | null = null;
  private previousVolume = 1;

  constructor(private readonly deps: PlaybackDeps) {}

  getState = (): PlaybackState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Fires for every discontinuity (seek, play start, end reached) so audio can resync. */
  onSeek(listener: (time: MediaTime) => void): () => void {
    this.seekListeners.add(listener);
    return () => this.seekListeners.delete(listener);
  }

  private set(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private notifySeek(): void {
    for (const l of this.seekListeners) l(this.state.currentTime);
  }

  /** `nowMs` anchors the wall clock; pass the same timebase later given to `tick`. */
  play(nowMs: number): void {
    const duration = this.deps.getDuration();
    if (duration <= 0) return;
    let time = this.state.currentTime;
    if (time >= duration) time = mediaTime(0);
    this.anchorTime = time;
    this.anchorWall = nowMs;
    this.set({ isPlaying: true, currentTime: time });
    this.notifySeek();
  }

  pause(): void {
    if (!this.state.isPlaying) return;
    this.anchorWall = null;
    this.set({ isPlaying: false });
  }

  toggle(nowMs: number): void {
    if (this.state.isPlaying) this.pause();
    else this.play(nowMs);
  }

  stop(): void {
    this.pause();
    this.seek(mediaTime(0));
  }

  seek(time: number, nowMs?: number): void {
    const target = snappedSeekTime(time, this.deps.getDuration(), this.deps.getFps());
    this.anchorTime = target;
    if (this.state.isPlaying && nowMs !== undefined) this.anchorWall = nowMs;
    this.set({ currentTime: target });
    this.notifySeek();
  }

  seekBySeconds(seconds: number, nowMs?: number): void {
    this.seek(this.state.currentTime + roundMediaTime(seconds * TICKS_PER_SECOND), nowMs);
  }

  setScrubbing(isScrubbing: boolean): void {
    if (this.state.isScrubbing !== isScrubbing) this.set({ isScrubbing });
  }

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, volume));
    if (v > 0) this.previousVolume = v;
    this.set({ volume: v, muted: v === 0 });
  }

  toggleMute(): void {
    if (this.state.muted || this.state.volume === 0) {
      this.set({ muted: false, volume: this.previousVolume });
    } else {
      this.previousVolume = this.state.volume;
      this.set({ muted: true });
    }
  }

  /** Advance to wall-clock `nowMs`; the displayed frame never runs ahead of real time. */
  tick(nowMs: number): void {
    if (!this.state.isPlaying || this.anchorWall === null) return;
    const duration = this.deps.getDuration();
    const elapsed = roundMediaTime(((nowMs - this.anchorWall) / 1000) * TICKS_PER_SECOND);
    const raw = this.anchorTime + elapsed;
    if (raw >= duration) {
      this.anchorWall = null;
      this.set({ isPlaying: false, currentTime: duration });
      this.notifySeek();
      return;
    }
    const frameTime = clampTime(floorToFrame(raw, this.deps.getFps()), 0, duration);
    if (frameTime !== this.state.currentTime) this.set({ currentTime: frameTime });
  }

  /** Keeps the playhead legal after the timeline shrinks. */
  reconcile(): void {
    const duration = this.deps.getDuration();
    if (this.state.currentTime > duration) this.set({ currentTime: duration });
    if (this.state.isPlaying && duration <= 0) this.pause();
  }
}
