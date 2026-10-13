# 10. Templates feature research

Date: 2026-10-13. Base: `origin/main` @ d26c08a (worktree `/Users/mac/Desktop/coding/oss-tpl`, detached, nothing committed).
Method: curl (HTML, status, X oEmbed), `gh api` for repo metadata, repo READMEs and `data/videos.json` / `cases.json`. Videos were NOT watched frame by frame: archetypes in section 2 are inferred from card titles, durations, aspect ratios and the two collections' categories and tech tags. Structure only; no third-party content is reproduced.

## 1. Link check

### 1.1 notes.apoorv.xyz/launch-videos

HTTP 200, Next.js static page, "Launch videos - Notes by Apoorv". 22 cards. Each card: poster (`poster.webp`), muted looping `preview.mp4` (`preload=none`, lazy), `full.mp4`, duration badge (`0:46`), avatar, `@handle`, "View post" link, an `open-video` button, a per-card play/pause control. All media is served from `notes-media.latheyapoorv.workers.dev` (CORS `*`, immutable cache). Page owner handle: `@apoorveth`. Posters: 960x540 (18 cards), 960x720, 960x528, 960x960 (2).

Post URL status: every `https://x.com/<handle>/status/<id>` returns **HTTP 200 to a plain curl with a browser UA, with and without `-L`**. That is not proof of availability: X serves a JS shell with 200 for any status id, including to logged-out clients. The reliable signal is X's oEmbed endpoint (`publish.twitter.com/oembed?url=...`): it answers 301 -> `x.com` and then **200 with the tweet HTML for the two I followed (Lovable, Polymarket)**; the other 20 returned 301 and I did not follow them all (gap, see 1.4). No login was attempted. Logged-out viewing of a single tweet works on x.com today; replies, threads and some media need login, and X may change that at any time.

| # | Item (card title) | Handle | Duration | Aspect | Post URL | curl status | Publicly viewable (logged out) |
|---|---|---|---|---|---|---|---|
| 1 | Pomelli - a new chapter | @PomelliByGoogle | 1:00 | 16:9 | https://x.com/PomelliByGoogle/status/2056797533792530801 | 200 | shell 200; content not verified |
| 2 | Lovable - Google connectors | @Lovable | 0:46 | 16:9 | https://x.com/Lovable/status/2056751240357580911 | 200 | yes (oEmbed 200) |
| 3 | Jupiter - Offerbook | @JupiterExchange | 0:25 | 16:9 | https://x.com/JupiterExchange/status/2059662628729872407 | 200 | shell 200; not verified |
| 4 | Pump.fun - USDC trading | @Pumpfun | 0:20 | 16:9 | https://x.com/Pumpfun/status/2082869372234747933 | 200 | shell 200; not verified |
| 5 | Aside - a new way to browse | @hyojun_at | 1:27 | 16:9 | https://x.com/hyojun_at/status/2069497198879048131 | 200 | shell 200; not verified |
| 6 | Google AI Studio - pretty URLs | @OfficialLoganK | 0:41 | 16:9 | https://x.com/OfficialLoganK/status/2075598301018337773 | 200 | shell 200; not verified |
| 7 | saviomartin - internet business launch | @saviomartin | 0:25 | 4:3 | https://x.com/saviomartin/status/2055687342812488107 | 200 | shell 200; not verified |
| 8 | azatsol - full video | @azatsol | 0:28 | ~1.82:1 | https://x.com/azatsol/status/2083885284853223814 | 200 | shell 200; not verified |
| 9 | Figma Motion - VeduBoi | @vedu_boi | 1:17 | 16:9 | https://x.com/vedu_boi/status/2070014128807367023 | 200 | shell 200; not verified |
| 10 | Figma - canvas agent | @figma | 1:01 | 16:9 | https://x.com/figma/status/2057084392640843956 | 200 | shell 200; not verified |
| 11 | Whop - payment infrastructure | @organicbond | 0:19 | 16:9 | https://x.com/organicbond/status/2036749097818841498 | 200 | shell 200; not verified |
| 12 | Jumper - private swaps on Base | @jumperapp | 0:08 | 16:9 | https://x.com/jumperapp/status/2075203412611010846 | 200 | shell 200; not verified |
| 13 | Creator Studio - live streaming | @benjitaylor | 0:52 | 1:1 | https://x.com/benjitaylor/status/2072435629548597547 | 200 | shell 200; not verified |
| 14 | Polymarket - five-minute markets | @Polymarket | 0:20 | 16:9 | https://x.com/Polymarket/status/2022343906168623112 | 200 | yes (oEmbed 200) |
| 15 | Husher x Axiom | @AxiomExchange | 0:22 | 16:9 | https://x.com/AxiomExchange/status/2088721197915623455 | 200 | shell 200; not verified |
| 16 | fomo - Ethereum mainnet | @fomo | 0:18 | 1:1 | https://x.com/fomo/status/2060468574007767073 | 200 | shell 200; not verified |
| 17 | Umbra - private payroll | @UmbraPrivacy | 0:50 | 16:9 | https://x.com/UmbraPrivacy/status/2072367388087976112 | 200 | shell 200; not verified |
| 18 | Hunch - trading terminal | @tradeonhunch | 0:57 | 16:9 | https://x.com/tradeonhunch/status/2059685085134135412 | 200 | shell 200; not verified |
| 19 | Brim3nEdits - pacing study | @Brim3nEdits | 0:23 | 16:9 | https://x.com/Brim3nEdits/status/2073159246477209713 | 200 | shell 200; not verified |
| 20 | Print - multi-wallet manager | @printworld | 0:51 | 16:9 | https://x.com/printworld/status/2057520192780194091 | 200 | shell 200; not verified |
| 21 | TROOVY - Hanta Virus | @TROOVY | 0:19 | 16:9 | https://x.com/TROOVY/status/2056112526857797920 | 200 | shell 200; not verified |
| 22 | Jumper Pass - new perks | @jumperpass | 0:16 | 16:9 | https://x.com/jumperpass/status/2056707619180691481 | 200 | shell 200; not verified |

