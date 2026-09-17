import type { ConversationViewDefinition } from "../contract/conversation.ts";
import { ConversationDefinitionRegistry } from "./definition-registry.ts";

export class ConversationViewRegistry extends ConversationDefinitionRegistry<ConversationViewDefinition> {
  register(definition: ConversationViewDefinition): () => void {
    return this.registerDefinition(
      definition.target,
      definition,
      `conversation view target "${definition.target}" is already registered`,
      `uiConversation.views.register(${JSON.stringify(definition.target)})`,
    );
  }
}
