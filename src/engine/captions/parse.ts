import { mediaTimeFromSeconds, type MediaTime } from "#/engine/time";

export interface CaptionCue {
  text: string;
  startTime: MediaTime;
  duration: MediaTime;
  /** ASS only: fractional style hints resolved against the script's play resolution. */
  style?: CueStyle;
}

export interface CueStyle {
  fontFamily?: string;
  /** Font size as a fraction of the script play height. */
  fontSizeRatio?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeOut?: boolean;
  letterSpacing?: number;
  align?: "left" | "center" | "right";
  vertical?: "top" | "middle" | "bottom";
  marginLeftRatio?: number;
  marginRightRatio?: number;
  marginVerticalRatio?: number;
  backgroundColor?: string;
}

export interface ParsedCaptions {
  cues: CaptionCue[];
  skipped: number;
  warnings: string[];
}

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function srtSeconds(match: RegExpExecArray): number {
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number((ms as string).padEnd(3, "0")) / 1000;
}

export function parseSrt(input: string): ParsedCaptions {
  const blocks = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues: CaptionCue[] = [];
  let skipped = 0;
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
    if (lines.length < 2) {
      if (lines.length > 0) skipped++;
      continue;
    }
    const timeIndex = /-->/.test(lines[0] as string) ? 0 : 1;
    const timeLine = lines[timeIndex];
    if (!timeLine || !/-->/.test(timeLine)) { skipped++; continue; }
    const [from, to] = timeLine.split("-->");
    const a = SRT_TIME.exec(from ?? "");
    const b = SRT_TIME.exec(to ?? "");
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    if (!a || !b || !text) { skipped++; continue; }
    const start = srtSeconds(a);
    const end = srtSeconds(b);
    if (!(end > start)) { skipped++; continue; }
    cues.push({ text, startTime: mediaTimeFromSeconds(start), duration: mediaTimeFromSeconds(end - start) });
  }
  return { cues, skipped, warnings: [] };
}

// ---- ASS -----------------------------------------------------------------------------------------------------

function assColor(value: string): { css: string; alpha: number } | null {
  const m = /^&?H?([0-9a-f]{6,8})&?$/i.exec(value.trim());
  if (!m) return null;
  const hex = (m[1] as string).padStart(8, "0");
  const aa = parseInt(hex.slice(0, 2), 16);
  const bb = hex.slice(2, 4), gg = hex.slice(4, 6), rr = hex.slice(6, 8);
  return { css: `#${rr}${gg}${bb}`.toLowerCase(), alpha: 1 - aa / 255 };
}

function rgba(css: string, alpha: number): string {
  if (alpha >= 1) return css;
  return css + Math.round(alpha * 255).toString(16).padStart(2, "0");
}

const ALIGNMENT: Record<number, { align: "left" | "center" | "right"; vertical: "top" | "middle" | "bottom" }> = {
  1: { align: "left", vertical: "bottom" }, 2: { align: "center", vertical: "bottom" }, 3: { align: "right", vertical: "bottom" },
  4: { align: "left", vertical: "middle" }, 5: { align: "center", vertical: "middle" }, 6: { align: "right", vertical: "middle" },
  7: { align: "left", vertical: "top" }, 8: { align: "center", vertical: "top" }, 9: { align: "right", vertical: "top" },
};

function assTime(value: string): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})[.](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const frac = (m[4] as string);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(frac) / 10 ** frac.length;
}

function splitFields(line: string, count: number): string[] {
  const parts: string[] = [];
  let rest = line;
  for (let i = 0; i < count - 1; i++) {
    const idx = rest.indexOf(",");
    if (idx < 0) break;
    parts.push(rest.slice(0, idx).trim());
    rest = rest.slice(idx + 1);
  }
  parts.push(rest.trim());
  return parts;
}

