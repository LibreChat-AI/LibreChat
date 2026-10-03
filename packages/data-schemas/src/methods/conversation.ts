import { Buffer } from 'node:buffer';
import {
  RetentionMode,
  isForcedTemporaryRetention,
  UNSEEN_REPLY_WATERMARK,
} from 'librechat-data-provider';
import type {
  AnyBulkWriteOperation,
  DeleteResult,
  FilterQuery,
  Model,
  SortOrder,
  Types,
} from 'mongoose';
import type { SearchParams } from 'meilisearch';
import type {
  IAgentEventActorCheckpoint,
  IAgentEventActorReconciliation,
  IAgentEventActorSnapshot,
  IAgentEventActorState,
  IAgentEventActorSuspensionEvidence,
  IAgentEventBindingRecord,
  IAgentTriggerDeliveryDocument,
  AppConfig,
  IChatProjectDocument,
  IActiveSubagentThreadLease,
  IConversation,
  IMessage,
  ISharedLink,
  ISubagentThreadReservation,
} from '~/types';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import type { MessageMethods } from './message';
import {
  MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS,
  MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH,
  MAX_AGENT_EVENT_ACTOR_SKILLS,
  MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH,
  MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH,
} from '~/types/convo';
import {
  activeExpirationFilter,
  buildRetentionVisibilityFilter,
  createFallbackRetentionDate,
} from '~/utils/retention';
import {
  refreshChatProjectStatsForUser,
  updateChatProjectLastConversationForUser,
} from './chatProject';
import { createChatExpirationDate, createTempChatExpirationDate } from '~/utils/tempChatRetention';
import { isAgentFadingTier, isAgentFadingTierEntries } from '~/utils/fading';
import { isCompactionSemanticIndexProjection } from '~/types/compaction';
import { withoutMeiliIndexing } from '~/models/plugins/mongoMeili';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { isValidObjectIdString } from '~/utils/objectId';
import { decrementTagCounts } from './conversationTag';
import logger from '~/config/winston';

const ACTOR_CHECKPOINT_FIELDS = [
  'agentEventActor',
  'agentEventActorCleanup',
  'agentEventActorReconciliations',
  'agentEventActorSuspension',
] as const;

function stripActorCheckpointFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (ACTOR_CHECKPOINT_FIELDS.some((field) => key === field || key.startsWith(`${field}.`))) {
      delete record[key];
    }
  }
}

const AGENT_EVENT_ACTOR_RECEIPT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_AGENT_EVENT_ACTOR_SUSPENSION_BYTES = 64 * 1_024;
/** MeiliSearch's default `pagination.maxTotalHits` ceiling. */
const MEILI_SEARCH_LIMIT = 1000;
/** Ceiling for a single conversation page; the sidebar's largest request is 100. */
const MAX_CONVO_PAGE_SIZE = 100;
const DEFAULT_CONVO_PAGE_SIZE = 25;
const nextMonotonicStamp = (previous?: Date): Date => {
  const previousMs = previous?.getTime() ?? 0;
  return new Date(Math.max(Date.now(), Number.isFinite(previousMs) ? previousMs + 1 : 0));
};

const escapeMeiliFilterValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function validateAgentEventActorSuspension(
  conversationId: string,
  suspension: IAgentEventActorSuspensionEvidence,
  actionId: string,
  jobCreatedAt: number,
  previous?: AgentEventActorSettlementAuthority,
): void {
  const invocation = suspension?.invocation;
  const fork = invocation?.fork;
  const checkpoint = suspension?.checkpoint;
  if (
    suspension?.version !== 1 ||
    typeof suspension.suspensionId !== 'string' ||
    suspension.suspensionId.length === 0 ||
    !Number.isSafeInteger(suspension.attempt) ||
    suspension.attempt < 0 ||
    !Number.isSafeInteger(suspension.issuedAt) ||
    !Number.isSafeInteger(suspension.expiresAt) ||
    suspension.expiresAt <= suspension.issuedAt ||
    invocation?.actorThreadId !== conversationId ||
    fork?.threadId !== conversationId ||
    checkpoint?.threadId !== conversationId ||
    fork?.invocationId !== invocation?.invocationId ||
    checkpoint?.invocationId !== invocation?.invocationId ||
    checkpoint?.checkpointNs !== fork?.checkpointNs ||
    typeof suspension.interrupt?.id !== 'string' ||
    suspension.interrupt.id.length === 0 ||
    typeof suspension.suspensionDigest !== 'string' ||
    suspension.suspensionDigest.length === 0 ||
    typeof actionId !== 'string' ||
    actionId.length === 0 ||
    !Number.isSafeInteger(jobCreatedAt) ||
    jobCreatedAt < 0 ||
    (previous == null ? suspension.attempt !== 0 : suspension.attempt !== previous.attempt + 1)
  ) {
    throw new Error('Event actor suspension evidence is invalid');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(suspension);
  } catch {
    throw new Error('Event actor suspension evidence is not JSON-safe');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AGENT_EVENT_ACTOR_SUSPENSION_BYTES) {
    throw new RangeError('Event actor suspension exceeds maximum payload size');
  }
}

type ConversationUpdateResult = {
  value:
    | (IConversation & {
        _id: unknown;
        $isDefault: (path: string) => boolean;
        toObject: () => IConversation;
      })
    | null;
  lastErrorObject?: {
    updatedExisting?: boolean;
  };
};

export type SubagentThreadReadRecord = Pick<
  IConversation,
  | 'conversationId'
  | 'tenantId'
  | 'title'
  | 'agent_id'
  | 'updatedAt'
  | 'subagentThread'
  | 'subagentThreadLease'
> & {
  actorId?: string;
};

export type ParentSubagentThreadRecord = SubagentThreadReadRecord;

export type AgentEventActorCommitResult =
  | {
      status: 'committed';
      state: IAgentEventActorState;
      prunableCheckpoint?: IAgentEventActorCheckpoint;
    }
  | { status: 'stale'; state?: IAgentEventActorState };

export interface AgentEventActorSettlementAuthority {
  suspensionId: string;
  attempt: number;
  resumeAttemptId: string;
}

export interface AgentEventActorReconciliationStorageMetrics {
  pending: number;
  oldestPendingAgeSeconds: number;
}

const ARCHIVE_CONVERSATION_BATCH_SIZE = 500;
const PROJECT_STATS_REFRESH_CONCURRENCY = 10;
const PROJECT_STATS_REFRESH_MAX_PASSES = 2;
const PROJECT_DISCOVERY_MAX_ATTEMPTS = 3;

const subagentThreadReadRecord = (conversation: IConversation): SubagentThreadReadRecord => ({
  conversationId: conversation.conversationId,
  ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
  ...(conversation.title == null ? {} : { title: conversation.title }),
  ...(conversation.agent_id == null ? {} : { agent_id: conversation.agent_id }),
  ...(conversation.updatedAt == null ? {} : { updatedAt: conversation.updatedAt }),
  ...(conversation.subagentThread == null ? {} : { subagentThread: conversation.subagentThread }),
  ...(conversation.subagentThreadLease == null
    ? {}
    : { subagentThreadLease: conversation.subagentThreadLease }),
  ...(conversation.agentEventBinding?.actorId == null
    ? {}
    : { actorId: conversation.agentEventBinding.actorId }),
});

async function discoverProjectIds(
  Conversation: Model<IConversation>,
  filter: FilterQuery<IConversation>,
): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < PROJECT_DISCOVERY_MAX_ATTEMPTS; attempt++) {
    try {
      const currentProjectIds = await Conversation.distinct('chatProjectId', filter);
      return currentProjectIds.filter((projectId): projectId is string => Boolean(projectId));
    } catch (error) {
      lastError = error;
      logger.error('[archiveAllConvos] Conversations archived but project discovery failed', error);
    }
  }
  throw lastError;
}

/**
 * A project dropped here stays wrong forever: its chats are archived, so no retry of
 * archive-all can find them again to recompute against. The likeliest rejection is also
 * the most recoverable one, `refreshChatProjectStatsForUser` giving up after the project
 * changed under every compare-and-set attempt, so failures are collected and replayed
 * once the rest of the run has stopped competing with them.
 */
async function refreshChatProjectStatsInBatches(
  mongoose: typeof import('mongoose'),
  user: string,
  projectIds: Iterable<string>,
): Promise<void> {
  let pending = [...projectIds];
  for (let pass = 0; pass < PROJECT_STATS_REFRESH_MAX_PASSES && pending.length > 0; pass++) {
    const failed: string[] = [];
    for (let index = 0; index < pending.length; index += PROJECT_STATS_REFRESH_CONCURRENCY) {
      const batch = pending.slice(index, index + PROJECT_STATS_REFRESH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((projectId) => refreshChatProjectStatsForUser(mongoose, user, projectId)),
      );
      for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const result = results[resultIndex];
        if (result.status === 'rejected') {
          failed.push(batch[resultIndex]);
          logger.error(
            `[refreshChatProjectStatsInBatches] Failed to refresh project ${batch[resultIndex]}`,
            result.reason,
          );
        }
      }
    }
    pending = failed;
  }

  if (pending.length > 0) {
    logger.error(
      `[refreshChatProjectStatsInBatches] Left ${pending.length} project(s) unreconciled: ${pending.join(', ')}`,
    );
  }
}

export interface ConversationMethods {
  getConvoFiles(conversationId: string): Promise<string[]>;
  searchConversation(
    conversationId: string,
    fieldsToSelect?: string | null,
  ): Promise<IConversation | null>;
  deleteNullOrEmptyConversations(): Promise<{
    conversations: { deletedCount?: number };
    messages: { deletedCount?: number };
  }>;
  saveConvo(
    ctx: {
      userId: string;
      isTemporary?: boolean;
      expiredAt?: Date;
      interfaceConfig?: AppConfig['interfaceConfig'];
    },
    data: { conversationId: string; newConversationId?: string; [key: string]: unknown },
    metadata?: {
      context?: string;
      unsetFields?: Record<string, number>;
      noUpsert?: boolean;
      createdAtOnInsert?: Date;
      preserveUpdatedAt?: boolean;
      /** Same-tenant persisted agent already resolved by the request layer. */
      initialAgentId?: string | null;
      /** `_id`s of messages this save just wrote. When present, they are appended with
       *  `$addToSet` and the O(n) read-and-rewrite of the `messages` array is skipped;
       *  every save without this option still rebuilds the array from the database. */
      /** Casts plain string ids, so callers outside this package need not name the id type. */
      appendMessageIds?: Array<Types.ObjectId | string>;
      /** Advance the reply version and clear the catch-up after persisting an assistant reply. */
      stampReply?: boolean;
      /** Durable messageId paired atomically with a reply stamp. */
      replyMessageId?: string;
    },
  ): Promise<IConversation | { message: string } | null>;
  /**
   * Stamps forced-temporary retention onto an existing conversation and, optionally, some of its
   * messages, for writes that bypass the retention-aware save path. Reuses the stored deadline
   * rather than opening a new window, never upserts, never rewrites `messages`, and releases the
   * conversation's bookmark counts exactly once when it stops being visible.
   */
  stampForcedRetention(
    ctx: { userId: string; interfaceConfig?: AppConfig['interfaceConfig'] },
    target: { conversationId: string; messageIds?: string[] },
  ): Promise<void>;
  setConvoPinned(
    user: string,
    conversationId: string,
    pinned: boolean,
  ): Promise<IConversation | null>;
  appendConvoMessageReference(
    user: string,
    conversationId: string,
    messageId: string,
  ): Promise<IConversation | null>;
  getConvoCodeEnvironmentDecision(
    user: string,
    conversationId: string,
  ): Promise<Pick<
    IConversation,
    'conversationId' | 'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
  > | null>;
  addConvoToolApprovalAllows(input: {
    user: string;
    conversationId: string;
    toolNames: string[];
    max: number;
  }): Promise<boolean>;
  readAdmittedConvoCodeEnvironmentDecision(
    user: string,
    conversationId: string,
  ): Promise<Pick<
    IConversation,
    'conversationId' | 'codeEnvironmentMode' | 'codeWorkspaces'
  > | null>;
  replaceConvoCodeEnvironmentDecision(
    params: {
      user: string;
      conversationId: string;
      expected: Pick<
        IConversation,
        'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
      >;
    } & (
      | {
          codeEnvironmentMode: 'attached';
          codeWorkspaces: NonNullable<IConversation['codeWorkspaces']>;
        }
      | { codeEnvironmentMode: 'without_attached'; codeWorkspaces?: undefined }
    ),
  ): Promise<IConversation | null>;
  bulkSaveConvos(conversations: Array<Record<string, unknown>>): Promise<unknown>;
  getConvosByCursor(
    user: string,
    options?: {
      cursor?: string | null;
      limit?: number;
      isArchived?: boolean;
      pinned?: boolean;
      tags?: string[];
      search?: string;
      sortBy?: string;
      sortDirection?: string;
      projectId?: string;
      updatedAfter?: Date;
      createdAfter?: Date;
      endpoints?: string[];
      hasFiles?: boolean;
      sharedOnly?: boolean;
    },
  ): Promise<{ conversations: IConversation[]; nextCursor: string | null }>;
  getConvosQueried(
    user: string,
    convoIds: Array<{ conversationId: string }> | null,
    cursor?: string | null,
    limit?: number,
  ): Promise<{
    conversations: IConversation[];
    nextCursor: string | null;
    convoMap: Record<string, unknown>;
  }>;
  getConvo(user: string, conversationId: string): Promise<IConversation | null>;
  getSubagentThreadForParent(input: {
    user: string;
    parentConversationId: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<SubagentThreadReadRecord | null>;
  listSubagentThreadsForParent(input: {
    user: string;
    parentConversationId: string;
    tenantId?: string;
    limit: number;
  }): Promise<ParentSubagentThreadRecord[]>;
  getAgentEventBinding(input: {
    user: string;
    bindingId: string;
    sourceKeyId: string;
    tenantId?: string;
  }): Promise<IAgentEventBindingRecord | null>;
  getAgentEventActorSnapshot(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<IAgentEventActorSnapshot | undefined>;
  commitAgentEventActorState(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    action: IAgentEventActorReconciliation['action'];
    expected?: IAgentEventActorState;
    expectedEpoch: number;
    checkpoint: IAgentEventActorCheckpoint;
    contextFingerprint?: IAgentEventActorState['contextFingerprint'];
    skillManifest?: IAgentEventActorState['skillManifest'];
    discoveredToolNames?: IAgentEventActorState['discoveredToolNames'];
    summary?: IAgentEventActorState['summary'];
    contextMeta?: IAgentEventActorState['contextMeta'];
    compactionSemanticIndex?: IAgentEventActorState['compactionSemanticIndex'];
    settlementAuthority?: AgentEventActorSettlementAuthority;
  }): Promise<AgentEventActorCommitResult>;
  storeAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspension: IAgentEventActorSuspensionEvidence;
    kind?: 'human_decision' | 'internal_completion';
    appliedAction?: { toolName: string; toolCallId?: string };
    handlingGenerationCreatedAt?: number;
    actionId: string;
    jobCreatedAt: number;
    /** The segment applied its expected action before publishing this successor pause. */
    invalidateHead?: boolean;
    previous?: AgentEventActorSettlementAuthority;
  }): Promise<{ status: 'stored' | 'stale' }>;
  claimAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    actionId: string;
    jobCreatedAt: number;
    resumeAttemptId: string;
  }): Promise<{ status: 'claimed' | 'stale' }>;
  settleAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    resumeAttemptId: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
  }): Promise<{ status: 'settled' | 'stale' }>;
  cancelAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    /** Exact orphaned resume claim proven not to have entered provider execution. */
    claimedResumeAttemptId?: string;
  }): Promise<{ status: 'cancelled' | 'stale' }>;
  beginAgentEventActorLegacyTurn(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    token: string;
  }): Promise<boolean>;
  completeAgentEventActorLegacyTurn(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    token: string;
  }): Promise<boolean>;
  recordAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    reconciliation: IAgentEventActorReconciliation;
  }): Promise<boolean>;
  resolveAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    expectedActionAdmitted?: boolean;
    resolution:
      | 'checkpoint_verified'
      | 'action_compensated'
      | 'history_repaired'
      | 'invocation_abandoned';
  }): Promise<boolean>;
  clearAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired';
  }): Promise<boolean>;
  getAgentEventActorReconciliationStorageMetrics(
    now: Date,
  ): Promise<AgentEventActorReconciliationStorageMetrics>;
  expireLegacyAgentEventActorReceipts(
    now: Date,
    limit?: number,
    activity?: { found: boolean },
  ): Promise<number>;
  reserveSubagentThread(input: {
    user: string;
    conversationId: string;
    conversation: Partial<IConversation>;
    tenantId?: string;
  }): Promise<ISubagentThreadReservation>;
  acquireSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    taskId: string;
    now: Date;
    expiresAt: Date;
    tenantId?: string;
  }): Promise<boolean>;
  renewSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    now: Date;
    expiresAt: Date;
    tenantId?: string;
  }): Promise<boolean>;
  releaseSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    tenantId?: string;
  }): Promise<boolean>;
  countActiveSubagentThreadLeases(input: {
    user: string;
    now: Date;
    tenantId?: string;
  }): Promise<number>;
  listActiveSubagentThreadLeases(input: {
    user: string;
    now: Date;
    tenantId?: string;
  }): Promise<IActiveSubagentThreadLease[]>;
  getConvoOwnership(
    user: string,
    conversationId: string,
    tenantId?: string | null,
  ): Promise<Pick<IConversation, 'user' | 'tenantId' | 'subagentThread'> | null>;
  getConvoRetention(
    user: string,
    conversationId: string,
  ): Promise<Pick<IConversation, 'expiredAt' | 'isTemporary'> | null>;
  getConvoTitle(user: string, conversationId: string): Promise<string | null>;
  markConvoSeen(
    user: string,
    conversationId: string,
    observedResponseAt?: Date,
  ): Promise<{ modified: boolean }>;
  markConvoUnread(
    user: string,
    conversationId: string,
  ): Promise<{
    modified: boolean;
    lastResponseAt?: Date;
    lastResponseMessageId?: string;
    lastResponseIsManual?: boolean;
    isMarkedUnread?: boolean;
  }>;
  stampConvoLastResponse(
    user: string,
    conversationId: string,
    responseMessageId: string,
  ): Promise<{ lastResponseAt: Date; lastResponseMessageId: string; updatedAt?: Date } | null>;
  deleteConvos(
    user: string,
    filter: FilterQuery<IConversation>,
    options?: {
      beforeDelete?: (conversationIds: string[]) => Promise<void>;
      allowEmpty?: boolean;
    },
  ): Promise<DeleteResult & { messages: DeleteResult; conversationIds: string[] }>;
  archiveAllConvos(user: string): Promise<{ archivedCount: number }>;
}

