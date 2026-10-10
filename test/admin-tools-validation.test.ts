import { describe, it, expect } from "vitest";
import { makeCore, mintLocalToken } from "./helpers.js";
import { registerAdminTools } from "../src/registry/admin-tools.js";
import { pathSegment } from "../src/plane/lan-direct.js";

async function adminCall(tool: string, args: Record<string, unknown>) {
  const { core } = makeCore({ auditPath: "/tmp/ados-mcp-admin-validation.ndjson" });
  registerAdminTools(core.tools);
  const token = await mintLocalToken({ scopes: ["read", "admin"] as never });
  const auth = await core.pipeline.authenticateBearer(token);
  return core.pipeline.callTool(tool, args, auth, "s");
}

describe("admin tool argument patterns", () => {
  it("refuses a dot-dot plugin id", async () => {
    for (const tool of ["plugins.enable", "plugins.disable", "plugins.remove"]) {
      await expect(adminCall(tool, { id: "..", confirm: true })).rejects.toMatchObject({
        reason: "invalid_arguments",
      });
    }
    await expect(adminCall("plugins.enable", { id: "com..example", confirm: true })).rejects.toMatchObject({
      reason: "invalid_arguments",
    });
    await expect(adminCall("plugins.info", { id: "../enable" })).rejects.toMatchObject({
      reason: "invalid_arguments",
    });
  });

  it("refuses a malformed parameter name", async () => {
    await expect(adminCall("params.set", { name: "..", value: 1, confirm: true })).rejects.toMatchObject({
      reason: "invalid_arguments",
    });
    await expect(
      adminCall("params.set", { name: "arming_check", value: 1, confirm: true }),
    ).rejects.toMatchObject({ reason: "invalid_arguments" });
  });

  it("refuses a unit outside the ados- namespace", async () => {
    for (const name of ["..", "sshd", "ados-..", "ados-x/../y"]) {
      await expect(adminCall("services.restart", { name, confirm: true })).rejects.toMatchObject({
        reason: "invalid_arguments",
      });
    }
  });

  it("accepts well-formed ids", async () => {
    const r = await adminCall("plugins.enable", { id: "com.example-oem.payload", confirm: true });
    expect(r.structuredContent).toMatchObject({ ok: true });
  });

  it("refuses dot segments at the agent route boundary", () => {
    for (const v of ["", ".", "..", "a..b", "a/b"]) {
      expect(() => pathSegment(v), v).toThrow(expect.objectContaining({ reason: "invalid_arguments" }));
    }
    expect(pathSegment("com.example-oem.payload")).toBe("com.example-oem.payload");
  });
});
