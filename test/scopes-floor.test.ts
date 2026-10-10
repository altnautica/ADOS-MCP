import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { CAPABILITY_FLOOR } from "../src/auth/capability-floor.generated.js";
import {
  READ_SAFE_ALLOWLIST,
  capabilityFloorClass,
  grantsAffectFlight,
} from "../src/auth/scopes.js";

// The agent capability catalog, present when the sibling agent checkout exists.
const CATALOG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../ADOSDroneAgent/crates/ados-protocol/capabilities.toml",
);

/** The `id` of every `[[agent]]` table in the catalog. */
function agentCatalogIds(toml: string): string[] {
  const ids: string[] = [];
  let inAgent = false;
  for (const line of toml.split(/\r?\n/)) {
    const table = /^\s*\[\[(\w+)\]\]/.exec(line);
    if (table) {
      inAgent = table[1] === "agent";
      continue;
    }
    const id = inAgent ? /^\s*id\s*=\s*"([^"]+)"/.exec(line) : null;
    if (id?.[1]) ids.push(id[1]);
  }
  return ids;
}

// Ids that sit in neither the generated floor nor the allowlist and are admin on
// purpose (process, filesystem and network reach).
const DELIBERATE_ADMIN = ["filesystem.host", "network.listen", "network.outbound", "process.spawn"];

describe("capability floor", () => {
  it("floors flight-control writes at flight and hardware at admin", () => {
    for (const c of ["msp.write", "estimator.pose.inject", "vision.track.designate"]) {
      expect(capabilityFloorClass(c), c).toBe("flight");
      expect(grantsAffectFlight([c]), c).toBe(true);
    }
    for (const c of ["hardware.uart", "hardware.usb", "hardware.spi", "hardware.gpio", "hardware.gpio_out"]) {
      expect(capabilityFloorClass(c), c).toBe("admin");
    }
  });

  it("treats an id outside the floor and the allowlist as admin", () => {
    expect(capabilityFloorClass("brand.new.capability")).toBe("admin");
    expect(capabilityFloorClass("plugin.com.example-oem.payload.trigger")).toBeNull();
  });

  it("the generated floor only carries flight and admin", () => {
    for (const [id, cls] of Object.entries(CAPABILITY_FLOOR)) {
      expect(["flight", "admin"], id).toContain(cls);
      expect(READ_SAFE_ALLOWLIST.has(id), id).toBe(false);
    }
  });

  it.skipIf(!existsSync(CATALOG))("gives every agent catalog id a floor or an allowlist entry", () => {
    const ids = agentCatalogIds(readFileSync(CATALOG, "utf8"));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const covered =
        id in CAPABILITY_FLOOR ||
        READ_SAFE_ALLOWLIST.has(id) ||
        DELIBERATE_ADMIN.includes(id) ||
        capabilityFloorClass(id) === "flight" ||
        capabilityFloorClass(id) === "destructive";
      expect(covered, id).toBe(true);
    }
  });
});
