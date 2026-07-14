import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace the Convex client with a spy whose action() we control. `vi.hoisted`
// makes the spy available inside the hoisted mock factory.
const { actionSpy } = vi.hoisted(() => ({ actionSpy: vi.fn() }));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    action = actionSpy;
    constructor(_url: string) {}
  },
}));

import { ConvexAuditSink } from "../../src/audit/convex-sink.js";
import type { AuditEvent } from "../../src/audit/event.js";

function ev(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    tsUs: 1000,
    tokenId: "tok",
    operatorId: "op",
    tool: "status.get",
    args: {},
    node: "n1",
    decision: "allowed",
    result: "ok",
    latencyMs: 5,
    mcpSession: "sess",
    plane: "cloud_relay",
    ...over,
  };
}

function sink() {
  return new ConvexAuditSink({
    convexUrl: "https://example.invalid",
    credential: "ados_mc_test",
    flushMs: 100_000, // never fire the timer during a test; we drive flush via close()
    batchSize: 3,
  });
}

describe("ConvexAuditSink", () => {
  beforeEach(() => {
    actionSpy.mockReset();
    actionSpy.mockResolvedValue({ inserted: 1 });
  });

  it("is always healthy so a cloud outage never blocks a write", async () => {
    const s = sink();
    expect(s.healthy()).toBe(true);
    actionSpy.mockRejectedValueOnce(new Error("backend down"));
    await s.record(ev());
    await s.close(); // flushes; the rejection is swallowed
    expect(s.healthy()).toBe(true);
  });

  it("flushes a lean, credential-carrying batch with a stable contentHash", async () => {
    const s = sink();
    await s.record(ev({ tsUs: 111 }));
    await s.close();
    expect(actionSpy).toHaveBeenCalledTimes(1);
    const [, arg] = actionSpy.mock.calls[0] as [unknown, { credential: string; events: Record<string, unknown>[] }];
    expect(arg.credential).toBe("ados_mc_test");
    expect(arg.events).toHaveLength(1);
    const row = arg.events[0];
    // lean projection: no raw args map, but the redaction flag + a hash are carried
    expect(row).not.toHaveProperty("args");
    expect(row).not.toHaveProperty("tokenId"); // the server stamps identity
    expect(row.tool).toBe("status.get");
    expect(typeof row.contentHash).toBe("string");
    expect((row.contentHash as string)).toHaveLength(64);
  });

  it("produces the same contentHash for the same call and a different one otherwise", async () => {
    const s = sink();
    await s.record(ev({ tsUs: 1, tool: "a" }));
    await s.record(ev({ tsUs: 1, tool: "a" })); // identical -> same hash
    await s.record(ev({ tsUs: 2, tool: "a" })); // different tsUs -> different hash
    await s.close();
    const rows = actionSpy.mock.calls.flatMap(
      (c) => (c[1] as { events: { contentHash: string }[] }).events,
    );
    expect(rows[0].contentHash).toBe(rows[1].contentHash);
    expect(rows[0].contentHash).not.toBe(rows[2].contentHash);
  });

  it("auto-flushes when the batch size is reached", async () => {
    const s = sink(); // batchSize 3
    await s.record(ev({ tsUs: 1 }));
    await s.record(ev({ tsUs: 2 }));
    expect(actionSpy).not.toHaveBeenCalled();
    await s.record(ev({ tsUs: 3 })); // reaches 3 -> schedules a flush
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget flush run
    expect(actionSpy).toHaveBeenCalledTimes(1);
    await s.close();
  });

  it("never throws on record, and bounds the queue when the backend is down", async () => {
    actionSpy.mockRejectedValue(new Error("down"));
    const s = new ConvexAuditSink({
      convexUrl: "https://example.invalid",
      credential: "c",
      flushMs: 100_000,
      batchSize: 1_000_000, // never auto-flush; force the queue to fill
      maxQueue: 10,
    });
    for (let i = 0; i < 100; i++) {
      await expect(s.record(ev({ tsUs: i }))).resolves.toBeUndefined();
    }
    await s.close(); // flush attempt rejects, swallowed
    expect(s.healthy()).toBe(true);
  });

  it("drops records after close", async () => {
    const s = sink();
    await s.close();
    await s.record(ev());
    // a second close flushes nothing new
    actionSpy.mockClear();
    await s.close();
    expect(actionSpy).not.toHaveBeenCalled();
  });
});
