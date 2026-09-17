import type { ConversationNodeDefinition } from "../contract/conversation.ts";
import { ConversationDefinitionRegistry } from "./definition-registry.ts";

export class ConversationEventRegistry extends ConversationDefinitionRegistry<ConversationNodeDefinition> {
  private fallback: ConversationNodeDefinition | undefined;

  register(definition: ConversationNodeDefinition): () => void {
    assertDefinitionTarget(definition);
    return this.registerDefinition(
      definition.kind,
      definition,
      `conversation Definition "${definition.kind}" is already registered`,
      `uiConversation.events.register(${JSON.stringify(definition.kind)})`,
    );
  }

  registerFallback(definition: ConversationNodeDefinition): () => void {
    assertDefinitionTarget(definition);
    const target = definition.target;
    if (target === undefined)
      throw new Error("conversation fallback Definition must declare a target");
    if (this.fallback !== undefined)
      throw new Error("conversation fallback Definition is already registered");
    const dispose = this.ctx.effect(
      () => {
        this.fallback = definition;
        this.refresh();
        return () => {
          if (this.fallback !== definition) return;
          this.fallback = undefined;
          this.refresh();
        };
      },
      `uiConversation.events.registerFallback(${JSON.stringify(definition.kind)})`,
    );
    return () => {
      void dispose();
    };
  }

  fallbackEntry(): ConversationNodeDefinition | undefined {
    return this.fallback;
  }
}

function assertDefinitionTarget(definition: ConversationNodeDefinition): void {
  if ((definition.target === undefined) !== (definition.buildViewNode === undefined)) {
    throw new Error(
      `conversation Definition "${definition.kind}" must declare target and buildViewNode together`,
    );
  }
}
