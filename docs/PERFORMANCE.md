# Performance and long-media hardening (N1)

Measured 2026-10-10 on an Apple-silicon Mac while other builds and test runs shared the machine, so frame-gap maxima are noisy and p50/p95 are the numbers to trust. Timeline numbers come from the Vite dev server (React development build, slower than production). Reproduce with `pnpm exec playwright test perf-` and `pnpm vitest run tests/perf-`; raw JSON lands in `e2e/.artifacts/` (gitignored). Test media is generated with ffmpeg into `e2e/.artifacts/perf-media/` and never committed. ffmpeg is resolved from `FFMPEG_PATH` or `PATH` (needs libx264); without it the media specs skip with a reason. CI installs ffmpeg with apt and skips the 4K spec (it runs the Node worker out of heap on the runner; `RUN_4K=1` forces it). The media specs run in the installed Chrome (`channel: "chrome"`) because Playwright's bundled Chromium has no H.264 decoder.

## (a) Large timeline: 96 clips on 8 tracks (`e2e/perf-timeline.spec.ts`)

| Metric | Before | After |
|---|---|---|
| Clip elements mounted at high zoom (96 total) | 96 | 9 |
| Ruler scrub, rAF gap p50 / p95 | 16.7 / 33.4 ms | 16.7 / 33.3 ms |
| Ruler scrub, long-task time over 160 moves | 889 ms (12 tasks), max gap 217 ms | 176-490 ms (3-8 tasks), max gap 83-100 ms (one noisy run 2.2 s) |
| Clip drag, 80 moves, long-task time | 1293 ms, p95 50 ms | 50-363 ms, p95 33 ms |
| Horizontal scroll, p95 | 33.3 ms | 16.8-33.4 ms |

What changed (`src/ui/timeline/`):
- Clips are windowed: only clips intersecting the viewport plus half a viewport of overscan, and selected clips, are mounted (`clipWindow` / `intersectsWindow` in `layout.ts`).
- `ClipView` now bails out of re-renders: handlers are stable `useCallback`s, the `box` prop is no longer re-created per render, the `track` object prop became `trackId`, and a custom comparator ignores geometry rebuilds that did not change a clip's own numbers.
- `Timeline` subscribes to the slices of `interactionStore` it renders (`mode`, `snapTime`, `dropLineIndex`, `box`) instead of the whole object, so snap/scrub updates no longer re-render everything.

Windowing caveat: a keyboard-focused clip that scrolls out of the window loses focus (selected clips stay mounted).

Remaining: during a scrub that reaches the edge of the timeline, `edgeAutoScroll`'s per-frame `getBoundingClientRect` plus `scrollLeft` write forces layout; on a loaded machine this produced occasional single frames of 0.3-2 s (attributed by the Long Animation Frames API to `controllers.ts tick`). Not isolated from CPU contention; no fix attempted.

## (b) Export audio mix (`tests/perf-audio-mix.test.ts`, `e2e/perf-export.spec.ts`)

Before, `mixTimelineAudio` scheduled every clip of the whole project on one `OfflineAudioContext` and rendered one buffer for the entire duration. Now `openAudioMix` renders consecutive 15 s chunks (each its own context, started 0.5 s early with the preroll discarded so the limiter has settled), and the exporter pulls a chunk, encodes it with `AudioBufferSource.add`, and only then renders the next, staying about one second ahead of the video frames. Pitch preservation, gain envelopes and the master limiter are the same `scheduleClipWindow` / `createMasterChain` calls as before. `mixTimelineAudio` remains as a concatenating wrapper for short mixes and the existing tests.

10-minute synthetic mix with fake contexts (14 overlapping 60 s clips, real `Float32Array` allocation):

| | Chunks | Largest single render | Output sample storage allocated per pulled chunk |
|---|---|---|---|
| Whole timeline (previous behaviour, `chunkSeconds` = duration) | 1 | 26,460,000 samples | 211.7 MB |
| Chunked | 40 | 661,500 samples | 10.8 MB |

This is the memory that scales with project length; the chunked figure is constant for any length. A 1 hour project previously needed about 1.27 GB for this buffer alone.

Real browser, 2 minute project (6 x 20 s clips, 440 Hz tone, WebM/Opus): export took 12.2-16.4 s, file 4.5 MB, decoded audio 120.01 s, largest sample-to-sample step 0.021 (a click at a chunk seam would exceed 0.15), JS heap peak 35-38 MB. JS heap does not include audio buffers (external memory), so the unit-test accounting above is the memory evidence. No before-run of this e2e was taken.

