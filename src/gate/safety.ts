// The safety gate: the per-call check that runs after a token is verified and
// scoped. A well-behaved AI client is helpful but never trusted to enforce
// safety, so the server enforces here.
//
//   read / safe_write : scope only.
//   admin             : a `confirm: true` boolean in the arguments.
//   flight            : the flight scope + (operator-present OR a signed confirm
//                       OR sim) + per-tool preconditions.
//   destructive       : a fixed typed-confirm phrase in the arguments.
//
// The operator-present and signed-confirm providers are pluggable; the flight
// path is fully exercised once the flight tools land, but the mechanism is here
// so no flight tool can ship without passing through it.

import { GateError, type ErrorReason } from "./errors.js";
import type { SafetyClass } from "../auth/scopes.js";

// Fixed uppercase phrases for the destructive tools. A phrase is a plain string,
// never generated, so it is obvious in an audit and hard to submit by accident.
export const DESTRUCTIVE_PHRASES: Record<string, string> = {
  "system.reboot": "REBOOT THIS NODE",
  "system.shutdown": "SHUTDOWN THIS NODE",
  "system.factory_reset": "FACTORY RESET THIS NODE",
  "params.reset_all": "RESET ALL PARAMS ON THIS NODE",
  "flight.emergency_stop": "EMERGENCY STOP THIS AIRCRAFT",
};

export interface OperatorPresence {
  /** Presence for a node: present flag + age of the last heartbeat in ms. */
  status(node: string): { present: boolean; ageMs: number };
}

/** Default: no operator is ever present. Flight refuses without a signed confirm. */
export const NO_OPERATOR_PRESENT: OperatorPresence = {
  status: () => ({ present: false, ageMs: Number.POSITIVE_INFINITY }),
};

export interface SignedConfirm {
  /** Consume a one-time signed confirm for (tool, node, argsHash). */
  consume(input: { confirmId: string; tool: string; node: string; argsHash: string }): boolean;
}

/** Default: no signed-confirm backend. The admin/destructive inline paths still work. */
export const NO_SIGNED_CONFIRM: SignedConfirm = { consume: () => false };

// Operator-present freshness window (ms). A stale heartbeat suspends flight.
export const OPERATOR_PRESENT_WINDOW_MS = 10_000;

export interface SafetyContext {
  tool: string;
  node: string;
  safetyClass: SafetyClass;
  args: Record<string, unknown>;
  argsHash: string;
  sim: boolean;
  operatorPresent: OperatorPresence;
  signedConfirm: SignedConfirm;
}

export interface SafetyDecision {
  decision: "allowed" | "confirmed";
}

export class SafetyGate {
  evaluate(ctx: SafetyContext): SafetyDecision {
    switch (ctx.safetyClass) {
      case "read":
      case "safe_write":
        return { decision: "allowed" };
      case "admin":
        return this.adminGate(ctx);
      case "flight":
        return this.flightGate(ctx);
      case "destructive":
        return this.destructiveGate(ctx);
      default:
        throw new GateError("not_supported", `unknown safety class ${String(ctx.safetyClass)}`);
    }
  }

  private adminGate(ctx: SafetyContext): SafetyDecision {
    if (ctx.args.confirm !== true) {
      throw new GateError("confirm_required", `${ctx.tool} requires confirm: true`, {
        tool: ctx.tool,
      });
    }
    return { decision: "confirmed" };
  }

  private destructiveGate(ctx: SafetyContext): SafetyDecision {
    const phrase = DESTRUCTIVE_PHRASES[ctx.tool];
    if (!phrase) {
      // A destructive tool with no registered phrase is a build error, surfaced
      // as a refusal rather than an accidental allow.
      throw new GateError("not_supported", `${ctx.tool} has no confirm phrase configured`);
    }
    if (ctx.args.confirm !== phrase) {
      throw new GateError(
        "confirm_required",
        `${ctx.tool} requires the exact typed phrase`,
        { tool: ctx.tool, phrase },
      );
    }
    return { decision: "confirmed" };
  }

  private flightGate(ctx: SafetyContext): SafetyDecision {
    // The scope check (token holds `flight`) already ran in the pipeline. Here we
    // require a live human signal: operator-present, or a signed confirm, or sim.
    if (ctx.sim) return { decision: "confirmed" };

    const confirmId = typeof ctx.args.confirm_id === "string" ? ctx.args.confirm_id : undefined;
    if (confirmId) {
      const ok = ctx.signedConfirm.consume({
        confirmId,
        tool: ctx.tool,
        node: ctx.node,
        argsHash: ctx.argsHash,
      });
      if (ok) return { decision: "confirmed" };
      throw new GateError("confirm_required", `${ctx.tool} signed confirm was invalid or expired`, {
        tool: ctx.tool,
      });
    }

    const presence = ctx.operatorPresent.status(ctx.node);
    if (presence.present && presence.ageMs <= OPERATOR_PRESENT_WINDOW_MS) {
      return { decision: "confirmed" };
    }
    const reason: ErrorReason = "operator_present_stale";
    throw new GateError(
      reason,
      `${ctx.tool} needs a fresh operator-present signal or a signed confirm`,
      { tool: ctx.tool, node: ctx.node },
    );
  }
}
