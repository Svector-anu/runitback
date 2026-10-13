/** Emscripten factory of the vendored RNNoise build; see README.txt in this folder. */
declare function createRNNWasmModule(options?: { wasmBinary?: Uint8Array; locateFile?: (path: string) => string }): Promise<unknown>;
export default createRNNWasmModule;
