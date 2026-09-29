import { logger } from '@librechat/data-schemas';
import { excludedKeys, isAgentsEndpoint, isEphemeralAgentId } from 'librechat-data-provider';
import type { AppConfig, ConversationMethods, IConversation } from '@librechat/data-schemas';
import type { TConversation } from 'librechat-data-provider';

type SaveConvo = ConversationMethods['saveConvo'];
type SaveConvoOptions = NonNullable<Parameters<SaveConvo>[2]>;
type SavedMessageId = NonNullable<SaveConvoOptions['appendMessageIds']>[number];
type ConversationStore = Pick<ConversationMethods, 'getConvo' | 'saveConvo'>;

/** Retention context a message or conversation write runs under. */
export type ConversationWriteContext = Parameters<SaveConvo>[0];

/** The request state a turn's conversation writes read and update. */
export interface TurnConversationRequest {
  user?: { id?: string };
  body?: { isTemporary?: boolean };
  config?: { interfaceConfig?: AppConfig['interfaceConfig'] };
  /** Server-captured creation time, stamped only when a write inserts the row. */
  conversationCreatedAt?: string;
  /** `null` once looked up and absent; unset until something has read it. */
  resolvedConversation?: Partial<IConversation> | null;
  _agentEventBindingRetention?: { isTemporary?: boolean; expiredAt?: Date };
  /** Set for subagent threads, whose rows only their parent run may create. */
  _agentEventBindingParentConversationId?: string;
}

/** The conversation fields a turn writes, shared by its seed and its message saves. */
export interface TurnConversationFields {
  req?: TurnConversationRequest;
  conversationId: string;
  endpoint?: string | null;
  endpointType?: string | null;
  endpointOptions?: Partial<TConversation>;
  /** The agent running the turn, recorded as the conversation's initial agent when persisted. */
  agentId?: string;
  /** Logged by `saveConvo` to name the write. */
  context: string;
}

export interface TurnConversationWrite extends TurnConversationFields {
  ctx: ConversationWriteContext;
  /** Whether an earlier write in this request already initialized the conversation. */
  initialized?: boolean;
  /** The message this write just saved, appended to the conversation's message list. */
  savedMessageId?: SavedMessageId;
}

export interface TurnConversationResult {
  conversation: Awaited<ReturnType<SaveConvo>>;
  /** Whether the conversation was already stored, so later writes in the turn skip that work. */
  initialized: boolean;
}

function hasResolvedConversation(req?: TurnConversationRequest): boolean {
  return req != null && Object.prototype.hasOwnProperty.call(req, 'resolvedConversation');
}

/** Whether `retentionMode: all` still needs the stored conversation to stamp a write. */
export function needsRetentionConversation(req?: TurnConversationRequest): boolean {
  const interfaceConfig = req?.config?.interfaceConfig;
  return (
    interfaceConfig?.retentionMode === 'all' &&
    interfaceConfig.generalChatRetention !== undefined &&
    !hasResolvedConversation(req)
  );
}

/** Builds the retention context a message or conversation write runs under. */
export function getConversationWriteContext(
  req?: TurnConversationRequest,
): ConversationWriteContext {
  const resolved = hasResolvedConversation(req) ? req?.resolvedConversation : null;
  return {
    userId: req?.user?.id ?? '',
    isTemporary:
      req?._agentEventBindingRetention?.isTemporary ??
      resolved?.isTemporary ??
      req?.body?.isTemporary,
    expiredAt: req?._agentEventBindingRetention?.expiredAt ?? resolved?.expiredAt ?? undefined,
    interfaceConfig: req?.config?.interfaceConfig,
  };
}

function isAgentOwned(write: TurnConversationFields): boolean {
  const agentId = write.endpointOptions?.agent_id;
  return (
    isAgentsEndpoint(write.endpoint) &&
    agentId != null &&
    agentId !== '' &&
    !isEphemeralAgentId(agentId)
  );
}

/** Keys the stored row carries that this turn's options no longer set. */
function getUnsetFields(
  existing: Partial<IConversation>,
  endpointOptions: Partial<TConversation>,
  agentOwned: boolean,
): Record<string, number> {
  const kept = new Set(['spec', 'iconURL']);
  if (agentOwned) {
    kept.add('model');
  }
  const unsetFields: Record<string, number> = {};
  for (const key of Object.keys(existing)) {
    if (excludedKeys.has(key) && !kept.has(key)) {
      continue;
    }
    if (endpointOptions[key as keyof TConversation] === undefined) {
      unsetFields[key] = 1;
    }
  }
  return unsetFields;
}

function getCreatedAtOnInsert(req?: TurnConversationRequest): Date | undefined {
  if (req?.conversationCreatedAt == null) {
    return undefined;
  }
  const createdAt = new Date(req.conversationCreatedAt);
  return Number.isNaN(createdAt.getTime()) ? undefined : createdAt;
}

async function loadExistingConversation(
  deps: ConversationStore,
  write: TurnConversationWrite,
): Promise<Partial<IConversation> | null> {
  if (write.initialized === true) {
    return null;
  }
  if (hasResolvedConversation(write.req)) {
    return write.req?.resolvedConversation ?? null;
  }
  return deps.getConvo(write.ctx.userId, write.conversationId);
}

