Vendored, unmodified build of RNNoise (https://gitlab.xiph.org/xiph/rnnoise, BSD-3-Clause, Xiph.Org) compiled to
WebAssembly by Jitsi: @jitsi/rnnoise-wasm 0.2.1, dist/rnnoise.js (emscripten glue) and dist/rnnoise.wasm
(Apache-2.0, see LICENSE-rnnoise-wasm-Apache-2.0.txt; RNNoise itself: Copyright (c) 2017 Mozilla, 2007-2017 Jean-Marc Valin
et al., BSD-3-Clause). The sha256 of both files is pinned in tests/supply-chain.test.ts and docs/SUPPLY_CHAIN.md.
Re-vendor: npm pack @jitsi/rnnoise-wasm@<version>, copy dist/rnnoise.js and dist/rnnoise.wasm, update the hashes.
