# Aeon, MiniAeon and Epoch: how they fit this project

Findings from inspecting the local installs (not assumptions).

## What exists

- **Aeon** (`~/.claude/skills/aeon`): a setup skill for *Aeon instances* — an agent that runs scheduled markdown skills on a user's GitHub repo through GitHub Actions. Modes: start, reschedule, unblock, chat→skill, edit skill, pick skills, strategy/voice, mine history. Relevant here: Mode 4 (turn a workflow into a scheduled skill) and Mode 8 (mine past Claude Code chats for repeated work).
- **MiniAeon** (`~/.local/bin/miniaeon`, source `~/Desktop/coding/miniaeon`, Go): a local-first skill runner on the `omp` agent loop. A run is a ledgered state machine (`planned → dispatched → acknowledged → running → completed`) with scope-checked writes, git-backed memory, approvals (`miniaeon approve`), scoring, a watchdog and a daemon. Commands used for development: `run <skill>`, `rank`, `approvals`, `trace`, `selfcheck`, `pack`.
- **Epoch** (skills `epoch-spec`, `epoch-build`, `epoch-review`, `epoch-watch`, plus `create-prove`, in `~/Desktop/svectors-lab/skills/`, workspace `~/Desktop/coding and projects/svectors-lab`): the engineering lifecycle as skills.
  - `epoch-spec` turns one intent into durable knowledge (`memory/topics/<project>/map.md`, `spec.md`, `orders/<id>.md`, `handoff.md`) and exactly one runnable next unit (a candidate row `miniaeon rank` reads).
  - `epoch-build` executes one order in an isolated clone: smallest change, local VERIFY, one PR, registered for approval. Never merges.
  - `epoch-review` reviews a PR against its order at an exact head SHA and posts a receipt-bearing review, with no access to the builder's reasoning.
  - `epoch-watch` decides merge-readiness from GitHub state plus review and proof receipts at the same head SHA. `create-prove` records proof.

## Mapping to this repo's loop

| Epoch stage | Here |
|---|---|
| INTAKE/UNDERSTAND/PLAN | `docs/ROADMAP.md` + a written order per milestone (claim, scope, acceptance, VERIFY, FORBIDDEN) |
| IMPLEMENT | partitioned subagents owning disjoint paths |
| TEST | `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm e2e` |
| REVIEW | independent reviewer agent that has not seen the builder's reasoning |
| REPAIR | fix findings, rerun gates |
| PROVE | observed behaviour (e2e/eval output) bound to the exact commit SHA |
| RECORD | `docs/PROJECT_STATE.md`, `IMPLEMENTATION_AUDIT.md`, commit message evidence |

## Using the real Epoch tooling

Epoch's builder/reviewer/watcher operate on **GitHub pull requests**; they need (1) this project on a GitHub repository, (2) a MiniAeon workspace with the epoch skills enabled, (3) model/provider quota for autonomous runs, and (4) `miniaeon approve` as the human go/no-go. None of those exist for this project yet. Until they do, the Epoch discipline is applied manually (table above) with independent reviewer agents standing in for `epoch-review`. See `docs/PROJECT_STATE.md` → "Blocked on the owner".
- Epoch workspace needs git origin == target repo (grant targets match origin); run with --no-git so workspace state is never pushed.


## What actually worked (2026-10-08)

- **MiniAeon route** (`~/Desktop/coding/opencut-epoch`): `epoch-spec` worked and produced a spec + 5 work orders (pitch-preserving speed). `epoch-build` was blocked: repo grants match the workspace's git `origin`; fixed by giving the workspace the target origin and running with `--no-git`. Superseded by the Aeon route at the owner's request.
- **Aeon route** (instance `Svector-anu/svectors-lab`): Epoch-style loop = issue (the order) → `feature external:<owner/repo>#<N>` builds one PR → `pr-review <owner/repo>#<PR>` reviews it → human merges. Dispatch with `gh workflow run aeon.yml -R Svector-anu/svectors-lab -f skill=... -f var=... -f harness=claude`. The first attempt failed on an expired Codex credential; the per-run `harness=claude` override fixed it without editing the instance config.
- The instance also has an `Epoch intake` workflow (issue label `epoch` or `/epoch` comment) and `Epoch verify`; they act on that instance's own issues.
