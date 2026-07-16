// The tool registry. Holds tool definitions, answers tools/list filtered by a
// token's scopes, and enforces that every registered tool has a route-to-
// capability row. Flight tools are additionally hidden while the MAVLink proxy
// enforce flag is off, so a downgrade removes the tools rather than un-gating
// them silently.

import { z } from "zod";
import { routeCapFor } from "../auth/route-capability.js";
import { scopeCoversTool } from "../gate/scope-check.js";
import type { PublicToolInfo, ToolDefinition } from "./types.js";
import type { TokenClaims } from "../auth/token.js";

export interface ToolListContext {
  claims: TokenClaims;
  /** True once the raw MAVLink proxy enforce flag is confirmed on. */
  flightEnforced: boolean;
  /** True in fleet-mode (tools that are agent-mode-only are hidden). */
  fleetMode: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new Error(`duplicate tool registration: ${def.name}`);
    }
    if (!routeCapFor(def.name)) {
      throw new Error(
        `tool ${def.name} has no route-to-capability row; add one to route-capability.ts`,
      );
    }
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Remove a tool by name (no-op if absent). Used to prune a plugin tool. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Remove every plugin tool. A plugin tool's name is `${pluginId}:${tool}`, so
   * it contains a ":", which a built-in tool name never does. Called before a
   * plugin-tool refresh so a disabled/removed plugin's tools do not linger in
   * tools/list and a changed safety class does not persist as a stale entry.
   */
  unregisterPluginTools(): void {
    for (const name of [...this.tools.keys()]) {
      if (name.includes(":")) this.tools.delete(name);
    }
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  size(): number {
    return this.tools.size;
  }

  /** The names of registered tools, for the completeness check. */
  names(): string[] {
    return [...this.tools.keys()];
  }

  /** tools/list, filtered to what this token may actually invoke. */
  listFor(ctx: ToolListContext): PublicToolInfo[] {
    const out: PublicToolInfo[] = [];
    for (const def of this.tools.values()) {
      const entry = routeCapFor(def.name);
      if (!entry) continue;
      if (!scopeCoversTool(ctx.claims.scopes, entry)) continue;
      // Any tool that changes in-flight behavior is hidden until the enforce
      // flag is on, whether its class is flight or (like emergency_stop) destructive.
      if ((entry.scope === "flight" || entry.affectsFlight) && !ctx.flightEnforced) continue;
      // A drone-direct-only tool cannot be served over the GCS relay, so it is
      // hidden in fleet-mode rather than advertised only to always fail.
      if (entry.agentModeOnly && ctx.fleetMode) continue;
      out.push(this.toPublic(def));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private toPublic(def: ToolDefinition): PublicToolInfo {
    return {
      name: def.name,
      description: def.description,
      inputSchema:
        def.rawInputSchema ?? (z.toJSONSchema(def.inputSchema) as Record<string, unknown>),
      ...(def.annotations ? { annotations: def.annotations } : {}),
    };
  }
}