export interface ConversationMethodDeps
  extends Pick<MessageMethods, 'getMessages' | 'deleteMessages'> {
  searchMessages?: MessageMethods['searchMessages'];
  deleteAgentQueuedTurns?: (
    user: string,
    conversations: Array<{ conversationId: string; tenantId?: string; allTenants?: true }>,
  ) => Promise<void>;
  eraseAgentTriggerDeliveryConversationResults?: (
    user: string,
    conversationIds: string[],
  ) => Promise<void>;
  prepareAgentTriggerConversationResultErasure?: (
    user: string,
    conversationIds: string[],
  ) => Promise<void>;
}

export function createConversationMethods(
  mongoose: typeof import('mongoose'),
  deps?: ConversationMethodDeps,
): ConversationMethods {
  let legacyReceiptExpiryCursor: Types.ObjectId | undefined;

  /**
   * Stamps a real assistant reply with a strictly increasing server value.
   *
   * The read and write are a classic compare-and-set pair so this remains compatible with
   * DocumentDB: concurrent writers that read the same value retry against the winner and use
   * `max(now, previous + 1ms, updatedAt + 1ms)`. Advancing both versions makes the reply itself
   * distinguishable from a metadata-only promotion. Only a successful write supplies a stamp.
   */
  async function stampReplyWithCas(
    Conversation: Model<IConversation>,
    filter: FilterQuery<IConversation>,
    responseMessageId: string,
    projection?: Record<string, 0 | 1>,
  ): Promise<{ stamp: Date; conversation: Partial<IConversation> } | null> {
    const replyFilter = { ...filter, isTemporary: { $ne: true } };
    for (;;) {
      const current = await Conversation.findOne(replyFilter)
        .select({ lastResponseAt: 1, updatedAt: 1 })
        .lean<Pick<IConversation, 'lastResponseAt' | 'updatedAt'> | null>();
      if (!current) {
        return null;
      }
      const previous = current.lastResponseAt;
      const latestActivity =
        current.updatedAt && (!previous || current.updatedAt > previous)
          ? current.updatedAt
          : previous;
      const stamp = nextMonotonicStamp(latestActivity);
      const casFilter: FilterQuery<IConversation> =
        previous == null
          ? {
              ...replyFilter,
              updatedAt: current.updatedAt ?? null,
              $or: [{ lastResponseAt: null }, { lastResponseAt: { $exists: false } }],
            }
          : { ...replyFilter, lastResponseAt: previous, updatedAt: current.updatedAt ?? null };
      const stamped = await Conversation.findOneAndUpdate(
        casFilter,
        {
          $set: {
            lastResponseAt: stamp,
            lastResponseMessageId: responseMessageId,
            isMarkedUnread: false,
            lastSeenAt: new Date(UNSEEN_REPLY_WATERMARK),
          },
          $unset: { lastResponseIsManual: '' },
          $max: { updatedAt: stamp },
        },
        { new: true, projection, timestamps: false },
      ).lean<Partial<IConversation> | null>();
      if (stamped) {
        return { stamp, conversation: stamped };
      }
    }
  }
  function getMessageMethods() {
    if (!deps) {
      throw new Error('Message methods not injected into conversation methods');
    }
    return deps;
  }

  function getVisibleConversationRetentionFilter(): FilterQuery<IConversation> {
    return buildRetentionVisibilityFilter<IConversation>();
  }

  /** Child threads are durable execution records, not user-navigable conversations. */
  function getHumanConversationFilter(): FilterQuery<IConversation> {
    return { subagentThread: { $exists: false } } as FilterQuery<IConversation>;
  }

  /**
   * Searches for a conversation by conversationId and returns a lean document with only conversationId and user.
   */
  /** `fieldsToSelect: null` returns the full document so one read can serve the whole request. */
  async function searchConversation(
    conversationId: string,
    fieldsToSelect: string | null = 'conversationId user',
  ) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOne({ conversationId }, fieldsToSelect).lean<IConversation>();
    } catch (error) {
      logger.error('[searchConversation] Error searching conversation', error);
      throw new Error('Error searching conversation');
    }
  }

  /**
   * Retrieves a single conversation for a given user and conversation ID.
   */
  async function getConvo(user: string, conversationId: string) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOne({ user, conversationId }).lean<IConversation>();
    } catch (error) {
      logger.error('[getConvo] Error getting single conversation', error);
      throw new Error('Error getting single conversation');
    }
  }

  /** Resolves a child only through its owning parent and includes its private live lease. */
  async function getSubagentThreadForParent(input: {
    user: string;
    parentConversationId: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<SubagentThreadReadRecord | null> {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const conversation = await Conversation.findOne({
        user: input.user,
        conversationId: input.conversationId,
        'subagentThread.parentConversationId': input.parentConversationId,
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
      })
        .select(
          'conversationId tenantId title agent_id updatedAt subagentThread +subagentThreadLease +agentEventBinding',
        )
        .lean<IConversation>();
      if (conversation == null) return null;
      return subagentThreadReadRecord(conversation);
    } catch (error) {
      logger.error('[getSubagentThreadForParent] Error getting child conversation', error);
      throw new Error('Error getting child conversation');
    }
  }

  /**
   * Lists bounded child metadata through immutable parent lineage. Private
   * event-delivery records are collapsed to actor identity inside this Module.
   */
  async function listSubagentThreadsForParent(input: {
    user: string;
    parentConversationId: string;
    tenantId?: string;
    limit: number;
  }): Promise<ParentSubagentThreadRecord[]> {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const conversations = await Conversation.find({
        user: input.user,
        'subagentThread.parentConversationId': input.parentConversationId,
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
      })
        .select(
          'conversationId tenantId title agent_id updatedAt subagentThread +subagentThreadLease +agentEventBinding',
        )
        .sort({ updatedAt: -1, conversationId: 1, _id: 1 })
        .limit(input.limit)
        .lean<IConversation[]>();
      return conversations.map(subagentThreadReadRecord);
    } catch (error) {
      logger.error('[listSubagentThreadsForParent] Error listing child conversations', error);
      throw new Error('Error listing child conversations');
    }
  }

  /** Resolves an event target only when the API key, owner, and tenant all match. */
  async function getAgentEventBinding(input: {
    user: string;
    bindingId: string;
    sourceKeyId: string;
    tenantId?: string;
  }): Promise<IAgentEventBindingRecord | null> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversation = await Conversation.findOne({
      user: input.user,
      'agentEventBinding.bindingId': input.bindingId,
      'agentEventBinding.sourceKeyId': input.sourceKeyId,
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    })
      .select(
        'conversationId agent_id tenantId isTemporary expiredAt subagentThread +agentEventBinding',
      )
      .lean<IConversation>();
    if (
      conversation?.agentEventBinding == null ||
      conversation.subagentThread == null ||
      typeof conversation.agent_id !== 'string'
    ) {
      return null;
    }
    return {
      conversationId: conversation.conversationId,
      agentId: conversation.agent_id,
      ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
      ...(conversation.isTemporary == null ? {} : { isTemporary: conversation.isTemporary }),
      ...(conversation.expiredAt == null ? {} : { expiredAt: conversation.expiredAt }),
      binding: conversation.agentEventBinding,
      lineage: conversation.subagentThread,
    };
  }

  function readableActorSuspension(
    suspension: IConversation['agentEventActorSuspension'],
  ): IAgentEventActorSnapshot['suspension'] {
    if (suspension == null) return null;
    if (suspension.status === 'pending_owned') return { ...suspension, status: 'pending' };
    if (suspension.status === 'claimed_owned') return { ...suspension, status: 'claimed' };
    return suspension;
  }

  /** Reads the private actor head and every fail-closed reconciliation marker. */
  async function getAgentEventActorSnapshot(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
  }): Promise<IAgentEventActorSnapshot | undefined> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversation = await Conversation.findOne({
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    })
      .select(
        '+agentEventActor +agentEventActorReconciliations +agentEventActorEpoch +agentEventActorLegacyTurn +agentEventActorSuspension',
      )
      .lean<IConversation>();
    return conversation == null
      ? undefined
      : {
          state: conversation.agentEventActor ?? null,
          reconciliations: conversation.agentEventActorReconciliations ?? [],
          legacyTurn: conversation.agentEventActorLegacyTurn ?? null,
          suspension: readableActorSuspension(conversation.agentEventActorSuspension),
          epoch: conversation.agentEventActorEpoch ?? 0,
        };
  }

  /** Publishes one SDK-issued suspension, or atomically replaces its exact claimed predecessor. */
  async function storeAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspension: IAgentEventActorSuspensionEvidence;
    kind?: 'human_decision' | 'internal_completion';
    appliedAction?: { toolName: string; toolCallId?: string };
    handlingGenerationCreatedAt?: number;
    actionId: string;
    jobCreatedAt: number;
    invalidateHead?: boolean;
    previous?: AgentEventActorSettlementAuthority;
  }): Promise<{ status: 'stored' | 'stale' }> {
    validateAgentEventActorSuspension(
      input.conversationId,
      input.suspension,
      input.actionId,
      input.jobCreatedAt,
      input.previous,
    );
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const predecessor: FilterQuery<IConversation> =
      input.previous == null
        ? {
            $or: [
              { agentEventActorSuspension: { $exists: false } },
              { 'agentEventActorSuspension.status': 'closed' },
            ],
          }
        : {
            'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
            'agentEventActorSuspension.suspension.suspensionId': input.previous.suspensionId,
            'agentEventActorSuspension.suspension.attempt': input.previous.attempt,
            'agentEventActorSuspension.resumeAttemptId': input.previous.resumeAttemptId,
          };
    const ownership = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      agentEventActorReconciliations: {
        $elemMatch: {
          invocationId: input.suspension.invocation.invocationId,
          status: 'invocation_pending',
        },
      },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
      ...predecessor,
    };
    const suspension = {
      suspension: input.suspension,
      kind: input.kind ?? 'human_decision',
      ...(input.appliedAction == null ? {} : { appliedAction: input.appliedAction }),
      handlingGenerationCreatedAt: input.handlingGenerationCreatedAt ?? input.jobCreatedAt,
      actionId: input.actionId,
      jobCreatedAt: input.jobCreatedAt,
      status: 'pending_owned' as const,
      observedAt: new Date(),
    };
    const storeUpdate = {
      $set: {
        agentEventActorSuspension: suspension,
        ...(input.invalidateHead === true ? { 'agentEventActor.requiresColdStart': true } : {}),
      },
    };
    let stored = await Conversation.findOneAndUpdate(
      {
        ...ownership,
        ...(input.invalidateHead === true ? { agentEventActor: { $exists: true } } : {}),
      },
      storeUpdate,
      { new: false, timestamps: false },
    )
      .select('_id')
      .lean<IConversation>();
    /** A headless actor is already guaranteed to cold-start; publish the
     * successor without manufacturing a partial canonical state. */
    if (stored == null && input.invalidateHead === true) {
      stored = await Conversation.findOneAndUpdate(
        { ...ownership, agentEventActor: { $exists: false } },
        {
          $set: {
            agentEventActorSuspension: suspension,
          },
        },
        { new: false, timestamps: false },
      )
        .select('_id')
        .lean<IConversation>();
    }
    return { status: stored == null ? 'stale' : 'stored' };
  }

  /** One resume attempt wins the canonical Conversation-side suspension fence. */
  async function claimAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    actionId: string;
    jobCreatedAt: number;
    resumeAttemptId: string;
  }): Promise<{ status: 'claimed' | 'stale' }> {
    if (
      input.suspensionId.length === 0 ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 0 ||
      input.actionId.length === 0 ||
      !Number.isSafeInteger(input.jobCreatedAt) ||
      input.jobCreatedAt < 0 ||
      input.resumeAttemptId.length === 0
    ) {
      throw new Error('Event actor suspension claim is invalid');
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const claimed = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        agentEventBinding: { $exists: true },
        'agentEventActorSuspension.status': { $in: ['pending', 'pending_owned'] },
        'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
        'agentEventActorSuspension.suspension.attempt': input.attempt,
        'agentEventActorSuspension.actionId': input.actionId,
        'agentEventActorSuspension.jobCreatedAt': input.jobCreatedAt,
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
      },
      {
        $set: {
          'agentEventActorSuspension.status': 'claimed_owned',
          'agentEventActorSuspension.resumeAttemptId': input.resumeAttemptId,
          'agentEventActorSuspension.observedAt': new Date(),
        },
        $unset: {
          'agentEventActorSuspension.outcome': 1,
          'agentEventActorSuspension.closedAt': 1,
        },
      },
      { new: false, timestamps: false },
    )
      .select('_id')
      .lean<IConversation>();
    return { status: claimed == null ? 'stale' : 'claimed' };
  }

  /** Closes a claimed no-action suspension while retaining one bounded retry receipt. */
  async function settleAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    resumeAttemptId: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
  }): Promise<{ status: 'settled' | 'stale' }> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const settled = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
        'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
        'agentEventActorSuspension.suspension.attempt': input.attempt,
        'agentEventActorSuspension.resumeAttemptId': input.resumeAttemptId,
        agentEventActorReconciliations: {
          $elemMatch: {
            invocationId: input.invocationId,
            status: 'invocation_pending',
            'checkpoint.threadId': input.checkpoint.threadId,
            'checkpoint.checkpointNs': input.checkpoint.checkpointNs,
            ...(input.checkpoint.checkpointId == null
              ? { 'checkpoint.checkpointId': { $exists: false } }
              : { 'checkpoint.checkpointId': input.checkpoint.checkpointId }),
          },
        },
        ...subagentLeaseTenantFilter(input.tenantId),
      },
      {
        $set: {
          'agentEventActorSuspension.status': 'closed',
          'agentEventActorSuspension.outcome': 'settled',
          'agentEventActorSuspension.closedAt': new Date(),
          'agentEventActorSuspension.observedAt': new Date(),
        },
        $pull: {
          agentEventActorReconciliations: {
            invocationId: input.invocationId,
            status: 'invocation_pending',
            'checkpoint.threadId': input.checkpoint.threadId,
            'checkpoint.checkpointNs': input.checkpoint.checkpointNs,
            ...(input.checkpoint.checkpointId == null
              ? { 'checkpoint.checkpointId': { $exists: false } }
              : { 'checkpoint.checkpointId': input.checkpoint.checkpointId }),
          },
        },
      },
      { new: false, timestamps: false },
    )
      .select('_id')
      .lean<IConversation>();
    if (settled != null) {
      return { status: 'settled' };
    }
    const snapshot = await getAgentEventActorSnapshot(input);
    return snapshot?.suspension?.status === 'closed' &&
      snapshot.suspension.outcome === 'settled' &&
      snapshot.suspension.suspension.suspensionId === input.suspensionId &&
      snapshot.suspension.suspension.attempt === input.attempt &&
      snapshot.suspension.resumeAttemptId === input.resumeAttemptId
      ? { status: 'settled' }
      : { status: 'stale' };
  }

  /** Cancellation races resume through the same current-suspension predicate. */
  async function cancelAgentEventActorSuspension(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    suspensionId: string;
    attempt: number;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    claimedResumeAttemptId?: string;
  }): Promise<{ status: 'cancelled' | 'stale' }> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const suspensionOwner =
      input.claimedResumeAttemptId == null
        ? { 'agentEventActorSuspension.status': { $in: ['pending', 'pending_owned'] } }
        : {
            'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
            'agentEventActorSuspension.resumeAttemptId': input.claimedResumeAttemptId,
          };
    const cancelled = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        ...suspensionOwner,
        'agentEventActorSuspension.suspension.suspensionId': input.suspensionId,
        'agentEventActorSuspension.suspension.attempt': input.attempt,
        agentEventActorReconciliations: {
          $elemMatch: {
            invocationId: input.invocationId,
            status: 'invocation_pending',
            'checkpoint.threadId': input.checkpoint.threadId,
            'checkpoint.checkpointNs': input.checkpoint.checkpointNs,
            ...(input.checkpoint.checkpointId == null
              ? { 'checkpoint.checkpointId': { $exists: false } }
              : { 'checkpoint.checkpointId': input.checkpoint.checkpointId }),
          },
        },
        ...subagentLeaseTenantFilter(input.tenantId),
      },
      {
        $set: {
          'agentEventActorSuspension.status': 'closed',
          'agentEventActorSuspension.outcome': 'cancelled',
          'agentEventActorSuspension.closedAt': new Date(),
          'agentEventActorSuspension.observedAt': new Date(),
        },
        $pull: {
          agentEventActorReconciliations: {
            invocationId: input.invocationId,
            status: 'invocation_pending',
            'checkpoint.threadId': input.checkpoint.threadId,
            'checkpoint.checkpointNs': input.checkpoint.checkpointNs,
            ...(input.checkpoint.checkpointId == null
              ? { 'checkpoint.checkpointId': { $exists: false } }
              : { 'checkpoint.checkpointId': input.checkpoint.checkpointId }),
          },
        },
      },
      { new: false, timestamps: false },
    )
      .select('_id')
      .lean<IConversation>();
    if (cancelled != null) {
      return { status: 'cancelled' };
    }
    const snapshot = await getAgentEventActorSnapshot(input);
    return snapshot?.suspension?.status === 'closed' &&
      snapshot.suspension.outcome === 'cancelled' &&
      snapshot.suspension.suspension.suspensionId === input.suspensionId &&
      snapshot.suspension.suspension.attempt === input.attempt
      ? { status: 'cancelled' }
      : { status: 'stale' };
  }

  /** Advances one actor head only when its complete prior identity still matches. */
  async function commitAgentEventActorState(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    action: IAgentEventActorReconciliation['action'];
    expected?: IAgentEventActorState;
    expectedEpoch: number;
    checkpoint: IAgentEventActorCheckpoint;
    contextFingerprint?: IAgentEventActorState['contextFingerprint'];
    skillManifest?: IAgentEventActorState['skillManifest'];
    discoveredToolNames?: IAgentEventActorState['discoveredToolNames'];
    summary?: IAgentEventActorState['summary'];
    contextMeta?: IAgentEventActorState['contextMeta'];
    compactionSemanticIndex?: IAgentEventActorState['compactionSemanticIndex'];
    settlementAuthority?: AgentEventActorSettlementAuthority;
  }): Promise<AgentEventActorCommitResult> {
    if (input.checkpoint.threadId !== input.conversationId) {
      throw new Error('Event actor checkpoint changed its logical thread');
    }
    if ((input.skillManifest?.length ?? 0) > MAX_AGENT_EVENT_ACTOR_SKILLS) {
      throw new RangeError(`Event actor Skill manifest exceeds ${MAX_AGENT_EVENT_ACTOR_SKILLS}`);
    }
    if (
      (input.discoveredToolNames?.length ?? 0) > MAX_AGENT_EVENT_ACTOR_DISCOVERED_TOOLS ||
      input.discoveredToolNames?.some(
        (name) => name.length === 0 || name.length > MAX_AGENT_EVENT_ACTOR_TOOL_NAME_LENGTH,
      )
    ) {
      throw new RangeError('Event actor discovered-tool state is invalid');
    }
    if (
      input.summary != null &&
      (input.summary.text.length === 0 ||
        input.summary.text.length > MAX_AGENT_EVENT_ACTOR_SUMMARY_LENGTH ||
        !Number.isFinite(input.summary.tokenCount) ||
        input.summary.tokenCount < 0)
    ) {
      throw new RangeError('Event actor summary state is invalid');
    }
    if (
      input.contextMeta != null &&
      (!Number.isFinite(input.contextMeta.calibrationRatio) ||
        input.contextMeta.calibrationRatio < 0.5 ||
        input.contextMeta.calibrationRatio > 5 ||
        (input.contextMeta.encoding != null &&
          (input.contextMeta.encoding.length === 0 ||
            input.contextMeta.encoding.length > MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH)))
    ) {
      throw new RangeError('Event actor context calibration is invalid');
    }
    if (
      input.contextMeta?.fadingTiers != null &&
      !isAgentFadingTierEntries(input.contextMeta.fadingTiers)
    ) {
      throw new RangeError('Event actor context fading tiers are invalid');
    }
    if (input.contextMeta?.fading != null && !isAgentFadingTier(input.contextMeta.fading)) {
      throw new RangeError('Event actor context fading tier is invalid');
    }
    if (
      input.compactionSemanticIndex != null &&
      !isCompactionSemanticIndexProjection(input.compactionSemanticIndex)
    ) {
      throw new RangeError('Event actor compaction semantic index is invalid');
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    /** A legacy turn against a headless or already cold-marked actor leaves
     * the head fields unchanged, so the CAS must also require the invalidation
     * epoch observed at preparation. `null` matches a document that has never
     * been invalidated. */
    const expectedFilter: FilterQuery<IConversation> = {
      agentEventActorEpoch: input.expectedEpoch === 0 ? null : input.expectedEpoch,
      /** A legacy turn in flight has not yet persisted its messages, so no
       * fork rebuild can be complete — refuse the commit outright rather than
       * relying on the epoch, which only moves once that turn seals. */
      agentEventActorLegacyTurn: { $exists: false },
      ...(input.expected == null
        ? { agentEventActor: { $exists: false } }
        : {
            'agentEventActor.generation': input.expected.generation,
            'agentEventActor.checkpoint.threadId': input.expected.checkpoint.threadId,
            'agentEventActor.checkpoint.checkpointId': input.expected.checkpoint.checkpointId,
            'agentEventActor.checkpoint.checkpointNs': input.expected.checkpoint.checkpointNs,
            'agentEventActor.previousCheckpoint': input.expected.previousCheckpoint ?? {
              $exists: false,
            },
            ...(input.expected.contextFingerprint == null
              ? { 'agentEventActor.contextFingerprint': { $exists: false } }
              : {
                  'agentEventActor.contextFingerprint.algorithm':
                    input.expected.contextFingerprint.algorithm,
                  'agentEventActor.contextFingerprint.version':
                    input.expected.contextFingerprint.version,
                  'agentEventActor.contextFingerprint.digest':
                    input.expected.contextFingerprint.digest,
                }),
            ...(input.expected.skillManifest == null
              ? { 'agentEventActor.skillManifest': { $exists: false } }
              : { 'agentEventActor.skillManifest': input.expected.skillManifest }),
            ...(input.expected.discoveredToolNames == null
              ? { 'agentEventActor.discoveredToolNames': { $exists: false } }
              : { 'agentEventActor.discoveredToolNames': input.expected.discoveredToolNames }),
            ...(input.expected.summary == null
              ? { 'agentEventActor.summary': { $exists: false } }
              : { 'agentEventActor.summary': input.expected.summary }),
            ...(input.expected.contextMeta == null
              ? { 'agentEventActor.contextMeta': { $exists: false } }
              : { 'agentEventActor.contextMeta': input.expected.contextMeta }),
            ...(input.expected.compactionSemanticIndex == null
              ? { 'agentEventActor.compactionSemanticIndex': { $exists: false } }
              : {
                  'agentEventActor.compactionSemanticIndex': input.expected.compactionSemanticIndex,
                }),
            'agentEventActor.requiresColdStart':
              input.expected.requiresColdStart === true ? true : { $ne: true },
          }),
    };
    const settlementFilter: FilterQuery<IConversation> =
      input.settlementAuthority == null
        ? {}
        : {
            'agentEventActorSuspension.status': { $in: ['claimed', 'claimed_owned'] },
            'agentEventActorSuspension.suspension.suspensionId':
              input.settlementAuthority.suspensionId,
            'agentEventActorSuspension.suspension.attempt': input.settlementAuthority.attempt,
            'agentEventActorSuspension.resumeAttemptId': input.settlementAuthority.resumeAttemptId,
          };
    const nextState: IAgentEventActorState = {
      generation: (input.expected?.generation ?? 0) + 1,
      checkpoint: input.checkpoint,
      ...(input.contextFingerprint == null ? {} : { contextFingerprint: input.contextFingerprint }),
      ...(input.skillManifest == null ? {} : { skillManifest: input.skillManifest }),
      ...(input.discoveredToolNames == null
        ? {}
        : { discoveredToolNames: input.discoveredToolNames }),
      ...(input.summary == null ? {} : { summary: input.summary }),
      ...(input.contextMeta == null ? {} : { contextMeta: input.contextMeta }),
      ...(input.compactionSemanticIndex == null
        ? {}
        : { compactionSemanticIndex: input.compactionSemanticIndex }),
      ...(input.expected == null ? {} : { previousCheckpoint: input.expected.checkpoint }),
    };
    const previous = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        agentEventBinding: { $exists: true },
        agentEventActorReconciliations: {
          $elemMatch: {
            invocationId: input.invocationId,
            status: 'invocation_pending',
          },
        },
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
        ...expectedFilter,
        ...settlementFilter,
      },
      {
        $set: {
          agentEventActor: nextState,
          'agentEventActorReconciliations.$.status': 'persistence_pending',
          'agentEventActorReconciliations.$.checkpoint': input.checkpoint,
          'agentEventActorReconciliations.$.action': input.action,
          'agentEventActorReconciliations.$.observedAt': new Date(),
          ...(input.settlementAuthority == null
            ? {}
            : {
                'agentEventActorSuspension.status': 'closed',
                'agentEventActorSuspension.outcome': 'committed',
                'agentEventActorSuspension.closedAt': new Date(),
                'agentEventActorSuspension.observedAt': new Date(),
              }),
        },
        ...(input.expected?.previousCheckpoint == null
          ? {}
          : {
              $addToSet: { agentEventActorCleanup: input.expected.previousCheckpoint },
            }),
        $unset: { 'agentEventActorReconciliations.$.error': 1 },
      },
      { new: false, timestamps: false },
    )
      .select('+agentEventActor +agentEventActorSuspension')
      .lean<IConversation>();
    if (previous != null) {
      return {
        status: 'committed',
        state: nextState,
        ...(previous.agentEventActor?.previousCheckpoint == null
          ? {}
          : { prunableCheckpoint: previous.agentEventActor.previousCheckpoint }),
      };
    }
    if (input.settlementAuthority != null) {
      /** A resumed action must close its claim even when another head won.
       * The negative full-head predicate makes this mutually exclusive with
       * the commit CAS above; the retained closure is the ambiguous-reply receipt. */
      const closedStale = await Conversation.findOneAndUpdate(
        {
          user: input.user,
          conversationId: input.conversationId,
          subagentThread: { $exists: true },
          agentEventBinding: { $exists: true },
          agentEventActorReconciliations: {
            $elemMatch: {
              invocationId: input.invocationId,
              status: 'invocation_pending',
            },
          },
          ...subagentLeaseTenantFilter(input.tenantId),
          ...activeExpirationFilter<IConversation>(),
          ...settlementFilter,
          $nor: [expectedFilter],
        },
        {
          $set: {
            'agentEventActorSuspension.status': 'closed',
            'agentEventActorSuspension.outcome': 'stale',
            'agentEventActorSuspension.closedAt': new Date(),
            'agentEventActorSuspension.observedAt': new Date(),
          },
        },
        { new: false, timestamps: false },
      )
        .select('+agentEventActor +agentEventActorSuspension')
        .lean<IConversation>();
      if (closedStale != null) {
        return {
          status: 'stale',
          ...(closedStale.agentEventActor == null ? {} : { state: closedStale.agentEventActor }),
        };
      }
      const current = await getAgentEventActorSnapshot(input);
      const receipt = current?.suspension;
      const matchesAuthority =
        receipt?.suspension.suspensionId === input.settlementAuthority.suspensionId &&
        receipt?.suspension.attempt === input.settlementAuthority.attempt &&
        receipt?.resumeAttemptId === input.settlementAuthority.resumeAttemptId;
      if (matchesAuthority && receipt?.status === 'closed') {
        if (receipt.outcome === 'committed' && current?.state != null) {
          return { status: 'committed', state: current.state };
        }
        if (receipt.outcome === 'stale') {
          return {
            status: 'stale',
            ...(current?.state == null ? {} : { state: current.state }),
          };
        }
      }
      if (matchesAuthority) {
        throw new Error('Resumed event actor commit could not close its suspension fence');
      }
      return {
        status: 'stale',
        ...(current?.state == null ? {} : { state: current.state }),
      };
    }
    const current = await getAgentEventActorSnapshot(input);
    return {
      status: 'stale',
      ...(current?.state == null ? {} : { state: current.state }),
    };
  }

  /**
   * Opens the durable fence for one legacy-path turn BEFORE it executes. One
   * mutually exclusive classic update sets the token and, only when a valid
   * head exists, marks it cold — no partial fence state is externally visible.
   * Refuses while another legacy turn or fork lifecycle is active. Abandoned
   * legacy tokens are reclaimed through the bounded recovery operation before
   * admission is retried.
   */
  async function beginAgentEventActorLegacyTurn(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    token: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const ownership: FilterQuery<IConversation> = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      agentEventActorLegacyTurn: { $exists: false },
      agentEventActorReconciliations: {
        $not: { $elemMatch: { status: { $ne: 'settled' } } },
      },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    };
    const legacyTurn = { token: input.token, startedAt: new Date() };
    /** DocumentDB does not support aggregation-pipeline updates. Split the
     * headful/headless shapes into mutually exclusive classic updates. A head
     * cannot appear between them without first creating an unresolved fork
     * lifecycle, which the shared ownership filter rejects. */
    const openedWithHead = await Conversation.findOneAndUpdate(
      { ...ownership, 'agentEventActor.generation': { $exists: true } },
      {
        $set: {
          agentEventActorLegacyTurn: legacyTurn,
          'agentEventActor.requiresColdStart': true,
        },
      },
      { new: true, timestamps: false },
    ).lean<IConversation>();
    if (openedWithHead != null) {
      return true;
    }
    const openedHeadless = await Conversation.findOneAndUpdate(
      { ...ownership, 'agentEventActor.generation': { $exists: false } },
      { $set: { agentEventActorLegacyTurn: legacyTurn } },
      { new: true, timestamps: false },
    ).lean<IConversation>();
    return openedHeadless != null;
  }

  /**
   * Closes the fence in ONE atomic write once the legacy turn's history is
   * durable: clears this exact token and advances the epoch together, so a
   * fork can never observe a cleared fence at an unchanged epoch. Matching the
   * token keeps a later turn's seal from closing an earlier turn's fence.
   */
  async function completeAgentEventActorLegacyTurn(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    token: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const sealed = await Conversation.findOneAndUpdate(
      {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        agentEventBinding: { $exists: true },
        'agentEventActorLegacyTurn.token': input.token,
        ...subagentLeaseTenantFilter(input.tenantId),
        ...activeExpirationFilter<IConversation>(),
      },
      {
        $unset: { agentEventActorLegacyTurn: 1 },
        $inc: { agentEventActorEpoch: 1 },
      },
      { new: true, timestamps: false },
    ).lean<IConversation>();
    return sealed != null;
  }

  /** Acquires or advances one invocation lifecycle fence and blocks competing turns. */
  async function recordAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    reconciliation: IAgentEventActorReconciliation;
  }): Promise<boolean> {
    if (input.reconciliation.checkpoint.threadId !== input.conversationId) {
      throw new Error('Event actor reconciliation changed its logical thread');
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const ownership = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    };
    const existing = await Conversation.findOne(ownership)
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    const journal = existing?.agentEventActorReconciliations ?? [];
    const current = journal.find((item) => item.invocationId === input.reconciliation.invocationId);
    if (current != null) {
      const confirmsActionAdmission =
        current.status === 'invocation_pending' &&
        current.actionAdmitted !== true &&
        input.reconciliation.status === 'invocation_pending' &&
        input.reconciliation.actionAdmitted === true &&
        current.checkpoint.threadId === input.reconciliation.checkpoint.threadId &&
        current.checkpoint.checkpointId === input.reconciliation.checkpoint.checkpointId &&
        current.checkpoint.checkpointNs === input.reconciliation.checkpoint.checkpointNs &&
        current.action.toolName === input.reconciliation.action.toolName &&
        current.action.toolCallId === input.reconciliation.action.toolCallId;
      const canTransition =
        confirmsActionAdmission ||
        (current?.status === 'invocation_pending' &&
          input.reconciliation.status !== 'invocation_pending') ||
        (current?.status === 'persistence_pending' &&
          (input.reconciliation.status === 'persistence_failed' ||
            input.reconciliation.status === 'history_persisted')) ||
        (current?.status === 'persistence_failed' &&
          input.reconciliation.status === 'history_persisted');
      const sameIdentity =
        current?.status === input.reconciliation.status &&
        current.actionAdmitted === input.reconciliation.actionAdmitted &&
        current.checkpoint.threadId === input.reconciliation.checkpoint.threadId &&
        current.checkpoint.checkpointId === input.reconciliation.checkpoint.checkpointId &&
        current.checkpoint.checkpointNs === input.reconciliation.checkpoint.checkpointNs &&
        current.action.toolName === input.reconciliation.action.toolName &&
        current.action.toolCallId === input.reconciliation.action.toolCallId;
      /** A pending record is an exclusive ownership fence, not an idempotent
       * receipt. A second executor must not inherit the first owner's claim. */
      if (input.reconciliation.status === 'invocation_pending' && !confirmsActionAdmission) {
        return false;
      }
      if (!canTransition) {
        return sameIdentity;
      }
      const transitioned = await Conversation.findOneAndUpdate(
        {
          ...ownership,
          agentEventActorReconciliations: {
            $elemMatch: {
              invocationId: input.reconciliation.invocationId,
              status: current!.status,
              ...(confirmsActionAdmission && {
                actionAdmitted: { $ne: true },
                'checkpoint.threadId': current.checkpoint.threadId,
                'checkpoint.checkpointNs': current.checkpoint.checkpointNs,
                ...(current.checkpoint.checkpointId == null
                  ? { 'checkpoint.checkpointId': { $exists: false } }
                  : { 'checkpoint.checkpointId': current.checkpoint.checkpointId }),
                'action.toolName': current.action.toolName,
                ...(current.action.toolCallId == null
                  ? { 'action.toolCallId': { $exists: false } }
                  : { 'action.toolCallId': current.action.toolCallId }),
              }),
            },
          },
        },
        { $set: { 'agentEventActorReconciliations.$': input.reconciliation } },
        { new: true, timestamps: false },
      )
        .select('+agentEventActorReconciliations')
        .lean<IConversation>();
      return transitioned != null;
    }
    /** Every post-acquisition state must transition the exact pending lifecycle.
     * Never recreate a marker after terminal recovery has already removed it. */
    if (input.reconciliation.status !== 'invocation_pending') {
      return false;
    }
    const recorded = await Conversation.findOneAndUpdate(
      {
        ...ownership,
        agentEventActorLegacyTurn: { $exists: false },
        agentEventActorReconciliations: {
          $not: { $elemMatch: { status: { $ne: 'settled' } } },
        },
        'agentEventActorReconciliations.invocationId': { $ne: input.reconciliation.invocationId },
      },
      { $push: { agentEventActorReconciliations: input.reconciliation } },
      { new: true, timestamps: false },
    )
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    if (
      recorded?.agentEventActorReconciliations?.some(
        (item) => item.invocationId === input.reconciliation.invocationId,
      ) === true
    ) {
      return true;
    }
    /** Another writer won the same invocation fence while this write raced. */
    return false;
  }

  /** Resolves exactly one lifecycle after settlement, abandonment, or repair. */
  async function resolveAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    expectedActionAdmitted?: boolean;
    resolution:
      | 'checkpoint_verified'
      | 'action_compensated'
      | 'history_repaired'
      | 'invocation_abandoned';
  }): Promise<boolean> {
    if (input.checkpoint.threadId !== input.conversationId) {
      throw new Error('Event actor reconciliation changed its logical thread');
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const exactCheckpoint: Record<string, unknown> = {
      invocationId: input.invocationId,
      'checkpoint.threadId': input.checkpoint.threadId,
      'checkpoint.checkpointNs': input.checkpoint.checkpointNs,
      ...(input.checkpoint.checkpointId == null
        ? { 'checkpoint.checkpointId': { $exists: false } }
        : { 'checkpoint.checkpointId': input.checkpoint.checkpointId }),
    };
    if (
      input.resolution === 'checkpoint_verified' &&
      (typeof input.checkpoint.checkpointId !== 'string' ||
        input.checkpoint.checkpointId.length === 0)
    ) {
      return false;
    }
    const owner = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    };
    if (input.resolution === 'checkpoint_verified') {
      const settled = await Conversation.findOneAndUpdate(
        {
          ...owner,
          'agentEventActor.checkpoint.threadId': input.checkpoint.threadId,
          'agentEventActor.checkpoint.checkpointId': input.checkpoint.checkpointId!,
          'agentEventActor.checkpoint.checkpointNs': input.checkpoint.checkpointNs,
          agentEventActorReconciliations: {
            $elemMatch: { ...exactCheckpoint, status: 'history_persisted' },
          },
        },
        {
          $set: {
            'agentEventActorReconciliations.$.status': 'settled',
            'agentEventActorReconciliations.$.resolution': 'checkpoint_verified',
            'agentEventActorReconciliations.$.observedAt': new Date(),
          },
          $unset: { 'agentEventActorReconciliations.$.error': 1 },
        },
        { new: true, timestamps: false },
      )
        .select('+agentEventActorReconciliations')
        .lean<IConversation>();
      if (settled != null) {
        return true;
      }
      /** A verification retry may replay only a receipt that verification
       * itself settled. A compensated receipt must fail this resolve so the
       * caller re-reads and honors the compensation instead. */
      const replay = await Conversation.exists({
        ...owner,
        'agentEventActor.checkpoint.threadId': input.checkpoint.threadId,
        'agentEventActor.checkpoint.checkpointId': input.checkpoint.checkpointId!,
        'agentEventActor.checkpoint.checkpointNs': input.checkpoint.checkpointNs,
        agentEventActorReconciliations: {
          $elemMatch: { ...exactCheckpoint, status: 'settled', resolution: 'checkpoint_verified' },
        },
      });
      return replay != null;
    }
    let expectedAdmissionFilter: Record<string, unknown> = {};
    if (input.expectedActionAdmitted != null) {
      expectedAdmissionFilter = input.expectedActionAdmitted
        ? { actionAdmitted: true }
        : { actionAdmitted: { $ne: true } };
    }
    const checkpointFilter: Record<string, unknown> = {
      ...exactCheckpoint,
      ...(input.resolution === 'invocation_abandoned'
        ? {
            status: 'invocation_pending',
            ...expectedAdmissionFilter,
          }
        : {
            status: {
              $in: [
                'persistence_pending',
                'history_persisted',
                'commit_conflict',
                'commit_indeterminate',
                'persistence_failed',
              ],
            },
          }),
    };
    const ownership = {
      ...owner,
      agentEventActorReconciliations: { $elemMatch: checkpointFilter },
    };
    const mustRebuild =
      input.resolution === 'action_compensated' || input.resolution === 'history_repaired';
    if (!mustRebuild) {
      const abandoned = await Conversation.findOneAndUpdate(
        ownership,
        { $pull: { agentEventActorReconciliations: checkpointFilter } },
        { new: true, timestamps: false },
      )
        .select('+agentEventActorReconciliations')
        .lean<IConversation>();
      return abandoned != null;
    }
    /** Repair and compensation both act on an invocation whose action already
     * reached the outside world, so the receipt must survive as the durable
     * same-invocation tombstone. Deleting it would let a delayed duplicate
     * owner reacquire the same id and repeat that action. Compensation undoes
     * the effect; it does not re-authorize the delivery, so a legitimate retry
     * must arrive under a new invocation id. */
    const retainedReceipt = {
      'agentEventActorReconciliations.$.status': 'settled',
      'agentEventActorReconciliations.$.resolution': input.resolution,
      'agentEventActorReconciliations.$.observedAt': new Date(),
    };
    const resolved = await Conversation.findOneAndUpdate(
      { ...ownership, agentEventActor: { $exists: true } },
      { $set: { ...retainedReceipt, 'agentEventActor.requiresColdStart': true } },
      { new: true, timestamps: false },
    )
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    if (resolved != null) {
      return true;
    }
    /** Compensation before a first committed head must retire the exact fence
     * without creating a partial actor state that cannot be resumed. */
    const resolvedWithoutHead = await Conversation.findOneAndUpdate(
      { ...ownership, agentEventActor: { $exists: false } },
      { $set: retainedReceipt },
      { new: true, timestamps: false },
    )
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    if (resolvedWithoutHead != null) {
      return true;
    }
    /** A retried repair finds its own retained receipt already settled. */
    const replayed = await Conversation.exists({
      ...owner,
      agentEventActorReconciliations: {
        $elemMatch: { ...exactCheckpoint, status: 'settled', resolution: input.resolution },
      },
    });
    return replayed != null;
  }

  /** Removes an active lifecycle only after its terminal proof is durable elsewhere. */
  async function clearAgentEventActorReconciliation(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    invocationId: string;
    checkpoint: IAgentEventActorReconciliation['checkpoint'];
    resolution: 'checkpoint_verified' | 'action_compensated' | 'history_repaired';
  }): Promise<boolean> {
    if (input.checkpoint.threadId !== input.conversationId) {
      throw new Error('Event actor reconciliation changed its logical thread');
    }
    if (
      input.resolution === 'checkpoint_verified' &&
      (typeof input.checkpoint.checkpointId !== 'string' ||
        input.checkpoint.checkpointId.length === 0)
    ) {
      return false;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const exactCheckpoint = {
      invocationId: input.invocationId,
      'checkpoint.threadId': input.checkpoint.threadId,
      'checkpoint.checkpointNs': input.checkpoint.checkpointNs,
      ...(input.checkpoint.checkpointId == null
        ? { 'checkpoint.checkpointId': { $exists: false } }
        : { 'checkpoint.checkpointId': input.checkpoint.checkpointId }),
    };
    const owner = {
      user: input.user,
      conversationId: input.conversationId,
      subagentThread: { $exists: true },
      agentEventBinding: { $exists: true },
      ...subagentLeaseTenantFilter(input.tenantId),
      ...activeExpirationFilter<IConversation>(),
    };
    const activeStatuses =
      input.resolution === 'checkpoint_verified'
        ? ['history_persisted']
        : [
            'persistence_pending',
            'history_persisted',
            'commit_conflict',
            'commit_indeterminate',
            'persistence_failed',
          ];
    const lifecycle = {
      ...exactCheckpoint,
      $or: [
        { status: { $in: activeStatuses } },
        { status: 'settled', resolution: input.resolution },
      ],
    };
    const clearedWithHead = await Conversation.findOneAndUpdate(
      {
        ...owner,
        agentEventActor: { $exists: true },
        ...(input.resolution === 'checkpoint_verified' && {
          'agentEventActor.checkpoint.threadId': input.checkpoint.threadId,
          'agentEventActor.checkpoint.checkpointId': input.checkpoint.checkpointId,
          'agentEventActor.checkpoint.checkpointNs': input.checkpoint.checkpointNs,
        }),
        agentEventActorReconciliations: { $elemMatch: lifecycle },
      },
      {
        ...(input.resolution === 'checkpoint_verified'
          ? {}
          : { $set: { 'agentEventActor.requiresColdStart': true } }),
        $pull: { agentEventActorReconciliations: lifecycle },
      },
      { new: true, timestamps: false },
    )
      .select('+agentEventActorReconciliations')
      .lean<IConversation>();
    if (clearedWithHead != null) {
      return true;
    }
    if (input.resolution !== 'checkpoint_verified') {
      const clearedWithoutHead = await Conversation.findOneAndUpdate(
        {
          ...owner,
          agentEventActor: { $exists: false },
          agentEventActorReconciliations: { $elemMatch: lifecycle },
        },
        { $pull: { agentEventActorReconciliations: lifecycle } },
        { new: true, timestamps: false },
      )
        .select('+agentEventActorReconciliations')
        .lean<IConversation>();
      if (clearedWithoutHead != null) {
        return true;
      }
    }
    const conflict = await Conversation.exists({
      ...owner,
      agentEventActorReconciliations: { $elemMatch: { invocationId: input.invocationId } },
    });
    if (conflict != null) {
      return false;
    }
    return (await Conversation.exists(owner)) != null;
  }

  async function getAgentEventActorReconciliationStorageMetrics(
    now: Date,
  ): Promise<AgentEventActorReconciliationStorageMetrics> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const [row] = await Conversation.aggregate<{ pending: number; oldestObservedAt?: Date }>([
      {
        $match: {
          agentEventActorReconciliations: {
            $elemMatch: { status: { $ne: 'settled' } },
          },
        },
      },
      { $unwind: '$agentEventActorReconciliations' },
      { $match: { 'agentEventActorReconciliations.status': { $ne: 'settled' } } },
      {
        $group: {
          _id: null,
          pending: { $sum: 1 },
          oldestObservedAt: { $min: '$agentEventActorReconciliations.observedAt' },
        },
      },
    ]);
    const oldestObservedAt = row?.oldestObservedAt;
    return {
      pending: row?.pending ?? 0,
      oldestPendingAgeSeconds:
        oldestObservedAt == null
          ? 0
          : Math.max(0, (now.getTime() - oldestObservedAt.getTime()) / 1000),
    };
  }

  /** Bounded mixed-version cleanup for terminal receipts embedded by older
   * builds. New receipts expire through the delivery collection TTL index,
   * but dormant legacy conversations need an independent retirement path. */
  async function expireLegacyAgentEventActorReceipts(
    now: Date,
    limit = 100,
    activity?: { found: boolean },
  ): Promise<number> {
    if (Number.isNaN(now.getTime())) {
      throw new TypeError('now must be a valid date');
    }
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    const cutoff = new Date(now.getTime() - AGENT_EVENT_ACTOR_RECEIPT_RETENTION_MS);
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const Delivery = mongoose.models.AgentTriggerDelivery as
      | Model<IAgentTriggerDeliveryDocument>
      | undefined;
    if (Delivery == null) {
      return 0;
    }
    /** Advance a bounded candidate page before querying delivery protection.
     * Reaching the end resets the cursor so newly expiry-eligible older rows
     * enter the next sweep without making any one pass collection-wide. */
    const candidates = await Conversation.find({
      ...(legacyReceiptExpiryCursor == null ? {} : { _id: { $gt: legacyReceiptExpiryCursor } }),
    })
      /** Pure inclusion, as an object. The string form
       * `'_id +agentEventActorReconciliations'` compiles to `{ _id: 1 }` plus a
       * `: 0` exclusion for every OTHER `select: false` sibling — the `+` token
       * only un-hides its field and `_id` alone does not make the projection
       * inclusive. MongoDB tolerates that mixed shape via the `_id` exception;
       * Amazon DocumentDB rejects it, which failed this sweep on every pass and
       * took the sequenced lane reclamation down with it. An explicit `1` for a
       * `select: false` path overrides the schema default, so nothing hidden
       * leaks and nothing extra is fetched. */
      .select({ _id: 1, agentEventActorReconciliations: 1 })
      .sort({ _id: 1 })
      .limit(boundedLimit)
      .lean<
        Array<Pick<IConversation, 'agentEventActorReconciliations'> & { _id: Types.ObjectId }>
      >();
    if (candidates.length === 0) {
      legacyReceiptExpiryCursor = undefined;
      return 0;
    }
    legacyReceiptExpiryCursor = candidates[candidates.length - 1]._id;
    // A full page is not an empty sweep: later conversations may contain
    // expired receipts. Keep scanning at base cadence until the page walk ends.
    if (activity != null && candidates.length === boundedLimit) activity.found = true;
    const expiredInvocationIds = [
      ...new Set(
        candidates.flatMap((candidate) =>
          (candidate.agentEventActorReconciliations ?? [])
            .filter((receipt) => receipt.status === 'settled' && receipt.observedAt <= cutoff)
            .map((receipt) => receipt.invocationId),
        ),
      ),
    ];
    if (expiredInvocationIds.length === 0) return 0;
    if (activity != null) activity.found = true;
    const protectedInvocationIds = new Set(
      await Delivery.find({
        deliveryKey: { $in: expiredInvocationIds },
        $or: [{ handling: { $exists: false } }, { 'handling.status': 'started' }],
      }).distinct<string>('deliveryKey'),
    );
    const operations = candidates.flatMap((candidate) => {
      const removable = (candidate.agentEventActorReconciliations ?? [])
        .filter(
          (receipt) =>
            receipt.status === 'settled' &&
            receipt.observedAt <= cutoff &&
            !protectedInvocationIds.has(receipt.invocationId),
        )
        .map((receipt) => receipt.invocationId);
      return removable.length === 0
        ? []
        : [
            {
              updateOne: {
                filter: { _id: candidate._id },
                update: {
                  $pull: {
                    agentEventActorReconciliations: {
                      invocationId: { $in: removable },
                      status: 'settled',
                      observedAt: { $lte: cutoff },
                    },
                  },
                },
              },
            },
          ];
    }) as unknown as AnyBulkWriteOperation[];
    if (operations.length === 0) {
      return 0;
    }
    const result = await tenantSafeBulkWrite(Conversation, operations, {
      ordered: false,
      timestamps: false,
    });
    return result.modifiedCount;
  }

  /** Creates immutable child lineage exactly once without overwriting a concurrent winner. */
  async function reserveSubagentThread(input: {
    user: string;
    conversationId: string;
    conversation: Partial<IConversation>;
    tenantId?: string;
  }): Promise<ISubagentThreadReservation> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const filter = {
      user: input.user,
      conversationId: input.conversationId,
      ...(input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId }),
    };
    try {
      const result = (await Conversation.findOneAndUpdate(
        filter,
        {
          $setOnInsert: {
            ...input.conversation,
            user: input.user,
            conversationId: input.conversationId,
            messages: [],
          },
        },
        { new: true, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
      ).select('+agentEventBinding')) as unknown as ConversationUpdateResult;
      if (result.value == null) {
        throw new Error('Unable to reserve the subagent thread.');
      }
      return {
        conversation: result.value.toObject(),
        created: result.lastErrorObject?.updatedExisting !== true,
      };
    } catch (error) {
      /** Concurrent upserts can race at the unique index. The document that won is
       * the reservation; callers still validate its immutable lineage before use. */
      if ((error as { code?: number }).code === 11000) {
        const existing = await Conversation.findOne(filter)
          .select('+agentEventBinding')
          .lean<IConversation>();
        if (existing != null) {
          return { conversation: existing, created: false };
        }
      }
      throw error;
    }
  }

  function subagentLeaseTenantFilter(tenantId?: string): FilterQuery<IConversation> {
    return tenantId == null ? { tenantId: { $exists: false } } : { tenantId };
  }

  /** Atomically claims one durable child thread across all API replicas. */
  async function acquireSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    taskId: string;
    now: Date;
    expiresAt: Date;
    tenantId?: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      {
        user: input.user,
        conversationId: input.conversationId,
        subagentThread: { $exists: true },
        ...subagentLeaseTenantFilter(input.tenantId),
        $or: [
          { subagentThreadLease: { $exists: false } },
          { 'subagentThreadLease.expiresAt': { $lte: input.now } },
          { 'subagentThreadLease.token': input.token },
        ],
      },
      {
        $set: {
          subagentThreadLease: {
            token: input.token,
            taskId: input.taskId,
            expiresAt: input.expiresAt,
          },
          /** Child threads are hidden from normal recents. Stamp the task start
           * explicitly so bounded parent discovery promotes real new activity;
           * automatic timestamps stay disabled for lease heartbeats/releases. */
          updatedAt: input.now,
        },
      },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  /** Renews only the unexpired lease owned by this exact task token. */
  async function renewSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    now: Date;
    expiresAt: Date;
    tenantId?: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      {
        user: input.user,
        conversationId: input.conversationId,
        ...subagentLeaseTenantFilter(input.tenantId),
        'subagentThreadLease.token': input.token,
        'subagentThreadLease.expiresAt': { $gt: input.now },
      },
      { $set: { 'subagentThreadLease.expiresAt': input.expiresAt } },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  /** Releases only the lease owned by this exact task token. */
  async function releaseSubagentThreadLease(input: {
    user: string;
    conversationId: string;
    token: string;
    tenantId?: string;
  }): Promise<boolean> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await Conversation.updateOne(
      {
        user: input.user,
        conversationId: input.conversationId,
        ...subagentLeaseTenantFilter(input.tenantId),
        'subagentThreadLease.token': input.token,
      },
      { $unset: { subagentThreadLease: 1 } },
      { timestamps: false },
    );
    return result.modifiedCount === 1;
  }

  /** Counts live child execution fences while account deletion drains. */
  async function countActiveSubagentThreadLeases(input: {
    user: string;
    now: Date;
    tenantId?: string;
  }): Promise<number> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return Conversation.countDocuments({
      user: input.user,
      ...subagentLeaseTenantFilter(input.tenantId),
      'subagentThreadLease.expiresAt': { $gt: input.now },
    });
  }

  /** Resolves only live task addresses so account-wide cancellation stays O(active tasks). */
  async function listActiveSubagentThreadLeases(input: {
    user: string;
    now: Date;
    tenantId?: string;
  }): Promise<IActiveSubagentThreadLease[]> {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversations = await Conversation.find({
      user: input.user,
      ...subagentLeaseTenantFilter(input.tenantId),
      'subagentThreadLease.expiresAt': { $gt: input.now },
    })
      .select('conversationId subagentThread.parentConversationId +subagentThreadLease')
      .lean<
        Array<Pick<IConversation, 'conversationId' | 'subagentThread' | 'subagentThreadLease'>>
      >();
    return conversations.flatMap((conversation) => {
      const { conversationId } = conversation;
      const parentConversationId = conversation.subagentThread?.parentConversationId;
      const taskId = conversation.subagentThreadLease?.taskId;
      return typeof conversationId === 'string' &&
        conversationId !== '' &&
        typeof parentConversationId === 'string' &&
        parentConversationId !== '' &&
        typeof taskId === 'string' &&
        taskId !== ''
        ? [{ conversationId, parentConversationId, taskId }]
        : [];
    });
  }

  /**
   * Public-read probe: resolves ownership plus the child-thread discriminator
   * without materializing the full conversation document (preset spread +
   * message ObjectId array).
   */
  async function getConvoOwnership(user: string, conversationId: string, tenantId?: string | null) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const tenantFilter =
        tenantId === undefined ? {} : subagentLeaseTenantFilter(tenantId ?? undefined);
      return await Conversation.findOne(
        {
          user,
          conversationId,
          ...tenantFilter,
          ...activeExpirationFilter<IConversation>(),
        },
        'user tenantId subagentThread',
      ).lean<Pick<IConversation, 'user' | 'tenantId' | 'subagentThread'>>();
    } catch (error) {
      logger.error('[getConvoOwnership] Error checking conversation ownership', error);
      throw new Error('Error checking conversation ownership');
    }
  }

  /**
   * Retrieves only the retention deadline for a conversation.
   */
  async function getConvoRetention(
    user: string,
    conversationId: string,
  ): Promise<Pick<IConversation, 'expiredAt' | 'isTemporary'> | null> {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOne({ user, conversationId }, 'expiredAt isTemporary').lean<
        Pick<IConversation, 'expiredAt' | 'isTemporary'>
      >();
    } catch (error) {
      logger.error('[getConvoRetention] Error getting conversation retention fields', error);
      throw new Error('Error getting conversation retention fields');
    }
  }

  /**
   * Deletes conversations and messages with null or empty IDs.
   */
  async function deleteNullOrEmptyConversations() {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const { deleteMessages } = getMessageMethods();
      const filter = {
        $or: [
          { conversationId: null },
          { conversationId: '' },
          { conversationId: { $exists: false } },
        ],
      };

      const result = await Conversation.deleteMany(filter);
      const messageDeleteResult = await deleteMessages(filter);

      logger.info(
        `[deleteNullOrEmptyConversations] Deleted ${result.deletedCount} conversations and ${messageDeleteResult.deletedCount} messages`,
      );

      return {
        conversations: result,
        messages: messageDeleteResult,
      };
    } catch (error) {
      logger.error('[deleteNullOrEmptyConversations] Error deleting conversations', error);
      throw new Error('Error deleting conversations with null or empty conversationId');
    }
  }

  /**
   * Searches for a conversation by conversationId and returns associated file ids.
   */
  async function getConvoFiles(conversationId: string): Promise<string[]> {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return (
        (await Conversation.findOne({ conversationId }, 'files').lean<IConversation>())?.files ?? []
      );
    } catch (error) {
      logger.error('[getConvoFiles] Error getting conversation files', error);
      throw new Error('Error getting conversation files');
    }
  }

  async function stampForcedRetention(
    { userId, interfaceConfig }: { userId: string; interfaceConfig?: AppConfig['interfaceConfig'] },
    { conversationId, messageIds = [] }: { conversationId: string; messageIds?: string[] },
  ): Promise<void> {
    if (!userId || !isForcedTemporaryRetention(interfaceConfig?.retentionMode)) {
      return;
    }

    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const stored = await Conversation.findOne({ conversationId, user: userId })
      .select({ _id: 1, isTemporary: 1, expiredAt: 1, tags: 1 })
      .lean<{
        _id: Types.ObjectId;
        isTemporary?: boolean;
        expiredAt?: Date | null;
        tags?: string[];
      } | null>();
    if (!stored) {
      return;
    }

    let expiredAt = stored.expiredAt ?? null;
    if (expiredAt == null) {
      try {
        expiredAt = createTempChatExpirationDate(interfaceConfig);
      } catch (err) {
        logger.error('[stampForcedRetention] Error creating temporary chat expiration date:', err);
        expiredAt = createFallbackRetentionDate();
      }
    }

    let stampedDeadline = stored.expiredAt != null;
    if (stored.isTemporary !== true) {
      /**
       * Conditional on the transition, so concurrent stamps release the bookmark counts once;
       * the released tags are cleared with it so a later delete cannot release them again.
       */
      const converted = await Conversation.updateOne(
        { _id: stored._id, isTemporary: { $ne: true } },
        { $set: { isTemporary: true, expiredAt, tags: [] } },
        { timestamps: false },
      );
      stampedDeadline ||= converted.modifiedCount > 0;
      if (converted.modifiedCount > 0 && stored.tags?.length) {
        await decrementTagCounts(mongoose, userId, stored.tags);
      }
    } else if (stored.expiredAt == null) {
      const stamped = await Conversation.updateOne(
        { _id: stored._id, expiredAt: null },
        { $set: { expiredAt } },
        { timestamps: false },
      );
      stampedDeadline = stamped.modifiedCount > 0;
    }

    if (messageIds.length === 0) {
      return;
    }
    if (!stampedDeadline) {
      /** A concurrent stamp set the conversation's deadline first; its messages share that one. */
      const current = await Conversation.findOne({ _id: stored._id })
        .select({ expiredAt: 1 })
        .lean<{ expiredAt?: Date | null } | null>();
      expiredAt = current?.expiredAt ?? expiredAt;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    await Message.updateMany(
      { user: userId, conversationId, messageId: { $in: messageIds } },
      { $set: { isTemporary: true, expiredAt } },
      { timestamps: false },
    );
  }

  /**
   * Saves a conversation to the database.
   */
  async function saveConvo(
    {
      userId,
      isTemporary,
      expiredAt,
      interfaceConfig,
    }: {
      userId: string;
      isTemporary?: boolean;
      expiredAt?: Date;
      interfaceConfig?: AppConfig['interfaceConfig'];
    },
    {
      conversationId,
      newConversationId,
      ...convo
    }: {
      conversationId: string;
      newConversationId?: string;
      [key: string]: unknown;
    },
    metadata?: {
      context?: string;
      unsetFields?: Record<string, number>;
      noUpsert?: boolean;
      createdAtOnInsert?: Date;
      preserveUpdatedAt?: boolean;
      initialAgentId?: string | null;
      /** Casts plain string ids, so callers outside this package need not name the id type. */
      appendMessageIds?: Array<Types.ObjectId | string>;
      /** Stamp `lastResponseAt` at write time: this save carries a persisted assistant reply. */
      stampReply?: boolean;
      /** Durable messageId paired atomically with a reply stamp. */
      replyMessageId?: string;
    },
  ) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const { getMessages } = getMessageMethods();

      if (metadata?.context) {
        logger.debug(`[saveConvo] ${metadata.context}`);
      }

      const appendMessageIds = metadata?.appendMessageIds;
      const update: Record<string, unknown> = { ...convo, user: userId };
      delete update.isTemporary;
      delete update.expiredAt;
      /* Read-state fields are server-owned. A stale marker must never be reintroduced by a
       * metadata save after a real reply cleared it. */
      delete update.lastResponseIsManual;
      delete update.isMarkedUnread;
      delete update.lastResponseAt;
      delete update.lastResponseMessageId;
      delete update.initial_agent_id;
      /* Remembered tool approvals are granted only by a validated resume. */
      delete update.toolApprovalAllows;
      /** Ordinary saves may seed a decision, but only an explicit move may replace it. */
      const decisionOnInsert = {
        ...(convo.codeEnvironmentMode != null && {
          codeEnvironmentMode: convo.codeEnvironmentMode,
        }),
        ...(convo.codeWorkspaces != null && { codeWorkspaces: convo.codeWorkspaces }),
      };
      delete update.codeEnvironmentRevision;
      delete update.codeEnvironmentMode;
      delete update.codeWorkspaces;
      stripActorCheckpointFields(update);
      if (appendMessageIds == null) {
        update.messages = await getMessages({ conversationId, user: userId }, '_id');
      } else {
        delete update.messages;
      }
      const unsetFields: Record<string, number> = { ...(metadata?.unsetFields ?? {}) };
      delete unsetFields.lastResponseIsManual;
      delete unsetFields.isMarkedUnread;
      delete unsetFields.lastResponseMessageId;
      delete unsetFields.lastResponseAt;
      delete unsetFields.initial_agent_id;
      delete unsetFields.toolApprovalAllows;
      delete unsetFields.codeEnvironmentRevision;
      delete unsetFields.codeEnvironmentMode;
      delete unsetFields.codeWorkspaces;
      stripActorCheckpointFields(unsetFields);
      let chatProjectIdOnInsert: string | undefined;
      // Turn saves may seed a new conversation, never move or detach an existing one.
      const candidate = update.chatProjectId;
      delete update.chatProjectId;
      delete unsetFields.chatProjectId;
      if (metadata?.noUpsert !== true && typeof candidate === 'string') {
        if (isValidObjectIdString(candidate)) {
          const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;
          const project = await ChatProject.exists({
            _id: new mongoose.Types.ObjectId(candidate),
            user: userId,
          });
          if (project != null) {
            chatProjectIdOnInsert = candidate;
          }
        }
      }

      if (newConversationId) {
        update.conversationId = newConversationId;
      }

      let retentionOnInsert: { expiredAt: Date; isTemporary: false } | undefined;
      const forcedTemporary = isForcedTemporaryRetention(interfaceConfig?.retentionMode);
      if (expiredAt instanceof Date && !Number.isNaN(expiredAt.getTime())) {
        if (forcedTemporary) {
          update.isTemporary = true;
        } else if (typeof isTemporary === 'boolean') {
          update.isTemporary = isTemporary;
        }
        update.expiredAt = expiredAt;
      } else if (forcedTemporary) {
        update.isTemporary = true;
        try {
          update.expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error('Error creating temporary chat expiration date:', err);
          logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
          update.expiredAt = createFallbackRetentionDate();
        }
      } else if (interfaceConfig?.retentionMode === RetentionMode.ALL) {
        if (typeof isTemporary === 'boolean') {
          update.isTemporary = isTemporary;
        }
        if (
          typeof isTemporary === 'boolean' ||
          interfaceConfig.generalChatRetention === undefined
        ) {
          try {
            update.expiredAt = createChatExpirationDate(interfaceConfig, isTemporary);
          } catch (err) {
            logger.error('Error creating chat expiration date:', err);
            logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
            update.expiredAt = createFallbackRetentionDate();
          }
        } else {
          try {
            retentionOnInsert = {
              expiredAt: createChatExpirationDate(interfaceConfig, false),
              isTemporary: false,
            };
          } catch (err) {
            logger.error('Error creating chat expiration date:', err);
            logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
            retentionOnInsert = {
              expiredAt: createFallbackRetentionDate(),
              isTemporary: false,
            };
          }
        }
      } else if (isTemporary === true) {
        update.isTemporary = true;
        try {
          update.expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error('Error creating temporary chat expiration date:', err);
          logger.info(`---\`saveConvo\` context: ${metadata?.context}`);
          update.expiredAt = createFallbackRetentionDate();
        }
      } else if (isTemporary === false) {
        update.isTemporary = false;
        update.expiredAt = null;
      }

      const createdAtOnInsert =
        metadata?.createdAtOnInsert instanceof Date &&
        !Number.isNaN(metadata.createdAtOnInsert.getTime())
          ? metadata.createdAtOnInsert
          : undefined;
      /**
       * Metadata-only edits (pinning) must not read as activity: the sidebar orders
       * chats by `updatedAt`, so bumping it would hoist an untouched chat to Today.
       */
      const preserveUpdatedAt = metadata?.preserveUpdatedAt === true;
      const updatesArchiveState = typeof update.isArchived === 'boolean';
      if (!preserveUpdatedAt && (createdAtOnInsert || updatesArchiveState)) {
        update.updatedAt = new Date();
      }

      const timestampOptions: { timestamps?: false } = {};
      if (updatesArchiveState || createdAtOnInsert || preserveUpdatedAt) {
        timestampOptions.timestamps = false;
      }

      const canUpsert = metadata?.noUpsert !== true;
      const initialAgentId =
        canUpsert &&
        typeof metadata?.initialAgentId === 'string' &&
        metadata.initialAgentId.trim() !== ''
          ? metadata.initialAgentId
          : null;

      const buildOperation = (setFields: Record<string, unknown>) => {
        const operation: Record<string, unknown> = { $set: setFields };
        if (appendMessageIds != null && appendMessageIds.length > 0) {
          operation.$addToSet = { messages: { $each: appendMessageIds } };
        }
        /* Two responses can persist concurrently, and the older one can reach the write last.
         * `$max` keeps whichever stamp is later without a pipeline update, which the
         * DocumentDB targets rule out. */
        if (setFields.lastResponseAt instanceof Date) {
          const { lastResponseAt, ...withoutReplyStamp } = setFields;
          operation.$set = {
            ...withoutReplyStamp,
            isMarkedUnread: false,
            lastSeenAt: new Date(UNSEEN_REPLY_WATERMARK),
          };
          operation.$max = { lastResponseAt };
          operation.$unset = { lastResponseIsManual: '' };
        }
        if (Object.keys(unsetFields).length > 0) {
          operation.$unset = {
            ...(operation.$unset as Record<string, unknown> | undefined),
            ...unsetFields,
          };
        }
        const createdAtForInsert = updatesArchiveState
          ? (createdAtOnInsert ??
            (!preserveUpdatedAt && update.updatedAt instanceof Date ? update.updatedAt : undefined))
          : createdAtOnInsert;
        operation.$setOnInsert = {
          initial_agent_id: initialAgentId,
          ...decisionOnInsert,
          ...retentionOnInsert,
          ...(chatProjectIdOnInsert ? { chatProjectId: chatProjectIdOnInsert } : {}),
          ...(createdAtForInsert ? { createdAt: createdAtForInsert } : {}),
        };
        return operation;
      };

      const baseFilter = { conversationId, user: userId };
      const runUpdate = (
        filter: Record<string, unknown>,
        operation: Record<string, unknown>,
        upsert: boolean,
      ) =>
        Conversation.findOneAndUpdate(filter, operation, {
          new: true,
          upsert,
          includeResultMetadata: true,
          ...timestampOptions,
        }) as unknown as Promise<ConversationUpdateResult>;

      let conversationResult: ConversationUpdateResult;
      if (update.isArchived === true) {
        /** DocumentDB documents no support for pipeline-form updates on any engine
         * version (`misc/documentdb/documentdb-compat.md`), so the stamp is applied
         * by compare-and-set instead of `$cond`. Matching on the flag is what keeps
         * it atomic: only the write that finds the chat unarchived stamps it, so a
         * duplicate or retried archive cannot move `archivedAt`, and an unarchive
         * that lands first is re-stamped rather than left bare. */
        const withoutStamp = { ...update };
        delete withoutStamp.archivedAt;
        const stamped = { ...withoutStamp, archivedAt: update.archivedAt ?? new Date() };

        const runArchiveWrites = async () => {
          const transitioned = await runUpdate(
            { ...baseFilter, isArchived: { $ne: true } },
            buildOperation(stamped),
            false,
          );
          if (transitioned.value) {
            return transitioned;
          }
          return runUpdate(
            { ...baseFilter, isArchived: true },
            buildOperation(withoutStamp),
            false,
          );
        };

        conversationResult = await runArchiveWrites();
        /** Both conditional writes miss when the flag flips between them: the chat was
         * already archived when the first ran and unarchived again before the second.
         * That is a live conversation, so confirm it is really gone before letting the
         * route answer 404, and retry the pair when it is not. */
        for (let attempt = 0; !conversationResult.value && attempt < 2; attempt++) {
          if (!(await Conversation.exists(baseFilter))) {
            break;
          }
          conversationResult = await runArchiveWrites();
        }
        if (!conversationResult.value && canUpsert) {
          conversationResult = await runUpdate(baseFilter, buildOperation(stamped), true);
        }
        if (!conversationResult.value) {
          /** Alternating archive and unarchive requests can split every attempt, so
           * exhausting the retries still proves nothing about whether the chat exists.
           * Answer with its actual current state rather than reporting it missing. */
          const current = await Conversation.findOne(baseFilter);
          if (current) {
            conversationResult = {
              value: current as unknown as ConversationUpdateResult['value'],
              lastErrorObject: { updatedExisting: true },
            };
          }
        }
      } else {
        conversationResult = await runUpdate(
          baseFilter,
          buildOperation(updatesArchiveState ? { ...update, archivedAt: null } : update),
          canUpsert,
        );
      }
      const conversation = conversationResult.value;

      if (!conversation) {
        logger.debug('[saveConvo] Conversation not found, skipping update');
        return null;
      }

      /** `$setOnInsert` only reaches a chat this save creates, yet a chat whose earlier turns never
       * involved a code-capable agent holds no decision either: without this fill its first
       * workspace choice is dropped and the next turn starts undecided again. The filter repeats
       * that absence, so a concurrent writer that decided first keeps its decision and a chat that
       * already holds one is never touched. Only a whole decision seeds a row, never bare
       * selections. */
      if (
        decisionOnInsert.codeEnvironmentMode != null &&
        conversation.codeEnvironmentMode == null &&
        (conversation.codeWorkspaces?.length ?? 0) === 0
      ) {
        const seeded = await Conversation.updateOne(
          {
            _id: conversation._id,
            codeEnvironmentMode: { $in: [null] },
            $or: [{ codeWorkspaces: { $in: [null] } }, { codeWorkspaces: { $size: 0 } }],
          },
          { $set: decisionOnInsert },
          { timestamps: false },
        );
        if (seeded.modifiedCount > 0) {
          Object.assign(conversation, decisionOnInsert);
        }
      }

      /** Reuse the saved row's chat type when callers omit it, preserving existing deadlines. */
      if (
        interfaceConfig?.retentionMode === RetentionMode.ALL &&
        interfaceConfig.generalChatRetention !== undefined &&
        typeof isTemporary !== 'boolean' &&
        conversation.expiredAt == null
      ) {
        const deadline = createChatExpirationDate(
          interfaceConfig,
          conversation.isTemporary === true,
        );
        const result = await Conversation.updateOne(
          {
            _id: conversation._id,
            expiredAt: null,
            isTemporary: conversation.isTemporary === true ? true : { $ne: true },
          },
          { $set: { expiredAt: deadline } },
          { timestamps: false },
        );
        if (result.modifiedCount > 0) {
          conversation.expiredAt = deadline;
        }
      }

      /* Advance the version and reset catch-up atomically. The database CAS orders
       * concurrent replies even when their application hosts disagree about wall-clock time. */
      let replyStampApplied = false;
      if (metadata?.stampReply === true) {
        const responseMessageId = metadata.replyMessageId;
        if (typeof responseMessageId === 'string' && responseMessageId.length > 0) {
          try {
            const stamped = await stampReplyWithCas(
              Conversation,
              { _id: conversation._id },
              responseMessageId,
              {
                lastResponseAt: 1,
                lastResponseMessageId: 1,
                lastResponseIsManual: 1,
                isMarkedUnread: 1,
                lastSeenAt: 1,
                updatedAt: 1,
              },
            );
            if (stamped) {
              /* The caller hands this document to the client as the turn's conversation, and the
               * seen acknowledgement is bound to the stamp it carries. */
              replyStampApplied = true;
              conversation.lastResponseAt = stamped.stamp;
              conversation.lastResponseMessageId = stamped.conversation.lastResponseMessageId;
              conversation.lastResponseIsManual = stamped.conversation.lastResponseIsManual;
              conversation.isMarkedUnread = stamped.conversation.isMarkedUnread;
              conversation.lastSeenAt = stamped.conversation.lastSeenAt;
              if (stamped.conversation.updatedAt) {
                conversation.updatedAt = stamped.conversation.updatedAt;
              }
            }
          } catch (error) {
            logger.error('[saveConvo] Failed to stamp persisted reply', error);
          }
        }
      }

      if (
        interfaceConfig?.retentionMode === RetentionMode.ALL &&
        typeof isTemporary !== 'boolean' &&
        (conversation.isTemporary == null ||
          (conversation.isTemporary === false && conversation.$isDefault('isTemporary')))
      ) {
        /* This backfill runs after the main write, so it needs the same timestamp
           suppression: otherwise the first pin or archive of a legacy chat under
           `RetentionMode.ALL` bumps `updatedAt` here and lands in Today anyway.
           A reply stamp is the same case for a different reason: the CAS above set `updatedAt`
           to the stamp deliberately, and an away tab that has never cached this conversation
           reads the two disagreeing as a metadata-only promotion, withholding the reply's
           chime and desktop notification. */
        await Conversation.updateOne(
          { _id: conversation._id, isTemporary: { $ne: false } },
          { $set: { isTemporary: false } },
          preserveUpdatedAt || replyStampApplied ? { timestamps: false } : {},
        );
        conversation.isTemporary = false;
      }

      /* The conversation and its reply stamp are durable by now, and the caller hands this
         document to the client as the turn's conversation. Project statistics are maintenance
         on a different collection: letting one of their failures reach the catch below would
         answer a successful save with an error, dropping the stamp from the terminal event and
         presenting a reply the user already watched arrive as unread on the next refresh. */
      try {
        if (conversation.chatProjectId) {
          const isRetentionVisibilityUpdate =
            typeof update.isTemporary === 'boolean' ||
            Object.prototype.hasOwnProperty.call(convo, 'expiredAt') ||
            Object.prototype.hasOwnProperty.call(unsetFields, 'isTemporary') ||
            Object.prototype.hasOwnProperty.call(unsetFields, 'expiredAt');
          /**
           * Saving a conversation that is itself archived or retention-hidden (e.g.
           * renaming or title generation on an archived project chat) must recompute
           * stats rather than take the incremental fast path, otherwise the project's
           * lastConversationAt/Id would point at a chat the project workspace hides.
           */
          const isConversationHidden =
            conversation.isArchived === true ||
            conversation.isTemporary === true ||
            (conversation.expiredAt != null &&
              new Date(conversation.expiredAt).getTime() <= Date.now());
          const isNewConversation = conversationResult.lastErrorObject?.updatedExisting === false;
          const shouldRefreshProjectStats =
            isNewConversation ||
            typeof update.isArchived === 'boolean' ||
            Object.prototype.hasOwnProperty.call(unsetFields, 'isArchived') ||
            isRetentionVisibilityUpdate ||
            isConversationHidden;

          if (shouldRefreshProjectStats) {
            await refreshChatProjectStatsForUser(mongoose, userId, conversation.chatProjectId);
          } else if (!preserveUpdatedAt) {
            await updateChatProjectLastConversationForUser(
              mongoose,
              userId,
              conversation.chatProjectId,
              conversation,
            );
          }
        }
      } catch (error) {
        logger.error('[saveConvo] Failed to maintain project statistics', error);
      }

      return conversation.toObject();
    } catch (error) {
      logger.error('[saveConvo] Error saving conversation', error);
      if (metadata?.context) {
        logger.info(`[saveConvo] ${metadata.context}`);
      }
      return { message: 'Error saving conversation' };
    }
  }

  /**
   * Flips the pinned flag on its own rather than routing through `saveConvo`.
   *
   * Pinning is pure metadata: it moves no chat between projects, changes nothing the
   * project workspace hides, and opens no retention window, so none of `saveConvo`'s
   * tail work applies. Going direct drops the `getMessages` round trip and the rewrite
   * of the whole message-id array that a one-field toggle would otherwise pay for, and
   * `timestamps: false` keeps the sidebar ordering by real activity.
   *
   * Returns null when no conversation matched, so a pin can never insert one.
   */
  async function setConvoPinned(user: string, conversationId: string, pinned: boolean) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOneAndUpdate(
        { conversationId, user },
        { $set: { pinned } },
        { new: true, timestamps: false },
      ).lean<IConversation>();
    } catch (error) {
      logger.error('[setConvoPinned] Error updating pinned state', error);
      throw new Error('Error updating pinned state');
    }
  }

  /**
   * Adds one message's id to a conversation's message list, and nothing else.
   *
   * A message write that failed, or that resolved falsy on a duplicate key it could not
   * re-read, leaves its row out of `messages`, and the bare `saveMessage` retries that
   * restore the row never add it. Going direct keeps the repair to what it is: no
   * `getMessages` round trip, no rewrite of the whole array, and no `$set` of fields the
   * caller never meant to touch. `timestamps: false` because repairing a reference is not
   * activity and must not reorder the sidebar.
   *
   * Takes the id as a string so callers stay free of the storage engine's own id type; the
   * cast to it happens here. Returns null when no conversation matched, so a repair can
   * never insert one.
   */
  async function appendConvoMessageReference(
    user: string,
    conversationId: string,
    messageId: string,
  ) {
    if (!isValidObjectIdString(messageId)) {
      logger.warn('[appendConvoMessageReference] Ignoring an unusable message id');
      return null;
    }
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOneAndUpdate(
        { conversationId, user },
        { $addToSet: { messages: new mongoose.Types.ObjectId(messageId) } },
        { new: true, timestamps: false },
      ).lean<IConversation>();
    } catch (error) {
      logger.error('[appendConvoMessageReference] Error appending the message reference', error);
      throw new Error('Error appending the message reference');
    }
  }

  /** Internal snapshot for a transition. The revision is never exposed in ordinary chat reads. */
  async function getConvoCodeEnvironmentDecision(user: string, conversationId: string) {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return Conversation.findOne({ user, conversationId })
      .select('conversationId codeEnvironmentMode codeWorkspaces +codeEnvironmentRevision')
      .lean<IConversation>();
  }

  /**
   * Call only AFTER publishing the generation's active job. Atomically advance the fence and
   * return the post-update decision in one round trip. A run that wins invalidates an in-flight
   * transition's revision; a transition that wins is observed by this read.
   */
  /**
   * Remember tools the owner approved for the rest of one conversation. Owner-scoped,
   * idempotent (`$addToSet`), and bounded: the write matches only while the stored list
   * plus the names it does not hold yet fits `max`, so concurrent resumes cannot grow it
   * past the cap and a name already stored costs no room. Returns whether it applied.
   */
  async function addConvoToolApprovalAllows({
    user,
    conversationId,
    toolNames,
    max,
  }: {
    user: string;
    conversationId: string;
    toolNames: string[];
    max: number;
  }): Promise<boolean> {
    const names = [...new Set(toolNames.filter((name) => typeof name === 'string' && name))];
    if (names.length === 0 || names.length > max) {
      return false;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const result = await withoutMeiliIndexing(
      Conversation.updateOne(
        {
          user,
          conversationId,
          $expr: {
            $lte: [
              { $size: { $setUnion: [{ $ifNull: ['$toolApprovalAllows', []] }, names] } },
              max,
            ],
          },
        },
        { $addToSet: { toolApprovalAllows: { $each: names } } },
        { timestamps: false },
      ),
    );
    return result.matchedCount === 1;
  }

  async function readAdmittedConvoCodeEnvironmentDecision(user: string, conversationId: string) {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    return withoutMeiliIndexing(
      Conversation.findOneAndUpdate(
        { user, conversationId },
        { $inc: { codeEnvironmentRevision: 1 } },
        { new: true, timestamps: false },
      ),
    )
      .select('conversationId codeEnvironmentMode codeWorkspaces')
      .lean<IConversation>();
  }

  /**
   * Compare-and-swap for an owner's explicit replacement of a code-environment decision, whether
   * that attaches an environment, moves to another, or leaves attached execution behind.
   * The filter repeats the stored decision being replaced, so a writer that changed it first
   * leaves this update unmatched rather than overwritten. A missing and a null mode both
   * describe a legacy decision inferred from its selections. Leaving attached execution clears
   * the selections outright: a decision that kept them would read as attached again.
   */
  async function replaceConvoCodeEnvironmentDecision({
    user,
    conversationId,
    expected,
    codeEnvironmentMode,
    codeWorkspaces,
  }: {
    user: string;
    conversationId: string;
    expected: Pick<
      IConversation,
      'codeEnvironmentMode' | 'codeWorkspaces' | 'codeEnvironmentRevision'
    >;
  } & (
    | {
        codeEnvironmentMode: 'attached';
        codeWorkspaces: NonNullable<IConversation['codeWorkspaces']>;
      }
    | { codeEnvironmentMode: 'without_attached'; codeWorkspaces?: undefined }
  )) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      return await Conversation.findOneAndUpdate(
        {
          conversationId,
          user,
          codeEnvironmentMode: expected.codeEnvironmentMode ?? { $in: [null] },
          codeWorkspaces: expected.codeWorkspaces ?? { $in: [null] },
          codeEnvironmentRevision: expected.codeEnvironmentRevision ?? { $in: [null] },
        },
        codeEnvironmentMode === 'attached'
          ? { $set: { codeEnvironmentMode, codeWorkspaces }, $inc: { codeEnvironmentRevision: 1 } }
          : {
              $set: { codeEnvironmentMode },
              $unset: { codeWorkspaces: 1 },
              $inc: { codeEnvironmentRevision: 1 },
            },
        { new: true, timestamps: false },
      ).lean<IConversation>();
    } catch (error) {
      logger.error('[replaceConvoCodeEnvironmentDecision] Error moving code environment', error);
      throw new Error('Error moving code environment');
    }
  }

  /**
   * Saves multiple conversations in bulk.
   */
  async function bulkSaveConvos(conversations: Array<Record<string, unknown>>) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument>;

      /**
       * Validate project ownership before persisting (mirrors saveConvo). Bulk
       * paths like import/duplicate/fork can carry a chatProjectId that does not
       * belong to the user; persisting it would create an orphan assignment that
       * is hidden from both the project and the unassigned filter.
       */
      const candidatePairs = new Map<string, { user: string; projectId: string }>();
      for (const convo of conversations) {
        if (
          typeof convo.user === 'string' &&
          typeof convo.chatProjectId === 'string' &&
          isValidObjectIdString(convo.chatProjectId)
        ) {
          candidatePairs.set(`${convo.user}:${convo.chatProjectId}`, {
            user: convo.user,
            projectId: convo.chatProjectId,
          });
        }
      }

      const ownedProjects = new Set<string>();
      if (candidatePairs.size > 0) {
        const owned = await ChatProject.find({
          $or: [...candidatePairs.values()].map(({ user, projectId }) => ({
            _id: new mongoose.Types.ObjectId(projectId),
            user,
          })),
        })
          .select('_id user')
          .lean<Array<{ _id: { toString: () => string }; user: string }>>();
        for (const project of owned) {
          ownedProjects.add(`${project.user}:${project._id.toString()}`);
        }
      }

      /**
       * Capture each conversation's existing project so a bulk move (import that
       * overwrites an existing (user, conversationId), duplicate/fork) also refreshes
       * the project it leaves, not just the one it joins. One batched read keeps this
       * O(1) in round-trips regardless of batch size.
       */
      const previousProjectByConversation = new Map<string, string>();
      const conversationPairs = conversations
        .filter((c) => typeof c.user === 'string' && typeof c.conversationId === 'string')
        .map((c) => ({ user: c.user as string, conversationId: c.conversationId as string }));
      if (conversationPairs.length > 0) {
        const existing = await Conversation.find(
          { $or: conversationPairs },
          'user conversationId chatProjectId',
        ).lean<Array<{ user: string; conversationId: string; chatProjectId?: string | null }>>();
        for (const doc of existing) {
          if (doc.chatProjectId) {
            previousProjectByConversation.set(
              `${doc.user}:${doc.conversationId}`,
              doc.chatProjectId,
            );
          }
        }
      }

      const affectedProjectStats = new Map<string, { user: string; projectId: string }>();
      const bulkOps = conversations.map((convo) => {
        const { codeEnvironmentMode, codeWorkspaces, ...sanitized } = convo;
        /* Read state belongs to the reader who lived through the replies, so an import never
           carries one in: the rows arrive unseen-free and unread-free. */
        delete sanitized.lastResponseAt;
        delete sanitized.lastResponseMessageId;
        delete sanitized.lastResponseIsManual;
        delete sanitized.isMarkedUnread;
        delete sanitized.lastSeenAt;
        delete sanitized.codeApprovalMode;
        delete sanitized.initial_agent_id;
        delete sanitized.toolApprovalAllows;
        delete sanitized.codeEnvironmentRevision;
        stripActorCheckpointFields(sanitized);
        if (typeof sanitized.user === 'string' && typeof sanitized.chatProjectId === 'string') {
          if (ownedProjects.has(`${sanitized.user}:${sanitized.chatProjectId}`)) {
            affectedProjectStats.set(`${sanitized.user}:${sanitized.chatProjectId}`, {
              user: sanitized.user,
              projectId: sanitized.chatProjectId,
            });
          } else {
            sanitized.chatProjectId = null;
          }
        }
        if (typeof sanitized.user === 'string' && typeof sanitized.conversationId === 'string') {
          const previousProjectId = previousProjectByConversation.get(
            `${sanitized.user}:${sanitized.conversationId}`,
          );
          const newProjectId =
            typeof sanitized.chatProjectId === 'string' ? sanitized.chatProjectId : null;
          if (previousProjectId && previousProjectId !== newProjectId) {
            affectedProjectStats.set(`${sanitized.user}:${previousProjectId}`, {
              user: sanitized.user,
              projectId: previousProjectId,
            });
          }
        }
        return {
          updateOne: {
            filter: {
              conversationId: sanitized.conversationId,
              user: sanitized.user,
            },
            update: {
              $set: sanitized,
              $setOnInsert: {
                initial_agent_id: null,
                ...(codeEnvironmentMode != null && { codeEnvironmentMode }),
                ...(codeWorkspaces != null && { codeWorkspaces }),
              },
            },
            upsert: true,
            timestamps: false,
          },
        };
      });

      const result = await tenantSafeBulkWrite(Conversation, bulkOps);
      await Promise.all(
        [...affectedProjectStats.values()].map(({ user, projectId }) =>
          refreshChatProjectStatsForUser(mongoose, user, projectId),
        ),
      );
      return result;
    } catch (error) {
      logger.error('[bulkSaveConvos] Error saving conversations in bulk', error);
      throw new Error('Failed to save conversations in bulk.');
    }
  }

  /**
   * Flags which conversations on a page currently have an active shared link, in one
   * batched lookup instead of a query per row. The flag lives in another collection, so
   * it is derived per request rather than projected; a failure here degrades the badge
   * but must never fail the conversation list itself.
   */
  async function attachSharedFlags(user: string, conversations: IConversation[]): Promise<void> {
    const SharedLink = mongoose.models.SharedLink as Model<ISharedLink> | undefined;
    if (!SharedLink || conversations.length === 0) {
      return;
    }
    /* A deployment with shared links off serves no links and renders no badge, so the
       extra round trip on the sidebar's first page would buy nothing. */
    const allowSharedLinks = process.env.ALLOW_SHARED_LINKS;
    if (allowSharedLinks !== undefined && allowSharedLinks.toLowerCase().trim() !== 'true') {
      return;
    }

    try {
      const shares = await SharedLink.find({
        user,
        conversationId: { $in: conversations.map((convo) => convo.conversationId) },
        ...activeExpirationFilter<ISharedLink>(),
      })
        .select('conversationId')
        .lean();

      const shared = new Set(shares.map((share) => share.conversationId));
      for (const convo of conversations) {
        convo.isShared = shared.has(convo.conversationId);
      }
    } catch (error) {
      logger.error('[attachSharedFlags] Error resolving shared conversations', error);
    }
  }

  /**
   * Conversations with a file on any of this user's messages. A message holds files in
   * three places: uploads on `files`, tool and assistant output on `attachments` (a stored
   * file, or a download-only one the client renders by its `filepath`), and content parts
   * in every shape replay reads (a steer's `files`, a provider-native `file` or
   * `image_file`, or a bare `file_id`).
   */
  async function getMessageFileConversationIds(user: string): Promise<string[] | null> {
    const Message = mongoose.models.Message as Model<IMessage> | undefined;
    if (!Message) {
      return null;
    }
    return Message.find({
      user,
      $or: [
        { 'files.0': { $exists: true } },
        { 'attachments.file_id': { $type: 'string' } },
        { 'attachments.filepath': { $type: 'string', $gt: '' } },
        { 'content.files.0': { $exists: true } },
        { 'content.file.file_id': { $type: 'string' } },
        { 'content.image_file.file_id': { $type: 'string' } },
        { 'content.file_id': { $type: 'string' } },
      ],
    }).distinct('conversationId');
  }

  /**
   * The conversations this user is actively sharing.
   *
   * Shared state is not a field on the conversation: it is a live link that can expire,
   * so a denormalized flag would keep saying "shared" after a link lapsed. This asks the
   * links themselves, indexed by `{ user, conversationId }`, and returns `null` when the
   * deployment has sharing switched off so the caller can tell "no links" from "not
   * applicable".
   */
  async function getSharedConversationIds(user: string): Promise<string[] | null> {
    const SharedLink = mongoose.models.SharedLink as Model<ISharedLink> | undefined;
    if (!SharedLink) {
      return null;
    }
    const allowSharedLinks = process.env.ALLOW_SHARED_LINKS;
    if (allowSharedLinks !== undefined && allowSharedLinks.toLowerCase().trim() !== 'true') {
      return null;
    }

    /* Distinct, not find: the only thing this caller can use is the set of IDs, so the
       server dedupes and returns nothing else. Covered by `{ user, conversationId }`. */
    const sharedIds = await SharedLink.find({
      user,
      ...activeExpirationFilter<ISharedLink>(),
    }).distinct('conversationId');

    return sharedIds.filter(
      (conversationId): conversationId is string => typeof conversationId === 'string',
    );
  }

  /**
   * Retrieves conversations using cursor-based pagination.
   */
  async function getConvosByCursor(
    user: string,
    {
      cursor,
      limit = DEFAULT_CONVO_PAGE_SIZE,
      isArchived = false,
      pinned = false,
      tags,
      search,
      sortBy = 'updatedAt',
      sortDirection = 'desc',
      projectId,
      updatedAfter,
      createdAfter,
      endpoints,
      hasFiles,
      sharedOnly,
    }: {
      cursor?: string | null;
      limit?: number;
      isArchived?: boolean;
      pinned?: boolean;
      tags?: string[];
      search?: string;
      sortBy?: string;
      sortDirection?: string;
      projectId?: string;
      updatedAfter?: Date;
      createdAfter?: Date;
      endpoints?: string[];
      hasFiles?: boolean;
      sharedOnly?: boolean;
    } = {},
  ) {
    const Conversation = mongoose.models.Conversation as Model<IConversation> &
      Pick<SchemaWithMeiliMethods, 'meiliSearch'>;
    /* `.limit(0)` is "no limit" to MongoDB and a negative one caps to a single batch, so an
       unclamped page size hands the caller the whole collection rather than a page of it. */
    const pageSize = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), MAX_CONVO_PAGE_SIZE)
      : DEFAULT_CONVO_PAGE_SIZE;
    const filters: FilterQuery<IConversation>[] = [{ user } as FilterQuery<IConversation>];
    if (isArchived) {
      filters.push({ isArchived: true } as FilterQuery<IConversation>);
    } else {
      filters.push({
        $or: [{ isArchived: false }, { isArchived: { $exists: false } }],
      } as FilterQuery<IConversation>);
    }

    if (pinned) {
      filters.push({ pinned: true } as FilterQuery<IConversation>);
    }

    if (Array.isArray(tags) && tags.length > 0) {
      filters.push({ tags: { $in: tags } } as FilterQuery<IConversation>);
    }

    if (projectId === 'unassigned') {
      filters.push({
        $or: [{ chatProjectId: null }, { chatProjectId: { $exists: false } }],
      } as FilterQuery<IConversation>);
    } else if (projectId) {
      filters.push({ chatProjectId: projectId } as FilterQuery<IConversation>);
    }

    /* Ranges are half-open on purpose: the caller sends the start of the window it
       means, and "since midnight" must not depend on how the clock rounds. */
    if (updatedAfter instanceof Date && !Number.isNaN(updatedAfter.getTime())) {
      filters.push({ updatedAt: { $gte: updatedAfter } } as FilterQuery<IConversation>);
    }
    if (createdAfter instanceof Date && !Number.isNaN(createdAfter.getTime())) {
      filters.push({ createdAt: { $gte: createdAfter } } as FilterQuery<IConversation>);
    }

    if (Array.isArray(endpoints) && endpoints.length > 0) {
      filters.push({ endpoint: { $in: endpoints } } as FilterQuery<IConversation>);
    }

    /* The two facet lookups are independent user-scoped reads, so they start together
       instead of adding their latencies on every page that combines them. */
    const [messageFileIds, activeShares] = await Promise.all([
      hasFiles === true ? getMessageFileConversationIds(user) : null,
      sharedOnly === true ? getSharedConversationIds(user) : null,
    ]);

    /* Attachments are not one field: the standard flow rides them on messages, imports
       can land them on the conversation, and `files` is absent or `[]` when empty. The
       conversation-side predicate alone would miss every ordinary chat with an upload,
       so the message-side conversation IDs are OR-matched in. */
    if (hasFiles === true) {
      const orClauses: FilterQuery<IConversation>[] = [
        { files: { $exists: true, $not: { $size: 0 } } } as FilterQuery<IConversation>,
      ];
      if (messageFileIds != null && messageFileIds.length > 0) {
        orClauses.push({ conversationId: { $in: messageFileIds } } as FilterQuery<IConversation>);
      }
      filters.push({ $or: orClauses } as FilterQuery<IConversation>);
    }

    /* When this filter runs, the page's rows are already known to be shared, so the set
       is kept and used to mark `isShared` directly instead of issuing a second
       SharedLink query after the conversation query for the same answers. */
    let sharedIds: Set<string> | null = null;
    if (sharedOnly === true) {
      /* Nothing shared, or sharing switched off, means nothing can match. Returning early
         also keeps an empty `$in` out of the query, which would match every document. */
      if (activeShares == null || activeShares.length === 0) {
        return { conversations: [], nextCursor: null };
      }
      sharedIds = new Set(activeShares);
      filters.push({ conversationId: { $in: activeShares } } as FilterQuery<IConversation>);
    }

    filters.push(getVisibleConversationRetentionFilter());
    filters.push(getHumanConversationFilter());

    if (search) {
      try {
        const searchParams: SearchParams = {
          filter: `user = "${escapeMeiliFilterValue(user)}"`,
          limit: MEILI_SEARCH_LIMIT,
          attributesToRetrieve: ['conversationId', 'originalConversationId'],
        };
        const [convoResults, messageHits] = await Promise.all([
          Conversation.meiliSearch(search, searchParams),
          deps?.searchMessages
            ? deps.searchMessages(search, searchParams).then(
                (results) => (Array.isArray(results.hits) ? results.hits : []),
                (error) => {
                  logger.error(
                    '[getConvosByCursor] Message search failed, using title matches only',
                    error,
                  );
                  return [];
                },
              )
            : [],
        ]);
        const matchingIds = new Set<string>();
        for (const hit of convoResults.hits ?? []) {
          if (typeof hit.conversationId === 'string') {
            matchingIds.add(hit.conversationId);
          }
        }
        for (const hit of messageHits) {
          if (typeof hit.conversationId === 'string') {
            matchingIds.add(hit.conversationId);
          }
        }
        if (!matchingIds.size) {
          return { conversations: [], nextCursor: null };
        }
        filters.push({
          conversationId: { $in: [...matchingIds] },
        } as FilterQuery<IConversation>);
      } catch (error) {
        logger.error('[getConvosByCursor] Error during meiliSearch', error);
        throw new Error('Error during meiliSearch');
      }
    }

    const validSortFields = ['title', 'createdAt', 'updatedAt', 'archivedAt'];
    if (!validSortFields.includes(sortBy)) {
      throw new Error(
        `Invalid sortBy field: ${sortBy}. Must be one of ${validSortFields.join(', ')}`,
      );
    }
    const finalSortBy = sortBy;
    const finalSortDirection = sortDirection === 'asc' ? 'asc' : 'desc';
    /* `title` and `archivedAt` are both absent on plenty of rows, and BSON orders a
       missing field before every string and every date alike. The paging clauses below
       therefore treat them the same way; `createdAt`/`updatedAt` are always present. */
    const sortFieldIsNullable = finalSortBy === 'title' || finalSortBy === 'archivedAt';
    /* The archive view renders `archivedAt ?? createdAt`, so the legacy group, which
       shares a missing `archivedAt`, has to be ordered by the same `createdAt` the cell
       shows rather than by last activity, or its dates read out of order. */
    const secondaryField = finalSortBy === 'archivedAt' ? 'createdAt' : 'updatedAt';

    let cursorFilter: FilterQuery<IConversation> | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
        const { primary, secondary, id } = decoded;
        const secondaryValue = new Date(secondary);
        const descending = finalSortDirection !== 'asc';
        const op = descending ? '$lt' : '$gt';
        const sortsBySecondary = finalSortBy === secondaryField;
        const boundaryId =
          typeof id === 'string' && isValidObjectIdString(id)
            ? { [op]: new mongoose.Types.ObjectId(id) }
            : null;

        /* One clause per sort level, so the page boundary is exact. Titles and
           timestamps both repeat; `_id` is the only field guaranteed to break the
           tie, and without that last clause every row sharing the boundary's
           (sort field, updatedAt) pair is skipped instead of returned. */
        const clauses: FilterQuery<IConversation>[] = [];

        /* A title or an archive stamp can be absent, and BSON orders a missing field
           before every string and date while `$lt`/`$gt` never cross that type
           boundary. Those rows therefore need clauses of their own: their own tail
           when the boundary is one of them, and the whole group when a descending
           page runs past the last non-null value. */
        if (primary == null) {
          clauses.push({ [finalSortBy]: null, [secondaryField]: { [op]: secondaryValue } });
          if (boundaryId) {
            clauses.push({
              [finalSortBy]: null,
              [secondaryField]: secondaryValue,
              _id: boundaryId,
            });
          }
          if (!descending) {
            clauses.push({ [finalSortBy]: { $ne: null } });
          }
        } else {
          const primaryValue = finalSortBy === 'title' ? primary : new Date(primary);
          clauses.push({ [finalSortBy]: { [op]: primaryValue } });
          if (!sortsBySecondary) {
            clauses.push({
              [finalSortBy]: primaryValue,
              [secondaryField]: { [op]: secondaryValue },
            });
          }
          if (boundaryId) {
            clauses.push({
              [finalSortBy]: primaryValue,
              ...(sortsBySecondary ? {} : { [secondaryField]: secondaryValue }),
              _id: boundaryId,
            });
          }
          if (descending && sortFieldIsNullable) {
            clauses.push({ [finalSortBy]: null });
          }
        }

        cursorFilter = { $or: clauses } as FilterQuery<IConversation>;
      } catch {
        logger.warn('[getConvosByCursor] Invalid cursor format, starting from beginning');
      }
      if (cursorFilter) {
        filters.push(cursorFilter);
      }
    }

    const query: FilterQuery<IConversation> =
      filters.length === 1 ? filters[0] : ({ $and: filters } as FilterQuery<IConversation>);

    try {
      const sortOrder: SortOrder = finalSortDirection === 'asc' ? 1 : -1;
      const sortObj: Record<string, SortOrder> = { [finalSortBy]: sortOrder };

      if (finalSortBy !== secondaryField) {
        sortObj[secondaryField] = sortOrder;
      }
      sortObj._id = sortOrder;

      const convos = await Conversation.find(query)
        /* `isArchived` rides along so a row can offer archive or restore from its own state:
           the sidebar lists archived and unarchived chats in the same session, and the
           active list also carries the unarchived pins beside them. */
        .select(
          'conversationId endpoint title createdAt updatedAt archivedAt isArchived user model agent_id assistant_id spec iconURL chatProjectId pinned lastResponseAt lastResponseMessageId lastResponseIsManual isMarkedUnread lastSeenAt',
        )
        .sort(sortObj)
        .limit(pageSize + 1)
        .lean<IConversation[]>();

      let nextCursor: string | null = null;
      if (convos.length > pageSize) {
        convos.pop();
        const lastReturned = convos[convos.length - 1];
        const sortValues: Record<string, string | Date | null | undefined> = {
          title: lastReturned.title,
          createdAt: lastReturned.createdAt,
          updatedAt: lastReturned.updatedAt,
          archivedAt: lastReturned.archivedAt,
        };
        const primaryValue = sortValues[finalSortBy];

        /* A null primary is what tells the next page it is inside the missing-value
           group, so an absent stamp has to survive as null rather than collapse to
           the epoch, which would page from 1970 and replay the whole archive. */
        let primaryStr: string | null = null;
        if (finalSortBy === 'title') {
          primaryStr = typeof primaryValue === 'string' ? primaryValue : null;
        } else if (primaryValue != null) {
          primaryStr = new Date(primaryValue).toISOString();
        }
        const secondaryValueOut =
          secondaryField === 'createdAt' ? lastReturned.createdAt : lastReturned.updatedAt;
        const secondaryStr = new Date(secondaryValueOut ?? 0).toISOString();
        const composite = {
          primary: primaryStr,
          secondary: secondaryStr,
          id: String(lastReturned._id),
        };
        nextCursor = Buffer.from(JSON.stringify(composite)).toString('base64');
      }

      if (sharedIds != null) {
        for (const convo of convos) {
          convo.isShared = sharedIds.has(convo.conversationId);
        }
      } else {
        await attachSharedFlags(user, convos);
      }

      return { conversations: convos, nextCursor };
    } catch (error) {
      logger.error('[getConvosByCursor] Error getting conversations', error);
      throw new Error('Error getting conversations');
    }
  }

  /**
   * Fetches specific conversations by ID array with pagination.
   */
  async function getConvosQueried(
    user: string,
    convoIds: Array<{ conversationId: string }> | null,
    cursor: string | null = null,
    limit = 25,
  ) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      if (!convoIds?.length) {
        return { conversations: [], nextCursor: null, convoMap: {} };
      }

      const conversationIds = convoIds.map((convo) => convo.conversationId);

      const results = await Conversation.find({
        $and: [
          { user, conversationId: { $in: conversationIds } },
          getVisibleConversationRetentionFilter(),
          getHumanConversationFilter(),
        ],
      } as FilterQuery<IConversation>).lean<IConversation[]>();

      results.sort(
        (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
      );

      let filtered = results;
      if (cursor && cursor !== 'start') {
        const cursorDate = new Date(cursor);
        filtered = results.filter((convo) => new Date(convo.updatedAt ?? 0) < cursorDate);
      }

      const limited = filtered.slice(0, limit + 1);
      let nextCursor: string | null = null;
      if (limited.length > limit) {
        limited.pop();
        nextCursor = (limited[limited.length - 1].updatedAt as Date).toISOString();
      }

      await attachSharedFlags(user, limited);

      const convoMap: Record<string, unknown> = {};
      limited.forEach((convo) => {
        convoMap[convo.conversationId] = convo;
      });

      return { conversations: limited, nextCursor, convoMap };
    } catch (error) {
      logger.error('[getConvosQueried] Error getting conversations', error);
      throw new Error('Error fetching conversations');
    }
  }

  /**
   * Gets conversation title, returning 'New Chat' as default.
   */
  async function getConvoTitle(user: string, conversationId: string) {
    try {
      const convo = await getConvo(user, conversationId);
      if (convo && !convo.title) {
        return null;
      } else {
        return convo?.title || 'New Chat';
      }
    } catch (error) {
      logger.error('[getConvoTitle] Error getting conversation title', error);
      throw new Error('Error getting conversation title');
    }
  }

  /**
   * Deletes conversations and their associated messages for a given user and filter.
   */
  async function deleteConvos(
    user: string,
    filter: FilterQuery<IConversation>,
    options?: {
      beforeDelete?: (conversationIds: string[]) => Promise<void>;
      /** Idempotent destructive-recovery mode. An empty selection is success, while
       * query, cascade, reconciliation, and deletion failures still propagate. */
      allowEmpty?: boolean;
    },
  ) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const { deleteMessages, getMessages } = getMessageMethods();
      const userFilter = { ...filter, user };
      type DeletionConversation = Pick<
        IConversation,
        'conversationId' | 'tenantId' | 'chatProjectId' | 'tags'
      >;
      const retryCascadeOperation = async <T>(operation: () => PromiseLike<T> | T): Promise<T> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            return await operation();
          } catch (error) {
            lastError = error;
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
            }
          }
        }
        throw lastError;
      };
      let conversations = await Conversation.find(userFilter)
        .select('conversationId tenantId chatProjectId tags')
        .lean<DeletionConversation[]>();
      const recoveryConversationIds: string[] = [];
      if (!conversations.length && typeof filter.conversationId === 'string') {
        /** A prior attempt may have deleted the root before a descendant read failed.
         * Resume from immutable root lineage and retain the root id for message,
         * checkpoint, and tool cleanup. The message probe distinguishes that partial
         * commit from a conversation id that never existed. */
        const [descendants, rootMessages] = await Promise.all([
          retryCascadeOperation(() =>
            Conversation.find({
              user,
              'subagentThread.rootConversationId': filter.conversationId,
            })
              .select('conversationId tenantId chatProjectId tags')
              .lean<DeletionConversation[]>(),
          ),
          getMessages({ user, conversationId: filter.conversationId }, '_id', { limit: 1 }),
        ]);
        if (descendants.length === 0 && rootMessages.length === 0 && options?.allowEmpty !== true) {
          throw new Error('Conversation not found or already deleted.');
        }
        conversations = descendants;
        recoveryConversationIds.push(filter.conversationId);
      } else if (!conversations.length) {
        if (options?.allowEmpty === true) {
          return {
            acknowledged: true,
            deletedCount: 0,
            messages: { acknowledged: true, deletedCount: 0 },
            conversationIds: [],
          };
        }
        throw new Error('Conversation not found or already deleted.');
      }

      /**
       * Delete roots first, then walk their owner-scoped lineage. Apart from
       * making child threads share the parent's lifecycle, deleting each wave
       * before discovering the next closes the child-creation race: a creator
       * that started concurrently sees its parent disappear and rolls back,
       * while a child already committed is found by the next query.
       */
      const deletedConversations: DeletionConversation[] = [];
      const seen = new Set<string>();
      let pending = conversations;
      let acknowledged = true;
      let deletedCount = 0;
      const reconcileDeletedWave = async (
        wave: DeletionConversation[],
        waveDeletedCount: number,
      ): Promise<void> => {
        if (waveDeletedCount === 0) {
          return;
        }

        /**
         * Commit derived metadata while the deleted documents are still available in
         * memory. Descendant discovery can fail after this point; deferring the
         * reconciliation until the whole walk completes would make the root's tags and
         * project impossible to recover on a later retry.
         */
        const tagDecrements: string[] = [];
        for (const conversation of wave) {
          for (const tag of new Set(conversation.tags ?? [])) {
            tagDecrements.push(tag);
          }
        }
        await decrementTagCounts(mongoose, user, tagDecrements);

        const waveProjectIds = new Set(
          wave
            .map((conversation) => conversation.chatProjectId)
            .filter((projectId): projectId is string => Boolean(projectId)),
        );
        if (waveProjectIds.size > 0) {
          try {
            await refreshChatProjectStatsInBatches(mongoose, user, waveProjectIds);
          } catch (error) {
            logger.error('[deleteConvos] Conversations deleted but stats refresh failed', error);
          }
        }
      };
      while (pending.length > 0) {
        const wave = pending.filter((conversation) => !seen.has(conversation.conversationId));
        if (wave.length === 0) {
          break;
        }
        const waveIds = wave.map((conversation) => conversation.conversationId);
        await deps?.deleteAgentQueuedTurns?.(
          user,
          wave.map((conversation) => ({
            conversationId: conversation.conversationId,
            ...(conversation.tenantId != null && { tenantId: conversation.tenantId }),
          })),
        );
        await options?.beforeDelete?.(waveIds);
        await deps?.prepareAgentTriggerConversationResultErasure?.(user, waveIds);
        const result = await Conversation.deleteMany({ user, conversationId: { $in: waveIds } });
        if (result.deletedCount > 0) {
          /** Result erasure is irreversible. Keep receipts intact when a
           * pre-delete hook or the conversation delete itself fails, so a
           * retained conversation cannot lose a receipt-only completion. */
          try {
            await deps?.eraseAgentTriggerDeliveryConversationResults?.(user, waveIds);
          } catch (error) {
            logger.error('[deleteConvos] Receipt erasure deferred to durable cleanup', error);
          }
        }
        acknowledged &&= result.acknowledged;
        deletedCount += result.deletedCount;
        await reconcileDeletedWave(wave, result.deletedCount);
        for (const conversation of wave) {
          seen.add(conversation.conversationId);
          deletedConversations.push(conversation);
        }
        pending = await retryCascadeOperation(() =>
          Conversation.find({
            user,
            'subagentThread.parentConversationId': { $in: waveIds },
          })
            .select('conversationId tenantId chatProjectId tags')
            .lean<DeletionConversation[]>(),
        );
      }

      const conversationIds = [
        ...recoveryConversationIds,
        ...deletedConversations.map((conversation) => conversation.conversationId),
      ];

      if (recoveryConversationIds.length > 0) {
        await deps?.deleteAgentQueuedTurns?.(
          user,
          recoveryConversationIds.map((conversationId) => ({
            conversationId,
            allTenants: true,
          })),
        );
        try {
          await deps?.eraseAgentTriggerDeliveryConversationResults?.(user, recoveryConversationIds);
        } catch (error) {
          logger.error('[deleteConvos] Receipt erasure deferred to durable cleanup', error);
        }
      }

      const deleteConvoResult: DeleteResult = { acknowledged, deletedCount };

      /**
       * Post-delete cleanup is best-effort: the conversations are already gone, so a
       * thrown error here would hide the deletion from the caller — dropping the
       * `conversationIds` that downstream cleanup (e.g. agent-checkpoint pruning)
       * needs, with no way to recover them on retry (the query finds nothing).
       */
      let deleteMessagesResult: DeleteResult = { acknowledged: false, deletedCount: 0 };
      try {
        deleteMessagesResult = await deleteMessages({
          conversationId: { $in: conversationIds },
          user,
        });
      } catch (error) {
        logger.error('[deleteConvos] Conversations deleted but message cleanup failed', error);
      }

      // conversationIds lets callers run sibling cleanup that lives in higher layers
      // (e.g. pruning the conversations' durable agent checkpoints) without re-querying
      // documents that no longer exist.
      return { ...deleteConvoResult, messages: deleteMessagesResult, conversationIds };
    } catch (error) {
      logger.error('[deleteConvos] Error deleting conversations and messages', error);
      throw error;
    }
  }

  /**
   * Archives every conversation the user can currently see in one pass. Temporary and
   * retention-expired conversations are left alone: they are already hidden from the
   * chat list, so archiving them would only resurrect them in the archived view.
   */
  async function archiveAllConvos(user: string) {
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const projectIds = new Set<string>();
    /** One stamp for the whole sweep so the archived view groups the run together
     * instead of fanning it out across however long the batching took, and so the
     * recovery below can find everything this call committed without holding an id
     * per conversation in memory. */
    const archivedAt = new Date();
    let archivedCount = 0;
    /** A write whose result never came back may still have committed, so reconciliation
     * keys off the attempt rather than off `archivedCount`: a stepdown between commit and
     * acknowledgement would otherwise strand those chats with stale project counts, and no
     * retry can find them again because they no longer match the sweep filter. */
    let attemptedArchiveWrite = false;
    try {
      const filter = {
        user,
        $and: [
          { $or: [{ isArchived: false }, { isArchived: { $exists: false } }] },
          getVisibleConversationRetentionFilter(),
          getHumanConversationFilter(),
        ],
      } as FilterQuery<IConversation>;

      const snapshotBoundary = await Conversation.findOne(filter)
        .select('_id')
        .sort({ _id: -1 })
        .lean<Pick<IConversation, '_id'>>();
      if (!snapshotBoundary) {
        return { archivedCount: 0 };
      }

      let lastConversationId: Types.ObjectId | null = null;

      while (true) {
        const idRange = lastConversationId
          ? { $gt: lastConversationId, $lte: snapshotBoundary._id }
          : { $lte: snapshotBoundary._id };
        const conversations = await Conversation.find({ ...filter, _id: idRange })
          .select('_id chatProjectId')
          .sort({ _id: 1 })
          .limit(ARCHIVE_CONVERSATION_BATCH_SIZE)
          .lean<Array<Pick<IConversation, '_id' | 'chatProjectId'>>>();
        if (conversations.length === 0) {
          break;
        }

        const conversationIds: Types.ObjectId[] = [];
        for (const conversation of conversations) {
          conversationIds.push(conversation._id);
          if (conversation.chatProjectId) {
            projectIds.add(conversation.chatProjectId);
          }
        }
        lastConversationId = conversationIds[conversationIds.length - 1];

        /**
         * `timestamps: false` keeps each conversation's own `updatedAt`, so the archived
         * view stays sorted by real activity instead of collapsing onto the archive time.
         * `archivedAt` is still stamped: the filter only matches unarchived chats, so this
         * cannot move an existing stamp, and leaving it unset would drop the whole sweep
         * into the legacy group the archived table sorts and dates by `createdAt`.
         */
        attemptedArchiveWrite = true;
        const result = await Conversation.updateMany(
          { ...filter, _id: { $in: conversationIds } },
          { $set: { isArchived: true, archivedAt } },
          { timestamps: false },
        );
        const batchArchivedCount = result.modifiedCount ?? 0;
        archivedCount += batchArchivedCount;

        if (batchArchivedCount > 0) {
          const currentProjectIds = await discoverProjectIds(Conversation, {
            _id: { $in: conversationIds },
            user,
          });
          for (const projectId of currentProjectIds) {
            projectIds.add(projectId);
          }
        }
      }

      return { archivedCount };
    } catch (error) {
      logger.error('[archiveAllConvos] Error archiving conversations', error);
      throw error;
    } finally {
      /**
       * Best-effort, mirroring `deleteConvos`: committed batches are already archived, so
       * a stats failure must not hide that from the caller. Recover destination projects
       * first, because in-loop discovery can throw after a move and a retry cannot see
       * those already-archived chats. The sweep marker is what identifies them, so this
       * costs one indexed query rather than a per-conversation id list: history size
       * changes how much this reads, never how much it holds.
       */
      if (attemptedArchiveWrite) {
        try {
          const recoveredProjectIds = await discoverProjectIds(Conversation, {
            user,
            isArchived: true,
            archivedAt,
          });
          for (const projectId of recoveredProjectIds) {
            projectIds.add(projectId);
          }
        } catch (error) {
          logger.error(
            '[archiveAllConvos] Conversations archived but project recovery failed',
            error,
          );
        }
      }
      if (attemptedArchiveWrite && projectIds.size > 0) {
        try {
          await refreshChatProjectStatsInBatches(mongoose, user, projectIds);
        } catch (error) {
          logger.error('[archiveAllConvos] Conversations archived but stats refresh failed', error);
        }
      }
    }
  }

  /**
   * Records that the user has caught up with a conversation's newest message.
   *
   * `observedResponseAt` is the reply the client actually had on screen. Filtering on it keeps
   * the acknowledgement bound to that reply: if another device persisted a newer one in the
   * meantime, nothing matches and the indicator survives instead of being cleared for a message
   * nobody read. The stamp itself stays server-side, so no client clock is trusted.
   *
   * Deliberately bypasses `saveConvo`: this needs neither the message lookup nor the upsert,
   * and `timestamps: false` keeps `updatedAt` untouched so reading a conversation does not
   * reorder the sidebar.
   */
  async function markConvoSeen(user: string, conversationId: string, observedResponseAt?: Date) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const filter: FilterQuery<IConversation> = { conversationId, user };
      if (observedResponseAt) {
        filter.lastResponseAt = { $lte: observedResponseAt };
      }
      /* Never earlier than the reply being acknowledged. The filter guarantees the stored
       * response is no newer than what the client observed, but across replicas the node
       * writing this can be behind the one that stamped the reply, and a catch-up older than
       * the response it acknowledges would read as unseen again on the next refetch. */
      const now = new Date();
      const lastSeenAt = observedResponseAt && observedResponseAt > now ? observedResponseAt : now;
      const result = await Conversation.updateOne(
        filter,
        { $set: { lastSeenAt }, $unset: { isMarkedUnread: '' } },
        { timestamps: false },
      );
      /* Matched, not modified: a retry of an acknowledgement that already landed writes the
       * same value back, which MongoDB reports as zero documents modified. The client reads
       * `modified: false` as a rejected stale acknowledgement and rolls its cache back to
       * unseen, so success has to mean "the observed reply is still the newest", which is
       * exactly what the filter matching does. */
      return { modified: result.matchedCount > 0 };
    } catch (error) {
      logger.error('[markConvoSeen] Error marking conversation seen', error);
      throw new Error('Error marking conversation seen');
    }
  }

  /**
   * Flags a conversation as unread again: the user explicitly wants the indicator back.
   *
   * A conversation that has never been replied to has no stamp for the dot to compare against,
   * so the flag stamps a strictly monotonic server value and records its source explicitly.
   * A real reply racing this write either wins first (and the clear-only path preserves it) or
   * sees the synthetic stamp and advances past it while clearing the marker.
   *
   * Classic operators only. Pipeline-form updates (and `$$REMOVE`) are unsupported on every
   * DocumentDB engine this project targets.
   */
  async function markConvoUnread(user: string, conversationId: string) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const projection = {
        lastResponseAt: 1,
        lastResponseMessageId: 1,
        lastResponseIsManual: 1,
        isMarkedUnread: 1,
      };
      const stamped = await Conversation.findOneAndUpdate(
        {
          conversationId,
          user,
          $or: [{ lastResponseAt: null }, { lastResponseAt: { $exists: false } }],
        },
        {
          $set: { lastResponseAt: new Date(), lastResponseIsManual: true, isMarkedUnread: true },
          $unset: { lastSeenAt: '', lastResponseMessageId: '' },
        },
        { timestamps: false, new: true, projection },
      ).lean<
        Pick<
          IConversation,
          'lastResponseAt' | 'lastResponseMessageId' | 'lastResponseIsManual' | 'isMarkedUnread'
        >
      >();
      if (stamped) {
        return {
          modified: true,
          lastResponseAt: stamped.lastResponseAt,
          lastResponseMessageId: stamped.lastResponseMessageId,
          lastResponseIsManual: stamped.lastResponseIsManual === true,
          isMarkedUnread: stamped.isMarkedUnread,
        };
      }

      const cleared = await Conversation.findOneAndUpdate(
        { conversationId, user },
        { $set: { isMarkedUnread: true }, $unset: { lastSeenAt: '' } },
        { timestamps: false, new: true, projection },
      ).lean<
        Pick<
          IConversation,
          'lastResponseAt' | 'lastResponseMessageId' | 'lastResponseIsManual' | 'isMarkedUnread'
        >
      >();

      return cleared
        ? {
            modified: true,
            lastResponseAt: cleared.lastResponseAt,
            lastResponseMessageId: cleared.lastResponseMessageId,
            lastResponseIsManual: cleared.lastResponseIsManual === true,
            isMarkedUnread: cleared.isMarkedUnread,
          }
        : { modified: false };
    } catch (error) {
      logger.error('[markConvoUnread] Error marking conversation unread', error);
      throw new Error('Error marking conversation unread');
    }
  }

  /**
   * Stamps a persisted assistant reply for paths that save the message directly
   * (assistants threads, resumed runs, terminal abort re-saves) rather than through
   * BaseClient's saveConvo payload.
   *
   * The same compare-and-set write `saveConvo` uses advances the reply version and clears the
   * previous catch-up atomically. Every persisted reply advances beyond the stored version,
   * including concurrent replies and replies from hosts whose clocks are behind.
   *
   * `updatedAt` moves with it, exactly as BaseClient's reply path already does: a new reply is
   * real activity and belongs at the top of the sidebar. It is also what the away poll pages
   * by, so a stamp that left the order alone would hide replies to any conversation that had
   * fallen past the first page. Contrast `markConvoSeen`, where reading must not reorder.
   */
  async function stampConvoLastResponse(
    user: string,
    conversationId: string,
    responseMessageId: string,
  ) {
    try {
      const Conversation = mongoose.models.Conversation as Model<IConversation>;
      const stamped = await stampReplyWithCas(
        Conversation,
        { conversationId, user },
        responseMessageId,
        {
          conversationId: 1,
          chatProjectId: 1,
          createdAt: 1,
          updatedAt: 1,
          lastResponseMessageId: 1,
        },
      );

      /* Moving `updatedAt` is only half of what `saveConvo` does for a project chat: the
       * workspace sorts on `ChatProject.lastConversationAt`, so lifting the conversation
       * while leaving its project behind would make the two views disagree. */
      if (stamped?.conversation.chatProjectId) {
        try {
          await updateChatProjectLastConversationForUser(
            mongoose,
            user,
            stamped.conversation.chatProjectId,
            stamped.conversation as IConversation,
          );
        } catch (error) {
          logger.error('[stampConvoLastResponse] Failed to update project activity', error);
        }
      }

      /* Return the exact server-side stamp that won the CAS. Callers that deliver a terminal
       * event can merge this into their read-state cache without inventing a browser timestamp. */
      return stamped
        ? {
            lastResponseAt: stamped.stamp,
            lastResponseMessageId: responseMessageId,
            ...(stamped.conversation.updatedAt
              ? { updatedAt: stamped.conversation.updatedAt }
              : {}),
          }
        : null;
    } catch (error) {
      logger.error('[stampConvoLastResponse] Error stamping conversation reply', error);
      throw new Error('Error stamping conversation reply');
    }
  }

  return {
    getConvoFiles,
    searchConversation,
    deleteNullOrEmptyConversations,
    stampForcedRetention,
    saveConvo,
    setConvoPinned,
    appendConvoMessageReference,
    getConvoCodeEnvironmentDecision,
    addConvoToolApprovalAllows,
    readAdmittedConvoCodeEnvironmentDecision,
    replaceConvoCodeEnvironmentDecision,
    bulkSaveConvos,
    getConvosByCursor,
    getConvosQueried,
    getConvo,
    getSubagentThreadForParent,
    listSubagentThreadsForParent,
    getAgentEventBinding,
    getAgentEventActorSnapshot,
    commitAgentEventActorState,
    storeAgentEventActorSuspension,
    claimAgentEventActorSuspension,
    settleAgentEventActorSuspension,
    cancelAgentEventActorSuspension,
    beginAgentEventActorLegacyTurn,
    completeAgentEventActorLegacyTurn,
    recordAgentEventActorReconciliation,
    resolveAgentEventActorReconciliation,
    clearAgentEventActorReconciliation,
    getAgentEventActorReconciliationStorageMetrics,
    expireLegacyAgentEventActorReceipts,
    reserveSubagentThread,
    acquireSubagentThreadLease,
    renewSubagentThreadLease,
    releaseSubagentThreadLease,
    countActiveSubagentThreadLeases,
    listActiveSubagentThreadLeases,
    getConvoOwnership,
    getConvoRetention,
    getConvoTitle,
    markConvoSeen,
    markConvoUnread,
    stampConvoLastResponse,
    deleteConvos,
    archiveAllConvos,
  };
}
