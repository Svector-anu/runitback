# Transcript-driven editing

Engine side of M7. A transcript is word-level text with SOURCE-time seconds per asset (`src/engine/transcript/types.ts`). The engine never decodes audio: a `Transcriber` (platform layer) produces transcripts, a `TranscriptStore` keeps them, and the agent tools below read them.

## Pure functions (`src/engine/transcript/`)

| Function | Does |
| --- | --- |
| `searchTranscript({ words, query })` | Phrase or word search, ignoring case and punctuation. Returns non-overlapping matches with word indices (inclusive) and source seconds. |
| `groupSentences({ words, pauseSeconds? })` | Sentences split at `. ! ? ...` or at a pause of 0.8 s or more. |
| `wordsToCaptionChunks({ words, maxChars?, maxSeconds?, pauseSeconds? })` | Caption phrasing: breaks at sentence ends, pauses, 32 chars, 3 s. The existing `src/engine/captions` only parses SRT/ASS, so there was nothing to reuse; chunks become `CaptionCue`-shaped text clips through the same `captionElement` as `import_captions`. |
| `sourceRangesForWords({ words, ranges, padSeconds?, durationSeconds? })` | Word index ranges to padded source spans, clamped to `[0, duration]`, never padded into a neighbouring word, merged when overlapping or touching. |

## Agent tools (`createTranscriptTools({ store, transcriber? })`)

Opt-in like the reference tools: exported from `#/engine/agent`, absent from `createAgentTools()`. The app (or an eval) adds them to the registry. All times are seconds; clips are addressed by element id.

| Tool | Notes |
| --- | --- |
| `get_transcript` | `elementId`: sentences in TIMELINE seconds for the words that play in the clip (after `trimStart`, `trimEnd`, `startTime` and speed). `assetId`: the whole file in source seconds. `includeWords` adds per-word timings. |
| `search_transcript` | Same addressing. Matches carry `startWord`/`endWord` for `delete_spoken_range`. |
| `delete_spoken_range` | `phrase` (plus `occurrence` when ambiguous) or `startWord`/`endWord`. Splits the span out of the clip and deletes it in one undo step. Padding (default 0.02 s) never reaches neighbouring words; the span is snapped outward to the frame grid. `ripple:true` closes the gap on that clip's track only. |
| `add_captions_from_transcript` | Caption text clips timed on the timeline, on new text track(s) at the top (`insertElementsOnLanes`). Optional word range, `maxChars`, `maxSeconds`. |
| `transcribe_asset` | Only registered when a `transcriber` is injected. Reuses a stored transcript unless `force`. |

Word indices are positions in the stored transcript, so they stay valid after edits. After a cut the original element id keeps only the left piece; a call naming words that the clip no longer plays fails with a hint listing the other clips of that asset.

## Invariants

The deletion goes through `splitCommand` and `deleteElements` inside one transaction, so the CLAUDE.md invariants (no overlap, source mapping, one undo step, ripple limited to the affected track) are enforced by the commands, and `tests/transcript-fuzz.test.ts` checks `assertDocumentInvariants` after hundreds of random phrase and index deletions with random trims and speeds.

## Not done yet

- A real recognizer and persistent store (platform layer) and any UI.
- Clips are matched by `mediaId`; a compound or nested clip is not followed.
- Linked tracks (e.g. a separate music or caption track) are not edited when speech is rippled out; cuts affect the clip's own track.