Also: the muxed file is now streamed to the origin-private file system (`src/export/export-target.ts`, `StreamTarget`) instead of a `BufferTarget` followed by a second copy into a `Blob`; it falls back to the buffer where OPFS is unavailable. Files older than an hour in `runitback-exports/` are removed at the next export. Not separately measured: the 4K export below produced a 15.3 MB file, too small to show the saving.

## (c) 4K H.264 (`e2e/perf-media.spec.ts`)

Source: 3840x2160, 30 fps, 8 s, H.264 + AAC, keyframe every 2 s. The project adopts the clip's size, so preview and export canvases are 3840x2160.

| Metric | Before | After |
|---|---|---|
| Import, preview paint, MP4 export | works (no crash) | works |
| Decoded preview frame width | 3840 | 1920 (`PREVIEW_MAX_EDGE`) |
| First frame decode | 25.5 ms | 7.3-11.6 ms |
| Sequential frame decode (mean of 60) | 13.5 ms | 9.7-10.5 ms |
| Random seek (mean of 20, 2 s GOP) | 205 ms | 201-208 ms (unchanged: GOP decode from the keyframe) |
| Export 240 frames at 4K | 20.6 s (11.6 fps) | 19.9-21.0 s (11.4-12.1 fps) |
| Output | 3840x2160 MP4, 15.3 MB | same |

Changes (`src/platform/video-frames.ts`, `media-runtime.ts`, `src/export/exporter.ts`):
- `VideoFrameCache` takes `maxEdge` and passes a scaled `{width, height}` to `CanvasSink`. The preview runtime caps at 1920. Export decodes up to 2x the output's long edge so zoomed-in clips stay sharp, so a 4K export still decodes at native size.
- At most `MAX_OPEN_DECODERS` (12) decoders are open; the least recently used is disposed first (previously one per media id, each retaining a full frame, for the life of the project: 80 distinct 4K sources would hold roughly 2.6 GB of frames).
- A failed `open` now disposes its `Input` (it was leaked on retry).

Remaining (see section (e) for the export work that followed): the 4K preview canvas itself is still allocated at project size (3 full-size canvases in `Compositor`) because preview resolution is owned by `render/compositor.ts` and `ui/preview`, outside this work. Export throughput at 4K (about 12 fps) is bounded by compositing and encoding, not by decode. Random-seek latency is H.264 GOP cost.

## (d) 10-minute source: scrubbing and release (`e2e/perf-media.spec.ts`, `tests/perf-media-runtime.test.ts`)

Source: 640x360, 15 fps, 600 s H.264/AAC. 340 pseudo-random seeks through the playhead and `runtime.video.getFrame`.

| Metric | Result |
|---|---|
| Seek latency p50 / p95 | 51.8 / 89.6 ms |
| JS heap after forced GC, after 40 seeks vs after 340 seeks | 22.3 MB vs 23.0 MB |
| Open decoders / object URLs / image bitmaps during scrub | 1 / 1 / 0 |
| After navigating away (project closed) | 0 decoders, 0 object URLs, 0 blobs, 0 bitmaps |

`MediaRuntime.stats()` exposes these counts. The unit test uses a mocked `mediabunny` to assert: one decoder and at most one live iterator across 400 seeks, decoders never exceed `MAX_OPEN_DECODERS` across 36 media, the most recently used decoder is kept, every created object URL is revoked on `release`/`dispose`, and no input stays open after `dispose`.

Not covered: audio sinks (`AudioSinkCache`, in `audio-scheduler.ts`) have no count hook and were not asserted.

## Not verified

- Production-build timeline numbers (dev server only).
- Playwright's bundled Chromium (the media specs need Chrome; the timeline and export specs run in either).
- Projects longer than 2 minutes in a real browser, and 4K projects longer than 8 s.
- Firefox and Safari export throughput (`docs/BROWSERS.md` covers whether they work at all; the numbers here are Apple-silicon Chrome).

## (e) Export throughput at 1080p and 4K

Instrumentation: `exportProject` takes an optional `timings` object (`ExportTimings`) and fills per-stage wall time: frame plan, decode (`sources.prepare`), compose (`drawPlan`), audio pump, capture (`new VideoSample(canvas)`) and encode (`videoSource.add`, which includes encoder and muxer backpressure). `e2e/perf-export-profile.spec.ts` runs it at 1080p and 4K (`EXPORT_SYNC_GPU=1` forces a GPU sync after compositing so `composeMs` is real work and not queued work). Without the object nothing is measured and nothing changes.

