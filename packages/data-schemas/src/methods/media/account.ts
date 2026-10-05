import { randomUUID } from 'crypto';
import { resolveMediaConfig } from 'librechat-data-provider';
import type { MediaMethods, MediaOwnerScope } from '~/types/media';
import type { MediaPersistenceContext } from './context';
import {
  MediaPersistenceError,
  positiveMediaLimit as positive,
  mediaScopeFilter as scopeFilter,
} from '~/utils/media';
import { createMediaNativePartModel } from '~/models/mediaNativePart';
import { createMediaSettlementModel } from '~/models/mediaSettlement';
import { createTransactionModel } from '~/models/transaction';
import { createBalanceModel } from '~/models/balance';
import { durable, terminal } from './scope';

export function createMediaAccountMethods({
  Owner,
  ownerExists,
  ensureMediaIndexes,
  AssetWrite,
  Job,
  Turn,
  mongoose,
  accounting,
  Thread,
  Preset,
  File,
  reconcileMediaRetirements,
  releaseMediaPermits,
  Permit,
}: Pick<
  MediaPersistenceContext,
  | 'Owner'
  | 'ownerExists'
  | 'ensureMediaIndexes'
  | 'AssetWrite'
  | 'Job'
  | 'Turn'
  | 'mongoose'
  | 'accounting'
  | 'Thread'
  | 'Preset'
  | 'File'
  | 'reconcileMediaRetirements'
  | 'releaseMediaPermits'
  | 'Permit'
>): Pick<
  MediaPersistenceContext,
  | 'assertOwnerActive'
  | 'admitOwnerWork'
  | 'releaseOwnerWork'
  | 'prepareMediaAccountDeletion'
  | 'cancelMediaAccountDeletion'
  | 'completeMediaAccountDeletion'
  | 'reconcileMediaAccountDeletion'
