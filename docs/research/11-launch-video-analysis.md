# 11. Launch-video analysis: what the 22 spots actually do, and the templates they imply

Date: 2026-10-13. Base: `origin/main` @ 508afa2 (worktree `/Users/mac/Desktop/coding/oss-lva`, detached; this file is the only change, nothing committed).
Supersedes the inferred archetype table in `10-templates-research.md` section 2 (that pass did not watch the videos). Section 4 of doc 10 (`ProjectTemplate`) is the target format; engine limits come from `docs/CAPCUT_PARITY.md` and `src/engine/model/{definitions,params}.ts`.

## 0. Method, scope and limits

Source: the 22 cards on https://notes.apoorv.xyz/launch-videos (curated by @apoorveth). I resolved each card's `full.mp4` (it carries the audio; `preview.mp4` is muted) on `notes-media.latheyapoorv.workers.dev` and downloaded all 22 (HTTP 200 each, 1.7 MB to 32 MB) into `/private/tmp/claude-502/lva/v/` (outside the repo; nothing media-related is committed or will be).

**Study use only.** The videos belong to their creators. They were downloaded solely to analyse structure and style. We do not redistribute, embed, hotlink, re-encode into the repo, or reproduce shot-for-shot. This document records handle, post URL, card title, and our own description of structure and style. Text on screen is described by role and style; only short factual labels (a word or two, such as a product name already in the card title) are quoted. People and archival photos seen in two videos are not described individually.

Pipeline per video (scripts and outputs in `/private/tmp/claude-502/lva/`, not in the repo):
- `ffprobe`: duration, resolution, fps, codecs. All 22 have H.264 video + AAC audio.
- `ffmpeg select='gt(scene,0.3)'` and `gt(scene,0.1)` + `showinfo` for cut times. The 0.3 pass finds hard cuts; the 0.1 pass also finds dissolves, whips and heavy UI morphs (merged within 0.5 s for the counts below).
- Contact sheets, 5 columns x up to 6 rows of 384x216 tiles, one frame per second (videos up to 30 s) or per two seconds (longer ones), viewed with the image reader. So **beat times below are accurate to about +/-1 s (+/-2 s on the long videos)** except where a scene-cut timestamp gives better.
- `ffmpeg ebur128 + silencedetect` on the full audio for loudness, loudness range, true peak, silent tails.
- Palette: 48x27 downsample at 2 fps, 8 levels per channel, bucket means (so +/-16 per channel) for the dominant colours; accent colours are the most saturated pixel in a hand-picked region at a hand-picked time (sampled, not eyeballed, but the region choice is mine).

What I could **not** verify (also repeated in section 8): I cannot listen, so music genre, instrumentation, SFX identity and whether picture hits land on beats are not established; I only have loudness statistics. Font identities are guesses from letterforms. Text sizes are estimates from 384 px wide thumbnails (+/-30 %). Cursor and click behaviour is read from sparse frames. Several videos (1, 4, 6, 8, 16, 20) are "one continuous morphing take", so cuts-per-10 s understates their pace; I give a text-swap rate for those.

## 1. Per-video record

Post URL pattern: `https://x.com/<handle>/status/<id>`. Fps in parentheses. Cuts = merged scene changes (hard@0.3 / any@0.1); per-10 s uses the any@0.1 count. LUFS = integrated, LRA = loudness range, TP = true peak dBFS (positive values mean the transcode inter-sample-clips).

| # | Card title | Handle | Post id | Dur | Res (fps) | Aspect | Cuts hard/any (per 10 s) | LUFS / LRA / TP | Silent tail |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Pomelli - a new chapter | @PomelliByGoogle | 2056797533792530801 | 1:00 | 1920x1080 (30) | 16:9 | 0/4 (0.7) | -12.5 / 5.2 / +0.9 | none |
| 2 | Lovable - Google connectors | @Lovable | 2056751240357580911 | 0:46 | 1920x1080 (30) | 16:9 | 15/27 (5.8) | -12.7 / 5.2 / +0.5 | 1.3 s |
| 3 | Jupiter - Offerbook | @JupiterExchange | 2059662628729872407 | 0:26 | 1920x1080 (29.97) | 16:9 | 9/14 (5.4) | -8.0 / 1.2 / +0.7 | none |
| 4 | Pump.fun - USDC trading | @Pumpfun | 2082869372234747933 | 0:20 | 1920x1080 (60) | 16:9 | 0/2 (1.0) | -7.6 / 2.2 / +1.9 | none |
| 5 | Aside - a new way to browse | @hyojun_at | 2069497198879048131 | 1:27 | 1920x1080 (29.97) | 16:9 | 4/8 (0.9) | -14.1 / 8.7 / -0.8 | none |
| 6 | Google AI Studio - pretty URLs | @OfficialLoganK | 2075598301018337773 | 0:42 | 1920x1080 (29.97) | 16:9 | 0/2 (0.5) | -14.2 / 4.6 / +0.5 | 1.5 s |
| 7 | saviomartin - internet business launch | @saviomartin | 2055687342812488107 | 0:25 | 1440x1080 (25) | 4:3 | 14/17 (6.8) | -11.8 / 7.7 / +1.3 | none |
| 8 | azatsol - full video | @azatsol | 2083885284853223814 | 0:29 | 1280x704 (30) | 20:11 (~1.82) | 0/3 (1.1) | -15.1 / 6.2 / +0.5 | none |
| 9 | Figma Motion - VeduBoi | @vedu_boi | 2070014128807367023 | 1:17 | 1920x1080 (60) | 16:9 | 18/27 (3.5) | -24.9 / 10.2 / -4.8 | 2.7 s |
| 10 | Figma - canvas agent | @figma | 2057084392640843956 | 1:01 | 1920x1080 (24) | 16:9 | 17/37 (6.1) | -9.0 / 3.3 / +1.1 | 0.7 s |
| 11 | Whop - payment infrastructure | @organicbond | 2036749097818841498 | 0:19 | 1920x1080 (30) | 16:9 | 20/24 (12.5) | -11.2 / 3.7 / -2.3 | 1.0 s |
| 12 | Jumper - private swaps on Base | @jumperapp | 2075203412611010846 | 0:09 | 1280x720 (60) | 16:9 | 2/2 (2.3) | -20.3 / 1.5 / -0.5 | none |
| 13 | Creator Studio - live streaming | @benjitaylor | 2072435629548597547 | 0:52 | 1080x1080 (60) | 1:1 | 6/14 (2.7) | -12.6 / 1.8 / +1.2 | none |
| 14 | Polymarket - five-minute markets | @Polymarket | 2022343906168623112 | 0:21 | 1920x1080 (23.98) | 16:9 | 2/7 (3.4) | -21.3 / 4.6 / -4.7 | none |
| 15 | Husher x Axiom | @AxiomExchange | 2088721197915623455 | 0:23 | 1920x1080 (24) | 16:9 | 2/7 (3.1) | -8.8 / 5.7 / +1.4 | none |
| 16 | fomo - Ethereum mainnet | @fomo | 2060468574007767073 | 0:18 | 1080x1080 (24) | 1:1 | 0/1 (0.6) | -6.7 / 1.7 / +2.2 | none |
| 17 | Umbra - private payroll | @UmbraPrivacy | 2072367388087976112 | 0:51 | 1920x1080 (30) | 16:9 | 9/15 (3.0) | -14.6 / 6.8 / +0.7 | none |
| 18 | Hunch - trading terminal | @tradeonhunch | 2059685085134135412 | 0:57 | 1920x1080 (30) | 16:9 | 5/9 (1.6) | -17.3 / 10.2 / +0.4 | none |
| 19 | Brim3nEdits - pacing study | @Brim3nEdits | 2073159246477209713 | 0:24 | 1920x1080 (30) | 16:9 | 8/14 (5.9) | -10.9 / 1.6 / +6.2 | 1.4 s |
| 20 | Print - multi-wallet manager | @printworld | 2057520192780194091 | 0:52 | 1920x1080 (30) | 16:9 | 0/0 (0.0) | -15.2 / 4.6 / +5.1 | 1.3 s |
| 21 | TROOVY - Hanta Virus | @TROOVY | 2056112526857797920 | 0:19 | 1280x720 (30) | 16:9 | 2/4 (2.1) | -9.8 / 8.2 / +0.4 | none |
| 22 | Jumper Pass - new perks | @jumperpass | 2056707619180691481 | 0:16 | 1280x720 (30) | 16:9 | 2/3 (1.8) | -11.6 / 3.3 / +0.6 | 2.1 s |

