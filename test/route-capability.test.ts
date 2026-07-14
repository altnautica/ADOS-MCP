import { describe, it, expect } from "vitest";
import {
  ROUTE_CAPABILITY_TABLE,
  routeCapFor,
  knownRouteTools,
} from "../src/auth/route-capability.js";
import { SAFETY_CLASSES, SCOPE_GROUPS } from "../src/auth/scopes.js";

describe("route-to-capability table", () => {
  it("has a valid, unique row for every catalog tool", () => {
    const seen = new Set<string>();
    for (const e of ROUTE_CAPABILITY_TABLE) {
      expect(e.tool.length).toBeGreaterThan(0);
      expect(seen.has(e.tool)).toBe(false);
      seen.add(e.tool);
      expect(SCOPE_GROUPS).toContain(e.scope);
      expect(SAFETY_CLASSES).toContain(e.safetyClass);
      expect(e.capability.length).toBeGreaterThan(0);
    }
  });

  it("routes flight and destructive tools to the right scope", () => {
    expect(routeCapFor("flight.arm")?.scope).toBe("flight");
    expect(routeCapFor("flight.goto")?.scope).toBe("flight");
    expect(routeCapFor("flight.emergency_stop")?.scope).toBe("destructive");
    expect(routeCapFor("system.reboot")?.scope).toBe("destructive");
  });

  it("keeps the read tools in the read scope", () => {
    for (const t of ["status.get", "telemetry.snapshot", "params.read_all", "logs.query", "audit.query"]) {
      expect(routeCapFor(t)?.scope).toBe("read");
    }
  });

  it("exposes the escalating tools as escalates=true", () => {
    expect(routeCapFor("params.set")?.escalates).toBe(true);
    expect(routeCapFor("config.set")?.escalates).toBe(true);
    expect(routeCapFor("services.restart")?.escalates).toBe(true);
  });

  it("knownRouteTools returns the whole catalog", () => {
    const known = knownRouteTools();
    expect(known.has("status.get")).toBe(true);
    expect(known.size).toBe(ROUTE_CAPABILITY_TABLE.length);
  });
});