Stats: 22 videos, total 13:45, mean 37.5 s, median ~26 s, range 0:08 to 1:27; 18/22 are 16:9, none vertical. Median is under 30 s: short launch spots dominate.

### 1.2 The two GitHub repos

| Repo | Exists | Stars | Licence | Last push | Structure |
|---|---|---|---|---|---|
| https://github.com/yihui-dev/awesome-opus5-5-videos | yes | 4,746 | MIT (applies to the repo files only) | 2026-10-12 (commit e6c7eee "Add 10 Opus 5.5 videos ...") | `README.md`, `LICENSE`, `data/videos.json` (853 entries: slug, author, post_url, category, tech_tags, prompt, has_remake), `prompts/*.md`. Categories: motion 501, 3d 123, explainer 122, interactive 107. README images/links point at the curator's own site (skillry.dev). |
| https://github.com/zhuyansen/awesome-opus-5.5-video | yes | 166 | **none** (GitHub reports null; README says "inclusion grants no license") | 2026-10-12 (commit 6ebd1b5 "Sync 2026-10-12") | `README.md`, `README.zh-CN.md`, `cases.json` (1,496 works), `cases/*.md` (16 files), `CONTRIBUTING.md`. README hotlinks `pbs.twimg.com` thumbnails (we must not copy that). |

Both are curated indexes of "videos written as code by an LLM" (HTML/Canvas/SVG/Three.js/GSAP/Remotion). They are about AI-generated animation prompts, not launch-video editing. Neither contains video-template files. Their MIT/no licence does not cover the creators' videos or prompts (both READMEs say content belongs to the creators). tech_tags frequency in the yihui set: canvas 357, svg 222, threejs 156, shader 110, gsap 100, css 68, audio 39. Keyword mentions across both datasets: remotion 150, gsap 120, three.js 274, blender 176, elevenlabs 54, hyperframes 67, ffmpeg 71, playwright 41, rive 64, after effects 63; capcut 3, davinci 2, mediabunny / webcodecs 0.

### 1.3 Tools and techniques referenced, with licence and fit for an MIT browser project

Licences read from `gh api repos/<r>` on 2026-10-13. "Usable" = could be a dependency or be studied/ported without licence conflict in an MIT repo that ships to the browser.

