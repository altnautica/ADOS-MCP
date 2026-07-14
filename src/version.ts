// Single source of truth for the server version and the MCP spec revision it targets.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const SERVER_NAME = "ados-mcp";
export const SERVER_VERSION: string = pkg.version;

// The Model Context Protocol specification revision this server targets.
// Streamable HTTP is the single-endpoint transport introduced at this revision.
export const MCP_SPEC_REVISION = "2025-06-18";
