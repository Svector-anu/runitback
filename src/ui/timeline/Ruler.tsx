import { memo, useMemo, type ReactNode } from "react";
import { buildRulerTicks, timeToPixels } from "#/engine/timeline";
import { TICKS_PER_SECOND } from "#/engine/time";
import type { FrameRate } from "#/engine/time";

const BEAT_WINDOW_MARGIN_PX = 40;

function RulerImpl({ zoom, fps, scrollLeft, viewportWidth, maxTime, width, beats, onPointerDown }: {
  zoom: number; fps: FrameRate; scrollLeft: number; viewportWidth: number; maxTime: number; width: number;
  /** Beat times in seconds; null hides the markers. */
  beats: ReadonlyArray<number> | null;
  onPointerDown: (e: React.PointerEvent) => void;
}): ReactNode {
  const ticks = useMemo(() => buildRulerTicks({ zoom, fps, scrollLeft, viewportWidth, maxTime }), [zoom, fps, scrollLeft, viewportWidth, maxTime]);
  const beatLefts = useMemo(() => {
    if (!beats) return [];
    const from = scrollLeft - BEAT_WINDOW_MARGIN_PX;
    const to = scrollLeft + viewportWidth + BEAT_WINDOW_MARGIN_PX;
    return beats.map((b) => timeToPixels(Math.round(b * TICKS_PER_SECOND), zoom)).filter((x) => x >= from && x <= to);
  }, [beats, zoom, scrollLeft, viewportWidth]);
  return (
    <div className="timeline__ruler" role="slider" aria-label="Timeline ruler" aria-valuemin={0} aria-valuemax={maxTime} aria-valuenow={0} style={{ width }} onPointerDown={onPointerDown}>
      {ticks.map((t) => (
        <div key={t.time}>
          <div className="ruler__tick" style={{ left: t.left }} />
          {t.label ? <div className="ruler__label" style={{ left: t.left }}>{t.label}</div> : null}
        </div>
      ))}
      {beatLefts.map((left) => <div key={`beat-${left}`} className="ruler__beat" data-testid="ruler-beat" style={{ left }} />)}
    </div>
  );
}

export const Ruler = memo(RulerImpl);
