import { describe, it, expect } from "vitest";
import { ServerCore } from "../../src/server.js";
import { ActivityFeedSink, type ActivityFeedEvent } from "../../src/audit/activity-sink.js";
import {
  baseConfig,
  CapturingAuditSink,
  FakePlane,
  mintLocalToken,
  registerFakeReadTool,
  registerFakeAdminTool,
} from "../helpers.js";

/** Captures live-feed events in memory instead of appending to a file. */
class CapturingActivitySink extends ActivityFeedSink {
  readonly events: ActivityFeedEvent[] = [];
  constructor() {
    super("/tmp/ados-mcp-test-activity.ndjson");
  }
  override async emit(event: ActivityFeedEvent): Promise<void> {
    this.events.push(event);
  }
}

function makeCoreWithActivity() {
  const audit = new CapturingAuditSink();
  const activity = new CapturingActivitySink();
  const core = new ServerCore(baseConfig(), {
    plane: new FakePlane("agent"),
    auditSink: audit,
    activitySink: activity,
  });
  return { core, audit, activity };
}

describe("activity feed lifecycle", () => {
  it("emits a started then a done, paired by callId, on a successful call", async () => {
    const { core, activity } = makeCoreWithActivity();
    registerFakeReadTool(core);
    const token = await mintLocalToken({ scopes: ["read"] as never });
    const auth = await core.pipeline.authenticateBearer(token);

    await core.pipeline.callTool("status.get", {}, auth, "sess-1");

    expect(activity.events).toHaveLength(2);
    const [started, done] = activity.events;
    expect(started.phase).toBe("started");
    expect(done.phase).toBe("done");
    expect(started.callId).toBe(done.callId);
    expect(started.tool).toBe("status.get");
    expect(done.decision).toBe("allowed");
    expect(done.mcpSession).toBe("sess-1");
    expect(typeof done.latencyMs).toBe("number");
  });

  it("emits only a done (no started) for a call denied before dispatch", async () => {
    const { core, activity } = makeCoreWithActivity();
    registerFakeAdminTool(core);
    // A read token cannot reach an admin tool; the scope gate denies it before
    // the handler runs, so there is no start marker — just a denied completion.
    const token = await mintLocalToken({ scopes: ["read"] as never });
    const auth = await core.pipeline.authenticateBearer(token);

    await expect(
      core.pipeline.callTool("admin.node.rename", { name: "x" }, auth, "sess-2"),
    ).rejects.toMatchObject({ reason: "scope_missing" });

    const started = activity.events.filter((e) => e.phase === "started");
    const done = activity.events.filter((e) => e.phase === "done");
    expect(started).toHaveLength(0);
    expect(done).toHaveLength(1);
    expect(done[0].decision).toBe("denied");
  });

  it("masks a secret-shaped arg value in the live feed", async () => {
    const { core, activity } = makeCoreWithActivity();
    registerFakeAdminTool(core);
    const token = await mintLocalToken({ scopes: ["read"] as never });
    const auth = await core.pipeline.authenticateBearer(token);
    // Denied, but the started/done still redact a secret-shaped value.
    await core.pipeline
      .callTool("admin.node.rename", { name: "x", api_key: "supersecret" }, auth, "s")
      .catch(() => undefined);
    const done = activity.events.find((e) => e.phase === "done");
    expect(JSON.stringify(done?.args)).not.toContain("supersecret");
  });
});
