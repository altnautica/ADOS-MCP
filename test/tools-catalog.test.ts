/**
 * Catalog drift guard. The committed catalog/tools-catalog.json must byte-match a
 * fresh build. So a newly registered tool, or an edited description, that was not
 * re-exported (`npm run catalog:export`) fails CI. A copy of this file is rendered
 * by the Mission Control MCP tab's Tools section, so it must stay in sync.
 *
 * @license GPL-3.0-only
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolsCatalog, serializeCatalog } from "../src/catalog/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const committedPath = resolve(here, "..", "catalog", "tools-catalog.json");

describe("tools catalog", () => {
  it("the committed catalog matches a fresh build (run `npm run catalog:export`)", () => {
    const fresh = serializeCatalog(buildToolsCatalog());
    const committed = readFileSync(committedPath, "utf8");
    expect(committed).toBe(fresh);
  });

  it("every catalog tool carries a scope and a safety class", () => {
    const cat = buildToolsCatalog();
    expect(cat.toolCount).toBeGreaterThan(0);
    for (const t of cat.tools) {
      expect(t.scope).toBeTruthy();
      expect(t.safetyClass).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});
