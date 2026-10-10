// The scope model. A scope is a named group, not a single capability. Each group
// expands to a curated set of platform capability ids and lines up one-to-one
// with a safety class. Flight and destructive default off; a token cannot invoke
// a tool of that class unless the operator explicitly added the scope at mint.

import { CAPABILITY_FLOOR } from "./capability-floor.generated.js";

export const SCOPE_GROUPS = [
  "read",
  "safe_write",
  "admin",
  "flight",
  "destructive",
  "secret_read",
] as const;

export type ScopeGroup = (typeof SCOPE_GROUPS)[number];

// A tool's safety class is one of the write/read classes (secret_read is an
// orthogonal read modifier, not a class).
export const SAFETY_CLASSES = [
  "read",
  "safe_write",
  "admin",
  "flight",
  "destructive",
] as const;

export type SafetyClass = (typeof SAFETY_CLASSES)[number];

// Scope groups on by default when a token is minted from the wizard.
export const DEFAULT_ENABLED_SCOPES: ScopeGroup[] = ["read", "safe_write", "admin"];

// The capability ids each scope group expands to. These are the platform
// capability vocabulary ids (the same names the agent's capabilities catalog
// carries). The route-to-capability table maps a tool to one capability; the
// token is admitted when a granted scope group contains that capability.
export const SCOPE_CAPABILITIES: Record<ScopeGroup, readonly string[]> = {
  read: [
    "telemetry.read",
    "mavlink.read",
    "mission.read",
    "config.get",
    "vision.detection.subscribe",
    "compute.job.read",
    "perception.read",
  ],
  safe_write: [
    "config.set",
    "recording.write",
    "mission.write.stage",
    "vision.model.register",
    "video.snapshot",
    "display.oled.page",
  ],
  admin: [
    "config.set.network",
    "process.spawn",
    "network.outbound",
  ],
  flight: [
    "vehicle.command",
    "flight.guided_setpoint",
    "mavlink.write",
    "mission.write",
    "msp.write",
    "estimator.pose.inject",
    "vision.track.designate",
  ],
  destructive: [
    "system.reboot",
    "system.shutdown",
    "factory.reset",
    "ota.install",
    "ota.rollback",
    "params.reset_all",
    "flight.terminate",
  ],
  secret_read: ["filesystem.host.secret"],
};

/** True when the granted scope groups collectively contain the capability id. */
export function scopesGrantCapability(
  granted: readonly ScopeGroup[],
  capability: string,
): boolean {
  return granted.some((group) => SCOPE_CAPABILITIES[group].includes(capability));
}

/** Validate a requested scope set at mint time (the invariants from the spec). */
export function validateScopeRequest(scopes: readonly ScopeGroup[]): {
  ok: boolean;
  reason?: string;
} {
  const set = new Set(scopes);
  // secret_read is a modifier on read, not a substitute for it.
  if (set.has("secret_read") && !set.has("read")) {
    return { ok: false, reason: "secret_read requires read" };
  }
  for (const s of scopes) {
    if (!SCOPE_GROUPS.includes(s)) {
      return { ok: false, reason: `unknown scope group: ${s}` };
    }
  }
  return { ok: true };
}

/** Is this scope group one of the always-dangerous ones (default off)? */
export function isElevatedScope(group: ScopeGroup): boolean {
  return group === "flight" || group === "destructive" || group === "secret_read";
}

// Danger ordering of the write/read safety classes (read lowest, destructive
// highest). Used to floor a plugin tool's scope at its granted capabilities'
// implied class, and to pick the higher of two classes.
export const SAFETY_CLASS_RANK: Record<SafetyClass, number> = {
  read: 0,
  safe_write: 1,
  admin: 2,
  flight: 3,
  destructive: 4,
};

/** The higher-danger of two safety classes. */
export function maxSafetyClass(a: SafetyClass, b: SafetyClass): SafetyClass {
  return SAFETY_CLASS_RANK[a] >= SAFETY_CLASS_RANK[b] ? a : b;
}

/**
 * Capability ids known to imply no floor above safe_write: the curated read and
 * safe_write scope vocabulary, the agent catalog's read / data / perception ids,
 * and the read-only SDK method names. An id that is neither here nor in the
 * generated CAPABILITY_FLOOR is unknown and is floored at admin (fail closed).
 */
