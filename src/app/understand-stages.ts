import { MEDIA_ANALYSIS_VERSION } from "#/engine/analysis";
import type { FaceDetections, FaceIndexer, FaceStore } from "#/engine/face";
import { isUsableFaceDetections } from "#/engine/face";
import { TICKS_PER_SECOND } from "#/engine/time";
import type { ModelDownload, StageId, UnderstandStage } from "#/engine/understand";
import { isUsableEmbeddings } from "#/engine/visual";
import { analysisCacheKey, analyzeMedia, type AnalysisStore } from "#/platform/analysis";
import { DEFAULT_FACE_MODEL, IdbFaceStore, createFaceIndexer, type Footage } from "#/platform/visual";
import { sharedAnalysisStore } from "./agent/platform-tools";
import { MODEL_DOWNLOAD_NOTE, getTranscribeService } from "./transcribe-service";
import { UnderstandService, type UnderstandConsent } from "./understand-service";
import { VISUAL_MODEL_NOTE, getVisualService } from "./visual-service";
import { getServices } from "./services";

const missingMedia = (assetId: string): Error => new Error(`Media for asset ${assetId} is not loaded`);

export function analysisStage(deps: { store: () => AnalysisStore; getBlob: (assetId: string) => Blob | undefined }): UnderstandStage {
  return {
    id: "analysis",
    async has(asset) {
      const cached = await deps.store().get(analysisCacheKey(asset));
      return cached !== undefined && cached.version === MEDIA_ANALYSIS_VERSION;
    },
    async run({ asset, signal, onProgress }) {
      const blob = deps.getBlob(asset.id);
      if (!blob) throw missingMedia(asset.id);
      await analyzeMedia(blob, asset, { store: deps.store(), signal, onProgress: (p) => onProgress(p.overall) });
    },
  };
}

export function transcriptStage(): UnderstandStage {
  const service = getTranscribeService();
  return {
    id: "transcript",
    async has(asset) {
      return (await service.store.get(asset.id)) !== undefined;
    },
    async run({ asset, signal, onProgress }) {
      await service.gatedTranscriber.transcribe({ assetId: asset.id, signal, onProgress });
    },
  };
}

export function visualStage(): UnderstandStage {
  const service = getVisualService();
  return {
    id: "visual",
    async has(asset) {
      const stored = await service.store.get(asset.id);
      return stored !== undefined && isUsableEmbeddings(stored, service.gatedSearcher.model);
    },
    async run({ asset, signal, onProgress }) {
      const embeddings = await service.gatedIndexer.index({ assetId: asset.id, signal, onProgress });
      await service.store.save(embeddings);
    },
  };
}

interface FaceHookHost {
  __faces?: { indexer?: FaceIndexer };
}

/** A face-detector test double may be injected for e2e tests, but only in dev/test builds: Vite strips this branch from production. */
function devTestFaceIndexer(): FaceIndexer | undefined {
  if (!import.meta.env.DEV) return undefined;
  return (globalThis as FaceHookHost).__faces?.indexer;
}

let sharedFaceStore: FaceStore | null = null;

export function getFaceStore(): FaceStore {
  sharedFaceStore ??= new IdbFaceStore();
  return sharedFaceStore;
}

export function faceStage(deps: { store: () => FaceStore; indexer: () => FaceIndexer }): UnderstandStage {
  return {
    id: "faces",
    async has(asset) {
      const stored: FaceDetections | undefined = await deps.store().get(asset.id);
      return stored !== undefined && isUsableFaceDetections(stored, DEFAULT_FACE_MODEL);
    },
    async run({ asset, signal, onProgress }) {
      const detections = await deps.indexer().index({ assetId: asset.id, signal, onProgress });
      await deps.store().save(detections);
    },
  };
}

/** Sampling grid for faces: the asset's duration plus the scene cuts the analysis stage has already cached. */
async function footageOf(assetId: string): Promise<Footage> {
  const info = getServices().editor.getAsset(assetId);
  const analysis = info ? await sharedAnalysisStore().get(analysisCacheKey(info)) : undefined;
  const fallback = info?.duration !== undefined ? info.duration / TICKS_PER_SECOND : 0;
  return { durationSeconds: analysis?.durationSeconds ?? fallback, cutTimes: analysis?.sceneCuts.map((c) => c.time) ?? [] };
}

const MODEL_STAGE_NOTES: Partial<Record<StageId, { model: string; approxMegabytes: number }>> = {
  transcript: { model: MODEL_DOWNLOAD_NOTE.model, approxMegabytes: MODEL_DOWNLOAD_NOTE.approxMegabytes },
  visual: { model: VISUAL_MODEL_NOTE.model, approxMegabytes: VISUAL_MODEL_NOTE.approxMegabytes },
};

function appConsent(): UnderstandConsent {
  return {
    async pending(stages) {
      const needs = await Promise.all(stages.map(async (stage) => {
        const needed = stage === "transcript" ? await getTranscribeService().needsConsent() : stage === "visual" ? await getVisualService().needsConsent() : false;
        const note = MODEL_STAGE_NOTES[stage];
        return needed && note ? [{ stage, ...note } satisfies ModelDownload] : [];
      }));
      return needs.flat();
    },
    grant(stages) {
      if (stages.includes("transcript")) getTranscribeService().grantConsent();
      if (stages.includes("visual")) getVisualService().grantConsent();
    },
  };
}

let sharedService: UnderstandService | null = null;

export function getUnderstandService(): UnderstandService {
  sharedService ??= new UnderstandService({
    getAsset: (assetId) => getServices().editor.getAsset(assetId),
    consent: appConsent(),
    stages: [
      analysisStage({ store: sharedAnalysisStore, getBlob: (assetId) => getServices().runtime.getBlob(assetId) }),
      transcriptStage(),
      visualStage(),
      faceStage({
        store: getFaceStore,
        indexer: () => devTestFaceIndexer() ?? createFaceIndexer({ getVideo: (assetId) => getServices().runtime.getBlob(assetId), getFootage: footageOf }),
      }),
    ],
  });
  return sharedService;
}
