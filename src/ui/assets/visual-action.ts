import { getVisualService, type VisualIndexOutcome } from "#/app/visual-service";
import { toast } from "../primitives/toast";

/** Indexes a video for visual search for the UI and reports the outcome as a toast. Returns "needs-consent" so the caller can ask first. */
export async function indexVisualsWithToast(input: { assetId: string; assetName: string }): Promise<VisualIndexOutcome["status"]> {
  const outcome = await getVisualService().begin(input.assetId);
  if (outcome.status === "done") toast.success(`Indexed ${input.assetName}`, `${outcome.embeddings.times.length} frames can now be searched by what they show.`);
  else if (outcome.status === "error") toast.error(`Could not index ${input.assetName}`, outcome.message);
  return outcome.status;
}
