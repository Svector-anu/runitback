# Project state

_Updated at the end of every milestone. Read this first when resuming._

## North star
An agent-native video editor: an agent that can see footage, understand references, edit the real project through typed tools, and verify its own work. See `ROADMAP.md`.

## Current milestone
**M4 in-app agent**, **M6 reference intelligence (engine)** and **review hardening (remaining P1/P2)** in parallel. M5 eval harness is done (`docs/EVALS.md`). Next: M7 speech (transcript tool unblocks the last eval case), then the temporal index.

## Completed (evidence)
- M0 reconstruction: editor works end to end (`IMPLEMENTATION_AUDIT.md`).
- M1 agent tool surface: 33 tools + transactions (one turn = one undo); 152 tests.
- M2 perception: silence, loudness, onsets, tempo, scene cuts, pacing, contact sheets; real WebM e2e within 20 ms.
- M3 bridge + MCP: loopback WebSocket with token handshake, MCP stdio server, `render_frame`/`export_project`; docs/AGENT_MCP.md.
- Independent review (`docs/research/review-1.md`): 6 P0 / 18 P1 / 14 P2. All 6 P0 fixed with regression tests; most P1 fixed (`review-1-status.md`).
- Gate at commit `4d4c4fc`: typecheck + lint clean, **653 unit tests** (incl. seeded fuzz over every command and every agent tool: invariants hold, undo-all restores the start), build ok, **24 Playwright tests**.

## In flight (owners → paths)
| Agent | Owns | Deliverable |
|---|---|---|
| H in-app agent | `src/app/agent`, `src/ui/agent` | Claude tool loop, chat panel, shared platform tools |
| J hardening | engine persistence/editor/commands/timeline, `src/app`, `src/ui` (not agent) | typed errors in UI, error boundary, caption lanes, load-time repair, param clamping |
| K reference | `src/engine/reference`, `agent/tools-reference.ts` | style profiles, planner, compare/apply tools |

## Epoch on Aeon (real runs)
Instance: `Svector-anu/svectors-lab` (Aeon, GitHub Actions). Pitch-preserving speed (5 orders) is complete: #2 WSOLA module, #6 live playback (Aeon review caught a per-chunk reset bug; fixed and re-reviewed approve-ready), #7 export-mix verification, and the Speed-tab "Change pitch" switch (built directly after Aeon providers ran out of credit). Remaining gap: a Playwright test that measures pitch on real browser audio. See `AEON_EPOCH.md`.

## Gates (must be green before any milestone is called done)
`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm e2e`

## Known risks / open items
- Product name: **RunItBack** (renamed from the working title "OpenCut", which belongs to the upstream project). Storage migrates once from the `opencut*` IndexedDB names and `opencut:` prefs (`src/platform/legacy-migration.ts`); legacy data is left in place. Old `OPENCUT_*` MCP env vars still work as fallbacks.
- Instance's codex credential (`CODEX_AUTH`) is expired — owner action: `./aeon auth --harness codex`.
- Aeon `chain-runner` workflow is disabled in the instance repo; used the Skill Runner directly instead.
- Real-model evals need an Anthropic API key (owner).
