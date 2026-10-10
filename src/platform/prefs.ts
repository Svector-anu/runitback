/** The only module that touches localStorage. Reads are validated so corrupt values fall back to defaults. */
export interface PrefsBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

const memoryBackend = (): PrefsBackend => {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};

export function browserBackend(): PrefsBackend {
  try {
    const probe = "__runitback_probe__";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return memoryBackend();
  }
}

export class PrefsStore {
  constructor(private readonly backend: PrefsBackend = browserBackend()) {}

  read<T>(key: string, fallback: T, validate: (value: unknown) => value is T): T {
    try {
      const raw = this.backend.getItem(`runitback:${key}`);
      if (raw === null) return fallback;
      const parsed: unknown = JSON.parse(raw);
      return validate(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  write(key: string, value: unknown): void {
    try {
      this.backend.setItem(`runitback:${key}`, JSON.stringify(value));
    } catch (error) {
      console.warn(`Could not save preference ${key}`, error);
    }
  }
}

export const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === "number");
export const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
export const isRecordOfStrings = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

export const isString = (v: unknown): v is string => typeof v === "string";

/** Anthropic API key for the in-app agent. Kept in this browser's localStorage only; sent only to api.anthropic.com. */
export const AGENT_API_KEY_PREF = "agent-api-key";
export const AGENT_MODEL_PREF = "agent-model";
export const ONBOARDING_DISMISSED_PREF = "onboarding-dismissed";
