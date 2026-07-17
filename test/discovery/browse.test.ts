import { describe, it, expect } from "vitest";
import { parseAgent, planAdoptions, type DiscoveredAgent } from "../../src/discovery/browse.js";
import type { FleetNode } from "../../src/config.js";

describe("parseAgent", () => {
  // Documentation-range LAN IPs; not real hosts.
  const svc = (over: Record<string, unknown> = {}) => ({
    txt: (over.txt as Record<string, unknown>) ?? {
      device_id: "drone-a",
      name: "Alpha",
      profile: "drone",
      paired: "false",
    },
    addresses: (over.addresses as string[]) ?? ["10.0.0.10"],
    port: (over.port as number) ?? 8080,
  });

  it("builds a reachable REST host from the advertised IPv4 + port", () => {
    const a = parseAgent(svc());
    expect(a).toMatchObject({ deviceId: "drone-a", name: "Alpha", profile: "drone", paired: false, host: "http://10.0.0.10:8080" });
  });

  it("reads the paired flag (true / 1 → paired)", () => {
    expect(parseAgent(svc({ txt: { device_id: "x", paired: "true" } }))?.paired).toBe(true);
    expect(parseAgent(svc({ txt: { device_id: "x", paired: "1" } }))?.paired).toBe(true);
    expect(parseAgent(svc({ txt: { device_id: "x", paired: "false" } }))?.paired).toBe(false);
  });

  it("uses the advertised REST port when non-default", () => {
    expect(parseAgent(svc({ port: 9090 }))?.host).toBe("http://10.0.0.10:9090");
  });

  it("returns null without a device id or an IPv4 address", () => {
    expect(parseAgent(svc({ txt: {} }))).toBeNull();
    expect(parseAgent(svc({ addresses: ["fe80::1"] }))).toBeNull();
  });
});

describe("planAdoptions", () => {
  const known: FleetNode[] = [{ deviceId: "known-1", host: "http://10.0.0.5:8080", apiKey: "k1" }];
  const agent = (id: string, paired: boolean): DiscoveredAgent => ({
    deviceId: id,
    paired,
    host: `http://10.0.0.20:8080`,
  });

  it("adopts an UNPAIRED drone not already in the fleet", () => {
    const plan = planAdoptions([agent("new-unpaired", false)], known, true);
    expect(plan.map((a) => a.deviceId)).toEqual(["new-unpaired"]);
  });

  it("skips a drone already in the fleet (its key is handed over)", () => {
    expect(planAdoptions([agent("known-1", false)], known, true)).toHaveLength(0);
  });

  it("skips a PAIRED drone not in the fleet (can't auto-key it)", () => {
    expect(planAdoptions([agent("someone-elses", true)], known, true)).toHaveLength(0);
  });

  it("adopts nothing when opt-in is off", () => {
    expect(planAdoptions([agent("new-unpaired", false)], known, false)).toHaveLength(0);
  });
});
