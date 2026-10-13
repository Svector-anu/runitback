/** Number formatting for count-up text: pure, locale-independent (en-US), shared by preview and export. */

export const COUNT_FORMATS = ["plain", "thousands", "compact", "percent"] as const;
export type CountFormat = (typeof COUNT_FORMATS)[number];

export interface CountSpec {
  format: CountFormat;
  decimals: number;
  prefix: string;
  suffix: string;
}

const COMPACT_STEPS: ReadonlyArray<readonly [number, string]> = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
export const MAX_COUNT_DECIMALS = 6;

const clampDecimals = (decimals: number): number => Math.min(MAX_COUNT_DECIMALS, Math.max(0, Math.round(decimals)));

function grouped(value: number, decimals: number): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole = "0", fraction] = fixed.split(".");
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? withCommas : `${withCommas}.${fraction}`;
}

/** The text a count shows at `value`. Negative zero and values that round to zero print without a sign. */
export function formatCount(input: { value: number } & CountSpec): string {
  const decimals = clampDecimals(input.decimals);
  const value = Number.isFinite(input.value) ? input.value : 0;
  const rounded = Number(value.toFixed(decimals));
  const sign = rounded < 0 ? "-" : "";
  let body: string;
  switch (input.format) {
    case "plain": body = Math.abs(value).toFixed(decimals); break;
    case "thousands": body = grouped(value, decimals); break;
    case "percent": body = `${Math.abs(value).toFixed(decimals)}%`; break;
    case "compact": {
      const step = COMPACT_STEPS.find(([size]) => Math.abs(value) >= size);
      body = step ? `${(Math.abs(value) / step[0]).toFixed(decimals)}${step[1]}` : Math.abs(value).toFixed(decimals);
      break;
    }
  }
  return `${input.prefix}${sign}${body}${input.suffix}`;
}

/**
 * Reads a headline number out of ordinary text so "Count up" works on what is already typed: `$12,400+` gives a value of
 * 12400, a `$` prefix, a `+` suffix, thousands grouping and no decimals. Null when there is no number to count to.
 */
export function inferCount(content: string): ({ value: number } & CountSpec) | null {
  const match = /^([^\d\-.]*)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s.exec(content.trim());
  if (!match) return null;
  const [, prefix = "", digits = "", rest = ""] = match;
  const value = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const decimals = clampDecimals((digits.split(".")[1] ?? "").length);
  const percent = rest.startsWith("%");
  const compact = /^[KMBT]/.test(rest);
  const format: CountFormat = percent ? "percent" : compact ? "compact" : digits.includes(",") ? "thousands" : "plain";
  const suffix = percent || compact ? rest.slice(1) : rest;
  if (compact) {
    const factor = COMPACT_STEPS.find(([, letter]) => letter === rest[0])?.[0] ?? 1;
    return { value: value * factor, format, decimals, prefix, suffix };
  }
  return { value, format, decimals, prefix, suffix };
}
