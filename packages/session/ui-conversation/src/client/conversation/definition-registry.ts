import { Service, type Context } from "@deepseek-ai/cordis";
import { notifySubscribers } from "@deepseek-ai/dsh-client-store";

export abstract class ConversationDefinitionRegistry<Definition> {
  protected readonly definitions = new Map<string, Definition>();
  private listeners = new Set<() => void>();
  private cached: readonly Definition[] = [];

  constructor(protected readonly ctx: Context) {
    Object.defineProperty(this, Service.tracker, {
      value: { property: "ctx" },
    });
  }

  entries(): readonly Definition[] {
    return this.cached;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  protected registerDefinition(
    key: string,
    definition: Definition,
    duplicateMessage: string,
    effectName: string,
  ): () => void {
    if (this.definitions.has(key)) throw new Error(duplicateMessage);
    const owner = this.ctx;
    const dispose = owner.effect(() => {
      this.definitions.set(key, definition);
      this.refresh();
      return () => {
        if (this.definitions.get(key) !== definition) return;
        this.definitions.delete(key);
        this.refresh();
      };
    }, effectName);
    return () => {
      void dispose();
    };
  }

  protected refresh(): void {
    this.cached = [...this.definitions.values()];
    notifySubscribers(this.listeners, "[ui-conversation] definition registry");
  }
}
