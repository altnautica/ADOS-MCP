import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTransport, readFleetFile } from "../src/config.js";

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
    expect(resolveTransport("auto", "local-fleet", true)).toBe("stdio");
  });

  it("auto (TTY) → stdio for local-fleet (local, not the http fleet default)", () => {
    expect(resolveTransport("auto", "local-fleet", false)).toBe("stdio");
    expect(resolveTransport("auto", "fleet", false)).toBe("http");
  });

  it("auto in an interactive terminal falls back to the mode default", () => {
    // Run by hand as a long-lived service: fleet → http, agent → stdio.
    expect(resolveTransport("auto", "fleet", false)).toBe("http");
    expect(resolveTransport("auto", "agent", false)).toBe("stdio");
  });
});

describe("readFleetFile", () => {
  const dir = mkdtempSync(join(tmpdir(), "ados-fleet-"));
  const write = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it("parses valid nodes and carries name + profile", () => {
    const p = write(
      "ok.json",
      JSON.stringify({
        version: 1,
        nodes: [
          { deviceId: "a", name: "Alpha", host: "http://10.0.0.10:8080", apiKey: "ka", profile: "drone" },
          { deviceId: "b", host: "http://10.0.0.11:8080", apiKey: "kb" },
        ],
      }),
    );
    const nodes = readFleetFile(p);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ deviceId: "a", name: "Alpha", apiKey: "ka", profile: "drone" });
    expect(nodes[1]).toMatchObject({ deviceId: "b", host: "http://10.0.0.11:8080" });
  });

  it("skips malformed entries and de-dupes by deviceId", () => {
    const p = write(
      "mixed.json",
      JSON.stringify({
        nodes: [
          { deviceId: "a", host: "http://10.0.0.10:8080", apiKey: "ka" },
          { deviceId: "a", host: "http://dupe:8080", apiKey: "dupe" }, // duplicate id → dropped
          { deviceId: "no-key", host: "http://10.0.0.12:8080" }, // missing apiKey → dropped
          "not-an-object",
        ],
      }),
    );
    const nodes = readFleetFile(p);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.apiKey).toBe("ka");
  });

  it("throws on a missing file", () => {
    expect(() => readFleetFile(join(dir, "nope.json"))).toThrow(/cannot read/i);
  });

  it("throws when there are no valid nodes (never a silent empty fleet)", () => {
    const p = write("empty.json", JSON.stringify({ nodes: [] }));
    expect(() => readFleetFile(p)).toThrow(/no valid nodes/i);
  });

  it("throws when the nodes array is missing", () => {
    const p = write("bad.json", JSON.stringify({ version: 1 }));
    expect(() => readFleetFile(p)).toThrow(/nodes/i);
  });

  it("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
