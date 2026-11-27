import { randomUUID } from 'node:crypto';
import {
  logger,
  AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
} from '@librechat/data-schemas';
import type {
  AgentEventActorDetachedAction,
  AgentTriggerDeliveryMethods,
  IAgentEventActorSuspensionEvidence,
} from '@librechat/data-schemas';
import type { EventActorInterrupt } from '@librechat/agents';
import type {
  AgentContinueTriggerEnvelope,
  AgentTriggerEnvelope,
  AgentTriggerExpectedAction,
} from './envelope';
import type { DetachedAgentEventActionStoreMode, SerializableJobData } from '~/stream';
import type { EventActorDetachedActionLifecycle } from '../handlers';
import type { AgentEventDetachedTerminalEvidence } from './types';
import { matchesExpectedAction } from './expectedAction';
import { createAgentTriggerEnvelope } from './envelope';

const MAX_TERMINAL_RESULT_LENGTH = 32_768;
const TERMINAL_PERSIST_RETRY_INITIAL_MS = 100;
const TERMINAL_PERSIST_RETRY_MAX_MS = 30_000;
const RESERVATION_RECOVERY_MS = 60_000;
const RUNNING_RECOVERY_MS = 30 * 60_000;
export const EVENT_ACTOR_DETACHED_COMPLETION_TYPE = 'librechat.event_actor.detached_completion';
export const EVENT_ACTOR_DETACHED_COMPLETION_SOURCE = 'librechat-event-actor';
const DETACHED_COMPLETION_INPUT =
  'Resume the suspended event actor with the detached tool completion supplied by the host.';

export function parseAgentEventDetachedTerminalEvidence(
  value: unknown,
): AgentEventDetachedTerminalEvidence | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const status = input.status;
  if (
    input.version !== 1 ||
    typeof input.deliveryKey !== 'string' ||
    input.deliveryKey.length === 0 ||
    input.deliveryKey.length > 128 ||
    !Number.isSafeInteger(input.generationCreatedAt) ||
    (input.generationCreatedAt as number) < 0 ||
    typeof input.taskId !== 'string' ||
    input.taskId.length === 0 ||
    input.taskId.length > 128 ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.idempotencyKey) ||
    (status !== 'succeeded' && status !== 'failed' && status !== 'cancelled') ||
    !Number.isSafeInteger(input.observedAt) ||
    (input.observedAt as number) < 0 ||
    (input.result != null &&
      (typeof input.result !== 'string' || input.result.length > MAX_TERMINAL_RESULT_LENGTH)) ||
    (input.error != null && (typeof input.error !== 'string' || input.error.length > 2_048)) ||
    (status === 'succeeded'
      ? typeof input.result !== 'string' || input.error != null
      : typeof input.error !== 'string' || input.result != null)
  ) {
    return undefined;
  }
  return {
    version: 1,
    deliveryKey: input.deliveryKey,
    generationCreatedAt: input.generationCreatedAt as number,
    taskId: input.taskId,
    idempotencyKey: input.idempotencyKey,
    status,
    ...(input.result == null ? {} : { result: input.result as string }),
    ...(input.error == null ? {} : { error: input.error as string }),
    observedAt: input.observedAt as number,
  };
}

export interface AgentEventActorDetachedCompletionProjection {
  version: 1;
  invocationId: string;
  /** Generation that owns the original delivery's detached-action record. */
  generationCreatedAt: number;
  /** Generation whose terminal handling enqueued this wake. */
  wakeGenerationCreatedAt: number;
  taskId: string;
  idempotencyKey: string;
}

