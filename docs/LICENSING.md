# Licensing

No `LICENSE` file exists and `package.json` has no `license` field (the package is `private`). Choosing a licence is an owner decision and has deliberately not been made here.

## Dependency licence scan

Tool: `pnpm licenses list --prod --json` (pnpm 11) on the lockfile with the ORT 1.30.0 override applied; the app itself is bundled by Vite, so "production" means what can reach `dist/`.

Production dependency tree (57 packages incl. transitive): MIT 32, BSD-3-Clause 11, Apache-2.0 8, ISC 2, plus single packages under LGPL-3.0-or-later, Unlicense, MPL-2.0 and `(MIT OR CC0-1.0)`.

Direct runtime dependencies: `@anthropic-ai/sdk` MIT, `@huggingface/transformers` Apache-2.0, `@mediapipe/tasks-vision` Apache-2.0, `mediabunny` **MPL-2.0**, `onnxruntime-web` MIT, `react` and `react-dom` MIT.

Non-permissive or notable:

| Package | Licence | Reaches the browser bundle? | Note |
| --- | --- | --- | --- |
| `mediabunny` | MPL-2.0 | yes | File-level copyleft: modifications to mediabunny's own files must be published under MPL-2.0; using it unmodified as a dependency does not impose it on our code. We do not patch it. |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | no | Native image library pulled in by `sharp`, a Node-only dependency of transformers.js. Not in `dist/`. |
| `lightningcss` (dev tree) | MPL-2.0 | no | Build tool. |
| `protobufjs` family | BSD-3-Clause | yes (via ORT) | Permissive; attribution required. |
| `minimatch` (dev tree) | BlueOak-1.0.0 | no | Permissive. |

No GPL/AGPL packages. Attribution notices (MIT, BSD, Apache-2.0 NOTICE) are required when redistributing; the build does not currently emit a third-party notices file.

## Bundled assets

| Asset | Licence | Source |
| --- | --- | --- |
| Inter (`public/fonts`) | SIL OFL 1.1 | `Inter-OFL.txt` shipped alongside; the font may not be sold on its own and the reserved font name rules apply to modified versions. |
| BlazeFace short-range `.tflite`, MediaPipe wasm | Apache-2.0 (MediaPipe) | Model card terms should be confirmed by the owner. |

## Models downloaded at runtime

| Model | Upstream licence (believed) | Verified here? |
| --- | --- | --- |
| Whisper tiny.en (OpenAI), ONNX export `onnx-community/whisper-tiny.en_timestamped` | MIT | No: the hub API returns no licence tag for the repo. |
| CLIP ViT-B/32 (OpenAI), ONNX export `Xenova/clip-vit-base-patch32` | MIT | No: no licence tag either. |

The code comment in `src/platform/visual/indexer.ts` already states CLIP is MIT; confirm against the model cards before launch.

## Owner decision checklist

- [ ] Choose the project licence and add `LICENSE` plus the `license` field.
- [ ] Decide whether "reconstructed from OpenCut" (see `docs/RECONSTRUCTION_SPEC.md`, `docs/research/07-oss-reuse-audit.md`) imposes obligations; confirm OpenCut's licence and whether any code or assets were copied rather than re-derived.
- [ ] Confirm the licences of the two Hugging Face model repos and the MediaPipe model; record them here.
- [ ] Accept or reject MPL-2.0 for `mediabunny` (fine if unmodified; revisit if you patch it).
- [ ] Decide on a third-party notices file generated at build time (MIT/BSD/Apache attribution).
- [ ] Decide the stance on the bundled Inter (OFL) and which further fonts to bundle (each needs its own licence file).
- [ ] Trademark/branding: confirm "RunItBack" naming and any OpenCut branding left in UI strings or assets.
