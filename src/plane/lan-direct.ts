// LanDirectPlane: talks to one agent over its native surfaces on the LAN. Reads
// go to the ados-control REST on :8080 with the X-ADOS-Key header (when paired).
// This is agent-mode's plane — the drone-direct pathway. The write verbs and the
// state-socket / MAVLink-WS streaming are added with their phases; this module
// holds the REST client and the full read surface.

import { GateError } from "../gate/errors.js";
import { logger } from "../util/logger.js";
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

export interface LanDirectConfig {
  /** Agent host: a bare hostname/IP (defaults to http://<host>:8080), or a full URL. */
  host: string;
  /** The pairing api key, sent as X-ADOS-Key. Omitted when the agent is unpaired. */
  apiKey?: string;
  /** This node's device id, for the fleet-list row. */
  nodeId?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

/** Normalize a bare host to the agent's REST base URL; leave a full URL intact. */
export function agentBaseUrl(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A bare host (optionally with a port) defaults to http on the agent port.
  if (/:\d+$/.test(trimmed)) return `http://${trimmed}`;
  return `http://${trimmed}:8080`;
}

/** Map the platform's FC-variant string to a metadata firmware key. */
export function firmwareOf(variant: unknown): string {
  const v = String(variant ?? "").toLowerCase();
  if (v.includes("ardu") || v.includes("apm")) return "ardupilot";
  if (v.includes("px4")) return "px4";
  if (v.includes("inav")) return "inav";
  if (v.includes("betaflight") || v.includes("bf")) return "betaflight";
  return "unknown";
}

/** Map a MAVLink/vehicle type string to a metadata vehicle class. */
export function vehicleClassOf(type: unknown): string | undefined {
  const v = String(type ?? "").toLowerCase();
  if (!v) return undefined;
  if (v.includes("copter") || v.includes("quad") || v.includes("hexa") || v.includes("octo") || v.includes("rotor"))
    return "copter";
  if (v.includes("plane") || v.includes("fixed") || v.includes("vtol")) return "plane";
  if (v.includes("rover") || v.includes("ground")) return "rover";
  if (v.includes("sub") || v.includes("boat")) return "sub";
  return undefined;
}

/** Normalize the agent's parameter payload (map or array) into ParamEntry[]. */
export function normalizeParams(raw: unknown): ParamEntry[] {
  const out: ParamEntry[] = [];
  const push = (name: unknown, value: unknown, type?: unknown): void => {
    if (typeof name !== "string") return;
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      out.push({ name, value, ...(typeof type === "string" ? { type } : {}) });
    }
  };
  // { params: [...] } or { params: {name: value} } or a bare array / map.
  const body = raw && typeof raw === "object" && "params" in (raw as object)
    ? (raw as { params: unknown }).params
    : raw;
  if (Array.isArray(body)) {
    for (const p of body) {
      if (p && typeof p === "object") push((p as Record<string, unknown>).name, (p as Record<string, unknown>).value, (p as Record<string, unknown>).type);
    }
  } else if (body && typeof body === "object") {
    for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
      if (value && typeof value === "object" && "value" in (value as object)) {
        push(name, (value as Record<string, unknown>).value, (value as Record<string, unknown>).type);
      } else {
        push(name, value);
      }
    }
  }
  return out;
}

