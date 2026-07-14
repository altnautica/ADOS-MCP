import { describe, it, expect } from "vitest";
import { makeCore, mintLocalToken } from "./helpers.js";
import { registerReadTools } from "../src/registry/read-tools.js";
import type { ServerCore } from "../src/server.js";

const AUDIT = "/tmp/ados-mcp-cred-test.ndjson";

// The FakePlane.verifyCredential encodes scopes in the credential ("cred:read,admin")
// and treats "revoked-cred" as revoked (returns null).
function fleetCore(credential: string): { core: ServerCore } {
  const { core } = makeCore({ mode: "fleet", credential, auditPath: AUDIT });
  return { core };
}

describe("fleet-mode machine credential auth", () => {
  it("authenticates the configured credential and grants its scopes", async () => {
    const { core } = fleetCore("ados_mc_valid:read,admin");
    const auth = await core.pipeline.authenticateBearer("ados_mc_valid:read,admin");
    expect(auth.claims.operatorId).toBe("cloud:op-fake");
    expect(auth.claims.iss).toBe("cloud:op-fake");
    expect(auth.claims.scopes).toEqual(["read", "admin"]);
    expect(auth.plane).toBe("cloud_relay");
  });

  it("rejects a bearer that is not the configured credential (no confused deputy)", async () => {
    const { core } = fleetCore("ados_mc_server:read");
    await expect(
      core.pipeline.authenticateBearer("ados_mc_attacker:read,admin"),
    ).rejects.toMatchObject({ reason: "unauthorized" });
  });

  it("rejects when the backend reports the credential revoked", async () => {
    const { core } = fleetCore("revoked-cred");
    await expect(core.pipeline.authenticateBearer("revoked-cred")).rejects.toMatchObject({
      reason: "token_revoked",
    });
  });

  it("drops unknown scope strings the backend returns", async () => {
    const { core } = fleetCore("ados_mc_x:read,bogus,admin");
    const auth = await core.pipeline.authenticateBearer("ados_mc_x:read,bogus,admin");
    expect(auth.claims.scopes).toEqual(["read", "admin"]);
  });

  it("still accepts a local dev HMAC token in fleet-mode (it has a dot, so routes to the token path)", async () => {
    const { core } = fleetCore("ados_mc_server:read");
    const local = await mintLocalToken({ scopes: ["read"] as never });
    const auth = await core.pipeline.authenticateBearer(local);
    expect(auth.claims.iss).toBe("local");
    expect(auth.plane).toBe("cloud_relay");
  });

  it("fails closed on a malformed backend principal", async () => {
    const { core } = fleetCore("malformed-cred");
    await expect(core.pipeline.authenticateBearer("malformed-cred")).rejects.toMatchObject({
      reason: "token_revoked",
    });
  });

  it("a credential with an empty allowlist may target any node (the backend gates ownership)", async () => {
    // FakePlane returns an empty allowedNodes; a backend-gated credential should
    // still reach a specific node, unlike a self-contained fleet token.
    const { core } = fleetCore("ados_mc_x:read");
    registerReadTools(core.tools, AUDIT);
    const auth = await core.pipeline.authenticateBearer("ados_mc_x:read");
    const r = await core.pipeline.callTool("status.get", { node: "n1" }, auth, "s");
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("a self-contained fleet token with an empty allowlist still fails closed on a per-node call", async () => {
    const { core } = fleetCore("ados_mc_x:read");
    registerReadTools(core.tools, AUDIT);
    // a local HMAC token (not backend-gated) with no allowedNodes
    const local = await mintLocalToken({ scopes: ["read"] as never, allowedNodes: [] });
    const auth = await core.pipeline.authenticateBearer(local);
    await expect(core.pipeline.callTool("status.get", { node: "n1" }, auth, "s")).rejects.toMatchObject({
      reason: "node_not_allowed",
    });
  });
});
