// GcsPlane: the GCS-interface adapter. It connects to a Mission Control (GCS)
// Convex backend by URL — LOCAL (a dev / self-hosted Convex) or PROD — and reaches
// the operator's CLOUD-CONNECTED drones through the machine-credential reach
// surface (`cmdMcpReach`). This is the primary pathway: the AI client connects to
// the MCP server; the MCP server is the AI-native interface to Mission Control;
// through it the operator reads and controls their fleet.
//
// AUTH: the operator mints one scoped, revocable, opaque machine credential in
// the Mission Control MCP tab and runs the server with it. That credential is
// passed on every reach call; the backend hashes it, checks it is live, resolves
// the operator, and scopes the reach. The server never holds a browser refresh
// token (rotating, single-consumer; a second consumer logs the operator's browser
// out) and never needs an operator HMAC secret — the backend verifies.
//
// Honest reach limit (a surface reports verified state or none): the relay
// carries a fixed command vocabulary with no synchronous parameter/config read or
// write, so those throw a typed `not_supported` naming the direct reach.

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { GateError } from "../gate/errors.js";
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
} from "./platform-plane.js";
import { firmwareOf, readBatteryPct, vehicleClassOf } from "./lan-direct.js";

export interface GcsPlaneConfig {
  /** The Mission Control Convex deployment URL (local or prod). */
  convexUrl?: string;
  /** The operator machine credential minted in the Mission Control MCP tab. */
  credential?: string;
  /** The MQTT broker URL for live streams (used by later streaming phases). */
  mqttUrl?: string;
  /** A public label for the description, e.g. the hosted endpoint name. */
  endpoint?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

// A heartbeat older than this reads as offline in the fleet list.
const ONLINE_WINDOW_MS = 90_000;
// Cache a credential's verification this long so a burst of sessions re-verifies
// (and picks up a revocation) at most once per window.
const PRINCIPAL_TTL_MS = 60_000;
// Poll the command queue this often, up to this deadline, for the agent's ack.
const RELAY_POLL_MS = 700;
const RELAY_ACK_TIMEOUT_MS = 25_000;

const VERIFY_CREDENTIAL = makeFunctionReference<"action">("cmdMcpReach:verifyCredential");
const LIST_NODES = makeFunctionReference<"action">("cmdMcpReach:listNodes");
const GET_STATUS = makeFunctionReference<"action">("cmdMcpReach:getStatus");
const ENQUEUE = makeFunctionReference<"action">("cmdMcpReach:enqueue");
const GET_COMMAND_STATUS = makeFunctionReference<"action">("cmdMcpReach:getCommandStatus");

interface StatusRow {
  drone?: Record<string, unknown>;
  status?: Record<string, unknown> | null;
}

interface RelayRow {
  status?: string;
  result?: { success?: boolean; message?: string };
  data?: unknown;
}

export class GcsPlane implements PlatformPlane {
  readonly mode: PlaneMode = "fleet";
  private readonly client: ConvexHttpClient | null;
  private readonly credential?: string;
  private principalCache: Map<string, { value: CredentialPrincipal | null; expiry: number }> = new Map();

  constructor(private readonly config: GcsPlaneConfig = {}) {
    this.credential = config.credential;
    this.client = config.convexUrl ? new ConvexHttpClient(config.convexUrl) : null;
  }

  describe(): { mode: PlaneMode; target: string } {
    return { mode: this.mode, target: this.config.endpoint ?? this.config.convexUrl ?? "gcs" };
  }

  async health(): Promise<PlaneHealth> {
    if (!this.client) return { ok: false, detail: "GCS backend not configured (no Convex url)" };
    if (!this.credential) {
      return {
        ok: false,
        detail: "no operator credential; mint one in the Mission Control MCP tab",
        target: this.config.convexUrl,
      };
    }
    const principal = await this.verifyCredential(this.credential).catch(() => null);
    if (!principal) {
      return { ok: false, detail: "credential invalid, revoked, or expired", target: this.config.convexUrl };
    }
    return { ok: true, target: this.config.convexUrl };
  }

  /** Verify a machine credential and cache the principal (picks up revocations). */
  async verifyCredential(credential: string): Promise<CredentialPrincipal | null> {
    if (!this.client) return null;
    const cached = this.principalCache.get(credential);
    if (cached && Date.now() < cached.expiry) return cached.value;
    try {
      const value = await this.action<CredentialPrincipal | null>(VERIFY_CREDENTIAL, { credential });
      // Cache only a DEFINITIVE backend answer: a resolved principal, or a
      // resolved null that means genuinely revoked/expired.
      this.principalCache.set(credential, { value, expiry: Date.now() + PRINCIPAL_TTL_MS });
      return value;
    } catch {
      // A transient failure (timeout / network) is NOT a revocation. Fail closed
      // for this call but do NOT poison the cache, so a recovered backend restores
      // auth on the very next request instead of after the full TTL.
      return null;
    }
  }

