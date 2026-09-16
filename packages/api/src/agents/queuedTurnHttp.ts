import { Types } from 'mongoose';
import {
  enqueueAgentQueuedTurnSchema,
  isAgentsEndpoint,
  isEphemeralAgentId,
} from 'librechat-data-provider';
import {
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnConflictError,
  AgentQueuedTurnLaneRetiredError,
} from '@librechat/data-schemas';
import type {
  AgentQueuedTurnActiveRecord,
  AgentQueuedTurnMethods,
  AgentQueuedTurnRecord,
  IMongoFile,
} from '@librechat/data-schemas';
import type {
  TAgentQueuedTurnFileRef,
  TAgentQueuedTurnReceipt,
  TFile,
  TReasoningOverride,
} from 'librechat-data-provider';
import type { AgentQueuedTurnLifecycle } from './queuedTurns';
import type { SteerFileFetcher } from './steering/request';
import type { SteerRequestUser } from './steering/refs';
import { buildOwnerFilter, collectFileIds, toSteerFileRef } from './steering/refs';
import { getReferencedQuotes } from '~/utils';

const MAX_QUEUED_TURN_LENGTH = 16_000;
const MAX_QUEUED_TURN_FILES = 10;
const CAPABILITY = { supported: true, durability: 'durable' } as const;

interface QueuedTurnConversation {
  agent_id?: string;
  endpoint?: string;
  tenantId?: string;
}

interface QueuedTurnHttpMethods extends AgentQueuedTurnMethods {
  getConvo: (userId: string, conversationId: string) => Promise<QueuedTurnConversation | null>;
}

export interface AgentQueuedTurnHttpDeps {
  methods: QueuedTurnHttpMethods;
  lifecycle: Pick<AgentQueuedTurnLifecycle, 'schedule' | 'cancel'>;
  getFiles?: SteerFileFetcher;
  updateFilesUsage?: (
    files: Array<{ file_id: string }>,
    fileIds?: string[],
    options?: { user?: string; tenantId?: string | null },
  ) => Promise<unknown[]>;
  checkAgentAccess?: (run: { agentId?: string; endpoint?: string }) => Promise<boolean>;
  isPrincipalActive?: (userId: string) => boolean | Promise<boolean>;
}

export interface AgentQueuedTurnHttpResult {
  status: number;
  body: Record<string, unknown>;
}

function owner(user: SteerRequestUser): { user: Types.ObjectId; tenantId?: string } | null {
  if (typeof user.id !== 'string' || !Types.ObjectId.isValid(user.id)) {
    return null;
  }
  return {
    user: new Types.ObjectId(user.id),
    ...(user.tenantId != null && { tenantId: user.tenantId }),
  };
}

function sameTenant(actual: unknown, expected: string | undefined): boolean {
  return expected == null ? actual == null : actual === expected;
}

function receipt(
  turn: AgentQueuedTurnRecord | AgentQueuedTurnActiveRecord,
  position?: number,
): TAgentQueuedTurnReceipt {
  const updatedAt = turn.updatedAt ?? turn.createdAt;
  return {
    queuedTurnId: turn.queuedTurnId,
    conversationId: turn.conversationId,
    parentMessageId: turn.parentMessageId,
    clientRequestId: turn.clientRequestId,
    text: turn.text,
    ...(turn.files != null && { files: turn.files }),
    ...(turn.quotes != null && { quotes: turn.quotes }),
    ...(turn.manualSkills != null && { manualSkills: turn.manualSkills }),
    ...(turn.reasoningOverride != null && { reasoningOverride: turn.reasoningOverride }),
    priority: turn.priority,
    ...(turn.expectedPredecessorCreatedAt != null && {
      expectedPredecessorCreatedAt: turn.expectedPredecessorCreatedAt,
    }),
    ...(turn.terminalReceipt?.outcome === 'admitted' &&
      turn.terminalReceipt.effectivePredecessorCreatedAt != null && {
        effectivePredecessorCreatedAt: turn.terminalReceipt.effectivePredecessorCreatedAt,
      }),
    ...(turn.terminalReceipt?.outcome === 'admitted' &&
      turn.terminalReceipt.rootPredecessor === true && { rootPredecessor: true as const }),
    status: turn.status,
    ...(position != null && { position }),
    revision: turn.sequence,
    createdAt: turn.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    ...(turn.terminalReceipt?.failure != null && {
      failure: {
        code: turn.terminalReceipt.failure.code,
        message: turn.terminalReceipt.failure.message,
      },
    }),
  };
}

