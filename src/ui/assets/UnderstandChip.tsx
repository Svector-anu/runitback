import type { ReactNode } from "react";
import type { UnderstandRunView } from "#/app/understand-service";
import { STAGE_LABELS, describeStatus, type StageId, type UnderstandStatus } from "#/engine/understand";

export function UnderstandChip({ status, run, failures }: { status: UnderstandStatus | undefined; run: UnderstandRunView | undefined; failures: Partial<Record<StageId, string>> | undefined }): ReactNode {
  if (run) {
    const text = run.queued ? "Queued" : `${Math.round(run.overall * 100)}%`;
    const title = run.queued ? "Waiting for another asset to finish" : `${run.stage ? STAGE_LABELS[run.stage] : "Starting"}: ${text}`;
    return <span className="media-item__status" data-state="running" title={title}>{text}</span>;
  }
  if (!status || status.state === "not-understood" || status.state === "not-applicable") return null;
  const text = status.state === "understood" ? "Understood" : "Partial";
  const reasons = Object.entries(failures ?? {}).map(([stage, message]) => `${STAGE_LABELS[stage as StageId]}: ${message}`);
  return <span className="media-item__status" data-state={status.state} title={[describeStatus(status, failures), ...reasons].join(". ")}>{text}</span>;
}
