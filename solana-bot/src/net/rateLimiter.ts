import type { Clock } from "../core/clock.ts";

/**
 * Token bucket. `acquire()` waits until a token is free.
 * `penalize(untilMs)` blocks all callers until a provider's rate-limit window resets.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private blockedUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  public waits = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
  ) {
    if (capacity <= 0 || refillPerSec <= 0) throw new Error("RateLimiter needs positive capacity and refill");
    this.tokens = capacity;
    this.last = clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = now;
  }

  /** Serialised so callers are served in order. */
  acquire(): Promise<void> {
    const run = this.queue.then(() => this.take());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async take(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      if (now < this.blockedUntil) {
        this.waits++;
        await this.clock.sleep(this.blockedUntil - now);
        continue;
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      this.waits++;
      const needMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
      await this.clock.sleep(needMs);
    }
  }

  penalize(untilMs: number): void {
    if (untilMs > this.blockedUntil) this.blockedUntil = untilMs;
    this.tokens = 0;
  }

  get blockedUntilMs(): number {
    return this.blockedUntil;
  }
}
