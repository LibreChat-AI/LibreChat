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
  DurableStorageConfig,
} from 'librechat-data-provider';
import type { ChannelRunRecord, ChannelPrincipalLaneRecord } from '~/models/channelRun';
import type { ChannelLaneScope, ChannelRunEnrollment } from './channelProtocol';
import type { StoredResponseRecord } from '~/models/response';
import type { PhysicalChannelRun } from './channelRunWrite';
import type { ChannelRunClaim } from './channelRunControl';
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
import { channelRunTarget, writeChannelRunPatch } from './channelRunWrite';
import { createChannelRunPublication } from './channelRunPublication';
import { createManagedConversationId } from '~/utils/managed';
import { createChannelRunControl } from './channelRunControl';
import { createChannelIndexGate } from './channelIndexes';
import { responseOwnerFilter } from './responseScope';
import { getTenantId } from '~/config/tenantContext';
import { managedTargetFilter } from './managed';

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
  /** Persist one click's immutable target/cutoff; null means no eligible retained target. */
  observeThreadStop(
    scope: ChannelLaneScope,
    eventAt: number,
    observedAt: number,
  ): Promise<{ run: ChannelRunRecord; before: number } | null>;
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

/** Registered FIFO publication and actor control coordinate update-only Run transitions. */
export function createChannelRunStorage(
  mongoose: typeof import('mongoose'),
  options: Partial<ChannelStorageConfig> = {},
  getDurableConfig: () => Promise<Partial<DurableStorageConfig>> = async () => ({}),
): ChannelRunStorage {
  const limits = channelStorageConfigSchema.parse(options);
  const publication = createChannelRunPublication(mongoose, getDurableConfig);
  const runs = () => mongoose.model<ChannelRunRecord>('ChannelRun');
  const lanes = () => mongoose.model<ChannelPrincipalLaneRecord>('ChannelLane');
  const control = createChannelRunControl(mongoose, getDurableConfig);
  const ensureIndexes = createChannelIndexGate(() => [runs(), lanes()]);
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
  ): Promise<PhysicalChannelRun> {
    const run = await runs()
      .findOne(predicate(tenantId, fence, now))
      .select('+_managed')
      .read('primary')
      .lean<PhysicalChannelRun | null>();
    if (!run) throw new ChannelRunConflict('stale_fence');
    return run;
  }
  async function mutate(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
    change: (run: PhysicalChannelRun) => Promise<Partial<ChannelRunRecord>>,
  ): Promise<ChannelRunRecord>;
  async function mutate(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
    change: (run: PhysicalChannelRun) => Promise<Partial<ChannelRunRecord> | null>,
  ): Promise<ChannelRunRecord | null>;
  async function mutate(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
    change: (run: PhysicalChannelRun) => Promise<Partial<ChannelRunRecord> | null>,
  ): Promise<ChannelRunRecord | null> {
    await ensureIndexes();
    let run = await owned(tenantId, fence, now);
    const target = channelRunTarget(run);
    for (;;) {
      if (!(await control.isActive(run))) throw new ChannelRunConflict('stale_fence');
      const patch = await change(run);
      if (patch === null) return null;
      const result = await writeChannelRunPatch(
        mongoose,
        run,
        patch,
        predicate(tenantId, fence, now),
        getDurableConfig,
      );
      if (result) {
        if (!(await control.isActive(result))) throw new ChannelRunConflict('stale_fence');
        return result;
      }
      const current = await runs()
        .findOne({
          ...predicate(tenantId, fence, now),
          ...managedTargetFilter(mongoose, target),
          '_managed.phase': 'published',
        })
        .select('+_managed')
        .read('primary')
        .lean<PhysicalChannelRun | null>();
      if (!current) throw new ChannelRunConflict('stale_fence');
      run = current;
    }
  }
  async function responseBinding(
    run: ChannelRunRecord,
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
      .lean();
    if (!response) return null;
    if (
      response.conversationId !== run.execution.conversationId ||
      response.parentMessageId !== run.execution.parentMessageId
    )
      throw new ChannelRunConflict('invalid_transition');
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
        ...(response.generationCreatedAt == null
          ? {}
          : { generationCreatedAt: response.generationCreatedAt }),
      },
    };
  }
  async function finishTerminal(
    tenantId: string,
    fence: ChannelRunFence,
    now: number,
    authorityLoss: boolean,
  ): Promise<ChannelRunRecord> {
    let run = await runs()
      .findOne({ tenantId, runId: fence.runId, '_managed.phase': 'published' })
      .select('+_managed')
      .read('primary')
      .lean<PhysicalChannelRun | null>();
    if (!run) throw new ChannelRunConflict('stale_fence');
    const target = channelRunTarget(run);
    for (;;) {
      if (['delivered', 'failed', 'cancelled'].includes(run.state)) {
        if (run.terminalFence?.owner !== fence.owner || run.terminalFence.epoch !== fence.epoch)
          throw new ChannelRunConflict('stale_fence');
        return control.repairTerminal(run, now);
      }
      if (
        run.leaseOwner !== fence.owner ||
        run.leaseEpoch !== fence.epoch ||
        run.leaseExpiresAt <= now ||
        !(await control.isActive(run))
      )
        throw new ChannelRunConflict('stale_fence');
      if (
        authorityLoss &&
        (run.errorCode !== 'channel_authority_changed' || !run.cancellationRequested)
      )
        throw new ChannelRunConflict('invalid_transition');
      if (!run.leaseGrantId) throw new Error('Terminal Run lost its grant');
      const state = authorityLoss
        ? 'cancelled'
        : deliveryDisposition(run, CHANNEL_DELIVERY_PARTS_HARD_MAX);
      const result = await writeChannelRunPatch(
        mongoose,
        run,
        {
          state,
          cursorState: 'pending',
          leaseExpiresAt: 0,
          terminalFence: { owner: fence.owner, epoch: fence.epoch, grantId: run.leaseGrantId },
          ...(authorityLoss
            ? {}
            : {
                deliveredAt: now,
                ...(hasPermanentDeliveryFailure(run) && {
                  errorCode: 'delivery_permanent_failure',
                }),
              }),
        },
        predicate(tenantId, fence, now),
        getDurableConfig,
        true,
      );
      if (result) return control.repairTerminal(result, now);
      const current = await runs()
        .findOne({ ...managedTargetFilter(mongoose, target), '_managed.phase': 'published' })
        .select('+_managed')
        .read('primary')
        .lean<PhysicalChannelRun | null>();
      if (!current) throw new ChannelRunConflict('stale_fence');
      run = current;
    }
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
        .find({
          '_managed.phase': 'published',
          state: { $in: activeStates },
          ...(cursor ? { _id: { $gt: cursor } } : {}),
        })
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
      if (!owner) throw new Error('Invalid cleanup lease');
      leaseDeadline(now, leaseMs);
      const current = await runs()
        .findOne({
          tenantId: run.tenantId,
          channelId: run.channelId,
          runId: run.runId,
          leaseEpoch: run.leaseEpoch,
          state: { $in: activeStates },
          $or: [
            { errorCode: { $ne: 'channel_authority_changed' } },
            { leaseExpiresAt: { $lte: now } },
          ],
        })
        .select('_id tenantId publication leaseEpoch +_managed')
        .read('primary')
        .lean<ChannelRunClaim | null>();
      return current ? control.claim(current, owner, now, leaseMs, true) : null;
    },
    admit: publication.admit,
    async claim(tenantId, channelId, owner, now, leaseMs) {
      if (!owner) throw new Error('Invalid channel lease');
      leaseDeadline(now, leaseMs);
      await publication.recoverPending(tenantId, channelId, now, limits.claimBatchSize);
      await ensureIndexes();
      const candidates = await runs()
        .find({
          tenantId,
          channelId,
          '_managed.phase': 'published',
          state: { $in: activeStates },
          leaseExpiresAt: { $lte: now },
        })
        .select(
          '_id tenantId channelId runId laneId sequence publication leaseEpoch leaseExpiresAt +_managed',
        )
        .sort({ claimCheckedAt: 1, receivedAt: 1, sequence: 1 })
        .hint('channel_run_fair_claim')
        .limit(limits.claimBatchSize)
        .read('primary')
        .lean<
          Array<
            ChannelRunClaim &
              Pick<ChannelRunRecord, 'runId' | 'laneId' | 'sequence' | 'leaseExpiresAt'>
          >
        >();
      const first = new Map<string, number>();
      for (const run of candidates)
        first.set(run.laneId, Math.min(first.get(run.laneId) ?? Infinity, run.sequence));
      const blocked = candidates.length
        ? new Set(
            await runs()
              .distinct('laneId', {
                tenantId,
                channelId,
                '_managed.phase': 'published',
                state: { $in: activeStates },
                $or: [...first].map(([laneId, sequence]) => ({
                  laneId,
                  sequence: { $lt: sequence },
                })),
              })
              .read('primary'),
          )
        : new Set<string>();
      for (const run of candidates) {
        if (!blocked.has(run.laneId) && run.sequence === first.get(run.laneId)) {
          const claimed = await control.claim(run, owner, now, leaseMs);
          if (claimed) return claimed;
        }
        await runs().updateOne(
          {
            ...managedTargetFilter(mongoose, channelRunTarget(run)),
            leaseEpoch: run.leaseEpoch,
            leaseExpiresAt: run.leaseExpiresAt,
            state: { $in: activeStates },
          },
          { $set: { claimCheckedAt: now }, $inc: { __v: 1 } },
          { upsert: false },
        );
      }
      return null;
    },
    async renew(tenantId, fence, now, leaseMs) {
      const expiresAt = leaseDeadline(now, leaseMs);
      const run = await runs()
        .findOne(predicate(tenantId, fence, now))
        .select('+_managed')
        .read('primary')
        .lean<PhysicalChannelRun | null>();
      if (!run || !(await control.isActive(run))) return false;
      const result = await runs().updateOne(
        {
          ...predicate(tenantId, fence, now),
          ...managedTargetFilter(mongoose, channelRunTarget(run)),
        },
        { $max: { leaseExpiresAt: expiresAt }, $inc: { __v: 1 } },
        { upsert: false },
      );
      return result.matchedCount === 1 && control.isActive(run);
    },
    async yieldLease(tenantId, channelId, fence, now) {
      if ((getTenantId() ?? '_') !== tenantId) return false;
      const filter = {
        ...predicate(tenantId, fence, now),
        channelId,
        state: { $in: ['executing', 'requires_action', 'blocked'] },
        'execution.protocol': 'responses',
        'execution.responseId': { $type: 'string' },
        plan: { $exists: false },
        'progress.outcome': { $nin: ['inflight', 'unknown'] },
        receipts: { $not: { $elemMatch: { outcome: { $in: ['inflight', 'unknown'] } } } },
      };
      const run = await runs()
        .findOne(filter)
        .select('+_managed')
        .read('primary')
        .lean<PhysicalChannelRun | null>();
      if (!run || !(await control.isActive(run))) return false;
      const result = await runs().updateOne(
        { ...filter, ...managedTargetFilter(mongoose, channelRunTarget(run)), __v: run.__v },
        {
          $set: { leaseExpiresAt: now + limits.projectionYieldMs },
          $unset: { leaseOwner: 1 },
          $inc: { __v: 1 },
        },
        { upsert: false },
      );
      return result.modifiedCount === 1 && control.isActive(run);
    },
    async read(tenantId, channelId, runId) {
      return runs()
        .findOne({ tenantId, channelId, runId, '_managed.phase': 'published' })
        .select('+_managed')
        .read('primary')
        .lean();
    },
    async prepareExecution(tenantId, fence, now) {
      return mutate(tenantId, fence, now, async (run) => {
        if (run.execution) return {};
        if (run.state !== 'queued') throw new ChannelRunConflict('invalid_transition');
        const lane = await lanes()
          .findOne({
            ...managedTargetFilter(mongoose, run.publication!.lane),
            tenantId,
            laneId: run.laneId,
            kind: 'principal',
          })
          .lean();
        if (!lane) throw new ChannelRunConflict('stale_fence');
        return {
          state: 'executing',
          execution: {
            requestId: run.runId,
            conversationId:
              lane.conversationId ??
              createManagedConversationId(JSON.stringify(['channel-run', channelRunTarget(run)])),
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
      return mutate(tenantId, fence, now, async (run) => {
        const patch = await responseBinding(run, responseId);
        if (!patch) throw new ChannelRunConflict('invalid_transition');
        return patch;
      });
    },
    async recoverResponse(tenantId, fence, now) {
      if ((getTenantId() ?? '_') !== tenantId) throw new ChannelRunConflict('invalid_transition');
      return mutate(tenantId, fence, now, async (run) => {
        if (
          !run.cancellationRequested ||
          run.execution?.protocol !== 'responses' ||
          !run.execution.apiKeyId ||
          run.execution.deliveryKey != null ||
          run.execution.enqueueAttemptedAt != null
        )
          throw new ChannelRunConflict('invalid_transition');
        return run.execution.responseId ? {} : responseBinding(run);
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
    commitDelivery: (tenantId, fence, now) => finishTerminal(tenantId, fence, now, false),
    async markAuthorityLost(tenantId, fence, now) {
      return mutate(tenantId, fence, now, async (run) => authorityLost(run));
    },
    async finishAuthorityLost(tenantId, fence, now) {
      await finishTerminal(tenantId, fence, now, true);
    },
    readActiveThread: control.readActive,
    observeThreadStop: control.observeStop,
    async requestCancel(scope, runId, observed) {
      const { tenantId, channelId } = scope;
      if (
        observed &&
        (!Number.isSafeInteger(observed.epoch) ||
          observed.epoch < 0 ||
          !Number.isFinite(observed.before))
      )
        throw new ChannelRunConflict('invalid_transition');
      const run = await runs()
        .findOne({ tenantId, channelId, runId, '_managed.phase': 'published' })
        .select('+_managed')
        .read('primary')
        .lean<PhysicalChannelRun | null>();
      if (!run || laneKey(run) !== laneKey(scope)) return false;
      const result = await runs().updateOne(
        {
          ...managedTargetFilter(mongoose, channelRunTarget(run)),
          '_managed.phase': 'published',
          tenantId,
          channelId,
          runId,
          state: { $in: ['queued', 'executing', 'requires_action'] },
          ...(observed
            ? {
                leaseEpoch: observed.epoch,
                claimCheckedAt: { $lte: observed.before },
                receivedAt: { $lte: observed.before },
              }
            : {}),
        },
        { $set: { cancellationRequested: true }, $inc: { __v: 1 } },
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
