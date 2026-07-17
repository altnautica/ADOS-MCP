// Resolve the runtime configuration from CLI args, environment, and (agent-mode)
// the on-box pairing file. Holds the transport selection, the auth backends, and
// the plane targets. No secret is embedded; the agent verify key derives from the
// pairing key at request time, the local dev secret comes from the environment.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliArgs } from "./cli.js";
import { fromBase64Url, utf8 } from "./util/base64.js";
import { logger } from "./util/logger.js";
import type { PlaneMode } from "./plane/platform-plane.js";

export const DEFAULT_HTTP_PORT = 8091;
export const DEFAULT_FLEET_ENDPOINT = "https://mcp.altnautica.com/mcp";

// The Convex backend URLs the --gcs convenience resolves to. `local` targets a
// self-hosted dev Convex; `prod` the production Mission Control backend.
const GCS_LOCAL_CONVEX = "http://127.0.0.1:3210";
const GCS_PROD_CONVEX = "https://convex.altnautica.com";

/** Resolve the --gcs convenience (local|prod|<url>) to a Convex url. */
export function resolveGcsUrl(gcs: string | undefined): string | undefined {
  if (!gcs) return undefined;
  if (gcs === "local") return GCS_LOCAL_CONVEX;
  if (gcs === "prod") return GCS_PROD_CONVEX;
  return gcs; // a literal Convex url
}

/** The default local audit file (the MCP server runs on the operator's machine). */
export function defaultAuditPath(): string {
  return process.env.ADOS_MCP_AUDIT_PATH ?? join(homedir(), ".ados", "mcp", "audit.ndjson");
}

function runDir(): string {
  return process.env.ADOS_RUN_DIR ?? "/run/ados";
}

export function defaultUnixSocketPath(): string {
  return `${runDir()}/mcp.sock`;
}

function pairingPath(): string {
  return process.env.ADOS_PAIRING_PATH ?? "/etc/ados/pairing.json";
}

/** The default local-fleet file: the operator exports it from the GCS MCP tab. */
export function defaultFleetPath(): string {
  return process.env.ADOS_MCP_FLEET_PATH ?? join(homedir(), ".ados", "mcp", "fleet.json");
}

/** One LAN drone in the local-fleet file: reachable host + its own pairing key. */
export interface FleetNode {
  deviceId: string;
  name?: string;
  /** Reachable base (e.g. http://drone.local:8080); LanDirectPlane normalizes it. */
  host: string;
  /** This node's pairing api key, sent as X-ADOS-Key. */
  apiKey: string;
  profile?: string;
}

/**
 * Validate a parsed `{ version, nodes: [...] }` fleet document into FleetNode[].
 * Each node needs a deviceId, host, and apiKey; malformed entries are skipped and
 * an empty result throws (a fleet with no reachable nodes is a config error, not a
 * silent empty fleet). `source` names the origin in error messages.
 */
export function parseFleetNodes(parsed: unknown, source: string): FleetNode[] {
  const nodesRaw =
    parsed && typeof parsed === "object" ? (parsed as { nodes?: unknown }).nodes : undefined;
  if (!Array.isArray(nodesRaw)) {
    throw new Error(`${source} must have a "nodes" array`);
  }
  const nodes: FleetNode[] = [];
  const seen = new Set<string>();
  for (const n of nodesRaw) {
    if (!n || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    if (
      typeof o.deviceId === "string" &&
      typeof o.host === "string" &&
      typeof o.apiKey === "string" &&
      o.deviceId &&
      o.host &&
      o.apiKey &&
      !seen.has(o.deviceId)
    ) {
      seen.add(o.deviceId);
      nodes.push({
        deviceId: o.deviceId,
        host: o.host,
        apiKey: o.apiKey,
        ...(typeof o.name === "string" ? { name: o.name } : {}),
        ...(typeof o.profile === "string" ? { profile: o.profile } : {}),
      });
    }
  }
  if (nodes.length === 0) {
    throw new Error(`${source} has no valid nodes (each needs deviceId, host, apiKey)`);
  }
  return nodes;
}

/**
 * Read + validate the local-fleet FILE `{ version, nodes: [...] }`. Warns when the
 * file is group/world-readable — it holds pairing keys.
 */
export function readFleetFile(path: string): FleetNode[] {
  let raw: string;
  try {
    const st = statSync(path);
    if ((st.mode & 0o077) !== 0) {
      logger.warn(
        `fleet file ${path} is group/world-readable; it holds pairing keys — restrict it (chmod 600)`,
      );
    }
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read local-fleet file at ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`local-fleet file at ${path} is not valid JSON`);
  }
  return parseFleetNodes(parsed, `local-fleet file at ${path}`);
}

