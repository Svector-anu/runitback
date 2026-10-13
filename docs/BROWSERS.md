# Browser support

Measured 2026-10-13 on an Apple-silicon Mac (macOS, headless). Versions tested:

| Browser | Version | How it was run |
|---|---|---|
| Chrome stable | 155.0.8059.40 | Playwright `channel: "chrome"` |
| Firefox | 155.0 | Playwright's Firefox build |
| Safari engine | WebKit 26.6 | Playwright's WebKit build (not the Safari app) |

Reproduce: `pnpm exec playwright install firefox webkit`, then `PLAYWRIGHT_PROJECT=chrome|firefox|webkit pnpm exec playwright test`. That selects only `e2e/browser-*.spec.ts` (the `@cross` smoke subset) in that browser; the default `pnpm e2e` is unchanged and skips them. Matrix lines (`[matrix] ...`) are printed to stdout.

## Support table

| Browser | Level | Reason |
|---|---|---|
| Chrome / Edge, desktop, current | Supported | Everything works. MP4 (H.264/AAC) and WebM (VP9/Opus) export. This is the browser the full e2e suite and the perf work run in. |
| Firefox desktop, 155 | Supported, one difference | The smoke subset passes. Firefox has no AAC encoder, so an MP4 export carries Opus audio (plays in current players; WebM is the safer choice for sharing). It cannot decode HEVC, so HEVC imports are refused with "uses a codec this browser cannot decode". |
| Safari / WebKit 26.6 | Partial | The smoke subset passes (import, edit, play, split, undo, MP4 and WebM export, agent panel). Canvas filters are accepted but not drawn, so blur, colour adjustments and sharpen do not show in the preview or the export. The editor says so in a notice. |
| Safari private windows, older Safari | Partial, untested for real | Written against WebKit's behaviour with non-persistent storage (below): media falls back to IndexedDB, exports to an in-memory buffer. Not run in the Safari app. |
| Mobile browsers | Limited | Out of scope here; see the in-app notice and `e2e/mobile-editor.spec.ts`. |

## Feature matrix

`yes` = present and behaving, `no` = absent or ineffective. The raw API probe ran in Playwright's bundled Chromium 153; Chrome stable 155 was checked through the smoke subset (H.264/AAC MP4 export, 4K H.264 and VP9 encode, `ctx.filter`), and its HEVC decode was not measured (bundled Chromium has none).

| Feature | Chromium 153 (probe) | Firefox 155 | WebKit 26.6 | Used for |
|---|---|---|---|---|
| WebCodecs `VideoDecoder` / `VideoEncoder` | yes | yes | yes | import, preview, export |
| H.264 / VP9 / VP8 / AV1 encode, 4K (`isConfigSupported`) | yes / yes / yes / yes | yes / yes / yes / yes | yes / yes / yes / yes | export |
| `AudioEncoder` AAC / Opus | yes / yes | **no** / yes | yes / yes | export audio |
| H.264 / VP9 / AV1 decode | yes | yes | yes | import |
| HEVC decode | no (stable not measured) | no | yes | import |
| `OffscreenCanvas` 2D | yes | yes | yes | compositor, thumbnails |
| `ctx.filter` (pixels actually change) | yes | yes | **no** (assignment accepted, ignored, on both canvas kinds) | blur, adjust, sharpen |
| `roundRect` (context and `Path2D`) | yes | yes | yes | text backgrounds, shapes |
| OPFS `getDirectory` | yes | yes | yes | media bytes, export target |
| OPFS `createWritable` | yes | yes | yes in a persistent profile, **fails** in a non-persistent one (`UnknownError`) | media bytes, export target |
| IndexedDB `Blob` values | yes | yes | yes in a persistent profile, **fails** in a non-persistent one; `ArrayBuffer` values work | media fallback |
| Web Locks | yes | yes | yes | one tab per project |
| `BroadcastChannel`, `structuredClone` | yes | yes | yes | |
| Module workers | yes | yes | yes | Whisper, CLIP and face workers (loading checked, models not run) |
| `AudioContext`, `OfflineAudioContext` | yes | yes | yes | playback, export mix |
| `showSaveFilePicker` | yes | no | no | not used (export downloads a Blob) |

## Smoke results (`e2e/browser-smoke.spec.ts`, 7 tests, all `@cross`)

Landing page loads; import, place, play, split and undo; WebM export decoded back (duration, 320x180, audio present); MP4 export decoded back; agent panel turn with the scripted model and one undo; notice and precise import error when `VideoDecoder` is removed; capability report has no blockers and its `canvasFilter` flag matches what the canvas really draws.

| | Chrome 155 | Firefox 155 | WebKit 26.6 |
|---|---|---|---|
| Passed | 7 / 7 | 7 / 7 | 7 / 7 |
| MP4 export tracks | avc + aac | avc + **opus** | avc + aac |
| `detectCapabilities` issues | none | none | `canvasFilter` |

## What breaks, and what the app does about it

- **Safari, canvas filters.** Detected by drawing a blurred square and reading pixels (`src/platform/capabilities.ts`), because `ctx.filter` reads back what was assigned. The editor notice says filters will not show. No fallback: blur, adjust and sharpen live in `src/render/compositor.ts`, which this work does not own. A fallback would be an alternative implementation there (for example downscale and upscale for blur, `getImageData` matrices for adjust), selected when `detectCapabilities().canvasFilter` is false.
- **Safari, non-persistent storage (private windows).** Writing media to OPFS threw `UnknownError` and writing a `Blob` to IndexedDB aborted the transaction, so every import failed with "Could not import ...: IndexedDB transaction failed". `IdbAssetRepository.save` now tries OPFS, then an IndexedDB `Blob`, then an IndexedDB `ArrayBuffer`; reads and deletes look in all three. A full disk (`QuotaExceededError`) is still reported, not hidden. Covered by `tests/platform-storage.test.ts`. The export target already fell back to an in-memory buffer.
- **No WebCodecs at all.** Import fails with "Your browser can't decode video: it does not support WebCodecs ..." (`probeVideo`), and export fails before it starts with the encode equivalent. The editor shows the same sentence once, as a dismissible notice.
- **No encoder for the chosen container or size.** The export error now says what to change: "Your browser can't encode MP4 video at 3840x2160. Choose WebM in the export settings", "Lower the project resolution ...", or "open RunItBack in a current Chrome, Edge, Safari or Firefox".
- **Firefox, AAC.** `pickAudioCodec` already falls back to Opus in MP4. Nothing to fix; documented above.

## Detection

`detectCapabilities()` in `src/platform/capabilities.ts` is pure (takes an environment object, so it is unit-tested in Node by `tests/capabilities.test.ts`). `reportCapabilities()` turns it into worded issues, each with a scope (`editor`, `import`, `export`) and a severity (`blocker`, `degraded`). `probeEncoders()` is the asynchronous half: it asks `VideoEncoder.isConfigSupported` which containers work at a size. `BrowserNotice` (`src/ui/editor/BrowserNotice.tsx`) shows the first issue once; dismissal is remembered per set of missing features.

## Not verified

- The Safari application itself, iOS Safari, Safari private windows, and Safari earlier than the 26.6 engine tested.
- Windows and Linux builds of any browser; Firefox ESR; Edge (assumed equal to Chrome).
- Hardware encoder differences (the 4K encode numbers in `docs/PERFORMANCE.md` are Apple-silicon Chrome).
- Transcription, CLIP search and face detection on Firefox and WebKit: workers load, but models were not downloaded or run.
- The full e2e suite on Firefox and WebKit; only the smoke subset runs there.