> {
  async function ensureOwner(scope: MediaOwnerScope): Promise<void> {
    const owner = await Owner.findOneAndUpdate(
      scopeFilter(scope),
      {
        $setOnInsert: {
          ...scopeFilter(scope),
          status: 'initializing',
          creationToken: randomUUID(),
          workIds: [],
        },
      },
      { upsert: true, new: true, writeConcern: durable },
    ).lean();
    if (owner.status !== 'initializing') return;
    if (!(await ownerExists(scope))) {
      await Owner.updateOne(
        { ...scopeFilter(scope), status: 'initializing', creationToken: owner.creationToken },
        {
          $set: { status: 'deleted', deletionPrepared: true },
          $unset: { creationToken: 1 },
        },
        { writeConcern: durable },
      );
      throw new MediaPersistenceError('retired', 'Media owner no longer exists');
    }
    // The token cannot activate a tombstone or a replacement row after an arbitrarily paused lookup.
    await Owner.updateOne(
      { ...scopeFilter(scope), status: 'initializing', creationToken: owner.creationToken },
      { $set: { status: 'active' }, $unset: { creationToken: 1 } },
      { writeConcern: durable },
    );
  }

  async function assertOwnerActive(scope: MediaOwnerScope): Promise<void> {
    await ensureOwner(scope);
    if (!(await Owner.exists({ ...scopeFilter(scope), status: 'active' }))) {
      throw new MediaPersistenceError('retired', 'Media account deletion is in progress');
    }
  }

  async function admitOwnerWork(scope: MediaOwnerScope, workId: string): Promise<boolean> {
    await ensureOwner(scope);
    // Publication grants and account deletion share this CAS. A grant survives process death.
    const result = await Owner.updateOne(
      { ...scopeFilter(scope), status: 'active' },
      { $addToSet: { workIds: workId } },
      { writeConcern: durable },
    );
    return result.matchedCount > 0;
  }

  async function releaseOwnerWork(scope: MediaOwnerScope, workId: string): Promise<void> {
    await Owner.updateOne(
      scopeFilter(scope),
      { $pull: { workIds: workId } },
      { writeConcern: durable },
    );
  }

  const prepareMediaAccountDeletion: MediaMethods['prepareMediaAccountDeletion'] = async ({
    scope: inputScope,
    token,
  }) => {
    const scope = scopeFilter(inputScope);
    if (!token) {
      throw new MediaPersistenceError('invalid_input', 'Account deletion requires a token');
    }
    await ensureMediaIndexes();
    await ensureOwner(scope);
    const owner = await Owner.findOneAndUpdate(
      { ...scope, $or: [{ status: 'active' }, { status: 'deleting', deletionToken: token }] },
      { $set: { status: 'deleting', deletionToken: token } },
      { new: true, writeConcern: durable },
    ).lean();
    if (!owner) {
      return false;
    }
    const jobIds = owner.workIds.filter((id) => id.startsWith('job:')).map((id) => id.slice(4));
    const importIds = owner.workIds
      .filter((id) => id.startsWith('import:'))
      .map((id) => id.slice(7));
    const writeIds = owner.workIds.filter((id) => id.startsWith('write:')).map((id) => id.slice(6));
    // A writer that has not won its publication CAS can be cancelled under the owner fence.
    // A committing writer keeps its grant until recovery publishes or rejects its original.
    await AssetWrite.updateMany(
      { ...scope, writeId: { $in: writeIds }, state: 'reserved' },
      { $set: { state: 'abandoned' } },
      { writeConcern: durable },
    );
    const admissionIds = owner.workIds
      .filter((id) => id.startsWith('accounting:'))
      .map((id) => id.slice(11));
    const [settledJobs, publishedImports, terminalWrites, closedAdmissions] = await Promise.all([
      Job.find({
        ...scope,
        jobId: { $in: jobIds },
        phase: { $in: terminal },
        'provider.certainty': { $in: ['unsubmitted', 'terminal'] },
      })
        .select({ jobId: 1 })
        .lean(),
      Turn.find({
        ...scope,
        turnId: { $in: importIds },
        publicationPhase: { $in: ['accepted', 'rejected'] },
      })
        .select({ turnId: 1 })
        .lean(),
      AssetWrite.find({
        ...scope,
        writeId: { $in: writeIds },
        state: { $in: ['published', 'abandoned', 'deleted'] },
      })
        .select({ writeId: 1 })
        .lean(),
      createMediaSettlementModel(mongoose)
        .find({ ...scope, settlementId: { $in: admissionIds }, balanceAcknowledged: true })
        .select({ settlementId: 1 })
        .lean(),
    ]);
    const completed = [
      ...settledJobs.map((job) => `job:${job.jobId}`),
      ...publishedImports.map((turn) => `import:${turn.turnId}`),
      ...terminalWrites.map((write) => `write:${write.writeId}`),
      ...closedAdmissions.map((record) => `accounting:${record.settlementId}`),
    ];
    if (completed.length) {
      await Owner.updateOne(
        { ...scope, status: 'deleting', deletionToken: token },
        { $pull: { workIds: { $in: completed } } },
        { writeConcern: durable },
      );
    }
    // No new grant can appear behind this fence. Staged rows without a grant cannot publish or execute.
    const [pendingGrant, activeJob] = await Promise.all([
      Owner.exists({
        ...scope,
        status: 'deleting',
        deletionToken: token,
        'workIds.0': { $exists: true },
      }),
      Job.exists({ ...scope, phase: { $nin: terminal } }),
    ]);
    if (pendingGrant || activeJob) {
      return false;
    }
    const prepared = await Owner.updateOne(
      { ...scope, status: 'deleting', deletionToken: token, workIds: { $size: 0 } },
      { $set: { deletionPrepared: true } },
      { writeConcern: durable },
    );
    return prepared.matchedCount > 0;
  };

  const cancelMediaAccountDeletion: MediaMethods['cancelMediaAccountDeletion'] = async ({
    scope,
    token,
  }) => {
    await Owner.updateOne(
      { ...scopeFilter(scope), status: 'deleting', deletionToken: token },
      {
        $set: { status: 'active' },
        $unset: { deletionToken: 1, deletionPrepared: 1 },
      },
      { writeConcern: durable },
    );
  };

  const purgeDeletedAccountAccounting = async (scope: MediaOwnerScope) => {
    await accounting.deleteMediaAccountingHistory(scope);
    await Promise.all([
      createBalanceModel(mongoose).deleteMany(
        {
          user: scope.ownerId,
          tenantId: scope.tenantId,
          'mediaHolds.0': { $exists: false },
          mediaPendingSettlement: null,
        },
        { writeConcern: durable },
      ),
      createTransactionModel(mongoose).deleteMany(
        {
          user: scope.ownerId,
          tenantId: scope.tenantId,
          $or: [
            { mediaSettlementId: { $exists: true } },
            { context: { $in: ['media', 'media_debt'] } },
          ],
        },
        { writeConcern: durable },
      ),
    ]);
  };

  const completeMediaAccountDeletion: MediaMethods['completeMediaAccountDeletion'] = async ({
    scope,
    token,
  }) => {
    const completed = await Owner.findOneAndUpdate(
      {
        ...scopeFilter(scope),
        deletionToken: token,
        deletionPrepared: true,
        status: { $in: ['deleting', 'deleted'] },
        workIds: { $size: 0 },
      },
      { $set: { status: 'deleted' } },
      { new: true, writeConcern: durable },
    ).lean();
    if (!completed) {
      throw new MediaPersistenceError('conflict', 'Media account deletion fence changed');
    }
    await purgeDeletedAccountAccounting(scope);
    // No User lookup: this durable cleanup identity remains valid after the User is removed.
    await Thread.updateMany(
      { ...scopeFilter(scope), status: 'active' },
      {
        $set: { status: 'retiring', retiredAt: new Date() },
        $inc: { epoch: 1, version: 1 },
      },
      { writeConcern: durable },
    );
    await Preset.deleteMany(scopeFilter(scope), { writeConcern: durable });
  };

  const reconcileMediaAccountDeletion: MediaMethods['reconcileMediaAccountDeletion'] = async ({
    scope: inputScope,
    limit,
    retentionMs = resolveMediaConfig().assets.deletedAccountRetentionMs,
  }) => {
    const scope = scopeFilter(inputScope);
    positive(limit);
    positive(retentionMs);
    const owner = await Owner.findOne(scope).lean();
    if (!owner) {
      // A preset insert can acknowledge after the last account tombstone expired. The preset
      // itself is the durable cleanup marker, including if its writer died before revalidation.
      if (!(await ownerExists(scope))) {
        const orphanPresets = await Preset.find(scope)
          .select({ _id: 1 })
          .sort({ presetId: 1 })
          .limit(limit)
          .lean();
        const removed = await Preset.deleteMany(
          { ...scope, _id: { $in: orphanPresets.map((preset) => preset._id) } },
          { writeConcern: durable },
        );
        return removed.deletedCount;
      }
      return 0;
    }
    if (owner.status === 'active' || owner.status === 'initializing') return 0;
    if (owner.status === 'deleting') {
      // Recover a crash after User removal but before the final media acknowledgement.
      if (
        !owner.deletionPrepared ||
        !owner.deletionToken ||
        !mongoose.models.User ||
        (await mongoose.models.User.exists({ _id: scope.ownerId, tenantId: scope.tenantId }))
      ) {
        return 0;
      }
      await completeMediaAccountDeletion({ scope, token: owner.deletionToken });
    } else {
      await purgeDeletedAccountAccounting(scope);
    }
    await Preset.deleteMany(scope, { writeConcern: durable });
    const now = new Date();
    // Repeated sweeps also catch pre-fence request handlers whose staged write acknowledged late.
    await Thread.updateMany(
      { ...scope, status: 'active' },
      { $set: { status: 'retiring', retiredAt: now }, $inc: { epoch: 1, version: 1 } },
      { writeConcern: durable },
    );
    await Job.updateMany(
      { ...scope, phase: 'queued', 'provider.certainty': 'unsubmitted' },
      {
        $set: {
          phase: 'cancelled',
          'receipt.phase': 'rejected',
          'receipt.error': { code: 'not_found' },
          updatedAt: now,
        },
        $unset: { activeSlot: 1, leaseToken: 1, leaseOwner: 1, leaseUntil: 1 },
        $inc: { version: 1 },
      },
      { writeConcern: durable },
    );
    await File.updateMany(
      { user: scope.ownerId, tenantId: scope.tenantId, mediaLifecycle: 'live' },
      { $set: { mediaRetainers: [], expiredAt: new Date(now) } },
      { writeConcern: durable },
    );
    await reconcileMediaRetirements({ scope, limit });
    // Retired File tombstones retain storage identity until byte deletion is acknowledged.
    const jobs = await Job.find({
      ...scope,
      phase: { $in: terminal },
      'provider.certainty': { $in: ['unsubmitted', 'terminal'] },
      'accounting.phase': { $ne: 'held' },
    })
      .select({ jobId: 1 })
      .sort({ jobId: 1 })
      .limit(limit)
      .lean();
    for (const job of jobs) {
      await releaseMediaPermits({ scope, jobId: job.jobId });
    }
    if (jobs.length) {
      const jobIds = jobs.map((job) => job.jobId);
      await createMediaNativePartModel(mongoose).deleteMany(
        { ...scope, jobId: { $in: jobIds } },
        { writeConcern: durable },
      );
      await Job.deleteMany({ ...scope, jobId: { $in: jobIds } }, { writeConcern: durable });
    }
    const turns = await Turn.find(scope)
      .select({ turnId: 1 })
      .sort({ turnId: 1 })
      .limit(limit)
      .lean();
    await Turn.deleteMany(
      { ...scope, turnId: { $in: turns.map((turn) => turn.turnId) } },
      { writeConcern: durable },
    );
    const threads = await Thread.find({ ...scope, status: 'retired' })
      .select({ threadId: 1 })
      .sort({ threadId: 1 })
      .limit(limit)
      .lean();
    await Thread.deleteMany(
      { ...scope, threadId: { $in: threads.map((thread) => thread.threadId) } },
      { writeConcern: durable },
    );
    // Bypass only the legacy File tombstone-preservation hook after acknowledged byte retirement.
    // A new owner fence requires a live User even after this deletion tombstone expires.
    const retiredFiles = await File.find({
      user: scope.ownerId,
      tenantId: scope.tenantId,
      mediaLifecycle: 'retired',
    })
      .select({ _id: 1, file_id: 1 })
      .limit(limit)
      .lean();
    if (retiredFiles.length) {
      await File.deleteMany(
        {
          _id: { $in: retiredFiles.map((file) => file._id) },
          user: scope.ownerId,
          tenantId: scope.tenantId,
          mediaLifecycle: 'retired',
        },
        { writeConcern: durable, mediaRetirement: true },
      );
      await AssetWrite.deleteMany(
        {
          ...scope,
          state: 'published',
          $or: [
            { fileId: { $in: retiredFiles.map((file) => file.file_id) } },
            { 'asset.file_id': { $in: retiredFiles.map((file) => file.file_id) } },
          ],
        },
        { writeConcern: durable },
      );
    }
    // Keep minimal deleted-write tombstones: a paused uploader can still resume and needs
    // its unique storage key to authorize explicit cleanup after account deletion.
    const remaining = await Promise.all([
      Thread.exists(scope),
      Turn.exists(scope),
      Job.exists(scope),
      Preset.exists(scope),
      File.exists({
        user: scope.ownerId,
        tenantId: scope.tenantId,
        mediaOutputKey: { $exists: true },
      }),
      AssetWrite.exists({ ...scope, state: { $ne: 'deleted' } }),
      createMediaNativePartModel(mongoose).exists(scope),
      Permit.exists(scope),
    ]);
    if (remaining.some(Boolean)) {
      await Owner.updateOne(
        { ...scope, status: 'deleted' },
        { $unset: { expiresAt: 1 } },
        { writeConcern: durable },
      );
    } else {
      await Owner.updateOne(
        { ...scope, status: 'deleted', expiresAt: null },
        { $set: { expiresAt: new Date(Date.now() + retentionMs) } },
        { writeConcern: durable },
      );
    }
    return jobs.length + turns.length + threads.length;
  };
  return {
    assertOwnerActive,
    admitOwnerWork,
    releaseOwnerWork,
    prepareMediaAccountDeletion,
    cancelMediaAccountDeletion,
    completeMediaAccountDeletion,
    reconcileMediaAccountDeletion,
  };
}