/**
 * Read the local-fleet INLINE from the `ADOS_MCP_FLEET` env — a base64 of the same
 * `{ version, nodes: [...] }` JSON the file holds. This is the "control all my
 * drones with one command, no file" hand-off: the GCS wizard bakes the whole fleet
 * (each drone's host + pairing key) into the client's launch env, exactly as the
 * single-drone recipe bakes one key into `ADOS_MCP_AGENT_KEY`.
 */
export function readFleetFromEnv(b64: string): FleetNode[] {
  let json: string;
  try {
    json = Buffer.from(b64, "base64").toString("utf8");
  } catch (err) {
    throw new Error(`ADOS_MCP_FLEET is not valid base64: ${(err as Error).message}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("ADOS_MCP_FLEET does not decode to valid JSON");
  }
  return parseFleetNodes(parsed, "ADOS_MCP_FLEET");
}

function revokedListPath(): string {
  return process.env.ADOS_MCP_REVOKED_PATH ?? "/etc/ados/mcp/revoked.json";
}

export interface ServerConfig {
  mode: PlaneMode;
  nodeId?: string;
  // agent-mode
  agentHost: string;
  agentApiKey?: string;
  pairingKey?: string;
  revocationSalt?: Uint8Array;
  // local-fleet mode (many LAN drones, no cloud)
  fleetFilePath?: string;
  fleetNodes?: FleetNode[];
  /** local-fleet: browse the LAN and auto-adopt UNPAIRED drones (opt-in). */
  discover: boolean;
  // fleet-mode (the GCS-interface pathway)
  convexUrl?: string;
  /** The operator machine credential that reaches the GCS backend (fleet-mode). */
  credential?: string;
  mqttUrl?: string;
  fleetEndpoint: string;
  // auth
  localDevSecret?: Uint8Array;
  revokedListPath?: string;
  launchToken?: string;
  // audit (local file on the operator's machine)
  auditPath: string;
  // transports
  transports: Set<"stdio" | "http" | "unix">;
  httpPort: number;
  unixSocketPath: string;
  // gate
  flightEnforced: boolean;
  sim: boolean;
  // discovery
  mdns: boolean;
  mdnsHostname?: string;
  lanIp?: string;
}

interface Pairing {
  paired?: boolean;
  api_key?: string;
}

/** Read the on-box pairing file. Missing/malformed reads as unpaired (no key). */
export function readPairing(path = pairingPath()): { apiKey?: string } {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Pairing;
    if (parsed.paired && typeof parsed.api_key === "string" && parsed.api_key.length > 0) {
      return { apiKey: parsed.api_key };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.debug(`pairing file unreadable at ${path}: ${String(err)}`);
    }
  }
  return {};
}

function resolveLocalDevSecret(): Uint8Array | undefined {
  const env = process.env.ADOS_MCP_LOCAL_SECRET;
  if (!env) return undefined;
  // Accept base64url or raw utf8; both are valid ways to hand in a dev secret.
  try {
    if (/^[A-Za-z0-9_-]+={0,2}$/.test(env) && env.length >= 16) return fromBase64Url(env);
  } catch {
    /* fall through to utf8 */
  }
  return utf8(env);
}

/**
 * Resolve the effective transport. When `requested` is `auto`: an MCP client
 * (Claude Code, Cursor, …) launches the server with `claude mcp add … -- <cmd>`
 * and speaks the protocol over the child's stdio, piping its stdin — so a
 * non-TTY stdin (`isSubprocess`) means "spawned by a client" and we use stdio,
 * regardless of mode. This makes the common `--target fleet` one-liner work over
 * stdio with no `--transport stdio` needed (the previous default sent fleet-mode
 * to http, which an `mcp add -- …` stdio client could never talk to). When stdin
 * IS a TTY — run by hand as a long-lived service — fall back to the mode default:
 * http for fleet, stdio for agent. An explicit `--transport` always wins.
 */
export function resolveTransport(
  requested: "auto" | "stdio" | "http" | "unix",
  mode: PlaneMode,
  isSubprocess: boolean,
): "stdio" | "http" | "unix" {
  if (requested !== "auto") return requested;
  if (isSubprocess) return "stdio";
  return mode === "fleet" ? "http" : "stdio";
}

export function resolveConfig(args: CliArgs): ServerConfig {
  const mode: PlaneMode = args.target;

  // `process.stdin.isTTY` is truthy only for an interactive terminal; a client
  // that spawns us over a pipe leaves it undefined (→ isSubprocess true).
  const resolvedTransport = resolveTransport(args.transport, mode, !process.stdin.isTTY);
  const transports = new Set<"stdio" | "http" | "unix">();
  if (resolvedTransport === "stdio") transports.add("stdio");
  else if (resolvedTransport === "http") {
    transports.add("http");
    if (mode === "agent" || mode === "local-fleet") transports.add("unix");
  } else if (resolvedTransport === "unix") transports.add("unix");

  const pairing = mode === "agent" ? readPairing() : {};

  // local-fleet: the operator-exported fleet (each node carries its own pairing
  // key). Prefer it INLINE from the ADOS_MCP_FLEET env (the "control all my drones
  // in one command, no file" hand-off the GCS wizard bakes into the launch env);
  // else read the fleet FILE (positional after `--target local-fleet`, --fleet-file,
  // or the default under ~/.ados/mcp/).
  let fleetFilePath: string | undefined;
  let fleetNodes: FleetNode[] | undefined;
  if (mode === "local-fleet") {
    const inline = process.env.ADOS_MCP_FLEET;
    if (inline) {
      fleetNodes = readFleetFromEnv(inline);
    } else {
      fleetFilePath = args.fleetFile ?? process.env.ADOS_MCP_FLEET_PATH ?? defaultFleetPath();
      fleetNodes = readFleetFile(fleetFilePath);
    }
  }

  const launchToken = args.token ?? process.env.ADOS_MCP_TOKEN;

  return {
    mode,
    nodeId: args.nodeId ?? process.env.ADOS_NODE_ID,
    agentHost: args.host ?? process.env.ADOS_AGENT_HOST ?? "127.0.0.1",
    ...(fleetFilePath ? { fleetFilePath } : {}),
    ...(fleetNodes ? { fleetNodes } : {}),
    agentApiKey: pairing.apiKey ?? process.env.ADOS_MCP_AGENT_KEY,
    pairingKey: pairing.apiKey ?? process.env.ADOS_MCP_PAIRING_KEY,
    convexUrl: resolveGcsUrl(args.gcs) ?? args.convexUrl ?? process.env.ADOS_CONVEX_URL,
    mqttUrl: args.mqttUrl ?? process.env.ADOS_MQTT_URL,
    fleetEndpoint: args.fleetEndpoint ?? process.env.ADOS_MCP_FLEET_ENDPOINT ?? DEFAULT_FLEET_ENDPOINT,
    localDevSecret: resolveLocalDevSecret(),
    revokedListPath: revokedListPath(),
    auditPath: args.auditPath ?? defaultAuditPath(),
    ...(launchToken ? { launchToken } : {}),
    // In fleet-mode the launch token IS the operator machine credential.
    ...(launchToken && mode === "fleet" ? { credential: launchToken } : {}),
    transports,
    httpPort: args.httpPort ?? (Number(process.env.ADOS_MCP_HTTP_PORT) || DEFAULT_HTTP_PORT),
    unixSocketPath: defaultUnixSocketPath(),
    flightEnforced: args.flightEnforced,
    sim: args.sim,
    mdns: args.mdns && mode === "agent",
    discover: (args.discover || process.env.ADOS_MCP_DISCOVER === "1") && mode === "local-fleet",
    mdnsHostname: process.env.ADOS_MDNS_HOSTNAME,
    lanIp: process.env.ADOS_LAN_IP,
  };
}
