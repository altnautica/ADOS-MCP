// The gate pipeline: the single chokepoint every tool call passes through.
// Order: token verify + scope, route-to-capability, class-specific safety gate,
// per-tool preconditions, rate limit, audit, dispatch, audit finalize. No
// handler runs without passing it, and every call (allowed or denied) produces
// exactly one audit event.

import { createHash } from "node:crypto";
import { verifyToken, type TokenClaims } from "../auth/token.js";
import { classifyIssuer, type SecretResolver } from "../auth/issuers.js";
import { routeCapFor, type RouteCapEntry } from "../auth/route-capability.js";
import { SCOPE_GROUPS, type SafetyClass, type ScopeGroup } from "../auth/scopes.js";
import type { RevocationSource } from "../auth/revocation.js";
import { scopeCoversTool } from "./scope-check.js";
import { GateError } from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import {
  SafetyGate,
  type OperatorPresence,
  type SignedConfirm,
  NO_OPERATOR_PRESENT,
  NO_SIGNED_CONFIRM,
} from "./safety.js";
import { canonicalJson } from "../auth/canonical.js";
import { sourceIpAllowed } from "../util/cidr.js";
import type { AuditSink } from "../audit/sink.js";
import type { AuditDecision, AuditEvent, AuditPlane } from "../audit/event.js";
import { redactArgs } from "../audit/event.js";
import type { ToolRegistry } from "../registry/tools.js";
import type { PlatformPlane, PlaneMode } from "../plane/platform-plane.js";
import type { PublicToolInfo, ToolCtx } from "../registry/types.js";

export interface AuthContext {
  claims: TokenClaims;
  plane: AuditPlane;
  onBox: boolean;
  sourceIp?: string;
}

export interface PipelineConfig {
  planeMode: PlaneMode;
  /** This node's id in agent-mode (the implicit target). */
  nodeId?: string;
  /** True once the raw MAVLink proxy enforce flag is confirmed on. */
  flightEnforced: boolean;
  /** True when the bound target runs in simulation (SITL). */
  sim: boolean;
}

export interface PipelineDeps {
  plane: PlatformPlane;
  tools: ToolRegistry;
  resolver: SecretResolver;
  revocation: RevocationSource;
  rateLimiter: RateLimiter;
  safety: SafetyGate;
  audit: AuditSink;
  config: PipelineConfig;
  operatorPresent?: OperatorPresence;
  signedConfirm?: SignedConfirm;
  /** This device's id, for the agent-issuer subject check. */
  expectedNodeId?: string;
}

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: unknown;
}

/** Flight-critical parameter name patterns; params.set on these rises to flight. */
const FLIGHT_CRITICAL_PARAM = [
  /^FS_/,
  /^ARMING_/,
  /^MOT_/,
  /^SERVO\d*_FUNCTION$/,
  /^EK3_SRC/,
  /^COMPASS_USE/,
  /^BATT.*_ARM/,
];

function isFlightCriticalParam(name: unknown): boolean {
  if (typeof name !== "string") return false;
  return FLIGHT_CRITICAL_PARAM.some((re) => re.test(name));
}

/** config.set on a network path rises to admin. */
function isNetworkConfigPath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  return /(^|\.)(network|wifi|wfb|uplink|modem|ethernet|radio)(\.|$)/i.test(path);
}

export class GatePipeline {
  private readonly operatorPresent: OperatorPresence;
  private readonly signedConfirm: SignedConfirm;

  constructor(private readonly deps: PipelineDeps) {
    this.operatorPresent = deps.operatorPresent ?? NO_OPERATOR_PRESENT;
    this.signedConfirm = deps.signedConfirm ?? NO_SIGNED_CONFIRM;
  }

