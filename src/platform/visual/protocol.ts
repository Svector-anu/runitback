/** An RGBA frame, ready for the image model's preprocessor. */
export interface ImagePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Embeds frames and text in one vector space. Rows come back L2-normalised. */
export interface ClipBackend {
  embedImages(input: { images: ImagePixels[]; onLoad?: (fraction: number) => void }): Promise<Float32Array[]>;
  embedTexts(input: { texts: string[]; onLoad?: (fraction: number) => void }): Promise<Float32Array[]>;
  dispose(): void;
}

/** Row-major batch of embeddings as the model returns it, before normalisation. */
export interface EncodedBatch {
  data: Float32Array;
  dimensions: number;
}

export type WorkerRequest =
  | { type: "embed-images"; id: number; model: string; images: ImagePixels[] }
  | { type: "embed-texts"; id: number; model: string; texts: string[] };

export type WorkerResponse =
  | { type: "loading"; id: number; fraction: number }
  | { type: "result"; id: number; data: Float32Array; dimensions: number }
  | { type: "error"; id: number; message: string };
