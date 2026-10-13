import { callTool, createAgentTools, createMotionTools, type AgentTool } from "#/engine/agent";
import { createMotionAnalyzer, type MotionAnalyzer } from "#/platform/tracking";
import { Store } from "./store";
import { getServices } from "./services";

export type MotionJobKind = "stabilize" | "track";

export interface MotionJobView {
  kind: MotionJobKind;
  /** 0..1 */
  progress: number;
}

export interface MotionState {
  /** Running analyses by the clip they were started for. */
  jobs: Readonly<Record<string, MotionJobView>>;
}

/** On-device motion analysis for the app: one job per clip, progress, cancel, and the agent's motion tools over the same analyser. */
export class MotionAnalysisService {
  readonly state = new Store<MotionState>({ jobs: {} });
  private readonly controllers = new Map<string, AbortController>();
  private currentJob: string | null = null;

  constructor(private readonly analyzer: MotionAnalyzer = createMotionAnalyzer()) {}

  private async withJob<T>(jobKey: string, kind: MotionJobKind, signal: AbortSignal | undefined, work: (options: { signal: AbortSignal; onProgress: (p: number) => void }) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.set(jobKey, controller);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    this.state.set((s) => ({ jobs: { ...s.jobs, [jobKey]: { kind, progress: 0 } } }));
    try {
      return await work({ signal: controller.signal, onProgress: (progress) => this.state.set((s) => ({ jobs: { ...s.jobs, [jobKey]: { kind, progress } } })) });
    } finally {
      this.controllers.delete(jobKey);
      this.state.set((s) => {
        const jobs = { ...s.jobs };
        delete jobs[jobKey];
        return { jobs };
      });
    }
  }

  /** Cancels the analysis running for a clip. */
  cancel(jobKey: string): void {
    this.controllers.get(jobKey)?.abort();
  }

  private blobFor(assetId: string): Blob {
    const blob = getServices().runtime.getBlob(assetId);
    if (!blob) throw new Error(`Media for asset ${assetId} is not loaded`);
    return blob;
  }

  tools(options: { signal?: () => AbortSignal | undefined; jobKey?: () => string } = {}): AgentTool[] {
    const key = (assetId: string): string => options.jobKey?.() ?? this.currentJob ?? assetId;
    return createMotionTools({
      track: ({ assetId, times, start }) => this.withJob(key(assetId), "track", options.signal?.(), (o) => this.analyzer.track({ blob: this.blobFor(assetId), times, start, ...o })),
      camera: ({ assetId, times }) => this.withJob(key(assetId), "stabilize", options.signal?.(), (o) => this.analyzer.camera({ blob: this.blobFor(assetId), times, ...o })),
    });
  }

  /** Runs one motion tool for a clip from the UI (same validation, same single undo step as the agent). */
  async runTool(input: { name: "track_point" | "stabilize_clip"; args: unknown; jobKey: string }): Promise<{ ok: true; summary: string } | { ok: false; error: string; hint?: string }> {
    this.currentJob = input.jobKey;
    try {
      const registry = new Map(createAgentTools());
      for (const tool of this.tools({ jobKey: () => input.jobKey })) registry.set(tool.name, tool);
      const result = await callTool({ tools: registry, name: input.name, args: input.args, ctx: { editor: getServices().editor, nowMs: () => performance.now() } });
      return result.ok ? { ok: true, summary: result.summary } : { ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) };
    } finally {
      this.currentJob = null;
    }
  }
}

let service: MotionAnalysisService | null = null;

export function getMotionAnalysis(): MotionAnalysisService {
  service ??= new MotionAnalysisService();
  return service;
}
