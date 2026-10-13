import { Store } from "./store";
import { getServices } from "./services";
import { isBoolean, isNumberArray, isRecordOfStrings } from "#/platform/prefs";

export type RightPanelTab = "properties" | "agent";

/** Panels reachable from the compact (below 900 px) bottom-sheet tab bar. */
export type SheetTab = "assets" | "properties" | "agent";

export type AssetTab = "media" | "text" | "graphics" | "effects" | "captions" | "settings";

export interface LayoutSizes {
  horizontal: number[];
  vertical: number[];
}

export const DEFAULT_LAYOUT: LayoutSizes = { horizontal: [25, 50, 25], vertical: [50, 50] };

export const PANEL_CONSTRAINTS = {
  horizontal: [{ min: 15, max: 40 }, { min: 30 }, { min: 15, max: 40 }],
  vertical: [{ min: 30, max: 85 }, { min: 15, max: 70 }],
};

const isLayout = (v: unknown): v is LayoutSizes =>
  typeof v === "object" && v !== null && isNumberArray((v as LayoutSizes).horizontal) && isNumberArray((v as LayoutSizes).vertical)
  && (v as LayoutSizes).horizontal.length === 3 && (v as LayoutSizes).vertical.length === 2;

function loadLayout(): LayoutSizes {
  return getServices().prefs.read("panel-sizes", DEFAULT_LAYOUT, isLayout);
}

export interface UiState {
  layout: LayoutSizes;
  assetTab: AssetTab;
  rightPanel: RightPanelTab;
  /** Compact layout only: the tab whose bottom sheet is open, or null when the sheet is closed. */
  sheet: SheetTab | null;
  mediaView: "grid" | "list";
  mediaSort: "name" | "type" | "duration" | "size";
  mediaSortDesc: boolean;
  theme: "light" | "dark";
  /** Elements whose keyframe lanes are expanded in the timeline. */
  expandedElements: ReadonlySet<string>;
  revealMediaId: string | null;
  propertyTabs: Record<string, string>;
  selectedAssetIds: string[];
}

const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export const uiStore = new Store<UiState>({
  layout: DEFAULT_LAYOUT,
  assetTab: "media",
  rightPanel: "properties",
  sheet: null,
  mediaView: "grid",
  mediaSort: "name",
  mediaSortDesc: false,
  theme: prefersDark ? "dark" : "light",
  expandedElements: new Set(),
  revealMediaId: null,
  propertyTabs: {},
  selectedAssetIds: [],
});

/** Reads persisted preferences once services exist. */
export function hydrateUiState(): void {
  const prefs = getServices().prefs;
  const theme = prefs.read<string>("theme", uiStore.get().theme, (v): v is string => v === "light" || v === "dark");
  uiStore.set({
    layout: loadLayout(),
    theme: theme as UiState["theme"],
    mediaView: prefs.read<string>("media-view", "grid", (v): v is string => v === "grid" || v === "list") as UiState["mediaView"],
    mediaSort: prefs.read<string>("media-sort", "name", (v): v is string => ["name", "type", "duration", "size"].includes(v as string)) as UiState["mediaSort"],
    mediaSortDesc: prefs.read("media-sort-desc", false, isBoolean),
  });
  const snapping = prefs.read("snapping", true, isBoolean);
  const ripple = prefs.read("ripple", false, isBoolean);
  getServices().editor.setSnappingEnabled(snapping);
  getServices().editor.setRippleEnabled(ripple);
  applyTheme(uiStore.get().theme);
}

export function applyTheme(theme: UiState["theme"]): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: UiState["theme"]): void {
  uiStore.set({ theme });
  applyTheme(theme);
  getServices().prefs.write("theme", theme);
}

export function setLayout(layout: Partial<LayoutSizes>): void {
  const next = { ...uiStore.get().layout, ...layout };
  uiStore.set({ layout: next });
  getServices().prefs.write("panel-sizes", next);
}

export function openSheet(tab: SheetTab): void {
  uiStore.set({ sheet: tab });
}

export function closeSheet(): void {
  if (uiStore.get().sheet !== null) uiStore.set({ sheet: null });
}

/** Tapping the active tab dismisses the sheet; tapping another tab switches to it. */
export function toggleSheet(tab: SheetTab): void {
  uiStore.set({ sheet: uiStore.get().sheet === tab ? null : tab });
}

export function toggleExpanded(elementId: string): void {
  const next = new Set(uiStore.get().expandedElements);
  if (next.has(elementId)) next.delete(elementId);
  else next.add(elementId);
  uiStore.set({ expandedElements: next });
}

export const isStringRecord = isRecordOfStrings;
