import type { MediaAssetInfo } from "#/engine/model";
import { applicableStages, STAGE_IDS, STAGE_WEIGHTS, type StageId } from "./status";

/** One step of understanding. Implementations live in the app layer; the engine only sequences them. */
export interface UnderstandStage {
  id: StageId;
  /** True when this asset already has stored results for the stage, so it can be skipped (resumable runs). */
  has(asset: MediaAssetInfo): Promise<boolean>;
  /** Computes and stores the results. Must reject with an AbortError when `signal` aborts. */
  run(input: { asset: MediaAssetInfo; signal: AbortSignal; onProgress: (fraction: number) => void }): Promise<void>;
}

export type StageOutcome = "done" | "skipped" | "failed" | "cancelled" | "not-applicable" | "not-run";

export interface UnderstandRunSummary {
  assetId: string;
  outcomes: Readonly<Record<StageId, StageOutcome>>;
  errors: Partial<Record<StageId, string>>;
  cancelled: boolean;
}

export type UnderstandEvent =
  | { type: "stage-start"; stage: StageId; overall: number }
  | { type: "stage-progress"; stage: StageId; fraction: number; overall: number }
  | { type: "stage-end"; stage: StageId; outcome: StageOutcome; overall: number };

export const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs the applicable stages for one asset in pipeline order. Stages that already have results are skipped,
 * a failing stage is recorded and the rest still run, and an abort stops after the current stage unwinds.
 * Never rejects.
 */
export async function runUnderstanding(input: {
  asset: MediaAssetInfo;
  stages: ReadonlyArray<UnderstandStage>;
  signal: AbortSignal;
  onEvent?: (event: UnderstandEvent) => void;
}): Promise<UnderstandRunSummary> {
  const { asset, signal } = input;
  const applicable = applicableStages(asset);
  const outcomes = Object.fromEntries(STAGE_IDS.map((id) => [id, applicable.includes(id) ? "not-run" : "not-applicable"])) as Record<StageId, StageOutcome>;
  const errors: Partial<Record<StageId, string>> = {};
  const totalWeight = applicable.reduce((sum, id) => sum + STAGE_WEIGHTS[id], 0);
  let finishedWeight = 0;
  const overallAt = (fraction: number, id: StageId): number => (totalWeight === 0 ? 1 : Math.min(1, (finishedWeight + STAGE_WEIGHTS[id] * fraction) / totalWeight));

  for (const id of STAGE_IDS) {
    if (!applicable.includes(id)) continue;
    if (signal.aborted) break;
    const stage = input.stages.find((s) => s.id === id);
    if (!stage) { outcomes[id] = "failed"; errors[id] = `No implementation for the ${id} stage`; finishedWeight += STAGE_WEIGHTS[id]; continue; }
    input.onEvent?.({ type: "stage-start", stage: id, overall: overallAt(0, id) });
    try {
      if (await stage.has(asset)) {
        outcomes[id] = "skipped";
      } else {
        await stage.run({
          asset, signal,
          onProgress: (fraction) => input.onEvent?.({ type: "stage-progress", stage: id, fraction, overall: overallAt(Math.min(1, Math.max(0, fraction)), id) }),
        });
        outcomes[id] = "done";
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) outcomes[id] = "cancelled";
      else { outcomes[id] = "failed"; errors[id] = messageOf(error); }
    }
    if (outcomes[id] !== "cancelled") finishedWeight += STAGE_WEIGHTS[id];
    input.onEvent?.({ type: "stage-end", stage: id, outcome: outcomes[id], overall: overallAt(0, id) });
    if (outcomes[id] === "cancelled") break;
  }
  return { assetId: asset.id, outcomes, errors, cancelled: signal.aborted };
}

/** A model the user has to approve downloading before a stage can run. */
export interface ModelDownload {
  stage: StageId;
  model: string;
  approxMegabytes: number;
}

export type UnderstandStartResult =
  | { status: "needs-consent"; downloads: ModelDownload[] }
  | { status: "nothing-to-do" }
  | { status: "started"; completion: Promise<UnderstandRunSummary> };
