import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../src/gate/rate-limit.js";

describe("RateLimiter", () => {
  it("allows a burst then blocks", () => {
    const now = 1_000_000;
    const rl = new RateLimiter({ toolCallsPerSec: 1, toolBurst: 3, resourceReadsPerSec: 10, resourceBurst: 10 }, () => now);
    expect(rl.check("t", "tool").allowed).toBe(true);
    expect(rl.check("t", "tool").allowed).toBe(true);
    expect(rl.check("t", "tool").allowed).toBe(true);
    const blocked = rl.check("t", "tool");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", () => {
    let now = 0;
    const rl = new RateLimiter({ toolCallsPerSec: 2, toolBurst: 1, resourceReadsPerSec: 10, resourceBurst: 10 }, () => now);
    expect(rl.check("t", "tool").allowed).toBe(true);
    expect(rl.check("t", "tool").allowed).toBe(false);
    now += 600; // 0.6s * 2/s = 1.2 tokens
    expect(rl.check("t", "tool").allowed).toBe(true);
  });

  it("separates tokens and kinds", () => {
    const now = 0;
    const rl = new RateLimiter({ toolCallsPerSec: 1, toolBurst: 1, resourceReadsPerSec: 1, resourceBurst: 1 }, () => now);
    expect(rl.check("a", "tool").allowed).toBe(true);
    expect(rl.check("a", "tool").allowed).toBe(false);
    expect(rl.check("b", "tool").allowed).toBe(true); // different token
    expect(rl.check("a", "resource").allowed).toBe(true); // different kind
  });
});
