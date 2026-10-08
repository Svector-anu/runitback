export type ActionCategory = "playback" | "navigation" | "editing" | "selection" | "history" | "timeline" | "controls" | "assets";

export interface ActionDefinition {
  description: string;
  category: ActionCategory;
  defaultShortcuts?: ReadonlyArray<string>;
}

/** Action ids and their default bindings. Keys: modifiers joined with `+`, `ctrl` means Cmd on Apple platforms. */
export const ACTIONS = {
  "toggle-play": { description: "Play / pause", category: "playback", defaultShortcuts: ["space", "k"] },
  "stop-playback": { description: "Stop and return to start", category: "playback" },
  "seek-forward": { description: "Seek forward 1 second", category: "playback", defaultShortcuts: ["l"] },
  "seek-backward": { description: "Seek backward 1 second", category: "playback", defaultShortcuts: ["j"] },
  "frame-step-forward": { description: "Step forward one frame", category: "navigation", defaultShortcuts: ["right"] },
  "frame-step-backward": { description: "Step backward one frame", category: "navigation", defaultShortcuts: ["left"] },
  "jump-forward": { description: "Jump forward 5 seconds", category: "navigation", defaultShortcuts: ["shift+right"] },
  "jump-backward": { description: "Jump backward 5 seconds", category: "navigation", defaultShortcuts: ["shift+left"] },
  "goto-start": { description: "Go to start", category: "navigation", defaultShortcuts: ["home", "enter"] },
  "goto-end": { description: "Go to end", category: "navigation", defaultShortcuts: ["end"] },
  split: { description: "Split at playhead", category: "editing", defaultShortcuts: ["s"] },
  "split-left": { description: "Split and remove left", category: "editing", defaultShortcuts: ["q"] },
  "split-right": { description: "Split and remove right", category: "editing", defaultShortcuts: ["w"] },
  "delete-selected": { description: "Delete selected", category: "editing", defaultShortcuts: ["backspace", "delete"] },
  "copy-selected": { description: "Copy", category: "editing", defaultShortcuts: ["ctrl+c"] },
  "paste-copied": { description: "Paste at playhead", category: "editing", defaultShortcuts: ["ctrl+v"] },
  "duplicate-selected": { description: "Duplicate selected", category: "editing", defaultShortcuts: ["ctrl+d"] },
  "toggle-snapping": { description: "Toggle snapping", category: "timeline", defaultShortcuts: ["n"] },
  "toggle-ripple-editing": { description: "Toggle ripple editing", category: "timeline" },
  "toggle-bookmark": { description: "Add / remove bookmark at playhead", category: "timeline" },
  "toggle-source-audio": { description: "Extract / recover source audio", category: "editing" },
  "toggle-elements-muted-selected": { description: "Mute / unmute selected", category: "editing" },
  "toggle-elements-visibility-selected": { description: "Show / hide selected", category: "editing" },
  "select-all": { description: "Select all", category: "selection", defaultShortcuts: ["ctrl+a"] },
  "deselect-all": { description: "Deselect all", category: "selection" },
  "cancel-interaction": { description: "Cancel current interaction", category: "selection", defaultShortcuts: ["escape"] },
  undo: { description: "Undo", category: "history", defaultShortcuts: ["ctrl+z"] },
  redo: { description: "Redo", category: "history", defaultShortcuts: ["ctrl+shift+z", "ctrl+y"] },
} as const satisfies Record<string, ActionDefinition>;

export type ActionId = keyof typeof ACTIONS;

export type Keybindings = Record<string, ActionId>;

export function defaultKeybindings(): Keybindings {
  const out: Keybindings = {};
  for (const [id, def] of Object.entries(ACTIONS) as Array<[ActionId, ActionDefinition]>) {
    for (const key of def.defaultShortcuts ?? []) out[key] = id;
  }
  return out;
}

const NAMED_KEYS: Record<string, string> = {
  " ": "space", arrowright: "right", arrowleft: "left", arrowup: "up", arrowdown: "down", esc: "escape",
};

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Letters and digits resolve by physical key so non-QWERTY layouts keep their shortcuts. */
export function normalizeKey(event: Pick<KeyEventLike, "key" | "code">): string {
  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const lower = event.key.toLowerCase();
  return NAMED_KEYS[lower] ?? lower;
}

export function keybindingString(event: KeyEventLike, isApple: boolean): string {
  const modifiers: string[] = [];
  const primary = isApple ? event.metaKey : event.ctrlKey;
  if (primary) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  return [...modifiers, normalizeKey(event)].join("+");
}

export function resolveAction(event: KeyEventLike, bindings: Keybindings, isApple: boolean): ActionId | null {
  return bindings[keybindingString(event, isApple)] ?? null;
}

/** Conflict = the same key bound to a different action. */
export function findConflict(bindings: Keybindings, key: string, action: ActionId): ActionId | null {
  const existing = bindings[key];
  return existing && existing !== action ? existing : null;
}

export function rebind(bindings: Keybindings, action: ActionId, key: string): Keybindings {
  const next: Keybindings = {};
  for (const [k, a] of Object.entries(bindings)) if (a !== action && k !== key) next[k] = a;
  next[key] = action;
  return next;
}

export function parseKeybindings(raw: unknown): Keybindings | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Keybindings = {};
  for (const [key, action] of Object.entries(raw)) {
    if (typeof action !== "string" || !(action in ACTIONS)) return null;
    out[key] = action as ActionId;
  }
  return out;
}

export function isTypableTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable === true;
}
