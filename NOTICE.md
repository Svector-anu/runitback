# Third-party notices

RunItBack is released under the [MIT License](LICENSE). It builds on the work of others; this file records what we owe them and what we ship. See `docs/LICENSING.md` for the audit method and open questions.

## OpenCut

RunItBack was reconstructed from the observable behaviour, information architecture and design tokens of two MIT-licensed projects, written as a new TypeScript implementation (see `docs/RECONSTRUCTION_SPEC.md` and `docs/research/`). Their licence texts carry these copyright lines, quoted verbatim:

- [OpenCut-app/OpenCut](https://github.com/OpenCut-app/OpenCut), MIT: `Copyright 2026 OpenCut`
- [OpenCut-app/opencut-classic](https://github.com/OpenCut-app/opencut-classic), MIT: `Copyright 2025-2026 OpenCut`

The design tokens in `src/ui/styles/tokens.css` follow OpenCut classic's `globals.css`. The MIT licence requires its copyright and permission notice to be kept in copies of the Software or substantial portions of it, so the notice is reproduced here:

```
Copyright 2025-2026 OpenCut

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The licence texts were fetched from each repository's `LICENSE` file on the `main` branch. RunItBack is not affiliated with or endorsed by OpenCut.

## Direct runtime dependencies

Licences as reported by `pnpm licenses list --prod` on this repository's lockfile.

| Package | Licence | Notes |
| --- | --- | --- |
| `mediabunny` | MPL-2.0 | File-level copyleft. We use it unmodified as a dependency; changes to mediabunny's own files would have to be published under MPL-2.0. |
| `@anthropic-ai/sdk` | MIT | Used for the in-app agent, with the user's own key. |
| `@huggingface/transformers` | Apache-2.0 | Runs Whisper and CLIP in the browser. |
| `@mediapipe/tasks-vision` | Apache-2.0 | Face detection. |
| `onnxruntime-web` | MIT | WebAssembly runtime for the models above. |
| `react`, `react-dom` | MIT | UI. |

Transitive production dependencies (57 packages in all) are MIT, BSD-3-Clause, Apache-2.0, ISC, Unlicense or `(MIT OR CC0-1.0)`, with two exceptions that do not reach the browser bundle: `@img/sharp-libvips-*` (LGPL-3.0-or-later, a native library pulled in by `sharp`, which is a Node-only dependency of transformers.js) and the MPL-2.0 `lightningcss` build tool. No GPL or AGPL packages are in the tree. The `protobufjs` family (BSD-3-Clause) is bundled through ONNX Runtime; BSD-3-Clause and Apache-2.0 attribution applies to it and to the Apache-licensed packages above. Their licence texts ship inside the respective npm packages.

Development-only tooling (Vite, Vitest, Playwright, ESLint, TypeScript, tsx, zod, the MCP SDK and others) is not distributed in the built site.

## Vendored assets

| Asset | Location | Licence |
| --- | --- | --- |
| Inter (variable, latin subset, via `@fontsource-variable/inter` 5.3.0) | `public/fonts/` | SIL Open Font License 1.1, copyright 2016 The Inter Project Authors. Licence text: `public/fonts/Inter-OFL.txt`. Inter is the only bundled font. |
| MediaPipe Tasks Vision WebAssembly runtime (`vision_wasm_internal.js`, `.wasm`) | `public/mediapipe/wasm/` | Apache-2.0 (Google, MediaPipe). |
| MediaPipe Selfie Segmenter (`selfie_segmenter.tflite`, `selfie_segmenter_landscape.tflite`) | `public/mediapipe/` | Published by Google MediaPipe; believed Apache-2.0 (the model card links to the Apache licence; its text could not be read here). **Not confirmed**: see `docs/VIDEO_FX.md`. |
| BlazeFace short-range face detector (`blaze_face_short_range.tflite`) | `public/mediapipe/` | Published by Google MediaPipe; believed Apache-2.0. **Not confirmed here**: confirm against the MediaPipe model card before relying on it. |

## Models downloaded at runtime

No model weights are in this repository. Models are fetched from Hugging Face only after the user gives explicit consent in the app (`src/app/model-consent.ts`) and are cached in the browser.

| Model | Source | Upstream licence |
| --- | --- | --- |
| Whisper tiny.en (speech transcription) | `onnx-community/whisper-tiny.en_timestamped`, ONNX conversion of OpenAI `whisper-tiny.en` | OpenAI Whisper is released under MIT. **Unconfirmed for the ONNX repo**: the Hugging Face API returned no licence tag for it on 2026-10-12 (only a `base_model` link). |
| CLIP ViT-B/32 (visual search) | `Xenova/clip-vit-base-patch32`, ONNX conversion of OpenAI `clip-vit-base-patch32` | OpenAI CLIP is released under MIT. **Unconfirmed for the ONNX repo**: no licence tag returned either. |

These models are neither redistributed nor modified by this project. Anyone who self-hosts a copy of the weights should check the licence of the repository they copy from.

## Trademarks

All product and company names are trademarks of their respective owners. CapCut is a trademark of its owner; RunItBack is not affiliated with, endorsed by or sponsored by it. Anthropic and Claude are trademarks of Anthropic, PBC; RunItBack is an independent project.
