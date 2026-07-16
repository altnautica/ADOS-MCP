import { describe, it, expect } from "vitest";
import {
  parseAuditQuery,
  matchesAuditQuery,
  type AuditEventLike,
} from "../../src/audit/search-grammar.js";

const ev = (over: Partial<AuditEventLike> = {}): AuditEventLike => ({
  tool: "params.set",
  node: "skynodepi",
  operatorId: "cloud:usr_1",
  decision: "denied",
  result: "scope_denied",
  ...over,
});

describe("parseAuditQuery", () => {
  it("splits field-qualified terms from free text", () => {
    const q = parseAuditQuery("tool:params.set DENIED node:sky");
    expect(q.fields).toEqual([
      { field: "tool", value: "params.set" },
      { field: "node", value: "sky" },
    ]);
    expect(q.terms).toEqual(["denied"]);
  });

  it("treats an unknown field prefix and a valueless colon as free text", () => {
    const q = parseAuditQuery("bogus:x tool: plain");
    expect(q.fields).toEqual([]);
    expect(q.terms).toEqual(["bogus:x", "tool:", "plain"]);
  });
});

describe("matchesAuditQuery", () => {
  it("ANDs field filters (case-insensitive substring)", () => {
    expect(matchesAuditQuery(ev(), parseAuditQuery("tool:params decision:denied"))).toBe(true);
    expect(matchesAuditQuery(ev(), parseAuditQuery("tool:params decision:allowed"))).toBe(false);
    expect(matchesAuditQuery(ev(), parseAuditQuery("operator:usr_1"))).toBe(true);
  });

  it("requires every free-text term to match somewhere", () => {
    expect(matchesAuditQuery(ev(), parseAuditQuery("scope_denied"))).toBe(true);
    expect(matchesAuditQuery(ev(), parseAuditQuery("scope_denied skynodepi"))).toBe(true);
    expect(matchesAuditQuery(ev(), parseAuditQuery("scope_denied nope"))).toBe(false);
  });

  it("combines a field filter with free text", () => {
    expect(matchesAuditQuery(ev(), parseAuditQuery("tool:params.set scope_denied"))).toBe(true);
    expect(matchesAuditQuery(ev(), parseAuditQuery("tool:flight.arm scope_denied"))).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(matchesAuditQuery(ev(), parseAuditQuery(""))).toBe(true);
  });
});
