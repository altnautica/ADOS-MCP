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
  NodeRef,
  NodeStatus,
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
  async getStatus(_node: NodeRef): Promise<NodeStatus> {
    return this.status;
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
