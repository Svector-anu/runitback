export type DragPayload =
  | { kind: "media"; assetId: string; mediaType: "video" | "audio" | "image" }
  | { kind: "text" }
  | { kind: "graphic"; definitionId: string }
  | { kind: "effect"; effectType: string };

export const DRAG_MIME = "application/x-runitback-drag";

let current: DragPayload | null = null;

/** The payload is kept in module state as well, because dataTransfer contents are unreadable during dragover. */
export function beginDrag(event: React.DragEvent | DragEvent, payload: DragPayload): void {
  current = payload;
  event.dataTransfer?.setData(DRAG_MIME, JSON.stringify(payload));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
}

export function endDrag(): void {
  current = null;
}

export function currentDrag(): DragPayload | null {
  return current;
}

export function hasFiles(event: DragEvent | React.DragEvent): boolean {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}
