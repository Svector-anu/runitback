import { AudioBufferSource, BufferTarget, CanvasSource, Output, QUALITY_HIGH, WebMOutputFormat } from "mediabunny";
import { getAgentSession } from "#/app/agent/instance";
import { createAgentTools } from "#/engine/agent";
import type { MediaAnalysis } from "#/engine/analysis";
import type { Project } from "#/engine/model";
import { MemoryAnalysisStore, analyzeMedia } from "#/platform/analysis";
import { getServices } from "#/app/services";
import { blocksOf, truthFromSpec } from "./fixtures";
import { POLICIES } from "./policies";
import { placeInitialTimeline } from "./setup";
import type { FixtureSpec, RunSummary } from "./types";

/**
 * Page-side half of the browser eval: runs inside the editor tab (loaded through the Vite dev server by
 * e2e/agent-eval.spec.ts). It generates REAL media from a fixture declaration, drives the real in-app agent session
 * with a scripted policy, and hands plain JSON back to the test, which scores it with the same checks as the headless suite.
 */

const WIDTH = 320;
const HEIGHT = 180;
const FPS = 30;
const SAMPLE_RATE = 48_000;
const TONE_HZ = 440;
const TONE_AMPLITUDE = 0.3;
const PAD_HZ = 220;
const PAD_AMPLITUDE = 0.03;
const CLICK_HZ = 1000;
const CLICK_AMPLITUDE = 0.8;
const CLICK_SECONDS = 0.06;
const CLICK_DECAY_SECONDS = 0.012;

function renderAudio(spec: FixtureSpec): AudioBuffer {
  const buffer = new AudioBuffer({ length: Math.round(SAMPLE_RATE * spec.durationSeconds), sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
  const data = buffer.getChannelData(0);
  const tone = (from: number, to: number, hz: number, amplitude: number): void => {
    for (let i = Math.round(from * SAMPLE_RATE); i < Math.min(data.length, Math.round(to * SAMPLE_RATE)); i++) data[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * amplitude;
  };
  const audio = spec.audio;
  if (audio.kind === "tone") tone(0, spec.durationSeconds, TONE_HZ, TONE_AMPLITUDE);
  else if (audio.kind === "speech") for (const range of audio.speech) tone(range.start, range.end, TONE_HZ, TONE_AMPLITUDE);
  else if (audio.kind === "beat") {
    tone(0, spec.durationSeconds, PAD_HZ, PAD_AMPLITUDE);
    for (let beat = audio.phase; beat < spec.durationSeconds; beat += 60 / audio.bpm) {
      const first = Math.round(beat * SAMPLE_RATE);
      for (let i = 0; i < Math.round(CLICK_SECONDS * SAMPLE_RATE) && first + i < data.length; i++) {
        data[first + i] = (data[first + i] ?? 0) + Math.sin((2 * Math.PI * CLICK_HZ * i) / SAMPLE_RATE) * CLICK_AMPLITUDE * Math.exp(-i / (SAMPLE_RATE * CLICK_DECAY_SECONDS));
      }
    }
  }
  return buffer;
}

/** A real WebM (VP9 video and/or Opus audio) with exactly the structure the spec declares. */
export async function generateFixtureFile(spec: FixtureSpec): Promise<File> {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  const video = spec.kind === "video" ? new CanvasSource(canvas, { codec: "vp9", bitrate: QUALITY_HIGH }) : null;
  if (video) output.addVideoTrack(video, { frameRate: FPS });
  const audio = spec.audio.kind === "none" ? null : new AudioBufferSource({ codec: "opus", bitrate: 96_000 });
  if (audio) output.addAudioTrack(audio);
  await output.start();
  if (audio) {
    await audio.add(renderAudio(spec));
    audio.close();
  }
  if (video) {
    const blocks = blocksOf(spec);
    const frames = Math.round(spec.durationSeconds * FPS);
    for (let i = 0; i < frames; i++) {
      const t = i / FPS;
      let edge = 0;
      let block = blocks[blocks.length - 1] ?? { seconds: 0, rgb: [128, 128, 128] as [number, number, number] };
      for (const candidate of blocks) {
        edge += candidate.seconds;
        if (t < edge - 1e-9) {
          block = candidate;
          break;
        }
      }
      ctx.fillStyle = `rgb(${block.rgb[0]} ${block.rgb[1]} ${block.rgb[2]})`;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect((i % 60) * 4, 150, 16, 16);
      await video.add(t, 1 / FPS);
    }
  }
  await output.finalize();
  const bytes = (output.target as InstanceType<typeof BufferTarget>).buffer as ArrayBuffer;
  return new File([bytes], spec.name, { type: spec.kind === "video" ? "video/webm" : "audio/webm", lastModified: 1_700_000_000_000 });
}

export async function generateIntoImportQueue(specs: FixtureSpec[]): Promise<void> {
  const host = window as unknown as { __files?: File[] };
  host.__files = [...(host.__files ?? [])];
  for (const spec of specs) host.__files.push(await generateFixtureFile(spec));
}

export async function waitForAssets(count: number): Promise<Array<{ id: string; name: string }>> {
  const { editor } = getServices();
  const deadline = Date.now() + 60_000;
  while (editor.getState().doc.assets.length < count) {
    if (Date.now() > deadline) throw new Error(`only ${editor.getState().doc.assets.length} of ${count} assets imported`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return editor.getState().doc.assets.map((a) => ({ id: a.id, name: a.name }));
}

export function snapshot(): Project {
  return JSON.parse(JSON.stringify(getServices().editor.toProject())) as Project;
}

export async function placeFixtures(input: { specs: FixtureSpec[]; assetIds: Record<string, string> }): Promise<void> {
  const { editor } = getServices();
  const fixtures = input.specs.map((spec) => ({ spec, assetId: input.assetIds[spec.name] ?? "", truth: truthFromSpec(spec) }));
  await placeInitialTimeline({ editor, tools: createAgentTools(), fixtures, resetHistory: false });
}

export interface InAppRun {
  run: RunSummary;
  toolCalls: string[];
}

/** Sends the brief through the real in-app agent session with a scripted policy (the oracle unless `policyId` says otherwise) as the model. */
export async function runPolicyInApp(input: { caseId: string; brief: string; policyId?: string }): Promise<InAppRun> {
  const policy = POLICIES.find((p) => p.caseId === input.caseId && p.id === (input.policyId ?? "oracle"));
  if (!policy) throw new Error(`no policy "${input.policyId ?? "oracle"}" for case ${input.caseId}`);
  (globalThis as unknown as { __agentModel?: unknown }).__agentModel = policy.build();
  const session = getAgentSession();
  const result = await session.send(input.brief);
  if (!result) throw new Error("the agent session did not run (is a run already active?)");
  const toolCalls = session.getState().items.flatMap((item) => (item.kind === "tool" ? [item.name] : []));
  return {
    run: { status: result.status, finalText: result.finalText, steps: result.steps, changed: result.changed, usage: result.usage, ...(result.error ? { error: result.error } : {}) },
    toolCalls,
  };
}

/** Real measured analysis of every imported asset, keyed by asset id. */
export async function measureAssets(): Promise<Record<string, MediaAnalysis>> {
  const { editor, runtime } = getServices();
  const store = new MemoryAnalysisStore();
  const out: Record<string, MediaAnalysis> = {};
  for (const info of editor.getState().doc.assets) {
    const blob = runtime.getBlob(info.id);
    if (blob) out[info.id] = await analyzeMedia(blob, info, { store });
  }
  return out;
}
