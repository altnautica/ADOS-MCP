#!/usr/bin/env node
// ADOS MCP entry point. Parses the CLI, resolves the config, builds the server
// core, and starts the selected transports. stdio runs alone (it owns stdout);
// http and the on-box Unix socket run together in a long-lived service.

import { parseCli, usage } from "./cli.js";
import { resolveConfig } from "./config.js";
import { ServerCore } from "./server.js";
import { startStdio } from "./transport/stdio.js";
import { startHttpServer, startUnixServer } from "./transport/http.js";
import { advertiseMdns, type MdnsHandle } from "./discovery/mdns.js";
import { FileAuditSink } from "./audit/file-sink.js";
import { registerReadTools } from "./registry/read-tools.js";
import { registerReadResources } from "./registry/read-resources.js";
import { registerAdminTools } from "./registry/admin-tools.js";
import { registerReadPrompts } from "./registry/read-prompts.js";
import { SERVER_VERSION } from "./version.js";
import { logger } from "./util/logger.js";
import type http from "node:http";

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (args.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const config = resolveConfig(args);
  // The durable audit store is a local file on the operator's machine, fanned in
  // alongside the always-available stderr sink.
  const core = new ServerCore(config, { extraAuditSinks: [new FileAuditSink(config.auditPath)] });
  registerReadTools(core.tools, config.auditPath);
  registerReadResources(core.resources);
  registerAdminTools(core.tools);
  registerReadPrompts(core.prompts);
  const info = core.info();
  logger.info("ados-mcp starting", {
    version: info.version,
    mcpRevision: info.mcpRevision,
    mode: info.mode,
    target: info.target,
    transports: [...config.transports],
  });

  const servers: http.Server[] = [];
  let mdns: MdnsHandle | null = null;

  if (config.transports.has("stdio")) {
    await startStdio(core, config);
  } else {
    if (config.transports.has("http")) {
      servers.push(await startHttpServer(core, config.httpPort));
    }
    if (config.transports.has("unix")) {
      // The on-box socket is an opportunistic convenience; if it cannot bind
      // (the run dir is absent, a dev host, a permissions issue) the HTTP
      // transport still serves, so a socket failure never stops the server.
      try {
        servers.push(await startUnixServer(core, config.unixSocketPath));
      } catch (err) {
        logger.warn(`on-box socket unavailable at ${config.unixSocketPath}, continuing`, {
          err: String(err),
        });
      }
    }
    mdns = advertiseMdns(config);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down`);
    try {
      if (mdns) await mdns.stop();
      await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
      await core.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal", { err: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exit(1);
});
