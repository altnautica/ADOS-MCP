// Shared registry types. A tool binds a name, a Zod input schema, honest MCP
// annotations, and a handler that calls the PlatformPlane. Its safety class and
// scope come from the route-to-capability table, so the two never drift.

import type { z } from "zod";
import type { NodeRef, PlaneMode, PlatformPlane } from "../plane/platform-plane.js";
import type { TokenClaims } from "../auth/token.js";

/** Context passed to a tool handler. Grows as later planes need more. */
export interface ToolCtx {
  plane: PlatformPlane;
  planeMode: PlaneMode;
  node: NodeRef;
  claims: TokenClaims;
  /** True when the target is running in simulation (SITL). */
  sim: boolean;
  /** True when the token holds secret_read; a handler leaves secrets intact. */
  secretRead: boolean;
}

/** MCP tool annotations. Advisory hints, never the enforcement point. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool handler returns a JSON-serializable value; the dispatcher wraps it. */
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolCtx) => Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  /**
   * A raw JSON-Schema for tools/list, preferred over converting `inputSchema`.
   * Plugin tools carry their manifest-declared JSON Schema here (a permissive
   * `inputSchema` zod validates the call), so the MCP client sees the tool's
   * real argument shape without a lossy JSON-Schema -> zod -> JSON-Schema trip.
   */
  rawInputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  handler: ToolHandler;
}

/** The public tool descriptor returned by tools/list. */
export interface PublicToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

/** A resource, read-once or subscribable. */
export interface ResourceDefinition {
  uriTemplate: string;
  name: string;
  description: string;
  mimeType: string;
  subscribable: boolean;
  /** Read the resource for a concrete uri; returns a JSON-serializable value. */
  read: (uri: string, ctx: ToolCtx) => Promise<unknown>;
}

/** A prompt template surfaced as a slash command. */
export interface PromptDefinition {
  name: string;
  title: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  /** Render the prompt to an MCP messages array. */
  render: (args: Record<string, string>) => { description: string; messages: PromptMessage[] };
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}
