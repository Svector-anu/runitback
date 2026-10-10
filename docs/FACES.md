# Faces

Roadmap N3. Face detections (`docs/VISUAL_SEARCH.md` covers indexing: MediaPipe BlazeFace on sampled frames, stored in IndexedDB by `IdbFaceStore`) become a first-class part of the temporal index and the agent. Everything here is pure engine code in `src/engine/face/` plus tools in `src/engine/agent/tools-face.ts`; nothing decodes media or runs a model.

## Data

`FaceDetections { assetId, model, durationSeconds, frames: [{ t, boxes }] }`: boxes are fractions of the frame, times are SOURCE seconds. Frames are sampled about every 2 s and at shot starts, so every statement below is as precise as that sampling: a frame stands for the stretch halfway to its neighbours, never across a scene cut.

## Pure helpers (`#/engine/face`)

| Helper | What it does |
| --- | --- |
| `trackFaces` | Greedy IoU matching between frames (min IoU 0.2, one missed frame bridged), stable track ids starting at 1, exponential smoothing of the boxes (weight 0.6 for the new box). |
| `faceShotStats` | Per span: sampled frames, share with a face, mean count, the biggest face, dominant third (area weighted). |
| `findFaceMoments` | Presence or absence stretches. Filters: `minFaces`/`maxFaces` (qualifying faces per frame), `minSize` (face height as a fraction of frame height), `region` (left/center/right third by face centre), `minDurationSeconds`, `sourceRange`; `sort: "longest"` + `limit: 1` is the longest continuous presence. |
| `faceFocusPath` | Where a crop of a target shape (e.g. 9:16 from 16:9) should look per sampled frame: the followed face is sticky (another takes over only if 1.3x bigger), frames without a face hold the last position for 3 s then ease to the middle, moves under a 5%-of-frame dead zone are ignored, bigger ones are eased, and a subject who would land outside the current window is jumped to (a speaker change). Zoom 1 is the widest crop of the target shape; `zoom: "auto"` goes in on small faces up to 3x. The window never leaves the frame. |
| `focusAt`, `focusTransform` | Linear lookup in the path, and the element transform (position px from centre, uniform scale) that puts a focus point in the middle of the canvas, matching how `computeVisualTransform` draws a clip (contained, then scaled). |

## Agent tools (`createFaceTools({ faces, indexer?, model?, analysis? })`)

Opt-in, like the temporal and visual tools: not in `createAgentTools()`. App wiring is `src/app/agent/face-wiring.ts`.

| Tool | Notes |
| --- | --- |
| `find_face_moments` | Read-only. One `assetId` or `allAssets:true` (videos without face data are listed in `skipped`). Results in source seconds plus, for every clip of the asset that plays them, timeline seconds via `momentsToTimelineRanges` (speed, trim, start), so they feed `cut_to_moments` directly. |
| `describe_faces` | Read-only. Per-shot summary; shots come from the scene cuts when an analysis provider is given, else the video is one shot (the summary says so). |
| `reframe_to_faces` | Writes `transform.positionX/Y` and `transform.scaleX/Y` keyframes on a video clip over the part of the source it plays (both ends included, at most 200 keyframes). Existing position/scale animation on the clip is replaced and scale becomes uniform. One undo step. Set the canvas first (`set_project canvasPreset 9:16`; note the first clip on an empty project sets the canvas to its own shape). |
| `index_faces` | Only when an `indexer` is supplied: detects and saves, reuses usable data unless `force`. The app wiring does not pass one yet. |

Failures are plain `ToolError`s with a next step: no face data, data from another model (stale), a clip that plays a stretch without any detected face, a video with no face anywhere, images, unknown ids.

## Limits to know

- Sampling is sparse, so a quick head turn between samples is invisible and the path interpolates linearly between samples.
- Tracking is overlap only: two people crossing can swap ids. `subject: "largest"` is sticky to limit flicker, not an identity model.
- The crop uses the face centre, not the body, and does not leave headroom.
- Non-uniform scale, rotation and masks on the clip are not considered.

## Tests and eval

`tests/face-pure.test.ts` (tracking, stats, queries, focus path, transform, temporal index), `tests/face-tools.test.ts` (tools, including speed and trims), `tests/face-fuzz.test.ts` (random calls keep `assertDocumentInvariants`, each reframe is one undo step), and the eval `reframe-to-speaker` (`docs/EVALS.md`).
