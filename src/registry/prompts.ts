// The prompt registry. Holds prompt templates surfaced as slash commands,
// answers prompts/list, and renders a prompt to a messages array. Populated by
// the read/admin planes; empty at scaffold time.

import type { PromptDefinition } from "./types.js";

export class PromptRegistry {
  private readonly prompts = new Map<string, PromptDefinition>();

  register(def: PromptDefinition): void {
    if (this.prompts.has(def.name)) {
      throw new Error(`duplicate prompt registration: ${def.name}`);
    }
    this.prompts.set(def.name, def);
  }

  get(name: string): PromptDefinition | undefined {
    return this.prompts.get(name);
  }

  all(): PromptDefinition[] {
    return [...this.prompts.values()];
  }

  size(): number {
    return this.prompts.size;
  }
}
