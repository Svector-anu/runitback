# Licensing

Decision (owner, 2026-10-12): RunItBack is released under the **MIT License**. The licence text is `LICENSE` (`Copyright (c) 2026 RunItBack contributors`), `package.json` declares `"license": "MIT"`, and third-party credits are in `NOTICE.md`. The package stays `"private": true` only so it is never published to npm by accident; that flag does not affect the licence.

## OpenCut

RunItBack was reconstructed from the behaviour, information architecture and design tokens of OpenCut and opencut-classic (`RECONSTRUCTION_SPEC.md`, `research/`, the comment in `src/ui/styles/tokens.css`). Both repositories are MIT (verified 2026-10-12 against their `LICENSE` files; the GitHub API reports `MIT` for opencut-classic):

- `OpenCut-app/OpenCut`: `Copyright 2026 OpenCut`
- `OpenCut-app/opencut-classic`: `Copyright 2025-2026 OpenCut`

MIT is compatible with relicensing under MIT provided the notice is kept for any copied portion. The engine is a new implementation, but the design tokens (colour values in `tokens.css`) follow classic's `globals.css`; `NOTICE.md` therefore reproduces the OpenCut notice to be safe. Not verified here: whether any individual file or asset was copied verbatim rather than re-derived (the research notes say re-derived; a file-by-file diff against upstream was not run). Legacy IndexedDB names `opencut`, `opencut-style` (`src/platform/legacy-migration.ts`) are data-migration identifiers, not branding.

## Dependency licence scan

Tool: `pnpm licenses list --prod` (pnpm 11) on the lockfile, re-run 2026-10-12. The app is bundled by Vite, so "production" means what can reach `dist/`.

Production dependency tree (57 packages incl. transitive): MIT, BSD-3-Clause, Apache-2.0, ISC, plus single packages under LGPL-3.0-or-later, Unlicense, MPL-2.0 and `(MIT OR CC0-1.0)`.

Direct runtime dependencies: `@anthropic-ai/sdk` MIT, `@huggingface/transformers` Apache-2.0, `@mediapipe/tasks-vision` Apache-2.0, `mediabunny` **MPL-2.0**, `onnxruntime-web` MIT, `react` and `react-dom` MIT.

| Package | Licence | Reaches the browser bundle? | Note |
| --- | --- | --- | --- |
| `mediabunny` | MPL-2.0 | yes | File-level copyleft: modifications to mediabunny's own files must be published under MPL-2.0; using it unmodified does not impose it on our code. We do not patch it. Accepted by the owner's MIT decision; revisit if it is ever patched or vendored. |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | no | Native library pulled in by `sharp`, a Node-only dependency of transformers.js. Not in `dist/`. |
| `lightningcss` (dev tree) | MPL-2.0 | no | Build tool. |
| `protobufjs` family | BSD-3-Clause | yes (via ORT) | Permissive; attribution required. |
| `minimatch` (dev tree) | BlueOak-1.0.0 | no | Permissive. |

No GPL or AGPL packages. The build does not emit a third-party notices file; `NOTICE.md` lists the direct dependencies and the package licence texts ship in `node_modules`/the bundle sources. Generating a full bundled-licences file at build time remains optional hardening.

## Bundled assets

| Asset | Licence | Source |
| --- | --- | --- |
| Inter (`public/fonts`, the only bundled font) | SIL OFL 1.1 | `Inter-OFL.txt` ships alongside; the font may not be sold on its own and the reserved-name rules apply to modified versions. |
| MediaPipe wasm runtime (`public/mediapipe/wasm`) | Apache-2.0 | `@mediapipe/tasks-vision`. |
| MediaPipe Selfie Segmenter `.tflite` (two files) | Believed Apache-2.0 (MediaPipe) | **Unconfirmed**: model card PDF links to the Apache licence but its text was not readable here. |
| BlazeFace short-range `.tflite` | Believed Apache-2.0 (MediaPipe) | **Unconfirmed**: check the model card. |

## Models downloaded at runtime

| Model | Upstream licence (believed) | Verified here? |
| --- | --- | --- |
| Whisper tiny.en (OpenAI), ONNX export `onnx-community/whisper-tiny.en_timestamped` | MIT | No: the Hugging Face API returned no licence tag for the repo (2026-10-12); only a `base_model` link to `openai/whisper-tiny.en`. |
| CLIP ViT-B/32 (OpenAI), ONNX export `Xenova/clip-vit-base-patch32` | MIT | No: no licence tag either; base model `openai/clip-vit-base-patch32`. |

Weights are downloaded by the user's browser after explicit consent and are not redistributed by this repository.

## Trademarks and branding

CapCut is a trademark of its owner; RunItBack is not affiliated with it. README and `NOTICE.md` say so, and comparisons are factual. No OpenCut name or logo is used in the UI (only the legacy migration identifiers above). "RunItBack" has not been through a trademark search; do that before any paid or branded launch.

## Remaining owner actions

- [ ] Confirm the BlazeFace model card licence and the two Hugging Face model repos' licences (open each repo page; add the result to `NOTICE.md`).
- [ ] Optional: decide on a build-time third-party notices file.
- [ ] Optional: a file-by-file comparison against OpenCut sources to confirm nothing was copied verbatim.
- [ ] Run a name/trademark search for "RunItBack".
