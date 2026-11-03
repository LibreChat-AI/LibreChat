import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { DurableStorageConfig } from 'librechat-data-provider';
import type {
  ResponseExecutionBinding,
  ResponsePersistenceFailure,
  ResponseMutationResult,
  ResponseOwner,
  ResponseReference,
  ResponseCheckpointExecution,
  ResponseProviderExecution,
  ResponseReservation,
  StoredResponseRecord,
  StoredResponseStatus,
  ResponseReviewCheckpoint,
  ResponseResumeIntent,
  ResponseTerminalReceipt,
} from '~/models/response';
import type { ResponseTurnWrites, ResponseConversationWrites } from './responseTurn';
import type { ManagedTarget, CanonicalConversationTarget } from '~/types/managed';
import {
  prepareResponseRootStorage,
  publishResponseRoot,
  discardResponseRoot,
  assertResponseReservation,
  responseRootFilter,
  responseRootCleanupFilter,
} from './responseRoot';
import {
  responseScopeKeys,
  responseOwnerFilter,
  assertResponseErasureOwner,
  isResponseScopeClosed,
  initializeResponseScopes,
  createResponseRetention,
} from './responseScope';
import {
  sameResponseTerminalReceipt,
  responseReceiptKey,
  terminalReceipt,
  terminalFilter,
  assertResponseExecutionBinding,
} from '~/utils/receipt';
import {
  updateResponseDocument,
  responseReservationFits,
  RESPONSE_BUDGET_FIELDS,
} from './responseBudget';
import {
  readResponseConversationTarget,
  prepareResponseConversation,
} from './responseConversation';
import { retiredResponseUpdate, finishResponseErasure } from './responseErasure';
import { createResponseCheckpointStorage } from './responseCheckpoint';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { allocateManagedTarget, managedTargetFilter } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { createResponseFailureStorage } from './responseFailure';
import { reconcileErasedResponseTargets } from './registration';
import { createStoredResponseModel } from '~/models/response';
import { includeManagedAllocations } from '~/utils/managed';
import { activeExpirationFilter } from '~/utils/retention';
import { checkpointConfigKey } from '~/utils/checkpoint';
import { materializeResponseTurn } from './responseTurn';

export { sameResponseTerminalReceipt } from '~/utils/receipt';

export type {
  ResponseMutationResult,
  ResponseOwner,
  ResponseReservation,
  StoredResponseRecord,
  StoredResponseStatus,
  ResponseReviewCheckpoint,
  ResponseResumeIntent,
  ResponseTerminalReceipt,
} from '~/models/response';

export type ResponseReservationResult =
  | { ok: true; record: StoredResponseRecord; replayed: boolean }
  | { ok: false; code: 'idempotency_conflict' | 'response_unavailable' | 'document_limit' };

export type { ResponseExecutionBinding } from '~/models/response';

/** Internal drain identity only; expired requests, answers and decisions are never returned.
 * Stored rows include immutable request binding; older retained job identities may omit it. */
export type ResponseCleanupIdentity = Pick<
  StoredResponseRecord,
  | 'userId'
  | 'tenantId'
  | 'responseId'
  | 'agentId'
  | 'conversationId'
  | 'generationCreatedAt'
  | 'expiredAt'
  | 'storageTarget'
> &
  Partial<Pick<StoredResponseRecord, 'requestKey' | 'sourceKeyId' | 'parentMessageId'>> & {
    /** Cleanup authority only; never permission to read output or execute a provider. */
    retirement?: 'owner_deleted' | 'conversation_deleted' | 'expired';
    checkpointNamespace?: string;
    checkpointConfigJSON?: string;
    requiresCheckpointCleanup?: boolean;
  };

export interface ResponseResumeReservation
  extends Omit<ResponseResumeIntent, 'state' | 'reservedAt' | 'admittedAt'> {
  generationCreatedAt: number;
}

/** Replays are receipts, not permission to enqueue or execute terminal/cancelled runs. */
export type ResponseResumeResult =
  | { ok: true; record: StoredResponseRecord; replayed: boolean }
  | { ok: false; code: 'resume_conflict' | 'document_limit' };

/** Canonical execution writes are independent of polling's projection revision. */
export interface ResponseExecutionGuard {
  execution: Pick<
    StoredResponseRecord,
    | 'agentId'
    | 'sourceKeyId'
    | 'conversationId'
    | 'generationCreatedAt'
    | 'review'
    | 'resume'
    | 'storageTarget'
  >;
}

function responseReviewFilter(
  review: ResponseReviewCheckpoint | undefined,
): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (review) {
    const fields: Record<
      keyof ResponseReviewCheckpoint,
      ResponseReviewCheckpoint[keyof ResponseReviewCheckpoint]
    > = {
      actionId: review.actionId,
      providerExecutionId: review.providerExecutionId,
      expiresAt: review.expiresAt,
      partialResponseJSON: review.partialResponseJSON,
      visibleOutputTokens: review.visibleOutputTokens,
      pendingActionJSON: review.pendingActionJSON,
      checkpointConfigJSON: review.checkpointConfigJSON,
      checkpointId: review.checkpointId,
      checkpointNs: review.checkpointNs,
    };
    for (const [key, value] of Object.entries(fields))
      filter[`review.${key}`] = value ?? { $exists: false };
  } else filter.review = { $exists: false };
  return filter;
}

function responseExecutionFilter(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
  guard: ResponseExecutionGuard,
) {
  const { execution } = guard;
  if (
    !execution.storageTarget ||
    (execution.storageTarget.tenantId || undefined) !== (owner.tenantId || undefined)
  )
    return null;
  const filter: Record<string, unknown> = {
    ...(execution.storageTarget ? managedTargetFilter(mongoose, execution.storageTarget) : {}),
    agentId: execution.agentId,
    sourceKeyId: execution.sourceKeyId ?? { $exists: false },
    conversationId: execution.conversationId,
    generationCreatedAt: execution.generationCreatedAt,
    ...responseReviewFilter(execution.review),
  };
  const resume = execution.resume;
  if (resume) {
    const fields: Record<
      keyof ResponseResumeIntent,
      ResponseResumeIntent[keyof ResponseResumeIntent]
    > = {
      intentId: resume.intentId,
      actionId: resume.actionId,
      previousProviderExecutionId: resume.previousProviderExecutionId,
      providerExecutionId: resume.providerExecutionId,
      fingerprint: resume.fingerprint,
      resolutionJSON: resume.resolutionJSON,
      decisionJSON: resume.decisionJSON,
      state: resume.state,
      reservedAt: resume.reservedAt,
      admittedAt: resume.admittedAt,
    };
    for (const [key, value] of Object.entries(fields))
      filter[`resume.${key}`] = value ?? { $exists: false };
  } else filter.resume = { $exists: false };
  return filter;
}

export interface ResponseExecutionProof extends ResponseExecutionBinding {
  /** Actual canonical disposition permits releasing the transient provider barrier. */
  releaseReady?: boolean;
  releaseAcknowledged?: boolean;
  outcome?: ResponseProviderExecution['outcome'];
  checkpointNamespace?: string;
  checkpointConfigJSON?: string;
  checkpointWriterId?: string;
}

export type ResponseReleaseAuthority =
  | { kind: 'unused'; releaseAcknowledged: boolean }
  | { kind: 'provider'; proof: ResponseExecutionProof };

