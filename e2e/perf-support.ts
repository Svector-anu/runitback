import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";

const ARTIFACTS = "e2e/.artifacts";

/** Records a measurement for docs/PERFORMANCE.md under e2e/.artifacts (gitignored) and prints it. */
export function recordMeasurement(name: string, values: Record<string, number | string | boolean>): void {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(`${ARTIFACTS}/${name}.json`, JSON.stringify(values, null, 2));
  process.stdout.write(`[perf] ${name} ${JSON.stringify(values)}\n`);
}

export interface FrameStats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  longTasks: number;
  longTaskMs: number;
}

/** Starts a requestAnimationFrame gap recorder and a long-task observer inside the page. */
export async function startFrameProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __probe?: { gaps: number[]; longMs: number[]; stop(): void } };
    w.__probe?.stop();
    const gaps: number[] = [];
    const longMs: number[] = [];
    let last = performance.now();
    let running = true;
    const tick = (now: number): void => {
      if (!running) return;
      gaps.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) longMs.push(e.duration); });
    observer.observe({ entryTypes: ["longtask"] });
    w.__probe = { gaps, longMs, stop: () => { running = false; observer.disconnect(); } };
  });
}

export async function stopFrameProbe(page: Page): Promise<FrameStats> {
  return page.evaluate(() => {
    const w = window as unknown as { __probe: { gaps: number[]; longMs: number[]; stop(): void } };
    w.__probe.stop();
    const sorted = [...w.__probe.gaps].sort((a, b) => a - b);
    const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const round = (n: number): number => Math.round(n * 10) / 10;
    return {
      frames: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1] ?? 0),
      longTasks: w.__probe.longMs.length, longTaskMs: round(w.__probe.longMs.reduce((a, b) => a + b, 0)),
    };
  });
}

/** Samples the JS heap of the page through CDP until the returned stop function is called. */
export async function sampleHeap(page: Page): Promise<() => Promise<{ peakMb: number; samples: number }>> {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  let peak = 0;
  let samples = 0;
  let running = true;
  const loop = (async (): Promise<void> => {
    while (running) {
      const { metrics } = await session.send("Performance.getMetrics");
      const used = metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
      peak = Math.max(peak, used);
      samples++;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  })();
  return async () => {
    running = false;
    await loop;
    await session.detach();
    return { peakMb: Math.round(peak / 1e5) / 10, samples };
  };
}

const MEDIA_DIR = `${ARTIFACTS}/perf-media`;

/** Generates (once) a synthetic H.264/AAC file with ffmpeg. Never committed: e2e/.artifacts is gitignored. */
export function ensureH264(input: { name: string; width: number; height: number; fps: number; seconds: number; keyframeSeconds?: number }): string {
  const path = `${MEDIA_DIR}/${input.name}`;
  if (existsSync(path)) return path;
  mkdirSync(MEDIA_DIR, { recursive: true });
  execFileSync("/opt/homebrew/bin/ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${input.width}x${input.height}:rate=${input.fps}:duration=${input.seconds}`,
    "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${input.seconds}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-pix_fmt", "yuv420p", "-g", String(Math.round(input.fps * (input.keyframeSeconds ?? 2))),
    "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-shortest", "-movflags", "+faststart", path,
  ], { stdio: "inherit" });
  return path;
}
