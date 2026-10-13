import type { ReactNode } from "react";
import { updateClipEffectParams } from "#/engine/commands";
import type { FramePlan } from "#/engine/render";
import { colorPickStore, sampleSourceColor } from "#/app/color-pick";
import { getServices } from "#/app/services";
import { runEdit } from "../lib/edit";
import { PickLayer } from "./PickLayer";
import type { PreviewView } from "./view";

/** Eyedropper: one click on the preview reads the picked clip's source colour into the waiting effect parameter. */
export function ColorPickCapture({ view, renderer }: { view: PreviewView; renderer: { lastPlan: FramePlan | null } }): ReactNode {
  const target = colorPickStore.use((s) => s.target);
  if (!target) return null;
  const cancel = (): void => colorPickStore.set({ target: null });
  return (
    <PickLayer view={view} label="Click the colour to remove" testId="color-pick-capture" onCancel={cancel}
      onPick={(point) => {
        const plan = renderer.lastPlan;
        const color = plan ? sampleSourceColor({ plan, elementId: target.ref.elementId, point }) : null;
        if (color) runEdit(getServices().editor, updateClipEffectParams(target.ref, target.effectId, { keyColor: color }));
        cancel();
      }} />
  );
}
