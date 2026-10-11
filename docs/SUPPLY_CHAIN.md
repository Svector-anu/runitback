# Supply chain

What the app loads at runtime, and how each piece is pinned. Everything else is bundled into `dist/` at build time from `pnpm-lock.yaml`.

## Runtime network access

| Resource | Host | Pinned by |
| --- | --- | --- |
| Whisper tiny.en timestamped | huggingface.co, redirected to `us.aws.cdn.hf.co` | commit hash, below |
| CLIP ViT-B/32 | same | commit hash, below |
| MediaPipe BlazeFace + wasm | this origin (`public/mediapipe`) | sha256 test, below |
| ONNX Runtime wasm/mjs | this origin (bundled asset) | `onnxruntime-web` version |
| Inter font | this origin (`public/fonts`) | sha256 test, below |
| Anthropic Messages API | api.anthropic.com | user key, user action |

No third-party script, stylesheet or font is loaded. Google Fonts was removed.

## Hugging Face model revisions

`src/platform/model-revisions.ts`; the workers pass `revision` to transformers.js.

| Repo | Commit | Last modified upstream |
| --- | --- | --- |
| `onnx-community/whisper-tiny.en_timestamped` | `aeaa13760958b03fac5062f457d317d3319c3168` | 2025-03-05 |
| `Xenova/clip-vit-base-patch32` | `d15189d7028b43f1d3e65039190477f6af591c2a` | 2025-07-08 |

Observed with real downloads: model weights and CLIP files are requested at the hash (the hub rewrites to `/api/resolve-cache/models/<repo>/<hash>/...`). Limitation of transformers.js 4.3.0: `pipeline()` first probes `config.json`, `tokenizer_config.json` and `preprocessor_config.json` at `main` to plan the file list (Whisper only). Those probes only decide which components load; all bytes are fetched at the pinned commit. Pinning Whisper fully would mean constructing the pipeline from `from_pretrained` pieces; not done to avoid changing the real recogniser path.

Effects of pinning: browsers that cached the `main` URLs download once more. The stored `model` string on transcripts and embeddings is unchanged (the revision is not part of it), so existing derived data stays valid; bump `TRANSCRIPT_VERSION` / `VISUAL_INDEX_VERSION` when a hash is bumped for a different model build. To bump: pick the new commit on the hub, run `REAL_CSP=1` and `REAL_CLIP=1` specs, update the table and the map.

The hub gives no integrity hash for the ONNX files themselves; the commit hash is the integrity anchor. Hosting the models on our own bucket (own CDN, add the origin to `connect-src`) remains the stronger option for a hosted product.

## Self-hosted binary assets (sha256)

Enforced by `tests/supply-chain.test.ts`; change both together.

| File | sha256 |
| --- | --- |
| `public/mediapipe/blaze_face_short_range.tflite` | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| `public/mediapipe/wasm/vision_wasm_internal.js` | `e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73` |
| `public/mediapipe/wasm/vision_wasm_internal.wasm` | `8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886` |
| `public/fonts/inter-latin-wght-normal.woff2` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |

The tflite model's upstream provenance (Google MediaPipe `blaze_face_short_range`) was not re-verified against Google's storage in this pass; the hash records what is in the repo.

## Fonts

Inter variable, latin subset, from `@fontsource-variable/inter` 5.3.0 (published 2026-07-19), SIL OFL 1.1, copied to `public/fonts` with its licence (`Inter-OFL.txt`); `public/fonts/inter.css` declares the `@font-face`. It is vendored rather than installed so the lockfile and the shared dependency tree stay untouched. Re-vendor: `npm pack @fontsource-variable/inter@<version>`, copy `files/inter-latin-wght-normal.woff2`, update the hash.

Text elements: `src/platform/fonts.ts` now knows only system fonts and the bundled `Inter`. `loadFont` makes no network request for any name (the previous behaviour fetched an arbitrary family name from Google, an exfiltration channel); a non-bundled family renders with the canvas fallback. The inspector datalist offers Arial, Helvetica, Times New Roman, Courier New, Verdana, Georgia and Inter. Projects that used Roboto, Open Sans, Montserrat, Lato, Poppins, Oswald, Playfair Display, Source Sans 3, Raleway, Merriweather or Bebas Neue keep their stored name but render and export with the fallback face until those fonts are bundled. To add one: vendor its latin woff2 plus licence into `public/fonts`, add an `@font-face`, add it to `BUNDLED_FONTS`.

## ONNX Runtime: nightly to stable 1.30.0

`@huggingface/transformers@4.3.0` depends on the exact nightly `onnxruntime-web@1.31.0-dev.20260914-8d85527a0`; the app pinned the same build so the asyncify loader/wasm it self-hosts matches the JS inside transformers. Stable `onnxruntime-web@1.30.0` (published 2026-09-14) ships the same `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` files, so the switch is a `pnpm` override (`pnpm-workspace.yaml: overrides`) plus `package.json` pin. Checked in an isolated copy:

- `tsc` and `vite build` pass; the wasm asset is 26,781.91 kB (6,746 kB gzip) versus 26,861.77 kB (6,763 kB gzip): about 80 kB smaller, no meaningful change.
- `REAL_CSP=1` e2e (real Whisper + CLIP + MediaPipe under the CSP): "Understood".
- `REAL_CLIP=1 e2e/visual-real.spec.ts` (red vs blue frames through the real model): pass.

Caveats: this deviates from the pairing upstream tests (transformers' own `package.json` pins the nightly), and WebGPU inference was not exercised. If a regression appears, remove the override and restore the nightly pin. This worktree's shared `node_modules` still holds the nightly; run `pnpm install` once after merging.

## Provenance gaps (owner)

Neither Hugging Face repo carries licence metadata via the API; see `docs/LICENSING.md`.
