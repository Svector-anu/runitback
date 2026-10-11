# Real-footage end-to-end acceptance (roadmap N7)

Run 2026-10-11 on an Apple-silicon Mac, Vite dev server, real Chrome (`channel: "chrome"`, H.264/AAC), real Whisper (`whisper-tiny.en`), CLIP (`clip-vit-base-patch32`) and MediaPipe BlazeFace, real exporter, and a real model (`claude-haiku-4.5` through a gateway, Node-side bridge: the key never enters the page). Spec: `e2e/real-footage.spec.ts`. The model key's budget was almost spent, so only part of the model scenarios completed; the table says exactly which.

Footage (local only, never committed): an 83 s product promo (1920x1080, 24 fps, H.264/AAC), a 7 s clip (1902x1080, 60 fps), and a synthetic face clip (macOS `say` speech muxed over Google's public MediaPipe `portrait.jpg`, 1280x720, 9.4 s). `keeperhub.mp4` (356 MB) was not used: the 83 s promo already contains every queried shot. `Vv_F2pPF3yVR6uoP.mp4` is blocked by macOS permissions and was not touched.

Note on the footage: the "narrated" promo has music with sung lyrics, not a narrator. Whisper tiny transcribes it as plausible but wrong text ("Game to the game with a brand new sauce ..."), so the transcript scenario's phrase ("It's going on to", source 50.98 s) is real Whisper output but not real narration.

## Results

| # | Scenario | Result | Objective measurement | Model steps / tokens / cost | Wall |
|---|---|---|---|---|---|
| 0a | Import 3 files | pass | 3 assets probed and stored, 1.5 s | none | 1.5 s |
| 0b | Press **Understand all**, confirm the one consent dialog (2 models, about 206 MB) | pass, 4 runs | every asset reached `understood` with analysis, transcript, visual and faces stored; promo 141 words, face clip 29 words, 7 s clip 1 word | none | 113 to 157 s for all three, including the model downloads (promo done at 91 to 99 s) |
| 1 | Transcript: "find where the narrator talks about <phrase> and cut a ~10 s highlight" | **fail** (first run, old prompt) | the agent appended a 10 s copy (source 46 to 56 s) after the untouched 82.6 s clip: timeline 92.6 s, phrase covered, but not a highlight. Its verification quoted the 9.98 s clip, not the timeline. Plan shown (1 step), project unchanged while awaiting, one undo restored the original | 11 / 219,096 / $0.086 (history from the previous scenario included) | 44.5 s |
| 1b | Same, after the prompt fix below | **not completed** | the agent now trims the clip (45.98 to 55.98 s) instead of appending, but my budget guard stopped it after 11 calls (about $0.07) before it finished; not scored | 11 / n.r. / about $0.07 | n.r. |
| 2 | Visual: "payment / Allow-Deny screen first, then the confetti shot" | **fail** | order correct (payment first, confetti second, no overlap, one undo restored). Confetti shot 68 to 72 s is right (human-checked 66 to 70 s). The "payment" shot is source 21.8 to 25.8 s, which does not overlap the checked range 26 to 30 s: CLIP's top hit was a frame before the Allow/Deny screen. The agent's verification reported times and durations only and called the shot "payment/Allow-Deny" | 15 / 376,176 / $0.195 (history from two earlier scenarios included) | 65.1 s |
| 3 | Pace: "remove dead air and keep it under 40 seconds" | **not completed** | the run was cut off by my own budget guard after 5 calls ($0.038, a guard misconfiguration: the per-scenario cap was half the remaining budget). The agent had inspected the footage and found the only silence is a 0.37 s tail (source analysis: one silence, 0.37 s); timeline stayed 82.6 s. "Dead air" is barely present in this footage | 5 / 82,811 / $0.038 | 17.1 s |
| 4 | Vertical reframe on the face clip | pass | canvas became 1080x1920 (9:16), `face.mp4` got `transform.positionX/Y` and scale keyframes from the real face detections, no overlap, plan shown (2 steps, doc unchanged while awaiting), one undo restored the document, add-clip undone to base | 12 / 201,163 / $0.071 | 39.8 s |
| 5a | Export the unedited 83 s timeline with the real exporter, decode the file | pass | MP4 avc + aac, 1920x1080, 18.7 MB, decoded 82.73 s vs timeline 82.645 s (+0.09 s), 83 of 83 one-second windows audible (RMS above 0.005), exported frames at 0.5, 41.3, 81.6 s match the source frames at the same time (mean abs difference 0.0 to 0.1 of 255 against 11 to 18 for a frame 9 s off) | none | export 26.8 s |
| 5b | Export an edited timeline (scripted replay of the scenario-2 cut, two 4 s shots, no model call) | pass | expected 8.00 s, decoded 8.08 s, 1920x1080 avc/aac, 2.6 MB, 9 of 9 windows audible, frames at 0.5, 4, 7 s match source 26.5, 66, 69 s (difference 0.1 to 0.3 against 17 to 31 wrong) | none | export 7.0 s |

Model cost this effort, at Haiku rates ($1 / $5 per million tokens, cache read $0.10, write $1.25): about $0.46 of the $0.50 cap. No 4xx or budget error came from the gateway; the stops above are my own guard. Real-model numbers, one run each: they show behaviour, not statistics.

Unverified: scenario 1 and 3 after the fix, scenario 2 with a fresh conversation, a run of all scenarios in one pass with the final spec, Chromium without H.264, a reload in the middle of Understand, footage longer than 83 s, the tracked face quality (only that keyframes were written, not that the crop looks right; screenshots are in `e2e/.artifacts/real-vertical-face-done.png`).

## Fix made

`src/app/agent/system-prompt.ts` (rule added): `cut_to_moments` appends after the clips already on the main track, so a request for a highlight, shorter cut or "keep only" must leave the finished timeline as that result (delete or replace the originals unless asked to keep them) and the agent must report the length of the whole timeline from `get_timeline`. Evidence: before, scenario 1 appended to a 92.6 s timeline; after, the agent chose `trim` of the original clip. The end state under the fix was not scored (budget). Typecheck, lint and all 1367 unit tests pass.

## Findings, ranked

- **P1. A highlight request produced an appended copy and the verification hid it** (scenario 1). Fixed in the prompt (above), not yet confirmed to completion. The verification line should be checked mechanically against `get_timeline`: the claimed total length must come from the whole timeline.
- **P1. Cost per request is high and grows with the conversation.** About 15 to 17k input tokens per model call (about 40 tool schemas plus rendered frames); 5 to 15 calls per request: $0.04 to $0.20 with Haiku. The conversation is kept across requests, so scenario 2 (third in a conversation) cost 2.7x scenario 4. The spec now starts a fresh conversation per scenario. Product: drop old `render_frame` images from the history, show a visible cost/length indicator, offer "New chat" more prominently, check that prompt caching is hit.
- **P2. Visual search misses the exact shot on text-heavy UI** (scenario 2): the agent trusted the top hit at 2 s sampling and its own `render_frame` check did not catch it; the final claim did not state what the frame showed. Needs a cheaper verification step (one contact sheet of the chosen ranges) or finer sampling around the top hit.
- **P2. Whisper-tiny on music hallucinates fluent lyrics**, and the agent treats the transcript as ground truth. There is no per-word confidence shown to the agent or user, and no music/speech warning. Scenario 1's phrase search therefore works on text that was never said.
- **P2. "Remove dead air" on footage with no silence.** The agent should say "there is almost none (0.37 s)" and ask what to cut for "under 40 s" instead of choosing content by transcript spans; the brief needs a different tool (shot selection by loudness or saliency). Not verified to completion.
- **P3. Understand is serial and slow without GPU:** 83 s of video took about 90 s end to end including a fresh 206 MB model download (every fresh browser profile pays it); the three files together 113 to 157 s. The promo's tile stays at "Visual index" or "Faces" a long time with only a percentage.
- **P3. Decoded export duration is slightly longer than the timeline** (+0.08 to +0.09 s, audio frame padding), harmless but visible to a strict duration check (this spec allows 0.3 s).
- **P3. The "Ask before editing" plan card works as designed in all runs:** plans shown before edits, document unchanged while awaiting, one undo restores; no defect found there.

## Top product issues observed

1. Request cost and token growth across a conversation (P1).
2. Highlight semantics: tools append, users expect a replacement (P1, fixed in prompt).
3. Agent verification states times it set, not what is visible in the shot (P2).
4. CLIP's top hit is trusted without a check on text-heavy UI (P2).
5. Speech transcripts from music are presented as fact (P2).

## How to rerun

```sh
# the spec needs real Chrome (H.264/AAC): run it with a temp config that sets use.channel = "chrome"
source ~/.surplus-env            # or any ANTHROPIC_API_KEY (+ ANTHROPIC_BASE_URL)
export REAL_FOOTAGE=1 REAL_BUDGET_USD=0.5 \
  FOOTAGE_PROMO=/path/promo.mp4 FOOTAGE_SHORT=/path/short.mp4 FOOTAGE_FACE=/path/face.mp4
# optional: REAL_MODEL_ID=claude-haiku-4.5 REAL_SCENARIOS=transcript,visual,pace,vertical-face
# optional: FOOTAGE_PAYMENT_RANGE=26,30 FOOTAGE_CONFETTI_RANGE=66,70  (human-checked source seconds)
pnpm exec playwright test e2e/real-footage.spec.ts
```

`REAL_SCENARIOS=none` runs import, Understand and the export checks (no model calls; the export then replays a scripted two-shot cut when the timeline is untouched). The report is `e2e/.artifacts/real-footage-report.jsonl` (gitignored; screenshots `e2e/.artifacts/real-*.png`). The spec never prints, logs or writes the key; Playwright traces are off in the temp config. The face clip: `say -o speech.aiff "..."` then `ffmpeg -loop 1 -framerate 24 -i portrait.jpg -i speech.aiff -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p" -c:v libx264 -c:a aac -shortest face.mp4` with `portrait.jpg` from `https://storage.googleapis.com/mediapipe-assets/portrait.jpg`.
