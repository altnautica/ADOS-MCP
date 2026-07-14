// A durable local audit sink. Because the MCP server runs on the operator's own
// machine (not the drone's box), the durable audit store is a local newline-
// delimited JSON file the operator owns and can grep. It is created 0600 (the
// operator's eyes only) under ~/.ados/mcp by default. Each tool call appends one
// line; a write failure flips the sink unhealthy so a write tool refuses rather
// than acting un-audited (the pipeline enforces that).

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../util/logger.js";
import type { AuditEvent } from "./event.js";
import type { AuditSink } from "./sink.js";

export interface AuditQuery {
  tool?: string;
  node?: string;
  decision?: string;
  /** Only events at or after this epoch-ms time. */
  sinceMs?: number;
  /** Max rows returned (newest first). */
  limit?: number;
}

export class FileAuditSink implements AuditSink {
  private up = true;
  private ensured = false;

  constructor(private readonly path: string) {}

  async record(event: AuditEvent): Promise<void> {
    try {
      await this.ensureDir();
      await appendFile(this.path, JSON.stringify(event) + "\n", { mode: 0o600 });
      if (!this.up) {
        this.up = true;
        logger.info("audit file writable again", { path: this.path });
      }
    } catch (err) {
      if (this.up) {
        this.up = false;
        logger.error("audit file write failed; the sink is now unhealthy", {
          path: this.path,
          err: String(err),
        });
      }
    }
  }

  healthy(): boolean {
    return this.up;
  }

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    this.ensured = true;
  }
}

/**
 * Read back the local audit file, newest first, filtered. A missing file reads
 * as an empty result (nothing has been audited yet), never an error.
 */
export async function queryAuditFile(path: string, q: AuditQuery = {}): Promise<AuditEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const out: AuditEvent[] = [];
  const lines = raw.split("\n");
  // Walk newest-first (from the end) so a large file is bounded by the limit.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let ev: AuditEvent;
    try {
      ev = JSON.parse(line) as AuditEvent;
    } catch {
      continue;
    }
    if (q.tool && ev.tool !== q.tool) continue;
    if (q.node && ev.node !== q.node) continue;
    if (q.decision && ev.decision !== q.decision) continue;
    if (q.sinceMs && ev.tsUs / 1000 < q.sinceMs) continue;
    out.push(ev);
  }
  return out;
}