Note on titles: the card titles are the collection owner's labels and are not always the product name. Card 8 is a lending-market product launch (brand wordmark appears at the end); card 9 is a launch reel for a gradient-asset tool made by the credited creator (the "Figma Motion" in the title is the tool used); card 19 is a credits promo for a "vibe-coding" app; card 7 is a "coming soon" teaser for an unnamed product; card 21 is a parody launch. Card 12's duration was 8.6 s (the page says 0:08).

Download status: 22 of 22 downloaded, 22 of 22 probed, scene-cut analysed, audio-analysed, contact-sheeted and viewed. No broken downloads.

## 2. Cross-cutting findings

**Format.** 18 of 22 are 16:9 (1920x1080 or 1280x720). Others: 1:1 x2 (13, 16), 4:3 x1 (7), 20:11 x1 (8, a 1280x704 export). None is vertical. Frame rates: 24 (10, 15, 16), 25 (7), 30 (most), 60 (4, 9, 12, 13). Median length 26 s; 14 of 22 are 8-30 s, 5 are 45-62 s, one is 87 s (Aside).

**Structure is almost always the same skeleton**: (1) brand sting or hook phrase 0-4 s; (2) a product reveal as UI on a stage; (3) 2-6 "feature beats", each one short phrase plus a UI crop or graphic; (4) a closing phrase; (5) an **end card: logo/wordmark and a URL or social handles, held 2-4 s**. 22 of 22 have an end card (logo only: 3; logo + URL/handles: 17; text CTA only: 2). Seven of them (2, 6, 9, 11, 19, 20, 22) have the audio stop 1-2.7 s before the end, so the last card plays on a silent or near-silent tail.

**Text is the main visual.** In 14 of 22 videos no more than a third of the runtime is real footage or screen recording; the rest is type, icon chips, 3D props and gradients. Typical hierarchy: one idea per card, 2 to 7 words, set in a single grotesk sans (geometric or neo-grotesque, medium/semibold; two videos use a serif with italic accent), centred, 6 to 12 % of frame height; a hero word or number at 17 to 25 %; small captions at 2.5 to 4 %. Accent treatment is almost always a **colour or italic change on one word of the phrase** (9 videos), not a different font.

**Text motion vocabulary** (used by 15+ videos): word/phrase swaps in place with a short blur-and-fade (rather than fly-ins); typed text with a caret (8 videos); mask-up or slide-up reveals; scale-pop for chips; inline icons that sit inside the sentence (4 videos; 5 uses it most). The four presets we have (fade, slide-up, pop, typewriter) cover roughly 60 % of observed motion; blur-in/out and stagger are the notable absentees.

**Pacing.** Cuts per 10 s (any@0.1): 0-1 for continuous-morph pieces (1, 4, 5, 6, 8, 16, 20), 2-4 for UI-led pieces (9, 12-15, 17, 18, 21, 22, 13), 5-7 for hook-and-demo or story pieces (2, 3, 7, 10, 19), 12.5 for the one hype montage (11, with 0.1-0.5 s shots in the first 2 s). Text card dwell is 1 to 2.5 s; UI sections dwell 3 to 10 s with a slow push-in; end cards 2 to 4 s.

**Backgrounds.** Four families: (a) near-black with a soft coloured gradient glow or mesh (3, 8, 9, 12, 14, 15, 18, 20, 22; 9 of 22); (b) flat or near-flat light/white or paper-grey with a coloured floor or shadow overlay (4, 5, 7, 11, 13?, 19, 21; 13 is black); (c) saturated single-hue brand fields (16 indigo, 17 sky-blue, 2 hot gradient); (d) the UI-as-stage where the app's own colours are the background (6, 10, 13). The 8 gradient pieces all use *blurred, drifting, low-contrast* blobs, not hard-edged gradients.

**Cursor.** An animated cursor with click feedback appears in 14 of 22 (arrow, hand or a plain white dot); in 4 of them (2, 4, 14, 22) a hand cursor with a pink/blue ripple on the send/confirm button is the central device.

**Audio (loudness only).** Integrated loudness spans -6.7 to -24.9 LUFS. Six videos are mastered hot (-6.7 to -9.8 LUFS: 3, 4, 10, 15, 16, 21; 11 and 19 are borderline at about -11), which fits a produced music bed with sustained level; the quietest (9 at -24.9 with LRA 10.2, 14 at -21.3, 12 at -20.3) have wide dynamics or sparse sound. LRA is above 8 for 5, 9, 18 (long pieces with sections and a spoken or dynamic bed). Peaks above 0 dBFS (1, 2, 3, 4, 7, 10, 13, 15, 16, 19, 20) are X-transcode inter-sample overs. I cannot say what the music is or whether picture hits sit on beats; a crude autocorrelation tempo guess was too unstable to report (many fell on its 173 BPM search ceiling) so I discard it.

**Palettes** (dominant, bucket means; accent = max-saturation sample): near-black `#060b12`/`#080808`/`#0b0b0e`/`#040504` is the base in 11 videos; light `#f8fbfa`/`#fbfbfb`/`#f2f2f2`/`#f0f1ed` in 6; the rest are saturated brand fields. Accents seen: lime `#acfe7c` / `#daff16`, mint `#5cfa87`, violet `#d6a1fc` / `#c69be4`, electric blue `#0ba0ff` / `#068adf`, pink/magenta `#ef007e` / `#de00ff`, orange `#f77400`, red `#e4205b`, indigo `#4a30f3`, sky `#0fc1f8`.

## 3. Beat notes per video

Times are seconds from start, +/-1 s (+/-2 on 1, 2, 5, 6, 9, 10, 13, 17, 18, 20). "Type" sizes are percent of frame height of the glyph em, then the engine unit (x 0.9, because `fontSize` is against a 90-unit-tall canvas).

**1. Pomelli (60 s, 16:9).** Dark olive blurred field (`#11140d` / `#2c3429`, olive-lime accent `#84913f`); background alternates between that and a lime-yellow bokeh. 0-2 wordmark + small "experiment" outlined pill, mint-white on olive. 2-4 italic display serif phrase (about 7 %). 4-18 tall translucent phone-shaped chat card with teal edge glow rises and fills with an agent conversation; file chips drop in, a prompt is typed in a pill input with a mic icon, a mint "Yes" pill is clicked. 18-20 orbit ring of file icons around a document glyph (loading). 20-26 camera pushes into a three-panel brand-builder UI that fills in. 26-30 italic serif phrase typed with motion blur over lime bokeh plus two action pills. 30-38 image-picker grid, numbered selections, "Confirm" pill with cursor; a brand-book page floats in 3D. 38-46 italic serif phrase; glass panel morphs into a publish toggle row. 46-56 laptop mockup with the generated site, product grid, then palette chips and logo card drift in. 56-58 closing italic serif phrase. 58-60 lab-brand end mark. Transitions are morphs: the card you are looking at becomes the next UI, plus blur-dissolve to a new background. Cursor: standard black arrow. Audio: -12.5 LUFS, no silent tail.

