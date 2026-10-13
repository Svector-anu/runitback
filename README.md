# RunItBack

**Tell your video editor what to do.**

RunItBack is an open-source video editor that runs entirely in your browser, with an AI agent built in. Import your clips, describe the edit in plain words ("cut the dead air", "make it vertical and keep the speaker centred"), review the plan the agent proposes, and export an MP4 or WebM. Your media never leaves your machine, and every agent turn is a single undo step.

**Status: beta.** The editor core is built and heavily tested; the agent's quality with a real model is still being measured. See [Status](#status).

<!-- Screenshot slot: add public/landing/hero.webp (or a GIF of "tell the agent, review the plan, export") and reference it here once the landing assets land. -->

[⭐ Star the repo](https://github.com/Svector-anu/runitback) if you want to follow along.

## Why

Most capable video editors are proprietary: closed source, tied to accounts, and built around uploading your footage to someone else's servers. RunItBack is an open alternative to proprietary editors such as CapCut. It aims for the same everyday workflow (timeline, text, transitions, filters, captions, export) with different trade-offs: the source is MIT-licensed, projects and media stay in your browser's storage, there are no accounts, and the whole edit surface is exposed as typed tools so an AI agent can drive the same commands you do.

It does not match every feature of those editors. [`docs/CAPCUT_PARITY.md`](docs/CAPCUT_PARITY.md) lists what exists and what is still missing.

> CapCut is a trademark of its owner; RunItBack is not affiliated with, endorsed by or sponsored by it.

## Features

Built and covered by tests (see [`docs/FEATURE_MATRIX.md`](docs/FEATURE_MATRIX.md) and [`docs/IMPLEMENTATION_AUDIT.md`](docs/IMPLEMENTATION_AUDIT.md) for the full, honest list):

- Multi-track timeline: split, trim, move, ripple, snapping, bookmarks, keyframes, multiple scenes, undo/redo, autosave.
- Preview that renders the real composition, shared with export (one frame plan, one compositor).
- Text (stroke, shadow, background, animation presets), shapes, masks, blur, colour adjust and eight filters, crop, freeze frame, speed with optional pitch preservation, seven transitions.
- Captions import (SRT/ASS) and local speech transcription (Whisper) with transcript search and delete-by-sentence.
- MP4 (H.264/AAC) and WebM (VP9/Opus) export, run in the browser with WebCodecs.
- Templates: eight original templates (product launch, kinetic announcement, feature callouts, before and after, numbered list, testimonial, talking head with captions, metric reveal) in a gallery at `/templates`, applied in one undo step from the editor, the Projects page or the agent. Importing or saving your own template in the app is not built yet ([`docs/TEMPLATES.md`](docs/TEMPLATES.md)).
- Agent layer: an in-app chat agent and an MCP server over the same typed tools, with plan-then-approve, local perception (silence, loudness, beats, scene cuts), a per-asset temporal index, visual search (CLIP) and face detection (MediaPipe).

In progress or known gaps (stated plainly):

- The in-app agent's quality with a real model is not yet measured end to end; the scripted evals pass, the real-model run is partial ([`docs/EVALS.md`](docs/EVALS.md), [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md)).
- Word-level caption styling is data plumbing only. Stickers, speed curves, chroma key, background removal and audio effects do not exist yet.
- Long media and large projects are untested; whole-timeline audio mixing happens in memory.
- Safari is the least capable browser: canvas filters (blur, colour adjustments) do not render there. See [Browser support](#browser-support).

## Quick start

```sh
pnpm install
pnpm dev
```

Open http://localhost:5173 in a current **Chrome** or Edge for the full feature set (see [Browser support](#browser-support)). Requires Node 22 and pnpm.

```sh
pnpm build    # typecheck + production bundle in dist/ (static, no server needed)
```

## Browser support

The editor needs WebCodecs (video decode and encode) and IndexedDB; the rest degrades with a notice in the editor.

| Browser | Status |
|---|---|
| Chrome / Edge (desktop, current) | Supported: everything works, MP4 (H.264/AAC) and WebM export. |
| Firefox (desktop, 155 tested) | Supported with one difference: no AAC encoder, so MP4 exports carry Opus audio. |
| Safari (WebKit 26.6 tested) | Partial: edit, preview and export work, but canvas filters (blur, colour adjustments, sharpen) do not render. |
| Mobile browsers | Limited; see the in-app notice. |

Versions tested, the per-feature matrix and the fallbacks are in [`docs/BROWSERS.md`](docs/BROWSERS.md).

## Bring your own key, and privacy

The in-app agent calls the Anthropic API with **your own key**. Paste it into the agent panel; it is stored only in this browser's `localStorage` and is never sent anywhere except `api.anthropic.com`. There is no RunItBack server, no accounts and no analytics.

What stays local: media, projects, transcripts and the temporal index live in your browser (IndexedDB and OPFS). Editing, preview and export run on your device.

The only network traffic is what you start yourself:

- **Anthropic API** (`api.anthropic.com`) when you use the in-app agent with your key. Text, plus any frames or analysis summaries you ask the agent to look at, are sent there.
- **Hugging Face** (`huggingface.co` and its CDN) the first time you opt in to transcription or visual search, to download the Whisper or CLIP model. Models download only after explicit consent and are cached in the browser.
- **A loopback WebSocket** (`ws://127.0.0.1`) only if you start the MCP server and click Allow.

The hosted build enforces this with a Content Security Policy; details and residual risks are in [`docs/SECURITY.md`](docs/SECURITY.md). Keep in mind that a key in `localStorage` is only as safe as the code on the page.

## Agent and MCP

The editor exposes its edit surface as typed tools (times in seconds, ids not pixels). One agent turn is one undo step, and larger edits go through a plan you approve first. Read [`docs/AGENT_FLOW.md`](docs/AGENT_FLOW.md) for the flow.

External agents (Claude Code, Claude Desktop, any MCP client) can drive the project open in your tab:

```sh
claude mcp add runitback -- pnpm --dir /path/to/repo exec tsx tools/mcp/server.ts
```

Nothing connects until you click Allow in the editor. Setup and the tool list: [`docs/AGENT_MCP.md`](docs/AGENT_MCP.md).

## Evals

Agent quality is tracked by scored briefs with exact ground truth, oracles that must pass, and mutations (plausible wrong solutions) that must fail:

```sh
pnpm eval                              # scripted, no network, deterministic: the CI gate
ANTHROPIC_API_KEY=... pnpm eval:real   # real model, report only (costs money)
```

See [`docs/EVALS.md`](docs/EVALS.md).

## Architecture

Layers import downward only, enforced by a test: `engine` (pure, headless) <- `render` <- `platform` <- `export` <- `app` <- `ui`. Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the product spec is [`docs/RECONSTRUCTION_SPEC.md`](docs/RECONSTRUCTION_SPEC.md) and the current state is [`docs/PRODUCT_MAP.md`](docs/PRODUCT_MAP.md). Performance measurements: [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

## Status

Beta. Expect rough edges, changing file formats (project schema migrations are additive) and an agent that is useful but not yet proven. Please file bugs, especially with real footage. Known limitations are listed in [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md).

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, the gates a change must pass and the layering rules, and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Security issues: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE). RunItBack was reconstructed from the behaviour and design tokens of [OpenCut](https://github.com/OpenCut-app/OpenCut) and [opencut-classic](https://github.com/OpenCut-app/opencut-classic), both MIT; credits and third-party licences (including MPL-2.0 `mediabunny`, the bundled Inter font and the models downloaded at runtime) are in [`NOTICE.md`](NOTICE.md) and [`docs/LICENSING.md`](docs/LICENSING.md).

If RunItBack is useful to you, [⭐ star the repo](https://github.com/Svector-anu/runitback).
