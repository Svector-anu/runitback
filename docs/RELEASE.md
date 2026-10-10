# Release checklist

How a change gets from a merged PR to the live app, and which steps only the
account owner can do.

## Currency

Accurate as of this PR's own head commit, against `main` @ `bb14af1`. Of the
six M9 ship-brief orders (`docs/SHIP_BRIEF.md`):

| Order | What | Status |
| --- | --- | --- |
| 1 | Auto-deploy (CI-gated Vercel Action) | **merged** — issue #17, PR #19 |
| 2 | Production-build e2e | **merged** — issue #15, PR #16 |
| 3 | Post-deploy smoke check | **merged** — issue #20, PR #21 |
| 4 | Agent panel UX ("API key required") | **planned** — issue #18, open |
| 5 | First-run onboarding hint | **merged** — issue #22, PR #23 |
| 6 | This doc | in progress |

If order 4 later merges, or any status above changes, update this table —
don't let it drift from what's actually shipped.

## 1. Pre-merge gate (CI)

Every push and pull request runs the `gates` job in
`.github/workflows/ci.yml`:

```
pnpm typecheck && pnpm lint && pnpm test && pnpm eval && pnpm build && pnpm e2e
```

A second job, `e2e-production`, builds the app and runs the Playwright suite
against that production build (`PLAYWRIGHT_TARGET=production`) rather than
the dev server. Both jobs must be green before merge.

## 2. Merge to `main`

Standard GitHub merge once CI is green. No automation beyond branch
protection; this step itself needs no owner secrets.

## 3. Automated deploy

Two deploy paths exist in this repo; only one is active:

- **Active today:** Vercel's native GitHub integration, connected directly to
  this repo by the owner. It deploys every push to `main` to Production
  (`runitback-three.vercel.app`) on its own — no GitHub Actions secret
  required for this path.
- **Built, currently disabled:** `.github/workflows/deploy.yml` — a
  CI-gated Action (triggers after the `ci` workflow completes on `main`) that
  deploys via the Vercel CLI using `VERCEL_TOKEN`, `VERCEL_ORG_ID` and
  `VERCEL_PROJECT_ID`. Its GitHub Actions workflow state is
  `disabled_manually`. This is order 1 (PR #19) — built and merged, but not
  the path currently deploying the app.

## 4. Post-deploy smoke check

`.github/workflows/smoke.yml` (order 3, PR #21) fires on a `deployment_status`
event for a `Production` deployment — it runs regardless of which of the two
paths above produced the deploy. It loads the live URL headlessly, creates a
project, and confirms the editor mounts, failing the workflow run if not.
This is a post-deploy signal, not a merge gate: a failure means "production
is broken, fix forward or roll back," not "undo the merge."

Deployment Protection being on means the smoke check's headless request hits
Vercel's login page unless a bypass secret is present — see Owner-only below.
Without it, the job logs a warning and skips the check rather than failing.

## Owner-only

These steps require the Vercel dashboard or GitHub repo secrets — no skill in
this repo can do them.

- **Add `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`** (repo secrets,
  Settings > Secrets and variables > Actions) — only needed to re-enable
  `deploy.yml`. Not required for the active Vercel-integration deploy path.
- **Add `VERCEL_AUTOMATION_BYPASS_SECRET`** (repo secret) — generate it under
  the Vercel project's Settings > Deployment Protection > Protection Bypass
  for Automation. Required for the smoke check to reach the live app while
  Deployment Protection is on.
- **Turn off Deployment Protection** (make the site public) — Vercel
  project Settings > Deployment Protection. An alternative to adding the
  bypass secret above; either unblocks the smoke check.
- **Rotate any of the above** — regenerate in the Vercel dashboard, then
  update the corresponding GitHub repo secret. Never commit a secret value,
  put one in a PR body, or paste one into chat.