**2. Lovable (46 s, 16:9).** Bold hot gradient (blue/pink/orange, `#ef007e`, `#f77400`) alternating with white UI. 0-2 white wordmark centred on the gradient. Then five repeated cycles of about 8 s: (a) a black rounded prompt card (about 85 % wide x 45 % tall) rises on the gradient; the prompt is typed in white semibold (about 7 %), the last words in blue-to-purple gradient text; a source chip (sheets, mail, calendar, maps) is added bottom-left; (b) a hand cursor travels to the round white send button, the button pulses with a pink ring (a zoomed 2 s close-up for cycle 3); (c) hard cut to a bright result screen (dashboard, product selector, booking calendar, mail triage, map store finder) with the hand cursor clicking one control. 30-38 a full-bleed black card with a huge headline typed in white, the end words gradient-coloured. 38-44 a mosaic of many app screens zooms out. 44-46 wordmark again on gradient. Cuts 5.8 per 10 s, mostly hard. Silent tail 1.3 s.

**3. Jupiter (26 s, 16:9).** Deep navy (`#060b12`) with big teal/lime gradient rings and ellipses (`#154856`, `#2c6f74`, lime accent `#acfe7c`). 0-3 single words swap in place: small grey, then white (about 7 %). 3-6 dashboard UI tilted in perspective with a glow frame rises from the bottom. 6-8 giant product name (about 17 %, semibold white) with small "brand" above-left and a short right-aligned suffix below on a lime/teal flash. 8-10 toggle chips (up arrow / down arrow). 9-10 a curved row of 3D collectible cards. 10-11 inverted cream flash with one word. 11-14 UI rises from below, three times, getting closer. 14-16 icon columns frame a counter (about 14 %) then a sentence. 16-17 phrase over concentric teal ellipses. 17-18 huge two-letter-plus-digit word ghosting in as green gradient letters, small cursor. 18-21 referral QR card tilts in, with a phrase on the left. 21-22 centred two-line statement (about 7 %, last word cyan). 22-24 "now available" and the URL inside a peanut-shaped gradient ring. 24-26 spinner sliver, then glossy logo. Hard cuts at 4.7, 6.4, 8.9, 10.4, 11.4, 16.1, 18.5, 20.6, 21.9 s.

**4. Pump.fun (20 s, 16:9, 60 fps).** White `#f8fbfa` field with a mint floor gradient (`#91e9ab` to `#caf2d6`, about 25 % tall) and a halftone dot texture that fades. 0-1 app icon. 1-2 pill toggle with a cursor. 2-4 3D blue coins tumble in with motion blur and depth of field around the toggle. 4-6 two-line phrase with a large bold hero word (about 14 %) and a small line below that blurs in. 6-7 three amount buttons and a toolbar pill. 7-8 phone UI. 8-12 four one-second sentence beats with an inline icon chip in each (trade [token] ...), each swapping in place. 12-14 "swap" pill, then a convert card clicked by a hand cursor, which spins into a green 3D ring tunnel. 14-17 "0%" in outlined digits (stroke only) with halftone. 17-20 closing line above a phone with a download prompt, the last word blurring in. Text-swap rate about 6 per 10 s. Hot master (-7.6 LUFS).

**5. Aside (87 s, 16:9).** Alternates dark `#252526` and white `#fbfbfb` almost 50/50; blue accent word. 0-10 dark: search field with I-beam cursor; two app icons; a sentence with the accent word in blue and a trash-can icon; sentence with an icon dock; hand cursor; sentence about a stop; chat bubbles with refusal lines; a blue glass funnel (3D) pulling icons in. 20 wordmark on a blue-grey gradient. 21-60 white: large left-aligned four-line statement with an inline circular logo glyph; sentence with inline globe, key and history glyphs; a command bar types a task; step list of the agent working (text lines with tiny icons); a benchmark bar chart on dark where the product bar glows blue (53-58). 60-86 mix: wordmark; "can do" sentences with inline icons; a laptop mockup; a password-field gag (field text turns into dots); local/private statements; end. Pacing 0.9 cuts per 10 s but a text swap every 1.5-2 s. Largest dynamic range in the set (LRA 8.7).

**6. Google AI Studio (42 s, 16:9).** Near-black `#040504`; soft rainbow glow rims on UI cards. 0-4 "Introducing" then a phrase with an inline link icon revealing with a left-to-right blur wipe. 4-8 product glyph, then wordmark. 8-14 UI toolbar zoom with a blue arrow cursor clicking a Publish tab; a dialog; a form where the cursor reaches the submit button. 14-20 camera zooms into the URL field; the field is enlarged to 9 % and typed with a caret; an availability tag appears in green. 20-26 white progress pill fills; status text ticks through two states. 26-30 rocket glyph in a rounded square; a success card on a rainbow arc. 30-36 browser window containing the site, zoomed from full UI to the new URL bar. 36-40 closing phrase typed, then URL in small white. Zero hard cuts: every transition is a zoom or blur dissolve.

**7. saviomartin (25 s, 4:3).** Pure black `#030303` and white `#fcfcfc` alternating; serif display type (thin transitional serif, about 6 %) with one italic word per phrase. 0-2 three 0.08-0.2 s flash cuts (crowd, close eye, eyelid) with a centred white serif phrase burned over them. 3-4 white card, two-line serif phrase, accent word italic. 5-9 collage of historical team photos builds on white (each photo pops in at a new spot, 4-5 photos). 9-10 black card, short phrase, accent italic. 10-16 interview clips (hard cuts, speaker framed left; burned-in small white serif captions placed beside the speaker, word-group by word-group). 16-20 serif phrases on black then white ("one person" ... "the leverage of a 1000"). 20-22 sans "result" with a superscript copyright mark on black, twice. 22-23 phrase on black. 23-25 typewriter close-up stock shot with a typed line appearing ("coming soon"). Tail: none.

**8. azatsol / lending-market view (29 s, 20:11).** Mesh gradient base (blue left `#344d8f`, green bottom `#2e704d`/`#36af69`, orange-red right `#724b39`), UI panels in black glass with a thin rainbow edge glow. 0-1 translucent glass asterisk logo. 1-3 "Introducing" and a short feature name with the logo glyph. 3-5 pill header UI zooms in. 5-13 chart panel: line draws blue to orange, bars rise orange-red, camera pushes in slowly, sub-tabs click. 13-15 panels with sliders and a green action button. 15-16 gradient with a white capsule label (white text on a translucent pill, about 6 %). 16-20 a card whose heading unscrambles from random letters to the final text; table rows slide in. 20-22 "know more" statement over gradient. 22-25 URL (the path segment tinted orange-pink). 25-29 logo, then wordmark, on the gradient.

