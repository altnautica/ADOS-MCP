// The MCP audit event shape and its redaction. One tool call maps to one event.
// The event lands in the platform's durable logging store as a `mcp.tool_call`
// event (wired in the logd sink); the shape here is the producer-side model.

export type AuditDecision = "allowed" | "denied" | "confirmed" | "operator_absent";
export type AuditPlane = "lan_direct" | "cloud_relay" | "on_box";

export interface AuditEvent {
  /** Microseconds since the Unix epoch, stamped when the call completes. */
  tsUs: number;
  /** Token identifier that made the call. Never the raw token. */
  tokenId: string;
  /** Operator the token was minted for. */
  operatorId: string;
  /** Dotted tool name. */
  tool: string;
  /** Redacted tool arguments. */
  args: Record<string, unknown>;
  /** Target node (local in agent-mode; the explicit node in fleet-mode). */
  node: string;
  /** The gate outcome. */
  decision: AuditDecision;
  /** A short result summary or the error class. Never a full payload. */
  result: string;
  /** Wall time from receipt to completion, ms. */
  latencyMs: number;
  /** MCP session id grouping a client's calls. */
  mcpSession: string;
  /** Which data plane carried the call. */
  plane: AuditPlane;
  /** True when a secret value was returned under secret_read. */
  sensitiveRead?: boolean;
  /** True when redaction touched any field. */
  redacted?: boolean;
}

// Keys whose values are treated as secret-bearing and redacted unless the caller
// holds secret_read. Matched case-insensitively as a substring of the key.
const SECRET_KEY_PATTERNS = [
  "password",
  "passwd",
  "secret",
  "api_key",
  "apikey",
  "token",
  "psk",
  "private_key",
  "privatekey",
  "pairing_key",
  "credential",
  "authorization",
  "bearer",
];

export const REDACTION_MARKER = "[REDACTED]";

function keyIsSecret(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Redact secret-shaped values in an arbitrary structure. Returns a new value and
 * whether anything was touched. When `allowSecrets` is true (a secret_read
 * token), values are left intact but the touched flag still reports presence.
 */
export function redact(
  value: unknown,
  allowSecrets = false,
): { value: unknown; redacted: boolean } {
  let touched = false;
  const walk = (v: unknown, keyIsSecretHint = false): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val, keyIsSecret(k));
      }
      return out;
    }
    if (keyIsSecretHint && typeof v === "string" && v.length > 0) {
      touched = true;
      return allowSecrets ? v : REDACTION_MARKER;
    }
    return v;
  };
  const result = walk(value);
  return { value: result, redacted: touched };
}

/** Redact a top-level args map, returning a plain object and the touched flag. */
export function redactArgs(
  args: Record<string, unknown>,
  allowSecrets = false,
): { args: Record<string, unknown>; redacted: boolean } {
  const { value, redacted } = redact(args, allowSecrets);
  return { args: (value as Record<string, unknown>) ?? {}, redacted };
}
