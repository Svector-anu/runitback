/**
 * What the current browser can do, decided once and without side effects beyond throwaway canvas probes.
 * `detectCapabilities` takes the environment as a parameter so it is unit-testable in Node; the default is `globalThis`.
 * Codec support (can this browser encode H.264 at 4K?) is asynchronous and lives in `probeEncoders`.
 */

export interface CapabilityEnv {
  VideoDecoder?: unknown;
  VideoEncoder?: unknown;
  VideoFrame?: unknown;
  AudioDecoder?: unknown;
  AudioEncoder?: unknown;
  OffscreenCanvas?: unknown;
  AudioContext?: unknown;
  OfflineAudioContext?: unknown;
  BroadcastChannel?: unknown;
  Worker?: unknown;
  indexedDB?: unknown;
  createImageBitmap?: unknown;
  structuredClone?: unknown;
  navigator?: { storage?: { getDirectory?: unknown }; locks?: unknown };
  /** Draws on a throwaway canvas; absent where there is no DOM. */
  probeCanvas?: () => { roundRect: boolean; filter: boolean } | null;
}

export interface Capabilities {
  videoDecoding: boolean;
  videoEncoding: boolean;
  audioDecoding: boolean;
  audioEncoding: boolean;
  offscreenCanvas: boolean;
  opfs: boolean;
  webLocks: boolean;
  audioContext: boolean;
  offlineAudio: boolean;
  broadcastChannel: boolean;
  structuredClone: boolean;
  moduleWorkers: boolean;
  indexedDb: boolean;
  imageBitmap: boolean;
  /** `ctx.filter` visibly changes what is drawn (WebKit accepts the assignment and ignores it). */
  canvasFilter: boolean;
  canvasRoundRect: boolean;
}

export type CapabilityScope = "editor" | "import" | "export";

export interface CapabilityIssue {
  id: keyof Capabilities;
  /** `blocker`: the scope cannot work. `degraded`: it works with reduced fidelity or a fallback. */
  severity: "blocker" | "degraded";
  scope: CapabilityScope;
  /** A complete sentence for the person using the editor. */
  message: string;
}

export type SupportLevel = "full" | "partial" | "unsupported";

export interface CapabilityReport {
  capabilities: Capabilities;
  issues: CapabilityIssue[];
  level: SupportLevel;
}

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== false;

/** Safari accepts `ctx.filter = ...` and reads it back but draws nothing blurred, so the probe checks the pixels. */
function defaultCanvasProbe(): { roundRect: boolean; filter: boolean } | null {
  if (typeof document === "undefined") return null;
  const source = document.createElement("canvas");
  source.width = 24;
  source.height = 24;
  const target = document.createElement("canvas");
  target.width = 24;
  target.height = 24;
  const sourceCtx = source.getContext("2d");
  const ctx = target.getContext("2d", { willReadFrequently: true });
  if (!sourceCtx || !ctx) return null;
  sourceCtx.fillRect(10, 10, 4, 4);
  ctx.filter = "blur(3px)";
  ctx.drawImage(source, 0, 0);
  return { roundRect: typeof ctx.roundRect === "function", filter: (ctx.getImageData(7, 12, 1, 1).data[3] ?? 0) > 0 };
}

function browserEnv(): CapabilityEnv {
  const g = globalThis as unknown as CapabilityEnv;
  return {
    VideoDecoder: g.VideoDecoder, VideoEncoder: g.VideoEncoder, VideoFrame: g.VideoFrame, AudioDecoder: g.AudioDecoder,
    AudioEncoder: g.AudioEncoder, OffscreenCanvas: g.OffscreenCanvas, AudioContext: g.AudioContext,
    OfflineAudioContext: g.OfflineAudioContext, BroadcastChannel: g.BroadcastChannel, Worker: g.Worker, indexedDB: g.indexedDB,
    createImageBitmap: g.createImageBitmap, structuredClone: g.structuredClone, navigator: g.navigator, probeCanvas: defaultCanvasProbe,
  };
}

export function detectCapabilities(env: CapabilityEnv = browserEnv()): Capabilities {
  const canvas = env.probeCanvas?.() ?? null;
  return {
    videoDecoding: present(env.VideoDecoder),
    videoEncoding: present(env.VideoEncoder) && present(env.VideoFrame),
    audioDecoding: present(env.AudioDecoder),
    audioEncoding: present(env.AudioEncoder),
    offscreenCanvas: present(env.OffscreenCanvas),
    opfs: typeof env.navigator?.storage?.getDirectory === "function",
    webLocks: present(env.navigator?.locks),
    audioContext: present(env.AudioContext),
    offlineAudio: present(env.OfflineAudioContext),
    broadcastChannel: present(env.BroadcastChannel),
    structuredClone: typeof env.structuredClone === "function",
    moduleWorkers: present(env.Worker),
    indexedDb: present(env.indexedDB),
    imageBitmap: typeof env.createImageBitmap === "function",
    canvasFilter: canvas?.filter ?? true,
    canvasRoundRect: canvas?.roundRect ?? true,
  };
}

