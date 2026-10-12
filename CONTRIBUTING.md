# Contributing to RunItBack

Thanks for helping. RunItBack is a local-first, in-browser video editor with an AI agent, in beta. Small, focused pull requests with tests are the easiest to review.

By contributing you agree your work is released under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, see [SECURITY.md](SECURITY.md).

## Setup

Requires Node 22 and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm exec playwright install chromium   # once, for e2e
pnpm dev                                # http://localhost:5173, use Chrome
```

Read `CLAUDE.md` (architecture, invariants, testing workflow) and `docs/ARCHITECTURE.md` before a non-trivial change. The file is written for coding agents but is the authoritative short description of the rules below.

## Gates

A change is ready when all of these pass; CI runs the same set.

```sh
pnpm typecheck   # tsc --noEmit, strict, noUncheckedIndexedAccess
pnpm lint
pnpm test        # vitest: engine, persistence, render geometry, ui lib, architecture
pnpm eval        # scripted agent evals: no network, no key
pnpm build       # typecheck + production bundle
pnpm e2e         # Playwright (Chromium): import, edit, play, persist, export
```

Fix the cause of a failing test, not the assertion. Some e2e specs are opt-in (`REAL_MODEL=1`, `REAL_CLIP=1`, `REAL_FACE=1`); they are listed in `CLAUDE.md` and need models or a key. Never print, log or commit an API key.

## Layering rules

Imports point downward only; `tests/architecture.test.ts` enforces it.

`engine` (pure) <- `render` <- `platform` <- `export` <- `app` <- `ui`

- `src/engine/` has no DOM and no framework and must run in Node.
- `src/ui/` holds no document state.
- Only `platform/prefs.ts` touches `localStorage`. Persist through repositories.
- Time is integer ticks (`TICKS_PER_SECOND = 120_000`); seconds appear only at I/O.
- Every document change is a `Command` run through `Editor.execute`; continuous gestures use `preview` then `commitPreview` or `discardPreview`.
- Preview and export share `buildFramePlan` and `Compositor`. Never add rendering logic to only one.
- Schema changes need an additive migration in `engine/persistence/serialization.ts` and a `PROJECT_SCHEMA_VERSION` bump. Never delete or rename persisted fields.
- No `any`, `@ts-ignore` or `console.log`. Functions with several parameters take an object.

Write engine tests first (`tests/*.test.ts`, helpers in `tests/helpers.ts`). UI gestures and pixels are covered by Playwright against real generated media (`e2e/media.ts`); do not mock the decoder or exporter.

## Commits and pull requests

Conventional style, one logical change per commit:

```
<type>(<scope>): <what changed and why>
```

`type` is one of `feat`, `fix`, `chore`, `test`, `refactor`, `docs`; `scope` is the module (`engine`, `timeline`, `agent`, `export`, `ui`, ...). Keep the subject under 72 characters, no trailing period. Examples from the history: `fix(timeline): first clip dropped on an empty project starts at 0 on the main track`, `feat(ui): collapse agent panel settings once an API key is set`.

Fix bugs minimally; do not refactor while fixing. Open the PR against `main`, fill in the template, and link the issue it closes. Mark in-progress behaviour honestly in docs (`docs/PRODUCT_MAP.md` tracks what is built versus planned).

## Adding an agent tool

1. Define it with `defineTool` in the matching `src/engine/agent/tools-*.ts` file (or a new one) and add it to that file's tool list. Tools take seconds and element ids, validate input, and edit only through commands so one agent turn stays one undo step.
2. Register the list in `src/engine/agent/registry.ts` (`createAgentTools`) or, for tools that need injected services, export a `create...Tools` factory from `src/engine/agent/index.ts` and wire it in `src/app/agent/`.
3. Mention it in `src/app/agent/system-prompt.ts` if the prompt lists tools by name.
4. Add tests under `tests/` (see `tests/agent-*.test.ts` and `tests/agent-harness.ts`). Tools run over MCP too, see `docs/AGENT_MCP.md`.

## Adding an eval case

Full procedure in `docs/EVALS.md` ("Adding a case"). In short: add an `EvalCase` and register it in `CASES` in `evals/cases.ts` (declare fixtures, a brief, a budget and pure checks); add an oracle and at least one mutation with `mustFail` in `evals/policies.ts`, plus `LAZY_FAILS` and `OVERREACH_FAILS` entries; run `pnpm eval` until the oracle passes and each mutation fails exactly the checks it declares. If no oracle can solve it with today's tools, set `blocked` instead of faking a solution.

## Adding a landing section

The landing page is `src/ui/pages/Landing.tsx`, styled in `src/ui/styles/`. Add the section as a component in that file (or a sibling under `src/ui/pages/`), reuse the design tokens in `src/ui/styles/tokens.css` and primitives from `src/ui/primitives/`, keep copy factual (state beta and known gaps honestly), and check it at phone and desktop width and in both themes. `e2e/landing-app-split.spec.ts` covers the landing-to-app split; extend it if you add navigation.

## Questions

Open a GitHub Discussion (if enabled) or an issue. For anything that should not be public, use [SECURITY.md](SECURITY.md).
