import { Types } from 'mongoose';
import { createHash } from 'crypto';
import { ResourceType } from 'librechat-data-provider';
import type { CodeEnvironmentUserSettings } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type { CodeEnvironmentDocument } from '~/types';
import type { IAclEntry } from '~/types';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import logger from '~/config/winston';

const CODE_ENVIRONMENT_TOMBSTONES = 'code_environment_tombstones';
const REFERENCE_LEASE_MS = 2 * 60_000;
const REFERENCE_RENEW_INTERVAL_MS = REFERENCE_LEASE_MS / 3;
const REMOVAL_LEASE_MS = 2 * 60_000;

type CodeEnvironmentTombstone = {
  _id: string;
  tenantId: string;
  environmentId: string;
  deletedAt: Date;
};

function tenantScope(tenantId?: string): string {
  const resolved = tenantId ?? getTenantId();
  return resolved == null || resolved === SYSTEM_TENANT_ID ? '' : resolved;
}

function tombstoneId(environmentId: string, tenantId?: string): string {
  return createHash('sha256')
    .update(`librechat-code-environment-tombstone\0${tenantScope(tenantId)}\0${environmentId}`)
    .digest('hex');
}

function tombstones(mongoose: typeof import('mongoose')) {
  const db = mongoose.connection.db;
  if (db == null) {
    throw new Error('MongoDB is not connected');
  }
  return db.collection<CodeEnvironmentTombstone>(CODE_ENVIRONMENT_TOMBSTONES);
}

function ownerSlotId(ownerId: Types.ObjectId, slot: number): Types.ObjectId {
  const hex = createHash('sha256')
    .update(`librechat-code-environment-slot\0${ownerId.toHexString()}\0${slot}`)
    .digest('hex')
    .slice(0, 24);
  return new Types.ObjectId(hex);
}

function agentReferenceFilter(environmentId: string, tenantId?: string) {
  return {
    code_environment_id: environmentId,
    ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
  };
}

export type CodeEnvironmentReferenceReservation = {
  environmentId: string;
  reservationId: string;
};

export class CodeEnvironmentReferenceError extends Error {
  readonly statusCode = 409;
  constructor(environmentId: string) {
    super(`Code environment is being removed: ${environmentId}`);
    this.name = 'CodeEnvironmentReferenceError';
  }
}

export async function reserveCodeEnvironmentReference(
  mongoose: typeof import('mongoose'),
  environmentId: string | undefined,
): Promise<CodeEnvironmentReferenceReservation | undefined> {
  if (environmentId == null || environmentId.length === 0) return undefined;
  const CodeEnvironment = mongoose.models.CodeEnvironment as
    | Model<CodeEnvironmentDocument>
    | undefined;
  if (CodeEnvironment == null) return undefined;
  const reservationId = new Types.ObjectId().toHexString();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + REFERENCE_LEASE_MS);
  const reserved = await CodeEnvironment.findOneAndUpdate(
    {
      environmentId,
      registrationPendingAt: { $exists: false },
      deletionCommittedAt: { $exists: false },
      deletionStartedAt: { $exists: false },
    },
    { $push: { pendingAgentReferences: { reservationId, expiresAt } } },
    { new: true },
  ).lean<CodeEnvironmentDocument>();
  if (reserved != null) return { environmentId, reservationId };

  const [persisted, tombstone] = await Promise.all([
    CodeEnvironment.exists({ environmentId }),
    tombstones(mongoose).findOne({ _id: tombstoneId(environmentId) }),
  ]);
  if (persisted != null || tombstone != null) {
    throw new CodeEnvironmentReferenceError(environmentId);
  }
  // Deployment-owned configuration does not have a registry row.
  return undefined;
}

