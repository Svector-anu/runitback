import { createTemporalTools, type AgentTool } from "#/engine/agent";
import type { AnalysisProvider } from "#/engine/reference";
import { getTranscribeService } from "../transcribe-service";

/** Temporal-index tools over the session's analysis provider and the shared transcript store. */
export function createAppTemporalTools(provider: AnalysisProvider): AgentTool[] {
  return createTemporalTools({ analysis: provider, transcripts: getTranscribeService().store });
}
