/** A recognised word in the time base of the audio window it was recognised from. */
export interface RecognisedWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface RecogniseInput {
  samples: Float32Array;
  language?: string;
}

/** Runs one 16 kHz mono window through the speech model. */
export interface WhisperBackend {
  recognise(input: RecogniseInput): Promise<RecognisedWord[]>;
  dispose(): void;
}

export type WorkerRequest =
  | { type: "recognise"; id: number; model: string; samples: Float32Array; language?: string };

export type WorkerResponse =
  | { type: "result"; id: number; words: RecognisedWord[] }
  | { type: "error"; id: number; message: string };
