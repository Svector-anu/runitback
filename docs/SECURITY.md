# Security posture

Scope: the hosted static app (Vercel). Everything runs in the browser; there is no server of ours. Review source: `docs/research/09-architecture-review.md` (P0-3, P1-7, P1-9).

## Content Security Policy

`vercel.json` is the single source of truth. `vite preview` serves the same headers (plugin `runitback:vercel-headers` in `vite.config.ts`), so `e2e/csp.spec.ts` tests what Vercel sends. The dev server sends no CSP (HMR and React Refresh need inline script and a websocket).

| Directive | Value | Why |
| --- | --- | --- |
| `default-src` | `'self'` | Deny by default. |
| `script-src` | `'self' 'wasm-unsafe-eval'` | Own bundles only, no inline script, no `eval`. `wasm-unsafe-eval` lets ONNX Runtime and MediaPipe compile WebAssembly. |
| `worker-src` | `'self' blob:` | Module workers are own-origin files. `blob:` is kept for libraries that spawn blob workers (the CSP e2e uses one as a probe); the app's own workers do not need it, so tightening it is a candidate follow-up. |
| `style-src` | `'self'` | Bundled CSS and `/fonts/inter.css`. React writes styles through the CSSOM, which CSP does not block (verified: no violations). |
| `img-src` | `'self' data: blob:` | Favicon is a `data:` URI; thumbnails and frames are blobs. |
| `media-src` | `'self' blob:` | Imported media plays from object URLs. |
| `font-src` | `'self'` | Inter is self-hosted. |
| `connect-src` | `'self' blob: https://huggingface.co https://*.hf.co https://api.anthropic.com ws://127.0.0.1:* ws://localhost:*` | Model downloads (hub, then redirect to `us.aws.cdn.hf.co`, recorded in a real run; `*.hf.co` covers the CDN host names), the in-app agent, and the opt-in local agent bridge (`ws://127.0.0.1:<port>`). `blob:` is for `fetch(objectUrl)`. |
| `object-src` | `'none'` | No plugins. |
| `base-uri` | `'self'` | Blocks `<base>` injection. |
| `form-action` | `'self'` | No form can post elsewhere. |
| `frame-ancestors` | `'none'` | No framing (clickjacking). |

Other headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.

### The one exception: `'unsafe-eval'` on the MediaPipe workers (face and segmenter)

The background-removal worker (`src/platform/segmentation/face-worker-segmenter.ts`, emitted as `/assets/face-worker-segmenter-*.js`) uses the same loader matches the existing `/assets/face-worker-` carve-out in `vercel.json` (no config change); nothing else does. The rest of this section describes the face worker and applies to both.


MediaPipe's WASM loader is a classic script that defines a global factory. A module worker cannot `importScripts`, so `src/platform/visual/face-worker.ts` runs it with an indirect eval. Without `'unsafe-eval'` the face stage fails with "Evaluating a string as JavaScript violates the following Content Security Policy" (reproduced). A worker's CSP comes from its own script response, so `vercel.json` gives `/assets/face-worker-*.js` (and only it) `'unsafe-eval'`; the document, and every other script, stay strict. A test asserts this split (`tests/supply-chain.test.ts`, `e2e/csp.spec.ts`). The worker has no access to `localStorage` (where the agent key lives). Follow-up that removes the exception: ship a module-wrapped copy of the loader in `public/mediapipe/wasm`.

### Worker detail: `env.useWasmCache = false`

transformers.js by default re-wraps the ORT loader in a `blob:` URL and imports it. That needs `blob:` in `script-src`, which would defeat the policy. Both model workers set `env.useWasmCache = false` so ORT imports `/assets/ort-*.mjs` directly. Found by running the real models under the CSP (the first run failed with "Failed to fetch dynamically imported module: blob:").

### Gateways

The browser UI builds only the Anthropic client (`docs/PROVIDERS.md`), against `api.anthropic.com`; there is no in-app base-URL setting. A self-hoster who points a build at a gateway must add that origin to `connect-src` in `vercel.json`. The OpenAI-compatible client is used by evals and tools only, not in the browser.

### Surplus Intelligence (media generation)

`connect-src` also lists `https://api.surplusintelligence.ai`, used only by the Generate tab and the agent's `generate_media` tool (`docs/GENERATE.md`). What goes there: the model catalog request (public, no key), and, when the user presses Generate, the prompt, the chosen model and options with the user's own `inf_` key in the `Authorization` header. The prompt is therefore sent to a third party (Surplus and the model provider it routes to); the UI says so next to the key field and the Generate button. Nothing from the project (media, timeline, transcripts) is sent, and nothing is sent before a key is saved. The key is stored like the Anthropic key (`runitback:surplus-api-key`, `platform/prefs.ts` only) with the same residual risk below.

Not covered by the allow-list, and honest about it: a finished video or audio job is downloaded from the artifact URL the gateway returns. For Surplus-hosted artifacts that is `api.surplusintelligence.ai` itself, but the gateway may answer with a 302 to short-lived storage or a provider-hosted URL on another host, and a redirect target is also checked against `connect-src`. Those hosts were not verified (no real generation was run), so a redirect to an unlisted host (or to a host that does not answer CORS for the `Authorization` and `X-Job-Token` headers) fails with "Could not download the finished file" instead of silently widening the policy. Images and speech return their bytes in the response and need no extra host. If a real run shows the storage host, add that one origin to `vercel.json` as a reviewed change.

