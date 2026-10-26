/**
 * Export the paper ledger as CSV files for record-keeping and tax review.
 *
 *   npm run export            # writes data/export/positions.csv and orders.csv
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { exportOrdersCsv, exportPositionsCsv } from "../paper/exportCsv.ts";
import { openDb } from "../storage/db.ts";

const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
const dir = resolve(cfg.DATA_DIR, "export");
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, "positions.csv"), exportPositionsCsv(db));
writeFileSync(resolve(dir, "orders.csv"), exportOrdersCsv(db));
const n = (db.prepare("SELECT COUNT(*) n FROM positions").get() as { n: number }).n;
process.stdout.write(`wrote ${dir}/positions.csv (${n} positions) and orders.csv\nThese records do not determine tax treatment; keep them for your accountant.\n`);
db.close();
