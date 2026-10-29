import { randomUUID } from 'node:crypto';
import {
  channelStorageConfigSchema,
  CHANNEL_DELIVERY_PARTS_HARD_MAX,
} from 'librechat-data-provider';
import type {
  ChannelStorageConfig,
  ChannelRunFence,
  ChannelRunSnapshot,
  ChannelDeliveryPlan,
  ChannelDeliveryReceipt,
  ChannelRunProgress,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ChannelLaneScope, ChannelRunEnrollment } from './channelProtocol';
import type { ChannelRunRecord, ChannelLaneRecord } from '~/models/channelRun';
import type { StoredResponseRecord } from '~/models/response';
import {
  digest,
  laneKey,
  activeStates,
  assertReconciliation,
  assertDeliveryEvidence,
  snapshotPatch,
  assertPlan,
  deliveryDisposition,
  hasPermanentDeliveryFailure,
  leaseDeadline,
  ChannelRunConflict,
} from './channelProtocol';
import { initializeChannelScope, touchChannelScope } from './channelScope';
import { prepareChannelOwnerAdmission } from './channelOwner';
import { createChannelIndexGate } from './channelIndexes';
import { responseOwnerFilter } from './responseScope';
import { getTenantId } from '~/config/tenantContext';

export type { ChannelRunRecord, ChannelLaneRecord } from '~/models/channelRun';

export type { ChannelLaneScope, ChannelRunEnrollment } from './channelProtocol';
export { ChannelRunConflict } from './channelProtocol';

