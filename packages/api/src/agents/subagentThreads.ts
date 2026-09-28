import { randomUUID } from 'node:crypto';
import { InMemorySubagentTaskStore } from '@librechat/agents';
import { logger, tenantStorage } from '@librechat/data-schemas';
import { EModelEndpoint, Constants } from 'librechat-data-provider';
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@librechat/agents/langchain/messages';
import type {
  InMemorySubagentTaskStoreOptions,
  SubagentTaskClaim,
  SubagentTaskControlCommand,
  SubagentTaskControlResult,
  SubagentTaskRuntime,
  SubagentTaskSnapshot,
  SubagentTaskStartRequest,
  SubagentTaskStartResult,
  SubagentTaskStore,
  SubagentUpdateEvent,
} from '@librechat/agents';
import type {
  AllMethods,
  IActiveSubagentThreadLease,
  IConversation,
  ISubagentTaskControlReceipt,
  IMessage,
  MessageMethods,
  ConversationMethods,
  SubagentTaskResultClaim,
} from '@librechat/data-schemas';
import type { BaseMessage, StoredMessage } from '@librechat/agents/langchain/messages';
import type {
  SubagentActivityUpdateEvent,
  SubagentActivitySubscriber,
  SubagentActivitySubscription,
  SubagentActivityTerminalStatus,
} from './subagentActivity';
import type { SubagentTaskControlTransport } from './subagentTaskRouting';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { HostSubagentTaskConfig } from './subagentDelivery';
import {
  boundedClaim,
  boundedTaskList,
  controlFingerprint,
  SubagentTaskOwnerUnavailableError,
} from './subagentTaskRouting';
import { boundSubagentActivityUpdate, SubagentActivityStream } from './subagentActivity';
import { createSubagentAttemptKey, createSubagentThreadId } from './subagentThreadIds';
import { runWithDetachedSubagentUsage } from './subagentTaskContext';
import { SUBAGENT_COMPLETION_DELIVERY } from './subagentDelivery';
import { createConcurrencyLimiter } from '~/utils/promise';
import { projectSubagentActivity } from './activity';
import { InMemoryEventTransport } from '~/stream';
import { aggregateEmittedUsage } from './usage';

const SCOPE_VERSION = 1;
const DEFAULT_MAX_THREAD_DEPTH = 1;
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_LEASE_HEARTBEAT_MS = 10_000;
const DEFAULT_OWNER_DRAIN_TIMEOUT_MS = 45_000;
/** Keeps the admission fence alive across the deletion that follows the drain. */
const OWNER_FENCE_GRACE_MS = 5 * 60_000;
const DEFAULT_OWNER_DRAIN_POLL_MS = 100;
/** Matches the deletion drain batch so cancellation cannot burst Redis. */
const DELETION_CANCEL_CONCURRENCY = 32;
/** Bounds retained control invocations; one entry per applied command. */
const MAX_CONTROL_INVOCATIONS = 4_096;
/** Terminal controls are side-effect free, but retaining one bounded window
 * prevents duplicate storage writers while preserving recent retry replay. */
const MAX_TERMINAL_CONTROL_INVOCATIONS = 64;
/** Keep same-task durable reservations below the storage CAS retry bound. Receipt
 * finalization is serialized per task separately, leaving ample collision headroom. */
const CONTROL_RESERVATION_CONCURRENCY = 32;
const MAX_DURABLE_CONTROL_MESSAGE_CHARS = 4 * 1024;
const DEFAULT_CONTROL_RECEIPT_RETRY_MS = 5_000;
const SHUTDOWN_CONTROL_RECEIPT_FLUSH_ATTEMPTS = 4;
const DEFAULT_SHUTDOWN_CONTROL_RECEIPT_BACKOFF_MS = 1_000;
/** Bounds retained live-only updates while an event transport is unavailable. */
const MAX_PENDING_ACTIVITY_EVENTS = 32;
/** Live activity must never delay terminal notification indefinitely. */
const ACTIVITY_PUBLICATION_TIMEOUT_MS = 1_000;

/** A cancellation target set resolved before the conversations are removed. */
export interface SubagentCancellationPlan {
  userId: string;
  tenantId?: string;
  conversationIds: string[];
  scopes: Array<{ scopeId: string; threadIds: string[] | null }>;
  leases: IActiveSubagentThreadLease[];
}
/** Three missed 10-second transport heartbeats retire a crashed owner. */
const DEFAULT_TASK_ROUTING_TTL_MS = 30_000;
const SLOW_PREPARATION_WARN_MS = 5_000;
const MAX_TRANSCRIPT_BYTES = 12 * 1024 * 1024;
const TRANSCRIPT_SELECT =
  'messageId parentMessageId text createdAt +subagentTranscript +subagentTask';
const DURABLE_RESULT_SELECT =
  'messageId conversationId sender text createdAt updatedAt +subagentTask';

class SubagentThreadPublicError extends Error {}
class SubagentThreadDeletedError extends SubagentThreadPublicError {}
class SubagentControlReceiptConflictError extends Error {}

type SubagentThreadMethods = Pick<
  AllMethods,
  | 'acquireSubagentThreadLease'
  | 'claimSubagentTaskResult'
  | 'countActiveSubagentThreadLeases'
  | 'deleteConvos'
  | 'deleteMessages'
  | 'getConvo'
  | 'getSubagentTaskControlReplay'
  | 'getMessages'
  | 'listActiveSubagentThreadLeases'
  | 'reserveSubagentThread'
  | 'releaseSubagentThreadLease'
  | 'recordSubagentTaskControlReceipt'
  | 'renewSubagentThreadLease'
  | 'saveConvo'
  | 'saveMessage'
>;

interface SubagentThreadScope {
  version: typeof SCOPE_VERSION;
  userId: string;
  parentConversationId: string;
  tenantId?: string;
}

interface PreparedThread {
  conversation: IConversation;
  initialMessages: BaseMessage[];
  initialStoredMessages: StoredMessage[];
  attemptKey: string;
  /** Stable source-occurrence time shared by first delivery and every replay. */
  taskCreatedAt: number;
  userMessageId?: string;
  replay?: {
    status: 'completed' | 'error' | 'cancelled';
    content: string;
    taskId: string;
    parentRunId: string;
    /** Original running task closed by a retry under a new terminal message id. */
    previousTaskId?: string;
  };
}

interface HostSubagentTaskStartRequest extends SubagentTaskStartRequest {
  completionDelivery?: typeof SUBAGENT_COMPLETION_DELIVERY;
}

type ThreadMessage = Pick<
  IMessage,
  'messageId' | 'parentMessageId' | 'text' | 'createdAt' | 'subagentTranscript' | 'subagentTask'
>;

type SdkControlReceipt = {
  controlId: string;
  action: 'steer' | 'queue' | 'interrupt';
  status: 'accepted' | 'applied' | 'rejected' | 'failed';
  createdAt: number;
  updatedAt: number;
  boundary?: 'preempt' | 'tool' | 'turn';
  reason?: 'withdrawn' | 'task_completed' | 'task_cancelled' | 'task_failed';
};

type SnapshotWithControlReceipts = SubagentTaskSnapshot & {
  controlReceipts?: SdkControlReceipt[];
};

type ControlInvocationRecord = {
  scopeId: string;
  taskId: string;
  invocationId: string;
  fingerprint: string;
  command: SubagentTaskControlCommand;
  commandMessageTruncated: boolean;
  result: SubagentTaskControlResult;
  createdAt: number;
  /** Last authoritative SDK transition, retained for idempotent retries even
   * after the bounded SDK snapshot evicts older receipt history. */
  receipt?: ISubagentTaskControlReceipt;
  /** True only after this invocation's current receipt is durable and therefore
   * safe to evict from the bounded process-local replay window. */
  receiptPersisted?: boolean;
  /** The current durable write, shared by same-invocation retries so a caller
   * cannot observe success before the authoritative receipt is committed. */
  receiptPersistence?: Promise<void>;
};

const hasDurableControlReceipt = (invocation: ControlInvocationRecord): boolean =>
  invocation.receiptPersisted === true;

interface TaskThreadLease {
  scopeId: string;
  idempotencyKey: string;
  taskId: string;
  running: boolean;
  settling: boolean;
  /** Resolves only after child persistence and lease cleanup finish. */
  execution?: Promise<void>;
  /** Ordered observational tail; canonical child settlement never awaits it. */
  activityTail?: Promise<void>;
  activityPending?: number;
  /** Terminal settlement stops new admission but must not discard admitted events. */
  activityAdmissionClosed?: boolean;
  /** A failed observational publication suppresses the remainder of this task's queue. */
  activityCircuitOpen?: boolean;
  shared?: {
    token: string;
    lost: boolean;
    /** Epoch ms this lease is durable until, advanced only by a confirmed renewal. */
    expiresAt: number;
    heartbeat?: ReturnType<typeof setInterval>;
    heartbeatInFlight?: Promise<void>;
  };
}

class SubagentActivityPublicationTimeoutError extends Error {
  constructor() {
    super('Subagent activity publication timed out.');
    this.name = 'SubagentActivityPublicationTimeoutError';
  }
}

async function settleActivityWithin(operation: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new SubagentActivityPublicationTimeoutError()),
          ACTIVITY_PUBLICATION_TIMEOUT_MS,
        );
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

export interface SubagentThreadTaskStoreOptions extends InMemorySubagentTaskStoreOptions {
  maxThreadDepth?: number;
  leaseTtlMs?: number;
  leaseHeartbeatMs?: number;
  ownerDrainTimeoutMs?: number;
  ownerDrainPollMs?: number;
  taskRoutingTtlMs?: number;
  isOwnerActive?: (userId: string) => Promise<boolean>;
  maxControlInvocations?: number;
  controlReceiptRetryMs?: number;
  shutdownControlReceiptBackoffMs?: number;
  ownerFenceGraceMs?: number;
  fenceOwnerAdmission?: (userId: string, token: string, fencedUntil: Date) => Promise<void>;
  renewOwnerAdmission?: (userId: string, token: string, fencedUntil: Date) => Promise<boolean>;
  releaseOwnerAdmission?: (userId: string, token: string) => Promise<void>;
  /** Host-owned work may share the durable child lease protocol without living in
   * this in-memory task store. Return true only after that work is stopped. */
  cancelUnroutedTask?: (target: {
    userId: string;
    parentConversationId: string;
    taskId: string;
    tenantId?: string;
  }) => Promise<boolean>;
  onTaskPrepared?: (
    registration: SubagentTaskWakeupRegistration,
  ) => Promise<boolean | void> | boolean | void;
  /** Called once a child's terminal message is durable, with the parent conversation its
   * completion wake-up resumes. The child generation settles before that write, so the
   * wake-up is ready only from here. Task ids include the original abandoned
   * attempt when a retry persisted its result under a new id. */
  onTaskSettled?: (userId: string, parentConversationId: string, taskIds: string[]) => void;
}

export interface SubagentTaskWakeupRegistration {
  userId: string;
  parentConversationId: string;
  parentMessageId: string;
  parentAgentId?: string;
  tenantId?: string;
  taskId: string;
  threadId: string;
  subagentType: string;
  createdAt: number;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value != null && value > 0 ? value : fallback;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function normalizedRequestFingerprint(request: SubagentTaskStartRequest): string | undefined {
  const fingerprint = request.requestFingerprint?.trim();
  return fingerprint == null || fingerprint === '' ? undefined : fingerprint;
}

function parseScope(scopeId: string): SubagentThreadScope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scopeId);
  } catch {
    throw new Error('Invalid subagent thread scope.');
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid subagent thread scope.');
  }
  const candidate = parsed as Partial<SubagentThreadScope>;
  if (
    candidate.version !== SCOPE_VERSION ||
    !isNonEmptyString(candidate.userId) ||
    !isNonEmptyString(candidate.parentConversationId) ||
    (candidate.tenantId != null && !isNonEmptyString(candidate.tenantId))
  ) {
    throw new Error('Invalid subagent thread scope.');
  }
  return {
    version: SCOPE_VERSION,
    userId: candidate.userId,
    parentConversationId: candidate.parentConversationId,
    ...(candidate.tenantId == null ? {} : { tenantId: candidate.tenantId }),
  };
}

function serializeScope(scope: Omit<SubagentThreadScope, 'version'>): string {
  return JSON.stringify({ version: SCOPE_VERSION, ...scope });
}

/** Builds the trusted live-owner routing scope after parent authorization. */
export function createSubagentThreadScopeId(scope: Omit<SubagentThreadScope, 'version'>): string {
  return serializeScope(scope);
}

function matchesTenant(actual: string | undefined, expected: string | undefined): boolean {
  return actual === expected;
}

function durableMessageTime(message: Pick<IMessage, 'createdAt'>, missingMessage: string): number {
  const value = message.createdAt?.getTime();
  if (!Number.isSafeInteger(value) || value == null || value < 0) {
    throw new Error(missingMessage);
  }
  return value;
}

function assertParentPersistence(
  value: unknown,
  scope: SubagentThreadScope,
): asserts value is { message: { messageId: string; conversationId: string } } {
  const message =
    value != null && typeof value === 'object'
      ? (value as { message?: unknown }).message
      : undefined;
  if (
    message == null ||
    typeof message !== 'object' ||
    !isNonEmptyString((message as { messageId?: unknown }).messageId) ||
    (message as { conversationId?: unknown }).conversationId !== scope.parentConversationId
  ) {
    throw new Error('The parent message was not persisted.');
  }
}

function selectLatestBranch(messages: ThreadMessage[]): ThreadMessage[] {
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  const branch: ThreadMessage[] = [];
  const seen = new Set<string>();
  let current: ThreadMessage | undefined = messages[messages.length - 1];
  while (current != null && !seen.has(current.messageId)) {
    branch.push(current);
    seen.add(current.messageId);
    const parentId: string | undefined = current.parentMessageId ?? undefined;
    current =
      parentId == null || parentId === '' || parentId === Constants.NO_PARENT
        ? undefined
        : byId.get(parentId);
  }
  return branch.reverse();
}

function parseStoredMessages(value: string): StoredMessage[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new SubagentThreadPublicError('Invalid persisted subagent transcript.');
  }
  for (const message of parsed) {
    if (
      message == null ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      !isNonEmptyString((message as { type?: unknown }).type) ||
      (message as { data?: unknown }).data == null ||
      typeof (message as { data?: unknown }).data !== 'object' ||
      Array.isArray((message as { data?: unknown }).data)
    ) {
      throw new SubagentThreadPublicError('Invalid persisted subagent transcript.');
    }
  }
  return parsed as StoredMessage[];
}

function restoreThreadMessages(branch: ThreadMessage[]): BaseMessage[] {
  let storedMessages: StoredMessage[] = [];
  for (const message of branch) {
    const transcript = message.subagentTranscript;
    if (transcript == null) {
      continue;
    }
    const segment = parseStoredMessages(transcript.messagesJson);
    if (transcript.mode === 'replace') {
      storedMessages = segment;
    } else {
      storedMessages.push(...segment);
    }
  }
  return mapStoredMessagesToChatMessages(storedMessages);
}

function isStoredPrefix(prefix: StoredMessage[], messages: StoredMessage[]): boolean {
  if (prefix.length > messages.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (JSON.stringify(prefix[index]) !== JSON.stringify(messages[index])) {
      return false;
    }
  }
  return true;
}

