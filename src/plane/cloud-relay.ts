// CloudRelayPlane: talks to the whole fleet through the cloud relay (the Convex
// heartbeat and command queue, and MQTT for live streams). This is fleet-mode's
// plane. Its full reach (Convex reads, command enqueue, MQTT subscriptions) is
// wired in the read plane phase; this scaffold implements the mode, description,
// and an honest health report, and refuses reads it cannot yet serve with a
// clear typed error rather than fabricating data (Rule 44).

import { GateError } from "../gate/errors.js";
import type { NodeRef, NodeStatus, PlaneHealth, PlaneMode, PlatformPlane } from "./platform-plane.js";

export interface CloudRelayConfig {
  /** The Convex deployment URL for the fleet backend. */
  convexUrl?: string;
  /** The MQTT broker URL for live streams. */
  mqttUrl?: string;
  /** The hosted fleet endpoint's public name, for the description. */
  endpoint?: string;
}

export class CloudRelayPlane implements PlatformPlane {
  readonly mode: PlaneMode = "fleet";

  constructor(private readonly config: CloudRelayConfig = {}) {}

  describe(): { mode: PlaneMode; target: string } {
    return { mode: this.mode, target: this.config.endpoint ?? this.config.convexUrl ?? "fleet" };
  }

  async health(): Promise<PlaneHealth> {
    if (!this.config.convexUrl) {
      return { ok: false, detail: "fleet backend not configured (convexUrl missing)" };
    }
    // Connectivity to the Convex and MQTT backends is exercised once the read
    // plane wires the clients; until then this reports configured-but-unverified.
    return {
      ok: false,
      detail: "cloud reach is wired in the read plane phase",
      target: this.config.convexUrl,
    };
  }

  async getStatus(_node: NodeRef): Promise<NodeStatus> {
    throw new GateError(
      "not_supported",
      "fleet-mode status read is wired in the read plane phase",
    );
  }
}