| Item | URL | Status | Public? | Relevance to templates | Licence | Usable in MIT browser project |
|---|---|---|---|---|---|---|
| Remotion | https://github.com/remotion-dev/remotion | 63.8k stars, active | yes | programmatic video in React; reference for template-as-code and per-composition props | custom Remotion licence (GitHub: NOASSERTION), free only for individuals / small teams, company licence otherwise | **No as dependency.** Study the idea only. |
| HyperFrames (HeyGen) | https://github.com/heygen-com/hyperframes | 62.2k, active | yes | HTML-to-video compositions; 67 mentions in the datasets; reference for declarative scenes | Apache-2.0 | Yes (compatible; attribution + NOTICE). Heavy; ideas only. |
| Motion Canvas | https://github.com/motion-canvas/motion-canvas | 19.3k, last push 2026-07 | yes | generator-based animation, editor for it | MIT | Yes, but a separate runtime; not needed. |
| Revideo | https://github.com/redotvideo/revideo | 4.1k, last push 2026-07 | yes | Motion Canvas fork with headless render | MIT | Yes; not needed. |
| Theatre.js | https://github.com/theatre-js/theatre | 12.8k, last push 2024-08 (stale) | yes | keyframe timeline UI | Apache-2.0 (core; studio is AGPL in some packages: verify before use) | Not recommended (stale, licence split). |
| lottie-web | https://github.com/airbnb/lottie-web | 32.2k, last push 2025-09 | yes | vector motion templates (stickers, lower thirds) | MIT | Yes, for optional Lottie overlays; needs a render path in `render/`. Later. |
| dotLottie web | https://github.com/LottieFiles/dotlottie-web | 902 | yes | smaller Lottie player | MIT | Yes, alternative to lottie-web. |
| Rive wasm | https://github.com/rive-app/rive-wasm | 985 | yes | interactive vector animation (64 mentions) | MIT | Yes; low priority. |
| GSAP | https://github.com/greensock/GSAP | 29.2k | yes | easing/timeline reference (120 mentions) | no SPDX; GreenSock "Standard No Charge" licence, restricts use in tools that compete with Webflow-style visual animation builders | **Do not depend on it.** Our own `animation` engine already covers keyframes. |
| anime.js | https://github.com/juliangarnier/anime | 73.6k | yes | easing reference | MIT | Yes; not needed. |
| editly | https://github.com/mifi/editly | 5.5k, last push 2025-05 | yes | declarative JSON video spec (clips, layers, transitions, titles); closest prior art for our `ProjectTemplate` JSON | MIT | Yes (read for schema ideas). Node + ffmpeg, not browser. |
| mediabunny | https://github.com/Vanilagy/mediabunny | 7.3k, active | yes | already our decode/encode layer | MPL-2.0 | Already used (see `docs/LICENSING.md`). |
| ffmpeg.wasm | https://github.com/ffmpegwasm/ffmpeg.wasm | 17.9k | yes | not needed; mediabunny covers us. CSP forbids `unsafe-eval` outside the face worker | MIT wrapper (FFmpeg LGPL/GPL builds) | No. |
| react-timeline-editor | https://github.com/xzdarcy/react-timeline-editor | 800 | yes | timeline UI reference | MIT | Not needed; we have a timeline. |
| MoviePy | https://github.com/Zulko/moviepy | 15k | yes | python template scripts | MIT | N/A (not browser). |
| Blender, Three.js, ElevenLabs, Whisper | n/a | n/a | n/a | frequently cited in the collections for 3D, TTS, captions. Whisper already local (`platform/transcribe`). TTS is an external paid API: out of scope under "no network, local-first". | various | Whisper yes (already); others no. |

### 1.4 Gaps in the link check

- 20 of 22 X posts were verified only to the "shell 200" level; the oEmbed endpoint needs one redirect hop and I only followed it for 2. A follow-up should loop `curl -L` on all 22 and record which return a JSON body. Re-run it in CI before shipping the Inspiration section, because tweets get deleted.
- I did not open any post in a browser (no Playwright run) and did not watch the videos.

## 2. Style analysis: 11 reusable template archetypes

Derived from the 22-card set (SaaS/crypto/AI-tool product launches, mostly 16:9, 8 s to 1:27) plus the two collections' categories. Beats are seconds from start for a standard cut of the stated length. "Engine" lists what RunItBack needs; status vs `docs/CAPCUT_PARITY.md` and the agent tool list: OK = present, MISSING = gap.

