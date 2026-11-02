import { isDeepStrictEqual } from 'node:util';
import { sameResponseTerminalReceipt } from '@librechat/data-schemas';
import type {
  ResponseStorage,
  StoredResponseRecord,
  ResponseTerminalReceipt,
  ResponseMutationResult,
  ResponseCleanupIdentity,
} from '@librechat/data-schemas';
import type { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { projectCanonicalResponseTurn } from './turnProjection';
import { responseTenantId } from './scope';

/** A retirement result carries cleanup authority only and must never render private output. */
export interface ResponseCompletionRecord extends StoredResponseRecord {
  retirement?: ResponseCleanupIdentity['retirement'];
}

export interface ResponseCompletion {
  prepare(
    record: StoredResponseRecord,
    receipt: ResponseTerminalReceipt,
  ): Promise<ResponseCompletionRecord>;
  finish(record: StoredResponseRecord): Promise<ResponseCompletionRecord>;
  stageAndFinish(
    record: StoredResponseRecord,
    receipt: ResponseTerminalReceipt,
  ): Promise<ResponseCompletionRecord>;
}

export interface ResponseCompletionDependencies {
  storage: ResponseStorage;
  cleanupCheckpoint: (record: StoredResponseRecord, namespace: string) => Promise<void>;
  /** A prepared result is a proposal; only exact canonical drain permits its promotion. */
  confirmExecution: (
    record: StoredResponseRecord,
    receipt: ResponseTerminalReceipt,
  ) => Promise<'complete' | 'error' | 'aborted' | null>;
  /** Required and idempotent: transient provider ownership survives until canonical publication. */
  releaseExecution: (
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

async function readExecutionJob(
  jobs: Pick<GenerationJobManagerClass, 'getJob'>,
  record: ExecutionReleaseIdentity,
  receipt?: Pick<ResponseTerminalReceipt, 'providerExecutionId' | 'ownerId'>,
) {
  if (record.generationCreatedAt == null) return null;
  const job = await jobs.getJob(record.responseId);
  if (!job) return null;
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
    !job.metadata.providerExecutionId ||
    (expectedProvider != null && job.metadata.providerExecutionId !== expectedProvider) ||
    (receipt != null && job.metadata.providerExecutionOwnerId !== receipt.ownerId)
  )
    throw new Error('Response terminal execution identity changed');
  return { job, providerExecutionId: job.metadata.providerExecutionId };
}

/** Candidate bytes and possession of a provider ID do not prove that execution drained. */
export function createResponseExecutionConfirmation(
  jobs: Pick<GenerationJobManagerClass, 'getJob'>,
): ResponseCompletionDependencies['confirmExecution'] {
  return async (record, receipt) => {
    const proof = await readExecutionJob(jobs, record, receipt);
    const job = proof?.job;
    if (
      !job ||
      job.metadata.providerDrained !== true ||
      job.status === 'running' ||
      job.status === 'requires_action'
    )
      return null;
    if (job.status !== 'complete' && job.status !== 'error' && job.status !== 'aborted')
      throw new Error('Response terminal execution outcome is unavailable');
    return job.status;
  };
}

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
    const proof = await readExecutionJob(jobs, record, receipt);
    if (!proof) return;
    const { job, providerExecutionId } = proof;
    if (
      !['complete', 'error', 'aborted'].includes(job.status) ||
      job.metadata.providerDrained !== true
    )
      throw new Error('Response terminal execution identity changed');
    const released = await jobs.finishProviderTerminalPersistence(
      record.responseId,
      record.generationCreatedAt,
      providerExecutionId,
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

function publishedReceipt(
  previous: StoredResponseRecord,
  current: StoredResponseRecord | null,
  receipt: ResponseTerminalReceipt,
): boolean {
  return (
    current != null &&
    sameExecution(previous, current, receipt) &&
    current.status === receipt.status &&
    current.responseJSON === receipt.responseJSON &&
    !current.pendingTerminal &&
    !current.preparedTerminal
  );
}

function redactRetirement(record: ResponseCompletionRecord): ResponseCompletionRecord {
  return {
    ...record,
    requestJSON: '',
    responseJSON: undefined,
    review: undefined,
    resume: undefined,
    pendingTerminal: undefined,
    preparedTerminal: undefined,
  };
}

/** Prepare durably before drain; only the completion owner may promote, clean up and publish. */
export function createResponseCompletion(deps: ResponseCompletionDependencies): ResponseCompletion {
  if (
    typeof deps.cleanupCheckpoint !== 'function' ||
    typeof deps.confirmExecution !== 'function' ||
    typeof deps.releaseExecution !== 'function'
  )
    throw new Error('Response completion confirmation, cleanup and release owners are unavailable');
  async function readRetirement(record: StoredResponseRecord, receipt: ResponseTerminalReceipt) {
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
    const retired: ResponseCompletionRecord & ResponseCleanupIdentity = {
      ...record,
      ...identity,
      retirement: identity.retirement ?? 'expired',
    };
    return retired;
  }
  async function discardRetired(record: StoredResponseRecord, receipt: ResponseTerminalReceipt) {
    const retired = await readRetirement(record, receipt);
    if (!retired) return null;
    const identity = retired;
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
    await deps.releaseExecution(retired, receipt);
    return {
      ...redactRetirement(retired),
      status: receipt.status,
    };
  }
  async function finish(record: StoredResponseRecord): Promise<ResponseCompletionRecord> {
    const authority = record.pendingTerminal ?? record.preparedTerminal;
    if (authority) {
      const retired = await readRetirement(record, authority);
      if (retired) {
        if (record.preparedTerminal && (await deps.confirmExecution(record, authority)) == null)
          return redactRetirement(retired);
        const discarded = await discardRetired(record, authority);
        if (discarded) return discarded;
      }
    } else {
      const identity = await deps.storage.readCleanupIdentity(record, record.responseId, record);
      if (identity?.retirement) {
        const retired = redactRetirement({ ...record, retirement: identity.retirement });
        if (terminal(record)) await deps.releaseExecution(retired);
        return retired;
      }
    }
    if (authority?.turnJSON != null && record.status !== 'materializing')
      throw new Error('Response private terminal phase is unavailable');
    const receipt = record.pendingTerminal;
    if (!receipt) {
      if (terminal(record)) {
        await deps.releaseExecution(record);
        return record;
      }
      const prepared = record.preparedTerminal;
      if (prepared) {
        assertReceipt(record, prepared);
        const outcome = await deps.confirmExecution(record, prepared);
        if (outcome == null) return record;
        const response = JSON.parse(prepared.responseJSON) as Record<string, unknown>;
        const cancelled = outcome === 'aborted' || record.cancellationRequestedAt != null;
        const failed = outcome === 'error' && prepared.status === 'completed';
        let status = prepared.status;
        if (cancelled) status = 'cancelled';
        else if (failed) status = 'failed';
        const responseJSON =
          status === prepared.status
            ? prepared.responseJSON
            : JSON.stringify({
                ...response,
                status,
                completed_at: Math.floor(Date.now() / 1000),
                error: cancelled
                  ? null
                  : {
                      type: 'server_error',
                      code: 'execution_failed',
                      message: 'The Agent could not complete this request.',
                    },
              });
        return stageAndFinish(record, { ...prepared, status, responseJSON }, prepared);
      }
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
        projectCanonicalResponseTurn(record, receipt),
      );
      current = result.ok ? result.record : await deps.storage.read(record, record.responseId);
    } catch (error) {
      current = await deps.storage.read(record, record.responseId);
      if (!current) {
        const expired = await discardRetired(record, receipt);
        if (expired) return expired;
      }
      if (!publishedReceipt(record, current, receipt)) throw error;
    }
    if (!current) {
      const expired = await discardRetired(record, receipt);
      if (expired) return expired;
      throw new Error('Response terminal journal is unavailable');
    }
    if (terminal(current)) await deps.releaseExecution(current, receipt);
    return current;
  }
  async function stageAndFinish(
    record: StoredResponseRecord,
    receipt: ResponseTerminalReceipt,
    prepared?: ResponseTerminalReceipt,
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
        prepared
          ? { receipt: prepared, cancellationRequestedAt: record.cancellationRequestedAt }
          : undefined,
      );
    } catch (error) {
      const current = await deps.storage.read(record, record.responseId);
      if (!current) {
        const expired = await discardRetired(record, receipt);
        if (expired) return expired;
      }
      if (current && publishedReceipt(record, current, receipt)) return finish(current);
      const saved = current?.pendingTerminal;
      if (
        !current ||
        !saved ||
        (receipt.turnJSON != null && current.status !== 'materializing') ||
        !sameExecution(record, current, receipt) ||
        !sameResponseTerminalReceipt(saved, receipt)
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
  }
  return {
    finish,
    stageAndFinish,
    async prepare(record, receipt) {
      assertReceipt(record, receipt);
      projectCanonicalResponseTurn(record, receipt);
      try {
        const staged = await deps.storage.prepareTerminal(
          record,
          record.responseId,
          { execution: record },
          receipt,
        );
        if (staged.ok) return staged.record;
      } catch (error) {
        const saved = await deps.storage.read(record, record.responseId);
        if (
          saved?.preparedTerminal &&
          (receipt.turnJSON == null || saved.status === 'materializing') &&
          sameExecution(record, saved, receipt) &&
          sameResponseTerminalReceipt(saved.preparedTerminal, receipt)
        )
          return saved;
        const retired = !saved ? await readRetirement(record, receipt) : null;
        if (retired) return redactRetirement(retired);
        throw error;
      }
      const saved = await deps.storage.read(record, record.responseId);
      if (
        saved?.preparedTerminal &&
        (receipt.turnJSON == null || saved.status === 'materializing') &&
        sameExecution(record, saved, receipt) &&
        sameResponseTerminalReceipt(saved.preparedTerminal, receipt)
      )
        return saved;
      const retired = !saved ? await readRetirement(record, receipt) : null;
      if (retired) return redactRetirement(retired);
      throw new Error('Response terminal preparation conflicted');
    },
  };
}
