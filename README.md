# RunItBack

A free, private, in-browser video editor: multi-track timeline, preview that renders the real composition, keyframes, text, graphics, masks, blur, captions import, undo/redo, autosave, and MP4/WebM export. Media never leaves the browser.

Built from a source-level analysis of [OpenCut](https://github.com/OpenCut-app/OpenCut) and [opencut-classic](https://github.com/OpenCut-app/opencut-classic) (see `docs/`). Not a copy: the engine is a new, pure TypeScript implementation.

```sh
pnpm install
pnpm dev
```

Use a Chromium-based browser (WebCodecs + OPFS). See `CLAUDE.md` for architecture and conventions, `docs/IMPLEMENTATION_AUDIT.md` for what is and is not implemented.
