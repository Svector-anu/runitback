export interface LinearRgba { r: number; g: number; b: number; a: number }

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c: number): number {
  const v = clamp01(c);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Accepts #rgb, #rgba, #rrggbb, #rrggbbaa. Returns null for anything else. */
export function parseHexToLinearRgba(hex: string): LinearRgba | null {
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m || m[1] === undefined) return null;
  let digits = m[1];
  if (digits.length <= 4) digits = [...digits].map((c) => c + c).join("");
  const byte = (i: number): number => parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
  return {
    r: srgbToLinear(byte(0)),
    g: srgbToLinear(byte(1)),
    b: srgbToLinear(byte(2)),
    a: digits.length === 8 ? byte(3) : 1,
  };
}

export function formatLinearRgba({ r, g, b, a }: LinearRgba): string {
  const hex = (v: number): string => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  const base = `#${hex(linearToSrgb(r))}${hex(linearToSrgb(g))}${hex(linearToSrgb(b))}`;
  return a < 1 ? base + hex(a) : base;
}
