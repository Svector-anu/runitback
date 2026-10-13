import type { ReactNode } from "react";
import type { TimelineElement } from "#/engine/model";
import { getBackgroundRemoval } from "#/app/background-removal";
import { Button } from "../primitives/Button";
import "../styles/vfx.css";

/** Analysis state of the media behind a clip with background removal: Analyze, progress with Cancel, or ready. */
export function BackgroundRemovalStatus({ element }: { element: TimelineElement }): ReactNode {
  const service = getBackgroundRemoval();
  const state = service.state.use((s) => s);
  const assetId = element.type === "video" || element.type === "image" ? element.mediaId : null;
  if (!assetId) return null;
  const job = state.jobs[assetId];
  const error = state.errors[assetId];
  const ready = service.provider.has(assetId);
  const analyze = (): void => { service.analyze(assetId).catch(() => undefined); };

  return (
    <div className="bg-removal" data-testid="bg-removal-status" data-state={job ? "analyzing" : ready ? "ready" : "needs-analysis"}>
      {job ? (
        <>
          <div className="row-between">
            <span>Analyzing… {Math.round(job.progress * 100)}%</span>
            <Button size="sm" variant="ghost" onClick={() => service.cancel(assetId)}>Cancel</Button>
          </div>
          <progress className="bg-removal__bar" max={1} value={job.progress} aria-label="Background analysis progress" />
        </>
      ) : ready ? (
        <div className="row-between">
          <span>Person mask ready. Analysed on this device.</span>
          <Button size="sm" variant="ghost" onClick={() => { void service.provider.remove(assetId).then(analyze); }}>Re-analyze</Button>
        </div>
      ) : (
        <div className="row-between">
          <span>This media needs a one-time analysis before the background is removed.</span>
          <Button size="sm" onClick={analyze}>Analyze</Button>
        </div>
      )}
      {error ? <p className="bg-removal__error" role="alert">Analysis failed: {error}</p> : null}
      <p className="muted">Keeps people, removes everything else. Runs on this device with a small model (no upload). Edges can flicker on fast motion or fine hair, and every person in frame is kept.</p>
    </div>
  );
}
