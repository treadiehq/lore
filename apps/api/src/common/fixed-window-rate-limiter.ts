interface RateWindow {
  startedAt: number;
  count: number;
}

export interface FixedWindowRateLimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys: number;
  now?: () => number;
}

export class FixedWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, RateWindow>();

  constructor(options: FixedWindowRateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#windows.size;
  }

  allow(key: string): boolean {
    const now = this.#now();
    const current = this.#windows.get(key);
    if (
      current === undefined ||
      now - current.startedAt >= this.#windowMs
    ) {
      if (current === undefined) {
        this.#makeRoom(now);
      } else {
        this.#windows.delete(key);
      }
      this.#windows.set(key, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= this.#limit) {
      return false;
    }
    current.count += 1;
    return true;
  }

  #makeRoom(now: number): void {
    if (this.#windows.size < this.#maxKeys) {
      return;
    }
    for (const [key, window] of this.#windows) {
      if (now - window.startedAt >= this.#windowMs) {
        this.#windows.delete(key);
      }
    }
    while (this.#windows.size >= this.#maxKeys) {
      const oldestKey = this.#windows.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      this.#windows.delete(oldestKey);
    }
  }
}
