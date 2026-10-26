/**
 * Daily risk state, persisted so a restart can't reset a loss limit.
 * Days are UTC. A halt lasts until the day ends and is never cleared automatically
 * within the day.
 */
import type { DatabaseSync } from "node:sqlite";
import { utcDay } from "../solana/rpc.ts";

export interface DayState {
  day: string;
  realizedLossCad: number;
  entries: number;
  consecutiveLosses: number;
  haltedReason: string | null;
}

export class RiskStateStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
  ) {}

  today(): DayState {
    const day = utcDay(this.now());
    const r = this.db.prepare("SELECT * FROM risk_state WHERE day = ?").get(day) as
      | { realized_loss_cad: number; entries: number; consecutive_losses: number; halted_reason: string | null }
      | undefined;
    // Consecutive losses carry over from the last recorded day.
    const prev = r
      ? undefined
      : (this.db.prepare("SELECT consecutive_losses FROM risk_state WHERE day < ? ORDER BY day DESC LIMIT 1").get(day) as { consecutive_losses: number } | undefined);
    return {
      day,
      realizedLossCad: r?.realized_loss_cad ?? 0,
      entries: r?.entries ?? 0,
      consecutiveLosses: r?.consecutive_losses ?? prev?.consecutive_losses ?? 0,
      haltedReason: r?.halted_reason ?? null,
    };
  }

  private write(s: DayState): void {
    this.db
      .prepare(
        `INSERT INTO risk_state (day, realized_loss_cad, entries, consecutive_losses, halted_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (day) DO UPDATE SET realized_loss_cad = excluded.realized_loss_cad, entries = excluded.entries,
           consecutive_losses = excluded.consecutive_losses, halted_reason = excluded.halted_reason, updated_at = excluded.updated_at`,
      )
      .run(s.day, s.realizedLossCad, s.entries, s.consecutiveLosses, s.haltedReason, this.now());
  }

  recordEntry(): void {
    const s = this.today();
    this.write({ ...s, entries: s.entries + 1 });
  }

  /** pnlCad < 0 is a loss. Losses add to the day's total; wins reset the losing streak. */
  recordClose(pnlCad: number): void {
    const s = this.today();
    this.write({
      ...s,
      realizedLossCad: s.realizedLossCad + Math.max(0, -pnlCad),
      consecutiveLosses: pnlCad < 0 ? s.consecutiveLosses + 1 : 0,
    });
  }

  halt(reason: string): void {
    const s = this.today();
    if (!s.haltedReason) this.write({ ...s, haltedReason: reason.slice(0, 200) });
  }
}
