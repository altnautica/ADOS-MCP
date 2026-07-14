// The server core: assembles the pipeline and registries into an MCP Server, and
// threads the per-request auth context through AsyncLocalStorage so the same
// handler code serves the HTTP, stdio, and Unix-socket transports. A fresh MCP
// Server is produced per session; they share the pipeline and registries.

import { AsyncLocalStorage } from "node:async_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { GatePipeline, type AuthContext, type PipelineConfig } from "./gate/pipeline.js";
import { GateError } from "./gate/errors.js";
import { RateLimiter } from "./gate/rate-limit.js";
import { SafetyGate, type OperatorPresence, type SignedConfirm } from "./gate/safety.js";
import { ToolRegistry } from "./registry/tools.js";
import { ResourceRegistry } from "./registry/resources.js";
import { PromptRegistry } from "./registry/prompts.js";
import { makeResolver, type SecretResolver } from "./auth/issuers.js";
import { DenylistRevocation, NO_REVOCATION, type RevocationSource } from "./auth/revocation.js";
import { StderrAuditSink, MultiAuditSink, type AuditSink } from "./audit/sink.js";
import { LanDirectPlane } from "./plane/lan-direct.js";
import { CloudRelayPlane } from "./plane/cloud-relay.js";
import type { PlaneHealth, PlatformPlane } from "./plane/platform-plane.js";
import type { ServerConfig } from "./config.js";
import { MCP_SPEC_REVISION, SERVER_NAME, SERVER_VERSION } from "./version.js";
import { logger } from "./util/logger.js";

interface AlsStore {
  auth: AuthContext;
  mcpSession: string;
}

export interface ServerCoreOptions {
  /** Override the plane (tests inject a fake plane). */
  plane?: PlatformPlane;
  /** Override the audit sink (tests inject a capturing sink). */
  auditSink?: AuditSink;
  /** Override the secret resolver (tests inject a local resolver). */
  resolver?: SecretResolver;
  /** Extra audit sinks fanned in alongside the default stderr sink. */
  extraAuditSinks?: AuditSink[];
  operatorPresent?: OperatorPresence;
  signedConfirm?: SignedConfirm;
}

export class ServerCore {
  readonly tools = new ToolRegistry();
  readonly resources = new ResourceRegistry();
  readonly prompts = new PromptRegistry();
  readonly pipeline: GatePipeline;
  readonly plane: PlatformPlane;
  readonly audit: AuditSink;
  private readonly als = new AsyncLocalStorage<AlsStore>();
  private fixedPrincipal: AuthContext | null = null;
  private cachedPlaneHealth: PlaneHealth | null = null;
  private lastHealthProbe = 0;

  constructor(
    readonly config: ServerConfig,
    opts: ServerCoreOptions = {},
  ) {
    this.plane =
      opts.plane ??
      (config.mode === "agent"
        ? new LanDirectPlane({
            host: config.agentHost,
            ...(config.agentApiKey ? { apiKey: config.agentApiKey } : {}),
          })
        : new CloudRelayPlane({
            ...(config.convexUrl ? { convexUrl: config.convexUrl } : {}),
            ...(config.mqttUrl ? { mqttUrl: config.mqttUrl } : {}),
            endpoint: config.fleetEndpoint,
          }));

    this.audit =
      opts.auditSink ?? new MultiAuditSink([new StderrAuditSink(), ...(opts.extraAuditSinks ?? [])]);

    const resolver = opts.resolver ?? this.buildResolver();
    const revocation: RevocationSource = config.revokedListPath
      ? new DenylistRevocation(config.revokedListPath)
      : NO_REVOCATION;

    const pipelineConfig: PipelineConfig = {
      planeMode: config.mode,
      ...(config.nodeId ? { nodeId: config.nodeId } : {}),
      flightEnforced: config.flightEnforced,
      sim: config.sim,
    };

    this.pipeline = new GatePipeline({
      plane: this.plane,
      tools: this.tools,
      resolver,
      revocation,
      rateLimiter: new RateLimiter(),
      safety: new SafetyGate(),
      audit: this.audit,
      config: pipelineConfig,
      ...(opts.operatorPresent ? { operatorPresent: opts.operatorPresent } : {}),
      ...(opts.signedConfirm ? { signedConfirm: opts.signedConfirm } : {}),
      ...(config.nodeId ? { expectedNodeId: config.nodeId } : {}),
    });
  }

  private buildResolver(): SecretResolver {
    return makeResolver({
      ...(this.config.pairingKey
        ? {
            agent: {
              pairingKey: this.config.pairingKey,
              ...(this.config.revocationSalt ? { revocationSalt: this.config.revocationSalt } : {}),
            },
          }
        : {}),
      ...(this.config.localDevSecret ? { local: this.config.localDevSecret } : {}),
      // The cloud backend is wired with the fleet Convex client in the read plane.
    });
  }

  /** Run a function with the request's auth context bound. */
  runWith<T>(auth: AuthContext, mcpSession: string, fn: () => Promise<T>): Promise<T> {
    return this.als.run({ auth, mcpSession }, fn);
  }

