import type {
  ResponseOwner,
  StoredResponseRecord,
  StoredResponseStatus,
  ResponseReviewCheckpoint,
  ResponseResumeIntent,
  ResponseTerminalReceipt,
} from '~/models/response';
import {
  responseScopeKeys,
  responseOwnerFilter,
  isResponseScopeClosed,
  initializeResponseScopes,
} from './responseScope';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createResponseScopeModel } from '~/models/responseScope';
import { createStoredResponseModel } from '~/models/response';
import { getTransactionSupport } from '~/utils/transactions';
import { activeExpirationFilter } from '~/utils/retention';
import { createIndexesWithRetry } from '~/utils/retry';

export type {
  ResponseOwner,
  StoredResponseRecord,
  StoredResponseStatus,
  ResponseReviewCheckpoint,
  ResponseResumeIntent,
  ResponseTerminalReceipt,
} from '~/models/response';

export interface ResponseReservation extends ResponseOwner {
  expiredAt?: Date;
  isTemporary?: boolean;
  responseId: string;
  requestKey: string;
  fingerprint: string;
  agentId: string;
  sourceKeyId?: string;
  requestJSON: string;
  conversationId: string;
  parentMessageId: string;
}

export type ResponseReservationResult =
  | { ok: true; record: StoredResponseRecord; replayed: boolean }
  | { ok: false; code: 'idempotency_conflict' | 'response_unavailable' };

export type ResponseMutationResult =
  | { ok: true; record: StoredResponseRecord }
  | { ok: false; code: 'response_conflict' };

/** Internal drain identity only; expired requests, answers and decisions are never returned. */
export type ResponseCleanupIdentity = Pick<
  StoredResponseRecord,
  | 'userId'
  | 'tenantId'
  | 'responseId'
  | 'agentId'
  | 'conversationId'
  | 'generationCreatedAt'
  | 'expiredAt'
