import { describe, it, expect } from "vitest";
import { makeCore, mintLocalToken, FakePlane } from "./helpers.js";
import { registerReadTools } from "../src/registry/read-tools.js";
import { registerFlightTools } from "../src/registry/flight-tools.js";
import { routeCapFor } from "../src/auth/route-capability.js";
import type { ServerCore } from "../src/server.js";

const AUDIT = "/tmp/ados-mcp-vision-nav-test.ndjson";

async function auth(core: ServerCore, scopes: string[]) {
  const token = await mintLocalToken({ scopes: scopes as never });
  return core.pipeline.authenticateBearer(token);
}

describe("vision and nav tools", () => {
  it("reads detections and the nav status with a read token", async () => {
    const { core } = makeCore({ auditPath: AUDIT });
    registerReadTools(core.tools, AUDIT);
    const a = await auth(core, ["read"]);
    const det = await core.pipeline.callTool("vision.detections", {}, a, "s");
    expect(det.structuredContent).toHaveProperty("batches");
    const nav = await core.pipeline.callTool("nav.status", {}, a, "s");
    expect(nav.structuredContent).toMatchObject({ follow: { data: { phase: "following" } }, pose: null });
  });

  it("classes the reads as read and designate as a drone-direct flight tool", () => {
    expect(routeCapFor("vision.detections")).toMatchObject({ scope: "read", agentModeOnly: true });
    expect(routeCapFor("nav.status")).toMatchObject({ scope: "read", agentModeOnly: true });
    expect(routeCapFor("vision.designate")).toMatchObject({
      scope: "flight",
      affectsFlight: true,
      agentModeOnly: true,
    });
  });

  it("refuses designate to a token without the flight scope", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true });
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "safe_write", "admin"]);
    const args = { camera_id: "main", bbox: { x: 0.4, y: 0.3, width: 0.1, height: 0.3 } };
    await expect(core.pipeline.callTool("vision.designate", args, a, "s")).rejects.toMatchObject({
      reason: "scope_missing",
    });
  });

  it("posts the designation through the plane (SITL waives the human signal)", async () => {
    const { core } = makeCore({ auditPath: AUDIT, flightEnforced: true, sim: true });
    await core.resolveSimTarget();
    registerFlightTools(core.tools);
    const a = await auth(core, ["read", "flight"]);
    const bbox = { x: 0.4, y: 0.3, width: 0.1, height: 0.3 };
    const r = await core.pipeline.callTool(
      "vision.designate",
      { camera_id: "main", bbox, class_label: "person" },
      a,
      "s",
    );
    expect((r.structuredContent as { ok: boolean }).ok).toBe(true);
    expect((core.plane as FakePlane).lastDesignate).toEqual({ camera_id: "main", bbox, class_label: "person" });
  });
});
