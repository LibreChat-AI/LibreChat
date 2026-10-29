import {
  AGENT_TRIGGER_WORKER_CAPABILITY_RESPONSES_V2,
  AGENT_TRIGGER_WORKER_CAPABILITY_RESPONSES_RESUME_V1,
} from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { AgentTriggerExecutionHost } from '../triggers/host';
import type { AgentTriggerEnvelope } from '../triggers/envelope';
import type { AgentTriggerService } from '../triggers/service';
import {
  createAgentTriggerEnvelope,
  getAgentTriggerIdempotencyKey,
  parseAgentTriggerEnvelope,
} from '../triggers/envelope';
import { prepareAgentTriggerDelivery } from '../triggers/delivery';
import { AgentTriggerExecutionError } from '../triggers/host';

export const BACKGROUND_RESPONSE_SOURCE = 'responses';
export const BACKGROUND_RESPONSE_RESUME_SOURCE = 'responses.resume';

/** A saved decision selects this identity once; HTTP/queue retries reuse it verbatim. */
export function createResponseResumeEnvelope(record: StoredResponseRecord): AgentTriggerEnvelope {
  const intent = record.resume;
  if (!intent || record.generationCreatedAt == null)
    throw new Error('Response resume intent is unavailable');
  const identity = `${record.responseId}:resume:${intent.intentId}`;
  return createAgentTriggerEnvelope({
    mode: 'fire',
    requestId: identity,
    deliveryId: identity,
    receivedAt: intent.reservedAt,
    principal: { id: record.userId, tenantId: record.tenantId },
    target: { agentId: record.agentId },
    run: { conversationId: record.conversationId },
    event: {
      id: intent.intentId,
      type: 'response.resume',
      occurredAt: intent.reservedAt,
      source: { id: record.responseId, type: BACKGROUND_RESPONSE_RESUME_SOURCE },
    },
    input: 'Resume the saved Responses checkpoint.',
  });
}

