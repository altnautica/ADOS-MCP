import { describe, it, expect } from "vitest";
import { redact, redactArgs, REDACTION_MARKER } from "../../src/audit/event.js";

describe("redact", () => {
  it("redacts a scalar secret-shaped key", () => {
    const { value, redacted } = redact({ api_key: "s3cr3t", name: "drone" });
    expect(value).toEqual({ api_key: REDACTION_MARKER, name: "drone" });
    expect(redacted).toBe(true);
  });

  it("propagates the secret hint into an array under a secret key", () => {
    const { value, redacted } = redact({ api_keys: ["a", "b"], ports: [1, 2] });
    expect(value).toEqual({ api_keys: [REDACTION_MARKER, REDACTION_MARKER], ports: [1, 2] });
    expect(redacted).toBe(true);
  });

  it("propagates the secret hint into a nested object under a secret key", () => {
    const { value } = redact({ credential: { token: "x", note: "keep" }, ok: "visible" });
    expect(value).toEqual({
      credential: { token: REDACTION_MARKER, note: REDACTION_MARKER },
      ok: "visible",
    });
  });

  it("redacts a numeric secret value", () => {
    const { value } = redact({ pairing_key: 12345 });
    expect(value).toEqual({ pairing_key: REDACTION_MARKER });
  });

  it("leaves values intact under secret_read but still flags presence", () => {
    const { value, redacted } = redact({ api_key: "s3cr3t" }, true);
    expect(value).toEqual({ api_key: "s3cr3t" });
    expect(redacted).toBe(true);
  });

  it("does not touch non-secret data", () => {
    const { value, redacted } = redact({ battery: 80, mode: "GUIDED", tags: ["a"] });
    expect(value).toEqual({ battery: 80, mode: "GUIDED", tags: ["a"] });
    expect(redacted).toBe(false);
  });

  it("redactArgs returns a plain object and the touched flag", () => {
    const { args, redacted } = redactArgs({ token: "abc", n: 1 });
    expect(args).toEqual({ token: REDACTION_MARKER, n: 1 });
    expect(redacted).toBe(true);
  });
});
