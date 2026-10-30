/**
 * Does the RPC in .env do everything the bot needs? Never prints the URL or key.
 *
 *   npm run rpc-check
 *
 * Checks, in order: getSlot, getMultipleAccounts, getTokenLargestAccounts
 * (holder check; many free tiers block it), getRecentPrioritizationFees,
 * and a logsSubscribe on the WebSocket URL.
 */
import { fetch, WebSocket } from "undici";
import { describeRpc, loadConfig } from "../core/config.ts";

const cfg = loadConfig();
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const out: string[] = [`RPC check ${new Date().toISOString()}`, `  http: ${describeRpc(cfg.SOLANA_RPC_URL)}`, `  ws:   ${describeRpc(cfg.SOLANA_WS_URL)}`, ""];
let failed = 0;
let holderOnly = true;

async function call(method: string, params: unknown[]): Promise<{ ok: boolean; note: string }> {
  const started = Date.now();
  try {
    const res = await fetch(cfg.SOLANA_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), redirect: "error", signal: AbortSignal.timeout(15_000) });
    const ms = Date.now() - started;
    if (res.status === 429) return { ok: false, note: `rate limited (429) in ${ms} ms: plan used up or too many calls` };
    if (res.status === 401 || res.status === 403) return { ok: false, note: `refused (${res.status}): key wrong, or this method is not on your plan` };
    const body = JSON.parse(await res.text()) as { result?: unknown; error?: { code: number; message: string } };
    if (body.error) return { ok: false, note: `error ${body.error.code}: ${String(body.error.message).slice(0, 100)}` };
    return { ok: true, note: `${ms} ms` };
  } catch (e) {
    return { ok: false, note: (e as Error).message.replace(/https?:\/\/\S+/g, "<url>").slice(0, 100) };
  }
}

const checks: [string, string, unknown[], string][] = [
  ["getSlot", "basic reads", [{ commitment: "confirmed" }], "nothing works"],
  ["getMultipleAccounts", "confirming coins on chain", [[USDC], { encoding: "base64" }], "coins never confirm"],
  ["getTokenLargestAccounts", "holder check", [USDC], "on-chain holder read refused; paper explore/drill use Jupiter's holder summary instead"],
  ["getRecentPrioritizationFees", "fee estimate", [[]], "fees budgeted at the cap (conservative, still works)"],
];
for (const [m, what, params, ifFail] of checks) {
  const r = await call(m, params);
  if (!r.ok) {
    failed++;
    if (m !== "getTokenLargestAccounts") holderOnly = false;
  }
  out.push(`  ${r.ok ? "OK  " : "FAIL"} ${m.padEnd(28)} ${what.padEnd(28)} ${r.note}${r.ok ? "" : `  -> ${ifFail}`}`);
}

const ws = await new Promise<{ ok: boolean; note: string }>((resolve) => {
  const started = Date.now();
  let done = false;
  const finish = (r: { ok: boolean; note: string }) => {
    if (done) return;
    done = true;
    try { sock.close(); } catch { /* ignore */ }
    resolve(r);
  };
  const sock = new WebSocket(cfg.SOLANA_WS_URL);
  const t = setTimeout(() => finish({ ok: false, note: "no data in 20 s" }), 20_000);
  sock.addEventListener("open", () => sock.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP] }, { commitment: "confirmed" }] })));
  sock.addEventListener("message", (ev) => {
    const m = JSON.parse(String(ev.data)) as { method?: string; error?: { message: string } };
    if (m.error) { clearTimeout(t); finish({ ok: false, note: `refused: ${m.error.message.slice(0, 80)}` }); }
    if (m.method === "logsNotification") { clearTimeout(t); finish({ ok: true, note: `first event in ${Date.now() - started} ms` }); }
  });
  sock.addEventListener("close", (ev) => { clearTimeout(t); finish({ ok: false, note: `closed (${(ev as unknown as { code: number }).code}) before any data: key used up or WebSockets not on this plan` }); });
  sock.addEventListener("error", () => { clearTimeout(t); finish({ ok: false, note: "connection error" }); });
});
if (!ws.ok) {
  failed++;
  holderOnly = false;
}
out.push(`  ${ws.ok ? "OK  " : "FAIL"} ${"logsSubscribe (WebSocket)".padEnd(28)} ${"live trade feed".padEnd(28)} ${ws.note}${ws.ok ? "" : "  -> no signals at all"}`);
out.push("", !failed ? "All good. This RPC can run the bot." : holderOnly ? "Only the on-chain holder read is refused. Paper explore and drill mode will run, using Jupiter's holder summary." : `${failed} check(s) failed. The bot will not work properly on this RPC.`);
process.stdout.write(out.join("\n") + "\n");
process.exit(0);
