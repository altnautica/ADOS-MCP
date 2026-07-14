// Shared test helpers: build a server core with a local dev secret and a fake
// plane, and mint local-issuer tokens to exercise the gate.
import { z } from "zod";
import { ServerCore } from "../src/server.js";
import type { ServerConfig } from "../src/config.js";
import { importHmacKey } from "../src/auth/issuers.js";
import { mintToken, type TokenClaims } from "../src/auth/token.js";
import type { ScopeGroup } from "../src/auth/scopes.js";
import type { AuditEvent } from "../src/audit/event.js";
import type { AuditSink } from "../src/audit/sink.js";
import type {
  CommandOutcome,
  CredentialPrincipal,
  FirmwareHint,
  NodeRef,
  NodeStatus,
  NodeSummary,
  ParamEntry,
  PlaneHealth,
  PlaneMode,
  PlatformPlane,
} from "../src/plane/platform-plane.js";

export const TEST_SECRET = new Uint8Array(32).fill(7);

export class FakePlane implements PlatformPlane {
  readonly mode: PlaneMode;
  constructor(mode: PlaneMode = "agent", private readonly status: NodeStatus = { ok: true }) {
    this.mode = mode;
  }
  describe(): { mode: PlaneMode; target: string } {
    return { mode: this.mode, target: "fake" };
  }
  async health(): Promise<PlaneHealth> {
    return { ok: true, target: "fake" };
  }
  async verifyCredential(credential: string): Promise<CredentialPrincipal | null> {
    if (credential === "revoked-cred") return null;
    // A backend that returns a malformed principal (missing scopes) must fail closed.
    if (credential === "malformed-cred") return { userId: "op-fake" } as unknown as CredentialPrincipal;
    // "cred:read,admin" encodes the scopes for a test; default read+safe_write+admin.
    const scopeStr = credential.split(":")[1];
    const scopes = scopeStr ? scopeStr.split(",") : ["read", "safe_write", "admin"];
    return { userId: "op-fake", scopes, allowedNodes: [] };
  }
  async getStatus(_node: NodeRef): Promise<NodeStatus> {
    return this.status;
  }
  async getStatusFull(_node: NodeRef): Promise<NodeStatus> {
    return this.status;
  }
  async getSystem(_node: NodeRef): Promise<NodeStatus> {
    return { cpu: 12, memory: 40, disk: 30, temperature: 45 };
  }
  async getTelemetry(_node: NodeRef): Promise<NodeStatus> {
    return { battery: { remaining: 78 }, mode: "GUIDED", armed: false };
  }
  async getVision(_node: NodeRef): Promise<NodeStatus> {
    return { vision: { model: "none" } };
  }
  async getServices(_node: NodeRef): Promise<NodeStatus> {
    return { services: [{ unit: "ados-supervisor", state: "running" }] };
  }
  async getParams(_node: NodeRef): Promise<ParamEntry[]> {
    return [
      { name: "ATC_RAT_RLL_P", value: 0.135 },
      { name: "FENCE_ENABLE", value: 1 },
    ];
  }
  async getParam(_node: NodeRef, name: string): Promise<ParamEntry | null> {
    return name === "FENCE_ENABLE" ? { name, value: 1 } : null;
  }
  async getConfig(_node: NodeRef): Promise<NodeStatus> {
    return { profile: "drone", api_key: "s3cr3t" };
  }
  async firmwareHint(_node: NodeRef): Promise<FirmwareHint> {
    return { firmware: "ardupilot", vehicleClass: "copter" };
  }
  async listNodes(): Promise<NodeSummary[]> {
    return [{ deviceId: "fake-node", online: true, battery: 78 }];
  }
  async restartService(_node: NodeRef, unit: string): Promise<CommandOutcome> {
    return { ok: true, status: "completed", message: `restarted ${unit}` };
  }
  async restartSupervisor(_node: NodeRef): Promise<CommandOutcome> {
    return { ok: true, status: "completed" };
  }
  async setParam(_node: NodeRef, name: string, value: number): Promise<CommandOutcome> {
    return { ok: true, status: "completed", data: { name, value } };
  }
  async setConfig(_node: NodeRef, key: string, value: string): Promise<CommandOutcome> {
    return { ok: true, status: "completed", data: { key, value } };
  }
  async pluginInstall(_node: NodeRef, url: string): Promise<CommandOutcome> {
    return { ok: true, status: "completed", data: { url } };
  }
  async pluginEnable(_node: NodeRef, id: string): Promise<CommandOutcome> {
    return { ok: true, status: "completed", data: { id, action: "enabled" } };
  }
  async pluginDisable(_node: NodeRef, id: string): Promise<CommandOutcome> {
    return { ok: true, status: "completed", data: { id, action: "disabled" } };
  }
  async pluginRemove(_node: NodeRef, id: string): Promise<CommandOutcome> {
    return { ok: true, status: "completed", data: { id, action: "uninstalled" } };
  }
  async pluginConfig(_node: NodeRef, id: string, key: string, value: unknown): Promise<CommandOutcome> {
    return { ok: true, status: "completed", data: { id, key, value } };
  }
  async getPlugins(_node: NodeRef): Promise<unknown> {
    return [{ pluginId: "demo", enabled: true }];
  }
  async getPluginInfo(_node: NodeRef, id: string): Promise<unknown> {
    return { pluginId: id, enabled: true };
  }
  async queryLogs(_node: NodeRef): Promise<unknown> {
    return { entries: [{ seq: 1, message: "hello" }], total: 1 };
  }
}

