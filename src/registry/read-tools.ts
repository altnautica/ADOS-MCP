// The read plane's tools. Each is a thin, honest wrapper over a PlatformPlane
// read: it calls the bound plane, and where the plane cannot serve a read it
// surfaces the plane's typed `not_supported` (naming the reach that does) rather
// than a fabricated value. Parameter reads join the vendored firmware-metadata
// floor so a value reads with meaning offline. Every call is scope-gated and
// audited by the pipeline; these handlers hold no policy of their own.

import { z } from "zod";
import type { ToolRegistry } from "./tools.js";
import type { ToolCtx, ToolDefinition } from "./types.js";
import type { DecodedParam, FirmwareType, ParamMetadata, VehicleClass } from "../param-metadata/loader.js";
import {
  decodeValue,
  joinParams,
  loadParamMetadata,
  paramsDifferingFromDefault,
} from "../param-metadata/loader.js";
import type { FirmwareHint, ParamEntry } from "../plane/platform-plane.js";
import { queryAuditFile } from "../audit/file-sink.js";

const NODE = z.string().optional().describe("Device id (fleet-mode) or host (agent-mode)");

const READ: ToolDefinition["annotations"] = { readOnlyHint: true, openWorldHint: true };

/** Convert a ParamEntry list to the {name: value} map the metadata join takes. */
function toValueMap(params: ParamEntry[]): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const p of params) out[p.name] = p.value;
  return out;
}

async function metadataFor(ctx: ToolCtx, hint?: FirmwareHint): Promise<Map<string, ParamMetadata>> {
  const h = hint ?? (await ctx.plane.firmwareHint(ctx.node));
  return loadParamMetadata({
    firmware: h.firmware as FirmwareType,
    ...(h.vehicleClass ? { vehicleClass: h.vehicleClass as VehicleClass } : {}),
  });
}

/** A deterministic, metadata-grounded range check — never a fabricated tuning number. */
function rangeObservation(p: DecodedParam): Array<Record<string, unknown>> {
  const r = p.metadata?.range;
  if (!r || typeof p.value !== "number") return [];
  if (p.value < r.min || p.value > r.max) {
    return [
      {
        name: p.name,
        current: p.value,
        ...(p.decoded ? { current_decoded: p.decoded } : {}),
        observation: `value ${p.value} is outside the documented range [${r.min}, ${r.max}]`,
        ...(p.metadata?.humanName ? { about: p.metadata.humanName } : {}),
      },
    ];
  }
  return [];
}

