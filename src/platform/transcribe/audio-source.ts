import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from "mediabunny";
import { WHISPER_SAMPLE_RATE } from "./chunking";

/** Decoded speech audio as consecutive 16 kHz mono blocks; the whole recording is never in memory at once. */
export interface AudioSource {
  durationSeconds: number;
  blocks(): AsyncGenerator<Float32Array, void, unknown>;
  dispose(): void;
}

const BLOCK_SECONDS = 30;

async function resampleTo16k(mono: Float32Array<ArrayBuffer>, sampleRate: number): Promise<Float32Array<ArrayBuffer>> {
  if (sampleRate === WHISPER_SAMPLE_RATE) return mono;
  const length = Math.max(1, Math.ceil((mono.length * WHISPER_SAMPLE_RATE) / sampleRate));
  const context = new OfflineAudioContext(1, length, WHISPER_SAMPLE_RATE);
  const buffer = context.createBuffer(1, mono.length, sampleRate);
  buffer.copyToChannel(mono, 0);
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.start();
  return (await context.startRendering()).getChannelData(0);
}

function downmix(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / channels;
  }
  return mono;
}

/** Returns null when the file has no decodable audio track. */
export async function openAudio16k(blob: Blob): Promise<AudioSource | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryAudioTrack();
  if (!track || !(await track.canDecode())) {
    input.dispose();
    return null;
  }
  const durationSeconds = await input.computeDuration();
  return {
    durationSeconds,
    async *blocks() {
      let pieces: Float32Array[] = [];
      let blockSamples = 0;
      let blockRate = 0;
      let writtenSeconds = 0;
      const flush = async (): Promise<Float32Array<ArrayBuffer>> => {
        const mono = new Float32Array(blockSamples);
        let offset = 0;
        for (const piece of pieces) { mono.set(piece, offset); offset += piece.length; }
        const rate = blockRate;
        pieces = [];
        blockSamples = 0;
        return resampleTo16k(mono, rate);
      };
      for await (const wrapped of new AudioBufferSink(track).buffers()) {
        const rate = wrapped.buffer.sampleRate;
        if (blockSamples > 0 && rate !== blockRate) yield await flush();
        blockRate = rate;
        const gap = Math.round((wrapped.timestamp - writtenSeconds) * rate);
        if (gap > 0) {
          pieces.push(new Float32Array(gap));
          blockSamples += gap;
          writtenSeconds += gap / rate;
        }
        pieces.push(downmix(wrapped.buffer));
        blockSamples += wrapped.buffer.length;
        writtenSeconds += wrapped.buffer.length / rate;
        if (blockSamples / rate >= BLOCK_SECONDS) yield await flush();
      }
      if (blockSamples > 0) yield await flush();
    },
    dispose: () => input.dispose(),
  };
}
