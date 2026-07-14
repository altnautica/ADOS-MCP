// The P4 flight tools. Only the six commands the agent's /api/command actually
// accepts are registered (arm/disarm/takeoff/land/rtl/mode); goto, emergency_stop,
// and the mission ops have no reachable agent endpoint yet and stay forward-seams
// (they must NOT be faked). Every flight tool is hidden unless the operator sets
// the flight-enforce affirmation, requires the flight scope, and passes the safety
// gate (operator-present OR a signed confirm OR --sim). The result is HONEST: the
// agent returns HTTP 200 even for a DENIED COMMAND_ACK, so flightResult downgrades
// `ok` to the FC's `ack.accepted` and surfaces the denial reason.

import { z } from "zod";
import type { ToolRegistry } from "./tools.js";
import type { ToolDefinition } from "./types.js";
import type { CommandOutcome } from "../plane/platform-plane.js";

const NODE = z.string().optional().describe("Device id (fleet-mode) or host (agent-mode)");
const CONFIRM_ID = z
  .string()
  .optional()
  .describe(
    "A one-time operator signed-confirm id bound to this call. Required unless the target is SITL (--sim) or a fresh operator-present signal exists.",
  );
const WRITE: ToolDefinition["annotations"] = { readOnlyHint: false, openWorldHint: true };

interface AckBlock {
  observed?: boolean;
  accepted?: boolean;
  result_name?: string;
  statustext?: string;
}

/**
 * Turn a flight CommandOutcome into an honest result. The agent's /api/command
 * returns `status:"ok"` (HTTP 200) even when the FC REJECTS the command, so `ok`
 * here means "the FC accepted it" (ack.accepted), not merely "it was delivered".
 */
function flightResult(o: CommandOutcome, cmd: string): Record<string, unknown> {
  const ack = ((o.data as { ack?: AckBlock } | undefined)?.ack ?? {}) as AckBlock;
  return {
    ok: o.ok && ack.accepted === true,
    cmd,
    delivered: o.ok,
    acked: ack.observed === true,
    accepted: ack.accepted === true,
    ...(ack.result_name ? { result: ack.result_name } : {}),
    ...(ack.statustext ? { reason: ack.statustext } : {}),
    ...(o.message ? { message: o.message } : {}),
    raw: o.data,
  };
}

/** Register the six flight commands the agent's /api/command vocabulary supports. */
export function registerFlightTools(reg: ToolRegistry): void {
  const simple: Array<{ name: string; cmd: string; description: string }> = [
    { name: "flight.arm", cmd: "arm", description: "Arm the vehicle." },
    { name: "flight.disarm", cmd: "disarm", description: "Disarm the vehicle." },
    { name: "flight.land", cmd: "land", description: "Command the vehicle to land." },
    { name: "flight.rtl", cmd: "rtl", description: "Return to launch." },
  ];

  const defs: ToolDefinition[] = [
    ...simple.map(
      ({ name, cmd, description }): ToolDefinition => ({
        name,
        description: `${description} Requires the flight scope and an operator-present or signed confirm (or --sim).`,
        inputSchema: z.object({ node: NODE, confirm_id: CONFIRM_ID }),
        annotations: WRITE,
        handler: async (_a, ctx) => flightResult(await ctx.plane.sendFlightCommand(ctx.node, cmd, []), cmd),
      }),
    ),
    {
      name: "flight.takeoff",
      description: "Takeoff to an altitude AGL in metres. Requires the flight scope + confirm/sim.",
      inputSchema: z.object({ node: NODE, altitude_m: z.number().positive().max(500), confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: async (a, ctx) =>
        flightResult(await ctx.plane.sendFlightCommand(ctx.node, "takeoff", [Number(a.altitude_m)]), "takeoff"),
    },
    {
      name: "flight.mode",
      description: "Set the flight mode by name (e.g. GUIDED, RTL, LOITER). Requires the flight scope + confirm/sim.",
      inputSchema: z.object({ node: NODE, mode: z.string().min(1), confirm_id: CONFIRM_ID }),
      annotations: WRITE,
      handler: async (a, ctx) =>
        flightResult(await ctx.plane.sendFlightCommand(ctx.node, "mode", [String(a.mode)]), "mode"),
    },
  ];

  for (const def of defs) reg.register(def);
}
