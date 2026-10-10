import { createUnderstandTools, type AgentTool } from "#/engine/agent";
import { getUnderstandService } from "../understand-stages";

/** One-action footage understanding (analysis, transcript, visual index, faces) behind the shared consent gate. */
export function createAppUnderstandTools(): AgentTool[] {
  const service = getUnderstandService();
  return createUnderstandTools({ status: service, start: (assetId) => service.start(assetId) });
}
