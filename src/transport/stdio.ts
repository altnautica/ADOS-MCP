// The stdio transport: the local one-liner Claude Code and Desktop spawn. The
// principal is resolved once at launch. LOCAL-FIRST: a client that
// spawns this server over stdio is the operator's own process on the operator's
// own box, so for a LAN target (loopback, RFC1918, or an mDNS .local drone) local
// presence is the credential and the on-box principal applies with NO token — the
// drone's own pairing key (X-ADOS-Key) authorizes the data path separately, and
// flight stays refused unless --flight-enforced is set. Only a PUBLIC/routable
// target needs a launch token, so full authority is never granted to an off-LAN
// address by presence alone. A fleet-mode credential is still the fleet path.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerCore } from "../server.js";
import type { ServerConfig } from "../config.js";
import { logger } from "../util/logger.js";
import { isPrivateOrLocalHost } from "../util/cidr.js";

// How often a long-lived stdio fleet session re-verifies its credential, so a
// revocation propagates within this window (HTTP re-auths per request).
const FLEET_REVERIFY_MS = 60_000;

export async function startStdio(core: ServerCore, config: ServerConfig): Promise<void> {
  // local-fleet is always on-box over stdio: there is no single host to classify,
  // and every per-node call is authorized by that node's own pairing key from the
  // fleet file. agent-mode is on-box for a LAN target; a public host needs a token.
  const localTarget =
    config.mode === "local-fleet" ||
    (config.mode === "agent" && isPrivateOrLocalHost(config.agentHost));
  if (config.launchToken) {
    const principal = await core.authenticateBearer(config.launchToken);
    core.setFixedPrincipal(principal);
    logger.info("stdio principal resolved from launch token", { operator: principal.claims.operatorId });
  } else if (localTarget) {
    core.setFixedPrincipal(core.onBoxContext());
    logger.info("stdio principal is on-box (LAN target, no token)", { host: config.agentHost });
  } else {
    throw new Error(
      "a bearer token is required for a public/remote target over stdio; pass --token or set ADOS_MCP_TOKEN. " +
        "A drone on your LAN (loopback, RFC1918, or an mDNS .local host) connects with no token — its pairing key authorizes it.",
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
