import { describe, it, expect } from "vitest";
import {
  DEFAULT_ENABLED_SCOPES,
  SCOPE_CAPABILITIES,
  SCOPE_GROUPS,
  isElevatedScope,
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
