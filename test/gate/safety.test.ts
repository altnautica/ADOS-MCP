import { describe, it, expect } from "vitest";
import {
  SafetyGate,
  NO_OPERATOR_PRESENT,
  NO_SIGNED_CONFIRM,
  DESTRUCTIVE_PHRASES,
  destructivePhraseFor,
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

  it("requires the exact typed phrase for destructive (necessary, not sufficient)", () => {
    expect(() => gate.evaluate(ctx({ tool: "system.reboot", safetyClass: "destructive" }))).toThrow(
      /phrase/,
    );
    expect(() =>
      gate.evaluate(ctx({ tool: "system.reboot", safetyClass: "destructive", args: { confirm: "wrong" } })),
    ).toThrow(GateError);
  });

  it("requires a signed confirm in addition to the phrase for destructive", () => {
    const phrase = DESTRUCTIVE_PHRASES["system.reboot"];
    // The public phrase alone is not enough (a client can produce it).
    try {
      gate.evaluate(ctx({ tool: "system.reboot", safetyClass: "destructive", args: { confirm: phrase } }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as GateError).reason).toBe("confirm_required");
    }
    // The phrase plus a valid operator signed confirm passes.
    const oneShot = {
      used: false,
      consume() {
        if (this.used) return false;
        this.used = true;
        return true;
      },
    };
    const ok = gate.evaluate(
      ctx({
        tool: "system.reboot",
        safetyClass: "destructive",
        args: { confirm: phrase, confirm_id: "cid" },
        signedConfirm: oneShot,
      }),
    );
    expect(ok.decision).toBe("confirmed");
  });

  it("waives the signed confirm for destructive in sim, but still needs the phrase", () => {
    const phrase = DESTRUCTIVE_PHRASES["system.reboot"];
    expect(
      gate.evaluate(ctx({ tool: "system.reboot", safetyClass: "destructive", sim: true, args: { confirm: phrase } }))
        .decision,
    ).toBe("confirmed");
    expect(() =>
      gate.evaluate(ctx({ tool: "system.reboot", safetyClass: "destructive", sim: true, args: { confirm: "wrong" } })),
    ).toThrow();
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

  it("synthesizes a confirm phrase for a destructive plugin tool (CFIX-2)", () => {
    // A built-in tool with no phrase has none (build error → refusal).
    expect(destructivePhraseFor("some.builtin")).toBeUndefined();
    // A plugin tool (name contains ":") gets a stable synthesized phrase.
    const tool = "com.x.p:wipe";
    const phrase = destructivePhraseFor(tool);
    expect(phrase).toBe("CONFIRM COM.X.P:WIPE");

    // Without the phrase it is confirm_required (not not_supported — it IS invokable).
    try {
      gate.evaluate(ctx({ tool, safetyClass: "destructive", args: { confirm: "nope" } }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as GateError).reason).toBe("confirm_required");
    }
    // Phrase + sim → confirmed (same posture as a built-in destructive tool).
    expect(
      gate.evaluate(ctx({ tool, safetyClass: "destructive", sim: true, args: { confirm: phrase } })).decision,
    ).toBe("confirmed");
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
