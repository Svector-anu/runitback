# Visual search

Find footage by what it looks like ("a dog", "a whiteboard", "someone laughing") without sending a frame anywhere. Part of M7c (the temporal index): the embeddings become a `tracks.visual` track and the agent gets `index_visuals` and `find_visual_moments`. The model runtime is `@huggingface/transformers`, already a dependency (see `docs/research/07-oss-reuse-audit.md`); nothing new was added to `package.json`.

## Model

| | |
| --- | --- |
| Model | `Xenova/clip-vit-base-patch32` (OpenAI CLIP ViT-B/32, ONNX export for transformers.js), 512-d joint image and text space |
| Weights used | int8 (`dtype: "q8"`): `onnx/vision_model_quantized.onnx` 89 117 001 B (89 MB), `onnx/text_model_quantized.onnx` 64 504 507 B (65 MB), `tokenizer.json` 2 224 119 B (2 MB), small configs. About **156 MB** in total, downloaded once and cached by transformers.js in Cache Storage (`transformers-cache`). Indexing needs only the image half, searching only the text half; consent covers both. |
| Licence | **MIT.** The weights are OpenAI's CLIP (`github.com/openai/CLIP/LICENSE`, MIT, verified). The Hugging Face repos `openai/clip-vit-base-patch32` and `Xenova/clip-vit-base-patch32` declare no licence in their metadata, so the MIT grant rests on the upstream repository, not on the Hub card. |
| Backend | WASM (ONNX Runtime Web, self-hosted exactly as the Whisper worker does: `onnxruntime-web/...asyncify.{mjs,wasm}?url`, no CDN). WebGPU is not used: the int8 weights were only run on the WASM backend (the Whisper worker's WebGPU path uses fp32/q8 mixes; not evaluated for CLIP). |

Considered and rejected (sizes from the Hub API, int8 variants): SigLIP-base-patch16-224 (`Xenova/siglip-base-patch16-224`, Apache-2.0 declared, ~205 MB: licence is explicit, quality likely better, but about 31% larger; not tried), MobileCLIP s0/s1/b (`license: other`, Apple's research licence, not permissive). Swapping the model is one constant (`DEFAULT_CLIP_MODEL`) plus the file names in `isClipModelCached`; stored embeddings carry their model id and are ignored (tool hint: re-run `index_visuals` with `force:true`) when it differs.

## Pipeline

```
index_visuals / Index visuals button
  app/visual-service   consent gate (prefs only), per-asset progress + abort
  platform/visual/indexer
    planFrameTimes     (engine, pure) one frame per shot midpoint + one every 2 s, capped at 300 frames
    frame-source       VideoFrameCache (the preview's decoder) -> OffscreenCanvas, shortest edge <= 224 -> RGBA
    worker-backend     module worker clip-worker.ts, batches of 8 frames, transferable buffers
    clip-engine        loads CLIPVisionModelWithProjection + AutoProcessor lazily, L2-normalises rows
  IdbVisualStore       IndexedDB `runitback-visual`, store `embeddings`, key = assetId

find_visual_moments "a dog"
  searcher (worker kept for 30 s idle) -> text embedding (CLIPTextModelWithProjection + AutoTokenizer)
  engine/visual  rankByText (cosine = dot, rows are unit length) -> frames above minScore and within a margin of the best
                 -> frameSpans (halfway to neighbours, clipped to the asset and to the frame's own shot)
                 -> mergeHitsIntoMoments (touching matching frames become one moment)
  engine/agent/tools-visual  source seconds + momentsToTimelineRanges for every clip of the asset
```

Shot midpoints come from the asset's scene cuts (the analysis, computed on demand and cached, the same one `describe_footage` uses); without an analysis only the 2 s grid is sampled. The cuts used are stored with the embeddings, so searching never triggers analysis. The centre-crop CLIP applies to non-square frames (shortest edge scaled to 224, centre 224x224 kept) means things at the far left or right of a 16:9 frame are not seen.

## Stored record (`VisualEmbeddings`)

`{ version, assetId, model, dimensions, durationSeconds, cuts[], times[], vectors: Float32Array(times.length * dimensions) }`, rows normalised. `version` is `VISUAL_INDEX_VERSION` (bump to invalidate every stored index if sampling or preprocessing changes). A record whose `model` differs from the searcher's, whose `version` differs, or whose vector length does not match `times * dimensions` is treated as stale: `find_visual_moments` skips it (`skipped: [{ assetId, reason: "stale-index" }]`) and `index_visuals` rebuilds it.

## Scores and thresholds

CLIP cosine similarities are small and relative. Measured with the real model (4 natural images, 8 queries, plus solid red/blue frames): true matches 0.24 to 0.30 (tiger 0.302, football match 0.263, dog 0.242, city street 0.243), unrelated pairs 0.17 to 0.22. So `DEFAULT_MIN_SCORE = 0.22`, and `DEFAULT_WITHIN_OF_BEST = 0.04`: a frame must also be within 0.04 of the best frame for the query (across all searched assets), otherwise every frame above the floor would be a "match". These two numbers come from that small sample and are not tuned on real footage; both are overridable per call (`minScore`), and results always include the score so the agent can judge, and the tool description tells it to verify weak ones with `render_frame`. Text-only queries about abstract things ("someone laughing") score lower than object queries; expect fewer, weaker hits.

### Confidence

`find_visual_moments` results carry `confidence: 'low' | 'ok'`, `margin` (best score minus the 5th best score over all searched frames, null with fewer than five frames) and, when low, a `hint` (also in the summary as `LOW CONFIDENCE`). Rule (`searchConfidence`, `tools-visual.ts`): low when the best score is below 0.24 (the bottom of the measured true-match range); or when the margin is below 0.02 and the best score is below 0.28 (nothing singles out a hit, and the score is not strong enough to be a real match among many look-alike frames). Otherwise ok. These numbers come from the same small sample as the thresholds above and are not tuned on real footage. On low, the agent is told to `render_frame` at the top moment's midpoint and rephrase and search again; the system prompt also requires that midpoint check after placing any moment.

## Agent tools (`createVisualTools({ store, searcher, indexer? })`)

Opt-in like the transcript and temporal tools: exported from `#/engine/agent`, absent from `createAgentTools()`, wired in `src/app/agent/visual-wiring.ts` for the in-app session and the MCP bridge.

| Tool | Notes |
| --- | --- |
| `index_visuals` `{ assetId, force? }` | Registered only when an indexer is supplied. Video only. Reuses a current-model index unless `force`. Consent not given: fails with "Ask the user to press Index visuals..." and the hint "Do not retry until the user confirms the download" (same convention as `transcribe_asset`). Read-only (does not touch the project). |
| `find_visual_moments` `{ query, assetId \| allAssets, limit?, minScore?, sort? }` | Moments with source seconds, `score`, merged `frames`, and `timeline: [{ elementId, startSeconds, endSeconds }]` for every clip of the asset that plays them. `sort`: `relevance` (default) or `time`. `allAssets` skips unindexed or stale videos and lists them in `skipped`. No match returns an empty list and the best similarity seen. Read-only. |

The results are shaped for `cut_to_moments`. `find_moments` was deliberately not extended with a `visualText` filter: its moments are sentences, silences and shots measured from the analysis, while visual moments are model-scored spans with their own score semantics; mixing them in one filter would hide that.

## Consent and privacy

`app/visual-service.ts` mirrors the transcribe service on a shared `ModelConsent` (`app/model-consent.ts`, also used by `TranscribeService`; behaviour and tests unchanged). The Index visuals button (top-left of a video tile, and the asset context menu) asks first with model name, ~156 MB and "stays on this device"; consent is stored in prefs only (`visual-consent-model` = model id). "Already cached" requires both halves of the model in Cache Storage, so indexing first and searching later can never start an unapproved download. The agent's tools go through `gatedIndexer` / `gatedSearcher` and cannot download either. Abort terminates the worker. After 30 s without a query the search worker is terminated too (the text model is ~65 MB in memory).

## Tests and verification

| What | Where |
| --- | --- |
| Ranking, spans, merging, sampling plan, tracks.visual | `tests/visual-pure.test.ts` |
| IndexedDB store (fake-indexeddb) | `tests/visual-store.test.ts` |
| Consent gate, service, tools refuse without consent | `tests/visual-consent.test.ts` |
| Indexer / searcher / engine / load progress / cache check with fake backends | `tests/visual-platform.test.ts` |
| Tool behaviour with a fake searcher and embeddings; compose with `cut_to_moments` | `tests/visual-tools.test.ts`, `tests/visual-harness.ts` |
| Fuzz: random searches, indexes and cuts keep `assertDocumentInvariants`, each cut one undo step | `tests/visual-fuzz.test.ts` |
| Consent dialog, progress, cancel, persisted record, agent tool call (double via `window.__visual`); real frame decode | `e2e/visual.spec.ts` |
| Real model on solid red/blue frames (opt-in, downloads ~156 MB: `REAL_CLIP=1 pnpm e2e e2e/visual-real.spec.ts`) | `e2e/visual-real.spec.ts` |
| Eval `find-visual-moment` (injected embeddings, oracle, `first-only`, `wrong-subject`, `lazy`, `overreach`) | `evals/cases.ts`, `evals/visual.ts`, `docs/EVALS.md` |

No test downloads a model except the opt-in one.

## Not built

Faces (MediaPipe, the other adopt-for-next item in the audit), text-to-image re-ranking with more than one prompt template, searching by example image, using the index to pick thumbnails, and cleaning embeddings when an asset is removed (transcripts have the same gap).

## Measured on real footage (2026-10-08)

Real CLIP (`Xenova/clip-vit-base-patch32`, int8) through the real worker and decoder, two local screen-capture / product-promo videos (a 201 s screen recording of a 3D village then terminal windows, and an 83 s app promo). Ground-truth ranges were checked by viewing frames. Reproduce with `FOOTAGE_CASES=<json> pnpm exec playwright test e2e/visual-footage.spec.ts` (see the spec header for the JSON shape). Frames are sampled every 2 s, so a short target has only 1-2 frames.

| Query | Top hit inside truth? | Notes |
|---|---|---|
| 3D village with red-roofed houses | yes (top 3 all inside, AUC 0.97) | scene-level content works |
| terminal with white text on black | yes (top 3 all inside, AUC 0.98) | |
| credit card payment, Allow / Deny | yes (top 2 inside) | |
| confetti | yes (top 1) | other frames within 0.03 |
| blue circles with check marks | yes (top 1) | only 1 of 2 truth frames in top 3 |
| phone form with name/email fields | no (found at rank 3) | a frame at 75 s outranks it |
| browser showing JSON text | no | reading text is not what CLIP does |
| black screen / black frame | no | absence queries fail; use luminance from analysis instead |

Summary: top-1 landed inside the checked range for 5 of 9 queries. Scores for real hits were 0.25-0.31 against 0.18-0.24 background, but false positives reached 0.28, so `DEFAULT_MIN_SCORE = 0.22` removes almost nothing on UI footage and a score alone cannot separate a hit from a miss. Conclusions: CLIP B/32 is useful for scene-level queries on natural or screen-recorded content, weak for text-in-UI and for "nothing here" queries. Next experiments, in order of cost: SigLIP-base (Apache-2.0, about 205 MB), combining visual hits with transcript and the black-frame/silence tracks in `find_moments`. Prompt templates were tried next (below) and dropped from this list — they did not help.

## Prompt templates (tried 2026-10-09, not adopted)

Tried wrapping the text query before it reaches `CLIPTextModelWithProjection` (the call site is `createClipSearcher`'s `embedText` in `src/platform/visual/searcher.ts`, which is the only place a bare query turns into a text embedding) to see if a caption-shaped prompt scores better than a bare query, per CLIP's own training distribution.

**Harness substitution.** The two local screen-capture videos used for the "Measured on real footage" table above are local files from whoever ran that analysis and are not present in this environment or committed to the repo (confirmed: no `.mp4`/`.webm` fixtures exist in the repo, and `e2e/media.ts` only generates synthetic video in-browser). `FOOTAGE_CASES` could not be reproduced, so this attempt fell back to the repo's other opt-in real-model harness, `e2e/visual-real.spec.ts`: solid red and solid blue 1-second blocks, indexed and scored for the queries `red`, `blue`, `a red screen`, `a blue screen`. This is a materially different (and weaker) test than the original 9-query natural/screen-content harness — it only measures whether red frames score the query "red" above blue frames, not top-1-inside-truth over descriptive scenes — so its result bounds confidence in either direction but is not the number this order was scoped to produce.

Three templates tried, each run against the real model (`Xenova/clip-vit-base-patch32`, `REAL_CLIP=1`), reporting the margin (mean score on the correct-color frames minus mean score on the wrong-color frames) per query:

| Query | No template (baseline) | `a photo of {query}` | `a screenshot of {query}` | `an image of {query}` |
|---|---|---|---|---|
| red | 0.040 | 0.026 | 0.003 | 0.020 |
| blue | 0.053 | 0.046 | 0.050 | 0.047 |
| a red screen | 0.011 | 0.006 | **-0.005 (flips)** | 0.005 |
| a blue screen | 0.060 | 0.058 | 0.058 | 0.059 |

All three templates reduced the margin on every one of the four queries versus the bare query, and `a screenshot of {query}` flipped the sign for "a red screen" — on a solid red screen, "a screenshot of a red screen" scored the blue frames higher, a real regression, not just a smaller margin. No template beat the baseline on this proxy.

**Why this may not generalise**: the proxy's frames are uniform-color screens, about as context-free as an image gets; "a photo of red" or "a screenshot of red" describes a different thing (a physical object, a captured UI) than a solid color fill, so the mismatch may be specific to this degenerate test case rather than to templates in general. The original 9-query baseline this order was meant to beat is scene-level content (a 3D village, a terminal, a credit card dialog) where a caption-shaped prompt could plausibly still help, per CLIP's training distribution — that remains untested.

**Conclusion (per this order's ACCEPTANCE criterion for a non-improving result): no template is shipped, the default stays an unwrapped bare query, and `src/platform/visual/searcher.ts` is unchanged.** Re-attempting this with the actual 9-query real-footage harness (two representative local videos, supplied via `FOOTAGE_CASES`) rather than the solid-color proxy is the right next step before concluding templates don't help this repo's real use case; absent that, the next cheapest unexplored experiment from the list above is SigLIP-base.

### Prompt templates on the real-footage set (2026-10-09)

The experiment above used solid-colour frames because the footage was not available to the cloud run. The same templates were then run locally on the 9-query real-footage set (`QUERY_TEMPLATE` env var on `e2e/visual-footage.spec.ts`):

| Template | Top-1 inside truth | Mean AUC |
|---|---|---|
| none (bare query) | 5 / 9 | 0.66 |
| `a photo of {query}` | 5 / 9 | 0.66 |
| `a screenshot of {query}` | 5 / 9 | 0.69 |

No template changes which queries succeed. `a screenshot of` lifts the phone-form query's AUC from 0.83 to 0.96 and slightly lowers "JSON text", but the gain is within noise for 9 queries, so the bare query stays the default. The conclusion matches the colour experiment: wording is not the bottleneck, model capacity and the nature of UI footage are. Next candidate: SigLIP-base.
