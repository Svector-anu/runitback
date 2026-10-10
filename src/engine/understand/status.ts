import type { MediaAssetInfo } from "#/engine/model";

/** The four kinds of understanding, in the order they run. */
export const STAGE_IDS = ["analysis", "transcript", "visual", "faces"] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const STAGE_LABELS: Readonly<Record<StageId, string>> = {
  analysis: "Analysis", transcript: "Transcript", visual: "Visual index", faces: "Faces",
};

/** Relative cost of each stage, used to turn per-stage progress into one overall fraction. */
export const STAGE_WEIGHTS: Readonly<Record<StageId, number>> = { analysis: 0.15, transcript: 0.35, visual: 0.35, faces: 0.15 };

/** Stages whose model must be downloaded before first use; the rest run on code that ships with the app. */
export const MODEL_STAGES: ReadonlyArray<StageId> = ["transcript", "visual"];

export type AssetFacts = Pick<MediaAssetInfo, "id" | "type" | "hasAudio">;

/** Which stages have stored results for an asset. */
export type StoredStages = Readonly<Record<StageId, boolean>>;

export type StageReadiness = "done" | "missing" | "not-applicable";

export type UnderstandState = "not-understood" | "partial" | "understood" | "not-applicable";

export interface UnderstandStatus {
  assetId: string;
  state: UnderstandState;
  stages: Readonly<Record<StageId, StageReadiness>>;
  /** Applicable stages with stored results, in pipeline order. */
  indexed: StageId[];
  /** Applicable stages still to do, in pipeline order. */
  missing: StageId[];
}

/** Images carry nothing to analyse; audio has no frames; video without sound has no speech. */
export function applicableStages(asset: AssetFacts): StageId[] {
  switch (asset.type) {
    case "image": return [];
    case "audio": return ["analysis", "transcript"];
    case "video": return asset.hasAudio === false ? ["analysis", "visual", "faces"] : [...STAGE_IDS];
  }
}

export function understandStatus(input: { asset: AssetFacts; stored: StoredStages }): UnderstandStatus {
  const applicable = new Set(applicableStages(input.asset));
  const stages = Object.fromEntries(STAGE_IDS.map((id) => [id, !applicable.has(id) ? "not-applicable" : input.stored[id] ? "done" : "missing"])) as Record<StageId, StageReadiness>;
  const indexed = STAGE_IDS.filter((id) => stages[id] === "done");
  const missing = STAGE_IDS.filter((id) => stages[id] === "missing");
  const state: UnderstandState = applicable.size === 0 ? "not-applicable"
    : missing.length === 0 ? "understood"
      : indexed.length === 0 ? "not-understood" : "partial";
  return { assetId: input.asset.id, state, stages, indexed, missing };
}

export const NO_STORED_STAGES: StoredStages = { analysis: false, transcript: false, visual: false, faces: false };

/** Model-backed stages that still have to run, i.e. the ones whose download needs consent. */
export function modelStagesToRun(statuses: ReadonlyArray<UnderstandStatus>): StageId[] {
  return MODEL_STAGES.filter((id) => statuses.some((s) => s.stages[id] === "missing"));
}

/** One short line for a tile or a tool result, e.g. "Partial: missing transcript, faces". */
export function describeStatus(status: UnderstandStatus, failures: Partial<Record<StageId, string>> = {}): string {
  switch (status.state) {
    case "understood": return "Understood";
    case "not-applicable": return "Nothing to analyse";
    case "not-understood": return "Not understood";
    case "partial": {
      const failed = status.missing.filter((id) => failures[id] !== undefined);
      const reason = failed.length > 0 ? `${failed.map((id) => STAGE_LABELS[id].toLowerCase()).join(", ")} failed` : `missing ${status.missing.map((id) => STAGE_LABELS[id].toLowerCase()).join(", ")}`;
      return `Partial: ${reason}`;
    }
  }
}
