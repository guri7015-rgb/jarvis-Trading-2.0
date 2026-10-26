/** Exponential backoff with full jitter, capped. */
export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  random?: () => number;
}

export function backoffDelay(attempt: number, opts: BackoffOptions): number {
  const rnd = opts.random ?? Math.random;
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  // Full jitter, but never below a quarter of the step so we don't hammer on unlucky draws.
  return Math.round(exp * (0.25 + 0.75 * rnd()));
}
