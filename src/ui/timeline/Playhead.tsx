import { memo, useEffect, type ReactNode } from "react";
import { TICKS_PER_SECOND } from "#/engine/time";
import { usePlaybackState } from "#/app/hooks";
import { getServices } from "#/app/services";
import { interactionStore } from "./controllers";
import type { Viewport } from "./useViewport";

function PlayheadImpl({ viewport, height, onKnobDown, onKey }: {
  viewport: Viewport; height: number; onKnobDown: (e: React.PointerEvent) => void; onKey: (e: React.KeyboardEvent) => void;
}): ReactNode {
  const time = usePlaybackState((s) => s.currentTime);
  const isPlaying = usePlaybackState((s) => s.isPlaying);
  const isScrubbing = usePlaybackState((s) => s.isScrubbing);
  const snapping = interactionStore.use((s) => s.scrubbingSnapped);
  const x = viewport.timeToX(time);

  useEffect(() => {
    const el = viewport.scrollRef.current;
    if (!el || !isPlaying || isScrubbing) return;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
    }
  }, [x, isPlaying, isScrubbing, viewport.scrollRef]);

  return (
    <div className="playhead" style={{ left: x - 1, height }} data-seconds={(time / TICKS_PER_SECOND).toFixed(3)}>
      <button
        type="button" className="playhead__knob" role="slider" aria-label="Playhead" aria-valuemin={0}
        aria-valuemax={Math.round(getServices().editor.duration() / TICKS_PER_SECOND * 100) / 100} aria-valuenow={Math.round(time / TICKS_PER_SECOND * 100) / 100} data-snapping={snapping}
        onPointerDown={onKnobDown} onKeyDown={onKey}
      />
    </div>
  );
}

export const Playhead = memo(PlayheadImpl);
