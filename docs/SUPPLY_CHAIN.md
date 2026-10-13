# Supply chain

What the app loads at runtime, and how each piece is pinned. Everything else is bundled into `dist/` at build time from `pnpm-lock.yaml`.

## Runtime network access

| Resource | Host | Pinned by |
| --- | --- | --- |
| Whisper tiny.en timestamped | huggingface.co, redirected to `us.aws.cdn.hf.co` | commit hash, below |
| CLIP ViT-B/32 | same | commit hash, below |
| SpeechT5 TTS + HiFi-GAN vocoder (text to speech, `q4f16` / `q8`) | same | commit hashes, below |
| Helsinki-NLP opus-mt en-es, en-fr, es-en (caption translation, `q8`) | same | commit hashes, below |
| RNNoise wasm + glue (noise removal) | this origin (bundled from `src/platform/denoise/vendor`) | sha256 test, below |
| TTS speaker embeddings (7 x 2 KB) | this origin (`public/tts/voices`) | sha256 test, below |
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
| `Xenova/speecht5_tts` | `1723781b8ce2d02f0400c8337be04ae8ee3d6d56` | 2025-08-27 |
| `Xenova/speecht5_hifigan` | `cf980c3610d7b7f20919960031066ef7905737bd` | 2025-08-18 |
| `Xenova/opus-mt-en-es` | `4b002a4c7edd54a7ced58877258b87f7efd3f892` | 2025-07-14 |
| `Xenova/opus-mt-en-fr` | `28726206f80896b90035bd99cccd5cc1e151f916` | 2025-07-14 |
| `Xenova/opus-mt-es-en` | `eadfd7c658a9d8929ac3b8e996b68a68e2c7d480` | 2025-07-14 |

Observed with real downloads: model weights and CLIP files are requested at the hash (the hub rewrites to `/api/resolve-cache/models/<repo>/<hash>/...`). Limitation of transformers.js 4.3.0: `pipeline()` first probes `config.json`, `tokenizer_config.json` and `preprocessor_config.json` at `main` to plan the file list (Whisper only). Those probes only decide which components load; all bytes are fetched at the pinned commit. Pinning Whisper fully would mean constructing the pipeline from `from_pretrained` pieces; not done to avoid changing the real recogniser path.

Effects of pinning: browsers that cached the `main` URLs download once more. The stored `model` string on transcripts and embeddings is unchanged (the revision is not part of it), so existing derived data stays valid; bump `TRANSCRIPT_VERSION` / `VISUAL_INDEX_VERSION` when a hash is bumped for a different model build. To bump: pick the new commit on the hub, run `REAL_CSP=1` and `REAL_CLIP=1` specs, update the table and the map.

The hub gives no integrity hash for the ONNX files themselves; the commit hash is the integrity anchor. Hosting the models on our own bucket (own CDN, add the origin to `connect-src`) remains the stronger option for a hosted product.

## Self-hosted binary assets (sha256)

Enforced by `tests/supply-chain.test.ts`; change both together.

| File | sha256 |
| --- | --- |
| `public/mediapipe/blaze_face_short_range.tflite` | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| `public/mediapipe/selfie_segmenter.tflite` | `191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b` |
| `public/mediapipe/selfie_segmenter_landscape.tflite` | `490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e` |
| `public/mediapipe/wasm/vision_wasm_internal.js` | `e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73` |
| `public/mediapipe/wasm/vision_wasm_internal.wasm` | `8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886` |
| `public/fonts/inter-latin-wght-normal.woff2` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `src/platform/denoise/vendor/rnnoise.js` | `83a86f528a0f4d5c61a84be40dac9f15e5d114f24971bd5953f7f21879bc9bdf` |
| `src/platform/denoise/vendor/rnnoise.wasm` | `677147b9248aedc0a00de79dc090d1ecead37c08c8bb773a790da16109d2c487` |
| `public/tts/voices/slt.bin` | `1be85882a04effc2cd1111869ae885f53cf2b05ac6ad3b072d56e079cf3b24ff` |
| `public/tts/voices/clb.bin` | `80fd16944f979a6e0f159ed6dd59ae84ed73ef5264f62263106e6fb11a4e59a7` |
| `public/tts/voices/bdl.bin` | `274173f5dccebb838f38b47e8af7d3931428e0fbe9bcb9b11134ab296a77ad19` |
| `public/tts/voices/rms.bin` | `b400b4d40c96f014a34165d7d70001634008b2071cf917b22e713e083285683f` |
| `public/tts/voices/awb.bin` | `9109c94f57937d8f5327e267d65b290d91ceb7dfdc34063b36c9c735e90c5fe9` |
| `public/tts/voices/jmk.bin` | `5ad213535eef0815e77eadfff622e821e87206a4a6481d702b9249a76d5d3300` |
| `public/tts/voices/ksp.bin` | `89d49de8cde5fd74cc591fbd1105b78ad4d5e051c84e39818fb1d04a7116045b` |

