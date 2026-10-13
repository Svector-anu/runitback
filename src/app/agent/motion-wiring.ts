import type { AgentTool } from "#/engine/agent";
import { getMotionAnalysis } from "../motion-analysis";

/** track_point and stabilize_clip: on-device motion analysis, cancelled with the agent turn. */
export function createAppMotionTools(signal?: () => AbortSignal | undefined): AgentTool[] {
  return getMotionAnalysis().tools(signal ? { signal } : {});
}
