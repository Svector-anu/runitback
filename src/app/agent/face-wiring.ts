import type { AgentTool } from "#/engine/agent";
import { createFaceTools } from "#/engine/agent/tools-face";
import type { FaceStore } from "#/engine/face";
import type { AnalysisProvider } from "#/engine/reference";
import { IdbFaceStore } from "#/platform/visual";

let sharedStore: FaceStore | null = null;

/** The browser's face-detection store, or undefined where IndexedDB does not exist (the agent then simply has no face tools). */
export function getFaceStore(): FaceStore | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  sharedStore ??= new IdbFaceStore();
  return sharedStore;
}

/**
 * Face tools (find_face_moments, describe_faces, reframe_to_faces) over the stored detections. They read what
 * indexing saved and never start detection themselves. With the analysis provider, shots follow the scene cuts.
 */
export function createAppFaceTools(provider?: AnalysisProvider): AgentTool[] {
  const faces = getFaceStore();
  return faces ? createFaceTools({ faces, ...(provider ? { analysis: provider } : {}) }) : [];
}
