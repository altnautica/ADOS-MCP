// The route-to-capability table. It maps each MCP tool to the one scope group
// (and a representative platform capability) it requires. The MCP server's gate
// checks the token's scopes against the tool's `scope` group (authoritative);
// the `capability` id is carried for audit and for the agent-edge check that
// re-enforces the same rows independently. A tool with no row here fails the
// build gate (a CI test asserts every registered tool has an entry).
//
// Some tools escalate at call time based on their arguments (config.set on a
// network path, params.set on a flight-critical name, services.restart on an
// armed-critical unit). The table records the BASE class; the gate computes the
// escalation from the arguments.

import type { SafetyClass, ScopeGroup } from "./scopes.js";

export interface RouteCapEntry {
  /** The dotted MCP tool name. */
  tool: string;
  /** The scope group the token must hold. Authoritative for the gate. */
  scope: ScopeGroup;
  /** A representative platform capability id, for audit + the agent edge. */
  capability: string;
  /** The tool's safety class. Equals `scope` for non-secret tools. */
  safetyClass: SafetyClass;
  /** True when the tool may touch a secret path and needs secret_read for it. */
  secretPossible?: boolean;
  /** True when the tool can escalate to a higher class from its arguments. */
  escalates?: boolean;
  /**
   * True when the tool is fleet-wide / node-agnostic: it targets no single node
   * (fleet.list_nodes enumerates the operator's fleet; audit.* reads the local
   * audit). Such tools skip the per-node targeting gate, which in fleet-mode
   * would otherwise reject them for having no `node` argument.
   */
  fleetWide?: boolean;
  /**
   * True when the tool writes MAVLink / changes in-flight behavior, even if its
   * class is not `flight` (emergency_stop is `destructive`). Such tools are
   * hidden and refused until the MAVLink proxy enforce flag is confirmed on, and
   * are never exposed to a token without the flight scope.
   */
  affectsFlight?: boolean;
  /**
   * True when the tool can only be served over the drone-direct (agent) reach —
   * the GCS relay vocabulary has no synchronous parameter/config read/write, no
   * plugin install, no plugin-config set, no supervisor restart. Such a tool is
   * hidden from tools/list and refused with `agent_mode_only` in fleet-mode, so a
   * fleet-mode client never sees a tool that would always return not_supported.
   */
  agentModeOnly?: boolean;
}

const R = (
  tool: string,
  scope: ScopeGroup,
  capability: string,
  extra: Partial<RouteCapEntry> = {},
): RouteCapEntry => ({
  tool,
  scope,
  capability,
  safetyClass: (extra.safetyClass ?? (scope === "secret_read" ? "read" : scope)) as SafetyClass,
  ...extra,
});

