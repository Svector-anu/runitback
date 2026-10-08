# 07 - OSS reuse audit of hand-built modules

Date 2026-10-08. Package metadata from `npm view` (version, license, unpackedSize, modified). Stars/commit dates not
fetched (no GitHub access that worked); "modified" is last npm publish. Ranking is value/effort.

## Prioritized recommendation

1. **KEEP almost everything.** No candidate is clearly better than ours on license + size + API fit + pure-engine constraint.
   Our modules are small (stretch 151 LOC, analysis ~800, captions 236, transcript ~190), pure, Float32Array/seconds-native,
   and covered by tests (audio-stretch 6, analysis-* 40, regress-captions 5, transcript-* suites).
2. **ADOPT-FOR-NEXT (high value, low effort): MediaPipe Tasks Vision** (`@mediapipe/tasks-vision`, Apache-2.0) for face
   detection/tracking. Lives in `platform/`, outputs normalized boxes into engine as plain data.
3. **ADOPT-FOR-NEXT (high value, zero new dependency): `@huggingface/transformers` 4.3.x already in package.json**
   (we pin 4.3.0; 4.3.1 out) for CLIP/SigLIP embeddings. Only add a model, not a library.
4. **CONDITIONAL REPLACE (medium value, medium effort): true EBU R128 LUFS** via `ebur128-wasm` (Apache-2.0) *only if*
   the product needs a real LUFS number (e.g. normalize-to -14 LUFS, export loudness report). Our "integrated" is an
   RMS-gated approximation (`integratedApproxDb`, no K-weighting) - fine for silence/relative leveling, wrong for LUFS targets.
   Alternative: implement K-weighting (two biquads) + gating ourselves in ~80 LOC; cheaper than a wasm dep and stays pure.
5. **Do NOT adopt**: Rubber Band wasm ports (GPL), essentia.js (AGPL), soundtouchjs (LGPL), jassub/libass-wasm (LGPL),
   lamejs (LGPL). All fail the license bar.
6. **Optional (low value): `signalsmith-stretch`** (MIT) as a quality upgrade for extreme rates; see section 1.

Value/effort table:

| Rank | Item | Verdict | Value | Effort |
|---|---|---|---|---|
| 1 | transformers.js CLIP/SigLIP (already a dep) | ADOPT-FOR-NEXT | high | low |
| 2 | MediaPipe FaceDetector/FaceLandmarker | ADOPT-FOR-NEXT | high | low-med |
| 3 | LUFS (own K-weighting, or ebur128-wasm) | REPLACE (conditional) | med | low-med |
| 4 | signalsmith-stretch | KEEP unless quality complaints | low-med | med-high |
| 5 | Subtitle parsers, onsets/tempo, scene cuts, alignment | KEEP | - | - |

## 1. Time-stretch: src/engine/audio/stretch.ts (WSOLA, pure, Float32Array[] -> Float32Array[])

Used by `platform/audio-scheduler.ts` (per decoded buffer) and `export/audio-mix.ts` (offline), so it is the shared path
that keeps preview and export identical (invariant 6).

| Candidate | License | Maint. | Size (unpacked) | Notes |
|---|---|---|---|---|
| `soundtouchjs` 0.3.0 | **LGPL-2.1** | 2026-02 | 1.87 MB | LGPL: reject (static bundling in a Vite app is a compliance burden) |
| `@soundtouchjs/core` 2.1.1 / `audio-worklet` 2.1.1 | MPL-2.0 (ok) | 2026-08 | 224 KB / 296 KB | Rewritten, active. Same WSOLA-family algorithm we already ship; no quality gain. `core` is pure TS and could run headless |
| `signalsmith-stretch` 1.3.2 | MIT | 2025-06 | 232 KB (wasm inlined) | Phase-vocoder-style, noticeably better quality than WSOLA on polyphonic/music and large ratios. API is an AudioWorklet-node (`SignalsmithStretch(ctx)`), not a pure function; real-time oriented. Offline export would need an OfflineAudioContext worklet or a different entry |
| `rubberband-wasm` 3.3.0, `rubberband-web` 0.2.1 | **GPLv2 / GPL-2.0+** | 2024-12 / 2022 | 644 KB / 1.45 MB | Best quality, license disqualifies (commercial license exists upstream, not for us) |

Verdict: **KEEP.** WSOLA at 0.5x-2x on speech is what NLEs ship. Replacing with `@soundtouchjs/core` buys nothing
(same algorithm, +224 KB). `signalsmith-stretch` is the only quality upgrade, but it breaks the "engine is pure and
runs in Node" rule (worklet/wasm) and the preview/export shared-function design.
If music-at-extreme-ratio quality becomes a complaint: wrap signalsmith in `platform/`, keep `stretch()` as the
engine fallback/headless path. Equivalence check: `tests/audio-stretch.test.ts` (autocorrelation pitch preservation,
duration) + a new A/B listening fixture; do not replace without a pitch-error and transient-smear metric.

