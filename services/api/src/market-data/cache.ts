type Entry<T> = { expiresAt: number; value: T };

/** Tiny in-memory TTL cache (per process). */
export class TtlCache {
  private store = new Map<string, Entry<unknown>>();

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): T {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }
}

export const marketDataCache = new TtlCache();
