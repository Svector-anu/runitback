import { getUnderstandService } from "#/app/understand-stages";
import type { UnderstandBeginOutcome } from "#/app/understand-service";
import { STAGE_LABELS, type UnderstandRunSummary } from "#/engine/understand";
import { toast } from "../primitives/toast";

function report(label: string, summary: UnderstandRunSummary): void {
  if (summary.cancelled) { toast.info(`Stopped understanding ${label}`, "Finished stages are kept; press Understand to resume."); return; }
  const failed = Object.entries(summary.errors);
  if (failed.length === 0) { toast.success(`Understood ${label}`); return; }
  const detail = failed.map(([stage, message]) => `${STAGE_LABELS[stage as keyof typeof STAGE_LABELS]}: ${message}`).join(" ");
  toast.error(`${label} is only partly understood`, detail);
}

/**
 * Starts Understand for the UI and reports each asset's result as a toast once its run ends. Returns right away, so a
 * `needs-consent` outcome can open the download dialog without waiting for a run.
 */
export async function understandWithToast(input: { assetIds: ReadonlyArray<string>; labelOf: (assetId: string) => string }): Promise<UnderstandBeginOutcome> {
  const outcome = await getUnderstandService().begin(input.assetIds);
  if (outcome.status === "started") {
    for (const run of outcome.runs) void run.completion.then((summary) => report(input.labelOf(run.assetId), summary));
  }
  return outcome;
}