> & {
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
export type ResponseExecutionGuard =
  | number
  | {
      execution: Pick<
        StoredResponseRecord,
        'agentId' | 'sourceKeyId' | 'conversationId' | 'generationCreatedAt' | 'review' | 'resume'
      >;
    };

/** Compatibility name for existing terminal producers. */
export type ResponseTerminalGuard = ResponseExecutionGuard;

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

function responseExecutionFilter(guard: Exclude<ResponseExecutionGuard, number>) {
  const { execution } = guard;
  const filter: Record<string, unknown> = {
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

export interface ResponseStorage {
  stageTerminal(
    owner: ResponseOwner,
    responseId: string,
    guard: ResponseTerminalGuard,
    receipt: ResponseTerminalReceipt,
  ): Promise<ResponseMutationResult>;
  finishTerminal(
    owner: ResponseOwner,
    responseId: string,
    revision: number,
    receipt: ResponseTerminalReceipt,
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

function sameTerminal(a: ResponseTerminalReceipt, b: ResponseTerminalReceipt): boolean {
  return (
    a.generationCreatedAt === b.generationCreatedAt &&
    a.providerExecutionId === b.providerExecutionId &&
    a.ownerId === b.ownerId &&
    a.status === b.status &&
    a.responseJSON === b.responseJSON &&
    a.checkpointNamespace === b.checkpointNamespace &&
    a.checkpointConfigJSON === b.checkpointConfigJSON
  );
}

/** Authorization precedes this storage boundary; every read/write remains owner- and tenant-scoped. */
export function createResponseStorage(mongoose: typeof import('mongoose')): ResponseStorage {
  const model = createStoredResponseModel(mongoose);
  let indexPromise: Promise<void> | undefined;
  let transactionSupport: boolean | null = null;
  function ensureIndexes() {
    indexPromise ??= createIndexesWithRetry(model)
      .then(() => undefined)
      .catch((error: unknown) => {
        indexPromise = undefined;
        throw error;
      });
    return indexPromise;
  }
  function ownerScope(owner: ResponseOwner) {
    if (!owner.userId || owner.tenantId === '__SYSTEM__')
      throw new TypeError('Invalid response owner');
    const tenantId = getTenantId() || undefined;
    if (
      tenantId != null &&
      tenantId !== SYSTEM_TENANT_ID &&
      tenantId !== (owner.tenantId || undefined)
    )
      throw new TypeError('Response tenant does not match authenticated scope');
    return responseOwnerFilter(owner);
  }
  const scope = (owner: ResponseOwner) => ({
    ...ownerScope(owner),
    $and: [activeExpirationFilter<StoredResponseRecord>()],
  });
  return {
    async stageTerminal(owner, responseId, guard, receipt) {
      if (
        typeof guard !== 'number' &&
        guard.execution.generationCreatedAt !== receipt.generationCreatedAt
      )
        return { ok: false, code: 'response_conflict' };
      const execution = typeof guard === 'number' ? undefined : responseExecutionFilter(guard);
      const pendingTerminal: ResponseTerminalReceipt = {
        generationCreatedAt: receipt.generationCreatedAt,
        providerExecutionId: receipt.providerExecutionId,
        ...(receipt.ownerId == null ? {} : { ownerId: receipt.ownerId }),
        status: receipt.status,
        responseJSON: receipt.responseJSON,
        ...(receipt.checkpointNamespace == null
          ? {}
          : { checkpointNamespace: receipt.checkpointNamespace }),
        ...(receipt.checkpointConfigJSON == null
          ? {}
          : { checkpointConfigJSON: receipt.checkpointConfigJSON }),
      };
      const record = await model
        .findOneAndUpdate(
          {
            ...scope(owner),
            responseId,
            ...(execution ?? { revision: guard }),
            generationCreatedAt: receipt.generationCreatedAt,
            status: { $in: active },
            pendingTerminal: { $exists: false },
            $or: [
              {
                'resume.state': 'admitted',
                'resume.providerExecutionId': receipt.providerExecutionId,
              },
              {
                'resume.state': { $ne: 'admitted' },
                'review.providerExecutionId': receipt.providerExecutionId,
              },
              { review: { $exists: false }, resume: { $exists: false } },
            ],
          },
          { $set: { pendingTerminal }, $inc: { revision: 1 } },
          { new: true, runValidators: true },
        )
        .lean();
      if (record) return { ok: true, record };
      const existing = await model.findOne({ ...scope(owner), responseId, ...execution }).lean();
      if (
        existing?.generationCreatedAt === receipt.generationCreatedAt &&
        existing.pendingTerminal &&
        sameTerminal(existing.pendingTerminal, pendingTerminal)
      )
        return { ok: true, record: existing };
      return { ok: false, code: 'response_conflict' };
    },
    async finishTerminal(owner, responseId, revision, receipt) {
      const record = await model
        .findOneAndUpdate(
          {
            ...scope(owner),
            responseId,
            revision,
            generationCreatedAt: receipt.generationCreatedAt,
            status: { $in: active },
            'pendingTerminal.generationCreatedAt': receipt.generationCreatedAt,
            'pendingTerminal.providerExecutionId': receipt.providerExecutionId,
            'pendingTerminal.ownerId': receipt.ownerId ?? { $exists: false },
            'pendingTerminal.status': receipt.status,
            'pendingTerminal.responseJSON': receipt.responseJSON,
            'pendingTerminal.checkpointNamespace': receipt.checkpointNamespace ?? {
              $exists: false,
            },
            'pendingTerminal.checkpointConfigJSON': receipt.checkpointConfigJSON ?? {
              $exists: false,
            },
          },
          {
            $set: { status: receipt.status, responseJSON: receipt.responseJSON },
            $unset: { pendingTerminal: 1 },
            $inc: { revision: 1 },
          },
          { new: true },
        )
        .lean();
      return record ? { ok: true, record } : { ok: false, code: 'response_conflict' };
    },
    async publishReview(owner, responseId, guard, generationCreatedAt, review, responseJSON) {
      if (typeof guard !== 'number' && guard.execution.generationCreatedAt !== generationCreatedAt)
        return { ok: false, code: 'response_conflict' };
      const execution = typeof guard === 'number' ? undefined : responseExecutionFilter(guard);
      const receiptFilter =
        typeof guard === 'number'
          ? undefined
          : {
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
              cancellationRequestedAt: { $exists: false },
            };
      if (
        typeof guard !== 'number' &&
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
            ...(execution ?? { revision: guard }),
            generationCreatedAt,
            status: { $in: ['in_progress', 'requires_action'] },
            pendingTerminal: { $exists: false },
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
      if (
        input.expiredAt != null &&
        (!(input.expiredAt instanceof Date) || !Number.isFinite(input.expiredAt.getTime()))
      )
        throw new TypeError('Invalid response expiration');
      const filter = { ...scope(input), requestKey: input.requestKey };
      transactionSupport = await getTransactionSupport(mongoose, transactionSupport);
      if (!transactionSupport) return { ok: false, code: 'response_unavailable' };
      await ensureIndexes();
      const prior = await model.findOne(filter).select('conversationId').lean();
      const keys = responseScopeKeys(input, prior?.conversationId ?? input.conversationId);
      await initializeResponseScopes(mongoose, keys);
      const session = await mongoose.startSession();
      try {
        let result: ResponseReservationResult | undefined;
        await session.withTransaction(async () => {
          // A write, not a snapshot read: erasure waits for admitted insertions to commit.
          const scopes = createResponseScopeModel(mongoose);
          const touched = await scopes.updateOne(
            { _id: keys[0], closed: false },
            { $inc: { revision: 1 } },
            { session },
          );
          if (touched.matchedCount !== 1) {
            result = { ok: false, code: 'response_unavailable' };
            return;
          }
          const existing = await model.findOne(filter).session(session).lean();
          const conversationKey = responseScopeKeys(
            input,
            existing?.conversationId ?? input.conversationId,
          )[1];
          const conversation = await scopes
            .findOneAndUpdate(
              { _id: conversationKey, closed: false },
              {
                $inc: { revision: 1 },
                ...(input.expiredAt ? { $min: { expiredAt: input.expiredAt } } : {}),
              },
              { session, new: true },
            )
            .lean();
          if (!conversation) {
            result = { ok: false, code: 'response_unavailable' };
            return;
          }
          if (conversation.expiredAt) {
            await model.updateMany(
              {
                ...responseOwnerFilter(input),
                conversationId: existing?.conversationId ?? input.conversationId,
                $or: [{ expiredAt: null }, { expiredAt: { $gt: conversation.expiredAt } }],
              },
              { $set: { expiredAt: conversation.expiredAt } },
              { session },
            );
            if (existing && (!existing.expiredAt || conversation.expiredAt < existing.expiredAt))
              existing.expiredAt = conversation.expiredAt;
            if (conversation.expiredAt.getTime() <= Date.now()) {
              result = { ok: false, code: 'response_unavailable' };
              return;
            }
          }
          if (existing) {
            result =
              existing.fingerprint === input.fingerprint
                ? { ok: true, record: existing, replayed: true }
                : { ok: false, code: 'idempotency_conflict' };
            return;
          }
          const [created] = await model.create(
            [
              {
                ...input,
                ...(conversation.expiredAt ? { expiredAt: conversation.expiredAt } : {}),
                status: 'queued',
                revision: 0,
              },
            ],
            {
              session,
            },
          );
          result = { ok: true, record: created.toObject(), replayed: false };
        });
        if (!result) throw new Error('Response reservation did not commit');
        return result;
      } catch (error) {
        if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000)
          throw error;
        const existing = await model.findOne(filter).lean();
        if (!existing) {
          if (await model.exists({ ...responseOwnerFilter(input), requestKey: input.requestKey }))
            return { ok: false, code: 'response_unavailable' };
          throw error;
        }
        if (await isResponseScopeClosed(mongoose, input, existing.conversationId))
          return { ok: false, code: 'response_unavailable' };
        return existing.fingerprint === input.fingerprint
          ? { ok: true, record: existing, replayed: true }
          : { ok: false, code: 'idempotency_conflict' };
      } finally {
        await session.endSession();
      }
    },
    async read(owner, responseId) {
      return model.findOne({ ...scope(owner), responseId }).lean();
    },
    async readCleanupIdentity(owner, responseId, retained) {
      const record = await model
        .findOne({ ...ownerScope(owner), responseId })
        .select(
          'userId tenantId responseId agentId conversationId generationCreatedAt expiredAt pendingTerminal.checkpointNamespace pendingTerminal.checkpointConfigJSON review.checkpointConfigJSON review.providerExecutionId',
        )
        .lean();
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
      const terminalCheckpoint = record?.pendingTerminal;
      const hasTerminalCheckpoint =
        terminalCheckpoint?.checkpointNamespace != null ||
        terminalCheckpoint?.checkpointConfigJSON != null;
      const checkpointNamespace = hasTerminalCheckpoint
        ? terminalCheckpoint?.checkpointNamespace
        : matchingRetained?.checkpointNamespace;
      const checkpointConfigJSON = hasTerminalCheckpoint
        ? terminalCheckpoint?.checkpointConfigJSON
        : (record?.review?.checkpointConfigJSON ?? matchingRetained?.checkpointConfigJSON);
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
          status: { $in: active },
          cancellationRequestedAt: { $exists: false },
          pendingTerminal: { $exists: false },
        },
        { $set: { cancellationRequestedAt: now } },
      );
      return model.findOne({ ...scope(owner), responseId }).lean();
    },
  };
}
