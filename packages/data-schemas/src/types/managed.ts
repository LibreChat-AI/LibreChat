export const MANAGED_TARGET_KINDS = [
  'message',
  'conversation',
  'response',
  'channel',
  'channelIdentity',
  'channelRun',
  'channelLane',
  'channelKey',
  'channelReply',
  'channelFeedback',
  'channelFeedbackEvent',
] as const;
export type ManagedTargetKind = (typeof MANAGED_TARGET_KINDS)[number];
export const MANAGED_REGISTRATION_BYTES = 512;

/** Internal physical identity. A missing target is retired, never re-created. */
export interface ManagedTarget<Kind extends ManagedTargetKind = 'message' | 'conversation'> {
  kind: Kind;
  id: string;
  incarnation: string;
  tenantId?: string;
}

export type ManagedStorageTarget = ManagedTarget<ManagedTargetKind>;

export interface ManagedState {
  incarnation: string;
  phase: 'empty' | 'pinned' | 'registering' | 'registered' | 'published' | 'retired';
  parentId?: string;
  ownerKey?: string;
  conversationKey?: string;
  /** Fixed channel cleanup/admission authorities; never prompt, label or credential data. */
  scopeKeys?: string[];
  expiredAt?: Date;
  receipt?: string;
  logicalId?: string;
}

export interface ManagedRegistrationIntent {
  key: string;
  target: ManagedStorageTarget;
}

/** The authority stamps its own version; callers do not choose retention epochs. */
export interface ManagedRegistration extends ManagedRegistrationIntent {
  retentionEpoch: number;
  /** Set only by a canonical channel/link registry after matching its current revision. */
  authorityRevision?: string;
}

export interface ManagedRegistryState {
  pending?: ManagedRegistration[];
  pendingCount?: number;
  retentionEpoch?: number;
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

/** Metadata selected by the existing Response journal; contains no additional payload copy. */
export interface ResponseCanonicalTarget {
  logicalId: string;
  receipt: string;
  phase: 'selected' | 'registering' | 'registered' | 'published' | 'retired';
  target: ManagedTarget;
}