function serializeTranscript(
  taskId: string,
  initialMessages: StoredMessage[],
  resultMessages: BaseMessage[] | undefined,
): IMessage['subagentTranscript'] {
  if (resultMessages == null) {
    return undefined;
  }
  const storedResult = mapChatMessagesToStoredMessages(resultMessages);
  const storedResultJson = JSON.stringify(storedResult);
  if (Buffer.byteLength(storedResultJson, 'utf8') > MAX_TRANSCRIPT_BYTES) {
    throw new SubagentThreadPublicError(
      'Subagent thread transcript is too large to persist safely.',
    );
  }
  const append = isStoredPrefix(initialMessages, storedResult);
  const messages = append ? storedResult.slice(initialMessages.length) : storedResult;
  if (messages.length === 0) {
    return undefined;
  }
  const messagesJson = append ? JSON.stringify(messages) : storedResultJson;
  return {
    taskId,
    mode: append ? 'append' : 'replace',
    messagesJson,
  };
}

function retentionContext(conversation: IConversation): {
  isTemporary?: boolean;
  expiredAt?: Date;
} {
  return {
    ...(conversation.isTemporary == null ? {} : { isTemporary: conversation.isTemporary }),
    ...(conversation.expiredAt == null ? {} : { expiredAt: conversation.expiredAt }),
  };
}

function retentionFields(conversation: IConversation): {
  isTemporary?: boolean;
  expiredAt?: Date;
  tenantId?: string;
} {
  return {
    ...retentionContext(conversation),
    ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
  };
}

function childAgentId(request: SubagentTaskStartRequest): string | undefined {
  if (request.subagentKind === 'graph') {
    return undefined;
  }
  return request.subagentType === 'self' ? request.parentAgentId : request.subagentType;
}

function publicFailureDetail(error: unknown): string {
  return error instanceof SubagentThreadPublicError
    ? error.message.slice(0, 2_000)
    : 'The child run could not be completed.';
}

/** Rebuilds the terminal claim a recovered durable result stands for. */
function recoveredClaim(
  message: IMessage,
  claim: Extract<SubagentTaskClaim, { status: 'claimed' }>,
): SubagentTaskClaim | undefined {
  const status = message.subagentTask?.status;
  const content = message.text ?? '';
  /** A durable child message keeps the untruncated output, so recovering one applies
   * the same bounds a routed response would have. */
  if (status === 'completed') {
    return boundedClaim({ status: 'completed', task: claim.task, result: content });
  }
  if (status === 'error' || status === 'cancelled') {
    return boundedClaim({ status, task: claim.task, error: content });
  }
  return undefined;
}

function drainKey(parentConversationId: string, taskId: string): string {
  return `${parentConversationId}\u0000${taskId}`;
}

function controlTaskKey(scopeId: string, taskId: string): string {
  return `${scopeId}\u0000${taskId}`;
}

function parseControlTaskKey(key: string): { scopeId: string; taskId: string } | undefined {
  const separator = key.lastIndexOf('\u0000');
  if (separator < 0 || separator === key.length - 1) return undefined;
  return { scopeId: key.slice(0, separator), taskId: key.slice(separator + 1) };
}

function controlReceiptKey(scopeId: string, taskId: string, controlId: string): string {
  return `${scopeId}\u0000${taskId}\u0000${controlId}`;
}

function boundedControlMessage(
  command: SubagentTaskControlCommand,
  alreadyTruncated = false,
): {
  message?: string;
  messageTruncated?: boolean;
} {
  if (!('message' in command)) return {};
  if (command.message.length <= MAX_DURABLE_CONTROL_MESSAGE_CHARS) {
    return {
      message: command.message,
      ...(alreadyTruncated ? { messageTruncated: true } : {}),
    };
  }
  return {
    message: command.message.slice(0, MAX_DURABLE_CONTROL_MESSAGE_CHARS),
    messageTruncated: true,
  };
}

function boundedControlCommand(command: SubagentTaskControlCommand): SubagentTaskControlCommand {
  if (!('message' in command)) return command;
  return {
    action: command.action,
    message: command.message.slice(0, MAX_DURABLE_CONTROL_MESSAGE_CHARS),
  };
}

function safeErrorMessage(error: unknown): string {
  return `Subagent task failed: ${publicFailureDetail(error).slice(0, 2_000)}`;
}

async function observeSlowPreparation<T>(
  operation: Promise<T>,
  context: { stage: string; taskId: string; threadId: string },
): Promise<T> {
  const warning = setTimeout(() => {
    logger.warn('[subagentThreads] Child-thread preparation is still waiting', context);
  }, SLOW_PREPARATION_WARN_MS);
  try {
    return await operation;
  } finally {
    clearTimeout(warning);
  }
}

/** Persists view-only logical child threads with owner-routed controls and a shared execution fence. */
export class SubagentThreadTaskStore extends InMemorySubagentTaskStore {
  readonly supportsThreadContinuation = true;
  private readonly activeThreads = new Map<string, TaskThreadLease>();
  private readonly controlInvocations = new Map<string, ControlInvocationRecord>();
  private readonly terminalControlInvocations = new Map<string, ControlInvocationRecord>();

  private readonly controlInvocationByReceipt = new Map<string, ControlInvocationRecord>();
  private readonly pendingControlReceipts = new Map<
    string,
    Map<string, { threadId: string; receipt: ISubagentTaskControlReceipt }>
  >();

  private readonly controlPersistenceTails = new Map<string, Promise<void>>();
  private readonly controlPersistenceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controlReservationSlot = createConcurrencyLimiter(
    CONTROL_RESERVATION_CONCURRENCY,
  );

  private controlPersistenceStopping = false;
  private controlCommandAdmissionClosed = false;

  private readonly parentPersistence = new Map<string, Promise<unknown>>();
  private readonly maxThreadDepth: number;
  private readonly leaseTtlMs: number;
  private readonly leaseHeartbeatMs: number;
  private readonly ownerDrainTimeoutMs: number;
  private readonly ownerDrainPollMs: number;
  private readonly taskRoutingTtlMs: number;
  private readonly maxControlInvocations: number;
  private readonly controlReceiptRetryMs: number;
  private readonly shutdownControlReceiptBackoffMs: number;
  private readonly ownerFenceGraceMs: number;
  private readonly isOwnerActive: (userId: string) => Promise<boolean>;
  private readonly fenceOwnerAdmission?: (
    userId: string,
    token: string,
    fencedUntil: Date,
  ) => Promise<void>;

  private readonly renewOwnerAdmission?: (
    userId: string,
    token: string,
    fencedUntil: Date,
  ) => Promise<boolean>;

  private readonly releaseOwnerAdmission?: (userId: string, token: string) => Promise<void>;
  private readonly cancelUnroutedTask?: SubagentThreadTaskStoreOptions['cancelUnroutedTask'];
  private readonly onTaskPrepared?: SubagentThreadTaskStoreOptions['onTaskPrepared'];
  private readonly onTaskSettled?: SubagentThreadTaskStoreOptions['onTaskSettled'];
  /** Tasks whose completion wake-up was registered; only they announce settlement. */
  private readonly wakeupTaskIds = new Set<string>();
  private taskControlTransport?: SubagentTaskControlTransport;
  private activityStream = new SubagentActivityStream(new InMemoryEventTransport());