  async getStatus(node: NodeRef): Promise<NodeStatus> {
    return this.cloudStatus(node);
  }

  async getStatusFull(node: NodeRef): Promise<NodeStatus> {
    return this.cloudStatus(node);
  }

  async getSystem(node: NodeRef): Promise<NodeStatus> {
    const s = await this.cloudStatus(node);
    return pick(s, ["cpu", "memory", "disk", "temperature", "load", "uptimeSeconds", "cpuUsage"]);
  }

  async getTelemetry(node: NodeRef): Promise<NodeStatus> {
    const s = await this.cloudStatus(node);
    return pick(s, [
      "telemetry",
      "battery",
      "gps",
      "position",
      "attitude",
      "mode",
      "armed",
      "heading",
      "velocity",
      "flightState",
    ]);
  }

  async getVision(node: NodeRef): Promise<NodeStatus> {
    const s = await this.cloudStatus(node);
    return pick(s, ["vision", "perception", "perceptionTier", "perceptionOffloadTarget", "detections"]);
  }

  async getServices(node: NodeRef): Promise<NodeStatus> {
    const s = await this.cloudStatus(node);
    return { services: s.services ?? [] };
  }

  getParams(_node: NodeRef): Promise<ParamEntry[]> {
    return Promise.reject(this.relayReadUnsupported("flight-controller parameters"));
  }

  getParam(_node: NodeRef, _name: string): Promise<ParamEntry | null> {
    return Promise.reject(this.relayReadUnsupported("a flight-controller parameter"));
  }

  getConfig(_node: NodeRef): Promise<NodeStatus> {
    return Promise.reject(this.relayReadUnsupported("the agent configuration"));
  }

  async firmwareHint(node: NodeRef): Promise<FirmwareHint> {
    const s = await this.cloudStatus(node).catch(() => ({}) as NodeStatus);
    const variant = s.fcVariant ?? s.fcFirmware ?? s.firmwareType;
    const type = s.vehicleType ?? s.mavType ?? s.frameClass;
    const version = s.fcFirmwareVersion ?? s.firmwareVersion;
    const vc = vehicleClassOf(type);
    return {
      firmware: firmwareOf(variant),
      ...(vc ? { vehicleClass: vc } : {}),
      ...(typeof version === "string" ? { version } : {}),
    };
  }

  async listNodes(): Promise<NodeSummary[]> {
    const rows = (await this.action<StatusRow[]>(LIST_NODES, { credential: this.requireCredential() })) ?? [];
    const now = Date.now();
    return rows.map((row) => {
      const drone = row.drone ?? {};
      const status = (row.status ?? {}) as Record<string, unknown>;
      const lastSeen = numOr(drone.lastSeen, status.lastSeen);
      return {
        deviceId: String(drone.deviceId ?? status.deviceId ?? ""),
        ...(typeof drone.name === "string" ? { name: drone.name } : {}),
        online: typeof lastSeen === "number" ? now - lastSeen < ONLINE_WINDOW_MS : undefined,
        ...(typeof lastSeen === "number" ? { lastSeen } : {}),
        ...(typeof drone.agentVersion === "string" ? { agentVersion: drone.agentVersion } : {}),
        ...(typeof drone.board === "string" ? { board: drone.board } : {}),
        ...(typeof drone.tier === "string" ? { tier: drone.tier } : {}),
        ...(typeof drone.fcConnected === "boolean" ? { fcConnected: drone.fcConnected } : {}),
        battery: readBatteryPct(status),
        ...(typeof status.mode === "string" ? { mode: status.mode } : {}),
        ...(typeof status.armed === "boolean" ? { armed: status.armed } : {}),
      };
    });
  }

  // --- Admin / ecosystem writes over the relay (enqueue then poll the ack) ---

  restartService(node: NodeRef, unit: string): Promise<CommandOutcome> {
    if (!unit) return Promise.reject(new GateError("invalid_arguments", "service unit name is required"));
    return this.runRelayCommand(node, "restart_service", { name: unit });
  }

  pluginEnable(node: NodeRef, id: string): Promise<CommandOutcome> {
    return this.runRelayCommand(node, "plugin.enable", { pluginId: id });
  }

  pluginDisable(node: NodeRef, id: string): Promise<CommandOutcome> {
    return this.runRelayCommand(node, "plugin.disable", { pluginId: id });
  }

  pluginRemove(node: NodeRef, id: string, keepData?: boolean): Promise<CommandOutcome> {
    if (keepData) return Promise.reject(this.relayWriteUnsupported("a keep-data plugin removal"));
    return this.runRelayCommand(node, "plugin.uninstall", { pluginId: id });
  }