const RECOMMENDED = "Open RunItBack in a current Chrome, Edge, Safari or Firefox.";

/** Everything the browser lacks, worded for the person who hits it. Ordered blockers first. */
export function capabilityIssues(c: Capabilities): CapabilityIssue[] {
  const issues: CapabilityIssue[] = [];
  const add = (issue: CapabilityIssue): void => void issues.push(issue);
  if (!c.indexedDb) add({ id: "indexedDb", severity: "blocker", scope: "editor", message: `Your browser can't store projects (IndexedDB is unavailable, which also happens in some private windows). ${RECOMMENDED}` });
  if (!c.videoDecoding) add({ id: "videoDecoding", severity: "blocker", scope: "import", message: `Your browser can't decode video: it does not support WebCodecs. Importing and previewing video will not work. ${RECOMMENDED}` });
  if (!c.videoEncoding) add({ id: "videoEncoding", severity: "blocker", scope: "export", message: `Your browser can't encode video: it does not support WebCodecs video encoding. You can edit, but exporting will not work. ${RECOMMENDED}` });
  if (!c.audioContext || !c.offlineAudio) add({ id: "audioContext", severity: "degraded", scope: "editor", message: "Your browser's Web Audio support is incomplete, so audio playback and the audio of exports may be missing." });
  if (!c.offscreenCanvas) add({ id: "offscreenCanvas", severity: "degraded", scope: "editor", message: "Your browser has no OffscreenCanvas, so image import and exports fall back to slower paths." });
  if (!c.canvasFilter) add({ id: "canvasFilter", severity: "degraded", scope: "editor", message: "Your browser ignores canvas filters, so blur, colour adjustments and the sharpen effect will not show in the preview or the export." });
  if (!c.canvasRoundRect) add({ id: "canvasRoundRect", severity: "degraded", scope: "editor", message: "Your browser can't draw rounded rectangles on canvas, so rounded text backgrounds and shapes are drawn square." });
  if (!c.audioEncoding) add({ id: "audioEncoding", severity: "degraded", scope: "export", message: "Your browser can't encode audio, so exports will have no sound." });
  if (!c.opfs) add({ id: "opfs", severity: "degraded", scope: "export", message: "Your browser has no origin-private file system, so media is kept in IndexedDB and exports are assembled in memory; very large projects may run out of memory." });
  if (!c.webLocks) add({ id: "webLocks", severity: "degraded", scope: "editor", message: "Your browser has no Web Locks, so RunItBack can't warn you when the same project is open in two tabs. Keep one tab per project." });
  return issues.sort((a, b) => Number(b.severity === "blocker") - Number(a.severity === "blocker"));
}

export function reportCapabilities(env?: CapabilityEnv): CapabilityReport {
  const capabilities = detectCapabilities(env);
  const issues = capabilityIssues(capabilities);
  const blockers = issues.filter((i) => i.severity === "blocker");
  const level: SupportLevel = blockers.some((i) => i.scope === "import" || i.scope === "editor") ? "unsupported" : issues.length > 0 ? "partial" : "full";
  return { capabilities, issues, level };
}

export interface EncoderSupport {
  mp4: boolean;
  webm: boolean;
  /** Codec name of the first encodable video codec per container, or null. */
  mp4Video: string | null;
  webmVideo: string | null;
}

const ENCODER_CANDIDATES = {
  mp4: [["avc", "avc1.640033"], ["vp9", "vp09.00.10.08"], ["av1", "av01.0.08M.08"]],
  webm: [["vp9", "vp09.00.10.08"], ["vp8", "vp8"], ["av1", "av01.0.08M.08"]],
} as const;

interface EncoderApi {
  isConfigSupported(config: { codec: string; width: number; height: number; bitrate: number }): Promise<{ supported?: boolean }>;
}

/** Asks the browser which containers it can produce video for at the given size. */
export async function probeEncoders(input: { width: number; height: number; encoder?: EncoderApi | undefined }): Promise<EncoderSupport> {
  const encoder = input.encoder ?? (globalThis as unknown as { VideoEncoder?: EncoderApi }).VideoEncoder;
  const first = async (format: "mp4" | "webm"): Promise<string | null> => {
    if (!encoder) return null;
    for (const [name, codec] of ENCODER_CANDIDATES[format]) {
      try {
        const result = await encoder.isConfigSupported({ codec, width: input.width, height: input.height, bitrate: 8_000_000 });
        if (result.supported) return name;
      } catch {
        continue;
      }
    }
    return null;
  };
  const [mp4Video, webmVideo] = await Promise.all([first("mp4"), first("webm")]);
  return { mp4: mp4Video !== null, webm: webmVideo !== null, mp4Video, webmVideo };
}
