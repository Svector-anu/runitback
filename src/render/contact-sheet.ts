import { contactSheetPlan, type ContactSheetPlan } from "#/engine/analysis";
import type { FramePlan } from "#/engine/render";
import { context2d, createCanvas, type AnyCanvas } from "./canvas";
import type { Compositor, FrameSources } from "./compositor";

export const CONTACT_SHEET_JPEG_QUALITY = 0.85;
const SHEET_BACKGROUND = "#111111";
const LABEL_BACKGROUND = "rgba(0, 0, 0, 0.65)";
const LABEL_COLOR = "#ffffff";
const LABEL_HEIGHT_RATIO = 0.11;
const LABEL_MIN_FONT_PX = 9;

export type SheetFrame = AnyCanvas | ImageBitmap;

/** Returns the pixels for a timeline time. Called sequentially; the result is drawn before the next call. */
export type SheetFrameSource = (timelineSeconds: number) => Promise<SheetFrame | null>;

export interface ContactSheetResult {
  blob: Blob;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  plan: ContactSheetPlan;
}

/** Adapts the shared FramePlan + Compositor path (same pixels as preview and export) into a sheet frame source. */
export function framePlanFrameSource(input: { buildPlan: (timelineSeconds: number) => FramePlan; compositor: Compositor; sources: FrameSources }): SheetFrameSource {
  return async (time) => {
    await input.compositor.render(input.buildPlan(time), input.sources);
    return input.compositor.canvas;
  };
}

function encodeJpeg(canvas: AnyCanvas): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: "image/jpeg", quality: CONTACT_SHEET_JPEG_QUALITY });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Contact sheet encode failed"))), "image/jpeg", CONTACT_SHEET_JPEG_QUALITY));
}

/** Draws each requested time into a grid (letterboxed, with a timecode label) and encodes one JPEG, long side <= 1568 px. */
export async function renderContactSheet(input: {
  times: ReadonlyArray<number>;
  columns: number;
  cell: { width: number; height: number };
  frameAt: SheetFrameSource;
  gap?: number;
  signal?: AbortSignal;
}): Promise<ContactSheetResult> {
  const plan = contactSheetPlan({ times: input.times, columns: input.columns, cell: input.cell, gap: input.gap });
  const canvas = createCanvas(plan.width, plan.height);
  const ctx = context2d(canvas);
  ctx.fillStyle = SHEET_BACKGROUND;
  ctx.fillRect(0, 0, plan.width, plan.height);

  for (const cell of plan.cells) {
    if (input.signal?.aborted) throw new DOMException("Contact sheet render was aborted", "AbortError");
    const frame = await input.frameAt(cell.time);
    if (frame && frame.width > 0 && frame.height > 0) {
      const fit = Math.min(cell.width / frame.width, cell.height / frame.height);
      const w = frame.width * fit;
      const h = frame.height * fit;
      ctx.drawImage(frame, cell.x + (cell.width - w) / 2, cell.y + (cell.height - h) / 2, w, h);
    }
    const labelHeight = Math.max(LABEL_MIN_FONT_PX + 4, Math.round(cell.height * LABEL_HEIGHT_RATIO));
    ctx.fillStyle = LABEL_BACKGROUND;
    ctx.fillRect(cell.x, cell.y + cell.height - labelHeight, Math.min(cell.width, labelHeight * 5.5), labelHeight);
    ctx.fillStyle = LABEL_COLOR;
    ctx.font = `${Math.max(LABEL_MIN_FONT_PX, labelHeight - 4)}px monospace`;
    ctx.textBaseline = "middle";
    ctx.fillText(cell.label, cell.x + 4, cell.y + cell.height - labelHeight / 2);
  }
  const blob = await encodeJpeg(canvas);
  return { blob, mimeType: "image/jpeg", width: plan.width, height: plan.height, plan };
}

/** Base64 payload (no data-URL prefix), as vision APIs expect. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
