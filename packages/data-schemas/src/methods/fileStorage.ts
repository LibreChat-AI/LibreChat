import type { FilterQuery, Model } from 'mongoose';
import type {
  FileStorageClaim,
  FileStorageDeleteClaim,
  FileProvisionCommit,
  IMongoFile,
} from '~/types/file';

import { fileContentUpdate } from './fileContent';

function claimFilter(data: FileStorageClaim): FilterQuery<IMongoFile> {
  if (
    typeof data.file_id !== 'string' ||
    data.file_id.trim().length === 0 ||
    typeof data.userId !== 'string' ||
    !/^[a-f\d]{24}$/i.test(data.userId) ||
    typeof data.token !== 'string' ||
    data.token.trim().length === 0 ||
    (data.tenantId != null &&
      (typeof data.tenantId !== 'string' || data.tenantId.trim().length === 0))
  ) {
    throw new Error('A valid file storage owner scope and claim token are required');
  }
  return {
    file_id: data.file_id,
    user: data.userId,
    $and: [{ tenantId: data.tenantId ?? null }],
  };
}

/** Claims never expire: elapsed time cannot fence an external storage operation. */
export function createFileStorageMethods(mongoose: typeof import('mongoose')): {
  acquireFileProvision: (data: FileStorageClaim) => Promise<boolean>;
  releaseFileProvision: (data: FileStorageClaim) => Promise<boolean>;
  commitFileProvision: (data: FileProvisionCommit) => Promise<boolean>;
  acquireFileDeletion: (data: FileStorageDeleteClaim) => Promise<{ resumed: boolean } | null>;
  releaseFileDeletion: (data: FileStorageClaim & { retainDeletion: boolean }) => Promise<boolean>;
} {
  async function acquireFileProvision(data: FileStorageClaim): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      {
        ...claimFilter(data),
        'storageOperations.deletionPending': { $ne: true },
        'storageOperations.deleting': { $exists: false },
      },
      { $addToSet: { 'storageOperations.provisioning': data.token }, $unset: { expiresAt: '' } },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  /** An already-applied release is successful; only the supplied token is removed. */
  async function releaseFileProvision(data: FileStorageClaim): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      claimFilter(data),
      { $pull: { 'storageOperations.provisioning': data.token } },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  async function commitFileProvision(data: FileProvisionCommit): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    if (data.releaseOnly) {
      return (
        (await File.exists({
          ...claimFilter(data.claim),
          'storageOperations.provisioning': data.claim.token,
          'storageOperations.deletionPending': { $ne: true },
          'storageOperations.deleting': { $exists: false },
        })) != null
      );
    }
    const update: Record<string, unknown> = {};
    if (data.output) {
      const { file } = data.output;
      if (
        file.file_id !== data.claim.file_id ||
        file.user !== data.claim.userId ||
        (file.tenantId ?? null) !== (data.claim.tenantId ?? null)
      ) {
        throw new Error('Generated output does not match its storage claim');
      }
      Object.assign(update, file);
      delete update.file_id;
    }
    if (data.code) {
      const { routeKey, ref, legacyRef } = data.code;
      if (!routeKey || routeKey.includes('.') || routeKey.startsWith('$')) {
        throw new Error('Invalid code environment route key');
      }
      update[`metadata.codeEnvRefs.${routeKey}`] = ref;
      if (legacyRef) update['metadata.codeEnvRef'] = legacyRef;
    }
    if (data.embedded === true) update.embedded = true;
    if (Object.keys(update).length === 0) throw new Error('Missing provisioning result');
    const content = fileContentUpdate(update);
    if (data.entityId) {
      const owners = content.$addToSet?.['metadata.embeddedEntities']?.$each ?? [];
      content.$addToSet = { 'metadata.embeddedEntities': { $each: [...owners, data.entityId] } };
    }
    const result = await File.updateOne(
      {
        ...claimFilter(data.claim),
        'storageOperations.provisioning': data.claim.token,
        'storageOperations.deletionPending': { $ne: true },
        'storageOperations.deleting': { $exists: false },
        ...(data.output?.sourceDispatchedAt != null
          ? {
              $or: [
                { 'metadata.sourceDispatchedAt': { $exists: false } },
                { 'metadata.sourceDispatchedAt': { $lte: data.output.sourceDispatchedAt } },
              ],
            }
          : {}),
      },
      {
        ...content,
        $unset: { expiresAt: '' },
      },
    );
    return result.matchedCount === 1;
  }

  async function acquireFileDeletion(
    data: FileStorageDeleteClaim,
  ): Promise<{ resumed: boolean } | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const previous = await File.findOneAndUpdate(
      {
        ...claimFilter(data),
        updatedAt: data.updatedAt ?? { $exists: false },
        'storageOperations.deleting': { $exists: false },
        'storageOperations.provisioning.0': { $exists: false },
      },
      {
        $set: {
          'storageOperations.deleting': data.token,
          'storageOperations.deletionPending': true,
        },
        $unset: { expiresAt: '' },
      },
      { new: false, timestamps: false },
    )
      .select({ 'storageOperations.deletionPending': 1 })
      .lean();
    return previous == null
      ? null
      : { resumed: previous.storageOperations?.deletionPending === true };
  }

  async function releaseFileDeletion(
    data: FileStorageClaim & { retainDeletion: boolean },
  ): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      { ...claimFilter(data), 'storageOperations.deleting': data.token },
      {
        $unset: {
          'storageOperations.deleting': '',
          ...(!data.retainDeletion ? { 'storageOperations.deletionPending': '' } : {}),
        },
      },
      { timestamps: false },
    );
    if (result.matchedCount === 1) return true;
    // A lost release acknowledgement must not clear pending intent or a newer token.
    return (
      (await File.exists({
        ...claimFilter(data),
        'storageOperations.deleting': { $exists: false },
      })) != null
    );
  }

  return {
    acquireFileProvision,
    releaseFileProvision,
    commitFileProvision,
    acquireFileDeletion,
    releaseFileDeletion,
  };
}

export type FileStorageMethods = ReturnType<typeof createFileStorageMethods>;
