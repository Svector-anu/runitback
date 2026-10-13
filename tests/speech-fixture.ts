/**
 * Deterministic "speech plus noise" signal for noise-removal measurements: a pitch-gliding glottal pulse train through
 * vowel formant resonators (a, i, u, e), gated into 0.28 s syllables with a pause every fourth one, plus coloured
 * (pink-ish) noise. Not real speech, but it has the voiced harmonic structure, formants and pauses a denoiser keys on.
 */
export const SYLLABLE_SECONDS = 0.28;

export interface SpeechFixture {
  sampleRate: number;
  clean: Float32Array;
  noise: Float32Array;
  mixed: Float32Array;
  /** Spans (seconds) with only noise: the middle of every pause syllable. */
  pauses: Array<[number, number]>;
  /** Spans (seconds) in the steady part of voiced syllables. */
  voiced: Array<[number, number]>;
}

const VOWELS: ReadonlyArray<readonly [number, number, number]> = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [660, 1720, 2410]];

export function speechPlusNoise(input: { sampleRate?: number; seconds?: number; noiseAmplitude?: number } = {}): SpeechFixture {
  const sampleRate = input.sampleRate ?? 48_000;
  const seconds = input.seconds ?? 6;
  const noiseAmplitude = input.noiseAmplitude ?? 0.03;
  const length = Math.round(sampleRate * seconds);
  let seed = 1;
  const random = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const resonator = (frequency: number, bandwidth: number) => {
    const r = Math.exp((-Math.PI * bandwidth) / sampleRate);
    return { a1: -2 * r * Math.cos((2 * Math.PI * frequency) / sampleRate), a2: r * r, gain: 1 - r, y1: 0, y2: 0 };
  };
  const filters = VOWELS.map((formants) => formants.map((f, k) => resonator(f, 80 + 40 * k)));
  const clean = new Float32Array(length);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const syllable = Math.floor(t / SYLLABLE_SECONDS);
    const within = (t % SYLLABLE_SECONDS) / SYLLABLE_SECONDS;
    const gate = syllable % 4 === 3 ? 0 : Math.sin(Math.PI * within) ** 0.6;
    const f0 = 115 + 25 * Math.sin(2 * Math.PI * 0.9 * t) + 10 * Math.sin(2 * Math.PI * 5.5 * t);
    phase += f0 / sampleRate;
    let pulse = 0;
    if (phase >= 1) {
      phase -= 1;
      pulse = 1;
    }
    let y = 0;
    (filters[syllable % 4] as ReturnType<typeof resonator>[]).forEach((s, k) => {
      const o = s.gain * pulse - s.a1 * s.y1 - s.a2 * s.y2;
      s.y2 = s.y1;
      s.y1 = o;
      y += o * (k === 0 ? 1 : 0.6 / k);
    });
    clean[i] = y * gate;
  }
  const peak = clean.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  for (let i = 0; i < length; i++) clean[i] = ((clean[i] as number) / peak) * 0.5;
  const noise = new Float32Array(length);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < length; i++) {
    const w = random();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    noise[i] = (b0 + b1 + b2 + w * 0.1848) * noiseAmplitude * 0.5;
  }
  const mixed = clean.map((v, i) => v + (noise[i] as number));
  const syllables = Math.floor(seconds / SYLLABLE_SECONDS);
  const pauses: Array<[number, number]> = [];
  const voiced: Array<[number, number]> = [];
  for (let s = 0; s < syllables; s++) {
    const start = s * SYLLABLE_SECONDS;
    if (s % 4 === 3) pauses.push([start + 0.03, start + SYLLABLE_SECONDS - 0.03]);
    else voiced.push([start + 0.07, start + 0.21]);
  }
  return { sampleRate, clean, noise, mixed, pauses, voiced };
}

export function rmsDb(samples: Float32Array, sampleRate: number, spans: ReadonlyArray<readonly [number, number]>): number {
  let sum = 0;
  let count = 0;
  for (const [from, to] of spans) {
    for (let i = Math.round(from * sampleRate); i < Math.min(samples.length, Math.round(to * sampleRate)); i++) {
      sum += (samples[i] as number) ** 2;
      count++;
    }
  }
  return 10 * Math.log10(Math.max(sum / Math.max(1, count), 1e-20));
}

/** 16-bit mono PCM WAV bytes, for importing the fixture into the app. */
export function wavBytes(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string): void => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true));
  return new Uint8Array(buffer);
}
