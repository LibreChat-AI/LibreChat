import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import {
  AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
  logger,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  AgentQueuedTurnClaim,
  AgentQueuedTurnMethods,
  AgentQueuedTurnRecord,
  ConversationMethods,
  IMessage,
  MessageMethods,
} from '@librechat/data-schemas';
import type {
  AgentContinuationAdmissionSource,
  AgentTriggerExecutionHostDeps,
} from './triggers/host';
import type { AgentContinueTriggerEnvelope, AgentTriggerEnvelope } from './triggers/envelope';
import type { AgentTriggerEnqueueOptions } from './triggers/delivery';
import type { AgentTriggerDeliveryFailure } from './triggers/engine';
import { getAgentTriggerIdempotencyKey, parseAgentTriggerEnvelope } from './triggers/envelope';
import { createAgentTriggerEnvelope } from './triggers/envelope';
import { AgentTriggerExecutionError } from './triggers/host';

export const AGENT_QUEUED_TURN_SOURCE = 'agent-queued-turn';
const AGENT_QUEUED_TURN_EVENT = 'agent.queued-turn';
const MESSAGE_SELECT = 'messageId parentMessageId isCreatedByUser createdAt unfinished error';
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const RECONCILIATION_LEASE_MS = 2 * 60 * 1000;
const RECONCILIATION_BACKOFF_BASE_MS = 5_000;
const RECONCILIATION_BACKOFF_MAX_MS = 5 * 60 * 1000;
const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
const DEFAULT_RECOVERY_LIMIT = 100;
const MAX_FAILURE_CODE_LENGTH = 128;
const MAX_FAILURE_MESSAGE_LENGTH = 2048;
/** PID is commonly identical across container replicas. Keep claim ownership
 * stable within this process while fencing every other process instance. */
const PROCESS_CLAIM_OWNER = `agent-queued-turn:${process.pid}:${randomUUID()}`;

interface GenerationState {
  streamId?: unknown;
  status?: unknown;
  createdAt?: unknown;
  error?: unknown;
  metadata?: {
    idempotencyClientRequestId?: unknown;
    terminalPersistencePending?: unknown;
  };
}

interface GenerationAdmissionEvidence {
  generationId: string;
  generationCreatedAt: number;
}

type GetGenerationAdmissionEvidence = (
  userId: string,
  clientRequestId: string,
  streamId: string,
  conversationId?: string,
) => Promise<GenerationAdmissionEvidence | null>;

type QueuedTurnResolverMethods = AgentQueuedTurnMethods &
  Pick<ConversationMethods, 'getConvo'> &
  Pick<MessageMethods, 'getMessages'>;

export interface AgentQueuedTurnResolverDeps {
  methods: QueuedTurnResolverMethods;
  getGenerationJob: (conversationId: string) => Promise<GenerationState | null>;
  now?: () => number;
  claimBy?: string;
}

export type EnqueueAgentQueuedTurnDelivery = (
  envelope: unknown,
  options?: AgentTriggerEnqueueOptions,
) => Promise<{ deliveryKey: string }>;

export interface AgentQueuedTurnSchedulerDeps {
  methods: AgentQueuedTurnMethods;
  enqueue: EnqueueAgentQueuedTurnDelivery;
  getGenerationAdmissionEvidence: GetGenerationAdmissionEvidence;
  recoveryIntervalMs?: number;
  recoveryLimit?: number;
}

export interface AgentQueuedTurnScheduler {
  initialize: () => Promise<void>;
  stop: () => Promise<void>;
  schedule: (turn: AgentQueuedTurnRecord) => Promise<string>;
  recover: () => Promise<number>;
}

export interface AgentQueuedTurnLifecycle {
  prepareContinue: NonNullable<AgentTriggerExecutionHostDeps['prepareContinue']>;
  settleBeforeDeadLetter: (
    rawEnvelope: unknown,
    failure: AgentTriggerDeliveryFailure,
  ) => Promise<void>;
  recordExecutionAdmission: (
    rawSource: unknown,
    input: AgentQueuedTurnExecutionAdmission,
  ) => Promise<boolean>;
  verifyExecutionAdmission: (
    rawSource: unknown,
    input: AgentQueuedTurnExecutionAdmission,
  ) => Promise<boolean>;
  initialize: () => Promise<void>;
  stop: () => Promise<void>;
  schedule: (turn: AgentQueuedTurnRecord) => Promise<string>;
  cancel: (
    input: Parameters<AgentQueuedTurnMethods['cancelAgentQueuedTurn']>[0],
  ) => ReturnType<AgentQueuedTurnMethods['cancelAgentQueuedTurn']>;
  recover: () => Promise<number>;
}

