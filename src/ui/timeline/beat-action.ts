import { currentScene } from "#/engine/commands";
import { BEAT_SNAP_DEFAULT_TOLERANCE_SECONDS, planBeatSnap, snapCutsToBeatCommand } from "#/engine/beatsync";
import type { Editor } from "#/engine/editor";
import { computeTimelineBeats } from "#/app/beat-service";
import { toast } from "../primitives/toast";
import { runEdit } from "../lib/edit";

/** "Snap cuts to beat": selected clips' cuts, or every cut when nothing is selected. One undo step. */
export async function snapCutsToBeatWithToast(editor: Editor): Promise<void> {
  const doc = editor.getState().doc;
  const tracks = currentScene(doc).tracks;
  const selected = editor.getState().selection.elements.map((r) => r.elementId);
  let beats: number[];
  try {
    beats = await computeTimelineBeats(tracks);
  } catch (error) {
    toast.error("Could not analyse the music", error instanceof Error ? error.message : undefined);
    return;
  }
  if (beats.length === 0) {
    toast.error("No beats to snap to", "Put music with a clear rhythm on an unmuted audio track.");
    return;
  }
  const latest = editor.getState().doc;
  if (latest !== doc) {
    toast.error("The timeline changed while the music was analysed", "Press Snap cuts to beat again.");
    return;
  }
  const plan = planBeatSnap({
    tracks, beatsSeconds: beats, fps: doc.settings.fps, toleranceSeconds: BEAT_SNAP_DEFAULT_TOLERANCE_SECONDS,
    ...(selected.length > 0 ? { elementIds: selected } : {}),
  });
  if (plan.cutCount === 0) {
    toast.info("No cuts to snap", "Cuts are where two clips touch on a video track.");
    return;
  }
  if (plan.moves.length === 0) {
    toast.info("Nothing to move", `${plan.cutCount} cut${plan.cutCount === 1 ? " is" : "s are"} already on a beat, too far from one, or have no spare footage.`);
    return;
  }
  if (runEdit(editor, snapCutsToBeatCommand(plan))) {
    toast.success(`Snapped ${plan.moves.length} of ${plan.cutCount} cuts to the beat`, "Undo restores the original cuts.");
  }
}
