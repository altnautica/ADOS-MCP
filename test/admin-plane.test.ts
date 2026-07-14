import { describe, it, expect } from "vitest";
import { makeCore, mintLocalToken } from "./helpers.js";
import { registerAdminTools } from "../src/registry/admin-tools.js";
import type { ServerCore } from "../src/server.js";

const AUDIT = "/tmp/ados-mcp-admin-test.ndjson";

function adminCore(): { core: ServerCore; audit: ReturnType<typeof makeCore>["audit"] } {
  const { core, audit } = makeCore({ auditPath: AUDIT });
  registerAdminTools(core.tools);
  return { core, audit };
}

async function auth(core: ServerCore, scopes: string[]) {
  const token = await mintLocalToken({ scopes: scopes as never });
  return core.pipeline.authenticateBearer(token);
}

function ok(r: { structuredContent?: unknown }): boolean {
  return (r.structuredContent as { ok?: boolean }).ok === true;
}

describe("admin platform tools (drone-direct)", () => {
  it("sets the WFB channel in agent-mode with the admin scope", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read", "admin"]);
    const r = await core.pipeline.callTool("admin.wfb.channel", { channel: 149, confirm: true }, a, "s");
    expect(ok(r)).toBe(true);
  });

  it("reads pairing info with the read scope", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read"]);
    const r = await core.pipeline.callTool("admin.pairing.info", {}, a, "s");
    expect(r.structuredContent).toMatchObject({ paired: false });
  });

  it("hides the drone-direct platform tools from a fleet-mode tools/list", async () => {
    const { core } = makeCore({ mode: "fleet", convexUrl: "https://convex.example", auditPath: AUDIT });
    registerAdminTools(core.tools);
    const a = await auth(core, ["read", "admin"]);
    const names = core.pipeline.listTools(a).map((t) => t.name);
    for (const hidden of ["admin.wfb.channel", "admin.network.wifi_join", "admin.pairing.unpair", "admin.node.rename"]) {
      expect(names).not.toContain(hidden);
    }
  });
});

