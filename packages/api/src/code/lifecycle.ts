import { EModelEndpoint, ResourceType } from 'librechat-data-provider';
import { createMethods, logger, runAsSystem } from '@librechat/data-schemas';
import type { AppConfig, CodeEnvironmentDocument } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import type { CodeBridgeFetch } from './bridge';
import { readCodeBridgeSecret, revokeCodeBridgeWorker } from './bridge';
import { createIdleRecoveryLoop } from '~/agents/recovery';
import { isLeader } from '~/cluster';

const RECONCILE_INTERVAL_MS = 60_000;
/** While a pass finds nothing to do the wait doubles up to this ceiling, the same four-fold span the
 * durable agent loops use. A pass that finds work returns the loop to the base interval. Fixed for
 * now: one configurable ceiling shared by the always-on loops is a separate change. */
const RECONCILE_MAX_IDLE_INTERVAL_MS = 4 * RECONCILE_INTERVAL_MS;
const RECONCILE_LEASE_MS = 2 * 60_000;
const REGISTRATION_STALE_MS = 5 * 60_000;
const REGISTRATION_RETRY_MS = 5 * 60_000;
const REVOCATION_RETRY_MS = 5 * 60_000;
let reconcileLoop: ReturnType<typeof createIdleRecoveryLoop> | undefined;

function agentReferenceFilter(environmentId: string, tenantId?: string) {
  return {
    $or: [{ code_environment_id: environmentId }, { code_environment_ids: environmentId }],
    ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
  };
}

/**
 * Runs one bounded reconciliation pass. Resolves true only when the pass confirmed there was nothing
 * to do: no expired removal, stale registration, committed deletion, orphaned environment or due
 * revocation turned up, and the reference sweep pruned nothing. A page of live environments is not
 * work, so the loop can back off for as long as the sweep keeps walking them.
 */
