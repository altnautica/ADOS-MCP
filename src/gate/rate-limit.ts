// Per-token token-bucket rate limiting. Sized so an interactive AI client is
// never throttled but a runaway loop is bounded. Separate buckets for tool
// calls and resource reads (reads are cheap and get a higher budget).

export interface RateLimitConfig {
  toolCallsPerSec: number;
  toolBurst: number;
  resourceReadsPerSec: number;
  resourceBurst: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  toolCallsPerSec: 10,
  toolBurst: 30,
  resourceReadsPerSec: 40,
  resourceBurst: 80,
};

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export type RateKind = "tool" | "resource";

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: RateLimitConfig = DEFAULT_RATE_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Consume one unit for a token+kind. Returns { allowed, retryAfterMs }.
   * A refused call reports how long until a token frees up.
   */
  check(tokenId: string, kind: RateKind): { allowed: boolean; retryAfterMs: number } {
    const rate = kind === "tool" ? this.config.toolCallsPerSec : this.config.resourceReadsPerSec;
    const burst = kind === "tool" ? this.config.toolBurst : this.config.resourceBurst;
    const key = `${tokenId}:${kind}`;
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: burst, lastRefill: t };
      this.buckets.set(key, b);
    }
    const elapsedSec = (t - b.lastRefill) / 1000;
    if (elapsedSec > 0) {
      b.tokens = Math.min(burst, b.tokens + elapsedSec * rate);
      b.lastRefill = t;
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }
    const deficit = 1 - b.tokens;
    return { allowed: false, retryAfterMs: Math.ceil((deficit / rate) * 1000) };
  }

  /** Drop a token's buckets (on revocation or disconnect). */
  forget(tokenId: string): void {
    this.buckets.delete(`${tokenId}:tool`);
    this.buckets.delete(`${tokenId}:resource`);
  }
}
