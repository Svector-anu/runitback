# Audio and voice features

Four features, all on-device: **Snap cuts to beat**, **Noise removal**, **Text to speech**, **Translate captions**. This page records what each one does, which open-source pieces it uses (and which it rejected, as `docs/research/07-oss-reuse-audit.md` asks), the licences and sizes, what was measured, and the honest limits. Pins and hashes are in `docs/SUPPLY_CHAIN.md`.

## Summary

| Feature | Entry points | Engine | Platform | Model / dependency | Download |
| --- | --- | --- | --- | --- | --- |
| Snap cuts to beat | Timeline toolbar (snap button, beat-ticks toggle), agent `snap_cuts_to_beat` | `engine/beatsync` (uses `engine/analysis` + `engine/reference/beats`) | `platform/analysis` (existing cache) | none | none |
| Noise removal | Properties > Audio > Noise removal, agent `reduce_noise` | `engine/audio/{denoise,resample}` | `platform/denoise` | RNNoise via `@jitsi/rnnoise-wasm` 0.2.1 (vendored) | 112 KB wasm, bundled |
| Text to speech | Assets > Text > Text to speech, agent `generate_voiceover`, `list_voices` | `engine/voiceover`, `engine/audio/wav` | `platform/tts` (worker) | SpeechT5 TTS + HiFi-GAN (MIT), `q4f16` | about 105 MB, consent |
| Translate captions | Assets > Captions > Translate captions, agent `translate_captions` | `engine/translate` | `platform/translate` (worker) | Helsinki-NLP opus-mt (`Xenova/opus-mt-*`), `q8` | about 115 MB per pair, consent |

Nothing here changes the CSP (`vercel.json`): the models come from `huggingface.co` / `*.hf.co` (already allowed), the RNNoise wasm is a same-origin hashed asset, no new origin, no eval, no blob scripts. Every model download is behind the consent dialog and `src/app/model-consent.ts`; revisions are pinned in `src/platform/model-revisions.ts`.

## 1. Snap cuts to beat

