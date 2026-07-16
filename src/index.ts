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
import { ConvexAuditSink } from "./audit/convex-sink.js";
import type { AuditSink } from "./audit/sink.js";
import { registerReadTools } from "./registry/read-tools.js";
import { registerReadResources } from "./registry/read-resources.js";
import { registerAdminTools } from "./registry/admin-tools.js";
import { registerFlightTools } from "./registry/flight-tools.js";
import { registerPluginTools } from "./registry/plugin-tools.js";
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
  // alongside the always-available stderr sink. In fleet-mode, a best-effort cloud
  // mirror also pushes a lean copy to Mission Control so the MCP tab shows one
  // cross-node history (it never blocks a tool call; the file remains authoritative).
  const auditSinks: AuditSink[] = [new FileAuditSink(config.auditPath)];
  if (config.mode === "fleet" && config.credential && config.convexUrl) {
    auditSinks.push(
      new ConvexAuditSink({ convexUrl: config.convexUrl, credential: config.credential }),
    );
  }
  const core = new ServerCore(config, { extraAuditSinks: auditSinks });

  // --verify: connect, check auth + reachability, print the result, exit. No server.
  if (args.verify) {
    await runVerify(core);
    return;
  }

  registerReadTools(core.tools, config.auditPath);
  registerReadResources(core.resources);
  registerAdminTools(core.tools);
  registerFlightTools(core.tools);
  registerReadPrompts(core.prompts);
  // Register the configured agent's plugin-contributed MCP tools. Agent-mode
  // only: a plugin tool invokes over the agent's per-plugin socket, which the
  // fleet relay has no reach for (the tools are agentModeOnly). Best-effort at
  // startup; an unreachable agent leaves the built-in tools intact. Dynamic
  // refresh on plugin enable/disable (list_changed) is a follow-on.
  if (config.mode === "agent") {
    try {
      const n = await registerPluginTools(core.tools, core.plane, config.nodeId ?? "agent");
      if (n > 0) logger.info("registered plugin tools", { count: n });
    } catch (err) {
      logger.warn("plugin tool registration failed", { error: String(err) });
    }
  }
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

/**
 * `--verify`: probe the bound plane's health, print a clear ✓/✗ + reason, and
 * exit 0 (ok) / 1 (not ok). A deterministic "does my setup work?" check the user
 * (and the GCS setup wizard) can run without an MCP client in the loop.
 */
async function runVerify(core: ServerCore): Promise<void> {
  const info = core.info();
  const h = await core.healthz();
  const label =
    info.mode === "fleet" ? "fleet mode" : info.mode === "local-fleet" ? "local fleet" : "agent mode";
  const where = `${label} → ${h.plane.target ?? info.target}`;
  if (h.ok) {
    process.stdout.write(`✓ Connected — ${where}\n`);
    if (info.mode === "fleet") {
      process.stdout.write(`  Your machine credential was verified against Mission Control.\n`);
    } else if (info.mode === "local-fleet" && h.plane.detail) {
      // e.g. "2/3 nodes reachable" — surface partial reachability even on ok.
      process.stdout.write(`  ${h.plane.detail}\n`);
    }
  } else {
    process.stdout.write(`✗ Not connected — ${where}\n`);
    process.stdout.write(`  ${h.plane.detail ?? "the target is unreachable"}\n`);
  }
  await core.close();
  process.exit(h.ok ? 0 : 1);
}

main().catch((err) => {
  logger.error("fatal", { err: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exit(1);
});
