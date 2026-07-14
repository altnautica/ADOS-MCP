// Regenerate the committed tools catalog. Run `npm run catalog:export` after
// adding or editing a tool; the drift test fails CI until the committed file
// matches. A copy is also placed in the Mission Control repo's MCP tab data dir.
//
// Usage: node --import tsx scripts/export-catalog.ts

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolsCatalog, serializeCatalog } from "../src/catalog/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "catalog", "tools-catalog.json");

const catalog = buildToolsCatalog();
writeFileSync(out, serializeCatalog(catalog), "utf8");
process.stdout.write(`wrote ${catalog.toolCount} tools -> ${out}\n`);
