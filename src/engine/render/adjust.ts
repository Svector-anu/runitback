import { numberParam, type ParamValues } from "#/engine/model";

export interface ColorCast {
  r: number;
  g: number;
  b: number;
  /** 0..1 strength of the cast mixed over the pixels. */
  alpha: number;
}

/** What the compositor has to do for an `adjust` effect; all fields are neutral when the effect changes nothing. */
export interface AdjustPlan {
  /** CSS filter chain (brightness, contrast, saturate) or "none". Runs on the GPU in Canvas2D. */
  filter: string;
  casts: ColorCast[];
  /** 0..1 darkening toward the corners. */
  vignette: number;
  /** 0..1 overlay strength of a high-pass sharpen. */
  sharpen: number;
}

const WARM: Omit<ColorCast, "alpha"> = { r: 255, g: 140, b: 30 };
const COOL: Omit<ColorCast, "alpha"> = { r: 40, g: 120, b: 255 };
const MAGENTA: Omit<ColorCast, "alpha"> = { r: 255, g: 40, b: 200 };
const GREEN: Omit<ColorCast, "alpha"> = { r: 60, g: 220, b: 70 };
const MAX_TEMPERATURE_CAST = 0.3;
const MAX_TINT_CAST = 0.25;
const MAX_VIGNETTE = 0.9;

const round = (v: number): number => Math.round(v * 1000) / 1000;

/** Pure mapping from `adjust` parameters to render operations; the single definition preview and export share. */
export function adjustPlan(params: ParamValues): AdjustPlan | null {
  const brightness = numberParam(params, "brightness", 0);
  const contrast = numberParam(params, "contrast", 0);
  const saturation = numberParam(params, "saturation", 0);
  const exposure = numberParam(params, "exposure", 0);
  const temperature = numberParam(params, "temperature", 0);
  const tint = numberParam(params, "tint", 0);
  const vignette = numberParam(params, "vignette", 0);
  const sharpen = numberParam(params, "sharpen", 0);

  const light = round((1 + brightness / 100) * 2 ** (exposure / 50));
  const filters: string[] = [];
  if (light !== 1) filters.push(`brightness(${light})`);
  if (contrast !== 0) filters.push(`contrast(${round(1 + contrast / 100)})`);
  if (saturation !== 0) filters.push(`saturate(${round(1 + saturation / 100)})`);

  const casts: ColorCast[] = [];
  if (temperature !== 0) casts.push({ ...(temperature > 0 ? WARM : COOL), alpha: round((Math.abs(temperature) / 100) * MAX_TEMPERATURE_CAST) });
  if (tint !== 0) casts.push({ ...(tint > 0 ? MAGENTA : GREEN), alpha: round((Math.abs(tint) / 100) * MAX_TINT_CAST) });

  const plan: AdjustPlan = {
    filter: filters.length > 0 ? filters.join(" ") : "none",
    casts,
    vignette: round((Math.max(0, vignette) / 100) * MAX_VIGNETTE),
    sharpen: round(Math.max(0, sharpen) / 100),
  };
  const neutral = plan.filter === "none" && casts.length === 0 && plan.vignette === 0 && plan.sharpen === 0;
  return neutral ? null : plan;
}
