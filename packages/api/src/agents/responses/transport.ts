import { z } from 'zod';
import type { StoredResponseRecord, ResponseStorage } from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import type { BackgroundResponseQueueDependencies } from './queue';
import { mintBackgroundResponseWorkerToken, mintResponseResumeWorkerToken } from './worker';
import { AgentTriggerExecutionError } from '../triggers/host';

export interface BackgroundResponseTransportDependencies {
  storage: ResponseStorage;
  getOrigin: () => string;
  signingSecret: () => string;
  acknowledgementTimeoutMs: (record: StoredResponseRecord) => Promise<number>;
  fetch?: (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => ReturnType<typeof globalThis.fetch>;
}

const acknowledgement = z.object({
  id: z.string(),
  object: z.literal('response'),
  model: z.string(),
  background: z.literal(true),
  store: z.literal(true),
  status: z.enum(['queued', 'in_progress', 'completed', 'cancelled', 'failed', 'incomplete']),
});

export function createBackgroundResponseTransport(
  deps: BackgroundResponseTransportDependencies,
): BackgroundResponseQueueDependencies['execute'] {
  return createResponseWorkerTransport(deps);
}

/** A consumed approval alone is not proof that its selected provider attempt started. */
export function createResponseResumeTransport(
  deps: BackgroundResponseTransportDependencies & {
    jobs: Pick<GenerationJobManagerClass, 'getJob'>;
  },
): BackgroundResponseQueueDependencies['execute'] {
  return createResponseWorkerTransport(deps, deps.jobs);
}

/** Only the capable local replica may execute this queue delivery, through Responses ingress. */
function createResponseWorkerTransport(
  deps: BackgroundResponseTransportDependencies,
  resumeJobs?: Pick<GenerationJobManagerClass, 'getJob'>,
): BackgroundResponseQueueDependencies['execute'] {
  async function receipt(record: StoredResponseRecord, current: StoredResponseRecord | null) {
    if (current?.generationCreatedAt == null) return;
    if (!resumeJobs)
      return { status: 'resumed' as const, generationCreatedAt: current.generationCreatedAt };
    if (
      !record.resume ||
      current.generationCreatedAt !== record.generationCreatedAt ||
      current.resume?.intentId !== record.resume.intentId ||
      current.resume.providerExecutionId !== record.resume.providerExecutionId ||
      current.sourceKeyId !== record.sourceKeyId ||
      current.agentId !== record.agentId ||
      current.conversationId !== record.conversationId
    )
      return;
    const identity = { generationCreatedAt: current.generationCreatedAt };
    if (['completed', 'failed', 'incomplete', 'cancelled'].includes(current.status))
      return { ...identity, status: 'settled' as const };
    if (current.resume.state !== 'admitted') return;
    const job = await resumeJobs.getJob(record.responseId);
    if (
      !job ||
      job.createdAt !== current.generationCreatedAt ||
      job.metadata.userId !== current.userId ||
      job.metadata.tenantId !== current.tenantId ||
      job.metadata.agent_id !== current.agentId ||
      job.metadata.conversationId !== current.conversationId ||
      job.metadata.responseMessageId !== current.responseId ||
      job.metadata.endpoint !== 'responses' ||
      job.metadata.providerExecutionId !== current.resume.providerExecutionId ||
      job.metadata.providerExecutionStartedId !== current.resume.providerExecutionId ||
      !job.metadata.providerExecutionOwnerId
    )
      return;
    return { ...identity, status: 'resumed' as const };
  }
  return async (
    record: StoredResponseRecord,
    signal?: AbortSignal,
  ): Promise<{
    status: 'started' | 'resumed' | 'settled';
    generationCreatedAt?: number;
  }> => {
    const origin = new URL(deps.getOrigin());
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(origin.hostname)
    )
      throw new Error('Background Responses requires the capable local listener');
    const timeoutMs = await deps.acknowledgementTimeoutMs(record);
    const timeout = AbortSignal.timeout(timeoutMs);
    const token = resumeJobs
      ? mintResponseResumeWorkerToken(record, deps.signingSecret())
      : mintBackgroundResponseWorkerToken(record, deps.signingSecret());
    let response: globalThis.Response;
    try {
      response = await (deps.fetch ?? globalThis.fetch)(
        new URL('/api/agents/v1/responses', origin),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'x-lc-response-worker': '1',
          },
          body: '{}',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
      );
    } catch {
      const current = await deps.storage.read(record, record.responseId);
      const confirmed = await receipt(record, current);
      if (confirmed) return confirmed;
      throw new AgentTriggerExecutionError(
        'Background response admission acknowledgement unavailable',
        {
          mode: 'fire',
          certainty: 'ambiguous',
          retryable: true,
          code: 'response_acknowledgement_unavailable',
        },
      );
    }
    const current = await deps.storage.read(record, record.responseId);
    const confirmed = await receipt(record, current);
    if (response.status === 409 && confirmed) {
      await response.body?.cancel();
      return confirmed;
    }
    if (resumeJobs && response.status === 409) {
      await response.body?.cancel();
      throw new AgentTriggerExecutionError('Response resume start acknowledgement unavailable', {
        mode: 'fire',
        certainty: 'ambiguous',
        retryable: true,
        code: 'response_resume_start_unconfirmed',
      });
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new AgentTriggerExecutionError('Background response admission rejected', {
        mode: 'fire',
        certainty: response.status >= 500 ? 'ambiguous' : 'definite',
        retryable: response.status >= 500 || response.status === 429,
        code: 'response_admission_rejected',
        status: response.status,
      });
    }
    const body = acknowledgement.safeParse(await response.json().catch(() => null));
    if (
      !body.success ||
      body.data.id !== record.responseId ||
      body.data.model !== record.agentId ||
      !confirmed
    )
      throw new AgentTriggerExecutionError(
        'Background response acknowledgement identity unavailable',
        {
          mode: 'fire',
          certainty: 'ambiguous',
          retryable: true,
          code: 'response_acknowledgement_invalid',
        },
      );
    return resumeJobs ? confirmed : { ...confirmed, status: 'started' };
  };
}
