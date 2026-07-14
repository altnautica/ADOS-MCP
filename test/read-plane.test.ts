import { describe, it, expect } from "vitest";
import { makeCore, mintLocalToken } from "./helpers.js";
import { registerReadTools } from "../src/registry/read-tools.js";
import { registerReadResources } from "../src/registry/read-resources.js";
import type { ServerCore } from "../src/server.js";

const AUDIT = "/tmp/ados-mcp-read-plane-test.ndjson";

function readPlaneCore(): { core: ServerCore; audit: ReturnType<typeof makeCore>["audit"] } {
  const { core, audit } = makeCore({ auditPath: AUDIT });
  registerReadTools(core.tools, AUDIT);
  registerReadResources(core.resources);
  return { core, audit };
}

async function auth(core: ServerCore, scopes: string[] = ["read"]) {
  const token = await mintLocalToken({ scopes: scopes as never });
  return core.pipeline.authenticateBearer(token);
}

describe("read plane", () => {
  it("serves status / telemetry / fleet reads to a read token and audits them", async () => {
    const { core, audit } = readPlaneCore();
    const a = await auth(core);
    const status = await core.pipeline.callTool("status.get", {}, a, "s");
    expect(status.structuredContent).toMatchObject({ ok: true });
    const tel = await core.pipeline.callTool("telemetry.snapshot", {}, a, "s");
    expect(tel.structuredContent).toHaveProperty("battery");
    const nodes = await core.pipeline.callTool("fleet.list_nodes", {}, a, "s");
    expect(Array.isArray(nodes.structuredContent)).toBe(true);
    expect(audit.events.map((e) => e.decision)).toEqual(["allowed", "allowed", "allowed"]);
  });

  it("joins firmware metadata on params.read_all", async () => {
    const { core } = readPlaneCore();
    const a = await auth(core);
    const r = await core.pipeline.callTool("params.read_all", {}, a, "s");
    const body = r.structuredContent as { firmware: string; total: number; params: { name: string }[] };
    expect(body.firmware).toBe("ardupilot");
    expect(body.total).toBe(2);
    expect(body.params.map((p) => p.name)).toContain("FENCE_ENABLE");
  });

  it("redacts secret-shaped config fields unless the token holds secret_read", async () => {
    const { core } = readPlaneCore();
    const a = await auth(core, ["read"]);
    const r = await core.pipeline.callTool("config.get", {}, a, "s");
    expect((r.structuredContent as { api_key: string }).api_key).toBe("[REDACTED]");

    const a2 = await auth(core, ["read", "secret_read"]);
    const r2 = await core.pipeline.callTool("config.get", {}, a2, "s");
    expect((r2.structuredContent as { api_key: string }).api_key).toBe("s3cr3t");
  });

  it("refuses a read tool from a token without the read scope", async () => {
    const { core } = readPlaneCore();
    const a = await auth(core, ["safe_write"]);
    await expect(core.pipeline.callTool("status.get", {}, a, "s")).rejects.toMatchObject({
      reason: "scope_missing",
    });
  });

  it("reads a resource through the gate and audits it", async () => {
    const { core, audit } = readPlaneCore();
    const a = await auth(core);
    const def = core.resources.match("ados://local/status");
    expect(def).toBeTruthy();
    const value = await core.pipeline.readResource(def!, "ados://local/status", a, "s");
    expect(value).toMatchObject({ ok: true });
    expect(audit.events.at(-1)).toMatchObject({ tool: "resource:Node status", decision: "allowed" });
  });

  it("refuses a resource read without the read scope", async () => {
    const { core } = readPlaneCore();
    const a = await auth(core, ["safe_write"]);
    const def = core.resources.match("ados://local/telemetry")!;
    await expect(core.pipeline.readResource(def, "ados://local/telemetry", a, "s")).rejects.toMatchObject({
      reason: "scope_missing",
    });
  });

  it("queries the local audit log without throwing on a fresh file", async () => {
    const { core } = readPlaneCore();
    const a = await auth(core);
    const r = await core.pipeline.callTool("audit.query", { limit: 5 }, a, "s");
    expect(r.structuredContent).toHaveProperty("events");
  });

  it("registers exactly the read-scoped tools (no write escapes into the read plane)", async () => {
    const { core } = readPlaneCore();
    const a = await auth(core, ["read"]);
    const listed = core.pipeline.listTools(a).map((t) => t.name);
    // every registered read-plane tool is visible to a pure read token
    expect(listed).toEqual(
      expect.arrayContaining(["status.get", "params.read_all", "fleet.list_nodes", "audit.query"]),
    );
    // and nothing that mutates leaked in
    expect(listed).not.toContain("params.set");
    expect(listed).not.toContain("services.restart");
  });

  it("serves node-agnostic tools in fleet-mode without a node argument", async () => {
    const { core } = makeCore({ mode: "fleet", auditPath: AUDIT });
    registerReadTools(core.tools, AUDIT);
    registerReadResources(core.resources);
    const token = await mintLocalToken({ scopes: ["read"] as never, allowedNodes: ["n1"] });
    const a = await core.pipeline.authenticateBearer(token);
    // fleet.list_nodes + audit.query are node-agnostic: no node arg needed.
    const nodes = await core.pipeline.callTool("fleet.list_nodes", {}, a, "s");
    expect(Array.isArray(nodes.structuredContent)).toBe(true);
    const aq = await core.pipeline.callTool("audit.query", { limit: 3 }, a, "s");
    expect(aq.structuredContent).toHaveProperty("events");
    // but a node-targeting tool still requires a node in fleet-mode.
    await expect(core.pipeline.callTool("status.get", {}, a, "s")).rejects.toMatchObject({
      reason: "node_required",
    });
  });

  it("never persists a returned secret into the audit result, even under secret_read", async () => {
    const { core, audit } = readPlaneCore();
    const a = await auth(core, ["read", "secret_read"]);
    const r = await core.pipeline.callTool("config.get", {}, a, "s");
    // the client still receives the cleartext value it asked for
    expect((r.structuredContent as { api_key: string }).api_key).toBe("s3cr3t");
    // but the durable audit record is redacted and flags the disclosure
    const last = audit.events.at(-1)!;
    expect(JSON.stringify(last.args) + last.result).not.toContain("s3cr3t");
    expect(last.sensitiveRead).toBe(true);
  });
});
