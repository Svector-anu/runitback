import { isString, type PrefsStore } from "#/platform/prefs";

export interface ModelConsentDeps {
  prefs: PrefsStore;
  /** Prefs key that remembers which model the user agreed to download in this browser. */
  pref: string;
  model: string;
  /** True when the model is already on this device, so using it needs no download. */
  isCached(model: string): Promise<boolean>;
}

/** The explicit-consent gate in front of an on-device model download. Consent is per model and lives in prefs only. */
export class ModelConsent {
  constructor(private readonly deps: ModelConsentDeps) {}

  has(): boolean {
    return this.deps.prefs.read(this.deps.pref, "", isString) === this.deps.model;
  }

  grant(): void {
    this.deps.prefs.write(this.deps.pref, this.deps.model);
  }

  /** True when running the model would start a download the user has not approved. */
  async needed(): Promise<boolean> {
    if (this.has()) return false;
    return !(await this.deps.isCached(this.deps.model));
  }
}