Common ground across the set: short (median ~26 s) hard-cut or fast-dissolve spots; large sans-serif headline text with one accent colour; screen recordings or UI mock frames as the main visual; a single sustained music bed; end card with logo and a URL/CTA in the last 2-3 s. Pace is set by beats, one idea per 2-4 s.

| # | Archetype | Purpose | Duration | Beats (s) | Text / caption style | Transitions | Music / pacing | User supplies | Engine needs (status) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Product launch, screen recording | announce a feature | 20-45 | 0-3 hook headline over blurred recording; 3-30 three recording segments each with a 1-line caption; 30-38 result shot; 38-45 logo + URL | big bold sans, 1 line, bottom-left, fade/pop in | dissolve or hard cut every 5-8 s | steady bed, cut on downbeat | 3 clips, logo, headline, 3 captions, URL | transitions OK, text animation OK, crop OK (zoom into UI), `apply_filter` OK; animated cursor / click ripple MISSING (use graphic + keyframes by hand) |
| 2 | Kinetic typography announcement | news/teaser with no footage | 8-20 | 0-2 word 1; word-per-beat every 0.6-1.2 s; last 3 s logo | huge centred type, one accent word, pop/typewriter | none or fast slide | rhythmic, cuts on beats | headline words, brand colour, logo, music | text animation OK, `reveal` OK, background colour OK; beat snap MISSING (analysis has beats, no snap UI); per-word timing helper MISSING |
| 3 | Feature highlight with callouts | explain 3 features on one UI | 25-50 | per feature ~8 s: zoom to region (crop/scale keyframes) + callout label + arrow | small label chip with background box, arrow graphic | zoom, wipe between features | calm, build-up | 1 recording, 3 regions + labels | crop OK, keyframes OK, graphic shapes OK, text box OK; arrow/callout presets MISSING; auto zoom-to-region MISSING |
| 4 | Before / after | show improvement | 10-25 | 0-4 "before" clip; 4-5 wipe; 5-12 "after"; 12-15 CTA | two small labels "Before"/"After" | wipe-left/right or split mask | quick sting at the wipe | 2 clips, labels | transitions OK, `split` mask OK; draggable slider wipe MISSING |
| 5 | Listicle / "N things" | numbered tips | 30-60 | intro 3 s; N cards of 6-10 s each with number + title + clip; outro 4 s | big numeral + title, consistent position | slide-left each card | one bed, level SFX per card (MISSING SFX library) | N clips, N titles | text OK, transitions OK; template with variable N needs repeatable groups (data model below) |
| 6 | Testimonial / quote | social proof | 15-30 | 0-3 name/role; 3-22 quote typed over portrait or footage; 22-28 logo | serif quote, large, typewriter | dissolve | soft, slow | portrait or clip, quote, name, role | typewriter OK, mask (circle crop) OK; caption styling presets for speech MISSING |
| 7 | App promo with device frame | show a mobile app | 20-40 | 0-3 headline; 3-30 recording inside a phone frame, 2-3 feature captions; 30-40 store badges | medium sans, centred above device | slide, zoom | upbeat | portrait recording, captions, badge image | mask (rounded rectangle) partial; device frame overlay asset MISSING (we author a frame as graphic shapes + mask), vertical 9:16 canvas OK |
| 8 | Changelog / release notes | weekly update | 30-60 | title card 3 s; each item 6-10 s: bullet title + recording; outro | left-aligned list titles, version chip | hard cut | light bed | recordings, bullet titles, version | OK for all but variable item count (same as 5) |
| 9 | Talking-head with auto captions | creator / explainer | 15-60 | 0-3 hook; body with word-by-word captions; CTA | 2-line, bold, centre-lower third, active word highlight | jump cuts, optional zoom punch-in | speech-led | one talking clip | `transcribe_asset` + `add_captions_from_transcript` OK; word-level highlight styles and caption presets MISSING (CAPCUT_PARITY lists it as a gap); silence removal OK via `delete_spoken_range`/`apply_cut_plan`; reframe-to-face OK (`reframe_to_faces`) |
| 10 | Data / metric reveal | announce a number or milestone | 10-20 | 0-3 context line; 3-9 counter rolls up (keyframed text); 9-15 secondary stat; 15-20 logo | huge numerals, count-up | none | rising swell | numbers, label, logo | numeric count-up MISSING (text content is not keyframeable; workaround: several text clips, or add an animated-number text param); the rest OK |
| 11 | Hype / sizzle montage (pacing study) | trailers, event recaps | 15-30 | cuts on every beat, 0.4-1.2 s shots, speed ramps, flash transitions | minimal, 2-3 words | glitch / flash (MISSING, only 7 transitions) | beat-locked, build then drop | 8-20 clips, music | `plan_cuts_to_style` / `cut_to_moments` OK; beat snap, speed ramps, glitch/flash transitions MISSING |

