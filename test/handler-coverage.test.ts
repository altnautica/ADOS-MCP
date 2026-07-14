/**
 * Handler-coverage guard. Every tool with a route-capability row must have a
 * REGISTERED handler, unless it is an explicitly-documented forward-seam (a row
 * reserved for a phase not yet built). Without this, a route row can sit orphaned
 * — advertised nowhere, callable nowhere — and CI stays green. This test is the
 * tripwire: add a route row and you must either register its handler or add it to
 * FORWARD_SEAMS with a reason.
 *
 * @license GPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../src/registry/tools.js";
import { registerReadTools } from "../src/registry/read-tools.js";
import { registerAdminTools } from "../src/registry/admin-tools.js";
import { ROUTE_CAPABILITY_TABLE } from "../src/auth/route-capability.js";

// Route rows reserved for a phase not yet built. Each MUST carry a reason so a
// reviewer sees why it is unregistered rather than a silent orphan.
const FORWARD_SEAMS: Record<string, string> = {
  // P4 — flight/mission plane
  "flight.arm": "P4 flight plane",
  "flight.disarm": "P4 flight plane",
  "flight.takeoff": "P4 flight plane",
  "flight.land": "P4 flight plane",
  "flight.rtl": "P4 flight plane",
  "flight.mode": "P4 flight plane",
  "flight.goto": "P4 flight plane",
  "flight.emergency_stop": "P4 flight plane",
  "mission.read": "P4 mission plane",
  "mission.download": "P4 mission plane",
  "mission.upload": "P4 mission plane",
  "mission.clear": "P4 mission plane",
  // agent-update has no LAN/HTTP endpoint (`ados update` is CLI/on-box only)
  "admin.agent.update": "pending an agent OTA/update endpoint (update is CLI/on-box only)",
  // Later phases / deferred reads + writes
  "status.diagnostics": "deferred read",
  "status.time": "deferred read",
  "telemetry.subscribe": "streaming phase",
  "params.reset_all": "destructive; later phase",
  "vision.detector_get": "vision write phase",
  "vision.detector_set": "vision write phase",
  "vision.designate": "vision write phase",
  "video.live_url": "video phase",
  "video.snapshot": "video phase",
  "files.list": "files phase",
  "files.read": "files phase",
  "files.write": "files phase",
  "fleet.search": "fleet phase",
  "fleet.target": "fleet phase",
  "logs.tail": "streaming logs phase",
  "logs.aggregate": "logs phase",
  "system.reboot": "destructive system phase",
  "system.shutdown": "destructive system phase",
  "system.factory_reset": "destructive system phase",
};

describe("handler coverage", () => {
  const reg = new ToolRegistry();
  registerReadTools(reg, "/tmp/ados-mcp-test-audit.ndjson");
  registerAdminTools(reg);
  const registered = new Set(reg.names());

  it("every route-capability row is registered or an explicit forward-seam", () => {
    const orphans = ROUTE_CAPABILITY_TABLE.map((r) => r.tool)
      .filter((tool) => !registered.has(tool) && !(tool in FORWARD_SEAMS));
    expect(orphans, `orphaned route rows (register a handler or add to FORWARD_SEAMS): ${orphans.join(", ")}`).toEqual([]);
  });

  it("no forward-seam is actually registered (stale allowlist guard)", () => {
    const stale = Object.keys(FORWARD_SEAMS).filter((tool) => registered.has(tool));
    expect(stale, `these are registered but still marked forward-seam — remove them from FORWARD_SEAMS: ${stale.join(", ")}`).toEqual([]);
  });
});
