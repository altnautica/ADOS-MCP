// Token revocation. Two mechanisms, per the auth design:
//   - Bulk revoke is the HKDF salt fold in issuers.ts (rotating the agent's
//     mcp_token_salt or re-pairing changes the derived key, so every prior
//     agent token stops verifying). That happens outside this module.
//   - Single revoke is a small denylist of tokenIds that survives reboot. In
//     agent-mode it is a 0600 JSON file; in fleet-mode the hosted server flips
//     a `revoked` flag on the issuance row and pushes it here.
//
// A revoked token fails on its next call.

import { readFileSync } from "node:fs";
import { logger } from "../util/logger.js";

export interface RevocationSource {
  isRevoked(tokenId: string): boolean;
}

export class DenylistRevocation implements RevocationSource {
  private readonly ids = new Set<string>();

  constructor(private readonly filePath?: string) {
    this.reload();
  }

  isRevoked(tokenId: string): boolean {
    return this.ids.has(tokenId);
  }

  /** Add a tokenId at runtime (a fleet-mode push, or a local revoke). */
  revoke(tokenId: string): void {
    this.ids.add(tokenId);
  }

  /** Re-read the on-disk denylist. Missing or malformed file means an empty list. */
  reload(): void {
    if (!this.filePath) return;
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { revoked?: unknown }).revoked)
          ? (parsed as { revoked: unknown[] }).revoked
          : [];
      this.ids.clear();
      for (const id of list) {
        if (typeof id === "string") this.ids.add(id);
      }
    } catch (err) {
      // An unreadable denylist is treated as empty, but it is logged loudly so a
      // permissions problem does not silently disable revocation.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`revocation denylist unreadable at ${this.filePath}: ${String(err)}`);
      }
    }
  }
}

/** A source that never revokes; the default when no denylist is configured. */
export const NO_REVOCATION: RevocationSource = { isRevoked: () => false };
