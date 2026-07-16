import { describe, it, expect, beforeEach } from "vitest";

import { clearDynamicRouteCaps, routeCapFor } from "../../src/auth/route-capability.js";
import {
  registerPluginTools,
  safetyToScope,
  toolsFromDetail,
} from "../../src/registry/plugin-tools.js";
import { ToolRegistry } from "../../src/registry/tools.js";
import type { PlatformPlane } from "../../src/plane/platform-plane.js";

// Reset the module-global dynamic route-cap table between tests so a plugin tool
// registered by one test never leaks into another.
beforeEach(() => clearDynamicRouteCaps());

describe("safetyToScope", () => {
  it("maps each known class and treats flight_action as flight", () => {
    expect(safetyToScope("read")).toEqual({ scope: "read", safetyClass: "read", affectsFlight: false });
    expect(safetyToScope("safe_write")).toEqual({
      scope: "safe_write",
      safetyClass: "safe_write",
      affectsFlight: false,
    });
    expect(safetyToScope("flight_action")).toEqual({
      scope: "flight",
      safetyClass: "flight",
      affectsFlight: true,
    });
    expect(safetyToScope("destructive")).toEqual({
      scope: "destructive",
      safetyClass: "destructive",
      affectsFlight: false,
    });
  });

  it("maps an unknown / absent class to admin (fail-safe)", () => {
    expect(safetyToScope("bogus").scope).toBe("admin");
    expect(safetyToScope(undefined).scope).toBe("admin");
  });
});

describe("toolsFromDetail", () => {
  const detail = (extra: Record<string, unknown>) => ({
    granted_capabilities: ["mcp.expose", "mavlink.write"],
    manifest: { mcp: { tools: [], resources: [], prompts: [] } },
    ...extra,
  });

  it("returns agent-half tools when mcp.expose is granted", () => {
    const tools = toolsFromDetail("com.x.p", {
      granted_capabilities: ["mcp.expose"],
      manifest: {
        mcp: {
          tools: [
            { name: "start", title: "Start", safety_class: "flight_action", half: "agent" },
            { name: "peek", safety_class: "read", half: "agent" },
          ],
        },
      },
    });
    expect(tools.map((t) => t.toolName)).toEqual(["start", "peek"]);
    expect(tools[0].description).toBe("Start");
    expect(tools[0].safetyClassRaw).toBe("flight_action");
  });

  it("returns nothing when mcp.expose is NOT granted (the exposure gate)", () => {
    const tools = toolsFromDetail("com.x.p", {
      granted_capabilities: ["mavlink.write"],
      manifest: { mcp: { tools: [{ name: "start", safety_class: "read", half: "agent" }] } },
    });
    expect(tools).toEqual([]);
  });

  it("skips gcs-half tools and malformed entries", () => {
    const tools = toolsFromDetail("com.x.p", {
      granted_capabilities: ["mcp.expose"],
      manifest: {
        mcp: {
          tools: [
            { name: "gcs_only", safety_class: "read", half: "gcs" },
            { safety_class: "read", half: "agent" }, // no name
            "not-an-object",
            { name: "ok", safety_class: "read", half: "agent" },
          ],
        },
      },
    });
    expect(tools.map((t) => t.toolName)).toEqual(["ok"]);
  });

  it("is defensive against a malformed detail", () => {
    expect(toolsFromDetail("p", null)).toEqual([]);
    expect(toolsFromDetail("p", detail({ manifest: {} }))).toEqual([]);
  });
});