  constructor(
    private readonly methods: SubagentThreadMethods,
    options: SubagentThreadTaskStoreOptions = {},
  ) {
    super(options);
    this.maxThreadDepth =
      Number.isSafeInteger(options.maxThreadDepth) && (options.maxThreadDepth ?? 0) > 0
        ? (options.maxThreadDepth as number)
        : DEFAULT_MAX_THREAD_DEPTH;
    this.leaseTtlMs = positiveInteger(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    this.leaseHeartbeatMs = Math.min(
      positiveInteger(options.leaseHeartbeatMs, DEFAULT_LEASE_HEARTBEAT_MS),
      Math.max(1, Math.floor(this.leaseTtlMs / 2)),
    );
    this.ownerDrainTimeoutMs = positiveInteger(
      options.ownerDrainTimeoutMs,
      DEFAULT_OWNER_DRAIN_TIMEOUT_MS,
    );
    this.ownerDrainPollMs = positiveInteger(options.ownerDrainPollMs, DEFAULT_OWNER_DRAIN_POLL_MS);
    this.taskRoutingTtlMs = positiveInteger(options.taskRoutingTtlMs, DEFAULT_TASK_ROUTING_TTL_MS);
    this.maxControlInvocations = positiveInteger(
      options.maxControlInvocations,
      MAX_CONTROL_INVOCATIONS,
    );
    this.controlReceiptRetryMs = positiveInteger(
      options.controlReceiptRetryMs,
      DEFAULT_CONTROL_RECEIPT_RETRY_MS,
    );
    this.shutdownControlReceiptBackoffMs = positiveInteger(
      options.shutdownControlReceiptBackoffMs,
      DEFAULT_SHUTDOWN_CONTROL_RECEIPT_BACKOFF_MS,
    );
    this.ownerFenceGraceMs = positiveInteger(options.ownerFenceGraceMs, OWNER_FENCE_GRACE_MS);
    this.isOwnerActive = options.isOwnerActive ?? (async () => true);
    this.fenceOwnerAdmission = options.fenceOwnerAdmission;
    this.renewOwnerAdmission = options.renewOwnerAdmission;
    this.releaseOwnerAdmission = options.releaseOwnerAdmission;
    this.cancelUnroutedTask = options.cancelUnroutedTask;
    this.onTaskPrepared = options.onTaskPrepared;
    this.onTaskSettled = options.onTaskSettled;
  }

  /** Receives payload-free authoritative transitions from the SDK task store. */
  protected onControlReceipt(scopeId: string, taskId: string, receipt: SdkControlReceipt): void {
    const persistence = this.queueAuthoritativeControlReceipt(scopeId, taskId, receipt);
    void persistence?.catch((error) => {
      logger.warn('[subagentThreads] Failed to persist a child control transition', error);
    });
  }

  private queueAuthoritativeControlReceipt(
    scopeId: string,
    taskId: string,
    receipt: SdkControlReceipt,
  ): Promise<void> | undefined {
    const invocation = this.controlInvocationByReceipt.get(
      controlReceiptKey(scopeId, taskId, receipt.controlId),
    );
    const threadId = this.get(scopeId, taskId)?.threadId;
    if (invocation == null || threadId == null) return undefined;
    const durable = this.durableReceipt(invocation, receipt);
    invocation.receipt = durable;
    invocation.result = this.controlResultFromReceipt(
      invocation,
      durable,
      this.get(scopeId, taskId)?.pendingControls,
    );
    if (receipt.status !== 'accepted') {
      this.controlInvocationByReceipt.delete(controlReceiptKey(scopeId, taskId, receipt.controlId));
    }
    invocation.receiptPersisted = false;
    const persistence = this.queueControlReceipt(scopeId, taskId, threadId, durable).then(() => {
      if (invocation.receipt === durable) invocation.receiptPersisted = true;
    });
    const tracked = persistence.finally(() => {
      if (invocation.receiptPersistence === tracked) invocation.receiptPersistence = undefined;
    });
    invocation.receiptPersistence = tracked;
    return tracked;
  }

  /** Keeps same-process retries aligned with the durable receipt ledger. The SDK
   * can replace an accepted control with a terminal transition after the child
   * settles, so the originally returned result is no longer authoritative. */
  private controlResultFromReceipt(
    invocation: ControlInvocationRecord,
    receipt: ISubagentTaskControlReceipt,
    pendingControls?: number,
  ): SubagentTaskControlResult {
    const current = invocation.result;
    if (!('task' in current)) return current;
    let terminalStatus = current.task.status;
    if (
      (receipt.action === 'cancel' && receipt.status === 'applied') ||
      receipt.reason === 'task_cancelled'
    ) {
      terminalStatus = 'cancelled';
    } else if (receipt.reason === 'task_completed') {
      terminalStatus = 'completed';
    } else if (receipt.reason === 'task_failed') {
      terminalStatus = 'error';
    }
    const task: SubagentTaskSnapshot = {
      ...current.task,
      status: terminalStatus,
      updatedAt: receipt.updatedAt.getTime(),
      /** A receipt can make cancellation authoritative before the assistant row
       * exists. Preserve actual result materialization rather than inferring it. */
      resultAvailable: current.task.resultAvailable,
      pendingControls: pendingControls ?? current.task.pendingControls,
    };
    if (receipt.status === 'accepted') {
      return {
        status: 'accepted',
        task,
        ...(receipt.controlId == null ? {} : { controlId: receipt.controlId }),
      };
    }
    if (receipt.status === 'applied') {
      return receipt.action === 'cancel'
        ? { status: 'cancelled', task }
        : {
            status: 'accepted',
            task,
            ...(receipt.controlId == null ? {} : { controlId: receipt.controlId }),
          };
    }
    if (
      receipt.reason === 'task_not_running' ||
      receipt.reason === 'task_completed' ||
      receipt.reason === 'task_cancelled' ||
      receipt.reason === 'task_failed'
    ) {
      return { status: 'not_running', task };
    }
    if (receipt.reason === 'control_not_found' || receipt.reason === 'withdrawn') {
      return { status: 'control_not_found', task };
    }
    return {
      status: 'invalid',
      message:
        receipt.status === 'failed'
          ? 'The prior control invocation failed.'
          : 'The prior control invocation was rejected.',
    };
  }

  private durableReceipt(
    invocation: ControlInvocationRecord,
    receipt: SdkControlReceipt,
  ): ISubagentTaskControlReceipt {
    return {
      invocationId: invocation.invocationId,
      fingerprint: invocation.fingerprint,
      controlId: receipt.controlId,
      action: receipt.action,
      status: receipt.status,
      createdAt: new Date(receipt.createdAt),
      updatedAt: new Date(receipt.updatedAt),
      ...(receipt.boundary == null ? {} : { boundary: receipt.boundary }),
      ...(receipt.reason == null ? {} : { reason: receipt.reason }),
      ...boundedControlMessage(invocation.command, invocation.commandMessageTruncated),
    };
  }

  private controlResultReceipt(
    invocation: ControlInvocationRecord,
  ): ISubagentTaskControlReceipt | undefined {
    const { command, result } = invocation;
    if (result.status === 'not_found' || result.status === 'invalid') return undefined;
    if (invocation.receipt != null) return invocation.receipt;
    const snapshot = result.task as SnapshotWithControlReceipts;
    if (
      result.status === 'accepted' &&
      result.controlId != null &&
      (command.action === 'steer' || command.action === 'queue' || command.action === 'interrupt')
    ) {
      const sdkReceipt = snapshot.controlReceipts?.find(
        (receipt) => receipt.controlId === result.controlId,
      );
      if (sdkReceipt != null) return this.durableReceipt(invocation, sdkReceipt);
      return {
        invocationId: invocation.invocationId,
        fingerprint: invocation.fingerprint,
        controlId: result.controlId,
        action: command.action,
        status: 'accepted',
        createdAt: new Date(invocation.createdAt),
        updatedAt: new Date(invocation.createdAt),
        ...boundedControlMessage(command, invocation.commandMessageTruncated),
      };
    }
    const now = new Date();
    let reason: string | undefined;
    if (result.status === 'not_running') {
      reason = 'task_not_running';
    } else if (result.status === 'control_not_found') {
      reason = 'control_not_found';
    }
    let targetControlId: string | undefined;
    if (command.action === 'cancel_message') {
      targetControlId = command.controlId;
    } else if (result.status === 'accepted') {
      targetControlId = result.controlId;
    }
    return {
      invocationId: invocation.invocationId,
      fingerprint: invocation.fingerprint,
      ...(targetControlId == null ? {} : { controlId: targetControlId }),
      action: command.action,
      status:
        result.status === 'accepted' || result.status === 'cancelled' ? 'applied' : 'rejected',
      createdAt: new Date(invocation.createdAt),
      updatedAt: now,
      ...(reason == null ? {} : { reason }),
      ...boundedControlMessage(command, invocation.commandMessageTruncated),
    };
  }

  private async replayDurableControl(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult | undefined> {
    const scope = parseScope(scopeId);
    const replay = await this.runWithOwnerContext(scope, () =>
      this.methods.getSubagentTaskControlReplay({
        userId: scope.userId,
        parentConversationId: scope.parentConversationId,
        taskId,
        invocationId,
        ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
      }),
    );
    if (replay == null) return undefined;
    if (replay.receipt.fingerprint !== controlFingerprint(command)) {
      return {
        status: 'invalid',
        message: 'This control invocation id was already used for a different command.',
      };
    }
    const { receipt, task: durableTask } = replay;
    if (receipt.status === 'reserved') {
      /** The prior owner fenced this invocation but did not durably prove the
       * side effect. Reapplying could duplicate it; reporting acceptance would lie. */
      throw new SubagentTaskOwnerUnavailableError();
    }
    const task: SubagentTaskSnapshot = {
      taskId,
      threadId: durableTask.threadId,
      subagentType: durableTask.subagentType,
      status: durableTask.status,
      createdAt: durableTask.createdAt.getTime(),
      updatedAt: durableTask.updatedAt.getTime(),
      resultAvailable: durableTask.resultAvailable,
      resultClaimed: durableTask.resultClaimed,
      pendingControls: durableTask.pendingControls,
      ...(receipt.controlId != null &&
      (receipt.action === 'steer' || receipt.action === 'queue' || receipt.action === 'interrupt')
        ? {
            controlReceipts: [
              {
                controlId: receipt.controlId,
                action: receipt.action,
                status: receipt.status,
                createdAt: receipt.createdAt.getTime(),
                updatedAt: receipt.updatedAt.getTime(),
                ...(receipt.boundary == null ? {} : { boundary: receipt.boundary }),
                ...(receipt.reason === 'withdrawn' ||
                receipt.reason === 'task_completed' ||
                receipt.reason === 'task_cancelled' ||
                receipt.reason === 'task_failed'
                  ? { reason: receipt.reason }
                  : {}),
              },
            ],
          }
        : {}),
    };
    if (receipt.status === 'accepted') {
      return {
        status: 'accepted',
        task,
        ...(receipt.controlId == null ? {} : { controlId: receipt.controlId }),
      };
    }
    if (receipt.status === 'applied') {
      return command.action === 'cancel'
        ? { status: 'cancelled', task }
        : {
            status: 'accepted',
            task,
            ...(receipt.controlId == null ? {} : { controlId: receipt.controlId }),
          };
    }
    if (
      receipt.reason === 'task_not_running' ||
      receipt.reason === 'task_completed' ||
      receipt.reason === 'task_cancelled' ||
      receipt.reason === 'task_failed'
    ) {
      return { status: 'not_running', task };
    }
    if (receipt.reason === 'control_not_found' || receipt.reason === 'withdrawn') {
      return { status: 'control_not_found', task };
    }
    return {
      status: 'invalid',
      message:
        receipt.status === 'failed'
          ? 'The prior control invocation failed.'
          : 'The prior control invocation was rejected.',
    };
  }

  private queueControlReceipt(
    scopeId: string,
    taskId: string,
    threadId: string,
    receipt: ISubagentTaskControlReceipt,
  ): Promise<void> {
    const key = controlTaskKey(scopeId, taskId);
    const pending = this.pendingControlReceipts.get(key) ?? new Map();
    pending.set(receipt.invocationId, { threadId, receipt });
    this.pendingControlReceipts.set(key, pending);
    return this.flushControlReceipts(scopeId, taskId);
  }

  private flushControlReceipts(scopeId: string, taskId: string): Promise<void> {
    const key = controlTaskKey(scopeId, taskId);
    const prior = this.controlPersistenceTails.get(key) ?? Promise.resolve();
    const operation = prior
      .catch(() => undefined)
      .then(async () => {
        const pending = this.pendingControlReceipts.get(key);
        if (pending == null) return;
        const scope = parseScope(scopeId);
        for (const [invocationId, candidate] of [...pending]) {
          const current = pending.get(invocationId);
          if (current !== candidate) continue;
          const persisted = await this.runWithOwnerContext(scope, () =>
            this.methods.recordSubagentTaskControlReceipt({
              userId: scope.userId,
              conversationId: candidate.threadId,
              taskId,
              ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
              receipt: candidate.receipt,
            }),
          );
          if (persisted === 'conflict') {
            if (pending.get(invocationId) === candidate) pending.delete(invocationId);
            if (pending.size === 0) this.pendingControlReceipts.delete(key);
            throw new SubagentControlReceiptConflictError();
          }
          if (!persisted) {
            throw new Error('The child control receipt target is not ready.');
          }
          const invocation = this.retainedControlInvocation(scopeId, taskId, invocationId);
          if (invocation?.receipt === candidate.receipt) {
            invocation.receiptPersisted = true;
          }
          if (pending.get(invocationId) === candidate) {
            pending.delete(invocationId);
          }
        }
        if (pending.size === 0) {
          this.pendingControlReceipts.delete(key);
          const retry = this.controlPersistenceRetryTimers.get(key);
          if (retry != null) clearTimeout(retry);
          this.controlPersistenceRetryTimers.delete(key);
        }
      });
    this.controlPersistenceTails.set(key, operation);
    void operation.then(
      () => {
        if (this.controlPersistenceTails.get(key) === operation) {
          this.controlPersistenceTails.delete(key);
        }
        this.scheduleControlReceiptRetry(scopeId, taskId);
      },
      () => {
        if (this.controlPersistenceTails.get(key) === operation) {
          this.controlPersistenceTails.delete(key);
        }
        this.scheduleControlReceiptRetry(scopeId, taskId);
      },
    );
    return operation;
  }

  /** A terminal child may have no later caller to retrigger persistence. Keep a
   * single bounded retry timer per task so transient storage failures converge
   * even after result collection expires its in-memory task; restart durability
   * remains AI-1737. */
  private scheduleControlReceiptRetry(scopeId: string, taskId: string): void {
    const key = controlTaskKey(scopeId, taskId);
    if (
      this.controlPersistenceStopping ||
      this.controlPersistenceRetryTimers.has(key) ||
      !this.pendingControlReceipts.has(key)
    ) {
      return;
    }
    const timer = setTimeout(() => {
      this.controlPersistenceRetryTimers.delete(key);
      void this.flushControlReceipts(scopeId, taskId).catch((error) => {
        logger.warn('[subagentThreads] Failed to retry child control receipts', error);
      });
    }, this.controlReceiptRetryMs);
    this.controlPersistenceRetryTimers.set(key, timer);
  }

  private async flushControlReceiptsForSettlement(scopeId: string, taskId: string): Promise<void> {
    try {
      await this.flushControlReceipts(scopeId, taskId);
    } catch (error) {
      logger.warn('[subagentThreads] Failed to flush child control receipts', error);
    }
  }

  /** Enables optional cross-replica lookup after the host's Redis service is ready. */
  async configureTaskControlTransport(transport: SubagentTaskControlTransport): Promise<void> {
    if (this.taskControlTransport != null) {
      throw new Error('Subagent task control transport is already configured.');
    }
    await transport.bind({
      claim: (scopeId, taskId) => super.claim(scopeId, taskId),
      control: (scopeId, taskId, command, invocationId) =>
        this.controlInvocationAndPersist(scopeId, taskId, command, invocationId),
      list: (scopeId) => super.list(scopeId),
      cancelScope: (scopeId, threadIds, removedConversationIds = []) => {
        const cancelled = this.cancelForScope(scopeId, threadIds);
        if (removedConversationIds.length > 0) {
          const scope = parseScope(scopeId);
          this.dropDeletedControlReceiptWork(
            scope.userId,
            new Set(removedConversationIds),
            scope.tenantId,
          );
        }
        return cancelled;
      },
      retainsTaskOwnership: (scopeId, taskId) =>
        this.pendingControlReceipts.has(controlTaskKey(scopeId, taskId)),
    });
    this.taskControlTransport = transport;
  }

  async destroyTaskControlTransport(): Promise<void> {
    /** Close command admission and synchronously cancel every locally-owned child
     * before the first await. The SDK emits all pending-control transitions while
     * cancelling, so no receipt producer can race the final persistence snapshot. */
    this.controlCommandAdmissionClosed = true;
    const cancellationFlushes: Promise<void>[] = [];
    for (const lease of this.activeThreads.values()) {
      if (lease.taskId !== '' && this.get(lease.scopeId, lease.taskId)?.status === 'running') {
        const cancellation = super.control(lease.scopeId, lease.taskId, { action: 'cancel' });
        if (cancellation.status === 'cancelled') {
          /** The SDK hook above is synchronous, but retain direct promises for the
           * authoritative terminal snapshot as well. This makes shutdown await the
           * transition even when its first storage attempt fails under load. */
          const snapshot = cancellation.task as SnapshotWithControlReceipts;
          for (const receipt of snapshot.controlReceipts ?? []) {
            const persistence = this.queueAuthoritativeControlReceipt(
              lease.scopeId,
              lease.taskId,
              receipt,
            );
            if (persistence != null) cancellationFlushes.push(persistence);
          }
        }
      }
    }
    const childSettlements = [...this.activeThreads.values()]
      .map((lease) => lease.execution)
      .filter((execution): execution is Promise<void> => execution != null);
    let childSettlementTimedOut = false;
    if (childSettlements.length > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(childSettlements),
          new Promise<void>((_, reject) => {
            timeout = setTimeout(
              () => reject(new SubagentTaskOwnerUnavailableError()),
              this.ownerDrainTimeoutMs,
            );
          }),
        ]);
      } catch {
        childSettlementTimedOut = true;
      } finally {
        if (timeout != null) clearTimeout(timeout);
      }
    }
    this.controlPersistenceStopping = true;
    for (const timer of this.controlPersistenceRetryTimers.values()) clearTimeout(timer);
    this.controlPersistenceRetryTimers.clear();
    await Promise.allSettled(cancellationFlushes);
    /** Cancellation can enqueue its terminal transition behind an already-failing
     * acceptance write. Re-snapshot both maps after each round so work admitted
     * synchronously before shutdown cannot appear just after the final snapshot. */
    for (let attempt = 0; attempt < SHUTDOWN_CONTROL_RECEIPT_FLUSH_ATTEMPTS; attempt += 1) {
      const pendingTasks = [...this.pendingControlReceipts.keys()]
        .map(parseControlTaskKey)
        .filter((task): task is { scopeId: string; taskId: string } => task != null);
      await Promise.allSettled(
        pendingTasks.map(({ scopeId, taskId }) => this.flushControlReceipts(scopeId, taskId)),
      );
      await Promise.allSettled([...this.controlPersistenceTails.values()]);
      if (this.pendingControlReceipts.size === 0 && this.controlPersistenceTails.size === 0) {
        break;
      }
      if (attempt + 1 < SHUTDOWN_CONTROL_RECEIPT_FLUSH_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.shutdownControlReceiptBackoffMs * 2 ** attempt);
        });
      }
    }
    const transport = this.taskControlTransport;
    this.taskControlTransport = undefined;
    await transport?.destroy();
    if (
      childSettlementTimedOut ||
      this.pendingControlReceipts.size > 0 ||
      this.controlPersistenceTails.size > 0
    ) {
      throw new SubagentTaskOwnerUnavailableError();
    }
  }

  /** Replaces the process-local activity bus after the host's Redis service is ready. */
  configureActivityStream(stream: SubagentActivityStream): void {
    const previous = this.activityStream;
    this.activityStream = stream;
    previous.destroy();
  }

  destroyActivityStream(): void {
    this.activityStream.destroy();
  }

  prepareActivityForShutdown(): void {
    this.activityStream.prepareForShutdown();
  }

  subscribeActivity(
    threadId: string,
    taskId: string,
    subscriber: SubagentActivitySubscriber,
  ): SubagentActivitySubscription {
    return this.activityStream.subscribe(threadId, taskId, subscriber);
  }

  /** Publishes activity produced by a host-owned event child. Event children
   * use the same bounded, demand-aware transport as detached tool children,
   * but their generation lease is owned by the trigger controller instead of
   * this task store. */
  publishTaskActivity(threadId: string, taskId: string, event: SubagentUpdateEvent): Promise<void> {
    return this.activityStream.publish(threadId, taskId, boundSubagentActivityUpdate(event));
  }

  private publishActivity(
    lease: TaskThreadLease,
    threadId: string,
    taskId: string,
    event: SubagentUpdateEvent,
  ): void {
    if (
      lease.activityAdmissionClosed === true ||
      lease.activityCircuitOpen === true ||
      (lease.activityPending ?? 0) >= MAX_PENDING_ACTIVITY_EVENTS
    ) {
      return;
    }
    lease.activityPending = (lease.activityPending ?? 0) + 1;
    const boundedEvent = boundSubagentActivityUpdate(event);
    const publication = (lease.activityTail ?? Promise.resolve())
      .then(() => {
        if (lease.activityCircuitOpen === true) return;
        return settleActivityWithin(this.activityStream.publish(threadId, taskId, boundedEvent));
      })
      .catch((error) => {
        /** Any failed observational command opens the per-task circuit. Retrying every
         * token during an outage only creates command/log pressure; durable state remains. */
        lease.activityCircuitOpen = true;
        logger.warn('[subagentThreads] Failed to publish child activity', error);
      })
      .finally(() => {
        lease.activityPending = Math.max(0, (lease.activityPending ?? 1) - 1);
      });
    lease.activityTail = publication;
  }

  private completeActivity(
    lease: TaskThreadLease,
    threadId: string,
    taskId: string,
    status: SubagentActivityTerminalStatus,
  ): void {
    lease.activityAdmissionClosed = true;
    const terminal = (lease.activityTail ?? Promise.resolve())
      .then(() => settleActivityWithin(this.activityStream.complete(threadId, taskId, status)))
      .catch((error) => {
        logger.warn('[subagentThreads] Failed to close child activity stream', error);
      });
    lease.activityTail = terminal;
    void terminal.finally(() => {
      if (lease.activityTail === terminal) {
        lease.activityTail = undefined;
      }
    });
  }

  /** Gates child creation on the ordinary parent write without retaining request state. */
  registerParentPersistence(scopeId: string, persistence: Promise<unknown>): void {
    const scope = parseScope(scopeId);
    const gate = Promise.resolve(persistence).then((result) => {
      assertParentPersistence(result, scope);
      return result;
    });
    this.parentPersistence.set(scopeId, gate);
    void gate
      .then(() => {
        if (this.parentPersistence.get(scopeId) === gate) {
          this.parentPersistence.delete(scopeId);
        }
      })
      .catch(() => undefined);
  }

  override start(request: SubagentTaskStartRequest): SubagentTaskStartResult {
    if (request.subagentKind !== 'agent' && request.subagentKind !== 'graph') {
      throw new Error('Subagent task kind must be agent or graph.');
    }
    const scope = parseScope(request.scopeId);
    const parentReady = this.parentPersistence.get(request.scopeId);
    const requestedThreadId = request.threadId?.trim();
    const isContinuation = requestedThreadId != null && requestedThreadId !== '';
    const idempotencyKey = request.idempotencyKey.trim();
    const threadId = isContinuation
      ? requestedThreadId
      : createSubagentThreadId(request.scopeId, idempotencyKey);
    const lockKey = `${request.scopeId}\u0000${threadId}`;
    const active = this.activeThreads.get(lockKey);
    if (active != null && active.idempotencyKey !== idempotencyKey) {
      return { accepted: false, reason: 'capacity' };
    }

    const lease: TaskThreadLease = active ?? {
      scopeId: request.scopeId,
      idempotencyKey,
      taskId: '',
      running: false,
      settling: false,
    };
    const ownsLease = active == null;
    if (ownsLease) {
      this.activeThreads.set(lockKey, lease);
    }

    let started: SubagentTaskStartResult;
    try {
      started = super.start({
        ...request,
        threadId,
        run: (runtime: SubagentTaskRuntime) => {
          const execution = this.runWithOwnerContext(scope, async () => {
            lease.taskId = runtime.taskId;
            lease.running = true;
            const detachedUsage: UsageMetadata[] = [];
            let prepared: PreparedThread | undefined;
            let activityTerminal: SubagentActivityTerminalStatus = 'failed';
            try {
              if (runtime.signal.aborted) {
                throw runtime.signal.reason ?? new Error('Subagent task was cancelled.');
              }
              /** Publish the owner address before any provider work: a child running
               * while unaddressable cannot be polled, controlled, or cancelled, and its
               * side effects would already have happened by the time a heartbeat
               * republished it. A failed registration fails the task closed instead. */
              await this.taskControlTransport?.registerTask(
                request.scopeId,
                runtime.taskId,
                this.taskRoutingTtlMs,
              );
              await parentReady;
              prepared = await this.prepareThread(
                request.scopeId,
                scope,
                threadId,
                isContinuation,
                request,
                runtime.taskId,
                lease,
              );
              await this.registerTaskWakeup(scope, prepared.conversation.conversationId, request, {
                taskId: prepared.replay?.taskId ?? runtime.taskId,
                parentRunId: prepared.replay?.parentRunId ?? request.parentRunId,
                createdAt: prepared.taskCreatedAt,
              });
              if (prepared.replay != null) {
                this.notifyTaskSettled(
                  scope,
                  prepared.replay.taskId,
                  prepared.replay.previousTaskId,
                );
              }
              if (runtime.signal.aborted) {
                throw runtime.signal.reason ?? new Error('Subagent task was cancelled.');
              }
              if (prepared.replay != null) {
                if (prepared.replay.status === 'completed') {
                  return { content: prepared.replay.content };
                }
                throw new SubagentThreadPublicError(prepared.replay.content);
              }
              if (!(await this.renewSharedLease(scope, threadId, lease))) {
                throw new SubagentThreadPublicError(
                  'This child thread is already being continued by another run.',
                );
              }
              const preparedThread = prepared;
              let activitySequence = 0;
              const activityRuntime: SubagentTaskRuntime = {
                ...runtime,
                reportProgress: (event) => {
                  const sequence = activitySequence++;
                  const activityEvent: SubagentActivityUpdateEvent = {
                    ...event,
                    activityEventId: `${runtime.taskId}:${sequence}`,
                    activitySequence: sequence,
                  };
                  runtime.reportProgress(activityEvent);
                  this.publishActivity(
                    lease,
                    preparedThread.conversation.conversationId,
                    runtime.taskId,
                    activityEvent,
                  );
                },
              };
              const result = await runWithDetachedSubagentUsage(detachedUsage, () =>
                request.run(activityRuntime, preparedThread.initialMessages),
              );
              if (runtime.signal.aborted) {
                throw runtime.signal.reason ?? new Error('Subagent task was cancelled.');
              }
              if (!(await this.renewSharedLease(scope, threadId, lease))) {
                throw new SubagentThreadPublicError(
                  'This child thread is already being continued by another run.',
                );
              }
              lease.settling = true;
              await this.persistResult(
                scope,
                request,
                runtime.taskId,
                prepared,
                result,
                detachedUsage,
              );
              activityTerminal = 'completed';
              return result;
            } catch (error) {
              /** A replay is already terminal in Mongo. A temporary wakeup-queue
               * outage must not overwrite that canonical result with a new error. */
              if (prepared?.replay != null) {
                throw error;
              }
              const mayPersist =
                lease.shared == null || (await this.renewSharedLease(scope, threadId, lease));
              const terminalTask = this.get(request.scopeId, runtime.taskId);
              if (runtime.signal.aborted && terminalTask?.status === 'cancelled') {
                activityTerminal = 'cancelled';
                if (mayPersist) {
                  await this.persistCancellation(
                    scope,
                    threadId,
                    request,
                    runtime.taskId,
                    detachedUsage,
                  ).catch((persistError) => {
                    logger.error(
                      '[subagentThreads] Failed to persist child-thread cancellation',
                      persistError,
                    );
                  });
                }
                throw error;
              }
              logger.error('[subagentThreads] Child-thread execution failed', {
                detail: publicFailureDetail(error),
                errorName: error instanceof Error ? error.name : typeof error,
                ...(error instanceof Error && error.stack != null ? { stack: error.stack } : {}),
              });
              if (mayPersist) {
                await this.persistFailure(
                  scope,
                  threadId,
                  request,
                  runtime.taskId,
                  error,
                  detachedUsage,
                ).catch((persistError) => {
                  logger.error(
                    '[subagentThreads] Failed to persist child-thread failure',
                    persistError,
                  );
                });
              }
              throw new Error(publicFailureDetail(error));
            } finally {
              if (prepared != null) {
                this.wakeupTaskIds.delete(prepared.replay?.taskId ?? runtime.taskId);
              }
              if (prepared != null && prepared.replay == null) {
                this.completeActivity(
                  lease,
                  prepared.conversation.conversationId,
                  runtime.taskId,
                  activityTerminal,
                );
              }
              await this.stopAndReleaseSharedLease(scope, threadId, lease);
              if (this.activeThreads.get(lockKey) === lease) {
                this.activeThreads.delete(lockKey);
              }
            }
          });
          const settlement = execution.then(
            () => undefined,
            () => undefined,
          );
          lease.execution = settlement;
          return execution;
        },
      });
    } catch (error) {
      if (ownsLease && this.activeThreads.get(lockKey) === lease) {
        this.activeThreads.delete(lockKey);
      }
      throw error;
    }

    if (started.accepted && started.isNew) {
      lease.taskId = started.task.taskId;
    } else if (ownsLease && this.activeThreads.get(lockKey) === lease) {
      this.activeThreads.delete(lockKey);
    }
    return started;
  }

  /** Detached tasks intentionally outlive the HTTP request that admitted them.
   * Reconstruct only the trusted owner identity carried by the opaque task scope
   * so tenant-isolated database reads and lazy child initialization do not depend
   * on request AsyncLocalStorage remaining alive after the parent turn returns. */
  private runWithOwnerContext<T>(scope: SubagentThreadScope, run: () => Promise<T>): Promise<T> {
    return tenantStorage.run(
      {
        userId: scope.userId,
        ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
      },
      run,
    );
  }

  /**
   * Claims locally when possible, otherwise asks the registered owning replica.
   *
   * A child's terminal result is durable in its own thread, so collection is recorded
   * there against the polling invocation rather than kept alive in the owner's memory.
   * The invocation that lost a response re-acquires its own result on the next poll;
   * a different invocation is told the result was already collected. Owner-side
   * retention stays a fast path, free to expire, instead of the only copy.
   */
  async claimTask(
    scopeId: string,
    taskId: string,
    invocationId?: string,
  ): Promise<SubagentTaskClaim> {
    const local = super.claim(scopeId, taskId);
    const claim =
      local.status !== 'not_found'
        ? local
        : ((await this.taskControlTransport?.claim(scopeId, taskId)) ?? local);
    if (invocationId == null || claim.status === 'running') {
      return claim;
    }
    if (claim.status === 'not_found') {
      return this.claimDurableTaskResult(scopeId, taskId, invocationId);
    }
    const threadId = claim.task.threadId;
    if (threadId == null || threadId === '') {
      return claim;
    }
    /** The durable record decides who holds this one-shot result. The invocation that
     * already consumed it re-acquires and is handed it again, a second invocation is
     * told it was collected instead of being given a duplicate, and a task with no
     * durable record to arbitrate keeps whatever the owner just answered. */
    const collected = await this.assignResultClaim(
      parseScope(scopeId).userId,
      threadId,
      claim.task.taskId,
      invocationId,
    );
    if (collected.status === 'claimed') {
      return { status: 'claimed', task: claim.task };
    }
    if (collected.status === 'not_found') {
      return claim;
    }
    return claim.status === 'claimed' ? (recoveredClaim(collected.message, claim) ?? claim) : claim;
  }

  /**
   * Recovers a terminal task after its owning process and Redis registration are gone.
   * The task id locates only a candidate; durable child lineage re-establishes the
   * trusted parent scope before the one-shot result is claimed.
   */
  private async claimDurableTaskResult(
    scopeId: string,
    taskId: string,
    invocationId: string,
  ): Promise<SubagentTaskClaim> {
    const scope = parseScope(scopeId);
    let message: IMessage | undefined;
    try {
      [message] = await this.methods.getMessages(
        {
          user: scope.userId,
          messageId: `${taskId}:assistant`,
          'subagentTask.status': { $in: ['completed', 'error', 'cancelled'] },
        },
        DURABLE_RESULT_SELECT,
        { limit: 1, sort: false },
      );
    } catch (error) {
      logger.warn('[subagentThreads] Failed to locate a durable child result', error);
      throw new SubagentTaskOwnerUnavailableError();
    }
    const threadId = message?.conversationId;
    const status = message?.subagentTask?.status;
    if (
      message == null ||
      !isNonEmptyString(threadId) ||
      !isNonEmptyString(message.sender) ||
      (status !== 'completed' && status !== 'error' && status !== 'cancelled')
    ) {
      return { status: 'not_found' };
    }

    let parent: IConversation | null;
    let conversation: IConversation | null;
    try {
      [parent, conversation] = await Promise.all([
        this.methods.getConvo(scope.userId, scope.parentConversationId),
        this.methods.getConvo(scope.userId, threadId),
      ]);
    } catch (error) {
      logger.warn('[subagentThreads] Failed to verify durable child lineage', error);
      throw new SubagentTaskOwnerUnavailableError();
    }
    const lineage = conversation?.subagentThread;
    if (
      parent == null ||
      conversation == null ||
      lineage == null ||
      conversation.endpoint !== EModelEndpoint.agents ||
      lineage.parentConversationId !== scope.parentConversationId ||
      lineage.subagentType !== message.sender ||
      lineage.depth > this.maxThreadDepth ||
      !matchesTenant(parent.tenantId, scope.tenantId) ||
      !matchesTenant(conversation.tenantId, scope.tenantId)
    ) {
      return { status: 'not_found' };
    }

    const createdAt = message.createdAt?.getTime();
    const updatedAt = message.updatedAt?.getTime() ?? createdAt;
    if (createdAt == null || updatedAt == null) {
      return { status: 'not_found' };
    }
    const task: SubagentTaskSnapshot = {
      taskId,
      threadId,
      subagentType: lineage.subagentType,
      status,
      createdAt,
      updatedAt,
      resultAvailable: true,
      resultClaimed: true,
      pendingControls: 0,
      ...(status === 'completed' ? {} : { error: message.text ?? '' }),
    };
    const collected = await this.assignResultClaim(scope.userId, threadId, taskId, invocationId);
    if (collected.status === 'not_found') {
      return { status: 'not_found' };
    }
    if (collected.status === 'claimed') {
      return { status: 'claimed', task };
    }
    return (
      recoveredClaim(collected.message, { status: 'claimed', task }) ?? {
        status: 'not_found',
      }
    );
  }

  /**
   * Assigns one durable terminal result to the invocation collecting it. A failed
   * write is not an absent record: handing the result over without recording its
   * claimant would let another invocation acquire the same one-shot output once the
   * database recovers, so this reports the retryable path and leaves the result
   * unclaimed for a later poll.
   */
  private async assignResultClaim(
    userId: string,
    threadId: string,
    taskId: string,
    invocationId: string,
  ): Promise<SubagentTaskResultClaim> {
    try {
      return await this.methods.claimSubagentTaskResult({
        userId,
        conversationId: threadId,
        taskId,
        kind: 'manual',
        claimId: invocationId,
      });
    } catch (error) {
      logger.warn('[subagentThreads] Failed to record a collected child result', error);
      throw new SubagentTaskOwnerUnavailableError();
    }
  }

  /**
   * Controls locally when possible, otherwise asks the registered owning replica.
   * `invocationId` identifies one caller invocation: a routed retransmission of that
   * invocation replays the owner's result, while a fresh invocation applies again even
   * when its action and message are identical.
   */
  async controlTask(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string = randomUUID(),
  ): Promise<SubagentTaskControlResult> {
    /** A requester that has neither the task nor a retained invocation cannot be
     * authoritative. Route first so a remote control pays only the owner's durable
     * preflight instead of repeating the same Mongo read on both replicas. */
    const hasLocalAuthority =
      this.get(scopeId, taskId) != null ||
      this.retainedControlInvocation(scopeId, taskId, invocationId) != null;
    const local = hasLocalAuthority
      ? await this.controlInvocationAndPersist(scopeId, taskId, command, invocationId)
      : ({ status: 'not_found' } as const);
    if (local.status !== 'not_found') {
      return local;
    }
    let routed: SubagentTaskControlResult | undefined;
    try {
      routed = await this.taskControlTransport?.control(scopeId, taskId, command, invocationId);
    } catch (error) {
      if (error instanceof SubagentTaskOwnerUnavailableError) {
        const replay = await this.replayDurableControlAtBoundary(
          scopeId,
          taskId,
          command,
          invocationId,
        );
        if (replay != null) return replay;
      }
      throw error;
    }
    if (routed != null && routed.status !== 'not_found') return routed;
    return (
      (await this.replayDurableControlAtBoundary(scopeId, taskId, command, invocationId)) ??
      routed ??
      local
    );
  }

  /** Durable receipt reads are part of the owner boundary. Storage ambiguity must
   * remain retryable instead of escaping as an unrelated tool execution failure. */
  private async replayDurableControlAtBoundary(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult | undefined> {
    try {
      return await this.replayDurableControl(scopeId, taskId, command, invocationId);
    } catch (error) {
      if (error instanceof SubagentTaskOwnerUnavailableError) throw error;
      throw new SubagentTaskOwnerUnavailableError();
    }
  }

  private retainedControlInvocation(
    scopeId: string,
    taskId: string,
    invocationId: string,
  ): ControlInvocationRecord | undefined {
    const key = `${scopeId}\u0000${taskId}\u0000${invocationId}`;
    return this.controlInvocations.get(key) ?? this.terminalControlInvocations.get(key);
  }

  private async replayRetainedControl(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult | undefined> {
    const retained = this.retainedControlInvocation(scopeId, taskId, invocationId);
    if (retained == null) return undefined;
    if (retained.fingerprint !== controlFingerprint(command)) {
      return {
        status: 'invalid',
        message: 'This control invocation id was already used for a different command.',
      };
    }
    if (hasDurableControlReceipt(retained)) {
      /** Terminal materialization and one-shot collection can change after the
       * receipt becomes durable. Refresh those flags from the exact durable row so
       * same-owner replay agrees with replay after owner loss. */
      if ('task' in retained.result && retained.result.task.status !== 'running') {
        const current = this.get(scopeId, taskId);
        if (current != null) {
          retained.result = {
            ...retained.result,
            task: {
              ...retained.result.task,
              status: current.status,
              updatedAt: current.updatedAt,
              resultAvailable: current.resultAvailable,
              resultClaimed: current.resultClaimed,
            },
          };
        } else {
          const durable = await this.replayDurableControlAtBoundary(
            scopeId,
            taskId,
            command,
            invocationId,
          );
          if (durable != null) retained.result = durable;
        }
      }
      return retained.result;
    }
    let persistenceFailed = false;
    try {
      await (retained.receiptPersistence ?? this.flushControlReceipts(scopeId, taskId));
    } catch {
      persistenceFailed = true;
      // The durable replay below distinguishes a committed result or conflict
      // from a genuinely retryable storage failure.
    }
    if (hasDurableControlReceipt(retained)) return retained.result;
    if (persistenceFailed) {
      try {
        const retry = this.flushControlReceipts(scopeId, taskId);
        retained.receiptPersistence = retry;
        await retry;
      } catch {
        // Durable replay below remains the authoritative discriminator.
      }
    }
    try {
      const durable = await this.replayDurableControl(scopeId, taskId, command, invocationId);
      if (durable != null) {
        retained.result = durable;
        retained.receiptPersisted = true;
        retained.receiptPersistence = undefined;
        return durable;
      }
    } catch {
      // Normalize storage outages at the owner boundary.
    }
    throw new SubagentTaskOwnerUnavailableError();
  }

  private retainedControlResult(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): SubagentTaskControlResult | undefined {
    const retained = this.retainedControlInvocation(scopeId, taskId, invocationId);
    if (retained == null) return undefined;
    return retained.fingerprint === controlFingerprint(command)
      ? retained.result
      : {
          status: 'invalid',
          message: 'This control invocation id was already used for a different command.',
        };
  }

  /**
   * Applies one logical control exactly once for its owning task. Idempotency lives
   * here rather than in the transport so a local and a routed caller of the same
   * invocation agree, and it is keyed by task as well as invocation because provider
   * tool-call ids repeat across runs and agents.
   */
  controlInvocation(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): SubagentTaskControlResult {
    if (this.controlCommandAdmissionClosed) {
      return { status: 'invalid', message: 'Subagent task controls are shutting down.' };
    }
    const key = `${scopeId}\u0000${taskId}\u0000${invocationId}`;
    const fingerprint = controlFingerprint(command);
    const applied = this.retainedControlResult(scopeId, taskId, command, invocationId);
    if (applied != null) return applied;
    const localTask = this.get(scopeId, taskId);
    if (localTask == null) {
      /** Not this replica's task. Refusing here would keep the command from ever
       * reaching its owner, so local load cannot veto a remote cancellation: the
       * owner applies its own window to the routed request. */
      return this.control(scopeId, taskId, command);
    }
    if (localTask.status !== 'running') {
      const result = this.control(scopeId, taskId, command);
      if (result.status === 'not_found' || result.status === 'invalid') return result;
      if (this.terminalControlInvocations.size >= MAX_TERMINAL_CONTROL_INVOCATIONS) {
        const oldestPersisted = [...this.terminalControlInvocations].find(
          ([, invocation]) => invocation.receiptPersisted === true,
        )?.[0];
        if (oldestPersisted == null) {
          return {
            status: 'invalid',
            message:
              'Too many terminal control invocations are awaiting persistence; retry shortly.',
          };
        }
        this.terminalControlInvocations.delete(oldestPersisted);
      }
      this.terminalControlInvocations.set(key, {
        scopeId,
        taskId,
        invocationId,
        fingerprint,
        command: boundedControlCommand(command),
        commandMessageTruncated:
          'message' in command && command.message.length > MAX_DURABLE_CONTROL_MESSAGE_CHARS,
        result,
        createdAt: Date.now(),
      });
      return result;
    }
    if (!this.makeRoomForInvocation()) {
      /** Every tracked invocation belongs to a task this store still holds. Applying
       * this command without room to record it would let a caller retry apply it a
       * second time, so it is refused before the child is touched at all. */
      logger.warn('[subagentThreads] Refused a control; live invocation records are full');
      return {
        status: 'invalid',
        message: 'Too many control invocations are in flight for this process; retry shortly.',
      };
    }
    const result = this.control(scopeId, taskId, command);
    if (result.status === 'not_found' || result.status === 'invalid') {
      return result;
    }
    if (result.status !== 'accepted' && result.status !== 'cancelled') {
      return result;
    }
    const invocation: ControlInvocationRecord = {
      scopeId,
      taskId,
      invocationId,
      fingerprint,
      command: boundedControlCommand(command),
      commandMessageTruncated:
        'message' in command && command.message.length > MAX_DURABLE_CONTROL_MESSAGE_CHARS,
      result,
      createdAt: Date.now(),
    };
    this.controlInvocations.set(key, invocation);
    if (
      result.status === 'accepted' &&
      result.controlId != null &&
      (command.action === 'steer' || command.action === 'queue' || command.action === 'interrupt')
    ) {
      this.controlInvocationByReceipt.set(
        controlReceiptKey(scopeId, taskId, result.controlId),
        invocation,
      );
    }
    return result;
  }

  private async controlInvocationAndPersist(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult> {
    const retained = await this.replayRetainedControl(scopeId, taskId, command, invocationId);
    if (retained != null) return retained;
    try {
      const durable = await this.replayDurableControl(scopeId, taskId, command, invocationId);
      if (durable != null) return durable;
    } catch (error) {
      logger.warn('[subagentThreads] Failed to preflight a child control receipt', error);
      throw new SubagentTaskOwnerUnavailableError();
    }
    const localTask = this.get(scopeId, taskId);
    if (localTask?.status === 'running') {
      if (localTask.threadId == null || localTask.threadId === '') {
        throw new SubagentTaskOwnerUnavailableError();
      }
      const scope = parseScope(scopeId);
      const now = new Date();
      const reservation: ISubagentTaskControlReceipt = {
        invocationId,
        fingerprint: controlFingerprint(command),
        action: command.action,
        status: 'reserved',
        createdAt: now,
        updatedAt: now,
        ...boundedControlMessage(
          boundedControlCommand(command),
          'message' in command && command.message.length > MAX_DURABLE_CONTROL_MESSAGE_CHARS,
        ),
      };
      let reserved: boolean | 'unchanged' | 'conflict';
      try {
        reserved = (await this.controlReservationSlot(() =>
          this.runWithOwnerContext(scope, () =>
            this.methods.recordSubagentTaskControlReceipt({
              userId: scope.userId,
              conversationId: localTask.threadId as string,
              taskId,
              ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
              receipt: reservation,
            }),
          ),
        )) as boolean | 'unchanged' | 'conflict';
      } catch (error) {
        logger.warn('[subagentThreads] Failed to reserve a child control invocation', error);
        throw new SubagentTaskOwnerUnavailableError();
      }
      if (reserved === 'conflict') {
        return {
          status: 'invalid',
          message: 'This control invocation id was already used for a different command.',
        };
      }
      if (reserved === 'unchanged') {
        try {
          const replay = await this.replayDurableControl(scopeId, taskId, command, invocationId);
          if (replay != null) return replay;
        } catch {
          // Normalize storage ambiguity at the owner boundary below.
        }
        throw new SubagentTaskOwnerUnavailableError();
      }
      if (!reserved) throw new SubagentTaskOwnerUnavailableError();
    }
    const invocationKey = `${scopeId}\u0000${taskId}\u0000${invocationId}`;
    const result = this.controlInvocation(scopeId, taskId, command, invocationId);
    const retainedInvocation =
      this.controlInvocations.get(invocationKey) ??
      this.terminalControlInvocations.get(invocationKey);
    const invocation: ControlInvocationRecord | undefined =
      retainedInvocation ??
      (result.status === 'not_found' || result.status === 'invalid'
        ? undefined
        : {
            scopeId,
            taskId,
            invocationId,
            fingerprint: controlFingerprint(command),
            command: boundedControlCommand(command),
            commandMessageTruncated:
              'message' in command && command.message.length > MAX_DURABLE_CONTROL_MESSAGE_CHARS,
            result,
            createdAt: Date.now(),
          });
    const threadId = 'task' in result ? result.task.threadId : undefined;
    if (invocation == null || threadId == null) return result;
    const receipt = this.controlResultReceipt(invocation);
    let persistedReceipt: ISubagentTaskControlReceipt | undefined;
    let persistence: Promise<void> | undefined;
    try {
      if (receipt != null) {
        persistedReceipt = receipt;
        invocation.receipt = persistedReceipt;
        invocation.receiptPersisted = false;
        persistence = this.queueControlReceipt(scopeId, taskId, threadId, persistedReceipt);
        invocation.receiptPersistence = persistence;
        await persistence;
        /** A terminal SDK transition can replace the accepted projection while its
         * older write is awaiting Mongo. Mark only the exact generation awaited. */
        if (invocation.receipt === persistedReceipt) invocation.receiptPersisted = true;
        /** Do not acknowledge an older generation while a newer authoritative SDK
         * transition is still queued. There is no async gap after this loop, so the
         * generation proven durable is the one returned to the caller. */
        await this.awaitCurrentControlReceipt(scopeId, taskId, invocation);
      }
    } catch (error) {
      if (error instanceof SubagentControlReceiptConflictError) {
        const invalid: SubagentTaskControlResult = {
          status: 'invalid',
          message: 'This control invocation id was already used for a different command.',
        };
        invocation.result = invalid;
        invocation.receiptPersisted = true;
        if (result.status === 'accepted' && result.controlId != null) {
          this.controlInvocationByReceipt.delete(
            controlReceiptKey(scopeId, taskId, result.controlId),
          );
          super.control(scopeId, taskId, {
            action: 'cancel_message',
            controlId: result.controlId,
          });
        }
        return invalid;
      }
      logger.warn('[subagentThreads] Failed to durably accept a child control', error);
      throw new SubagentTaskOwnerUnavailableError();
    } finally {
      if (
        persistence != null &&
        persistedReceipt != null &&
        invocation.receiptPersistence === persistence &&
        invocation.receipt === persistedReceipt &&
        invocation.receiptPersisted === true
      ) {
        invocation.receiptPersistence = undefined;
      }
    }
    return invocation.result;
  }

  private async awaitCurrentControlReceipt(
    scopeId: string,
    taskId: string,
    invocation: ControlInvocationRecord,
  ): Promise<void> {
    while (invocation.receipt != null && invocation.receiptPersisted !== true) {
      const receipt = invocation.receipt;
      const persistence =
        invocation.receiptPersistence ?? this.flushControlReceipts(scopeId, taskId);
      invocation.receiptPersistence = persistence;
      await persistence;
      if (invocation.receipt === receipt && hasDurableControlReceipt(invocation)) return;
    }
  }

  /**
   * Frees invocation slots by dropping records whose task the store no longer holds:
   * a settled task cannot be controlled again, so its record is worthless, while a
   * live one is exactly what a caller retry needs to replay instead of applying its
   * command twice. The sweep runs only when the window is full and clears every dead
   * record at once, so it is amortized rather than repeated per control.
   */
  private makeRoomForInvocation(): boolean {
    if (this.controlInvocations.size < this.maxControlInvocations) {
      return true;
    }
    for (const [key, invocation] of this.controlInvocations) {
      if (this.get(invocation.scopeId, invocation.taskId) == null) {
        this.controlInvocations.delete(key);
        const result = invocation.result;
        if (result.status === 'accepted' && result.controlId != null) {
          this.controlInvocationByReceipt.delete(
            controlReceiptKey(invocation.scopeId, invocation.taskId, result.controlId),
          );
        }
      }
    }
    return this.controlInvocations.size < this.maxControlInvocations;
  }

  /** Returns this process's tasks plus tasks reported by registered remote owners. */
  async listTasks(scopeId: string): Promise<SubagentTaskSnapshot[]> {
    const local = super.list(scopeId);
    const remote = (await this.taskControlTransport?.list(scopeId)) ?? [];
    const byId = new Map(local.map((task) => [task.taskId, task]));
    for (const task of remote) {
      byId.set(task.taskId, task);
    }
    /** The remote aggregation and each owner's reply carry their own bound, but this
     * merge is what the poll tool reads: without a cap here the list the model sees is
     * that bound plus however many children this replica happens to own. */
    return boundedTaskList([...byId.values()]);
  }

  /** Fast capability probe used while deciding whether a later turn needs the poll tool. */
  async hasTasks(scopeId: string): Promise<boolean> {
    if (super.list(scopeId).length > 0) {
      return true;
    }
    return (await this.taskControlTransport?.hasTasks(scopeId)) ?? false;
  }

  override control(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
  ): SubagentTaskControlResult {
    const snapshot = this.get(scopeId, taskId);
    const lockKey = snapshot?.threadId == null ? undefined : `${scopeId}\u0000${snapshot.threadId}`;
    const lease = lockKey == null ? undefined : this.activeThreads.get(lockKey);
    if (snapshot != null && lease?.taskId === taskId && lease.settling) {
      return { status: 'not_running', task: snapshot };
    }
    const result = super.control(scopeId, taskId, command);
    if (
      command.action === 'cancel' &&
      result.status === 'cancelled' &&
      lockKey != null &&
      lease?.taskId === taskId &&
      !lease.running
    ) {
      this.activeThreads.delete(lockKey);
    }
    return result;
  }

  /** Finds a provisional child lease before its conversation is durable. */
  isThreadActiveForOwner(userId: string, threadId: string, tenantId?: string): boolean {
    const suffix = `\u0000${threadId}`;
    for (const lockKey of this.activeThreads.keys()) {
      if (!lockKey.endsWith(suffix)) {
        continue;
      }
      const scope = parseScope(lockKey.slice(0, -suffix.length));
      if (scope.userId === userId && matchesTenant(scope.tenantId, tenantId)) {
        return true;
      }
    }
    return false;
  }

  /** Cancels active descendants before their owning conversations are removed. */
  cancelForConversations(
    userId: string,
    conversationIds: Iterable<string>,
    tenantId?: string,
  ): number {
    const targets = new Set(conversationIds);
    return this.cancelMatchingThreads(
      (scope, threadId) =>
        scope.userId === userId &&
        matchesTenant(scope.tenantId, tenantId) &&
        (targets.has(scope.parentConversationId) || targets.has(threadId)),
    );
  }

  /**
   * Resolves every cancellation target while the conversations still exist. The plan is
   * replayed after deletion, when those rows can no longer be read back, so the second
   * pass only has to reach registered owners through Redis.
   */
  async planCancellationForConversations(
    userId: string,
    conversationIds: Iterable<string>,
    tenantId?: string,
  ): Promise<SubagentCancellationPlan> {
    const targetIds = [...new Set(conversationIds)];
    const plan: SubagentCancellationPlan = {
      userId,
      ...(tenantId == null ? {} : { tenantId }),
      conversationIds: targetIds,
      scopes: [],
      leases: [],
    };
    if (targetIds.length === 0 || this.taskControlTransport == null) {
      return plan;
    }
    const targets = new Set(targetIds);
    const scopeIdFor = (parentConversationId: string): string =>
      serializeScope({
        userId,
        parentConversationId,
        ...(tenantId ? { tenantId } : {}),
      });
    /** Deleting a conversation takes its whole scope; a deleted child only cancels its
     * own thread inside a parent scope that survives. */
    const conversations = await Promise.all(
      targetIds.map((conversationId) => this.methods.getConvo(userId, conversationId)),
    );
    const threadTargetsByParent = new Map<string, Set<string>>();
    for (const [index, conversation] of conversations.entries()) {
      const parentConversationId = conversation?.subagentThread?.parentConversationId;
      if (
        parentConversationId == null ||
        targets.has(parentConversationId) ||
        !matchesTenant(conversation?.tenantId, tenantId)
      ) {
        continue;
      }
      const threadIds = threadTargetsByParent.get(parentConversationId) ?? new Set<string>();
      threadIds.add(targetIds[index]);
      threadTargetsByParent.set(parentConversationId, threadIds);
    }
    plan.scopes = [
      ...targetIds.map((parentConversationId) => ({
        scopeId: scopeIdFor(parentConversationId),
        threadIds: null,
      })),
      ...[...threadTargetsByParent].map(([parentConversationId, threadIds]) => ({
        scopeId: scopeIdFor(parentConversationId),
        threadIds: [...threadIds],
      })),
    ];
    /** Captured now so descendants removed by the cascade stay reachable afterwards. */
    plan.leases = await this.methods.listActiveSubagentThreadLeases({
      user: userId,
      now: new Date(),
      ...(tenantId == null ? {} : { tenantId }),
    });
    return plan;
  }

  /**
   * Cancels local children and replays a plan against registered remote owners.
   * `removedConversationIds` extends it with the cascade a deletion reported, matched
   * against leases captured before those rows were removed.
   */
  async cancelPlan(
    plan: SubagentCancellationPlan,
    removedConversationIds: Iterable<string> = [],
  ): Promise<number> {
    const { userId, tenantId } = plan;
    const planned = new Set(plan.conversationIds);
    const removed = new Set(removedConversationIds);
    /** A cascade can remove descendants the plan never named — a grandchild lives in
     * its own parent's scope, not the deleted root's — so every removed conversation
     * is cancelled as a scope of its own. */
    const targets = [...new Set([...planned, ...removed])];
    let cancelled = this.cancelForConversations(userId, targets, tenantId);
    const transport = this.taskControlTransport;
    if (transport == null) {
      if (removed.size > 0) {
        this.dropDeletedControlReceiptWork(userId, removed, tenantId);
      }
      return cancelled;
    }
    const cancelSlot = createConcurrencyLimiter(DELETION_CANCEL_CONCURRENCY);
    const cascadeScopes = [...removed]
      .filter((conversationId) => !planned.has(conversationId))
      .map((parentConversationId) => ({
        scopeId: serializeScope({
          userId,
          parentConversationId,
          ...(tenantId ? { tenantId } : {}),
        }),
        threadIds: null,
      }));
    const scopeCancellations = [...plan.scopes, ...cascadeScopes].map((scope) => {
      const parsed = parseScope(scope.scopeId);
      const removedForScope = [
        ...(removed.has(parsed.parentConversationId) ? [parsed.parentConversationId] : []),
        ...(scope.threadIds ?? []).filter((threadId) => removed.has(threadId)),
      ];
      return cancelSlot(() =>
        transport.cancelScope(scope.scopeId, scope.threadIds, removedForScope),
      );
    });
    const leaseCancellations = plan.leases
      .filter(
        (lease) => removed.has(lease.parentConversationId) || removed.has(lease.conversationId),
      )
      .map((lease) =>
        cancelSlot(async () => {
          const scopeId = serializeScope({
            userId,
            parentConversationId: lease.parentConversationId,
            ...(tenantId ? { tenantId } : {}),
          });
          const removedForLease = [lease.parentConversationId, lease.conversationId].filter((id) =>
            removed.has(id),
          );
          const stopped = await transport.cancelScope(
            scopeId,
            [lease.conversationId],
            removedForLease,
          );
          if (stopped > 0 || this.cancelUnroutedTask == null) return stopped;
          return (await this.cancelUnroutedTask({
            userId,
            parentConversationId: lease.parentConversationId,
            taskId: lease.taskId,
            ...(tenantId ? { tenantId } : {}),
          }))
            ? 1
            : 0;
        }),
      );
    try {
      for (const count of await Promise.all(scopeCancellations)) {
        cancelled += count;
      }
      for (const count of await Promise.all(leaseCancellations)) {
        cancelled += count;
      }
      return cancelled;
    } finally {
      /** Delivery may fail after the deletion committed. Receipt persistence for
       * removed rows is still terminal and must not poison graceful shutdown. */
      if (removed.size > 0) {
        this.dropDeletedControlReceiptWork(userId, removed, tenantId);
      }
    }
  }

  /** A successful deletion makes false receipt writes permanent, not retryable.
   * Remove only work whose authorized parent or child was actually deleted. */
  private dropDeletedControlReceiptWork(
    userId: string,
    removedConversationIds: ReadonlySet<string>,
    tenantId?: string,
  ): void {
    const matchesDeletedScope = (scopeId: string): boolean => {
      const scope = parseScope(scopeId);
      return (
        scope.userId === userId &&
        matchesTenant(scope.tenantId, tenantId) &&
        removedConversationIds.has(scope.parentConversationId)
      );
    };
    for (const [key, pending] of this.pendingControlReceipts) {
      const task = parseControlTaskKey(key);
      if (task == null) continue;
      const deleteWholeTask = matchesDeletedScope(task.scopeId);
      for (const [invocationId, candidate] of pending) {
        if (deleteWholeTask || removedConversationIds.has(candidate.threadId)) {
          pending.delete(invocationId);
        }
      }
      if (pending.size === 0) {
        this.pendingControlReceipts.delete(key);
        const retry = this.controlPersistenceRetryTimers.get(key);
        if (retry != null) clearTimeout(retry);
        this.controlPersistenceRetryTimers.delete(key);
      }
    }
    const dropInvocation = (key: string, invocation: ControlInvocationRecord): void => {
      const resultThreadId =
        'task' in invocation.result ? invocation.result.task.threadId : undefined;
      if (
        !matchesDeletedScope(invocation.scopeId) &&
        (resultThreadId == null || !removedConversationIds.has(resultThreadId))
      ) {
        return;
      }
      this.controlInvocations.delete(key);
      this.terminalControlInvocations.delete(key);
      if (invocation.result.status === 'accepted' && invocation.result.controlId != null) {
        this.controlInvocationByReceipt.delete(
          controlReceiptKey(invocation.scopeId, invocation.taskId, invocation.result.controlId),
        );
      }
    };
    for (const [key, invocation] of this.controlInvocations) dropInvocation(key, invocation);
    for (const [key, invocation] of this.terminalControlInvocations)
      dropInvocation(key, invocation);
  }

  /** Cancels this process's live children for one scope, optionally narrowed to threads. */
  private cancelForScope(scopeId: string, threadIds: string[] | null): number {
    const scope = parseScope(scopeId);
    const targets = threadIds == null ? null : new Set(threadIds);
    return this.cancelMatchingThreads(
      (candidate, threadId) =>
        candidate.userId === scope.userId &&
        candidate.parentConversationId === scope.parentConversationId &&
        matchesTenant(candidate.tenantId, scope.tenantId) &&
        (targets == null || targets.has(threadId)),
    );
  }

  /** Cancels every active child owned by a user before a delete-all operation. */
  cancelForOwner(userId: string, tenantId?: string): number {
    return this.cancelMatchingThreads(
      (scope) => scope.userId === userId && matchesTenant(scope.tenantId, tenantId),
    );
  }

  /**
   * Deletes an owner's conversations behind a durable admission fence. Draining alone
   * cannot close the race: a child admitted on another replica after the drain read
   * its leases would begin provider work against a parent that is about to disappear.
   * Fencing first inverts that — the fence is written before any lease is read, and a
   * child validates the fence after its own lease is written, so one of the two always
   * observes the other. The fence expires by itself, so a process lost mid-deletion
   * cannot leave the account unable to run subagents.
   */
  async withOwnerDeletionFence<T>(
    userId: string,
    tenantId: string | undefined,
    deletion: () => Promise<T>,
    recoverAdditionalOwnerWork?: () => Promise<void>,
  ): Promise<T> {
    const fenceWindowMs = this.ownerDrainTimeoutMs + this.ownerFenceGraceMs;
    const token = randomUUID();
    /** Only a confirmed write moves this, so a run of failed renewals leaves it in the
     * past and the deletion can tell that its fence is no longer guaranteed. */
    let fencedUntil = Date.now() + fenceWindowMs;
    let fenceLapsed = false;
    await this.fenceOwnerAdmission?.(userId, token, new Date(fencedUntil));
    /** A very large account, or a stalled database, can outlast one fence window, and
     * a fence that expires mid-deletion lets another replica admit a child against
     * conversations being deleted. It is renewed for as long as the work runs. */
    let releasing = false;
    let inFlight: Promise<void> | undefined;
    const renewal = setInterval(
      () => {
        if (inFlight != null) {
          return;
        }
        inFlight = (async () => {
          const deadline = fencedUntil;
          const renewedUntil = Date.now() + fenceWindowMs;
          const held = await this.renewOwnerAdmission?.(userId, token, new Date(renewedUntil));
          if (held === false) {
            /** The durable entry was absent, so admission may already have opened even
             * when the local deadline has not passed. Reacquire for containment, but
             * retain the lapse so the enclosing deletion re-drains before success. */
            fenceLapsed = true;
            if (releasing) {
              return;
            }
            /** The entry is gone — expired, or pruned by another deletion — so this
             * deletion takes its fence again rather than running on unfenced. */
            await this.fenceOwnerAdmission?.(userId, token, new Date(renewedUntil));
          }
          if (Date.now() >= deadline) {
            /** The write only landed after the deadline it was meant to extend, so
             * admission stood open in between and a child could have taken a lease the
             * drain had already read past. A fence cannot be restored backwards over
             * that gap, so the lapse is recorded rather than papered over. */
            fenceLapsed = true;
            return;
          }
          fencedUntil = renewedUntil;
        })()
          .catch((error) => {
            logger.warn('[subagentThreads] Failed to hold the owner admission fence', error);
          })
          .finally(() => {
            inFlight = undefined;
          });
      },
      Math.max(1, Math.floor(fenceWindowMs / 3)),
    );
    renewal.unref?.();
    const stopRenewal = async (): Promise<void> => {
      clearInterval(renewal);
      await inFlight;
    };
    const fenceHeld = (): boolean =>
      this.fenceOwnerAdmission == null || (!fenceLapsed && Date.now() < fencedUntil);
    try {
      await this.cancelAndDrainForOwner(userId, tenantId);
      /** The drain can outlast the fence window when the database is unreachable, and
       * renewals that keep failing leave the account open to admitting a child against
       * conversations about to disappear. Nothing has been removed yet, so this fails
       * closed and the caller retries once the fence can be held again. */
      if (!fenceHeld()) {
        throw new Error('The subagent admission fence expired before this deletion began.');
      }
      const deleted = await deletion();
      /** Settle a renewal already in flight before deciding whether deletion crossed a
       * gap. Otherwise a late write can report the lapse only after this check and the
       * finally block would release the fence without re-draining. */
      await stopRenewal();
      if (!fenceHeld()) {
        /** The rows are gone, but the gap can leave a child another replica admitted
         * while the fence was down. Re-take the fence and drain that work before this
         * operation may report success. */
        logger.error(
          '[subagentThreads] Owner deletion outlived its admission fence; draining children admitted in the gap',
        );
        const recoveryUntil = Date.now() + fenceWindowMs;
        const reheld = await this.renewOwnerAdmission?.(userId, token, new Date(recoveryUntil));
        if (reheld !== true) {
          await this.fenceOwnerAdmission?.(userId, token, new Date(recoveryUntil));
        }
        if (Date.now() >= recoveryUntil) {
          throw new Error('The subagent admission fence expired while it was being restored.');
        }
        fencedUntil = recoveryUntil;
        fenceLapsed = false;
        await this.cancelAndDrainForOwner(userId, tenantId);
        /** The fence is shared by host-owned execution classes that do not use the
         * subagent lease store. Let the caller re-drain those classes after the same
         * lapse, while the restored fence still prevents fresh admission. */
        await recoverAdditionalOwnerWork?.();
        if (!fenceHeld()) {
          throw new Error('The subagent admission fence expired while recovering this deletion.');
        }
      }
      return deleted;
    } finally {
      releasing = true;
      await stopRenewal();
      /** `clearInterval` stops only future passes. A renewal still waiting on the
       * database would otherwise find its fence released, read that as expiry, and
       * write a fresh one that nothing is left to lift. */
      /** Only this deletion's own fence is lifted: an overlapping deletion that took a
       * later one keeps admission closed until it finishes. */
      await this.releaseOwnerAdmission?.(userId, token).catch((error) => {
        logger.warn('[subagentThreads] Failed to release the owner admission fence', error);
      });
    }
  }

  /**
   * Cancels local work and waits for every replica's durable lease to drain. Each task
   * is cancelled under one invocation held for the whole drain and only while its
   * owner has not answered: a fresh invocation per poll would retain a replay entry on
   * the owner for every pass, and a task already reported cancelled needs no second
   * command, only its lease to disappear.
   */
  async cancelAndDrainForOwner(userId: string, tenantId?: string): Promise<void> {
    this.cancelForOwner(userId, tenantId);
    const deadline = Date.now() + this.ownerDrainTimeoutMs;
    const invocations = new Map<string, string>();
    const answered = new Set<string>();
    while (true) {
      const activeLeases = await this.methods.listActiveSubagentThreadLeases({
        user: userId,
        now: new Date(),
        ...(tenantId == null ? {} : { tenantId }),
      });
      if (activeLeases.length === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out draining detached subagent tasks for account deletion.');
      }
      const unanswered = activeLeases.filter(
        ({ parentConversationId, taskId }) => !answered.has(drainKey(parentConversationId, taskId)),
      );
      for (let index = 0; index < unanswered.length; index += DELETION_CANCEL_CONCURRENCY) {
        await Promise.all(
          unanswered
            .slice(index, index + DELETION_CANCEL_CONCURRENCY)
            .map(({ parentConversationId, taskId }) =>
              this.cancelDrainedTask(
                { userId, parentConversationId, taskId, tenantId },
                invocations,
                answered,
              ),
            ),
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.ownerDrainPollMs));
    }
  }

  /** Sends one drained task's cancellation, retrying only unconfirmed deliveries. */
  private async cancelDrainedTask(
    target: { userId: string; parentConversationId: string; taskId: string; tenantId?: string },
    invocations: Map<string, string>,
    answered: Set<string>,
  ): Promise<void> {
    const { userId, parentConversationId, taskId, tenantId } = target;
    const key = drainKey(parentConversationId, taskId);
    const invocationId = invocations.get(key) ?? randomUUID();
    invocations.set(key, invocationId);
    const scopeId = serializeScope({
      userId,
      parentConversationId,
      ...(tenantId == null ? {} : { tenantId }),
    });
    try {
      const result = await this.controlTask(scopeId, taskId, { action: 'cancel' }, invocationId);
      /** Only the owner confirming the task is stopped ends the commands for it. A
       * `not_found` means its registration is missing while its lease is still live —
       * an unconfirmed delivery, retried once the owner republishes itself. */
      if (result.status === 'cancelled' || result.status === 'not_running') {
        answered.add(key);
      } else if (result.status === 'not_found' && this.cancelUnroutedTask != null) {
        const stopped = await this.cancelUnroutedTask(target);
        if (stopped) {
          answered.add(key);
        }
      }
    } catch (error) {
      logger.warn('[subagentThreads] Retrying an unconfirmed child cancellation', error);
    }
  }

  private startSharedLeaseHeartbeat(
    scopeId: string,
    scope: SubagentThreadScope,
    threadId: string,
    lease: TaskThreadLease,
  ): void {
    const shared = lease.shared;
    if (shared == null) {
      return;
    }
    const heartbeat = () => {
      if (shared.lost || shared.heartbeatInFlight != null) {
        return;
      }
      const renewal = (async () => {
        let ownerActive = false;
        try {
          ownerActive = await this.isOwnerActive(scope.userId);
        } catch (error) {
          logger.warn('[subagentThreads] Failed to verify the child-thread owner', error);
        }
        if (!ownerActive) {
          const task = this.get(scopeId, lease.taskId);
          if (task?.status === 'running') {
            super.control(scopeId, lease.taskId, { action: 'cancel' });
          }
        }
        if (!(await this.renewSharedLeaseFence(scope, threadId, lease))) {
          const task = this.get(scopeId, lease.taskId);
          if (task?.status === 'running') {
            super.control(scopeId, lease.taskId, { action: 'cancel' });
          }
        }
      })().finally(() => {
        if (shared.heartbeatInFlight === renewal) {
          shared.heartbeatInFlight = undefined;
        }
      });
      shared.heartbeatInFlight = renewal;
    };
    shared.heartbeat = setInterval(heartbeat, this.leaseHeartbeatMs);
  }

  private async renewSharedLease(
    scope: SubagentThreadScope,
    threadId: string,
    lease: TaskThreadLease,
  ): Promise<boolean> {
    const shared = lease.shared;
    if (shared == null || shared.lost) {
      return false;
    }
    try {
      if (!(await this.isOwnerActive(scope.userId))) {
        return false;
      }
      return this.renewSharedLeaseFence(scope, threadId, lease);
    } catch (error) {
      logger.warn('[subagentThreads] Failed to verify the child-thread owner', error);
      return false;
    }
  }

  private async renewSharedLeaseFence(
    scope: SubagentThreadScope,
    threadId: string,
    lease: TaskThreadLease,
  ): Promise<boolean> {
    const shared = lease.shared;
    if (shared == null || shared.lost) {
      return false;
    }
    try {
      const deadline = shared.expiresAt;
      const now = new Date();
      const renewedUntil = now.getTime() + this.leaseTtlMs;
      const renewed = await this.methods.renewSubagentThreadLease({
        user: scope.userId,
        conversationId: threadId,
        token: shared.token,
        now,
        expiresAt: new Date(renewedUntil),
        ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
      });
      if (!renewed) {
        shared.lost = true;
        return false;
      }
      if (Date.now() >= deadline) {
        /** The renewal filter compares against the `now` captured before the call, so a
         * write that only lands after this lease had expired still succeeds and moves
         * the row forward. An owner drain reading active leases in that gap saw this
         * thread as free, so the executor stops rather than run past a deletion that
         * may already have stepped over it. */
        shared.lost = true;
        return false;
      }
      shared.expiresAt = renewedUntil;
      return true;
    } catch (error) {
      shared.lost = true;
      logger.warn('[subagentThreads] Lost the shared child-thread lease', error);
      return false;
    }
  }

  private async stopAndReleaseSharedLease(
    scope: SubagentThreadScope,
    threadId: string,
    lease: TaskThreadLease,
  ): Promise<void> {
    const shared = lease.shared;
    if (shared == null) {
      return;
    }
    if (shared.heartbeat != null) {
      clearInterval(shared.heartbeat);
    }
    await shared.heartbeatInFlight;
    try {
      await this.methods.releaseSubagentThreadLease({
        user: scope.userId,
        conversationId: threadId,
        token: shared.token,
        ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
      });
    } catch (error) {
      logger.warn('[subagentThreads] Failed to release the shared child-thread lease', error);
    }
  }

  /** Whether a durable child may be created below the supplied conversation depth. */
  canCreateChildThread(parentDepth: number): boolean {
    return (
      Number.isSafeInteger(parentDepth) && parentDepth >= 0 && parentDepth < this.maxThreadDepth
    );
  }

  private async prepareThread(
    scopeId: string,
    scope: SubagentThreadScope,
    threadId: string,
    isContinuation: boolean,
    request: SubagentTaskStartRequest,
    taskId: string,
    lease: TaskThreadLease,
  ): Promise<PreparedThread> {
    if (!(await this.isOwnerActive(scope.userId))) {
      throw new SubagentThreadPublicError('The thread owner is unavailable.');
    }
    const [parent, existing] = await Promise.all([
      this.methods.getConvo(scope.userId, scope.parentConversationId),
      this.methods.getConvo(scope.userId, threadId),
    ]);
    if (parent == null || !matchesTenant(parent.tenantId, scope.tenantId)) {
      throw new SubagentThreadPublicError('Parent thread is unavailable.');
    }

    let createdThread = false;
    let sharedLeaseAcquired = false;
    try {
      let conversation = existing;
      if (conversation == null && isContinuation) {
        throw new SubagentThreadPublicError(
          'Child thread is unavailable for this subagent and parent scope.',
        );
      }
      if (conversation == null) {
        const parentDepth = parent.subagentThread?.depth ?? 0;
        if (!this.canCreateChildThread(parentDepth)) {
          throw new SubagentThreadPublicError(
            `Subagent thread depth exceeds the configured limit of ${this.maxThreadDepth}.`,
          );
        }
        const depth = parentDepth + 1;
        const agentId = childAgentId(request);
        const reserved = await this.methods.reserveSubagentThread({
          user: scope.userId,
          conversationId: threadId,
          ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
          conversation: {
            conversationId: threadId,
            endpoint: EModelEndpoint.agents,
            title: `Subagent: ${request.subagentType}`.slice(0, 120),
            ...(agentId == null ? {} : { agent_id: agentId }),
            ...retentionFields(parent),
            subagentThread: {
              rootConversationId:
                parent.subagentThread?.rootConversationId ?? scope.parentConversationId,
              parentConversationId: scope.parentConversationId,
              parentMessageId: request.parentRunId || request.parentToolCallId,
              parentToolCallId: request.parentToolCallId,
              ...(request.parentAgentId == null ? {} : { parentAgentId: request.parentAgentId }),
              subagentType: request.subagentType,
              subagentKind: request.subagentKind as 'agent' | 'graph',
              depth,
            },
          },
        });
        conversation = reserved.conversation;
        createdThread = reserved.created;
      }

      this.assertContinuation(scope, request, conversation);
      const sharedToken = randomUUID();
      const now = new Date();
      sharedLeaseAcquired = await this.methods.acquireSubagentThreadLease({
        user: scope.userId,
        conversationId: threadId,
        token: sharedToken,
        taskId,
        now,
        expiresAt: new Date(now.getTime() + this.leaseTtlMs),
        ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
      });
      if (!sharedLeaseAcquired) {
        throw new SubagentThreadPublicError(
          'This child thread is already being continued by another run.',
        );
      }
      lease.shared = {
        token: sharedToken,
        lost: false,
        expiresAt: now.getTime() + this.leaseTtlMs,
      };
      /** A detached child has no request or stream handle after its parent returns.
       * Keep the lease heartbeat referenced until settlement so Node cannot retire
       * the execution context while its provider promise is still pending. */
      this.startSharedLeaseHeartbeat(scopeId, scope, threadId, lease);
      /** Account deletion can fence the owner after the optimistic probe but before
       * this lease exists. Once the lease is visible, revalidate so deletion either
       * observes and drains us or wins before any provider work can begin. */
      logger.debug('[subagentThreads] Child-thread preparation entered stage', {
        stage: 'owner_recheck',
        taskId,
        threadId,
      });
      if (
        !(await observeSlowPreparation(this.isOwnerActive(scope.userId), {
          stage: 'owner_recheck',
          taskId,
          threadId,
        }))
      ) {
        throw new SubagentThreadDeletedError('The thread owner is unavailable.');
      }
      logger.debug('[subagentThreads] Child-thread preparation entered stage', {
        stage: 'transcript_read',
        taskId,
        threadId,
      });
      const allMessages = (await observeSlowPreparation(
        this.methods.getMessages(
          { conversationId: threadId, user: scope.userId },
          TRANSCRIPT_SELECT,
          { sort: { createdAt: 1, _id: 1 } },
        ),
        { stage: 'transcript_read', taskId, threadId },
      )) as ThreadMessage[];
      const attemptKey = createSubagentAttemptKey(scopeId, request.idempotencyKey);
      const requestFingerprint = normalizedRequestFingerprint(request);
      const priorAttempt = allMessages.filter(
        (message) => message.subagentTask?.attemptKey === attemptKey,
      );
      if (priorAttempt.length > 0) {
        if (
          priorAttempt.some(
            (message) => message.subagentTask?.requestFingerprint !== requestFingerprint,
          )
        ) {
          throw new SubagentThreadPublicError(
            'The same parent tool call was already used with different subagent arguments.',
          );
        }
        const terminal = [...priorAttempt]
          .reverse()
          .find((message) => message.subagentTask?.status !== 'running');
        if (terminal?.subagentTask != null) {
          const canonicalTaskId = terminal.messageId.endsWith(':assistant')
            ? terminal.messageId.slice(0, -':assistant'.length)
            : '';
          if (canonicalTaskId === '') {
            throw new Error('The prior subagent result has an invalid task identity.');
          }
          const canonicalStart = priorAttempt.find(
            (message) => message.messageId === `${canonicalTaskId}:user`,
          );
          const taskCreatedAt = durableMessageTime(
            canonicalStart ?? terminal,
            'The prior subagent result has no durable occurrence time.',
          );
          return {
            conversation,
            initialMessages: [],
            initialStoredMessages: [],
            attemptKey,
            taskCreatedAt,
            replay: {
              status: terminal.subagentTask.status as 'completed' | 'error' | 'cancelled',
              taskId: canonicalTaskId,
              ...(terminal.parentMessageId?.endsWith(':user') === true &&
                terminal.parentMessageId !== `${canonicalTaskId}:user` && {
                  previousTaskId: terminal.parentMessageId.slice(0, -':user'.length),
                }),
              parentRunId: terminal.subagentTask.parentRunId ?? request.parentRunId,
              content:
                terminal.text ??
                (terminal.subagentTask.status === 'completed'
                  ? 'Subagent task completed.'
                  : 'The prior subagent task did not complete successfully.'),
            },
          };
        }
        /** Reaching this point while holding the thread lease proves the original
         * worker no longer owns settlement. Close the abandoned attempt once rather
         * than either re-billing it or leaving every retry permanently "running". */
        const abandoned = priorAttempt[priorAttempt.length - 1];
        const abandonedMessage =
          'Subagent task failed: The prior execution ended before its result could be persisted.';
        const savedAbandoned = await this.methods.saveMessage(
          { userId: scope.userId, ...retentionContext(conversation) },
          {
            messageId: `${taskId}:assistant`,
            conversationId: threadId,
            parentMessageId: abandoned.messageId,
            sender: request.subagentType,
            text: abandonedMessage,
            endpoint: EModelEndpoint.agents,
            isCreatedByUser: false,
            unfinished: false,
            error: true,
            subagentTask: {
              attemptKey,
              parentRunId: request.parentRunId,
              ...(requestFingerprint == null ? {} : { requestFingerprint }),
              status: 'error',
            },
            ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
          },
          { context: 'SubagentThreadTaskStore.prepareThread.abandonedAttempt' },
        );
        if (savedAbandoned == null) {
          throw new Error('Unable to close the abandoned subagent attempt.');
        }
        await this.touchAfterMessage(scope, threadId, taskId, 'failed');
        return {
          conversation,
          initialMessages: [],
          initialStoredMessages: [],
          attemptKey,
          taskCreatedAt: durableMessageTime(
            savedAbandoned,
            'The abandoned subagent result has no durable occurrence time.',
          ),
          replay: {
            status: 'error',
            content: abandonedMessage,
            taskId,
            ...(abandoned.messageId.endsWith(':user') && {
              previousTaskId: abandoned.messageId.slice(0, -':user'.length),
            }),
            parentRunId: request.parentRunId,
          },
        };
      }
      const branch = selectLatestBranch(allMessages);
      const initialMessages = restoreThreadMessages(branch);
      const userMessageId = `${taskId}:user`;
      /** A crashed lease can leave its input row behind. Continue from the latest
       * terminal task row instead of making that incomplete input canonical. */
      let parentMessageId: string = Constants.NO_PARENT;
      for (let index = branch.length - 1; index >= 0; index -= 1) {
        if (branch[index].messageId.endsWith(':assistant')) {
          parentMessageId = branch[index].messageId;
          break;
        }
      }
      logger.debug('[subagentThreads] Child-thread preparation entered stage', {
        stage: 'seed_write',
        taskId,
        threadId,
      });
      const savedUserMessage = await observeSlowPreparation(
        this.methods.saveMessage(
          { userId: scope.userId, ...retentionContext(conversation) },
          {
            messageId: userMessageId,
            conversationId: threadId,
            parentMessageId,
            sender: 'User',
            text: request.input,
            endpoint: EModelEndpoint.agents,
            isCreatedByUser: true,
            subagentTask: {
              attemptKey,
              parentRunId: request.parentRunId,
              ...(requestFingerprint == null ? {} : { requestFingerprint }),
              status: 'running',
            },
            ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
          },
          { context: 'SubagentThreadTaskStore.prepareThread' },
        ),
        { stage: 'seed_write', taskId, threadId },
      );
      if (savedUserMessage == null) {
        throw new Error('Unable to persist the child-thread input.');
      }
      await this.flushControlReceiptsForSettlement(scopeId, taskId);
      const currentParent = await this.methods.getConvo(scope.userId, scope.parentConversationId);
      if (currentParent == null || !matchesTenant(currentParent.tenantId, scope.tenantId)) {
        throw new SubagentThreadPublicError('Parent thread is unavailable.');
      }
      return {
        conversation,
        initialMessages,
        initialStoredMessages: mapChatMessagesToStoredMessages(initialMessages),
        attemptKey,
        taskCreatedAt: durableMessageTime(
          savedUserMessage,
          'The child-thread input has no durable occurrence time.',
        ),
        userMessageId,
      };
    } catch (error) {
      if (sharedLeaseAcquired) {
        await this.rollbackPreparation(scope, threadId, taskId, createdThread);
      }
      throw error;
    }
  }

  private assertContinuation(
    scope: SubagentThreadScope,
    request: SubagentTaskStartRequest,
    conversation: IConversation,
  ): void {
    if (!this.isContinuationAllowed(scope, request, conversation)) {
      throw new SubagentThreadPublicError(
        'Child thread is unavailable for this subagent and parent scope.',
      );
    }
  }

  private isContinuationAllowed(
    scope: SubagentThreadScope,
    request: SubagentTaskStartRequest,
    conversation: IConversation,
  ): boolean {
    const lineage = conversation.subagentThread;
    const expectedAgentId = childAgentId(request);
    const agentIdentityMatches =
      request.subagentKind === 'graph'
        ? conversation.agent_id == null
        : conversation.agent_id === expectedAgentId;
    return !(
      lineage == null ||
      conversation.endpoint !== EModelEndpoint.agents ||
      !agentIdentityMatches ||
      lineage.parentConversationId !== scope.parentConversationId ||
      lineage.parentAgentId !== request.parentAgentId ||
      lineage.subagentType !== request.subagentType ||
      lineage.subagentKind !== request.subagentKind ||
      lineage.depth > this.maxThreadDepth ||
      !matchesTenant(conversation.tenantId, scope.tenantId)
    );
  }

  private async persistResult(
    scope: SubagentThreadScope,
    request: SubagentTaskStartRequest,
    taskId: string,
    prepared: PreparedThread,
    result: { content: string; messages?: BaseMessage[] },
    detachedUsage: UsageMetadata[],
  ): Promise<void> {
    if (prepared.userMessageId == null) {
      throw new Error('The child-thread input was not prepared.');
    }
    await this.flushControlReceiptsForSettlement(request.scopeId, taskId);
    const subagentTranscript = serializeTranscript(
      taskId,
      prepared.initialStoredMessages,
      result.messages,
    );
    const activityProjection =
      subagentTranscript == null
        ? undefined
        : projectSubagentActivity(
            subagentTranscript.messagesJson,
            subagentTranscript.mode,
            request.input,
          );
    const subagentActivityProjection =
      activityProjection == null
        ? undefined
        : {
            taskId,
            version: 1 as const,
            activityJson: JSON.stringify(activityProjection.activity),
            truncated: activityProjection.truncated,
          };
    const conversation = await this.requireCurrentConversation(
      scope,
      request,
      prepared.conversation.conversationId,
    );
    const usage = this.aggregateDetachedUsage(detachedUsage);
    const savedAssistantMessage = await this.methods.saveMessage(
      { userId: scope.userId, ...retentionContext(conversation) },
      {
        messageId: `${taskId}:assistant`,
        conversationId: conversation.conversationId,
        parentMessageId: prepared.userMessageId,
        sender: request.subagentType,
        text: result.content,
        endpoint: EModelEndpoint.agents,
        isCreatedByUser: false,
        unfinished: false,
        ...(subagentTranscript == null ? {} : { subagentTranscript }),
        ...(subagentActivityProjection == null ? {} : { subagentActivityProjection }),
        subagentTask: {
          attemptKey: prepared.attemptKey,
          parentRunId: request.parentRunId,
          ...(normalizedRequestFingerprint(request) == null
            ? {}
            : { requestFingerprint: normalizedRequestFingerprint(request) }),
          status: 'completed',
        },
        ...(usage == null ? {} : { metadata: { usage } }),
        ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
      },
      { context: 'SubagentThreadTaskStore.persistResult' },
    );
    if (savedAssistantMessage == null) {
      throw new Error('Unable to persist the child-thread result.');
    }
    await this.touchAfterMessage(scope, conversation.conversationId, taskId, 'completed');
  }

  private async persistFailure(
    scope: SubagentThreadScope,
    threadId: string,
    request: SubagentTaskStartRequest,
    taskId: string,
    error: unknown,
    detachedUsage: UsageMetadata[],
  ): Promise<void> {
    await this.flushControlReceiptsForSettlement(request.scopeId, taskId);
    const conversation = await this.currentConversation(scope, request, threadId);
    if (conversation == null || !(await this.taskInputExists(scope, threadId, taskId))) {
      return;
    }
    const usage = this.aggregateDetachedUsage(detachedUsage);
    const savedFailure = await this.methods.saveMessage(
      { userId: scope.userId, ...retentionContext(conversation) },
      {
        messageId: `${taskId}:assistant`,
        conversationId: threadId,
        parentMessageId: `${taskId}:user`,
        sender: request.subagentType,
        text: safeErrorMessage(error),
        endpoint: EModelEndpoint.agents,
        isCreatedByUser: false,
        unfinished: false,
        error: true,
        subagentTask: {
          attemptKey: createSubagentAttemptKey(request.scopeId, request.idempotencyKey),
          parentRunId: request.parentRunId,
          ...(normalizedRequestFingerprint(request) == null
            ? {}
            : { requestFingerprint: normalizedRequestFingerprint(request) }),
          status: 'error',
        },
        ...(usage == null ? {} : { metadata: { usage } }),
        ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
      },
      { context: 'SubagentThreadTaskStore.persistFailure' },
    );
    if (savedFailure == null) {
      throw new Error('Unable to persist the child-thread failure.');
    }
    await this.touchAfterMessage(scope, threadId, taskId, 'failed');
  }

  private async registerTaskWakeup(
    scope: SubagentThreadScope,
    threadId: string,
    request: SubagentTaskStartRequest,
    task: { taskId: string; parentRunId: string; createdAt: number },
  ): Promise<void> {
    if (
      this.onTaskPrepared == null ||
      (request as HostSubagentTaskStartRequest).completionDelivery !== SUBAGENT_COMPLETION_DELIVERY
    ) {
      return;
    }
    const admitted = await this.onTaskPrepared({
      userId: scope.userId,
      parentConversationId: scope.parentConversationId,
      parentMessageId: task.parentRunId,
      ...(request.parentAgentId == null ? {} : { parentAgentId: request.parentAgentId }),
      ...(scope.tenantId == null ? {} : { tenantId: scope.tenantId }),
      taskId: task.taskId,
      threadId,
      subagentType: request.subagentType,
      createdAt: task.createdAt,
    });
    if (admitted !== false) {
      this.wakeupTaskIds.add(task.taskId);
    }
  }

  private async persistCancellation(
    scope: SubagentThreadScope,
    threadId: string,
    request: SubagentTaskStartRequest,
    taskId: string,
    detachedUsage: UsageMetadata[],
  ): Promise<void> {
    await this.flushControlReceiptsForSettlement(request.scopeId, taskId);
    const conversation = await this.currentConversation(scope, request, threadId);
    if (conversation == null || !(await this.taskInputExists(scope, threadId, taskId))) {
      return;
    }
    const usage = this.aggregateDetachedUsage(detachedUsage);
    const savedCancellation = await this.methods.saveMessage(
      { userId: scope.userId, ...retentionContext(conversation) },
      {
        messageId: `${taskId}:assistant`,
        conversationId: threadId,
        parentMessageId: `${taskId}:user`,
        sender: request.subagentType,
        text: 'Subagent task was cancelled.',
        endpoint: EModelEndpoint.agents,
        isCreatedByUser: false,
        unfinished: false,
        subagentTask: {
          attemptKey: createSubagentAttemptKey(request.scopeId, request.idempotencyKey),
          parentRunId: request.parentRunId,
          ...(normalizedRequestFingerprint(request) == null
            ? {}
            : { requestFingerprint: normalizedRequestFingerprint(request) }),
          status: 'cancelled',
        },
        ...(usage == null ? {} : { metadata: { usage } }),
        ...(conversation.tenantId == null ? {} : { tenantId: conversation.tenantId }),
      },
      { context: 'SubagentThreadTaskStore.persistCancellation' },
    );
    if (savedCancellation == null) {
      throw new Error('Unable to persist the child-thread cancellation.');
    }
    await this.touchAfterMessage(scope, threadId, taskId, 'cancelled');
  }

  private async currentConversation(
    scope: SubagentThreadScope,
    request: SubagentTaskStartRequest,
    threadId: string,
  ): Promise<IConversation | null> {
    const [ownerActive, parent, conversation] = await Promise.all([
      this.isOwnerActive(scope.userId),
      this.methods.getConvo(scope.userId, scope.parentConversationId),
      this.methods.getConvo(scope.userId, threadId),
    ]);
    if (conversation == null || !this.isContinuationAllowed(scope, request, conversation)) {
      return null;
    }
    if (!ownerActive) {
      return null;
    }
    if (parent != null && matchesTenant(parent.tenantId, scope.tenantId)) {
      return conversation;
    }
    await this.methods.deleteConvos(scope.userId, { conversationId: threadId }).catch((error) => {
      logger.warn('[subagentThreads] Failed to remove an orphaned child thread', error);
    });
    return null;
  }

  private cancelMatchingThreads(
    matches: (scope: SubagentThreadScope, threadId: string) => boolean,
  ): number {
    let cancelled = 0;
    for (const [lockKey, lease] of this.activeThreads) {
      const separator = lockKey.lastIndexOf('\u0000');
      if (separator < 0 || lease.taskId === '') {
        continue;
      }
      const scopeId = lockKey.slice(0, separator);
      const threadId = lockKey.slice(separator + 1);
      const scope = parseScope(scopeId);
      if (!matches(scope, threadId)) {
        continue;
      }
      const result = this.control(scopeId, lease.taskId, { action: 'cancel' });
      if (result.status === 'cancelled') {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private async requireCurrentConversation(
    scope: SubagentThreadScope,
    request: SubagentTaskStartRequest,
    threadId: string,
  ): Promise<IConversation> {
    const conversation = await this.currentConversation(scope, request, threadId);
    if (conversation == null) {
      throw new SubagentThreadDeletedError('Child thread was deleted before settlement.');
    }
    return conversation;
  }

  private async taskInputExists(
    scope: SubagentThreadScope,
    threadId: string,
    taskId: string,
  ): Promise<boolean> {
    const messages = await this.methods.getMessages(
      { conversationId: threadId, user: scope.userId, messageId: `${taskId}:user` },
      'messageId',
      { limit: 1 },
    );
    return messages.length > 0;
  }

  private async rollbackPreparation(
    scope: SubagentThreadScope,
    threadId: string,
    taskId: string,
    createdThread: boolean,
  ): Promise<void> {
    try {
      if (createdThread) {
        await this.methods.deleteConvos(scope.userId, { conversationId: threadId });
        return;
      }
      await this.deleteTaskMessages(scope, threadId, taskId);
    } catch (cleanupError) {
      logger.error('[subagentThreads] Failed to roll back child-thread setup', cleanupError);
    }
  }

  private async deleteTaskMessages(
    scope: SubagentThreadScope,
    threadId: string,
    taskId: string,
  ): Promise<void> {
    await this.methods.deleteMessages({
      user: scope.userId,
      conversationId: threadId,
      messageId: { $in: [`${taskId}:user`, `${taskId}:assistant`] },
    });
  }

  private async touchAfterMessage(
    scope: SubagentThreadScope,
    threadId: string,
    taskId: string,
    outcome: 'cancelled' | 'completed' | 'failed',
  ): Promise<void> {
    try {
      const saved = await this.methods.saveConvo(
        { userId: scope.userId },
        { conversationId: threadId },
        { context: 'SubagentThreadTaskStore.touchAfterMessage', noUpsert: true },
      );
      if (saved == null) {
        throw new SubagentThreadDeletedError('Child thread was deleted before settlement.');
      }
      if ('message' in saved) {
        throw new Error('Unable to refresh the child thread.');
      }
    } catch (error) {
      if (error instanceof SubagentThreadDeletedError) {
        await this.deleteTaskMessages(scope, threadId, taskId);
        throw error;
      }
      logger.error(`[subagentThreads] Failed to refresh ${outcome} child thread`, error);
    }
    this.notifyTaskSettled(scope, taskId);
  }

  private notifyTaskSettled(
    scope: SubagentThreadScope,
    taskId: string,
    previousTaskId?: string,
  ): void {
    if (!this.wakeupTaskIds.delete(taskId)) {
      return;
    }
    try {
      this.onTaskSettled?.(
        scope.userId,
        scope.parentConversationId,
        previousTaskId == null ? [taskId] : [taskId, previousTaskId],
      );
    } catch (error) {
      logger.warn('[subagentThreads] Settled-task listener failed', error);
    }
  }

  private aggregateDetachedUsage(detachedUsage: UsageMetadata[]) {
    return aggregateEmittedUsage(
      detachedUsage.map((entry) => ({ ...entry, usage_type: 'subagent' as const })),
    );
  }
}

const REQUIRED_THREAD_METHODS = [
  'acquireSubagentThreadLease',
  'claimSubagentTaskResult',
  'countActiveSubagentThreadLeases',
  'deleteConvos',
  'deleteMessages',
  'getConvo',
  'getSubagentTaskControlReplay',
  'getMessages',
  'listActiveSubagentThreadLeases',
  'recordSubagentTaskControlReceipt',
  'releaseSubagentThreadLease',
  'renewSubagentThreadLease',
  'reserveSubagentThread',
  'saveConvo',
  'saveMessage',
] as const;

export function createSubagentThreadTaskStore(
  methods: Pick<
    ConversationMethods,
    | 'acquireSubagentThreadLease'
    | 'countActiveSubagentThreadLeases'
    | 'deleteConvos'
    | 'getConvo'
    | 'listActiveSubagentThreadLeases'
    | 'releaseSubagentThreadLease'
    | 'reserveSubagentThread'
    | 'renewSubagentThreadLease'
    | 'saveConvo'
  > &
    Pick<
      MessageMethods,
      | 'claimSubagentTaskResult'
      | 'deleteMessages'
      | 'getSubagentTaskControlReplay'
      | 'getMessages'
      | 'recordSubagentTaskControlReceipt'
      | 'saveMessage'
    >,
  options?: SubagentThreadTaskStoreOptions,
): SubagentThreadTaskStore {
  /** The host wires this from JavaScript, where the parameter type checks nothing. A
   * method missing there would otherwise surface as a routed failure at claim time,
   * long after startup, so the omission is caught here instead. */
  const missing = REQUIRED_THREAD_METHODS.filter(
    (name) => typeof (methods as Record<string, unknown>)[name] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(`Subagent thread task store is missing methods: ${missing.join(', ')}`);
  }
  return new SubagentThreadTaskStore(methods, options);
}

type CompletionWakeupStore = SubagentTaskStore &
  Pick<SubagentThreadTaskStore, 'claimTask' | 'controlTask' | 'hasTasks' | 'listTasks'>;

const completionWakeupStores = new WeakMap<SubagentThreadTaskStore, CompletionWakeupStore>();

function completionWakeupStore(store: SubagentThreadTaskStore): CompletionWakeupStore {
  const existing = completionWakeupStores.get(store);
  if (existing != null) {
    return existing;
  }
  const adapter: CompletionWakeupStore = {
    supportsThreadContinuation: store.supportsThreadContinuation,
    start: (request) => {
      const hostRequest: HostSubagentTaskStartRequest = {
        ...request,
        completionDelivery: SUBAGENT_COMPLETION_DELIVERY,
      };
      return store.start(hostRequest);
    },
    get: (scopeId, taskId) => store.get(scopeId, taskId),
    list: (scopeId) => store.list(scopeId),
    claim: (scopeId, taskId) => store.claim(scopeId, taskId),
    control: (scopeId, taskId, command) => store.control(scopeId, taskId, command),
    claimTask: (scopeId, taskId, invocationId) => store.claimTask(scopeId, taskId, invocationId),
    controlTask: (scopeId, taskId, command, invocationId) =>
      store.controlTask(scopeId, taskId, command, invocationId),
    hasTasks: (scopeId) => store.hasTasks(scopeId),
    listTasks: (scopeId) => store.listTasks(scopeId),
  };
  completionWakeupStores.set(store, adapter);
  return adapter;
}

export function buildSubagentThreadTaskConfig(
  store: SubagentThreadTaskStore,
  scope: Omit<SubagentThreadScope, 'version'>,
  options: { completionWakeups?: boolean } = {},
): HostSubagentTaskConfig {
  const taskStore = options.completionWakeups === true ? completionWakeupStore(store) : store;
  return {
    store: taskStore,
    scopeId: serializeScope(scope),
    ...(options.completionWakeups === true
      ? { completionDelivery: SUBAGENT_COMPLETION_DELIVERY }
      : {}),
  };
}
