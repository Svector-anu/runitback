import type { MediaAssetInfo } from "#/engine/model";
import {
  NO_STORED_STAGES, STAGE_IDS, modelStagesToRun, runUnderstanding, understandStatus,
  type ModelDownload, type StageId, type StoredStages, type UnderstandRunSummary, type UnderstandStage, type UnderstandStartResult, type UnderstandStatus,
} from "#/engine/understand";
import { Store } from "./store";

/** The combined consent for every model the pipeline would download. */
export interface UnderstandConsent {
  /** Downloads the user has not approved yet, for the given model-backed stages. Empty when everything is approved or cached. */
  pending(stages: ReadonlyArray<StageId>): Promise<ModelDownload[]>;
  grant(stages: ReadonlyArray<StageId>): void;
}

export interface UnderstandServiceDeps {
  getAsset(assetId: string): MediaAssetInfo | undefined;
  stages: ReadonlyArray<UnderstandStage>;
  consent: UnderstandConsent;
}

export interface UnderstandRunView {
  /** Waiting behind another asset: heavy stages run one asset at a time. */
  queued: boolean;
  stage: StageId | null;
  /** 0..1 across all stages of this asset. */
  overall: number;
}

export interface UnderstandState {
  runs: Readonly<Record<string, UnderstandRunView>>;
  /** Derived from the stores, never remembered: it survives a reload because the results do. */
  statuses: Readonly<Record<string, UnderstandStatus>>;
  /** Why stages are missing after the latest run in this session. */
  failures: Readonly<Record<string, Partial<Record<StageId, string>>>>;
}

export type UnderstandBeginOutcome =
  | { status: "needs-consent"; downloads: ModelDownload[] }
  | { status: "nothing-to-do" }
  | { status: "started"; runs: Array<{ assetId: string; completion: Promise<UnderstandRunSummary> }> };

interface Job {
  controller: AbortController;
  completion: Promise<UnderstandRunSummary>;
}

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

/**
 * One-action "Understand footage": runs analysis, transcript, visual index and faces per asset, one asset at a time,
 * behind a single consent for the model downloads. Stages with stored results are skipped, so a cancelled or partly
 * failed run resumes where it stopped.
 */
export class UnderstandService {
  readonly state = new Store<UnderstandState>({ runs: {}, statuses: {}, failures: {} });
  private readonly jobs = new Map<string, Job>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: UnderstandServiceDeps) {}

  async stored(asset: MediaAssetInfo): Promise<StoredStages> {
    const entries = await Promise.all(STAGE_IDS.map(async (id) => {
      const stage = this.deps.stages.find((s) => s.id === id);
      try {
        return [id, stage ? await stage.has(asset) : false] as const;
      } catch {
        return [id, false] as const;
      }
    }));
    return { ...NO_STORED_STAGES, ...Object.fromEntries(entries) };
  }

  async statusOf(asset: MediaAssetInfo): Promise<UnderstandStatus> {
    return understandStatus({ asset, stored: await this.stored(asset) });
  }

  /** Re-reads the stores for these assets and publishes the result. */
  async refresh(assets: ReadonlyArray<MediaAssetInfo>): Promise<void> {
    const statuses = await Promise.all(assets.map((asset) => this.statusOf(asset)));
    this.state.set((s) => ({ statuses: { ...s.statuses, ...Object.fromEntries(statuses.map((status) => [status.assetId, status])) } }));
  }

  isActive(assetId: string): boolean {
    return this.jobs.has(assetId);
  }

  cancel(assetId: string): void {
    this.jobs.get(assetId)?.controller.abort();
  }

  cancelAll(): void {
    for (const job of this.jobs.values()) job.controller.abort();
  }

  grantConsent(downloads: ReadonlyArray<ModelDownload>): void {
    this.deps.consent.grant(downloads.map((d) => d.stage));
  }

  /** Queues the assets that still miss something. Reports `needs-consent` (and starts nothing) while a model download is unapproved. */
  async begin(assetIds: ReadonlyArray<string>): Promise<UnderstandBeginOutcome> {
    const assets = assetIds.map((id) => this.deps.getAsset(id)).filter((a): a is MediaAssetInfo => a !== undefined);
    const statuses = await Promise.all(assets.map((asset) => this.statusOf(asset)));
    this.state.set((s) => ({ statuses: { ...s.statuses, ...Object.fromEntries(statuses.map((status) => [status.assetId, status])) } }));
    const todo = assets.filter((_, i) => (statuses[i] as UnderstandStatus).missing.length > 0 || this.jobs.has((assets[i] as MediaAssetInfo).id));
    const pending = todo.filter((a) => !this.jobs.has(a.id));
    if (todo.length === 0) return { status: "nothing-to-do" };
    const downloads = await this.deps.consent.pending(modelStagesToRun(statuses.filter((st) => pending.some((a) => a.id === st.assetId))));
    if (downloads.length > 0) return { status: "needs-consent", downloads };
    return { status: "started", runs: todo.map((asset) => ({ assetId: asset.id, completion: this.enqueue(asset) })) };
  }

  /** Single-asset form used by the agent tool. */
  async start(assetId: string): Promise<UnderstandStartResult> {
    const outcome = await this.begin([assetId]);
    if (outcome.status !== "started") return outcome;
    return { status: "started", completion: (outcome.runs[0] as { completion: Promise<UnderstandRunSummary> }).completion };
  }

  private enqueue(asset: MediaAssetInfo): Promise<UnderstandRunSummary> {
    const existing = this.jobs.get(asset.id);
    if (existing) return existing.completion;
    const controller = new AbortController();
    this.state.set((s) => ({ runs: { ...s.runs, [asset.id]: { queued: true, stage: null, overall: 0 } } }));
    const completion = this.tail.then(() => this.execute(asset, controller));
    this.tail = completion;
    this.jobs.set(asset.id, { controller, completion });
    return completion;
  }

  private async execute(asset: MediaAssetInfo, controller: AbortController): Promise<UnderstandRunSummary> {
    const setRun = (patch: Partial<UnderstandRunView>): void =>
      this.state.set((s) => ({ runs: { ...s.runs, [asset.id]: { queued: false, stage: null, overall: 0, ...s.runs[asset.id], ...patch } } }));
    setRun({ queued: false });
    const summary = await runUnderstanding({
      asset, stages: this.deps.stages, signal: controller.signal,
      onEvent: (event) => setRun({ stage: event.stage, overall: event.overall }),
    });
    this.jobs.delete(asset.id);
    const status = await this.statusOf(asset);
    this.state.set((s) => ({
      runs: without(s.runs, asset.id),
      statuses: { ...s.statuses, [asset.id]: status },
      failures: { ...s.failures, [asset.id]: summary.errors },
    }));
    return summary;
  }
}
