// Resolve the runtime configuration from CLI args, environment, and (agent-mode)
// the on-box pairing file. Holds the transport selection, the auth backends, and
// the plane targets. No secret is embedded; the agent verify key derives from the
// pairing key at request time, the local dev secret comes from the environment.

import { readFileSync } from "node:fs";
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

export function resolveConfig(args: CliArgs): ServerConfig {
  const mode: PlaneMode = args.target;

  const resolvedTransport =
    args.transport === "auto" ? (mode === "fleet" ? "http" : "stdio") : args.transport;
  const transports = new Set<"stdio" | "http" | "unix">();
  if (resolvedTransport === "stdio") transports.add("stdio");
  else if (resolvedTransport === "http") {
    transports.add("http");
    if (mode === "agent") transports.add("unix");
  } else if (resolvedTransport === "unix") transports.add("unix");

  const pairing = mode === "agent" ? readPairing() : {};

  const launchToken = args.token ?? process.env.ADOS_MCP_TOKEN;

  return {
    mode,
    nodeId: args.nodeId ?? process.env.ADOS_NODE_ID,
    agentHost: args.host ?? process.env.ADOS_AGENT_HOST ?? "127.0.0.1",
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
    mdnsHostname: process.env.ADOS_MDNS_HOSTNAME,
    lanIp: process.env.ADOS_LAN_IP,
  };
}