export interface ChannelRunStorage {
  listPendingMetadata(
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    runs: Array<{ tenantId: string; channelId: string; runId: string }>;
    next?: string;
  }>;
  claimAuthorityLost(
    run: ChannelRunRecord,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<ChannelRunRecord | null>;
  admit(
    input: ChannelRunEnrollment,
    now: number,
  ): Promise<{ run: ChannelRunRecord; duplicate: boolean }>;
  claim(
    tenantId: string,
    channelId: string,
    owner: string,
    now: number,
    leaseMs: number,
  ): Promise<ChannelRunRecord | null>;
  renew(tenantId: string, fence: ChannelRunFence, now: number, leaseMs: number): Promise<boolean>;
  /** Yield only a drained projection turn, never its execution or actor lane. */
  yieldLease(
    tenantId: string,
    channelId: string,
    fence: ChannelRunFence,
    now: number,
  ): Promise<boolean>;
  read(tenantId: string, channelId: string, runId: string): Promise<ChannelRunRecord | null>;
  readActiveThread(scope: ChannelLaneScope, before: number): Promise<ChannelRunRecord | null>;
  prepareExecution(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
  ): Promise<ChannelRunRecord>;
  bindResponse(
    tenantId: string,
    fence: ChannelRunFence,
    responseId: string,
    now: number,
  ): Promise<ChannelRunRecord>;
  /** Stop-only reconciliation. Absence is not proof that response creation has retired. */
  recoverResponse(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
  ): Promise<ChannelRunRecord | null>;
  attachResponseCredential(
    tenantId: string,
    fence: ChannelRunFence,
    credential: { apiKeyId: string; encryptedApiKey: string },
    now: number,
  ): Promise<ChannelRunRecord>;
  finishUnstartedResponseCancellation(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
  ): Promise<ChannelRunRecord>;
  saveSnapshot(
    tenantId: string,
    fence: ChannelRunFence,
    snapshot: ChannelRunSnapshot,
    now: number,
    generationCreatedAt?: number,
  ): Promise<ChannelRunRecord>;
  savePlan(
    tenantId: string,
    fence: ChannelRunFence,
    plan: ChannelDeliveryPlan,
    now: number,
  ): Promise<ChannelRunRecord>;
  planProgress(
    tenantId: string,
    fence: ChannelRunFence,
    plan: Pick<ChannelRunProgress, 'revision' | 'rendererVersion' | 'text'>,
    now: number,
  ): Promise<ChannelRunRecord>;
  beginProgress(
    tenantId: string,
    fence: ChannelRunFence,
    revision: number,
    now: number,
  ): Promise<ChannelRunRecord>;
  settleProgress(
    tenantId: string,
    fence: ChannelRunFence,
    receipt: Omit<ChannelRunProgress, 'rendererVersion' | 'text'>,
    now: number,
  ): Promise<ChannelRunRecord>;
  reconcileProgress(
    tenantId: string,
    fence: ChannelRunFence,
    receipt: Pick<ChannelRunProgress, 'revision' | 'attempts' | 'externalMessageKey'>,
    now: number,
  ): Promise<ChannelRunRecord>;
  beginDelivery(
    tenantId: string,
    fence: ChannelRunFence,
    operationId: string,
    now: number,
  ): Promise<ChannelRunRecord>;
  settleDelivery(
    tenantId: string,
    fence: ChannelRunFence,
    receipt: ChannelDeliveryReceipt,
    now: number,
  ): Promise<ChannelRunRecord>;
  /** Confirm a previously uncertain send only after verifying its provider receipt. Never resends. */
  reconcileDelivery(
    tenantId: string,
    fence: ChannelRunFence,
    receipt: ChannelDeliveryReceipt & { outcome: 'confirmed' },
    now: number,
  ): Promise<ChannelRunRecord>;
  checkpointUpload(
    tenantId: string,
    fence: ChannelRunFence,
    operationId: string,
    attempts: number,
    upload: NonNullable<ChannelDeliveryReceipt['upload']>,
    now: number,
  ): Promise<ChannelRunRecord>;
  commitDelivery(tenantId: string, fence: ChannelRunFence, now: number): Promise<ChannelRunRecord>;
  markAuthorityLost(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
  ): Promise<ChannelRunRecord>;
  finishAuthorityLost(tenantId: string, fence: ChannelRunFence, now: number): Promise<void>;
  requestCancel(
    scope: ChannelLaneScope,
    runId: string,
    observed?: { epoch: number; before: number },
  ): Promise<boolean>;
  findDeliveredReply(
    scope: ChannelLaneScope,
    externalMessageKey: string,
  ): Promise<ChannelRunRecord | null>;
}

function authorityLost(run: ChannelRunRecord): Partial<ChannelRunRecord> {
  return {
    cancellationRequested: true,
    errorCode: 'channel_authority_changed',
    receipts: run.receipts.map((receipt) =>
      receipt.outcome === 'inflight' ? { ...receipt, outcome: 'unknown' as const } : receipt,
    ),
    ...(run.progress?.outcome === 'inflight'
      ? { progress: { ...run.progress, outcome: 'unknown' as const } }
      : {}),
  };
}

/** Mongo transactions protect FIFO and cursor/receipt commit; a standalone Mongo fails closed. */
export function createChannelRunStorage(
  mongoose: typeof import('mongoose'),
  options: Partial<ChannelStorageConfig> = {},
): ChannelRunStorage {
  const limits = channelStorageConfigSchema.parse(options);
  const runs = () => mongoose.model<ChannelRunRecord>('ChannelRun');
  const lanes = () => mongoose.model<ChannelLaneRecord>('ChannelLane');
  const ensureIndexes = createChannelIndexGate(
    () => [runs(), lanes()],
    async () => {
      // The prototype index was narrower than provider event identity. Build its
      // replacement first, then remove only that exact old unique constraint.
      const legacy = {
        tenantId: 1,
        channelId: 1,
        'admission.actor.teamId': 1,
        'admission.eventId': 1,
      };
      for (const index of await runs().listIndexes()) {
        if (!index.unique || !index.name || digest(index.key) !== digest(legacy)) continue;
        try {
          await runs().cleanIndexes({ toDrop: [index.name] });
        } catch (error) {
          if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 27) throw error;
        }
      }
    },
  );
  async function transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    await ensureIndexes();
    const session = await mongoose.startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await work(session);
      });
      if (result === undefined) throw new Error('Channel transaction did not commit');
      return result;
    } finally {
      await session.endSession();
    }
  }
  const terminalUnset = { leaseOwner: 1, 'execution.encryptedApiKey': 1 } as const;
  const predicate = (tenantId: string, fence: ChannelRunFence, now: number) => ({
    tenantId,
    runId: fence.runId,
    leaseOwner: fence.owner,
    leaseEpoch: fence.epoch,
    leaseExpiresAt: { $gt: now },
    state: { $in: activeStates },
  });
  async function owned(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
    session: ClientSession,
  ) {
    const run = await runs()
      .findOne(predicate(tenantId, fence, now))
      .session(session)
      .lean();
    if (!run) throw new ChannelRunConflict('stale_fence');
    return run;
  }
  async function mutate(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
    change: (run: ChannelRunRecord, session: ClientSession) => Promise<Partial<ChannelRunRecord>>,
  ): Promise<ChannelRunRecord> {
    return transaction(async (session) => {
      const run = await owned(tenantId, fence, now, session);
      const patch = await change(run, session);
      const result = await runs()
        .findOneAndUpdate(predicate(tenantId, fence, now), { $set: patch }, { new: true, session })
        .lean();
      if (!result) throw new ChannelRunConflict('stale_fence');
      return result;
    });
  }
  async function responseBinding(
    run: ChannelRunRecord,
    session: ClientSession,
    responseId?: string,
  ): Promise<Partial<ChannelRunRecord> | null> {
    if (
      !run.execution ||
      (run.state !== 'executing' && run.execution.protocol !== 'responses') ||
      run.execution.deliveryKey != null ||
      run.execution.enqueueAttemptedAt != null ||
      (run.execution.responseId != null && run.execution.responseId !== responseId)
    )
      throw new ChannelRunConflict('invalid_transition');
    const response = await mongoose
      .model<StoredResponseRecord>('StoredResponse')
      .findOne({
        ...responseOwnerFilter({
          tenantId: run.tenantId === '_' ? undefined : run.tenantId,
          userId: run.principal.userId,
        }),
        agentId: run.agentId,
        ...(responseId === undefined ? {} : { responseId }),
        requestKey: `channel:${run.runId}`,
        ...(run.execution.apiKeyId ? { sourceKeyId: run.execution.apiKeyId } : {}),
      })
      .session(session)
      .lean();
    if (!response) return null;
    const request: {
      input?: string;
      model?: string;
      previous_response_id?: string;
      background?: boolean;
      store?: boolean;
    } = JSON.parse(response.requestJSON);
    const previous =
      run.execution.parentMessageId === '00000000-0000-0000-0000-000000000000'
        ? undefined
        : run.execution.parentMessageId;
    if (
      request.model !== run.agentId ||
      request.input !== run.admission.input ||
      (run.execution.responseId == null && request.previous_response_id !== previous) ||
      request.background !== true ||
      request.store === false
    )
      throw new ChannelRunConflict('invalid_transition');
    return {
      execution: {
        ...run.execution,
        protocol: 'responses',
        responseId: response.responseId,
        conversationId: response.conversationId,
        parentMessageId: response.parentMessageId,
        ...(response.generationCreatedAt == null
          ? {}
          : { generationCreatedAt: response.generationCreatedAt }),
      },
    };
  }
  return {
    async listPendingMetadata(cursor, limit) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > limits.maxMetadataPageSize ||
        (cursor && !mongoose.isValidObjectId(cursor))
      )
        throw new Error('Invalid run metadata page');
      await ensureIndexes();
      const records = await runs()
        .find({ state: { $in: activeStates }, ...(cursor ? { _id: { $gt: cursor } } : {}) })
        .select({ _id: 1, tenantId: 1, channelId: 1, runId: 1 })
        .sort({ _id: 1 })
        .limit(limit + 1)
        .lean();
      const page = records.slice(0, limit);
      return {
        runs: page.map(({ tenantId, channelId, runId }) => ({ tenantId, channelId, runId })),
        ...(records.length > limit ? { next: String(page[page.length - 1]._id) } : {}),
      };
    },
    async claimAuthorityLost(run, owner, now, leaseMs) {
      if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
        throw new Error('Invalid cleanup lease');
      return transaction(async (session) => {
        const filter = {
          tenantId: run.tenantId,
          channelId: run.channelId,
          runId: run.runId,
          leaseEpoch: run.leaseEpoch,
          state: { $in: activeStates },
          $or: [
            { errorCode: { $ne: 'channel_authority_changed' } },
            { leaseExpiresAt: { $lte: now } },
          ],
        };
        const current = await runs().findOne(filter).session(session).lean();
        if (!current) return null;
        return runs()
          .findOneAndUpdate(
            filter,
            {
              $set: {
                ...authorityLost(current),
                leaseOwner: owner,
                leaseExpiresAt: leaseDeadline(now, leaseMs),
              },
              $inc: { leaseEpoch: 1 },
            },
            { new: true, session },
          )
          .lean();
      });
    },
    async admit(input, now) {
      const ownerAdmission = await prepareChannelOwnerAdmission(mongoose, {
        userId: input.principal.userId,
        tenantId: input.tenantId === '_' ? undefined : input.tenantId,
      });
      await initializeChannelScope(mongoose, input.tenantId, input.channelId);
      const eventKey = {
        tenantId: input.tenantId,
        channelId: input.channelId,
        'admission.actor.teamId': input.admission.actor.teamId,
        'admission.actor.appId': input.admission.actor.appId,
        'admission.eventId': input.admission.eventId,
      };
      const payloadHash = digest(input.admission);
      const laneId = laneKey(input);
      try {
        return await transaction(async (session) => {
          if (!(await ownerAdmission(session))) throw new ChannelRunConflict('invalid_transition');
          if (!(await touchChannelScope(mongoose, input.tenantId, input.channelId, session)))
            throw new ChannelRunConflict('invalid_transition');
          const existing = await runs().findOne(eventKey).session(session).lean();
          if (existing) {
            if (
              digest(existing.admission) !== payloadHash ||
              existing.agentId !== input.agentId ||
              digest(existing.principal) !== digest(input.principal)
            )
              throw new ChannelRunConflict('event_conflict');
            return { run: existing, duplicate: true };
          }
          const lane = await lanes()
            .findOneAndUpdate(
              { tenantId: input.tenantId, laneId },
              {
                $inc: { nextSequence: 1 },
                $setOnInsert: {
                  channelId: input.channelId,
                  userId: input.principal.userId,
                },
              },
              { upsert: true, new: true, session },
            )
            .lean();
          if (!lane) throw new Error('Channel lane unavailable');
          const [record] = await runs().create(
            [
              {
                ...input,
                runId: randomUUID(),
                laneId,
                payloadHash,
                sequence: lane.nextSequence,
                receivedAt: now,
                state: 'queued',
                leaseEpoch: 0,
                leaseExpiresAt: 0,
                receipts: [],
                cancellationRequested: false,
              },
            ],
            { session },
          );
          return { run: record.toObject(), duplicate: false };
        });
      } catch (error) {
        if (
          !(error instanceof mongoose.mongo.MongoServerError) ||
          error.code !== 11000 ||
          (error.keyPattern?.['admission.eventId'] == null &&
            !error.message.includes('channel_run_event_v2'))
        )
          throw error;
        const existing = await runs().findOne(eventKey).lean();
        if (!existing) throw new ChannelRunConflict('event_conflict');
        if (
          digest(existing.admission) !== payloadHash ||
          existing.agentId !== input.agentId ||
          digest(existing.principal) !== digest(input.principal)
        )
          throw new ChannelRunConflict('event_conflict');
        return { run: existing, duplicate: true };
      }
    },
    async claim(tenantId, channelId, owner, now, leaseMs) {
      if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
        throw new Error('Invalid channel lease');
      return transaction(async (session) => {
        const candidates = await runs()
          .find({
            tenantId,
            channelId,
            state: { $in: activeStates },
            leaseExpiresAt: { $lte: now },
          })
          .sort({ claimCheckedAt: 1, receivedAt: 1, sequence: 1 })
          .hint('channel_run_fair_claim')
          .limit(limits.claimBatchSize)
          .session(session)
          .lean();
        const laneCache = new Map<string, ChannelLaneRecord | null>();
        for (const run of candidates) {
          if (!laneCache.has(run.laneId))
            laneCache.set(
              run.laneId,
              await lanes().findOne({ tenantId, laneId: run.laneId }).session(session).lean(),
            );
          const lane = laneCache.get(run.laneId);
          if (
            !lane ||
            (lane.activeRunId && lane.activeRunId !== run.runId) ||
            (await runs()
              .exists({
                tenantId,
                laneId: run.laneId,
                sequence: { $lt: run.sequence },
                state: { $in: activeStates },
              })
              .hint('channel_run_active_predecessor')
              .session(session))
          ) {
            await runs().updateOne(
              {
                tenantId,
                runId: run.runId,
                leaseEpoch: run.leaseEpoch,
                leaseExpiresAt: run.leaseExpiresAt,
              },
              { $set: { claimCheckedAt: now } },
              { session },
            );
            continue;
          }
          await lanes().updateOne(
            { tenantId, laneId: run.laneId },
            { $set: { activeRunId: run.runId } },
            { session },
          );
          // An expired sender may have reached Slack. Recovery must never turn this into a repost.
          const receipts = run.receipts.map((receipt) =>
            receipt.outcome === 'inflight' ? { ...receipt, outcome: 'unknown' as const } : receipt,
          );
          return runs()
            .findOneAndUpdate(
              { tenantId, runId: run.runId, leaseEpoch: run.leaseEpoch },
              {
                $set: {
                  leaseOwner: owner,
                  leaseExpiresAt: leaseDeadline(now, leaseMs),
                  claimCheckedAt: now,
                  receipts,
                  ...(run.progress?.outcome === 'inflight'
                    ? { progress: { ...run.progress, outcome: 'unknown' } }
                    : {}),
                },
                $inc: { leaseEpoch: 1 },
              },
              { new: true, session },
            )
            .lean();
        }
        return null;
      });
    },
    async renew(tenantId, fence, now, leaseMs) {
      const result = await runs().updateOne(predicate(tenantId, fence, now), {
        $max: { leaseExpiresAt: leaseDeadline(now, leaseMs) },
      });
      return result.matchedCount === 1;
    },
    async yieldLease(tenantId, channelId, fence, now) {
      if ((getTenantId() ?? '_') !== tenantId) return false;
      const result = await runs().updateOne(
        {
          ...predicate(tenantId, fence, now),
          channelId,
          state: { $in: ['executing', 'requires_action', 'blocked'] },
          'execution.protocol': 'responses',
          'execution.responseId': { $type: 'string' },
          plan: { $exists: false },
          'progress.outcome': { $nin: ['inflight', 'unknown'] },
          receipts: { $not: { $elemMatch: { outcome: { $in: ['inflight', 'unknown'] } } } },
        },
        {
          // Clearing owner invalidates its fence immediately; expiry records the
          // configured next eligibility, not continued execution ownership.
          $set: { leaseExpiresAt: now + limits.projectionYieldMs },
          $unset: { leaseOwner: 1 },
        },
      );
      return result.modifiedCount === 1;
    },
    async read(tenantId, channelId, runId) {
      return runs().findOne({ tenantId, channelId, runId }).lean();
    },
    async prepareExecution(tenantId, fence, now) {
      return mutate(tenantId, fence, now, async (run, session) => {
        if (run.execution) return {};
        if (run.state !== 'queued') throw new ChannelRunConflict('invalid_transition');
        const lane = await lanes()
          .findOne({ tenantId, laneId: run.laneId, activeRunId: run.runId })
          .session(session)
          .lean();
        if (!lane) throw new ChannelRunConflict('stale_fence');
        return {
          state: 'executing',
          execution: {
            requestId: run.runId,
            conversationId: lane.conversationId ?? randomUUID(),
            parentMessageId: lane.responseId ?? '00000000-0000-0000-0000-000000000000',
          },
        };
      });
    },
    async finishUnstartedResponseCancellation(tenantId, fence, now) {
      return mutate(tenantId, fence, now, async (run) => {
        const execution = run.execution;
        if (
          !run.cancellationRequested ||
          !execution ||
          execution.apiKeyId ||
          execution.responseId ||
          execution.generationCreatedAt != null ||
          execution.deliveryKey ||
          execution.enqueueAttemptedAt ||
          run.plan
        )
          throw new ChannelRunConflict('invalid_transition');
        return {
          state: 'delivering' as const,
          execution: { ...execution, protocol: 'responses' as const },
          snapshot: {
            status: 'cancelled' as const,
            text: '',
            elapsedMs: Math.max(0, now - run.receivedAt),
          },
        };
      });
    },
    async attachResponseCredential(tenantId, fence, credential, now) {
      return mutate(tenantId, fence, now, async (run) => {
        if (
          !run.execution ||
          !['queued', 'executing', 'requires_action'].includes(run.state) ||
          run.execution.deliveryKey ||
          run.execution.enqueueAttemptedAt ||
          !credential.apiKeyId ||
          !credential.encryptedApiKey ||
          run.cancellationRequested
        )
          throw new ChannelRunConflict('invalid_transition');
        if (run.execution.apiKeyId) {
          if (
            run.execution.apiKeyId !== credential.apiKeyId ||
            run.execution.encryptedApiKey !== credential.encryptedApiKey
          )
            throw new ChannelRunConflict('invalid_transition');
          return {};
        }
        return { execution: { ...run.execution, protocol: 'responses' as const, ...credential } };
      });
    },
    async bindResponse(tenantId, fence, responseId, now) {
      return mutate(tenantId, fence, now, async (run, session) => {
        const patch = await responseBinding(run, session, responseId);
        if (!patch) throw new ChannelRunConflict('invalid_transition');
        return patch;
      });
    },
    async recoverResponse(tenantId, fence, now) {
      if ((getTenantId() ?? '_') !== tenantId) throw new ChannelRunConflict('invalid_transition');
      return transaction(async (session) => {
        const run = await owned(tenantId, fence, now, session);
        if (
          !run.cancellationRequested ||
          run.execution?.protocol !== 'responses' ||
          !run.execution.apiKeyId ||
          run.execution.deliveryKey != null ||
          run.execution.enqueueAttemptedAt != null
        )
          throw new ChannelRunConflict('invalid_transition');
        if (run.execution.responseId) return run;
        const patch = await responseBinding(run, session);
        if (!patch) return null;
        const recovered = await runs()
          .findOneAndUpdate(
            { ...predicate(tenantId, fence, now), cancellationRequested: true },
            { $set: patch },
            { new: true, session },
          )
          .lean();
        if (!recovered) throw new ChannelRunConflict('stale_fence');
        return recovered;
      });
    },
    async saveSnapshot(tenantId, fence, snapshot, now, generationCreatedAt) {
      return mutate(tenantId, fence, now, async (run) => {
        if (!run.execution) throw new ChannelRunConflict('invalid_transition');
        if (
          generationCreatedAt != null &&
          run.execution.generationCreatedAt != null &&
          generationCreatedAt !== run.execution.generationCreatedAt
        )
          throw new ChannelRunConflict('invalid_transition');
        return {
          ...snapshotPatch(run, snapshot),
          execution: {
            ...run.execution,
            ...(generationCreatedAt != null ? { generationCreatedAt } : {}),
          },
        };
      });
    },
    async savePlan(tenantId, fence, plan, now) {
      return mutate(tenantId, fence, now, async (run) => {
        if (run.plan) {
          if (digest(run.plan) !== digest(plan)) throw new ChannelRunConflict('invalid_transition');
          return {};
        }
        assertPlan(run, plan, limits.maxDeliveryParts);
        return {
          plan,
          receipts: plan.parts.map(({ operationId }) => ({
            operationId,
            outcome: 'planned',
            attempts: 0,
          })),
        };
      });
    },
    async planProgress(tenantId, fence, plan, now) {
      return mutate(tenantId, fence, now, async (run) => {
        const previous = run.progress;
        if (previous?.revision === plan.revision) {
          if (previous.text !== plan.text || previous.rendererVersion !== plan.rendererVersion)
            throw new ChannelRunConflict('invalid_transition');
          return {};
        }
        const writable =
          ['queued', 'executing', 'requires_action'].includes(run.state) ||
          (run.state === 'delivering' && Boolean(previous?.externalMessageKey));
        if (
          run.plan ||
          !writable ||
          plan.revision !== (previous?.revision ?? 0) + 1 ||
          (previous && previous.outcome !== 'confirmed')
        ) {
          throw new ChannelRunConflict('invalid_transition');
        }
        return {
          progress: {
            ...plan,
            outcome: 'planned',
            attempts: 0,
            ...(previous?.externalMessageKey
              ? { externalMessageKey: previous.externalMessageKey }
              : {}),
          },
        };
      });
    },
    async beginProgress(tenantId, fence, revision, now) {
      return mutate(tenantId, fence, now, async (run) => {
        const progress = run.progress;
        const writable =
          ['queued', 'executing', 'requires_action'].includes(run.state) ||
          (run.state === 'delivering' && Boolean(progress?.externalMessageKey));
        if (
          run.plan ||
          !writable ||
          !progress ||
          progress.revision !== revision ||
          !['planned', 'retryable'].includes(progress.outcome) ||
          (progress.retryAt ?? 0) > now
        )
          throw new ChannelRunConflict('invalid_transition');
        return { progress: { ...progress, outcome: 'inflight', attempts: progress.attempts + 1 } };
      });
    },
    async settleProgress(tenantId, fence, receipt, now) {
      return mutate(tenantId, fence, now, async (run) => {
        const previous = run.progress;
        if (
          previous &&
          previous.outcome !== 'inflight' &&
          ['confirmed', 'retryable', 'unknown', 'permanent_failure'].includes(receipt.outcome) &&
          previous.attempts === receipt.attempts &&
          previous.outcome === receipt.outcome &&
          digest({ ...previous, ...receipt }) === digest(previous)
        )
          return {};
        if (
          !previous ||
          previous.outcome !== 'inflight' ||
          previous.revision !== receipt.revision ||
          previous.attempts !== receipt.attempts ||
          !['confirmed', 'retryable', 'unknown', 'permanent_failure'].includes(receipt.outcome) ||
          (receipt.outcome === 'confirmed' && !receipt.externalMessageKey) ||
          (previous.externalMessageKey &&
            receipt.externalMessageKey &&
            previous.externalMessageKey !== receipt.externalMessageKey)
        ) {
          throw new ChannelRunConflict('invalid_transition');
        }
        return { progress: { ...previous, ...receipt } };
      });
    },
    async beginDelivery(tenantId, fence, operationId, now) {
      return mutate(tenantId, fence, now, async (run) => {
        if (!run.plan) throw new ChannelRunConflict('invalid_transition');
        assertPlan(run, run.plan, CHANNEL_DELIVERY_PARTS_HARD_MAX);
        if (hasPermanentDeliveryFailure(run)) throw new ChannelRunConflict('invalid_transition');
        const index = run.receipts.findIndex((receipt) => receipt.operationId === operationId);
        const receipt = run.receipts[index];
        if (
          !run.plan ||
          !receipt ||
          !['planned', 'retryable'].includes(receipt.outcome) ||
          (receipt.retryAt ?? 0) > now
        )
          throw new ChannelRunConflict('invalid_transition');
        if (
          run.receipts
            .slice(0, index)
            .some((prior, i) => run.plan?.parts[i].required && prior.outcome !== 'confirmed')
        )
          throw new ChannelRunConflict('delivery_incomplete');
        return {
          receipts: run.receipts.map((part) =>
            part.operationId === operationId
              ? { ...part, outcome: 'inflight' as const, attempts: part.attempts + 1 }
              : part,
          ),
        };
      });
    },
    async settleDelivery(tenantId, fence, receipt, now) {
      return mutate(tenantId, fence, now, async (run) => {
        const previous = run.receipts.find((part) => part.operationId === receipt.operationId);
        if (
          previous &&
          previous.outcome !== 'inflight' &&
          ['confirmed', 'retryable', 'unknown', 'permanent_failure'].includes(receipt.outcome) &&
          previous.attempts === receipt.attempts &&
          previous.outcome === receipt.outcome &&
          digest({ ...previous, ...receipt }) === digest(previous)
        )
          return {};
        if (
          !previous ||
          previous.outcome !== 'inflight' ||
          previous.attempts !== receipt.attempts ||
          !['confirmed', 'retryable', 'unknown', 'permanent_failure'].includes(receipt.outcome) ||
          (previous?.upload &&
            receipt.externalFileId &&
            previous.upload.fileId !== receipt.externalFileId)
        )
          throw new ChannelRunConflict('invalid_transition');
        assertDeliveryEvidence(run, receipt, previous);
        return {
          receipts: run.receipts.map((part) =>
            part.operationId === receipt.operationId ? { ...part, ...receipt } : part,
          ),
        };
      });
    },
    async reconcileProgress(tenantId, fence, receipt, now) {
      return mutate(tenantId, fence, now, async (run) => {
        if (run.progress?.revision !== receipt.revision || !receipt.externalMessageKey)
          throw new ChannelRunConflict('invalid_transition');
        assertReconciliation(run.progress, receipt);
        return {
          progress: {
            ...run.progress,
            outcome: 'confirmed' as const,
            externalMessageKey: receipt.externalMessageKey,
            retryAt: undefined,
            errorCode: undefined,
          },
        };
      });
    },
    async reconcileDelivery(tenantId, fence, receipt, now) {
      return mutate(tenantId, fence, now, async (run) => {
        const previous = run.receipts.find((part) => part.operationId === receipt.operationId);
        if (
          !run.plan?.parts.some((part) => part.operationId === receipt.operationId) ||
          receipt.outcome !== 'confirmed'
        )
          throw new ChannelRunConflict('invalid_transition');
        assertReconciliation(previous, receipt);
        assertDeliveryEvidence(run, receipt, previous);
        return {
          receipts: run.receipts.map((part) =>
            part.operationId === receipt.operationId
              ? {
                  ...part,
                  outcome: 'confirmed' as const,
                  externalMessageKey: receipt.externalMessageKey,
                  externalFileId: receipt.externalFileId,
                  retryAt: undefined,
                  errorCode: undefined,
                }
              : part,
          ),
        };
      });
    },
    async checkpointUpload(tenantId, fence, operationId, attempts, upload, now) {
      return mutate(tenantId, fence, now, async (run) => {
        if (!run.plan) throw new ChannelRunConflict('invalid_transition');
        assertPlan(run, run.plan, CHANNEL_DELIVERY_PARTS_HARD_MAX);
        const previous = run.receipts.find((part) => part.operationId === operationId);
        const part = run.plan?.parts.find((item) => item.operationId === operationId);
        if (
          !previous ||
          previous.outcome !== 'inflight' ||
          previous.attempts !== attempts ||
          part?.kind !== 'artifact' ||
          !upload.fileId ||
          !['allocated', 'uploaded'].includes(upload.stage) ||
          (previous.externalFileId != null && previous.externalFileId !== upload.fileId) ||
          (previous.upload &&
            (previous.upload.fileId !== upload.fileId ||
              (previous.upload.stage === 'uploaded' && upload.stage !== 'uploaded'))) ||
          (!previous.upload && upload.stage !== 'allocated')
        )
          throw new ChannelRunConflict('invalid_transition');
        return {
          receipts: run.receipts.map((item) =>
            item.operationId === operationId ? { ...item, upload } : item,
          ),
        };
      });
    },
    async commitDelivery(tenantId, fence, now) {
      return transaction(async (session) => {
        const existing = await runs()
          .findOne({
            tenantId,
            runId: fence.runId,
            state: { $in: ['delivered', 'failed', 'cancelled'] },
          })
          .session(session)
          .lean();
        if (existing) {
          await runs().updateOne(
            { tenantId, runId: existing.runId, state: existing.state },
            { $unset: terminalUnset },
            { session },
          );
          if (existing.execution) delete existing.execution.encryptedApiKey;
          delete existing.leaseOwner;
          return existing;
        }
        const run = await owned(tenantId, fence, now, session);
        const state = deliveryDisposition(run, CHANNEL_DELIVERY_PARTS_HARD_MAX);
        const success = state === 'delivered';
        const laneUpdate = await lanes().updateOne(
          { tenantId, laneId: run.laneId, activeRunId: run.runId },
          {
            $unset: { activeRunId: 1 },
            ...(success
              ? {
                  $set: {
                    conversationId: run.execution?.conversationId,
                    responseId: run.execution?.responseId,
                  },
                }
              : {}),
          },
          { session },
        );
        if (laneUpdate.modifiedCount !== 1) throw new ChannelRunConflict('stale_fence');
        const result = await runs()
          .findOneAndUpdate(
            predicate(tenantId, fence, now),
            {
              $set: {
                state,
                ...(hasPermanentDeliveryFailure(run)
                  ? { errorCode: 'delivery_permanent_failure' }
                  : {}),
                deliveredAt: now,
                leaseExpiresAt: 0,
              },
              $unset: terminalUnset,
            },
            { new: true, session },
          )
          .lean();
        if (!result) throw new ChannelRunConflict('stale_fence');
        return result;
      });
    },
    async markAuthorityLost(tenantId, fence, now) {
      return mutate(tenantId, fence, now, async (run) => authorityLost(run));
    },
    async finishAuthorityLost(tenantId, fence, now) {
      await transaction(async (session) => {
        const run = await owned(tenantId, fence, now, session);
        if (run.errorCode !== 'channel_authority_changed' || !run.cancellationRequested)
          throw new ChannelRunConflict('invalid_transition');
        await lanes().updateOne(
          { tenantId, laneId: run.laneId, activeRunId: run.runId },
          { $unset: { activeRunId: 1 } },
          { session },
        );
        const result = await runs().updateOne(
          predicate(tenantId, fence, now),
          {
            $set: { state: 'cancelled', leaseExpiresAt: 0 },
            $unset: terminalUnset,
          },
          { session },
        );
        if (result.modifiedCount !== 1) throw new ChannelRunConflict('stale_fence');
        return true;
      });
    },
    async readActiveThread(scope, before) {
      const { tenantId, channelId } = scope;
      const laneId = laneKey(scope);
      const lane = await lanes().findOne({ tenantId, channelId, laneId }).lean();
      if (!lane?.activeRunId) return null;
      // A delayed event must never stop a later claim/generation, even if that
      // run's message was queued before the click. Recovery may conservatively
      // reject an old click after re-claim; the user can click Stop again.
      return runs()
        .findOne({
          tenantId,
          channelId,
          laneId,
          runId: lane.activeRunId,
          state: { $in: ['queued', 'executing', 'requires_action'] },
          claimCheckedAt: { $lte: before },
          receivedAt: { $lte: before },
        })
        .lean();
    },
    async requestCancel(scope, runId, observed) {
      const { tenantId, channelId } = scope;
      if (
        observed &&
        (!Number.isSafeInteger(observed.epoch) ||
          observed.epoch < 0 ||
          !Number.isFinite(observed.before))
      )
        throw new ChannelRunConflict('invalid_transition');
      const result = await runs().updateOne(
        {
          tenantId,
          channelId,
          runId,
          laneId: laneKey(scope),
          state: { $in: ['queued', 'executing', 'requires_action'] },
          ...(observed
            ? {
                leaseEpoch: observed.epoch,
                claimCheckedAt: { $lte: observed.before },
                receivedAt: { $lte: observed.before },
              }
            : {}),
        },
        { $set: { cancellationRequested: true } },
      );
      return result.matchedCount === 1;
    },
    async findDeliveredReply(scope, externalMessageKey) {
      const { tenantId, channelId } = scope;
      return runs()
        .findOne({
          tenantId,
          channelId,
          laneId: laneKey(scope),
          state: 'delivered',
          receipts: { $elemMatch: { externalMessageKey, outcome: 'confirmed' } },
        })
        .lean();
    },
  };
}
