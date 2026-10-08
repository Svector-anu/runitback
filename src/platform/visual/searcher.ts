import type { VisualSearcher } from "#/engine/visual";
import { DEFAULT_CLIP_MODEL } from "./indexer";
import type { ClipBackend } from "./protocol";
import { createWorkerBackend } from "./worker-backend";

/** The text model is ~65 MB in memory; release the worker once nobody has searched for this long. */
export const SEARCHER_IDLE_MS = 30_000;

export interface ClipSearcherOptions {
  model?: string;
  idleMs?: number;
  /** Test seam: replaces the worker-backed model. */
  createBackend?: (model: string) => ClipBackend;
}

export interface ClipSearcher extends VisualSearcher {
  /** Terminates the worker now; the next query starts a new one. */
  dispose(): void;
}

/** Embeds search text on device. The worker is created on the first query, reused, and terminated when idle. */
export function createClipSearcher(options: ClipSearcherOptions = {}): ClipSearcher {
  const model = options.model ?? DEFAULT_CLIP_MODEL;
  const idleMs = options.idleMs ?? SEARCHER_IDLE_MS;
  const createBackend = options.createBackend ?? createWorkerBackend;
  let backend: ClipBackend | null = null;
  let inFlight = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const dispose = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    backend?.dispose();
    backend = null;
  };

  return {
    model,
    dispose,
    async embedText(query) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      backend ??= createBackend(model);
      const active = backend;
      inFlight += 1;
      try {
        const [row] = await active.embedTexts({ texts: [query] });
        if (!row) throw new Error("The model returned no embedding for the query");
        return row;
      } catch (error) {
        if (backend === active) dispose();
        throw error;
      } finally {
        inFlight -= 1;
        if (inFlight === 0 && backend === active) idleTimer = setTimeout(dispose, idleMs);
      }
    },
  };
}
