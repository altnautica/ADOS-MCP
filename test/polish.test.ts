import { describe, it, expect } from "vitest";
import { makeCore, mintLocalToken } from "./helpers.js";
import { registerReadTools } from "../src/registry/read-tools.js";
import { registerAdminTools } from "../src/registry/admin-tools.js";
import { registerReadPrompts } from "../src/registry/read-prompts.js";
import { PromptRegistry } from "../src/registry/prompts.js";
import type { ServerCore } from "../src/server.js";

const AUDIT = "/tmp/ados-mcp-polish-test.ndjson";

function buildCore(mode: "agent" | "fleet"): ServerCore {
  const { core } = makeCore({
    mode,
    ...(mode === "fleet" ? { credential: "ados_mc_x:read,admin" } : {}),
    auditPath: AUDIT,
  });
  registerReadTools(core.tools, AUDIT);
  registerAdminTools(core.tools);
  return core;
}

async function auth(core: ServerCore, mode: "agent" | "fleet") {
  if (mode === "fleet") return core.pipeline.authenticateBearer("ados_mc_x:read,admin");
  const t = await mintLocalToken({ scopes: ["read", "safe_write", "admin"] as never });
  return core.pipeline.authenticateBearer(t);
}

describe("fleet-mode agentModeOnly filter", () => {
  it("hides relay-unsupported tools from fleet-mode tools/list, keeps them in agent-mode", async () => {
    const fc = buildCore("fleet");
    const fleetTools = fc.pipeline.listTools(await auth(fc, "fleet")).map((t) => t.name);
    for (const t of ["params.read_all", "config.get", "config.set", "plugins.list", "plugins.install"]) {
      expect(fleetTools).not.toContain(t);
    }
    // tools the relay CAN serve stay visible
    expect(fleetTools).toEqual(expect.arrayContaining(["status.get", "services.restart", "plugins.enable"]));

    const ac = buildCore("agent");
    const agentTools = ac.pipeline.listTools(await auth(ac, "agent")).map((t) => t.name);
    expect(agentTools).toEqual(expect.arrayContaining(["params.read_all", "config.get", "plugins.list"]));
  });

  it("refuses a relay-unsupported tool with agent_mode_only in fleet-mode", async () => {
    const fc = buildCore("fleet");
    await expect(
      fc.pipeline.callTool("params.read_all", { node: "n1" }, await auth(fc, "fleet"), "s"),
    ).rejects.toMatchObject({ reason: "agent_mode_only" });
  });

  it("serves the same tool over the direct reach in agent-mode", async () => {
    const ac = buildCore("agent");
    const r = await ac.pipeline.callTool("params.read_all", {}, await auth(ac, "agent"), "s");
    expect(r.structuredContent).toHaveProperty("params");
  });
});

describe("prompts catalog", () => {
  it("registers the five plane-agnostic prompts and renders them with args", () => {
    const reg = new PromptRegistry();
    registerReadPrompts(reg);
    expect(reg.all().map((p) => p.name)).toEqual(
      expect.arrayContaining([
        "fleet_health",
        "preflight_brief",
        "postflight_debrief",
        "triage_issue",
        "tune_and_optimize",
      ]),
    );
    const rendered = reg.get("preflight_brief")!.render({ node: "n1" });
    expect(rendered.messages[0]!.role).toBe("user");
    expect(rendered.messages[0]!.content.text).toContain("n1");
    // fleet_health takes no args and still renders
    expect(reg.get("fleet_health")!.render({}).messages.length).toBe(1);
  });
});