describe("registerPluginTools", () => {
  const plane = {
    async getPlugins() {
      return { installs: [{ plugin_id: "com.x.follow" }, { plugin_id: "com.x.noexpose" }] };
    },
    async getPluginInfo(_n: string, id: string) {
      if (id === "com.x.noexpose") {
        return { granted_capabilities: [], manifest: { mcp: { tools: [] } } };
      }
      return {
        granted_capabilities: ["mcp.expose", "mavlink.write"],
        manifest: {
          mcp: {
            tools: [
              {
                name: "start",
                title: "Start follow",
                safety_class: "flight_action",
                inputSchema: { type: "object", properties: { d: { type: "number" } } },
                half: "agent",
              },
              { name: "peek", safety_class: "read", half: "agent" },
              { name: "gcs_only", safety_class: "read", half: "gcs" },
            ],
          },
        },
      };
    },
    async invokePluginTool(_n: string, id: string, tool: string, args: Record<string, unknown>) {
      return { plugin_id: id, tool, result: args };
    },
  } as unknown as PlatformPlane;

  it("registers agent-half tools namespaced, with the right dynamic scope", async () => {
    const reg = new ToolRegistry();
    const count = await registerPluginTools(reg, plane, "node1");
    expect(count).toBe(2); // start + peek; gcs_only and the no-expose plugin skipped

    // The namespaced tools are registered and gate-resolvable.
    expect(reg.get("com.x.follow:start")).toBeDefined();
    expect(reg.get("com.x.follow:peek")).toBeDefined();
    expect(reg.get("com.x.follow:gcs_only")).toBeUndefined();

    const startCap = routeCapFor("com.x.follow:start");
    expect(startCap?.scope).toBe("flight");
    expect(startCap?.affectsFlight).toBe(true);
    expect(startCap?.agentModeOnly).toBe(true);

    // peek DECLARES read, but the plugin holds mavlink.write, so the scope floor
    // lifts it to flight (a MAVLink-injecting plugin's tools are all flight-class).
    const peekCap = routeCapFor("com.x.follow:peek");
    expect(peekCap?.scope).toBe("flight");
    expect(peekCap?.affectsFlight).toBe(true);
  });

  it("advertises the manifest input schema and routes the handler to the plane", async () => {
    const reg = new ToolRegistry();
    await registerPluginTools(reg, plane, "node1");

    const list = reg.listFor({
      claims: { scopes: ["read", "safe_write", "admin", "flight"] } as never,
      flightEnforced: true,
      fleetMode: false,
    });
    const start = list.find((t) => t.name === "com.x.follow:start");
    expect(start?.inputSchema).toEqual({
      type: "object",
      properties: { d: { type: "number" } },
    });

    // The handler forwards to the plane's invokePluginTool.
    const def = reg.get("com.x.follow:start")!;
    const out = await def.handler(
      { d: 8 },
      { plane, node: "node1", claims: {} as never } as never,
    );
    expect(out).toEqual({ plugin_id: "com.x.follow", tool: "start", result: { d: 8 } });
  });

  it("is idempotent across a re-register in the same pass", async () => {
    const reg = new ToolRegistry();
    const first = await registerPluginTools(reg, plane, "node1");
    // A second pass (same registry) skips already-registered tools rather than
    // throwing on a duplicate registration.
    const second = await registerPluginTools(reg, plane, "node1");
    expect(first).toBe(2);
    expect(second).toBe(0);
  });
});

describe("plugin tool scope floor (CFIX-1)", () => {
  // A plane that reports ONE plugin holding a chosen cap set + declaring one tool
  // `act` with a chosen safety_class, so the end-to-end floor is asserted via the
  // registered route-cap (the authoritative gate input).
  const planeWithCaps = (caps: string[], declared: string): PlatformPlane =>
    ({
      async getPlugins() {
        return { installs: [{ plugin_id: "com.x.p" }] };
      },
      async getPluginInfo() {
        return {
          granted_capabilities: ["mcp.expose", ...caps],
          manifest: { mcp: { tools: [{ name: "act", safety_class: declared, half: "agent" }] } },
        };
      },
      async invokePluginTool() {
        return {};
      },
    }) as unknown as PlatformPlane;

  it("floors an under-declared tool at the caps' implied class, never below the declared", async () => {
    const cases: Array<[string[], string, string, boolean]> = [
      // [granted caps, declared class, expected floored scope, expected affectsFlight]
      [["mavlink.write"], "safe_write", "flight", true],
      // pattern-match catches caps NOT enumerated in SCOPE_CAPABILITIES:
      [["mavlink.send"], "read", "flight", true],
      [["flight.guided_setpoint.send"], "read", "flight", true],
      [["mavlink.tunnel"], "read", "flight", true],
      [["mavlink.component.vio"], "read", "flight", true],
      [["mission.write"], "read", "flight", true],
      [["vehicle.command"], "read", "flight", true],
      [["process.spawn"], "read", "admin", false],
      [["network.outbound"], "read", "admin", false],
      // a destructive-class cap floors to destructive; flight.terminate still
      // affects flight even though its top class is destructive.
      [["factory.reset"], "admin", "destructive", false],
      [["flight.terminate"], "read", "destructive", true],
      // no over-floor: a read-only plugin keeps its declared class.
      [["perception.read"], "read", "read", false],
      [["telemetry.read"], "safe_write", "safe_write", false],
    ];
    for (const [caps, declared, expected, flight] of cases) {
      clearDynamicRouteCaps();
      const reg = new ToolRegistry();
      await registerPluginTools(reg, planeWithCaps(caps, declared), "n");
      const cap = routeCapFor("com.x.p:act");
      expect(cap?.scope, `caps=${caps} declared=${declared}`).toBe(expected);
      expect(cap?.affectsFlight, `caps=${caps} affectsFlight`).toBe(flight);
    }
  });
});