export const ROUTE_CAPABILITY_TABLE: readonly RouteCapEntry[] = [
  // status.* (read)
  R("status.get", "read", "telemetry.read"),
  R("status.full", "read", "telemetry.read"),
  R("status.version", "read", "telemetry.read"),
  R("status.system", "read", "telemetry.read"),
  R("status.diagnostics", "read", "telemetry.read"),
  R("status.time", "read", "telemetry.read"),
  R("status.ping", "read", "telemetry.read"),
  R("status.health", "read", "telemetry.read"),
  // telemetry.* (read)
  R("telemetry.snapshot", "read", "telemetry.read"),
  R("telemetry.subscribe", "read", "telemetry.read"),
  // params.* (read + gated write) — the FC parameter surface is not on the GCS
  // relay, so these are drone-direct-only (agentModeOnly).
  R("params.read_all", "read", "telemetry.read", { agentModeOnly: true }),
  R("params.get", "read", "telemetry.read", { agentModeOnly: true }),
  R("params.explain", "read", "telemetry.read", { agentModeOnly: true }),
  R("params.diff_from_default", "read", "telemetry.read", { agentModeOnly: true }),
  R("params.optimize", "read", "telemetry.read", { agentModeOnly: true }),
  R("params.set", "admin", "config.set", { escalates: true, agentModeOnly: true }),
  R("params.reset_all", "destructive", "params.reset_all", { agentModeOnly: true }),
  // config.* (read + gated write) — /api/config is drone-direct-only.
  R("config.get", "read", "config.get", { secretPossible: true, agentModeOnly: true }),
  R("config.set", "safe_write", "config.set", { escalates: true, agentModeOnly: true }),
  // services.* (read + gated write)
  R("services.list", "read", "telemetry.read"),
  R("services.restart", "admin", "process.spawn", { escalates: true }),
  // admin.* / platform.*
  R("admin.node.rename", "admin", "process.spawn"),
  R("admin.agent.update", "admin", "process.spawn"),
  // Restarting the supervisor cycles the whole service tree, including the
  // armed-critical MAVLink router and video units, so it carries the same flight
  // gate that services.restart escalates those units to (never a plain admin
  // confirm-only path to a more-destructive action).
  R("admin.agent.restart_supervisor", "flight", "process.spawn", {
    affectsFlight: true,
    agentModeOnly: true,
  }),
  R("admin.pairing.info", "read", "telemetry.read"),
  R("admin.pairing.generate_code", "admin", "config.set.network"),
  R("admin.pairing.claim", "admin", "config.set.network"),
  R("admin.pairing.unpair", "admin", "config.set.network"),
  R("admin.wfb.channel", "admin", "network.outbound"),
  R("admin.wfb.tx_power", "admin", "network.outbound"),
  R("admin.network.wifi_join", "admin", "network.outbound"),
  R("admin.network.wifi_leave", "admin", "network.outbound"),
  // plugins.* — enable/disable/remove ride the relay; list/info (live plugin
  // state) and install/config are drone-direct-only.
  R("plugins.list", "read", "telemetry.read", { agentModeOnly: true }),
  R("plugins.info", "read", "telemetry.read", { agentModeOnly: true }),
  R("plugins.install", "admin", "process.spawn", { agentModeOnly: true }),
  R("plugins.enable", "admin", "process.spawn"),
  R("plugins.disable", "admin", "process.spawn"),
  R("plugins.remove", "admin", "process.spawn"),
  R("plugins.config", "safe_write", "config.set", { agentModeOnly: true }),
  // flight.* (gated, off by default)
  R("flight.arm", "flight", "vehicle.command", { affectsFlight: true }),
  R("flight.disarm", "flight", "vehicle.command", { affectsFlight: true }),
  R("flight.takeoff", "flight", "vehicle.command", { affectsFlight: true }),
  R("flight.land", "flight", "vehicle.command", { affectsFlight: true }),
  R("flight.rtl", "flight", "vehicle.command", { affectsFlight: true }),
  R("flight.mode", "flight", "vehicle.command", { affectsFlight: true }),
  R("flight.goto", "flight", "flight.guided_setpoint", { affectsFlight: true }),
  R("flight.emergency_stop", "destructive", "flight.terminate", { affectsFlight: true }),
  // mission.* (read + gated write)
  R("mission.read", "read", "mission.read"),
  R("mission.download", "read", "mission.read"),
  R("mission.upload", "flight", "mission.write", { affectsFlight: true }),
  R("mission.clear", "flight", "mission.write", { affectsFlight: true }),
  // vision.* (read + gated write)
  R("vision.status", "read", "perception.read"),
  R("vision.detector_get", "read", "perception.read"),
  R("vision.detector_set", "safe_write", "vision.model.register"),
  R("vision.designate", "safe_write", "vision.designate"),
  // video.* (read, url handoff)
  R("video.live_url", "read", "telemetry.read"),
  R("video.snapshot", "safe_write", "video.snapshot"),
  // files.* (allow-listed, redacted)
  R("files.list", "read", "telemetry.read"),
  R("files.read", "read", "telemetry.read", { secretPossible: true }),
  R("files.write", "admin", "process.spawn"),
  // fleet.* (fleet-mode; enumeration is node-agnostic, target takes a node)
  R("fleet.list_nodes", "read", "telemetry.read", { fleetWide: true }),
  R("fleet.search", "read", "telemetry.read", { fleetWide: true }),
  R("fleet.target", "read", "telemetry.read"),
  // logs.* (read)
  R("logs.query", "read", "telemetry.read"),
  R("logs.tail", "read", "telemetry.read"),
  R("logs.aggregate", "read", "telemetry.read"),
  // audit.* (read; the local MCP audit, node is a filter not a target)
  R("audit.query", "read", "telemetry.read", { fleetWide: true }),
  R("audit.search", "read", "telemetry.read", { fleetWide: true }),
  // system.* (destructive)
  R("system.reboot", "destructive", "system.reboot"),
  R("system.shutdown", "destructive", "system.shutdown"),
  R("system.factory_reset", "destructive", "factory.reset"),
];

const BY_TOOL = new Map<string, RouteCapEntry>(ROUTE_CAPABILITY_TABLE.map((e) => [e.tool, e]));

export function routeCapFor(tool: string): RouteCapEntry | undefined {
  return BY_TOOL.get(tool);
}

/** Every tool the table knows about, for the CI completeness check. */
export function knownRouteTools(): Set<string> {
  return new Set(BY_TOOL.keys());
}
