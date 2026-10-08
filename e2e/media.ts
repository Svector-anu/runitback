import type { Page } from "@playwright/test";

/** Builds a real WebM (VP9 video + Opus tone) inside the page with the same encoder stack the app exports with. */
export async function makeWebm(page: Page, input: { seconds: number; hue: number; name: string; withAudio?: boolean }): Promise<void> {
  await page.evaluate(async ({ seconds, hue, name, withAudio }) => {
    const url = "/node_modules/.vite/deps/mediabunny.js";
    const { Output, WebMOutputFormat, BufferTarget, CanvasSource, AudioBufferSource, QUALITY_MEDIUM } = (await import(url)) as typeof import("mediabunny");
    const canvas = new OffscreenCanvas(320, 180);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const video = new CanvasSource(canvas, { codec: "vp9", bitrate: QUALITY_MEDIUM });
    output.addVideoTrack(video, { frameRate: 30 });
    let audio: InstanceType<typeof AudioBufferSource> | null = null;
    if (withAudio) {
      audio = new AudioBufferSource({ codec: "opus", bitrate: 64000 });
      output.addAudioTrack(audio);
    }
    await output.start();
    if (audio) {
      const rate = 48000;
      const ac = new AudioContext({ sampleRate: rate });
      const buf = ac.createBuffer(1, rate * seconds, rate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3;
      await audio.add(buf);
      audio.close();
    }
    const frames = Math.round(seconds * 30);
    for (let i = 0; i < frames; i++) {
      ctx.fillStyle = `hsl(${(hue + i * 3) % 360} 80% 50%)`;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "#fff";
      ctx.fillRect((i / frames) * 280, 70, 40, 40);
      await video.add(i / 30, 1 / 30);
    }
    await output.finalize();
    const file = new File([(output.target as InstanceType<typeof BufferTarget>).buffer as ArrayBuffer], name, { type: "video/webm" });
    (window as unknown as { __files?: File[] }).__files = [...((window as unknown as { __files?: File[] }).__files ?? []), file];
  }, input);
}

/** Feeds files created by makeWebm into the media import input. */
export async function importGenerated(page: Page): Promise<void> {
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Import media files"]');
    if (!input) throw new Error("import input not found");
    const dt = new DataTransfer();
    for (const f of (window as unknown as { __files: File[] }).__files) dt.items.add(f);
    (window as unknown as { __files: File[] }).__files = [];
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