function parseClientRequestIds(raw: unknown): string[] | null {
  if (raw == null) {
    return [];
  }
  const values = Array.isArray(raw) ? raw : [raw];
  if (values.length > 100 || values.some((value) => typeof value !== 'string')) {
    return null;
  }
  const normalized = [...new Set((values as string[]).map((value) => value.trim()))];
  return normalized.some((value) => value.length === 0 || value.length > 128) ? null : normalized;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function uniqueStrings(values: readonly string[] | undefined): string[] | undefined {
  return values == null ? undefined : [...new Set(values)];
}

function sameReasoningOverride(
  left: TReasoningOverride | undefined,
  right: TReasoningOverride | undefined,
): boolean {
  return left?.key === right?.key && left?.value === right?.value;
}

function matchesReplayIntent(
  turn: AgentQueuedTurnRecord,
  input: {
    parentMessageId: string;
    clientRequestId: string;
    files?: readonly TAgentQueuedTurnFileRef[];
    manualSkills?: readonly string[];
    reasoningOverride?: TReasoningOverride;
    expectedPredecessorCreatedAt?: number;
  },
  text: string,
  quotes: readonly string[] | undefined,
): boolean {
  return (
    turn.parentMessageId === input.parentMessageId &&
    turn.clientRequestId === input.clientRequestId &&
    turn.text === text &&
    sameStrings(
      turn.files?.map((file) => file.file_id),
      uniqueStrings(input.files?.map((file) => file.file_id)),
    ) &&
    sameStrings(turn.quotes, quotes) &&
    sameStrings(turn.manualSkills, uniqueStrings(input.manualSkills)) &&
    sameReasoningOverride(turn.reasoningOverride, input.reasoningOverride) &&
    turn.expectedPredecessorCreatedAt === input.expectedPredecessorCreatedAt
  );
}

async function authorizeConversation(
  user: SteerRequestUser,
  conversationId: string,
  deps: AgentQueuedTurnHttpDeps,
): Promise<
  | { status: 200; conversation: QueuedTurnConversation & { agent_id: string } }
  | AgentQueuedTurnHttpResult
> {
  if (user.id == null) {
    return { status: 401, body: { code: 'UNAUTHORIZED' } };
  }
  const conversation = await deps.methods.getConvo(user.id, conversationId);
  if (conversation == null || !sameTenant(conversation.tenantId, user.tenantId)) {
    return { status: 404, body: { code: 'CONVERSATION_NOT_FOUND' } };
  }
  const agentId = conversation.agent_id;
  if (
    !isAgentsEndpoint(conversation.endpoint) ||
    typeof agentId !== 'string' ||
    isEphemeralAgentId(agentId)
  ) {
    return { status: 501, body: { code: 'QUEUED_TURNS_UNSUPPORTED' } };
  }
  if (
    deps.checkAgentAccess != null &&
    !(await deps.checkAgentAccess({ agentId, endpoint: conversation.endpoint }))
  ) {
    return { status: 403, body: { code: 'FORBIDDEN' } };
  }
  return { status: 200, conversation: { ...conversation, agent_id: agentId } };
}

async function resolveFiles(
  raw: unknown,
  user: SteerRequestUser,
  deps: AgentQueuedTurnHttpDeps,
): Promise<{ files?: TAgentQueuedTurnFileRef[]; error?: AgentQueuedTurnHttpResult }> {
  if (raw == null) {
    return {};
  }
  if (!Array.isArray(raw) || raw.length > MAX_QUEUED_TURN_FILES) {
    return { error: { status: 400, body: { code: 'INVALID_FILES' } } };
  }
  const requested = raw.map(toSteerFileRef);
  if (requested.some((file) => file == null)) {
    return { error: { status: 400, body: { code: 'INVALID_FILES' } } };
  }
  const files = requested as Partial<TFile>[];
  if (files.length === 0) {
    return {};
  }
  if (deps.getFiles == null || deps.updateFilesUsage == null) {
    return {
      error: { status: 503, body: { code: 'FILE_STORAGE_UNAVAILABLE' } },
    };
  }
  const ids = collectFileIds(files);
  const filter = buildOwnerFilter(ids, user);
  if (filter == null) {
    return { error: { status: 400, body: { code: 'INVALID_FILES' } } };
  }
  const docs = (await deps.getFiles(filter, {}, {})) ?? [];
  const byId = new Map(docs.map((doc: IMongoFile) => [doc.file_id, doc]));
  const resolved = ids.flatMap((id): TAgentQueuedTurnFileRef[] => {
    const ref = toSteerFileRef(byId.get(id));
    return ref == null ? [] : [{ ...ref, file_id: id }];
  });
  if (resolved.length !== ids.length) {
    return { error: { status: 400, body: { code: 'INVALID_FILES' } } };
  }
  const retained = await deps.updateFilesUsage(
    ids.map((file_id) => ({ file_id })),
    undefined,
    { user: user.id, tenantId: user.tenantId },
  );
  const retainedIds = new Set<string>();
  for (const file of retained) {
    if (
      file != null &&
      typeof file === 'object' &&
      'file_id' in file &&
      typeof file.file_id === 'string'
    ) {
      retainedIds.add(file.file_id);
    }
  }
  if (!ids.every((id) => retainedIds.has(id))) {
    return { error: { status: 503, body: { code: 'FILE_RETENTION_FAILED' } } };
  }
  return { files: resolved };
}

export async function handleAgentQueuedTurnEnqueue(
  user: SteerRequestUser,
  body: unknown,
  deps: AgentQueuedTurnHttpDeps,
): Promise<AgentQueuedTurnHttpResult> {
  const parsed = enqueueAgentQueuedTurnSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { code: 'INVALID_QUEUED_TURN' } };
  }
  const input = parsed.data;
  const text = input.text.replace(/\0/g, '').trim();
  if (text.length === 0) {
    return { status: 400, body: { code: 'EMPTY_TEXT' } };
  }
  if (text.length > MAX_QUEUED_TURN_LENGTH) {
    return {
      status: 413,
      body: { code: 'QUEUED_TURN_TOO_LONG', maxLength: MAX_QUEUED_TURN_LENGTH },
    };
  }
  /** Interrupt-and-send remains the existing warm steer path; a future lane
   * arbiter can add durable front insertion without weakening FIFO here. */
  if (input.priority === true) {
    return { status: 501, body: { code: 'QUEUED_TURN_PRIORITY_UNSUPPORTED' } };
  }
  const scope = owner(user);
  if (scope == null) {
    return { status: 401, body: { code: 'UNAUTHORIZED' } };
  }
  if (deps.isPrincipalActive != null && !(await deps.isPrincipalActive(user.id!))) {
    return { status: 409, body: { code: 'USER_DELETION_IN_PROGRESS' } };
  }
  const quotes = getReferencedQuotes(input.quotes) ?? undefined;
  /** Request identity is the durable receipt address. Resolve it before
   * mutable conversation/agent/file preconditions so an accepted turn remains
   * observable even if those resources change before a lost-response replay. */
  const existing = await deps.methods.getAgentQueuedTurnByClientRequestId({
    ...scope,
    conversationId: input.conversationId,
    clientRequestId: input.clientRequestId,
  });
  if (existing != null) {
    if (!matchesReplayIntent(existing, input, text, quotes)) {
      return { status: 409, body: { code: 'QUEUED_TURN_IDEMPOTENCY_CONFLICT' } };
    }
    if (existing.status !== 'queued' && existing.status !== 'claimed') {
      return {
        status: 200,
        body: { receipt: receipt(existing), capability: CAPABILITY },
      };
    }
    try {
      await deps.lifecycle.schedule(existing);
    } catch {
      return { status: 503, body: { code: 'QUEUED_TURN_SCHEDULING_PENDING' } };
    }
    const active = await deps.methods.listActiveAgentQueuedTurns({
      ...scope,
      conversationId: input.conversationId,
    });
    const position = active.findIndex((turn) => turn.queuedTurnId === existing.queuedTurnId);
    return {
      status: 202,
      body: {
        receipt: receipt(existing, position >= 0 ? position + 1 : undefined),
        capability: CAPABILITY,
      },
    };
  }
  const authorized = await authorizeConversation(user, input.conversationId, deps);
  if ('body' in authorized) {
    return authorized;
  }
  const resolvedFiles = await resolveFiles(input.files, user, deps);
  if (resolvedFiles.error != null) {
    return resolvedFiles.error;
  }
  try {
    const queued = await deps.methods.enqueueAgentQueuedTurn({
      ...scope,
      conversationId: input.conversationId,
      agentId: authorized.conversation.agent_id,
      parentMessageId: input.parentMessageId,
      clientRequestId: input.clientRequestId,
      text,
      ...(resolvedFiles.files != null && { files: resolvedFiles.files }),
      ...(quotes != null && { quotes }),
      ...(input.manualSkills != null && { manualSkills: input.manualSkills }),
      ...(input.reasoningOverride != null && { reasoningOverride: input.reasoningOverride }),
      priority: false,
      ...(input.expectedPredecessorCreatedAt != null && {
        expectedPredecessorCreatedAt: input.expectedPredecessorCreatedAt,
      }),
    });
    /** A same-body replay is the transport-independent receipt lookup. It can
     * arrive after the original row already settled, in which case no new
     * scheduling side effect is valid or necessary. */
    if (queued.replayed && queued.turn.status !== 'queued' && queued.turn.status !== 'claimed') {
      return {
        status: 200,
        body: { receipt: receipt(queued.turn), capability: CAPABILITY },
      };
    }
    try {
      await deps.lifecycle.schedule(queued.turn);
    } catch {
      /** The row is the outbox source of truth; periodic recovery repairs the
       * record-to-delivery seam. A retry with the same clientRequestId replays. */
      return { status: 503, body: { code: 'QUEUED_TURN_SCHEDULING_PENDING' } };
    }
    const active = await deps.methods.listActiveAgentQueuedTurns({
      ...scope,
      conversationId: input.conversationId,
    });
    const position = active.findIndex((turn) => turn.queuedTurnId === queued.turn.queuedTurnId);
    return {
      status: 202,
      body: {
        receipt: receipt(queued.turn, position >= 0 ? position + 1 : undefined),
        capability: CAPABILITY,
      },
    };
  } catch (error) {
    if (error instanceof AgentQueuedTurnCapacityError) {
      return { status: 429, body: { code: 'QUEUED_TURN_QUEUE_FULL' } };
    }
    if (error instanceof AgentQueuedTurnConflictError) {
      return {
        status: 409,
        body: { code: 'QUEUED_TURN_IDEMPOTENCY_CONFLICT' },
      };
    }
    if (error instanceof AgentQueuedTurnLaneRetiredError) {
      return { status: 409, body: { code: 'QUEUED_TURN_CONVERSATION_DELETING' } };
    }
    throw error;
  }
}

