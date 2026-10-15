import { GRADIENT_MAX_COLORS, GRADIENT_MIN_COLORS, GRADIENT_STYLES, type Background, type GradientBackground } from "#/engine/model";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const DEFAULT_GRADIENT: GradientBackground = { type: "gradient", style: "linear", colors: ["#1e1b4b", "#7c3aed"], angle: 135, motion: 0 };

/** Why a gradient cannot be used, or null. Anything read from a file or a tool goes through this before it is drawn. */
export function gradientProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "a gradient must be an object";
  const g = value as Partial<GradientBackground>;
  if (!(GRADIENT_STYLES as readonly string[]).includes(g.style as string)) return `style must be one of ${GRADIENT_STYLES.join(", ")}`;
  if (!Array.isArray(g.colors) || g.colors.length < GRADIENT_MIN_COLORS || g.colors.length > GRADIENT_MAX_COLORS) {
    return `colors needs ${GRADIENT_MIN_COLORS} to ${GRADIENT_MAX_COLORS} entries`;
  }
  if (!g.colors.every((c) => typeof c === "string" && HEX_COLOR.test(c))) return "every colour must be #rrggbb";
  if (typeof g.angle !== "number" || !Number.isFinite(g.angle)) return "angle must be a finite number";
  if (typeof g.motion !== "number" || !Number.isFinite(g.motion) || g.motion < 0 || g.motion > 100) return "motion must be between 0 and 100";
  return null;
}

/** The gradient to draw for a project background, or null for colour and blur backgrounds and for a damaged gradient. */
export function activeGradient(background: Background): GradientBackground | null {
  return background.type === "gradient" && gradientProblem(background) === null ? background : null;
}

/** `#rrggbb` as an `rgba()` string; transparent stops let a blob fade into what is behind it. */
export function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export interface GradientLine { x0: number; y0: number; x1: number; y1: number }

/** Start and end of a CSS-style linear gradient that exactly spans a box, for `angle` degrees (0 = bottom to top, 90 = left to right). */
export function linearGradientLine(input: { width: number; height: number; angle: number }): GradientLine {
  const a = (input.angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const half = (Math.abs(input.width * dx) + Math.abs(input.height * dy)) / 2;
  const cx = input.width / 2;
  const cy = input.height / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

/** Degrees per second a linear gradient turns at full motion. */
export const GRADIENT_TURN_RATE = 36;
/** Seconds one drift cycle takes at full motion. */
const DRIFT_PERIOD_SECONDS = 12;
/** How far a blob wanders from its home, as a share of the canvas. */
const DRIFT_REACH = 0.14;

export const gradientAngleAt = (g: GradientBackground, seconds: number): number => g.angle + (g.motion / 100) * GRADIENT_TURN_RATE * seconds;

export interface GradientBlob {
  /** Centre as a fraction of the canvas width and height. */
  x: number;
  y: number;
  /** Radius as a fraction of the longer canvas side. */
  radius: number;
  color: string;
}

/**
 * Where the blobs of a mesh (or the centre of a radial gradient: the first blob) sit at `seconds`. Homes are spread round an
 * ellipse in colour order; each wanders on its own Lissajous path, so the picture never repeats exactly and never jumps.
 */
export function gradientBlobs(input: { colors: ReadonlyArray<string>; motion: number; seconds: number }): GradientBlob[] {
  const n = input.colors.length;
  const phase = (input.motion / 100) * ((2 * Math.PI) / DRIFT_PERIOD_SECONDS) * input.seconds;
  return input.colors.map((color, i) => {
    const around = (i / n) * 2 * Math.PI - Math.PI / 2;
    const homeX = 0.5 + 0.34 * Math.cos(around);
    const homeY = 0.5 + 0.34 * Math.sin(around);
    return {
      x: homeX + DRIFT_REACH * Math.sin(phase * (1 + (i % 3) * 0.37) + i * 1.9),
      y: homeY + DRIFT_REACH * Math.cos(phase * (1 + ((i + 1) % 3) * 0.29) + i * 2.3),
      radius: 0.62,
      color,
    };
  });
}

/** Centre of a radial gradient: the middle, orbiting a little when it has motion. */
export function radialCenter(input: { motion: number; seconds: number }): { x: number; y: number } {
  const phase = (input.motion / 100) * ((2 * Math.PI) / DRIFT_PERIOD_SECONDS) * input.seconds;
  return { x: 0.5 + 0.12 * Math.sin(phase), y: 0.5 + 0.12 * Math.cos(phase * 1.3) };
}
