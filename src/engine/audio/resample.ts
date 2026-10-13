const HALF_WIDTH = 16;
const TABLE_STEPS = 512;
const CUTOFF = 0.96;

function blackman(position: number): number {
  const t = (position + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

/** Windowed-sinc kernel sampled at `TABLE_STEPS` points per input sample over [-HALF_WIDTH, HALF_WIDTH]. */
const KERNEL: Float32Array = (() => {
  const size = 2 * HALF_WIDTH * TABLE_STEPS + 2;
  const table = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = i / TABLE_STEPS - HALF_WIDTH;
    if (Math.abs(x) >= HALF_WIDTH) continue;
    const arg = Math.PI * x * CUTOFF;
    table[i] = (x === 0 ? CUTOFF : (Math.sin(arg) / (Math.PI * x))) * blackman(x / HALF_WIDTH);
  }
  return table;
})();

/**
 * Band-limited resampling of one channel with a Blackman-windowed sinc (32 taps, 96% of the narrower Nyquist).
 * Equal rates return a copy. The output has `round(length * to / from)` samples and the same start time.
 */
export function resample(input: { samples: Float32Array; fromRate: number; toRate: number }): Float32Array {
  const { samples, fromRate, toRate } = input;
  if (fromRate === toRate) return Float32Array.from(samples);
  const outLength = Math.round((samples.length * toRate) / fromRate);
  const out = new Float32Array(outLength);
  const step = fromRate / toRate;
  const scale = Math.min(1, toRate / fromRate);
  const reach = Math.ceil(HALF_WIDTH / scale);
  const last = samples.length - 1;
  for (let n = 0; n < outLength; n++) {
    const centre = n * step;
    const first = Math.ceil(centre - reach);
    const stop = Math.floor(centre + reach);
    let sum = 0;
    let weight = 0;
    for (let k = first; k <= stop; k++) {
      const x = (k - centre) * scale;
      const position = (x + HALF_WIDTH) * TABLE_STEPS;
      const index = Math.floor(position);
      if (index < 0 || index >= KERNEL.length - 1) continue;
      const fraction = position - index;
      const w = (KERNEL[index] as number) * (1 - fraction) + (KERNEL[index + 1] as number) * fraction;
      weight += w;
      if (k >= 0 && k <= last) sum += (samples[k] as number) * w;
    }
    out[n] = weight !== 0 ? sum / weight : 0;
  }
  return out;
}
