// Run: pnpm exec tsx docs/research/repros/captions-dos.ts
import { parseAss, parseSrt } from "#/engine/captions";
import { makeEditor } from "../../../tests/helpers";
import { addTrack, batch, insertElement } from "#/engine/commands";
import { buildTextElement } from "#/engine/model";
import { totalDuration } from "#/engine/timeline";
import { mediaTime } from "#/engine/time";

const out: string[] = [];
const time = <T>(label: string, fn: () => T): T => { const t = performance.now(); const r = fn(); out.push(`${label}: ${(performance.now() - t).toFixed(0)} ms`); return r; };

// C1: quadratic {…} stripping in ASS dialogue text
for (const n of [20_000, 40_000, 80_000]) {
  const ass = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${"{".repeat(n)}\n`;
  time(`C1 parseAss with ${n} unmatched '{'`, () => parseAss(ass));
}
// C2: unbounded ASS hours => absurd timeline duration
{
  const ass = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,99999999999:00:00.00,99999999999:00:01.00,Default,,0,0,0,,boom\n`;
  const parsed = parseAss(ass);
  const cue = parsed.cues[0];
  out.push(`C2 cue start ticks = ${cue?.startTime} (Number.MAX_SAFE_INTEGER=${Number.MAX_SAFE_INTEGER}); safe integer? ${Number.isSafeInteger(cue?.startTime ?? 0)}`);
  const { editor } = makeEditor();
  const trackId = "txt";
  try {
    editor.execute(batch("cap", [addTrack({ type: "text", index: 0, trackId }), insertElement({ element: buildTextElement({ id: "c", startTime: cue!.startTime, duration: cue!.duration }), placement: { mode: "explicit", trackId } })]));
    out.push(`C2 timeline duration now ${totalDuration(editor.tracks())} ticks = ${(totalDuration(editor.tracks()) / 120000 / 3600).toExponential(2)} hours; export frameCount would be ${(totalDuration(editor.tracks()) / 4000).toExponential(2)}`);
  } catch (e) { out.push(`C2 execute threw ${String(e)}`); }
}
// C3: overlapping SRT cues land on ONE track via the Captions import path (explicit placement)
{
  const srt = "1\n00:00:01,000 --> 00:00:05,000\nA\n\n2\n00:00:02,000 --> 00:00:04,000\nB\n";
  const parsed = parseSrt(srt);
  const { editor } = makeEditor();
  const trackId = "txt";
  editor.execute(batch("cap", [addTrack({ type: "text", index: 0, trackId }), ...parsed.cues.map((c, i) => insertElement({ element: buildTextElement({ id: `c${i}`, startTime: c.startTime, duration: c.duration }), placement: { mode: "explicit", trackId } }))]));
  const els = editor.tracks().overlay.find((t) => t.id === trackId)!.elements;
  const overlapping = els[0]!.startTime + els[0]!.duration > els[1]!.startTime;
  out.push(`C3 overlapping SRT cues produce overlapping clips on one track: ${overlapping}`);
}
// C4: SRT lenient hour field / negative-looking input
{ const p = parseSrt("1\n123:00:01,000 --> 00:00:05,000\nA\n"); out.push(`C4 srt '123:00:01' accepted as ${p.cues[0]?.startTime} (unanchored regex matches '23:00:01')`); }
void mediaTime;
console.log(out.join("\n"));
