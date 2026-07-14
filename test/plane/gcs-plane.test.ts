import { describe, it, expect } from "vitest";
import { GcsPlane } from "../../src/plane/gcs-plane.js";

describe("GcsPlane honest reach limits", () => {
  // No Convex url: the not_supported writes short-circuit before any auth/query.
  const plane = new GcsPlane({});

  it("refuses writes the relay vocabulary cannot carry, naming the direct reach", async () => {
    const calls: (() => Promise<unknown>)[] = [
      () => plane.setParam("n", "ATC_RAT_RLL_P", 1),
      () => plane.setConfig("n", "video.bitrate", "8"),
      () => plane.pluginInstall("n", "https://example.test/p.adosplug"),
      () => plane.pluginConfig("n", "id", "k", "v"),
      () => plane.restartSupervisor("n"),
      () => plane.getPlugins("n"),
      () => plane.getPluginInfo("n", "id"),
    ];
    for (const c of calls) {
      await expect(c()).rejects.toMatchObject({ reason: "not_supported" });
    }
  });

  it("refuses a keep-data plugin removal over the relay rather than destroying data", async () => {
    await expect(plane.pluginRemove("n", "id", true)).rejects.toMatchObject({ reason: "not_supported" });
  });

  it("validates the service unit name before enqueue", async () => {
    await expect(plane.restartService("n", "")).rejects.toMatchObject({ reason: "invalid_arguments" });
  });

  it("describes itself as the fleet (GCS-interface) plane", () => {
    expect(plane.describe().mode).toBe("fleet");
  });
});
