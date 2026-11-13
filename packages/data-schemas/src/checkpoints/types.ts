export interface CheckpointReference {
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
}

export interface CheckpointIdentity {
  threadId: string;
  checkpointNs: string;
  checkpointId?: string;
  owner?: string;
  /** Exact historical proof, never permission to scan legacy storage. */
  legacyCheckpointId?: string;
}

export interface CheckpointPayload {
  type: string;
  bytes: Uint8Array;
}

export interface SerializedCheckpoint {
  identity: CheckpointReference;
  parentCheckpointId?: string;
  checkpoint: CheckpointPayload;
  metadata: CheckpointPayload;
  metadataSearch: Record<string, unknown>;
}

export interface SerializedCheckpointWrite {
  taskId: string;
  index: number;
  channel: string;
  value: CheckpointPayload;
}

export interface CheckpointSelection {
  threadId?: string;
  checkpointNs?: string;
  owner?: string;
  before?: string;
  limit?: number;
  metadata?: Record<string, unknown>;
}

export interface CheckpointGeneration {
  threadId: string;
  checkpointNamespace?: string;
  checkpointIds: string[];
}

/** Serialized persistence only. Graph configuration, serde and retention belong to the caller. */
export interface CheckpointRepository {
  setup(): Promise<Error[]>;
  setupOwnershipIndexes(): Promise<void>;
  get(identity: CheckpointIdentity): Promise<SerializedCheckpoint | null>;
  list(selection: CheckpointSelection): AsyncIterable<SerializedCheckpoint>;
  readWrites(
    identity: CheckpointIdentity & { checkpointId: string },
  ): Promise<SerializedCheckpointWrite[]>;
  save(
    identity: CheckpointIdentity,
    checkpoint: SerializedCheckpoint,
    context: { rootConversationId?: string; storageOwner?: string },
  ): Promise<void>;
  saveWrites(
    identity: CheckpointIdentity & { checkpointId: string },
    writes: readonly SerializedCheckpointWrite[],
    options: { replace: boolean; rootConversationId?: string; storageOwner?: string },
  ): Promise<void>;
  measureMetadata(metadata: Record<string, unknown>): number;
  deleteThread(threadId: string): Promise<void>;
  captureGeneration(threadId: string, checkpointNamespace?: string): Promise<string[]>;
  deleteGeneration(
    threadId: string,
    generation?: CheckpointGeneration,
    checkpointNamespace?: string,
  ): Promise<void>;
  deleteReference(reference: CheckpointReference, owner?: string): Promise<void>;
  deleteReferences(references: readonly CheckpointReference[], owner?: string): Promise<void>;
  deleteOwnedScope(threadId: string, checkpointNs: string, owner: string): Promise<void>;
  deleteOwned(
    userId: string,
    tenantId: string | undefined,
    conversationIds: readonly string[] | undefined,
  ): Promise<void>;
}

export interface CheckpointStorage {
  type: 'mongo' | 'memory';
  checkpointCollectionName: string;
  checkpointWritesCollectionName: string;
}

export interface CheckpointStorageConfig extends CheckpointStorage {
  ttlSeconds: number;
}

export interface CheckpointDeletionTarget {
  id: string;
  version: string;
  threadId: string;
  checkpoint?: CheckpointReference;
  userId: string;
  tenantId?: string;
  storage: CheckpointStorageConfig;
}

export interface CheckpointDeletionJournal {
  retained(
    userId: string,
    tenantId: string | undefined,
    rootConversationId: string | undefined,
  ): Promise<CheckpointDeletionTarget[]>;
  remember(targets: readonly CheckpointDeletionTarget[]): Promise<void>;
  acknowledge(targets: readonly Pick<CheckpointDeletionTarget, 'id' | 'version'>[]): Promise<void>;
  hasPending(
    userId: string,
    tenantId: string | undefined,
    rootConversationId: string | undefined,
  ): Promise<boolean>;
  scan(limit: number, after?: string): Promise<CheckpointDeletionTarget[]>;
  reclaim(target: Pick<CheckpointDeletionTarget, 'id' | 'version'>): Promise<number>;
  hasConversation(userId: string, threadId: string): Promise<boolean>;
  hasPersistence(target: CheckpointDeletionTarget): Promise<boolean>;
}

export interface CheckpointCatalog {
  configurations(userId: string, tenantId: string | undefined): Promise<CheckpointStorage[]>;
  references(
    userId: string,
    tenantId: string | undefined,
    conversationIds: readonly string[] | undefined,
    storage: CheckpointStorage,
  ): AsyncIterable<{ conversationId: string; checkpoint: CheckpointReference }>;
  forgetDescriptors(
    userId: string,
    tenantId: string | undefined,
    stores: readonly CheckpointStorage[],
  ): Promise<void>;
}

export interface ActorCheckpointPruning {
  pending(
    user: string,
    tenantId: string | undefined,
    conversationId: string,
  ): Promise<CheckpointReference[]>;
  acknowledge(
    user: string,
    tenantId: string | undefined,
    conversationId: string,
    reference: CheckpointReference,
  ): Promise<void>;
  historical(
    user: string,
    tenantId: string | undefined,
    conversationIds: readonly string[] | undefined,
  ): AsyncIterable<CheckpointReference>;
}
