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

// Fixed uppercase phrases for the built-in destructive tools. A phrase is a plain
// string, never generated, so it is obvious in an audit and hard to submit by
// accident.
export const DESTRUCTIVE_PHRASES: Record<string, string> = {
  "system.reboot": "REBOOT THIS NODE",
  "system.shutdown": "SHUTDOWN THIS NODE",
  "system.factory_reset": "FACTORY RESET THIS NODE",
  "params.reset_all": "RESET ALL PARAMS ON THIS NODE",
  "flight.emergency_stop": "EMERGENCY STOP THIS AIRCRAFT",
};

/**
 * The typed-confirm phrase required for a destructive tool. Built-in tools carry
 * a fixed hand-written phrase (above). A plugin tool (its name is always
 * `${pluginId}:${tool}`, so it contains a ":") is floored to destructive at
 * registration when the plugin holds a destructive-class capability; it has no
 * hand-written phrase, so a stable one is synthesized from its name so the tool is
 * still invokable (with the same phrase + operator signed-confirm requirement as a
 * built-in destructive tool), never silently un-invokable. A built-in destructive
 * tool with no phrase remains a build error (returns undefined → refusal).
 */
export function destructivePhraseFor(tool: string): string | undefined {
  const fixed = DESTRUCTIVE_PHRASES[tool];
  if (fixed) return fixed;
  if (tool.includes(":")) return `CONFIRM ${tool.toUpperCase()}`;
  return undefined;
}

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
    const phrase = destructivePhraseFor(ctx.tool);
    if (!phrase) {
      // A built-in destructive tool with no registered phrase is a build error,
      // surfaced as a refusal rather than an accidental allow. (Plugin tools
      // always get a synthesized phrase, so this only ever fires for a built-in.)
      throw new GateError("not_supported", `${ctx.tool} has no confirm phrase configured`);
    }
    // The typed phrase is public, so a client can produce it on its own; the
    // phrase alone must never admit a destructive call. It is checked but not
    // echoed, and an operator-signed confirm bound to this exact call is required
    // in addition, exactly as the flight gate requires. With no signed-confirm
    // backend the gate fails closed. Sim waives the signature (never the phrase).
    if (ctx.args.confirm !== phrase) {
      throw new GateError(
        "confirm_required",
        `${ctx.tool} requires the exact typed confirm phrase and an operator signed confirm`,
        { tool: ctx.tool },
      );
    }
    if (ctx.sim) return { decision: "confirmed" };
    const confirmId = typeof ctx.args.confirm_id === "string" ? ctx.args.confirm_id : undefined;
    const signed =
      confirmId !== undefined &&
      ctx.signedConfirm.consume({
        confirmId,
        tool: ctx.tool,
        node: ctx.node,
        argsHash: ctx.argsHash,
      });
    if (!signed) {
      throw new GateError(
        "confirm_required",
        `${ctx.tool} requires an operator signed confirm bound to this call`,
        { tool: ctx.tool },
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
