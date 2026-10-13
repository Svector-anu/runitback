import { DENOISE_FRAME_SAMPLES, type FrameDenoiser } from "#/engine/audio";
import rnnoiseWasmUrl from "./vendor/rnnoise.wasm?url";

/** The subset of the emscripten module (`public/rnnoise/rnnoise.js`, @jitsi/rnnoise-wasm 0.2.1) this adapter calls. */
interface RnnoiseModule {
  HEAPF32: Float32Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _rnnoise_create(): number;
  _rnnoise_destroy(state: number): void;
  _rnnoise_process_frame(state: number, output: number, input: number): number;
}

type RnnoiseFactory = (options: { wasmBinary?: Uint8Array; locateFile?: (path: string) => string }) => Promise<RnnoiseModule>;

export interface RnnoiseRuntime {
  createDenoiser(): FrameDenoiser;
}

export interface RnnoiseSource {
  /** Test seam / Node: the wasm bytes, so nothing is fetched. */
  wasmBinary?: Uint8Array;
  /** Test seam: replaces importing the glue. */
  loadFactory?: () => Promise<RnnoiseFactory>;
}

const SCALE = 32768;
const BYTES_PER_FLOAT = 4;

function describe(module: RnnoiseModule): RnnoiseRuntime {
  return {
    createDenoiser(): FrameDenoiser {
      const state = module._rnnoise_create();
      const input = module._malloc(DENOISE_FRAME_SAMPLES * BYTES_PER_FLOAT);
      const output = module._malloc(DENOISE_FRAME_SAMPLES * BYTES_PER_FLOAT);
      let alive = true;
      return {
        process(frame: Float32Array): Float32Array {
          if (!alive) throw new Error("The noise remover was already disposed");
          if (frame.length !== DENOISE_FRAME_SAMPLES) throw new Error(`Noise removal works on ${DENOISE_FRAME_SAMPLES}-sample frames`);
          const heap = module.HEAPF32;
          const inIndex = input >> 2;
          for (let i = 0; i < DENOISE_FRAME_SAMPLES; i++) heap[inIndex + i] = (frame[i] as number) * SCALE;
          module._rnnoise_process_frame(state, output, input);
          const outIndex = output >> 2;
          const result = new Float32Array(DENOISE_FRAME_SAMPLES);
          for (let i = 0; i < DENOISE_FRAME_SAMPLES; i++) result[i] = (heap[outIndex + i] as number) / SCALE;
          return result;
        },
        dispose(): void {
          if (!alive) return;
          alive = false;
          module._rnnoise_destroy(state);
          module._free(input);
          module._free(output);
        },
      };
    },
  };
}

/**
 * Loads RNNoise (BSD-3 algorithm, Apache-2.0 wasm build) from this origin. The glue is a vendored, hash-pinned file
 * (docs/SUPPLY_CHAIN.md) bundled as its own lazy chunk, and the wasm is a hashed asset: no network access beyond our host.
 */
export async function loadRnnoise(source: RnnoiseSource = {}): Promise<RnnoiseRuntime> {
  const factory = source.loadFactory
    ? await source.loadFactory()
    : ((await import("./vendor/rnnoise.js")).default as unknown as RnnoiseFactory);
  const module = await factory({ ...(source.wasmBinary ? { wasmBinary: source.wasmBinary } : { locateFile: () => rnnoiseWasmUrl }) });
  return describe(module);
}

let shared: Promise<RnnoiseRuntime> | null = null;

/** One wasm instance per page; a failed load is not cached, so a later attempt can succeed. */
export function sharedRnnoise(): Promise<RnnoiseRuntime> {
  shared ??= loadRnnoise().catch((error: unknown) => {
    shared = null;
    throw error;
  });
  return shared;
}
