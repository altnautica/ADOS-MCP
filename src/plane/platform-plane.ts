// The PlatformPlane abstraction. Tool handlers call this interface, never a
// concrete plane. At launch, --target binds one of two adapters (LanDirectPlane
// for agent-mode, GcsPlane for fleet-mode) and every handler runs unchanged
// against whichever is bound.
//
// The interface grows one method per platform verb as the phases land, so at
// every commit every declared method is implemented on both adapters. This
// module holds the read surface; the write verbs are added with the admin and
// flight planes. Where a plane genuinely cannot serve a read (params are not in
// the GCS relay vocabulary), the method throws a typed `not_supported` GateError
// naming the reach that does serve it — an honest capability limit, never a stub
// nor a fabricated reading.

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

/** One flight-controller parameter as the platform reports it. */
export interface ParamEntry {
  name: string;
  value: number | string | boolean;
  /** The platform's type hint when it gives one (e.g. FLOAT / INT32). */
  type?: string;
}

/**
 * The outcome of a write/command. In fleet-mode it is the terminal state of the
 * async relay round-trip (enqueue then poll the ack); in agent-mode it is the
 * direct REST response. `ok` is true only on a successful completion.
 */
export interface CommandOutcome {
  ok: boolean;
  status: "completed" | "failed" | "queued" | "timeout";
  message?: string;
  data?: unknown;
  /** The relay command id, in fleet-mode, for correlation. */
  commandId?: string;
}

/**
 * The principal a fleet-mode credential resolves to. In fleet-mode the bearer is
 * an opaque machine credential the GCS minted; the plane verifies it against the
 * backend and returns the operator it belongs to and the scopes + node allowlist
 * it carries. `null` means the credential is invalid, revoked, or expired.
 */
export interface CredentialPrincipal {
  userId: string;
  scopes: string[];
  allowedNodes: string[];
}

/** A firmware hint so the reader can pick the right parameter-metadata snapshot. */
export interface FirmwareHint {
  /** ardupilot | px4 | betaflight | inav | unknown. */
  firmware: string;
  /** copter | plane | rover | sub, when known. */
  vehicleClass?: string;
  /** The firmware version string when the platform reports it. */
  version?: string;
}

/** A fleet-list row: one node the operator owns, with a display-safe summary. */
export interface NodeSummary {
  deviceId: string;
  name?: string;
  /** True when the node's last heartbeat is recent. */
  online?: boolean;
  lastSeen?: number;
  agentVersion?: string;
  board?: string;
  tier?: string;
  profile?: string;
  fcConnected?: boolean;
  /** Battery remaining percent when the heartbeat carries it (null = unknown). */
  battery?: number | null;
  mode?: string;
  armed?: boolean;
}

export interface PlatformPlane {
  readonly mode: PlaneMode;

  /** A human-readable description of what this plane reaches, for status. */
  describe(): { mode: PlaneMode; target: string };

  /** Whether the bound plane is currently reachable. Never throws. */
  health(): Promise<PlaneHealth>;

  /**
   * Verify a fleet-mode machine credential against the backend, returning its
   * principal or null. Agent-mode planes (no backend) return null; agent-mode
   * auth is the self-contained token path, not this.
   */
  verifyCredential(credential: string): Promise<CredentialPrincipal | null>;

  /** Read the consolidated status for a node. */
  getStatus(node: NodeRef): Promise<NodeStatus>;

  /** Read the fuller status document (more fields than getStatus). */
  getStatusFull(node: NodeRef): Promise<NodeStatus>;

  /** Read the host resource snapshot (cpu / memory / disk / temperature). */
  getSystem(node: NodeRef): Promise<NodeStatus>;

  /** Read the flight telemetry snapshot (battery / gps / position / attitude). */
  getTelemetry(node: NodeRef): Promise<NodeStatus>;

  /** Read the perception / vision engine status. */
  getVision(node: NodeRef): Promise<NodeStatus>;

  /** Read the process / service list (unit, state). */
  getServices(node: NodeRef): Promise<NodeStatus>;

  /** Read the full flight-controller parameter set. */
  getParams(node: NodeRef): Promise<ParamEntry[]>;

  /** Read one flight-controller parameter by name (null when absent). */
  getParam(node: NodeRef, name: string): Promise<ParamEntry | null>;

  /** Read the agent configuration document. */
  getConfig(node: NodeRef): Promise<NodeStatus>;

  /** A firmware hint for the parameter-metadata join. */
  firmwareHint(node: NodeRef): Promise<FirmwareHint>;

