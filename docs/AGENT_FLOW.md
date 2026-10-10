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
| Stale plan | If the document changed while waiting (the user edited the timeline), Approve is converted to "re-inspect and propose again"; the user's edits stay. |
| Ambiguous brief | Prompt rule unchanged: ask one question, no plan, no edits. |

## Skipping the plan ("Ask before editing")

Pref `agent-ask-before-editing` (`platform/prefs.ts`), default on, checkbox in the Agent panel. Off: no plan tools, no gate, the plain prompt (`buildSystemPrompt({ planning: false })`).
On: the prompt allows a plan-free request only when it is a single fully specified edit. The runtime backs this with a limit of one unplanned mutating call per run; the second is refused with an instruction to call `propose_plan`.

## Loop contract

`RunAgentOptions.planning?: { mode: "ask"; decide(plan): Promise<PlanDecision> } | { mode: "auto-approve" }`. Absent = legacy behaviour (evals, headless). Events: `plan`, `plan_decision`, `plan_step`, `notice`, and `tool_result.planStep`. New status: `rejected`.

## Known limits

- The editor is not locked. While a plan waits, user edits are safe (see above). While an approved plan executes, the transaction is open, as for any agent run without planning, so stopping or failing mid-execution rolls back manual edits made in that window too.
- A re-plan after approval commits the steps done so far as one undo step; the next approved stretch is another, so such a run has more than one undo step and "Undo agent changes" reverts only the last.
- A kept unplanned edit (project changed before the plan) is its own undo step, separate from the plan's.
- Step status is reported by the model through `update_plan_step`; the loop only marks a step failed when the run ends while it is running.
- The `Verification:` line is parsed from the final message; a model that omits it shows no verification on the card.