export interface ResponseStorage {
  recordPersistenceFailure(
    record: StoredResponseRecord,
    failure: ResponsePersistenceFailure,
  ): Promise<ResponseMutationResult>;
  finishPersistenceFailure(
    record: StoredResponseRecord,
    responseJSON: string,
  ): Promise<ResponseMutationResult>;
  readConversationTarget(
    owner: ResponseOwner,
    conversationId: string,
  ): Promise<{
    target: CanonicalConversationTarget;
    expiredAt?: Date;
    isTemporary?: boolean;
  } | null>;
  prepareConversation(
    record: StoredResponseRecord,
    binding: ResponseExecutionBinding,
    writes: ResponseConversationWrites,
  ): Promise<ResponseMutationResult>;
  /** Positive proof on the exact retained root; missing jobs are never substituted. */
  readExecutionProof(identity: ResponseCleanupIdentity): Promise<ResponseExecutionProof | null>;
  readReleaseAuthority(identity: ResponseCleanupIdentity): Promise<ResponseReleaseAuthority | null>;
  finishUnstartedExecution(
    record: StoredResponseRecord,
    binding: ResponseExecutionBinding & {
      outcome: NonNullable<ResponseProviderExecution['outcome']>;
    },
    status: 'failed' | 'cancelled',
    responseJSON: string,
  ): Promise<ResponseMutationResult>;
  acknowledgeExecutionRelease(
    identity: ResponseCleanupIdentity,
    proof?: ResponseExecutionProof,
  ): Promise<boolean>;
  /** Fence enrollment and scrub private data before using provider proof for physical cleanup. */
  retireExecution(identity: ResponseCleanupIdentity): Promise<boolean>;
  finishErasure(identity: ResponseCleanupIdentity): Promise<boolean>;
  acknowledgeCheckpointErasure(
    identity: ResponseCleanupIdentity,
    proof: ResponseExecutionProof,
  ): Promise<boolean>;
  createCheckpointWriter(
    reference: ResponseReference,
    checkpoint: Omit<ResponseCheckpointExecution, 'state' | 'erased' | 'configKey'>,
  ): ReturnType<typeof createResponseCheckpointStorage>;
  enrollExecution(
    record: StoredResponseRecord,
    binding: ResponseExecutionBinding,
    responseJSON: string,
  ): Promise<ResponseMutationResult>;
  /** Bind the attempt selected by the existing provider-start CAS before SDK work. */
  bindExecution(record: StoredResponseRecord, binding: ResponseExecutionBinding): Promise<boolean>;
  /** Positive provider proof is retained independently of transient job lifetime. */
  settleExecution(
    reference: ResponseReference,
    binding: ResponseExecutionBinding,
    outcome?: 'complete' | 'error' | 'aborted',
  ): Promise<boolean>;
  prepareTerminal(
    owner: ResponseOwner,
    responseId: string,
    guard: ResponseExecutionGuard,
    receipt: ResponseTerminalReceipt,
  ): Promise<ResponseMutationResult>;
  stageTerminal(
    owner: ResponseOwner,
    responseId: string,
    guard: ResponseExecutionGuard,
    receipt: ResponseTerminalReceipt,
    promotion?: { receipt: ResponseTerminalReceipt; cancellationRequestedAt?: number },
  ): Promise<ResponseMutationResult>;
  finishTerminal(
    owner: ResponseOwner,
    responseId: string,
    revision: number,
    receipt: ResponseTerminalReceipt,
    writes?: ResponseTurnWrites,
  ): Promise<ResponseMutationResult>;
  publishReview(
    owner: ResponseOwner,
    responseId: string,
    guard: ResponseExecutionGuard,
    generationCreatedAt: number,
    review: ResponseReviewCheckpoint,
    responseJSON: string,
  ): Promise<ResponseMutationResult>;
  reserveResume(
    owner: ResponseOwner,
    responseId: string,
    input: ResponseResumeReservation,
    now: number,
  ): Promise<ResponseResumeResult>;
  admitResume(
    owner: ResponseOwner,
    responseId: string,
    intentId: string,
    generationCreatedAt: number,
    providerExecutionId: string,
    responseJSON: string,
    now: number,
  ): Promise<ResponseMutationResult>;
  reserve(input: ResponseReservation): Promise<ResponseReservationResult>;
  /** SYSTEM metadata scan only; request/answer/key material never crosses this boundary. */
  listRecoveryCandidates(
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    responses: Array<
      Pick<StoredResponseRecord, 'userId' | 'tenantId' | 'responseId' | 'storageTarget'>
    >;
    next?: string;
  }>;
  /** Scope-fenced acknowledgement of one exact source intent, independent of execution revision. */
  settleDispatch(
    owner: ResponseOwner,
    responseId: string,
    token: { kind: 'create' | 'resume'; id: string },
  ): Promise<boolean>;
  read(owner: ResponseOwner, responseId: string): Promise<StoredResponseRecord | null>;
  readCleanupIdentity(
    owner: ResponseOwner,
    responseId: string,
    retained?: ResponseCleanupIdentity,
  ): Promise<ResponseCleanupIdentity | null>;
  attachDelivery(
    owner: ResponseOwner,
    responseId: string,
    deliveryKey: string,
  ): Promise<ResponseMutationResult>;
  publish(
    owner: ResponseOwner,
    responseId: string,
    revision: number,
    update: { status: StoredResponseStatus; responseJSON: string; generationCreatedAt?: number },
  ): Promise<ResponseMutationResult>;
  requestCancellation(
    owner: ResponseOwner,
    responseId: string,
    now: number,
  ): Promise<StoredResponseRecord | null>;
}

const active = ['queued', 'in_progress', 'requires_action'];

function terminalProviderFilter(receipt: ResponseTerminalReceipt) {
  return {
    $or: [
      { 'resume.state': 'admitted', 'resume.providerExecutionId': receipt.providerExecutionId },
      {
        'resume.state': { $ne: 'admitted' },
        'review.providerExecutionId': receipt.providerExecutionId,
      },
      { review: { $exists: false }, resume: { $exists: false } },
    ],
  };
}

