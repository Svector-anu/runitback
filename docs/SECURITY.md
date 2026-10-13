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

## Verification and its limits

`e2e/csp.spec.ts` (run with `PLAYWRIGHT_TARGET=production`, part of the `e2e-production` CI job):

- header assertions on the document and on each built script;
- controls proving the recorder works: a blocked inline script, third-party stylesheet and third-party fetch each produce a `securitypolicyviolation`;
- `connect-src` probes from the page and from a blob worker (hub, CDN host, Anthropic reachable; `example.com` blocked, violation seen in the worker scope);
- create, import, edit, play, reload with no violations and no third-party response;
- Understand with the real workers and the hub stubbed: the face detector runs under the CSP;
- opt-in `REAL_CSP=1`: real Whisper and CLIP download and run (ONNX Runtime WASM) under the CSP, ending "Understood", with zero violations, hosts `huggingface.co` and `us.aws.cdn.hf.co` only.

Not verifiable from Playwright: violations raised inside real (non-blob) workers are not delivered to the page recorder. They are covered indirectly (a blocked request or script makes the stage fail, and the real run ends "Understood"). WebGPU execution was not exercised (headless Chromium).

## Residual risks

- The Anthropic API key is in `localStorage` (`runitback:agent-api-key`). The CSP makes third-party script injection hard but does not protect against a bug in our own code. For a hosted product with other users, move the key behind a thin proxy.
- `connect-src` allows `https://api.anthropic.com` for anyone, so injected own-origin code could still send data there. Acceptable only because no third-party code runs.
- `ws://127.0.0.1:*` lets the page talk to any local websocket server; the bridge itself requires an explicit user grant (`docs/AGENT_MCP.md`).