Measurement caveat that shapes everything below: the machine was shared with other builds (load average 50-320 while profiling), and one run of the same export varied 2-3x (the 4K export alone ran at 8.6 to 27.6 fps for identical code). Single runs are not evidence. Every before/after number below is the median of 5-6 exports of the same project in one browser page, alternating the two variants round by round so load drift hits both equally, audio off. Absolute fps from `perf-media.spec.ts` (section c, UI-driven, with audio, measured on a different day) is therefore not comparable with these.

Where the time goes (4K, source 3840x2160, `EXPORT_SYNC_GPU=1`, per frame): plan 0.05 ms, decode call 2 ms (the decoder runs asynchronously; its GPU copy lands in compose), compose about 20 ms of GPU work, capture 0.2 ms, then encode wait 16-22 ms. At 1080p compose is about 6-7 ms. A raw WebCodecs loop that encodes a pre-drawn 4K canvas (no compositor) reached 53 fps on the same loaded machine, so the hardware encoder is not the limit; compositing is. `latencyMode: "realtime"`, `hardwareAcceleration: "prefer-hardware"` and `"prefer-software"` were each tried and were no faster or much slower (software: 5-9 fps at 4K), so the encoder configuration was left alone. Audio costs 1-3 ms per frame, decode 2 ms: neither is worth touching.

What changed (all under `src/export` and `src/platform`):
- **Decode at the size the frame is drawn** (`src/export/decode-scale.ts`, `VideoFrameCache.decodeScale`): one pass over every frame plan records the largest size each source is ever drawn at relative to its own size (crop cancels out; transitions and blurred backgrounds are included), then each source is decoded at that fraction (full size when at least 95%). Previously a source was decoded at up to 2x the output edge regardless, so a 4K clip in a 1080p project was decoded at 4K.
- **Reuse decoded canvases** (`canvasPoolSize`): mediabunny's `CanvasSink` allocated a new full-size canvas per frame. Export now rotates 4 per source. A pooled frame is overwritten after 4 newer frames of the same source, so it is only used when the frame plan reads exactly one position of that source (`exclusive`); two clips of the same asset visible at once (a transition between two splits, a picture-in-picture of itself) use a second, unpooled sink. Preview is unchanged.
- `CanvasSource` became `VideoSampleSource` so capture and encode can be timed separately. Same frames, same encoder.

Results, interleaved medians, 240 frames at 30 fps, MP4 H.264, no audio:

| Project / source | Before (median, best) | After (median, best) |
|---|---|---|
| 3840x2160 / 3840x2160 | 35.5, 35.9 fps | 40.7, 42.1 fps |
| 1920x1080 / 1920x1080 | 117, 121 fps | 128, 129 fps |
| 1920x1080 / 3840x2160 source | 85.8, 89.5 fps | 111, 138 fps |

End to end through the UI (`e2e/perf-media.spec.ts`, 4K, audio on, 8 s, base and changed checkouts alternated at low machine load): before 16.8, 12.9, 18.4 fps; after 11.3, 19.6, 21.3 fps (and 21.8 in a separate run). The medians (16.8 against 19.6) point the same way as the interleaved table but three runs a side do not separate the two; the table above is the evidence.

Memory: JS heap 25-30 MB before and after (it never held frames). Peak resident memory summed over all browser processes, sampled every 300 ms: 860-880 MB before, 830-865 MB after at 4K; unchanged within noise at 1080p.

Output: same size and codec, decoded export checks (`e2e/export.spec.ts`, `cc-*`, `ctl-*`) unchanged and green. A source that is decoded below its own size is scaled by the decoder (same filter the compositor would apply when drawing it down), so pixels can differ in the last bit from decoding at full size and scaling in the compositor; no test measures that difference.

### Compositor findings (not changed: `src/render/compositor.ts` is owned elsewhere)

The remaining cost at 4K is GPU compositing, about 20 ms per frame for one plain video layer. Reading `drawMediaLayer`:
1. Every layer goes through the intermediate `layer` canvas: `clearLayer()` (a full-canvas `clearRect`), draw into `layer`, then `composite()` draws the whole `layer` onto the main canvas. For a layer with no effects, no mask, no transition darkness and `blendMode: "normal"` the result equals drawing the clip straight onto the main context with the same transform, `globalAlpha` and clip. That fast path removes two of the roughly four full-frame passes per layer (33 MB each at 4K). Not prototyped or measured; the estimate is a large share of the 20 ms.
2. `layer`, `scratch` and `scratch2` are allocated at full canvas size in the constructor (about 100 MB of GPU memory at 4K) although `scratch`/`scratch2` are only used by blur, adjust and sharpen. Allocating them on first use saves that memory for projects without those effects.
3. `drawPlan` fills the canvas black and then fills it again with the background colour; skipping the black fill when a colour is present saves one pass.