export class LanDirectPlane implements PlatformPlane {
  readonly mode: PlaneMode = "agent";
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: LanDirectConfig) {
    this.baseUrl = agentBaseUrl(config.host);
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  describe(): { mode: PlaneMode; target: string } {
    return { mode: this.mode, target: this.baseUrl };
  }

  async health(): Promise<PlaneHealth> {
    try {
      // A short timeout so /healthz stays fast even when the agent is down.
      await this.get("/api/status", 2000);
      return { ok: true, target: this.baseUrl };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        target: this.baseUrl,
      };
    }
  }

  async verifyCredential(_credential: string): Promise<CredentialPrincipal | null> {
    // Agent-mode has no backend to verify a machine credential against; its auth
    // is the self-contained token path, not this.
    return null;
  }

  getStatus(_node: NodeRef): Promise<NodeStatus> {
    return this.get<NodeStatus>("/api/status");
  }

  getStatusFull(_node: NodeRef): Promise<NodeStatus> {
    return this.get<NodeStatus>("/api/status/full");
  }

  getSystem(_node: NodeRef): Promise<NodeStatus> {
    return this.get<NodeStatus>("/api/system");
  }

  getTelemetry(_node: NodeRef): Promise<NodeStatus> {
    return this.get<NodeStatus>("/api/telemetry");
  }

  getVision(_node: NodeRef): Promise<NodeStatus> {
    return this.get<NodeStatus>("/api/vision/status");
  }

  getServices(_node: NodeRef): Promise<NodeStatus> {
    return this.get<NodeStatus>("/api/services");
  }

  getConfig(_node: NodeRef): Promise<NodeStatus> {
    return this.get<NodeStatus>("/api/config");
  }

  async getParams(_node: NodeRef): Promise<ParamEntry[]> {
    return normalizeParams(await this.get("/api/params"));
  }

  async getParam(_node: NodeRef, name: string): Promise<ParamEntry | null> {
    const raw = await this.get<unknown>(`/api/params/${encodeURIComponent(name)}`);
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      const value = r.value;
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        return { name, value, ...(typeof r.type === "string" ? { type: r.type } : {}) };
      }
    }
    if (typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean") {
      return { name, value: raw };
    }
    return null;
  }

  async firmwareHint(_node: NodeRef): Promise<FirmwareHint> {
    const status = await this.get<Record<string, unknown>>("/api/status").catch(
      () => ({}) as Record<string, unknown>,
    );
    const variant = status.fcVariant ?? status.fc_variant ?? status.firmwareType ?? status.fcFirmware;
    const type = status.vehicleType ?? status.mavType ?? status.frameClass;
    const version = status.fcFirmwareVersion ?? status.firmwareVersion;
    const vc = vehicleClassOf(type);
    return {
      firmware: firmwareOf(variant),
      ...(vc ? { vehicleClass: vc } : {}),
      ...(typeof version === "string" ? { version } : {}),
    };
  }

  async listNodes(): Promise<NodeSummary[]> {
    // Agent-mode reaches exactly one node: itself.
    const status = await this.get<Record<string, unknown>>("/api/status").catch(
      () => ({}) as Record<string, unknown>,
    );
    const deviceId = String(this.config.nodeId ?? status.deviceId ?? status.device_id ?? "local");
    const battery = readBatteryPct(status);
    return [
      {
        deviceId,
        ...(typeof status.name === "string" ? { name: status.name } : {}),
        online: true,
        ...(typeof status.agentVersion === "string" ? { agentVersion: status.agentVersion } : {}),
        ...(typeof status.board === "string" ? { board: status.board } : {}),
        ...(typeof status.profile === "string" ? { profile: status.profile } : {}),
        ...(typeof status.fcConnected === "boolean" ? { fcConnected: status.fcConnected } : {}),
        battery,
      },
    ];
  }

  // --- Admin / ecosystem writes over the agent REST (drone-direct) ---

  async restartService(_node: NodeRef, unit: string): Promise<CommandOutcome> {
    return toOutcome(await this.post(`/api/services/${encodeURIComponent(unit)}/restart`));
  }

  async restartSupervisor(_node: NodeRef): Promise<CommandOutcome> {
    return toOutcome(await this.post(`/api/v1/system/restart-supervisor`));
  }

  async setParam(_node: NodeRef, name: string, value: number): Promise<CommandOutcome> {
    return toOutcome(await this.post(`/api/params/${encodeURIComponent(name)}`, { value }));
  }

  async setConfig(_node: NodeRef, key: string, value: string): Promise<CommandOutcome> {
    return toOutcome(await this.put(`/api/config`, { key, value }));
  }

  async pluginInstall(_node: NodeRef, url: string, sha256?: string): Promise<CommandOutcome> {
    return toOutcome(
      await this.post(`/api/plugins/install_from_url`, {
        url,
        ...(sha256 ? { expected_sha256: sha256 } : {}),
      }),
    );
  }

  async pluginEnable(_node: NodeRef, id: string): Promise<CommandOutcome> {
    return toOutcome(await this.post(`/api/plugins/${encodeURIComponent(id)}/enable`));
  }

  async pluginDisable(_node: NodeRef, id: string): Promise<CommandOutcome> {
    return toOutcome(await this.post(`/api/plugins/${encodeURIComponent(id)}/disable`));
  }

  async pluginRemove(_node: NodeRef, id: string, keepData?: boolean): Promise<CommandOutcome> {
    const q = keepData ? "?keep_data=1" : "";
    return toOutcome(await this.del(`/api/plugins/${encodeURIComponent(id)}${q}`));
  }

  async pluginConfig(
    _node: NodeRef,
    id: string,
    key: string,
    value: unknown,
    scope?: string,
  ): Promise<CommandOutcome> {
    return toOutcome(
      await this.put(`/api/plugins/${encodeURIComponent(id)}/config`, {
        key,
        value,
        ...(scope ? { scope } : {}),
      }),
    );
  }

  getPlugins(_node: NodeRef): Promise<unknown> {
    return this.get("/api/plugins");
  }

  getPluginInfo(_node: NodeRef, id: string): Promise<unknown> {
    return this.get(`/api/plugins/${encodeURIComponent(id)}`);
  }

  queryLogs(_node: NodeRef, opts?: { level?: string; limit?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.level) params.set("level", opts.level);
    params.set("limit", String(opts?.limit ?? 200));
    return this.get(`/api/logs?${params.toString()}`);
  }

  // --- Node / platform administration (agent-mode REST) ---
  // The OS hostname is set only at install time, so "rename" sets the DISPLAY
  // name (config key agent.name), which is what pairing + the fleet card show.
  async renameNode(_node: NodeRef, name: string): Promise<CommandOutcome> {
    return toOutcome(await this.put(`/api/config`, { key: "agent.name", value: name }));
  }
  getPairingInfo(_node: NodeRef): Promise<unknown> {
    return this.get(`/api/pairing/info`);
  }
  generatePairingCode(_node: NodeRef): Promise<unknown> {
    return this.get(`/api/pairing/code`);
  }
  async claimPairing(_node: NodeRef, userId: string): Promise<CommandOutcome> {
    return toOutcome(await this.post(`/api/pairing/claim`, { user_id: userId }));
  }
  async unpairAgent(_node: NodeRef): Promise<CommandOutcome> {
    return toOutcome(await this.post(`/api/pairing/unpair`));
  }
  async setWfbChannel(_node: NodeRef, channel: number): Promise<CommandOutcome> {
    return toOutcome(await this.post(`/api/wfb/channel`, { channel }));
  }
  async setWfbTxPower(_node: NodeRef, powerDbm: number): Promise<CommandOutcome> {
    return toOutcome(await this.put(`/api/wfb/tx-power`, { tx_power_dbm: powerDbm }));
  }
  async joinWifi(_node: NodeRef, ssid: string, passphrase?: string): Promise<CommandOutcome> {
    return toOutcome(
      await this.put(`/api/v1/network/client/join`, {
        ssid,
        ...(passphrase !== undefined ? { passphrase } : {}),
      }),
    );
  }
  async leaveWifi(_node: NodeRef): Promise<CommandOutcome> {
    return toOutcome(await this.del(`/api/v1/network/client`));
  }

  async sendFlightCommand(_node: NodeRef, cmd: string, args: (number | string)[]): Promise<CommandOutcome> {
    // Native ados-control POST /api/command {cmd,args}; X-ADOS-Key is sent by
    // request(). A 503 (FC not connected) throws rest_down. The response carries
    // the correlated COMMAND_ACK; the tool layer reads ack.accepted (a DENIED ack
    // still returns HTTP 200), so this stays a plain toOutcome.
    return toOutcome(await this.post(`/api/command`, { cmd, args }));
  }

  /** Perform an authenticated GET against the agent REST, mapping failures. */
  protected async get<T = unknown>(path: string, timeoutMs?: number): Promise<T> {
    return this.request<T>("GET", path, undefined, timeoutMs);
  }

  protected post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  protected put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  protected del<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  protected async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.config.apiKey) headers["X-ADOS-Key"] = this.config.apiKey;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new GateError("unauthorized", `agent rejected the request (${res.status})`, { path });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new GateError("rest_down", `agent returned ${res.status} for ${path}`, {
          path,
          status: res.status,
          body: text.slice(0, 400),
        });
      }
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        return (await res.json()) as T;
      }
      return (await res.text()) as unknown as T;
    } catch (err) {
      if (err instanceof GateError) throw err;
      logger.debug(`LAN plane request failed`, { path, err: String(err) });
      throw new GateError("rest_down", `agent REST unreachable at ${url}`, {
        path,
        cause: String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Wrap a REST write response as a CommandOutcome. A transport failure throws a
 * GateError before this is reached, so arriving here means HTTP 2xx — but the
 * agent may report an in-body failure (`{ success: false }`) on a 2xx, so honor
 * that rather than reporting a failed command as completed (matches GcsPlane). */
export function toOutcome(data: unknown): CommandOutcome {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  const message = obj && typeof obj.message === "string" ? (obj.message as string) : undefined;
  const bodyFailed = obj?.success === false;
  return {
    ok: !bodyFailed,
    status: bodyFailed ? "failed" : "completed",
    ...(message ? { message } : {}),
    ...(data !== undefined && data !== null ? { data } : {}),
  };
}

/** Pull a battery-remaining percent out of a status document, or null. */
export function readBatteryPct(status: Record<string, unknown>): number | null {
  const battery = status.battery;
  if (battery && typeof battery === "object") {
    const rem = (battery as Record<string, unknown>).remaining ?? (battery as Record<string, unknown>).percent;
    if (typeof rem === "number") return rem < 0 ? null : rem;
  }
  if (typeof status.batteryRemaining === "number") return status.batteryRemaining < 0 ? null : status.batteryRemaining;
  return null;
}