  /** Fixed principal for stdio (resolved once at launch). */
  setFixedPrincipal(auth: AuthContext | null): void {
    this.fixedPrincipal = auth;
  }

  authenticateBearer(token: string, sourceIp?: string): Promise<AuthContext> {
    return this.pipeline.authenticateBearer(token, sourceIp);
  }

  onBoxContext(): AuthContext {
    return this.pipeline.onBoxContext();
  }

  private currentAuth(): AuthContext {
    const store = this.als.getStore();
    if (store?.auth) return store.auth;
    if (this.fixedPrincipal) return this.fixedPrincipal;
    throw new McpError(ErrorCode.InvalidRequest, "unauthorized: no valid token presented");
  }

  info(): {
    name: string;
    version: string;
    mcpRevision: string;
    mode: string;
    target: string;
  } {
    const d = this.plane.describe();
    return {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      mcpRevision: MCP_SPEC_REVISION,
      mode: d.mode,
      target: d.target,
    };
  }

  /**
   * Honest health for /healthz. `ok` is true when the server can serve and audit;
   * `degraded` is true when the bound plane is unreachable (reads that hit it will
   * fail, but the server itself is up). The plane probe is cached briefly so a
   * frequent probe does not hammer the agent.
   */
  async healthz(): Promise<{
    ok: boolean;
    degraded: boolean;
    version: string;
    mcpRevision: string;
    mode: string;
    target: string;
    audit: boolean;
    plane: PlaneHealth;
  }> {
    const now = Date.now();
    if (!this.cachedPlaneHealth || now - this.lastHealthProbe > 5000) {
      this.cachedPlaneHealth = await this.plane.health();
      this.lastHealthProbe = now;
    }
    const auditHealthy = this.audit.healthy();
    const plane = this.cachedPlaneHealth;
    const info = this.info();
    return {
      ok: auditHealthy,
      degraded: !plane.ok,
      version: info.version,
      mcpRevision: info.mcpRevision,
      mode: info.mode,
      target: info.target,
      audit: auditHealthy,
      plane,
    };
  }

  /** Build a fresh MCP Server bound to this core's registries and pipeline. */
  newServer(): Server {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
          logging: {},
        },
        instructions:
          "ADOS MCP: read and control an ADOS drone or fleet. Reads are open within scope; " +
          "writes are scope-gated and audited; flight and destructive actions need explicit scope and confirmation.",
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const auth = this.currentAuth();
      return { tools: this.pipeline.listTools(auth) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
      const auth = this.currentAuth();
      const session = this.als.getStore()?.mcpSession ?? "stdio";
      try {
        const r = await this.pipeline.callTool(
          req.params.name,
          (req.params.arguments as Record<string, unknown> | undefined) ?? {},
          auth,
          session,
        );
        // structuredContent must be a JSON object; a primitive/array result rides
        // only in the text content block.
        const sc = r.structuredContent;
        const structured =
          sc !== undefined && sc !== null && typeof sc === "object" && !Array.isArray(sc)
            ? (sc as { [x: string]: unknown })
            : undefined;
        return {
          content: r.content,
          ...(structured ? { structuredContent: structured } : {}),
        };
      } catch (err) {
        throw toMcpError(err);
      }
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      this.currentAuth();
      return {
        resources: this.resources.fixed().map((r) => ({
          uri: r.uriTemplate,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
      };
    });

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      this.currentAuth();
      return {
        resourceTemplates: this.resources.templates().map((r) => ({
          uriTemplate: r.uriTemplate,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const def = this.resources.match(req.params.uri);
      if (!def) {
        throw new McpError(ErrorCode.InvalidParams, `no such resource: ${req.params.uri}`);
      }
      // The concrete read path (with auth + audit) is wired in the read plane.
      throw new McpError(ErrorCode.InvalidRequest, "resource reads are wired in the read plane");
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      this.currentAuth();
      return {
        prompts: this.prompts.all().map((p) => ({
          name: p.name,
          title: p.title,
          description: p.description,
          arguments: p.arguments,
        })),
      };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const def = this.prompts.get(req.params.name);
      if (!def) throw new McpError(ErrorCode.InvalidParams, `no such prompt: ${req.params.name}`);
      const rendered = def.render((req.params.arguments as Record<string, string>) ?? {});
      return { description: rendered.description, messages: rendered.messages };
    });

    return server;
  }

  async close(): Promise<void> {
    await this.audit.close?.();
    logger.debug("server core closed");
  }
}

/** Map an internal error to an MCP protocol error. */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof GateError) {
    const data = { adosCode: err.adosCode, reason: err.reason, ...(err.detail ?? {}) };
    let code = ErrorCode.InvalidRequest;
    if (err.reason === "unknown_tool") code = ErrorCode.MethodNotFound;
    else if (err.reason === "invalid_arguments") code = ErrorCode.InvalidParams;
    else if (err.reason === "rest_down" || err.reason === "fc_unreachable") code = ErrorCode.InternalError;
    return new McpError(code, err.message, data);
  }
  return new McpError(ErrorCode.InternalError, err instanceof Error ? err.message : String(err));
}
