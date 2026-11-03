import type { ClientSession } from 'mongoose';
import type {
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
import type { ResponseTurnWrites } from './responseTurn';
import type { ManagedTarget } from '~/types/managed';
import {
  prepareResponseRootStorage,
  publishResponseRoot,
  discardResponseRoot,
  assertResponseReservation,
  responseRootFilter,
} from './responseRoot';
import {
  responseScopeKeys,
  responseOwnerFilter,
  isResponseScopeClosed,
  initializeResponseScopes,
  createResponseRetention,
} from './responseScope';
import { sameResponseTerminalReceipt, terminalReceipt, terminalFilter } from '~/utils/receipt';
import { createResponseCheckpointStorage } from './responseCheckpoint';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { allocateManagedTarget, managedTargetFilter } from './managed';
import { createResponseScopeModel } from '~/models/responseScope';
import { createStoredResponseModel } from '~/models/response';
import { getTransactionSupport } from '~/utils/transactions';
import { includeManagedAllocations } from '~/utils/managed';
import { activeExpirationFilter } from '~/utils/retention';
import { materializeResponseTurn } from './responseTurn';

export { sameResponseTerminalReceipt } from '~/utils/receipt';

export type {
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
  | { ok: false; code: 'idempotency_conflict' | 'response_unavailable' };

export type ResponseMutationResult =
  | { ok: true; record: StoredResponseRecord }
  | { ok: false; code: 'response_conflict' };

export type ResponseExecutionBinding = Pick<
  ResponseTerminalReceipt,
  'generationCreatedAt' | 'providerExecutionId' | 'ownerId'
>;

function assertExecutionBinding(binding: ResponseExecutionBinding): void {
  if (
    !Number.isSafeInteger(binding.generationCreatedAt) ||
    binding.generationCreatedAt < 1 ||
    typeof binding.providerExecutionId !== 'string' ||
    !binding.providerExecutionId ||
    binding.providerExecutionId.length > 128 ||
    (binding.ownerId != null &&
      (typeof binding.ownerId !== 'string' || !binding.ownerId || binding.ownerId.length > 128))
  )
    throw new TypeError('Invalid Response provider identity');
}

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
  | { ok: false; code: 'resume_conflict' };

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
    execution.storageTarget &&
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
  outcome?: ResponseProviderExecution['outcome'];
  checkpointNamespace?: string;
  checkpointConfigJSON?: string;
}

export interface ResponseStorage {
  /** Positive proof on the exact retained root; missing jobs are never substituted. */
  readExecutionProof(identity: ResponseCleanupIdentity): Promise<ResponseExecutionProof | null>;
  /** Fence enrollment and scrub private data before using provider proof for physical cleanup. */
  retireExecution(identity: ResponseCleanupIdentity): Promise<boolean>;
  createCheckpointWriter(
    reference: ResponseReference,
    checkpoint: Omit<ResponseCheckpointExecution, 'state'>,
  ): ReturnType<typeof createResponseCheckpointStorage>;
  enrollExecution(
    record: StoredResponseRecord,
    binding: ResponseExecutionBinding,
    responseJSON: string,
  ): Promise<ResponseMutationResult>;
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
  listPendingDispatches(
    cursor: string | undefined,
    limit: number,
    includeResume: boolean,
  ): Promise<{
    responses: Array<ResponseOwner & { responseId: string }>;
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
  options?: { getMCPAppMessageBudget?: () => Promise<number | undefined> },
): ResponseStorage {
  const model = createStoredResponseModel(mongoose);
  let indexPromise: Promise<void> | undefined;
  let transactionSupport: boolean | null = null;
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
  const scope = (owner: ResponseOwner) => ({
    ...ownerScope(owner),
    '_managed.phase': 'published',
    retiredAt: { $exists: false },
    $and: [activeExpirationFilter<StoredResponseRecord>()],
  });
  async function commitInOpenScope<T>(
    owner: ResponseOwner,
    responseId: string,
    apply: (session: ClientSession, record: StoredResponseRecord) => Promise<T>,
    conflict: T,
  ): Promise<T> {
    transactionSupport = await getTransactionSupport(mongoose, transactionSupport);
    if (!transactionSupport) throw new Error('Response publication requires transactions');
    const current = await model.findOne({ ...scope(owner), responseId }).lean();
    if (!current) return conflict;
    const keys = responseScopeKeys(owner, current.conversationId);
    await initializeResponseScopes(mongoose, keys);
    const session = await mongoose.startSession({
      defaultTransactionOptions: { readPreference: 'primary' },
    });
    try {
      let result = conflict;
      await session.withTransaction(async () => {
        result = conflict;
        const scopes = createResponseScopeModel(mongoose);
        for (const key of keys) {
          const touched = await scopes.updateOne(
            { _id: key, closed: false, $and: [activeExpirationFilter()] },
            { $inc: { revision: 1 } },
            { session },
          );
          if (touched.matchedCount !== 1) return;
        }
        const record = await model
          .findOne({ ...scope(owner), responseId })
          .session(session)
          .lean();
        if (record) result = await apply(session, record);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
  return {
    async retireExecution(identity) {
      if (!identity.storageTarget) return false;
      const closed = await isResponseScopeClosed(mongoose, identity, identity.conversationId);
      const now = new Date();
      const result = await model.updateOne(
        {
          ...responseRootFilter(mongoose, { ...identity, target: identity.storageTarget }),
          agentId: identity.agentId,
          conversationId: identity.conversationId,
          generationCreatedAt: identity.generationCreatedAt ?? { $exists: false },
          '_managed.phase': { $in: ['published', 'retired'] },
          ...(closed ? {} : { expiredAt: { $lte: now } }),
        },
        {
          $set: { '_managed.phase': 'retired' },
          $min: { retiredAt: now },
          $unset: {
            requestJSON: 1,
            responseJSON: 1,
            review: 1,
            resume: 1,
            preparedTerminal: 1,
            pendingTerminal: 1,
          },
        },
        { upsert: false },
      );
      return result.matchedCount === 1;
    },
    async readExecutionProof(identity) {
      if (!identity.storageTarget || identity.generationCreatedAt == null) return null;
      const record = await includeManagedAllocations(
        model
          .findOne({
            ...responseRootFilter(mongoose, {
              ...identity,
              target: identity.storageTarget,
            }),
            agentId: identity.agentId,
            conversationId: identity.conversationId,
            generationCreatedAt: identity.generationCreatedAt,
            'providerExecution.drained': true,
            $or: [{ checkpoint: { $exists: false } }, { 'checkpoint.state': 'settled' }],
          })
          .select('generationCreatedAt +providerExecution +checkpoint')
          .lean(),
      );
      if (!record?.providerExecution || record.generationCreatedAt == null) return null;
      return {
        generationCreatedAt: record.generationCreatedAt,
        providerExecutionId: record.providerExecution.id,
        ...(record.providerExecution.ownerId ? { ownerId: record.providerExecution.ownerId } : {}),
        ...(record.providerExecution.outcome ? { outcome: record.providerExecution.outcome } : {}),
        ...(record.checkpoint
          ? {
              checkpointNamespace: record.checkpoint.namespace,
              checkpointConfigJSON: record.checkpoint.configJSON,
            }
          : {}),
      };
    },
    createCheckpointWriter: (reference, checkpoint) =>
      createResponseCheckpointStorage(mongoose, reference, checkpoint),
    async enrollExecution(current, binding, responseJSON) {
      assertExecutionBinding(binding);
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
      const record = await model
        .findOneAndUpdate(
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
                ...(binding.ownerId ? { ownerId: binding.ownerId } : {}),
                drained: false,
              },
            },
            $inc: { revision: 1 },
          },
          { new: true, upsert: false },
        )
        .lean();
      return record ? { ok: true, record } : { ok: false, code: 'response_conflict' };
    },
    async settleExecution(reference, binding, outcome) {
      assertExecutionBinding(binding);
      if (outcome != null && !['complete', 'error', 'aborted'].includes(outcome))
        throw new TypeError('Invalid Response provider outcome');
      const updated = await model.updateOne(
        {
          ...responseRootFilter(mongoose, reference),
          generationCreatedAt: binding.generationCreatedAt,
          'providerExecution.id': binding.providerExecutionId,
          'providerExecution.ownerId': binding.ownerId ?? { $exists: false },
          ...(outcome
            ? {
                $or: [
                  { 'providerExecution.outcome': { $exists: false } },
                  { 'providerExecution.outcome': outcome },
                ],
              }
            : {}),
        },
        {
          $set: {
            'providerExecution.drained': true,
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
      return commitInOpenScope<ResponseMutationResult>(
        owner,
        responseId,
        async (session) => {
          const record = await model
            .findOneAndUpdate(
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
                  ...(receipt.turnJSON != null ? { status: 'materializing' } : {}),
                },
                $inc: { revision: 1 },
              },
              { new: true, runValidators: true, session },
            )
            .lean();
          if (record) return { ok: true, record };
          const existing = await model
            .findOne({ ...scope(owner), responseId, ...execution })
            .session(session)
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
      return commitInOpenScope<ResponseMutationResult>(
        owner,
        responseId,
        async (session) => {
          const record = await model
            .findOneAndUpdate(
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
                  ...(receipt.turnJSON != null ? { status: 'materializing' } : {}),
                },
                $unset: { preparedTerminal: 1 },
                $inc: { revision: 1 },
              },
              { new: true, runValidators: true, session },
            )
            .lean();
          if (record) return { ok: true, record };
          const existing = await model
            .findOne({ ...scope(owner), responseId, ...execution })
            .session(session)
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
      // Resolve operator configuration before opening the database transaction.
      const budget = writes ? await options?.getMCPAppMessageBudget?.() : undefined;
      return commitInOpenScope<ResponseMutationResult>(
        owner,
        responseId,
        async (session, current) => {
          if (
            current.revision !== revision ||
            current.generationCreatedAt !== receipt.generationCreatedAt ||
            (receipt.turnJSON != null
              ? current.status !== 'materializing'
              : !active.includes(current.status)) ||
            !current.pendingTerminal ||
            !sameResponseTerminalReceipt(current.pendingTerminal, receipt)
          )
            return { ok: false, code: 'response_conflict' };
          if (writes) {
            if (
              writes.conversation.conversationId !== current.conversationId ||
              writes.messages[writes.messages.length - 1]?.messageId !== current.responseId ||
              writes.messages.some((message) => message.conversationId !== current.conversationId)
            )
              throw new Error('Response canonical history identity changed');
            await materializeResponseTurn(
              mongoose,
              session,
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
            );
          }
          const record = await model
            .findOneAndUpdate(
              {
                ...scope(owner),
                responseId,
                revision,
                ...terminalFilter('pendingTerminal', receipt),
              },
              {
                $set: { status: receipt.status, responseJSON: receipt.responseJSON },
                $unset: { pendingTerminal: 1, preparedTerminal: 1 },
                $inc: { revision: 1 },
              },
              { new: true, session },
            )
            .lean();
          if (!record) throw new Error('Response publication changed during materialization');
          return { ok: true, record };
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
      const record = await model
        .findOneAndUpdate(
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
        )
        .lean();
      if (record) return { ok: true, record };
      if (!receiptFilter) return { ok: false, code: 'response_conflict' };
      const existing = await model.findOne(receiptFilter).lean();
      return existing ? { ok: true, record: existing } : { ok: false, code: 'response_conflict' };
    },
    async reserveResume(owner, responseId, input, now) {
      if (!Number.isFinite(now) || now <= 0) throw new TypeError('Invalid resume reservation time');
      if (input.providerExecutionId === input.previousProviderExecutionId)
        throw new TypeError('Resume requires a new provider execution identity');
      const record = await model
        .findOneAndUpdate(
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
        )
        .lean();
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
      const record = await model
        .findOneAndUpdate(
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
        )
        .lean();
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
          .findOne({ ...scope(record), responseId: record.responseId })
          .lean();
        if (!current || (await isResponseScopeClosed(mongoose, input, current.conversationId)))
          return { ok: false, code: 'response_unavailable' };
        return { ok: true, record: current, replayed: true };
      };
      if (existing) return replay(existing);
      const conversationId = input.conversationId;
      await initializeResponseScopes(mongoose, responseScopeKeys(input, conversationId));
      if (input.expiredAt)
        await createResponseRetention(mongoose)(input, conversationId, input.expiredAt);
      if (await isResponseScopeClosed(mongoose, input, conversationId))
        return { ok: false, code: 'response_unavailable' };
      const target = await allocateManagedTarget(mongoose, 'response', input.tenantId);
      try {
        const record = await publishResponseRoot(mongoose, target, input);
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
    async listPendingDispatches(cursor, limit, includeResume) {
      if (getTenantId() !== SYSTEM_TENANT_ID)
        throw new Error('Response dispatch scan requires system context');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new TypeError('Invalid response dispatch page size');
      if (cursor != null && !/^[a-f\d]{24}$/i.test(cursor))
        throw new TypeError('Invalid response dispatch cursor');
      await ensureIndexes();
      const pending: Record<string, unknown> = {
        'dispatchOutbox.state': 'pending',
        'dispatchOutbox.kind': { $in: includeResume ? ['create', 'resume'] : ['create'] },
      };
      const rows = await model
        .find({
          ...(cursor ? { _id: { $gt: new mongoose.Types.ObjectId(cursor) } } : {}),
          $and: [activeExpirationFilter<StoredResponseRecord>()],
          ...pending,
        })
        .select('_id tenantId userId responseId')
        .sort({ _id: 1 })
        .limit(limit + 1)
        .lean();
      const page = rows.slice(0, limit);
      return {
        responses: page.map((row) => ({
          userId: row.userId,
          ...(row.tenantId ? { tenantId: row.tenantId } : {}),
          responseId: row.responseId,
        })),
        ...(rows.length > limit ? { next: String(page[page.length - 1]._id) } : {}),
      };
    },
    async settleDispatch(owner, responseId, token) {
      if (!token.id || !['create', 'resume'].includes(token.kind))
        throw new TypeError('Invalid response dispatch identity');
      return commitInOpenScope(
        owner,
        responseId,
        async (session, record) => {
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
            { ...scope(owner), responseId },
            {
              $set: { dispatchOutbox: { ...token, state: 'settled' } },
            },
            { session },
          );
          return updated.matchedCount === 1;
        },
        false,
      );
    },
    async read(owner, responseId) {
      const record = await model.findOne({ ...scope(owner), responseId }).lean();
      if (record && (await isResponseScopeClosed(mongoose, owner, record.conversationId)))
        return null;
      return record;
    },
    async readCleanupIdentity(owner, responseId, retained) {
      const record = await includeManagedAllocations(
        model
          .findOne({ ...ownerScope(owner), responseId })
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
        generationCreatedAt:
          generationCreatedAt ?? (retirement ? matchingRetained?.generationCreatedAt : undefined),
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
      const record = await model
        .findOneAndUpdate(
          {
            ...scope(owner),
            responseId,
            status: { $in: active },
            $or: [{ deliveryKey: { $exists: false } }, { deliveryKey }],
          },
          { $set: { deliveryKey } },
          { new: true },
        )
        .lean();
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
      const record = await model
        .findOneAndUpdate(
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
        )
        .lean();
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
      return model.findOne({ ...scope(owner), responseId }).lean();
    },
  };
}
