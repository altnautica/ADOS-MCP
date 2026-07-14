import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../../src/transport/http.js";
import { makeCore, mintLocalToken, registerFakeReadTool } from "../helpers.js";

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

async function boot(scopes: string[]): Promise<{ url: string; token: string; noToken: string }> {
  const { core } = makeCore();
  registerFakeReadTool(core);
  server = await startHttpServer(core, 0, "127.0.0.1");
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const token = await mintLocalToken({ scopes: scopes as never });
  const noToken = "";
  return { url, token, noToken };
}

function client(url: string, token: string): { client: Client; transport: StreamableHTTPClientTransport } {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: "test-client", version: "0.0.0" });
  return { client: c, transport };
}

describe("Streamable HTTP transport (P0 gate)", () => {
  it("healthz reports ok", async () => {
    const { url } = await boot(["read"]);
    const res = await fetch(url.replace("/mcp", "/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBeTruthy();
  });

  it("a read-scoped client connects, lists, and calls a read tool", async () => {
    const { url, token } = await boot(["read"]);
    const { client: c, transport } = client(url, token);
    await c.connect(transport);
    const tools = await c.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("status.get");
    const result = await c.callTool({ name: "status.get", arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain("ok");
    await c.close();
  });

  it("rejects a request with no bearer token (401)", async () => {
    const { url } = await boot(["read"]);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("an unscoped token connects but sees no tools and is refused on a call", async () => {
    const { url, token } = await boot([]); // no scopes
    const { client: c, transport } = client(url, token);
    await c.connect(transport);
    const tools = await c.listTools();
    expect(tools.tools).toHaveLength(0);
    await expect(c.callTool({ name: "status.get", arguments: {} })).rejects.toThrow();
    await c.close();
  });
});
