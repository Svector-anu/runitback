# Temporal index

Engine side of M7c. One per-asset structure that joins what is known about footage on a single SOURCE-time axis, so the agent finds moments (a phrase, the loudest shot, a silence) instead of re-analyzing. Pure code in `src/engine/temporal/`; it consumes a `MediaAnalysis` and a `Transcript` and never decodes media.

## Shape (`TemporalIndex`)

| Field | Content |
| --- | --- |
| `shots` | From `sceneCuts` (one shot when there are none; cuts closer than 50 ms are noise). Per shot: mean and peak loudness (power average of the level curve), silence ratio, speech word count, words/second, motion level. Loudness and silence are `null` without audio/analysis. |
| `tracks.speech` | Sentences from `groupSentences`, with inclusive word ranges (same indices as `get_transcript`) and the shot they sit in. |
| `tracks.silence`, `tracks.onset`, `tracks.speechLike` | Analysis silences, onsets, and energy-based speech-like ranges (used for `speaking` when there is no transcript). |
| `rhythm` | Onset count, the strongest onsets, and a beat grid (bpm, period, first beat) when the tempo estimate is trusted. |
| `sources` | Which inputs were present (`analysis`, `transcript`, `audio`), so "no speech" is distinguishable from "never transcribed". |

`tracks` is `Record<string, TemporalEvent[]>` with the core kinds typed. The face detector and the embedding matcher add `tracks.face` / `tracks.visual` (events with `label` and `score`) and nothing else changes: consumers ignore kinds they do not know, and `describeIndex` lists them.

## Queries

`findMoments(index, query)` returns `Moment { startSeconds, endSeconds, shotIndex, text?, loudnessDb, reason, matches }`. What a moment is depends on the query: sentences containing `text` (phrases may span sentences), else silences for `silent: true`, else sentences for `speaking: true`, else whole shots. `shot` and `sourceRange` clip candidates; `minLoudnessDb` / `maxLoudnessDb` test the mean level of the clipped span; `silent` / `speaking` keep (true) or drop (false) spans at least half silent / half spoken. Every given filter must hold. `sort` is `relevance` (phrase matches, then time), `time`, `loudest`, `quietest` or `longest`; ties always fall back to asset id and source time, so output is deterministic. `limit` defaults to 10.

`momentsToTimelineRanges({ moments, placement })` maps source moments through a placed clip's start, trim and speed (the same `mapSourceToTimeline` the transcript tools use), clipping to what the clip plays. `describeIndex` is bounded (12 shots, 8 sentences, 5 silences, 3000 characters).

## Agent tools (`createTemporalTools({ analysis, transcripts })`)

Opt-in like the transcript and reference tools: exported from `#/engine/agent`, absent from `createAgentTools()`. The app wires them in `src/app/agent/temporal-wiring.ts` (session and bridge) using the session's analysis provider (which analyzes on demand and caches) and the shared transcript store.

| Tool | Notes |
| --- | --- |
| `describe_footage` | Text summary plus bounded structured data for an asset, and where it sits on the timeline. Read-only. |
| `find_moments` | The query above for one `assetId` or `allAssets:true` (assets with nothing indexed are reported in `skipped`). Each result has source seconds and, for every clip of the asset that plays it, `timeline: [{ elementId, startSeconds, endSeconds }]`. Read-only. |
| `cut_to_moments` | Video moments in the order given become clips back to back on the main track, from the end of the main track (or `startSeconds`). Built with the same clip builder as `apply_cut_plan`, inserted in one transaction (one undo step); rolls back if any clip would not land where planned. |

## Visual track

`buildTemporalIndex({ ..., visual: { embeddings, query? } })` adds `tracks.visual` and `sources.visual: true` (both absent otherwise, so existing consumers and tests are unchanged). Without `query`: one unlabelled event per sampled frame, covering the span that frame stands for. With `query: { label, embedding, minScore? }`: the matching stretches, merged, with `label` and `score`. The agent tools search the embeddings directly (`find_visual_moments`, see `docs/VISUAL_SEARCH.md`); `find_moments` has no visual filter.

## Face track

`buildTemporalIndex({ ..., faces })` (a `FaceDetections`, see `docs/FACES.md`) adds `sources.faces: true`, `tracks.face` and `shot.faces` (both absent without faces, so existing consumers and tests are unchanged). `tracks.face` has one event per continuous appearance of a tracked face, labelled `face-<id>` (stable while the IoU tracker can follow the person) and scored with the mean detector confidence. `shot.faces` is `{ framesSampled, presentRatio, meanCount, largest?, dominantPosition? }` over the sampled frames inside the shot; a shot with no sampled frame says `framesSampled: 0` rather than "no faces". `describeIndex` adds a faces part to each shot line. Queries over faces are `findFaceMoments` and `faceFocusPath`, not `findMoments`.

## Not built

Any other model-backed track. `findMoments` has no `track` filter yet; add one when a producer needs to be filtered through it.

## Tests

`tests/temporal-index.test.ts` (build, every filter, ranking, describe bounds, timeline mapping), `tests/face-pure.test.ts` (the face track), `tests/temporal-tools.test.ts`, `tests/temporal-fuzz.test.ts` (random queries and cuts keep `assertDocumentInvariants`, each cut is one undo step), and the evals `find-and-cut-phrase-moments` and `loudest-shot-first`.
