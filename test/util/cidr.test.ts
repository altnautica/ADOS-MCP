import { describe, it, expect } from "vitest";
import { sourceIpAllowed, isLoopback, isPrivateOrLocalHost } from "../../src/util/cidr.js";

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

describe("isPrivateOrLocalHost", () => {
  it("treats loopback + empty as local", () => {
    expect(isPrivateOrLocalHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalHost("localhost")).toBe(true);
    expect(isPrivateOrLocalHost("::1")).toBe(true);
    expect(isPrivateOrLocalHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrLocalHost("")).toBe(true);
  });

  it("treats RFC1918 + link-local + mDNS as local", () => {
    expect(isPrivateOrLocalHost("192.168.1.50")).toBe(true);
    expect(isPrivateOrLocalHost("10.0.0.9")).toBe(true);
    expect(isPrivateOrLocalHost("172.16.5.5")).toBe(true);
    expect(isPrivateOrLocalHost("172.31.255.255")).toBe(true);
    expect(isPrivateOrLocalHost("169.254.1.2")).toBe(true);
    expect(isPrivateOrLocalHost("skynodepi.local")).toBe(true);
  });

  it("strips scheme, port, path, and IPv6 brackets before classifying", () => {
    expect(isPrivateOrLocalHost("http://192.168.1.50:8080")).toBe(true);
    expect(isPrivateOrLocalHost("192.168.1.50:8080")).toBe(true);
    expect(isPrivateOrLocalHost("http://groundnode.local:8080/api/status")).toBe(true);
    expect(isPrivateOrLocalHost("http://[::1]:8080")).toBe(true);
    expect(isPrivateOrLocalHost("fe80::1")).toBe(true);
    expect(isPrivateOrLocalHost("fd00::5")).toBe(true);
  });

  it("rejects public / routable hosts (they still need a token)", () => {
    // RFC 5737 / RFC 2606 documentation ranges — never real LAN addresses.
    expect(isPrivateOrLocalHost("203.0.113.5")).toBe(false);
    expect(isPrivateOrLocalHost("198.51.100.7:8080")).toBe(false);
    expect(isPrivateOrLocalHost("example.com")).toBe(false);
    expect(isPrivateOrLocalHost("https://mcp.altnautica.com/mcp")).toBe(false);
    // 172.15 and 172.32 are OUTSIDE the /12 private block.
    expect(isPrivateOrLocalHost("172.15.0.1")).toBe(false);
    expect(isPrivateOrLocalHost("172.32.0.1")).toBe(false);
  });
});