**9. Grainient v2 reel (77 s, 16:9, 60 fps).** Black `#050504` base punctuated by saturated gradient swatches (cyan `#15e2f6`, magenta `#de00ff`, lime, deep blue `#0734a7`). Pervasive pattern: a white sans phrase typed with a caret ("Int|", "...|"), then a swatch tile or card appears. 0-8 typed phrase, giant product word (22 %), gradient tile grid in perspective. 8-16 circular mark drawn in outline, dims into a star field, becomes the "v2" lockup glowing lime. 16-26 flying gradient tiles and a ring of tiles around a phrase; aurora background. 26-30 pastel "But" inversion, gold/cyan framed box. 30-50 green aurora chapter: phrases "meet the", "real-time shader", "create", "transform", "static to alive" in neon-green, a before/after vertical-line slider wiping a static swatch to an animated one. 50-60 design-tool UI: AI prompt bar, cursor, tint slider, selection handles on cards. 60-68 wall of testimonial cards scrolls, dimmed. 68-77 rainbow ring arc with text, orbiting colour dots, final caret-typed line, logo. Quiet master (-24.9 LUFS), LRA 10.2.

**10. Figma agent (61 s, 16:9, 24 fps).** Periwinkle `#b1bcca` and white stage; app-green design inside the UI (`#116635`, `#dafba8`, `#8ff17a`); blue accent `#0ba0ff`. 0-8 design canvas with a selected mobile frame (blue handles), a floating prompt bar typed in a white pill with a blue send button, sparkle cursor; many screens appear in a grid. 8-18 multi-user cursors with coloured name tags (magenta, blue) and a comment bubble. 18-24 large left-aligned black heading (about 9 %) above a chat bubble with an avatar; "thinking" state; the answer types in. 24-30 chart widgets, big green card, mosaic of components. 30-44 "apply your design system" heading, selection box, prompt box typing, spacing measurement callout (red box with arrows), input-state variants. 44-56 screens settle into a flow; final composite; camera pulls out to a canvas against sky. 58-61 black end card: phrase in a blue-outlined box with a sparkle cursor, and a pixel-block shape logo. Fast 8-10 s section (cuts every 0.1 s) is a flicker transition.

**11. Whop (19 s, 16:9).** Hype montage, near-monochrome (`#f2f2f2`, `#cfced0`, `#282b2c`) with torn-paper stickers and newsprint. 0-3 black-and-white archive clips (steam train, loading bar) cut every 0.1-0.5 s, then a small black sentence on white and the same sentence as a white subtitle on a circuit macro. 4-6 product UI (balance card with a yellow button; revenue line chart). 6-9 stock hands exchanging cash; newspaper front pages with condensed black headline (headline blocks about 10 %) stacking up; tweet cards with a payment toast. 10-12 giant condensed numeral on a torn paper strip (about 24 %) with a small label; sentence with a torn-sticker brand logo. 12-15 server-rack macro with green LEDs, blurred code. 15-17 night train and city POV with a white sentence (about 4 %) split over two beats. 17-19 torn-paper sticker logo on off-white. Fastest pacing in the set (12.5 per 10 s).

**12. Jumper (9 s, 16:9, 60 fps).** Deep violet `#15082b`, lilac light `#d6a1fc`. 0-1 glossy 3D logo on violet with a bottom glow. 1-3 cut to a light grid-floor scene (`#cfd4e6`) with the logo and a blue 3D coin (0.78 s cut). 3-4 glowing coin with a vertical light beam on violet (2.58 s cut). 4-6 one-line statement with chain logo (white, about 6 %). 6-8 giant phrase (about 13 %) where the second word slides in blurred then focuses. 8-9 small line with the URL in lilac. Quiet mix (-20.3 LUFS).

**13. Creator Studio (52 s, 1:1).** Pure black stage (`#010101`, 33 %) with a white app window. Almost no type: a two-line white title at 0 s, a two-line end line at 50 s, nothing in between. 0-8 the window starts small in the centre, scales up in steps toward the sidebar item. 8-30 modal flow: create dialog, thumbnail upload (image fills), date picker with a red-dot date (`#e4205b`), audience step, a hand cursor pressing Next; the camera crops tighter around each dialog. 30-46 scheduled-stream view with countdown, live view with chat list, a viewer-count sparkline; window shrinks and pans between views (jump cuts at 21.9, 26.8, 31.8, 33.0, 42.1 s). 46-50 dimmed window, then the end line. Square canvas.

**14. Polymarket (21 s, 16:9, 23.976 fps).** Black `#080a0d`; accents blue-violet glow `#5e4cf9`, green `#49d064`, red. 0-1 glowing currency glyph. 1-4 headline typed with an accent word in violet gradient plus a trailing glyph; a glass pill ("short market") appears and a cursor presses it. 4-10 zoomed UI simulation: countdown (04:43), Up/Down price chips, the Down chip clicked, amount field typed with I-beam cursor, "to win" amount updates, Buy button, confetti burst and a "bought" state. 10-12 UI over a sky backdrop. 12-15 a small market card with a gauge, then a huge green "Up" button with a stacked list of gains (+$5, +$25, +$145) that ticks upward and a red LIVE dot. 15-17 "5 minute" glow-type and a phrase with the glyph. 17-20 dimmed UI with a violet word and a closing line. Cursor: white arrow / hand. Cuts: 12.0 and 15.2 s.

**15. Husher x Axiom (23 s, 16:9).** Near-black navy. 0-1 hex logo glowing blue. 1-2 two-word feature title (white, about 5 %). 2-4 fast zoom-blur fly-through of a dense dashboard (radial blur). 4-8 dim UI; checkout modal steps tick green. 8-9 three-word product phrase over blank. 9-14 UI tilted in perspective, sliders and fields animating, camera drifts. 14-15 phrase "on all chains". 15-18 top-bar crop with the chain selector cycling through three chains, each with a full-width colour wash bar above it (blue `#2ba7ef`, lime `#daff16`, blue) acting as a flash-wipe. 18-23 brand triangle logo, wordmark, and a bottom row of handle, invite link, URL (about 2.2 %, white). Hot master.

**16. fomo (18 s, 1:1).** Flat electric indigo `#4a30f3` with a slight vertical gradient; white bold lowercase sans (about 4 % small captions, 6 % for the chain title). 0-4 token avatars orbit and spiral in a vortex above a photographic hand on a mouse; "thousands" then "thousands of tokens." appear as small captions mid-frame while a ring of icons draws itself. 4-10 a second hand and a dense field of token icons; "one slide away" caption; the vortex cuts at 10.0 s. 10-14 chain gem icon and a two-line announcement ("... is now live."), the first line bolder; a waving hand. 14-18 phone held in a hand, then the app's mark on indigo. Few cuts, mostly object motion. Loudest master (-6.7 LUFS).

**17. Umbra (51 s, 16:9).** Sky blue (`#0fc1f8`, `#1792e1`) with clouds and a green hill photo; mint toast chips (`#8fff85`). 0-12 office scene (illustrated, then photographic blur) with floating "salary credited" toast chips whose amounts later turn into asterisks (privacy gag); a cursor. 12-14 big white title card on sky (about 12 %, semibold). 14-18 second title, then a glass card with a balance figure, then a QR deposit card. 20-26 chain dropdown, 3D coins floating through clouds with a sentence fading in left-to-right. 26-30 pale payroll list stack; "withdraw" pill with concentric rings. 30-34 bank icons on a timeline. 34-40 solid cyan with a two-step sentence, "compliance" inside a large circle, "generate report" pill, report table. 42-48 3D coins and a wallet; coin on a hill. 48-51 solid cyan end card with tagline, URL and a cloud-bubble logo. Hard cuts 9/15.

