import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAuditSink, queryAuditFile } from "../../src/audit/file-sink.js";
import type { AuditEvent } from "../../src/audit/event.js";

function ev(over: Partial<AuditEvent>): AuditEvent {
  return {
    tsUs: Date.now() * 1000,
    tokenId: "t",
    operatorId: "o",
    tool: "status.get",
    args: {},
    node: "local",
    decision: "allowed",
    result: "ok",
    latencyMs: 1,
    mcpSession: "s",
    plane: "lan_direct",
    ...over,
  };
}

describe("FileAuditSink", () => {
  it("appends and reads back newest-first with filters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ados-audit-"));
    const path = join(dir, "sub", "audit.ndjson");
    const sink = new FileAuditSink(path);
    await sink.record(ev({ tool: "status.get", decision: "allowed", node: "n1" }));
    await sink.record(ev({ tool: "params.set", decision: "denied", node: "n2" }));
    expect(sink.healthy()).toBe(true);

    const all = await queryAuditFile(path);
    expect(all.length).toBe(2);
    expect(all[0]!.tool).toBe("params.set"); // newest first

    expect((await queryAuditFile(path, { decision: "denied" })).length).toBe(1);
    expect((await queryAuditFile(path, { tool: "status.get" })).length).toBe(1);
    expect((await queryAuditFile(path, { node: "n2" }))[0]!.tool).toBe("params.set");
    expect((await queryAuditFile(path, { limit: 1 })).length).toBe(1);
  });

  it("returns empty for a missing file rather than throwing", async () => {
    expect(await queryAuditFile("/nonexistent/ados/mcp/audit.ndjson")).toEqual([]);
  });
});
