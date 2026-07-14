// The scope model. A scope is a named group, not a single capability. Each group
// expands to a curated set of platform capability ids and lines up one-to-one
// with a safety class. Flight and destructive default off; a token cannot invoke
// a tool of that class unless the operator explicitly added the scope at mint.

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
