import { createVisualTools, type AgentTool } from "#/engine/agent";
import { getVisualService } from "../visual-service";

/** Visual-search tools backed by the shared embedding store and the consent-gated on-device image model. */
export function createAppVisualTools(): AgentTool[] {
  const service = getVisualService();
  return createVisualTools({ store: service.store, searcher: service.gatedSearcher, indexer: service.gatedIndexer });
}