export async function releaseCodeEnvironmentReference(
  mongoose: typeof import('mongoose'),
  reservation: CodeEnvironmentReferenceReservation | undefined,
): Promise<void> {
  if (reservation == null) return;
  const CodeEnvironment = mongoose.models.CodeEnvironment as
    | Model<CodeEnvironmentDocument>
    | undefined;
  if (CodeEnvironment == null) return;
  await CodeEnvironment.updateOne(
    { environmentId: reservation.environmentId },
    { $pull: { pendingAgentReferences: { reservationId: reservation.reservationId } } },
  );
}

async function renewCodeEnvironmentReference(
  mongoose: typeof import('mongoose'),
  reservation: CodeEnvironmentReferenceReservation,
): Promise<void> {
  const CodeEnvironment = mongoose.models.CodeEnvironment as
    | Model<CodeEnvironmentDocument>
    | undefined;
  if (CodeEnvironment == null) return;
  const result = await CodeEnvironment.updateOne(
    {
      environmentId: reservation.environmentId,
      deletionStartedAt: { $exists: false },
      'pendingAgentReferences.reservationId': reservation.reservationId,
    },
    {
      $set: {
        'pendingAgentReferences.$.expiresAt': new Date(Date.now() + REFERENCE_LEASE_MS),
      },
    },
  );
  if (result.matchedCount !== 1) {
    throw new CodeEnvironmentReferenceError(reservation.environmentId);
  }
}

export async function withCodeEnvironmentReference<T>(
  mongoose: typeof import('mongoose'),
  environmentId: string | undefined,
  operation: () => Promise<T>,
  renewIntervalMs: number = REFERENCE_RENEW_INTERVAL_MS,
  onReferenceLoss?: (result: T) => Promise<void>,
): Promise<T> {
  const reservation = await reserveCodeEnvironmentReference(mongoose, environmentId);
  if (reservation == null) return await operation();

  let renewal = Promise.resolve();
  let renewalError: unknown;
  const timer = setInterval(() => {
    renewal = renewal
      .then(() => renewCodeEnvironmentReference(mongoose, reservation))
      .catch((error) => {
        renewalError ??= error;
        logger.error('[code-environments] agent reference lease renewal failed:', error);
      });
  }, renewIntervalMs);
  timer.unref();
  try {
    const result = await operation();
    /** Freeze the renewal chain before awaiting it. Otherwise the interval can
     * append one last renewal after this await has captured an earlier promise. */
    clearInterval(timer);
    await renewal;
    if (renewalError != null) {
      try {
        await renewCodeEnvironmentReference(mongoose, reservation);
        renewalError = undefined;
      } catch (error) {
        await onReferenceLoss?.(result);
        throw error;
      }
    }
    return result;
  } finally {
    clearInterval(timer);
    await renewal;
    await releaseCodeEnvironmentReference(mongoose, reservation);
  }
}

type CreateCodeEnvironmentInput = Pick<
  CodeEnvironmentDocument,
  'environmentId' | 'name' | 'type' | 'baseURL' | 'controlPlaneId' | 'createdBy'
> &
  Pick<Partial<CodeEnvironmentDocument>, 'workerId' | 'revocationTokenEnv' | 'workerPrincipal'>;

