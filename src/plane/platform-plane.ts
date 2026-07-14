// The PlatformPlane abstraction. Tool handlers call this interface, never a
// concrete plane. At launch, --target binds one of two adapters (LanDirectPlane
// for agent-mode, CloudRelayPlane for fleet-mode) and every handler runs
// unchanged against whichever is bound.
//
// The interface grows one method per platform verb as the phases land, so at
// every commit every declared method is implemented on both adapters. This
// module holds the read surface the server needs to prove its shape and health;
// the write verbs are added with the admin and flight planes.

export type PlaneMode = "agent" | "fleet";

/** Targeting primitive. In agent-mode it resolves to the one bound host; in
 * fleet-mode it names a device. A bare string is a hostname or deviceId. */
export type NodeRef = string;

export interface PlaneHealth {
  ok: boolean;
  /** A short reason when not ok, or a note when degraded. */
  detail?: string;
  /** The bound target, for the health readout. */
  target?: string;
}

/** The agent status document, passed through as the platform returns it. */
export type NodeStatus = Record<string, unknown>;

export interface PlatformPlane {
  readonly mode: PlaneMode;

  /** A human-readable description of what this plane reaches, for status. */
  describe(): { mode: PlaneMode; target: string };

  /** Whether the bound plane is currently reachable. Never throws. */
  health(): Promise<PlaneHealth>;

  /** Read the consolidated status for a node. */
  getStatus(node: NodeRef): Promise<NodeStatus>;
}
