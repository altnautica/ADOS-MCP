import { describe, it, expect } from "vitest";
import { canonicalJson } from "../../src/auth/canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys at every level and emits no whitespace", () => {
    const value = { b: 1, a: { d: 4, c: 3 }, e: [3, 1, 2] };
    expect(canonicalJson(value)).toBe('{"a":{"c":3,"d":4},"b":1,"e":[3,1,2]}');
  });

  it("is stable across key insertion order", () => {
    const a = canonicalJson({ x: 1, y: 2, z: 3 });
    const b = canonicalJson({ z: 3, y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order (arrays are ordered, not sets)", () => {
    expect(canonicalJson(["c", "a", "b"])).toBe('["c","a","b"]');
  });

  it("drops undefined-valued keys", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("encodes null, booleans, and strings", () => {
    expect(canonicalJson({ a: null, b: true, c: "hi" })).toBe('{"a":null,"b":true,"c":"hi"}');
  });
});