describe("admin plane", () => {
  it("restarts a non-critical service with confirm and audits it as confirmed", async () => {
    const { core, audit } = adminCore();
    const a = await auth(core, ["read", "admin"]);
    const r = await core.pipeline.callTool("services.restart", { name: "ados-api", confirm: true }, a, "s");
    expect(ok(r)).toBe(true);
    expect(audit.events.at(-1)).toMatchObject({ tool: "services.restart", decision: "confirmed" });
  });

  it("refuses an admin write without confirm", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read", "admin"]);
    await expect(
      core.pipeline.callTool("services.restart", { name: "ados-api" }, a, "s"),
    ).rejects.toMatchObject({ reason: "confirm_required" });
  });

  it("refuses an admin write from a read-only token", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read"]);
    await expect(
      core.pipeline.callTool("plugins.enable", { id: "demo", confirm: true }, a, "s"),
    ).rejects.toMatchObject({ reason: "scope_missing" });
  });

  it("escalates restarting an armed-critical unit to the flight gate", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read", "admin"]); // no flight scope
    // ados-video is armed-critical -> escalates to flight -> needs the flight scope
    await expect(
      core.pipeline.callTool("services.restart", { name: "ados-video", confirm: true }, a, "s"),
    ).rejects.toMatchObject({ reason: "scope_missing" });
  });

  it("escalates params.set on a flight-critical name; a normal param is plain admin", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read", "admin"]); // no flight scope
    await expect(
      core.pipeline.callTool("params.set", { name: "ARMING_CHECK", value: 1, confirm: true }, a, "s"),
    ).rejects.toMatchObject({ reason: "scope_missing" });
    const r = await core.pipeline.callTool(
      "params.set",
      { name: "ATC_RAT_RLL_P", value: 0.1, confirm: true },
      a,
      "s",
    );
    expect(ok(r)).toBe(true);
  });

  it("escalates config.set on a network path to admin; a normal path is safe_write", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read", "safe_write", "admin"]);
    // network.* escalates to admin -> confirm required
    await expect(
      core.pipeline.callTool("config.set", { key: "network.reg", value: "US" }, a, "s"),
    ).rejects.toMatchObject({ reason: "confirm_required" });
    // a normal config path stays safe_write -> no confirm needed
    const r = await core.pipeline.callTool("config.set", { key: "video.bitrate", value: "8" }, a, "s");
    expect(ok(r)).toBe(true);
  });

  it("enables, disables, and removes a plugin with confirm", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read", "admin"]);
    for (const tool of ["plugins.enable", "plugins.disable", "plugins.remove"] as const) {
      const r = await core.pipeline.callTool(tool, { id: "demo", confirm: true }, a, "s");
      expect(ok(r)).toBe(true);
    }
  });

  it("plugins.config is safe_write (no confirm)", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read", "safe_write"]);
    const r = await core.pipeline.callTool("plugins.config", { id: "demo", key: "k", value: "v" }, a, "s");
    expect(ok(r)).toBe(true);
  });

  it("serves the admin-plane reads (plugins.list, plugins.info, logs.query) to a read token", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read"]);
    const list = await core.pipeline.callTool("plugins.list", {}, a, "s");
    expect(Array.isArray(list.structuredContent)).toBe(true);
    const info = await core.pipeline.callTool("plugins.info", { id: "demo" }, a, "s");
    expect(info.structuredContent).toMatchObject({ pluginId: "demo" });
    const logs = await core.pipeline.callTool("logs.query", { limit: 10 }, a, "s");
    expect(logs.structuredContent).toHaveProperty("entries");
  });

  it("escalates armed-critical restarts through aliases, .service suffix, and the real router unit", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read", "admin"]); // no flight scope
    for (const name of ["video", "ados-video.service", "ADOS-VIDEO", "ados-mavlink-router", "mavlink-router"]) {
      await expect(
        core.pipeline.callTool("services.restart", { name, confirm: true }, a, "s"),
      ).rejects.toMatchObject({ reason: "scope_missing" });
    }
    // a genuinely non-critical unit stays admin and succeeds
    const okr = await core.pipeline.callTool("services.restart", { name: "ados-api", confirm: true }, a, "s");
    expect(ok(okr)).toBe(true);
  });

  it("flight-gates admin.agent.restart_supervisor (not a plain admin confirm)", async () => {
    const { core } = adminCore();
    // hidden from an admin-but-not-flight token while enforce is off
    const admin = await auth(core, ["read", "admin"]);
    expect(core.pipeline.listTools(admin).map((t) => t.name)).not.toContain("admin.agent.restart_supervisor");
    await expect(
      core.pipeline.callTool("admin.agent.restart_supervisor", { confirm: true }, admin, "s"),
    ).rejects.toMatchObject({ reason: "scope_missing" });
  });

  it("never persists a config.set/plugins.config secret into the audit", async () => {
    const { core, audit } = adminCore();
    const a = await auth(core, ["read", "safe_write", "admin"]);
    const r = await core.pipeline.callTool(
      "config.set",
      { key: "network.psk", value: "topsecret", confirm: true },
      a,
      "s",
    );
    expect(ok(r)).toBe(true);
    const ev = audit.events.at(-1)!;
    expect(JSON.stringify(ev.args) + ev.result).not.toContain("topsecret");
    expect(ev.redacted).toBe(true);

    const r2 = await core.pipeline.callTool(
      "plugins.config",
      { id: "vpn", key: "api_key", value: "sk-live-xyz" },
      a,
      "s",
    );
    expect(ok(r2)).toBe(true);
    const ev2 = audit.events.at(-1)!;
    expect(JSON.stringify(ev2.args) + ev2.result).not.toContain("sk-live-xyz");
  });

  it("refuses a write when the durable audit sink is unhealthy", async () => {
    const { core, audit } = adminCore();
    audit.setHealthy(false);
    const a = await auth(core, ["read", "admin"]);
    await expect(
      core.pipeline.callTool("services.restart", { name: "ados-api", confirm: true }, a, "s"),
    ).rejects.toMatchObject({ reason: "not_supported" });
    // a read is still allowed even when audit is unhealthy
    // (only writes refuse; the read plane is separate, so just confirm no throw shape leaks)
  });

  it("hides admin write tools from a read-only token's tools/list", async () => {
    const { core } = adminCore();
    const a = await auth(core, ["read"]);
    const listed = core.pipeline.listTools(a).map((t) => t.name);
    expect(listed).toContain("plugins.list");
    expect(listed).toContain("logs.query");
    expect(listed).not.toContain("services.restart");
    expect(listed).not.toContain("params.set");
    expect(listed).not.toContain("plugins.install");
  });
});
