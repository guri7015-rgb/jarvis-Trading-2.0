/**
 * CSV export of the paper ledger for record-keeping and tax review.
 *
 * Fields follow CRA's record list (date/time, amount and type, CAD value,
 * purpose, counterparty) plus the on-chain identifiers. The software does
 * not decide tax treatment; that depends on the facts and your accountant.
 */
import type { DatabaseSync } from "node:sqlite";

const esc = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  // A cell starting with = + - @ would run as a formula in a spreadsheet. Route labels and
  // failure strings come from providers, so neutralise them (negative numbers stay numbers).
  if (/^[=+\-@]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function exportPositionsCsv(db: DatabaseSync): string {
  const rows = db.prepare("SELECT * FROM positions ORDER BY opened_at").all() as Record<string, unknown>[];
  const head = [
    "position_id", "mode", "mint", "venue", "strategy", "state", "opened_at_utc", "closed_at_utc", "entry_price_sol_per_token", "tokens_bought", "cost_basis_sol", "proceeds_sol", "fees_sol", "realized_pnl_sol", "sol_cad_rate_at_entry", "fx_source", "realized_pnl_cad", "close_reason", "close_detail", "software_version",
  ];
  const lines = [head.join(",")];
  for (const r of rows) {
    const buy = db.prepare("SELECT fill_out FROM orders WHERE position_id = ? AND side = 'buy' AND state = 'FILLED'").get(r.id as string) as { fill_out: string } | undefined;
    let fx = "";
    try {
      const j = JSON.parse((r.fx_json as string) ?? "{}");
      fx = j.usdCadDate ? `Jupiter SOL/USD ${new Date(j.solUsdAt).toISOString()} x BoC USD/CAD ${j.usdCadDate}` : "";
    } catch {
      /* no fx */
    }
    lines.push(
      [
        r.id, r.mode, r.mint, r.venue, r.strategy, r.state,
        r.opened_at ? new Date(r.opened_at as number).toISOString() : "",
        r.closed_at ? new Date(r.closed_at as number).toISOString() : "",
        r.entry_price,
        buy?.fill_out ?? "",
        Number(r.cost_basis_lamports as string) / 1e9,
        Number(r.proceeds_lamports as string) / 1e9,
        Number(r.fees_lamports as string) / 1e9,
        r.realized_pnl_lamports ? Number(r.realized_pnl_lamports as string) / 1e9 : "",
        r.sol_cad_at_entry, fx, r.realized_pnl_cad, r.close_reason, r.close_detail, r.software_version,
      ].map(esc).join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function exportOrdersCsv(db: DatabaseSync): string {
  const rows = db.prepare("SELECT o.*, p.mint FROM orders o JOIN positions p ON p.id = o.position_id ORDER BY o.created_at").all() as Record<string, unknown>[];
  const head = ["order_id", "position_id", "mint", "side", "state", "created_at_utc", "resolved_at_utc", "reason", "quote_in", "quote_out", "quote_impact_pct", "quote_route", "sim_latency_ms", "requote_out", "fill_in", "fill_out", "slippage_bps", "base_fee_lamports", "priority_fee_lamports", "rent_lamports", "failure", "signature"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push(
      [r.id, r.position_id, r.mint, r.side, r.state, new Date(r.created_at as number).toISOString(), r.resolved_at ? new Date(r.resolved_at as number).toISOString() : "", r.reason, r.quote_in, r.quote_out, r.quote_impact_pct, r.quote_route, r.sim_latency_ms, r.requote_out, r.fill_in, r.fill_out, r.slippage_bps, r.base_fee_lamports, r.priority_fee_lamports, r.rent_lamports, r.failure, r.signature ?? ""].map(esc).join(","),
    );
  }
  return lines.join("\n") + "\n";
}
