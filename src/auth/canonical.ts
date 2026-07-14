// Canonical JSON serialization for the token claims blob.
//
// The signed bytes are the canonical JSON of the claims: object keys sorted
// lexicographically at every level, no whitespace, UTF-8. Arrays keep their
// element order (an array is ordered data, not a set). This is the exact shape
// the minting side signs; the verifier hashes the received blob bytes rather
// than re-serializing, so canonical form only has to be deterministic on the
// mint side and identical between the two implementations.

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("canonical JSON cannot encode a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (t === "boolean" || t === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => serialize(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map((k) => JSON.stringify(k) + ":" + serialize(obj[k]));
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`canonical JSON cannot encode a value of type ${t}`);
}