A **cut** is the shared edge of two touching clips on a video track. Snapping is a *rolling edit*: the left clip's end and the right clip's start move together to the nearest beat within a tolerance (default 150 ms, max 500 ms), so total length, every other clip and the no-overlap rule are untouched, and sync with other tracks is kept. Trims move with the edge (`trimEnd` of the left clip, `trimStart` of the right clip, both converted through the clip's rate), so `trimStart + duration * rate + trimEnd` still equals the source length. One command (`updateElements`), one undo step.

- Beats come from the existing analysis: `analyzeMedia` per unmuted audio-track asset (cached in IndexedDB), then `engine/reference/beats.beatTimes` (a regular grid when the tempo is confident, otherwise strong onsets), mapped to the timeline through each clip's start, trim and rate (`timelineBeats`).
- Candidate beats are rounded to the project's frame grid, so a beat that falls between two frames snaps to one of them: expect up to half a frame (16.7 ms at 30 fps) of residual error.
- UI: the snap button in the timeline toolbar (selected clips' cuts, or every cut when nothing is selected), and a toggle that draws the beats as small dots on the ruler. Both use `src/app/beat-service.ts`.
- Agent: `snap_cuts_to_beat {elementIds?, toleranceSeconds?, dryRun?}` reports moved/skipped counts with reasons and how many cuts sit within 60 ms of a beat before and after. It is part of `createAgentTools({ reference })`, so the app, the MCP bridge and the evals all have it.
- Eval: case `snap-cuts-to-beat` (oracle, `tiny-tolerance` and `left-trim-only` mutations, plus the generic lazy/overreach ones).

Limits, stated plainly:

- **A cut with no spare footage cannot move.** A rolling edit needs "handles": media past the edge on the side that has to grow. Two full-length clips back to back have none; those cuts are skipped (`not-enough-media`), never faked with a gap or a ripple. Cuts made by splitting one clip always have handles.
- Beats exist only if there is music on an unmuted **audio track**. Music inside a video clip's own audio is not used.
- The tempo/onset detector is the existing energy-based one. It is reliable on clear percussive material and weak on soft, legato music; the ticks on the ruler show exactly what it found, so check them before snapping.
- Only video tracks are snapped (not text or graphic layers), and only cuts where clips touch (a gap is not a cut).

Measured (Chrome, real decode and analysis; `e2e/beat-sync.spec.ts`): a 10 s footage clip split at 2.05, 4.45, 6.85, 8.65 s against a 100 BPM click track (beats at 0.15 + 0.6k s, each cut 100 ms late). After the button: 1.933, 4.333, 6.733, 8.533 s, worst distance to a true beat 16.7 ms (the frame grid), timeline length unchanged, `data-start` of each clip equal to the previous end, source continuous, one Ctrl+Z restores the original four cuts.

## 2. Noise removal

**Choice.** RNNoise is the maintained, permissively licensed real-time speech denoiser (a small recurrent network that predicts per-band gains; BSD-3-Clause, Xiph.Org/Mozilla). Candidates checked with `npm view` (2026-10-13):

| Package | Licence | Size (unpacked) | Notes |
| --- | --- | --- | --- |
| `@jitsi/rnnoise-wasm` 0.2.1 | Apache-2.0 (RNNoise itself BSD-3-Clause) | 2.0 MB, of which `rnnoise.wasm` 112 KB and the glue 12 KB are what we ship | Maintained by the Jitsi team (published 2025-11). **Chosen.** The async build contains the RNNoise 0.1 model; the `-sync` build (1.9 MB, inlined) is not used. |
| `@shiguredo/rnnoise-wasm` 2025.1.5 | Apache-2.0 | 4.8 MB (wasm inlined in JS) | Maintained, newer RNNoise, but 40x the shipped size and bundled as one JS blob. Held in reserve. |
| `@timephy/rnnoise-wasm` 1.0.0 | no licence field | 2.0 MB | Rejected (no licence statement). |
| `@sapphi-red/web-noise-suppressor` 0.4.1 | MIT | 0.9 MB | Wrapper around the same RNNoise; AudioWorklet-shaped, not usable offline in the export mix. |

**Why vendored, not an npm dependency.** The package needs two files (the glue and the wasm); the worktree this was built in shares `node_modules` with other checkouts, and a vendored, hash-pinned pair matches how `public/mediapipe` is handled. Files are in `src/platform/denoise/vendor/` (README and licence text next to them) and are bundled by Vite: the glue as a lazy chunk, the wasm as a hashed asset. Re-vendor with `npm pack @jitsi/rnnoise-wasm@<version>`.

**How it works.** `denoise` is a clip parameter (`PARAM.denoise`, 0 to 1, absent means 0, no schema bump: older projects simply lack it). The cleaned audio is computed once per media file, not per clip: the whole decoded source is resampled to 48 kHz, denoised per channel (each channel has its own recurrent state; stereo is not mixed down), the model's one-frame delay is removed, and the result is resampled back to the source rate (`engine/audio/denoise.ts`, `resample.ts`; pure and unit-tested with the real wasm). Only the fully denoised signal is cached (`platform/denoise/denoise-cache.ts`, keyed by the media `Blob`); strength is a dry/wet mix applied while scheduling, so dragging the slider never reprocesses anything.

**One code path for preview and export.** Both `AudioEngine` (live) and `openAudioMix` (export) obtain a clip's audio from `AudioSinkCache.forClip(clip)`. That is the seam: in `src/export/audio-mix.ts` the only change is the line `input.sinks.get(clip.mediaId)` becoming `input.sinks.forClip(clip)`; the chunked mix, its pre-roll and the limiter are untouched. `forClip` returns the original source when `clip.denoise` is 0, and a `denoisedSource` wrapper otherwise. Differences by design: live playback never waits (`wait: false`): while the cleaned copy is still being computed it starts that work and plays the original, switching at the next scheduling window (2 s lookahead); the export waits for it. If denoising fails (wasm error, file too long) both fall back to the original audio, so an export is never silent, and the Audio tab shows the reason.

- Progress: the Audio tab shows "Cleaning up audio... N%" and then the measured noise floor before and after (10th percentile of 20 ms RMS levels, dBFS).
- Agent: `reduce_noise {elementIds, strength?}` analyses first, then sets the strength in one undo step, and reports the estimated floors. A failed analysis changes nothing. `set_params` also accepts `denoise`.
- Memory: the result holds float samples for the whole file. Limit 10 channel-minutes (stereo counts double): about 115 MB of floats at 48 kHz, two to four times that at peak while processing; longer files are refused with a message and play unprocessed. The cleaned copy lives page-wide, keyed by the media blob, so a preview and an export compute it once; only the project's `MediaRuntime` releases it (the exporter's short-lived cache does not).

Measured:

| Where | Noise floor in pauses | Speech level | Source |
| --- | --- | --- | --- |
| Unit test, 48 kHz mono, 6 s synthetic speech plus pink noise | -31.7 dB to -56.8 dB (25.1 dB lower) | -17.1 to -17.5 dB | `tests/denoise.test.ts` |
| Same at 44.1 kHz, stereo | more than 15 dB lower (asserted) | | `tests/denoise.test.ts` |
| Chrome, through the app: slider to 100 %, **exported WebM (Opus) decoded and measured** | -32.0 dB to -55.5 dB (23.5 dB lower) | -16.8 to -17.1 dB | `e2e/denoise.spec.ts` |

The fixture (`tests/speech-fixture.ts`) is a pitch-gliding glottal pulse train through vowel formant filters, gated into 0.28 s syllables with a pause every fourth, plus coloured noise: it has voiced harmonics, formants and pauses, but it is **not real speech**. Real recordings with non-stationary noise (traffic, keyboard, crowds), music or reverb will not give 20+ dB.

Limits: RNNoise is trained for speech; music and effects can lose detail or get a pumping character (lower the strength). The bundled model is RNNoise 0.1's. Steady hiss and hum are removed best; it does not de-reverb. Preview playback cannot be captured by Playwright (the AudioContext writes to the sound card), so the preview/export match is established by the shared `forClip` path and `tests/denoise-clip-path.test.ts`, and the measurement above is on the export.

## 3. Text to speech

**Choice.** Required: permissive licence, runs in the browser, no server.

| Candidate | Licence | Verdict |
| --- | --- | --- |
| Kokoro-82M ONNX (`onnx-community/Kokoro-82M-v1.0-ONNX`) via `kokoro-js` | Apache-2.0 model, Apache-2.0 `kokoro-js` | **Rejected: its phonemizer.** `kokoro-js` depends on `phonemizer`, which bundles a WebAssembly build of **eSpeak NG (GPL-3.0-or-later)**. Shipping that in an MIT app would make the distributed whole GPL. Kokoro without eSpeak needs our own English grapheme-to-phoneme front end, which is not done. Best quality of the lot, so this is the first thing to revisit. |
| Piper voices | MIT engine, voice licences vary | Rejected: same eSpeak NG phonemizer. |
| MMS-TTS (`Xenova/mms-tts-*`) | CC-BY-NC-4.0 | Rejected: non-commercial. |
| Supertonic (`Supertone/supertonic*`, `onnx-community/Supertonic-TTS-*`) | OpenRAIL (use restrictions) | Rejected: not an OSI-style open licence. |
| **SpeechT5 TTS (`Xenova/speecht5_tts`) + HiFi-GAN vocoder (`Xenova/speecht5_hifigan`)**, x-vector voices from CMU ARCTIC | model MIT, vocoder MIT, x-vectors MIT | **Chosen.** Character-level input (no phonemizer, no GPL), transformers.js support in the version we already ship. English only. |

**Quantisation matters.** The default 8-bit export (`q8`, 71 + 88 MB) truncates and garbles speech: a Whisper round trip of "Welcome to the show. Today we are going to talk about editing video." came back as "Welcome to the video.". The 4-bit-weights/fp16-activations export (`q4f16`: encoder 49.4 MB, merged decoder 36.1 MB, plus the 18.3 MB 8-bit vocoder, about 105 MB total) round-trips word for word, as does fp16 (290 MB), so q4f16 is used. Verified in Node with onnxruntime-node and again in Chrome with onnxruntime-web WASM (see below).

**Voices.** Seven x-vectors (the first utterance of each CMU ARCTIC speaker: slt, clb, bdl, rms, awb, jmk, ksp), copied unmodified into `public/tts/voices/` with a README and sha256-pinned. A voice changes timbre and pitch, not the language.

**How it works.** `engine/voiceover` splits the text into passages (sentences, then clauses, then words, at most 180 characters; digits and `%` are spelled out), the worker synthesizes each, passages are joined with 0.28 s pauses, and `speed` (0.5 to 2) is applied with the existing pitch-preserving WSOLA `stretch`. The result is a 16 kHz mono 16-bit WAV, stored through the normal import path (`AppServices.importFiles`: probe, OPFS, IndexedDB, `registerAsset`) and inserted with the normal placement code, so it is a regular audio asset and clip. One undo step removes the clip; the asset stays in the library like any import.

- UI: **Assets > Text > Text to speech** (script, voice, speed, Generate), consent dialog with the size, download then generate progress, cancel.
- Agent: `generate_voiceover {text, voice?, speed?, start?, trackId?, newTrack?}` and `list_voices`. Without consent the call fails with a message that tells the agent which button the user must press once. Eval: case `add-voiceover` (stub engine, oracle and mutations).
- Limits: 2000 characters per call.

**Honest quality.** Intelligible (a Whisper tiny.en round trip reproduces the sentences) but clearly synthetic: flat prosody, occasional mispronunciation of names and unusual words, 16 kHz bandwidth, English only. It is a scratch/placeholder voice, not narration. The generation speed on a loaded machine was about 1x real time on WASM.

**Web Speech API (`speechSynthesis`).** Not offered. Browsers do not let a page capture its output: `SpeechSynthesisUtterance` plays to the sound card and exposes no audio data, no `MediaStream` and no file, so it cannot produce a clip that exports. It is not a recording path and the UI does not present it as one.

## 4. Translate captions

**Choice.** Helsinki-NLP **opus-mt** (MarianMT, trained on OPUS) via the `Xenova/opus-mt-*` ONNX conversions, run with the transformers.js `translation` pipeline in a worker (`q8`). Licences are per pair on the upstream cards (checked with the Hub API on 2026-10-13): `en-es` Apache-2.0, `en-fr` Apache-2.0, `es-en` Apache-2.0, `fr-en` Apache-2.0, `de-en` Apache-2.0, **`en-de` CC-BY-4.0** (attribution required, see `NOTICE.md` if added). The Xenova repos carry no licence field of their own. **NLLB (CC-BY-NC-4.0) is not allowed.** M2M-100 is MIT but 418M parameters (over 400 MB quantised for one multilingual model) and slower; not used.

Size per pair (`q8`): encoder 52.9 MB + decoder 60.2 MB + tokenizer 6.3 MB, about 115 MB.

**Pairs offered = pairs verified on real model output**, listed in `src/engine/translate/pairs.ts`: `en-es`, `en-fr`, `es-en` (see Measurements). A pair is added only after running it.

**How it works.** `translate_captions` and the Captions-tab button translate the selected text clips (UI) or the clips named "Caption N" / an explicit track / explicit ids (agent), one caption per model input in batches of 8, and insert the results as **new** caption track(s) at the top with the same timing, style and animation. The text is re-wrapped for the new length and the box grows away from the frame edge it hugs. The originals are kept; the whole thing is one undo step, and the translator runs before anything is edited so a failure changes nothing.

**Honest quality.** Sentence-level machine translation without context. Short fragments, slang, names, idioms and captions that split a sentence mid-way come out literal or wrong, and gender or formality choices are the model's. The panel and the tool result say so, and tell the user to read the result before publishing. Transcripts: translate by creating captions first (`add_captions_from_transcript`, or import an `.srt`), then translating them; there is no separate transcript-translation path.

## Measurements

Real-model runs (Node 26 + onnxruntime-node for the offline checks; Google Chrome 155 stable with onnxruntime-web WASM for the app; machine under heavy load, so timings are pessimistic):

**Text to speech (SpeechT5).** Intelligibility is checked by transcribing the generated audio with Whisper tiny.en (the same model family the app ships).

| Run | Quantisation | Whisper transcript |
| --- | --- | --- |
| Node, onnxruntime-node | `q8` | "Hello, this is a very always-voive." (input: "Hello, this is a test of the on device voice over. It should be understandable."), "Welcome to the video.", "The quick breath off of HIV." |
| Node | `q4f16` | "Welcome to the show. Today we are going to talk about editing video." and "The quick brown fox jumps over the lazy dog." (both, with and without `minlenratio`) |
| Node | `fp16` | the same two sentences (one run: "Just the quick brown fox...") |
| **Chrome 155, onnxruntime-web WASM, in the app's worker (`e2e/voice-real.spec.ts`)** | `q4f16` | audio 3.99 to 4.06 s at 16 kHz, rms 0.034 to 0.041; transcript of the browser-generated audio: "Welcome to the show. Today we are going to talk about editing video." (verbatim) |

Page errors during the Chrome runs: none. End to end including the model download: 84 s on a fast link, 515 s on a slow one (about 105 MB). Under the production CSP (`vite preview` with the `vercel.json` headers, `e2e/csp.spec.ts` with `REAL_CSP=1`) the same flow (text to speech, then an imported .srt translated en to es) passed: the pinned revisions were requested, zero CSP violations, and the only hosts that answered were this origin, `huggingface.co` and `us.aws.cdn.hf.co`. The noise removal path has a non-opt-in CSP test too (the vendored wasm runs with no violation and no third-party request). Generation speed was not benchmarked (the measuring machine was heavily loaded; it ran roughly at real time).

**Caption translation (opus-mt, `q8`).** Real output:

| Pair | Input | Output |
| --- | --- | --- |
| en to es (Node) | "Welcome to the show." / "Today we are going to talk about editing video." / "Press the red button to start recording, then trim the clip." / "I can't believe it's already over!" | "Bienvenido al show." / "Hoy vamos a hablar de editar vídeo." / "Pulse el botón rojo para iniciar la grabación y luego recortar el clip." / "¡No puedo creer que ya haya terminado!" |
| en to es (**Chrome worker, `e2e/voice-real.spec.ts`**, first three) | same | "Bienvenido al espectáculo." / "Hoy vamos a hablar de editar vídeo." / "Pulse el botón rojo para iniciar la grabación y luego recortar el clip." |
| en to fr (Node) | same | "Bienvenue dans le spectacle." / "Aujourd'hui, nous allons parler de montage vidéo." / "Appuyez sur le bouton rouge pour commencer l'enregistrement, puis taillez le clip." / "Je n'arrive pas à croire que c'est déjà fini!" |
| es to en (Node) | "Bienvenidos al programa." / "Hoy vamos a hablar sobre edición de video." / "Pulsa el botón rojo para empezar a grabar y luego recorta el clip." | "Welcome to the show....." / "Today we're going to talk about video editing.." / "Press the red button to start recording and then crop the clip." |

Fluent for plain sentences, with the usual machine-translation slips: "show" rendered as "espectáculo", "trim" as "taillez" (cut a tree) and "crop", and stray repeated full stops in es to en output. The app does not post-process model output, so those dots appear in the caption. In Chrome the en to es run (including a 115 MB download) took 1.7 to 4 minutes end to end; translation itself, a few seconds for three captions.

Other pairs published as `Xenova/opus-mt-*` (`fr-en`, `de-en`, `en-de`, ...) exist, but were **not run**, so the UI does not list them.

**Noise removal and beat sync:** see the tables in sections 2 and 1.

## Tests

- Unit: `tests/beat-snap.test.ts` (rolling edits, fuzz over random cuts, skip reasons), `tests/denoise.test.ts` (real wasm, noise floor in dB, alignment, stereo, 44.1 kHz, cache, memory cap), `tests/denoise-clip-path.test.ts` (the shared `forClip` path), `tests/reduce-noise.test.ts`, `tests/voiceover.test.ts`, `tests/translate-captions.test.ts`, `tests/voice-translate-consent.test.ts`, `tests/supply-chain.test.ts` (hashes, pins), `tests/evals-suite.test.ts` (new eval cases).
- E2E in real Chrome (`playwright.chrome.config.ts`, `channel: "chrome"`): `e2e/beat-sync.spec.ts`, `e2e/denoise.spec.ts` (exported audio measured), `e2e/voice-translate.spec.ts` (UI flows with model doubles). Opt-in `REAL_TTS=1 e2e/voice-real.spec.ts` downloads and runs both real models.
