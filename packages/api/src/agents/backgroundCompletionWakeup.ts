import { randomUUID } from 'node:crypto';
import { backgroundResultMetadata, isEphemeralAgentId } from 'librechat-data-provider';
import {
  AGENT_BACKGROUND_TOOL_RESULT_STORAGE_MAX_CHARS,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3,
  AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
} from '@librechat/data-schemas';
import type {
  AgentTriggerProducerLeaseStatus,
  AgentTriggerDeliveryMethods,
  ConversationMethods,
  IMessage,
  MessageMethods,
} from '@librechat/data-schemas';
import type {
  BackgroundToolDeadClaimRecovery,
  PendingBackgroundCompletion,
  BackgroundToolWakeupAdmission,
  BackgroundToolWakeupRegistration,
  BackgroundToolWakeupRetireOptions,
  PendingBackgroundCompletionControls,
} from './backgroundCompletion';
import type {
  AgentTriggerContinuePreparation,
  AgentTriggerExecutionHostDeps,
} from './triggers/host';
import type { AgentContinueTriggerEnvelope } from './triggers/envelope';
import type { AgentTriggerDispatchContext } from './triggers/dispatch';
import type { AgentTriggerEnqueueOptions } from './triggers/delivery';
import { WAITING_RETRY_CAP_MS, waitingRetryAfter } from './triggers/backoff';
import { BACKGROUND_TOOL_PRODUCER_LEASE_MS } from './backgroundCompletion';
import { SUBAGENT_COMPLETION_SOURCE } from './subagentCompletionWakeup';
import { createAgentTriggerEnvelope } from './triggers/envelope';
import { AgentTriggerExecutionError } from './triggers/host';
import { truncateMiddle } from '~/utils';

const WAKEUP_ADMISSION_DELAY_MS = 250;
const MAX_WAKEUP_RESULT_CHARS = 24 * 1024;
export const BACKGROUND_TOOL_WAKEUP_INPUT_MAX_CHARS: number = 16 * 1024;
const MESSAGE_SELECT = 'messageId parentMessageId isCreatedByUser createdAt';
export const BACKGROUND_TOOL_COMPLETION_SOURCE = 'background-tool-completion';
const EVENT_TYPE = 'background-tool.completion';

export type EnqueueBackgroundToolCompletion = (
  envelope: unknown,
  options?: AgentTriggerEnqueueOptions,
) => Promise<{ deliveryKey: string }>;

export type RetireBackgroundToolCompletion = (
  deliveryKey: string,
  sourceId: string,
  reason: string,
  options?: BackgroundToolWakeupRetireOptions,
) => Promise<boolean>;

export type RenewBackgroundToolCompletionProducerLease = (
  deliveryKey: string,
  sourceId: string,
  leaseUntil: Date,
) => Promise<boolean>;

export type PersistBackgroundToolCompletionResult = (
  deliveryKey: string,
  sourceId: string,
  result: {
    status: 'completed' | 'error' | 'cancelled';
    output: string;
    settledAt: Date;
  },
) => Promise<boolean>;

type WakeupMethods = Pick<ConversationMethods, 'getConvo'> &
  Pick<
    MessageMethods,
    'getMessages' | 'claimBackgroundToolResults' | 'releaseBackgroundToolResultClaims'
  > & {
    getAgentTriggerDeliveryProducerLease(params: {
      deliveryKey: string;
      sourceId: string;
      now: Date;
    }): Promise<AgentTriggerProducerLeaseStatus>;
    getAgentBackgroundToolResult?(params: { deliveryKey: string; sourceId: string }): Promise<{
      status: 'completed' | 'error' | 'cancelled';
      output: string;
      settledAt: Date;
    } | null>;
    persistAgentBackgroundToolResult?: AgentTriggerDeliveryMethods['persistAgentBackgroundToolResult'];
    beginAgentBackgroundToolResultBatchDispatch?: AgentTriggerDeliveryMethods['beginAgentBackgroundToolResultBatchDispatch'];
    claimAgentBackgroundToolResultBatch?: AgentTriggerDeliveryMethods['claimAgentBackgroundToolResultBatch'];
    confirmAgentBackgroundToolResultBatch?: AgentTriggerDeliveryMethods['confirmAgentBackgroundToolResultBatch'];
    claimAgentBackgroundToolResults?: AgentTriggerDeliveryMethods['claimAgentBackgroundToolResults'];
    getAgentBackgroundToolResultClaim?: AgentTriggerDeliveryMethods['getAgentBackgroundToolResultClaim'];
    releaseAgentBackgroundToolResultClaims?: AgentTriggerDeliveryMethods['releaseAgentBackgroundToolResultClaims'];
  };

interface GenerationState {
  status?: unknown;
  metadata?: {
    idempotencyClientRequestId?: unknown;
    responseMessageId?: unknown;
    terminalPersistencePending?: unknown;
  };
}

