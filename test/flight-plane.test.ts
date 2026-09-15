import { describe, it, expect } from "vitest";
import { makeCore, mintLocalToken, FakePlane } from "./helpers.js";
import { registerFlightTools } from "../src/registry/flight-tools.js";
import type { ServerCore } from "../src/server.js";

const AUDIT = "/tmp/ados-mcp-flight-test.ndjson";

async function auth(core: ServerCore, scopes: string[]) {
  const token = await mintLocalToken({ scopes: scopes as never });
  return core.pipeline.authenticateBearer(token);
}

describe("flight plane", () => {
  it("hides flight tools unless the flight-enforce affirmation is set", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: false });
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "flight"]);
    expect(core.pipeline.listTools(a).map((t) => t.name)).not.toContain("flight.arm");
  });

  it("shows flight tools to a flight token once enforced", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true });
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "flight"]);
    const names = core.pipeline.listTools(a).map((t) => t.name);
    expect(names).toContain("flight.arm");
    expect(names).toContain("flight.takeoff");
    expect(names).toContain("flight.mode");
  });

  it("never shows flight tools to a token without the flight scope", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true });
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "safe_write", "admin"]);
    const names = core.pipeline.listTools(a).map((t) => t.name);
    for (const t of ["flight.arm", "flight.takeoff", "flight.mode", "flight.land"]) {
      expect(names).not.toContain(t);
    }
  });

  it("rejects a flight call from a non-flight token", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true });
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "admin"]);
    await expect(core.pipeline.callTool("flight.arm", {}, a, "s")).rejects.toMatchObject({
      reason: "scope_missing",
    });
  });

  it("routes an armed flight call to the six-verb command vocabulary (SITL waives the human signal)", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true, sim: true });
    await core.resolveSimTarget();
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "flight"]);
    await core.pipeline.callTool("flight.arm", {}, a, "s");
    expect((core.plane as FakePlane).lastFlight).toEqual({ cmd: "arm", args: [] });
    await core.pipeline.callTool("flight.takeoff", { altitude_m: 25 }, a, "s");
    expect((core.plane as FakePlane).lastFlight).toEqual({ cmd: "takeoff", args: [25] });
    await core.pipeline.callTool("flight.mode", { mode: "GUIDED" }, a, "s");
    expect((core.plane as FakePlane).lastFlight).toEqual({ cmd: "mode", args: ["GUIDED"] });
  });

  it("reports a FC-DENIED command as not accepted (a 200 with a denied ack is not success)", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true, sim: true });
    await core.resolveSimTarget();
    (core.plane as FakePlane).flightAckAccepted = false;
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "flight"]);
    const r = await core.pipeline.callTool("flight.arm", {}, a, "s");
    const body = r.structuredContent as { ok: boolean; accepted: boolean; delivered: boolean; reason?: string };
    expect(body.delivered).toBe(true);
    expect(body.accepted).toBe(false);
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/PreArm/);
  });
});

describe("local principals cannot reach the flight tier without a token", () => {
  it("denies flight.arm to the on-box principal with no token, and audits the denial", async () => {
    const { core, audit } = makeCore({ auditPath: AUDIT, flightEnforced: true });
    registerFlightTools(core.tools);
    const onBox = core.onBoxContext();
    await expect(core.pipeline.callTool("flight.arm", {}, onBox, "s")).rejects.toMatchObject({
      reason: "operator_present_stale",
    });
    expect((core.plane as FakePlane).lastFlight).toBeUndefined();
    expect(audit.events.at(-1)).toMatchObject({
      tool: "flight.arm",
      decision: "operator_absent",
      plane: "on_box",
      operatorId: "on-box:root",
    });
  });

  it("withholds the flight and destructive scopes from the stdio local-presence principal", async () => {
    const { core, audit } = makeCore({ auditPath: AUDIT, flightEnforced: true });
    registerFlightTools(core.tools);
    const local = core.localPresenceContext();
    expect(local.claims.scopes).not.toContain("flight");
    expect(local.claims.scopes).not.toContain("destructive");
    expect(core.pipeline.listTools(local).map((t) => t.name)).not.toContain("flight.arm");
    await expect(core.pipeline.callTool("flight.arm", {}, local, "s")).rejects.toMatchObject({
      reason: "scope_missing",
    });
    expect(audit.events.at(-1)).toMatchObject({ tool: "flight.arm", decision: "denied" });
  });
});

describe("the sim waiver is verified against the target, not asserted", () => {
  it("refuses to start when --sim is asserted and the target reports real hardware", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true, sim: true });
    (core.plane as FakePlane).simulated = false;
    await expect(core.resolveSimTarget()).rejects.toThrow(/does not report simulation/);
  });

  it("keeps the flight gate closed when --sim is asserted but unverified", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true, sim: true });
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "flight"]);
    // resolveSimTarget() has not run, so the assertion alone must not waive the
    // human signal the flight class requires.
    await expect(core.pipeline.callTool("flight.arm", {}, a, "s")).rejects.toMatchObject({
      reason: "operator_present_stale",
    });
    expect((core.plane as FakePlane).lastFlight).toBeUndefined();
  });
});
