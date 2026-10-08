import type { Page } from "@playwright/test";

export interface ToneSpan { from: number; to: number }
export interface ColorBlock { seconds: number; rgb: [number, number, number] }

declare global {
  interface Window {
    __analysisFile?: File;
  }
}

/**
 * Builds a real VP9/Opus WebM in the page with known structure: solid colour blocks (with a small moving
 * marker so frames are not byte-identical) and a 440 Hz tone only inside `tones`. Result is stored on `window.__analysisFile`.
 */
export async function makeStructuredWebm(page: Page, input: { blocks: ColorBlock[]; tones: ToneSpan[]; name: string; fps?: number }): Promise<void> {
  await page.evaluate(async ({ blocks, tones, name, fps }) => {
    const url = "/node_modules/.vite/deps/mediabunny.js";
    const { Output, WebMOutputFormat, BufferTarget, CanvasSource, AudioBufferSource, QUALITY_HIGH } = (await import(url)) as typeof import("mediabunny");
    const seconds = blocks.reduce((a, b) => a + b.seconds, 0);
    const canvas = new OffscreenCanvas(320, 180);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const video = new CanvasSource(canvas, { codec: "vp9", bitrate: QUALITY_HIGH });
    output.addVideoTrack(video, { frameRate: fps });
    const audio = new AudioBufferSource({ codec: "opus", bitrate: 96000 });
    output.addAudioTrack(audio);
    await output.start();

    const rate = 48000;
    const buffer = new AudioBuffer({ length: Math.round(rate * seconds), sampleRate: rate, numberOfChannels: 1 });
    const data = buffer.getChannelData(0);
    for (const span of tones) {
      for (let i = Math.round(span.from * rate); i < Math.min(data.length, Math.round(span.to * rate)); i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3;
    }
    await audio.add(buffer);
    audio.close();

    const frames = Math.round(seconds * fps);
    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      let acc = 0;
      let block = blocks[blocks.length - 1] as (typeof blocks)[number];
      for (const b of blocks) {
        acc += b.seconds;
        if (t < acc - 1e-9) {
          block = b;
          break;
        }
      }
      ctx.fillStyle = `rgb(${block.rgb[0]} ${block.rgb[1]} ${block.rgb[2]})`;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect((i % 60) * 4, 150, 16, 16);
      await video.add(t, 1 / fps);
    }
    await output.finalize();
    const bytes = (output.target as InstanceType<typeof BufferTarget>).buffer as ArrayBuffer;
    window.__analysisFile = new File([bytes], name, { type: "video/webm", lastModified: 1_700_000_000_000 });
  }, { blocks: input.blocks, tones: input.tones, name: input.name, fps: input.fps ?? 30 });
}