export function parseAgentEventActorDetachedCompletion(
  value: unknown,
): AgentEventActorDetachedCompletionProjection | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    typeof input.invocationId !== 'string' ||
    input.invocationId.length === 0 ||
    input.invocationId.length > 128 ||
    !Number.isSafeInteger(input.generationCreatedAt) ||
    (input.generationCreatedAt as number) < 0 ||
    !Number.isSafeInteger(input.wakeGenerationCreatedAt) ||
    (input.wakeGenerationCreatedAt as number) < 0 ||
    typeof input.taskId !== 'string' ||
    input.taskId.length === 0 ||
    input.taskId.length > 128 ||
    typeof input.idempotencyKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.idempotencyKey)
  ) {
    return undefined;
  }
  return {
    version: 1,
    invocationId: input.invocationId,
    generationCreatedAt: input.generationCreatedAt as number,
    wakeGenerationCreatedAt: input.wakeGenerationCreatedAt as number,
    taskId: input.taskId,
    idempotencyKey: input.idempotencyKey,
  };
}

interface DetachedActionOwner {
  user: string;
  tenantId?: string;
  bindingId: string;
  conversationId: string;
  generationCreatedAt: number;
  turnCreatedAt: number;
  invocationId: string;
  expectedAction: AgentTriggerExpectedAction;
}

interface DetachedActionDependencies {
  reserveAgentEventActorDetachedAction: AgentTriggerDeliveryMethods['reserveAgentEventActorDetachedAction'];
  markAgentEventActorDetachedActionRunning: AgentTriggerDeliveryMethods['markAgentEventActorDetachedActionRunning'];
  settleAgentEventActorDetachedAction: AgentTriggerDeliveryMethods['settleAgentEventActorDetachedAction'];
  persistTerminalEvidence(input: AgentEventDetachedTerminalEvidence): Promise<void>;
  onTerminal(input: { taskId: string; idempotencyKey: string }): Promise<void>;
  waitForTerminalPersistenceRetry?(delayMs: number): Promise<void>;
  storeMode(): DetachedAgentEventActionStoreMode | undefined;
  now?(): Date;
}

function waitForTerminalPersistenceRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

export interface AgentEventActorInternalSuspension {
  kind: 'internal_completion';
  actionId: string;
  jobCreatedAt: number;
  interrupt: EventActorInterrupt;
}

export interface AgentEventActorDetachedActionLifecycle extends EventActorDetachedActionLifecycle {
  readSuspension(): AgentEventActorInternalSuspension | undefined;
}

export interface AgentEventActorDetachedResumeInput {
  streamId: string;
  job: SerializableJobData;
  handlingGenerationCreatedAt: number;
  suspension: IAgentEventActorSuspensionEvidence;
  action: AgentEventActorDetachedAction;
}

interface DetachedResumeDependencies {
  getAgentTriggerDelivery: AgentTriggerDeliveryMethods['getAgentTriggerDelivery'];
  enqueueAgentTrigger(
    envelope: AgentTriggerEnvelope,
    options?: { requiredWorkerCapability?: string },
  ): Promise<unknown>;
  requestId?(): string;
  now?(): number;
}

/** Builds the exact internal continuation in the typed trigger layer. The app
 * server supplies only persistence and dispatch composition dependencies. */
