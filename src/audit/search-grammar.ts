// A small field-qualified search grammar for the local audit log. A query is a
// whitespace-separated list of tokens: a `field:value` token (field one of
// tool / node / operator / decision / result) is a field filter (case-insensitive
// substring on that field); every other token is a free-text term that must match
// somewhere in the event. All filters AND together. Unqualified queries behave as
// a plain substring search, so the grammar is backward-compatible.

const FIELDS = ["tool", "node", "operator", "decision", "result"] as const;
export type AuditField = (typeof FIELDS)[number];

export interface ParsedAuditQuery {
  fields: Array<{ field: AuditField; value: string }>;
  terms: string[];
}

/** The subset of an audit event the grammar reads. */
export interface AuditEventLike {
  tool?: string;
  node?: string;
  operatorId?: string;
  decision?: string;
  result?: string;
}

/** Parse a query string into field filters + free-text terms (all lower-cased). */
export function parseAuditQuery(query: string): ParsedAuditQuery {
  const fields: Array<{ field: AuditField; value: string }> = [];
  const terms: string[] = [];
  for (const tok of query.trim().split(/\s+/).filter(Boolean)) {
    const idx = tok.indexOf(":");
    if (idx > 0) {
      const f = tok.slice(0, idx).toLowerCase();
      const v = tok.slice(idx + 1);
      if (v && (FIELDS as readonly string[]).includes(f)) {
        fields.push({ field: f as AuditField, value: v.toLowerCase() });
        continue;
      }
    }
    terms.push(tok.toLowerCase());
  }
  return { fields, terms };
}

function fieldValue(e: AuditEventLike, f: AuditField): string {
  switch (f) {
    case "operator":
      return e.operatorId ?? "";
    case "tool":
      return e.tool ?? "";
    case "node":
      return e.node ?? "";
    case "decision":
      return e.decision ?? "";
    case "result":
      return e.result ?? "";
  }
}

/** Whether an event matches a parsed query: every field filter and every free-text term. */
export function matchesAuditQuery(e: AuditEventLike, q: ParsedAuditQuery): boolean {
  for (const { field, value } of q.fields) {
    if (!fieldValue(e, field).toLowerCase().includes(value)) return false;
  }
  if (q.terms.length > 0) {
    const hay = [e.tool, e.node, e.operatorId, e.decision, e.result]
      .filter((s): s is string => typeof s === "string")
      .join(" ")
      .toLowerCase();
    for (const term of q.terms) {
      if (!hay.includes(term)) return false;
    }
  }
  return true;
}
