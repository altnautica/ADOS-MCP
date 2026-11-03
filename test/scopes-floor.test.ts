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
// purpose: process, filesystem and network reach, and writes that change what
// every other consumer sees. capture.storage.write writes the capture volume and
// raises the marker that switches the flight controller's sensor rates;
// sensors.rig.write replaces the calibration every fused sample uses;
// camera.control.write changes a capture camera's exposure for every consumer;
// video.whep.relay hands the node's live camera video to the plugin's viewers.
const DELIBERATE_ADMIN = [
  "camera.control.write",
  "capture.storage.write",
  "filesystem.host",
  "network.listen",
  "network.outbound",
  "process.spawn",
  "sensors.rig.write",
  "video.whep.relay",
];

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
