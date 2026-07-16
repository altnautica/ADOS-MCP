// Discover a node's plugin-contributed MCP tools and register them into the
// ToolRegistry, namespaced `${pluginId}:${toolName}`. Each plugin tool routes
// through the SAME authoritative gate as a built-in tool: its route-cap entry is
// registered in the dynamic route-cap table (see route-capability.ts), so the
// gate resolves and enforces its scope by the identical path. A plugin tool's
// scope comes from its declared safety class; the plugin's OWN capabilities still
// bound what the tool can actually do, and (for a flight-class tool) the flight
// scope is default-off and the tool is hidden until flight is enforced.

import { z } from "zod";

import { clearDynamicRouteCaps, registerDynamicRouteCap } from "../auth/route-capability.js";
import type { RouteCapEntry } from "../auth/route-capability.js";
import {
  grantsAffectFlight,
  impliedFloorForCaps,
  maxSafetyClass,
} from "../auth/scopes.js";
import type { SafetyClass, ScopeGroup } from "../auth/scopes.js";
import type { NodeRef, PlatformPlane } from "../plane/platform-plane.js";
import { logger } from "../util/logger.js";
import type { ToolRegistry } from "./tools.js";

/** The capability id carried for audit on a plugin-tool route-cap entry. */
const PLUGIN_TOOL_CAPABILITY = "plugin.tool.invoke";

/** A plugin's description and input schema are echoed to the client verbatim, so
 * they are bounded: an oversized description is truncated and an oversized schema
 * is dropped (the permissive validator still accepts the call; only the ADVERTISED
 * schema is elided). Bounds a prompt-injection / oversized-payload surface. */
const MAX_TOOL_DESCRIPTION_CHARS = 512;
const MAX_INPUT_SCHEMA_BYTES = 16 * 1024;

/**
 * Map a plugin tool's declared safety class to the connector scope group + class.
 * The agent spells the flight class `flight_action`; the connector's class is
 * `flight`. An unknown / absent class maps to `admin` (fail-safe: an
 * unrecognized class needs at least admin, and the plugin's own capabilities
 * still bound the tool's real effect). A flight-class tool additionally sets
 * `affectsFlight`, so it is hidden until flight is enforced and never exposed to
 * a token without the flight scope.
 */
export function safetyToScope(raw: unknown): {
  scope: ScopeGroup;
  safetyClass: SafetyClass;
  affectsFlight: boolean;
} {
  switch (raw) {
    case "read":
      return { scope: "read", safetyClass: "read", affectsFlight: false };
    case "safe_write":
      return { scope: "safe_write", safetyClass: "safe_write", affectsFlight: false };
    case "flight_action":
    case "flight":
      return { scope: "flight", safetyClass: "flight", affectsFlight: true };
    case "destructive":
      return { scope: "destructive", safetyClass: "destructive", affectsFlight: false };
    case "admin":
    default:
      return { scope: "admin", safetyClass: "admin", affectsFlight: false };
  }
}

