import { describe, it, expect } from "vitest";
import {
  decodeValue,
  joinParams,
  loadParamMetadata,
  paramsDifferingFromDefault,
  type ParamMetadata,
} from "../src/param-metadata/loader.js";

describe("param metadata floor", () => {
  it("loads the ArduPilot copter floor with a large parameter set", async () => {
    const m = await loadParamMetadata({ firmware: "ardupilot", vehicleClass: "copter" });
    expect(m.size).toBeGreaterThan(100);
  });

  it("loads the PX4 floor", async () => {
    const m = await loadParamMetadata({ firmware: "px4" });
    expect(m.size).toBeGreaterThan(100);
  });

  it("returns an empty map for an unknown firmware", async () => {
    const m = await loadParamMetadata({ firmware: "unknown" });
    expect(m.size).toBe(0);
  });

  it("joins live values against the metadata registry", async () => {
    const m = await loadParamMetadata({ firmware: "ardupilot", vehicleClass: "copter" });
    const joined = joinParams({ FENCE_ENABLE: 1, ATC_RAT_RLL_P: 0.135 }, m);
    expect(joined.map((p) => p.name)).toEqual(["ATC_RAT_RLL_P", "FENCE_ENABLE"]);
  });

  it("decodes an enum value", () => {
    const meta: ParamMetadata = {
      name: "X",
      values: [
        [0, "Disabled"],
        [1, "Enabled"],
      ],
    };
    expect(decodeValue(meta, 1)).toBe("Enabled");
    expect(decodeValue(meta, 9)).toBeUndefined();
  });

  it("decodes bitmask flags", () => {
    const meta: ParamMetadata = {
      name: "X",
      bitmask: [
        [0, "A"],
        [1, "B"],
        [2, "C"],
      ],
    };
    expect(decodeValue(meta, 0b101)).toBe("A, C");
    expect(decodeValue(meta, 0)).toBe("(no bits set)");
  });

  it("finds parameters that differ from their default", () => {
    const meta = new Map<string, ParamMetadata>([
      ["A", { name: "A", defaultValue: 1 }],
      ["B", { name: "B", defaultValue: 5 }],
    ]);
    const diff = paramsDifferingFromDefault({ A: 1, B: 9 }, meta);
    expect(diff.map((p) => p.name)).toEqual(["B"]);
  });
});
