import { randomUUID } from 'node:crypto';
import { isEphemeralAgentId } from 'librechat-data-provider';
import type { ConversationMethods, IMessage, MessageMethods } from '@librechat/data-schemas';
import type {
  AgentTriggerContinuePreparation,
  AgentTriggerExecutionHostDeps,
} from './triggers/host';
import type { SubagentTaskWakeupRegistration } from './subagentThreads';
import type { AgentContinueTriggerEnvelope } from './triggers/envelope';
import type { AgentTriggerDispatchContext } from './triggers/dispatch';
import type { AgentTriggerEnqueueOptions } from './triggers/delivery';
import { WAITING_RETRY_CAP_MS, waitingRetryAfter } from './triggers/backoff';
import { boundedSubagentTaskResult } from './subagentTaskRouting';
import { createAgentTriggerEnvelope } from './triggers/envelope';
import { AgentTriggerExecutionError } from './triggers/host';

const WAKEUP_ADMISSION_DELAY_MS = 250;
/** SDK tasks time out after 30 minutes; this grace covers terminal persistence. */
const CHILD_READY_WAIT_MS = 35 * 60_000;
export const SUBAGENT_COMPLETION_SOURCE = 'subagent-completion';
const EVENT_TYPE = 'subagent.completion';
const MESSAGE_SELECT = 'messageId parentMessageId isCreatedByUser createdAt';
const TASK_SELECT =
  'messageId conversationId parentMessageId sender text error createdAt updatedAt +subagentTask';
const ORCHESTRATION_TASK_SELECT =
  'messageId conversationId sender isCreatedByUser createdAt updatedAt +subagentTask';
const MAX_ORCHESTRATION_TASKS = 16;
const MAX_ORCHESTRATION_CANDIDATES = MAX_ORCHESTRATION_TASKS * 2 + 1;
const MAX_ORCHESTRATION_ACTIVE_LEASES = 200;
const MAX_ORCHESTRATION_SNAPSHOT_BYTES = 8 * 1_024;
const MAX_ORCHESTRATION_SCALAR_CHARS = 256;

export type EnqueueAgentTrigger = (
  envelope: unknown,
  options?: AgentTriggerEnqueueOptions,
) => Promise<unknown>;

type WakeupMethods = Pick<ConversationMethods, 'getConvo'> &
  Pick<ConversationMethods, 'listActiveSubagentThreadLeases'> &
  Pick<
    MessageMethods,
    'claimSubagentTaskResult' | 'getMessages' | 'releaseSubagentTaskResultClaim'
  >;

interface GenerationState {
  status?: unknown;
  metadata?: {
    idempotencyClientRequestId?: unknown;
    terminalPersistencePending?: unknown;
  };
}

type SubagentTaskStatus = NonNullable<IMessage['subagentTask']>['status'];

interface OrchestrationTaskCandidate {
  attemptKey: string;
  taskId: string;
  threadId: string;
  status: SubagentTaskStatus;
  updatedAt: number;
  resultClaimed: boolean;
  sender?: string;
}

interface OrchestrationTaskSnapshot {
  background_task_id: string;
  subagent_thread_id: string;
  subagent_type: string;
  status: SubagentTaskStatus;
  result_state: 'pending' | 'available' | 'claimed';
  current_completion: boolean;
}

interface OrchestrationSnapshotResolution {
  tasks: OrchestrationTaskSnapshot[];
  candidateLimitReached: boolean;
  lineageUncertain: boolean;
  readUncertain: boolean;
}

export interface SubagentCompletionWakeupResolverDeps {
  methods: WakeupMethods;
  getGenerationJob: (conversationId: string) => Promise<GenerationState | null>;
  now?: () => number;
  /** Longest a waiting delivery re-checks readiness; the backoff default otherwise. */
  getWaitMaxIntervalMs?: () => number | undefined;
}

function payloadRegistration(
  envelope: AgentContinueTriggerEnvelope,
): Pick<SubagentTaskWakeupRegistration, 'taskId' | 'threadId' | 'subagentType'> | null | undefined {
  if (
    envelope.event.source.type !== 'internal' ||
    envelope.event.source.id !== SUBAGENT_COMPLETION_SOURCE ||
    envelope.event.type !== EVENT_TYPE
  ) {
    return;
  }
  const payload = envelope.event.payload;
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const { taskId, threadId, subagentType } = payload;
  if (
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 256 ||
    typeof threadId !== 'string' ||
    threadId.length === 0 ||
    threadId.length > 256 ||
    typeof subagentType !== 'string' ||
    subagentType.length === 0 ||
    subagentType.length > 256
  ) {
    return null;
  }
  return { taskId, threadId, subagentType };
}

