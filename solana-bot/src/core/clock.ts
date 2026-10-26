/** Injectable clock so tests can control time. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Manual clock for tests. Timers fire only when `advance` is called. */
export class FakeClock implements Clock {
  private t: number;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((r) => this.setTimeout(r, ms));
  }

  /** Move time forward, firing due timers in order. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      // Let promise continuations scheduled by the timer run.
      await new Promise((r) => setImmediate(r));
    }
    this.t = target;
    await new Promise((r) => setImmediate(r));
  }

  pendingTimers(): number {
    return this.timers.size;
  }
}
