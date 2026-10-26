import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { ProviderId } from "../core/types.ts";

/**
 * Runs `tick` on a fixed interval. A slow or failing tick never overlaps the
 * next one, and errors never stop the loop (health is recorded by the HTTP client).
 */
export class Poller {
  private timer: unknown;
  private running = false;
  private inFlight = false;
  public ticks = 0;
  public failures = 0;

  constructor(
    private readonly provider: ProviderId,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.run();
  }

  stop(): void {
    this.running = false;
    this.clock.clearTimeout(this.timer);
  }

  private async run(): Promise<void> {
    if (!this.running || this.inFlight) return;
    this.inFlight = true;
    try {
      await this.tick();
      this.ticks++;
    } catch (e) {
      this.failures++;
      this.logger.warn("poll failed", { provider: this.provider, err: (e as Error).message });
    } finally {
      this.inFlight = false;
      if (this.running) this.timer = this.clock.setTimeout(() => void this.run(), this.intervalMs);
    }
  }
}
