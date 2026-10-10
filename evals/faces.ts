import { createFaceTools } from "#/engine/agent/tools-face";
import type { AgentTool } from "#/engine/agent";
import { FACE_INDEX_VERSION, type FaceBox, type FaceDetections, type FaceStore } from "#/engine/face";
import type { AnalysisProvider } from "#/engine/reference";
import { planFrameTimes } from "#/engine/visual";
import type { ResolvedFixture } from "./types";

export const EVAL_FACE_MODEL = "eval/declared-faces";

/** A talking head: 12% of the frame wide, 20% tall, vertically a little above the middle. */
const speakerBox = (centerX: number): FaceBox => ({ x: centerX - 0.06, y: 0.3, width: 0.12, height: 0.2, score: 0.95 });

/**
 * Stand-in for the face detector: frames are sampled with the real sampling plan and each frame holds one face where the
 * fixture declares one, so tools see exactly what a perfect detector would report. Nothing is decoded.
 */
export function faceToolsFor(input: { fixtures: ReadonlyArray<ResolvedFixture>; provider: AnalysisProvider }): AgentTool[] {
  const withFaces = input.fixtures.filter((f) => f.spec.faces !== undefined);
  if (withFaces.length === 0) return [];
  const detections = withFaces.map((fixture): FaceDetections => {
    const cuts = fixture.truth.shots.slice(1).map((s) => s.start);
    const times = planFrameTimes({ durationSeconds: fixture.spec.durationSeconds, cutTimes: cuts });
    return {
      version: FACE_INDEX_VERSION, assetId: fixture.assetId, model: EVAL_FACE_MODEL, durationSeconds: fixture.spec.durationSeconds,
      frames: times.map((t) => {
        const showing = (fixture.spec.faces ?? []).find((f) => t >= f.start && t < f.end);
        return { t, boxes: showing ? [speakerBox(showing.centerX)] : [] };
      }),
    };
  });
  const byId = new Map(detections.map((d) => [d.assetId, d]));
  const faces: FaceStore = {
    get: (assetId) => byId.get(assetId),
    save: (d) => void byId.set(d.assetId, d),
    delete: (assetId) => void byId.delete(assetId),
  };
  return createFaceTools({ faces, model: EVAL_FACE_MODEL, analysis: input.provider });
}
