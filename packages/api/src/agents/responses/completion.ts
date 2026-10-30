import { isDeepStrictEqual } from 'node:util';
import type {
  ResponseStorage,
  StoredResponseRecord,
  ResponseTerminalReceipt,
  ResponseMutationResult,
  ResponseCleanupIdentity,
} from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { responseTenantId } from './scope';

/** A retirement result carries cleanup authority only and must never render private output. */
export interface ResponseCompletionRecord extends StoredResponseRecord {
  retirement?: ResponseCleanupIdentity['retirement'];
}

export interface ResponseCompletion {
  finish(record: StoredResponseRecord): Promise<ResponseCompletionRecord>;
  stageAndFinish(
    record: StoredResponseRecord,
    receipt: ResponseTerminalReceipt,
  ): Promise<ResponseCompletionRecord>;
}

export interface ResponseCompletionDependencies {
  storage: ResponseStorage;
  cleanupCheckpoint: (record: StoredResponseRecord, namespace: string) => Promise<void>;
  releaseExecution?: (
    record: StoredResponseRecord,
    receipt?: ResponseTerminalReceipt,
  ) => Promise<void>;
}

function terminal(record: StoredResponseRecord): boolean {
  return ['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status);
}

type ExecutionReleaseIdentity = Pick<
  StoredResponseRecord,
  | 'userId'
  | 'tenantId'
  | 'responseId'
  | 'agentId'
  | 'conversationId'
  | 'generationCreatedAt'
  | 'expiredAt'
  | 'status'
> & {
  retirement?: ResponseCleanupIdentity['retirement'];
  resume?: Pick<NonNullable<StoredResponseRecord['resume']>, 'state' | 'providerExecutionId'>;
  review?: Pick<NonNullable<StoredResponseRecord['review']>, 'providerExecutionId'>;
};

/** Release transient provider proof only after its canonical terminal result is durable. */
export function createResponseExecutionRelease(
  jobs: Pick<GenerationJobManagerClass, 'getJob' | 'finishProviderTerminalPersistence'>,
): (
  record: ExecutionReleaseIdentity,
  receipt?: Pick<ResponseTerminalReceipt, 'providerExecutionId' | 'ownerId'>,
) => Promise<void> {
  return async (record, receipt) => {
    if (
      !['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status) &&
      !record.retirement &&
      !(record.expiredAt && record.expiredAt.getTime() <= Date.now())
    )
      throw new Error('Response terminal publication is unavailable');
    if (record.generationCreatedAt == null) return;
    const job = await jobs.getJob(record.responseId);
    if (!job) return;
    const expectedProvider =
      receipt?.providerExecutionId ??
      (record.resume?.state === 'admitted'
        ? record.resume.providerExecutionId
        : record.review?.providerExecutionId);
    if (
      job.createdAt !== record.generationCreatedAt ||
      job.metadata.userId !== record.userId ||
      responseTenantId(job.metadata.tenantId) !== responseTenantId(record.tenantId) ||
      job.metadata.agent_id !== record.agentId ||
      job.metadata.endpoint !== 'responses' ||
      job.metadata.responseMessageId !== record.responseId ||
      job.metadata.conversationId !== record.conversationId ||
      !['complete', 'error', 'aborted'].includes(job.status) ||
      job.metadata.providerDrained !== true ||
      !job.metadata.providerExecutionId ||
      (expectedProvider != null && job.metadata.providerExecutionId !== expectedProvider) ||
      (receipt != null && job.metadata.providerExecutionOwnerId !== receipt.ownerId)
    )
      throw new Error('Response terminal execution identity changed');
    const released = await jobs.finishProviderTerminalPersistence(
      record.responseId,
      record.generationCreatedAt,
      job.metadata.providerExecutionId,
      receipt?.ownerId ?? job.metadata.providerExecutionOwnerId,
    );
    if (!released) throw new Error('Response terminal execution release is unavailable');
  };
}

function assertReceipt(record: StoredResponseRecord, receipt: ResponseTerminalReceipt): void {
  let response: unknown;
  try {
    response = JSON.parse(receipt.responseJSON);
  } catch {
    throw new Error('Response terminal receipt is invalid');
  }
  if (
    receipt.generationCreatedAt !== record.generationCreatedAt ||
    !response ||
    typeof response !== 'object' ||
    !('id' in response) ||
    response.id !== record.responseId ||
    !('model' in response) ||
    response.model !== record.agentId ||
    !('status' in response) ||
    response.status !== receipt.status ||
    !('object' in response) ||
    response.object !== 'response' ||
    !('output' in response) ||
    !Array.isArray(response.output) ||
    (receipt.checkpointConfigJSON != null && !receipt.checkpointNamespace) ||
    !('background' in response) ||
    response.background !== true ||
    !('store' in response) ||
    response.store !== true
  )
    throw new Error('Response terminal receipt identity changed');
}

function sameExecution(
  previous: StoredResponseRecord,
  current: StoredResponseRecord,
  receipt: ResponseTerminalReceipt,
): boolean {
  const provider =
    current.resume?.state === 'admitted'
      ? current.resume.providerExecutionId
      : current.review?.providerExecutionId;
  return (
    current.userId === previous.userId &&
    responseTenantId(current.tenantId) === responseTenantId(previous.tenantId) &&
    current.responseId === previous.responseId &&
    current.agentId === previous.agentId &&
    current.sourceKeyId === previous.sourceKeyId &&
    current.conversationId === previous.conversationId &&
    current.generationCreatedAt === receipt.generationCreatedAt &&
    (provider == null || provider === receipt.providerExecutionId) &&
    isDeepStrictEqual(current.review, previous.review) &&
    isDeepStrictEqual(current.resume, previous.resume)
  );
}

/** Persist a post-drain result before cleanup, then retry only cleanup/publication, never execution. */
export function createResponseCompletion(deps: ResponseCompletionDependencies): ResponseCompletion {
  async function discardRetired(record: StoredResponseRecord, receipt: ResponseTerminalReceipt) {
    const identity = await deps.storage.readCleanupIdentity(record, record.responseId, {
      ...record,
      checkpointNamespace: receipt.checkpointNamespace,
      checkpointConfigJSON: receipt.checkpointConfigJSON,
    });
    if (
      !identity?.retirement &&
      !(identity?.expiredAt && identity.expiredAt.getTime() <= Date.now())
    )
      return null;
    const retired: ResponseCompletionRecord = {
      ...record,
      ...identity,
      retirement: identity.retirement ?? 'expired',
    };
    const namespace = identity.checkpointNamespace ?? receipt.checkpointNamespace;
    if (identity.requiresCheckpointCleanup && !namespace)
      throw new Error('Response checkpoint cleanup identity unavailable');
    if (namespace)
      await deps.cleanupCheckpoint(
        {
          ...retired,
          review: undefined,
          pendingTerminal: {
            ...receipt,
            checkpointNamespace: namespace,
            checkpointConfigJSON: identity.checkpointConfigJSON ?? receipt.checkpointConfigJSON,
          },
        },
        namespace,
      );
    await deps.releaseExecution?.(retired, receipt);
    return {
      ...retired,
      requestJSON: '',
      responseJSON: undefined,
      review: undefined,
      resume: undefined,
      pendingTerminal: undefined,
      status: receipt.status,
    };
  }
  async function finish(record: StoredResponseRecord): Promise<ResponseCompletionRecord> {
    const receipt = record.pendingTerminal;
    if (!receipt) {
      if (terminal(record)) await deps.releaseExecution?.(record);
      return record;
    }
    assertReceipt(record, receipt);
    if (receipt.checkpointNamespace)
      await deps.cleanupCheckpoint(record, receipt.checkpointNamespace);
    let current: StoredResponseRecord | null;
    try {
      const result = await deps.storage.finishTerminal(
        record,
        record.responseId,
        record.revision,
        receipt,
      );
      current = result.ok ? result.record : await deps.storage.read(record, record.responseId);
    } catch (error) {
      current = await deps.storage.read(record, record.responseId);
      if (!current) {
        const expired = await discardRetired(record, receipt);
        if (expired) return expired;
      }
      if (
        !current ||
        current.status !== receipt.status ||
        current.generationCreatedAt !== receipt.generationCreatedAt ||
        current.responseJSON !== receipt.responseJSON ||
        current.pendingTerminal
      )
        throw error;
    }
    if (!current) {
      const expired = await discardRetired(record, receipt);
      if (expired) return expired;
      throw new Error('Response terminal journal is unavailable');
    }
    if (terminal(current)) await deps.releaseExecution?.(current, receipt);
    return current;
  }
  return {
    finish,
    async stageAndFinish(
      record: StoredResponseRecord,
      receipt: ResponseTerminalReceipt,
    ): Promise<ResponseCompletionRecord> {
      assertReceipt(record, receipt);
      if (record.expiredAt && record.expiredAt.getTime() <= Date.now()) {
        const retired = await discardRetired(record, receipt);
        if (!retired) throw new Error('Response retirement identity unavailable');
        return retired;
      }
      let staged: ResponseMutationResult;
      try {
        staged = await deps.storage.stageTerminal(
          record,
          record.responseId,
          { execution: record },
          receipt,
        );
      } catch (error) {
        const current = await deps.storage.read(record, record.responseId);
        if (!current) {
          const expired = await discardRetired(record, receipt);
          if (expired) return expired;
        }
        const saved = current?.pendingTerminal;
        if (
          !current ||
          !saved ||
          saved.generationCreatedAt !== receipt.generationCreatedAt ||
          saved.providerExecutionId !== receipt.providerExecutionId ||
          saved.ownerId !== receipt.ownerId ||
          saved.responseJSON !== receipt.responseJSON ||
          saved.status !== receipt.status ||
          saved.checkpointNamespace !== receipt.checkpointNamespace ||
          saved.checkpointConfigJSON !== receipt.checkpointConfigJSON
        )
          throw error;
        return finish(current);
      }
      if (staged.ok) return finish(staged.record);
      const current = await deps.storage.read(record, record.responseId);
      if (!current) {
        const expired = await discardRetired(record, receipt);
        if (expired) return expired;
      }
      if (!current || !sameExecution(record, current, receipt))
        throw new Error('Response terminal receipt publication conflicted');
      if (terminal(current)) return finish(current);
      throw new Error('Response terminal receipt publication conflicted');
    },
  };
}
