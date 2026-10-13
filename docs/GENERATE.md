# Generate with your Surplus key

Status: implemented, bring-your-own-key. Nothing here is paid for by RunItBack.

The Generate tab (left rail, below Captions) creates images, video clips, music and voice-overs with [Surplus Intelligence](https://www.surplusintelligence.ai), an OpenAI-compatible gateway. The user pastes their own `inf_` buyer key and pays Surplus directly. The agent can use the same key through `generate_media`.

## What leaves the device

Only the prompt (for speech, the text to speak), the model id and the options, plus the key in the `Authorization` header, go to `https://api.surplusintelligence.ai` and on to the model provider Surplus routes to. No project media, timeline or transcript is sent. The panel says so. CSP and residual risk: `docs/SECURITY.md`. The key lives in `runitback:surplus-api-key` via `platform/prefs.ts` only; Forget key clears it. Nothing contacts Surplus until a key is saved.

## Flow

1. **Catalog.** `GET /v1/models` (public, cached 10 minutes in `GenerateService`). Modality is `architecture.output_modalities`: `image`, `video`, `music`, `audio` (speech). Models that need a source file are hidden because the panel collects only text: image edit (`image_edit`/`image-to-image`), image-to-video-only, upscalers and background removers, music-route TTS and lyrics-required music, and `legacy` aliases. Options come from the catalog (`sizes`, `aspect_ratios`, `durations_seconds`, `voices`). Models sort cheapest first; the default is the cheapest priced model; the user's pick is remembered per kind.
2. **Price hints.** `pricing.image` with `pricing.media_unit` (`image`, `job`, `megapixel`, `1K characters`) is shown as, for example, "$0.01 per image". Models with no stated price (token-metered image models, some video) say "Price not listed in the catalog". Job prices are for the model's default length, so the estimate is labelled "About". For video and music the submit response carries the gateway's own quote (`estimated_cost_usdc`) and ceiling (`max_cost_usdc`), which the panel shows while the job runs. The final charge is what Surplus settles.
3. **Image.** `POST /v1/images/generations` with `response_format: "b64_json"`, `size`, `n: 1`, 120 s timeout.
4. **Speech.** `POST /v1/audio/speech` (`model`, `input`, `voice`, `response_format: "mp3"`), audio bytes back, 60 s timeout.
5. **Video and music (async).** `POST /v1/video/generations` or `/v1/music/generations` with an `Idempotency-Key`; the 202 carries `id`, `poll_url`, `job_token` and the quote. Polling `GET poll_url` with the key and `X-Job-Token`, 2 s backing off x1.5 to 10 s, until `succeeded`, `failed`, `canceled` or `expired`; 4 consecutive transient poll failures give up. Overall wait: 30 min (video) or 15 min (music), or the job's `expires_at`, whichever is sooner; on timeout the job is cancelled. Cancel in the UI sends `DELETE` on the job (best effort). The result is downloaded from `results[0].url` with the job token (redirects followed; credentials are not sent to a non-Surplus host). Artifacts expire about 3 hours after the job ends.
6. **Import.** The file goes through `AppServices.importFiles` (probe, quota check, `AssetRepository.save`, `registerAsset`) with a `generated` provenance record on the asset (`{ prompt, model, provider, createdAt }`, an additive optional field on `MediaAssetInfo`; no schema bump). The Assets panel shows a "Generated" tag with the model and prompt as its tooltip.

## Errors

| Situation | Message to the user |
|---|---|
| 401/403 | key rejected |
| 402, or 400 mentioning credit/balance/allowance | "Not enough Surplus credit"; nothing was charged |
| 400 other | Surplus's own message (key redacted) |
| 404 / `no_sellers_for_model` | pick another model |
| 429 | rate limited, with `Retry-After` |
| 5xx / 503 | unavailable, retry |
| network / ad blocker | could not reach Surplus |
| job `failed` / `expired` | the gateway's message and "You were not charged", using `error.retryable` |
| timeout | job cancelled; nothing added |
| download 404 | artifact expired, generate again |
| import failure after a billed generation | says it was generated and billed but not added |

Test key calls `GET /v1/buyer/me` (authenticated, free). `/v1/models` is public and accepts any key, so it cannot validate one.

## Agent tool

`generate_media { kind, prompt, model? }` exists only when a Surplus key is saved **and Ask before editing is on**. It is `destructive` in the plan-scope sense, so without an approved plan the loop refuses it, and after approval it runs only if the plan's steps list it. Further limits, all in `tools-generate.ts` and `generate-wiring.ts`: at most 3 generations per request, an estimated price above $1.00 is refused (the user presses Generate themselves), and an unknown model id returns the known ids. The result reports the asset id, model and charge; the agent places it with `insert_media`. It is not registered on the MCP bridge: an external agent has no plan gate.

## Hosted credits (not built)

The panel and the landing FAQ show "Hosted credits, sponsored by us: coming soon. Want free generations? Bring your own Surplus key for now." with a disabled button. There is no backend, no proxy and no pricing.

## Honest limits

- No real generation call was made while building this (the only key available is not scoped to media models). Request and response shapes follow the published API reference and one live `GET /v1/models`; image, speech, job polling, artifact download and cost fields are covered by fake-fetch unit tests and Playwright route interception only. First real runs may reveal differences (`/v1/audio/speech` is described in the catalog but has no reference page; `GET /v1/buyer/me` field names are unused).
- The artifact storage host after a redirect is unverified and not in the CSP (`docs/SECURITY.md`). The download also carries `Authorization` and `X-Job-Token`, which the browser preflights again on a cross-origin redirect; if the storage host does not allow them, finished video and music cannot be downloaded in the browser until Surplus serves artifacts directly or the host is allowed. This is the most likely thing to fail on a first real run.
- Quality, speed and price depend on the model. Image-to-image, image-to-video, lyrics and voice cloning are not offered.

## Tests

`tests/generate-catalog.test.ts`, `generate-client.test.ts` (image, speech, async video/music, 401/402/400-credit/404/429/503/network/timeout/cancel, key redaction), `generate-service.test.ts` (prefs, catalog cache, import with provenance, busy, cancel, agent wiring), `generate-tools.test.ts` (plan scope, caps). `e2e/generate.spec.ts` drives the panel against a faked gateway (no network, no key) and writes screenshots to `e2e/.artifacts/gen/`. `e2e/csp.spec.ts` asserts the origin in `connect-src`.
