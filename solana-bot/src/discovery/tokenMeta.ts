/**
 * Fills in names, symbols and logo URLs for the handful of tokens the
 * dashboard shows (watchlist, positions, recent rejections, recent signals).
 *
 * Display only. Nothing here feeds a gate, a strategy or the risk manager.
 * One Jupiter Tokens v2 `/search` call covers up to 100 mints; a mint that
 * came back without a logo is not asked about again for an hour.
 */
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { HttpClient } from "../net/http.ts";
import { fetchJupiterTokenMeta } from "../providers/jupiterTokens.ts";
import type { TokenRegistry } from "./registry.ts";

const RETRY_AFTER_MS = 3_600_000;

export class TokenMetaService {
  private readonly askedAt = new Map<string, number>();
  private inFlight = false;

  constructor(
    private readonly registry: TokenRegistry,
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Look up logos for the given mints that have none. At most one request at a time. */
  async refresh(mints: string[]): Promise<number> {
    if (this.inFlight) return 0;
    const now = this.clock.now();
    const want = this.registry.missingIcons(mints).filter((m) => (this.askedAt.get(m) ?? 0) + RETRY_AFTER_MS < now).slice(0, 100);
    if (!want.length) return 0;
    this.inFlight = true;
    try {
      for (const m of want) this.askedAt.set(m, now);
      const found = await fetchJupiterTokenMeta(this.http, this.apiKey, want);
      for (const f of found) this.registry.setMeta(f, "jupiter_tokens", now);
      return found.length;
    } catch (e) {
      this.logger.warn("token meta lookup failed", { err: (e as Error).message, mints: want.length });
      return 0;
    } finally {
      this.inFlight = false;
    }
  }
}
