// Command-line parsing. Uses Node's built-in parseArgs (no dependency). The launch
// shapes are `--target agent <host>` (one LAN drone), `--target local-fleet
// <fleet.json>` (many LAN drones, no cloud), and `--target fleet` (the hosted
// cloud relay).

import { parseArgs } from "node:util";

export interface CliArgs {
  target: "agent" | "fleet" | "local-fleet";
  host?: string;
  /** The local-fleet file path (positional after `--target local-fleet`). */
  fleetFile?: string;
  token?: string;
  transport: "auto" | "stdio" | "http" | "unix";
  httpPort?: number;
  nodeId?: string;
  /** The GCS backend to reach (fleet-mode): local | prod | a Convex url. */
  gcs?: string;
  convexUrl?: string;
  mqttUrl?: string;
  fleetEndpoint?: string;
  /** Override the local audit file path. */
  auditPath?: string;
  sim: boolean;
  flightEnforced: boolean;
  mdns: boolean;
  /** local-fleet: browse the LAN and auto-adopt UNPAIRED drones (opt-in). */
  discover: boolean;
  /** Connect, verify auth/reachability, print the result, and exit (no server). */
  verify: boolean;
  help: boolean;
  version: boolean;
}

const USAGE = `ados-mcp - Model Context Protocol server for the ADOS drone platform

Usage:
  ados-mcp --target agent <host> [options]              Connect to one drone on the LAN (local-first)
  ados-mcp --target local-fleet <fleet.json> [options]  Connect to many LAN drones, no cloud
  ados-mcp --target fleet --gcs prod [options]          Reach your fleet remotely via Mission Control (cloud)

Options:
  --target <agent|local-fleet|fleet>   Deployment mode (required)
  --fleet-file <path>      The local-fleet file (default: ~/.ados/mcp/fleet.json; local-fleet)
  --gcs <local|prod|url>   The GCS Convex backend to reach (fleet-mode)
  --token <token>          The bearer for the launch principal: the operator
                           machine credential (fleet-mode) or an agent token
  --transport <mode>       auto | stdio | http | unix  (default: auto)
  --http-port <port>       Streamable HTTP port in agent-mode (default: 8091)
  --node-id <id>           This node's device id (agent-mode)
  --convex-url <url>       Explicit Convex deployment url (fleet-mode; --gcs is the shortcut)
  --mqtt-url <url>         MQTT broker url for live streams (fleet-mode)
  --fleet-endpoint <url>   Hosted endpoint name (fleet-mode)
  --audit-path <file>      Local audit file (default: ~/.ados/mcp/audit.ndjson)
  --sim                    Target is running in simulation (SITL)
  --flight-enforced        The MAVLink proxy enforce flag is confirmed on
  --no-mdns                Disable mDNS advertisement (agent-mode)
  --discover               local-fleet: browse the LAN and auto-adopt UNPAIRED
                           drones (self-claims their key). Off by default.
  --verify                 Connect, check auth + reachability, print the result,
                           and exit 0 (ok) or 1 (not ok). Does not start a server.
  --help                   Show this help
  --version                Show the version

Environment:
  ADOS_MCP_TOKEN           The bearer (the operator machine credential in fleet-mode)
  ADOS_CONVEX_URL          Convex url (alternative to --convex-url / --gcs)
  ADOS_MCP_AUDIT_PATH      Local audit file (alternative to --audit-path)
  ADOS_MCP_LOG_LEVEL       debug | info | warn | error  (default: info)
`;

export function usage(): string {
  return USAGE;
}

export function parseCli(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      target: { type: "string" },
      "fleet-file": { type: "string" },
      gcs: { type: "string" },
      token: { type: "string" },
      transport: { type: "string", default: "auto" },
      "http-port": { type: "string" },
      "node-id": { type: "string" },
      "convex-url": { type: "string" },
      "mqtt-url": { type: "string" },
      "fleet-endpoint": { type: "string" },
      "audit-path": { type: "string" },
      sim: { type: "boolean", default: false },
      "flight-enforced": { type: "boolean", default: false },
      "no-mdns": { type: "boolean", default: false },
      discover: { type: "boolean", default: false },
      verify: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });

  const target = values.target as CliArgs["target"] | undefined;
  const transport = (values.transport as string) ?? "auto";
  const validTransports = ["auto", "stdio", "http", "unix"];
  if (!values.help && !values.version) {
    if (target !== "agent" && target !== "fleet" && target !== "local-fleet") {
      throw new Error("--target must be 'agent', 'local-fleet', or 'fleet'");
    }
    if (!validTransports.includes(transport)) {
      throw new Error(`--transport must be one of ${validTransports.join(", ")}`);
    }
  }

  // agent: host positionally after `agent` (or --host). local-fleet: the fleet
  // file positionally after `local-fleet` (or --fleet-file).
  let host: string | undefined;
  let fleetFile: string | undefined;
  if (target === "agent") {
    host = positionals[0] ?? undefined;
  } else if (target === "local-fleet") {
    fleetFile = (values["fleet-file"] as string | undefined) ?? positionals[0] ?? undefined;
  }

  return {
    target: (target ?? "agent") as CliArgs["target"],
    host,
    fleetFile,
    token: values.token as string | undefined,
    transport: transport as CliArgs["transport"],
    httpPort: values["http-port"] ? Number(values["http-port"]) : undefined,
    nodeId: values["node-id"] as string | undefined,
    gcs: values.gcs as string | undefined,
    convexUrl: values["convex-url"] as string | undefined,
    mqttUrl: values["mqtt-url"] as string | undefined,
    fleetEndpoint: values["fleet-endpoint"] as string | undefined,
    auditPath: values["audit-path"] as string | undefined,
    sim: Boolean(values.sim),
    flightEnforced: Boolean(values["flight-enforced"]),
    mdns: !values["no-mdns"],
    discover: Boolean(values.discover),
    verify: Boolean(values.verify),
    help: Boolean(values.help),
    version: Boolean(values.version),
  };
}