/** Install only when this host implements same-checkpoint resume, never as a chat fallback. */
export function createResponseResumeQueue(
  deps: Omit<BackgroundResponseQueueDependencies, 'execute'> & {
    /** Admit only the saved intent's provider segment within its original generation epoch. */
    resume: BackgroundResponseQueueDependencies['execute'];
  },
): BackgroundResponseQueue {
  const deliveryKey = (record: StoredResponseRecord) =>
    getAgentTriggerIdempotencyKey(createResponseResumeEnvelope(record));
  const dispatch: AgentTriggerExecutionHost['dispatch'] = async (input, options) => {
    const envelope = parseAgentTriggerEnvelope(input);
    const invalid = () =>
      new AgentTriggerExecutionError('Response resume authority changed', {
        mode: envelope.mode,
        certainty: 'definite',
        retryable: false,
        code: 'response_resume_authority_changed',
        status: 403,
      });
    if (
      envelope.event.source.type !== BACKGROUND_RESPONSE_RESUME_SOURCE ||
      envelope.mode !== 'fire'
    )
      throw invalid();
    const record = await deps.storage.read(envelope.principal, envelope.event.source.id);
    if (!record?.resume || !(await deps.authorize(record))) throw invalid();
    if (
      prepareAgentTriggerDelivery(envelope).fingerprint !==
      prepareAgentTriggerDelivery(createResponseResumeEnvelope(record)).fingerprint
    )
      throw invalid();
    const identity = {
      mode: 'fire' as const,
      conversationId: record.conversationId,
      streamId: record.responseId,
      responseMessageId: record.responseId,
      generationCreatedAt: record.generationCreatedAt,
    };
    // A persisted decision receipt survives cancellation; it must never restart the provider.
    if (
      record.cancellationRequestedAt != null ||
      ['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status)
    )
      return { ...identity, status: 'settled' };
    if (!['requires_action', 'in_progress'].includes(record.status)) throw invalid();
    const execution = await deps.resume(record, options?.signal);
    return { ...identity, ...execution };
  };
  return {
    deliveryKey,
    sourceDispatchers: new Map([
      [
        BACKGROUND_RESPONSE_RESUME_SOURCE,
        {
          workerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_RESPONSES_RESUME_V1,
          dispatch,
        },
      ],
    ]),
    async enqueue(record) {
      const envelope = createResponseResumeEnvelope(record);
      const receipt = await deps.enqueue(envelope, {
        orderingKey: `responses:${record.tenantId ?? '_'}:${record.userId}:${record.conversationId}`,
        requiredWorkerCapability: AGENT_TRIGGER_WORKER_CAPABILITY_RESPONSES_RESUME_V1,
      });
      if (receipt.deliveryKey !== getAgentTriggerIdempotencyKey(envelope))
        throw new Error('Response resume queue receipt identity changed');
    },
  };
}

/** The queue carries an immutable response reference, never credentials or a second request body. */
export function createBackgroundResponseEnvelope(
  record: StoredResponseRecord,
): AgentTriggerEnvelope {
  return createAgentTriggerEnvelope({
    mode: 'fire',
    requestId: record.responseId,
    deliveryId: record.responseId,
    receivedAt: record.createdAt.getTime(),
    principal: { id: record.userId, tenantId: record.tenantId },
    target: { agentId: record.agentId },
    run: { conversationId: record.conversationId },
    event: {
      id: record.responseId,
      type: 'response.create',
      occurredAt: record.createdAt.getTime(),
      source: { id: record.responseId, type: BACKGROUND_RESPONSE_SOURCE },
    },
    input: 'Execute the saved Responses request.',
  });
}

export function backgroundResponseDeliveryKey(record: StoredResponseRecord): string {
  return getAgentTriggerIdempotencyKey(createBackgroundResponseEnvelope(record));
}

export interface BackgroundResponseQueueDependencies {
  storage: ResponseStorage;
  enqueue: AgentTriggerService['enqueue'];
  authorize: (record: StoredResponseRecord) => Promise<boolean>;
  workerCapability?: string;
  /** Execute the persisted Responses payload with its exact stable identity.
   * Admission MUST be idempotent: a repeated delivery attaches rather than starting a second run.
   * The runtime also owns cancellation-before-start and already terminal reconciliation. */
  execute: (
    record: StoredResponseRecord,
    signal?: AbortSignal,
  ) => Promise<{
    status: 'started' | 'resumed' | 'settled';
    generationCreatedAt?: number;
  }>;
}

export interface BackgroundResponseQueue {
  deliveryKey: (record: StoredResponseRecord) => string;
  sourceDispatchers: ReadonlyMap<
    string,
    {
      workerCapability: string;
      dispatch: AgentTriggerExecutionHost['dispatch'];
    }
  >;
  enqueue: (record: StoredResponseRecord) => Promise<void>;
}

export function createBackgroundResponseQueue(
  deps: BackgroundResponseQueueDependencies,
): BackgroundResponseQueue {
  const dispatch: AgentTriggerExecutionHost['dispatch'] = async (input, options) => {
    const envelope = parseAgentTriggerEnvelope(input);
    const invalid = () =>
      new AgentTriggerExecutionError('Background response authority changed', {
        mode: envelope.mode,
        certainty: 'definite',
        retryable: false,
        code: 'response_authority_changed',
        status: 403,
      });
    if (envelope.event.source.type !== BACKGROUND_RESPONSE_SOURCE || envelope.mode !== 'fire')
      throw invalid();
    const record = await deps.storage.read(envelope.principal, envelope.event.source.id);
    if (!record || !(await deps.authorize(record))) throw invalid();
    const expected = createBackgroundResponseEnvelope(record);
    if (
      prepareAgentTriggerDelivery(envelope).fingerprint !==
        prepareAgentTriggerDelivery(expected).fingerprint ||
      record.deliveryKey !== backgroundResponseDeliveryKey(record)
    )
      throw invalid();
    if (['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status)) {
      return {
        mode: 'fire',
        status: 'settled',
        conversationId: record.conversationId,
        streamId: record.responseId,
        responseMessageId: record.responseId,
        generationCreatedAt: record.generationCreatedAt,
      };
    }
    const execution = await deps.execute(record, options?.signal);
    return {
      mode: 'fire',
      ...execution,
      conversationId: record.conversationId,
      streamId: record.responseId,
      responseMessageId: record.responseId,
    };
  };

  return {
    deliveryKey: backgroundResponseDeliveryKey,
    sourceDispatchers: new Map([
      [
        BACKGROUND_RESPONSE_SOURCE,
        {
          workerCapability: deps.workerCapability ?? AGENT_TRIGGER_WORKER_CAPABILITY_RESPONSES_V2,
          dispatch,
        },
      ],
    ]),
    async enqueue(record: StoredResponseRecord) {
      if (record.deliveryKey !== backgroundResponseDeliveryKey(record))
        throw new Error('Response queue identity changed');
      const receipt = await deps.enqueue(createBackgroundResponseEnvelope(record), {
        orderingKey: `responses:${record.tenantId ?? '_'}:${record.userId}:${record.conversationId}`,
        requiredWorkerCapability:
          deps.workerCapability ?? AGENT_TRIGGER_WORKER_CAPABILITY_RESPONSES_V2,
      });
      if (receipt.deliveryKey !== record.deliveryKey)
        throw new Error('Response queue receipt identity changed');
    },
  };
}
