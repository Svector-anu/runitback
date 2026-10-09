# Ship brief (M9) for Epoch

Goal: shipping RunItBack is automatic, gated and verified, with no manual deploys.

State today: Vercel project `runitback` (alias runitback-three.vercel.app), deployed by hand; Deployment Protection is ON (login required); the last deploy predates faces, true LUFS and the measured-numbers prompt rule. CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit, eval, build, e2e on every push and PR.

Orders to spec (smallest first, each one PR):
1. Auto-deploy: deploy `main` to Vercel only after CI is green. Prefer Vercel's GitHub integration; otherwise a GitHub Action using `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` secrets. List exactly which secrets or dashboard steps only the OWNER can do. Never write a secret into the repo.
2. Production-build e2e: `e2e/media.ts` imports mediabunny from the dev server path `/node_modules/.vite/deps/mediabunny.js`, so e2e cannot run on a built bundle. Make media generation work against `vite preview` and add a CI job that runs a core subset (import, edit, export) on the production build.
3. Post-deploy smoke: after deploy, a job loads the live URL headlessly, creates a project and confirms the editor mounts, fails the workflow if not. (Protection on means it needs the Vercel bypass token secret; owner adds it.)
4. Agent panel UX: show a clear "API key required" message when no key is set (the panel currently only disables Send).
5. First-run onboarding: a short, dismissible first-run hint on an empty editor pointing at Import, Transcribe, Index visuals and the agent.
6. Release checklist doc `docs/RELEASE.md` including the steps that need the owner (secrets, making the site public, rotating keys).

Owner-only: secrets, Vercel dashboard changes, turning off Deployment Protection (making the site public), anything about money or keys.
Constraints: follow CLAUDE.md; no new dependency without checking `docs/research/07-oss-reuse-audit.md`; every order has tests.
