/**
 * One-shot provider check: is each data source reachable, does its payload
 * pass our schema, and which venues does it report right now?
 *
 *   npm run probe
 */
import { buildDeps } from "../app/wire.ts";
import { describeRpc, loadConfig } from "../core/config.ts";
import { fetchDexScreenerTokens } from "../providers/dexscreener.ts";
import { fetchGeckoNewPools } from "../providers/geckoterminal.ts";
import { fetchJupiterRecent } from "../providers/jupiterTokens.ts";
import { buildSubscribeMessages, parsePumpPortalMessage, PUMPPORTAL_DATA_URL } from "../providers/pumpportal.ts";

const cfg = loadConfig();
const deps = buildDeps(cfg);
const now = () => Date.now();
const lines: string[] = [`provider probe ${new Date().toISOString()}  rpc=${describeRpc(cfg.SOLANA_RPC_URL)}`];

function venues(evs: { venueRaw: string }[]): string {
  const m = new Map<string, number>();
  for (const e of evs) m.set(e.venueRaw, (m.get(e.venueRaw) ?? 0) + 1);
  return [...m].map(([k, v]) => `${k}=${v}`).join(", ");
}

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const t = Date.now();
  try {
    const detail = await fn();
    lines.push(`  OK   ${name.padEnd(15)} ${String(Date.now() - t).padStart(5)}ms  ${detail}`);
  } catch (e) {
    lines.push(`  FAIL ${name.padEnd(15)} ${(e as Error).message}`);
  }
}

let sampleMints: string[] = [];
await step("solana_rpc", async () => `slot ${await deps.rpc.getSlot()}`);
await step("jupiter_tokens", async () => {
  const r = await fetchJupiterRecent(deps.http, cfg.JUPITER_API_KEY, now);
  sampleMints = r.events.map((e) => e.mint);
  return `${r.events.length} tokens, ${r.rejected} rejected; launchpads: ${venues(r.events)}`;
});
await step("geckoterminal", async () => {
  const r = await fetchGeckoNewPools(deps.http, now);
  const ages = r.events.filter((e) => e.poolCreatedAt).map((e) => Math.round((Date.now() - e.poolCreatedAt!) / 1000));
  return `${r.events.length} pools, ${r.rejected} rejected; dexes: ${venues(r.events)}; pool ages ${Math.min(...ages)}–${Math.max(...ages)}s`;
});
await step("dexscreener", async () => {
  const r = await fetchDexScreenerTokens(deps.http, sampleMints);
  return `${new Set(r.pairs.map((p) => p.mint)).size}/${Math.min(30, sampleMints.length)} Jupiter-recent mints known; dexes: ${venues(r.pairs)}`;
});
await step("pumpportal", () => {
  return new Promise((resolveP, reject) => {
    const ws = deps.wsFactory(PUMPPORTAL_DATA_URL);
    const evs: { venueRaw: string }[] = [];
    const timer = setTimeout(() => {
      ws.close();
      evs.length ? resolveP(`${evs.length} events in 20s; pools: ${venues(evs)}`) : reject(new Error("no events in 20s"));
    }, 20_000);
    ws.onopen = () => buildSubscribeMessages(["subscribeNewToken", "subscribeMigration"]).forEach((m) => ws.send(m));
    ws.onmessage = (e) => {
      const p = parsePumpPortalMessage(String(e.data), Date.now());
      if (p.type === "event") evs.push(p.event);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("socket error"));
    };
  });
});

process.stdout.write(lines.join("\n") + "\n");
deps.db.close();
process.exit(0);
