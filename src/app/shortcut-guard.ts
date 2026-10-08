export interface ClosestTarget {
  closest(selector: string): unknown;
}

interface PlainKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** Elements whose own Enter/Space behaviour is activation. */
const ACTIVATABLE = [
  "button", "a[href]", "summary", "[role='button']", "[role='tab']", "[role='menuitem']", "[role='menuitemcheckbox']",
  "[role='menuitemradio']", "[role='checkbox']", "[role='switch']", "[role='radio']", "[role='option']", "[role='link']",
].join(",");

/** Timeline clips and the playhead keep the global transport shortcuts; their own key handlers only select. */
const KEEPS_GLOBAL_SHORTCUTS = "[data-clip-id], [role='slider']";

const isActivationKey = (key: string): boolean => key === "Enter" || key === " " || key === "Spacebar";

/** True when Enter/Space should activate the focused control instead of running a global shortcut. */
export function shouldYieldToFocusedControl(event: PlainKeyEvent, target: ClosestTarget | null): boolean {
  if (!target || !isActivationKey(event.key) || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (target.closest(KEEPS_GLOBAL_SHORTCUTS)) return false;
  return target.closest(ACTIVATABLE) !== null;
}
