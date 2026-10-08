# Project state

_Updated at the end of every milestone. Read this first when resuming._

## North star
An agent-native video editor: an agent that can see footage, understand references, edit the real project through typed tools, and verify its own work. See `ROADMAP.md`.

## Current milestone
**M1–M3 in parallel** (agent tool surface, perception, MCP bridge) plus an independent adversarial code review (`docs/research/review-1.md`). Next: integrate, then M4 (in-app agent) and M5 (eval harness).

## Completed
- M0 editor reconstruction: 286 unit + 13 Playwright tests, clean-checkout install/test/build verified. Evidence: `IMPLEMENTATION_AUDIT.md`.
- Agent tool contract (`src/engine/agent/types.ts`), dependencies for MCP/Claude SDK installed, `ROADMAP.md`, `AEON_EPOCH.md`.

## In flight (owners → paths)
| Agent | Owns | Deliverable |
|---|---|---|
| A engine/agent | `src/engine/agent`, `commands`, `editor`, `tests/agent-*` | tool registry, transactions (one turn = one undo) |
| B perception | `src/engine/analysis`, `src/platform/analysis`, `src/render/contact-sheet.ts` | silence/loudness/cuts/onsets/tempo/pacing, contact sheets |
| C bridge/MCP | `src/platform/agent-bridge*`, `tools/mcp`, `src/ui/agent/BridgeStatus.tsx` | loopback WebSocket + MCP stdio server, `render_frame` |
| R review | `docs/research/review-1*` (read-only on source) | ranked P0/P1/P2 findings with repros |

## Gates (must be green before any milestone is called done)
`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm e2e`

## Known risks
See `ROADMAP.md` "Risks" and `docs/research/review-1.md` when it lands.

## Blocked on the owner
- **Epoch via MiniAeon needs a GitHub repository for this project** (Epoch builds/reviews/watches pull requests) and permission to spend model quota on autonomous runs. No remote is configured; I will not create or push to one without your go-ahead. Everything else proceeds without it.
- **A Claude API key** for the in-app agent's live evals (M4/M5). The MCP route needs none.