  /** Verify a bearer token into an auth context. Throws GateError on any failure. */
  async authenticateBearer(token: string, sourceIp?: string): Promise<AuthContext> {
    let claims: TokenClaims;
    try {
      claims = await verifyToken(token, this.deps.resolver, {
        expectedNodeId: this.deps.expectedNodeId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/expired/i.test(msg)) throw new GateError("token_expired", msg);
      throw new GateError("token_invalid", msg);
    }
    if (this.deps.revocation.isRevoked(claims.tokenId)) {
      throw new GateError("token_revoked", `token ${claims.tokenId} is revoked`);
    }
    if (!sourceIpAllowed(claims.sourceIpCidr, sourceIp)) {
      throw new GateError("source_ip_denied", `source ${sourceIp} not in token pin`);
    }
    // Sanity-check the issuer parses (classifyIssuer throws on unknown families).
    classifyIssuer(claims.iss);
    return {
      claims,
      plane: this.deps.config.planeMode === "agent" ? "lan_direct" : "cloud_relay",
      onBox: false,
      sourceIp,
    };
  }

  /** A synthetic on-box principal: local presence is the credential, full scope. */
  onBoxContext(osUser = "root"): AuthContext {
    const claims: TokenClaims = {
      tokenId: "on-box",
      operatorId: `on-box:${osUser}`,
      iss: "local",
      scopes: [...SCOPE_GROUPS],
      allowedNodes: [],
      allowedRoots: ["/"],
      sourceIpCidr: [],
      expiresAt: Number.MAX_SAFE_INTEGER,
      operatorPresentRequired: false,
      label: "on-box",
    };
    return { claims, plane: "on_box", onBox: true };
  }

  /** tools/list filtered to what this token may invoke. */
  listTools(auth: AuthContext): PublicToolInfo[] {
    return this.deps.tools.listFor({
      claims: auth.claims,
      flightEnforced: this.deps.config.flightEnforced,
      fleetMode: this.deps.config.planeMode === "fleet",
    });
  }

  /** Run a tool call through the whole gate, dispatch it, and audit it. */
  async callTool(
    name: string,
    rawArgs: Record<string, unknown> | undefined,
    auth: AuthContext,
    mcpSession: string,
  ): Promise<ToolCallResult> {
    const started = Date.now();
    const args = rawArgs ?? {};
    let node = this.deps.config.nodeId ?? "local";
    let decision: AuditDecision = "allowed";
    const allowSecrets = auth.claims.scopes.includes("secret_read");

    try {
      const def = this.deps.tools.get(name);
      if (!def) throw new GateError("unknown_tool", `no such tool: ${name}`);
      const baseEntry = routeCapFor(name);
      if (!baseEntry) throw new GateError("no_route_capability", `no route cap for ${name}`);

      node = this.resolveNode(args, auth);
      const eff = this.escalate(baseEntry, name, args);

      // Scope check (authoritative). On-box is trusted past the scope gate.
      if (!auth.onBox && !scopeCoversTool(auth.claims.scopes, eff)) {
        throw new GateError("scope_missing", `${name} requires the ${eff.scope} scope`, {
          required: eff.scope,
        });
      }
      // A flight tool cannot be invoked while the enforce flag is off.
      if (eff.scope === "flight" && !this.deps.config.flightEnforced) {
        throw new GateError("ws_proxy_enforce_off", `${name} is disabled until MAVLink auth is enforced`);
      }

      // Class-specific safety gate. On-box is trusted past confirm/present.
      const argsHash = createHash("sha256").update(canonicalJson(args)).digest("hex");
      if (!auth.onBox) {
        const sd = this.deps.safety.evaluate({
          tool: name,
          node,
          safetyClass: eff.safetyClass,
          args,
          argsHash,
          sim: this.deps.config.sim,
          operatorPresent: this.operatorPresent,
          signedConfirm: this.signedConfirm,
        });
        decision = sd.decision;
      }

      // Rate limit (per token bucket).
      const rl = this.deps.rateLimiter.check(auth.claims.tokenId, "tool");
      if (!rl.allowed) {
        throw new GateError("rate_limited", `rate limit exceeded for ${name}`, {
          retryAfterMs: rl.retryAfterMs,
        });
      }

      // A write refuses rather than act un-audited.
      const isWrite = eff.safetyClass !== "read";
      if (isWrite && !this.deps.audit.healthy()) {
        throw new GateError("not_supported", "audit store unavailable; write refused");
      }

      // Schema validation.
      const parsed = def.inputSchema.safeParse(args);
      if (!parsed.success) {
        throw new GateError("invalid_arguments", `invalid arguments for ${name}`, {
          issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
        });
      }

      // Dispatch.
      const ctx: ToolCtx = {
        plane: this.deps.plane,
        planeMode: this.deps.config.planeMode,
        node,
        claims: auth.claims,
        sim: this.deps.config.sim,
        secretRead: allowSecrets,
      };
      const value = await def.handler(parsed.data as Record<string, unknown>, ctx);

      await this.writeAudit(auth, name, args, node, decision, summarize(value), started, allowSecrets, mcpSession);
      return wrapResult(value);
    } catch (err) {
      const gerr = err instanceof GateError ? err : new GateError("not_supported", String(err));
      const auditDecision: AuditDecision =
        gerr.reason === "operator_present_stale" ? "operator_absent" : "denied";
      await this.writeAudit(
        auth,
        name,
        args,
        node,
        auditDecision,
        `${gerr.reason}: ${gerr.message}`,
        started,
        allowSecrets,
        mcpSession,
      ).catch(() => undefined);
      throw gerr;
    }
  }

  private resolveNode(args: Record<string, unknown>, auth: AuthContext): string {
    const requested = typeof args.node === "string" ? args.node : undefined;
    if (this.deps.config.planeMode === "agent") {
      const self = this.deps.config.nodeId ?? "local";
      if (requested && requested !== self && requested !== "local") {
        throw new GateError("node_not_allowed", `agent-mode targets ${self}, not ${requested}`);
      }
      return self;
    }
    // fleet-mode
    if (!requested) throw new GateError("node_required", `${"node"} is required in fleet-mode`);
    const allowed = auth.claims.allowedNodes;
    if (allowed.length > 0 && !allowed.includes(requested)) {
      throw new GateError("node_not_allowed", `token may not target ${requested}`);
    }
    return requested;
  }

  private escalate(entry: RouteCapEntry, tool: string, args: Record<string, unknown>): {
    scope: ScopeGroup;
    capability: string;
    safetyClass: SafetyClass;
  } {
    if (!entry.escalates) {
      return { scope: entry.scope, capability: entry.capability, safetyClass: entry.safetyClass };
    }
    if (tool === "params.set" && isFlightCriticalParam(args.name)) {
      return { scope: "flight", capability: "mavlink.write", safetyClass: "flight" };
    }
    if (tool === "config.set" && isNetworkConfigPath(args.path)) {
      return { scope: "admin", capability: "network.outbound", safetyClass: "admin" };
    }
    return { scope: entry.scope, capability: entry.capability, safetyClass: entry.safetyClass };
  }

  private async writeAudit(
    auth: AuthContext,
    tool: string,
    args: Record<string, unknown>,
    node: string,
    decision: AuditDecision,
    result: string,
    started: number,
    allowSecrets: boolean,
    mcpSession: string,
  ): Promise<void> {
    const { args: redacted, redacted: touched } = redactArgs(args, allowSecrets);
    const event: AuditEvent = {
      tsUs: Date.now() * 1000,
      tokenId: auth.claims.tokenId,
      operatorId: auth.claims.operatorId,
      tool,
      args: redacted,
      node,
      decision,
      result,
      latencyMs: Date.now() - started,
      mcpSession,
      plane: auth.plane,
      ...(allowSecrets && touched ? { sensitiveRead: true } : {}),
      ...(touched ? { redacted: true } : {}),
    };
    await this.deps.audit.record(event);
  }
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return "ok";
  if (typeof value === "string") return value.slice(0, 200);
  try {
    const s = JSON.stringify(value);
    return s.length > 200 ? `${s.slice(0, 197)}...` : s;
  } catch {
    return "ok";
  }
}

function wrapResult(value: unknown): ToolCallResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: value === undefined ? undefined : (value as unknown),
  };
}
