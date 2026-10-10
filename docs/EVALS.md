# Agent evals

A deterministic, measurable way to answer "did the editing agent do the job?", so a regression in a tool, a prompt or a model shows up as a failing check instead of a vibe. Code lives in `evals/`; the tests are `tests/evals-*.test.ts` and `e2e/agent-eval.spec.ts`.

## What an eval is

```
EvalCase { id, brief, fixtures, budget, checks }
```

- **brief**: the user's request, verbatim. This is the only instruction the agent gets.
- **fixtures**: declarative synthetic media (`FixtureSpec`): a name, a duration, colour blocks (the shots) and a soundtrack (`speech` ranges, a steady `tone`, a `beat` grid, or `none`) and optionally a word-level `transcript` in source seconds, `visual` showings (what is on screen when) or `faces` (where the speaker's face is when). Ground truth is exact because it is derived from the declaration, never measured. A fixture with `placeAt` starts on the timeline; the others sit in the media pool.
- **budget**: `maxSteps` and `maxTokens` handed to `runAgent`.
- **checks**: pure functions `(CheckInput) => { pass, score 0..1, detail }` over the project before the run (`initial`), right after it (`final`), after one undo (`afterUndo`), the resolved fixtures with their ground truth, and the run summary (status, final text, steps, usage).

The harness (`evals/harness.ts`) builds a headless `Editor` holding the fixtures, wires the real engine tools plus the reference tools, runs `runAgent`, snapshots the project, undoes once, and scores. A case passes when every check passes; its score is the mean check score.

### Tools behind the agent

Headless runs use the real `createAgentTools()`. The browser-only tools are replaced by deterministic stubs (`evals/stub-tools.ts`): `analyze_media` returns the exact analysis of the declared media (same summary format as the app), `analyze_timeline` measures the real timeline, and `render_frame` / `render_contact_sheet` return a tiny PNG whose pixels are the colour of the clip on screen (so image plumbing is exercised) with a caption naming that colour. `export_project` is absent. The Playwright mode uses the real tools on real decoded media.

## The cases

| Case | Brief (short) | Task checks |
| --- | --- | --- |
| `remove-silences` | Remove silences over 0.5 s from a talking clip, close the gaps | `no-long-silence`: no stretch of the timeline's audio, dead gaps included, is silent for over 0.5 s. `speech-retained`: at least 95% of the speech seconds still play. |
| `cut-to-beat` | Cut a montage of the footage to the music already on the timeline | `cuts-on-beat`: at least 4 cuts and at least 80% within 60 ms of a beat of the music as placed on the timeline. `music-and-footage-kept`: music at least 90%, footage at least 80% still used. |
| `trim-to-duration` | Cut a 2 s intro and 2 s outro so 8 s remain | `target-duration`: 8 s +/- 0.1 s starting at 0. `kept-the-middle`: at least 7.8 s of the middle, at most 0.1 s of intro/outro. |
| `captions-from-srt` | Add the supplied SRT as captions | `captions-correct`: every cue is a text clip with the right words (whitespace and case ignored) and start/end within 50 ms. `no-extra-captions`: as many text clips as cues. |
| `speed-to-fit` | Make a 12 s clip take exactly 8 s without cutting | `fits-duration`: 8 s +/- 0.1 s. `whole-clip-kept`: at least 11.8 s of source still plays. |
| `title-fade` | Title "Summer Roadtrip" for the first 3 s, fading in and out | `title-text-and-timing`: exactly one text clip with that text, 0 to 3 s +/- 0.1 s. `opacity-fades`: keyframed opacity that starts transparent, reaches full, and ends transparent at the clip end. |
| `reorder-clips` | Play blue, red, green instead of red, green, blue | `order`: the main track plays the wanted order. `back-to-back-and-intact`: starts at 0, no gaps, every clip its full length. |
| `match-reference-pacing` | Cut the footage in the pacing of a reference clip | `average-shot-length`: at least 6 shots, average within 20% of the reference's. `footage-only`: the reference itself is not on the timeline. |
| `ambiguous-request` | "Make it better." | `project-unchanged` and `asks-or-declines`. |
| `impossible-request` | Replace the voice with a French AI voice | `project-unchanged` and `asks-or-declines`. |
| `delete-spoken-sentence` | Delete the sentence where the speaker says "we should probably skip this part" | `sentence-removed`: at most 0.05 s of the sentence's words still play. `other-speech-retained`: at least 98% of the words of the other sentences still play. The fixture declares a word-level `transcript`; the case gets the transcript tools (`search_transcript`, `delete_spoken_range`, ...) backed by a store holding it. |
| `find-and-cut-phrase-moments` | Assemble a sequence of only the sentences where the speaker says "budget", in spoken order, back to back | `keyword-sentences-kept`: at least 98% of the matching sentences' speech is on the timeline. `nothing-else-kept`: at most 0.1 s of the other sentences' speech. `spoken-order-back-to-back`: main-track clips start at 0, touch, and follow source order. Uses `find_moments` + `cut_to_moments`. |
| `loudest-shot-first` | Cut a three-shot clip so the loudest shot plays first, the others after it in order | `loudest-leads`: the first clip is the whole loudest shot at 0. `all-shots-kept`: every shot at least 95% present. `rest-in-order-back-to-back`: the remaining shots follow in source order with no gaps. The fixture's soundtrack is `{ kind: "levels" }` (a tone whose level steps per shot). |
| `find-visual-moment` | Assemble only the parts of a clip that show "a dog", in the order they appear, back to back | `subject-footage-kept`: at least 95% of the seconds showing the subject are on the timeline. `nothing-else-kept`: at most 0.5 s of other footage. `appearance-order-back-to-back`: main-track clips start at 0, touch, and follow source order. The fixture declares what is on screen when (`visual: [{ start, end, shows }]`); `evals/visual.ts` turns that into embeddings with the real sampling plan and a stand-in text encoder, so the case gets `find_visual_moments` with no model involved. Mutations: `first-only`, `wrong-subject`. |
| `reframe-to-speaker` | Make a landscape interview vertical (9:16) and keep the speaker in the middle of the picture, keeping the whole clip | `canvas-is-vertical`: the canvas is 9:16. `speaker-in-frame`: at nine sampled moments inside the three declared stretches the speaker's face is within 10% of the canvas width from the middle, evaluating the clip's animated position and scale (all samples). `whole-clip-kept`: at least 95% of the clip still plays. The fixture declares where the face is when (`faces: [{ start, end, centerX }]`); `evals/faces.ts` turns that into detections with the real sampling plan, so the case gets `find_face_moments`, `describe_faces` and `reframe_to_faces` with no detector involved. Mutations: `static-crop` (fixed zoom on the middle, never follows), `wrong-canvas` (reframes but leaves 16:9). |

`asks-or-declines` is a heuristic: the final answer must contain a question mark or a plain refusal ("can't", "cannot", "unable", "no tool", "not possible", "not supported", ...). `project-unchanged` compares the whole document (scenes, settings, current scene), not just the timeline, and also requires that the run left nothing to undo.

### Invariant checks (added to every case)

| Check | Meaning |
| --- | --- |
| `agent-finished` | The run ended with the model's own answer (`done`), not an error, step limit or token budget. |
| `no-overlaps` | No two elements on one track overlap (touching edges are fine). |
| `finite-values` | No NaN or Infinity anywhere in scenes or settings. |
| `non-negative-times` | Starts and trims are at least 0, durations above 0. |
| `source-mapping` | `trimStart + duration * rate + trimEnd` equals the source duration (within one frame). |
| `undo-restores-original` | One undo returns the document to exactly the pre-run document. |

## Policies: proving the checks mean something

`evals/policies.ts` holds scripted policies (`ScriptedModelClient` turns). Each case has:

- one **oracle** that solves it through the real tools and must pass every check;
- **mutations**: plausible wrong solutions, each declaring which checks must report a failure (`mustFail`). Every case gets a `lazy` mutation (claims success, calls nothing) and an `overreach` mutation (deletes every clip); most cases add specific near misses such as `no-ripple` (leaves gaps), `off-beat`, `trim-instead` of speeding up, `no-fade`, `shifted` captions.

Policies never read fixture ground truth. They decide from tool results (`list_assets`, `analyze_media`, `get_timeline`) the way a model would, which is why the same policies work on real decoded media in the browser. They find assets by file name, never by id.

## Running

```sh
pnpm eval                        # scripted suite: every oracle and mutation, exit 1 on any surprise
pnpm exec tsx evals/run.ts remove-silences   # one case
pnpm vitest run tests/evals      # the same suite plus unit tests of the checks, inside vitest
pnpm exec playwright test e2e/agent-eval.spec.ts   # real generated media through the real in-app agent loop
ANTHROPIC_API_KEY=... pnpm eval:real [--trials 3] [--case ID] [--model ID]   # real model, periodic report
OPENAI_API_KEY=... pnpm eval:real --provider openai [--model ID] [--trials N]  # same suite through the OpenAI-compatible client
```

**Scripted** (`pnpm eval`, `tests/evals-*.test.ts`): no network, no browser, deterministic. This is the CI gate.

**Real media** (`e2e/agent-eval.spec.ts`): each case's fixtures are generated as real WebM files in the page (`evals/browser-entry.ts`), imported through the UI, edited by the real in-app session via the dev-only `window.__agentModel` hook driven by the case's oracle, and scored twice: against ground truth **measured** by the real analyzer from the decoded media, and against the declaration. It also runs three mutations to show the checks still discriminate on real data. Runs the cases `remove-silences`, `trim-to-duration`, `reorder-clips`, `captions-from-srt`, `speed-to-fit`, `title-fade`, `cut-to-beat`.

**Real model** (`evals/real.ts`, `pnpm eval:real`): runs every runnable case `--trials` times (default 3) against `AnthropicModelClient`. It makes model calls only when `ANTHROPIC_API_KEY` is set **and** `--real` is passed (the npm script passes it); otherwise it prints usage and exits without calling anything. `--provider anthropic` (default) or `--provider openai` selects the client (see `docs/PROVIDERS.md`); the OpenAI path reads `OPENAI_API_KEY` (never `ANTHROPIC_API_KEY`) and `OPENAI_BASE_URL` (default `https://api.surplusintelligence.ai/v1`). The model comes from `--model`, then `EVAL_MODEL`, then the provider default (`claude-sonnet-5-5` / `gpt-5-mini`). Tools are the deterministic stubs, so the only variable is the model. The key is never printed or stored; errors are passed through `redactSecrets`. Each run writes `evals/reports/<timestamp>.json` and `.md` (git-ignored) with per-case pass rate, mean score, steps, tokens and an estimated cost. Costs use `DEFAULT_PRICING` in `evals/report.ts` (override with `EVAL_PRICE_INPUT` / `EVAL_PRICE_OUTPUT`, USD per million tokens); treat them as a budget guide, not a bill.

## How results gate changes

| Suite | When | Gate |
| --- | --- | --- |
| Scripted (`pnpm eval`, vitest) | every PR / `pnpm test` | **Blocking.** An oracle that fails means a tool, schema or check regressed; a mutation that passes means a check got weaker. |
| Real media (Playwright) | with `pnpm e2e` | **Blocking** for changes to analysis, import, tools or the agent loop. |
| Real model (`pnpm eval:real`) | before releases, after prompt/tool/model changes, weekly | **Report, not a gate** (it is stochastic and costs money). Compare the pass rate and mean score with the previous report; investigate drops of more than one trial in a case. |

When a real-model run fails a case, look at the failed check ids in the report, then reproduce by reading the tool calls: either the model made a mistake (fix the prompt or tool descriptions), or the check is too strict for a legitimate alternative solution (fix the check and add a mutation test).

## Adding a case

1. Add an `EvalCase` to `evals/cases.ts` and to `CASES`. Declare fixtures with the structure the check needs (silences, beats, shot lengths). Use distinctive file names; briefs and policies refer to them.
2. Write task checks as pure functions of `CheckInput`. Use `clipsOf(final)` for a seconds-based view of the timeline, `sourceRangesOnTimeline` / `sourceTimesOnTimeline` to map fixture truth through trims and speed, and `graded` for partial credit. Prefer measuring the outcome (what plays when) over inspecting which tools were called.
3. Add an oracle (`id: "oracle"`) in `evals/policies.ts` that solves it from tool results, then at least one specific mutation with `mustFail`, and entries for the case in `LAZY_FAILS` and `OVERREACH_FAILS`.
4. Run `pnpm eval`. The oracle must pass, each mutation must fail exactly the checks it declares, and no mutation may fail an invariant. Add unit tests for any new helper to `tests/evals-checks.test.ts`.
5. If no oracle can solve the case with today's tools, set `blocked` to the reason and the missing tool instead of faking a solution.

## The plan protocol (plan-then-execute)

The in-app agent runs with "Ask before editing" on by default. Evals and scripted policies do not: `runAgent` is called without `planning`, so there are no plan tools, no gate, and the prompt is the plain one. The eval suite therefore measures the editing tools and checks, not the approval UI, and `pnpm eval` stays 75/75 as declared.

When `planning` is set, the loop adds two loop-level tools (never registry tools, never editor commands, no document effect):

- `propose_plan {summary, steps[{intent, tools[], targets[], check}]}`: 1 to 12 ordered steps. Tool names are validated against the registry. The call blocks until the user answers.
- `update_plan_step {step, status: running|done|failed, note}`: progress on an approved plan; `note` carries the measured result or the failure reason.

What a harness can assert (see `tests/agent-plan.test.ts`):

1. The document is identical to the start while a plan awaits a decision.
2. Approve runs the plan inside one transaction opened after the approval; one undo restores the state right before it, including any edits the user made during the wait.
3. Reject ends the run with status `rejected` and touches nothing (user edits made during the wait are kept, no history entry from the agent).
4. Revise returns the user's text to the model, which proposes again; only the approved plan runs.
5. Without an approved plan, one stand-alone edit is allowed; a second edit is refused. If a plan follows an unplanned edit, that edit's own undo step is reverted first, only if the project is unchanged since, so (1) holds.
6. A final `Verification:` line must state facts measured after the edits (the measured-numbers rule); the real-model scenario compares the number it states with the document.

To drive a case through the protocol without a human, pass `planning: { mode: "auto-approve" }` (`RunCaseOptions.planning`): the plan is recorded and approved at once. The real-model scenario is `e2e/agent-real.spec.ts` ("shows a plan before any edit..."), opt-in with `REAL_MODEL=1`; it asserts the plan is on screen before any edit, the document is unchanged while it waits, and the stated final length matches the measured one. See `AGENT_FLOW.md` for the full flow.

## Known gaps

- `delete-spoken-sentence` runs against a declared fixture transcript, not a real recognizer, and is not in the real-media Playwright run (the browser fixtures carry a tone, not speech). It proves the tools and the checks, not recognition quality.
- Real-media mode covers the audio/shot structure the analyzer can measure; the reference-pacing case needs a style store and is covered headlessly only.
- Stubbed rendering means headless runs cannot test visual judgement (is the title legible?). The checks measure timing and structure.

## Running the real-model eval through a gateway

`pnpm eval:real` talks to any Anthropic-compatible endpoint. To use Surplus Intelligence (marketplace of sellers, `inf_` keys), keep the key in your shell and never in the repo:

```sh
export ANTHROPIC_API_KEY=inf_...        # buyer key
export ANTHROPIC_BASE_URL=https://api.surplusintelligence.ai/anthropic
pnpm eval:real --trials 1 --model claude-opus-4.8
```

Only the synthetic fixtures' tool results (numbers and ids) leave the machine in this mode. Do not point the in-app agent at a gateway for real footage: requests are routed to third-party sellers and the docs do not say who can see them. Browser (CORS) access to the gateway is unverified, so the in-app agent has no base-URL setting. Model ids are the gateway's (`claude-opus-4.8`, `claude-sonnet-4-5-20250929`, ...), not Anthropic's.

### OpenAI-compatible provider through the gateway

```sh
source ~/.surplus-env                                   # exports ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL
export OPENAI_API_KEY=$ANTHROPIC_API_KEY OPENAI_BASE_URL=https://api.surplusintelligence.ai/v1
pnpm eval:real --provider openai --model claude-haiku-4.5 --trials 1
```

Cost is estimated from `EVAL_PRICE_INPUT` / `EVAL_PRICE_OUTPUT` (or the registry price for models that have one); set them for non-default models.

### Provider-independence results (N5, 1 trial per case)

`claude-haiku-4.5` over `--provider openai` (chat completions, function tools, SSE): 8 of the 15 runnable cases run (`trim-to-duration`, `find-visual-moment`, `remove-silences`, `title-fade`, `ambiguous-request`, `impossible-request`, `loudest-shot-first`, `reframe-to-speaker`), 8/8 passed, mean score 1.00, about $0.53 estimated at $1/$5 per million tokens. Anthropic-path regression, `trim-to-duration` with `claude-haiku-4.5`: pass, 1.00, about $0.05. The remaining cases were not run to stay inside the spend cap. `gpt-5-mini`, `gpt-5.3-codex` and `mercury-2.5` returned 403 (key not scoped) with the development key, so no native OpenAI model has been evaluated. No prompt or tool-description change was needed.
