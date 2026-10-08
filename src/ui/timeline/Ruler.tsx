import { memo, useMemo, type ReactNode } from "react";
import { buildRulerTicks } from "#/engine/timeline";
import type { FrameRate } from "#/engine/time";

function RulerImpl({ zoom, fps, scrollLeft, viewportWidth, maxTime, width, onPointerDown }: {
  zoom: number; fps: FrameRate; scrollLeft: number; viewportWidth: number; maxTime: number; width: number;
  onPointerDown: (e: React.PointerEvent) => void;
}): ReactNode {
  const ticks = useMemo(() => buildRulerTicks({ zoom, fps, scrollLeft, viewportWidth, maxTime }), [zoom, fps, scrollLeft, viewportWidth, maxTime]);
  return (
    <div className="timeline__ruler" role="slider" aria-label="Timeline ruler" aria-valuemin={0} aria-valuemax={maxTime} aria-valuenow={0} style={{ width }} onPointerDown={onPointerDown}>
      {ticks.map((t) => (
        <div key={t.time}>
          <div className="ruler__tick" style={{ left: t.left }} />
          {t.label ? <div className="ruler__label" style={{ left: t.left }}>{t.label}</div> : null}
        </div>
      ))}
    </div>
  );
}

export const Ruler = memo(RulerImpl);