  async queryLogs(node: NodeRef, opts?: { level?: string; limit?: number }): Promise<unknown> {
    const outcome = await this.runRelayCommand(node, "get_logs", {
      ...(opts?.level ? { level: opts.level } : {}),
      limit: opts?.limit ?? 200,
    });
    if (!outcome.ok) throw new GateError("rest_down", outcome.message ?? "get_logs did not complete on the drone");
    return outcome.data ?? { entries: [] };
  }

  restartSupervisor(_node: NodeRef): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("restarting the supervisor"));
  }

  setParam(_node: NodeRef, _name: string, _value: number): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("setting a flight-controller parameter"));
  }

  setConfig(_node: NodeRef, _key: string, _value: string): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("setting an agent configuration value"));
  }

  pluginInstall(_node: NodeRef, _url: string, _sha256?: string): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("installing a plugin"));
  }

  pluginConfig(_node: NodeRef, _id: string, _key: string, _value: unknown, _scope?: string): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("setting a plugin configuration value"));
  }

  getPlugins(_node: NodeRef): Promise<unknown> {
    return Promise.reject(this.relayReadUnsupported("the installed plugin list"));
  }

  getPluginInfo(_node: NodeRef, _id: string): Promise<unknown> {
    return Promise.reject(this.relayReadUnsupported("a plugin's detail"));
  }

  // Node / platform administration is drone-direct only — none of these effects
  // exist in the cloud-relay command vocabulary, so fleet-mode refuses them
  // (they are also agentModeOnly, so a fleet client never sees them in tools/list).
  renameNode(_node: NodeRef, _name: string): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("renaming the node"));
  }
  getPairingInfo(_node: NodeRef): Promise<unknown> {
    return Promise.reject(this.relayReadUnsupported("pairing info"));
  }
  generatePairingCode(_node: NodeRef): Promise<unknown> {
    return Promise.reject(this.relayReadUnsupported("a pairing code"));
  }
  claimPairing(_node: NodeRef, _userId: string): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("claiming a pairing"));
  }
  unpairAgent(_node: NodeRef): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("unpairing the agent"));
  }
  setWfbChannel(_node: NodeRef, _channel: number): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("setting the WFB channel"));
  }
  setWfbTxPower(_node: NodeRef, _powerDbm: number): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("setting the WFB TX power"));
  }
  joinWifi(_node: NodeRef, _ssid: string, _passphrase?: string): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("joining a Wi-Fi network"));
  }
  leaveWifi(_node: NodeRef): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("leaving a Wi-Fi network"));
  }

  private async cloudStatus(node: NodeRef): Promise<NodeStatus> {
    const row = await this.action<Record<string, unknown> | null>(GET_STATUS, {
      credential: this.requireCredential(),
      deviceId: node,
    });
    if (!row) {
      throw new GateError("not_supported", `no cloud status for ${node} (not a cloud-paired drone)`, { node });
    }
    return row;
  }

  /** Enqueue a relay command and poll the ack to a terminal outcome. */
  private async runRelayCommand(
    node: NodeRef,
    command: string,
    args: Record<string, unknown>,
  ): Promise<CommandOutcome> {
    const credential = this.requireCredential();
    const enq = await this.action<{ commandId: string }>(ENQUEUE, { credential, deviceId: node, command, args });
    const commandId = enq.commandId;
    const deadline = Date.now() + RELAY_ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(RELAY_POLL_MS);
      const row = await this.action<RelayRow | null>(GET_COMMAND_STATUS, { credential, commandId });
      if (row && (row.status === "completed" || row.status === "failed")) {
        const ok = row.status === "completed" && row.result?.success !== false;
        return {
          ok,
          status: row.status,
          ...(row.result?.message ? { message: row.result.message } : {}),
          ...(row.data !== undefined ? { data: row.data } : {}),
          commandId,
        };
      }
    }
    return {
      ok: false,
      status: "timeout",
      message: "no ack within the timeout window; the drone may be offline",
      commandId,
    };
  }

  private requireCredential(): string {
    if (!this.credential) {
      throw new GateError("unauthorized", "no operator credential; mint one in the Mission Control MCP tab");
    }
    return this.credential;
  }

  private relayWriteUnsupported(what: string): GateError {
    return new GateError(
      "not_supported",
      `${what} is not available over the GCS relay; reach the drone directly with --target agent <host>`,
    );
  }

  private relayReadUnsupported(what: string): GateError {
    return new GateError(
      "not_supported",
      `${what} is not available over the GCS relay; reach the drone directly with --target agent <host>`,
    );
  }

  private async action<T = unknown>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ref: any,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.client) throw new GateError("not_supported", "GCS backend not configured");
    const timeoutMs = this.config.timeoutMs ?? 15_000;
    return (await withTimeout(this.client.action(ref, args) as Promise<T>, timeoutMs, "GCS action")) as T;
  }
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in source && source[k] !== undefined) out[k] = source[k];
  }
  return out;
}

function numOr(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number") return v;
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GateError("rest_down", `${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
