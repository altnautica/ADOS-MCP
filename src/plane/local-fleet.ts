// LocalFleetPlane: the LOCAL-FIRST multi-drone plane (Rule 39). It composes one
// LanDirectPlane per LAN-paired drone — each with its own host + X-ADOS-Key — so
// an AI client reaches a WHOLE fleet directly over the LAN with no cloud, no
// login, and no relay. The fleet is the operator-exported list of drones already
// paired in Mission Control (local-nodes-store), read from a fleet file. Every
// per-node call carries that node's pairing key; listNodes fans out with honest
// online/offline; every other verb delegates to the target node's client, which
// keeps the full rich agent-mode surface (params/config/plugins/admin) for each
// node. This closes the gap where multi-node reach previously existed only over
// the cloud relay.

import { GateError } from "../gate/errors.js";
import { LanDirectPlane } from "./lan-direct.js";
import type { FleetNode } from "../config.js";
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

export class LocalFleetPlane implements PlatformPlane {
  readonly mode: PlaneMode = "local-fleet";
  private readonly clients = new Map<string, LanDirectPlane>();
  private readonly meta = new Map<string, FleetNode>();

  constructor(nodes: FleetNode[]) {
    for (const n of nodes) {
      this.clients.set(
        n.deviceId,
        new LanDirectPlane({ host: n.host, apiKey: n.apiKey, nodeId: n.deviceId }),
      );
      this.meta.set(n.deviceId, n);
    }
  }

  /** Run `fn` against the node's client, or REJECT (never sync-throw — these
   * methods return Promises) when the node is not in the fleet file. The pipeline
   * already validates the target upstream; this is the plane-level backstop. */
  private via<T>(node: NodeRef, fn: (client: LanDirectPlane) => Promise<T>): Promise<T> {
    const c = this.clients.get(node);
    if (!c) {
      return Promise.reject(
        new GateError(
          "node_not_allowed",
          `node '${node}' is not in the local fleet; call fleet.list_nodes to see the nodes this server reaches`,
        ),
      );
    }
    return fn(c);
  }

  describe(): { mode: PlaneMode; target: string } {
    return { mode: this.mode, target: `${this.clients.size} LAN node(s)` };
  }

  async health(): Promise<PlaneHealth> {
    const target = `${this.clients.size} LAN node(s)`;
    if (this.clients.size === 0) {
      return { ok: false, detail: "no nodes in the fleet file", target };
    }
    const results = await Promise.all([...this.clients.values()].map((c) => c.health()));
    const up = results.filter((r) => r.ok).length;
    const down = this.clients.size - up;
    return {
      ok: up > 0,
      detail: down > 0 ? `${up}/${this.clients.size} nodes reachable` : undefined,
      target,
    };
  }

  // No backend to verify a machine credential against — local-fleet auth is the
  // on-box stdio principal; each node's own pairing key authorizes its data path.
  verifyCredential(_credential: string): Promise<CredentialPrincipal | null> {
    return Promise.resolve(null);
  }

  // Honest per-node enumeration: probe every configured node in parallel and mark
  // it online only when it actually answers (never the hardcoded online:true the
  // single-node LanDirectPlane uses). An unreachable node still lists, offline.
  async listNodes(): Promise<NodeSummary[]> {
    const entries = [...this.clients.entries()];
    return Promise.all(
      entries.map(async ([deviceId, c]): Promise<NodeSummary> => {
        const meta = this.meta.get(deviceId);
        try {
          const health = await c.health();
          if (!health.ok) throw new Error(health.detail ?? "unreachable");
          const status = (await c.getStatus(deviceId)) as Record<string, unknown>;
          return {
            deviceId,
            name: meta?.name ?? (typeof status.name === "string" ? status.name : deviceId),
            online: true,
            profile:
              meta?.profile ?? (typeof status.profile === "string" ? status.profile : undefined),
            agentVersion:
              typeof status.agent_version === "string" ? status.agent_version : undefined,
          };
        } catch {
          return { deviceId, name: meta?.name ?? deviceId, online: false, profile: meta?.profile };
        }
      }),
    );
  }

