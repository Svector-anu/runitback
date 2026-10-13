import type { Voice } from "./types";

/**
 * Speaker identities of the SpeechT5 voice model: x-vectors extracted from the CMU ARCTIC speakers (MIT).
 * All speak English; a voice changes timbre and pitch, not language.
 */
export const VOICES: ReadonlyArray<Voice> = [
  { id: "slt", label: "Female, US (slt)", description: "US English, female" },
  { id: "clb", label: "Female, US (clb)", description: "US English, female, brighter" },
  { id: "bdl", label: "Male, US (bdl)", description: "US English, male" },
  { id: "rms", label: "Male, US (rms)", description: "US English, male, deeper" },
  { id: "awb", label: "Male, Scottish (awb)", description: "Scottish English, male" },
  { id: "jmk", label: "Male, Canadian (jmk)", description: "Canadian English, male" },
  { id: "ksp", label: "Male, Indian (ksp)", description: "Indian English, male" },
];

export const DEFAULT_VOICE_ID = "slt";

export function findVoice(id: string): Voice | undefined {
  return VOICES.find((v) => v.id === id);
}
