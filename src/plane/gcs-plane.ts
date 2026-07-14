// GcsPlane: the GCS-interface adapter. It connects to a Mission Control (GCS)
// Convex backend by URL — LOCAL (a dev / self-hosted Convex) or PROD
// (https://convex.altnautica.com) — authenticates as the operator, and reaches
// the operator's CLOUD-CONNECTED drones through the same auth-gated Convex
// functions the GCS itself calls. This is the primary pathway: the AI client
// connects to the MCP server; the MCP server is the AI-native interface to
// Mission Control; through it the operator reads and controls their fleet.
//
// Honest reach limit (a surface reports verified state or none): Convex holds
// only cloud-paired drones. A LAN-only drone lives in the browser's local store
// and never touches Convex, so it is reached by the drone-direct pathway
// (--target agent <host>), not here. And the relay carries a fixed command
// vocabulary with no synchronous parameter/config read, so those reads throw a
// typed `not_supported` that names the reach which does serve them — never a
// fabricated value.
//
// Operator identity: the MCP server is trusted (the operator runs it on their
// own machine), so it holds an operator session to call the gated reach
// functions. v1 uses the existing GCS auth refresh token: the operator signs in
// once in the Mission Control MCP tab, the setup recipe hands the server a
// refresh token, and the server mints a short-lived JWT from it and refreshes as
// needed. Refresh tokens rotate, so the live token is kept in memory for the
// process lifetime; a restart re-mints from the tab.

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { GateError } from "../gate/errors.js";
import { logger } from "../util/logger.js";
import type {
  CommandOutcome,
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
  /** The operator refresh token minted in the Mission Control MCP tab. */
  refreshToken?: string;
  /** The MQTT broker URL for live streams (used by later streaming phases). */
  mqttUrl?: string;
  /** A public label for the description, e.g. the hosted endpoint name. */
  endpoint?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

/** The operator HMAC secret used to verify `cloud:` MCP tokens. */
export interface OperatorSecret {
  current: Uint8Array;
  previous?: Uint8Array;
}

// A heartbeat older than this reads as offline in the fleet list.
const ONLINE_WINDOW_MS = 90_000;
// Re-mint the JWT this far before its nominal one-hour life.
const JWT_TTL_MS = 50 * 60_000;
// Cache the operator HMAC secret this long so a burst of token verifications
// hits the backend at most once per window (the secret rotates on a ~30-day
// cadence, and the verifier accepts current-or-previous, so a short cache is safe).
const OPERATOR_SECRET_TTL_MS = 60_000;

// Poll the command queue this often, up to this deadline, for the agent's ack.
const RELAY_POLL_MS = 700;
const RELAY_ACK_TIMEOUT_MS = 25_000;

const SIGN_IN = makeFunctionReference<"action">("auth:signIn");
const GET_CLOUD_STATUS = makeFunctionReference<"query">("cmdDroneStatus:getCloudStatus");
const LIST_MY_CLOUD_STATUSES = makeFunctionReference<"query">("cmdDroneStatus:listMyCloudStatuses");
const GET_MY_SECRET = makeFunctionReference<"query">("operatorHmacSecrets:getMyCurrent");
const ENQUEUE_COMMAND = makeFunctionReference<"mutation">("cmdDroneCommands:enqueueCommand");
const GET_COMMAND_STATUS = makeFunctionReference<"query">("cmdDroneCommands:getCommandStatus");

interface RelayRow {
  status?: string;
  result?: { success?: boolean; message?: string };
  data?: unknown;
}

interface StatusRow {
  drone?: Record<string, unknown>;
  status?: Record<string, unknown> | null;
}

export class GcsPlane implements PlatformPlane {
  readonly mode: PlaneMode = "fleet";
  private readonly client: ConvexHttpClient | null;
  private jwt: string | null = null;
  private jwtExpiry = 0;
  private refreshToken?: string;
  private authInFlight: Promise<void> | null = null;
  private secretCache: { value: OperatorSecret; expiry: number } | null = null;

  constructor(private readonly config: GcsPlaneConfig = {}) {
    this.refreshToken = config.refreshToken;
    this.client = config.convexUrl ? new ConvexHttpClient(config.convexUrl) : null;
  }

  describe(): { mode: PlaneMode; target: string } {
    return { mode: this.mode, target: this.config.endpoint ?? this.config.convexUrl ?? "gcs" };
  }

  async health(): Promise<PlaneHealth> {
    if (!this.client) {
      return { ok: false, detail: "GCS backend not configured (no Convex url)" };
    }
    if (!this.refreshToken) {
      return {
        ok: false,
        detail: "not signed in to the GCS backend; mint a token in the Mission Control MCP tab",
        target: this.config.convexUrl,
      };
    }
    try {
      await this.ensureAuth();
      await this.query(LIST_MY_CLOUD_STATUSES, {});
      return { ok: true, target: this.config.convexUrl };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        target: this.config.convexUrl,
      };
    }
  }

  async getStatus(node: NodeRef): Promise<NodeStatus> {
    return this.cloudStatus(node);
  }

  async getStatusFull(node: NodeRef): Promise<NodeStatus> {
    // The heartbeat row is the single cloud snapshot; it is the full document.
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
    const services = s.services;
    return { services: services ?? [] };
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
    await this.ensureAuth();
    const rows = (await this.query<StatusRow[]>(LIST_MY_CLOUD_STATUSES, {})) ?? [];
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
    // The relay uninstall cannot preserve plugin data, so a keep-data removal is
    // refused (naming the direct reach) rather than silently destroying it.
    if (keepData) return Promise.reject(this.relayWriteUnsupported("a keep-data plugin removal"));
    return this.runRelayCommand(node, "plugin.uninstall", { pluginId: id });
  }

  async queryLogs(node: NodeRef, opts?: { level?: string; limit?: number }): Promise<unknown> {
    const outcome = await this.runRelayCommand(node, "get_logs", {
      ...(opts?.level ? { level: opts.level } : {}),
      limit: opts?.limit ?? 200,
    });
    if (!outcome.ok) {
      throw new GateError("rest_down", outcome.message ?? "get_logs did not complete on the drone");
    }
    return outcome.data ?? { entries: [] };
  }

  // The relay vocabulary carries no synchronous parameter/config write, no
  // supervisor restart, no plugin install (the console installs over direct HTTP)
  // and no plugin-config value set, so these name the direct reach honestly.
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

  pluginConfig(
    _node: NodeRef,
    _id: string,
    _key: string,
    _value: unknown,
    _scope?: string,
  ): Promise<CommandOutcome> {
    return Promise.reject(this.relayWriteUnsupported("setting a plugin configuration value"));
  }

  getPlugins(_node: NodeRef): Promise<unknown> {
    return Promise.reject(this.relayReadUnsupported("the installed plugin list"));
  }

  getPluginInfo(_node: NodeRef, _id: string): Promise<unknown> {
    return Promise.reject(this.relayReadUnsupported("a plugin's detail"));
  }

  /** Enqueue a relay command and poll the ack to a terminal outcome. */
  private async runRelayCommand(
    node: NodeRef,
    command: string,
    args: Record<string, unknown>,
  ): Promise<CommandOutcome> {
    await this.ensureAuth();
    const enq = await this.mutation<{ commandId: string }>(ENQUEUE_COMMAND, {
      deviceId: node,
      command,
      args,
    });
    const commandId = enq.commandId;
    const deadline = Date.now() + RELAY_ACK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(RELAY_POLL_MS);
      const row = await this.query<RelayRow | null>(GET_COMMAND_STATUS, { commandId });
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

  private relayWriteUnsupported(what: string): GateError {
    return new GateError(
      "not_supported",
      `${what} is not available over the GCS relay; reach the drone directly with --target agent <host>`,
    );
  }

  /**
   * Fetch the operator HMAC secret used to verify `cloud:` MCP tokens. The read
   * plane wires this into the token resolver so the AI client's cloud token is
   * verified against the operator's current (and just-rotated previous) secret.
   */
  async getOperatorSecret(): Promise<OperatorSecret> {
    if (this.secretCache && Date.now() < this.secretCache.expiry) return this.secretCache.value;
    await this.ensureAuth();
    const row = await this.query<{ secretBase64: string; previousSecretBase64?: string } | null>(
      GET_MY_SECRET,
      {},
    );
    if (!row?.secretBase64) throw new GateError("not_supported", "operator secret unavailable");
    const value: OperatorSecret = {
      current: b64ToBytes(row.secretBase64),
      ...(row.previousSecretBase64 ? { previous: b64ToBytes(row.previousSecretBase64) } : {}),
    };
    this.secretCache = { value, expiry: Date.now() + OPERATOR_SECRET_TTL_MS };
    return value;
  }

  private async cloudStatus(node: NodeRef): Promise<NodeStatus> {
    await this.ensureAuth();
    const row = await this.query<Record<string, unknown> | null>(GET_CLOUD_STATUS, { deviceId: node });
    if (!row) {
      throw new GateError("not_supported", `no cloud status for ${node} (not a cloud-paired drone)`, {
        node,
      });
    }
    return row;
  }

  private relayReadUnsupported(what: string): GateError {
    return new GateError(
      "not_supported",
      `${what} is not available over the GCS relay; reach the drone directly with --target agent <host>`,
    );
  }

  /** Ensure a live operator JWT is set on the client, refreshing when stale. */
  private async ensureAuth(): Promise<void> {
    if (!this.client) throw new GateError("not_supported", "GCS backend not configured");
    if (this.jwt && Date.now() < this.jwtExpiry) return;
    // Serialize concurrent refreshes so a rotating refresh token is spent once.
    if (this.authInFlight) return this.authInFlight;
    this.authInFlight = this.refreshJwt().finally(() => {
      this.authInFlight = null;
    });
    return this.authInFlight;
  }

  private async refreshJwt(): Promise<void> {
    if (!this.client) throw new GateError("not_supported", "GCS backend not configured");
    if (!this.refreshToken) {
      throw new GateError(
        "unauthorized",
        "not signed in to the GCS backend; mint a token in the Mission Control MCP tab",
      );
    }
    let result: unknown;
    try {
      // Bound the sign-in so a hung backend cannot leave authInFlight pending
      // forever and wedge every read behind it (the query path is bounded too).
      result = await withTimeout(
        this.client.action(SIGN_IN, { refreshToken: this.refreshToken }) as Promise<unknown>,
        this.config.timeoutMs ?? 10_000,
        "GCS sign-in",
      );
    } catch (err) {
      throw new GateError("unauthorized", `GCS sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const tokens = (result as { tokens?: { token?: string; refreshToken?: string } } | null)?.tokens;
    if (!tokens?.token) {
      throw new GateError("unauthorized", "GCS sign-in returned no token; the refresh token may be spent");
    }
    this.jwt = tokens.token;
    this.jwtExpiry = Date.now() + JWT_TTL_MS;
    if (tokens.refreshToken) this.refreshToken = tokens.refreshToken; // rotate
    this.client.setAuth(this.jwt);
    logger.debug("GCS operator session refreshed");
  }

  private async query<T = unknown>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ref: any,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.client) throw new GateError("not_supported", "GCS backend not configured");
    const timeoutMs = this.config.timeoutMs ?? 10_000;
    return (await withTimeout(this.client.query(ref, args) as Promise<T>, timeoutMs, "GCS query")) as T;
  }

  private async mutation<T = unknown>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ref: any,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (!this.client) throw new GateError("not_supported", "GCS backend not configured");
    const timeoutMs = this.config.timeoutMs ?? 10_000;
    return (await withTimeout(this.client.mutation(ref, args) as Promise<T>, timeoutMs, "GCS mutation")) as T;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Project a subset of keys that are present on a document. */
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

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
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