## 2. Silence / loudness / onsets / tempo: src/engine/analysis/{audio,onsets,timeline}.ts

What exists: streaming `RmsAccumulator` (20 ms windows), silence ranges, RMS-gated integrated approximation
(400 ms blocks, -70 abs / -10 rel gate - the R128 gate structure but **no K-weighting**), energy-flux onsets, a
60-200 BPM tempo estimate with confidence. All operate on `RmsWindows` (tiny), not raw PCM.

| Candidate | License | Maint. | Size | Fit |
|---|---|---|---|---|
| `ebur128-wasm` 3.0.0 | Apache-2.0 | npm 2023-07 (stale but stable spec) | 107 KB | Real BS.1770/R128: integrated, momentary, short-term, LRA, true-peak. Needs raw PCM (we only keep RMS windows), wasm init in worker |
| `essentia.js` 0.1.3 | **AGPL-3.0** | 2022-05 | 10.1 MB | Reject: license + size |
| `aubiojs` 0.2.1 | none declared (aubio is GPL-3) | 2022-11 | 427 KB | Reject: GPL upstream |
| `web-audio-beat-detector` 8.2.39 | MIT | 2026-08 | 42 KB | Needs an `AudioBuffer`; returns a single BPM + offset. Ours already gives BPM+confidence from onsets; no beat grid per bar either way |
| `meyda` 5.6.3 | MIT | 2024-04 | 556 KB | Feature extractor (MFCC/spectral flux), needs FFT frames in WebAudio; not a drop-in onset/tempo tracker |
| `@ricky0123/vad-web` 0.0.31 | ISC | 2026-09 | 6.7 MB (onnx+model) | Neural VAD; relevant only if the energy-based "speech ranges" prove inaccurate on noisy audio |

Verdicts:
- Silence detection, onsets, tempo: **KEEP.** No maintained permissive library is better on our interface; the
  tempo path is used for beat-snapping, not music information retrieval. Benchmarks: `tests/analysis-audio.test.ts` (14),
  `analysis-timeline.test.ts` (11).
- Loudness: **REPLACE conditionally** with true LUFS. Two routes:
  (a) add K-weighting biquads (pre-filter shelf +4 dB @1.68 kHz, RLB high-pass 38 Hz, coefficients from BS.1770 table
      rescaled per sample rate) to the accumulator ahead of the mean-square, in `engine/analysis/audio.ts` - stays pure,
      ~80 LOC, rename `integratedApproxDb` to `integratedLufs`;
  (b) `ebur128-wasm` in a platform worker, fed decoded chunks (mediabunny already streams them).
  Prefer (a): the gating code is already there, no wasm, no worker. Equivalence: render pink noise / 1 kHz sine at
  known levels (-23 LUFS reference signal from EBU Tech 3341/3342 test set) and assert +-0.1 LU; cross-check against
  `ebur128-wasm` in a dev-only test (devDependency, not shipped).
- VAD: ADOPT-FOR-NEXT only if speech-range accuracy evals in `evals/` regress.

## 3. Scene-cut / shot detection: src/engine/analysis/video.ts (237 LOC)

16x9 luma grid + 8-bin RGB histogram + 4x4x4 palette signature, luma distance, robust local MAD threshold,
min shot 0.5 s, motion level classification. Pure, on RGBA arrays.

Search found **no maintained JS/wasm shot-boundary library** (PySceneDetect, TransNet V2 are Python; OpenCV.js
`@techstark/opencv-js` 5.0.0, Apache-2.0, 14.7 MB unpacked, could do histogram diffs but is vast overkill).
Learned option: TransNet V2 via onnxruntime-web (already a dep) - handles dissolves, but model download ~30 MB class
and no JS packaging; not justified for hard cuts.

