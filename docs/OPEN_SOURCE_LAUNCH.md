# Open-source launch checklist (owner)

Prepared 2026-10-12 against `origin/main` at `88bd66d`. Nothing here has been committed, pushed or published: the files below sit uncommitted in the worktree `/Users/mac/Desktop/coding/oss-oss`. Licence: MIT (`LICENSE`, `NOTICE.md`, `docs/LICENSING.md`).

## 1. Before you flip visibility

1. Review and commit the launch files (one commit is reasonable, `docs: open-source launch files (MIT licence, notices, contributing, templates)`): `LICENSE`, `NOTICE.md`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/*`, `.github/PULL_REQUEST_TEMPLATE.md`, `package.json` (metadata only), `.gitignore` (env/secret patterns), `docs/LICENSING.md`, `docs/OPEN_SOURCE_LAUNCH.md`.
2. **Fill in the Code of Conduct contact.** `CODE_OF_CONDUCT.md` still says `[INSERT CONTACT METHOD]` under "Enforcement". Put a real address or a GitHub-based method there; nothing was invented.
3. Decide on the internal-process docs below (keep, trim or move).
4. Confirm the licence items in `docs/LICENSING.md` ("Remaining owner actions"): BlazeFace and the two Hugging Face model repos could not be verified from here.
5. Merge or discard the work-in-progress in your main checkout first. The main checkout has many uncommitted changes and an untracked `dejavu/` folder (media, unrelated, ignored here). Only commits on `origin/main` become public; `dejavu/` must never be staged (do not use `git add -A` there).

## 2. Secret and history scan (done)

Scope: all 99 commits on every ref (`git log --all`, which includes the remote `ai/*` and `epoch/*` branches), plus the `origin/main` tree and the main checkout's working tree including untracked files (excluding `node_modules`, `dejavu/`, build output).

| Check | Result |
| --- | --- |
| `git log --all -p -G` for `inf_`, `sk-`, `sk-ant-`, `ghp_`, `gho_`, `github_pat_`, `AKIA`, `AIza`, `xox*-`, `PRIVATE KEY` | Hits only in tests, docs and UI placeholders: `sk-ant-test`, `sk-ant-test-12345`, `sk-ant-typed-by-hand`, `sk-ant-api03-SECRETSECRET123`, `sk-test-secret-key-123456`, `inf_abc123`, `sk-proj-abcdefgh1234`, and the placeholder `sk-ant-...`. All are fake fixtures for the secret-redaction tests. No real key found. |
| `.env`, `.pem`, `.key`, `id_rsa`, credentials files ever committed (any ref) | None. |
| Key/token/password assignments with long literal values in the tree | None. |
| CI workflows | Reference `secrets.VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, `VERCEL_AUTOMATION_BYPASS_SECRET` by name only (GitHub encrypted secrets, not values). `deploy.yml` is documented as disabled. |
| Large blobs in history | One: `public/mediapipe/wasm/vision_wasm_internal.wasm` (11.7 MB, Apache-2.0, intended). |
| Media files tracked | None (`mp4/mov/webm/wav/mp3` etc.). `e2e/.artifacts`, `test-results`, `playwright-report`, `evals/reports/*` are gitignored; only `evals/reports/README.md` is tracked. |
| Absolute local paths (`/Users/...`) | None in any tracked file or in the main checkout's working tree (so the earlier concern about `docs/research` paths does not apply to what is on `origin/main`). |

Limits of the scan: pattern-based, not entropy-based; it cannot see secrets stored in GitHub Actions settings, Vercel or your Hugging Face account. As a belt-and-braces step run `gitleaks detect --log-opts="--all"` or `trufflehog git file://. --since-commit ""` yourself (neither was installed here). Rotate any key you have ever pasted into a doc or test, even though none was found.

## 3. Things that are public once you flip visibility

- **Commit authorship**: `Anu <anuoluwakolapo94@gmail.com>`, `svector-anu <anuoluwakolapo94@gmail.com>` and `Aeon <aeonframework@proton.me>` appear in all history. If you do not want that Gmail address public, rewrite history with a `.mailmap` plus `git filter-repo --mailmap` before going public (changes every hash, so do it before anyone forks) or accept it.
- **Branches**: remote branches `ai/auto-deploy-vercel-ci-gated`, `ai/landing-app-split`, `ai/pitch-preserve-live-playback`, `ai/pitch-preserving-time-stretch`, `ai/true-lufs-k-weighting`, `epoch/n5-provider-independence`, `feat/post-deploy-smoke-check` all become visible. Delete the stale ones if you do not want them (`git push origin --delete <branch>`).
- **Internal-process docs** that read as owner/agent workflow rather than product docs. They contain no secrets, but decide if you want them public: `docs/AEON_EPOCH.md`, `docs/SHIP_BRIEF.md`, `docs/ROADMAP.md` (execution plan N1-N10), `docs/PROJECT_STATE.md` and `docs/PRODUCT_MAP.md` (mention the Aeon/Epoch instance `Svector-anu/svectors-lab`), `CLAUDE.md` (agent instructions; useful for contributors, keep), `docs/RELEASE.md` and `docs/SHIP_BRIEF.md` (name the Vercel alias `runitback-three.vercel.app`, which is not secret but is a deployment URL).
- **Research notes** `docs/research/*` (including `repros/*.ts`, reviews and adversarial QA) are candid about bugs and limitations. Fine to keep; they support the "honest status" stance.
- `docs/UX_AUDIT.md` and `docs/E2E_REAL.md` mention screenshots under `e2e/.artifacts/`, which are not committed.

## 4. Make it public

Run these yourself after the checks above (`gh` must be logged in as the owner).

```sh
# visibility (irreversible in effect: forks and caches can persist even if you make it private again)
gh repo edit Svector-anu/runitback --visibility public --accept-visibility-change-consequences

# description, homepage, topics
gh repo edit Svector-anu/runitback \
  --description "Open-source, local-first video editor in your browser with an AI agent. Tell your video editor what to do." \
  --homepage "https://runitback-three.vercel.app"
gh repo edit Svector-anu/runitback \
  --add-topic video-editor --add-topic ai-agent --add-topic mcp --add-topic local-first \
  --add-topic webcodecs --add-topic typescript --add-topic react --add-topic open-source \
  --add-topic video-editing --add-topic claude

# Discussions and security reporting
gh repo edit Svector-anu/runitback --enable-discussions
gh api -X PUT repos/Svector-anu/runitback/private-vulnerability-reporting
gh api -X PUT repos/Svector-anu/runitback/vulnerability-alerts
```

Notes: use your custom domain for `--homepage` if you have one (the Vercel alias above is behind Deployment Protection per `docs/PROJECT_STATE.md`; **turn Deployment Protection off for production or the public link will ask visitors to log in**). `CodeQL`/secret scanning and push protection are free on public repos: enable them under Settings, Code security (or `gh api -X PATCH repos/Svector-anu/runitback -f 'security_and_analysis[secret_scanning][status]=enabled' -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'`). Consider branch protection on `main` (require the `ci` workflow). GitHub Sponsors/`FUNDING.yml`: intentionally none.

## 5. One-line launch checklist

Commit the launch files; fill the CoC contact; remove or keep the internal docs; delete stale branches; run gitleaks; turn off Vercel Deployment Protection; verify the hosted build loads and the README screenshot slot is filled (`public/landing/` belongs to the landing work); flip visibility; add topics, description, homepage; enable Discussions and private vulnerability reporting; star it yourself; post it.