export interface AgentQueuedTurnLifecycleDeps {
  methods: QueuedTurnResolverMethods;
  getGenerationJob: AgentQueuedTurnResolverDeps['getGenerationJob'];
  getGenerationAdmissionEvidence: GetGenerationAdmissionEvidence;
  enqueue: EnqueueAgentQueuedTurnDelivery;
  retireDelivery?: (
    deliveryKey: string,
    sourceId: string,
    reason: string,
    options?: { onlyIfDead?: boolean },
  ) => Promise<boolean>;
  getDelivery?: (deliveryKey: string) => Promise<unknown | null>;
  now?: () => number;
  claimBy?: string;
  recoveryIntervalMs?: number;
  recoveryLimit?: number;
}

export interface AgentQueuedTurnExecutionAdmission {
  userId: string;
  tenantId?: string;
  conversationId: string;
  clientRequestId: string;
  generationId: string;
  generationCreatedAt: number;
}

function parseQueuedTurnAdmissionSource(raw: unknown): AgentContinuationAdmissionSource | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  if (!('source' in raw) || raw.source !== AGENT_QUEUED_TURN_SOURCE) {
    return null;
  }
  const sourceId = 'sourceId' in raw ? raw.sourceId : undefined;
  const claimId = 'claimId' in raw ? raw.claimId : undefined;
  const claimBy = 'claimBy' in raw ? raw.claimBy : undefined;
  const effectivePredecessorCreatedAt =
    'effectivePredecessorCreatedAt' in raw ? raw.effectivePredecessorCreatedAt : undefined;
  const lineagePredecessorId = 'lineagePredecessorId' in raw ? raw.lineagePredecessorId : undefined;
  if (
    typeof sourceId !== 'string' ||
    sourceId.length === 0 ||
    sourceId.length > 128 ||
    typeof claimId !== 'string' ||
    claimId.length === 0 ||
    claimId.length > 128 ||
    typeof claimBy !== 'string' ||
    claimBy.length === 0 ||
    claimBy.length > 256 ||
    (effectivePredecessorCreatedAt != null &&
      (typeof effectivePredecessorCreatedAt !== 'number' ||
        !Number.isSafeInteger(effectivePredecessorCreatedAt) ||
        effectivePredecessorCreatedAt < 0)) ||
    (lineagePredecessorId != null &&
      (typeof lineagePredecessorId !== 'string' ||
        lineagePredecessorId.length === 0 ||
        lineagePredecessorId.length > 128))
  ) {
    throw new TypeError('Agent queued turn admission source is invalid');
  }
  return {
    source: AGENT_QUEUED_TURN_SOURCE,
    sourceId,
    claimId,
    claimBy,
    ...(typeof effectivePredecessorCreatedAt === 'number' && {
      effectivePredecessorCreatedAt,
    }),
    ...(typeof lineagePredecessorId === 'string' && { lineagePredecessorId }),
  };
}

/** Commits the source-owned admission receipt only after the controller has
 * invoked the provider implementation. A process death before that boundary
 * leaves the source nonterminal for fail-closed reconciliation. */
async function settleAgentQueuedTurnExecutionAdmission(
  rawSource: unknown,
  input: AgentQueuedTurnExecutionAdmission,
  methods: Pick<AgentQueuedTurnMethods, 'markAgentQueuedTurnAdmitted'>,
): Promise<boolean> {
  const source = parseQueuedTurnAdmissionSource(rawSource);
  if (source == null) {
    return false;
  }
  if (!Types.ObjectId.isValid(input.userId)) {
    throw new TypeError('Agent queued turn admission principal is invalid');
  }
  const settled = await methods.markAgentQueuedTurnAdmitted({
    user: new Types.ObjectId(input.userId),
    ...(input.tenantId != null && { tenantId: input.tenantId }),
    conversationId: input.conversationId,
    queuedTurnId: source.sourceId,
    claimId: source.claimId,
    claimBy: source.claimBy,
    admissionId: input.clientRequestId,
    admissionMode: 'ordinary',
    generationId: input.generationId,
    generationCreatedAt: input.generationCreatedAt,
    ...(source.effectivePredecessorCreatedAt != null && {
      effectivePredecessorCreatedAt: source.effectivePredecessorCreatedAt,
    }),
    ...(source.lineagePredecessorId != null && {
      lineagePredecessorId: source.lineagePredecessorId,
    }),
    settledAt: new Date(),
  });
  if (settled.outcome === 'conflict') {
    throw new Error('The queued turn execution admission could not be committed');
  }
  return true;
}

