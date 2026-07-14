// The authoritative scope check: does a token's granted scope groups cover the
// scope group a tool's route-to-capability row requires. Separate from the
// finer capability check the agent edge re-runs; here the scope group is what
// gates the MCP server's own dispatch.

import type { ScopeGroup } from "../auth/scopes.js";

export function scopeCoversTool(
  granted: readonly ScopeGroup[],
  entry: { scope: ScopeGroup },
): boolean {
  return granted.includes(entry.scope);
}

/** True when the token holds a given scope group. */
export function hasScope(granted: readonly ScopeGroup[], scope: ScopeGroup): boolean {
  return granted.includes(scope);
}