export function createCodeEnvironmentMethods(mongoose: typeof import('mongoose')): {
  createCodeEnvironment: (input: CreateCodeEnvironmentInput) => Promise<CodeEnvironmentDocument>;
  createCodeEnvironmentWithinOwnerLimit: (
    input: CreateCodeEnvironmentInput,
    maxOwned: number,
  ) => Promise<CodeEnvironmentDocument | null>;
  findCodeEnvironmentsByIds: (
    ids: Array<string | Types.ObjectId>,
  ) => Promise<CodeEnvironmentDocument[]>;
  findCodeEnvironmentByEnvironmentId: (
    environmentId: string,
  ) => Promise<CodeEnvironmentDocument | null>;
  updateCodeEnvironmentSettings: (
    environmentId: string,
    settings: CodeEnvironmentUserSettings,
  ) => Promise<CodeEnvironmentDocument | null>;
  listCodeEnvironmentIds: () => Promise<string[]>;
  findCodeEnvironmentsByCreator: (
    userId: string | Types.ObjectId,
  ) => Promise<CodeEnvironmentDocument[]>;
  deleteCodeEnvironmentById: (
    id: string | Types.ObjectId,
  ) => Promise<CodeEnvironmentDocument | null>;
  discardCodeEnvironmentById: (id: string | Types.ObjectId) => Promise<void>;
  completeCodeEnvironmentRegistration: (id: string | Types.ObjectId) => Promise<void>;
  beginCodeEnvironmentRemoval: (
    id: string | Types.ObjectId,
  ) => Promise<CodeEnvironmentDocument | null>;
  cancelCodeEnvironmentRemoval: (id: string | Types.ObjectId, leaseId: string) => Promise<void>;
  commitCodeEnvironmentRemoval: (id: string | Types.ObjectId, leaseId: string) => Promise<void>;
  deleteUserCodeEnvironments: (userId: string | Types.ObjectId) => Promise<number>;
} {
  const model = () => mongoose.models.CodeEnvironment as Model<CodeEnvironmentDocument>;

  async function createCodeEnvironment(
    input: CreateCodeEnvironmentInput,
  ): Promise<CodeEnvironmentDocument> {
    if ((await tombstones(mongoose).findOne({ _id: tombstoneId(input.environmentId) })) != null) {
      throw new Error(`Code environment id was previously retired: ${input.environmentId}`);
    }
    return (
      await model().create({ ...input, registrationPendingAt: new Date() })
    ).toObject() as CodeEnvironmentDocument;
  }

  async function createCodeEnvironmentWithinOwnerLimit(
    input: CreateCodeEnvironmentInput,
    maxOwned: number,
  ): Promise<CodeEnvironmentDocument | null> {
    if ((await tombstones(mongoose).findOne({ _id: tombstoneId(input.environmentId) })) != null) {
      throw new Error(`Code environment id was previously retired: ${input.environmentId}`);
    }
    const existing = await model()
      .find({ createdBy: input.createdBy })
      .select('ownerSlot')
      .lean<Array<Pick<CodeEnvironmentDocument, 'ownerSlot'>>>();
    if (existing.length >= maxOwned) return null;
    const reserved = new Set(
      existing
        .map(({ ownerSlot }) => ownerSlot)
        .filter(
          (slot): slot is number =>
            typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 && slot < maxOwned,
        ),
    );
    for (let ownerSlot = 0; reserved.size < existing.length && ownerSlot < maxOwned; ownerSlot++) {
      reserved.add(ownerSlot);
    }
    for (let ownerSlot = 0; ownerSlot < maxOwned; ownerSlot++) {
      if (reserved.has(ownerSlot)) continue;
      try {
        return (
          await model().create({
            ...input,
            _id: ownerSlotId(input.createdBy, ownerSlot),
            ownerSlot,
            registrationPendingAt: new Date(),
          })
        ).toObject() as CodeEnvironmentDocument;
      } catch (error) {
        const duplicateOwnerSlot =
          typeof error === 'object' &&
          error != null &&
          'code' in error &&
          error.code === 11000 &&
          'keyPattern' in error &&
          typeof error.keyPattern === 'object' &&
          error.keyPattern != null &&
          ('_id' in error.keyPattern || 'ownerSlot' in error.keyPattern);
        if (!duplicateOwnerSlot) {
          throw error;
        }
      }
    }
    return null;
  }

  async function findCodeEnvironmentsByIds(
    ids: Array<string | Types.ObjectId>,
  ): Promise<CodeEnvironmentDocument[]> {
    if (ids.length === 0) return [];
    return await model()
      .find({ _id: { $in: ids } })
      .sort({ createdAt: 1, _id: 1 })
      .lean<CodeEnvironmentDocument[]>();
  }

  async function findCodeEnvironmentByEnvironmentId(
    environmentId: string,
  ): Promise<CodeEnvironmentDocument | null> {
    return await model().findOne({ environmentId }).lean<CodeEnvironmentDocument>();
  }

  async function updateCodeEnvironmentSettings(
    environmentId: string,
    settings: CodeEnvironmentUserSettings,
  ): Promise<CodeEnvironmentDocument | null> {
    const updates: Record<string, string> = {};
    if (settings.permissions?.fileWrite != null) {
      updates['settings.permissions.fileWrite'] = settings.permissions.fileWrite;
    }
    if (settings.permissions?.commandExecution != null) {
      updates['settings.permissions.commandExecution'] = settings.permissions.commandExecution;
    }
    const lifecycleFilter = {
      environmentId,
      registrationPendingAt: { $exists: false },
      deletionStartedAt: { $exists: false },
      deletionCommittedAt: { $exists: false },
    };
    if (Object.keys(updates).length === 0) {
      return await model().findOne(lifecycleFilter).lean<CodeEnvironmentDocument>();
    }
    return await model()
      .findOneAndUpdate(lifecycleFilter, { $set: updates }, { new: true, runValidators: true })
      .lean<CodeEnvironmentDocument>();
  }

  async function listCodeEnvironmentIds(): Promise<string[]> {
    return await model().distinct('environmentId');
  }

  async function findCodeEnvironmentsByCreator(
    userId: string | Types.ObjectId,
  ): Promise<CodeEnvironmentDocument[]> {
    const creatorId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    return await model()
      .find({ createdBy: creatorId })
      .sort({ createdAt: 1, _id: 1 })
      .lean<CodeEnvironmentDocument[]>();
  }

  async function deleteCodeEnvironmentById(
    id: string | Types.ObjectId,
  ): Promise<CodeEnvironmentDocument | null> {
    const environment = await model().findById(id).lean<CodeEnvironmentDocument>();
    if (environment == null) return null;
    await tombstones(mongoose).updateOne(
      { _id: tombstoneId(environment.environmentId, environment.tenantId) },
      {
        $setOnInsert: {
          tenantId: tenantScope(environment.tenantId),
          environmentId: environment.environmentId,
          deletedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return await model().findByIdAndDelete(id).lean<CodeEnvironmentDocument>();
  }

  async function discardCodeEnvironmentById(id: string | Types.ObjectId): Promise<void> {
    await model().deleteOne({ _id: id });
  }

  async function completeCodeEnvironmentRegistration(id: string | Types.ObjectId): Promise<void> {
    const result = await model().updateOne(
      {
        _id: id,
        registrationPendingAt: { $exists: true },
        registrationLeaseId: { $exists: false },
      },
      { $unset: { registrationPendingAt: 1, registrationReconcileAfter: 1 } },
    );
    if (result.matchedCount !== 1) {
      throw new Error('Code environment registration could not be committed');
    }
  }

  async function beginCodeEnvironmentRemoval(
    id: string | Types.ObjectId,
  ): Promise<CodeEnvironmentDocument | null> {
    const now = new Date();
    const leaseId = new Types.ObjectId().toHexString();
    return await model()
      .findOneAndUpdate(
        {
          _id: id,
          deletionCommittedAt: { $exists: false },
          $and: [
            {
              $or: [
                { deletionStartedAt: { $exists: false } },
                { deletionLeaseExpiresAt: { $lte: now } },
              ],
            },
            {
              $or: [
                { pendingAgentReferences: { $exists: false } },
                { pendingAgentReferences: { $size: 0 } },
                {
                  pendingAgentReferences: {
                    $not: { $elemMatch: { expiresAt: { $gt: now } } },
                  },
                },
              ],
            },
          ],
        },
        {
          $set: {
            deletionStartedAt: now,
            deletionLeaseId: leaseId,
            deletionLeaseExpiresAt: new Date(now.getTime() + REMOVAL_LEASE_MS),
          },
          $pull: { pendingAgentReferences: { expiresAt: { $lte: now } } },
        },
        { new: true },
      )
      .lean<CodeEnvironmentDocument>();
  }

  async function cancelCodeEnvironmentRemoval(
    id: string | Types.ObjectId,
    leaseId: string,
  ): Promise<void> {
    await model().updateOne(
      { _id: id, deletionLeaseId: leaseId, deletionCommittedAt: { $exists: false } },
      {
        $unset: {
          deletionStartedAt: 1,
          deletionLeaseId: 1,
          deletionLeaseExpiresAt: 1,
        },
      },
    );
  }

  async function commitCodeEnvironmentRemoval(
    id: string | Types.ObjectId,
    leaseId: string,
  ): Promise<void> {
    const result = await model().updateOne(
      { _id: id, deletionLeaseId: leaseId },
      {
        $set: { deletionCommittedAt: new Date() },
        $unset: { deletionLeaseExpiresAt: 1 },
      },
    );
    if (result.matchedCount !== 1) {
      throw new Error('Code environment removal lease was lost');
    }
  }

  /** Delete unreferenced creator-owned records and grants after user removal.
   * Failed worker revocations and environments selected by surviving agents
   * remain durable for reconciliation instead of becoming dangling refs. */
  async function deleteUserCodeEnvironments(userId: string | Types.ObjectId): Promise<number> {
    const creatorId = typeof userId === 'string' ? new Types.ObjectId(userId) : userId;
    const environments = await model()
      .find({
        createdBy: creatorId,
        revocationPendingAt: { $exists: false },
        deletionCommittedAt: { $exists: false },
      })
      .select('_id')
      .lean<Array<Pick<CodeEnvironmentDocument, '_id'>>>();
    if (environments.length === 0) return 0;

    const Agent = mongoose.models.Agent;
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
    let deleted = 0;
    for (const candidate of environments) {
      const claimed = await beginCodeEnvironmentRemoval(candidate._id);
      if (claimed == null || claimed.deletionLeaseId == null) continue;
      const referenced =
        Agent != null &&
        (await Agent.exists(agentReferenceFilter(claimed.environmentId, claimed.tenantId))) != null;
      if (referenced) {
        await cancelCodeEnvironmentRemoval(candidate._id, claimed.deletionLeaseId);
        continue;
      }
      await tombstones(mongoose).updateOne(
        { _id: tombstoneId(claimed.environmentId, claimed.tenantId) },
        {
          $setOnInsert: {
            tenantId: tenantScope(claimed.tenantId),
            environmentId: claimed.environmentId,
            deletedAt: new Date(),
          },
        },
        { upsert: true },
      );
      await AclEntry.deleteMany({
        resourceType: ResourceType.CODE_ENVIRONMENT,
        resourceId: candidate._id,
      });
      const result = await model().deleteOne({
        _id: candidate._id,
        deletionLeaseId: claimed.deletionLeaseId,
      });
      deleted += result.deletedCount ?? 0;
    }
    return deleted;
  }

  return {
    createCodeEnvironment,
    createCodeEnvironmentWithinOwnerLimit,
    findCodeEnvironmentsByIds,
    findCodeEnvironmentByEnvironmentId,
    updateCodeEnvironmentSettings,
    listCodeEnvironmentIds,
    findCodeEnvironmentsByCreator,
    deleteCodeEnvironmentById,
    discardCodeEnvironmentById,
    completeCodeEnvironmentRegistration,
    beginCodeEnvironmentRemoval,
    cancelCodeEnvironmentRemoval,
    commitCodeEnvironmentRemoval,
    deleteUserCodeEnvironments,
  };
}

export type CodeEnvironmentMethods = ReturnType<typeof createCodeEnvironmentMethods>;