RNNoise: `rnnoise.js` and `rnnoise.wasm` are the unmodified `dist/` files of `@jitsi/rnnoise-wasm` 0.2.1 (npm, published 2025-11-06, Apache-2.0; the RNNoise algorithm is BSD-3-Clause, Xiph.Org). The speaker embeddings are the unmodified `cmu_us_<speaker>_arctic-wav-arctic_a0001.bin` files of the dataset `Xenova/cmu-arctic-xvectors-extracted` at revision `b7b0b7fd0c1c77728ded8e1a908e863b490cfef4` (the awb file's hash equals the Hub's LFS object id); derived from `Matthijs/cmu-arctic-xvectors`, MIT. Details and licence decisions for all four audio features: `docs/AUDIO_VOICE.md`.

The tflite model's upstream provenance (Google MediaPipe `blaze_face_short_range`) was not re-verified against Google's storage in this pass; the hash records what is in the repo.

## Fonts

Inter variable, latin subset, from `@fontsource-variable/inter` 5.3.0 (published 2026-07-19), SIL OFL 1.1, copied to `public/fonts` with its licence (`Inter-OFL.txt`); `public/fonts/inter.css` declares the `@font-face`. It is vendored rather than installed so the lockfile and the shared dependency tree stay untouched. Re-vendor: `npm pack @fontsource-variable/inter@<version>`, copy `files/inter-latin-wght-normal.woff2`, update the hash.

Landing page only (loaded by the lazy landing chunk, never by the editor): Host Grotesk variable and Geist Mono variable, latin subsets from `@fontsource-variable/host-grotesk` 5.3.0 and `@fontsource-variable/geist-mono` 5.3.0, both SIL OFL 1.1, copied to `public/fonts` with their licences (`HostGrotesk-OFL.txt`, `GeistMono-OFL.txt`); the `@font-face` rules are in `src/ui/styles/zenon-tokens.css`. SHA-256 of the woff2 files: host-grotesk-latin-wght-normal.woff2 `ce9c9db8a488852eb7e4a52f51fd8ce0c93ef61a8d3bfa054b509ec92958dcfe`, geist-mono-latin-wght-normal.woff2 `684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc`. Re-vendor the same way as Inter (`npm pack`, copy `files/*-latin-wght-normal.woff2`).

Text elements: `src/platform/fonts.ts` now knows only system fonts and the bundled `Inter`. `loadFont` makes no network request for any name (the previous behaviour fetched an arbitrary family name from Google, an exfiltration channel); a non-bundled family renders with the canvas fallback. The inspector datalist offers Arial, Helvetica, Times New Roman, Courier New, Verdana, Georgia and Inter. Projects that used Roboto, Open Sans, Montserrat, Lato, Poppins, Oswald, Playfair Display, Source Sans 3, Raleway, Merriweather or Bebas Neue keep their stored name but render and export with the fallback face until those fonts are bundled. To add one: vendor its latin woff2 plus licence into `public/fonts`, add an `@font-face`, add it to `BUNDLED_FONTS`.

## ONNX Runtime: nightly to stable 1.30.0

`@huggingface/transformers@4.3.0` depends on the exact nightly `onnxruntime-web@1.31.0-dev.20260914-8d85527a0`; the app pinned the same build so the asyncify loader/wasm it self-hosts matches the JS inside transformers. Stable `onnxruntime-web@1.30.0` (published 2026-09-14) ships the same `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` files, so the switch is a `pnpm` override (`pnpm-workspace.yaml: overrides`) plus `package.json` pin. Checked in an isolated copy:

- `tsc` and `vite build` pass; the wasm asset is 26,781.91 kB (6,746 kB gzip) versus 26,861.77 kB (6,763 kB gzip): about 80 kB smaller, no meaningful change.
- `REAL_CSP=1` e2e (real Whisper + CLIP + MediaPipe under the CSP): "Understood".
- `REAL_CLIP=1 e2e/visual-real.spec.ts` (red vs blue frames through the real model): pass.

Caveats: this deviates from the pairing upstream tests (transformers' own `package.json` pins the nightly), and WebGPU inference was not exercised. If a regression appears, remove the override and restore the nightly pin. This worktree's shared `node_modules` still holds the nightly; run `pnpm install` once after merging.

## Provenance gaps (owner)

Neither Hugging Face repo carries licence metadata via the API; see `docs/LICENSING.md`.
