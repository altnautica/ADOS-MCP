// The admin / ecosystem plane's tools (P2). Each is a thin wrapper over a
// PlatformPlane write or a deferred read. The pipeline enforces the scope and
// the safety class from the route-to-capability table (admin needs confirm:true;
// params.set on a flight-critical name escalates to the flight gate; config.set
// on a network path escalates to admin; services.restart on an armed-critical
// unit escalates to flight). Where a plane cannot serve a write over its reach
// (the GCS relay has no parameter/config write, no plugin install) it surfaces a
// typed not_supported naming the direct reach — an honest limit, never a stub.

import { z } from "zod";
import type { ToolRegistry } from "./tools.js";
import type { ToolDefinition } from "./types.js";

const NODE = z.string().optional().describe("Device id (fleet-mode) or host (agent-mode)");
// admin tools require confirm:true; escalatable ones also accept a signed confirm id.
const CONFIRM = z.boolean().optional().describe("Set true to confirm this administrative action");
const CONFIRM_ID = z.string().optional().describe("A signed confirm id, when the action escalates to flight");

const WRITE: ToolDefinition["annotations"] = { readOnlyHint: false, openWorldHint: true };
const READ: ToolDefinition["annotations"] = { readOnlyHint: true, openWorldHint: true };

/** Register the P2 admin / ecosystem tools. */
export function registerAdminTools(reg: ToolRegistry): void {
  const defs: ToolDefinition[] = [
    {
      name: "services.restart",
      description: "Restart one supervised service on the node (confirm required).",
      inputSchema: z.object({
        node: NODE,
        name: z.string().describe("The service unit name, e.g. ados-video."),
        confirm: CONFIRM,
        confirm_id: CONFIRM_ID,
      }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.restartService(ctx.node, String(a.name)),
    },
    {
      name: "admin.agent.restart_supervisor",
      description: "Restart the agent supervisor and its whole service tree (confirm required).",
      inputSchema: z.object({ node: NODE, confirm: CONFIRM }),
      annotations: WRITE,
      handler: (_a, ctx) => ctx.plane.restartSupervisor(ctx.node),
    },
    {
      name: "params.set",
      description:
        "Set one flight-controller parameter to a numeric value (confirm required; flight-critical names need the flight scope and a signed confirm).",
      inputSchema: z.object({
        node: NODE,
        name: z.string().describe("The parameter name."),
        value: z.number().describe("The new numeric value."),
        confirm: CONFIRM,
        confirm_id: CONFIRM_ID,
      }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.setParam(ctx.node, String(a.name), Number(a.value)),
    },
    {
      name: "config.set",
      description:
        "Set one agent configuration value by dotted key (network paths escalate to admin and need confirm).",
      inputSchema: z.object({
        node: NODE,
        key: z.string().describe("The dotted config key, e.g. video.bitrate."),
        value: z.string().describe("The new value (as a string)."),
        confirm: CONFIRM,
        confirm_id: CONFIRM_ID,
      }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.setConfig(ctx.node, String(a.key), String(a.value)),
    },
    {
      name: "plugins.install",
      description: "Install a plugin from a signed archive url with a sha256 pin (confirm required).",
      inputSchema: z.object({
        node: NODE,
        url: z.string().describe("The .adosplug archive url."),
        sha256: z.string().optional().describe("The expected sha256 of the archive."),
        confirm: CONFIRM,
      }),
      annotations: WRITE,
      handler: (a, ctx) =>
        ctx.plane.pluginInstall(ctx.node, String(a.url), typeof a.sha256 === "string" ? a.sha256 : undefined),
    },
    {
      name: "plugins.enable",
      description: "Enable an installed plugin by id (confirm required).",
      inputSchema: z.object({ node: NODE, id: z.string(), confirm: CONFIRM }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.pluginEnable(ctx.node, String(a.id)),
    },
    {
      name: "plugins.disable",
      description: "Disable an installed plugin by id (confirm required).",
      inputSchema: z.object({ node: NODE, id: z.string(), confirm: CONFIRM }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.pluginDisable(ctx.node, String(a.id)),
    },
    {
      name: "plugins.remove",
      description: "Remove an installed plugin by id, optionally keeping its data (confirm required).",
      inputSchema: z.object({
        node: NODE,
        id: z.string(),
        keep_data: z.boolean().optional(),
        confirm: CONFIRM,
      }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.pluginRemove(ctx.node, String(a.id), a.keep_data === true),
    },
    {
      name: "plugins.config",
      description: "Set one plugin configuration value (scope drone|global).",
      inputSchema: z.object({
        node: NODE,
        id: z.string(),
        key: z.string(),
        value: z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
        scope: z.enum(["drone", "global"]).optional(),
      }),
      annotations: WRITE,
      handler: (a, ctx) =>
        ctx.plane.pluginConfig(ctx.node, String(a.id), String(a.key), a.value, typeof a.scope === "string" ? a.scope : undefined),
    },
    {
      name: "plugins.list",
      description: "List installed plugins on the node.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.getPlugins(ctx.node),
    },
    {
      name: "plugins.info",
      description: "Read one installed plugin's detail and manifest.",
      inputSchema: z.object({ node: NODE, id: z.string() }),
      annotations: READ,
      handler: (a, ctx) => ctx.plane.getPluginInfo(ctx.node, String(a.id)),
    },
    {
      name: "logs.query",
      description: "Query the node's agent logs (optional level filter, bounded count).",
      inputSchema: z.object({
        node: NODE,
        level: z.string().optional().describe("Minimum level filter, e.g. warning."),
        limit: z.number().int().min(1).max(1000).optional().describe("Max entries (default 200)."),
      }),
      annotations: READ,
      handler: (a, ctx) =>
        ctx.plane.queryLogs(ctx.node, {
          ...(typeof a.level === "string" ? { level: a.level } : {}),
          ...(typeof a.limit === "number" ? { limit: a.limit } : {}),
        }),
    },
    // --- Node / platform administration (drone-direct only; agentModeOnly) ---
    {
      name: "admin.node.rename",
      description: "Set the node's display name (shown in pairing and the fleet card). Not the OS hostname.",
      inputSchema: z.object({ node: NODE, name: z.string(), confirm: CONFIRM, confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.renameNode(ctx.node, String(a.name)),
    },
    {
      name: "admin.pairing.info",
      description: "Read the node's pairing status and reach info.",
      inputSchema: z.object({ node: NODE }),
      annotations: READ,
      handler: (_a, ctx) => ctx.plane.getPairingInfo(ctx.node),
    },
    {
      name: "admin.pairing.generate_code",
      description: "Mint a fresh local pair code (while the node is unpaired).",
      inputSchema: z.object({ node: NODE, confirm: CONFIRM, confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: (_a, ctx) => ctx.plane.generatePairingCode(ctx.node),
    },
    {
      name: "admin.pairing.claim",
      description: "Claim an unpaired node for an operator (LAN presence is the auth boundary).",
      inputSchema: z.object({ node: NODE, user_id: z.string(), confirm: CONFIRM, confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.claimPairing(ctx.node, String(a.user_id)),
    },
    {
      name: "admin.pairing.unpair",
      description: "Release the node's pairing (invalidates credentials derived from the pairing key).",
      inputSchema: z.object({ node: NODE, confirm: CONFIRM, confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: (_a, ctx) => ctx.plane.unpairAgent(ctx.node),
    },
    {
      name: "admin.wfb.channel",
      description: "Set the WFB radio channel (agent validates against its allowed set).",
      inputSchema: z.object({ node: NODE, channel: z.number().int(), confirm: CONFIRM, confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.setWfbChannel(ctx.node, Number(a.channel)),
    },
    {
      name: "admin.wfb.tx_power",
      description: "Set WFB TX power in dBm (agent clamps to its configured ceiling).",
      inputSchema: z.object({ node: NODE, power_dbm: z.number().int(), confirm: CONFIRM, confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: (a, ctx) => ctx.plane.setWfbTxPower(ctx.node, Number(a.power_dbm)),
    },
    {
      name: "admin.network.wifi_join",
      description: "Join a management Wi-Fi network.",
      inputSchema: z.object({
        node: NODE,
        ssid: z.string(),
        passphrase: z.string().optional(),
        confirm: CONFIRM,
        confirm_id: CONFIRM_ID,
      }),
      annotations: WRITE,
      handler: (a, ctx) =>
        ctx.plane.joinWifi(
          ctx.node,
          String(a.ssid),
          typeof a.passphrase === "string" ? a.passphrase : undefined,
        ),
    },
    {
      name: "admin.network.wifi_leave",
      description: "Leave the current management Wi-Fi network.",
      inputSchema: z.object({ node: NODE, confirm: CONFIRM, confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: (_a, ctx) => ctx.plane.leaveWifi(ctx.node),
    },
  ];

  for (const def of defs) reg.register(def);
}
