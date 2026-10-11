import { MEDIA_ANALYSIS_VERSION, type MediaAnalysis } from "#/engine/analysis";
import type { FaceDetections, FaceStore } from "#/engine/face";
import { FACE_INDEX_VERSION } from "#/engine/face";
import { TRANSCRIPT_VERSION, type Transcript, type TranscriptStore } from "#/engine/transcript";
import { VISUAL_INDEX_VERSION, type VisualEmbeddings, type VisualStore } from "#/engine/visual";
import { IdbAnalysisStore, analysisCacheKey, type AnalysisStore } from "./analysis";
import { DerivedDataRegistry, type DerivedDataStore } from "./derived-data";
import { IdbTranscriptStore } from "./transcribe";
import { IdbFaceStore, IdbVisualStore } from "./visual";

/** Embeddings below this are always exported; larger ones only when the caller opts in. */
export const SMALL_EMBEDDINGS_BYTES = 4 * 1024 * 1024;

const MAX_ITEMS = 5_000_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumberList = (v: unknown): v is number[] => Array.isArray(v) && v.length <= MAX_ITEMS && v.every(isFiniteNumber);

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function analysisAdapter(store: AnalysisStore): DerivedDataStore {
  return {
    kind: "analysis",
    deleteAsset: (assetId) => store.deleteAsset(assetId),
    assetIds: () => store.assetIds(),
    exportAsset: async (info) => store.get(analysisCacheKey(info)),
    async importAsset(info, payload) {
      if (!isObject(payload) || payload.version !== MEDIA_ANALYSIS_VERSION) return false;
      await store.put(analysisCacheKey(info), payload as unknown as MediaAnalysis);
      return true;
    },
  };
}

type IdListStore<T> = { delete(assetId: string): void | Promise<void>; assetIds(): Promise<string[]>; get(assetId: string): T | undefined | Promise<T | undefined> };

function perAssetAdapter<T>(kind: DerivedDataStore["kind"], store: IdListStore<T>): Pick<DerivedDataStore, "kind" | "deleteAsset" | "assetIds"> {
  return { kind, deleteAsset: async (assetId) => void (await store.delete(assetId)), assetIds: () => store.assetIds() };
}

export function transcriptAdapter(store: TranscriptStore & IdListStore<Transcript>): DerivedDataStore {
  return {
    ...perAssetAdapter("transcript", store),
    exportAsset: async (info) => store.get(info.id),
    async importAsset(info, payload) {
      if (!isObject(payload) || payload.version !== TRANSCRIPT_VERSION || typeof payload.model !== "string" || typeof payload.language !== "string") return false;
      const words = payload.words;
      if (!Array.isArray(words) || words.length > MAX_ITEMS) return false;
      const wellFormed = words.every((w: unknown) => isObject(w) && typeof w.text === "string" && isFiniteNumber(w.startSeconds) && isFiniteNumber(w.endSeconds));
      if (!wellFormed) return false;
      await store.save({ ...(payload as unknown as Transcript), assetId: info.id });
      return true;
    },
  };
}

export function faceAdapter(store: FaceStore & IdListStore<FaceDetections>): DerivedDataStore {
  return {
    ...perAssetAdapter("faces", store),
    exportAsset: async (info) => store.get(info.id),
    async importAsset(info, payload) {
      if (!isObject(payload) || payload.version !== FACE_INDEX_VERSION || typeof payload.model !== "string" || !isFiniteNumber(payload.durationSeconds)) return false;
      const frames = payload.frames;
      if (!Array.isArray(frames) || frames.length > MAX_ITEMS) return false;
      const boxOk = (b: unknown): boolean => isObject(b) && [b.x, b.y, b.width, b.height, b.score].every(isFiniteNumber);
      const frameOk = (f: unknown): boolean => isObject(f) && isFiniteNumber(f.t) && Array.isArray(f.boxes) && f.boxes.length < 1000 && f.boxes.every(boxOk);
      if (!frames.every(frameOk)) return false;
      await store.save({ ...(payload as unknown as FaceDetections), assetId: info.id });
      return true;
    },
  };
}

interface EncodedEmbeddings extends Omit<VisualEmbeddings, "vectors"> {
  vectorsBase64: string;
}

export function visualAdapter(store: VisualStore & IdListStore<VisualEmbeddings> & { delete(assetId: string): Promise<void> }): DerivedDataStore {
  return {
    ...perAssetAdapter("visual", store),
    async exportAsset(info, options) {
      const embeddings = await store.get(info.id);
      if (!embeddings) return undefined;
      if (!options.includeEmbeddings && embeddings.vectors.byteLength > SMALL_EMBEDDINGS_BYTES) return undefined;
      const { vectors, ...rest } = embeddings;
      const encoded: EncodedEmbeddings = { ...rest, vectorsBase64: bytesToBase64(new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength)) };
      return encoded;
    },
    async importAsset(info, payload) {
      if (!isObject(payload) || payload.version !== VISUAL_INDEX_VERSION || typeof payload.model !== "string" || typeof payload.vectorsBase64 !== "string") return false;
      const { dimensions, durationSeconds, cuts, times } = payload;
      if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192) return false;
      if (!isFiniteNumber(durationSeconds) || !isNumberList(cuts) || !isNumberList(times)) return false;
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(payload.vectorsBase64);
      } catch {
        return false;
      }
      if (bytes.length !== times.length * dimensions * 4) return false;
      const vectors = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      await store.save({ version: VISUAL_INDEX_VERSION, assetId: info.id, model: payload.model, dimensions, durationSeconds, cuts, times, vectors });
      return true;
    },
  };
}

export function browserDerivedData(): DerivedDataRegistry {
  return new DerivedDataRegistry()
    .register(analysisAdapter(new IdbAnalysisStore()))
    .register(transcriptAdapter(new IdbTranscriptStore()))
    .register(visualAdapter(new IdbVisualStore()))
    .register(faceAdapter(new IdbFaceStore()));
}