Feature gap roll-up (ranked by how many archetypes need it): variable-length repeatable groups (5, 8, 11) is a template-format feature, not an engine one; caption style presets with active-word highlight (9, 6); beat snap and beat-synced cut (2, 11); speed ramps/curves (11); extra transitions: glitch, flash, blur (11, 2); count-up text (10); callout/arrow/cursor presets (1, 3); device-frame assets (7).

## 3. Legal and ethics note

What we can show:
- Templates we author ourselves (our own layouts, type, colours, motion), previewed with our own generated media, rendered by our own engine. Published under the repo's licence.
- A text-only "Inspiration" list: creator handle, link to the post, our own one-line description of the structure ("62 s, 16:9, screen-recording with three callouts"), and attribution. No quotation of copy, no scripts, no paraphrased prompts.
- Facts (duration, aspect ratio) are not copyrightable; the selection and arrangement of the source page is theirs, so we make our own list.

What we cannot do:
- Embed, hotlink, copy or re-host their videos, posters or avatars (`notes-media.latheyapoorv.workers.dev`, `pbs.twimg.com`, `media.skillry.dev`). All are third-party media; X's terms also limit embedding outside their widget.
- Reproduce someone's video as a template (shot-for-shot structure with their wording, assets or brand marks), or use brand logos / names as template content (trademarks).
- Show prompts from the collections (the zhuyansen repo has no licence; the yihui repo's MIT applies to the curator's files, not to creators' prompts).
- Run any client-side fetch to these hosts: our CSP (`vercel.json`: `img-src 'self' data: blob:`, `media-src 'self' blob:`, `connect-src` limited to huggingface, anthropic) blocks them, and this is a feature. Do not loosen the CSP for Inspiration; use plain `<a rel="noopener noreferrer" target="_blank">` links.

Recommendation for the gallery "Inspiration" section: ship it as a collapsed, text-only list under the gallery ("Launch-video styles we studied"), each row: our archetype name, 1-line structure note, "View post by @handle" outbound link with the handle and source named ("Collected at notes.apoorv.xyz/launch-videos"), plus an "Open a similar template" button that opens OUR archetype. No thumbnails. Keep links in `src/templates/inspiration.json`, validated by a unit test and a scheduled link check (links rot, tweets get deleted). Ask the collection owner and the poster before listing anyone by name if we want to go beyond the link itself. Do not ship the section until the 22-link verification in 1.4 is done. Fall back to listing only the collection page, not individual posts, if any doubt remains.

## 4. Data model proposal: `ProjectTemplate`

Goals: declarative, versioned, applied only through existing `Command`s via `Editor.execute` (invariant 4), one undo step (like `runAgentTurn`), deterministic, previews generated from the real engine.

```jsonc
{
  "format": "runitback-template",
  "templateVersion": 1,                  // bumped on breaking change; additive fields never bump
  "minSchemaVersion": 5,                 // PROJECT_SCHEMA_VERSION it was authored against
  "id": "launch-screen-recording",       // kebab-case, unique, stable
  "name": "Product launch",
  "description": "...",
  "tags": ["launch", "saas"],
  "archetype": "product-launch",
  "license": "MIT", "author": "RunItBack",
  "canvas": { "preset": "16:9", "fps": 30, "backgroundColor": "#0b0b0f" },
  "duration": { "target": 36, "min": 20, "max": 60 },       // seconds, boundary format
  "slots": [                              // user media
    { "id": "clip1", "kind": "video", "label": "Screen recording 1",
      "expected": { "minSeconds": 3, "maxSeconds": 12, "aspect": "16:9" },
      "required": true, "fit": "cover", "audio": "mute|keep",
      "placeholder": "builtin:gradient-a" }
  ],
  "texts": [
    { "id": "headline", "label": "Headline", "default": "Your headline", "maxChars": 48 }
  ],
  "tracks": [ { "id": "main", "role": "main" }, { "id": "o1", "role": "overlay" }, { "id": "a1", "role": "audio" } ],
  "beats": [                              // timeline, seconds, relative to start; durations may be 'slot' to follow the slot
    { "at": 0.0, "track": "main", "slot": "clip1", "duration": "slot", "transitionIn": { "type": "dissolve", "duration": 0.4 },
      "filter": "vivid", "crop": { "left": 0, "top": 0, "right": 0, "bottom": 0 }, "speed": 1 },
    { "at": 0.2, "track": "o1", "text": "headline", "duration": 3,
      "style": { "fontSize": 96, "fill": "#ffffff", "stroke.width": 0, "shadow.enabled": true },
      "animation": { "in": "pop", "out": "fade" }, "position": { "x": 0, "y": -300 } },
    { "at": 30, "track": "o1", "graphic": "ellipse", "params": { "fill": "#7c5cff" }, "duration": 4 }
  ],
  "repeat": [ { "group": "features", "min": 1, "max": 6, "beats": ["..."], "stride": 8 } ],
  "captions": { "style": { "preset": "bold-lower", "highlight": "active-word" }, "from": "transcript" },
  "audio": { "music": "slot:music|none", "duckUnderSpeech": false },
  "preview": { "poster": "launch-screen-recording.webp", "video": "launch-screen-recording.mp4", "fixtureSeed": 7 }
}
```

Rules:
- Use the real param keys already in the engine (`stroke.*`, `shadow.*`, `crop.*`, `transform.*`, `textAnimation`), validated through the same `param-limits`, `validate.ts` code paths agent tools use. Unknown keys are an error with a hint, as in the agent tools.
- `apply(template, fill)` is a pure planner in `engine/templates/` that returns a list of commands (set canvas/fps, insert media/text/graphic, set_transition, apply_filter, set_crop, set_text_style, set_text_animation, set_speed); the caller runs them in one history step. `fill` = `{ slots: {id: assetId | null}, texts: {id: string}, repeat: {group: n} }`. Empty slots keep a placeholder clip (a flat generated image element) so the layout is visible and still replaceable.
- Timing: slot-relative beats stretch to the supplied clip length (clamped to `expected`); everything else is absolute seconds converted to ticks at the edge (invariant 1). Overlap is handled by the existing "new track or revert" rule, never by the template.
- A template never changes the project schema. If one needs a feature that does not exist (count-up, glitch), it is blocked until the engine ships it (`requires: ["transition:glitch"]` capability list; the gallery greys the card out with the reason).
- Relation to `.runitback`: a template is NOT a bundle. A bundle is a full saved project with media (`manifest.json`, `project.json`, `media/`, `derived/`). A template is a small JSON recipe without media, applied to a project. Two supporting paths: (a) "Save as template" exports a project to template JSON (media becomes slots, text becomes `texts`; the one-way lossy conversion warns about what is dropped); (b) the gallery can ship an optional "starter project" as a `.runitback` bundle with placeholder media for authors who prefer to edit visually. Import of a template JSON from the user is allowed but is data-only (no code, no URLs fetched), size-capped (256 KiB) and validated with the same strict parser.
- Agent tools: `list_templates({ query?, tag?, aspect? })` (read-only; returns id, name, slots, texts, duration, requires), and `apply_template({ templateId, slots: {slotId: assetId}, texts: {id: string}, repeat?, replace?: boolean })` marked `destructive: true` when it replaces a non-empty timeline (needs an approved plan per `plan-scope.ts`), otherwise appends to an empty or new scene. Both live in `src/engine/agent/tools-templates.ts` and register in `registry.ts`. Update `docs/AGENT_MCP.md` and the evals (a scripted policy that fills a template from `list_assets`).
- Files: `src/templates/<id>.json` (source of truth), `src/templates/index.ts` (typed catalogue via `import.meta.glob`), `src/templates/previews/<id>.webp` and `<id>.mp4` (small, committed, generated). Previews are produced by a Playwright script (`tools/render-template-previews.ts`, real Chrome, real engine, fixtures from `e2e/media.ts`): create project, apply the template to generated media, export with the real exporter for the MP4 loop and grab the poster frame. Content-addressed filenames or a `previewHash` in the catalogue so CI can fail when a template changes without regenerating its preview. Budget: poster <= 40 KB webp, loop <= 600 KB at 480p 8 s, because `media-src 'self'` serves them from our origin.
- Tests (project rules: engine tests first; never mock decoder/exporter):
  1. `tests/templates-schema.test.ts`: every `src/templates/*.json` parses, unique ids, all referenced slots/texts exist, all param keys valid, `requires` known.
  2. `tests/templates-apply.test.ts`: apply each template to `makeEditor` with generated assets across slot counts (empty, partial, full, short/long clips, repeat min/max); assert invariants (no overlap, source mapping `trimStart + duration*rate + trimEnd == sourceDuration`, main track starts at 0, ticks are integers), single undo restores the prior document, applying twice is deterministic.
  3. Property/fuzz test: random `fill` inputs never produce an invalid document.
  4. `e2e/templates.spec.ts`: gallery -> apply template to generated media in the page -> play -> export -> decode the output with mediabunny and assert duration within one frame of expected and non-black frames at each beat; plus a CSP test that the gallery makes zero third-party requests (extend `e2e/csp.spec.ts`).
  5. Architecture test already guards layering; `engine/templates` must be DOM-free.

## 5. UI proposal

Routing: `src/app/router.ts` is a hash router (`projects`, `editor/:id`, `not-found`), `/` is the landing page. Add `{ name: "templates" }` at `#/templates` (and a deep link `#/templates/:id`). The reference page is a standalone "/templates" path; a real path would need a `vercel.json` rewrite like `/app` has and an `App.tsx` change, which is more surface for no gain, so start with `#/templates` and link `/templates` -> `/app#/templates` from the landing page. Decide before building.

`/templates` page (`src/ui/pages/TemplatesPage.tsx` + `src/ui/templates/*`):
- Header: back to Projects, title, search, filter chips (aspect: 16:9, 9:16, 1:1; length: <15 s, 15-30, 30-60; archetype), sort.
- Toolbar toggle "Pause previews" (persist via `platform/prefs.ts`, the only localStorage user). Default to paused when `prefers-reduced-motion` or `navigator.connection.saveData`.
- Grid: dark, responsive CSS grid. Card = poster `<img>` (lazy) + `<video muted loop playsinline preload="none">` swapped in on hover/focus/in-view (IntersectionObserver, at most N=4 playing at once, `video.pause()` on leave, resources released on unmount per invariant 9), duration badge (`0:36`), template name, archetype + aspect chips, slot count ("3 clips, 4 texts"), "Use template" button. A card whose `requires` are unmet shows "Needs: glitch transition" disabled.
- Card click opens a dialog/sheet: larger looping preview, slots list with expected length, then a stepper: pick media (from current project assets or drag in), type texts, choose canvas (defaults from template), "Create project" (new project from template, fills slots) or "Add to current project" when launched from the editor.
- "Inspiration" section (collapsed, text-only, see section 3).
- Empty state, keyboard navigation (cards are links/buttons, Enter applies), focus ring, labelled controls; previews have no audio.

Editor entry point: a "Templates" button in `src/ui/editor/Header.tsx` and in the Projects page "New project" menu ("Start from template"); empty-timeline hint in `EditorHints.tsx` ("Start from a template"). Opens the same gallery as a modal filtered to the project's aspect. Agent: chat suggestion "Make a 30 s product launch from these clips" maps to `list_templates` then `apply_template`.

### AI tools panel (CapCut-style one-click tools)

A right-hand panel (or dropdown in the inspector) of one-click buttons. Each runs ONE agent turn (one undo step) with a scripted tool call; no model call unless the user types a prompt. Model downloads stay behind consent (`model-consent.ts`).

| One-click tool | Maps to | Status |
|---|---|---|
| Auto captions | `transcribe_asset` -> `add_captions_from_transcript` (local Whisper) | Present. Caption style presets and active-word highlight MISSING. |
| Import captions (SRT/VTT) | `import_captions` | Present |
| Remove silence | `delete_spoken_range` / `apply_cut_plan` / `find_moments` + `cut_to_moments` (analysis has silence detection) | Present via tools; a dedicated "remove silence" button wrapper is thin work; verify threshold defaults |
| Remove filler words ("um", "uh") | `search_transcript` (words) -> `delete_spoken_range` | Present via composition; a canned filler list is not shipped (small) |
| Smart cut / highlights | `understand_media`, `find_moments`, `cut_to_moments`, `plan_cuts_to_style` | Present |
| Reframe to face (9:16) | `set_project` + `index_faces` + `reframe_to_faces` | Present |
| Colour polish | `apply_filter`, `set_color_adjust` | Present (no auto-enhance / LUT) |
| Freeze frame, crop, speed (constant) | `freeze_frame`, `set_crop`, `set_speed` | Present |
| Style match to a reference | `compare_to_style`, `plan_cuts_to_style` | Present |
| Beat sync | analysis has beat detection (`timelineBeats`); no snap-to-beat or beat-cut tool | **MISSING** |
| Speed ramp / speed curves | only constant `set_speed` | **MISSING** |
| Background removal / chroma key | none | **MISSING** (heavy; segmentation model + per-frame matte) |
| Auto-zoom / punch-in | keyframes exist (`add_keyframe`); no tool | MISSING (cheap to add as a macro) |
| Text-to-speech, voice changer, denoise | none | MISSING (out of scope for local-first v1) |

## 6. Ranked build plan (one PR each, smallest first)

| # | PR | Size | Depends on | What |
|---|---|---|---|---|
| 1 | Template format + validator | S | none | `src/engine/templates/{types,parse,validate}.ts`, `src/templates/index.ts`, schema tests (4.1). No UI. Settle the JSON shape. |
| 2 | `apply` planner + 3 authored templates | M | 1 | pure planner returning commands, one undo step, tests 4.2-4.3; author 3 templates that need NO missing features: kinetic typography (#2), before/after (#4), product launch (#1). |
| 3 | Agent tools `list_templates` / `apply_template` | S | 2 | tools + registry + `AGENT_MCP.md` + a scripted eval policy. |
| 4 | Preview generator | M | 2 | Playwright script rendering poster + loop from the real engine; `previewHash` CI check; budget enforcement. |
| 5 | `/templates` gallery page (read-only) | M | 1, 4 | route, grid, pause toggle, filters, duration badge, CSP test (4.4 zero third-party requests). |
| 6 | Apply flow: dialog, slots, create project, "Add to project" + editor entry | M | 2, 5 | stepper UI, Header button, Projects "Start from template", e2e apply -> export -> decode. |
| 7 | 5 more templates (testimonial, listicle, changelog, feature callouts, app promo) | M | 2 | needs repeat groups (add `repeat` to planner in this PR) and graphic-built device frame. |
| 8 | "Save as template" from a project | M | 2 | lossy export to template JSON with warnings; round-trip test. |
| 9 | Inspiration section | S | 5 and a finished link check | `inspiration.json`, text-only, scheduled link check. Blocked on legal sign-off in section 3. |
| 10 | AI tools panel with existing tools | M | none (parallel) | buttons wrapping existing tools in one agent turn each. |
| 11 | Engine gaps, one PR each, by archetype value | L each | 1 | (a) caption style presets + active-word highlight, (b) beat snap + beat-cut tool, (c) glitch/flash/blur transitions, (d) speed ramps, (e) count-up text param, (f) callout/cursor presets, (g) background removal (largest, last). |

Honest gaps and risks:
- Archetypes are inferred from metadata, not from watching the videos; beat timings are my norms for each form, not measurements. Validate by authoring each template and comparing against a few reference spots on pacing only.
- 20 of 22 posts unverified for public viewability beyond HTTP 200 from a JS shell (1.4).
- Previews in the repo cost bytes: ~0.6 MB per template; with 12 templates this is ~7 MB in git. Consider generating at deploy time instead of committing if the budget is a concern, at the cost of a slower build.
- Variable-length repeat groups and slot-relative durations are the trickiest part of the format and the easiest to get wrong with the no-overlap and source-mapping invariants; budget the fuzz test early.
- The `/templates` path versus `#/templates` decision affects landing links and the Vercel rewrite.
- Theatre.js studio and GSAP licences are not clean for an MIT project; Remotion is not open source. None of the three is needed.
- `docs/CAPCUT_PARITY.md` already lists "templates" and "text templates" as not implemented; update that file and `docs/PRODUCT_MAP.md` when PR 2 lands.
