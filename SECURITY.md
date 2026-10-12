# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue or pull request for them.

Use GitHub's private vulnerability reporting: on the repository go to **Security**, then **Advisories**, then **Report a vulnerability** (https://github.com/Svector-anu/runitback/security/advisories/new). Include what you found, steps to reproduce, the affected version or commit and the impact you expect.

You can expect an acknowledgement and a first assessment from the maintainers; this is a small beta project, so response times are best effort. Please give us a reasonable window to fix an issue before disclosing it.

## Scope

RunItBack is a static, local-first app: there is no server of ours, no accounts and no analytics. In scope are the editor code, the bundled build and its Content Security Policy, the in-app agent and its handling of the user's API key, and the MCP bridge. Out of scope are vulnerabilities in third-party services or in dependencies that are not exploitable through RunItBack (report those upstream).

## Security posture

The CSP, the one `'unsafe-eval'` exception on the face worker, how the API key is stored and the residual risks are documented in [docs/SECURITY.md](docs/SECURITY.md). Supply-chain controls are in [docs/SUPPLY_CHAIN.md](docs/SUPPLY_CHAIN.md).

If you use the in-app agent, use a key with a spending limit and never share a build that has your key in its browser storage.