/** Register the P1 read tools. `auditPath` is the local audit file audit.query reads. */
export function registerReadTools(reg: ToolRegistry, auditPath: string): void {
  const defs: ToolDefinition[] = [
    {
      name: "status.get",
      description: "Read the node's consolidated status (link, FC, battery, mode, health).",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.getStatus(ctx.node),
    },
    {
      name: "status.full",
      description: "Read the node's full status document (every reported field).",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.getStatusFull(ctx.node),
    },
    {
      name: "status.system",
      description: "Read host resources: cpu, memory, disk, temperature, load, uptime.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.getSystem(ctx.node),
    },
    {
      name: "status.version",
      description: "Read the agent version and firmware identity for the node.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: async (_a, ctx) => {
        const s = (await ctx.plane.getStatus(ctx.node)) as Record<string, unknown>;
        const fw = await ctx.plane.firmwareHint(ctx.node).catch(() => ({ firmware: "unknown" }));
        return {
          agentVersion: s.agentVersion ?? s.version ?? null,
          board: s.board ?? null,
          firmware: fw,
        };
      },
    },
    {
      name: "status.health",
      description: "A rollup of the node's reachability and reported health state.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: async (_a, ctx) => {
        const health = await ctx.plane.health();
        const s = (await ctx.plane.getStatus(ctx.node).catch(() => ({}))) as Record<string, unknown>;
        return {
          reachable: health.ok,
          ...(health.detail ? { detail: health.detail } : {}),
          status: s.status ?? s.health ?? null,
          fcConnected: s.fcConnected ?? null,
          armed: s.armed ?? null,
        };
      },
    },
    {
      name: "status.ping",
      description: "A liveness probe: whether the node answers, with round-trip latency.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: async (_a, ctx) => {
        const started = Date.now();
        const health = await ctx.plane.health();
        return { reachable: health.ok, latencyMs: Date.now() - started, target: health.target ?? null };
      },
    },
    {
      name: "telemetry.snapshot",
      description: "A one-shot flight telemetry read: battery, gps, position, attitude, mode.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.getTelemetry(ctx.node),
    },
    {
      name: "services.list",
      description: "List the node's services and their running state.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.getServices(ctx.node),
    },
    {
      name: "vision.status",
      description: "Read the perception engine status: model, tier, detection state.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.getVision(ctx.node),
    },
    {
      name: "fleet.list_nodes",
      description: "List the nodes reachable through this connection, with a status summary.",
      inputSchema: z.object({}),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.listNodes(),
    },
    {
      name: "config.get",
      description: "Read the agent configuration document (secret-shaped fields redacted).",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      // The pipeline now redacts EVERY tool result against the token's secret_read
      // (not just this tool), so config.get returns the raw document and lets the
      // central choke point mask it — one redaction site, no double-marking.
      handler: (_a, ctx) => ctx.plane.getConfig(ctx.node),
    },
    {
      name: "params.read_all",
      description:
        "Read flight-controller parameters joined with firmware metadata (meaning, range, default). Filter with prefix or search; large sets are paged by limit.",
      inputSchema: z.object({
        node: NODE,
        prefix: z.string().optional().describe("Only parameters whose name starts with this."),
        search: z.string().optional().describe("Only parameters whose name contains this (case-insensitive)."),
        limit: z.number().int().min(1).max(2000).optional().describe("Max parameters returned (default 200)."),
      }),
      annotations: READ,
      handler: async (a, ctx) => {
        const prefix = typeof a.prefix === "string" ? a.prefix : undefined;
        const search = typeof a.search === "string" ? a.search.toLowerCase() : undefined;
        const limit = typeof a.limit === "number" ? a.limit : 200;
        // Fetch the firmware hint once, then params + metadata in parallel.
        const hint = await ctx.plane.firmwareHint(ctx.node);
        const [params, meta] = await Promise.all([ctx.plane.getParams(ctx.node), metadataFor(ctx, hint)]);
        let filtered = params;
        if (prefix) filtered = filtered.filter((p) => p.name.startsWith(prefix));
        if (search) filtered = filtered.filter((p) => p.name.toLowerCase().includes(search));
        const joined = joinParams(toValueMap(filtered), meta);
        return {
          firmware: hint.firmware,
          ...(hint.vehicleClass ? { vehicleClass: hint.vehicleClass } : {}),
          total: joined.length,
          returned: Math.min(joined.length, limit),
          params: joined.slice(0, limit),
        };
      },
    },
    {
      name: "params.get",
      description: "Read one flight-controller parameter with its decoded meaning and metadata.",
      inputSchema: z.object({ node: NODE, name: z.string().describe("The parameter name.") }),
      annotations: READ,
      handler: async (a, ctx) => {
        const name = String(a.name);
        const [entry, meta] = await Promise.all([ctx.plane.getParam(ctx.node, name), metadataFor(ctx)]);
        if (!entry) return { name, found: false };
        const m = meta.get(name);
        return {
          name,
          found: true,
          value: entry.value,
          ...(decodeValue(m, entry.value) ? { decoded: decodeValue(m, entry.value) } : {}),
          ...(m ? { metadata: m } : {}),
        };
      },
    },
    {
      name: "params.explain",
      description: "Explain a parameter's meaning (metadata + the node's current value) without changing it.",
      inputSchema: z.object({ node: NODE, name: z.string().describe("The parameter name.") }),
      annotations: READ,
      handler: async (a, ctx) => {
        const name = String(a.name);
        const meta = await metadataFor(ctx);
        const m = meta.get(name);
        const entry = await ctx.plane.getParam(ctx.node, name).catch(() => null);
        return {
          name,
          ...(m ? { metadata: m } : { metadata: null, note: "no metadata for this parameter in the bundled floor" }),
          ...(entry ? { currentValue: entry.value, decoded: decodeValue(m, entry.value) ?? null } : {}),
        };
      },
    },
    {
      name: "params.diff_from_default",
      description: "List the parameters whose value differs from the firmware default.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: async (_a, ctx) => {
        const [params, meta] = await Promise.all([ctx.plane.getParams(ctx.node), metadataFor(ctx)]);
        const diff = paramsDifferingFromDefault(toValueMap(params), meta);
        return { count: diff.length, params: diff };
      },
    },
    {
      name: "audit.query",
      description:
        "Query this MCP server's own local audit log (every tool call it made), newest first. Filter by tool, node, decision, or time.",
      inputSchema: z.object({
        tool: z.string().optional(),
        node: z.string().optional(),
        decision: z.enum(["allowed", "denied", "confirmed", "operator_absent"]).optional(),
        sinceMs: z.number().int().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      annotations: READ,
      handler: async (a) => {
        const events = await queryAuditFile(auditPath, {
          ...(typeof a.tool === "string" ? { tool: a.tool } : {}),
          ...(typeof a.node === "string" ? { node: a.node } : {}),
          ...(typeof a.decision === "string" ? { decision: a.decision } : {}),
          ...(typeof a.sinceMs === "number" ? { sinceMs: a.sinceMs } : {}),
          ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
        });
        return { count: events.length, events };
      },
    },
    {
      name: "audit.search",
      description:
        "Full-text search over this MCP server's own local audit log (tool name, node, operator, and result summary), newest first.",
      inputSchema: z.object({
        query: z.string().describe("Case-insensitive substring to match across the event."),
        decision: z.enum(["allowed", "denied", "confirmed", "operator_absent"]).optional(),
        sinceMs: z.number().int().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      annotations: READ,
      handler: async (a) => {
        const q = String(a.query).toLowerCase();
        const scanned = await queryAuditFile(auditPath, {
          ...(typeof a.decision === "string" ? { decision: a.decision } : {}),
          ...(typeof a.sinceMs === "number" ? { sinceMs: a.sinceMs } : {}),
          limit: 1000,
        });
        const match = (e: (typeof scanned)[number]): boolean =>
          [e.tool, e.node, e.operatorId, e.result].some(
            (s) => typeof s === "string" && s.toLowerCase().includes(q),
          );
        const limit = typeof a.limit === "number" ? a.limit : 200;
        const events = scanned.filter(match).slice(0, limit);
        return { count: events.length, events };
      },
    },
    {
      name: "params.optimize",
      description:
        "Read-only tuning advisory. Reads every FC parameter joined with firmware metadata and returns deterministic, metadata-grounded observations plus the joined data for the model to reason over. Writes nothing; applying a change is params.set.",
      inputSchema: z.object({
        node: NODE,
        focus: z.string().optional().describe("A focus area hint, e.g. vibration, tuning, battery."),
      }),
      annotations: READ,
      handler: async (a, ctx) => {
        const hint = await ctx.plane.firmwareHint(ctx.node);
        const [params, meta] = await Promise.all([ctx.plane.getParams(ctx.node), metadataFor(ctx, hint)]);
        const valueMap = toValueMap(params);
        const joined = joinParams(valueMap, meta);
        const diff = paramsDifferingFromDefault(valueMap, meta);
        const observations = joined.flatMap(rangeObservation);
        return {
          firmware: hint.firmware,
          ...(hint.vehicleClass ? { vehicleClass: hint.vehicleClass } : {}),
          ...(typeof a.focus === "string" ? { focus: a.focus } : {}),
          total: joined.length,
          differsFromDefault: diff.length,
          observations,
          params: joined,
          note: "Advisory only. Applying a change is params.set (confirm-gated; flight-critical names carry the flight gate).",
        };
      },
    },
  ];

  for (const def of defs) reg.register(def);
}
