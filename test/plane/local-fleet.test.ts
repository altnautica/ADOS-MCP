import { describe, it, expect, vi, afterEach } from "vitest";
import { LocalFleetPlane } from "../../src/plane/local-fleet.js";
import type { FleetNode } from "../../src/config.js";

// Documentation-range LAN IPs; not real hosts.
const NODES: FleetNode[] = [
  { deviceId: "drone-a", name: "Alpha", host: "http://10.0.0.10:8080", apiKey: "ka", profile: "drone" },
  { deviceId: "drone-b", name: "Bravo", host: "http://10.0.0.11:8080", apiKey: "kb", profile: "drone" },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("LocalFleetPlane", () => {
  it("describes the fleet size and has no backend credential to verify", async () => {
    const plane = new LocalFleetPlane(NODES);
    expect(plane.mode).toBe("local-fleet");
    expect(plane.describe()).toEqual({ mode: "local-fleet", target: "2 LAN node(s)" });
    expect(await plane.verifyCredential("anything")).toBeNull();
  });

  it("refuses a node that is not in the fleet file (no HTTP made)", async () => {
    const plane = new LocalFleetPlane(NODES);
    await expect(plane.getStatus("ghost")).rejects.toMatchObject({ reason: "node_not_allowed" });
  });

  it("routes each call to the matching node's host with that node's own key", async () => {
    const seen: { url: string; key: string | null }[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), key: headers.get("x-ados-key") });
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    const plane = new LocalFleetPlane(NODES);
    await plane.getStatus("drone-a");
    await plane.getStatus("drone-b");
    expect(seen[0]?.url).toContain("10.0.0.10");
    expect(seen[0]?.key).toBe("ka");
    expect(seen[1]?.url).toContain("10.0.0.11");
    expect(seen[1]?.key).toBe("kb");
  });

  it("listNodes marks a reachable node online and an unreachable node offline", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      if (String(url).includes("10.0.0.10"))
        return Promise.resolve(jsonResponse({ agent_version: "1.2.3" }));
      return Promise.reject(new Error("ECONNREFUSED"));
    });
    const plane = new LocalFleetPlane(NODES);
    const list = await plane.listNodes();
    const a = list.find((n) => n.deviceId === "drone-a");
    const b = list.find((n) => n.deviceId === "drone-b");
    expect(a?.online).toBe(true);
    expect(a?.name).toBe("Alpha");
    expect(a?.agentVersion).toBe("1.2.3");
    // An unreachable node is still LISTED, honestly offline (never dropped).
    expect(b?.online).toBe(false);
    expect(b?.name).toBe("Bravo");
  });

  it("health is ok when at least one node answers, and reports the partial count", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      if (String(url).includes("10.0.0.10")) return Promise.resolve(jsonResponse({}));
      return Promise.reject(new Error("down"));
    });
    const plane = new LocalFleetPlane(NODES);
    const h = await plane.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain("1/2");
  });

  it("health is not ok for an empty fleet", async () => {
    const h = await new LocalFleetPlane([]).health();
    expect(h.ok).toBe(false);
  });
});
