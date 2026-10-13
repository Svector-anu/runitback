# Performance and long-media hardening (N1)

Measured 2026-10-10 on an Apple-silicon Mac while other builds and test runs shared the machine, so frame-gap maxima are noisy and p50/p95 are the numbers to trust. Timeline numbers come from the Vite dev server (React development build, slower than production). Reproduce with `pnpm exec playwright test perf-` and `pnpm vitest run tests/perf-`; raw JSON lands in `e2e/.artifacts/` (gitignored). Test media is generated with ffmpeg into `e2e/.artifacts/perf-media/` and never committed. ffmpeg is resolved from `FFMPEG_PATH` or `PATH` (needs libx264); without it the media specs skip with a reason. CI installs ffmpeg with apt. The media specs run in the installed Chrome (`channel: "chrome"`) because Playwright's bundled Chromium has no H.264 decoder.

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

Remaining: the 4K preview canvas itself is still allocated at project size (3 full-size canvases in `Compositor`) because preview resolution is owned by `render/compositor.ts` and `ui/preview`, outside this work. Export throughput at 4K (about 12 fps) is bounded by compositing and encoding, not by decode. Random-seek latency is H.264 GOP cost.

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
- Firefox and Safari.
