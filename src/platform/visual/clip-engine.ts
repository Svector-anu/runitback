import { normalize } from "#/engine/visual";
import type { EncodedBatch, ImagePixels } from "./protocol";

export type ImageEncoder = (images: ImagePixels[]) => Promise<EncodedBatch>;
export type TextEncoder = (texts: string[]) => Promise<EncodedBatch>;

export interface ClipEngineDeps {
  loadImageEncoder(model: string, onLoad: (fraction: number) => void): Promise<ImageEncoder>;
  loadTextEncoder(model: string, onLoad: (fraction: number) => void): Promise<TextEncoder>;
}

/** Splits a row-major batch into one L2-normalised vector per row. */
export function normalizeRows(batch: EncodedBatch): Float32Array[] {
  const rows = batch.dimensions > 0 ? Math.floor(batch.data.length / batch.dimensions) : 0;
  return Array.from({ length: rows }, (_, i) => normalize(batch.data.slice(i * batch.dimensions, (i + 1) * batch.dimensions)));
}

interface ProgressEvent {
  status?: unknown;
  file?: unknown;
  loaded?: unknown;
  total?: unknown;
}

/**
 * Folds transformers.js per-file download events into one 0..1 fraction that never goes backwards (files are announced
 * as they start, so the total grows while loading).
 */
export function createLoadProgress(report: (fraction: number) => void): (event: unknown) => void {
  const files = new Map<string, { loaded: number; total: number }>();
  let best = 0;
  return (event) => {
    const e = event as ProgressEvent;
    if (typeof e.file !== "string") return;
    if (e.status === "progress" && typeof e.loaded === "number" && typeof e.total === "number" && e.total > 0) files.set(e.file, { loaded: e.loaded, total: e.total });
    else if (e.status === "done") {
      const known = files.get(e.file);
      if (known) files.set(e.file, { loaded: known.total, total: known.total });
    } else return;
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    if (total > 0) {
      best = Math.max(best, Math.min(1, loaded / total));
      report(best);
    }
  };
}

/** Model-agnostic core, shared by the worker and by tests (which inject fake encoders). Each encoder loads once per model. */
export function createClipEngine(deps: ClipEngineDeps): {
  embedImages(input: { model: string; images: ImagePixels[]; onLoad?: (fraction: number) => void }): Promise<EncodedBatch>;
  embedTexts(input: { model: string; texts: string[]; onLoad?: (fraction: number) => void }): Promise<EncodedBatch>;
} {
  const images = new Map<string, Promise<ImageEncoder>>();
  const texts = new Map<string, Promise<TextEncoder>>();

  function cached<T>(cache: Map<string, Promise<T>>, model: string, load: () => Promise<T>, onLoad?: (fraction: number) => void): Promise<T> {
    const existing = cache.get(model);
    if (existing) {
      onLoad?.(1);
      return existing;
    }
    const loading = load();
    cache.set(model, loading);
    loading.catch(() => cache.delete(model));
    return loading;
  }

  const flatten = (rows: Float32Array[]): EncodedBatch => {
    const dimensions = rows[0]?.length ?? 0;
    const data = new Float32Array(rows.length * dimensions);
    rows.forEach((row, i) => data.set(row, i * dimensions));
    return { data, dimensions };
  };

  return {
    async embedImages({ model, images: pixels, onLoad }) {
      const encode = await cached(images, model, () => deps.loadImageEncoder(model, onLoad ?? (() => undefined)), onLoad);
      return flatten(normalizeRows(await encode(pixels)));
    },
    async embedTexts({ model, texts: strings, onLoad }) {
      const encode = await cached(texts, model, () => deps.loadTextEncoder(model, onLoad ?? (() => undefined)), onLoad);
      return flatten(normalizeRows(await encode(strings)));
    },
  };
}