export class CapturingAuditSink implements AuditSink {
  readonly events: AuditEvent[] = [];
  private up = true;
  setHealthy(v: boolean): void {
    this.up = v;
  }
  async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
  healthy(): boolean {
    return this.up;
  }
}

export function baseConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    mode: "agent",
    agentHost: "127.0.0.1",
    fleetEndpoint: "https://mcp.example/mcp",
    localDevSecret: TEST_SECRET,
    auditPath: "/tmp/ados-mcp-test-audit.ndjson",
    transports: new Set(["http"]),
    httpPort: 0,
    unixSocketPath: "/tmp/ados-mcp-test.sock",
    flightEnforced: false,
    sim: false,
    mdns: false,
    ...overrides,
  };
}

export function makeCore(
  overrides: Partial<ServerConfig> = {},
): { core: ServerCore; audit: CapturingAuditSink } {
  const audit = new CapturingAuditSink();
  const core = new ServerCore(baseConfig(overrides), {
    plane: new FakePlane(overrides.mode ?? "agent"),
    auditSink: audit,
  });
  return { core, audit };
}

export async function mintLocalToken(claims: Partial<TokenClaims> = {}): Promise<string> {
  const key = await importHmacKey(TEST_SECRET);
  const full: TokenClaims = {
    tokenId: claims.tokenId ?? "tk-test",
    operatorId: claims.operatorId ?? "cloud:usr_test",
    iss: claims.iss ?? "local",
    scopes: claims.scopes ?? (["read"] as ScopeGroup[]),
    allowedNodes: claims.allowedNodes ?? [],
    allowedRoots: claims.allowedRoots ?? [],
    sourceIpCidr: claims.sourceIpCidr ?? [],
    expiresAt: claims.expiresAt ?? Date.now() + 3_600_000,
    operatorPresentRequired: claims.operatorPresentRequired ?? false,
    label: claims.label ?? "test",
  };
  return mintToken(full, key);
}

/** A trivial read tool for gate tests; status.get has a route-capability row. */
export function registerFakeReadTool(core: ServerCore): void {
  core.tools.register({
    name: "status.get",
    description: "fake status read",
    inputSchema: z.object({ node: z.string().optional() }),
    annotations: { readOnlyHint: true },
    handler: async (_args, ctx) => ctx.plane.getStatus(ctx.node),
  });
}

/** A trivial admin write tool for gate tests; admin.node.rename has a row. */
export function registerFakeAdminTool(core: ServerCore): void {
  core.tools.register({
    name: "admin.node.rename",
    description: "fake rename",
    inputSchema: z.object({ name: z.string(), confirm: z.boolean().optional() }),
    handler: async (args) => ({ renamed: args.name }),
  });
}
