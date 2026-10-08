export const CONTACT_SHEET_MAX_SIDE_PX = 1568;
export const CONTACT_SHEET_DEFAULT_GAP_PX = 4;

export interface ContactSheetCell {
  index: number;
  time: number;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ContactSheetPlan {
  width: number;
  height: number;
  columns: number;
  rows: number;
  gap: number;
  cells: ContactSheetCell[];
}

/** "mm:ss.cc" timecode used on contact sheet labels. */
export function formatSheetTimecode(seconds: number): string {
  const centis = Math.round(Math.max(0, seconds) * 100);
  const minutes = Math.floor(centis / 6000);
  const secs = Math.floor((centis % 6000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis % 100).padStart(2, "0")}`;
}

/**
 * Grid layout for sampled timeline times. The requested cell size is scaled down uniformly
 * (never up) until the long side of the sheet fits `maxSide`; sizes are whole pixels.
 */
export function contactSheetPlan(input: {
  times: ReadonlyArray<number>;
  columns: number;
  cell: { width: number; height: number };
  gap?: number;
  maxSide?: number;
}): ContactSheetPlan {
  const count = input.times.length;
  const columns = Math.max(1, Math.min(Math.floor(input.columns), Math.max(1, count)));
  const rows = Math.max(1, Math.ceil(count / columns));
  const gap = input.gap ?? CONTACT_SHEET_DEFAULT_GAP_PX;
  const maxSide = input.maxSide ?? CONTACT_SHEET_MAX_SIDE_PX;
  const naturalWidth = columns * input.cell.width + (columns + 1) * gap;
  const naturalHeight = rows * input.cell.height + (rows + 1) * gap;
  const scale = Math.min(1, (maxSide - (columns + 1) * gap) / (columns * input.cell.width), (maxSide - (rows + 1) * gap) / (rows * input.cell.height));
  if (!(scale > 0)) throw new RangeError(`Contact sheet of ${count} cells cannot fit in ${maxSide}px`);
  const cellWidth = Math.max(1, Math.floor(input.cell.width * scale));
  const cellHeight = Math.max(1, Math.floor(input.cell.height * scale));
  const width = scale < 1 ? columns * cellWidth + (columns + 1) * gap : naturalWidth;
  const height = scale < 1 ? rows * cellHeight + (rows + 1) * gap : naturalHeight;
  const cells = input.times.map((time, index) => ({
    index,
    time,
    label: formatSheetTimecode(time),
    x: gap + (index % columns) * (cellWidth + gap),
    y: gap + Math.floor(index / columns) * (cellHeight + gap),
    width: cellWidth,
    height: cellHeight,
  }));
  return { width, height, columns, rows, gap, cells };
}

/** Evenly spaced sample times across [start, end), centred in each slot. */
export function evenSampleTimes(input: { start: number; end: number; count: number }): number[] {
  const span = input.end - input.start;
  return Array.from({ length: input.count }, (_, i) => input.start + ((i + 0.5) * span) / input.count);
}
