// LanDirectPlane: talks to one agent over its native surfaces on the LAN. Reads
// go to the ados-control REST on :8080 with the X-ADOS-Key header (when paired).
// This is agent-mode's plane. The write verbs and the state-socket / MAVLink-WS
// streaming are added with their phases; this module holds the REST client and
// the read surface the server needs now.

import { GateError } from "../gate/errors.js";
import { logger } from "../util/logger.js";
import type { NodeRef, NodeStatus, PlaneHealth, PlaneMode, PlatformPlane } from "./platform-plane.js";

export interface LanDirectConfig {
  /** Agent host: a bare hostname/IP (defaults to http://<host>:8080), or a full URL. */
  host: string;
  /** The pairing api key, sent as X-ADOS-Key. Omitted when the agent is unpaired. */
  apiKey?: string;
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
      await this.get("/api/status");
      return { ok: true, target: this.baseUrl };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        target: this.baseUrl,
      };
    }
  }

  async getStatus(_node: NodeRef): Promise<NodeStatus> {
    return this.get<NodeStatus>("/api/status");
  }

  /** Perform an authenticated GET against the agent REST, mapping failures. */
  protected async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  protected async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
