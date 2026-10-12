# First-time-user UX audit

Method: real Chrome (Playwright `channel: 'chrome'`, 1440x900 and 1280x720), landing page to finished export, as someone who has never seen the app. Test footage: a 7 s screen clip. Screenshots live in `e2e/.artifacts/ux/` (git-ignored, and **wiped by every `playwright test` run**; regenerate by re-running the audit flow). `NN-*.png` are the audit (before fixes), `ux-NN-*.png` are written by `e2e/ux-guidance.spec.ts` (after fixes).

Console: no errors or warnings in the normal flow. The only error is the expected `401` when a fake API key is sent. Nothing crashed; the export produced a valid 1902x1080 MP4 with audio (`17-export-done.png`).

## Findings

Status: **Fixed** = fixed in this change and covered by a test, **Open** = not fixed.

### P0

| # | Finding | Evidence | Status |
|---|---|---|---|
| P0-1 | **Typing an API key by hand destroys the field.** The settings collapse the moment the first character is stored, the input unmounts, and only `s` is saved. Pasting worked, which hides it. Reads as "the agent is broken". | `21-agent-typed-key.png` | Fixed: the panel collapses only after 0.9 s without typing. |
| P0-2 | **Agent panel unusable on common screens.** At 1280x720 (and 1440x900 with no key) the message box, Send and Done are clipped with no scrolling; the "Describe an edit" text is scrolled out of view. | `04-agent-nokey.png`, `23-agent-1280x720.png` | Fixed: panel scrolls, log keeps a minimum height (`ux-11-agent-key-help.png`). |

### P1

| # | Finding | Evidence | Status |
|---|---|---|---|
| P1-1 | Landing never says what the first click does, that Chrome is needed, that you must bring your own Anthropic key, or how it works. "Start editing" lands on an empty "No projects yet" page that needs a second click. | `01-landing.png`, `02-after-start-editing.png` | Fixed (copy, facts row, 5-step how-it-works). The extra click on the projects page remains, see P2-1. |
| P1-2 | Assets header clips the **Import** button ("Imp") at 1440 wide; the primary first action is half hidden. | `03-empty-editor.png` | Fixed: header wraps. |
| P1-3 | Four unlabeled glyphs appear on a tile only on hover (search, captions, wand, plus) with no tooltips. Nobody can tell wand from search. | `07-tile-hover.png` | Fixed: tooltips that say what each does. |
| P1-4 | After clicking a tile's `+`, focus stays on that hidden button, so pressing Space (play) adds the clip again. Three clips from one click and two Space presses. | `13-after-split-key.png` | Fixed: mouse clicks release focus. Keyboard activation unchanged. |
| P1-5 | Understand is unexplained: no hint of what it does, what Queued / Partial / Understood mean, or that it downloads 206 MB. The consent dialog appears with no reason given. | `08-understand-consent.png` | Fixed: one-time intro card with sizes, local-only and a status legend; dialog says why it asks. |
| P1-6 | Agent panel: no link to get a key, no cost statement, model choice unexplained, "Ask before editing" unexplained, plan card jargon ("Tools: insert_media") with no first-time explanation. | `04-agent-nokey.png` | Fixed: "Where do I get a key?" link, who pays, model blurb, toggle tooltip, one-time plan card tip. |
| P1-7 | Empty timeline is a dashed strip with no words; empty Assets says only "Drag and drop". | `03-empty-editor.png` | Fixed (`ux-07-empty-editor.png`). |
| P1-8 | Keyboard shortcuts hidden inside the logo menu; no help anywhere. | `24-project-menu.png` | Fixed: visible `?` Help menu (tour, shortcuts, tips, key link). |
| P1-9 | Most icon-only buttons have an aria-label but no visible tooltip (project menu, list/sort, play, zoom, fullscreen, track mute/hide, scenes, dismiss). | audit6 DOM scan | Fixed: `Button` shows a tooltip from its `label`; raw buttons wrapped. |

### P2

| # | Finding | Status |
|---|---|---|
| P2-1 | "Start editing" goes to the projects list instead of straight into an editor. | Open: `landing-app-split.spec.ts` pins `/app`; needs a product decision. |
| P2-2 | Disabled Export gives a native `title` only. | Fixed: visible tooltip "Add a clip to the timeline to enable export". |
| P2-3 | Agent errors print the raw API JSON (`401 {"type":"error",...}`, `22-agent-fake-key-error.png`). | Open: message is built in `src/app/agent` (out of scope). |
| P2-4 | `S` (split) at a playhead with no clip under it does nothing and says nothing. | Open: action layer is in `src/app`. |
| P2-5 | The old banner used jargon ("Index visuals") and its removal shifts the layout up. | Reworded; shift remains. |
| P2-6 | Trim handles only appear on hover and nothing says clips can be trimmed. | Mitigated by the first-clip tip and the tour. |
| P2-7 | Understand chip states (Partial reason) are only in a native `title`; states were not observable without downloading models. | Open. |
| P2-8 | Assets header wraps to two rows in the default width. | Open: works, not pretty. |

### P3

- Export success toast does not say the file went to Downloads (tour step says it).
- Default project name "New project" while the library creates "Untitled Project" elsewhere.
- Preview is black until a clip is placed; the message "Add media to the timeline to see it here" is accurate, no change.
- A 4 s toast is easy to miss for the upload confirmation.

## What was added

- Guided tour: five non-blocking coach marks (Import, Understand, Agent, Timeline, Export). Auto-opens once for a first-time person, then never; reopened from the `?` Help menu. Esc, Left/Right, focus moves to Next and returns, reduced motion respected. Prefs: `tour-seen`. Skipped for automated browsers (`navigator.webdriver`) unless the URL has `?tour`, so the demo and real-model runs are not covered by a card.
- One-time hints (pref `hints-seen`, reset by Help > Show tips again): first clip tip, Understand intro, plan card explanation.
- Always-on empty states: Assets drop zone, timeline.
- Tooltips everywhere an icon stands alone; landing page rewrite.
- Tests: `tests/ui-guidance.test.ts` (stores, placement), `e2e/ux-guidance.spec.ts`.
