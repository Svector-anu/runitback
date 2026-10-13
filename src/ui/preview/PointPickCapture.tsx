import type { ReactNode } from "react";
import { toast } from "../primitives/toast";
import type { FramePlan } from "#/engine/render";
import { findVideoUnder, pointPickStore } from "#/app/point-pick";
import { getMotionAnalysis } from "#/app/motion-analysis";
import { getServices } from "#/app/services";
import { PickLayer } from "./PickLayer";
import type { PreviewView } from "./view";

/** Click a point on the picture of a video: the waiting clip then follows it (the track_point tool, one undo step). */
export function PointPickCapture({ view, renderer }: { view: PreviewView; renderer: { lastPlan: FramePlan | null } }): ReactNode {
  const target = pointPickStore.use((s) => s.targetElementId);
  if (!target) return null;
  const cancel = (): void => pointPickStore.set({ targetElementId: null });
  return (
    <PickLayer view={view} label="Click the point to follow" testId="point-pick-capture" onCancel={cancel}
      onPick={(point) => {
        const plan = renderer.lastPlan;
        const hit = plan ? findVideoUnder({ plan, excludeElementId: target, point }) : null;
        cancel();
        if (!hit) { toast.error("No video under that point", "Click on the picture of the video you want to follow."); return; }
        const playhead = getServices().editor.playback.getState().currentTime / 120_000;
        void getMotionAnalysis().runTool({ name: "track_point", jobKey: target, args: { videoElementId: hit.elementId, targetElementId: target, x: hit.u, y: hit.v, start: playhead } })
          .then((result) => { if (result.ok) toast.success("Following the point", result.summary); else toast.error("Could not follow that point", result.hint ? `${result.error} ${result.hint}` : result.error); });
      }} />
  );
}