export interface BackgroundToolCompletionWakeupResolverDeps {
  methods: WakeupMethods;
  getGenerationJob: (conversationId: string) => Promise<GenerationState | null>;
  getResultBatchSize?: () => number | undefined;
  recoverDeadClaim?: BackgroundToolDeadClaimRecovery;
  getGenerationAdmissionEvidence?: (
    userId: string,
    clientRequestId: string,
    streamId: string,
    conversationId?: string,
  ) => Promise<{ generationId: string; generationCreatedAt: number } | null>;
  /** Longest a waiting delivery re-checks readiness; the backoff default otherwise. */
  getWaitMaxIntervalMs?: () => number | undefined;
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

function payloadRegistration(
  envelope: AgentContinueTriggerEnvelope,
): Pick<BackgroundToolWakeupRegistration, 'taskId' | 'toolCallId' | 'toolName'> | null | undefined {
  if (
    envelope.event.source.type !== 'internal' ||
    envelope.event.source.id !== BACKGROUND_TOOL_COMPLETION_SOURCE ||
    envelope.event.type !== EVENT_TYPE
  ) {
    return;
  }
  const payload = envelope.event.payload;
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const { taskId, toolCallId, toolName } = payload;
  if (
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > 256 ||
    typeof toolCallId !== 'string' ||
    toolCallId.length === 0 ||
    toolCallId.length > 256 ||
    typeof toolName !== 'string' ||
    toolName.length === 0 ||
    toolName.length > 256
  ) {
    return null;
  }
  return { taskId, toolCallId, toolName };
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

function timestamp(message: Pick<IMessage, 'createdAt'>): number {
  const value = message.createdAt;
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = value == null ? Number.NaN : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

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

function fitWakeupResult(output: string, serializedBudget: number): string {
  if (serializedBudget <= 0 || output.length === 0) {
    return '';
  }
  let low = 0;
  let high = Math.min(output.length, MAX_WAKEUP_RESULT_CHARS);
  let fitted = '';
  while (low <= high) {
    const limit = Math.floor((low + high) / 2);
    const candidate = truncateMiddle(output, limit);
    /** The aggregate limit applies after JSON escaping, not just to raw tool
     * text. Subtract the empty string's two quote characters because the
     * fixed payload budget below already includes `result: ""`. */
    const cost = JSON.stringify(candidate).length - 2;
    if (cost <= serializedBudget) {
      fitted = candidate;
      low = limit + 1;
    } else {
      high = limit - 1;
    }
  }
  return fitted;
}

function buildWakeupInput(
  results: Array<{
    taskId: string;
    toolCallId: string;
    toolName: string;
    status: 'completed' | 'error' | 'cancelled';
    output: string;
  }>,
): string {
  const header =
    results.length === 1
      ? 'A background tool task has finished. Continue using its durable result below.'
      : `${results.length} background tool tasks have finished. Continue using their durable results below.`;
  const payload = results.map(backgroundResultMetadata);
  let remaining = Math.max(
    0,
    BACKGROUND_TOOL_WAKEUP_INPUT_MAX_CHARS - header.length - 1 - JSON.stringify(payload).length,
  );
  for (let index = 0; index < results.length; index++) {
    const slots = results.length - index;
    const share = Math.floor(remaining / slots);
    const fitted = fitWakeupResult(results[index]?.output ?? '', share);
    payload[index]!.result = fitted;
    remaining -= JSON.stringify(fitted).length - 2;
  }
  return `${header}\n${JSON.stringify(payload)}`;
}

/** Resolves a pre-registered delivery only after its result is durably
 * readable. The message claim elects automatic delivery against manual polls
 * and returns a bounded sibling batch for the continuation input. */
export function createBackgroundToolCompletionWakeupResolver({
  methods,
  getGenerationJob,
  getResultBatchSize,
  getWaitMaxIntervalMs,
  recoverDeadClaim,
  getGenerationAdmissionEvidence,
}: BackgroundToolCompletionWakeupResolverDeps): NonNullable<
  AgentTriggerExecutionHostDeps['prepareContinue']
> {
  const waitingRetry = (receivedAt: number): string =>
    waitingRetryAfter(receivedAt, Date.now(), getWaitMaxIntervalMs?.() ?? WAITING_RETRY_CAP_MS);
  const resolve = async (
    envelope: AgentContinueTriggerEnvelope,
    context: AgentTriggerDispatchContext,
  ): Promise<AgentTriggerContinuePreparation | undefined> => {
    const registration = payloadRegistration(envelope);
    if (registration === undefined) {
      return;
    }
    if (registration === null) {
      throw executionError('The background tool completion payload is invalid.', {
        code: 'INVALID_BACKGROUND_TOOL_WAKEUP',
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
    const parent = await methods.getConvo(userId, envelope.target.conversationId);
    if (parent == null || parent.tenantId !== envelope.principal.tenantId) {
      throw executionError('The parent conversation is no longer available.', {
        code: 'PARENT_NOT_FOUND',
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
    const batchScope = {
      deliveryKey: context.idempotencyKey,
      sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
      userId,
      ...(envelope.principal.tenantId != null && { tenantId: envelope.principal.tenantId }),
      conversationId: envelope.target.conversationId,
      parentMessageId: envelope.target.parentMessageId,
      agentId: envelope.target.agentId,
      ...(context.deliveryClaimToken != null && { deliveryClaimToken: context.deliveryClaimToken }),
    };
    const batch =
      context.requiredWorkerCapability != null &&
      context.requiredWorkerCapability !==
        AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3
        ? undefined
        : await methods.claimAgentBackgroundToolResultBatch?.({
            ...batchScope,
            limit: getResultBatchSize?.() ?? 8,
            maxMetadataChars: BACKGROUND_TOOL_WAKEUP_INPUT_MAX_CHARS - 256,
          });
    if (batch?.status === 'claimed') {
      if (batch.ownerStatus === 'applied') return { status: 'settled' };
      if (batch.ownerStatus === 'recoverable') {
        await recoverDeadClaim?.({
          userId,
          conversationId: envelope.target.conversationId,
          messageId: envelope.target.parentMessageId,
          claimId: batch.claimId,
          batchId: batch.batchId,
        });
      }
      throw executionError('The background result is owned by another completion delivery.', {
        code: 'BACKGROUND_TOOL_BATCH_PENDING',
        retryable: true,
        deferWithoutAttempt: true,
        retryAfter: '1',
      });
    }
    if (batch?.status === 'not_ready') {
      if (batch.waitingForResult === true) {
        // A producer can fail its receipt write while its terminal message
        // projection succeeds. Reconstruct from that already-durable result.
        const projection = await methods.claimBackgroundToolResults({
          userId,
          conversationId: envelope.target.conversationId,
          messageId: envelope.target.parentMessageId,
          taskId: registration.taskId,
          agentId: envelope.target.agentId,
          kind: 'wakeup',
          claimId: context.idempotencyKey,
          limit: 1,
        });
        if (
          projection.status === 'claimed' &&
          projection.claim?.kind === 'manual' &&
          projection.claim.receiptReconciled === true
        )
          return { status: 'settled' };
        if (projection.status === 'acquired') {
          const result = projection.results.find((result) => result.taskId === registration.taskId);
          const releaseProjection = async (): Promise<void> => {
            if (
              !(await methods.releaseBackgroundToolResultClaims({
                userId,
                conversationId: envelope.target.conversationId,
                messageId: envelope.target.parentMessageId,
                taskIds: [registration.taskId],
                kind: 'wakeup',
                claimId: context.idempotencyKey,
                allowMissingMessage: true,
              }))
            ) {
              throw new Error('Background projection reconstruction release was not confirmed');
            }
          };
          let restored = false;
          try {
            if (result != null)
              restored =
                (await methods.persistAgentBackgroundToolResult?.({
                  deliveryKey: context.idempotencyKey,
                  sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
                  result: {
                    status: result.status,
                    output: truncateMiddle(
                      result.output,
                      AGENT_BACKGROUND_TOOL_RESULT_STORAGE_MAX_CHARS,
                    ),
                    settledAt: result.settledAt ?? new Date(envelope.event.occurredAt),
                  },
                })) === true;
          } finally {
            await releaseProjection();
          }
          if (restored) return resolve(envelope, context);
          throw executionError('The background result receipt is being reconstructed.', {
            code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
            retryable: true,
            deferWithoutAttempt: true,
            retryAfter: '1',
          });
        }
        if (
          projection.status === 'claimed' &&
          projection.claim?.kind === 'manual' &&
          projection.claim.generationId != null
        ) {
          await recoverDeadClaim?.({
            userId,
            conversationId: envelope.target.conversationId,
            messageId: envelope.target.parentMessageId,
            claimId: projection.claim.claimId,
            kind: 'manual',
            generationId: projection.claim.generationId,
            onlyIfUnreconciled: true,
          });
        }
        if (projection.status === 'claimed')
          throw executionError('The background projection is being reconciled.', {
            code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
            retryable: true,
            deferWithoutAttempt: true,
            retryAfter: '1',
          });

        const producer = await methods.getAgentTriggerDeliveryProducerLease({
          deliveryKey: context.idempotencyKey,
          sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
          now: new Date(),
        });
        if (producer.status === 'expired') {
          throw executionError('The process-local background tool executor was lost.', {
            code: 'BACKGROUND_TOOL_PRODUCER_LOST',
            retryable: false,
          });
        }
      }
      throw executionError('The background result batch is not durable yet.', {
        code: 'BACKGROUND_TOOL_RESULT_NOT_READY',
        retryable: true,
        deferWithoutAttempt: true,
        retryAfter: waitingRetry(envelope.receivedAt),
      });
    }
    if (batch?.status === 'acquired') {
      const owned = { ...batchScope, batchId: batch.batchId };
      const dispatchId = randomUUID();
      let dispatchBegan = false;
      const release = async (): Promise<boolean> => {
        const admitted = await getGenerationAdmissionEvidence?.(
          userId,
          context.idempotencyKey,
          envelope.target.conversationId,
          envelope.target.conversationId,
        );
        if (admitted != null) {
          await methods.confirmAgentBackgroundToolResultBatch?.(owned);
          return false;
        }
        // Absence is not proof. The storage CAS permits only a first definite
        // failure or a never-dispatched plan, never a retry of an ambiguous POST.
        const released = await methods.releaseAgentBackgroundToolResultClaims?.({
          sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
          userId,
          conversationId: envelope.target.conversationId,
          parentMessageId: envelope.target.parentMessageId,
          claimId: context.idempotencyKey,
          batchId: batch.batchId,
          ...(dispatchBegan && { dispatchId }),
          ...(context.deliveryClaimToken != null && {
            deliveryClaimToken: context.deliveryClaimToken,
          }),
        });
        return released === true;
      };
      // A receipt may precede its projection. Reconcile every member, not just
      // the root, against a concurrent manual poll or late message persistence.
      const projections = await Promise.all(
        batch.results.map((result) =>
          methods.claimBackgroundToolResults({
            userId,
            conversationId: envelope.target.conversationId,
            messageId: envelope.target.parentMessageId,
            taskId: result.taskId,
            agentId: envelope.target.agentId,
            kind: 'wakeup',
            claimId: context.idempotencyKey,
            batchId: batch.batchId,
            limit: 1,
          }),
        ),
      );
      if (
        projections.some(
          (projection) =>
            projection.status === 'claimed' || projection.status === 'outcome_unknown',
        )
      ) {
        for (let index = 0; index < projections.length; index++) {
          const stale = projections[index];
          if (stale?.status !== 'claimed' || stale.claim?.kind !== 'wakeup') continue;
          const taskId = batch.results[index]!.taskId;
          const receipt = await methods.getAgentBackgroundToolResultClaim?.({
            sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
            userId,
            conversationId: envelope.target.conversationId,
            parentMessageId: envelope.target.parentMessageId,
            taskId,
          });
          if (receipt?.claimId !== context.idempotencyKey || receipt.batchId !== batch.batchId)
            continue;
          await methods.releaseBackgroundToolResultClaims({
            userId,
            conversationId: envelope.target.conversationId,
            messageId: envelope.target.parentMessageId,
            taskIds: [taskId],
            kind: 'wakeup',
            claimId: stale.claim.claimId,
            ...(stale.claim.batchId != null && { batchId: stale.claim.batchId }),
            allowMissingMessage: true,
          });
          throw executionError('A stale background projection is being reconciled.', {
            code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
            retryable: true,
            deferWithoutAttempt: true,
            retryAfter: '1',
          });
        }
        const released = await release();
        const rootProjection =
          projections[batch.results.findIndex((result) => result.taskId === registration.taskId)];
        if (
          released &&
          rootProjection?.status === 'claimed' &&
          rootProjection.claim?.kind === 'manual' &&
          rootProjection.claim.receiptReconciled === true
        ) {
          return { status: 'settled' };
        }
        if (released && recoverDeadClaim != null) {
          await Promise.all(
            projections.map(async (projection) => {
              if (
                projection.status !== 'claimed' ||
                projection.claim?.kind !== 'manual' ||
                projection.claim.receiptReconciled === true ||
                projection.claim.generationId == null
              )
                return;
              await recoverDeadClaim({
                userId,
                conversationId: envelope.target.conversationId,
                messageId: envelope.target.parentMessageId,
                claimId: projection.claim.claimId,
                kind: 'manual',
                generationId: projection.claim.generationId,
                onlyIfUnreconciled: true,
              });
            }),
          );
        }
        throw executionError('Background result ownership is being reconciled.', {
          code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
          retryable: true,
          deferWithoutAttempt: true,
          retryAfter: '1',
        });
      }
      return {
        status: 'ready',
        parentMessageId,
        ...(parent.codeApprovalMode != null && { codeApprovalMode: parent.codeApprovalMode }),
        input: buildWakeupInput(batch.results),
        releaseOnDefiniteFailure: async () => {
          await release();
        },
        beginDispatch: async () => {
          dispatchBegan = true;
          if (
            !(await methods.beginAgentBackgroundToolResultBatchDispatch?.({ ...owned, dispatchId }))
          ) {
            throw executionError('The background batch preparation was superseded.', {
              code: 'BACKGROUND_TOOL_BATCH_SUPERSEDED',
              retryable: true,
              deferWithoutAttempt: true,
            });
          }
        },
        settleOnAdmission: async (result) => {
          if (
            result.status === 'settled' &&
            getGenerationAdmissionEvidence != null &&
            (await getGenerationAdmissionEvidence(
              userId,
              context.idempotencyKey,
              envelope.target.conversationId,
              envelope.target.conversationId,
            )) == null
          ) {
            throw new Error('A recovery fence does not prove background admission');
          }
          if (!(await methods.confirmAgentBackgroundToolResultBatch?.(owned))) {
            throw new Error('Background result batch admission was not confirmed');
          }
        },
      };
    }
    const claim = await methods.claimBackgroundToolResults({
      userId,
      conversationId: envelope.target.conversationId,
      messageId: envelope.target.parentMessageId,
      taskId: registration.taskId,
      agentId: envelope.target.agentId,
      kind: 'wakeup',
      claimId: context.idempotencyKey,
      limit: getResultBatchSize?.() ?? 8,
      maxMetadataChars: BACKGROUND_TOOL_WAKEUP_INPUT_MAX_CHARS - 256,
    });
    if (claim.status === 'claimed') {
      const receiptOwner = await methods.getAgentBackgroundToolResultClaim?.({
        sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
        userId,
        conversationId: envelope.target.conversationId,
        parentMessageId: envelope.target.parentMessageId,
        taskId: registration.taskId,
      });
      if (receiptOwner?.claimId === context.idempotencyKey) {
        const released = await methods.releaseAgentBackgroundToolResultClaims?.({
          sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
          userId,
          conversationId: envelope.target.conversationId,
          parentMessageId: envelope.target.parentMessageId,
          claimId: context.idempotencyKey,
        });
        if (released === false)
          throw new Error('Background receipt claim release was not confirmed');
        throw executionError('Background result ownership is being reconciled.', {
          code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
          retryable: true,
          deferWithoutAttempt: true,
          retryAfter: '1',
        });
      }
      return { status: 'settled' };
    }
    if (claim.status === 'outcome_unknown') {
      throw executionError('The process-local background tool outcome is unknown.', {
        code: 'BACKGROUND_TOOL_OUTCOME_UNKNOWN',
        retryable: false,
      });
    }
    if (claim.status === 'acquired') {
      const taskIds = claim.results.map((result) => result.taskId);
      const receiptOwner = await methods.getAgentBackgroundToolResultClaim?.({
        sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
        userId,
        conversationId: envelope.target.conversationId,
        parentMessageId: envelope.target.parentMessageId,
        taskId: registration.taskId,
      });
      if (receiptOwner != null && receiptOwner.claimId !== context.idempotencyKey) {
        const released = await methods.releaseBackgroundToolResultClaims({
          userId,
          conversationId: envelope.target.conversationId,
          messageId: envelope.target.parentMessageId,
          taskIds,
          kind: 'wakeup',
          claimId: context.idempotencyKey,
        });
        if (!released) throw new Error('Background projection claim release was not confirmed');
        return { status: 'settled' };
      }
      const input = buildWakeupInput(claim.results);
      return {
        status: 'ready',
        parentMessageId,
        ...(parent.codeApprovalMode != null && { codeApprovalMode: parent.codeApprovalMode }),
        input,
        releaseOnDefiniteFailure: async () => {
          const released = await methods.releaseBackgroundToolResultClaims({
            userId,
            conversationId: envelope.target.conversationId,
            messageId: envelope.target.parentMessageId,
            kind: 'wakeup',
            claimId: context.idempotencyKey,
          });
          if (!released) throw new Error('Background projection claim release was not confirmed');
          const receiptReleased = await methods.releaseAgentBackgroundToolResultClaims?.({
            sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
            userId,
            conversationId: envelope.target.conversationId,
            parentMessageId: envelope.target.parentMessageId,
            claimId: context.idempotencyKey,
          });
          if (receiptReleased === false)
            throw new Error('Background receipt claim release was not confirmed');
        },
      };
    }
    const receiptClaim = await methods.claimAgentBackgroundToolResults?.({
      deliveryKey: context.idempotencyKey,
      sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
      userId,
      conversationId: envelope.target.conversationId,
      parentMessageId: envelope.target.parentMessageId,
      agentId: envelope.target.agentId,
      claimId: context.idempotencyKey,
      limit: 1,
    });
    if (receiptClaim?.status === 'claimed') {
      return { status: 'settled' };
    }
    if (receiptClaim?.status === 'acquired') {
      /** Reconcile with a parent projection that may have appeared while the
       * receipt CAS was in flight. A manual poll that already owns the message
       * wins; otherwise stamp this same automatic owner before dispatch. */
      const projectedClaim = await methods.claimBackgroundToolResults({
        userId,
        conversationId: envelope.target.conversationId,
        messageId: envelope.target.parentMessageId,
        taskId: registration.taskId,
        agentId: envelope.target.agentId,
        kind: 'wakeup',
        claimId: context.idempotencyKey,
        limit: 1,
      });
      if (projectedClaim.status === 'claimed') {
        const released = await methods.releaseAgentBackgroundToolResultClaims?.({
          sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
          userId,
          conversationId: envelope.target.conversationId,
          parentMessageId: envelope.target.parentMessageId,
          claimId: context.idempotencyKey,
        });
        if (released === false)
          throw new Error('Background receipt claim release was not confirmed');
        throw executionError('Background result ownership is being reconciled.', {
          code: 'BACKGROUND_TOOL_CLAIM_RECONCILING',
          retryable: true,
          deferWithoutAttempt: true,
          retryAfter: '1',
        });
      }
      return {
        status: 'ready',
        parentMessageId,
        ...(parent.codeApprovalMode != null && { codeApprovalMode: parent.codeApprovalMode }),
        input: buildWakeupInput(receiptClaim.results),
        releaseOnDefiniteFailure: async () => {
          const projectionReleased = await methods.releaseBackgroundToolResultClaims({
            userId,
            conversationId: envelope.target.conversationId,
            messageId: envelope.target.parentMessageId,
            kind: 'wakeup',
            claimId: context.idempotencyKey,
          });
          if (projectedClaim.status === 'acquired' && !projectionReleased) {
            throw new Error('Background projection claim release was not confirmed');
          }
          const receiptReleased = await methods.releaseAgentBackgroundToolResultClaims?.({
            sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
            userId,
            conversationId: envelope.target.conversationId,
            parentMessageId: envelope.target.parentMessageId,
            claimId: context.idempotencyKey,
          });
          if (receiptReleased === false)
            throw new Error('Background receipt claim release was not confirmed');
        },
      };
    }
    const receipt =
      methods.claimAgentBackgroundToolResults == null
        ? await methods.getAgentBackgroundToolResult?.({
            deliveryKey: context.idempotencyKey,
            sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
          })
        : null;
    if (receipt != null) {
      return {
        status: 'ready',
        parentMessageId,
        ...(parent.codeApprovalMode != null && { codeApprovalMode: parent.codeApprovalMode }),
        input: buildWakeupInput([
          { ...registration, status: receipt.status, output: receipt.output },
        ]),
      };
    }
    let producerLease: AgentTriggerProducerLeaseStatus;
    try {
      producerLease = await methods.getAgentTriggerDeliveryProducerLease({
        deliveryKey: context.idempotencyKey,
        sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
        now: new Date(),
      });
    } catch (error) {
      throw executionError(
        `Background tool producer liveness is temporarily unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { code: 'BACKGROUND_TOOL_PRODUCER_STATE_UNAVAILABLE', retryable: true },
      );
    }
    if (producerLease.status === 'expired') {
      throw executionError('The process-local background tool executor was lost.', {
        code: 'BACKGROUND_TOOL_PRODUCER_LOST',
        retryable: false,
      });
    }
    /** A live lease proves the invocation or its durable persistence retry
     * still has an owner. Missing remains defer-only for compatibility with
     * completion rows admitted before producer leases existed. */
    throw executionError('The background tool result is not durable yet.', {
      code: 'BACKGROUND_TOOL_RESULT_NOT_READY',
      retryable: true,
      status: 409,
      retryAfter: waitingRetry(envelope.receivedAt),
      deferWithoutAttempt: true,
    });
  };
  return resolve;
}

/** Lists and discards a conversation's undelivered background completions from the
 * durable delivery store, which outlives the process-local task registry: a result
 * dispatched in an earlier turn, on another replica, or before a restart is still
 * going to arrive, and the owner must be able to see and stop that. */
export function createPendingBackgroundCompletions(deps: {
  list: (input: {
    user: string;
    conversationId: string;
    sourceId: string;
    taskId?: string;
  }) => Promise<{
    completions: Array<PendingBackgroundCompletion & { deliveryKey: string }>;
    dead: Array<PendingBackgroundCompletion & { deliveryKey: string }>;
    truncated: boolean;
  }>;
  listTaskIds: (input: {
    user: string;
    conversationId: string;
    sourceId: string;
  }) => Promise<{ taskIds: string[]; truncated: boolean }>;
  retire: RetireBackgroundToolCompletion;
}): PendingBackgroundCompletionControls {
  const read = (input: { userId: string; conversationId: string; taskId?: string }) =>
    deps.list({
      user: input.userId,
      conversationId: input.conversationId,
      sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
      ...(input.taskId != null && { taskId: input.taskId }),
    });
  return {
    list: async (input) => {
      const { completions, dead, truncated } = await read(input);
      const project = ({
        taskId,
        toolCallId,
        toolName,
        dispatchedAt,
        result,
        claimedByWakeup,
      }: PendingBackgroundCompletion): PendingBackgroundCompletion => ({
        taskId,
        toolCallId,
        toolName,
        dispatchedAt,
        ...(result != null && { result }),
        claimedByWakeup,
      });
      return {
        completions: completions.map(project),
        dead: dead.map(project),
        complete: !truncated,
      };
    },
    discard: async (input) => {
      const [completion] = (await read(input)).completions;
      if (completion == null) {
        return 'not_pending';
      }
      if (completion.result == null) {
        return 'running';
      }
      if (completion.claimedByWakeup) {
        return 'delivering';
      }
      /** Unclaimed-only: once a resolver owns the delivery its continuation can no
       * longer be withdrawn, so that race, including one it already finished,
       * reports as delivering rather than discarded. */
      const retired = await deps.retire(
        completion.deliveryKey,
        BACKGROUND_TOOL_COMPLETION_SOURCE,
        'background result discarded by its owner',
        { onlyIfUnclaimed: true, requireTransition: true },
      );
      return retired ? 'discarded' : 'delivering';
    },
    listSubagentWakeups: async (input) => {
      const { taskIds, truncated } = await deps.listTaskIds({
        user: input.userId,
        conversationId: input.conversationId,
        sourceId: SUBAGENT_COMPLETION_SOURCE,
      });
      return { taskIds, complete: !truncated };
    },
    settleClaimed: async (input) => {
      const [completion] = (await read(input)).completions;
      if (completion == null) {
        return false;
      }
      return deps.retire(
        completion.deliveryKey,
        BACKGROUND_TOOL_COMPLETION_SOURCE,
        'completion claimed by manual poll',
        { onlyIfUnclaimed: true },
      );
    },
  };
}

/** Pre-registers the ordered completion delivery before external tool work starts. */
export function createBackgroundToolCompletionWakeupHandler(
  enqueue: EnqueueBackgroundToolCompletion,
  retire: RetireBackgroundToolCompletion,
  renewProducerLease: RenewBackgroundToolCompletionProducerLease,
  persistResult?: PersistBackgroundToolCompletionResult,
  expedite?: (deliveryKey: string) => void,
  getReceiptBatchingEnabled?: () => boolean,
): (
  registration: BackgroundToolWakeupRegistration,
) => Promise<BackgroundToolWakeupAdmission | false> {
  return async (registration) => {
    const parentAgentId = registration.parentAgentId?.trim();
    if (parentAgentId == null || parentAgentId === '' || isEphemeralAgentId(parentAgentId)) {
      return false;
    }
    const envelope = createAgentTriggerEnvelope({
      mode: 'continue',
      requestId: randomUUID(),
      deliveryId: registration.taskId,
      receivedAt: Date.now(),
      principal: {
        id: registration.userId,
        ...(registration.tenantId == null ? {} : { tenantId: registration.tenantId }),
      },
      event: {
        id: registration.taskId,
        type: EVENT_TYPE,
        occurredAt: registration.createdAt,
        source: { id: BACKGROUND_TOOL_COMPLETION_SOURCE, type: 'internal' },
        payload: {
          taskId: registration.taskId,
          toolCallId: registration.toolCallId,
          toolName: registration.toolName,
        },
      },
      target: {
        agentId: parentAgentId,
        conversationId: registration.conversationId,
        parentMessageId: registration.parentMessageId,
      },
      input: 'A background tool task is waiting to complete.',
    });
    const admitted = await enqueue(envelope, {
      /** Pending work gets a task-local lane so a slow tool cannot block an
       * independently completed sibling. The generation admission fence and
       * atomic result claim serialize the actual continuations. */
      orderingKey: `background-tool-completion:${registration.conversationId}:${registration.taskId}`,
      availableAt: new Date(
        Math.max(Date.now(), registration.createdAt) + WAKEUP_ADMISSION_DELAY_MS,
      ),
      requiredWorkerCapability:
        getReceiptBatchingEnabled?.() === true
          ? AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_BATCH_V3
          : AGENT_TRIGGER_WORKER_CAPABILITY_BACKGROUND_COMPLETION_RECEIPT_V2,
      producerLeaseUntil: new Date(Date.now() + BACKGROUND_TOOL_PRODUCER_LEASE_MS),
    });
    return {
      renew: () =>
        renewProducerLease(
          admitted.deliveryKey,
          BACKGROUND_TOOL_COMPLETION_SOURCE,
          new Date(Date.now() + BACKGROUND_TOOL_PRODUCER_LEASE_MS),
        ),
      ...(persistResult == null
        ? {}
        : {
            persistResult: (result) =>
              persistResult(admitted.deliveryKey, BACKGROUND_TOOL_COMPLETION_SOURCE, result),
          }),
      retire: (reason, options) =>
        options == null
          ? retire(admitted.deliveryKey, BACKGROUND_TOOL_COMPLETION_SOURCE, reason)
          : retire(admitted.deliveryKey, BACKGROUND_TOOL_COMPLETION_SOURCE, reason, options),
      ...(expedite == null ? {} : { expedite: () => expedite(admitted.deliveryKey) }),
    };
  };
}

/** Reopens every result owned by one dead automatic batch. Generation state
 * first fences an admitted continuation that is still running/finalizing;
 * delivery retirement then proves no retry remains, and releasing by the
 * batch-root claim identity makes sibling recovery independent of which task
 * originally admitted that delivery. */
export function createBackgroundToolDeadClaimRecovery(
  retire: RetireBackgroundToolCompletion,
  releaseClaims: WakeupMethods['releaseBackgroundToolResultClaims'],
  getGenerationJob: (conversationId: string) => Promise<GenerationState | null | undefined>,
  fenceGenerationClaim: (input: {
    userId: string;
    conversationId: string;
    claimId: string;
  }) => Promise<'fenced' | 'started' | 'unavailable'>,
  releaseReceiptClaims?: AgentTriggerDeliveryMethods['releaseAgentBackgroundToolResultClaims'],
  batchRecovery?: Pick<
    AgentTriggerDeliveryMethods,
    'getAgentBackgroundToolResultBatch' | 'confirmAgentBackgroundToolResultBatch'
  >,
  getAdmissionEvidence?: BackgroundToolCompletionWakeupResolverDeps['getGenerationAdmissionEvidence'],
): BackgroundToolDeadClaimRecovery {
  return async ({
    userId,
    conversationId,
    messageId,
    claimId,
    kind,
    generationId,
    batchId,
    onlyIfUnreconciled,
  }) => {
    if (kind === 'manual') {
      if (generationId == null || generationId.length === 0) {
        return false;
      }
      const generation = await getGenerationJob(conversationId);
      if (generation?.metadata?.responseMessageId === generationId && isParentActive(generation)) {
        return false;
      }
      /** Releasing a dead manual DELIVERY only re-presents an already durable
       * terminal result. It never retries the completed tool mutation. */
      return releaseClaims({
        userId,
        conversationId,
        messageId,
        kind: 'manual',
        claimId,
        ...(onlyIfUnreconciled === true && { onlyIfUnreconciled }),
      });
    }
    const owner = {
      deliveryKey: claimId,
      sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
      userId,
      conversationId,
      parentMessageId: messageId,
    };
    const batch = await batchRecovery?.getAgentBackgroundToolResultBatch(owner);
    if (batchId != null && batch != null && batch.batchId !== batchId) return false;
    if (batch?.appliedAt != null) {
      await batchRecovery?.confirmAgentBackgroundToolResultBatch({
        ...owner,
        batchId: batch.batchId,
      });
      return false;
    }
    const confirmAdmission = async (): Promise<boolean> => {
      const evidence = await getAdmissionEvidence?.(
        userId,
        claimId,
        conversationId,
        conversationId,
      );
      if (evidence == null) return false;
      if (batch != null)
        await batchRecovery?.confirmAgentBackgroundToolResultBatch({
          ...owner,
          batchId: batch.batchId,
        });
      return true;
    };
    if (batch != null && (await confirmAdmission())) return false;
    const claimGenerationIsActive = async (): Promise<boolean> => {
      const generation = await getGenerationJob(conversationId);
      return (
        generation?.metadata?.idempotencyClientRequestId === claimId && isParentActive(generation)
      );
    };
    if (await claimGenerationIsActive()) {
      return false;
    }
    const retired = await retire(
      claimId,
      BACKGROUND_TOOL_COMPLETION_SOURCE,
      'dead background completion batch recovered by manual poll',
      { onlyIfDead: true },
    );
    if (!retired) {
      return false;
    }
    /** Retirement closes further delivery retries. The idempotency-claim CAS
     * closes the remaining claim-to-job-publication window: recovery either
     * installs a started tombstone that invalidates a delayed creator's token,
     * or observes that job creation already won. */
    const generationFence = await fenceGenerationClaim({ userId, conversationId, claimId });
    if (generationFence === 'unavailable') return false;
    if (generationFence === 'started' && batch != null) {
      // The native claim CAS proves admission even when a custom store cannot
      // read historical claims or the live generation has been cleaned up.
      await batchRecovery?.confirmAgentBackgroundToolResultBatch({
        ...owner,
        batchId: batch.batchId,
      });
      return false;
    }
    if (await claimGenerationIsActive()) {
      return false;
    }
    const receiptBatchId = batch?.batchId ?? batchId;
    const receiptReleased = await releaseReceiptClaims?.({
      sourceId: BACKGROUND_TOOL_COMPLETION_SOURCE,
      userId,
      conversationId,
      parentMessageId: messageId,
      claimId,
      ...(receiptBatchId != null && { batchId: receiptBatchId }),
      recoveryFenced: true,
    });
    if (receiptReleased === false) return false;
    if (batch != null) return receiptReleased === true;
    return releaseClaims({
      userId,
      conversationId,
      messageId,
      allowMissingMessage: true,
      kind: 'wakeup',
      claimId,
      ...(receiptBatchId != null && { batchId: receiptBatchId }),
    });
  };
}
