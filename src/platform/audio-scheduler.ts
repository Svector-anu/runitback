import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import { gainEnvelope, sourceWindow, stretch, type AudioClip } from "#/engine/audio";

export type AudioContextLike = BaseAudioContext;

/** Decoders for the audio of each media id, created lazily from its file. */
export class AudioSinkCache {
  private readonly sinks = new Map<string, Promise<{ input: Input<BlobSource>; sink: AudioBufferSink } | null>>();

  constructor(private readonly getBlob: (mediaId: string) => Blob | undefined) {}

  get(mediaId: string): Promise<AudioBufferSink | null> {
    let entry = this.sinks.get(mediaId);
    if (!entry) {
      const blob = this.getBlob(mediaId);
      entry = blob ? this.open(blob) : Promise.resolve(null);
      this.sinks.set(mediaId, entry);
    }
    return entry.then((e) => e?.sink ?? null);
  }

  private async open(blob: Blob): Promise<{ input: Input<BlobSource>; sink: AudioBufferSink } | null> {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      return null;
    }
    return { input, sink: new AudioBufferSink(track) };
  }

  async release(mediaId: string): Promise<void> {
    const entry = this.sinks.get(mediaId);
    this.sinks.delete(mediaId);
    (await entry)?.input.dispose();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sinks.keys()].map((k) => this.release(k)));
  }
}

export interface ScheduledClip {
  gain: GainNode;
  sources: Set<AudioBufferSourceNode>;
}

/** Maps a timeline second to a time on the audio context clock. */
export type TimelineToContext = (timelineSeconds: number) => number;

export function createClipGain(ctx: AudioContextLike, destination: AudioNode): ScheduledClip {
  const gain = ctx.createGain();
  gain.connect(destination);
  return { gain, sources: new Set() };
}

/**
 * Schedules the part of `clip` inside [from, to] (timeline seconds): decoded buffers become
 * AudioBufferSourceNodes placed on the context clock, trimmed to the window, with the clip's gain automation.
 */
export async function scheduleClipWindow(input: {
  ctx: AudioContextLike; scheduled: ScheduledClip; clip: AudioClip; sink: AudioBufferSink;
  from: number; to: number; toContext: TimelineToContext; shouldStop?: () => boolean;
}): Promise<void> {
  const { ctx, clip, scheduled } = input;
  const window = sourceWindow({ clip, from: input.from, to: input.to });
  if (!window) return;

  const envelope = gainEnvelope({ clip, from: window.timelineStart, to: window.timelineEnd });
  envelope.forEach((point, i) => {
    const when = Math.max(ctx.currentTime, input.toContext(point.time));
    if (i === 0) scheduled.gain.gain.setValueAtTime(point.gain, when);
    else scheduled.gain.gain.linearRampToValueAtTime(point.gain, when);
  });

  const stretching = clip.maintainPitch && clip.rate !== 1;
  const pieceSlices: Array<{ buffer: AudioBuffer; from: number; to: number }> = [];
  let stretchStart = 0;

  for await (const wrapped of input.sink.buffers(window.start, window.end)) {
    if (input.shouldStop?.()) return;
    const bufferStart = wrapped.timestamp;
    const bufferEnd = wrapped.timestamp + wrapped.duration;
    let sourceFrom = Math.max(bufferStart, window.start);
    const sourceTo = Math.min(bufferEnd, window.end);
    if (sourceTo <= sourceFrom) continue;

    let when = input.toContext(clip.start + (sourceFrom - clip.trimStart) / clip.rate);
    if (when < ctx.currentTime) {
      const lateSource = (ctx.currentTime - when) * clip.rate;
      sourceFrom += lateSource;
      when = ctx.currentTime;
      if (sourceTo - sourceFrom <= 0.001) continue;
    }
    if (stretching) {
      if (pieceSlices.length === 0) stretchStart = when;
      pieceSlices.push({ buffer: wrapped.buffer, from: sourceFrom - bufferStart, to: sourceTo - bufferStart });
      continue;
    }
    const node = createTrackedSource({ ctx, scheduled });
    node.buffer = wrapped.buffer;
    node.playbackRate.value = clip.rate;
    node.start(when, sourceFrom - bufferStart, sourceTo - sourceFrom);
  }

  if (pieceSlices.length === 0) return;
  const node = createTrackedSource({ ctx, scheduled });
  node.buffer = stretchedSlices({ ctx, slices: pieceSlices, rate: clip.rate });
  node.playbackRate.value = 1;
  node.start(stretchStart);
}

function createTrackedSource(input: { ctx: AudioContextLike; scheduled: ScheduledClip }): AudioBufferSourceNode {
  const node = input.ctx.createBufferSource();
  node.connect(input.scheduled.gain);
  input.scheduled.sources.add(node);
  node.onended = () => {
    input.scheduled.sources.delete(node);
    node.disconnect();
  };
  return node;
}

/**
 * Joins the decoded chunks covering the window into one continuous signal and WSOLA-stretches it in a
 * single pass, so alignment state runs across codec-frame boundaries instead of resetting per chunk.
 * Runs on the main-thread scheduling tick (2 s lookahead, see `AudioEngine`), not the audio thread.
 */
function stretchedSlices(input: { ctx: AudioContextLike; slices: Array<{ buffer: AudioBuffer; from: number; to: number }>; rate: number }): AudioBuffer {
  const first = input.slices[0];
  if (!first) throw new Error("stretchedSlices needs at least one slice");
  const { sampleRate, numberOfChannels } = first.buffer;
  const parts: Float32Array[][] = Array.from({ length: numberOfChannels }, () => []);
  let total = 0;
  for (const slice of input.slices) {
    const startSample = Math.max(0, Math.round(slice.from * sampleRate));
    const endSample = Math.min(slice.buffer.length, Math.round(slice.to * sampleRate));
    for (let c = 0; c < numberOfChannels; c++) parts[c]?.push(slice.buffer.getChannelData(c).slice(startSample, endSample));
    total += Math.max(0, endSample - startSample);
  }
  const channels = parts.map((chunks) => {
    const joined = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    return joined;
  });
  const stretched = stretch({ channels, rate: input.rate, sampleRate });
  const length = Math.max(1, stretched[0]?.length ?? 1);
  const out = input.ctx.createBuffer(numberOfChannels, length, sampleRate);
  // stretch() declares its return as the ambient (ArrayBufferLike-backed) Float32Array type, but every
  // array it returns is a fresh `new Float32Array(n)` — concretely ArrayBuffer-backed, same as copyToChannel requires.
  stretched.forEach((channel, c) => out.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
  return out;
}

export function stopClip(scheduled: ScheduledClip): void {
  for (const node of scheduled.sources) {
    try {
      node.stop();
    } catch {
      // already stopped
    }
    node.disconnect();
  }
  scheduled.sources.clear();
  scheduled.gain.disconnect();
}

/** Limiter used for both live playback and the exported mix, so what you hear is what you export. */
export function createMasterChain(ctx: AudioContextLike): { input: AudioNode; output: AudioNode; volume: GainNode } {
  const volume = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.12;
  const output = ctx.createGain();
  output.gain.value = 0.98;
  volume.connect(limiter);
  limiter.connect(output);
  return { input: volume, output, volume };
}
