import { afterEach, describe, it, expect } from "vitest";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { parseCli } from "../src/cli.js";
import { resolveSourceIp, startHttpServer } from "../src/transport/http.js";
import { makeCore } from "./helpers.js";

function fakeReq(headers: Record<string, string>, remoteAddress = "192.168.1.50"): http.IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as http.IncomingMessage;
}

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe("proxy trust", () => {
  it("ignores spoofed forwarded headers without --trust-proxy", () => {
    const req = fakeReq({ "x-forwarded-for": "10.9.9.9", "cf-connecting-ip": "10.8.8.8" });
    expect(resolveSourceIp(req, false)).toBe("192.168.1.50");
  });

  it("prefers cf-connecting-ip behind a trusted proxy", () => {
    const req = fakeReq({ "cf-connecting-ip": " 203.0.113.7 ", "x-forwarded-for": "10.9.9.9, 198.51.100.4" }, "127.0.0.1");
    expect(resolveSourceIp(req, true)).toBe("203.0.113.7");
  });

  it("takes the right-most X-Forwarded-For hop, not the client-supplied first one", () => {
    const req = fakeReq({ "x-forwarded-for": "10.9.9.9, 198.51.100.4" }, "127.0.0.1");
    expect(resolveSourceIp(req, true)).toBe("198.51.100.4");
  });

  it("falls back to the socket peer when no forwarded header is present", () => {
    expect(resolveSourceIp(fakeReq({}, "::ffff:127.0.0.1"), true)).toBe("127.0.0.1");
  });

  it("parses --trust-proxy and defaults it off, also in fleet mode", () => {
    expect(parseCli(["--target", "fleet"]).trustProxy).toBe(false);
    expect(parseCli(["--target", "fleet", "--trust-proxy"]).trustProxy).toBe(true);
  });

  it("binds loopback when trusting a proxy", async () => {
    const { core } = makeCore({ mode: "fleet", convexUrl: "https://convex.example", trustProxy: true });
    server = await startHttpServer(core, 0);
    expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
  });

  it("binds every interface when not trusting a proxy, even in fleet mode", async () => {
    const { core } = makeCore({ mode: "fleet", convexUrl: "https://convex.example" });
    server = await startHttpServer(core, 0);
    expect((server.address() as AddressInfo).address).toBe("::");
  });
});