/** Deduplicated HTTP success is valid only when the original controller
 * already crossed the provider-invocation boundary and committed its exact
 * source receipt. Never manufacture that receipt from transient job state. */
async function verifyAgentQueuedTurnExecutionAdmission(
  rawSource: unknown,
  input: AgentQueuedTurnExecutionAdmission,
  methods: Pick<AgentQueuedTurnMethods, 'hasAgentQueuedTurnAdmissionReceipt'>,
): Promise<boolean> {
  const source = parseQueuedTurnAdmissionSource(rawSource);
  if (source == null) {
    return false;
  }
  if (!Types.ObjectId.isValid(input.userId)) {
    throw new TypeError('Agent queued turn admission principal is invalid');
  }
  const confirmed = await methods.hasAgentQueuedTurnAdmissionReceipt({
    user: new Types.ObjectId(input.userId),
    ...(input.tenantId != null && { tenantId: input.tenantId }),
    conversationId: input.conversationId,
    queuedTurnId: source.sourceId,
    admissionId: input.clientRequestId,
    generationId: input.generationId,
    generationCreatedAt: input.generationCreatedAt,
    ...(source.effectivePredecessorCreatedAt != null && {
      effectivePredecessorCreatedAt: source.effectivePredecessorCreatedAt,
    }),
    ...(source.lineagePredecessorId != null && {
      lineagePredecessorId: source.lineagePredecessorId,
    }),
  });
  if (!confirmed) {
    throw new Error('The queued turn execution admission is not yet confirmed');
  }
  return true;
}

