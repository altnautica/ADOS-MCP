import { describe, it, expect } from "vitest";
import { GateError } from "../../src/gate/errors.js";
import {
  makeCore,
  mintLocalToken,
  registerFakeAdminTool,
  registerFakeReadTool,
} from "../helpers.js";

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
});