Verdict: **KEEP.** Hard-cut detection by adaptive-threshold histogram/luma distance is the standard method
(PySceneDetect's ContentDetector is the same idea). Revisit only for gradual transitions. Tests: `analysis-video.test.ts` (15).

## 4. Caption parsing: src/engine/captions/parse.ts (SRT + ASS/SSA, 236 LOC)

Output carries bounds guards (`MAX_CUE_SECONDS`, 5 MB cap), `MediaTime` ticks, and a mapped `CueStyle` (ASS style -> ratios).

| Candidate | License | Maint. | Size | Notes |
|---|---|---|---|---|
| `subtitle` 4.2.2 | MIT | 2025-11 | 110 KB | SRT/VTT parse+stringify, stream API. No ASS |
| `@plussub/srt-vtt-parser` 2.0.5 | MIT | 2024-07 | 11.6 KB | Tiny SRT/VTT; no ASS |
| `media-captions` 0.0.18 | MIT | 2024-07 | 216 KB | VTT/SRT/SSA parse; Vidstack project; pre-1.0 |
| `ass-compiler` 0.1.16 | MIT | 2025-11 | 145 KB | Best ASS parser/compiler (styles, override tags, `\k` karaoke); pre-1.0, ES5-ish output |
| `subsrt-ts` 2.1.2 | MIT | 2024-04 | 88 KB | Multi-format convert |
| `jassub` 2.5.18 / `libass-wasm` | **LGPL-2.1 + mixed** | 2026-10 / 2022 | 4.9 / 7.7 MB | Renderer, not parser; LGPL; and we render cues ourselves in Compositor |

Verdict: **KEEP SRT** (parser is ~60 lines; a dep would not remove our time/bounds guard layer).
**ASS: KEEP now, ADOPT `ass-compiler` for next** if we want override-tag fidelity (`\pos`, `\k` karaoke, `\t` animation) -
our `stripOverrideBlocks` discards those, which is exactly the word-level-animated-caption feature. Migration sketch:
`parseAss` calls `ass-compiler.parse` for Dialogue/Style, maps `slices[].fragments[].tag` to a new optional
`CaptionCue.words?` array; keep `CueStyle` mapping and the bounds guards. Verify: `regress-captions.test.ts` + a golden
corpus of real .ass files (Aegisub exports) comparing cue count/time/text before and after.

## 5. Transcript: src/engine/transcript/* (word grouping, sentences, ranges, search)

Correction to premise: there is **no forced alignment** in this module. It consumes whisper word timestamps and does
greedy phrasing (`wordsToCaptionChunks`: max 32 chars, 3 s, 0.5 s pause) and sentence splitting. That logic is product
policy (caption line length, pause), not a commodity - no library replaces it. **KEEP.**

Forced alignment as a *next* capability (fixes whisper word-time drift, a known transformers.js issue #805):
- Browser-feasible option exists: wav2vec2/MMS CTC model through transformers.js plus CTC segmentation over a known
  transcript. A public demo does it with a ~241 MB model under **CC-BY-NC-4.0** (non-commercial) - disqualifying
  as-is. Would need a permissive CTC model (e.g. a facebook/wav2vec2-base-960h ONNX, Apache-2.0, English only, ~95 MB
  q8) plus our own Viterbi/trellis (~100 LOC, pure, belongs in `engine/transcript`).
- Verdict: **ADOPT-FOR-NEXT, low priority.** Gate on evidence that whisper word times are visibly wrong in
  `evals/`; whisper `return_timestamps: "word"` with DTW alignment heads is usually adequate for caption sync.

## 6. Planned next features

| Feature | Pick | License | Size | Fit |
|---|---|---|---|---|
| Face detect/track | `@mediapipe/tasks-vision` 1.1.0 (published 2026-10-08) | Apache-2.0 | npm 40.6 MB unpacked, but only the SIMD `wasm/` runtime (~10 MB class) + BlazeFace short-range model (~230 KB) are fetched at runtime | Works in Worker (`FaceDetector.detectForVideo(ImageBitmap, ts)`), TS types included, GPU delegate optional. Self-host the `wasm/` and `.tflite` under public/ for offline. Keep in `platform/`, emit `{t, boxes[]}` as plain data to the engine; smoothing/tracking (IoU + EMA) is pure engine code |
| Face landmarks / mesh | same package, FaceLandmarker | Apache-2.0 | +~3.7 MB model | Only if reframing needs head pose |
| Visual embeddings (CLIP/SigLIP) | `@huggingface/transformers` 4.3.1 (already dependency 4.3.0) | Apache-2.0 | models on demand (CLIP ViT-B/32 q8 ~90 MB; SigLIP-base larger) | Zero new code deps; WebGPU or wasm via the onnxruntime-web we already pin. Cache in OPFS. Use for semantic clip search and "find shots like this" |
| Face (legacy) | `@vladmandic/face-api` 1.7.15 (MIT, 23.7 MB), `face-api.js` 0.22.2 (2022) | MIT | big, TF.js-based | Reject: stale, TF.js duplicates ORT |
| OpenCV.js | `@techstark/opencv-js` 5.0.0 | Apache-2.0 | 14.7 MB | Reject for now: only worth it for optical-flow stabilization/tracking beyond box tracking |
| Word-level animated captions | none needed for rendering; `ass-compiler` for karaoke import | MIT | 145 KB | Render in our Compositor from word times (already available). Library help is only on the import side (\k tags) |

Layering for all ML items: model runtime and decoding in `platform/` (worker), results as typed plain data into the
engine, so `engine` stays Node-runnable. Model URLs must be configurable for offline/self-hosted use.

## Items not verified

GitHub stars/last commit dates (only npm publish dates used); exact runtime wasm/model byte sizes for MediaPipe,
CLIP and wav2vec2 (estimates marked "class"/"~"); whether `signalsmith-stretch` has a non-worklet offline entry.
Check these before committing to a migration.