export async function reconcileCodeEnvironmentLifecycle({
  mongoose,
  readSecret = readCodeBridgeSecret,
  fetchImpl,
  limit = 25,
  onRetryAt,
}: {
  mongoose: typeof import('mongoose');
  readSecret?: (name: string) => string | undefined;
  fetchImpl?: CodeBridgeFetch;
  limit?: number;
  /** Told when the retries this pass deferred (a lease left held, a registration or a revocation put
   * back) become due, one time per kind, so the caller can scan again then instead of after its own
   * idle wait. */
  onRetryAt?: (at: Date) => void;
}): Promise<boolean> {
  return runAsSystem(async () => {
    const CodeEnvironment = mongoose.models.CodeEnvironment;
    const AclEntry = mongoose.models.AclEntry;
    if (CodeEnvironment == null || AclEntry == null) return true;
    let idle = true;
    const methods = createMethods(mongoose);
    const now = new Date();
    /** Every retry of one kind that this pass defers falls due at the same time, so the caller learns one
     * time per kind rather than one per environment, and the scan at that time finds them all due. */
    const registrationRetryAt = new Date(now.getTime() + REGISTRATION_RETRY_MS);
    const revocationRetryAt = new Date(now.getTime() + REVOCATION_RETRY_MS);
    let removalRetryAt: Date | undefined;
    const checkpoints = mongoose.connection.db!.collection<{
      _id: string;
      lastId: Types.ObjectId | null;
      upperId?: Types.ObjectId | null;
    }>('code_environment_reconciliation');
    const checkpointId = 'agent-reference-cleanup';
    await checkpoints.updateOne(
      { _id: checkpointId },
      { $setOnInsert: { lastId: null } },
      { upsert: true },
    );
    const checkpoint = await checkpoints.findOne({ _id: checkpointId });
    const lastId = checkpoint?.lastId ?? null;
    let upperId = checkpoint?.upperId;
    if (upperId == null) {
      const tail = await CodeEnvironment.findOne({})
        .hint('_id_')
        .sort({ _id: -1 })
        .select('_id')
        .lean<Pick<CodeEnvironmentDocument, '_id'>>();
      upperId = tail?._id ?? null;
      const captured = await checkpoints.updateOne(
        { _id: checkpointId, lastId, upperId: null },
        { $set: { upperId } },
      );
      /** Another replica moved the checkpoint first: this pass did nothing, so it is not idle. */
      if (captured.matchedCount !== 1) return false;
    }
    // Persist progress across leader changes and include old-replica writes on each sweep.
    const expiredReferenceCandidates = await CodeEnvironment.find({
      _id: { $lte: upperId, ...(lastId == null ? {} : { $gt: lastId }) },
    })
      .hint('_id_')
      .sort({ _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
    if (expiredReferenceCandidates.length > 0) {
      /** Mongoose stamps `updatedAt` on every update the schema's timestamps see, so only a filter that
       * matches environments actually holding an expired reference makes the count mean pruned. */
      const pruned = await CodeEnvironment.updateMany(
        {
          _id: { $in: expiredReferenceCandidates.map(({ _id }) => _id) },
          pendingAgentReferences: { $elemMatch: { expiresAt: { $lte: now } } },
        },
        { $pull: { pendingAgentReferences: { expiresAt: { $lte: now } } } },
      );
      if (pruned.modifiedCount > 0) idle = false;
    }
    // Advance only after cleanup succeeds; a competing sweep must not rewind progress.
    const nextId = expiredReferenceCandidates[expiredReferenceCandidates.length - 1]?._id;
    const sweepComplete = nextId == null || nextId.equals(upperId);
    await checkpoints.updateOne(
      { _id: checkpointId, lastId, upperId },
      {
        $set: {
          lastId: sweepComplete ? null : nextId,
          upperId: sweepComplete ? null : upperId,
        },
      },
    );
    const expiredRemovals = await CodeEnvironment.find({
      deletionCommittedAt: { $exists: false },
      deletionLeaseExpiresAt: { $lte: now },
    })
      .sort({ _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
    if (expiredRemovals.length > 0) idle = false;
    for (const candidate of expiredRemovals) {
      const environment = await methods.beginCodeEnvironmentRemoval(candidate._id);
      if (environment == null || environment.deletionLeaseId == null) continue;
      const leaseId = environment.deletionLeaseId;
      const Agent = mongoose.models.Agent;
      if (
        Agent != null &&
        (await Agent.exists(
          agentReferenceFilter(environment.environmentId, environment.tenantId),
        )) != null
      ) {
        await methods.cancelCodeEnvironmentRemoval(environment._id, leaseId);
        continue;
      }
      /** The lease this pass took stays held on a failure, so the removal is retried when it expires. */
      const retryRemoval = (): void => {
        const expiresAt = environment.deletionLeaseExpiresAt;
        if (expiresAt != null && (removalRetryAt == null || expiresAt > removalRetryAt)) {
          removalRetryAt = expiresAt;
        }
      };
      try {
        if (environment.workerPrincipal?.type === 'user') {
          const tokenEnv = environment.revocationTokenEnv;
          const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
          if (!token || environment.workerId == null) {
            retryRemoval();
            continue;
          }
          await revokeCodeBridgeWorker({
            baseURL: environment.baseURL,
            token,
            workerId: environment.workerId,
            fetchImpl,
          });
        }
        await methods.commitCodeEnvironmentRemoval(environment._id, leaseId);
        await AclEntry.deleteMany({
          resourceType: ResourceType.CODE_ENVIRONMENT,
          resourceId: environment._id,
        });
        await methods.deleteCodeEnvironmentById(environment._id);
      } catch (error) {
        logger.error('[code-environments] interrupted removal reconciliation failed:', error);
        retryRemoval();
      }
    }
    if (removalRetryAt != null) onRetryAt?.(removalRetryAt);
    const staleRegistration = new Date(Date.now() - REGISTRATION_STALE_MS);
    const registrationCandidates = await CodeEnvironment.find({
      setupAttemptId: { $exists: false },
      registrationPendingAt: { $lte: staleRegistration },
      $and: [
        {
          $or: [
            { registrationReconcileAfter: { $exists: false } },
            { registrationReconcileAfter: { $lte: now } },
          ],
        },
        {
          $or: [
            { registrationLeaseExpiresAt: { $exists: false } },
            { registrationLeaseExpiresAt: { $lte: now } },
          ],
        },
      ],
    })
      .sort({ registrationReconcileAfter: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
    if (registrationCandidates.length > 0) idle = false;
    for (const candidate of registrationCandidates) {
      const leaseId = new mongoose.Types.ObjectId().toHexString();
      const leaseNow = new Date();
      const environment = await CodeEnvironment.findOneAndUpdate(
        {
          _id: candidate._id,
          registrationPendingAt: { $lte: staleRegistration },
          $and: [
            {
              $or: [
                { registrationReconcileAfter: { $exists: false } },
                { registrationReconcileAfter: { $lte: leaseNow } },
              ],
            },
            {
              $or: [
                { registrationLeaseExpiresAt: { $exists: false } },
                { registrationLeaseExpiresAt: { $lte: leaseNow } },
              ],
            },
          ],
        },
        {
          $set: {
            registrationLeaseId: leaseId,
            registrationLeaseExpiresAt: new Date(leaseNow.getTime() + RECONCILE_LEASE_MS),
          },
        },
        { new: true },
      ).lean<CodeEnvironmentDocument>();
      if (environment == null) continue;
      const deferRegistration = async (): Promise<void> => {
        await CodeEnvironment.updateOne(
          { _id: environment._id, registrationLeaseId: leaseId },
          {
            $set: { registrationReconcileAfter: registrationRetryAt },
            $unset: { registrationLeaseId: 1, registrationLeaseExpiresAt: 1 },
          },
        );
        onRetryAt?.(registrationRetryAt);
      };
      const tokenEnv = environment.revocationTokenEnv;
      const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
      if (environment.workerId != null && environment.workerPrincipal?.type !== 'deployment') {
        if (!token) {
          await deferRegistration();
          continue;
        }
        try {
          await revokeCodeBridgeWorker({
            baseURL: environment.baseURL,
            token,
            workerId: environment.workerId,
            fetchImpl,
          });
        } catch {
          await deferRegistration();
          continue;
        }
      }
      await AclEntry.deleteMany({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: environment._id,
      });
      await CodeEnvironment.deleteOne({
        _id: environment._id,
        registrationLeaseId: leaseId,
      });
    }

    const committedDeletions = await CodeEnvironment.find({
      deletionCommittedAt: { $exists: true },
    })
      .limit(limit)
      .lean<CodeEnvironmentDocument[]>();
    if (committedDeletions.length > 0) idle = false;
    for (const environment of committedDeletions) {
      await AclEntry.deleteMany({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: environment._id,
      });
      await methods.deleteCodeEnvironmentById(environment._id);
    }

    /** A failed marker write after an account deletion must not strand live worker
     * credentials. The missing owner is itself durable retry intent, so discover
     * unmarked orphans independently of the account-deletion request path. */
    const orphanedEnvironments = await CodeEnvironment.aggregate<{
      _id: CodeEnvironmentDocument['_id'];
      createdBy: CodeEnvironmentDocument['createdBy'];
      workerId?: string;
      workerPrincipal?: CodeEnvironmentDocument['workerPrincipal'];
    }>([
      {
        $match: {
          revocationPendingAt: { $exists: false },
          deletionCommittedAt: { $exists: false },
        },
      },
      {
        $lookup: {
          from: mongoose.models.User.collection.name,
          localField: 'createdBy',
          foreignField: '_id',
          as: 'owner',
        },
      },
      { $match: { owner: { $size: 0 } } },
      { $sort: { _id: 1 } },
      { $limit: limit },
      { $project: { _id: 1, createdBy: 1, workerId: 1, workerPrincipal: 1 } },
    ]);
    if (orphanedEnvironments.length > 0) idle = false;
    const revocationTargets = orphanedEnvironments.filter(
      ({ workerId, workerPrincipal }) => workerId != null && workerPrincipal?.type === 'user',
    );
    if (revocationTargets.length > 0) {
      await CodeEnvironment.updateMany(
        { _id: { $in: revocationTargets.map(({ _id }) => _id) } },
        {
          $set: { revocationPendingAt: now },
          $inc: { revocationAttempts: 1 },
          $unset: { revocationLastError: 1, revocationReconcileAfter: 1 },
        },
      );
    }
    for (const creatorId of new Set(
      orphanedEnvironments.map(({ createdBy }) => createdBy.toHexString()),
    )) {
      await methods.deleteUserCodeEnvironments(creatorId);
    }

    const candidates = await CodeEnvironment.find({
      revocationPendingAt: { $exists: true },
      $and: [
        {
          $or: [
            { revocationReconcileAfter: { $exists: false } },
            { revocationReconcileAfter: { $lte: now } },
          ],
        },
        {
          $or: [
            { revocationLeaseExpiresAt: { $exists: false } },
            { revocationLeaseExpiresAt: { $lte: now } },
          ],
        },
      ],
    })
      .sort({ revocationReconcileAfter: 1, _id: 1 })
      .limit(limit)
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
    if (candidates.length > 0) idle = false;
    for (const candidate of candidates) {
      const now = new Date();
      const leaseId = new mongoose.Types.ObjectId().toHexString();
      const environment = await CodeEnvironment.findOneAndUpdate(
        {
          _id: candidate._id,
          revocationPendingAt: { $exists: true },
          $and: [
            {
              $or: [
                { revocationReconcileAfter: { $exists: false } },
                { revocationReconcileAfter: { $lte: now } },
              ],
            },
            {
              $or: [
                { revocationLeaseExpiresAt: { $exists: false } },
                { revocationLeaseExpiresAt: { $lte: now } },
              ],
            },
          ],
        },
        {
          $set: {
            revocationLeaseId: leaseId,
            revocationLeaseExpiresAt: new Date(now.getTime() + RECONCILE_LEASE_MS),
          },
          $inc: { revocationAttempts: 1 },
        },
        { new: true },
      ).lean<CodeEnvironmentDocument>();
      if (environment == null || environment.workerId == null) continue;
      const tokenEnv = environment.revocationTokenEnv;
      const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
      try {
        if (!token) throw new Error('Code environment revocation token is unavailable');
        await revokeCodeBridgeWorker({
          baseURL: environment.baseURL,
          token,
          workerId: environment.workerId,
          fetchImpl,
        });
        await AclEntry.deleteMany({
          resourceType: ResourceType.CODE_ENVIRONMENT,
          resourceId: environment._id,
        });
        await methods.deleteCodeEnvironmentById(environment._id);
      } catch (error) {
        const message = (error instanceof Error ? error.message : 'Worker revocation failed').slice(
          0,
          500,
        );
        await CodeEnvironment.updateOne(
          { _id: environment._id, revocationLeaseId: leaseId },
          {
            $set: { revocationLastError: message, revocationReconcileAfter: revocationRetryAt },
            $unset: { revocationLeaseId: 1, revocationLeaseExpiresAt: 1 },
          },
        );
        onRetryAt?.(revocationRetryAt);
      }
    }
    return idle;
  });
}

/**
 * Starts the reconciler on the shared idle loop: every `RECONCILE_INTERVAL_MS` while a pass finds
 * work, backing off to `RECONCILE_MAX_IDLE_INTERVAL_MS` while it finds none. Only the elected
 * replica reconciles. A follower reads no Mongo, so it keeps the base interval rather than backing
 * off, which keeps a change of leader as prompt as before.
 */
export function startCodeEnvironmentLifecycleReconciler(
  options: Parameters<typeof reconcileCodeEnvironmentLifecycle>[0],
  deps: { reconcile?: typeof reconcileCodeEnvironmentLifecycle } = {},
): void {
  if (reconcileLoop != null) return;
  const reconcile = deps.reconcile ?? reconcileCodeEnvironmentLifecycle;
  reconcileLoop = createIdleRecoveryLoop({
    intervalMs: RECONCILE_INTERVAL_MS,
    maxIdleIntervalMs: RECONCILE_MAX_IDLE_INTERVAL_MS,
    scan: async () =>
      (await isLeader())
        ? reconcile({ ...options, onRetryAt: (at) => reconcileLoop?.noteEligibleAt(at) })
        : false,
    onError: (error) => logger.error('[code-environments] lifecycle reconciliation failed:', error),
  });
  void reconcileLoop.start();
}

/** A producer left reconcilable work behind: scan again after one base interval instead of waiting
 * out the idle back-off. Best effort, and local to this process. */
export function noteCodeEnvironmentLifecycleWork(): void {
  reconcileLoop?.hint(new Date(Date.now() + RECONCILE_INTERVAL_MS));
}

export async function stopCodeEnvironmentLifecycleReconciler(): Promise<void> {
  const loop = reconcileLoop;
  reconcileLoop = undefined;
  await loop?.stop();
}

export async function revokeUserCodeEnvironmentWorkers({
  mongoose,
  userId,
  appConfig,
  readSecret = readCodeBridgeSecret,
  fetchImpl,
}: {
  mongoose: typeof import('mongoose');
  userId: string;
  appConfig: AppConfig;
  readSecret?: (name: string) => string | undefined;
  fetchImpl?: CodeBridgeFetch;
}): Promise<number> {
  const environments = await createMethods(mongoose).findCodeEnvironmentsByCreator(userId);
  const controlPlanes =
    appConfig.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments ?? [];
  const targets = environments.filter(
    (environment) => environment.workerPrincipal?.type === 'user' && environment.workerId != null,
  );
  const CodeEnvironment = mongoose.models.CodeEnvironment;
  if (targets.length > 0 && CodeEnvironment != null) {
    await CodeEnvironment.updateMany(
      { _id: { $in: targets.map(({ _id }) => _id) } },
      {
        $set: { revocationPendingAt: new Date() },
        $inc: { revocationAttempts: 1 },
        $unset: { revocationLastError: 1 },
      },
    );
  }
  const results = await Promise.allSettled(
    targets.map(async (environment) => {
      const workerId = environment.workerId;
      if (workerId == null) {
        throw new Error(
          `Code environment worker id is unavailable for ${environment.environmentId}`,
        );
      }
      const fallbackControlPlane = controlPlanes.find(
        (candidate) =>
          candidate.id === environment.controlPlaneId &&
          candidate.owner === 'deployment' &&
          candidate.type === 'attached' &&
          candidate.pairing?.allowPrincipalWorkers === true &&
          candidate.baseURL === environment.baseURL,
      );
      const tokenEnv = environment.revocationTokenEnv ?? fallbackControlPlane?.pairing?.tokenEnv;
      const token = tokenEnv != null ? readSecret(tokenEnv)?.trim() : undefined;
      if (!token) {
        throw new Error(
          `Code environment revocation is unavailable for ${environment.environmentId}`,
        );
      }
      await revokeCodeBridgeWorker({
        baseURL: environment.baseURL,
        token,
        workerId,
        fetchImpl,
      });
      return environment.environmentId;
    }),
  );
  let revoked = 0;
  for (const [index, result] of results.entries()) {
    const target = targets[index];
    if (result.status === 'fulfilled') {
      revoked += 1;
      await CodeEnvironment?.updateOne(
        { _id: target._id },
        {
          $set: { deletionCommittedAt: new Date() },
          $unset: {
            revocationPendingAt: 1,
            revocationAttempts: 1,
            revocationLastError: 1,
            revocationReconcileAfter: 1,
          },
        },
      );
      continue;
    }
    const failureMessage = (
      result.reason instanceof Error ? result.reason.message : 'Worker revocation failed'
    ).slice(0, 500);
    await CodeEnvironment?.updateOne(
      { _id: target._id },
      { $set: { revocationLastError: failureMessage } },
    );
    logger.error(
      `[code-environments] worker revocation failed during committed user deletion: ${userId}`,
      result.reason,
    );
  }
  /** A failed revocation stays pending and is due at once, so the reconciler must not sleep past it. */
  if (revoked < targets.length) noteCodeEnvironmentLifecycleWork();
  return revoked;
}
