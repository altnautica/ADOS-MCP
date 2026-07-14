// Agent-mode mDNS advertisement of _ados-mcp._tcp. The advertised host is the
// real system hostname (what avahi actually publishes as <host>.local), never a
// synthesized name that would not resolve. The TXT record carries fields a client
// can filter on before it has a token. Discovery is best-effort; a failure to
// advertise never stops the server.

import os from "node:os";
import { Bonjour } from "bonjour-service";
import { MCP_SPEC_REVISION } from "../version.js";
import { logger } from "../util/logger.js";
import type { ServerConfig } from "../config.js";

export interface MdnsHandle {
  stop(): Promise<void>;
}

export function advertiseMdns(config: ServerConfig): MdnsHandle | null {
  if (!config.mdns) return null;
  // Lead with the real avahi-published system hostname. If an explicit hostname
  // override is given it must itself be a resolvable name, not a constructed one;
  // the default is os.hostname(), which avahi publishes.
  const host = config.mdnsHostname ?? os.hostname();
  try {
    const bonjour = new Bonjour();
    bonjour.publish({
      name: host,
      type: "ados-mcp",
      protocol: "tcp",
      port: config.httpPort,
      host: `${host}.local`,
      txt: {
        version: MCP_SPEC_REVISION,
        device_id: config.nodeId ?? "",
        name: host,
        profile: config.mode,
        paired: config.pairingKey ? "1" : "0",
      },
    });
    logger.info(`mDNS advertising _ados-mcp._tcp on ${host}.local:${config.httpPort}`);
    return {
      stop: () =>
        new Promise<void>((resolve) => {
          bonjour.unpublishAll(() => {
            bonjour.destroy();
            resolve();
          });
        }),
    };
  } catch (err) {
    logger.warn(`mDNS advertisement failed (continuing without it): ${String(err)}`);
    return null;
  }
}
