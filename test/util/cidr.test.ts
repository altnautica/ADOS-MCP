import { describe, it, expect } from "vitest";
import { sourceIpAllowed, isLoopback } from "../../src/util/cidr.js";

// Uses documentation IP ranges (RFC 5737) to keep test data neutral.
describe("sourceIpAllowed", () => {
  it("allows any IP when the pin list is empty", () => {
    expect(sourceIpAllowed([], "203.0.113.5")).toBe(true);
  });

  it("always allows loopback regardless of the pin", () => {
    expect(sourceIpAllowed(["203.0.113.0/24"], "127.0.0.1")).toBe(true);
    expect(sourceIpAllowed(["203.0.113.0/24"], "::1")).toBe(true);
    expect(isLoopback("127.0.0.5")).toBe(true);
  });

  it("matches an IPv4 CIDR and rejects outside it", () => {
    expect(sourceIpAllowed(["203.0.113.0/24"], "203.0.113.200")).toBe(true);
    expect(sourceIpAllowed(["203.0.113.0/24"], "198.51.100.7")).toBe(false);
  });

  it("matches an exact /32", () => {
    expect(sourceIpAllowed(["203.0.113.9/32"], "203.0.113.9")).toBe(true);
    expect(sourceIpAllowed(["203.0.113.9/32"], "203.0.113.10")).toBe(false);
  });

  it("fails closed on a malformed trailing-slash CIDR (does not match everything)", () => {
    // "x.x.x.x/" must NOT parse to /0. A non-loopback IP with only a malformed
    // pin entry is denied.
    expect(sourceIpAllowed(["203.0.113.5/"], "198.51.100.7")).toBe(false);
    expect(sourceIpAllowed(["203.0.113.5/"], "203.0.113.5")).toBe(false);
  });

  it("permits a request with no source info (stdio / on-box)", () => {
    expect(sourceIpAllowed(["203.0.113.0/24"], undefined)).toBe(true);
  });

  it("normalizes IPv4-mapped IPv6", () => {
    expect(sourceIpAllowed(["203.0.113.0/24"], "::ffff:203.0.113.7")).toBe(true);
  });
});
