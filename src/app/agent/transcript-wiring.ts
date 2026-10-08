import { createTranscriptTools, type AgentTool } from "#/engine/agent";
import { getTranscribeService } from "../transcribe-service";

/** Transcript tools backed by the shared store and the consent-gated on-device transcriber. */
export function createAppTranscriptTools(): AgentTool[] {
  const service = getTranscribeService();
  return createTranscriptTools({ store: service.store, transcriber: service.gatedTranscriber });
}