## Verification and its limits

`e2e/csp.spec.ts` (run with `PLAYWRIGHT_TARGET=production`, part of the `e2e-production` CI job):

- header assertions on the document and on each built script;
- controls proving the recorder works: a blocked inline script, third-party stylesheet and third-party fetch each produce a `securitypolicyviolation`;
- `connect-src` probes from the page and from a blob worker (hub, CDN host, Anthropic and the Surplus gateway reachable; `example.com` blocked, violation seen in the worker scope);
- create, import, edit, play, reload with no violations and no third-party response;
- Understand with the real workers and the hub stubbed: the face detector runs under the CSP;
- opt-in `REAL_CSP=1`: real Whisper and CLIP download and run (ONNX Runtime WASM) under the CSP, ending "Understood", with zero violations, hosts `huggingface.co` and `us.aws.cdn.hf.co` only.

Not verifiable from Playwright: violations raised inside real (non-blob) workers are not delivered to the page recorder. They are covered indirectly (a blocked request or script makes the stage fail, and the real run ends "Understood"). WebGPU execution was not exercised (headless Chromium).

## Local agent bridge pairing

The optional bridge (`tools/mcp`, `src/platform/agent-bridge*.ts`, `src/platform/agent-pairing.ts`) lets Claude Code drive the editor. The MCP server listens on `127.0.0.1:7777` (up to 7781) only. The editor page probes those ports only while the Claude Code card is open and exchanges a 6-digit code for the long session token. Opt-in: no server runs unless the user runs the command, and nothing connects without a code or an Allow click.

Controls, all enforced by the server (`tools/mcp/bridge-server.ts`, `tools/mcp/pairing.ts`):

- Loopback bind and `Host` check (blocks LAN access and DNS rebinding).
- Origin allowlist at the WebSocket upgrade: loopback origins plus exact-match `--allow-origin` entries; everything else gets HTTP 403 before any frame is read, so a hostile site cannot even probe or guess.
- Pairing code: 6 random digits from `crypto.randomInt`, one live code at a time, single use, expires after 2 minutes, dies after 3 wrong tries (a fresh code needs a user action in Claude Code), asking again does not reset tries or the deadline, bound to the origin of its first attempt (another origin fails and burns a try), pairing needs an `Origin` header (non-browser clients cannot pair), one attempt per socket, constant-time compare.
- Visibility: wrong attempts are logged to the server's stderr and `show_pairing_code` / `editor_status` warn the user in Claude Code when wrong attempts were made.
- The session token (24 random bytes) is compared in constant time and is never sent to a socket that did not present a valid code or token. The old link path stays as an advanced fallback.

What a malicious web page could try, and the outcome:

| Attack | Outcome |
| --- | --- |
| A page on `https://evil.example` probes or connects to `ws://127.0.0.1:7777` | Refused with 403 at the upgrade; the page learns nothing (Chrome's Local Network Access prompt also gates this for public sites). |
| Same, from a page whose origin the user allowlisted | Allowlisting is full trust in that origin; only allowlist origins you control. |
| Guessing the 6 digits | 3 tries per code, so a success chance of at most 3 in 1,000,000 per code, and only while a code is live (2 minutes after the user asked for one). Burning a code costs the attacker nothing but the user must ask for a new one; the failed attempts are reported in Claude Code. |
| Replaying a seen code | Single use and expired after 2 minutes. |
| A local process without an `Origin` header | Cannot pair (it can already read the user's files, so the token on the stderr line of the same process is no extra power). |
| Pairing from a different origin than the one that started | The code is bound to the first origin that tries it; a second origin fails and burns a try. |
| Reading the token from the address bar or storage | The token is never put in the URL by pairing and is never stored; links carrying it are scrubbed on read. |

Residual risk: any other web page served from `localhost` / `127.0.0.1` (another dev server on the same machine, for example `http://localhost:3000`) is a loopback origin and passes the allowlist. Such a page that guesses a live code within 3 tries (and only during the 2-minute window) gets the token and can drive the editor tool set (read the project, edit, export; no filesystem access, no API key). The Allow click is page UI, not a server check, so it does not stop a hostile local page. Mitigations: tiny window, 3 tries, visible warning in Claude Code, and the user closing Claude Code's server ends the session. Typing the code in the card is treated as consent, so pairing connects immediately. A bridge that exists only in a terminal session with Claude Code is the user's own process; a stronger option (not built) is a per-origin pairing prompt in the terminal.

## Residual risks

- The Anthropic API key is in `localStorage` (`runitback:agent-api-key`), and so is the optional Surplus key (`runitback:surplus-api-key`), which can spend the user's prepaid credit. The CSP makes third-party script injection hard but does not protect against a bug in our own code. For a hosted product with other users, move the key behind a thin proxy.
- `connect-src` allows `https://api.anthropic.com` for anyone, so injected own-origin code could still send data there. Acceptable only because no third-party code runs.
- `ws://127.0.0.1:*` lets the page talk to any local websocket server; the bridge itself requires an explicit user grant (`docs/AGENT_MCP.md`).