function executionError(
  message: string,
  options: {
    code: string;
    retryable: boolean;
    deferWithoutAttempt?: boolean;
    status?: number;
    retryAfter?: string;
  },
): AgentTriggerExecutionError {
  return new AgentTriggerExecutionError(message, {
    mode: 'continue',
    certainty: 'definite',
    ...options,
  });
}

function isParentActive(job: GenerationState | null): boolean {
  return (
    job?.status === 'running' ||
    job?.status === 'requires_action' ||
    job?.metadata?.terminalPersistencePending === true
  );
}

/** A running or approval-paused parent can stay busy for hours; one that has
 * settled and is only finishing terminal persistence clears within moments. */
function isParentWorking(job: GenerationState | null): boolean {
  return job?.status === 'running' || job?.status === 'requires_action';
}

function sameTenant(actual: string | undefined, expected: string | undefined): boolean {
  return actual === expected;
}

function timestamp(message: Pick<IMessage, 'createdAt'>): number {
  const value = message.createdAt;
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = value == null ? Number.NaN : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function updatedTimestamp(message: Pick<IMessage, 'createdAt' | 'updatedAt'>): number {
  const value = message.updatedAt;
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = value == null ? Number.NaN : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : timestamp(message);
}

function taskIdFromMessage(message: Pick<IMessage, 'messageId'>): string | undefined {
  let suffix: ':assistant' | ':user';
  if (message.messageId.endsWith(':assistant')) {
    suffix = ':assistant';
  } else if (message.messageId.endsWith(':user')) {
    suffix = ':user';
  } else {
    return;
  }
  const taskId = message.messageId.slice(0, -suffix.length);
  return taskId.length > 0 && taskId.length <= 256 ? taskId : undefined;
}

function candidateFromMessage(message: IMessage): OrchestrationTaskCandidate | undefined {
  const taskId = taskIdFromMessage(message);
  const threadId = message.conversationId;
  const status = message.subagentTask?.status;
  const attemptKey = message.subagentTask?.attemptKey;
  if (
    taskId == null ||
    typeof threadId !== 'string' ||
    threadId.length === 0 ||
    threadId.length > 256 ||
    typeof attemptKey !== 'string' ||
    attemptKey.length === 0 ||
    attemptKey.length > 256 ||
    status == null
  ) {
    return;
  }
  const terminal = status !== 'running';
  if (
    (terminal && !message.messageId.endsWith(':assistant')) ||
    (!terminal && !message.messageId.endsWith(':user'))
  ) {
    return;
  }
  return {
    attemptKey,
    taskId,
    threadId,
    status,
    updatedAt: updatedTimestamp(message),
    resultClaimed: terminal && message.subagentTask?.resultClaim != null,
    ...(typeof message.sender === 'string' && message.sender.length > 0
      ? { sender: message.sender }
      : {}),
  };
}

function preferCandidate(
  current: OrchestrationTaskCandidate | undefined,
  candidate: OrchestrationTaskCandidate,
): OrchestrationTaskCandidate {
  if (current == null || (current.status === 'running' && candidate.status !== 'running')) {
    return candidate;
  }
  return candidate.updatedAt > current.updatedAt ? candidate : current;
}

function resultState(
  candidate: OrchestrationTaskCandidate,
): OrchestrationTaskSnapshot['result_state'] {
  if (candidate.status === 'running') {
    return 'pending';
  }
  return candidate.resultClaimed ? 'claimed' : 'available';
}

async function resolveOrchestrationSnapshot(
  methods: WakeupMethods,
  input: {
    userId: string;
    tenantId?: string;
    parentConversationId: string;
    parentMessageId: string;
    parentAgentId: string;
    currentThread: NonNullable<Awaited<ReturnType<WakeupMethods['getConvo']>>>;
    currentTaskId: string;
    currentTerminal: IMessage;
  },
): Promise<OrchestrationSnapshotResolution> {
  const currentCandidate = candidateFromMessage(input.currentTerminal);
  if (currentCandidate == null) {
    return {
      tasks: [],
      candidateLimitReached: false,
      lineageUncertain: true,
      readUncertain: true,
    };
  }

  let readUncertain = false;
  let activeLeases: Awaited<ReturnType<WakeupMethods['listActiveSubagentThreadLeases']>> = [];
  /** Snapshot leases before terminal rows: a child settling between these reads is
   * then visible either through its earlier lease or through its later terminal. */
  try {
    activeLeases = (
      await methods.listActiveSubagentThreadLeases({
        user: input.userId,
        now: new Date(),
        ...(input.tenantId == null ? {} : { tenantId: input.tenantId }),
      })
    ).filter((lease) => lease.parentConversationId === input.parentConversationId);
  } catch {
    readUncertain = true;
  }
  const boundedActiveLeases = activeLeases.slice(0, MAX_ORCHESTRATION_ACTIVE_LEASES);
  const leaseEvidenceRead =
    boundedActiveLeases.length === 0
      ? Promise.resolve([])
      : methods.getMessages(
          {
            user: input.userId,
            messageId: {
              $in: boundedActiveLeases.flatMap(({ taskId }) => [
                `${taskId}:user`,
                `${taskId}:assistant`,
              ]),
            },
            'subagentTask.status': { $in: ['running', 'completed', 'error', 'cancelled'] },
          },
          ORCHESTRATION_TASK_SELECT,
          { sort: false, limit: MAX_ORCHESTRATION_ACTIVE_LEASES * 2 },
        );
  const [terminalResult, leaseEvidenceResult] = await Promise.allSettled([
    methods.getMessages(
      {
        user: input.userId,
        'subagentTask.parentRunId': input.parentMessageId,
        'subagentTask.status': { $in: ['completed', 'error', 'cancelled'] },
      },
      ORCHESTRATION_TASK_SELECT,
      { sort: { updatedAt: -1, _id: -1 }, limit: MAX_ORCHESTRATION_CANDIDATES },
    ),
    leaseEvidenceRead,
  ]);
  readUncertain ||=
    terminalResult.status === 'rejected' || leaseEvidenceResult.status === 'rejected';
  const terminalMessages = terminalResult.status === 'fulfilled' ? terminalResult.value : [];
  const leaseEvidenceMessages =
    leaseEvidenceResult.status === 'fulfilled' ? leaseEvidenceResult.value : [];
  const validLeaseEvidence = leaseEvidenceMessages.flatMap((message) => {
    const candidate = candidateFromMessage(message);
    return candidate == null ? [] : [{ message, candidate }];
  });
  const activeMessages = validLeaseEvidence
    .filter(
      ({ message, candidate }) =>
        candidate.status === 'running' &&
        message.subagentTask?.parentRunId === input.parentMessageId,
    )
    .map(({ message }) => message);
  const leaseTerminalMessages = validLeaseEvidence
    .filter(
      ({ message, candidate }) =>
        candidate.status !== 'running' &&
        message.subagentTask?.parentRunId === input.parentMessageId,
    )
    .map(({ message }) => message);
  if (leaseEvidenceResult.status === 'fulfilled') {
    const resolvedLeaseTaskIds = new Set(
      validLeaseEvidence
        .filter(({ message }) => typeof message.subagentTask?.parentRunId === 'string')
        .map(({ candidate }) => candidate.taskId),
    );
    /** A retry can acquire a replacement task lease before persisting its terminal
     * assistant row, while retaining only the abandoned attempt's seed. A valid
     * seed from another parent run excludes that lease from this branch, and a
     * visible same-task terminal resolves the lease during post-settlement cleanup.
     * Anything left unmatched is an identity gap, not permission to invent one. */
    readUncertain ||= boundedActiveLeases.some(({ taskId }) => !resolvedLeaseTaskIds.has(taskId));
  }
  if (
    terminalMessages.length === 0 &&
    activeMessages.length === 0 &&
    leaseTerminalMessages.length === 0 &&
    readUncertain
  ) {
    const lineage = input.currentThread.subagentThread;
    if (lineage == null) {
      return {
        tasks: [],
        candidateLimitReached: false,
        lineageUncertain: true,
        readUncertain: true,
      };
    }
    return {
      tasks: [
        {
          background_task_id: input.currentTaskId,
          subagent_thread_id: input.currentThread.conversationId,
          subagent_type: lineage.subagentType,
          status: currentCandidate.status,
          result_state: resultState(currentCandidate),
          current_completion: true,
        },
      ],
      candidateLimitReached: false,
      lineageUncertain: false,
      readUncertain: true,
    };
  }

  const byAttemptKey = new Map<string, OrchestrationTaskCandidate>();
  for (const message of [...activeMessages, ...terminalMessages, ...leaseTerminalMessages]) {
    const candidate = candidateFromMessage(message);
    if (candidate == null) {
      continue;
    }
    byAttemptKey.set(
      candidate.attemptKey,
      preferCandidate(byAttemptKey.get(candidate.attemptKey), candidate),
    );
  }
  byAttemptKey.set(currentCandidate.attemptKey, currentCandidate);

  const candidates = [...byAttemptKey.values()].sort((left, right) => {
    if (left.taskId === input.currentTaskId) {
      return -1;
    }
    if (right.taskId === input.currentTaskId) {
      return 1;
    }
    if (left.status === 'running' && right.status !== 'running') {
      return -1;
    }
    if (right.status === 'running' && left.status !== 'running') {
      return 1;
    }
    const time = right.updatedAt - left.updatedAt;
    return time === 0 ? left.taskId.localeCompare(right.taskId) : time;
  });
  const selected = candidates.slice(0, MAX_ORCHESTRATION_TASKS);
  const siblingThreadIds = [
    ...new Set(
      selected
        .filter((candidate) => candidate.threadId !== input.currentThread.conversationId)
        .map((candidate) => candidate.threadId),
    ),
  ];
  const siblingThreads = await Promise.all(
    siblingThreadIds.map(async (threadId) => {
      try {
        return await methods.getConvo(input.userId, threadId);
      } catch {
        return null;
      }
    }),
  );
  const threads = new Map([
    [input.currentThread.conversationId, input.currentThread],
    ...siblingThreads
      .filter((thread): thread is NonNullable<typeof thread> => thread != null)
      .map((thread) => [thread.conversationId, thread] as const),
  ]);
  let lineageUncertain = siblingThreads.some((thread) => thread == null);
  const tasks: OrchestrationTaskSnapshot[] = [];
  for (const candidate of selected) {
    const conversation = threads.get(candidate.threadId);
    const lineage = conversation?.subagentThread;
    if (
      conversation == null ||
      lineage == null ||
      !sameTenant(conversation.tenantId, input.tenantId) ||
      lineage.parentConversationId !== input.parentConversationId ||
      lineage.parentAgentId !== input.parentAgentId ||
      (candidate.status !== 'running' && candidate.sender !== lineage.subagentType)
    ) {
      lineageUncertain = true;
      continue;
    }
    tasks.push({
      background_task_id: candidate.taskId,
      subagent_thread_id: candidate.threadId,
      subagent_type: lineage.subagentType,
      status: candidate.status,
      result_state: resultState(candidate),
      current_completion: candidate.taskId === input.currentTaskId,
    });
  }
  return {
    tasks,
    candidateLimitReached:
      terminalMessages.length === MAX_ORCHESTRATION_CANDIDATES ||
      activeLeases.length > MAX_ORCHESTRATION_ACTIVE_LEASES ||
      activeMessages.length > MAX_ORCHESTRATION_TASKS ||
      candidates.length > MAX_ORCHESTRATION_TASKS,
    lineageUncertain,
    readUncertain,
  };
}

function renderOrchestrationSnapshot(
  parentMessageId: string,
  resolution: OrchestrationSnapshotResolution,
): string {
  const knownChildren = resolution.tasks.slice(0, MAX_ORCHESTRATION_TASKS);
  let omitted = resolution.tasks.length - knownChildren.length;
  const boundedParentMessageId = parentMessageId.slice(0, MAX_ORCHESTRATION_SCALAR_CHARS);
  const parentMessageIdTruncated = boundedParentMessageId !== parentMessageId;
  const completeness = (): 'complete' | 'bounded' | 'uncertain' => {
    if (resolution.readUncertain || resolution.lineageUncertain) {
      return 'uncertain';
    }
    return resolution.candidateLimitReached || omitted > 0 ? 'bounded' : 'complete';
  };
  const note = (): string => {
    if (completeness() === 'uncertain') {
      return 'Some sibling state could not be read or verified. Do not infer that no other children ran.';
    }
    if (completeness() === 'bounded') {
      return 'Additional durable child tasks may exist outside this bounded snapshot.';
    }
    return 'This lists the known durable child tasks for this exact parent run.';
  };
  const serialize = () =>
    JSON.stringify({
      scope: 'current_parent_branch',
      parent_message_id: boundedParentMessageId,
      ...(parentMessageIdTruncated ? { parent_message_id_truncated: true } : {}),
      completeness: completeness(),
      known_children: knownChildren,
      omitted_known_children: omitted,
      additional_children_may_exist:
        resolution.candidateLimitReached ||
        resolution.readUncertain ||
        resolution.lineageUncertain ||
        omitted > 0,
      note: note(),
    });
  let rendered = serialize();
  while (
    Buffer.byteLength(rendered, 'utf8') > MAX_ORCHESTRATION_SNAPSHOT_BYTES &&
    knownChildren.length > 0
  ) {
    knownChildren.pop();
    omitted += 1;
    rendered = serialize();
  }
  if (Buffer.byteLength(rendered, 'utf8') > MAX_ORCHESTRATION_SNAPSHOT_BYTES) {
    return JSON.stringify({
      scope: 'current_parent_branch',
      completeness: 'uncertain',
      known_children: [],
      omitted_known_children: resolution.tasks.length,
      additional_children_may_exist: true,
      current_completion_in_preceding_result: true,
      note: 'Snapshot metadata exceeded its byte budget. Do not infer that no other children ran.',
    });
  }
  return rendered;
}

/** Selects the newest persisted assistant on the branch below the original
 * parent. Re-resolving for every ordered delivery serializes sibling child
 * completions onto the branch produced by the preceding wakeup. */
function latestAssistantDescendant(messages: IMessage[], anchorId: string): string | undefined {
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  if (!byId.has(anchorId)) {
    return;
  }
  const memo = new Map<string, boolean>([[anchorId, true]]);
  const reachesAnchor = (message: IMessage, visiting = new Set<string>()): boolean => {
    const known = memo.get(message.messageId);
    if (known != null) {
      return known;
    }
    if (visiting.has(message.messageId)) {
      memo.set(message.messageId, false);
      return false;
    }
    visiting.add(message.messageId);
    const parent =
      typeof message.parentMessageId === 'string' ? byId.get(message.parentMessageId) : undefined;
    const reachable = parent != null && reachesAnchor(parent, visiting);
    visiting.delete(message.messageId);
    memo.set(message.messageId, reachable);
    return reachable;
  };
  const descendants = messages
    .filter((message) => message.isCreatedByUser === false && reachesAnchor(message))
    .sort((left, right) => {
      const time = timestamp(left) - timestamp(right);
      return time === 0 ? left.messageId.localeCompare(right.messageId) : time;
    });
  return descendants[descendants.length - 1]?.messageId;
}

function renderWakeupInput(
  registration: Pick<SubagentTaskWakeupRegistration, 'threadId' | 'subagentType'>,
  resultTaskId: string,
  terminal: IMessage,
  orchestrationSnapshot: string,
): string {
  const status = terminal.subagentTask?.status ?? 'error';
  return [
    `A detached subagent task has ${status}. Continue the parent task using its durable result below.`,
    JSON.stringify({
      background_task_id: resultTaskId,
      subagent_thread_id: registration.threadId,
      subagent_type: registration.subagentType,
      status,
      result: boundedSubagentTaskResult(terminal.text ?? ''),
    }),
    'Host-authored bounded orchestration snapshot:',
    orchestrationSnapshot,
  ].join('\n');
}

/** Resolves a pre-registered completion delivery immediately before dispatch.
 * The durable result claim elects exactly one consumer (manual poll or this
 * delivery), while the branch lookup chains ordered sibling completions. */
export function createSubagentCompletionWakeupResolver({
  methods,
  getGenerationJob,
  now = Date.now,
  getWaitMaxIntervalMs,
}: SubagentCompletionWakeupResolverDeps): NonNullable<
  AgentTriggerExecutionHostDeps['prepareContinue']
> {
  const waitingRetry = (receivedAt: number): string =>
    waitingRetryAfter(receivedAt, now(), getWaitMaxIntervalMs?.() ?? WAITING_RETRY_CAP_MS);
  return async (
    envelope: AgentContinueTriggerEnvelope,
    context: AgentTriggerDispatchContext,
  ): Promise<AgentTriggerContinuePreparation | undefined> => {
    const registration = payloadRegistration(envelope);
    if (registration === undefined) {
      return;
    }
    if (registration === null) {
      throw executionError('The subagent completion wakeup payload is invalid.', {
        code: 'INVALID_SUBAGENT_WAKEUP',
        retryable: false,
      });
    }

    let parentJob: GenerationState | null;
    try {
      parentJob = await getGenerationJob(envelope.target.conversationId);
    } catch (error) {
      throw executionError(
        `Parent generation state is temporarily unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { code: 'PARENT_STATE_UNAVAILABLE', retryable: true },
      );
    }
    if (
      isParentActive(parentJob) &&
      parentJob?.metadata?.idempotencyClientRequestId !== context.idempotencyKey
    ) {
      throw executionError('The parent generation has not settled yet.', {
        code: 'PARENT_NOT_READY',
        retryable: true,
        status: 409,
        retryAfter: isParentWorking(parentJob) ? waitingRetry(envelope.receivedAt) : '1',
        deferWithoutAttempt: true,
      });
    }

    const userId = envelope.principal.userId;
    const tenantId = envelope.principal.tenantId;
    const [parent, child, taskMessages] = await Promise.all([
      methods.getConvo(userId, envelope.target.conversationId),
      methods.getConvo(userId, registration.threadId),
      methods.getMessages(
        {
          user: userId,
          conversationId: registration.threadId,
          messageId: { $in: [`${registration.taskId}:user`, `${registration.taskId}:assistant`] },
        },
        TASK_SELECT,
        { sort: { createdAt: 1, _id: 1 } },
      ),
    ]);
    if (parent == null || !sameTenant(parent.tenantId, tenantId)) {
      throw executionError('The parent conversation is no longer available.', {
        code: 'PARENT_NOT_FOUND',
        retryable: false,
        status: 404,
      });
    }
    const lineage = child?.subagentThread;
    if (
      child == null ||
      !sameTenant(child.tenantId, tenantId) ||
      lineage?.parentConversationId !== envelope.target.conversationId ||
      lineage.parentAgentId !== envelope.target.agentId ||
      lineage.subagentType !== registration.subagentType
    ) {
      throw executionError('The child task lineage is no longer available.', {
        code: 'CHILD_TASK_MISSING',
        retryable: false,
        status: 404,
      });
    }
    let resultTaskId = registration.taskId;
    let terminal = taskMessages.find(
      (message) =>
        message.messageId === `${registration.taskId}:assistant` &&
        message.subagentTask?.status !== 'running',
    );
    const started = taskMessages.find(
      (message) => message.messageId === `${registration.taskId}:user`,
    );
    /** A worker can persist the input, lose its lease, and then have a retry
     * close the same logical attempt under the retry's runtime task id. Resolve
     * that terminal by the durable attempt identity so the earlier ordered
     * delivery cannot block the repaired delivery behind it for the full
     * abandonment grace period. */
    if (terminal == null && started?.subagentTask?.attemptKey != null) {
      const [supersedingTerminal] = await methods.getMessages(
        {
          user: userId,
          conversationId: registration.threadId,
          'subagentTask.attemptKey': started.subagentTask.attemptKey,
          'subagentTask.status': { $in: ['completed', 'error', 'cancelled'] },
        },
        TASK_SELECT,
        { sort: { createdAt: -1, _id: -1 }, limit: 1 },
      );
      if (supersedingTerminal?.messageId.endsWith(':assistant') === true) {
        terminal = supersedingTerminal;
        resultTaskId = supersedingTerminal.messageId.slice(0, -':assistant'.length);
      }
    }
    if (terminal == null) {
      if (started != null) {
        if (now() - envelope.event.occurredAt > CHILD_READY_WAIT_MS) {
          throw executionError('The child task owner disappeared before settlement.', {
            code: 'CHILD_TASK_ABANDONED',
            retryable: false,
            status: 410,
          });
        }
        throw executionError('The child task has not settled yet.', {
          code: 'CHILD_NOT_READY',
          retryable: true,
          status: 409,
          retryAfter: waitingRetry(envelope.receivedAt),
          deferWithoutAttempt: true,
        });
      }
      throw executionError('The child task no longer exists.', {
        code: 'CHILD_TASK_MISSING',
        retryable: false,
        status: 404,
      });
    }
    if (terminal.subagentTask?.parentRunId !== envelope.target.parentMessageId) {
      throw executionError('The child task lineage is no longer available.', {
        code: 'CHILD_TASK_MISSING',
        retryable: false,
        status: 404,
      });
    }

    const parentMessages = await methods.getMessages(
      { user: userId, conversationId: envelope.target.conversationId },
      MESSAGE_SELECT,
      { sort: { createdAt: 1, _id: 1 } },
    );

    const parentMessageId = latestAssistantDescendant(
      parentMessages,
      envelope.target.parentMessageId,
    );
    if (parentMessageId == null) {
      throw executionError('The parent conversation branch is no longer available.', {
        code: 'PARENT_NOT_FOUND',
        retryable: false,
        status: 404,
      });
    }

    const claim = await methods.claimSubagentTaskResult({
      userId,
      conversationId: registration.threadId,
      taskId: resultTaskId,
      kind: 'wakeup',
      claimId: context.idempotencyKey,
    });
    if (claim.status !== 'acquired') {
      return { status: 'settled' };
    }
    if (claim.message.subagentTask?.status === 'cancelled') {
      const released = await methods.releaseSubagentTaskResultClaim({
        userId,
        conversationId: registration.threadId,
        taskId: resultTaskId,
        kind: 'wakeup',
        claimId: context.idempotencyKey,
      });
      if (!released) {
        throw executionError('The cancelled child result claim could not be released.', {
          code: 'RESULT_CLAIM_RELEASE_FAILED',
          retryable: true,
        });
      }
      return { status: 'settled' };
    }
    const orchestrationSnapshot = renderOrchestrationSnapshot(
      envelope.target.parentMessageId,
      await resolveOrchestrationSnapshot(methods, {
        userId,
        tenantId,
        parentConversationId: envelope.target.conversationId,
        parentMessageId: envelope.target.parentMessageId,
        parentAgentId: envelope.target.agentId,
        currentThread: child,
        currentTaskId: resultTaskId,
        currentTerminal: claim.message,
      }),
    );
    return {
      status: 'ready',
      parentMessageId,
      ...(parent.codeApprovalMode != null && { codeApprovalMode: parent.codeApprovalMode }),
      input: renderWakeupInput(registration, resultTaskId, claim.message, orchestrationSnapshot),
      releaseOnDefiniteFailure: async () => {
        await methods.releaseSubagentTaskResultClaim({
          userId,
          conversationId: registration.threadId,
          taskId: resultTaskId,
          kind: 'wakeup',
          claimId: context.idempotencyKey,
        });
      },
    };
  };
}

/** Pre-registers the idempotent delivery before child provider work starts.
 * A process crash can therefore delay a wakeup but cannot lose it; dispatch
 * simply defers until the terminal child message exists. */
export function createSubagentCompletionWakeupHandler(
  enqueue: EnqueueAgentTrigger,
): (registration: SubagentTaskWakeupRegistration) => Promise<boolean> {
  return async (registration) => {
    const parentAgentId = registration.parentAgentId?.trim();
    if (parentAgentId == null || parentAgentId === '' || isEphemeralAgentId(parentAgentId)) {
      return false;
    }
    const eventId = registration.taskId;
    const envelope = createAgentTriggerEnvelope({
      mode: 'continue',
      requestId: randomUUID(),
      deliveryId: eventId,
      receivedAt: Date.now(),
      principal: {
        id: registration.userId,
        ...(registration.tenantId == null ? {} : { tenantId: registration.tenantId }),
      },
      event: {
        id: eventId,
        type: EVENT_TYPE,
        occurredAt: registration.createdAt,
        source: { id: SUBAGENT_COMPLETION_SOURCE, type: 'internal' },
        payload: {
          taskId: registration.taskId,
          threadId: registration.threadId,
          subagentType: registration.subagentType,
        },
      },
      target: {
        agentId: parentAgentId,
        conversationId: registration.parentConversationId,
        parentMessageId: registration.parentMessageId,
      },
      input: 'A detached subagent task is waiting to complete.',
    });
    await enqueue(envelope, {
      orderingKey: `subagent-completion:${registration.parentConversationId}`,
      availableAt: new Date(
        Math.max(Date.now(), registration.createdAt) + WAKEUP_ADMISSION_DELAY_MS,
      ),
    });
    return true;
  };
}
