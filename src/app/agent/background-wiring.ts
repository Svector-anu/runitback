import type { AgentTool } from "#/engine/agent";
import { createBackgroundTools } from "#/engine/agent";
import { getBackgroundRemoval } from "../background-removal";

/** remove_background: analyses media on first use through the app's background-removal service (cancelled with the turn). */
export function createAppBackgroundTools(signal?: () => AbortSignal | undefined): AgentTool[] {
  const service = getBackgroundRemoval();
  return createBackgroundTools({
    isReady: (assetId) => service.isReady(assetId),
    async analyze({ assetId }) {
      const track = await service.analyze(assetId, { ...(signal?.() ? { signal: signal() as AbortSignal } : {}) });
      return service.summarize(track);
    },
  });
}
