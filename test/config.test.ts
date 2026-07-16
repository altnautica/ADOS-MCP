import { describe, it, expect } from "vitest";
import { resolveTransport } from "../src/config.js";

describe("resolveTransport", () => {
  it("honours an explicit transport regardless of mode or launch context", () => {
    for (const mode of ["fleet", "agent"] as const) {
      for (const sub of [true, false]) {
        expect(resolveTransport("stdio", mode, sub)).toBe("stdio");
        expect(resolveTransport("http", mode, sub)).toBe("http");
        expect(resolveTransport("unix", mode, sub)).toBe("unix");
      }
    }
  });

  it("auto → stdio when spawned by an MCP client (piped stdin), any mode", () => {
    // The common `claude mcp add ados -- node dist/index.js --target fleet` case:
    // spawned over a pipe → stdio, so the client can actually talk to it.
    expect(resolveTransport("auto", "fleet", true)).toBe("stdio");
    expect(resolveTransport("auto", "agent", true)).toBe("stdio");
  });

  it("auto in an interactive terminal falls back to the mode default", () => {
    // Run by hand as a long-lived service: fleet → http, agent → stdio.
    expect(resolveTransport("auto", "fleet", false)).toBe("http");
    expect(resolveTransport("auto", "agent", false)).toBe("stdio");
  });
});
