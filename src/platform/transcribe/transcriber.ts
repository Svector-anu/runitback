import { TRANSCRIPT_VERSION, type Transcriber, type Transcript } from "#/engine/transcript/types";
import { openAudio16k, type AudioSource } from "./audio-source";
import { ChunkAssembler, WHISPER_SAMPLE_RATE, mergeChunkWords, type AudioChunk, type ChunkWords } from "./chunking";
import type { WhisperBackend } from "./protocol";
import { createWorkerBackend } from "./worker-backend";

/** The `_timestamped` export carries cross-attention outputs, which word-level timestamps need; the plain export cannot produce them. */
export const DEFAULT_WHISPER_MODEL = "onnx-community/whisper-tiny.en_timestamped";

export class NoAudioError extends Error {
  constructor() {
    super("This media has no audio track to transcribe");
    this.name = "NoAudioError";
  }
}

export interface WhisperTranscriberOptions {
  /** The imported media file for an asset, or undefined when it is unknown. */
  getAudio(assetId: string): Blob | undefined;
  model?: string;
  /** Test seam: replaces the worker-backed recogniser. */
  createBackend?: (model: string) => WhisperBackend;
  /** Test seam: replaces mediabunny decoding. */
  openAudio?: (blob: Blob) => Promise<AudioSource | null>;
}

const abortError = (): DOMException => new DOMException("Transcription was aborted", "AbortError");

/** "onnx-community/whisper-tiny.en_timestamped" -> "whisper-tiny.en_timestamped" */
export const modelLabel = (model: string): string => model.slice(model.lastIndexOf("/") + 1);

/**
 * Local speech-to-text. Audio is decoded to 16 kHz mono, cut into 30 s windows (20 s core + 5 s context either side),
 * recognised one window at a time in a worker, and merged by word midpoint. Nothing is uploaded.
 */
export function createWhisperTranscriber(options: WhisperTranscriberOptions): Transcriber {
  const model = options.model ?? DEFAULT_WHISPER_MODEL;
  const createBackend = options.createBackend ?? createWorkerBackend;
  const open = options.openAudio ?? openAudio16k;
  return {
    async transcribe({ assetId, language, signal, onProgress }): Promise<Transcript> {
      if (signal?.aborted) throw abortError();
      const blob = options.getAudio(assetId);
      if (!blob) throw new Error(`Media for asset ${assetId} is not loaded`);
      const source = await open(blob);
      if (!source) throw new NoAudioError();
      const backend = createBackend(model);
      const onAbort = (): void => backend.dispose();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const assembler = new ChunkAssembler();
        const results: ChunkWords[] = [];
        const duration = Math.max(source.durationSeconds, 1 / WHISPER_SAMPLE_RATE);
        const recogniseChunk = async (chunk: AudioChunk): Promise<void> => {
          if (signal?.aborted) throw abortError();
          const words = await backend.recognise({ samples: chunk.samples, language });
          results.push({
            coreStartSeconds: chunk.coreStartSeconds,
            coreEndSeconds: chunk.coreEndSeconds,
            words: words.map((w) => ({ text: w.text, startSeconds: chunk.startSeconds + w.startSeconds, endSeconds: chunk.startSeconds + w.endSeconds })),
          });
          onProgress?.(Math.min(1, Number.isFinite(chunk.coreEndSeconds) ? chunk.coreEndSeconds / duration : 1));
        };
        for await (const block of source.blocks()) {
          for (const chunk of assembler.push(block)) await recogniseChunk(chunk);
        }
        for (const chunk of assembler.finish()) await recogniseChunk(chunk);
        onProgress?.(1);
        return { version: TRANSCRIPT_VERSION, assetId, language: language ?? "en", model: modelLabel(model), words: mergeChunkWords(results) };
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        backend.dispose();
        source.dispose();
      }
    },
  };
}
