// The read plane's resources. Each `ados://<node>/<kind>` resource mirrors a
// read tool as a first-class MCP resource, so an AI client can subscribe to a
// node's status without a tool round-trip. The node is parsed from the uri by
// the pipeline (which gates + audits the read) and passed on ctx.node; the read
// handler just projects the bound plane. Subscriptions land with the streaming
// phase; these are read-once for now.

import type { ResourceRegistry } from "./resources.js";
import type { ResourceDefinition, ToolCtx } from "./types.js";

/** Parse `ados://<node>/<kind>` into its node and kind, or null if it is not one. */
export function parseAdosUri(uri: string): { node: string; kind: string } | null {
  const m = /^ados:\/\/([^/]+)\/([^/?#]+)/.exec(uri);
  if (!m) return null;
  return { node: decodeURIComponent(m[1]!), kind: m[2]! };
}

const JSON_MIME = "application/json";

function resource(
  kind: string,
  name: string,
  description: string,
  read: (ctx: ToolCtx) => Promise<unknown>,
): ResourceDefinition {
  return {
    uriTemplate: `ados://{node}/${kind}`,
    name,
    description,
    mimeType: JSON_MIME,
    subscribable: false,
    read: (_uri, ctx) => read(ctx),
  };
}

export function registerReadResources(reg: ResourceRegistry): void {
  const defs: ResourceDefinition[] = [
    resource("status", "Node status", "The node's consolidated status document.", (ctx) =>
      ctx.plane.getStatus(ctx.node),
    ),
    resource("telemetry", "Node telemetry", "The node's flight telemetry snapshot.", (ctx) =>
      ctx.plane.getTelemetry(ctx.node),
    ),
    resource("system", "Node system", "The node's host resource snapshot.", (ctx) =>
      ctx.plane.getSystem(ctx.node),
    ),
    resource("services", "Node services", "The node's services and their state.", (ctx) =>
      ctx.plane.getServices(ctx.node),
    ),
    resource("vision", "Node vision", "The node's perception engine status.", (ctx) =>
      ctx.plane.getVision(ctx.node),
    ),
    resource("params", "Node parameters", "The node's flight-controller parameters.", (ctx) =>
      ctx.plane.getParams(ctx.node),
    ),
  ];
  for (const def of defs) reg.register(def);
}
