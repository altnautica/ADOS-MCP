import { describe, it, expect } from "vitest";
import { z } from "zod";
import { GateError } from "../../src/gate/errors.js";
import {
  makeCore,
  mintLocalToken,
  registerFakeAdminTool,
  registerFakeReadTool,
} from "../helpers.js";
import type { ServerCore } from "../../src/server.js";
import { toOutcome } from "../../src/plane/lan-direct.js";

function registerFakeRestartTool(core: ServerCore): void {
  core.tools.register({
    name: "services.restart",
    description: "fake restart",
    inputSchema: z.object({ name: z.string(), confirm: z.boolean().optional() }),
    handler: async (args) => ({ restarted: args.name }),
  });
}

function registerFakeEmergencyStop(core: ServerCore): void {
  core.tools.register({
    name: "flight.emergency_stop",
    description: "fake e-stop",
    inputSchema: z.object({ confirm: z.string().optional(), confirm_id: z.string().optional() }),
    handler: async () => ({ stopped: true }),
  });
}

/** A read tool that returns a secret-shaped field; status.full has a route-cap row. */
function registerFakeSecretRead(core: ServerCore): void {
  core.tools.register({
    name: "status.full",
    description: "fake full status with a secret field",
    inputSchema: z.object({ node: z.string().optional() }),
    annotations: { readOnlyHint: true },
    handler: async () => ({ wifi_psk: "abc123", mode: "GUIDED" }),
  });
}

async function readAuth(core: ReturnType<typeof makeCore>["core"], scopes: string[] = ["read"]) {
  const token = await mintLocalToken({ scopes: scopes as never });
  return core.pipeline.authenticateBearer(token);
}

describe("GatePipeline integration", () => {
  it("authenticates a valid token and rejects an expired one", async () => {
    const { core } = makeCore();
    const auth = await readAuth(core);
    expect(auth.claims.tokenId).toBe("tk-test");
    const expired = await mintLocalToken({ expiresAt: Date.now() - 1000 });
    await expect(core.pipeline.authenticateBearer(expired)).rejects.toMatchObject({
      reason: "token_expired",
    });
  });

  it("lists only the tools a token's scopes cover", async () => {
    const { core } = makeCore();
    registerFakeReadTool(core);
    registerFakeAdminTool(core);
    const readAuthCtx = await readAuth(core, ["read"]);
    const readList = core.pipeline.listTools(readAuthCtx).map((t) => t.name);
    expect(readList).toContain("status.get");
    expect(readList).not.toContain("admin.node.rename");

    const adminAuth = await readAuth(core, ["read", "admin"]);
    const adminList = core.pipeline.listTools(adminAuth).map((t) => t.name);
    expect(adminList).toContain("admin.node.rename");
  });

  it("runs a read tool and audits it as allowed", async () => {
    const { core, audit } = makeCore();
    registerFakeReadTool(core);
    const auth = await readAuth(core);
    const result = await core.pipeline.callTool("status.get", {}, auth, "sess");
    expect(result.content[0]?.text).toContain("ok");
    expect(audit.events.at(-1)).toMatchObject({ tool: "status.get", decision: "allowed" });
  });

  it("rejects a write from a read-only token and audits the denial", async () => {
    const { core, audit } = makeCore();
    registerFakeAdminTool(core);
    const auth = await readAuth(core, ["read"]);
    await expect(
      core.pipeline.callTool("admin.node.rename", { name: "x", confirm: true }, auth, "sess"),
    ).rejects.toMatchObject({ reason: "scope_missing" });
    expect(audit.events.at(-1)).toMatchObject({ tool: "admin.node.rename", decision: "denied" });
  });

  it("requires confirm for an admin tool and passes with it", async () => {
    const { core } = makeCore();
    registerFakeAdminTool(core);
    const auth = await readAuth(core, ["read", "admin"]);
    await expect(
      core.pipeline.callTool("admin.node.rename", { name: "x" }, auth, "sess"),
    ).rejects.toMatchObject({ reason: "confirm_required" });
    const ok = await core.pipeline.callTool(
      "admin.node.rename",
      { name: "x", confirm: true },
      auth,
      "sess",
    );
    expect(ok.content[0]?.text).toContain("renamed");
  });

  it("rejects an unknown tool", async () => {
    const { core } = makeCore();
    const auth = await readAuth(core);
    await expect(core.pipeline.callTool("does.not.exist", {}, auth, "sess")).rejects.toMatchObject({
      reason: "unknown_tool",
    });
  });

  it("trusts an on-box caller past the scope and confirm gates", async () => {
    const { core } = makeCore();
    registerFakeAdminTool(core);
    const onBox = core.onBoxContext();
    const ok = await core.pipeline.callTool("admin.node.rename", { name: "x" }, onBox, "sess");
    expect(ok.content[0]?.text).toContain("renamed");
  });

  it("refuses a write when the audit sink is unhealthy", async () => {
    const { core, audit } = makeCore();
    registerFakeAdminTool(core);
    const auth = await readAuth(core, ["read", "admin"]);
    audit.setHealthy(false);
    await expect(
      core.pipeline.callTool("admin.node.rename", { name: "x", confirm: true }, auth, "sess"),
    ).rejects.toBeInstanceOf(GateError);
  });
});

