/**
 * Process sessions and data gaps.
 *
 * Any time the process wasn't running is a window where we may have missed
 * events. On start we record that window as a gap, so nothing downstream
 * assumes it has complete history across a restart.
 */
import type { DatabaseSync } from "node:sqlite";

export interface Gap {
  provider: string;
  from_ms: number;
  to_ms: number;
  reason: string;
}

export class SessionStore {
  private id: number | undefined;

  constructor(private readonly db: DatabaseSync) {}

  /** Start a session. Returns the downtime gap since the previous one, if any. */
  start(now: number): Gap | undefined {
    const prev = this.db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT 1").get() as
      | { id: number; last_heartbeat: number; ended_at: number | null; clean_shutdown: number }
      | undefined;
    let gap: Gap | undefined;
    if (prev) {
      const from = prev.ended_at ?? prev.last_heartbeat;
      const reason = prev.clean_shutdown ? "process not running" : "previous run stopped without clean shutdown";
      if (!prev.ended_at) this.db.prepare("UPDATE sessions SET ended_at = last_heartbeat WHERE id = ?").run(prev.id);
      if (now > from) {
        gap = { provider: "all", from_ms: from, to_ms: now, reason };
        this.addGap(gap);
      }
    }
    const r = this.db.prepare("INSERT INTO sessions (started_at, last_heartbeat) VALUES (?, ?)").run(now, now);
    this.id = Number(r.lastInsertRowid);
    return gap;
  }

  heartbeat(now: number): void {
    if (this.id !== undefined) this.db.prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?").run(now, this.id);
  }

  end(now: number): void {
    if (this.id === undefined) return;
    this.db.prepare("UPDATE sessions SET ended_at = ?, last_heartbeat = ?, clean_shutdown = 1 WHERE id = ?").run(now, now, this.id);
    this.id = undefined;
  }

  addGap(g: Gap): void {
    this.db.prepare("INSERT INTO gaps (provider, from_ms, to_ms, reason) VALUES (?, ?, ?, ?)").run(g.provider, g.from_ms, g.to_ms, g.reason.slice(0, 200));
  }

  gaps(sinceMs = 0): Gap[] {
    return this.db.prepare("SELECT provider, from_ms, to_ms, reason FROM gaps WHERE to_ms >= ? ORDER BY from_ms").all(sinceMs) as unknown as Gap[];
  }
}

export function budgetStore(db: DatabaseSync) {
  return {
    load: (day: string) => (db.prepare("SELECT used FROM rpc_budget WHERE day = ?").get(day) as { used: number } | undefined)?.used ?? 0,
    save: (day: string, used: number) => {
      db.prepare("INSERT INTO rpc_budget (day, used) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET used = excluded.used").run(day, used);
    },
  };
}
