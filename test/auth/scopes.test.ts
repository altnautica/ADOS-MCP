import { describe, it, expect } from "vitest";
import {
  DEFAULT_ENABLED_SCOPES,
  SCOPE_CAPABILITIES,
  SCOPE_GROUPS,
  capabilityFloorClass,
  grantsAffectFlight,
  impliedFloorForCaps,
  isElevatedScope,
  maxSafetyClass,
  scopesGrantCapability,
  validateScopeRequest,
} from "../../src/auth/scopes.js";

describe("scope model", () => {
  it("expands every group to a non-empty capability list", () => {
    for (const g of SCOPE_GROUPS) {
      expect(SCOPE_CAPABILITIES[g].length).toBeGreaterThan(0);
    }
  });

  it("defaults to read + safe_write + admin, flight/destructive off", () => {
    expect(DEFAULT_ENABLED_SCOPES).toEqual(["read", "safe_write", "admin"]);
    expect(DEFAULT_ENABLED_SCOPES).not.toContain("flight");
    expect(DEFAULT_ENABLED_SCOPES).not.toContain("destructive");
  });

  it("marks flight, destructive, and secret_read as elevated", () => {
    expect(isElevatedScope("flight")).toBe(true);
    expect(isElevatedScope("destructive")).toBe(true);
    expect(isElevatedScope("secret_read")).toBe(true);
    expect(isElevatedScope("read")).toBe(false);
  });

  it("rejects secret_read without read at mint", () => {
    expect(validateScopeRequest(["secret_read"]).ok).toBe(false);
    expect(validateScopeRequest(["read", "secret_read"]).ok).toBe(true);
  });

  it("rejects an unknown scope group", () => {
    // @ts-expect-error deliberately passing an invalid group
    expect(validateScopeRequest(["bogus"]).ok).toBe(false);
  });

  it("maps a granted group to its capabilities", () => {
    expect(scopesGrantCapability(["read"], "telemetry.read")).toBe(true);
    expect(scopesGrantCapability(["read"], "vehicle.command")).toBe(false);
    expect(scopesGrantCapability(["flight"], "vehicle.command")).toBe(true);
  });
});

describe("capability floor classifier (CFIX-1)", () => {
  it("classifies a capability by family, catching non-enumerated MAVLink/flight caps", () => {
    // destructive
    for (const c of ["system.reboot", "system.shutdown", "factory.reset", "ota.install", "params.reset_all", "flight.terminate"]) {
      expect(capabilityFloorClass(c), c).toBe("destructive");
    }
    // flight — includes caps that are NOT listed in SCOPE_CAPABILITIES.flight
    for (const c of ["vehicle.command", "flight.guided_setpoint", "flight.guided_setpoint.send", "mission.write", "mavlink.write", "mavlink.send", "mavlink.tunnel", "mavlink.tunnel.send", "mavlink.component.vio", "mavlink.register_component"]) {
      expect(capabilityFloorClass(c), c).toBe("flight");
    }
    // admin
    for (const c of ["process.spawn", "network.outbound", "config.set.network", "filesystem.host"]) {
      expect(capabilityFloorClass(c), c).toBe("admin");
    }
    // no floor for read/safe_write-class caps + read-only MAVLink
    for (const c of ["telemetry.read", "mavlink.read", "mavlink.subscribe", "config.get", "config.set", "perception.read", "video.snapshot"]) {
      expect(capabilityFloorClass(c), c).toBeNull();
    }
  });

  it("takes the highest implied class across a granted set", () => {
    expect(impliedFloorForCaps(["mcp.expose", "telemetry.read"])).toBeNull();
    expect(impliedFloorForCaps(["config.get", "process.spawn"])).toBe("admin");
    expect(impliedFloorForCaps(["mavlink.send", "process.spawn"])).toBe("flight");
    expect(impliedFloorForCaps(["mavlink.send", "factory.reset"])).toBe("destructive");
  });

  it("flags flight-affecting grants (including a destructive-classed flight.terminate)", () => {
    expect(grantsAffectFlight(["telemetry.read"])).toBe(false);
    expect(grantsAffectFlight(["process.spawn"])).toBe(false);
    expect(grantsAffectFlight(["mavlink.send"])).toBe(true);
    expect(grantsAffectFlight(["flight.terminate"])).toBe(true);
    expect(grantsAffectFlight(["mission.write"])).toBe(true);
  });

  it("maxSafetyClass returns the higher-danger class", () => {
    expect(maxSafetyClass("read", "admin")).toBe("admin");
    expect(maxSafetyClass("flight", "safe_write")).toBe("flight");
    expect(maxSafetyClass("destructive", "flight")).toBe("destructive");
    expect(maxSafetyClass("read", "read")).toBe("read");
  });
});
