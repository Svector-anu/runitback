export interface Voice {
  id: string;
  /** Short name shown in the picker. */
  label: string;
  description: string;
}

export interface SynthesizedSpeech {
  samples: Float32Array;
  sampleRate: number;
}

export interface SpeechEngine {
  /** Turns one short passage (a sentence or two) into speech. Long text is split by `planSpeech` first. */
  synthesize(input: { text: string; voiceId: string; signal?: AbortSignal }): Promise<SynthesizedSpeech>;
}

export interface VoiceoverRequest {
  text: string;
  voiceId: string;
  /** 0.5-2, 1 = natural pace. Applied with pitch-preserving time stretch after synthesis. */
  speed: number;
  signal?: AbortSignal;
  /** Called with the fraction of passages done. */
  onProgress?: (fraction: number) => void;
}
