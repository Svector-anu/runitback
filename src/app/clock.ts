import type { Playback } from "#/engine/editor";

/** Drives playback from requestAnimationFrame only while playing. Returns a disposer. */
export function startPlaybackClock(playback: Playback): () => void {
  let frame = 0;
  const loop = (now: number): void => {
    playback.tick(now);
    if (playback.getState().isPlaying) frame = requestAnimationFrame(loop);
  };
  const unsubscribe = playback.subscribe(() => {
    if (playback.getState().isPlaying && frame === 0) frame = requestAnimationFrame(loop);
    else if (!playback.getState().isPlaying && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  });
  return () => {
    unsubscribe();
    cancelAnimationFrame(frame);
  };
}