export function createAgentEventDetachedResumeHandler(deps: DetachedResumeDependencies) {
  const nextRequestId = deps.requestId ?? randomUUID;
  const now = deps.now ?? Date.now;
  return async ({
    job,
    action,
    handlingGenerationCreatedAt,
  }: AgentEventActorDetachedResumeInput): Promise<void> => {
    const delivery = await deps.getAgentTriggerDelivery(job.agentEventDeliveryKey as string);
    const envelope = delivery?.envelope as Partial<AgentContinueTriggerEnvelope> | undefined;
    if (
      delivery == null ||
      String(delivery.user) !== job.userId ||
      (delivery.tenantId ?? undefined) !== job.tenantId ||
      envelope?.mode !== 'continue' ||
      envelope.principal?.userId !== job.userId ||
      (envelope.principal?.tenantId ?? undefined) !== job.tenantId ||
      envelope.target?.bindingId !== job.agentEventBindingId ||
      envelope.target?.conversationId !== job.conversationId ||
      envelope.expectedAction?.toolName !== action.expectedToolName
    ) {
      throw new Error('Detached Event Actor completion owner is unavailable');
    }
    const target = envelope.target as AgentContinueTriggerEnvelope['target'];
    const receivedAt = now();
    const continuation = createAgentTriggerEnvelope({
      mode: 'continue',
      requestId: nextRequestId(),
      deliveryId: `detached_completion:${action.taskId}`,
      receivedAt,
      principal: {
        id: job.userId,
        ...(job.tenantId == null ? {} : { tenantId: job.tenantId }),
      },
      event: {
        id: action.taskId,
        type: EVENT_ACTOR_DETACHED_COMPLETION_TYPE,
        occurredAt: action.settledAt?.getTime() ?? action.observedAt.getTime(),
        source: { id: EVENT_ACTOR_DETACHED_COMPLETION_SOURCE, type: 'internal' },
        payload: {
          version: 1,
          invocationId: job.agentEventDeliveryKey as string,
          generationCreatedAt: handlingGenerationCreatedAt,
          wakeGenerationCreatedAt: job.createdAt,
          taskId: action.taskId,
          idempotencyKey: action.idempotencyKey,
        },
      },
      target,
      input: DETACHED_COMPLETION_INPUT,
      expectedAction: envelope.expectedAction,
    });
    await deps.enqueueAgentTrigger(continuation, {
      requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_DETACHED_ACTION_V1,
    });
  };
}

function serializeTerminalResult(value: unknown): string {
  let serialized: string;
  if (typeof value === 'string') {
    serialized = value;
  } else {
    try {
      serialized = JSON.stringify(value) ?? String(value);
    } catch {
      serialized = String(value);
    }
  }
  return serialized.slice(0, MAX_TERMINAL_RESULT_LENGTH);
}

/**
 * Binds the generic background executor to one delivery-owned expected action.
 * The delivery row remains authoritative; request-local state only lets the
 * actor adapter discover the exact launch that this segment already persisted.
 */
