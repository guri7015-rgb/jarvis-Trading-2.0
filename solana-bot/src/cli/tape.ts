/**
 * Export or import the research tape: trades, gaps, assessments, decisions
 * and paper positions. All of it is public on-chain data or the bot's own
 * decisions. No keys, no secrets, no wallet.
 *
 *   npm run tape -- export            # writes tapes/tape-<date>-<host>.json.gz
 *   npm run tape -- import <file>     # merges a tape into this machine's database
 *
 * Exported files are small enough to commit (tens of KB per hour of busy tape).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { loadConfig } from "../core/config.ts";
import { openDb, tx } from "../storage/db.ts";

const args = process.argv.slice(2);
const cmd = args[0];
const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));

const TABLES = ["trades", "gaps", "assessments", "decisions", "positions", "orders", "pools", "tokens"] as const;

if (cmd === "export") {
  const dir = resolve(process.cwd(), "tapes");
  mkdirSync(dir, { recursive: true });
  const payload: Record<string, unknown> = { version: 1, exportedAt: new Date().toISOString(), host: createHash("sha256").update(hostname()).digest("hex").slice(0, 8) };
  for (const t of TABLES) {
    // Keep the tape small: only tokens and pools that trades or assessments refer to,
    // and decisions without their feature snapshots (replay recomputes those).
    if (t === "tokens") payload[t] = db.prepare("SELECT * FROM tokens WHERE mint IN (SELECT mint FROM trades UNION SELECT mint FROM assessments UNION SELECT mint FROM positions)").all();
    else if (t === "pools") payload[t] = db.prepare("SELECT * FROM pools WHERE mint IN (SELECT mint FROM trades UNION SELECT mint FROM assessments)").all();
    else if (t === "decisions") payload[t] = db.prepare("SELECT id, at, mint, strategy, action, reasons, signal_json, risk_json FROM decisions WHERE action != 'SNAPSHOT'").all();
    else payload[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  const json = JSON.stringify(payload);
  const name = `tape-${new Date().toISOString().slice(0, 10)}-${payload.host as string}.json.gz`;
  writeFileSync(resolve(dir, name), gzipSync(Buffer.from(json)));
  const n = (payload.trades as unknown[]).length;
  process.stdout.write(`wrote tapes/${name}: ${n} trades, ${(payload.assessments as unknown[]).length} assessments, ${(payload.decisions as unknown[]).length} decisions (${Math.round(json.length / 1024)} KB raw)\nCommit the tapes/ folder to share it: git add tapes && git commit -m "tape" && git push\n`);
} else if (cmd === "import" && args[1]) {
  const file = resolve(process.cwd(), args[1]);
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);
  // A tape is a file from another machine: treat it as data, never as SQL.
  //  - decompressed size is capped
  //  - every column name must exist in the real table (the file's keys never reach the SQL text)
  //  - values must be plain scalars
  //  - positions and orders are re-labelled mode "imported:<mode>" so this machine's trader
  //    never manages them and they never count as this machine's paper account
  const MAX_BYTES = 256 * 1024 * 1024;
  const MAX_ROWS = 2_000_000;
  const raw = gunzipSync(readFileSync(file), { maxOutputLength: MAX_BYTES });
  const payload = JSON.parse(raw.toString()) as Record<string, unknown> & { version: number };
  if (payload.version !== 1) throw new Error(`unknown tape version ${String(payload.version)}`);
  const counts: Record<string, number> = {};
  tx(db, () => {
    for (const t of TABLES) {
      const rows = payload[t];
      if (!Array.isArray(rows) || !rows.length) continue;
      if (rows.length > MAX_ROWS) throw new Error(`tape table ${t} has ${rows.length} rows; refusing`);
      const real = new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
      const cols = Object.keys(rows[0] as object).filter((c) => real.has(c));
      if (!cols.length) continue;
      const stmt = db.prepare(`INSERT OR IGNORE INTO ${t} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
      let n = 0;
      for (const r of rows as Record<string, unknown>[]) {
        const vals = cols.map((c) => {
          let v = r[c];
          if ((t === "positions" || t === "orders") && c === "mode" && typeof v === "string" && !v.startsWith("imported:")) v = `imported:${v}`;
          if (v === undefined) v = null;
          if (v !== null && typeof v !== "string" && typeof v !== "number") throw new Error(`tape ${t}.${c}: unexpected value type ${typeof v}`);
          return v as string | number | null;
        });
        n += Number(stmt.run(...vals).changes);
      }
      counts[t] = n;
    }
  });
  process.stdout.write(`imported ${JSON.stringify(counts)} new rows from ${args[1]}\nPositions and orders are labelled mode "imported:<mode>": analysed with npm run evidence -- --imported, never managed here.\n`);
} else {
  process.stdout.write("usage: npm run tape -- export | import <file.json.gz>\n");
}
db.close();
