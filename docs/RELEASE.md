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
the dev server. That run serves the headers from `vercel.json` and includes
`e2e/csp.spec.ts`, which fails on any Content-Security-Policy violation (see
`docs/SECURITY.md`). Both jobs must be green before merge.

## 2. Merge to `main`

Standard GitHub merge once CI is green. No automation beyond branch
protection; this step itself needs no owner secrets.

## 3. Automated deploy

One deploy path is active: **Vercel's native GitHub integration** (owner-connected) deploys every push to `main` to Production (`runitback-three.vercel.app`). `.github/workflows/deploy.yml` (CI-gated Vercel CLI deploy) is **disabled** in GitHub's Actions settings and is kept only as the alternative below; do not enable it while the native integration is also on, or every commit deploys twice.

### The gap: deploys are not gated on CI

The native integration deploys as soon as the push lands, in parallel with `ci`, so a red commit can reach Production. This cannot be closed from the repository without owner credentials:

- `vercel.json` `git.deploymentEnabled` only switches deployments on or off per branch; it cannot wait for a check.
- `ignoreCommand` runs inside the Vercel build before CI has finished, and querying GitHub for the result needs a token (or a public repo plus a race against CI). A script that "waits for CI" would need a stored secret, so none was added.

Pick one (owner-only):

1. **Vercel Deployment Checks (preferred if available on the plan).** In the Vercel project settings, add the GitHub checks `gates` and `e2e-production` as required deployment checks so a Production deployment is promoted only when they pass. UI wording and plan availability were not verified here.
2. **CI-gated CLI deploy.** (a) Add repo secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. (b) In the Vercel project, turn off automatic Production deploys from Git (or set `"git": { "deploymentEnabled": { "main": false } }` in `vercel.json`, which is a repo change and takes effect on merge). (c) Enable the `deploy` workflow in GitHub Actions. From then on `deploy.yml` deploys only after `ci` succeeds on `main`.

Until one of these is done, treat a merge to `main` as an immediate deploy and merge only green PRs (branch protection requiring `gates` and `e2e-production` is the practical gate).

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

- **Gate Production deploys on CI** — see the options in section 3 (Vercel
  Deployment Checks, or the secrets plus `deploy.yml` route). Not doable without
  dashboard or secret access.
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
