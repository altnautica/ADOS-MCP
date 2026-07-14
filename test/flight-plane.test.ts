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
