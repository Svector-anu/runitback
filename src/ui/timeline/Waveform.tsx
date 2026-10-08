import { useEffect, useRef, type ReactNode } from "react";
import { TICKS_PER_SECOND } from "#/engine/time";
import { getServices } from "#/app/services";
import { peaksForRange } from "#/platform/waveform";

const MAX_CANVAS_WIDTH = 2048;

export function Waveform({ mediaId, assetSeconds, trimStartSeconds, sourceSeconds, width, height, rate }: {
  mediaId: string; assetSeconds: number; trimStartSeconds: number; sourceSeconds: number; width: number; height: number; rate: number;
}): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let canceled = false;
    const canvas = ref.current;
    if (!canvas) return undefined;
    const cols = Math.max(1, Math.min(MAX_CANVAS_WIDTH, Math.floor(width)));
    canvas.width = cols;
    canvas.height = height;
    void getServices().runtime.waveforms.get(mediaId, assetSeconds).then((peaks) => {
      if (canceled || !peaks) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const bars = Math.max(1, Math.floor(cols / 2));
      const data = peaksForRange({ peaks, startSeconds: trimStartSeconds, endSeconds: trimStartSeconds + sourceSeconds * rate, count: bars });
      ctx.clearRect(0, 0, cols, height);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      for (let i = 0; i < bars; i++) {
        const amp = data[i] as number;
        const db = amp > 0 ? 20 * Math.log10(amp) : -Infinity;
        const fraction = db <= -40 ? 0 : ((db + 40) / 40) ** 1.5;
        const h = Math.max(fraction > 0 ? 1 : 0, fraction * (height - 14));
        ctx.fillRect(i * 2, height - h, 1, h);
      }
    });
    return () => { canceled = true; };
  }, [mediaId, assetSeconds, trimStartSeconds, sourceSeconds, width, height, rate]);

  return <canvas ref={ref} className="clip__waveform" style={{ height }} />;
}

export const secondsOf = (ticks: number): number => ticks / TICKS_PER_SECOND;