describe("GatePipeline fleet-mode targeting", () => {
  it("requires a node argument in fleet-mode", async () => {
    const { core } = makeCore({ mode: "fleet", convexUrl: "https://convex.example" });
    registerFakeReadTool(core);
    const token = await mintLocalToken({ scopes: ["read"] as never, allowedNodes: ["ados-a"] });
    const auth = await core.pipeline.authenticateBearer(token);
    await expect(core.pipeline.callTool("status.get", {}, auth, "sess")).rejects.toMatchObject({
      reason: "node_required",
    });
  });

  it("rejects a node outside the token's allowedNodes", async () => {
    const { core } = makeCore({ mode: "fleet", convexUrl: "https://convex.example" });
    registerFakeReadTool(core);
    const token = await mintLocalToken({ scopes: ["read"] as never, allowedNodes: ["ados-a"] });
    const auth = await core.pipeline.authenticateBearer(token);
    await expect(
      core.pipeline.callTool("status.get", { node: "ados-b" }, auth, "sess"),
    ).rejects.toMatchObject({ reason: "node_not_allowed" });
  });

  it("fails CLOSED on an empty allowedNodes in fleet-mode (never 'any node')", async () => {
    const { core } = makeCore({ mode: "fleet", convexUrl: "https://convex.example" });
    registerFakeReadTool(core);
    const token = await mintLocalToken({ scopes: ["read"] as never, allowedNodes: [] });
    const auth = await core.pipeline.authenticateBearer(token);
    await expect(
      core.pipeline.callTool("status.get", { node: "ados-anything" }, auth, "sess"),
    ).rejects.toMatchObject({ reason: "node_not_allowed" });
  });
});

describe("GatePipeline audit-fix behaviors", () => {
  it("escalates services.restart of an armed-critical unit to the flight scope", async () => {
    const { core } = makeCore();
    registerFakeRestartTool(core);
    const admin = await readAuth(core, ["read", "safe_write", "admin"]);
    // An armed-critical unit escalates to flight; an admin-only token is refused.
    await expect(
      core.pipeline.callTool("services.restart", { name: "ados-mavlink", confirm: true }, admin, "s"),
    ).rejects.toMatchObject({ reason: "scope_missing" });
    // A non-critical unit stays admin (passes with confirm).
    const ok = await core.pipeline.callTool(
      "services.restart",
      { name: "ados-camera", confirm: true },
      admin,
      "s",
    );
    expect(ok.content[0]?.text).toContain("restarted");
  });

  it("refuses a flight-affecting destructive tool while the enforce flag is off", async () => {
    const { core } = makeCore({ flightEnforced: false });
    registerFakeEmergencyStop(core);
    const auth = await readAuth(core, ["read", "destructive"]);
    await expect(
      core.pipeline.callTool("flight.emergency_stop", { confirm: "x" }, auth, "s"),
    ).rejects.toMatchObject({ reason: "ws_proxy_enforce_off" });
    // And it is not even listed while enforce is off.
    expect(core.pipeline.listTools(auth).map((t) => t.name)).not.toContain("flight.emergency_stop");
  });

  it("returns success even if the audit write throws after the handler ran", async () => {
    const { core, audit } = makeCore();
    registerFakeReadTool(core);
    // Make record() throw once the handler has already run.
    const original = audit.record.bind(audit);
    let threw = false;
    audit.record = async (e) => {
      if (!threw) {
        threw = true;
        throw new Error("logd blip");
      }
      return original(e);
    };
    const auth = await readAuth(core, ["read"]);
    const result = await core.pipeline.callTool("status.get", {}, auth, "s");
    expect(result.content[0]?.text).toContain("ok");
  });
});

