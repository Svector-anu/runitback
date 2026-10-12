import { useSyncExternalStore } from "react";
import { TOUR_SEEN_PREF, isBoolean, type PrefsStore } from "#/platform/prefs";
import { getServices } from "#/app/services";

export interface TourStep {
  /** Value of the `data-tour` attribute on the element this step points at. */
  target: "import" | "understand" | "agent" | "timeline" | "export";
  title: string;
  body: string;
}

export const TOUR_STEPS: ReadonlyArray<TourStep> = [
  { target: "import", title: "Import your footage", body: "Drop videos, photos or audio here, or press Import. Files stay in this browser and are never uploaded." },
  { target: "understand", title: "Let it understand the footage", body: "Understand analyses your clips on this device: silences, speech, scenes and faces. The first run asks before downloading two small models (about 206 MB)." },
  { target: "agent", title: "Tell the agent what to do", body: "Paste your own Anthropic API key, then describe the edit in plain words. With Ask before editing on, it shows a plan first and changes nothing until you approve." },
  { target: "timeline", title: "Fine-tune on the timeline", body: "Press Space to play and S to split at the playhead. Drag a clip's edges to trim. Ctrl or Cmd+Z undoes anything, including a whole agent turn." },
  { target: "export", title: "Export", body: "Export renders MP4 or WebM in your browser and saves it to your Downloads folder." },
];

export interface TourState {
  open: boolean;
  step: number;
}

export const clampStep = (step: number, count: number): number => Math.min(Math.max(step, 0), count - 1);

/** True when something other than a person is driving the page, so first-run guidance must stay out of the way. */
export function isAutomated(nav: Pick<Navigator, "webdriver">, search: string): boolean {
  return nav.webdriver === true && !new URLSearchParams(search).has("tour");
}

export class TourStore {
  private state: TourState = { open: false, step: 0 };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly prefs: Pick<PrefsStore, "read" | "write">, private readonly stepCount = TOUR_STEPS.length) {}

  hasBeenSeen(): boolean {
    return this.prefs.read(TOUR_SEEN_PREF, false, isBoolean);
  }

  /** Opens the tour for first-time users only. Returns whether it opened. */
  autoStart(automated: boolean): boolean {
    if (automated || this.hasBeenSeen() || this.state.open) return false;
    this.start();
    return true;
  }

  start(): void {
    this.set({ open: true, step: 0 });
  }

  next(): void {
    if (this.state.step >= this.stepCount - 1) { this.close(); return; }
    this.set({ open: true, step: this.state.step + 1 });
  }

  back(): void {
    this.set({ open: true, step: clampStep(this.state.step - 1, this.stepCount) });
  }

  close(): void {
    if (!this.state.open) return;
    this.prefs.write(TOUR_SEEN_PREF, true);
    this.set({ open: false, step: 0 });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): TourState => this.state;

  private set(state: TourState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

let instance: TourStore | null = null;

export function getTourStore(): TourStore {
  instance ??= new TourStore(getServices().prefs);
  return instance;
}

export function useTour(): TourState {
  const store = getTourStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
