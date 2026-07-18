// A best-effort local "live activity" feed sink. Distinct from the durable
// audit (FileAuditSink -> audit.ndjson, the security record of completed calls):
// this writes a running-lifecycle stream (a `started` marker then a `done`
// event, paired by callId) to a sibling `activity.ndjson` so a same-machine
// Mission Control can render a pending -> done feed. It is NOT the audit-of-
// record — a write failure is swallowed and never blocks or fails a tool call
// (unlike the audit sink, which a write tool refuses without).

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logger } from "../util/logger.js";

export interface ActivityFeedEvent {
  /** Microseconds since the Unix epoch. */
  tsUs: number;
  /** Lifecycle phase: the start marker, then the completion. */
  phase: "started" | "done";
  /** Pairs a `started` with its later `done`. */
  callId: string;
  tool: string;
  /** Redacted arguments (never secret-bearing values). */
  args: Record<string, unknown>;
  node: string;
  mcpSession: string;
  plane: string;
  /** Present on `done`. */
  decision?: string;
  result?: string;
  latencyMs?: number;
}

export class ActivityFeedSink {
  private ensured = false;

  constructor(private readonly path: string) {}

  /** Append one lifecycle event. Best-effort: a failure is logged at debug and
   *  swallowed — the live feed must never affect a tool call. */
  async emit(event: ActivityFeedEvent): Promise<void> {
    try {
      if (!this.ensured) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        this.ensured = true;
      }
      await appendFile(this.path, JSON.stringify(event) + "\n", { mode: 0o600 });
    } catch (err) {
      logger.debug("activity feed write failed (ignored)", { path: this.path, err: String(err) });
    }
  }
}