/** Authorization precedes this storage boundary; every read/write remains owner- and tenant-scoped. */
export function createResponseStorage(
  mongoose: typeof import('mongoose'),
  options?: {
    getMCPAppMessageBudget?: () => Promise<number | undefined>;
    getDurableStorageConfig?: () => Promise<DurableStorageConfig>;
  },
): ResponseStorage {
  const model = createStoredResponseModel(mongoose);
  const storageConfig = async () =>
    durableStorageConfigSchema.parse((await options?.getDurableStorageConfig?.()) ?? {});
  let indexPromise: Promise<void> | undefined;
  function ensureIndexes() {
    indexPromise ??= prepareResponseRootStorage(mongoose)
      .then(() => undefined)
      .catch((error: unknown) => {
        indexPromise = undefined;
        throw error;
      });
    return indexPromise;
  }
  function ownerScope(
    owner: ResponseOwner & { storageTarget?: ManagedTarget<'response'>; responseId?: string },
  ) {
    if (!owner.userId || owner.tenantId === '__SYSTEM__')
      throw new TypeError('Invalid response owner');
    const tenantId = getTenantId() || undefined;
    if (
      tenantId != null &&
      tenantId !== SYSTEM_TENANT_ID &&
      tenantId !== (owner.tenantId || undefined)
    )
      throw new TypeError('Response tenant does not match authenticated scope');
    if (owner.storageTarget) {
      if (!owner.responseId) throw new TypeError('Response root identity is unavailable');
      return responseRootFilter(mongoose, {
        ...owner,
        responseId: owner.responseId,
        target: owner.storageTarget,
      });
    }
    return responseOwnerFilter(owner);
  }
  function cleanupOwnerScope(
    owner: ResponseOwner & { storageTarget?: ManagedTarget<'response'>; responseId?: string },
  ) {
    assertResponseErasureOwner(owner);
    if (owner.storageTarget) {
      if (!owner.responseId) throw new TypeError('Response root identity is unavailable');
      return responseRootCleanupFilter(mongoose, {
        ...owner,
        responseId: owner.responseId,
        target: owner.storageTarget,
      });
    }
    return responseOwnerFilter(owner);
  }
  const scope = (owner: ResponseOwner, mode: 'publication' | 'visible' = 'publication') => ({
    ...ownerScope(owner),
    '_managed.phase': 'published',
    retiredAt: { $exists: false },
    ...(mode === 'publication' ? { persistenceFailure: { $exists: false } } : {}),
    $and: [activeExpirationFilter<StoredResponseRecord>()],
  });
  async function mutateInOpenScope<T>(
    owner: ResponseOwner,
    responseId: string,
    apply: (record: StoredResponseRecord) => Promise<T>,
    conflict: T,
    mode: 'publication' | 'visible' = 'publication',
  ): Promise<T> {
    const current = await model
      .findOne({ ...scope(owner, mode), responseId })
      .select(RESPONSE_BUDGET_FIELDS)
      .lean();
    if (!current || (await isResponseScopeClosed(mongoose, current, current.conversationId)))
      return conflict;
    const result = await apply(current);
    // Closure retires/deletes exact targets before acknowledging erasure. An in-flight
    // local CAS may land during closure, but cannot be returned as disclosed success.
    return (await isResponseScopeClosed(mongoose, current, current.conversationId))
      ? conflict
      : result;
  }
  async function readExecutionProof(
    identity: ResponseCleanupIdentity,
  ): Promise<ResponseExecutionProof | null> {
    if (!identity.storageTarget || identity.generationCreatedAt == null) return null;
    const record = await includeManagedAllocations(
      model
        .findOne({
          ...responseRootCleanupFilter(mongoose, {
            ...identity,
            target: identity.storageTarget,
          }),
          agentId: identity.agentId,
          conversationId: identity.conversationId,
          generationCreatedAt: identity.generationCreatedAt,
          'providerExecution.drained': true,
          $or: [{ checkpoint: { $exists: false } }, { 'checkpoint.state': 'settled' }],
        })
        .select(
          'generationCreatedAt status retiredAt releaseAcknowledged +providerExecution +checkpoint',
        )
        .lean(),
    );
    if (!record?.providerExecution || record.generationCreatedAt == null) return null;
    return {
      generationCreatedAt: record.generationCreatedAt,
      releaseReady:
        (record.retiredAt != null ||
          ['completed', 'failed', 'incomplete', 'cancelled'].includes(record.status)) &&
        (!record.checkpoint || record.checkpoint.erased === true),
      releaseAcknowledged: record.releaseAcknowledged === true,
      providerExecutionId: record.providerExecution.id,
      ...(record.providerExecution.ownerId ? { ownerId: record.providerExecution.ownerId } : {}),
      ...(record.providerExecution.outcome ? { outcome: record.providerExecution.outcome } : {}),
      ...(record.checkpoint
        ? {
            checkpointWriterId: record.checkpoint.writerId,
            checkpointNamespace: record.checkpoint.namespace,
            checkpointConfigJSON: record.checkpoint.configJSON,
          }
        : {}),
    };
  }
  return {
    ...createResponseFailureStorage(mongoose),
    async readConversationTarget(owner, conversationId) {
      ownerScope(owner);
      return readResponseConversationTarget(mongoose, owner, conversationId);
    },
    async prepareConversation(record, binding, writes) {
      assertResponseExecutionBinding(binding);
      const prepared = await prepareResponseConversation(
        mongoose,
        record,
        binding,
        writes,
        await storageConfig(),
      );
      return prepared ? { ok: true, record: prepared } : { ok: false, code: 'response_conflict' };
    },
    async retireExecution(identity) {
      if (!identity.storageTarget) return false;
      const closed = await isResponseScopeClosed(mongoose, identity, identity.conversationId);
      const now = new Date();
      const result = await model.updateOne(
        {
          ...responseRootCleanupFilter(mongoose, { ...identity, target: identity.storageTarget }),
          agentId: identity.agentId,
          conversationId: identity.conversationId,
          generationCreatedAt: identity.generationCreatedAt ?? { $exists: false },
          '_managed.phase': { $in: ['published', 'retired'] },
          ...(closed ? {} : { expiredAt: { $lte: now } }),
        },
        retiredResponseUpdate(now),
        { upsert: false },
      );
      return result.matchedCount === 1;
    },
    async finishErasure(identity) {
      if (!identity.storageTarget) return false;
      const finished = await finishResponseErasure(mongoose, {
        ...identity,
        target: identity.storageTarget,
      });
      if (finished)
        await reconcileErasedResponseTargets(mongoose, identity, [
          responseScopeKeys(identity, identity.conversationId)[1],
        ]);
      return finished;
    },
    async acknowledgeCheckpointErasure(identity, proof) {
      assertResponseExecutionBinding(proof);
      if (
        !identity.storageTarget ||
        identity.generationCreatedAt !== proof.generationCreatedAt ||
        !proof.checkpointWriterId ||
        !proof.checkpointNamespace ||
        !proof.checkpointConfigJSON
      )
        return false;
      const result = await model.updateOne(
        {
          ...responseRootCleanupFilter(mongoose, { ...identity, target: identity.storageTarget }),
          agentId: identity.agentId,
          conversationId: identity.conversationId,
          generationCreatedAt: proof.generationCreatedAt,
          'providerExecution.id': proof.providerExecutionId,
          'providerExecution.ownerId': proof.ownerId ?? { $exists: false },
          'providerExecution.drained': true,
          'checkpoint.writerId': proof.checkpointWriterId,
          'checkpoint.namespace': proof.checkpointNamespace,
          'checkpoint.configKey': checkpointConfigKey(proof.checkpointConfigJSON),
          'checkpoint.state': 'settled',
        },
        { $set: { 'checkpoint.erased': true } },
        { upsert: false },
      );
      return result.matchedCount === 1;
    },
    async finishUnstartedExecution(record, binding, status, responseJSON) {
      assertResponseExecutionBinding(binding);
      if (!['complete', 'error', 'aborted'].includes(binding.outcome))
        throw new TypeError('Invalid unstarted Response outcome');
      return mutateInOpenScope<ResponseMutationResult>(
        record,
        record.responseId,
        async () => {
          const admitted = await updateResponseDocument(
            mongoose,
            {
              ...scope(record),
              revision: record.revision,
              status: 'queued',
              generationCreatedAt: { $exists: false },
              providerExecution: { $exists: false },
              cancellationRequestedAt: record.cancellationRequestedAt ?? { $exists: false },
              pendingTerminal: { $exists: false },
              preparedTerminal: { $exists: false },
            },
            {
              $set: {
                generationCreatedAt: binding.generationCreatedAt,
                providerExecution: {
                  id: binding.providerExecutionId,
                  ...(binding.ownerId ? { ownerId: binding.ownerId } : {}),
                  drained: true,
                  outcome: binding.outcome,
                },
                status,
                responseJSON,
              },
              $inc: { revision: 1 },
            },
            { new: true, upsert: false },
          );
          if (!admitted.ok && admitted.code === 'document_limit')
            return { ok: false, code: 'document_limit' };
          const saved = admitted.ok ? admitted.record : null;
          return saved ? { ok: true, record: saved } : { ok: false, code: 'response_conflict' };
        },
        { ok: false, code: 'response_conflict' },
      );
    },
    async acknowledgeExecutionRelease(identity, proof) {
      if (!identity.storageTarget) return false;
      if (proof) assertResponseExecutionBinding(proof);
      if (
        (identity.generationCreatedAt == null) !== (proof == null) ||
        (proof && identity.generationCreatedAt !== proof.generationCreatedAt)
      )
        return false;
      const result = await model.updateOne(
        {
          ...responseRootCleanupFilter(mongoose, { ...identity, target: identity.storageTarget }),
          agentId: identity.agentId,
          conversationId: identity.conversationId,
          $or: [
            { retiredAt: { $exists: true } },
            { status: { $in: ['completed', 'failed', 'incomplete', 'cancelled'] } },
          ],
          ...(proof
            ? {
                generationCreatedAt: proof.generationCreatedAt,
                'providerExecution.id': proof.providerExecutionId,
                'providerExecution.ownerId': proof.ownerId ?? { $exists: false },
                'providerExecution.drained': true,
                $and: [
                  {
                    $or: [
                      { checkpoint: { $exists: false } },
                      { 'checkpoint.state': 'settled', 'checkpoint.erased': true },
                    ],
                  },
                ],
              }
            : {
                generationCreatedAt: { $exists: false },
                providerExecution: { $exists: false },
                checkpoint: { $exists: false },
              }),
        },
        { $set: { releaseAcknowledged: true } },
        { upsert: false },
      );
      return result.matchedCount === 1;
    },
    async readReleaseAuthority(identity) {
      if (!identity.storageTarget) return null;
      if (identity.generationCreatedAt != null) {
        const proof = await readExecutionProof(identity);
        return proof?.releaseReady ? { kind: 'provider', proof } : null;
      }
      const record = await includeManagedAllocations(
        model.findOne({
          ...responseRootCleanupFilter(mongoose, { ...identity, target: identity.storageTarget }),
          agentId: identity.agentId,
          conversationId: identity.conversationId,
          generationCreatedAt: { $exists: false },
          providerExecution: { $exists: false },
          checkpoint: { $exists: false },
          $or: [
            { retiredAt: { $exists: true } },
            { status: { $in: ['completed', 'failed', 'incomplete', 'cancelled'] } },
          ],
        }),
      )
        .select('releaseAcknowledged')
        .read('primary')
        .lean();
      return record
        ? { kind: 'unused', releaseAcknowledged: record.releaseAcknowledged === true }
        : null;
    },
    readExecutionProof,
    createCheckpointWriter: (reference, checkpoint) =>
      createResponseCheckpointStorage(mongoose, reference, checkpoint),
    async enrollExecution(current, binding, responseJSON) {
      assertResponseExecutionBinding(binding);
      if (!current.storageTarget) return { ok: false, code: 'response_conflict' };
      const execution = responseExecutionFilter(mongoose, current, { execution: current });
      if (!execution) return { ok: false, code: 'response_conflict' };
      const resumed = current.resume?.state === 'admitted' ? current.resume : undefined;
      if (
        resumed &&
        (resumed.providerExecutionId !== binding.providerExecutionId ||
          current.generationCreatedAt !== binding.generationCreatedAt)
      )
        return { ok: false, code: 'response_conflict' };
      if (await isResponseScopeClosed(mongoose, current, current.conversationId))
        return { ok: false, code: 'response_conflict' };
      if (resumed) {
        // Enrollment admits the provider segment, not a competing attempt owner.
        // A retry may race the first attempt before the job's start CAS chooses one.
        const enrolled = await model
          .findOne({
            ...scope(current),
            ...execution,
            status: 'in_progress',
            'providerExecution.id': binding.providerExecutionId,
          })
          .lean();
        if (enrolled) return { ok: true, record: enrolled };
      }
      const admitted = await updateResponseDocument(
        mongoose,
        {
          ...scope(current),
          ...execution,
          revision: current.revision,
          cancellationRequestedAt: current.cancellationRequestedAt ?? { $exists: false },
          pendingTerminal: { $exists: false },
          preparedTerminal: { $exists: false },
          ...(resumed
            ? {
                status: 'in_progress',
                'providerExecution.id': resumed.previousProviderExecutionId,
                'providerExecution.drained': true,
                $and: [
                  activeExpirationFilter(),
                  {
                    $or: [{ checkpoint: { $exists: false } }, { 'checkpoint.state': 'settled' }],
                  },
                ],
              }
            : {
                status: 'queued',
                generationCreatedAt: { $exists: false },
                providerExecution: { $exists: false },
                resume: { $exists: false },
                review: { $exists: false },
              }),
        },
        {
          $set: {
            status: resumed || current.cancellationRequestedAt == null ? 'in_progress' : 'queued',
            responseJSON,
            generationCreatedAt: binding.generationCreatedAt,
            providerExecution: {
              id: binding.providerExecutionId,
              drained: false,
            },
          },
          $inc: { revision: 1 },
        },
        { new: true, upsert: false },
      );
      if (!admitted.ok && admitted.code === 'document_limit')
        return { ok: false, code: 'document_limit' };
      const record = admitted.ok ? admitted.record : null;
      return record ? { ok: true, record } : { ok: false, code: 'response_conflict' };
    },
    async bindExecution(record, binding) {
      assertResponseExecutionBinding(binding);
      if (!record.storageTarget) return false;
      const result = await model.updateOne(
        {
          ...scope(record),
          agentId: record.agentId,
          conversationId: record.conversationId,
          generationCreatedAt: binding.generationCreatedAt,
          'providerExecution.id': binding.providerExecutionId,
          'providerExecution.drained': false,
          $or: [
            { 'providerExecution.ownerId': { $exists: false } },
            { 'providerExecution.ownerId': binding.ownerId ?? { $exists: false } },
          ],
        },
        {
          $set: {
            'providerExecution.drained': false,
            ...(binding.ownerId ? { 'providerExecution.ownerId': binding.ownerId } : {}),
          },
        },
        { upsert: false },
      );
      return result.matchedCount === 1;
    },
    async settleExecution(reference, binding, outcome) {
      assertResponseExecutionBinding(binding);
      if (outcome != null && !['complete', 'error', 'aborted'].includes(outcome))
        throw new TypeError('Invalid Response provider outcome');
      const updated = await model.updateOne(
        {
          ...responseRootCleanupFilter(mongoose, reference),
          generationCreatedAt: binding.generationCreatedAt,
          'providerExecution.id': binding.providerExecutionId,
          $and: [
            {
              $or: [
                { 'providerExecution.ownerId': { $exists: false } },
                { 'providerExecution.ownerId': binding.ownerId ?? { $exists: false } },
              ],
            },
            ...(outcome
              ? [
                  {
                    $or: [
                      { 'providerExecution.outcome': { $exists: false } },
                      { 'providerExecution.outcome': outcome },
                    ],
                  },
                ]
              : []),
          ],
        },
        {
          $set: {
            'providerExecution.drained': true,
            ...(binding.ownerId ? { 'providerExecution.ownerId': binding.ownerId } : {}),
            ...(outcome ? { 'providerExecution.outcome': outcome } : {}),
          },
        },
        { upsert: false },
      );
      return updated.matchedCount === 1;
    },
    async prepareTerminal(owner, responseId, guard, receipt) {
      if (guard.execution.generationCreatedAt !== receipt.generationCreatedAt)
        return { ok: false, code: 'response_conflict' };
      const execution = responseExecutionFilter(mongoose, owner, guard);
      if (!execution) return { ok: false, code: 'response_conflict' };
      const preparedTerminal = terminalReceipt(receipt);
      return mutateInOpenScope<ResponseMutationResult>(
        owner,
        responseId,
        async (current) => {
          const admitted = await updateResponseDocument(
            mongoose,
            {
              ...scope(owner),
              responseId,
              ...execution,
              status: { $in: active },
              preparedTerminal: { $exists: false },
              pendingTerminal: { $exists: false },
              ...terminalProviderFilter(receipt),
            },
            {
              $set: {
                preparedTerminal,
                terminalReceiptKey: responseReceiptKey(preparedTerminal),
                ...(receipt.turnJSON != null ? { status: 'materializing' } : {}),
              },
              $inc: { revision: 1 },
            },
            { new: true, runValidators: true },
            current,
          );
          if (!admitted.ok && admitted.code === 'document_limit')
            return { ok: false, code: 'document_limit' };
          const record = admitted.ok ? admitted.record : null;
          if (record) return { ok: true, record };
          const existing = await model
            .findOne({ ...scope(owner), responseId, ...execution })
            .lean();
          if (
            existing?.preparedTerminal &&
            (receipt.turnJSON != null
              ? existing.status === 'materializing'
              : active.includes(existing.status)) &&
            !existing.pendingTerminal &&
            sameResponseTerminalReceipt(existing.preparedTerminal, preparedTerminal)
          )
            return { ok: true, record: existing };
          return { ok: false, code: 'response_conflict' };
        },
        { ok: false, code: 'response_conflict' },
      );
    },
    async stageTerminal(owner, responseId, guard, receipt, promotion) {
      const prepared = promotion?.receipt;
      if (
        prepared &&
        (prepared.generationCreatedAt !== receipt.generationCreatedAt ||
          prepared.providerExecutionId !== receipt.providerExecutionId ||
          prepared.ownerId !== receipt.ownerId ||
          prepared.turnJSON !== receipt.turnJSON ||
          prepared.checkpointNamespace !== receipt.checkpointNamespace ||
          prepared.checkpointConfigJSON !== receipt.checkpointConfigJSON)
      )
        return { ok: false, code: 'response_conflict' };
      if (guard.execution.generationCreatedAt !== receipt.generationCreatedAt)
        return { ok: false, code: 'response_conflict' };
      const execution = responseExecutionFilter(mongoose, owner, guard);
      if (!execution) return { ok: false, code: 'response_conflict' };
      const pendingTerminal = terminalReceipt(receipt);
      return mutateInOpenScope<ResponseMutationResult>(
        owner,
        responseId,
        async (current) => {
          const admitted = await updateResponseDocument(
            mongoose,
            {
              ...scope(owner),
              responseId,
              ...execution,
              generationCreatedAt: receipt.generationCreatedAt,
              status: promotion && receipt.turnJSON != null ? 'materializing' : { $in: active },
              pendingTerminal: { $exists: false },
              ...(promotion
                ? {
                    ...terminalFilter('preparedTerminal', promotion.receipt),
                    cancellationRequestedAt: promotion.cancellationRequestedAt ?? {
                      $exists: false,
                    },
                  }
                : { preparedTerminal: { $exists: false } }),
              ...terminalProviderFilter(receipt),
            },
            {
              $set: {
                pendingTerminal,
                terminalReceiptKey: responseReceiptKey(pendingTerminal),
                ...(receipt.turnJSON != null ? { status: 'materializing' } : {}),
              },
              $unset: { preparedTerminal: 1 },
              $inc: { revision: 1 },
            },
            { new: true, runValidators: true },
            current,
          );
          if (!admitted.ok && admitted.code === 'document_limit')
            return { ok: false, code: 'document_limit' };
          const record = admitted.ok ? admitted.record : null;
          if (record) return { ok: true, record };
          const existing = await model
            .findOne({ ...scope(owner), responseId, ...execution })
            .lean();
          if (
            existing?.generationCreatedAt === receipt.generationCreatedAt &&
            existing.pendingTerminal &&
            (receipt.turnJSON != null
              ? existing.status === 'materializing'
              : active.includes(existing.status)) &&
            sameResponseTerminalReceipt(existing.pendingTerminal, pendingTerminal)
          )
            return { ok: true, record: existing };
          return { ok: false, code: 'response_conflict' };
        },
        { ok: false, code: 'response_conflict' },
      );
    },
    async finishTerminal(owner, responseId, revision, receipt, writes) {
      if (
        (receipt.turnJSON != null) !== (writes != null) ||
        (writes &&
          (writes.intentJSON !== receipt.turnJSON || writes.context.userId !== owner.userId))
      )
        throw new Error('Response canonical projection identity changed');
      const [budget, bounds] = writes
        ? await Promise.all([options?.getMCPAppMessageBudget?.(), storageConfig()])
        : [undefined, undefined];
      return mutateInOpenScope<ResponseMutationResult>(
        owner,
        responseId,
        async (current) => {
          if (
            current.revision !== revision ||
            current.generationCreatedAt !== receipt.generationCreatedAt ||
            (writes ? current.status !== 'materializing' : !active.includes(current.status)) ||
            !current.pendingTerminal ||
            !sameResponseTerminalReceipt(current.pendingTerminal, receipt)
          )
            return { ok: false, code: 'response_conflict' };
          if (
            current.providerExecution?.id !== receipt.providerExecutionId ||
            current.providerExecution.ownerId !== receipt.ownerId ||
            current.providerExecution.drained !== true ||
            !current.providerExecution.outcome ||
            (current.checkpoint &&
              (current.checkpoint.state !== 'settled' || current.checkpoint.erased !== true))
          )
            return { ok: false, code: 'response_conflict' };
          if (writes) {
            if (
              writes.conversation.conversationId !== current.conversationId ||
              writes.messages[writes.messages.length - 1]?.messageId !== current.responseId ||
              writes.messages.some((message) => message.conversationId !== current.conversationId)
            )
              throw new Error('Response canonical history identity changed');
            const materialized = await materializeResponseTurn(
              mongoose,
              current,
              receipt,
              {
                ...writes,
                context: {
                  ...writes.context,
                  ...(current.isTemporary === true ? { isTemporary: true } : {}),
                  ...(current.expiredAt &&
                  (!writes.context.expiredAt || current.expiredAt < writes.context.expiredAt)
                    ? { expiredAt: current.expiredAt }
                    : {}),
                },
              },
              async () => budget,
              bounds,
            );
            if (!materialized.ok) return materialized;
          }
          // Target selections advance revision. Reread the same physical Root and
          // immutable receipt after Conversation append, never rerun provider work.
          const latest = await model
            .findOne({ ...scope(current), ...terminalFilter('pendingTerminal', receipt) })
            .select(RESPONSE_BUDGET_FIELDS)
            .lean();
          if (!latest || (await isResponseScopeClosed(mongoose, latest, latest.conversationId)))
            return { ok: false, code: 'response_conflict' };
          const admitted = await updateResponseDocument(
            mongoose,
            {
              ...scope(current),
              revision: latest.revision,
              generationCreatedAt: receipt.generationCreatedAt,
              'providerExecution.id': receipt.providerExecutionId,
              'providerExecution.ownerId': receipt.ownerId ?? { $exists: false },
              'providerExecution.drained': true,
              'providerExecution.outcome': { $in: ['complete', 'error', 'aborted'] },
              $or: [
                { checkpoint: { $exists: false } },
                { 'checkpoint.state': 'settled', 'checkpoint.erased': true },
              ],
              status: writes ? 'materializing' : { $in: active },
              ...terminalFilter('pendingTerminal', receipt),
            },
            {
              $set: { status: receipt.status, responseJSON: receipt.responseJSON },
              $unset: { pendingTerminal: 1, preparedTerminal: 1, terminalReceiptKey: 1 },
              $inc: { revision: 1 },
            },
            { new: true, upsert: false },
            latest,
          );
          if (!admitted.ok && admitted.code === 'document_limit')
            return { ok: false, code: 'document_limit' };
          const record = admitted.ok ? admitted.record : null;
          return record ? { ok: true, record } : { ok: false, code: 'response_conflict' };
        },
        { ok: false, code: 'response_conflict' },
      );
    },
    async publishReview(owner, responseId, guard, generationCreatedAt, review, responseJSON) {
      if (guard.execution.generationCreatedAt !== generationCreatedAt)
        return { ok: false, code: 'response_conflict' };
      const execution = responseExecutionFilter(mongoose, owner, guard);
      if (!execution) return { ok: false, code: 'response_conflict' };
      const receiptFilter = {
        ...scope(owner),
        responseId,
        generationCreatedAt,
        agentId: guard.execution.agentId,
        sourceKeyId: guard.execution.sourceKeyId ?? { $exists: false },
        conversationId: guard.execution.conversationId,
        ...responseReviewFilter(review),
        status: 'requires_action',
        resume: { $exists: false },
        pendingTerminal: { $exists: false },
        preparedTerminal: { $exists: false },
        cancellationRequestedAt: { $exists: false },
      };
      if (
        guard.execution.review?.actionId === review.actionId &&
        guard.execution.review.providerExecutionId === review.providerExecutionId &&
        guard.execution.resume == null
      ) {
        const existing = await model.findOne(receiptFilter).lean();
        return existing ? { ok: true, record: existing } : { ok: false, code: 'response_conflict' };
      }
      const admitted = await updateResponseDocument(
        mongoose,
        {
          ...scope(owner),
          responseId,
          ...execution,
          generationCreatedAt,
          status: { $in: ['in_progress', 'requires_action'] },
          pendingTerminal: { $exists: false },
          preparedTerminal: { $exists: false },
          cancellationRequestedAt: { $exists: false },
          $or: [
            { review: { $exists: false }, resume: { $exists: false } },
            {
              'review.actionId': review.actionId,
              'review.providerExecutionId': review.providerExecutionId,
              resume: { $exists: false },
            },
            {
              'resume.state': 'admitted',
              'resume.providerExecutionId': review.providerExecutionId,
            },
          ],
        },
        {
          $set: {
            status: 'requires_action',
            review: {
              actionId: review.actionId,
              providerExecutionId: review.providerExecutionId,
              expiresAt: review.expiresAt,
              partialResponseJSON: review.partialResponseJSON,
              ...(review.visibleOutputTokens == null
                ? {}
                : { visibleOutputTokens: review.visibleOutputTokens }),
              ...(review.pendingActionJSON == null
                ? {}
                : { pendingActionJSON: review.pendingActionJSON }),
              ...(review.checkpointConfigJSON == null
                ? {}
                : { checkpointConfigJSON: review.checkpointConfigJSON }),
              ...(review.checkpointId == null ? {} : { checkpointId: review.checkpointId }),
              ...(review.checkpointNs == null ? {} : { checkpointNs: review.checkpointNs }),
            },
            responseJSON,
          },
          $unset: { resume: 1 },
          $inc: { revision: 1 },
        },
        { new: true, runValidators: true },
      );
      if (!admitted.ok && admitted.code === 'document_limit')
        return { ok: false, code: 'document_limit' };
      const record = admitted.ok ? admitted.record : null;
      if (record) return { ok: true, record };
      if (!receiptFilter) return { ok: false, code: 'response_conflict' };
      const existing = await model.findOne(receiptFilter).lean();
      return existing ? { ok: true, record: existing } : { ok: false, code: 'response_conflict' };
    },
    async reserveResume(owner, responseId, input, now) {
      if (!Number.isFinite(now) || now <= 0) throw new TypeError('Invalid resume reservation time');
      if (input.providerExecutionId === input.previousProviderExecutionId)
        throw new TypeError('Resume requires a new provider execution identity');
      const admitted = await updateResponseDocument(
        mongoose,
        {
          ...scope(owner),
          responseId,
          generationCreatedAt: input.generationCreatedAt,
          status: 'requires_action',
          pendingTerminal: { $exists: false },
          preparedTerminal: { $exists: false },
          cancellationRequestedAt: { $exists: false },
          resume: { $exists: false },
          'review.actionId': input.actionId,
          'review.providerExecutionId': input.previousProviderExecutionId,
          'review.expiresAt': { $gt: now },
        },
        {
          $set: {
            resume: {
              intentId: input.intentId,
              actionId: input.actionId,
              previousProviderExecutionId: input.previousProviderExecutionId,
              providerExecutionId: input.providerExecutionId,
              fingerprint: input.fingerprint,
              resolutionJSON: input.resolutionJSON,
              ...(input.decisionJSON == null ? {} : { decisionJSON: input.decisionJSON }),
              state: 'reserved',
              reservedAt: now,
            },
            dispatchOutbox: { kind: 'resume', id: input.intentId, state: 'pending' },
          },
          $inc: { revision: 1 },
        },
        { new: true, runValidators: true },
      );
      if (!admitted.ok && admitted.code === 'document_limit')
        return { ok: false, code: 'document_limit' };
      const record = admitted.ok ? admitted.record : null;
      if (record) return { ok: true, record, replayed: false };
      const existing = await model.findOne({ ...scope(owner), responseId }).lean();
      const intent = existing?.resume;
      if (
        existing?.generationCreatedAt === input.generationCreatedAt &&
        intent &&
        intent.actionId === input.actionId &&
        intent.previousProviderExecutionId === input.previousProviderExecutionId &&
        intent.fingerprint === input.fingerprint &&
        intent.resolutionJSON === input.resolutionJSON &&
        intent.decisionJSON === input.decisionJSON
      )
        return { ok: true, record: existing, replayed: true };
      return { ok: false, code: 'resume_conflict' };
    },
    async admitResume(
      owner,
      responseId,
      intentId,
      generationCreatedAt,
      providerExecutionId,
      responseJSON,
      now,
    ) {
      if (!Number.isFinite(now) || now <= 0) throw new TypeError('Invalid resume admission time');
      const admitted = await updateResponseDocument(
        mongoose,
        {
          ...scope(owner),
          responseId,
          generationCreatedAt,
          status: 'requires_action',
          pendingTerminal: { $exists: false },
          preparedTerminal: { $exists: false },
          cancellationRequestedAt: { $exists: false },
          'resume.intentId': intentId,
          'resume.providerExecutionId': providerExecutionId,
          'resume.state': 'reserved',
        },
        {
          $set: {
            status: 'in_progress',
            responseJSON,
            'resume.state': 'admitted',
            'resume.admittedAt': now,
          },
          $inc: { revision: 1 },
        },
        { new: true },
      );
      if (!admitted.ok && admitted.code === 'document_limit')
        return { ok: false, code: 'document_limit' };
      const record = admitted.ok ? admitted.record : null;
      if (record) return { ok: true, record };
      const existing = await model.findOne({ ...scope(owner), responseId }).lean();
      if (
        existing?.generationCreatedAt === generationCreatedAt &&
        existing.resume?.intentId === intentId &&
        existing.resume.providerExecutionId === providerExecutionId &&
        existing.resume.state === 'admitted'
      )
        return { ok: true, record: existing };
      return { ok: false, code: 'response_conflict' };
    },
    async reserve(input) {
      input = { ...input };
      assertResponseReservation(input);
      const filter = { ...ownerScope(input), requestKey: input.requestKey };
      await ensureIndexes();
      const existing = await model.findOne(filter).lean();
      const replay = async (record: StoredResponseRecord): Promise<ResponseReservationResult> => {
        if (
          !record.storageTarget ||
          record.retiredAt ||
          (record.expiredAt && record.expiredAt <= new Date()) ||
          (await isResponseScopeClosed(mongoose, input, record.conversationId))
        )
          return { ok: false, code: 'response_unavailable' };
        if (record.fingerprint !== input.fingerprint)
          return { ok: false, code: 'idempotency_conflict' };
        if (input.expiredAt)
          await createResponseRetention(mongoose)(input, record.conversationId, input.expiredAt);
        const current = await model
          .findOne({ ...scope(record, 'visible'), responseId: record.responseId })
          .lean();
        if (!current || (await isResponseScopeClosed(mongoose, input, current.conversationId)))
          return { ok: false, code: 'response_unavailable' };
        return { ok: true, record: current, replayed: true };
      };
      if (existing) return replay(existing);
      if (!responseReservationFits(mongoose, input)) return { ok: false, code: 'document_limit' };
      const conversationId = input.conversationId;
      await initializeResponseScopes(mongoose, responseScopeKeys(input, conversationId));
      if (input.expiredAt)
        await createResponseRetention(mongoose)(input, conversationId, input.expiredAt);
      if (await isResponseScopeClosed(mongoose, input, conversationId))
        return { ok: false, code: 'response_unavailable' };
      const bounds = await storageConfig();
      const target = await allocateManagedTarget(mongoose, 'response', input.tenantId);
      try {
        const record = await publishResponseRoot(mongoose, target, input, bounds);
        if (!record) {
          await discardResponseRoot(mongoose, target, input);
          return { ok: false, code: 'response_unavailable' };
        }
        if (await isResponseScopeClosed(mongoose, input, record.conversationId))
          return { ok: false, code: 'response_unavailable' };
        return { ok: true, record, replayed: false };
      } catch (error) {
        await discardResponseRoot(mongoose, target, input);
        // Allocation already received an unambiguous acknowledgment. A primary read
        // of the published winner may resolve a lost publication reply or a key race;
        // absence never converts an operational failure into success.
        const winner = await model.findOne(filter).lean();
        if (winner) return replay(winner);
        throw error;
      }
    },
    async listRecoveryCandidates(cursor, limit) {
      if (getTenantId() !== SYSTEM_TENANT_ID)
        throw new Error('Response dispatch scan requires system context');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new TypeError('Invalid response dispatch page size');
      if (cursor != null && !/^[a-f\d]{24}$/i.test(cursor))
        throw new TypeError('Invalid response dispatch cursor');
      await ensureIndexes();
      const rows = await includeManagedAllocations(
        model.find({
          ...(cursor ? { _id: { $gt: new mongoose.Types.ObjectId(cursor) } } : {}),
          userId: { $exists: true },
          storageTarget: { $exists: true },
          '_managed.phase': { $in: ['published', 'retired'] },
          $or: [
            { status: { $in: ['queued', 'in_progress', 'requires_action', 'materializing'] } },
            { retiredAt: { $exists: true } },
            { expiredAt: { $lte: new Date() } },
            { 'dispatchOutbox.state': 'pending' },
            {
              status: { $in: ['completed', 'failed', 'incomplete', 'cancelled'] },
              releaseAcknowledged: { $ne: true },
            },
          ],
        }),
      )
        .select('_id tenantId userId responseId storageTarget')
        .sort({ _id: 1 })
        .limit(limit + 1)
        .lean();
      const page = rows.slice(0, limit);
      return {
        responses: page.map((row) => ({
          userId: row.userId,
          ...(row.tenantId ? { tenantId: row.tenantId } : {}),
          responseId: row.responseId,
          storageTarget: row.storageTarget,
        })),
        ...(rows.length > limit ? { next: String(page[page.length - 1]._id) } : {}),
      };
    },
    async settleDispatch(owner, responseId, token) {
      if (!token.id || !['create', 'resume'].includes(token.kind))
        throw new TypeError('Invalid response dispatch identity');
      return mutateInOpenScope(
        owner,
        responseId,
        async (record) => {
          const marker = record.dispatchOutbox;
          if (
            !marker ||
            !['create', 'resume'].includes(marker.kind) ||
            !['pending', 'settled'].includes(marker.state)
          )
            return false;
          if (marker.kind !== token.kind || marker.id !== token.id) return false;
          // A consumed resume may pause again and clear its intent before enqueue acknowledgement.
          if (token.kind === 'create') {
            if (token.id !== record.responseId || record.resume?.state === 'reserved') return false;
          } else if (record.resume && record.resume.intentId !== token.id) return false;
          if (marker.state === 'settled') return true;
          const updated = await model.updateOne(
            {
              ...scope(record, 'visible'),
              responseId,
              'dispatchOutbox.kind': token.kind,
              'dispatchOutbox.id': token.id,
              'dispatchOutbox.state': 'pending',
            },
            {
              $set: { dispatchOutbox: { ...token, state: 'settled' } },
            },
            { upsert: false },
          );
          return updated.matchedCount === 1;
        },
        false,
        // Settling an accepted outbox token cannot admit new execution or payload.
        'visible',
      );
    },
    async read(owner, responseId) {
      const record = await model.findOne({ ...scope(owner, 'visible'), responseId }).lean();
      if (record && (await isResponseScopeClosed(mongoose, owner, record.conversationId)))
        return null;
      return record;
    },
    async readCleanupIdentity(owner, responseId, retained) {
      const record = await includeManagedAllocations(
        model
          .findOne({ ...cleanupOwnerScope(owner), responseId })
          .select(
            'userId tenantId responseId agentId conversationId requestKey sourceKeyId parentMessageId generationCreatedAt expiredAt storageTarget +checkpoint pendingTerminal.checkpointNamespace pendingTerminal.checkpointConfigJSON preparedTerminal.checkpointNamespace preparedTerminal.checkpointConfigJSON review.checkpointConfigJSON review.providerExecutionId',
          )
          .lean(),
      );
      // Retained data comes only from an internal job/receipt, never request input.
      // Validate it even when the row exists before using any fallback checkpoint fields.
      const retainedCandidate =
        retained &&
        retained.responseId === responseId &&
        retained.userId === owner.userId &&
        (retained.tenantId || undefined) === (owner.tenantId || undefined) &&
        (!record ||
          (retained.conversationId === record.conversationId &&
            retained.agentId === record.agentId &&
            (record.generationCreatedAt == null ||
              retained.generationCreatedAt === record.generationCreatedAt)))
          ? retained
          : undefined;
      const source = record ?? retainedCandidate;
      if (!source) return null;
      const now = new Date();
      const [ownerKey, conversationKey] = responseScopeKeys(owner, source.conversationId);
      const anchors = await createResponseScopeModel(mongoose)
        .find({ _id: { $in: [ownerKey, conversationKey] } })
        .select('closed expiredAt')
        .lean();
      const ownerAnchor = anchors.find((anchor) => anchor._id === ownerKey);
      const conversationAnchor = anchors.find((anchor) => anchor._id === conversationKey);
      const expiredAt =
        conversationAnchor?.expiredAt &&
        (!source.expiredAt || conversationAnchor.expiredAt < source.expiredAt)
          ? conversationAnchor.expiredAt
          : source.expiredAt;
      let retirement: ResponseCleanupIdentity['retirement'];
      if (ownerAnchor?.closed) retirement = 'owner_deleted';
      else if (conversationAnchor?.closed) retirement = 'conversation_deleted';
      else if (expiredAt && expiredAt <= now) retirement = 'expired';
      // A retained deadline alone cannot prove why an authoritative row disappeared.
      if (
        !record &&
        !ownerAnchor?.closed &&
        !conversationAnchor?.closed &&
        !(conversationAnchor?.expiredAt && conversationAnchor.expiredAt <= now)
      )
        return null;
      const matchingRetained =
        retainedCandidate &&
        (!record ||
          retainedCandidate.generationCreatedAt === record.generationCreatedAt ||
          (retirement && record.generationCreatedAt == null))
          ? retainedCandidate
          : undefined;
      // A staged checkpoint is one binding: never fill an incomplete terminal
      // binding with settings from a prior review or retained provider segment.
      const terminalCheckpoint = record?.pendingTerminal ?? record?.preparedTerminal;
      const hasTerminalCheckpoint =
        terminalCheckpoint?.checkpointNamespace != null ||
        terminalCheckpoint?.checkpointConfigJSON != null;
      const checkpointNamespace =
        record?.checkpoint?.namespace ??
        (hasTerminalCheckpoint
          ? terminalCheckpoint?.checkpointNamespace
          : matchingRetained?.checkpointNamespace);
      const checkpointConfigJSON =
        record?.checkpoint?.configJSON ??
        (hasTerminalCheckpoint
          ? terminalCheckpoint?.checkpointConfigJSON
          : (record?.review?.checkpointConfigJSON ?? matchingRetained?.checkpointConfigJSON));
      const {
        userId,
        tenantId,
        responseId: id,
        agentId,
        conversationId,
        generationCreatedAt,
      } = source;
      return {
        userId,
        tenantId,
        responseId: id,
        agentId,
        conversationId,
        ...(source.storageTarget ? { storageTarget: source.storageTarget } : {}),
        ...(source.requestKey == null ? {} : { requestKey: source.requestKey }),
        ...(source.sourceKeyId == null ? {} : { sourceKeyId: source.sourceKeyId }),
        ...(source.parentMessageId == null ? {} : { parentMessageId: source.parentMessageId }),
        // A transient job cannot invent enrollment while the canonical Root still has none.
        generationCreatedAt: record ? generationCreatedAt : matchingRetained?.generationCreatedAt,
        expiredAt,
        retirement,
        checkpointNamespace,
        checkpointConfigJSON,
        requiresCheckpointCleanup: Boolean(
          record?.review ||
            checkpointNamespace ||
            checkpointConfigJSON ||
            matchingRetained?.requiresCheckpointCleanup,
        ),
      };
    },
    async attachDelivery(owner, responseId, deliveryKey) {
      const admitted = await updateResponseDocument(
        mongoose,
        {
          ...scope(owner),
          responseId,
          status: { $in: active },
          $or: [{ deliveryKey: { $exists: false } }, { deliveryKey }],
        },
        { $set: { deliveryKey } },
        { new: true },
      );
      if (!admitted.ok && admitted.code === 'document_limit')
        return { ok: false, code: 'document_limit' };
      const record = admitted.ok ? admitted.record : null;
      return record ? { ok: true, record } : { ok: false, code: 'response_conflict' };
    },
    async publish(owner, responseId, revision, update) {
      // This private phase can only be entered atomically with its terminal receipt.
      if (update.status === 'materializing') return { ok: false, code: 'response_conflict' };
      if (
        update.generationCreatedAt != null &&
        (!Number.isSafeInteger(update.generationCreatedAt) || update.generationCreatedAt <= 0)
      )
        throw new TypeError('Invalid response generation identity');
      let predecessors = active;
      if (update.status === 'queued') predecessors = ['queued'];
      if (update.status === 'in_progress') predecessors = ['queued', 'in_progress'];
      const admitted = await updateResponseDocument(
        mongoose,
        {
          ...scope(owner),
          responseId,
          revision,
          status: { $in: predecessors },
          pendingTerminal: { $exists: false },
          preparedTerminal: { $exists: false },
          ...(update.status === 'in_progress'
            ? {
                $and: [
                  activeExpirationFilter<StoredResponseRecord>(),
                  {
                    $or: [
                      { status: 'in_progress' },
                      { cancellationRequestedAt: { $exists: false } },
                    ],
                  },
                  ...(update.generationCreatedAt == null
                    ? [{ generationCreatedAt: { $gt: 0 } }]
                    : []),
                ],
              }
            : {}),
          ...(update.generationCreatedAt == null
            ? {}
            : {
                $or: [
                  { generationCreatedAt: { $exists: false } },
                  { generationCreatedAt: update.generationCreatedAt },
                ],
              }),
        },
        { $set: update, $inc: { revision: 1 } },
        { new: true },
      );
      if (!admitted.ok && admitted.code === 'document_limit')
        return { ok: false, code: 'document_limit' };
      const record = admitted.ok ? admitted.record : null;
      return record ? { ok: true, record } : { ok: false, code: 'response_conflict' };
    },
    async requestCancellation(owner, responseId, now) {
      if (!Number.isFinite(now) || now <= 0) throw new TypeError('Invalid cancellation time');
      await model.updateOne(
        {
          ...scope(owner),
          responseId,
          status: { $in: [...active, 'materializing'] },
          cancellationRequestedAt: { $exists: false },
          pendingTerminal: { $exists: false },
        },
        { $set: { cancellationRequestedAt: now } },
      );
      return model.findOne({ ...scope(owner, 'visible'), responseId }).lean();
    },
  };
}
