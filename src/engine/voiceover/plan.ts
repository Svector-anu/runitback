import { stretch } from "#/engine/audio";
import type { SpeechEngine, SynthesizedSpeech, VoiceoverRequest } from "./types";

export const MAX_PASSAGE_CHARS = 180;
export const MAX_VOICEOVER_CHARS = 2000;
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const PASSAGE_GAP_SECONDS = 0.28;
const SENTENCE_END = /(?<=[.!?…])\s+/u;
const CLAUSE_BREAK = /(?<=[,;:])\s+/u;

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** English words for an integer 0..999,999,999 (larger numbers are read digit by digit). */
export function numberToWords(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 999_999_999) return String(value).split("").map((d) => ONES[Number(d)] ?? d).join(" ");
  if (value < 20) return ONES[value] as string;
  if (value < 100) return `${TENS[Math.floor(value / 10)]}${value % 10 ? `-${ONES[value % 10]}` : ""}`;
  if (value < 1000) return `${ONES[Math.floor(value / 100)]} hundred${value % 100 ? ` ${numberToWords(value % 100)}` : ""}`;
  for (const [size, name] of [[1_000_000, "million"], [1000, "thousand"]] as const) {
    if (value >= size) return `${numberToWords(Math.floor(value / size))} ${name}${value % size ? ` ${numberToWords(value % size)}` : ""}`;
  }
  return String(value);
}

/** Spells out digits, percent and ampersands, which the character-level voice model would otherwise skip or mangle. */
export function normalizeForSpeech(text: string): string {
  return text
    .replace(/(\d+)\s*%/g, (_, n: string) => `${numberToWords(Number(n))} percent`)
    .replace(/&/g, " and ")
    .replace(/(\d{1,3}(?:,\d{3})+|\d+)/g, (n: string) => numberToWords(Number(n.replace(/,/g, ""))))
    .replace(/\s+/g, " ")
    .trim();
}

function splitLong(passage: string, limit: number): string[] {
  if (passage.length <= limit) return [passage];
  const clauses = passage.split(CLAUSE_BREAK);
  const out: string[] = [];
  let line = "";
  const push = (piece: string): void => {
    if (piece.length > limit) {
      for (const word of piece.split(" ")) {
        if (line && `${line} ${word}`.length > limit) {
          out.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      return;
    }
    if (line && `${line} ${piece}`.length > limit) {
      out.push(line);
      line = piece;
    } else line = line ? `${line} ${piece}` : piece;
  };
  clauses.forEach(push);
  if (line) out.push(line);
  return out;
}

/** The passages to synthesize one at a time: sentences, long ones broken at clauses and then words. */
export function planPassages(text: string, limit = MAX_PASSAGE_CHARS): string[] {
  const normalized = normalizeForSpeech(text);
  return normalized.split(SENTENCE_END).flatMap((sentence) => splitLong(sentence.trim(), limit)).filter((p) => /[\p{L}\p{N}]/u.test(p));
}

export class VoiceoverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceoverError";
  }
}

/** Synthesizes every passage, joins them with short pauses and applies the speed. Mono, at the engine's sample rate. */
export async function synthesizeVoiceover(input: VoiceoverRequest & { engine: SpeechEngine }): Promise<SynthesizedSpeech> {
  if (input.text.length > MAX_VOICEOVER_CHARS) throw new VoiceoverError(`Voice-overs are limited to ${MAX_VOICEOVER_CHARS} characters at a time; this text has ${input.text.length}. Split it into parts.`);
  if (input.speed < SPEED_MIN || input.speed > SPEED_MAX) throw new VoiceoverError(`Speed must be between ${SPEED_MIN} and ${SPEED_MAX}.`);
  const passages = planPassages(input.text);
  if (passages.length === 0) throw new VoiceoverError("There is nothing to say: the text has no letters or digits.");
  const parts: Float32Array[] = [];
  let sampleRate = 0;
  for (const [index, text] of passages.entries()) {
    input.signal?.throwIfAborted();
    const speech = await input.engine.synthesize({ text, voiceId: input.voiceId, ...(input.signal ? { signal: input.signal } : {}) });
    sampleRate = speech.sampleRate;
    parts.push(speech.samples);
    input.onProgress?.((index + 1) / passages.length);
  }
  const gap = new Float32Array(Math.round(PASSAGE_GAP_SECONDS * sampleRate));
  const total = parts.reduce((n, p) => n + p.length, 0) + gap.length * (parts.length - 1);
  const joined = new Float32Array(total);
  let offset = 0;
  parts.forEach((part, i) => {
    joined.set(part, offset);
    offset += part.length + (i < parts.length - 1 ? gap.length : 0);
  });
  if (input.speed === 1) return { samples: joined, sampleRate };
  const [stretched] = stretch({ channels: [joined], rate: input.speed, sampleRate });
  return { samples: Float32Array.from(stretched as Float32Array), sampleRate };
}