export async function handleAgentQueuedTurnList(
  user: SteerRequestUser,
  conversationId: unknown,
  deps: AgentQueuedTurnHttpDeps,
  rawClientRequestIds?: unknown,
): Promise<AgentQueuedTurnHttpResult> {
  if (typeof conversationId !== 'string' || conversationId.length === 0) {
    return { status: 400, body: { code: 'INVALID_CONVERSATION' } };
  }
  const scope = owner(user);
  if (scope == null) {
    return { status: 401, body: { code: 'UNAUTHORIZED' } };
  }
  const clientRequestIds = parseClientRequestIds(rawClientRequestIds);
  if (clientRequestIds == null) {
    return { status: 400, body: { code: 'INVALID_CLIENT_REQUEST_IDS' } };
  }
  const authorized = await authorizeConversation(user, conversationId, deps);
  if ('body' in authorized) {
    return authorized;
  }
  const turns = await deps.methods.listAgentQueuedTurnReceipts({
    ...scope,
    conversationId,
    clientRequestIds,
  });
  let activePosition = 0;
  return {
    status: 200,
    body: {
      queuedTurns: turns.map((turn) => {
        if (turn.status !== 'queued' && turn.status !== 'claimed') {
          return receipt(turn);
        }
        activePosition += 1;
        return receipt(turn, activePosition);
      }),
      capability: CAPABILITY,
      revision: turns.reduce((latest, turn) => Math.max(latest, turn.sequence), 0),
    },
  };
}

export async function handleAgentQueuedTurnCancel(
  user: SteerRequestUser,
  queuedTurnId: unknown,
  deps: AgentQueuedTurnHttpDeps,
): Promise<AgentQueuedTurnHttpResult> {
  if (typeof queuedTurnId !== 'string' || queuedTurnId.length === 0) {
    return { status: 400, body: { code: 'INVALID_QUEUED_TURN' } };
  }
  const scope = owner(user);
  if (scope == null) {
    return { status: 401, body: { code: 'UNAUTHORIZED' } };
  }
  const cancelled = await deps.lifecycle.cancel({
    ...scope,
    queuedTurnId,
    settledAt: new Date(),
  });
  if (cancelled.outcome === 'not_found') {
    return { status: 404, body: { code: 'QUEUED_TURN_NOT_FOUND' } };
  }
  if (cancelled.outcome === 'not_cancellable') {
    return { status: 409, body: { code: 'QUEUED_TURN_ALREADY_ADMITTING' } };
  }
  return { status: 200, body: { receipt: receipt(cancelled.turn) } };
}
