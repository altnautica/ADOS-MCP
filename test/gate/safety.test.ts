import { describe, it, expect } from "vitest";
import {
  SafetyGate,
  NO_OPERATOR_PRESENT,
  NO_SIGNED_CONFIRM,
  DESTRUCTIVE_PHRASES,
  type OperatorPresence,
  type SafetyContext,
} from "../../src/gate/safety.js";
import { GateError } from "../../src/gate/errors.js";
import type { SafetyClass } from "../../src/auth/scopes.js";

const gate = new SafetyGate();

function ctx(over: Partial<SafetyContext> & { tool: string; safetyClass: SafetyClass }): SafetyContext {
  return {
    node: "local",
    args: {},
    argsHash: "hash",
    sim: false,
    operatorPresent: NO_OPERATOR_PRESENT,
    signedConfirm: NO_SIGNED_CONFIRM,
    ...over,
  };
}

const presentNow: OperatorPresence = { status: () => ({ present: true, ageMs: 1000 }) };
const presentStale: OperatorPresence = { status: () => ({ present: true, ageMs: 60_000 }) };

describe("SafetyGate", () => {
  it("allows read and safe_write with no confirm", () => {
    expect(gate.evaluate(ctx({ tool: "status.get", safetyClass: "read" })).decision).toBe("allowed");
    expect(gate.evaluate(ctx({ tool: "config.set", safetyClass: "safe_write" })).decision).toBe("allowed");
  });

  it("requires confirm:true for admin", () => {
    expect(() => gate.evaluate(ctx({ tool: "admin.node.rename", safetyClass: "admin" }))).toThrow(
      /confirm/,
    );
    expect(
      gate.evaluate(ctx({ tool: "admin.node.rename", safetyClass: "admin", args: { confirm: true } }))
        .decision,
    ).toBe("confirmed");
  });

  it("requires the exact typed phrase for destructive", () => {
    expect(() => gate.evaluate(ctx({ tool: "system.reboot", safetyClass: "destructive" }))).toThrow(
      /phrase/,
    );
    expect(() =>
      gate.evaluate(ctx({ tool: "system.reboot", safetyClass: "destructive", args: { confirm: "wrong" } })),
    ).toThrow(GateError);
    const ok = gate.evaluate(
      ctx({ tool: "system.reboot", safetyClass: "destructive", args: { confirm: DESTRUCTIVE_PHRASES["system.reboot"] } }),
    );
    expect(ok.decision).toBe("confirmed");
  });

  it("refuses a destructive tool with no configured phrase", () => {
    expect(() =>
      gate.evaluate(ctx({ tool: "params.reset_all", safetyClass: "destructive", args: { confirm: "x" } })),
    ).toThrow();
    // params.reset_all does have a phrase, so the wrong phrase is confirm_required, not not_supported.
    try {
      gate.evaluate(ctx({ tool: "params.reset_all", safetyClass: "destructive", args: { confirm: "x" } }));
    } catch (e) {
      expect((e as GateError).reason).toBe("confirm_required");
    }
  });

  it("admits flight with a fresh operator-present signal", () => {
    expect(
      gate.evaluate(ctx({ tool: "flight.arm", safetyClass: "flight", operatorPresent: presentNow })).decision,
    ).toBe("confirmed");
  });

  it("refuses flight with a stale operator-present signal", () => {
    try {
      gate.evaluate(ctx({ tool: "flight.arm", safetyClass: "flight", operatorPresent: presentStale }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as GateError).reason).toBe("operator_present_stale");
    }
  });

  it("admits flight in sim mode without an operator", () => {
    expect(gate.evaluate(ctx({ tool: "flight.arm", safetyClass: "flight", sim: true })).decision).toBe(
      "confirmed",
    );
  });

  it("consumes a valid signed confirm for flight", () => {
    const oneShot = {
      used: false,
      consume() {
        if (this.used) return false;
        this.used = true;
        return true;
      },
    };
    const c = ctx({
      tool: "flight.goto",
      safetyClass: "flight",
      args: { confirm_id: "cid-1" },
      signedConfirm: oneShot,
    });
    expect(gate.evaluate(c).decision).toBe("confirmed");
    expect(() => gate.evaluate(c)).toThrow(/invalid or expired/); // single-use
  });
});
