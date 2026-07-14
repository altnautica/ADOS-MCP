// The audit sink interface and a stderr sink. Every tool call writes one event.
// The durable sink (the platform logging store over its ingest socket) is added
// where it belongs in the read plane; the stderr sink is the always-available
// baseline so audit is never silently dropped even before the durable sink is
// configured.

import { logger } from "../util/logger.js";
import type { AuditEvent } from "./event.js";

export interface AuditSink {
  /** Record one audit event. Must not throw; a sink failure never blocks a read
   * but a write tool refuses if its audit cannot be recorded (enforced by the
   * pipeline, not here). */
  record(event: AuditEvent): Promise<void>;
  /** True when the sink is currently able to record. */
  healthy(): boolean;
  /** Release any resources. */
  close?(): Promise<void>;
}

/** Writes each audit event to stderr as one JSON line. Always healthy. */
export class StderrAuditSink implements AuditSink {
  async record(event: AuditEvent): Promise<void> {
    logger.info("mcp.tool_call", {
      audit: {
        tokenId: event.tokenId,
        operatorId: event.operatorId,
        tool: event.tool,
        node: event.node,
        decision: event.decision,
        result: event.result,
        latencyMs: event.latencyMs,
        plane: event.plane,
        redacted: event.redacted ?? false,
      },
    });
  }

  healthy(): boolean {
    return true;
  }
}

/** Fan out to several sinks; healthy if any is healthy. */
export class MultiAuditSink implements AuditSink {
  constructor(private readonly sinks: AuditSink[]) {}

  async record(event: AuditEvent): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.record(event)));
  }

  healthy(): boolean {
    return this.sinks.some((s) => s.healthy());
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.close?.()));
  }
}