export function createAgentEventActorDetachedActionLifecycle(
  owner: DetachedActionOwner,
  deps: DetachedActionDependencies,
): AgentEventActorDetachedActionLifecycle {
  const now = deps.now ?? (() => new Date());
  const storeMode = deps.storeMode();
  let current: { taskId: string; idempotencyKey: string; launchAcknowledged: boolean } | undefined;
  const scope = {
    deliveryKey: owner.invocationId,
    user: owner.user,
    ...(owner.tenantId == null ? {} : { tenantId: owner.tenantId }),
    bindingId: owner.bindingId,
    conversationId: owner.conversationId,
    generationCreatedAt: owner.generationCreatedAt,
  };
  const matchesCurrent = (input: { taskId: string; idempotencyKey: string }): boolean =>
    current?.taskId === input.taskId && current.idempotencyKey === input.idempotencyKey;

  return {
    async reserve(input) {
      if (
        !matchesExpectedAction(
          {
            toolName: input.toolName,
            toolCallId: input.toolCallId,
            arguments: input.arguments,
          },
          owner.expectedAction,
        )
      ) {
        return { status: 'ignored' };
      }
      if (storeMode == null) {
        return {
          status: 'conflict',
          error:
            'Detached Event Actor production requires a compatible generation store; no external action was launched',
        };
      }
      const reservedAt = now();
      const reservation = await deps.reserveAgentEventActorDetachedAction({
        ...scope,
        turnId: input.turnId,
        invocationId: owner.invocationId,
        expectedToolName: owner.expectedAction.toolName,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        reservedAt,
        recoveryAfter: new Date(reservedAt.getTime() + RESERVATION_RECOVERY_MS),
      });
      if (reservation.status === 'conflict') {
        return {
          status: 'conflict',
          error: 'A different detached action already owns this Event Actor invocation',
        };
      }
      if (
        reservation.status === 'replay' &&
        ['succeeded', 'failed', 'cancelled'].includes(reservation.action.status)
      ) {
        return {
          status: 'terminal',
          taskId: reservation.action.taskId,
          idempotencyKey: reservation.action.idempotencyKey,
          outcome: reservation.action.status as 'succeeded' | 'failed' | 'cancelled',
          ...(reservation.action.result == null ? {} : { result: reservation.action.result }),
          ...(reservation.action.error == null ? {} : { error: reservation.action.error }),
        };
      }
      if (reservation.action.status === 'launch_indeterminate') {
        return {
          status: 'conflict',
          error:
            'The detached Event Actor launch outcome is indeterminate; exact terminal proof is required before this invocation can continue',
        };
      }
      if (reservation.status === 'replay') {
        if (
          matchesCurrent({
            taskId: reservation.action.taskId,
            idempotencyKey: reservation.action.idempotencyKey,
          })
        ) {
          return {
            status: 'replay',
            taskId: reservation.action.taskId,
            idempotencyKey: reservation.action.idempotencyKey,
          };
        }
        return {
          status: 'conflict',
          error:
            reservation.action.status === 'running'
              ? 'The detached Event Actor action was already launched by another executor'
              : 'The detached Event Actor launch acknowledgement is still pending',
        };
      }
      current = {
        taskId: reservation.action.taskId,
        idempotencyKey: reservation.action.idempotencyKey,
        launchAcknowledged: false,
      };
      return {
        status: reservation.status,
        taskId: current.taskId,
        idempotencyKey: current.idempotencyKey,
      };
    },
    async markRunning(input) {
      if (!matchesCurrent(input)) {
        return false;
      }
      const observedAt = now();
      const marked = await deps.markAgentEventActorDetachedActionRunning({
        ...scope,
        ...input,
        observedAt,
        recoveryAfter: new Date(observedAt.getTime() + RUNNING_RECOVERY_MS),
      });
      const accepted = marked.status !== 'conflict';
      if (accepted && current != null) {
        current.launchAcknowledged = true;
      }
      return accepted;
    },
    async settle(input) {
      if (!matchesCurrent(input)) {
        return false;
      }
      const observedAt = now();
      const evidence: AgentEventDetachedTerminalEvidence = {
        version: 1,
        deliveryKey: owner.invocationId,
        generationCreatedAt: owner.generationCreatedAt,
        taskId: input.taskId,
        idempotencyKey: input.idempotencyKey,
        status: input.status,
        ...(input.status === 'succeeded'
          ? { result: serializeTerminalResult(input.result) }
          : { error: String(input.error ?? 'Detached action failed').slice(0, 2_048) }),
        observedAt: observedAt.getTime(),
      };
      const waitForRetry = deps.waitForTerminalPersistenceRetry ?? waitForTerminalPersistenceRetry;
      let retryDelayMs = TERMINAL_PERSIST_RETRY_INITIAL_MS;
      let staged = false;
      for (;;) {
        try {
          if (!staged) {
            await deps.persistTerminalEvidence(evidence);
            staged = true;
          }
          const settled = await deps.settleAgentEventActorDetachedAction({
            ...scope,
            taskId: evidence.taskId,
            idempotencyKey: evidence.idempotencyKey,
            status: evidence.status,
            ...(evidence.result == null ? {} : { result: evidence.result }),
            ...(evidence.error == null ? {} : { error: evidence.error }),
            observedAt,
          });
          return settled.status !== 'conflict';
        } catch (error) {
          logger.warn('[event-actor] Retrying detached terminal evidence persistence', {
            taskId: input.taskId,
            retryDelayMs,
            error: error instanceof Error ? error.message : String(error),
          });
          await waitForRetry(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, TERMINAL_PERSIST_RETRY_MAX_MS);
        }
      }
    },
    async wake(input) {
      if (matchesCurrent(input)) {
        await deps.onTerminal(input);
      }
    },
    readSuspension() {
      if (current?.launchAcknowledged !== true) {
        return undefined;
      }
      return {
        kind: 'internal_completion',
        actionId: current.taskId,
        jobCreatedAt: owner.turnCreatedAt,
        interrupt: {
          id: current.taskId,
          payload: {
            type: 'event_actor_detached_action',
            taskId: current.taskId,
            idempotencyKey: current.idempotencyKey,
          },
        },
      };
    },
  };
}