export const READ_SAFE_ALLOWLIST: ReadonlySet<string> = new Set([
  ...SCOPE_CAPABILITIES.read,
  ...SCOPE_CAPABILITIES.safe_write.filter((c) => !c.startsWith("mission.write")),
  "button.subscribe",
  "cloud.publish",
  "cloud.read",
  "cloud.records",
  "event.publish",
  "event.subscribe",
  "mavlink.subscribe",
  "mcp.expose",
  "msp.read",
  "msp.subscribe",
  "node.info.read",
  "perception.subscribe",
  "radio.aux_stream",
  "sensor.camera.register",
  "sensor.depth.register",
  "sensor.imu.register",
  "sensor.lidar.register",
  "sensor.payload.register",
  "telemetry.extend",
  "telemetry.subscribe",
  "video.source.set",
  "vision.detection.publish",
  "vision.frame.read",
  "vision.model.read",
  "vision.offload.advertise",
]);

/** Plugin-scoped ids (`plugin.<id>.<name>`) reach only the granting plugin. */
const PLUGIN_SCOPED_PREFIX = "plugin.";

/**
 * The safety class a single platform capability id implies.
 *
 * Order: the destructive family (node lifecycle, OTA, mass reset, termination);
 * the flight family by prefix (vehicle commands, guided setpoints, mission
 * writes, every non-read MAVLink id including method names such as
 * `mavlink.send` that the catalog does not list); then the floor generated from
 * the agent capability catalog (`flight_control` non-read ids are flight,
 * `hardware.*` is admin). Ids on READ_SAFE_ALLOWLIST and plugin-scoped ids
 * imply no floor (null). Any other id is unknown and is
 * floored at admin, so a new catalog id can never slip under a read token.
 * `secret_read` is orthogonal and never raises the write class.
 */
export function capabilityFloorClass(cap: string): SafetyClass | null {
  if (
    cap === "params.reset_all" ||
    cap === "flight.terminate" ||
    cap.startsWith("system.") ||
    cap.startsWith("factory.") ||
    cap.startsWith("ota.")
  ) {
    return "destructive";
  }
  if (
    cap === "vehicle.command" ||
    cap.startsWith("flight.") ||
    cap.startsWith("mission.write") ||
    (cap.startsWith("mavlink.") && cap !== "mavlink.read" && cap !== "mavlink.subscribe")
  ) {
    return "flight";
  }
  const generated = CAPABILITY_FLOOR[cap];
  if (generated) return generated;
  if (READ_SAFE_ALLOWLIST.has(cap) || cap.startsWith(PLUGIN_SCOPED_PREFIX)) {
    return null;
  }
  return "admin";
}

/**
 * The highest safety class a plugin's granted capabilities imply
 * (admin / flight / destructive), or null when the plugin holds nothing above
 * safe_write. A plugin tool's scope is floored at this class so a plugin author
 * cannot under-declare a tool's `safety_class` to obtain a lower MCP-token scope
 * than the plugin's real reach — the defense-in-depth invariant that the
 * MCP-token scope layer must not collapse to trusting the plugin author.
 */
export function impliedFloorForCaps(granted: readonly string[]): SafetyClass | null {
  let floor: SafetyClass | null = null;
  for (const cap of granted) {
    const cls = capabilityFloorClass(cap);
    if (cls && (floor === null || SAFETY_CLASS_RANK[cls] > SAFETY_CLASS_RANK[floor])) {
      floor = cls;
    }
  }
  return floor;
}

/**
 * True when a plugin holds any capability that can affect flight — command the
 * vehicle, inject MAVLink, write a mission, or terminate flight. Such a plugin's
 * tools carry `affectsFlight` (hidden and refused until the MAVLink proxy enforce
 * flag is on) even when their top class is `destructive` (e.g. `flight.terminate`).
 */
export function grantsAffectFlight(granted: readonly string[]): boolean {
  return granted.some(
    (cap) =>
      cap === "vehicle.command" ||
      cap.startsWith("flight.") ||
      cap.startsWith("mission.write") ||
      (cap.startsWith("mavlink.") && cap !== "mavlink.read" && cap !== "mavlink.subscribe") ||
      CAPABILITY_FLOOR[cap] === "flight",
  );
}