**18. Hunch (57 s, 16:9).** Black `#080808`, orange-red accent (logo `#ff5a36`-ish; blue UI chips `#328ed1`). 0-4 whip pan across a ticker of trades with search text typed; the UI wraps into a 3D tunnel; logo burst on black. 6-12 product nav; hand cursor clicks a wallet icon; a provider grid of six exchanges; deposit panel ("fund with" button). 12-30 market cards, a "find the trade" panel, analytics cards, a green gauge in an orange glow. 30-38 photo tiles of sports/news markets in a masonry. 38-44 portfolio, a level progress bar, a large earnings figure (`$` + six digits, about 6 %) and an orange claim button. 44-50 text-logo marquee wall (partner names in both outline and fill forms) scrolls diagonally. 50-57 URL in white (3 %), small red "live now". Long dark UI sections with a few quick whips.

**19. Brim3nEdits pacing study (24 s, 16:9).** Warm grey `#cfd1cd` / `#f0f1ed` with a window-shadow overlay (diagonal light and leaf shadow) over everything; black type, with red/grey marker squares at the start. 0-3 four small photo tiles pop in, a word-by-word line beside them. 3-4 archival full-frame shot with a hand-drawn arrow and a handwritten label. 4-9 five one-second text beats with tiny inline photos ("one [photo] person", "neither would they [faces]"). 9-11 "you" in lowercase then uppercase (scale up). 11-14 a big odometer-style counter (about 14 %) rolls to a round number, with a small tracked "credits" label above and a "free" line below; second line fades to "free to build ...". 14-16 red outlined "live" pill; sky-blue gradient card with a counter ticking down and a sentence whose second half is italic blue. 17-19 UI prompt box with a serif heading and chips. 19-21 handwritten script line, then "it might be *you*" with asterisk emphasis, zooming in on a textured wall. 21-24 URL in dark grey on off-white. Colour `#3d96cd` accent. Peak +6.2 dBFS (clipped).

**20. Printworld (52 s, 16:9).** Black with a teal glow (`#0b0b0e` / `#132f2f`); the app window is a perspective-tilted slab; zero scene cuts, one continuous camera move. Captions are small white (about 2.5 to 3 %) text blocks pinned to alternating corners (top-left, top-right, bottom-right, left) so they never cover the UI, each 4-6 s, left- or right-aligned and fading in and out. A white dot cursor with a smeared pill shape on click drives every interaction. 0-2 "introducing" line; 2-10 import and create wallets; 10-18 send funds privately; 18-24 purposes; 24-32 trade join; 32-40 split buys; 40-44 quick access with a ghost red wordmark dripping behind; 44-48 pop-up panels; 48-52 wordmark in white caps.

**21. Hanta Virus (19 s, 16:9).** Parody. White `#fbfcfc` and mint `#5cfa87` fields; geometric rounded sans (Poppins-like), near-black text; faint tool watermark in the top-left corner. 0-2 two-line sentence typed with a word-level fade. 2-3 "and fixed it" with the connector word in mint, "fixed it" jittering. 3-5 huge "introducing" that cuts off the frame edges (about 17 %) then settles to 6 %. 5-8 logo glyph made of dots, wordmark with a mint blob bleeding in, black glossy 3D blob. 8-10 icon + short claim (lightning), then a bold two-clause line. 10-12 full mint card with a ring and a hero word (9 %) with dash particles bursting. 12-15 compliance claim, then a vertical list of four chips scrolling with the centre one highlighted in a pale-mint pill. 15-17 mint card with a dot-matrix world map and "available worldwide". 17-19 wordmark end card. Quick, dense.

**22. Jumper Pass (16 s, 16:9).** Deep violet `#080217` with soft purple blobs (`#231238`, `#4b306a`); lilac accent text (`#d6a1fc`). 0-2 two-phrase line, the accent word in lilac. 2-5 a fan of glass perk cards in 3D, a cursor. 5-8 screen recording of the widget with a cursor. 8-10 a grid of partner perk cards in perspective rises, with a three-line sentence above. 10-14 three two-word cards swap in place ("more", "higher", "perks"; last in lilac). 14-16 logo lockup. Silent tail 2.1 s.

## 4. Archetypes and mapping

Eleven archetypes; the 22 videos map as follows.

| Video | Archetype |
|---|---|
| 1 Pomelli | A. Prompt-to-result loop |
| 2 Lovable | A. Prompt-to-result loop |
| 10 Figma agent | A. Prompt-to-result loop |
| 8 azatsol | B. Tilted-UI tour on a dark gradient |
| 15 Husher x Axiom | B. Tilted-UI tour on a dark gradient |
| 20 Printworld | B. Tilted-UI tour on a dark gradient |
| 22 Jumper Pass | B. Tilted-UI tour on a dark gradient |
| 3 Jupiter | C. Branded-world feature chapters |
| 17 Umbra | C. Branded-world feature chapters |
| 4 Pump.fun | D. Inline-icon kinetic sentences |
| 21 Hanta Virus | D. Inline-icon kinetic sentences |
| 5 Aside | E. Long-form narrative explainer (dark/light inversion) |
| 12 Jumper | F. Hero-render sting |
| 16 fomo | F. Hero-render sting |
| 14 Polymarket | G. Cursor-driven UI simulation with number popups |
| 18 Hunch | G. Cursor-driven UI simulation with number popups |
| 6 Google AI Studio | H. Window-frame step walkthrough |
| 13 Creator Studio | H. Window-frame step walkthrough |
| 7 saviomartin | I. Manifesto collage (serif, archival) |
| 19 Brim3nEdits | I. Manifesto collage (serif, archival) |
| 11 Whop | J. Press-wall hype montage |
| 9 Figma Motion / Grainient | K. Typed-caption swatch reel |

Cluster sizes: B 4, A 3, D 2, C 2, F 2, G 2, H 2, I 2, E 1, J 1, K 1 (= 22). Merges made: Pomelli with Lovable and Figma (all "prompt card then result UI", differing only in surface); Axiom with the three tilted-UI pieces (its zoom-blur dive and chain colour-wipes are decorations of the same tour); Hunch with Polymarket (UI sim with number popups; Hunch adds a logo marquee, a component). Kept separate: E (87 s, light/dark inversion, benchmark chart) because it is the only long-form narrative; J because its pace is 2x everything else; K because every beat is typed text over a swatch.

## 5. Recipe cards

Conventions. **Type scale**: `fontSize` is in the engine's 90-unit canvas (`TEXT_SIZE_REFERENCE_HEIGHT`), so units = percent of frame height x 0.9 (a 9 % headline is size 8). `fontWeight` has only `normal|bold` today and `fontStyle` `normal|italic`; the "semibold" seen everywhere maps to `bold` unless the face is a variable font we load (not verified; `public/fonts` ships Inter, Host Grotesk and Geist Mono for the UI; I did not check that Canvas text can use them). **Transitions** only from {dissolve, fade-black, slide-left, slide-right, wipe-left, wipe-right, zoom}; a transition sits on the incoming clip between touching clips. **Text animation** in/out from {fade, slide-up, pop, typewriter}. **Filters** from {vivid, mono, warm, cool, fade, noir, teal-orange, sepia}. **Background**: solid colour or blur only; a "gradient" means a bundled generated image on the main track (our own, original) until gradients exist in the model. All palettes are hex values sampled above. "Slots" are user media; "texts" use the `texts[]` placeholders from doc 10 section 4. "Doable now" lists what the engine can do; "gap" refers to section 6.

