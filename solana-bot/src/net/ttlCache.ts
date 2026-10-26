import type { Clock } from "../core/clock.ts";

/** Small TTL cache with a size cap (oldest entry evicted first). */
export class TtlCache<V> {
  private map = new Map<string, { at: number; ttl: number; value: V }>();
  public hits = 0;
  public misses = 0;

  constructor(
    private readonly clock: Clock,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e || this.clock.now() - e.at > e.ttl) {
      if (e) this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return e.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.map.delete(key);
    this.map.set(key, { at: this.clock.now(), ttl: ttlMs, value });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