async function writeConversation(
  deps: ConversationStore,
  write: TurnConversationWrite,
  existing: Partial<IConversation> | null,
  appendMessageIds: SavedMessageId[] | undefined,
): Promise<TurnConversationResult> {
  const { req, ctx, conversationId, endpoint, endpointType, endpointOptions = {} } = write;
  const agentOwned = isAgentOwned(write);
  const conversation = await deps.saveConvo(
    ctx,
    {
      endpoint,
      endpointType,
      ...endpointOptions,
      conversationId: endpointOptions.conversationId ?? conversationId,
    },
    {
      context: write.context,
      unsetFields: existing != null ? getUnsetFields(existing, endpointOptions, agentOwned) : {},
      noUpsert: req?._agentEventBindingParentConversationId != null,
      initialAgentId: agentOwned ? (write.agentId ?? null) : null,
      createdAtOnInsert:
        write.initialized !== true && existing == null ? getCreatedAtOnInsert(req) : undefined,
      ...(appendMessageIds != null ? { appendMessageIds } : {}),
    },
  );
  if (req != null && conversation != null && 'conversationId' in conversation) {
    req.resolvedConversation = conversation;
  }
  return { conversation, initialized: existing != null };
}

/** Writes the conversation row for a turn's message save. */
export async function saveTurnConversation(
  deps: ConversationStore,
  write: TurnConversationWrite,
): Promise<TurnConversationResult> {
  const existing = await loadExistingConversation(deps, write);
  const appendMessageIds = write.savedMessageId != null ? [write.savedMessageId] : undefined;
  return writeConversation(deps, write, existing, appendMessageIds);
}

/**
 * Adds one message's id to its conversation. Declared structurally, and by plain id, so this
 * operation's callers never name the storage engine's own id type.
 */
export interface MessageReferenceAppender {
  appendConvoMessageReference(
    user: string,
    conversationId: string,
    messageId: string,
  ): Promise<unknown>;
}

/** What a turn knows about a message row whose conversation reference may be missing. */
export interface TurnMessageReferenceRecovery {
  userId: string;
  conversationId: string;
  /** The row a retry restored. Absent means there is nothing to reference. */
  messageId?: string;
  /** Whether the write that should have appended this reference already did. */
  alreadyRecorded: boolean;
  /** False for a turn whose conversation row another run owns, which holds no messages. */
  managesConversation: boolean;
  /** Names the caller in the repair log. */
  context: string;
}

/**
 * Appends a recovered message's reference when nothing else recorded it.
 *
 * A message write can fail and be swallowed, or resolve falsy on a duplicate key it cannot
 * re-read; either way its conversation is written with nothing appended. The turn then retries
 * the row with a bare `saveMessage`, which never touches the conversation, so that row would
 * stay absent from `messages` for good — every other write appends only its own id.
 *
 * Skipped whenever the reference is already recorded, which is every ordinary turn, so the happy
 * path costs no write. Returns whether it wrote.
 */
export async function recoverTurnMessageReference(
  deps: MessageReferenceAppender,
  recovery: TurnMessageReferenceRecovery,
): Promise<boolean> {
  const { userId, conversationId, messageId, alreadyRecorded, managesConversation } = recovery;
  if (alreadyRecorded || !managesConversation || messageId == null || messageId === '') {
    return false;
  }
  try {
    await deps.appendConvoMessageReference(userId, conversationId, messageId);
    return true;
  } catch (error) {
    /** Bookkeeping beside the row it points at: the message itself is already durable, and
     *  failing a turn over its reference would trade a wrong field for a lost response. The
     *  next write that appends to this conversation carries it. */
    logger.error(`[recoverTurnMessageReference] ${recovery.context}`, error);
    return false;
  }
}

/**
 * Creates a new conversation's row ahead of a deferred first message, without the message, so
 * the conversation lists return a running chat. An existing row is left to the message save.
 * Settles once the write has finished and never rejects.
 */
export async function seedTurnConversation(
  deps: ConversationStore,
  fields: TurnConversationFields,
): Promise<void> {
  const { req } = fields;
  const userId = req?.user?.id;
  if (req == null || userId == null || userId === '') {
    return;
  }
  try {
    if (!hasResolvedConversation(req)) {
      req.resolvedConversation = await deps.getConvo(userId, fields.conversationId);
    }
    const write: TurnConversationWrite = { ...fields, ctx: getConversationWriteContext(req) };
    const existing = await loadExistingConversation(deps, write);
    if (existing != null) {
      return;
    }
    /** An empty append set tells `saveConvo` the row holds no messages yet, sparing the read. */
    await writeConversation(deps, write, null, []);
  } catch (error) {
    logger.error('[seedTurnConversation] Failed to seed the conversation', error);
  }
}

/**
 * Orders a deferred write behind a seed of the same row. While the seed is in flight the write
 * waits for it; once the seed has landed the write starts synchronously, which a Stop relies on.
 * `seed` must not reject.
 */
export function runAfterSeed<T>(seed: Promise<void>, write: () => Promise<T>): () => Promise<T> {
  let seeding = true;
  void seed.finally(() => {
    seeding = false;
  });
  return () => (seeding ? seed.then(write) : write());
}
