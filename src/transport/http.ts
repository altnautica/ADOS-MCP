// The Streamable HTTP transport: a single /mcp endpoint (POST for JSON-RPC, GET
// for the SSE stream, DELETE to terminate a session) plus a /healthz probe. Each
// request's bearer token is verified before the request reaches the transport,
// and the resolved auth context is bound in AsyncLocalStorage so the handlers
// see it. The same listener backs the on-box Unix socket, where presence is the
// credential and no bearer is required.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ServerCore } from "../server.js";
import { GateError } from "../gate/errors.js";
import { logger } from "../util/logger.js";
import type { AuthContext } from "../gate/pipeline.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_HEADER = "mcp-session-id";

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
}

export interface HttpListenerOptions {
  /** True for the on-box Unix socket: presence is the credential, no bearer. */
  onBox: boolean;
}

/** Build an HTTP request listener that speaks Streamable MCP + /healthz. */
export function createMcpHttpListener(
  core: ServerCore,
  opts: HttpListenerOptions,
): http.RequestListener {
  const sessions = new Map<string, Session>();

  return (req, res) => {
    void handle(req, res).catch((err) => {
      logger.error("http handler crashed", { err: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      const info = core.info();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: info.version, mcpRevision: info.mcpRevision, mode: info.mode }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    // Resolve the request principal before touching the transport.
    let auth: AuthContext;
    try {
      auth = await resolveAuth(core, req, opts.onBox);
    } catch (err) {
      const gerr = err instanceof GateError ? err : new GateError("unauthorized", String(err));
      res.writeHead(gerr.isAuth() ? 401 : 403, {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer realm="ados-mcp", error="${gerr.reason}"`,
      });
      res.end(JSON.stringify({ error: gerr.reason, message: gerr.message }));
      return;
    }

    const sessionId = header(req, SESSION_HEADER);
    const body = req.method === "POST" ? await readJsonBody(req, res) : undefined;
    if (body === BODY_ERROR) return; // response already sent

    let session: Session | undefined = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
      if (req.method === "POST" && body !== undefined && isInitializeRequest(body)) {
        session = createSession(core, sessions);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no valid session; send initialize first" }));
        return;
      }
    }

    const activeSessionId = session.transport.sessionId ?? sessionId ?? "pending";
    await core.runWith(auth, activeSessionId, () =>
      session.transport.handleRequest(req, res, body),
    );
  }
}

function createSession(core: ServerCore, sessions: Map<string, Session>): Session {
  const server = core.newServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  void server.connect(transport);
  return { transport, server };
}

async function resolveAuth(
  core: ServerCore,
  req: http.IncomingMessage,
  onBox: boolean,
): Promise<AuthContext> {
  if (onBox) return core.onBoxContext();
  const authz = header(req, "authorization");
  const bearer = authz && /^Bearer\s+(.+)$/i.exec(authz)?.[1];
  if (!bearer) throw new GateError("unauthorized", "missing Authorization: Bearer <token>");
  const sourceIp = normalizeIp(req.socket.remoteAddress);
  return core.authenticateBearer(bearer, sourceIp);
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function normalizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

const BODY_ERROR = Symbol("body-error");

async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<unknown | typeof BODY_ERROR | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      return BODY_ERROR;
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return BODY_ERROR;
  }
}

export function startHttpServer(core: ServerCore, port: number, host = "::"): Promise<http.Server> {
  const server = http.createServer(createMcpHttpListener(core, { onBox: false }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      logger.info(`streamable HTTP listening on ${host}:${port}/mcp`);
      resolve(server);
    });
  });
}

export function startUnixServer(core: ServerCore, socketPath: string): Promise<http.Server> {
  const server = http.createServer(createMcpHttpListener(core, { onBox: true }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      logger.info(`on-box MCP socket listening at ${socketPath}`);
      resolve(server);
    });
  });
}
