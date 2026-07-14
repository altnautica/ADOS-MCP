import { describe, it, expect } from "vitest";
import {
  agentBaseUrl,
  firmwareOf,
  normalizeParams,
  readBatteryPct,
  toOutcome,
  vehicleClassOf,
} from "../../src/plane/lan-direct.js";

describe("lan-direct helpers", () => {
  it("normalizes params from an array payload", () => {
    expect(
      normalizeParams({
        params: [
          { name: "A", value: 1 },
          { name: "B", value: 2.5, type: "FLOAT" },
        ],
      }),
    ).toEqual([
      { name: "A", value: 1 },
      { name: "B", value: 2.5, type: "FLOAT" },
    ]);
  });

  it("normalizes params from a map payload (bare and {value})", () => {
    expect(normalizeParams({ params: { A: 1, B: { value: 2 } } })).toEqual([
      { name: "A", value: 1 },
      { name: "B", value: 2 },
    ]);
  });

  it("maps firmware variants", () => {
    expect(firmwareOf("ArduPilot")).toBe("ardupilot");
    expect(firmwareOf("PX4")).toBe("px4");
    expect(firmwareOf("iNav")).toBe("inav");
    expect(firmwareOf("Betaflight")).toBe("betaflight");
    expect(firmwareOf("")).toBe("unknown");
  });

  it("maps a vehicle class", () => {
    expect(vehicleClassOf("Quadcopter")).toBe("copter");
    expect(vehicleClassOf("fixed wing")).toBe("plane");
    expect(vehicleClassOf("Ground Rover")).toBe("rover");
    expect(vehicleClassOf(undefined)).toBeUndefined();
  });

  it("reads battery percent, treating -1 as unknown", () => {
    expect(readBatteryPct({ battery: { remaining: 80 } })).toBe(80);
    expect(readBatteryPct({ battery: { remaining: -1 } })).toBeNull();
    expect(readBatteryPct({})).toBeNull();
  });

  it("builds the agent base url", () => {
    expect(agentBaseUrl("dronehost")).toBe("http://dronehost:8080");
    expect(agentBaseUrl("http://10.0.0.4:9090")).toBe("http://10.0.0.4:9090");
    expect(agentBaseUrl("10.0.0.4:8080")).toBe("http://10.0.0.4:8080");
  });

  it("wraps a REST write response as a completed outcome", () => {
    expect(toOutcome({ status: "ok", message: "restarted" })).toEqual({
      ok: true,
      status: "completed",
      message: "restarted",
      data: { status: "ok", message: "restarted" },
    });
    // no message field -> just ok + data
    expect(toOutcome({ name: "P", value: 1 })).toEqual({
      ok: true,
      status: "completed",
      data: { name: "P", value: 1 },
    });
    // null body -> ok with no data
    expect(toOutcome(null)).toEqual({ ok: true, status: "completed" });
  });
});
