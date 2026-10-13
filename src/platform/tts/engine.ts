import { findVoice, type SpeechEngine } from "#/engine/voiceover";
import { SPEAKER_EMBEDDING_SIZE, SPEECHT5_MODEL } from "./models";
import type { TtsBackend } from "./protocol";
import { createWorkerBackend } from "./worker-backend";

export interface SpeechT5EngineOptions {
  model?: string;
  /** The 512-float speaker embedding of a voice. Defaults to the copy shipped in `public/tts/voices`. */
  loadSpeaker?: (voiceId: string) => Promise<Float32Array>;
  /** Test seam: replaces the worker-backed model. */
  createBackend?: (input: { model: string; onProgress: (fraction: number) => void }) => TtsBackend;
  /** The worker (and the model in it) is released this long after the last request. */
  idleMs?: number;
  onDownloadProgress?: (fraction: number) => void;
}

export interface DisposableSpeechEngine extends SpeechEngine {
  dispose(): void;
}

const base = (): string => (typeof import.meta.env?.BASE_URL === "string" ? import.meta.env.BASE_URL : "/");

export async function fetchSpeaker(voiceId: string): Promise<Float32Array> {
  const response = await fetch(`${base()}tts/voices/${voiceId}.bin`);
  if (!response.ok) throw new Error(`Could not load the voice "${voiceId}" (HTTP ${response.status})`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== SPEAKER_EMBEDDING_SIZE * 4) throw new Error(`The voice file for "${voiceId}" has an unexpected size`);
  return new Float32Array(bytes);
}

/** SpeechT5 text-to-speech on a worker. One worker serves a burst of passages, then is released after `idleMs`. */
export function createSpeechT5Engine(options: SpeechT5EngineOptions = {}): DisposableSpeechEngine {
  const model = options.model ?? SPEECHT5_MODEL;
  const loadSpeaker = options.loadSpeaker ?? fetchSpeaker;
  const createBackend = options.createBackend ?? ((input) => createWorkerBackend(input));
  const idleMs = options.idleMs ?? 20_000;
  let backend: TtsBackend | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const speakers = new Map<string, Promise<Float32Array>>();

  const dispose = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    backend?.dispose();
    backend = null;
  };
  return {
    async synthesize({ text, voiceId, signal }) {
      if (!findVoice(voiceId)) throw new Error(`Unknown voice "${voiceId}"`);
      if (signal?.aborted) throw new DOMException("Speech generation was aborted", "AbortError");
      let speaker = speakers.get(voiceId);
      if (!speaker) {
        speaker = loadSpeaker(voiceId);
        speakers.set(voiceId, speaker);
        speaker.catch(() => speakers.delete(voiceId));
      }
      const embedding = await speaker;
      if (timer !== null) clearTimeout(timer);
      backend ??= createBackend({ model, onProgress: (fraction) => options.onDownloadProgress?.(fraction) });
      const active = backend;
      const onAbort = (): void => {
        if (backend === active) dispose();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        return await active.synthesize({ text, speaker: Float32Array.from(embedding) });
      } catch (error) {
        if (signal?.aborted) throw new DOMException("Speech generation was aborted", "AbortError");
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (backend === active) timer = setTimeout(dispose, idleMs);
      }
    },
    dispose,
  };
}
