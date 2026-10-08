# RunItBack

A free, private, in-browser video editor: multi-track timeline, preview that renders the real composition, keyframes, text, graphics, masks, blur, captions import, undo/redo, autosave, and MP4/WebM export. Media never leaves the browser.

Built from a source-level analysis of [OpenCut](https://github.com/OpenCut-app/OpenCut) and [opencut-classic](https://github.com/OpenCut-app/opencut-classic) (see `docs/`). Not a copy: the engine is a new, pure TypeScript implementation.

```sh
pnpm install
pnpm dev
```

## Agent

The editor exposes its whole edit surface as typed tools: an in-app chat agent (your own Anthropic key, stored only in this browser) and an MCP server (`docs/AGENT_MCP.md`) let Claude cut, caption, reframe and re-pace footage, with one agent turn = one undo step. Perception (silence, loudness, beats, scene cuts), reference-style matching, local speech transcription and a per-asset temporal index back those tools. Quality is tracked by `pnpm eval` (`docs/EVALS.md`).

## Privacy

Media, projects and transcripts stay in this browser (IndexedDB/OPFS). No analytics, no accounts. The only network traffic is what you start yourself: the one-time speech-model download from Hugging Face when you press Transcribe, and requests to api.anthropic.com with your own key when you use the in-app agent (frames and summaries you ask it to look at are sent there). See `docs/ARCHITECTURE.md`.

## Deploying

`pnpm build` produces a static site in `dist/` (hash routing, no server needed). `vercel.json` is included. The speech runtime ships a ~26 MB wasm file, which exceeds Cloudflare Pages' 25 MiB per-file limit; use Vercel, Netlify, GitHub Pages or any static host.

Use a Chromium-based browser (WebCodecs + OPFS). See `CLAUDE.md` for architecture and conventions, `docs/IMPLEMENTATION_AUDIT.md` for what is and is not implemented.
