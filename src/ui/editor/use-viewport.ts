import { useSyncExternalStore } from "react";

/** Below this width the editor swaps the side panels for a bottom sheet. Desktop layout starts here. */
export const COMPACT_MAX_WIDTH = 900;
/** Below this width the editor is a phone: tighter header, one-time "mobile is limited" notice. */
export const PHONE_MAX_WIDTH = 600;

export type ViewportTier = "desktop" | "compact" | "phone";

export interface ViewportInfo {
  tier: ViewportTier;
  /** Width below 900 px: bottom-sheet layout. Also true on phones. */
  compact: boolean;
  /** Width below 600 px. */
  phone: boolean;
}

const VIEWPORTS: Record<ViewportTier, ViewportInfo> = {
  desktop: { tier: "desktop", compact: false, phone: false },
  compact: { tier: "compact", compact: true, phone: false },
  phone: { tier: "phone", compact: true, phone: true },
};

export const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_WIDTH - 0.02}px)`;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX_WIDTH - 0.02}px)`;

export interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export interface MediaQuerySource {
  matchMedia(query: string): MediaQueryListLike;
}

/** Maps the current media-query state to a stable tier object. Without matchMedia (SSR, tests) it is desktop. */
export function readViewport(source: Partial<MediaQuerySource> | undefined): ViewportInfo {
  if (!source?.matchMedia) return VIEWPORTS.desktop;
  if (source.matchMedia(PHONE_QUERY).matches) return VIEWPORTS.phone;
  if (source.matchMedia(COMPACT_QUERY).matches) return VIEWPORTS.compact;
  return VIEWPORTS.desktop;
}

/** Calls `onChange` whenever either breakpoint flips. Returns the unsubscribe function. */
export function subscribeViewport(source: Partial<MediaQuerySource> | undefined, onChange: () => void): () => void {
  if (!source?.matchMedia) return () => undefined;
  const lists = [source.matchMedia(COMPACT_QUERY), source.matchMedia(PHONE_QUERY)];
  for (const list of lists) list.addEventListener("change", onChange);
  return () => {
    for (const list of lists) list.removeEventListener("change", onChange);
  };
}

const browser = (): Partial<MediaQuerySource> | undefined => (typeof window === "undefined" ? undefined : window);

/** Layout tier for the editor shell. Pure CSS handles styling; use this only where the component tree itself differs. */
export function useViewport(): ViewportInfo {
  return useSyncExternalStore(
    (onChange) => subscribeViewport(browser(), onChange),
    () => readViewport(browser()),
    () => VIEWPORTS.desktop,
  );
}
