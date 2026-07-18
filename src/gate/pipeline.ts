// The gate pipeline: the single chokepoint every tool call passes through.
// Order: token verify + scope, route-to-capability, class-specific safety gate,
// per-tool preconditions, rate limit, audit, dispatch, audit finalize. No
// handler runs without passing it, and every call (allowed or denied) produces
// exactly one audit event.

import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
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
import { logger } from "../util/logger.js";
import type { AuditSink } from "../audit/sink.js";
import type { ActivityFeedSink } from "../audit/activity-sink.js";
import type { AuditDecision, AuditEvent, AuditPlane } from "../audit/event.js";
import { keyIsSecret, redact, redactArgs, semanticWriteArgs, REDACTION_MARKER } from "../audit/event.js";
import type { ToolRegistry } from "../registry/tools.js";
import type { PlatformPlane, PlaneMode } from "../plane/platform-plane.js";
import type { PublicToolInfo, ResourceDefinition, ToolCtx } from "../registry/types.js";
import { parseAdosUri } from "../registry/read-resources.js";

export interface AuthContext {
  claims: TokenClaims;
  plane: AuditPlane;
  onBox: boolean;
  sourceIp?: string;
  /**
   * True when the backend independently gates node ownership (a fleet-mode
   * machine credential). Such a principal's empty `allowedNodes` means "any node
   * the operator owns" — the backend rejects a non-owned node — rather than the
   * fail-closed "no nodes" a self-contained fleet token's empty list means.
   */
  backendGated?: boolean;
}

