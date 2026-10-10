// The Streamable HTTP transport: a single /mcp endpoint (POST for JSON-RPC, GET
// for the SSE stream, DELETE to terminate a session) plus a /healthz probe that
// reports real state. Each request's bearer token is verified before the request
// reaches the transport, and the resolved auth context is bound in
// AsyncLocalStorage so the handlers see it. The same listener backs the on-box
// Unix socket, where presence is the credential and no bearer is required.

import http from "node:http";
import fs from "node:fs";
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
const MAX_SESSIONS = 512;
const SESSION_IDLE_MS = 10 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastActivity: number;
}

export interface HttpListenerOptions {
  /** True for the on-box Unix socket: presence is the credential, no bearer. */
  onBox: boolean;
  /**
   * True only when the operator passed `--trust-proxy`: the listener sits behind
   * a trusted reverse proxy and binds loopback. The real client address is then
   * read from the forwarded headers, so a token's source-IP pin is enforced
   * against the client, not the proxy's loopback peer.
   */
  trustProxy: boolean;
}

/** Build an HTTP request listener that speaks Streamable MCP + /healthz. */
export function createMcpHttpListener(
  core: ServerCore,
  opts: HttpListenerOptions,
): http.RequestListener {
  const sessions = new Map<string, Session>();

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.lastActivity > SESSION_IDLE_MS) {
        sessions.delete(sid);
        try {
          s.transport.close();
        } catch {
          /* already closing */
        }
      }
    }
  }, REAP_INTERVAL_MS);
  reaper.unref?.();

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
      const h = await core.healthz();
      res.writeHead(h.ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(h));
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
      auth = await resolveAuth(core, req, opts);
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
        evictIfFull(sessions);
        session = createSession(core, sessions);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no valid session; send initialize first" }));
        return;
      }
    }

    session.lastActivity = Date.now();
    const activeSessionId = session.transport.sessionId ?? sessionId ?? "pending";
    await core.runWith(auth, activeSessionId, () =>
      session.transport.handleRequest(req, res, body),
    );
  }
}

/** Evict the least-recently-active session when the map is at capacity. */
function evictIfFull(sessions: Map<string, Session>): void {
  if (sessions.size < MAX_SESSIONS) return;
  let oldestId: string | undefined;
  let oldest = Number.POSITIVE_INFINITY;
  for (const [sid, s] of sessions) {
    if (s.lastActivity < oldest) {
      oldest = s.lastActivity;
      oldestId = sid;
    }
  }
  if (oldestId) {
    const s = sessions.get(oldestId);
    sessions.delete(oldestId);
    try {
      s?.transport.close();
    } catch {
      /* already closing */
    }
    logger.warn("session map at capacity; evicted the least-recently-active session");
  }
}

function createSession(core: ServerCore, sessions: Map<string, Session>): Session {
  const server = core.newServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid) => {
      sessions.set(sid, { transport, server, lastActivity: Date.now() });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  void server.connect(transport);
  return { transport, server, lastActivity: Date.now() };
}

async function resolveAuth(
  core: ServerCore,
  req: http.IncomingMessage,
  opts: HttpListenerOptions,
): Promise<AuthContext> {
  if (opts.onBox) return core.onBoxContext();
  const authz = header(req, "authorization");
  const bearer = authz && /^Bearer\s+(.+)$/i.exec(authz)?.[1];
  if (!bearer) throw new GateError("unauthorized", "missing Authorization: Bearer <token>");
  const sourceIp = resolveSourceIp(req, opts.trustProxy);
  return core.authenticateBearer(bearer, sourceIp);
}

/**
 * The caller's source IP. Without proxy trust it is the socket peer, so a
 * forwarded header cannot spoof it. Behind a trusted proxy it is Cloudflare's
 * `cf-connecting-ip`, else the right-most `x-forwarded-for` hop (the one the
 * proxy itself appended; earlier hops are client-controlled).
 */
export function resolveSourceIp(req: http.IncomingMessage, trustProxy: boolean): string | undefined {
  if (!trustProxy) return normalizeIp(req.socket.remoteAddress);
  const cf = header(req, "cf-connecting-ip")?.trim();
  if (cf) return normalizeIp(cf);
  const xff = header(req, "x-forwarded-for");
  if (xff) {
    const hops = xff.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
    const last = hops[hops.length - 1];
    if (last) return normalizeIp(last);
  }
  return normalizeIp(req.socket.remoteAddress);
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

/**
 * Start the network listener. With `--trust-proxy` it binds loopback only (the
 * proxy is the sole reachable peer, so forwarded headers can be believed);
 * otherwise it binds `::` and trusts only the socket peer address.
 */
export function startHttpServer(core: ServerCore, port: number, host?: string): Promise<http.Server> {
  const trustProxy = core.config.trustProxy === true;
  const bindHost = host ?? (trustProxy ? "127.0.0.1" : "::");
  const server = http.createServer(createMcpHttpListener(core, { onBox: false, trustProxy }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindHost, () => {
      logger.info(`streamable HTTP listening on ${bindHost}:${port}/mcp`);
      resolve(server);
    });
  });
}

export function startUnixServer(core: ServerCore, socketPath: string): Promise<http.Server> {
  // Remove a stale socket file left by an unclean shutdown, or listen() fails
  // with EADDRINUSE.
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* absent, which is the normal case */
  }
  const server = http.createServer(createMcpHttpListener(core, { onBox: true, trustProxy: false }));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      // Restrict the socket to the owner and the ados group; presence on it is
      // the privilege boundary, so it must not be world-accessible.
      try {
        fs.chmodSync(socketPath, 0o660);
      } catch (err) {
        logger.warn(`could not chmod the MCP socket at ${socketPath}`, { err: String(err) });
      }
      logger.info(`on-box MCP socket listening at ${socketPath}`);
      resolve(server);
    });
  });
}
