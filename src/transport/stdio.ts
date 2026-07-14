// The stdio transport: the local one-liner Claude Code and Desktop spawn. The
// principal is resolved once at launch. A launch token is the credential for a
// remote target; on the agent's own box (a localhost target) local presence is
// the credential and the on-box principal applies. A remote target with no token
// is refused rather than run with full authority.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerCore } from "../server.js";
import type { ServerConfig } from "../config.js";
import { logger } from "../util/logger.js";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
// How often a long-lived stdio fleet session re-verifies its credential, so a
// revocation propagates within this window (HTTP re-auths per request).
const FLEET_REVERIFY_MS = 60_000;

function isLocalTarget(host: string): boolean {
  const bare = host.replace(/^https?:\/\//, "").replace(/:\d+$/, "").toLowerCase();
  return LOCAL_HOSTS.has(bare) || bare === "";
}

export async function startStdio(core: ServerCore, config: ServerConfig): Promise<void> {
  if (config.launchToken) {
    const principal = await core.authenticateBearer(config.launchToken);
    core.setFixedPrincipal(principal);
    logger.info("stdio principal resolved from launch token", { operator: principal.claims.operatorId });
  } else if (config.mode === "agent" && isLocalTarget(config.agentHost)) {
    core.setFixedPrincipal(core.onBoxContext());
    logger.info("stdio principal is on-box (localhost target, no token)");
  } else {
    throw new Error(
      "a bearer token is required for a remote target over stdio; pass --token or set ADOS_MCP_TOKEN",
    );
  }

  // A fleet-mode machine credential is revocable, but the stdio principal is
  // pinned once at launch, so re-verify it periodically and deauthorize the
  // session if it stops verifying (a revocation). HTTP re-auths per request.
  if (config.mode === "fleet" && config.launchToken) {
    const token = config.launchToken;
    const timer = setInterval(() => {
      void core
        .authenticateBearer(token)
        .then((p) => core.setFixedPrincipal(p))
        .catch(() => {
          core.setFixedPrincipal(null);
          logger.warn("stdio fleet credential no longer verifies; session deauthorized until relaunch");
        });
    }, FLEET_REVERIFY_MS);
    timer.unref();
  }

  const server = core.newServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio transport connected");
}
