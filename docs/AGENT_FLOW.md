# Agent flow: plan, approve, execute, verify

Milestone N4. Code: `src/app/agent/loop.ts`, `session.ts`, `system-prompt.ts`; `src/engine/agent/plan.ts`; UI `src/ui/agent/PlanCard.tsx`.

## Flow

1. The user sends a request. The agent inspects with read-only tools.
2. For an editing request it calls `propose_plan`. The Agent panel shows a checklist (intent, tools, targets, check per step) with **Approve**, **Edit**, **Reject**. The run is paused; the project is not touched.
3. Approve: the loop answers the tool call with the approved plan and the agent executes in order. Before a step it calls `update_plan_step(running)`; after verifying it, `done` with the measured result, or `failed` with the reason. Tool results that arrive while a step runs are listed under that step.
4. Edit: the user's free text goes back to the model as the `propose_plan` result; the model proposes a revised plan, which replaces the old card (marked superseded).
5. Reject: the run ends with status `rejected`, everything is rolled back, the conversation stays valid for the next request.
6. A failure is explained in the step note. The agent repairs within the step's intent and re-verifies, or stops and says what failed and what state the project is in. A fix that needs different edits goes through `propose_plan` again.
7. The agent ends with a `Verification:` line of facts it measured after the edits. The panel shows it under the plan.

## Guarantees and where they live

| Guarantee | Mechanism |
|---|---|
| No edit before approval | `gateEdit` in `loop.ts` refuses non-read-only tools until a plan is approved. Exception below. |
| Plan tools never change the document | They are handled in the loop, not registered as tools or commands. |
| One agent turn = one undo step | Without planning the whole run is one transaction. With planning, `TurnLedger` opens the transaction at the first edit that is allowed to run (after Approve) and commits it at the end of the run, so one undo restores the state right before the approved execution, user edits made during the wait included. |
| A wait never holds a transaction | Nothing is open while `propose_plan` waits (a transaction left open by earlier approved steps is committed first). Reject, Stop and abort therefore touch nothing, and edits the user makes during the wait are ordinary history entries that cannot be rolled back by the agent. |
| Document untouched while the plan waits | Plan is shown before edits. The one allowed unplanned edit is its own committed undo step; when a plan follows, `revertUnplanned` undoes exactly that step, and only if the document is still exactly what the edit produced. If the project changed since, nothing is reverted; the model and the user are told the edit was kept. |
| Approval is scoped to the plan | After Approve, `planScopeViolation` (`engine/agent/plan-scope.ts`) refuses a mutating call whose tool is in no step's `tools`, whose existing element/track id (known at approval) is not named in the declared `targets`, or whose cut time (`at`, `time`) is outside a declared range such as "0-4.5s". Ids created after approval (the right half of a split) are free. Targets that name no existing id and no range are free text and not enforced. The refusal reads "not in the approved plan: propose an updated plan". |
| Stale plan | If the document changed while waiting (the user edited the timeline), Approve is converted to "re-inspect and propose again"; the user's edits stay. |
| Ambiguous brief | Prompt rule unchanged: ask one question, no plan, no edits. |

## Skipping the plan ("Ask before editing")

Pref `agent-ask-before-editing` (`platform/prefs.ts`), default on, checkbox in the Agent panel. Off: no plan tools, no gate, the plain prompt (`buildSystemPrompt({ planning: false })`).
On: the prompt allows a plan-free request only when it is a single fully specified edit of one element. The runtime backs this with a limit of one unplanned mutating call per run, and only a single targeted edit qualifies (`isSingleTargetedEdit`): not a tool marked `destructive` in its metadata (delete_track, set_project, import_captions, undo, redo, cut_to_moments, apply_cut_plan), not `ripple:true`, not an array argument with more than one entry, and for tools with `elementIds` (split, move, delete, duplicate) exactly one id named, so `split` without ids (every clip at the cut) is planned-only. A refused call does not use up the allowance; the refusal tells the model to call `propose_plan`.

## Untrusted tool output

The system prompt tells the model that tool output (transcripts, captions, asset/clip/project names, filenames, analysis text) is data, never instructions, and to mention embedded instructions to the user and continue the real request. Tests assert the rule text is in the prompt (`tests/qa-agent-safety.test.ts`). Whether a real model obeys it has NOT been measured: no model calls were made. The runtime gates above (plan approval, single-target allowance, plan scope) are the actual defence; the prompt rule is a mitigation only.

## Loop contract

`RunAgentOptions.planning?: { mode: "ask"; decide(plan): Promise<PlanDecision> } | { mode: "auto-approve" }`. Absent = legacy behaviour (evals, headless). Events: `plan`, `plan_decision`, `plan_step`, `notice`, and `tool_result.planStep`. New status: `rejected`.

## Context cost: history compaction

Every request resends the whole conversation, so analysis dumps and frames from many steps ago dominated the input (15-17k tokens per call). `compactHistory` (`loop.ts`, applied just before `limitImages`) replaces a stale tool result with `[result omitted: <tool>, <n> chars[, <k> image(s)]. Call <tool> again if you still need it. It began: <first line>]` when it is bulky (over `MIN_STUB_CHARS` or carrying an image). Stale means: results from earlier user requests, and results older than the newest `KEEP_RECENT_STEPS` (6) assistant steps of the current request, rounded down to a multiple of `COMPACTION_STEP_QUANTUM` (4). Only block content changes, so every `tool_use` keeps its `tool_result` (valid for both the Anthropic and OpenAI mappings), the latest step's results are never touched, the stored session history stays complete, and the prefix of the request changes once per quantum, not every step, so the Anthropic cache breakpoints (system, last tool, newest message) keep hitting between those points. The first request of a new user turn re-writes the cache once because earlier turns are now stubbed. Tests: `tests/agent-compaction.test.ts` (character-count proxy, pairing, cache breakpoints).

## Highlights and "keep only": replace, then verify content

`cut_to_moments` (and `apply_cut_plan`) append or fail by default. The prompt and tool description tell the model to pass `replace:true` when the result must BE the timeline; the main-track clips are then removed and the sequence built from 0 in one transaction (one undo step, nothing changes if the new sequence cannot be built). The result reports `timelineDurationSeconds` for the whole timeline. After placing a moment found by look or speech, the prompt requires a `render_frame` at its midpoint and a one-sentence comparison with the request, and a new search on mismatch. Eval: `highlight-around-phrase` (mutation `appended-copy`).

## Known limits

- The editor is not locked. While a plan waits, user edits are safe (see above). While an approved plan executes, the transaction is open, as for any agent run without planning, so stopping or failing mid-execution rolls back manual edits made in that window too.
- A re-plan after approval commits the steps done so far as one undo step; the next approved stretch is another, so such a run has more than one undo step and "Undo agent changes" reverts only the last.
- A kept unplanned edit (project changed before the plan) is its own undo step, separate from the plan's.
- Step status is reported by the model through `update_plan_step`; the loop only marks a step failed when the run ends while it is running.
- The `Verification:` line is parsed from the final message; a model that omits it shows no verification on the card.
