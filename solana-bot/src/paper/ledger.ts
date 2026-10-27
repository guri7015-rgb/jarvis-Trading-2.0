/**
 * Append-only paper ledger. SOL (lamports) is the unit of account; CAD is
 * derived at the FX rate stored with each position.
 *
 * Position states, forward only:
 *   PROPOSED → ENTRY_PENDING → OPEN → EXIT_PENDING → CLOSED
 *   ENTRY_PENDING → FAILED      (entry fill failed; fees still paid)
 *   EXIT_PENDING  → STUCK       (no sell route; still held, still marked)
 * Every transition is keyed by position id, so a repeated call is a no-op.
 */
import type { DatabaseSync } from "node:sqlite";
import { tx } from "../storage/db.ts";

/**
 * `paper` counts toward live evidence. `paper_explore` runs looser entry rules
 * to measure execution. `paper_drill` forces an entry every few minutes with no
 * strategy at all. Neither of the last two ever counts.
 */
export type Mode = "paper" | "paper_explore" | "paper_drill";
export type PositionState = "PROPOSED" | "ENTRY_PENDING" | "OPEN" | "EXIT_PENDING" | "CLOSED" | "STUCK" | "FAILED";
export const SOFTWARE_VERSION = "0.5.0";

export interface PositionRow {
  id: string;
  mode: Mode;
  mint: string;
  venue: string;
  strategy: string;
  state: PositionState;
  opened_at: number | null;
  closed_at: number | null;
  updated_at: number;
  decimals: number;
  planned_size_lamports: string;
  planned_loss_cad: number;
  entry_price: number | null;
  invalidation_price: number;
  target_price: number;
  time_stop_ms: number;
  breakout_level: number | null;
  tokens_held: string;
  cost_basis_lamports: string;
  proceeds_lamports: string;
  fees_lamports: string;
  rent_locked_lamports: string;
  peak_net_lamports: string;
  partial_taken: number;
  real_quote_sol_at_entry: number | null;
  sol_cad_at_entry: number | null;
  fx_json: string | null;
  close_reason: string | null;
  close_detail: string | null;
  realized_pnl_lamports: string | null;
  realized_pnl_cad: number | null;
  software_version: string;
}

export interface OrderFill {
  quoteIn: bigint;
  quoteOut: bigint;
  quoteImpactPct: number;
  quoteRoute: string;
  quoteAt: number;
  simLatencyMs: number;
  requoteOut?: bigint;
  fillIn?: bigint;
  fillOut?: bigint;
  slippageBps?: number;
  baseFee: bigint;
  priorityFee: bigint;
  rent: bigint;
  failure?: string;
}

const ORDER: Record<PositionState, number> = { PROPOSED: 0, ENTRY_PENDING: 1, OPEN: 2, EXIT_PENDING: 3, CLOSED: 4, STUCK: 4, FAILED: 4 };