export interface PipelineConfig {
  planeMode: PlaneMode;
  /** This node's id in agent-mode (the implicit target). */
  nodeId?: string;
  /** The operator machine credential the server was launched with (fleet-mode). */
  credential?: string;
  /** The device ids in the local-fleet file (local-fleet mode). A target must be
   * one of these; the operator owns every node in their own fleet file. */
  localFleetNodes?: string[];
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
  /** Optional best-effort live-feed sink (running -> done). Absent = no feed. */
  activity?: ActivityFeedSink;
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

/** Restarting one of these units mid-flight is flight-critical, so it escalates.
 * Keyed on the canonical `ados-<name>` unit names the agent exposes (the MAVLink
 * router unit is `ados-mavlink-router`). */
// Flight-critical service ROOTS: restarting a unit whose name contains any of
// these while armed can drop the FC link, the orchestrator, or the video pipeline.
// A substring match (rather than an exact allowlist) fails SAFE — an alias the
// agent accepts (mavlink_router, mavlinkrouter, ados-video-relay, …) still
// escalates to the flight gate. Over-escalating a benign unit only costs extra
// auth; under-escalating a critical one is the danger.
const ARMED_CRITICAL_ROOTS = ["mavlink", "supervisor", "video"];

function isArmedCriticalUnit(name: unknown): boolean {
  const u = canonicalUnit(name);
  return ARMED_CRITICAL_ROOTS.some((root) => u.includes(root));
}

/**
 * Canonicalize a service unit name the way the agent does before the armed-
 * critical check, so an alias (`video`), a `.service` suffix, or a case variant
 * can never slip an armed-critical restart past the flight escalation.
 */
function canonicalUnit(name: unknown): string {
  let n = String(name ?? "").trim().toLowerCase();
  if (n.endsWith(".service")) n = n.slice(0, -".service".length);
  // Normalize separators so mavlink_router / mavlink.router / mavlink--router all
  // canonicalize the same way (a separator alias can't dodge the root match).
  n = n.replace(/[_.\s]+/g, "-").replace(/-+/g, "-");
  if (n && !n.startsWith("ados-")) n = `ados-${n}`;
  return n;
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
    // Fleet-mode: the bearer is the opaque operator machine credential (not a
    // dot-delimited HMAC token). It is verified against the backend by the plane.
    if (this.deps.config.planeMode === "fleet" && isMachineCredential(token)) {
      return this.authenticateCredential(token, sourceIp);
    }
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
      // agent + local-fleet are both LAN-direct; only fleet-mode is the cloud relay.
      plane: this.deps.config.planeMode === "fleet" ? "cloud_relay" : "lan_direct",
      onBox: false,
      sourceIp,
    };
  }

  /**
   * Authenticate a fleet-mode machine credential. The presented bearer must equal
   * the credential the server was launched with (so the verified principal and the
   * plane's reach identity are the same operator — no confused deputy), and that
   * credential must still verify live against the backend (catching a revocation).
   */
  private async authenticateCredential(token: string, sourceIp?: string): Promise<AuthContext> {
    const configured = this.deps.config.credential;
    if (!configured || !credentialEqual(token, configured)) {
      throw new GateError("unauthorized", "credential not recognized");
    }
    const principal = await this.deps.plane.verifyCredential(configured);
    // Fail closed on a missing OR malformed principal (a backend that returns an
    // unexpected shape must never resolve to a partial, usable auth context).
    if (
      !principal ||
      typeof principal.userId !== "string" ||
      principal.userId.length === 0 ||
      !Array.isArray(principal.scopes) ||
      !Array.isArray(principal.allowedNodes)
    ) {
      throw new GateError("token_revoked", "credential invalid, revoked, or expired");
    }
    const claims: TokenClaims = {
      tokenId: "mcp-credential",
      operatorId: `cloud:${principal.userId}`,
      iss: `cloud:${principal.userId}`,
      scopes: coerceScopes(principal.scopes),
      allowedNodes: principal.allowedNodes.filter((n): n is string => typeof n === "string"),
      allowedRoots: [],
      sourceIpCidr: [],
      expiresAt: Number.MAX_SAFE_INTEGER, // the backend enforces the credential's expiry
      operatorPresentRequired: false,
      label: "mcp-credential",
    };
    return { claims, plane: "cloud_relay", onBox: false, sourceIp, backendGated: true };
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
    const callId = randomUUID();

    try {
      const def = this.deps.tools.get(name);
      if (!def) throw new GateError("unknown_tool", `no such tool: ${name}`);
      const baseEntry = routeCapFor(name);
      if (!baseEntry) throw new GateError("no_route_capability", `no route cap for ${name}`);

      // A drone-direct-only tool cannot be served over the GCS relay.
      if (baseEntry.agentModeOnly && this.deps.config.planeMode === "fleet") {
        throw new GateError(
          "agent_mode_only",
          `${name} is not available over the GCS relay; reach the drone directly with --target agent <host>`,
        );
      }

      // Fleet-wide tools (fleet enumeration, local audit) target no single node,
      // so they skip the per-node targeting gate that would otherwise reject a
      // node-less call in fleet-mode.
      node = baseEntry.fleetWide ? this.fleetWideNode() : this.resolveNode(args, auth);
      const eff = this.escalate(baseEntry, name, args);

      // Scope check (authoritative). On-box is trusted past the scope gate.
      if (!auth.onBox && !scopeCoversTool(auth.claims.scopes, eff)) {
        throw new GateError("scope_missing", `${name} requires the ${eff.scope} scope`, {
          required: eff.scope,
        });
      }
      // A tool that changes in-flight behavior cannot be invoked while the
      // MAVLink proxy enforce flag is off, whether its class is flight or (like
      // emergency_stop) destructive.
      if ((eff.scope === "flight" || baseEntry.affectsFlight) && !this.deps.config.flightEnforced) {
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
      // Live-feed start marker — the surface a same-machine GCS auto-navigates
      // to once the call completes. Best-effort; never blocks the dispatch.
      this.emitActivity("started", callId, name, args, node, mcpSession, auth.plane);
      const value = await def.handler(parsed.data as Record<string, unknown>, ctx);

      // The handler already ran; an audit-write failure here must not re-label a
      // completed call as denied nor tell the client it failed. Record best-effort
      // and surface the write failure to the operator log.
      // A config.set/plugins.config whose semantic key is secret-shaped carries a
      // secret the client wrote; never persist its value in the audit result.
      const secretKeyWrite =
        (name === "config.set" || name === "plugins.config") &&
        typeof args.key === "string" &&
        keyIsSecret(args.key);
      // The always-redacted copy: the durable audit is never cleartext, and it is
      // what a client WITHOUT secret_read receives.
      const { value: safeResult, redacted: resultRedacted } = redact(value, false);
      const resultHadSecret = resultRedacted || secretKeyWrite;
      const auditResult = secretKeyWrite ? "[redacted write]" : summarize(safeResult);
      // The client return: raw only when the token holds secret_read; otherwise the
      // redacted copy, so a read-only token never receives a secret-shaped value in
      // cleartext. A secret-shaped write echo (the value under a `value` key with the
      // secret name in `key`) is masked for a non-secret_read client too.
      let clientValue: unknown = value;
      if (!allowSecrets) {
        clientValue = safeResult;
        if (secretKeyWrite) clientValue = maskEchoedSecret(clientValue, args.value);
      }
      try {
        await this.writeAudit(
          auth,
          name,
          args,
          node,
          decision,
          auditResult,
          started,
          allowSecrets,
          mcpSession,
          resultHadSecret,
          callId,
        );
      } catch (auditErr) {
        logger.warn("audit write failed after a successful call", {
          tool: name,
          err: String(auditErr),
        });
      }
      return wrapResult(clientValue);
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
        false,
        callId,
      ).catch(() => undefined);
      throw gerr;
    }
  }

  /** Read a resource through the read-scope gate, resolving+auditing like a call. */
  async readResource(
    def: ResourceDefinition,
    uri: string,
    auth: AuthContext,
    mcpSession: string,
  ): Promise<unknown> {
    const started = Date.now();
    const parsed = parseAdosUri(uri);
    let node = this.deps.config.nodeId ?? "local";
    const allowSecrets = auth.claims.scopes.includes("secret_read");
    try {
      if (!auth.onBox && !auth.claims.scopes.includes("read")) {
        throw new GateError("scope_missing", `resource ${uri} requires the read scope`, {
          required: "read",
        });
      }
      node = this.resolveNode({ node: parsed?.node }, auth);
      // Resource reads use their own (higher) budget so polling resources does not
      // drain the tool-call budget and vice-versa.
      const rl = this.deps.rateLimiter.check(auth.claims.tokenId, "resource");
      if (!rl.allowed) {
        throw new GateError("rate_limited", `rate limit exceeded reading ${uri}`, {
          retryAfterMs: rl.retryAfterMs,
        });
      }
      const ctx: ToolCtx = {
        plane: this.deps.plane,
        planeMode: this.deps.config.planeMode,
        node,
        claims: auth.claims,
        sim: this.deps.config.sim,
        secretRead: allowSecrets,
      };
      const value = await def.read(uri, ctx);
      const { value: safeResult, redacted: resultHadSecret } = redact(value, false);
      await this.writeAudit(
        auth,
        `resource:${def.name}`,
        { uri },
        node,
        "allowed",
        summarize(safeResult),
        started,
        allowSecrets,
        mcpSession,
        resultHadSecret,
      ).catch((e) => logger.warn("resource audit failed after a successful read", { uri, err: String(e) }));
      // Raw only for a secret_read token; otherwise the redacted copy.
      return allowSecrets ? value : safeResult;
    } catch (err) {
      const gerr = err instanceof GateError ? err : new GateError("not_supported", String(err));
      await this.writeAudit(
        auth,
        `resource:${def.name}`,
        { uri },
        node,
        "denied",
        `${gerr.reason}: ${gerr.message}`,
        started,
        false,
        mcpSession,
      ).catch(() => undefined);
      throw gerr;
    }
  }

  /** The audit `node` for a fleet-wide tool: the self node in agent-mode, the
   * whole fleet ("*") otherwise. */
  private fleetWideNode(): string {
    return this.deps.config.planeMode === "agent" ? (this.deps.config.nodeId ?? "local") : "*";
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
    // local-fleet: the operator owns every node in their own fleet file, so the
    // target is validated against the file (not a token claim). A single-node
    // fleet needs no explicit node; a multi-node fleet requires one.
    if (this.deps.config.planeMode === "local-fleet") {
      const nodes = this.deps.config.localFleetNodes ?? [];
      if (!requested) {
        if (nodes.length === 1) return nodes[0]!;
        throw new GateError(
          "node_required",
          "specify a node; call fleet.list_nodes to see this server's LAN fleet",
        );
      }
      if (!nodes.includes(requested)) {
        throw new GateError("node_not_allowed", `node '${requested}' is not in the local fleet`);
      }
      return requested;
    }
    // fleet-mode. Targeting is enforced from the verified token claim, never the
    // request body, and it fails CLOSED: an empty allowedNodes does not mean "any
    // node" (that would be a confused-deputy hole); a fleet token must enumerate
    // the nodes it may reach.
    if (!requested) throw new GateError("node_required", "node is required in fleet-mode");
    const allowed = auth.claims.allowedNodes;
    if (allowed.length === 0) {
      // A backend-gated machine credential with no explicit allowlist may target
      // any node the operator owns; the backend rejects a non-owned node. A self-
      // contained fleet token with an empty list fails closed (confused-deputy).
      if (auth.backendGated) return requested;
      throw new GateError(
        "node_not_allowed",
        "token has no allowed nodes; mint it with an explicit node list",
      );
    }
    if (!allowed.includes(requested)) {
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
    if (tool === "config.set" && isNetworkConfigPath(args.key)) {
      return { scope: "admin", capability: "network.outbound", safetyClass: "admin" };
    }
    if (tool === "services.restart" && isArmedCriticalUnit(args.name)) {
      return { scope: "flight", capability: "vehicle.command", safetyClass: "flight" };
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
    resultHadSecret = false,
    callId?: string,
  ): Promise<void> {
    const { args: redacted, redacted: argsTouched } = redactArgs(
      semanticWriteArgs(tool, args),
      allowSecrets,
    );
    // A secret-shaped value was present in either an argument or the result.
    const anyRedaction = argsTouched || resultHadSecret;
    // The flags describe what the CLIENT actually received: `sensitiveRead` when a
    // secret_read token got it raw; `redacted` when a non-secret_read token got a
    // masked value. Exactly one is set on a secret-bearing call, so `redacted:true`
    // is honest — it means the client's value (and the stored args) were masked.
    const disclosedSecret = allowSecrets && anyRedaction;
    const maskedForClient = !allowSecrets && anyRedaction;
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
      ...(disclosedSecret ? { sensitiveRead: true } : {}),
      ...(maskedForClient ? { redacted: true } : {}),
    };
    await this.deps.audit.record(event);
    // Mirror the completion to the best-effort live feed (a `done` paired with
    // its earlier `started` by callId). Never affects the audit-of-record.
    this.emitActivity("done", callId ?? randomUUID(), tool, args, node, mcpSession, auth.plane, {
      decision,
      result,
      latencyMs: event.latencyMs,
    });
  }

  /** Best-effort live-feed emit for the running -> done lane. Masks secret-
   *  shaped args (never allowSecrets) and never throws; absent sink = no-op. */
  private emitActivity(
    phase: "started" | "done",
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    node: string,
    mcpSession: string,
    plane: string,
    extra?: { decision?: AuditDecision; result?: string; latencyMs?: number },
  ): void {
    if (!this.deps.activity) return;
    const { args: redacted } = redactArgs(semanticWriteArgs(tool, args), false);
    void this.deps.activity.emit({
      tsUs: Date.now() * 1000,
      phase,
      callId,
      tool,
      args: redacted,
      node,
      mcpSession,
      plane,
      ...(extra ?? {}),
    });
  }
}

/** An opaque machine credential (fleet-mode) vs a dot-delimited HMAC token. */
function isMachineCredential(token: string): boolean {
  return token.startsWith("ados_mc_") || !token.includes(".");
}

/** Constant-time compare of two credentials (hash to a fixed length first). */
function credentialEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Keep only the strings that name a real scope group; drop anything unknown. */
function coerceScopes(scopes: string[]): ScopeGroup[] {
  const valid = new Set<string>(SCOPE_GROUPS);
  return scopes.filter((s): s is ScopeGroup => valid.has(s));
}

/**
 * Mask a secret the client just wrote when the agent echoes it back under a
 * non-secret-shaped key (e.g. `{ data: { key: "network.psk", value: "s3cr3t" } }`),
 * which plain key-based redaction misses. Deep-replaces any string equal to the
 * written secret with the redaction marker. A no-op when there is no secret value.
 */
function maskEchoedSecret(value: unknown, secretVal: unknown): unknown {
  if (typeof secretVal !== "string" || secretVal.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v === secretVal ? REDACTION_MARKER : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
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
