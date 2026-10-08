/** WSOLA frame length target; short enough for responsiveness, long enough to carry a few cycles of bass content. */
const FRAME_SECONDS = 0.02;

function hannWindow(length: number): Float32Array {
  const w = new Float32Array(length);
  if (length <= 1) {
    w.fill(1);
    return w;
  }
  for (let i = 0; i < length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
  return w;
}

/** Normalized cross-correlation of two equal-length windows into the same array; 1 is a perfect match. */
function normalizedCorrelation(input: { samples: Float32Array; aOffset: number; bOffset: number; length: number }): number {
  const { samples, aOffset, bOffset, length } = input;
  let dot = 0;
  let energyA = 0;
  let energyB = 0;
  for (let i = 0; i < length; i++) {
    const a = samples[aOffset + i] ?? 0;
    const b = samples[bOffset + i] ?? 0;
    dot += a * b;
    energyA += a * a;
    energyB += b * b;
  }
  return dot / Math.sqrt(energyA * energyB + 1e-9);
}

/** Position within [minPos, maxPos] near `idealPos` whose overlap region best matches the one at `targetOffset`. */
function bestAlignedOffset(input: {
  reference: Float32Array; targetOffset: number; idealPos: number; tolerance: number; overlapLength: number; minPos: number; maxPos: number;
}): number {
  const { reference, targetOffset, idealPos, tolerance, overlapLength, minPos, maxPos } = input;
  const clampedIdeal = Math.min(Math.max(idealPos, minPos), maxPos);
  let bestPos = clampedIdeal;
  let bestScore = -Infinity;
  const from = Math.max(minPos, clampedIdeal - tolerance);
  const to = Math.min(maxPos, clampedIdeal + tolerance);
  for (let pos = from; pos <= to; pos++) {
    const score = normalizedCorrelation({ samples: reference, aOffset: pos, bOffset: targetOffset, length: overlapLength });
    if (score > bestScore) {
      bestScore = score;
      bestPos = pos;
    }
  }
  return bestPos;
}

export interface StretchInput {
  /** Decoded PCM, one Float32Array per channel; every channel must be the same length. */
  channels: ReadonlyArray<Float32Array>;
  /** Timeline playback rate: >1 speeds up, <1 slows down. Output length is input length / rate. */
  rate: number;
  sampleRate: number;
}

/**
 * Pitch-preserving time-stretch (WSOLA). Re-sequences frames of the original-rate signal instead
 * of resampling it, so local waveform content — and therefore perceived pitch — survives a change
 * in playback duration. Pure and DOM/AudioContext-free: usable from both the live playback
 * scheduler (per decoded buffer) and the offline export mixer, on the same Float32Array channel
 * data `AudioBuffer.getChannelData()` already hands both call sites.
 */
export function stretch(input: StretchInput): Float32Array[] {
  const { channels, sampleRate } = input;
  const rate = Number.isFinite(input.rate) && input.rate > 0 ? input.rate : 1;
  const inputLength = channels[0]?.length ?? 0;
  if (channels.length === 0 || inputLength === 0) return channels.map(() => new Float32Array(0));

  const outputLength = Math.max(1, Math.round(inputLength / rate));
  if (rate === 1) return channels.map((channel) => channel.slice(0, outputLength));

  let frameSize = Math.round(sampleRate * FRAME_SECONDS);
  frameSize -= frameSize % 2; // even, so the synthesis hop is an exact half
  frameSize = Math.min(Math.max(frameSize, 16), inputLength);

  if (frameSize < 4) {
    // Too little input to frame meaningfully (e.g. a handful of samples) — nearest-neighbour keeps duration correct.
    return channels.map((channel) => {
      const out = new Float32Array(outputLength);
      for (let i = 0; i < outputLength; i++) out[i] = channel[Math.min(inputLength - 1, Math.round(i * rate))] ?? 0;
      return out;
    });
  }

  const synthesisHop = Math.max(1, Math.floor(frameSize / 2));
  const analysisHop = synthesisHop * rate;
  const overlapLength = frameSize - synthesisHop;
  const tolerance = Math.max(0, Math.floor(synthesisHop / 2));
  const taper = hannWindow(frameSize);
  const reference = channels[0] as Float32Array;
  const maxStart = Math.max(0, inputLength - frameSize);

  const outputs = channels.map(() => new Float32Array(outputLength));
  const weight = new Float32Array(outputLength);

  let analysisPos = 0;
  let outPos = 0;
  let frameIndex = 0;
  let prevSegmentStart = 0;

  while (outPos < outputLength) {
    const start = frameIndex === 0 ? 0 : bestAlignedOffset({
      reference,
      targetOffset: prevSegmentStart + synthesisHop,
      idealPos: Math.round(analysisPos),
      tolerance,
      overlapLength,
      minPos: 0,
      maxPos: maxStart,
    });

    for (let c = 0; c < channels.length; c++) {
      const channel = channels[c] as Float32Array;
      const out = outputs[c] as Float32Array;
      for (let i = 0; i < frameSize && outPos + i < outputLength; i++) {
        out[outPos + i] = (out[outPos + i] ?? 0) + (channel[start + i] ?? 0) * (taper[i] ?? 0);
      }
    }
    for (let i = 0; i < frameSize && outPos + i < outputLength; i++) {
      weight[outPos + i] = (weight[outPos + i] ?? 0) + (taper[i] ?? 0);
    }

    prevSegmentStart = start;
    frameIndex += 1;
    outPos += synthesisHop;
    analysisPos = start + analysisHop;
  }

  for (const out of outputs) {
    for (let i = 0; i < outputLength; i++) {
      const w = weight[i] ?? 0;
      if (w > 1e-6) out[i] = (out[i] ?? 0) / w;
    }
  }
  return outputs;
}