### A. Prompt-to-result loop (Pomelli, Lovable, Figma agent; 3 of 22)
- **Duration** 30-60 s (target 40), **aspect** 16:9, 30 fps.
- **Canvas** brand gradient image `#ef007e` -> `#f77400` -> `#4a30f3` (or the brand's own) for prompt beats; white `#f6f5f6` for result beats. Prompt card: rounded rectangle `#101111`, radius 40 (graphic `rectangle`, `cornerRadius` 40), 85 % x 45 % of frame.
- **Type** prompt: bold, size 6, white `#ffffff`, left-aligned in the card; result captions: size 4, `#101111`. Typewriter in 1.6 s.
- **Beats** (one cycle, repeat 3-5x; durations are seconds): 0-2 brand sting (logo slot on gradient, pop in); [cycle] 0-3 prompt card rises (slide-up 0.4) with prompt typed (typewriter 2.0); 3-4 connector chip appears (small rounded rect + label, pop); 4-4.5 cursor to send button (position keyframes) and button pulse (scale keyframes 1 -> 1.25 -> 1); 4.5-8 result clip (slot, hard cut or zoom transition, crop to the relevant UI region, slow scale 100 -> 108 %); end: 3 s mosaic or logo.
- **Slots** `logo`, `clip1..clip5` (result recordings), optional `connector1..5` (icon images). **Texts** `prompt1..prompt5`, `endline`.
- **Transitions** prompt card -> result: none (hard cut) or `zoom` 0.3; between cycles `dissolve` 0.3.
- **Doable now** yes, with a prebuilt cursor PNG and keyframes. **Gaps**: cursor path/click ripple, per-run colour (last words), gradient bg, caret.

### B. Tilted-UI tour on a dark gradient (azatsol, Axiom, Printworld, Jumper Pass; 4 of 22)
- **Duration** 16-52 s (target 24), **aspect** 16:9.
- **Canvas** `#09080a` / `#080217` base plus a generated mesh image (blue `#344d8f`, green `#2e704d`, orange `#724b39`) behind everything; UI recording slot on the overlay track with `blur`-free sharp edges, rounded mask 2-3 %.
- **Type** feature captions size 3 white `#eeeff4`, left or right aligned, pinned to corners that avoid the UI; title cards size 5-6 centred; tagline size 8.
- **Beats**: 0-2 logo or "introducing" (fade 0.4); 2-4 first feature title; 4-12 UI slot 1, slow push-in (scale 100 -> 115 %, linear keyframes), caption corner-pinned 1-4 s after the start for 4-5 s (fade in/out 0.3); 12-20 UI slot 2 (same); 20-22 chain/feature chip swaps with a colour bar (use `wipe-left` 0.25 between three clips); last 3-4 s logo + URL (fade).
- **Slots** `ui1..ui3` (recordings, 3-12 s), `logo`, `bg` (optional gradient). **Texts** `title`, `feat1..feat4`, `url`.
- **Transitions** `zoom` 0.4 into UI, `dissolve` 0.4 between sections, `wipe-left` 0.25 for the chip swap.
- **Doable now** a flat approximation (no perspective). **Gaps**: perspective tilt, animated gradient, zoom-blur transition, cursor, device frame.

### C. Branded-world feature chapters (Jupiter, Umbra; 2 of 22)
- **Duration** 25-50 s, **aspect** 16:9.
- **Canvas** either near-black `#060b12` with a teal/lime ring image (`#154856`, `#acfe7c`), or sky `#0fc1f8` -> `#1792e1` with a clouds photo supplied as a slot.
- **Type** chapter title size 11 (about 12 %), bold, white, centred; subtitle size 6; counter hero size 14 bold; CTA size 6.
- **Beats** (per chapter, 5-8 s): 0-1.5 title on scene (slide-up 0.35); 1.5-6 UI card (image, rounded mask, drop-shadow via a dark rectangle behind, pop 0.3); every 3rd chapter a counter card; tail: 2 s tagline, 3 s URL + logo.
- **Slots** `scene1..3` (backdrop images), `card1..4` (UI screenshots), `logo`, `props` (transparent PNG coins/icons). **Texts** `chapter1..4`, `counter`, `tagline`, `url`.
- **Transitions** `dissolve` 0.5 between chapters, a `fade-black` 0.4 only into the end card.
- **Doable now** yes with supplied assets. **Gaps**: animated gradient, 3D props (user-supplied), orbit/ring motion, count-up.

### D. Inline-icon kinetic sentences (Pump.fun, Hanta Virus; 2 of 22; Aside uses the same device for 4-5 s runs)
- **Duration** 15-25 s (target 19), **aspect** 16:9 (also works at 1:1 and 9:16 by changing font size).
- **Canvas** white `#fbfcfc`, accent floor `#5cfa87` (mint) or `#91e9ab` -> `#caf2d6` (a bottom 25 % gradient strip as a generated image).
- **Type** sentence size 6 (about 6-7 %), normal weight, colour `#1a1a1a`; hero word size 12-15 bold; accent word colour from the brand (`#5cfa87` on dark, `#0fc1f8`). Each beat is one centred line.
- **Beats**: 0-1 logo; 1-3 hook phrase (slide-up out); 3-4.5 hero word, large, with a small line below; four to six 1.0-1.2 s sentence beats ("verb [icon] noun") each as one text clip with a small image clip placed inline (manual x offset computed by the template from the text width, an approximation); 1.5 s outlined hero number (text with `stroke.width` and no fill colour, a gap); 3 s end card with logo and the call to action, last word fades in last.
- **Slots** `logo`, `icon1..icon6` (PNG), `heroPhoto` optional. **Texts** `hook`, `hero`, `s1..s6`, `number`, `cta`.
- **Transitions** none; text animation `fade` in 0.25 and `slide-up` out 0.2 (the observed swap-in-place with blur is a gap); one `zoom` 0.3 into the end card.
- **Doable now** yes. **Gaps**: blur-in text and word stagger, inline icon flow, fill-less outline text, mint blob wash.

### E. Long-form narrative explainer (Aside; 1 of 22)
- **Duration** 60-90 s, **aspect** 16:9.
- **Canvas** alternates `#252526` (dark) and `#fbfbfb` (light) in 8-20 s chapters; a gradient wordmark card (`#95b9cd` blue-grey).
- **Type** statement size 8 left-aligned, accent word colour `#0ba0ff`; inline glyph icons (see D); chat bubbles size 3.5 in rounded rectangles; benchmark bars as rectangles with `scaleX` keyframes 0 -> value over 0.8 s.
- **Beats** problem (dark, 20 s): 5-6 short sentences; reveal (gradient wordmark, 2 s); solution (light, 30 s): one statement, a command bar typed, 6-8 step lines appearing one per 1.2 s; proof (dark, 8 s): bar chart; privacy chapter (light, 15 s) ending on the end card (dark).
- **Slots** `logo`, `appshot1..3`. **Texts** `problem1..6`, `reveal`, `command`, `step1..8`, `claim`, `url`.
- **Transitions** `fade-black` between light and dark chapters, `dissolve` within.
- **Doable now** yes, laborious. **Gaps**: inline icons, 3D funnel (skip), per-word colour.

### F. Hero-render sting (Jumper, fomo; 2 of 22)
- **Duration** 8-18 s (target 9), **aspect** 16:9 or 1:1.
- **Canvas** deep violet `#15082b` with bottom purple glow, or flat indigo `#4a30f3`; a light grid-floor scene as an optional slot.
- **Type** statement size 5-6 white; hero phrase size 12; URL size 3 in lilac `#d6a1fc`.
- **Beats**: 0-1 hero render (3D logo supplied as video/PNG slot); 1-3 second render on light scene (hard cut); 3-4 coin render with light beam; 4-6 one-line statement; 6-8 hero phrase (second word slides in); 8-9 URL line.
- **Slots** `render1..3`, `logo`. **Texts** `statement`, `hero`, `url`.
- **Transitions** hard cuts at 0.8 and 2.6 s, `dissolve` 0.3 into the statement.
- **Doable now** yes; the quality depends on supplied renders. **Gaps**: blurred slide-in, gradient glows.

### G. Cursor-driven UI simulation with number popups (Polymarket, Hunch; 2 of 22)
- **Duration** 20-57 s (target 22), **aspect** 16:9.
- **Canvas** `#080a0d` with a glow behind the UI (`#5e4cf9` blue-violet or green `#49d064`).
- **Type** headline size 7 bold white, accent word violet; popups size 6 green `#49d064` / red `#e4205b`; end URL size 3.
- **Beats**: 0-1 glyph; 1-4 headline typed; 4-10 UI clip with cursor, crop in to the order panel (crop left/right 0.3, scale 140 %); 10-12 market card; 12-15 hero button + stacked gains (three text clips each `slide-up` 0.3, staggered 0.25); 15-17 phrase; 17-20 end line + brand; optional 3 s logo marquee (rows of text clips).
- **Slots** `ui1`, `ui2`, `logo`. **Texts** `headline`, `accent`, `gain1..3`, `endline`, `url`.
- **Transitions** `zoom` 0.3 into UI, `dissolve` 0.3 out.
- **Doable now** yes with a recorded UI. **Gaps**: cursor click, count-up, confetti, glow.

### H. Window-frame step walkthrough (Google AI Studio, Creator Studio; 2 of 22)
- **Duration** 30-55 s (target 40), **aspect** 16:9 or 1:1.
- **Canvas** `#040504` / `#010101`, a single UI recording slot centred with rounded mask; for vertical, the clip fills with blur background.
- **Type** only three text moments: opening (size 8, 2 lines), one mid step (size 4), end line (size 8, `#ffffff`) + URL (size 3). Captions on the UI are baked in the recording.
- **Beats**: 0-4 opening text; 4-30 UI clip with keyframed crop/scale zooms to each region (each region held 4-6 s, 0.6 s ease); 30-34 browser result; 34-38 end line; 38-42 URL.
- **Slots** `screen` (the whole recording, 25-45 s), `result` optional. **Texts** `opening`, `end`, `url`.
- **Transitions** `dissolve` 0.4 only; zoom steps are keyframes.
- **Doable now** yes. Cheapest to build; template value is the keyframed region zooms. **Gaps**: cursor smoothing, window frame asset, auto zoom-to-region.

### I. Manifesto collage (saviomartin, Brim3nEdits; 2 of 22)
- **Duration** 20-26 s, **aspect** 4:3 or 16:9.
- **Canvas** white `#fcfcfc` and black `#030303`, or warm grey `#cfd1cd` with a shadow overlay (supplied multiply PNG, `blendMode` multiply).
- **Type** serif (system Georgia/Times as the fallback), size 6 centred, accent word italic (two text clips side by side; gap); sans hero numbers size 13 bold `#2f2f2c`; handwriting accents optional.
- **Beats**: 0-2 three flash cuts (0.1-0.2 s each, slot clips) with the opening phrase over; 2-4 two-line serif card; 4-9 collage: 4-5 image clips pop in sequence (0.25 pop, 1 s apart) at fixed positions; 9-10 black card; 10-16 interview clips with burned captions (use auto-captions, serif style) or short phrase cards; 16-20 two phrase cards; 20-22 sans "result" card with a small superscript (a second text clip); 22-25 closing phrase and typed "coming soon" or URL.
- **Slots** `flash1..3`, `photo1..5`, `interview1..2`, `closing`. **Texts** `p1..p8`, `number`, `closing`, `url`.
- **Transitions** hard cuts; `fade-black` 0.3 into end; `pop` text.
- **Doable now** yes; per-run italics only via two clips. **Gaps**: per-run styling, odometer count-up, texture overlays (workable with image + blend mode).

### J. Press-wall hype montage (Whop; 1 of 22)
- **Duration** 15-25 s, **aspect** 16:9.
- **Canvas** off-white `#f2f2f2` with a paper texture image; clips graded `mono` filter plus contrast.
- **Type** headline condensed bold size 9-22 (uses a condensed face; fallback Impact/Arial Narrow not verified), black `#282b2c`; subtitle size 3 white with shadow.
- **Beats**: 0-2.5 six archive shots of 0.15-0.5 s (use `mono`); 2.5-4 sentence over a macro clip; 4-6 UI; 6-9 stock cash clip, then newspaper headline images sliding up (slide-up on image clips, 0.3 s apart); 9-10 tweet card image; 10-12 torn-paper stat (hero number image or text size 22, `#282b2c`) and a sticker logo; 12-15 server macro; 15-17 two-part closing sentence over night footage; 17-19 sticker logo end.
- **Slots** `archive1..6`, `ui1..2`, `news1..3`, `tweet`, `macro1..2`, `logo`. **Texts** `sentence1`, `stat`, `statLabel`, `closing1`, `closing2`.
- **Transitions** hard cuts; `slide-left` 0.2 for the paper strips.
- **Doable now** mostly. **Gaps**: speed ramps, shake, flash cuts (short white fade-through clips as a workaround), paper-tear mask.

### K. Typed-caption swatch reel (Grainient; 1 of 22)
- **Duration** 40-80 s, **aspect** 16:9.
- **Canvas** `#050504` with swatch images (cyan `#15e2f6`, magenta `#de00ff`, deep blue `#0734a7`, lime).
- **Type** white size 7 normal, typed in 1.2 s with a "|" appended (as text, no blink), hero word size 20 bold.
- **Beats** repeating "typed line (2 s) -> swatch tile pop (1.5 s) -> tile grid (3 s)" about 12 times; midpoint pastel inversion card; UI prompt segment with cursor; testimonial wall (6 s) dimmed; end ring and logo.
- **Slots** `swatch1..8`, `ui`, `logo`, `quotes` (screenshot). **Texts** `line1..12`, `hero`.
- **Transitions** `dissolve` 0.5 and `zoom` 0.4.
- **Doable now** yes. **Gaps**: caret blink, gradient generation, before/after slider (wipe-left with keyframed position as a workaround).

## 6. Style elements we cannot do yet, ranked by how many of the 22 use them

Counts are by eye from the sheets (+/-2). "Today" = what the model offers per `docs/CAPCUT_PARITY.md` and `definitions.ts`: elements video/image/audio/text/graphic/effect; transform keyframes (position, scale, rotate, opacity), 17 blend modes, blur effect, one mask, rectangle/ellipse/polygon/star graphics with solid fill, solid-colour or blur canvas background, text with stroke/shadow/box/spacing/crop, text animations (4), transitions (7), filters (8), freeze frame, constant speed, captions.

| Rank | Style element | Videos (of 22) | Which | Engine feature needed | Workaround today |
|---|---|---|---|---|---|
| 1 | Text blur-in/out, in-place word swap, per-word stagger | 15 | 3, 4, 5, 6, 8, 9, 12, 14, 16, 17, 19, 20, 21, 22, 2 | text animations `blur-in`, `blur-out`, `stagger-words`, `morph-swap`; keyframeable text blur | `fade` + `slide-up` on stacked clips |
| 2 | Animated cursor with click ripple (arrow, hand, dot) | 14 | 1, 2, 3, 4, 5, 6, 9, 10, 13, 14, 17, 18, 20, 22 | a cursor element: bundled sprites, path with easing and dwell, click pulse and ring ripple, auto-target to a point | PNG sprite + position keyframes, manual |
| 3 | Gradient and mesh backgrounds, drifting blobs | 13 | 1, 2, 3, 4, 8, 9, 12, 15, 16, 17, 20, 21, 22 | `Background` type `gradient`/`mesh` (multi-stop, animated stops) and graphic gradient fill | generated gradient image/video loop on the main track |
| 4 | Blur/whip/zoom-blur/flash/glitch transitions and UI morphs | 10 | 3, 4, 6, 11, 12, 14, 15, 18, 21, 22 | transition types `blur`, `zoom-blur`, `flash`, `glitch`, `morph` | `zoom`, `dissolve`, white fade-through clip |
| 5 | Per-run text styling (accent word colour/italic/gradient) | 9 | 2, 5, 7, 8, 9, 14, 19, 21, 22 | rich-text runs in a text element (colour, style, gradient fill per run) | two text clips butted together; breaks on edit |
| 6 | Perspective/3D tilt of UI and cards | 8 | 1, 3, 8, 15, 18, 20, 22, 9 | `transform.rotateX/rotateY/perspective` or a four-corner pin, rendered in `render/` | none (flat) |
| 7 | Device and browser frames, rounded cards with soft shadow | 8 | 1, 2, 4, 5, 6, 13, 16, 17 | frame assets plus image shadow/rounded clip; mask with corner radius on image elements | rectangle graphic behind a masked image |
| 8 | Typed text with blinking caret; typed input fields | 8 | 1, 2, 6, 9, 10, 14, 19, 7 | `typewriter` option `caret: true, blink`, caret glyph style; field highlight | typewriter with a literal "|" |
| 9 | Count-up / odometer numbers | 6 | 3, 4, 11, 14, 18, 19 | numeric text param interpolated by keyframes with a format (thousands, currency) | stacked text clips; manual |
| 10 | Orbit, spiral and marquee loop paths | 5 | 1, 3, 9, 16, 18 | path/orbit presets and loop repeat for keyframes; text-marquee element | hand-keyframed rotation of a group (no groups either) |
| 11 | Shape/mask reveals (iris, ellipse, wipe-to-shape) | 5 | 3, 6, 9, 17, 21 | animated mask (keyframes on mask params), multiple masks, shape-to-shape morph | `wipe-left/right` |
| 12 | Inline icons inside a sentence that reflow | 4 | 4, 5, 16, 21 | inline image/emoji runs in text layout | measure text, offset image manually |
| 13 | Draw-on lines and animated charts (line/bar draw, trim path) | 4 | 5, 8, 14, 18 | shape keyframes beyond transform: path trim, bar value tween | rectangle with `scaleX` keyframes (bars only) |
| 14 | Speed ramps, whip cuts, shake | 3 | 7, 11, 15 | retime curves, camera shake preset | none |
| 15 | Outline-only (no fill) numerals and text | 2 | 4, 14 | text fill alpha 0 with stroke; stroke align | `stroke.width` with colour matching the background |
| 16 | Texture overlays (paper, window shadow, grain) | 4 | 7, 11, 19, 8 | none beyond assets | multiply-blend image overlay: **works today** |
| 17 | Beat sync of picture to the music | unverified | all have music | snap-to-beat in the editor and `cut_to_moments` on the beat grid | `plan_cuts_to_style`, no snap UI |

Not a gap (supported now): sentence-level text with stroke/shadow/box chips, pill chips (rectangle `cornerRadius` 50), slide-up/pop/fade text, push-in zooms (scale keyframes), region zoom (crop + scale), end card (text + image), filters for `mono`/`teal-orange`, background blur, dissolve/slide/wipe/zoom transitions, captions (for the manifesto interview captions), blend-mode overlays.

Template-format additions this analysis implies (small, additive, for doc 10 section 4): `texts[].runs` (per-run style, depends on rank 5), `beats[].cursor` (path points, depends on rank 2), `repeat` groups (A and K need them, already in doc 10), `background.gradient` (rank 3), a `requires: [...]` list so unavailable cards grey out (doc 10 already has it).

## 7. Which archetypes to build first

Weigh coverage (how many of the 22), feasibility on today's engine, and how much of the look survives the missing features.

1. **D. Inline-icon kinetic sentences** (2 videos, plus a pattern inside 5 and 16). Pure text and small images on a flat field; the four animation presets plus `zoom` carry it; survives a flat mint floor image. Best "feels like the launch videos" return for the least engine work. Also the vertical-friendly one.
2. **A. Prompt-to-result loop** (3 videos). Typewriter, pop, a rounded rectangle and keyframes cover it; the gradient background is a bundled image. Highest-demand format for AI products (the audience of this editor).
3. **H. Window-frame step walkthrough** (2 videos). Almost no text; value is the keyframed region zooms. Cheapest to ship and useful for any "show the feature" cut.
4. **B. Tilted-UI tour on a dark gradient** (4 videos, the biggest cluster). Ship the flat version (push-in scales, corner-pinned captions, gradient image, `zoom`/`wipe` chip swap) before perspective exists; mark the 3D tilt as an upgrade gated on rank 6.
5. **I. Manifesto collage** (2 videos) and **F. Hero-render sting** (2 videos). Both are small and quick to build; F depends on the user supplying a good render, so it is mostly a layout.
6. After the engine ships blur-in text, cursor and gradient backgrounds: **G** (cursor UI simulation), then **C** (branded chapters), **J** (press-wall montage, needs speed ramps), **E** (long-form), **K** (swatch reel).

Engine work that unlocks the most templates at the lowest cost, in order: (1) text blur-in/out + stagger, (2) cursor element, (3) gradient background type, (4) per-run text styling, (5) blur/flash/zoom-blur transitions. Perspective tilt (rank 6) is the most expensive item and benefits B alone.

## 8. Things I could not verify, and caveats

- **Audio character.** I only measured loudness, loudness range, peaks and silent tails. I did not hear the music, so genre, BPM, instrumentation, SFX hits and whether cuts land on beats are not established. The tempo estimate I tried was unreliable and is not reported.
- **Exact text, fonts and sizes.** Font identities and text sizes are estimates from 384 px thumbnails (+/-30 %); line breaks and copy are not transcribed on purpose.
- **Second-level beat times** are +/-1 s (+/-2 s on the long videos) because contact sheets are 1 s or 2 s apart; scene-cut timestamps are accurate to the frame.
- **Cursor and click detail** was read from sparse frames; ripple/pulse timing was not measured.
- **Videos 1, 4, 6, 8, 16, 20** are continuous morphs, so their "cuts per 10 s" understates their pace; text-swap rates are my count.
- **fomo (16) and Hunch (18)** have the lowest-confidence beat notes (the square sheet for 16 is mostly pillarbox; the middle of 18 is dense UI).
- **Post availability.** I did not open the X posts or verify the tweets are still live; the URLs are built from the card links and the status ids. The doc 10 caveat about the oEmbed check still applies.
- **Fonts for templates.** I did not check whether the editor's Canvas text can use Inter / Host Grotesk or only system fonts; the type recipes therefore name roles (bold sans, serif) rather than bundled faces.
- **Engine claims** (what exists today) come from `docs/CAPCUT_PARITY.md` and `src/engine/model/definitions.ts`/`params.ts` at 508afa2; I did not run the app or test any template.
- **Legal.** Study use only; nothing from the videos is stored in the repo or will ship. Our templates are original layouts and must use our own generated gradients, icons and renders. The 'Inspiration' list rules in doc 10 section 3 still apply: link and describe, do not embed.
