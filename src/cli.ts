// Command-line parsing. Uses Node's built-in parseArgs (no dependency). The two
// launch shapes are `--target agent <host>` (agent-mode, one node on the LAN)
// and `--target fleet` (fleet-mode, the hosted fleet endpoint).

import { parseArgs } from "node:util";

export interface CliArgs {
  target: "agent" | "fleet";
  host?: string;
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
  help: boolean;
  version: boolean;
}

const USAGE = `ados-mcp - Model Context Protocol server for the ADOS drone platform

Usage:
  ados-mcp --target fleet --gcs prod [options]   Interface with Mission Control (the GCS)
  ados-mcp --target agent <host> [options]       Connect to one drone on the LAN

Options:
  --target <agent|fleet>   Deployment mode (required)
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
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });

  const target = values.target as "agent" | "fleet" | undefined;
  const transport = (values.transport as string) ?? "auto";
  const validTransports = ["auto", "stdio", "http", "unix"];
  if (!values.help && !values.version) {
    if (target !== "agent" && target !== "fleet") {
      throw new Error("--target must be 'agent' or 'fleet'");
    }
    if (!validTransports.includes(transport)) {
      throw new Error(`--transport must be one of ${validTransports.join(", ")}`);
    }
  }

  // In agent-mode the host may be given positionally after `agent` or via --host.
  let host: string | undefined;
  if (target === "agent") {
    host = positionals[0] ?? undefined;
  }

  return {
    target: (target ?? "agent") as "agent" | "fleet",
    host,
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
    help: Boolean(values.help),
    version: Boolean(values.version),
  };
}
