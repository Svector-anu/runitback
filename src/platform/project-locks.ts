import type { ProjectLockHandle, ProjectLocks } from "#/engine/persistence";

/** The slice of the Web Locks API this module needs; tests substitute an in-memory manager. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<void> | undefined,
  ): Promise<unknown>;
}

const LOCK_PREFIX = "runitback:project:";

/**
 * Per-project exclusive ownership across tabs of one origin. The browser releases the lock when the holding
 * tab closes or crashes, so a dead tab can never keep a project locked.
 */
export class WebProjectLocks implements ProjectLocks {
  constructor(private readonly manager: LockManagerLike) {}

  tryAcquire(projectId: string): Promise<ProjectLockHandle | null> {
    return new Promise((resolve, reject) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((done) => { release = done; });
      this.manager.request(`${LOCK_PREFIX}${projectId}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        resolve({ release: () => release() });
        return held;
      }).catch(reject);
    });
  }
}

/** Used where the Web Locks API is unavailable: every acquire succeeds, so single-tab use is unaffected. */
export class UncontendedProjectLocks implements ProjectLocks {
  async tryAcquire(): Promise<ProjectLockHandle> {
    return { release: () => undefined };
  }
}

export function browserProjectLocks(): ProjectLocks {
  const manager = typeof navigator !== "undefined" ? (navigator as { locks?: LockManagerLike }).locks : undefined;
  return manager ? new WebProjectLocks(manager) : new UncontendedProjectLocks();
}
