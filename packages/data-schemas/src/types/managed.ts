/** Internal physical identity. A missing target is retired, never re-created. */
export interface ManagedTarget {
  kind: 'message' | 'conversation';
  id: string;
  incarnation: string;
  tenantId?: string;
}

export interface ManagedState {
  incarnation: string;
  phase: 'empty' | 'pinned' | 'registering' | 'registered' | 'published' | 'retired';
  parentId?: string;
  ownerKey?: string;
  conversationKey?: string;
  receipt?: string;
  logicalId?: string;
}

export interface ManagedRegistration {
  key: string;
  target: ManagedTarget;
  retentionEpoch: number;
}

export interface ManagedPublication {
  target: ManagedTarget;
  parentId: string;
  logicalId: string;
  ownerKey: string;
  conversationKey: string;
  /** Immutable receipt identity, not caller-submitted message content. */
  receipt: string;
}

/** Existing conversations are mutated in place; a recreated logical ID is a different target. */
export interface CanonicalConversationTarget {
  id: string;
  conversationId: string;
  userId: string;
  tenantId?: string;
}
