// Optional mDNS auto-discovery for local-fleet mode (--discover). Browses the LAN
// for ADOS agents (_ados._tcp) and, for an UNPAIRED drone not already in the fleet,
// auto-claims a pairing key (LAN presence is the auth boundary while unpaired), so
// the operator's "control all my drones" server adopts new drones hands-free. A
// drone the operator ALREADY paired can't be auto-keyed (the agent returns 409
// "already paired"); its key rides in the embedded fleet instead. Best-effort:
// every failure is logged and skipped, never fatal.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Bonjour } from "bonjour-service";
import { logger } from "../util/logger.js";
import type { FleetNode } from "../config.js";

export interface DiscoveredAgent {
  deviceId: string;
  name?: string;
  profile?: string;
  paired: boolean;
  /** Reachable REST base http://<ip>:<port> built from the advertised address. */
  host: string;
}

/** The subset of a browsed mDNS service record parseAgent reads. */
export interface BrowsedService {
  txt?: Record<string, unknown>;
  addresses?: string[];
  port?: number;
}

/** Parse one browsed service into a DiscoveredAgent, or null if it is not a
 *  reachable ADOS agent (no device id or no IPv4 address). Exported for tests. */
export function parseAgent(svc: BrowsedService): DiscoveredAgent | null {
  const txt = (svc.txt ?? {}) as Record<string, unknown>;
  const deviceId = typeof txt.device_id === "string" ? txt.device_id : "";
  if (!deviceId) return null;
  // The advertised `server` name (ados-<id>.local) is deliberately not resolvable,
  // so reach the agent by its advertised IPv4 address on its REST port.
  const ip = (svc.addresses ?? []).find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
  if (!ip) return null;
  const port = svc.port || 8080;
  const paired = txt.paired === "true" || txt.paired === "1";
  return {
    deviceId,
    ...(typeof txt.name === "string" && txt.name ? { name: txt.name } : {}),
    ...(typeof txt.profile === "string" && txt.profile ? { profile: txt.profile } : {}),
    paired,
    host: `http://${ip}:${port}`,
  };
}

/** Browse `_ados._tcp` for `timeoutMs`, returning the agents found (deduped by id). */
export function browseAgents(timeoutMs = 3000): Promise<DiscoveredAgent[]> {
  return new Promise((resolve) => {
    let bonjour: InstanceType<typeof Bonjour>;
    try {
      bonjour = new Bonjour();
    } catch (err) {
      logger.warn(`mDNS browse unavailable (continuing without discovery): ${String(err)}`);
      resolve([]);
      return;
    }
    const found = new Map<string, DiscoveredAgent>();
    const browser = bonjour.find({ type: "ados", protocol: "tcp" }, (svc) => {
      const a = parseAgent(svc as BrowsedService);
      if (a) found.set(a.deviceId, a);
    });
    setTimeout(() => {
      try {
        browser.stop?.();
        bonjour.destroy();
      } catch {
        /* ignore teardown errors */
      }
      resolve([...found.values()]);
    }, timeoutMs).unref();
  });
}

/** A stable per-machine owner id for auto-claim (persisted; ADOS_MCP_OWNER wins). */
export function ownerId(): string {
  if (process.env.ADOS_MCP_OWNER) return process.env.ADOS_MCP_OWNER;
  const path = join(homedir(), ".ados", "mcp", "owner-id");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* generate below */
  }
  const id = `ados-mcp-${randomUUID()}`;
  try {
    mkdirSync(join(homedir(), ".ados", "mcp"), { recursive: true });
    writeFileSync(path, `${id}\n`, { mode: 0o600 });
  } catch (err) {
    logger.warn(`could not persist owner id (using a session id): ${String(err)}`);
  }
  return id;
}

/** POST /api/pairing/claim on an unpaired agent, returning its fresh api key. */
async function claimAgent(host: string, userId: string, timeoutMs = 8000): Promise<string | null> {
  try {
    const res = await fetch(`${host}/api/pairing/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn(`auto-claim of ${host} refused (${res.status}); skipping`);
      return null;
    }
    const body = (await res.json()) as Record<string, unknown>;
    const key = body.api_key ?? body.apiKey;
    return typeof key === "string" && key ? key : null;
  } catch (err) {
    logger.warn(`auto-claim of ${host} errored (skipping): ${String(err)}`);
    return null;
  }
}

export interface DiscoverOptions {
  /** The fleet already handed over (embedded env / file) — its drones + keys. */
  known: FleetNode[];
  userId: string;
  /** When true, auto-claim + adopt UNPAIRED drones found on the LAN. */
  adoptUnpaired: boolean;
  timeoutMs?: number;
}

/**
 * Browse the LAN and return the NEW FleetNodes to merge with `known`:
 *  - a drone already in `known` (by deviceId) → skip (its key is already handed over)
 *  - an UNPAIRED drone not in `known` → auto-claim a key and adopt it (when opted in)
 *  - a PAIRED drone not in `known` → skip + log (no key to reach it)
 */
/**
 * The pure decision: which discovered agents to auto-adopt (claim). A drone
 * already in the fleet is skipped (its key is handed over); a PAIRED drone not in
 * the fleet is skipped (can't be auto-keyed); an UNPAIRED drone not in the fleet is
 * adopted when opted in. Exported for tests. Logs the paired-skip reason.
 */
export function planAdoptions(
  agents: DiscoveredAgent[],
  known: FleetNode[],
  adoptUnpaired: boolean,
): DiscoveredAgent[] {
  const knownIds = new Set(known.map((n) => n.deviceId));
  const toAdopt: DiscoveredAgent[] = [];
  for (const a of agents) {
    if (knownIds.has(a.deviceId)) continue;
    if (a.paired) {
      logger.info(
        `discovered paired drone ${a.name ?? a.deviceId} not in your fleet — skipping (its key is not on this machine)`,
      );
      continue;
    }
    if (adoptUnpaired) toAdopt.push(a);
  }
  return toAdopt;
}

export async function discoverFleet(opts: DiscoverOptions): Promise<FleetNode[]> {
  const agents = await browseAgents(opts.timeoutMs);
  const additions: FleetNode[] = [];
  for (const a of planAdoptions(agents, opts.known, opts.adoptUnpaired)) {
    const key = await claimAgent(a.host, opts.userId);
    if (key) {
      additions.push({
        deviceId: a.deviceId,
        host: a.host,
        apiKey: key,
        ...(a.name ? { name: a.name } : {}),
        ...(a.profile ? { profile: a.profile } : {}),
      });
      logger.info(`adopted unpaired drone ${a.name ?? a.deviceId} at ${a.host}`);
    }
  }
  return additions;
}
