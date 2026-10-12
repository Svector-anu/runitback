## What and why

<!-- What does this change, and why? Link the issue: Closes #123 -->

## How it was verified

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm eval`
- [ ] `pnpm build`
- [ ] `pnpm e2e` (or the relevant specs, noted below)

<!-- Notes on what you ran manually, screenshots or a short recording for UI changes. -->

## Checklist

- [ ] Layering respected (`engine` <- `render` <- `platform` <- `export` <- `app` <- `ui`)
- [ ] Document changes go through `Command`s; one agent turn stays one undo step
- [ ] Schema change has an additive migration and a `PROJECT_SCHEMA_VERSION` bump (or: no schema change)
- [ ] Tests added or updated; no mocked decoder or exporter
- [ ] Docs updated where behaviour changed; in-progress work is marked as such
- [ ] No API keys, tokens or personal media in the diff
