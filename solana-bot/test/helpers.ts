import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Clock } from "../src/core/clock.ts";
import type { AppConfig } from "../src/core/config.ts";
import type { FetchLike } from "../src/net/http.ts";
import type { WsLike } from "../src/net/wsClient.ts";

export const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8");
export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixture(name)) as T;

/** Clock whose sleeps return at once and move virtual time forward. */
export class ImmediateClock implements Clock {
  constructor(public t = 1_700_000_000_000) {}
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    return setTimeout(() => {
      this.t += ms;
      fn();
    }, 0);
  }
  clearTimeout(h: unknown) {
    clearTimeout(h as NodeJS.Timeout);
  }
  async sleep(ms: number) {
    this.t += ms;
  }
}

export interface FakeResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Fetch fake that replays scripted responses and records calls. */
export function scriptedFetch(responses: (FakeResponse | Error | "hang")[]) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (r === undefined) return Promise.reject(new Error("no scripted response"));
    if (r === "hang")
      return new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    if (r instanceof Error) return Promise.reject(r);
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return Promise.resolve({ status: r.status, headers: { get: (n: string) => headers.get(n.toLowerCase()) ?? null }, text: async () => r.body ?? "" });
  };
  return { fetch, calls };
}

export class FakeSocket implements WsLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: WsLike["onopen"] = null;
  onmessage: WsLike["onmessage"] = null;
  onclose: WsLike["onclose"] = null;
  onerror: WsLike["onerror"] = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // Test controls
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(text: string) {
    this.onmessage?.({ data: text });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

export function testConfig(over: Partial<AppConfig["discovery"]> = {}): AppConfig {
  return {
    SOLANA_RPC_URL: "https://rpc.invalid",
    SOLANA_WS_URL: "wss://rpc.invalid",
    SOLANA_FIREHOSE_WS_URL: "wss://rpc.invalid",
    JUPITER_API_KEY: undefined,
    RPC_DAILY_CALL_BUDGET: 1000,
    DATA_DIR: ":memory:",
    discovery: {
      geckoPollMs: 20_000,
      jupiterRecentPollMs: 30_000,
      pumpportalMaxSilenceMs: 60_000,
      pollMaxAgeFactor: 4,
      confirmBatchSize: 50,
      confirmIntervalMs: 5_000,
      newLaunchMaxAgeMs: 10 * 60_000,
      earlyMaxAgeMs: 2 * 3_600_000,
      ...over,
    },
  };
}

/** RPC fixture accounts: [0] token-2022 pump mint, [1] its bonding curve, [2] USDC (classic), [3] another pump mint. */
export function rpcFixtureAccounts() {
  const d = fixtureJson<{ result: { context: { slot: number }; value: { owner: string; data: [string, string] }[] } }>("rpc-getMultipleAccounts.json");
  return {
    slot: d.result.context.slot,
    accounts: d.result.value.map((a) => ({ owner: a.owner, lamports: 1, data: Uint8Array.from(Buffer.from(a.data[0], "base64")) })),
  };
}

export const PUMP_MINT = "H5YoDy72WFxRsRsYnqVptgKjbseBmYdMrXCex8WRpump";
export const PUMP_CURVE = "5tvQ1YUj5ViszyYYbrBiXR58eUkxh4VRykZ9oDu9n7Wx";
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