  // --- reads (delegated to the target node's client) ---
  getStatus(n: NodeRef): Promise<NodeStatus> {
    return this.via(n, (c) => c.getStatus(n));
  }
  getStatusFull(n: NodeRef): Promise<NodeStatus> {
    return this.via(n, (c) => c.getStatusFull(n));
  }
  getSystem(n: NodeRef): Promise<NodeStatus> {
    return this.via(n, (c) => c.getSystem(n));
  }
  getTelemetry(n: NodeRef): Promise<NodeStatus> {
    return this.via(n, (c) => c.getTelemetry(n));
  }
  getVision(n: NodeRef): Promise<NodeStatus> {
    return this.via(n, (c) => c.getVision(n));
  }
  getServices(n: NodeRef): Promise<NodeStatus> {
    return this.via(n, (c) => c.getServices(n));
  }
  getParams(n: NodeRef): Promise<ParamEntry[]> {
    return this.via(n, (c) => c.getParams(n));
  }
  getParam(n: NodeRef, name: string): Promise<ParamEntry | null> {
    return this.via(n, (c) => c.getParam(n, name));
  }
  getConfig(n: NodeRef): Promise<NodeStatus> {
    return this.via(n, (c) => c.getConfig(n));
  }
  firmwareHint(n: NodeRef): Promise<FirmwareHint> {
    return this.via(n, (c) => c.firmwareHint(n));
  }

  // --- admin / ecosystem writes ---
  restartService(n: NodeRef, unit: string): Promise<CommandOutcome> {
    return this.via(n, (c) => c.restartService(n, unit));
  }
  restartSupervisor(n: NodeRef): Promise<CommandOutcome> {
    return this.via(n, (c) => c.restartSupervisor(n));
  }
  setParam(n: NodeRef, name: string, value: number): Promise<CommandOutcome> {
    return this.via(n, (c) => c.setParam(n, name, value));
  }
  setConfig(n: NodeRef, key: string, value: string): Promise<CommandOutcome> {
    return this.via(n, (c) => c.setConfig(n, key, value));
  }
  pluginInstall(n: NodeRef, url: string, sha256?: string): Promise<CommandOutcome> {
    return this.via(n, (c) => c.pluginInstall(n, url, sha256));
  }
  pluginEnable(n: NodeRef, id: string): Promise<CommandOutcome> {
    return this.via(n, (c) => c.pluginEnable(n, id));
  }
  pluginDisable(n: NodeRef, id: string): Promise<CommandOutcome> {
    return this.via(n, (c) => c.pluginDisable(n, id));
  }
  pluginRemove(n: NodeRef, id: string, keepData?: boolean): Promise<CommandOutcome> {
    return this.via(n, (c) => c.pluginRemove(n, id, keepData));
  }
  pluginConfig(
    n: NodeRef,
    id: string,
    key: string,
    value: unknown,
    scope?: string,
  ): Promise<CommandOutcome> {
    return this.via(n, (c) => c.pluginConfig(n, id, key, value, scope));
  }
  getPlugins(n: NodeRef): Promise<unknown> {
    return this.via(n, (c) => c.getPlugins(n));
  }
  getPluginInfo(n: NodeRef, id: string): Promise<unknown> {
    return this.via(n, (c) => c.getPluginInfo(n, id));
  }
  invokePluginTool(
    n: NodeRef,
    id: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return this.via(n, (c) => c.invokePluginTool(n, id, tool, args));
  }
  queryLogs(n: NodeRef, opts?: { level?: string; limit?: number }): Promise<unknown> {
    return this.via(n, (c) => c.queryLogs(n, opts));
  }

  // --- node / platform administration ---
  renameNode(n: NodeRef, name: string): Promise<CommandOutcome> {
    return this.via(n, (c) => c.renameNode(n, name));
  }
  getPairingInfo(n: NodeRef): Promise<unknown> {
    return this.via(n, (c) => c.getPairingInfo(n));
  }
  generatePairingCode(n: NodeRef): Promise<unknown> {
    return this.via(n, (c) => c.generatePairingCode(n));
  }
  claimPairing(n: NodeRef, userId: string): Promise<CommandOutcome> {
    return this.via(n, (c) => c.claimPairing(n, userId));
  }
  unpairAgent(n: NodeRef): Promise<CommandOutcome> {
    return this.via(n, (c) => c.unpairAgent(n));
  }
  setWfbChannel(n: NodeRef, channel: number): Promise<CommandOutcome> {
    return this.via(n, (c) => c.setWfbChannel(n, channel));
  }
  setWfbTxPower(n: NodeRef, powerDbm: number): Promise<CommandOutcome> {
    return this.via(n, (c) => c.setWfbTxPower(n, powerDbm));
  }
  joinWifi(n: NodeRef, ssid: string, passphrase?: string): Promise<CommandOutcome> {
    return this.via(n, (c) => c.joinWifi(n, ssid, passphrase));
  }
  leaveWifi(n: NodeRef): Promise<CommandOutcome> {
    return this.via(n, (c) => c.leaveWifi(n));
  }

  // --- flight (gated upstream: flight scope + operator-present/confirm/sim) ---
  sendFlightCommand(n: NodeRef, cmd: string, args: (number | string)[]): Promise<CommandOutcome> {
    return this.via(n, (c) => c.sendFlightCommand(n, cmd, args));
  }
}
