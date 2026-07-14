import { describe, it, expect } from "vitest";
import { MultiAuditSink, StderrAuditSink, type AuditSink } from "../../src/audit/sink.js";
import type { AuditEvent } from "../../src/audit/event.js";

class FlakySink implements AuditSink {
  recorded = 0;
  constructor(private up: boolean) {}
  async record(_e: AuditEvent): Promise<void> {
    this.recorded++;
  }
  healthy(): boolean {
    return this.up;
  }
  setHealthy(v: boolean): void {
    this.up = v;
  }
}

function ev(): AuditEvent {
  return {
    tsUs: 1,
    tokenId: "t",
    operatorId: "o",
    tool: "status.get",
    args: {},
    node: "n",
    decision: "allowed",
    result: "ok",
    latencyMs: 1,
    mcpSession: "s",
    plane: "lan_direct",
  };
}

describe("MultiAuditSink", () => {
  it("is healthy only when EVERY sink is healthy (durable-sink guarantee)", () => {
    const durable = new FlakySink(true);
    const multi = new MultiAuditSink([new StderrAuditSink(), durable]);
    expect(multi.healthy()).toBe(true);
    // stderr is always healthy; a down durable sink must flip the aggregate.
    durable.setHealthy(false);
    expect(multi.healthy()).toBe(false);
  });

  it("fans a record out to every sink", async () => {
    const a = new FlakySink(true);
    const b = new FlakySink(true);
    const multi = new MultiAuditSink([a, b]);
    await multi.record(ev());
    expect(a.recorded).toBe(1);
    expect(b.recorded).toBe(1);
  });

  it("an empty set is vacuously healthy", () => {
    expect(new MultiAuditSink([]).healthy()).toBe(true);
  });
});