  /** List the nodes this plane reaches (one in agent-mode; the fleet otherwise). */
  listNodes(): Promise<NodeSummary[]>;

  // --- Admin / ecosystem writes (P2). A plane that cannot serve one over its
  // reach throws a typed not_supported naming the reach that can. ---

  /** Restart one supervised service by unit name. */
  restartService(node: NodeRef, unit: string): Promise<CommandOutcome>;

  /** Restart the whole agent supervisor (and its service tree). */
  restartSupervisor(node: NodeRef): Promise<CommandOutcome>;

  /** Set one flight-controller parameter to a numeric value. */
  setParam(node: NodeRef, name: string, value: number): Promise<CommandOutcome>;

  /** Set one agent configuration value by dotted key. */
  setConfig(node: NodeRef, key: string, value: string): Promise<CommandOutcome>;

  /** Install a plugin from a signed archive url with a sha256 pin. */
  pluginInstall(node: NodeRef, url: string, sha256?: string): Promise<CommandOutcome>;

  /** Enable an installed plugin by id. */
  pluginEnable(node: NodeRef, id: string): Promise<CommandOutcome>;

  /** Disable an installed plugin by id. */
  pluginDisable(node: NodeRef, id: string): Promise<CommandOutcome>;

  /** Remove an installed plugin by id (optionally keeping its data). */
  pluginRemove(node: NodeRef, id: string, keepData?: boolean): Promise<CommandOutcome>;

  /** Set one plugin config value (scope drone|global). */
  pluginConfig(node: NodeRef, id: string, key: string, value: unknown, scope?: string): Promise<CommandOutcome>;

  // --- Reads the read plane deferred to the admin plane ---

  /** List installed plugins. */
  getPlugins(node: NodeRef): Promise<unknown>;

  /** Read one installed plugin's detail. */
  getPluginInfo(node: NodeRef, id: string): Promise<unknown>;

  /**
   * Run one of a plugin's declared MCP tools and return its result. Drone-direct
   * only (the GCS relay has no synchronous plugin-tool invocation), so the GCS
   * plane throws `not_supported`.
   */
  invokePluginTool(
    node: NodeRef,
    id: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;

  /** Query agent logs (optional level filter, bounded count). */
  queryLogs(node: NodeRef, opts?: { level?: string; limit?: number }): Promise<unknown>;

  // --- Node / platform administration (P2, drone-direct only) ---

  /** Set the node's display name (the name shown in pairing + the fleet card).
   * NOT the OS hostname — that is fixed at install time. */
  renameNode(node: NodeRef, name: string): Promise<CommandOutcome>;
  /** Read the node's pairing status + reach info. */
  getPairingInfo(node: NodeRef): Promise<unknown>;
  /** Mint a fresh local pair code (while unpaired). */
  generatePairingCode(node: NodeRef): Promise<unknown>;
  /** Claim an unpaired agent for an operator (LAN presence is the auth boundary). */
  claimPairing(node: NodeRef, userId: string): Promise<CommandOutcome>;
  /** Release the pairing (invalidates credentials derived from the pairing key). */
  unpairAgent(node: NodeRef): Promise<CommandOutcome>;
  /** Set the WFB radio channel. */
  setWfbChannel(node: NodeRef, channel: number): Promise<CommandOutcome>;
  /** Set WFB TX power (dBm; the agent clamps to its configured ceiling). */
  setWfbTxPower(node: NodeRef, powerDbm: number): Promise<CommandOutcome>;
  /** Join a management Wi-Fi network. */
  joinWifi(node: NodeRef, ssid: string, passphrase?: string): Promise<CommandOutcome>;
  /** Leave the current management Wi-Fi. */
  leaveWifi(node: NodeRef): Promise<CommandOutcome>;

  // --- Flight (P4, gated: flight scope + operator-present/signed-confirm/sim) ---

  /**
   * Send one high-level flight command to the FC and return the correlated
   * outcome. `cmd` is one of arm|disarm|takeoff|land|rtl|mode; `args` is the
   * agent `/api/command` arg list (takeoff: [altitude_m], mode: [mode_name],
   * others: []). The outcome's `data` carries the FC COMMAND_ACK block
   * ({observed,result,result_name,accepted,statustext?}) — a caller reads
   * `ack.accepted`, never assumes the command was accepted just because it
   * was delivered.
   */
  sendFlightCommand(node: NodeRef, cmd: string, args: (number | string)[]): Promise<CommandOutcome>;
}
