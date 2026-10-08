/** All times are seconds in SOURCE time of the asset (not timeline time). */

export const TRANSCRIPT_VERSION = 1;

export interface TranscriptWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
  /** 0..1 when the recognizer reports it. */
  confidence?: number;
}

export interface Transcript {
  version: typeof TRANSCRIPT_VERSION;
  assetId: string;
  /** BCP-47 language code reported or requested, e.g. "en". */
  language: string;
  /** Identifies the recognizer, e.g. "whisper-tiny.en". */
  model: string;
  words: TranscriptWord[];
}

/** Where finished transcripts live. The platform layer supplies a persistent implementation. */
export interface TranscriptStore {
  get(assetId: string): Transcript | undefined | Promise<Transcript | undefined>;
  save(transcript: Transcript): void | Promise<void>;
}

/** Runs speech recognition on an asset's audio. Implemented in the platform layer; the engine never decodes media. */
export interface Transcriber {
  transcribe(input: { assetId: string; language?: string; signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<Transcript>;
}

export function createMemoryTranscriptStore(): TranscriptStore {
  const entries = new Map<string, Transcript>();
  return { get: (assetId) => entries.get(assetId), save: (t) => { entries.set(t.assetId, t); } };
}