export class Ledger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number,
    private readonly mode: Mode = "paper",
  ) {}

  /** Several ledger writes as one unit (uses savepoints when already inside a transaction). */
  atomic<T>(fn: () => T): T {
    return tx(this.db, fn);
  }

  /**
   * Start-up recovery. A crash can leave a position PROPOSED or ENTRY_PENDING
   * (no fill was ever recorded, no cash moved) or EXIT_PENDING (still held).
   * The first two become FAILED with no P&L so they stop blocking entries; the
   * last goes back to OPEN so the exit engine manages it again.
   */
  recover(): { failedUnresolved: string[]; reopened: string[] } {
    return tx(this.db, () => {
      const unresolved = this.db.prepare("SELECT id FROM positions WHERE mode = ? AND state IN ('PROPOSED','ENTRY_PENDING')").all(this.mode) as { id: string }[];
      for (const { id } of unresolved) {
        this.db
          .prepare("UPDATE positions SET state = 'FAILED', closed_at = ?, updated_at = ?, close_reason = 'RECOVERED_UNRESOLVED', close_detail = 'process stopped before the entry resolved; no fill recorded, no cash moved', realized_pnl_lamports = '0', realized_pnl_cad = 0 WHERE id = ?")
          .run(this.now(), this.now(), id);
      }
      const pendingExits = this.db.prepare("SELECT id FROM positions WHERE mode = ? AND state = 'EXIT_PENDING'").all(this.mode) as { id: string }[];
      for (const { id } of pendingExits) this.db.prepare("UPDATE positions SET state = 'OPEN', updated_at = ? WHERE id = ?").run(this.now(), id);
      return { failedUnresolved: unresolved.map((u) => u.id), reopened: pendingExits.map((u) => u.id) };
    });
  }

  /** Create the paper account once. Later calls keep the existing balance. */
  initAccount(startingCad: number, solCad: number): void {
    const lamports = BigInt(Math.floor((startingCad / solCad) * 1e9));
    this.db
      .prepare("INSERT OR IGNORE INTO paper_account (mode, cash_lamports, starting_lamports, starting_cad, sol_cad_at_start, started_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.mode, lamports.toString(), lamports.toString(), startingCad, solCad, this.now());
  }

  account(): { cash: bigint; starting: bigint; startingCad: number; solCadAtStart: number; startedAt: number } | undefined {
    const r = this.db.prepare("SELECT * FROM paper_account WHERE mode = ?").get(this.mode) as
      | { cash_lamports: string; starting_lamports: string; starting_cad: number; sol_cad_at_start: number; started_at: number }
      | undefined;
    return r ? { cash: BigInt(r.cash_lamports), starting: BigInt(r.starting_lamports), startingCad: r.starting_cad, solCadAtStart: r.sol_cad_at_start, startedAt: r.started_at } : undefined;
  }

  private adjustCash(delta: bigint): void {
    const a = this.account();
    if (!a) throw new Error("paper account not initialised");
    const next = a.cash + delta;
    if (next < 0n) throw new Error("paper cash would go negative");
    this.db.prepare("UPDATE paper_account SET cash_lamports = ? WHERE mode = ?").run(next.toString(), this.mode);
  }

  get(id: string): PositionRow | undefined {
    return this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as PositionRow | undefined;
  }

  open(): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions WHERE mode = ? AND state IN ('OPEN','EXIT_PENDING','STUCK') ORDER BY opened_at").all(this.mode) as unknown as PositionRow[];
  }

  pending(): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions WHERE mode = ? AND state IN ('PROPOSED','ENTRY_PENDING','EXIT_PENDING') ORDER BY updated_at").all(this.mode) as unknown as PositionRow[];
  }

  closed(sinceMs = 0): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions WHERE mode = ? AND state IN ('CLOSED','FAILED') AND closed_at >= ? ORDER BY closed_at").all(this.mode, sinceMs) as unknown as PositionRow[];
  }

  private transition(id: string, to: PositionState, set: Record<string, string | number | null> = {}): boolean {
    const cur = this.get(id);
    if (!cur) throw new Error(`unknown position ${id}`);
    if (ORDER[to] <= ORDER[cur.state] && !(cur.state === "STUCK" && to === "CLOSED")) return false; // already there or past it: idempotent
    const cols = Object.keys(set);
    this.db
      .prepare(`UPDATE positions SET state = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ?`)
      .run(to, this.now(), ...cols.map((c) => set[c]!), id);
    return true;
  }

  propose(p: {
    id: string;
    mint: string;
    venue: string;
    strategy: string;
    decimals: number;
    plannedSizeLamports: bigint;
    plannedLossCad: number;
    invalidationPrice: number;
    targetPrice: number;
    timeStopMs: number;
    breakoutLevel?: number;
    realQuoteSolAtEntry?: number;
    solCad: number;
    fxJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO positions (id, mode, mint, venue, strategy, state, updated_at, decimals, planned_size_lamports, planned_loss_cad, invalidation_price, target_price, time_stop_ms, breakout_level, real_quote_sol_at_entry, sol_cad_at_entry, fx_json, software_version)
         VALUES (?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, this.mode, p.mint, p.venue, p.strategy, this.now(), p.decimals, p.plannedSizeLamports.toString(), p.plannedLossCad, p.invalidationPrice, p.targetPrice, p.timeStopMs, p.breakoutLevel ?? null, p.realQuoteSolAtEntry ?? null, p.solCad, p.fxJson, SOFTWARE_VERSION);
  }

  private insertOrder(id: string, positionId: string, side: "buy" | "sell", state: string, f: OrderFill, reason?: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO orders (id, position_id, side, state, created_at, resolved_at, reason, quote_in, quote_out, quote_impact_pct, quote_route, quote_at, sim_latency_ms, requote_out, fill_in, fill_out, slippage_bps, base_fee_lamports, priority_fee_lamports, rent_lamports, failure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, positionId, side, state, f.quoteAt, this.now(), reason ?? null, f.quoteIn.toString(), f.quoteOut.toString(), f.quoteImpactPct, f.quoteRoute, f.quoteAt, f.simLatencyMs, f.requoteOut?.toString() ?? null, f.fillIn?.toString() ?? null, f.fillOut?.toString() ?? null, f.slippageBps ?? null, f.baseFee.toString(), f.priorityFee.toString(), f.rent.toString(), f.failure ?? null);
  }

  /** Entry fill: cash out = fillIn + fees + rent; tokens in. */
  recordEntryFill(positionId: string, f: OrderFill, entryPrice: number): boolean {
    return tx(this.db, () => {
      if (!this.transition(positionId, "ENTRY_PENDING")) return false;
      this.insertOrder(`${positionId}:buy`, positionId, "buy", "FILLED", f);
      const fees = f.baseFee + f.priorityFee;
      this.adjustCash(-(f.fillIn! + fees + f.rent));
      this.transition(positionId, "OPEN", {
        opened_at: this.now(),
        entry_price: entryPrice,
        tokens_held: f.fillOut!.toString(),
        cost_basis_lamports: (f.fillIn! + fees).toString(),
        fees_lamports: fees.toString(),
        rent_locked_lamports: f.rent.toString(),
        peak_net_lamports: "0",
      });
      return true;
    });
  }

  /** Entry failed on-chain: fees are still paid, nothing is held. */
  recordEntryFailure(positionId: string, f: OrderFill): boolean {
    return tx(this.db, () => {
      if (!this.transition(positionId, "ENTRY_PENDING")) return false;
      this.insertOrder(`${positionId}:buy`, positionId, "buy", "FAILED", f);
      const fees = f.baseFee + f.priorityFee;
      this.adjustCash(-fees);
      this.transition(positionId, "FAILED", { closed_at: this.now(), fees_lamports: fees.toString(), close_reason: "ENTRY_FAILED", close_detail: f.failure ?? null, realized_pnl_lamports: (-fees).toString() });
      return true;
    });
  }

  updateMark(positionId: string, netLamports: bigint): void {
    const p = this.get(positionId);
    if (!p || (p.state !== "OPEN" && p.state !== "STUCK")) return;
    if (netLamports > BigInt(p.peak_net_lamports)) this.db.prepare("UPDATE positions SET peak_net_lamports = ?, updated_at = ? WHERE id = ?").run(netLamports.toString(), this.now(), positionId);
  }

  private sellOrderId(positionId: string, orderKey?: string): string | undefined {
    const id = orderKey ? `${positionId}:sell:${orderKey}` : `${positionId}:sell:${(this.db.prepare("SELECT COUNT(*) n FROM orders WHERE position_id = ? AND side = 'sell'").get(positionId) as { n: number }).n + 1}`;
    // Idempotent: the same order key applied twice does nothing the second time.
    return this.db.prepare("SELECT 1 FROM orders WHERE id = ?").get(id) ? undefined : id;
  }

  /**
   * Exit fill for `tokensSold` (all, or part). Rent comes back only when the account is emptied.
   * `orderKey` makes the call idempotent: a repeat with the same key is ignored.
   */
  recordExitFill(positionId: string, f: OrderFill, tokensSold: bigint, reason: string, detail: string, solCadNow: number | null, orderKey?: string): boolean {
    return tx(this.db, () => {
      const p = this.get(positionId);
      if (!p || (p.state !== "OPEN" && p.state !== "STUCK" && p.state !== "EXIT_PENDING")) return false;
      const held = BigInt(p.tokens_held);
      if (tokensSold > held || tokensSold <= 0n) throw new Error("exit size exceeds holding");
      const orderId = this.sellOrderId(positionId, orderKey);
      if (!orderId) return false;
      this.insertOrder(orderId, positionId, "sell", "FILLED", f, reason);
      const fees = f.baseFee + f.priorityFee;
      const remaining = held - tokensSold;
      const rentBack = remaining === 0n ? BigInt(p.rent_locked_lamports) : 0n;
      this.adjustCash(f.fillOut! - fees + rentBack);
      const proceeds = BigInt(p.proceeds_lamports) + f.fillOut! - fees;
      const totalFees = BigInt(p.fees_lamports) + fees;
      const set: Record<string, string | number | null> = { tokens_held: remaining.toString(), proceeds_lamports: proceeds.toString(), fees_lamports: totalFees.toString(), partial_taken: remaining === 0n ? p.partial_taken : 1 };
      if (remaining === 0n) {
        const pnl = proceeds - BigInt(p.cost_basis_lamports);
        const solCad = solCadNow ?? p.sol_cad_at_entry;
        Object.assign(set, { closed_at: this.now(), close_reason: reason, close_detail: detail, rent_locked_lamports: "0", realized_pnl_lamports: pnl.toString(), realized_pnl_cad: solCad ? (Number(pnl) / 1e9) * solCad : null });
        this.db.prepare(`UPDATE positions SET state = 'CLOSED', updated_at = ?${Object.keys(set).map((c) => `, ${c} = ?`).join("")} WHERE id = ?`).run(this.now(), ...Object.values(set), positionId);
      } else {
        this.db.prepare(`UPDATE positions SET state = 'OPEN', updated_at = ?${Object.keys(set).map((c) => `, ${c} = ?`).join("")} WHERE id = ?`).run(this.now(), ...Object.values(set), positionId);
      }
      return true;
    });
  }

  /** Exit attempt failed (no route, failed tx): fees paid, still held. */
  recordExitFailure(positionId: string, f: OrderFill, reason: string, stuck: boolean, orderKey?: string): boolean {
    return tx(this.db, () => {
      const p = this.get(positionId);
      if (!p || (p.state !== "OPEN" && p.state !== "STUCK" && p.state !== "EXIT_PENDING")) return false;
      const orderId = this.sellOrderId(positionId, orderKey);
      if (!orderId) return false;
      this.insertOrder(orderId, positionId, "sell", "FAILED", f, reason);
      const fees = f.baseFee + f.priorityFee;
      if (fees > 0n) this.adjustCash(-fees);
      this.db
        .prepare("UPDATE positions SET state = ?, fees_lamports = ?, updated_at = ? WHERE id = ?")
        .run(stuck ? "STUCK" : "OPEN", (BigInt(p.fees_lamports) + fees).toString(), this.now(), positionId);
      return true;
    });
  }

  /** Mark-to-market: cash plus the net sell value of open positions (0 for positions with no quote). */
  snapshot(marks: Map<string, bigint>, solCad: number | null): { cash: bigint; marks: bigint; equity: bigint } {
    const a = this.account();
    if (!a) throw new Error("paper account not initialised");
    let m = 0n;
    for (const p of this.open()) m += marks.get(p.id) ?? 0n;
    const equity = a.cash + m;
    this.db
      .prepare("INSERT OR REPLACE INTO equity_snapshots (at, mode, cash_lamports, positions_mark_lamports, equity_lamports, sol_cad, equity_cad) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(this.now(), this.mode, a.cash.toString(), m.toString(), equity.toString(), solCad, solCad ? (Number(equity) / 1e9) * solCad : null);
    return { cash: a.cash, marks: m, equity };
  }
}