export function parseAss(input: string): ParsedCaptions {
  const lines = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const warnings = new Set<string>();
  let section = "";
  let playX = 384, playY = 288;
  let styleFormat: string[] = [];
  let eventFormat: string[] = [];
  const styles = new Map<string, CueStyle>();
  const cues: CaptionCue[] = [];
  let skipped = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { section = (header[1] as string).toLowerCase(); continue; }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (section === "script info") {
      if (key === "playresx") playX = Number(value) || playX;
      if (key === "playresy") playY = Number(value) || playY;
    } else if (section === "v4 styles" || section === "v4+ styles") {
      if (key === "format") styleFormat = value.split(",").map((f) => f.trim().toLowerCase());
      if (key === "style") {
        const fields = splitFields(value, styleFormat.length);
        const get = (name: string): string | undefined => fields[styleFormat.indexOf(name)];
        const primary = assColor(get("primarycolour") ?? "");
        const back = assColor(get("backcolour") ?? "");
        const alignment = ALIGNMENT[Number(get("alignment"))] ?? ALIGNMENT[2];
        const style: CueStyle = {
          fontFamily: get("fontname"),
          fontSizeRatio: Math.round((Number(get("fontsize")) / playY) * 1000) / 1000 || undefined,
          color: primary ? rgba(primary.css, primary.alpha) : undefined,
          bold: Number(get("bold")) !== 0 && get("bold") !== undefined,
          italic: Number(get("italic")) !== 0 && get("italic") !== undefined,
          underline: Number(get("underline")) !== 0 && get("underline") !== undefined,
          strikeOut: Number(get("strikeout")) !== 0 && get("strikeout") !== undefined,
          letterSpacing: Number(get("spacing")) || 0,
          align: alignment?.align, vertical: alignment?.vertical,
          marginLeftRatio: Number(get("marginl")) / playX || 0,
          marginRightRatio: Number(get("marginr")) / playX || 0,
          marginVerticalRatio: Number(get("marginv")) / playY || 0,
        };
        if (Number(get("borderstyle")) === 3 && back) style.backgroundColor = rgba(back.css, back.alpha);
        else if (get("borderstyle") && ![1, 3].includes(Number(get("borderstyle")))) warnings.add("Unsupported ASS border style ignored");
        if (Number(get("outline")) > 0 || Number(get("shadow")) > 0) warnings.add("ASS outline and shadow are not supported");
        styles.set((get("name") ?? "Default").toLowerCase(), style);
      }
    } else if (section === "events") {
      if (key === "format") eventFormat = value.split(",").map((f) => f.trim().toLowerCase());
      else if (key === "dialogue") {
        const fields = splitFields(value, eventFormat.length || 10);
        const get = (name: string): string | undefined => fields[eventFormat.indexOf(name)];
        const start = assTime(get("start") ?? "");
        const end = assTime(get("end") ?? "");
        const text = (get("text") ?? "")
          .replace(/\{[^}]*\}/g, "").replace(/\\N|\\n/g, "\n").replace(/\\h/g, " ").trim();
        if (start === null || end === null || !(end > start) || !text) { skipped++; continue; }
        if ((get("effect") ?? "") !== "") warnings.add("ASS event effects are ignored");
        const style = styles.get((get("style") ?? "Default").toLowerCase()) ?? styles.get("default");
        cues.push({ text, startTime: mediaTimeFromSeconds(start), duration: mediaTimeFromSeconds(end - start), style });
      } else {
        warnings.add(`ASS ${key} events are ignored`);
      }
    }
  }
  return { cues, skipped, warnings: [...warnings] };
}

export function parseSubtitleFile(input: { name: string; text: string }): ParsedCaptions {
  const ext = input.name.toLowerCase().split(".").pop();
  if (ext === "srt") return parseSrt(input.text);
  if (ext === "ass" || ext === "ssa") return parseAss(input.text);
  throw new Error(`Unsupported subtitle format ".${ext ?? ""}"`);
}

/** Groups transcript words into short caption chunks without overlap, as classic's transcription step does. */
export function chunkTranscript(input: {
  segments: ReadonlyArray<{ text: string; start: number; end: number }>; wordsPerCaption?: number; minDuration?: number;
}): Array<{ text: string; start: number; duration: number }> {
  const perCaption = input.wordsPerCaption ?? 3;
  const minDuration = input.minDuration ?? 0.8;
  const out: Array<{ text: string; start: number; duration: number }> = [];
  let lastEnd = 0;
  for (const segment of input.segments) {
    const words = segment.text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const segmentDuration = Math.max(0, segment.end - segment.start);
    const secondsPerWord = segmentDuration / words.length;
    let cursor = segment.start;
    for (let i = 0; i < words.length; i += perCaption) {
      const group = words.slice(i, i + perCaption);
      const duration = Math.max(minDuration, group.length * secondsPerWord);
      const start = Math.max(cursor, lastEnd);
      out.push({ text: group.join(" "), start, duration });
      cursor = start + duration;
      lastEnd = start + duration;
    }
  }
  return out;
}
