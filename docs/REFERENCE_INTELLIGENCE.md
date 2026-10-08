# Reference intelligence (M6 core)

Turns the measured analysis of one or more reference videos into a reusable **style profile**, compares a timeline against it, and plans a rough cut of new footage whose pacing follows it. Engine code lives in `src/engine/reference/`, agent tools in `src/engine/agent/tools-reference.ts`. Everything is deterministic arithmetic over `MediaAnalysis` (`src/engine/analysis`); no media is decoded here.

## What is measured

| Area | Fields |
|---|---|
| Shot length | count, mean, median, p10, p90, 21 quantiles (0%..100% in 5% steps), histogram over the pacing bins (0-1, 1-2, 2-4, 4-8, 8-16, 16+ s), cuts per minute, rhythm class (`fast-montage` median < 1.5 s, `steady` <= 4 s, `slow-burn`) |
| Opening | `hookSeconds`: mean length of each source's first shot (how long the opening holds before the first cut) |
| Cut density | cuts per minute in the first, middle and last third, and a trend (`accelerating`, `steady`, `decelerating`; 25% threshold) |
| Beat lock | share of cuts within a tolerance (default 80 ms) of a beat, plus tempo (bpm, confidence). Beats are a regular grid at the detected tempo (phase from the onsets) when tempo confidence >= 0.2, otherwise the strong onsets |
| Audio | loudness shape of the level curve (`flat`, `rising`, `falling`, `peaked`, `dipped`, 3 dB steps between thirds), silence ratio, dynamic range (p95 - p10 of the level curve, dB), integrated loudness approximation |
| Colour | palette (up to 5 quantised hex colours, rank-weighted), contrast (spread of shot brightness), mean saturation, mean brightness, all from per-shot dominant colours |
| Text | clips per minute, mean duration, coverage; only when text clips are passed to `buildStyleProfile` (`options.textClips`, e.g. text elements of a reference project) |

Several references are pooled: every shot counts once, per-source quantities (beat lock, density) use each source's own audio and duration.

## What is deliberately NOT claimed

- **No semantic understanding.** The system never knows what is in a shot, who is speaking, what a caption says, whether footage is a good take, or whether two shots belong together. It sees cut times, onset/tempo estimates, levels, silence and dominant colours.
- Beat lock is a timing statistic, not musical analysis. Tempo can be wrong by a factor of two; dense onsets inflate it.
- Rhythm classes and colour words (dark, vivid, ...) are fixed thresholds, not taste.
- The planner chooses footage by position only (forward through each source, never reused). It does not pick the "best" parts.
- Colour and contrast come from at most three dominant colours per shot; they say nothing about grading or lighting.

## Agent workflow

1. `list_assets`, then make sure reference and footage assets are analysed (platform tool; the engine tools only read finished analyses and say so if one is missing).
2. `save_style_profile {name, assetIds}` -> `profileId` and a compact description (<= 250 tokens). `get_style_profile` for full numbers, `list_style_profiles` to reuse earlier ones.
3. `plan_cuts_to_style {profileId, assetIds, targetDuration?, seed?, beatAssetId?}` returns a shot list. It does **not** edit. Read the summary and notes (target capped by footage length, "reference cuts to the beat but no beats supplied", ...). Try other seeds for alternative arrangements.
4. `apply_cut_plan {plan}` builds the cut on the main track: clips placed back to back from `plan.startSeconds` (default 0), trimmed to in/out, nothing rippled or moved, one undo step. Fails without changes if the main track is occupied or a shot exceeds its source.
5. `compare_to_style {profileId}` analyses the current timeline and lists deltas such as `average shot 4.2s vs target 1.8s (+133%)` or `only 12% of cuts within 80ms of a beat vs 71%`, each with `withinTolerance`, and a `matchScore`. Use it before and after edits to verify the result numerically. To get beat lock, put an analysed music clip on the timeline.

Tool availability: `createAgentTools({ reference: { store, provider } })`. Without `reference` the six tools are not registered and the registry is unchanged.

## Planner

`planCutsToProfile({sourceRanges, profile, beats?, minShot, maxShot, seed, targetDuration?})`:

1. Target length = `targetDuration` capped at the usable footage (ranges shorter than `minShot` are ignored).
2. Shot lengths are drawn by stratified inverse-CDF sampling from `profile.shots.quantiles`: one jittered draw per probability stratum, shuffled with a seeded PRNG (mulberry32), clamped to `[minShot, maxShot]`. Stratification keeps the empirical distribution close to the target even for short outputs.
3. Lengths accumulate to the target; the last shot absorbs the remainder (never leaving a tail shorter than `minShot`).
4. If `beatLock.score >= 0.5` and beats are given, each cut moves to the nearest beat within 30% of the shot length, subject to min/max and to leaving a legal remainder. Cut points are relative to timeline 0.
5. Footage is allocated forward from each source's cursor, choosing among sources that still fit (seeded); a shot never crosses a source's end or reuses material. If fragmentation leaves no fit, the shot shrinks to the largest remainder, or the plan ends early with a note.

Measured fidelity on synthetic references (120 shots): Kolmogorov-Smirnov distance to the target distribution about 0.01-0.02 for 100-240 s outputs and about 0.05 for 40 s outputs; on a beat-locked reference 158 of 160 cuts snapped, two-sample KS 0.02, mean shot length within 5%.

## Known limits

- Analyses must exist; the engine cannot produce them. The provider returning `undefined` is a hard error with a hint.
- Compare uses all video-kind clips (overlays included) for shot lengths; cuts per minute is measured over the video span, not over longer music.
- `hookSeconds` comes from a single shot per source and is noisy; treat the delta as a hint.
- Beat snapping assumes beat times are on the timeline and the plan starts at 0. Applying with a non-zero `startSeconds` keeps the shot lengths but not the beat alignment.
- Shots are rounded to the frame grid on apply, so cuts can move by up to half a frame.
- Profile ids derive from the name (`fast-montage`, `fast-montage-2`); persistence is the store's job.
