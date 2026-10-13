# Product map: vision vs what exists

Vision: an agent-native video editor, a "Claude for video editors". The agent edits through the same typed commands a human uses, can perceive footage, and every turn is one undo step. Local-first: media stays on the device.

| Capability | State | Evidence / where |
|---|---|---|
| Real editor (timeline, preview, export, persistence) | built, tested | M0; 46 e2e; production build smoke-tested |
| Agent edit tools + MCP bridge | built | `engine/agent`, `tools/mcp`; fuzzed for invariants |
| In-app agent chat | built; quality **unmeasured** | `src/app/agent`; evals run on scripted stand-ins only |
| Perception: silence, loudness (true LUFS), onsets, tempo, scene cuts | built, synthetic ground truth | `engine/analysis`; not cross-checked against an external meter |
| Speech: local Whisper, transcript search/delete/captions | built; real inference run once | `engine/transcript`, `platform/transcribe` |
| Temporal index + find/cut moments | built; never run on real footage in-app | `engine/temporal` |
| Visual search (CLIP) | built; 5/9 top-1 on real footage | `docs/VISUAL_SEARCH.md` |
| Faces (MediaPipe) | detection + storage only; not in index, UI or tools | `platform/visual/face-*` |
| Word-level caption styling | data plumbing only; compositor has no rich text | `CaptionCue.words` |
| Reference-style matching | engine + tools; opt-in | `engine/reference` |
| Templates | engine, 8 templates, previews, agent tools and eval built; fuzzed for invariants; gallery UI separate; count-up, beat sync, speed ramps, device frames not available | `engine/templates`, `src/templates`, `docs/TEMPLATES.md` |
| Evals | 70 scripted policy runs; real-model run **not done** | `evals/`, `docs/EVALS.md` |
| Hosted build | deployed behind Vercel login | Deployment Protection on |
| Speed / pitch | built; export pitch verified on real audio | `e2e/pitch-real-audio.spec.ts`; live playback not measured |

## Biggest unknowns (in order)

1. Does the agent actually edit well with a real model? (needs an Anthropic API key to run `pnpm eval:real`)
2. Do the new tools work in the real app on real footage end to end?
3. Faces and word-styled captions are not yet user-visible.

Process: Epoch plans orders (Aeon instance memory), Aeon or local agents build, Aeon `pr-review` reviews, then merge. Check OSS before building (`docs/research/07-oss-reuse-audit.md`).
