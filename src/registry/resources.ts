// The resource registry. Holds resource definitions (fixed and templated),
// answers resources/list and resources/templates/list, and resolves a concrete
// uri to its definition. Populated by the read plane; empty at scaffold time.

import type { ResourceDefinition } from "./types.js";

export class ResourceRegistry {
  private readonly resources = new Map<string, ResourceDefinition>();

  register(def: ResourceDefinition): void {
    if (this.resources.has(def.uriTemplate)) {
      throw new Error(`duplicate resource registration: ${def.uriTemplate}`);
    }
    this.resources.set(def.uriTemplate, def);
  }

  all(): ResourceDefinition[] {
    return [...this.resources.values()];
  }

  size(): number {
    return this.resources.size;
  }

  /** Fixed resources (no template variables). */
  fixed(): ResourceDefinition[] {
    return this.all().filter((r) => !r.uriTemplate.includes("{"));
  }

  /** Resource templates (RFC 6570). */
  templates(): ResourceDefinition[] {
    return this.all().filter((r) => r.uriTemplate.includes("{"));
  }

  /** Resolve a concrete uri to the definition whose template matches it. */
  match(uri: string): ResourceDefinition | undefined {
    // Exact match first.
    const exact = this.resources.get(uri);
    if (exact) return exact;
    // Then templated match: turn {var} into a capture and test.
    for (const def of this.resources.values()) {
      if (!def.uriTemplate.includes("{")) continue;
      if (matchesTemplate(def.uriTemplate, uri)) return def;
    }
    return undefined;
  }
}

/** Loose RFC-6570 level-1 match: {var} and {?query} segments become wildcards. */
export function matchesTemplate(template: string, uri: string): boolean {
  const pattern =
    "^" +
    template
      .replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === "{" || m === "}" ? m : "\\" + m))
      .replace(/\{\?[^}]+\}/g, "(?:\\?.*)?")
      .replace(/\{[^}]+\}/g, "[^/?]+") +
    "$";
  try {
    return new RegExp(pattern).test(uri);
  } catch {
    return false;
  }
}
