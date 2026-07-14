// A best-effort cloud mirror of the audit stream. The DURABLE audit record is the
// local FileAuditSink (the server runs on the operator's machine); this pushes a
// lean, already-redacted copy to Mission Control so the MCP tab shows one cross-
// node history. It batches on a short timer and never blocks a tool call: a Convex
// hiccup drops the batch (the local file still has it), it never re-queues without
// bound, and healthy() is ALWAYS true so a cloud outage cannot refuse a write.

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { createHash } from "node:crypto";
import { logger } from "../util/logger.js";
import type { AuditEvent } from "./event.js";
import type { AuditSink } from "./sink.js";

const RECORD_AUDIT = makeFunctionReference<"action">("cmdMcpReach:recordAudit");

/**
 * One lean mirror row. Matches the `cmdMcpReach.recordAudit` event validator; the
 * server-verified `userId` + `tokenId` are stamped by the action, never sent here,
 * and the full (redacted) argument map is NOT mirrored — it stays in the local file.
 */
interface MirrorRow {
  tool: string;
  node: string;
  decision: AuditEvent["decision"];
  result: string;
  plane: AuditEvent["plane"];
  latencyMs: number;
  tsUs: number;
  mcpSession?: string;
  argsRedacted?: boolean;
  sensitiveRead?: boolean;
  contentHash: string;
}

export interface ConvexAuditSinkConfig {
  convexUrl: string;
  credential: string;
  flushMs?: number;
  batchSize?: number;
  maxQueue?: number;
}

export class ConvexAuditSink implements AuditSink {
  private readonly client: ConvexHttpClient;
  private readonly credential: string;
  private readonly flushMs: number;
  private readonly batchSize: number;
  private readonly maxQueue: number;
  private queue: MirrorRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private closed = false;

  constructor(cfg: ConvexAuditSinkConfig) {
    this.client = new ConvexHttpClient(cfg.convexUrl);
    this.credential = cfg.credential;
    this.flushMs = cfg.flushMs ?? 3000;
    this.batchSize = cfg.batchSize ?? 50;
    this.maxQueue = cfg.maxQueue ?? 500;
  }

  async record(event: AuditEvent): Promise<void> {
    if (this.closed) return;
    const row: MirrorRow = {
      tool: event.tool,
      node: event.node,
      decision: event.decision,
      result: event.result.slice(0, 500),
      plane: event.plane,
      latencyMs: event.latencyMs,
      tsUs: event.tsUs,
      ...(event.mcpSession ? { mcpSession: event.mcpSession } : {}),
      ...(event.redacted !== undefined ? { argsRedacted: event.redacted } : {}),
      ...(event.sensitiveRead !== undefined ? { sensitiveRead: event.sensitiveRead } : {}),
      contentHash: contentHashOf(event),
    };
    this.queue.push(row);
    // Bound the queue: on overflow drop the OLDEST (the newest activity matters most
    // for the live tab; the local file remains the complete record).
    if (this.queue.length > this.maxQueue) {
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    } else {
      this.ensureTimer();
    }
  }

  healthy(): boolean {
    // Best-effort. The durable file sink is the one whose failure may refuse a
    // write; a down cloud mirror must never block a fleet-mode tool call.
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private ensureTimer(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    // Do not keep the event loop alive just to flush audit.
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    // Take up to a batch; recordAudit caps at 200 server-side.
    const batch = this.queue.splice(0, 200);
    try {
      await this.client.action(RECORD_AUDIT, { credential: this.credential, events: batch });
    } catch (err) {
      // Best-effort: the durable local file already has these. Drop, do not
      // re-queue (a persistently-down backend must not grow memory without bound).
      logger.debug("mcp audit cloud mirror push failed; dropping batch", {
        count: batch.length,
        err: String(err),
      });
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * The dedupe key for an idempotent re-push. `tsUs` is microsecond-unique per call,
 * so this identifies the event without the server-assigned tokenId; it must not
 * depend on anything the client controls for identity beyond the call itself.
 */
function contentHashOf(event: AuditEvent): string {
  const basis = `${event.tsUs}:${event.tool}:${event.node}:${event.decision}:${event.mcpSession ?? ""}`;
  return createHash("sha256").update(basis).digest("hex");
}
