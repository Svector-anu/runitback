import type { Page } from "@playwright/test";
import { wavBytes } from "../tests/speech-fixture";
import { importGenerated } from "./media";

/** A click track: a quiet pad plus a loud 25 ms burst on every beat `phase + k * 60 / bpm` (the eval fixture's shape). */
export function clickTrack(input: { bpm: number; phase: number; seconds: number; sampleRate?: number }): { samples: Float32Array; sampleRate: number; beats: number[] } {
  const sampleRate = input.sampleRate ?? 22_050;
  const samples = new Float32Array(Math.round(input.seconds * sampleRate));
  let seed = 3;
  const noise = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < samples.length; i++) samples[i] = 0.01 * noise();
  const beats: number[] = [];
  for (let t = input.phase; t < input.seconds - 0.05; t += 60 / input.bpm) {
    beats.push(Math.round(t * 1e6) / 1e6);
    const start = Math.round(t * sampleRate);
    for (let i = 0; i < Math.round(0.025 * sampleRate); i++) samples[start + i] = 0.9 * Math.sin((2 * Math.PI * 900 * i) / sampleRate) * (1 - i / (0.025 * sampleRate));
  }
  return { samples, sampleRate, beats };
}

/** Puts a WAV file made in Node into the page's import queue and imports it through the media input. */
export async function importWav(page: Page, input: { name: string; samples: Float32Array; sampleRate: number }): Promise<void> {
  const bytes = Array.from(wavBytes(input.samples, input.sampleRate));
  await page.evaluate(({ name, data }) => {
    const file = new File([new Uint8Array(data)], name, { type: "audio/wav" });
    const host = window as unknown as { __files?: File[] };
    host.__files = [...(host.__files ?? []), file];
  }, { name: input.name, data: bytes });
  await importGenerated(page);
}