describe("central result redaction (secret_read)", () => {
  it("masks a secret-shaped field for a read-only token and audits redacted", async () => {
    const { core, audit } = makeCore();
    registerFakeSecretRead(core);
    const auth = await readAuth(core, ["read"]);
    const result = await core.pipeline.callTool("status.full", {}, auth, "s");
    const body = JSON.parse(result.content[0]!.text) as { wifi_psk: string; mode: string };
    expect(body.wifi_psk).toBe("[REDACTED]");
    expect(body.mode).toBe("GUIDED");
    const ev = audit.events.at(-1)!;
    expect(ev.redacted).toBe(true);
    expect(ev.sensitiveRead).toBeUndefined();
  });

  it("returns the raw secret for a secret_read token and audits sensitiveRead", async () => {
    const { core, audit } = makeCore();
    registerFakeSecretRead(core);
    const auth = await readAuth(core, ["read", "secret_read"]);
    const result = await core.pipeline.callTool("status.full", {}, auth, "s");
    const body = JSON.parse(result.content[0]!.text) as { wifi_psk: string };
    expect(body.wifi_psk).toBe("abc123");
    const ev = audit.events.at(-1)!;
    expect(ev.sensitiveRead).toBe(true);
    expect(ev.redacted).toBeUndefined();
  });

  it("does not flag a read with no secret-shaped field", async () => {
    const { core, audit } = makeCore();
    registerFakeReadTool(core);
    const auth = await readAuth(core, ["read"]);
    await core.pipeline.callTool("status.get", {}, auth, "s");
    const ev = audit.events.at(-1)!;
    expect(ev.redacted).toBeUndefined();
    expect(ev.sensitiveRead).toBeUndefined();
  });
});

describe("armed-critical service-restart alias hardening", () => {
  it("escalates a flight-critical unit ALIAS to the flight scope (separator-normalized)", async () => {
    const { core } = makeCore();
    registerFakeRestartTool(core);
    const admin = await readAuth(core, ["read", "admin"]);
    // an admin token lacks flight, so a restart of a flight-critical alias is refused
    for (const name of ["mavlink_router", "MAVLink-Router.service", "ados-video-relay"]) {
      await expect(
        core.pipeline.callTool("services.restart", { name, confirm: true }, admin, "s"),
      ).rejects.toMatchObject({ reason: "scope_missing" });
    }
  });

  it("does not over-escalate a benign unit to the flight scope", async () => {
    const { core } = makeCore();
    registerFakeRestartTool(core);
    const admin = await readAuth(core, ["read", "admin"]);
    // a benign unit stays at admin — an admin token is not blocked for lacking flight
    await expect(
      core.pipeline.callTool("services.restart", { name: "ados-logd", confirm: true }, admin, "s"),
    ).resolves.toBeDefined();
  });
});

describe("LanDirect toOutcome honors an in-body failure", () => {
  it("reports a 2xx with { success:false } as failed, not completed", () => {
    expect(toOutcome({ success: false, message: "nope" })).toMatchObject({ ok: false, status: "failed" });
    expect(toOutcome({ success: true })).toMatchObject({ ok: true, status: "completed" });
    expect(toOutcome({ restarted: "ados-logd" })).toMatchObject({ ok: true, status: "completed" });
  });
});