/** One discovered plugin tool, ready to register. */
export interface DiscoveredPluginTool {
  pluginId: string;
  toolName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  safetyClassRaw: unknown;
  /**
   * The plugin's granted platform capabilities. Every tool from one plugin
   * carries the same set; it floors the tool's scope at the plugin's real reach
   * so a self-declared `safety_class` cannot under-scope a high-impact tool.
   */
  grantedCapabilities: string[];
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Parse one plugin's detail (`GET /api/plugins/{id}`) into its agent-half MCP
 * tools. Only agent-half tools are registered here — they invoke over the
 * agent's per-plugin socket, the reach this connector drives. A plugin without
 * the `mcp.expose` capability, or with no tools, yields an empty list. Defensive
 * against a malformed detail (drops what it cannot read, never throws).
 */
export function toolsFromDetail(pluginId: string, detail: unknown): DiscoveredPluginTool[] {
  const d = asRecord(detail);
  if (!d) return [];
  // Exposure gate: the plugin must carry mcp.expose in its granted capabilities.
  const granted = Array.isArray(d.granted_capabilities) ? d.granted_capabilities : [];
  if (!granted.includes("mcp.expose")) return [];
  // The plugin's granted capabilities (string ids only) floor each tool's scope.
  const grantedCapabilities = granted.filter((c): c is string => typeof c === "string");
  const manifest = asRecord(d.manifest);
  const mcp = manifest ? asRecord(manifest.mcp) : undefined;
  const rawTools = mcp && Array.isArray(mcp.tools) ? mcp.tools : [];
  const out: DiscoveredPluginTool[] = [];
  for (const raw of rawTools) {
    const t = asRecord(raw);
    if (!t) continue;
    // Only agent-half tools invoke over the per-plugin socket. A gcs-half tool
    // routes through the GCS bridge (a later increment); skip it here.
    if (t.half !== "agent") continue;
    const name = asString(t.name);
    if (!name) continue;
    // The namespaced id is `${pluginId}:${toolName}`; a ":" in the tool name would
    // make that mapping non-injective (a:b + c vs a + b:c), so reject it.
    if (name.includes(":")) {
      logger.warn("dropping plugin tool with ':' in its name", { pluginId, name });
      continue;
    }
    const rawDescription = asString(t.title) ?? asString(t.description) ?? `Plugin tool ${name}`;
    const description =
      rawDescription.length > MAX_TOOL_DESCRIPTION_CHARS
        ? `${rawDescription.slice(0, MAX_TOOL_DESCRIPTION_CHARS)}…`
        : rawDescription;
    let inputSchema = asRecord(t.inputSchema);
    if (inputSchema && JSON.stringify(inputSchema).length > MAX_INPUT_SCHEMA_BYTES) {
      logger.warn("dropping oversized plugin tool input schema", { pluginId, name });
      inputSchema = undefined;
    }
    out.push({
      pluginId,
      toolName: name,
      description,
      inputSchema,
      safetyClassRaw: t.safety_class,
      grantedCapabilities,
    });
  }
  return out;
}

/** Register one discovered plugin tool into the registry + the dynamic route-cap. */
function registerOne(reg: ToolRegistry, tool: DiscoveredPluginTool): void {
  const nsName = `${tool.pluginId}:${tool.toolName}`;
  const declared = safetyToScope(tool.safetyClassRaw);
  // Floor the tool's class at what the plugin's GRANTED capabilities imply, so a
  // self-declared `safety_class` can never under-scope a tool below the plugin's
  // real reach (a plugin holding mavlink.write / vehicle.command / a mission-write
  // cap makes ALL its tools flight-class, whatever they declare). Never resolves
  // BELOW the declared class; a genuinely read-only plugin keeps its read tools.
  const floor = impliedFloorForCaps(tool.grantedCapabilities);
  const safetyClass: SafetyClass = floor
    ? maxSafetyClass(declared.safetyClass, floor)
    : declared.safetyClass;
  const scope: ScopeGroup = safetyClass;
  const affectsFlight =
    declared.affectsFlight ||
    safetyClass === "flight" ||
    grantsAffectFlight(tool.grantedCapabilities);
  const entry: RouteCapEntry = {
    tool: nsName,
    scope,
    capability: PLUGIN_TOOL_CAPABILITY,
    safetyClass,
    affectsFlight,
    // A plugin tool invokes over the agent's per-plugin socket; the GCS relay
    // has no such reach, so it is hidden in fleet-mode rather than always failing.
    agentModeOnly: true,
  };
  registerDynamicRouteCap(entry);
  reg.register({
    name: nsName,
    description: tool.description,
    // A permissive validator; the plugin validates its own arguments. The raw
    // manifest schema (when present) is what tools/list advertises.
    inputSchema: z.record(z.string(), z.unknown()),
    ...(tool.inputSchema ? { rawInputSchema: tool.inputSchema } : {}),
    handler: (args, ctx) => ctx.plane.invokePluginTool(ctx.node, tool.pluginId, tool.toolName, args),
  });
}

/**
 * Discover a node's plugin tools and register them. Returns the number of tools
 * registered. Best-effort: a plugin whose detail cannot be read is skipped, and
 * a duplicate registration (already present from a prior pass) is skipped rather
 * than throwing, so a refresh is idempotent. Call after clearing the dynamic
 * route-caps (the caller owns the refresh lifecycle).
 */
export async function registerPluginTools(
  reg: ToolRegistry,
  plane: PlatformPlane,
  node: NodeRef,
): Promise<number> {
  let installs: unknown;
  try {
    installs = await plane.getPlugins(node);
  } catch {
    // No plugin list (not agent-mode, or the agent is unreachable) — nothing to do.
    return 0;
  }
  const list = asRecord(installs);
  const rows = list && Array.isArray(list.installs) ? list.installs : [];
  let count = 0;
  for (const row of rows) {
    const r = asRecord(row);
    const pluginId = r ? asString(r.plugin_id) : undefined;
    if (!pluginId) continue;
    let detail: unknown;
    try {
      detail = await plane.getPluginInfo(node, pluginId);
    } catch {
      continue;
    }
    const discovered = toolsFromDetail(pluginId, detail);
    if (discovered.length === 0) {
      // A plugin that carries mcp.expose but yields no agent-half tools (gcs-half
      // only, or none) is a no-op here; surface it at debug so the gap is visible.
      const d = asRecord(detail);
      const granted = d && Array.isArray(d.granted_capabilities) ? d.granted_capabilities : [];
      if (granted.includes("mcp.expose")) {
        logger.debug("plugin exposes MCP but contributed no agent-half tools", { pluginId });
      }
      continue;
    }
    for (const tool of discovered) {
      const nsName = `${tool.pluginId}:${tool.toolName}`;
      if (reg.get(nsName)) continue; // already registered this pass
      registerOne(reg, tool);
      count += 1;
    }
  }
  return count;
}

/**
 * Re-discover a node's plugin tools from scratch. Drops EVERY prior plugin tool
 * and its dynamic route-cap, then registers the current set. Call whenever the
 * plugin set may have changed (enable / disable / install / remove or a manifest
 * edit) so a removed plugin's tool no longer lists and a changed safety class
 * re-floors correctly — a plain re-run of {@link registerPluginTools} would skip
 * already-registered names and leave a stale route-cap behind. Returns the number
 * of plugin tools now registered.
 */
export async function refreshPluginTools(
  reg: ToolRegistry,
  plane: PlatformPlane,
  node: NodeRef,
): Promise<number> {
  clearDynamicRouteCaps();
  reg.unregisterPluginTools();
  return registerPluginTools(reg, plane, node);
}
