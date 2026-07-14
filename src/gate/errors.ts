// Structured error taxonomy. Gate denials and platform failures surface as
// typed errors with a stable reason code, an ADOS numeric code, and a
// JSON-RPC-friendly shape. Never a silent pass, never a bare 500.

export type ErrorReason =
  | "unauthorized"
  | "token_invalid"
  | "token_expired"
  | "token_revoked"
  | "source_ip_denied"
  | "scope_missing"
  | "capability_missing"
  | "confirm_required"
  | "operator_present_stale"
  | "precondition_failed"
  | "path_out_of_scope"
  | "secret_read_required"
  | "rate_limited"
  | "cloud_unavailable"
  | "fleet_mode_only"
  | "agent_mode_only"
  | "node_required"
  | "node_not_allowed"
  | "unknown_tool"
  | "no_route_capability"
  | "ws_proxy_enforce_off"
  | "rest_down"
  | "fc_unreachable"
  | "not_supported"
  | "invalid_arguments";

// ADOS numeric codes, aligned with the tools catalog.
export const ADOS_CODE: Partial<Record<ErrorReason, number>> = {
  unauthorized: 4010,
  token_invalid: 4011,
  token_expired: 4012,
  token_revoked: 4013,
  source_ip_denied: 4014,
  scope_missing: 4030,
  capability_missing: 4030,
  no_route_capability: 4030,
  path_out_of_scope: 4031,
  secret_read_required: 4032,
  confirm_required: 4281,
  operator_present_stale: 4030,
  precondition_failed: 4030,
  ws_proxy_enforce_off: 4030,
  rate_limited: 4290,
  cloud_unavailable: 4090,
  fleet_mode_only: 4091,
  agent_mode_only: 4092,
  node_required: 4400,
  node_not_allowed: 4403,
  unknown_tool: 4404,
  invalid_arguments: 4422,
  rest_down: 5031,
  fc_unreachable: 5032,
  not_supported: 5010,
};

export class GateError extends Error {
  readonly reason: ErrorReason;
  readonly adosCode: number;
  readonly detail?: Record<string, unknown>;

  constructor(reason: ErrorReason, message?: string, detail?: Record<string, unknown>) {
    super(message ?? reason);
    this.name = "GateError";
    this.reason = reason;
    this.adosCode = ADOS_CODE[reason] ?? 4000;
    this.detail = detail;
  }

  /** Is this an authentication failure (maps to HTTP 401)? */
  isAuth(): boolean {
    return (
      this.reason === "unauthorized" ||
      this.reason === "token_invalid" ||
      this.reason === "token_expired" ||
      this.reason === "token_revoked" ||
      this.reason === "source_ip_denied"
    );
  }
}