function createAgentQueuedTurnDeadLetterSettlement({
  methods,
  getGenerationAdmissionEvidence,
  now = Date.now,
}: {
  methods: Pick<AgentQueuedTurnMethods, 'deadLetterAgentQueuedTurn'>;
  getGenerationAdmissionEvidence?: GetGenerationAdmissionEvidence;
  now?: () => number;
}) {
  return async (rawEnvelope: unknown, failure: AgentTriggerDeliveryFailure): Promise<void> => {
    let envelope: AgentTriggerEnvelope;
    try {
      envelope = parseAgentTriggerEnvelope(rawEnvelope);
    } catch {
      return;
    }
    if (envelope.mode !== 'continue') {
      return;
    }
    const queuedTurnId = payloadQueuedTurnId(envelope);
    if (queuedTurnId === undefined) {
      return;
    }
    if (queuedTurnId === null || !Types.ObjectId.isValid(envelope.principal.userId)) {
      return;
    }
    const deliveryKey = getAgentTriggerIdempotencyKey(envelope);
    const admissionEvidence = await getGenerationAdmissionEvidence?.(
      envelope.principal.userId,
      deliveryKey,
      envelope.target.conversationId,
      envelope.target.conversationId,
    );
    const settled = await methods.deadLetterAgentQueuedTurn({
      user: new Types.ObjectId(envelope.principal.userId),
      ...(envelope.principal.tenantId != null && { tenantId: envelope.principal.tenantId }),
      conversationId: envelope.target.conversationId,
      queuedTurnId,
      deliveryKey,
      settledAt: new Date(now()),
      failure: normalizeFailure(failure.code, failure.message),
      ...(admissionEvidence != null && { admissionEvidence }),
    });
    if (settled.outcome === 'conflict') {
      throw new Error('Queued turn delivery no longer owns its source row');
    }
  };
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

function isGenerationActive(job: GenerationState | null): boolean {
  return (
    job?.status === 'running' ||
    job?.status === 'requires_action' ||
    job?.metadata?.terminalPersistencePending === true
  );
}

function sameTenant(actual: unknown, expected: string | undefined): boolean {
  return expected == null ? actual == null : actual === expected;
}

function timestamp(message: IMessage): number {
  const value = message.createdAt;
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  return parsed != null && Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
}

/** Finds the current assistant leaf on the exact visible branch captured when
 * the turn was queued. Unrelated branch activity can never retarget the turn. */
function latestAssistantDescendant(messages: IMessage[], anchorId: string): IMessage | undefined {
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
  return descendants[descendants.length - 1];
}

function boundedFailureValue(value: string, fallback: string, maxLength: number): string {
  const normalized = value.trim();
  return (normalized.length === 0 ? fallback : normalized).slice(0, maxLength);
}

function normalizeFailure(code: string, message: string): { code: string; message: string } {
  return {
    code: boundedFailureValue(code, 'DELIVERY_FAILED', MAX_FAILURE_CODE_LENGTH),
    message: boundedFailureValue(
      message,
      'Queued turn delivery failed',
      MAX_FAILURE_MESSAGE_LENGTH,
    ),
  };
}

function reconciliationBackoff(attempts: number | undefined): number {
  const exponent = Math.max(0, Math.min((attempts ?? 1) - 1, 6));
  return Math.min(RECONCILIATION_BACKOFF_BASE_MS * 2 ** exponent, RECONCILIATION_BACKOFF_MAX_MS);
}

function payloadQueuedTurnId(envelope: AgentContinueTriggerEnvelope): string | null | undefined {
  if (
    envelope.event.source.type !== 'internal' ||
    envelope.event.source.id !== AGENT_QUEUED_TURN_SOURCE
  ) {
    return;
  }
  const payload = envelope.event.payload;
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>).queuedTurnId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function releaseClaim(
  methods: AgentQueuedTurnMethods,
  envelope: AgentContinueTriggerEnvelope,
  claim: AgentQueuedTurnClaim,
): Promise<unknown> {
  return methods.releaseAgentQueuedTurn({
    user: claim.user,
    ...(claim.tenantId != null && { tenantId: claim.tenantId }),
    conversationId: envelope.target.conversationId,
    queuedTurnId: claim.queuedTurnId,
    claimId: claim.claimId,
    claimBy: claim.claimBy,
    disposition: 'retry',
    availableAt: new Date(),
  });
}

function deadClaim(
  methods: AgentQueuedTurnMethods,
  envelope: AgentContinueTriggerEnvelope,
  claim: AgentQueuedTurnClaim,
  code: string,
  message: string,
): Promise<unknown> {
  return methods.releaseAgentQueuedTurn({
    user: claim.user,
    ...(claim.tenantId != null && { tenantId: claim.tenantId }),
    conversationId: envelope.target.conversationId,
    queuedTurnId: claim.queuedTurnId,
    claimId: claim.claimId,
    claimBy: claim.claimBy,
    disposition: 'dead',
    settledAt: new Date(),
    failure: normalizeFailure(code, message),
  });
}

/** Resolves one queued message into a fresh ordinary Agent turn. The durable
 * claim remains owned by the queue record until generation admission is known. */
function createAgentQueuedTurnResolver({
  methods,
  getGenerationJob,
  now = Date.now,
  claimBy = PROCESS_CLAIM_OWNER,
}: AgentQueuedTurnResolverDeps): NonNullable<AgentTriggerExecutionHostDeps['prepareContinue']> {
  return async (envelope, context) => {
    const queuedTurnId = payloadQueuedTurnId(envelope);
    if (queuedTurnId === undefined) {
      return;
    }
    if (queuedTurnId === null) {
      throw executionError('The queued turn payload is invalid.', {
        code: 'INVALID_QUEUED_TURN',
        retryable: false,
      });
    }

    let generation: GenerationState | null;
    try {
      generation = await getGenerationJob(envelope.target.conversationId);
    } catch (error) {
      throw executionError(
        `Parent generation state is temporarily unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { code: 'PARENT_STATE_UNAVAILABLE', retryable: true, deferWithoutAttempt: true },
      );
    }
    if (
      isGenerationActive(generation) &&
      generation?.metadata?.idempotencyClientRequestId !== context.idempotencyKey
    ) {
      throw executionError('The preceding generation has not settled yet.', {
        code: 'PARENT_NOT_READY',
        retryable: true,
        status: 409,
        retryAfter: '1',
        deferWithoutAttempt: true,
      });
    }

    const userId = envelope.principal.userId;
    const conversation = await methods.getConvo(userId, envelope.target.conversationId);
    if (
      conversation == null ||
      !sameTenant(conversation.tenantId, envelope.principal.tenantId) ||
      conversation.agent_id !== envelope.target.agentId
    ) {
      throw executionError('The queued turn conversation is no longer available.', {
        code: 'PARENT_NOT_FOUND',
        retryable: false,
        status: 404,
      });
    }

    const claimNow = new Date(now());
    const claimed = await methods.claimNextAgentQueuedTurn({
      user: new Types.ObjectId(userId),
      ...(envelope.principal.tenantId != null && {
        tenantId: envelope.principal.tenantId,
      }),
      conversationId: envelope.target.conversationId,
      queuedTurnId,
      claimId: context.idempotencyKey,
      claimBy,
      now: claimNow,
      leaseUntil: new Date(claimNow.getTime() + CLAIM_LEASE_MS),
    });
    if (claimed.outcome === 'missing') {
      return { status: 'settled' };
    }
    if (claimed.outcome === 'blocked') {
      throw executionError('An earlier queued turn has not settled yet.', {
        code: 'QUEUED_TURN_BLOCKED',
        retryable: true,
        status: 409,
        retryAfter: '1',
        deferWithoutAttempt: true,
      });
    }

    const claim = claimed.claim;
    let messages: IMessage[];
    try {
      messages = await methods.getMessages(
        { user: userId, conversationId: envelope.target.conversationId },
        MESSAGE_SELECT,
        { sort: { createdAt: 1, _id: 1 } },
      );
    } catch (error) {
      try {
        await releaseClaim(methods, envelope, claim);
      } catch (releaseError) {
        throw executionError(
          `The queued turn branch read failed and its claim could not be released: ${
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          }`,
          {
            code: 'QUEUED_TURN_PREPARATION_RELEASE_FAILED',
            retryable: true,
            deferWithoutAttempt: true,
          },
        );
      }
      throw executionError(
        `The queued turn branch is temporarily unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        {
          code: 'QUEUED_TURN_PREPARATION_UNAVAILABLE',
          retryable: true,
          deferWithoutAttempt: true,
        },
      );
    }
    const parentMessage = latestAssistantDescendant(messages, claim.parentMessageId);
    if (parentMessage == null) {
      await deadClaim(
        methods,
        envelope,
        claim,
        'PARENT_NOT_FOUND',
        'The queued turn branch is no longer available.',
      );
      throw executionError('The queued turn branch is no longer available.', {
        code: 'PARENT_NOT_FOUND',
        retryable: false,
        status: 404,
      });
    }
    const predecessorFailed = generation?.status === 'error' || parentMessage.error === true;
    const predecessorAborted =
      !predecessorFailed &&
      (generation?.status === 'aborted' ||
        (claim.priority !== true && parentMessage.unfinished === true));
    if (predecessorAborted || predecessorFailed) {
      await deadClaim(
        methods,
        envelope,
        claim,
        predecessorAborted ? 'PREDECESSOR_ABORTED' : 'PREDECESSOR_FAILED',
        predecessorAborted
          ? 'The preceding generation was aborted. Review this turn before sending it.'
          : 'The preceding generation failed. Review this turn before sending it.',
      );
      return { status: 'settled' };
    }

    const admission = await methods.beginAgentQueuedTurnAdmission({
      user: claim.user,
      ...(claim.tenantId != null && { tenantId: claim.tenantId }),
      conversationId: claim.conversationId,
      queuedTurnId: claim.queuedTurnId,
      claimId: claim.claimId,
      claimBy: claim.claimBy,
      admissionId: context.idempotencyKey,
      startedAt: new Date(now()),
      admissionProtocolVersion: 2,
    });
    if (admission.outcome === 'conflict') {
      throw executionError('The queued turn admission fence is no longer owned.', {
        code: 'QUEUED_TURN_ADMISSION_FENCE_LOST',
        retryable: true,
        deferWithoutAttempt: true,
      });
    }
    if (admission.outcome === 'retired' || admission.outcome === 'order_unavailable') {
      return { status: 'settled' };
    }
    const effectivePredecessorCreatedAt = admission.turn.admissionEffectivePredecessorCreatedAt;
    const lineagePredecessorId = admission.turn.admissionLineagePredecessorId;

    return {
      status: 'ready',
      input: claim.text,
      parentMessageId: parentMessage.messageId,
      ...(effectivePredecessorCreatedAt != null && {
        expectedPredecessorCreatedAt: effectivePredecessorCreatedAt,
      }),
      ...(claim.files != null && { files: claim.files }),
      ...(claim.quotes != null && { quotes: claim.quotes }),
      ...(claim.manualSkills != null && { manualSkills: claim.manualSkills }),
      ...(claim.reasoningOverride != null && { reasoningOverride: claim.reasoningOverride }),
      admissionSource: {
        source: AGENT_QUEUED_TURN_SOURCE,
        sourceId: claim.queuedTurnId,
        claimId: claim.claimId,
        claimBy: claim.claimBy,
        ...(effectivePredecessorCreatedAt != null && { effectivePredecessorCreatedAt }),
        ...(lineagePredecessorId != null && { lineagePredecessorId }),
      },
      releaseOnDefiniteFailure: async (error) => {
        if (
          error?.retryable === false ||
          (context.attempt != null &&
            context.maxAttempts != null &&
            context.attempt >= context.maxAttempts)
        ) {
          await deadClaim(
            methods,
            envelope,
            claim,
            error?.code ?? 'ADMISSION_REJECTED',
            error?.message ?? 'Queued turn admission failed',
          );
          return;
        }
        await releaseClaim(methods, envelope, claim);
      },
      settleOnAdmission: async (result) => {
        const settled = await methods.markAgentQueuedTurnAdmitted({
          user: claim.user,
          ...(claim.tenantId != null && { tenantId: claim.tenantId }),
          conversationId: claim.conversationId,
          queuedTurnId: claim.queuedTurnId,
          claimId: claim.claimId,
          claimBy: claim.claimBy,
          admissionId: context.idempotencyKey,
          admissionMode: 'ordinary',
          ...(result.streamId != null && { generationId: result.streamId }),
          ...(result.generationCreatedAt != null && {
            generationCreatedAt: result.generationCreatedAt,
          }),
          ...(effectivePredecessorCreatedAt != null && { effectivePredecessorCreatedAt }),
          ...(lineagePredecessorId != null && { lineagePredecessorId }),
          settledAt: new Date(now()),
        });
        if (settled.outcome === 'conflict') {
          throw new Error('The queued turn admission could not be committed');
        }
      },
    };
  };
}

function deliveryEnvelope(turn: AgentQueuedTurnRecord) {
  const occurredAt = turn.createdAt.getTime();
  return createAgentTriggerEnvelope({
    mode: 'continue',
    requestId: randomUUID(),
    deliveryId: turn.queuedTurnId,
    receivedAt: Date.now(),
    principal: {
      id: turn.user.toString(),
      ...(turn.tenantId != null && { tenantId: turn.tenantId }),
    },
    event: {
      id: turn.queuedTurnId,
      type: AGENT_QUEUED_TURN_EVENT,
      occurredAt,
      source: { id: AGENT_QUEUED_TURN_SOURCE, type: 'internal' },
      payload: { queuedTurnId: turn.queuedTurnId },
    },
    input: turn.text,
    target: {
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      parentMessageId: turn.parentMessageId,
    },
  });
}

/** Repairs the intentional record-first outbox seam by replaying a stable
 * delivery identity until the queue row records the scheduling receipt. */
function createAgentQueuedTurnScheduler({
  methods,
  enqueue,
  getGenerationAdmissionEvidence,
  recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS,
  recoveryLimit = DEFAULT_RECOVERY_LIMIT,
}: AgentQueuedTurnSchedulerDeps): AgentQueuedTurnScheduler {
  let timer: NodeJS.Timeout | undefined;
  let recovery: Promise<number> | undefined;

  const schedule = async (turn: AgentQueuedTurnRecord): Promise<string> => {
    const envelope = deliveryEnvelope(turn);
    const deliveryKey = getAgentTriggerIdempotencyKey(envelope);
    const reserved = await runAsSystem(() =>
      methods.reserveAgentQueuedTurnDelivery({
        user: turn.user,
        ...(turn.tenantId != null && { tenantId: turn.tenantId }),
        conversationId: turn.conversationId,
        queuedTurnId: turn.queuedTurnId,
        deliveryKey,
      }),
    );
    if (reserved.outcome === 'conflict') {
      throw new Error('The queued turn delivery identity could not be reserved');
    }
    const receipt = await enqueue(envelope, {
      /** Queue sequence in Mongo is the sole conversation-ordering authority.
       * A lane per durable row prevents a later published delivery from
       * blocking recovery of an earlier record-first outbox row. */
      orderingKey: `agent-queued-turn-delivery:${turn.queuedTurnId}`,
      requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_QUEUED_TURN_V1,
    });
    if (receipt.deliveryKey !== deliveryKey) {
      throw new Error('The queued turn delivery identity changed during publication');
    }
    const marked = await runAsSystem(() =>
      methods.markQueuedTurnScheduled({
        user: turn.user,
        ...(turn.tenantId != null && { tenantId: turn.tenantId }),
        conversationId: turn.conversationId,
        queuedTurnId: turn.queuedTurnId,
        deliveryKey: receipt.deliveryKey,
        scheduledAt: new Date(),
      }),
    );
    if (marked.outcome === 'conflict') {
      throw new Error('The queued turn scheduling receipt could not be committed');
    }
    return receipt.deliveryKey;
  };

  const recover = (): Promise<number> => {
    if (recovery != null) {
      return recovery;
    }
    const task = (async () => {
      const reconciliationNow = new Date();
      const reconciliationClaimId = randomUUID();
      const [turns, quarantined] = await Promise.all([
        runAsSystem(() => methods.findQueuedTurnsNeedingDelivery(recoveryLimit)),
        runAsSystem(() =>
          methods.claimQueuedTurnsForAdmissionReconciliation({
            claimId: reconciliationClaimId,
            claimBy: PROCESS_CLAIM_OWNER,
            now: reconciliationNow,
            leaseUntil: new Date(reconciliationNow.getTime() + RECONCILIATION_LEASE_MS),
            limit: recoveryLimit,
          }),
        ),
      ]);
      let repaired = 0;
      for (const turn of quarantined) {
        const deliveryKey = turn.deliveryKey;
        if (
          deliveryKey == null ||
          turn.reconciliationClaimId !== reconciliationClaimId ||
          turn.reconciliationClaimBy !== PROCESS_CLAIM_OWNER
        ) {
          continue;
        }
        const defer = () =>
          runAsSystem(() =>
            methods.deferAgentQueuedTurnAdmissionReconciliation({
              user: turn.user,
              ...(turn.tenantId != null && { tenantId: turn.tenantId }),
              conversationId: turn.conversationId,
              queuedTurnId: turn.queuedTurnId,
              deliveryKey,
              claimId: reconciliationClaimId,
              claimBy: PROCESS_CLAIM_OWNER,
              availableAt: new Date(
                Date.now() + reconciliationBackoff(turn.reconciliationAttempts),
              ),
            }),
          );
        try {
          const isIndeterminate =
            turn.terminalReceipt?.outcome === 'dead' &&
            turn.terminalReceipt.failure?.code === 'ADMISSION_INDETERMINATE';
          if (turn.status === 'claimed' && !isIndeterminate) {
            const result = await runAsSystem(() =>
              methods.deadLetterAgentQueuedTurn({
                user: turn.user,
                ...(turn.tenantId != null && { tenantId: turn.tenantId }),
                conversationId: turn.conversationId,
                queuedTurnId: turn.queuedTurnId,
                deliveryKey,
                settledAt: new Date(),
                failure: {
                  code: 'ADMISSION_INDETERMINATE',
                  message: 'The queued turn provider admission owner disappeared',
                },
              }),
            );
            if (result.outcome === 'admission_indeterminate') {
              repaired += 1;
            }
            continue;
          }
          if (turn.admissionProtocolVersion === 2) {
            /** The provider may have been invoked before its Mongo receipt
             * became durable. Transient job evidence cannot decide that
             * boundary, so retain explicit indeterminate evidence and rotate
             * the work with bounded backoff until an exact late receipt or
             * operator reconciliation arrives. */
            await defer();
            continue;
          }
          const admissionEvidence = await getGenerationAdmissionEvidence(
            turn.user.toString(),
            deliveryKey,
            turn.conversationId,
            turn.conversationId,
          );
          if (admissionEvidence == null) {
            await defer();
            continue;
          }
          const settled = await runAsSystem(() =>
            methods.deadLetterAgentQueuedTurn({
              user: turn.user,
              ...(turn.tenantId != null && { tenantId: turn.tenantId }),
              conversationId: turn.conversationId,
              queuedTurnId: turn.queuedTurnId,
              deliveryKey,
              settledAt: new Date(),
              failure: turn.terminalReceipt?.failure ?? {
                code: 'ADMISSION_INDETERMINATE',
                message: 'The queued turn admission requires reconciliation',
              },
              admissionEvidence,
              reconciliationClaimId,
              reconciliationClaimBy: PROCESS_CLAIM_OWNER,
            }),
          );
          if (settled.outcome === 'admission_reconciled') {
            repaired += 1;
          }
        } catch (error) {
          await defer().catch(() => undefined);
          logger.warn(
            `[agentQueuedTurns] Failed to reconcile admission ${turn.queuedTurnId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      for (const turn of turns) {
        try {
          await schedule(turn);
          repaired += 1;
        } catch (error) {
          logger.warn(
            `[agentQueuedTurns] Failed to repair delivery ${turn.queuedTurnId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return repaired;
    })();
    recovery = task;
    void task.then(
      () => {
        if (recovery === task) {
          recovery = undefined;
        }
      },
      () => {
        if (recovery === task) {
          recovery = undefined;
        }
      },
    );
    return task;
  };

  return {
    schedule,
    recover,
    initialize: async () => {
      await runAsSystem(() => methods.ensureAgentQueuedTurnIndexes());
      timer = setInterval(() => {
        void recover().catch((error: unknown) => {
          logger.warn('[agentQueuedTurns] Delivery recovery pass failed', error);
        });
      }, recoveryIntervalMs);
      timer.unref?.();
      await recover().catch((error: unknown) => {
        logger.warn('[agentQueuedTurns] Initial delivery recovery pass failed', error);
      });
    },
    stop: async () => {
      if (timer != null) {
        clearInterval(timer);
        timer = undefined;
      }
      await recovery;
    },
  };
}

async function cancelAgentQueuedTurn(
  input: Parameters<AgentQueuedTurnMethods['cancelAgentQueuedTurn']>[0],
  deps: Pick<AgentQueuedTurnLifecycleDeps, 'methods' | 'retireDelivery' | 'getDelivery'>,
): ReturnType<AgentQueuedTurnMethods['cancelAgentQueuedTurn']> {
  const cancelled = await deps.methods.cancelAgentQueuedTurn(input);
  if (
    (cancelled.outcome !== 'cancelled' && cancelled.outcome !== 'already_cancelled') ||
    cancelled.turn.deliveryKey == null ||
    deps.retireDelivery == null
  ) {
    return cancelled;
  }
  const deliveryKey = cancelled.turn.deliveryKey;
  let retired = await deps.retireDelivery(
    deliveryKey,
    AGENT_QUEUED_TURN_SOURCE,
    'queued_turn_cancelled',
  );
  if (!retired) {
    retired = await deps.retireDelivery(
      deliveryKey,
      AGENT_QUEUED_TURN_SOURCE,
      'queued_turn_cancelled',
      { onlyIfDead: true },
    );
  }
  if (!retired && deps.getDelivery != null) {
    const fenced = await deps.methods.beginAgentQueuedTurnMissingDeliveryRetirement({
      deliveryKey,
    });
    if (fenced && (await deps.getDelivery(deliveryKey)) == null) {
      retired = await deps.methods.markAgentQueuedTurnMissingDeliveryRetired({ deliveryKey });
    }
  }
  if (retired) {
    await deps.methods.markAgentQueuedTurnDeliveryRetired({ deliveryKey });
  }
  return cancelled;
}

/** Owns the complete backend Agent queued-turn lifecycle while retaining
 * Mongo, trigger delivery, and generation execution as internal adapters. */
export function createAgentQueuedTurnLifecycle({
  methods,
  getGenerationJob,
  getGenerationAdmissionEvidence,
  enqueue,
  retireDelivery,
  getDelivery,
  now,
  claimBy,
  recoveryIntervalMs,
  recoveryLimit,
}: AgentQueuedTurnLifecycleDeps): AgentQueuedTurnLifecycle {
  const scheduler = createAgentQueuedTurnScheduler({
    methods,
    enqueue,
    getGenerationAdmissionEvidence,
    ...(recoveryIntervalMs != null && { recoveryIntervalMs }),
    ...(recoveryLimit != null && { recoveryLimit }),
  });
  return {
    prepareContinue: createAgentQueuedTurnResolver({
      methods,
      getGenerationJob,
      ...(now != null && { now }),
      ...(claimBy != null && { claimBy }),
    }),
    settleBeforeDeadLetter: createAgentQueuedTurnDeadLetterSettlement({
      methods,
      getGenerationAdmissionEvidence,
      ...(now != null && { now }),
    }),
    recordExecutionAdmission: (rawSource, input) =>
      settleAgentQueuedTurnExecutionAdmission(rawSource, input, methods),
    verifyExecutionAdmission: (rawSource, input) =>
      verifyAgentQueuedTurnExecutionAdmission(rawSource, input, methods),
    initialize: scheduler.initialize,
    stop: scheduler.stop,
    schedule: scheduler.schedule,
    cancel: (input) =>
      cancelAgentQueuedTurn(input, {
        methods,
        ...(retireDelivery != null && { retireDelivery }),
        ...(getDelivery != null && { getDelivery }),
      }),
    recover: scheduler.recover,
  };
}
