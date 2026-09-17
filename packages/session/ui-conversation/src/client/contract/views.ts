export interface ViewTab {
  id: string;
  label: string;
}

export interface ConversationViewRequest {
  readonly view: string;

  readonly focus: string;
}

export interface ConversationStoreState {
  draft: string;

  view: string | null;

  viewRequest: ConversationViewRequest | null;
}
