export interface TtsBackend {
  synthesize(input: { text: string; speaker: Float32Array }): Promise<{ samples: Float32Array; sampleRate: number }>;
  dispose(): void;
}

export type TtsRequest = { type: "synthesize"; id: number; model: string; text: string; speaker: Float32Array };

export type TtsResponse =
  | { type: "result"; id: number; samples: Float32Array; sampleRate: number }
  | { type: "progress"; id: number; fraction: number }
  | { type: "error"; id: number; message: string };
