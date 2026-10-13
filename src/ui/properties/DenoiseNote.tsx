import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { PARAM, numberParam, type TimelineElement } from "#/engine/model";
import { getServices } from "#/app/services";

const STATUS_IDLE = { state: "idle" } as const;

/** Progress, result and honest limits for the Noise removal slider on a video or audio clip. */
export function DenoiseNote({ element }: { element: TimelineElement }): ReactNode {
  const mediaId = "mediaId" in element ? element.mediaId : undefined;
  const strength = numberParam(element.params, PARAM.denoise, 0);
  const audio = getServices().runtime.audio;
  const status = useSyncExternalStore(
    (listener) => audio.subscribeDenoise(listener),
    () => (mediaId ? audio.denoiseStatus(mediaId) : STATUS_IDLE),
  );

  useEffect(() => {
    if (mediaId && strength > 0 && status.state === "idle") audio.prepareDenoise(mediaId).catch(() => undefined);
  }, [audio, mediaId, strength, status.state]);

  if (strength <= 0 && status.state !== "running") {
    return <p className="field-note">Removes steady background noise (hiss, hum, fans) from speech. Nothing is uploaded.</p>;
  }
  return (
    <div className="field-note" data-testid="denoise-note" data-state={status.state} role="status">
      {status.state === "running" ? (
        <>
          <span>Cleaning up audio... {Math.round(status.progress * 100)}%</span>
          <div className="progress" aria-hidden="true"><div style={{ width: `${Math.round(status.progress * 100)}%` }} /></div>
        </>
      ) : null}
      {status.state === "ready" ? (
        <span>Noise floor {Math.round(status.noiseFloorDb.before)} dB to {Math.round(status.noiseFloorDb.after)} dB at 100%. Tuned for speech: lower the amount if music or effects sound dull.</span>
      ) : null}
      {status.state === "error" ? <span>Noise removal could not run ({status.message}). The original audio plays instead.</span> : null}
      {status.state === "idle" ? <span>Preparing...</span> : null}
    </div>
  );
}
