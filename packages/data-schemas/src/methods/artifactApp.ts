import { nanoid } from 'nanoid';
import crypto from 'node:crypto';
import {
  ARTIFACT_SOURCE_KEY_PREFIX,
  DEFAULT_ARTIFACT_APPS_CONFIG,
  PrincipalType,
  ResourceType,
} from 'librechat-data-provider';
import type { ClientSession, FilterQuery, Model, Types } from 'mongoose';
import type {
  IAclEntry,
  IArtifactApp,
  IArtifactVersion,
  IArtifactPreview,
  ArtifactAppQuery,
  ArtifactVersionQuery,
  CreateArtifactAppInput,
  CreateArtifactVersionInput,
  ArtifactAppWithVersion,
  ArtifactAppSourceQuery,
  SyncArtifactAppResult,
  IArtifactSourceTombstone,
  IArtifactVersionRuntimeConfig,
  ArtifactAppListOptions,
  ArtifactAppListPage,
  ArtifactAppRecord,
  ArtifactAppUpdate,
  ArtifactAppSyncOptions,
  ArtifactVersionRecord,
  ArtifactVersionListOptions,
  ArtifactVersionListPage,
  ArtifactVersionSummaryRecord,
  ArtifactAppDeletionResult,
} from '~/types';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { supportsTransactions } from '~/utils/transactions';
import { escapeRegExp } from '~/utils/string';

/** Snapshot schema version — bump when the canonical snapshot shape changes. */
export const ARTIFACT_SCHEMA_VERSION = 1;

interface MongoWriteError {
  code?: number;
  errorLabels?: string[];
  writeErrors?: Array<{ code?: number }>;
}

interface ArtifactAppIdentityRecord {
  _id: Types.ObjectId;
  artifactAppId: string;
  status?: string;
  deletion?: { requestedBy: string };
  updatedAt?: Date;
  sourceMetadata?: { sourceKey?: string; detachedConversationId?: string };
}

interface ArtifactAppAvailabilityRecord {
  deletion?: { requestedBy: string };
  sourceMetadata?: { detachedConversationId?: string };
}

class ArtifactSyncRetryError extends Error {}

export type SyncArtifactAppCallOptions = Partial<ArtifactAppSyncOptions> & {
  assertSourceAvailable?: () => Promise<void>;
  /** Test hook: runs after the final source/tombstone check and before the mutating write. */
  afterSourceCheck?: () => Promise<void>;
  /**
   * The `latestVersionNumber` the caller observed when it queued this edit. If the app has
   * already moved past it by write time, the edit is stale relative to a newer one that landed
   * first — reject rather than create a version that resurrects superseded content.
   */
  basedOnVersionNumber?: number;
  /** Truncated source key used before overlong identities gained a hash suffix. */
  legacySourceKey?: string;
};

export class ArtifactAppDeletedError extends Error {
  constructor() {
    super('Artifact app source has been deleted');
    this.name = 'ArtifactAppDeletedError';
  }
}

export class ArtifactAppRestoreNotFoundError extends Error {
  constructor() {
    super('Deleted artifact app source was not found');
    this.name = 'ArtifactAppRestoreNotFoundError';
  }
}

export class ArtifactSyncConflictError extends Error {
  constructor() {
    super('Artifact was edited elsewhere since this change was queued');
    this.name = 'ArtifactSyncConflictError';
  }
}

const LEGACY_IDENTIFIER_SOURCE_SUFFIX = /^(identifier:.+):(application|text|image)\/[^:]+$/;

/** Maps rollout-era client keys into the stable v1 namespace. */
export function canonicalizeArtifactSourceKey(sourceKey: string): string {
  if (sourceKey.startsWith(ARTIFACT_SOURCE_KEY_PREFIX)) {
    return sourceKey;
  }
  const legacyIdentity = sourceKey.match(LEGACY_IDENTIFIER_SOURCE_SUFFIX)?.[1] ?? sourceKey;
  return `${ARTIFACT_SOURCE_KEY_PREFIX}${legacyIdentity}`.slice(0, 500);
}

function getLegacySourceKey(sourceKey: string): string | null {
  return sourceKey.startsWith(ARTIFACT_SOURCE_KEY_PREFIX)
    ? sourceKey.slice(ARTIFACT_SOURCE_KEY_PREFIX.length)
    : null;
}

function legacyTypedSourceKeyPattern(sourceKey: string): RegExp | null {
  if (!sourceKey.startsWith('identifier:')) {
    return null;
  }
  return new RegExp(`^${escapeRegExp(sourceKey)}:(?:application|text|image)/[^:]+$`);
}

function getArtifactSourceTombstoneModel(
  mongoose: typeof import('mongoose'),
): Model<IArtifactSourceTombstone> | undefined {
  return mongoose.models.ArtifactSourceTombstone as Model<IArtifactSourceTombstone> | undefined;
}

export async function hasArtifactSourceTombstone(
  mongoose: typeof import('mongoose'),
  createdBy: string,
  conversationId: string,
): Promise<boolean> {
  const Tombstone = getArtifactSourceTombstoneModel(mongoose);
  if (!Tombstone) {
    return false;
  }
  return (await Tombstone.exists({ createdBy, conversationId })) != null;
}

export async function recordArtifactSourceTombstones(
  mongoose: typeof import('mongoose'),
  createdBy: string,
  conversationIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(conversationIds.filter((id) => id.length > 0))];
  const Tombstone = getArtifactSourceTombstoneModel(mongoose);
  if (!Tombstone || uniqueIds.length === 0) {
    return;
  }

  try {
    await tenantSafeBulkWrite(
      Tombstone,
      uniqueIds.map((conversationId) => ({
        updateOne: {
          filter: { createdBy, conversationId },
          update: { $setOnInsert: { createdBy, conversationId } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    const confirmed = await Promise.all(
      uniqueIds.map((conversationId) =>
        hasArtifactSourceTombstone(mongoose, createdBy, conversationId),
      ),
    );
    if (confirmed.some((exists) => !exists)) {
      throw error;
    }
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  const writeError = error as MongoWriteError;
  return (
    writeError.code === 11000 ||
    writeError.writeErrors?.some((entry) => entry.code === 11000) === true
  );
}

function isRetryableWriteError(error: unknown): boolean {
  const writeError = error as MongoWriteError;
  return (
    error instanceof ArtifactSyncRetryError ||
    writeError.code === 11000 ||
    writeError.code === 112 ||
    writeError.errorLabels?.includes('TransientTransactionError') === true
  );
}

function waitForSyncLock(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Deterministic SHA-256 over the canonical version payload
 * ({ artifactType, sourceSnapshot, runtimeConfig }). Keys are sorted so the
 * hash is stable regardless of property insertion order.
 */
export function computeSourceHash(
  artifactType: string,
  sourceSnapshot: string,
  runtimeConfig: IArtifactVersionRuntimeConfig = {},
): string {
  const canonical = JSON.stringify({
    artifactType,
    sourceSnapshot,
    runtimeConfig: canonicalize(runtimeConfig),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(source[key]);
        return acc;
      }, {});
  }
  return value;
}

export interface ArtifactAppMethods {
  createArtifactAppWithVersion: (input: CreateArtifactAppInput) => Promise<ArtifactAppWithVersion>;
  syncArtifactAppWithVersion: (
    input: CreateArtifactAppInput,
    options?: SyncArtifactAppCallOptions,
  ) => Promise<SyncArtifactAppResult>;
  getArtifactAppByAppId: (query: ArtifactAppQuery) => Promise<ArtifactAppRecord | null>;
  getArtifactAppBySource: (query: ArtifactAppSourceQuery) => Promise<ArtifactAppRecord | null>;
  getDeletedArtifactAppBySource: (
    query: ArtifactAppSourceQuery,
  ) => Promise<ArtifactAppRecord | null>;
  restoreArtifactAppWithVersion: (
    input: CreateArtifactAppInput,
    options?: SyncArtifactAppCallOptions,
  ) => Promise<SyncArtifactAppResult>;
  resolveArtifactAppId: (query: ArtifactAppQuery) => Promise<string | null>;
  listArtifactApps: (options: ArtifactAppListOptions) => Promise<ArtifactAppListPage>;
  getArtifactAppsByIds: (ids: string[]) => Promise<ArtifactAppRecord[]>;
  updateArtifactApp: (
    query: ArtifactAppQuery,
    update: ArtifactAppUpdate,
  ) => Promise<ArtifactAppRecord | null>;
  deleteArtifactApp: (
    query: ArtifactAppQuery,
  ) => Promise<{ deletedApp: boolean; deletedVersions: number }>;
  prepareArtifactAppDeletion: (
    query: ArtifactAppQuery,
    requestedBy: string,
  ) => Promise<ArtifactAppDeletionResult>;
  finalizeArtifactAppDeletion: (query: ArtifactAppQuery, requestedBy: string) => Promise<boolean>;
  deleteUserArtifactApps: (
    userId: string,
  ) => Promise<{ deletedApps: number; deletedVersions: number }>;
  recordArtifactSourceTombstones: (createdBy: string, conversationIds: string[]) => Promise<void>;
  getArtifactVersion: (query: ArtifactVersionQuery) => Promise<ArtifactVersionRecord | null>;
  listArtifactVersions: (options: ArtifactVersionListOptions) => Promise<ArtifactVersionListPage>;
  releaseArtifactVersion: (
    query: ArtifactVersionQuery,
    releasedBy: string,
  ) => Promise<ArtifactVersionRecord | null>;
  activateArtifactVersion: (query: ArtifactVersionQuery) => Promise<ArtifactAppWithVersion | null>;
  withdrawArtifactVersion: (query: ArtifactVersionQuery) => Promise<ArtifactVersionRecord | null>;
}

function buildVersionFilter(query: ArtifactVersionQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = { artifactAppId: query.artifactAppId };
  if (query.artifactVersionId) {
    filter.artifactVersionId = query.artifactVersionId;
  }
  if (typeof query.versionNumber === 'number') {
    filter.versionNumber = query.versionNumber;
  }
  return filter;
}

export function createArtifactAppMethods(mongoose: typeof import('mongoose')): ArtifactAppMethods {
  const getApp = () => mongoose.models.ArtifactApp as Model<IArtifactApp>;
  const getVersion = () => mongoose.models.ArtifactVersion as Model<IArtifactVersion>;
  const getAclEntry = () => mongoose.models.AclEntry as Model<IAclEntry>;

  async function consolidateArtifactAppData(
    survivor: ArtifactAppIdentityRecord,
    duplicates: ArtifactAppIdentityRecord[],
  ): Promise<void> {
    if (duplicates.length === 0) {
      return;
    }

    const ArtifactVersion = getVersion();
    const duplicateAppIds = duplicates.map(({ artifactAppId }) => artifactAppId);
    const duplicateVersions = await ArtifactVersion.find({
      artifactAppId: { $in: duplicateAppIds },
    })
      .sort({ createdAt: 1, versionNumber: 1, _id: 1 })
      .exec();

    // Drafts can move; released snapshots retain their original identity and
    // are copied with deterministic IDs so interrupted imports are resumable.
    for (const version of duplicateVersions) {
      let moved = false;
      const importedVersionId = `ver_${crypto
        .createHash('sha256')
        .update(JSON.stringify([survivor.artifactAppId, version.artifactVersionId]))
        .digest('hex')}`;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (
          await ArtifactVersion.exists({
            artifactAppId: survivor.artifactAppId,
            artifactVersionId: importedVersionId,
          })
        ) {
          moved = true;
          break;
        }
        const current = await ArtifactVersion.findById(version._id).exec();
        if (!current || current.artifactAppId === survivor.artifactAppId) {
          moved = true;
          break;
        }
        const latest = await ArtifactVersion.findOne({ artifactAppId: survivor.artifactAppId })
          .sort({ versionNumber: -1 })
          .select({ versionNumber: 1 })
          .lean<Pick<IArtifactVersion, 'versionNumber'>>()
          .exec();
        try {
          if (current.publication.state !== 'draft' || current.publication.releasedAt != null) {
            const { _id: _originalId, ...snapshot } = current.toObject<IArtifactVersion>();
            await ArtifactVersion.create({
              ...snapshot,
              artifactVersionId: importedVersionId,
              artifactAppId: survivor.artifactAppId,
              versionNumber: (latest?.versionNumber ?? 0) + 1,
            });
            moved = true;
            break;
          }
          const result = await ArtifactVersion.updateOne(
            { _id: version._id, artifactAppId: current.artifactAppId },
            {
              $set: {
                artifactAppId: survivor.artifactAppId,
                versionNumber: (latest?.versionNumber ?? 0) + 1,
              },
            },
          ).exec();
          moved = result.matchedCount === 1;
          if (moved) {
            break;
          }
        } catch (error) {
          if (!isRetryableWriteError(error)) {
            throw error;
          }
        }
      }
      if (!moved) {
        throw new Error('[syncArtifactAppWithVersion] Failed to consolidate artifact history');
      }
    }

    const latestVersion = await ArtifactVersion.findOne({ artifactAppId: survivor.artifactAppId })
      .sort({ versionNumber: -1 })
      .select({ versionNumber: 1 })
      .lean<Pick<IArtifactVersion, 'versionNumber'>>()
      .exec();
    if (latestVersion) {
      await getApp()
        .updateOne(
          { _id: survivor._id, deletion: { $exists: false } },
          { $max: { latestVersionNumber: latestVersion.versionNumber } },
        )
        .exec();
    }

    const AclEntry = getAclEntry();
    const resourceIds = [survivor._id, ...duplicates.map(({ _id }) => _id)];
    const aclEntries = await AclEntry.find({
      resourceType: ResourceType.ARTIFACT_APP,
      resourceId: { $in: resourceIds },
    })
      .lean<IAclEntry[]>()
      .exec();
    const entriesByPrincipal = new Map<string, IAclEntry[]>();
    for (const entry of aclEntries) {
      const principalKey = [
        entry.tenantId ?? '',
        entry.principalType,
        entry.principalId?.toString() ?? '',
      ].join(':');
      const group = entriesByPrincipal.get(principalKey) ?? [];
      group.push(entry);
      entriesByPrincipal.set(principalKey, group);
    }

    for (const entries of entriesByPrincipal.values()) {
      const representative = [...entries].sort((left, right) => right.permBits - left.permBits)[0];
      if (!representative) {
        continue;
      }
      const mergedBits = entries.reduce((bits, entry) => bits | entry.permBits, 0);
      const roleSource = [...entries]
        .filter((entry) => entry.roleId != null)
        .sort((left, right) => right.permBits - left.permBits)[0];
      const directGrant = entries.some((entry) => entry.inheritedFrom == null);
      const neverExpires = entries.some((entry) => entry.expiredAt == null);
      const latestExpiration = neverExpires
        ? undefined
        : entries.reduce<Date | undefined>((latest, entry) => {
            if (!entry.expiredAt || (latest && latest >= entry.expiredAt)) {
              return latest;
            }
            return entry.expiredAt;
          }, undefined);
      const earliestGrant = entries.reduce<Date | undefined>((earliest, entry) => {
        if (!entry.grantedAt || (earliest && earliest <= entry.grantedAt)) {
          return earliest;
        }
        return entry.grantedAt;
      }, undefined);
      const targetEntry = entries.find(
        (entry) => entry.resourceId.toString() === survivor._id.toString(),
      );
      const identityFilter = {
        principalType: representative.principalType,
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: survivor._id,
        ...(representative.principalType === PrincipalType.PUBLIC
          ? { $or: [{ principalId: { $exists: false } }, { principalId: null }] }
          : { principalId: representative.principalId }),
      };
      const setFields = {
        principalType: representative.principalType,
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: survivor._id,
        permBits: mergedBits,
        ...(representative.principalId != null ? { principalId: representative.principalId } : {}),
        ...(representative.principalModel != null
          ? { principalModel: representative.principalModel }
          : {}),
        ...(representative.grantedBy != null ? { grantedBy: representative.grantedBy } : {}),
        ...(earliestGrant ? { grantedAt: earliestGrant } : {}),
        ...(roleSource?.roleId != null ? { roleId: roleSource.roleId } : {}),
        ...(!directGrant && representative.inheritedFrom != null
          ? { inheritedFrom: representative.inheritedFrom }
          : {}),
        ...(latestExpiration ? { expiredAt: latestExpiration } : {}),
      };
      const unsetFields = {
        ...(!roleSource ? { roleId: 1 } : {}),
        ...(directGrant ? { inheritedFrom: 1 } : {}),
        ...(neverExpires ? { expiredAt: 1 } : {}),
      };
      const update = {
        $set: setFields,
        ...(Object.keys(unsetFields).length > 0 ? { $unset: unsetFields } : {}),
      };
      const target = targetEntry
        ? await AclEntry.findOneAndUpdate({ _id: targetEntry._id }, update, { new: true }).exec()
        : await AclEntry.findOneAndUpdate(identityFilter, update, {
            new: true,
            upsert: true,
          }).exec();
      if (!target) {
        throw new Error('[syncArtifactAppWithVersion] Failed to consolidate artifact access');
      }
      const obsoleteEntryIds = entries
        .filter((entry) => entry._id.toString() !== target._id.toString())
        .map(({ _id }) => _id);
      if (obsoleteEntryIds.length > 0) {
        await AclEntry.deleteMany({ _id: { $in: obsoleteEntryIds } }).exec();
      }
    }
  }

  function toAppRecord(app: IArtifactApp): ArtifactAppRecord {
    return {
      id: app._id.toString(),
      artifactAppId: app.artifactAppId,
      tenantId: app.tenantId,
      title: app.title,
      description: app.description,
      icon: app.icon,
      category: app.category,
      tags: app.tags,
      createdBy: app.createdBy,
      activeVersionId: app.activeVersionId,
      latestVersionNumber: app.latestVersionNumber,
      status: app.status,
      visibility: app.visibility,
      allowEmbed: app.allowEmbed,
      allowFork: app.allowFork,
      allowAnonymousView: app.allowAnonymousView,
      toolPolicy: app.toolPolicy,
      marketplace: app.marketplace,
      preview: toPreviewRecord(app.preview),
      sourceMetadata: app.sourceMetadata
        ? {
            conversationId: app.sourceMetadata.conversationId,
            messageId: app.sourceMetadata.messageId,
            originalArtifactId: app.sourceMetadata.originalArtifactId,
            sourceKey: app.sourceMetadata.sourceKey,
          }
        : undefined,
      deletion: app.deletion,
      review: app.review,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      archivedAt: app.archivedAt,
    };
  }

  function toVersionRecord(version: IArtifactVersion): ArtifactVersionRecord {
    return {
      artifactVersionId: version.artifactVersionId,
      artifactAppId: version.artifactAppId,
      tenantId: version.tenantId,
      versionNumber: version.versionNumber,
      versionLabel: version.versionLabel,
      changelog: version.changelog,
      artifactType: version.artifactType,
      sourceSnapshot: version.sourceSnapshot,
      runtimeConfig: version.runtimeConfig,
      preview: toPreviewRecord(version.preview),
      integrity: version.integrity,
      createdBy: version.createdBy,
      createdAt: version.createdAt,
      publication: version.publication,
    };
  }

  function toVersionSummary(version: IArtifactVersion): ArtifactVersionSummaryRecord {
    return {
      artifactVersionId: version.artifactVersionId,
      artifactAppId: version.artifactAppId,
      tenantId: version.tenantId,
      versionNumber: version.versionNumber,
      versionLabel: version.versionLabel,
      changelog: version.changelog,
      artifactType: version.artifactType,
      preview: toPreviewRecord(version.preview),
      createdBy: version.createdBy,
      createdAt: version.createdAt,
      publication: version.publication,
    };
  }

  function toPreviewRecord(preview: IArtifactPreview | undefined): IArtifactPreview | undefined {
    if (!preview) {
      return undefined;
    }

    return {
      type: preview.type,
      imageUrl: preview.imageUrl,
      ...(preview.alt != null && { alt: preview.alt }),
    };
  }

  function encodeAppCursor(app: Pick<IArtifactApp, '_id' | 'updatedAt'>): string {
    return Buffer.from(
      JSON.stringify({ updatedAt: app.updatedAt.toISOString(), id: app._id.toString() }),
    ).toString('base64');
  }

  function decodeAppCursor(cursor: string): { updatedAt: Date; id: Types.ObjectId } {
    let parsed: { updatedAt?: string; id?: string };
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
        updatedAt?: string;
        id?: string;
      };
    } catch {
      throw new Error('Invalid artifact app cursor');
    }
    const updatedAt = parsed.updatedAt ? new Date(parsed.updatedAt) : null;
    if (
      !updatedAt ||
      Number.isNaN(updatedAt.getTime()) ||
      !parsed.id ||
      !mongoose.Types.ObjectId.isValid(parsed.id)
    ) {
      throw new Error('Invalid artifact app cursor');
    }
    return { updatedAt, id: new mongoose.Types.ObjectId(parsed.id) };
  }

  function encodeVersionCursor(versionNumber: number): string {
    return Buffer.from(JSON.stringify({ versionNumber })).toString('base64');
  }

  function decodeVersionCursor(cursor: string): number {
    let parsed: { versionNumber?: number };
    try {
      parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
        versionNumber?: number;
      };
    } catch {
      throw new Error('Invalid artifact version cursor');
    }
    const versionNumber = parsed.versionNumber;
    if (
      typeof versionNumber !== 'number' ||
      !Number.isInteger(versionNumber) ||
      versionNumber < 1
    ) {
      throw new Error('Invalid artifact version cursor');
    }
    return versionNumber;
  }

  function buildVersionDoc(
    artifactAppId: string,
    tenantId: string | undefined,
    versionNumber: number,
    input: CreateArtifactVersionInput,
    state: 'draft' | 'released',
  ): Partial<IArtifactVersion> {
    const runtimeConfig = input.runtimeConfig ?? {};
    return {
      artifactVersionId: `ver_${nanoid()}`,
      artifactAppId,
      tenantId,
      versionNumber,
      versionLabel: input.versionLabel,
      changelog: input.changelog,
      artifactType: input.artifactType,
      sourceSnapshot: input.sourceSnapshot,
      runtimeConfig,
      preview: input.preview,
      integrity: {
        sourceHash: computeSourceHash(input.artifactType, input.sourceSnapshot, runtimeConfig),
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
      },
      createdBy: input.createdBy,
      publication: {
        state,
        ...(state === 'released' ? { releasedBy: input.createdBy, releasedAt: new Date() } : {}),
      },
    } as Partial<IArtifactVersion>;
  }

  async function createArtifactAppWithVersion(
    input: CreateArtifactAppInput,
  ): Promise<ArtifactAppWithVersion> {
    const ArtifactApp = getApp();
    const ArtifactVersion = getVersion();
    const artifactAppId = `app_${nanoid()}`;

    const appDoc: Partial<IArtifactApp> = {
      artifactAppId,
      tenantId: input.tenantId,
      title: input.title,
      description: input.description,
      icon: input.icon,
      category: input.category,
      tags: input.tags,
      createdBy: input.createdBy,
      latestVersionNumber: 1,
      status: 'draft',
      visibility: input.visibility,
      allowEmbed: input.allowEmbed ?? false,
      allowFork: input.allowFork ?? false,
      allowAnonymousView: input.allowAnonymousView ?? false,
      toolPolicy: input.toolPolicy as IArtifactApp['toolPolicy'],
      marketplace: input.marketplace as IArtifactApp['marketplace'],
      preview: input.version.preview,
      sourceMetadata: input.sourceMetadata,
    };

    const versionSeed = buildVersionDoc(artifactAppId, input.tenantId, 1, input.version, 'draft');
    const activeVersionId = versionSeed.artifactVersionId;
    if (!activeVersionId) {
      throw new Error('[createArtifactAppWithVersion] Version seed has no identifier');
    }
    appDoc.activeVersionId = activeVersionId;

    const useTransaction = await supportsTransactions(mongoose);

    if (!useTransaction) {
      const [version] = await ArtifactVersion.create([versionSeed]);
      try {
        const [app] = await ArtifactApp.create([appDoc]);
        return { app: toAppRecord(app), version: toVersionRecord(version) };
      } catch (error) {
        await ArtifactVersion.deleteOne({ artifactVersionId: version.artifactVersionId }).exec();
        throw error;
      }
    }

    const session: ClientSession = await mongoose.startSession();
    try {
      let result: ArtifactAppWithVersion | undefined;
      await session.withTransaction(async () => {
        const [app] = await ArtifactApp.create([appDoc], { session });
        const [version] = await ArtifactVersion.create([versionSeed], { session });
        result = { app: toAppRecord(app), version: toVersionRecord(version) };
      });
      if (!result) {
        throw new Error('[createArtifactAppWithVersion] Transaction produced no result');
      }
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function getArtifactAppByAppId(query: ArtifactAppQuery): Promise<ArtifactAppRecord | null> {
    const app = await getApp()
      .findOne({ artifactAppId: query.artifactAppId })
      .lean<IArtifactApp>()
      .exec();
    return app ? toAppRecord(app) : null;
  }

  function buildSourceOwnerFilter(query: ArtifactAppSourceQuery): FilterQuery<IArtifactApp> {
    const filter: FilterQuery<IArtifactApp> = {
      createdBy: query.createdBy,
      'sourceMetadata.conversationId': query.conversationId,
    };
    if (query.tenantId != null) {
      filter.tenantId = query.tenantId;
    } else {
      filter.tenantId = { $exists: false };
    }
    return filter;
  }

  function buildSourceFilter(query: ArtifactAppSourceQuery): FilterQuery<IArtifactApp> {
    return {
      ...buildSourceOwnerFilter(query),
      'sourceMetadata.sourceKey': query.sourceKey,
    };
  }

  function buildDetachedSourceFilter(query: ArtifactAppSourceQuery): FilterQuery<IArtifactApp> {
    const filter: FilterQuery<IArtifactApp> = {
      createdBy: query.createdBy,
      'sourceMetadata.detachedConversationId': query.conversationId,
      'sourceMetadata.sourceKey': query.sourceKey,
    };
    if (query.tenantId != null) {
      filter.tenantId = query.tenantId;
    } else {
      filter.tenantId = { $exists: false };
    }
    return filter;
  }

  function liveSourceGuard(): FilterQuery<IArtifactApp> {
    return { 'sourceMetadata.detachedConversationId': { $exists: false } };
  }

  function sourceWasRemoved(app: ArtifactAppAvailabilityRecord | null | undefined): boolean {
    return app?.deletion != null || typeof app?.sourceMetadata?.detachedConversationId === 'string';
  }

  async function getArtifactAppBySource(
    query: ArtifactAppSourceQuery,
  ): Promise<ArtifactAppRecord | null> {
    const canonicalSourceKey = canonicalizeArtifactSourceKey(query.sourceKey);
    const canonicalQuery = { ...query, sourceKey: canonicalSourceKey };
    const currentFilter = {
      ...buildSourceFilter(canonicalQuery),
      deletion: { $exists: false },
      status: { $ne: 'archived' },
    };
    let app = await getApp().findOne(currentFilter).lean<IArtifactApp>().exec();
    const legacySourceKey = getLegacySourceKey(canonicalSourceKey);
    if (!app && legacySourceKey) {
      const legacyPattern = legacyTypedSourceKeyPattern(legacySourceKey);
      const sourceKeyFilter = legacyPattern
        ? {
            $or: [
              { 'sourceMetadata.sourceKey': legacySourceKey },
              { 'sourceMetadata.sourceKey': legacyPattern },
            ],
          }
        : { 'sourceMetadata.sourceKey': legacySourceKey };
      app = await getApp()
        .findOne({
          ...buildSourceOwnerFilter(canonicalQuery),
          ...sourceKeyFilter,
          deletion: { $exists: false },
          status: { $ne: 'archived' },
        })
        .sort({ updatedAt: -1, _id: -1 })
        .lean<IArtifactApp>()
        .exec();
    }
    return app ? toAppRecord(app) : null;
  }

  async function getDeletedArtifactAppBySource(
    query: ArtifactAppSourceQuery,
  ): Promise<ArtifactAppRecord | null> {
    const canonicalSourceKey = canonicalizeArtifactSourceKey(query.sourceKey);
    const sourceKeys: Array<string | RegExp> = [canonicalSourceKey];
    const legacySourceKey = getLegacySourceKey(canonicalSourceKey);
    if (legacySourceKey) {
      sourceKeys.push(legacySourceKey);
      const legacyPattern = legacyTypedSourceKeyPattern(legacySourceKey);
      if (legacyPattern) {
        sourceKeys.push(legacyPattern);
      }
    }
    const app = await getApp()
      .findOne({
        ...buildSourceOwnerFilter({ ...query, sourceKey: canonicalSourceKey }),
        'sourceMetadata.sourceKey': { $in: sourceKeys },
        'deletion.finalizedAt': { $exists: true },
      })
      .sort({ updatedAt: -1, _id: -1 })
      .lean<IArtifactApp>()
      .exec();
    return app ? toAppRecord(app) : null;
  }

  /**
   * Explicitly restores a user-deleted catalog entry from its current chat snapshot.
   * The tombstone stays authoritative for normal sync; only this method can replace it
   * with a new draft version. Standalone deployments use the same recoverable staging
   * pattern as automatic synchronization so a process interruption cannot lose the restore.
   */
  async function restoreArtifactAppWithVersion(
    input: CreateArtifactAppInput,
    options: SyncArtifactAppCallOptions = {},
  ): Promise<SyncArtifactAppResult> {
    const source = input.sourceMetadata;
    if (!source?.conversationId || !source.sourceKey) {
      throw new Error('[restoreArtifactAppWithVersion] Stable source metadata is required');
    }
    await options.assertSourceAvailable?.();
    if (await hasArtifactSourceTombstone(mongoose, input.createdBy, source.conversationId)) {
      throw new ArtifactAppDeletedError();
    }

    const canonicalSourceKey = canonicalizeArtifactSourceKey(source.sourceKey);
    const canonicalSource = { ...source, sourceKey: canonicalSourceKey };
    const sourceQuery: ArtifactAppSourceQuery = {
      tenantId: input.tenantId,
      createdBy: input.createdBy,
      conversationId: source.conversationId,
      sourceKey: canonicalSourceKey,
    };
    const sourceKeys: Array<string | RegExp> = [canonicalSourceKey];
    const legacySourceKey = getLegacySourceKey(canonicalSourceKey);
    if (legacySourceKey) {
      sourceKeys.push(legacySourceKey);
      const legacyPattern = legacyTypedSourceKeyPattern(legacySourceKey);
      if (legacyPattern) {
        sourceKeys.push(legacyPattern);
      }
    }
    const deletedFilter: FilterQuery<IArtifactApp> = {
      ...buildSourceOwnerFilter(sourceQuery),
      'sourceMetadata.sourceKey': { $in: sourceKeys },
      'deletion.finalizedAt': { $exists: true },
    };
    const syncOptions: ArtifactAppSyncOptions = {
      syncLockLeaseMs: options.syncLockLeaseMs ?? DEFAULT_ARTIFACT_APPS_CONFIG.syncLockLeaseMs,
      syncLockRetryDelayMs:
        options.syncLockRetryDelayMs ?? DEFAULT_ARTIFACT_APPS_CONFIG.syncLockRetryDelayMs,
      syncLockRetryAttempts:
        options.syncLockRetryAttempts ?? DEFAULT_ARTIFACT_APPS_CONFIG.syncLockRetryAttempts,
      syncWriteRetryAttempts:
        options.syncWriteRetryAttempts ?? DEFAULT_ARTIFACT_APPS_CONFIG.syncWriteRetryAttempts,
    };
    const ArtifactApp = getApp();
    const ArtifactVersion = getVersion();
    const restoreSourceHash = computeSourceHash(
      input.version.artifactType,
      input.version.sourceSnapshot,
      input.version.runtimeConfig ?? {},
    );

    async function assertRestoreSourceAvailable(): Promise<void> {
      await options.assertSourceAvailable?.();
      if (await hasArtifactSourceTombstone(mongoose, input.createdBy, sourceQuery.conversationId)) {
        throw new ArtifactAppDeletedError();
      }
    }

    async function detachRestoredSource(
      appId: IArtifactApp['_id'],
      session?: ClientSession,
    ): Promise<void> {
      const detachQuery = ArtifactApp.updateMany(
        {
          _id: appId,
          createdBy: input.createdBy,
          'sourceMetadata.conversationId': sourceQuery.conversationId,
        },
        {
          $rename: {
            'sourceMetadata.conversationId': 'sourceMetadata.detachedConversationId',
          },
        },
      );
      if (session) {
        detachQuery.session(session);
      }
      await detachQuery.exec();
    }

    async function resolveRestoreVersion(
      app: IArtifactApp,
      session?: ClientSession,
    ): Promise<IArtifactVersion> {
      let versionNumber = app.latestVersionNumber + 1;
      for (;;) {
        const existingQuery = ArtifactVersion.findOne({
          artifactAppId: app.artifactAppId,
          versionNumber,
        });
        if (session) {
          existingQuery.session(session);
        }
        const existing = await existingQuery.exec();
        if (!existing) {
          const versionSeed = buildVersionDoc(
            app.artifactAppId,
            app.tenantId,
            versionNumber,
            input.version,
            'draft',
          );
          if (session) {
            const [created] = await ArtifactVersion.create([versionSeed], { session });
            return created;
          }
          const [created] = await ArtifactVersion.create([versionSeed]);
          return created;
        }
        if (existing.integrity.sourceHash === restoreSourceHash) {
          return existing;
        }
        versionNumber += 1;
      }
    }

    const finishRestore = async (
      app: IArtifactApp,
      version: IArtifactVersion,
      lockToken?: string,
      session?: ClientSession,
    ): Promise<SyncArtifactAppResult> => {
      await assertRestoreSourceAvailable();
      await options.afterSourceCheck?.();
      const updateQuery = ArtifactApp.findOneAndUpdate(
        {
          _id: app._id,
          latestVersionNumber: app.latestVersionNumber,
          'deletion.finalizedAt': { $exists: true },
          ...(lockToken ? { 'syncLock.token': lockToken } : {}),
          ...liveSourceGuard(),
        },
        {
          $set: {
            title: input.title,
            sourceMetadata: canonicalSource,
            status: 'draft',
            'marketplace.listed': true,
            latestVersionNumber: version.versionNumber,
            activeVersionId: version.artifactVersionId,
            ...(input.version.preview ? { preview: input.version.preview } : {}),
          },
          $unset: {
            deletion: 1,
            archivedAt: 1,
            syncLock: 1,
            ...(!input.version.preview ? { preview: 1 } : {}),
          },
        },
        { new: true, ...(session ? { session } : {}) },
      );
      const restored = await updateQuery.exec();
      if (!restored) {
        await assertRestoreSourceAvailable();
        const blockedApp = await ArtifactApp.findOne({ _id: app._id })
          .select({ deletion: 1, 'sourceMetadata.detachedConversationId': 1 })
          .lean<ArtifactAppAvailabilityRecord>()
          .exec();
        if (sourceWasRemoved(blockedApp)) {
          throw new ArtifactAppDeletedError();
        }
        throw new ArtifactSyncRetryError(
          '[restoreArtifactAppWithVersion] Concurrent restore update',
        );
      }
      try {
        await assertRestoreSourceAvailable();
      } catch (error) {
        await detachRestoredSource(app._id, session);
        throw error;
      }
      return {
        app: toAppRecord(restored),
        version: toVersionRecord(version),
        created: false,
        versionCreated: true,
      };
    };

    const returnAlreadyRestored = async (): Promise<SyncArtifactAppResult> => {
      const live = await getArtifactAppBySource(sourceQuery);
      if (!live) {
        throw new ArtifactAppRestoreNotFoundError();
      }
      return syncArtifactAppWithVersion({ ...input, sourceMetadata: canonicalSource }, options);
    };

    if (!(await supportsTransactions(mongoose))) {
      for (let attempt = 0; attempt < syncOptions.syncLockRetryAttempts; attempt += 1) {
        const now = new Date();
        const lockToken = `restore_${nanoid()}`;
        const app = await ArtifactApp.findOneAndUpdate(
          {
            ...deletedFilter,
            $or: [{ syncLock: { $exists: false } }, { 'syncLock.expiresAt': { $lte: now } }],
          },
          {
            $set: {
              syncLock: {
                token: lockToken,
                expiresAt: new Date(now.getTime() + syncOptions.syncLockLeaseMs),
              },
            },
          },
          { new: true },
        ).exec();
        if (!app) {
          if (await getArtifactAppBySource(sourceQuery)) {
            return returnAlreadyRestored();
          }
          if (!(await ArtifactApp.exists(deletedFilter))) {
            throw new ArtifactAppRestoreNotFoundError();
          }
          await waitForSyncLock(syncOptions.syncLockRetryDelayMs);
          continue;
        }

        try {
          const version = await resolveRestoreVersion(app);
          return await finishRestore(app, version, lockToken);
        } catch (error) {
          await ArtifactApp.updateOne(
            { _id: app._id, 'syncLock.token': lockToken },
            { $unset: { syncLock: 1 } },
          ).exec();
          if (!isRetryableWriteError(error)) {
            throw error;
          }
        }
      }
      throw new Error('[restoreArtifactAppWithVersion] Timed out waiting for restore lock');
    }

    for (let attempt = 0; attempt < syncOptions.syncWriteRetryAttempts; attempt += 1) {
      const session = await mongoose.startSession();
      try {
        let result: SyncArtifactAppResult | undefined;
        await session.withTransaction(async () => {
          const app = await ArtifactApp.findOne(deletedFilter).session(session).exec();
          if (!app) {
            return;
          }
          const version = await resolveRestoreVersion(app, session);
          result = await finishRestore(app, version, undefined, session);
        });
        if (result) {
          return result;
        }
        return returnAlreadyRestored();
      } catch (error) {
        if (!isRetryableWriteError(error) || attempt === syncOptions.syncWriteRetryAttempts - 1) {
          throw error;
        }
      } finally {
        await session.endSession();
      }
    }
    throw new Error('[restoreArtifactAppWithVersion] Transaction restore exhausted retries');
  }

  /**
   * Creates the catalog record once, then appends and activates a new snapshot
   * only when its canonical content hash changes. Version history remains in
   * the separate ArtifactVersion collection so it can grow independently.
   */
  async function syncArtifactAppWithVersion(
    input: CreateArtifactAppInput,
    options: SyncArtifactAppCallOptions = {},
  ): Promise<SyncArtifactAppResult> {
    const syncOptions: ArtifactAppSyncOptions = {
      syncLockLeaseMs: options.syncLockLeaseMs ?? DEFAULT_ARTIFACT_APPS_CONFIG.syncLockLeaseMs,
      syncLockRetryDelayMs:
        options.syncLockRetryDelayMs ?? DEFAULT_ARTIFACT_APPS_CONFIG.syncLockRetryDelayMs,
      syncLockRetryAttempts:
        options.syncLockRetryAttempts ?? DEFAULT_ARTIFACT_APPS_CONFIG.syncLockRetryAttempts,
      syncWriteRetryAttempts:
        options.syncWriteRetryAttempts ?? DEFAULT_ARTIFACT_APPS_CONFIG.syncWriteRetryAttempts,
    };
    const source = input.sourceMetadata;
    if (!source?.conversationId || !source.sourceKey) {
      throw new Error('[syncArtifactAppWithVersion] Stable source metadata is required');
    }

    const canonicalSourceKey = canonicalizeArtifactSourceKey(source.sourceKey);
    const canonicalSource = { ...source, sourceKey: canonicalSourceKey };
    const sourceQuery: ArtifactAppSourceQuery = {
      tenantId: input.tenantId,
      createdBy: input.createdBy,
      conversationId: source.conversationId,
      sourceKey: canonicalSourceKey,
    };
    let filter = buildSourceFilter(sourceQuery);
    let existing = await getApp()
      .findOne(filter)
      .select({
        _id: 1,
        artifactAppId: 1,
        status: 1,
        deletion: 1,
        'sourceMetadata.detachedConversationId': 1,
      })
      .lean<ArtifactAppIdentityRecord>()
      .exec();
    const legacyBoundedSourceKey = options.legacySourceKey
      ? canonicalizeArtifactSourceKey(options.legacySourceKey)
      : null;
    if (!existing && legacyBoundedSourceKey && legacyBoundedSourceKey !== canonicalSourceKey) {
      const legacySourceQuery = { ...sourceQuery, sourceKey: legacyBoundedSourceKey };
      const legacyExisting = await getApp()
        .findOne(buildSourceFilter(legacySourceQuery))
        .select({
          _id: 1,
          artifactAppId: 1,
          status: 1,
          deletion: 1,
          'sourceMetadata.detachedConversationId': 1,
        })
        .lean<ArtifactAppIdentityRecord>()
        .exec();
      const legacyDetached = await getApp()
        .findOne(buildDetachedSourceFilter(legacySourceQuery))
        .select({ deletion: 1, 'sourceMetadata.detachedConversationId': 1 })
        .lean<ArtifactAppAvailabilityRecord>()
        .exec();
      if (
        legacyExisting?.deletion ||
        legacyExisting?.status === 'archived' ||
        sourceWasRemoved(legacyExisting) ||
        sourceWasRemoved(legacyDetached)
      ) {
        throw new ArtifactAppDeletedError();
      }
      if (legacyExisting) {
        try {
          existing = await getApp()
            .findOneAndUpdate(
              {
                _id: legacyExisting._id,
                'sourceMetadata.sourceKey': legacyBoundedSourceKey,
              },
              { $set: { 'sourceMetadata.sourceKey': canonicalSourceKey } },
              { new: true },
            )
            .select({
              _id: 1,
              artifactAppId: 1,
              status: 1,
              deletion: 1,
              'sourceMetadata.detachedConversationId': 1,
            })
            .lean<ArtifactAppIdentityRecord>()
            .exec();
        } catch (error) {
          if (!isRetryableWriteError(error)) {
            throw error;
          }
        }
        existing ??= await getApp()
          .findOne(filter)
          .select({
            _id: 1,
            artifactAppId: 1,
            status: 1,
            deletion: 1,
            'sourceMetadata.detachedConversationId': 1,
          })
          .lean<ArtifactAppIdentityRecord>()
          .exec();
        if (existing) {
          filter = { _id: existing._id };
        }
      }
    }
    if (existing?.deletion || existing?.status === 'archived' || sourceWasRemoved(existing)) {
      throw new ArtifactAppDeletedError();
    }

    const detachedSource = await getApp()
      .findOne(buildDetachedSourceFilter(sourceQuery))
      .select({ _id: 1, deletion: 1, 'sourceMetadata.detachedConversationId': 1 })
      .lean<ArtifactAppAvailabilityRecord>()
      .exec();
    if (sourceWasRemoved(detachedSource)) {
      throw new ArtifactAppDeletedError();
    }

    if (await hasArtifactSourceTombstone(mongoose, input.createdBy, source.conversationId)) {
      throw new ArtifactAppDeletedError();
    }

    async function throwIfSourceUnavailable(appId?: Types.ObjectId): Promise<void> {
      if (await hasArtifactSourceTombstone(mongoose, input.createdBy, sourceQuery.conversationId)) {
        throw new ArtifactAppDeletedError();
      }
      const query = appId
        ? { _id: appId }
        : { $or: [filter, buildDetachedSourceFilter(sourceQuery)] };
      const current = await getApp()
        .findOne(query)
        .select({ deletion: 1, 'sourceMetadata.detachedConversationId': 1 })
        .lean<ArtifactAppAvailabilityRecord>()
        .exec();
      if (sourceWasRemoved(current)) {
        throw new ArtifactAppDeletedError();
      }
    }

    async function abandonFirstInsert(artifactAppId: string): Promise<void> {
      let lastError: unknown;
      for (let attempt = 0; attempt < syncOptions.syncWriteRetryAttempts; attempt += 1) {
        try {
          await getApp()
            .updateMany(
              {
                artifactAppId,
                createdBy: input.createdBy,
                'sourceMetadata.conversationId': sourceQuery.conversationId,
              },
              {
                $rename: {
                  'sourceMetadata.conversationId': 'sourceMetadata.detachedConversationId',
                },
              },
            )
            .exec();
          await deleteArtifactApp({ artifactAppId });
          return;
        } catch (error) {
          lastError = error;
          if (!isRetryableWriteError(error) || attempt === syncOptions.syncWriteRetryAttempts - 1) {
            throw error;
          }
          await waitForSyncLock(syncOptions.syncLockRetryDelayMs);
        }
      }
      throw lastError;
    }

    // A versioned key makes legacy interpretation explicit. Collect every
    // matching pre-version record so MIME-changing identifiers converge on a
    // deterministic survivor instead of leaving duplicate catalog entries.
    const legacySourceKey = getLegacySourceKey(canonicalSourceKey);
    if (legacySourceKey) {
      const legacyTypedPattern = legacyTypedSourceKeyPattern(legacySourceKey);
      const legacySourceFilter = legacyTypedPattern
        ? {
            $or: [
              { 'sourceMetadata.sourceKey': legacySourceKey },
              { 'sourceMetadata.sourceKey': legacyTypedPattern },
            ],
          }
        : { 'sourceMetadata.sourceKey': legacySourceKey };
      const legacyApps = await getApp()
        .find({
          ...buildSourceOwnerFilter(sourceQuery),
          ...legacySourceFilter,
        })
        .select({
          _id: 1,
          artifactAppId: 1,
          status: 1,
          deletion: 1,
          updatedAt: 1,
          'sourceMetadata.sourceKey': 1,
        })
        .sort({ updatedAt: -1, _id: -1 })
        .lean<ArtifactAppIdentityRecord[]>()
        .exec();

      if (!existing && legacyApps.some((app) => app.deletion != null)) {
        throw new ArtifactAppDeletedError();
      }

      const migratableLegacyApps = legacyApps.filter((app) => app.deletion == null);
      const activeLegacyApps = migratableLegacyApps.filter(
        (app) => app.deletion == null && app.status !== 'archived',
      );
      let survivor = existing ?? activeLegacyApps[0];
      if (!existing && survivor) {
        try {
          const migrated = await getApp()
            .findOneAndUpdate(
              {
                _id: survivor._id,
                deletion: { $exists: false },
                'sourceMetadata.sourceKey': survivor.sourceMetadata?.sourceKey,
              },
              { $set: { 'sourceMetadata.sourceKey': canonicalSourceKey } },
              { new: true },
            )
            .select({ _id: 1, artifactAppId: 1, status: 1, deletion: 1 })
            .lean<ArtifactAppIdentityRecord>()
            .exec();
          existing =
            migrated ??
            (await getApp()
              .findOne(filter)
              .select({ _id: 1, artifactAppId: 1, status: 1 })
              .lean<ArtifactAppIdentityRecord>()
              .exec());
        } catch (error) {
          if (!isRetryableWriteError(error)) {
            throw error;
          }
          existing = await getApp()
            .findOne(filter)
            .select({ _id: 1, artifactAppId: 1, status: 1 })
            .lean<ArtifactAppIdentityRecord>()
            .exec();
        }
        survivor = existing ?? survivor;
      }

      if (survivor) {
        const duplicateApps = migratableLegacyApps.filter(
          (candidate) => candidate._id.toString() !== survivor._id.toString(),
        );
        await consolidateArtifactAppData(survivor, duplicateApps);
        const duplicateIds = duplicateApps.map((candidate) => candidate._id);
        if (duplicateIds.length > 0) {
          await getApp()
            .updateMany(
              { _id: { $in: duplicateIds }, deletion: { $exists: false } },
              {
                $set: {
                  status: 'archived',
                  archivedAt: new Date(),
                  'marketplace.listed': false,
                },
                $unset: { syncLock: 1 },
              },
            )
            .exec();
        }
        existing = survivor;
        filter = { _id: survivor._id };
      }
    }

    // Upgrade path for records created by the original manual Publish dialog,
    // which stored an originalArtifactId but had no stable sourceKey.
    if (!existing && source.originalArtifactId) {
      const legacyFilter: FilterQuery<IArtifactApp> = {
        createdBy: input.createdBy,
        'sourceMetadata.conversationId': source.conversationId,
        'sourceMetadata.originalArtifactId': source.originalArtifactId,
        'sourceMetadata.sourceKey': { $exists: false },
        ...(input.tenantId != null
          ? { tenantId: input.tenantId }
          : { tenantId: { $exists: false } }),
      };
      existing = await getApp()
        .findOne(legacyFilter)
        .select({ _id: 1, artifactAppId: 1, status: 1 })
        .lean<ArtifactAppIdentityRecord>()
        .exec();
      if (existing) {
        filter = { _id: existing._id };
      }
    }

    if (!existing) {
      await options.assertSourceAvailable?.();
      if (await hasArtifactSourceTombstone(mongoose, input.createdBy, source.conversationId)) {
        throw new ArtifactAppDeletedError();
      }
      await options.afterSourceCheck?.();
      let created: ArtifactAppWithVersion | undefined;
      try {
        created = await createArtifactAppWithVersion({
          ...input,
          sourceMetadata: canonicalSource,
          visibility: 'private',
          marketplace: { ...input.marketplace, listed: true },
        });
      } catch (error) {
        // A concurrent first sync may win the unique source index. Re-enter the
        // update path so both requests resolve to the same catalog record.
        if (!isRetryableWriteError(error)) {
          throw error;
        }
      }
      if (created) {
        if (await hasArtifactSourceTombstone(mongoose, input.createdBy, source.conversationId)) {
          await abandonFirstInsert(created.app.artifactAppId);
          throw new ArtifactAppDeletedError();
        }
        return { app: created.app, version: created.version, created: true, versionCreated: true };
      }
    }

    const ArtifactApp = getApp();
    const ArtifactVersion = getVersion();
    const sourceHash = computeSourceHash(
      input.version.artifactType,
      input.version.sourceSnapshot,
      input.version.runtimeConfig,
    );

    /**
     * Preview capture can finish just after the initial no-preview sync. Backfill only a missing
     * preview on the active draft: an existing preview wins, and the schema's query guard keeps
     * released/withdrawn snapshots immutable. Re-read after a lost race so the app always mirrors
     * the version that actually won.
     */
    const backfillActiveVersionPreview = async (
      activeVersion: IArtifactVersion,
      session?: ClientSession,
    ): Promise<IArtifactVersion> => {
      if (activeVersion.preview || !input.version.preview) {
        return activeVersion;
      }

      const updateQuery = ArtifactVersion.findOneAndUpdate(
        {
          _id: activeVersion._id,
          artifactAppId: activeVersion.artifactAppId,
          artifactVersionId: activeVersion.artifactVersionId,
          preview: { $exists: false },
        },
        { $set: { preview: input.version.preview } },
        { new: true },
      );
      if (session) updateQuery.session(session);
      const backfilledVersion = await updateQuery.exec();
      if (backfilledVersion) {
        return backfilledVersion;
      }

      const rereadQuery = ArtifactVersion.findOne({
        _id: activeVersion._id,
        artifactAppId: activeVersion.artifactAppId,
        artifactVersionId: activeVersion.artifactVersionId,
      });
      if (session) rereadQuery.session(session);
      return (await rereadQuery.exec()) ?? activeVersion;
    };

    const applyStandaloneSync = async (): Promise<SyncArtifactAppResult> => {
      const lockToken = `sync_${nanoid()}`;
      let app: IArtifactApp | null = null;
      let versionStaged = false;

      for (let attempt = 0; attempt < syncOptions.syncLockRetryAttempts; attempt++) {
        const now = new Date();
        app = await ArtifactApp.findOneAndUpdate(
          {
            ...filter,
            deletion: { $exists: false },
            ...liveSourceGuard(),
            $or: [{ syncLock: { $exists: false } }, { 'syncLock.expiresAt': { $lte: now } }],
          },
          {
            $set: {
              syncLock: {
                token: lockToken,
                expiresAt: new Date(now.getTime() + syncOptions.syncLockLeaseMs),
              },
            },
          },
          { new: true },
        ).exec();
        if (app) {
          break;
        }
        const blockedApp = await ArtifactApp.findOne({
          $or: [filter, buildDetachedSourceFilter(sourceQuery)],
        })
          .select({ deletion: 1, 'sourceMetadata.detachedConversationId': 1 })
          .lean<ArtifactAppAvailabilityRecord>()
          .exec();
        if (sourceWasRemoved(blockedApp)) {
          throw new ArtifactAppDeletedError();
        }
        if (!blockedApp) {
          throw new Error(
            '[syncArtifactAppWithVersion] Artifact app not found after source lookup',
          );
        }
        await waitForSyncLock(syncOptions.syncLockRetryDelayMs);
      }

      if (!app) {
        await throwIfSourceUnavailable();
        throw new Error('[syncArtifactAppWithVersion] Timed out waiting for artifact sync lock');
      }

      try {
        let recoveredVersion = false;
        const recoverableVersion = await ArtifactVersion.findOne({
          artifactAppId: app.artifactAppId,
          versionNumber: app.latestVersionNumber + 1,
        }).exec();
        if (recoverableVersion) {
          const recoveredApp = await ArtifactApp.findOneAndUpdate(
            {
              _id: app._id,
              'syncLock.token': lockToken,
              latestVersionNumber: app.latestVersionNumber,
              deletion: { $exists: false },
              ...liveSourceGuard(),
            },
            {
              $set: {
                latestVersionNumber: recoverableVersion.versionNumber,
                activeVersionId: recoverableVersion.artifactVersionId,
                ...(recoverableVersion.preview ? { preview: recoverableVersion.preview } : {}),
              },
              ...(!recoverableVersion.preview ? { $unset: { preview: 1 } } : {}),
            },
            { new: true },
          ).exec();
          if (!recoveredApp) {
            await throwIfSourceUnavailable(app._id);
            throw new Error('[syncArtifactAppWithVersion] Artifact sync lock was lost');
          }
          app = recoveredApp;
          recoveredVersion = true;
        }

        const versionQuery = app.activeVersionId
          ? ArtifactVersion.findOne({
              artifactAppId: app.artifactAppId,
              artifactVersionId: app.activeVersionId,
            })
          : ArtifactVersion.findOne({ artifactAppId: app.artifactAppId }).sort({
              versionNumber: -1,
            });
        const activeVersion = await versionQuery.exec();
        const metadata = canonicalSource;

        if (activeVersion?.integrity.sourceHash === sourceHash) {
          const versionWithPreview = await backfillActiveVersionPreview(activeVersion);
          const updatedApp = await ArtifactApp.findOneAndUpdate(
            {
              _id: app._id,
              'syncLock.token': lockToken,
              deletion: { $exists: false },
              ...liveSourceGuard(),
            },
            {
              $set: {
                title: input.title,
                sourceMetadata: metadata,
                'marketplace.listed': true,
                ...(versionWithPreview.preview ? { preview: versionWithPreview.preview } : {}),
              },
              $unset: { syncLock: 1, ...(!versionWithPreview.preview ? { preview: 1 } : {}) },
            },
            { new: true },
          ).exec();
          if (!updatedApp) {
            await throwIfSourceUnavailable(app._id);
            throw new Error('[syncArtifactAppWithVersion] Artifact sync lock was lost');
          }
          return {
            app: toAppRecord(updatedApp),
            version: toVersionRecord(versionWithPreview),
            created: false,
            versionCreated: recoveredVersion,
          };
        }

        if (
          options.basedOnVersionNumber != null &&
          options.basedOnVersionNumber < app.latestVersionNumber
        ) {
          throw new ArtifactSyncConflictError();
        }

        const nextVersionNumber = app.latestVersionNumber + 1;
        const versionSeed = buildVersionDoc(
          app.artifactAppId,
          app.tenantId,
          nextVersionNumber,
          input.version,
          'draft',
        );
        const stagedVersionId = versionSeed.artifactVersionId;
        if (!stagedVersionId) {
          throw new Error('[syncArtifactAppWithVersion] Version seed has no identifier');
        }
        const [version] = await ArtifactVersion.create([versionSeed]);
        versionStaged = true;
        const updatedApp = await ArtifactApp.findOneAndUpdate(
          {
            _id: app._id,
            'syncLock.token': lockToken,
            latestVersionNumber: app.latestVersionNumber,
            deletion: { $exists: false },
            ...liveSourceGuard(),
          },
          {
            $set: {
              title: input.title,
              sourceMetadata: metadata,
              'marketplace.listed': true,
              latestVersionNumber: nextVersionNumber,
              activeVersionId: version.artifactVersionId,
              ...(input.version.preview ? { preview: input.version.preview } : {}),
            },
            $unset: { syncLock: 1, ...(!input.version.preview ? { preview: 1 } : {}) },
          },
          { new: true },
        ).exec();
        if (!updatedApp) {
          await ArtifactVersion.deleteOne({ artifactVersionId: stagedVersionId }).exec();
          versionStaged = false;
          await throwIfSourceUnavailable(app._id);
          throw new Error('[syncArtifactAppWithVersion] Artifact sync lock was lost');
        }
        return {
          app: toAppRecord(updatedApp),
          version: toVersionRecord(version),
          created: false,
          versionCreated: true,
        };
      } catch (error) {
        await ArtifactApp.updateOne(
          { _id: app._id, 'syncLock.token': lockToken },
          { $unset: { syncLock: 1 } },
        ).exec();
        if (versionStaged) {
          throw new ArtifactSyncRetryError(
            '[syncArtifactAppWithVersion] Recovering staged artifact version',
          );
        }
        throw error;
      }
    };

    const applySync = async (session?: ClientSession): Promise<SyncArtifactAppResult> => {
      const appQuery = ArtifactApp.findOne(filter);
      if (session) appQuery.session(session);
      const app = await appQuery.exec();
      if (!app) {
        await throwIfSourceUnavailable();
        throw new Error('[syncArtifactAppWithVersion] Artifact app not found after source lookup');
      }
      if (sourceWasRemoved(app)) {
        throw new ArtifactAppDeletedError();
      }

      const versionQuery = app.activeVersionId
        ? ArtifactVersion.findOne({
            artifactAppId: app.artifactAppId,
            artifactVersionId: app.activeVersionId,
          })
        : ArtifactVersion.findOne({ artifactAppId: app.artifactAppId }).sort({ versionNumber: -1 });
      if (session) versionQuery.session(session);
      const activeVersion = await versionQuery.exec();

      if (activeVersion?.integrity.sourceHash === sourceHash) {
        const versionWithPreview = await backfillActiveVersionPreview(activeVersion, session);
        const updatedApp = await ArtifactApp.findOneAndUpdate(
          {
            _id: app._id,
            deletion: { $exists: false },
            ...liveSourceGuard(),
          },
          {
            $set: {
              title: input.title,
              sourceMetadata: canonicalSource,
              'marketplace.listed': true,
              ...(versionWithPreview.preview ? { preview: versionWithPreview.preview } : {}),
            },
            ...(!versionWithPreview.preview ? { $unset: { preview: 1 } } : {}),
          },
          { new: true, ...(session ? { session } : {}) },
        ).exec();
        if (!updatedApp) {
          await throwIfSourceUnavailable(app._id);
          throw new ArtifactSyncRetryError('[syncArtifactAppWithVersion] Concurrent app update');
        }
        return {
          app: toAppRecord(updatedApp),
          version: toVersionRecord(versionWithPreview),
          created: false,
          versionCreated: false,
        };
      }

      if (
        options.basedOnVersionNumber != null &&
        options.basedOnVersionNumber < app.latestVersionNumber
      ) {
        throw new ArtifactSyncConflictError();
      }

      const nextNumber = app.latestVersionNumber + 1;
      const versionSeed = buildVersionDoc(
        app.artifactAppId,
        app.tenantId,
        nextNumber,
        input.version,
        'draft',
      );
      const createOptions = session ? { session } : undefined;
      const updatedApp = await ArtifactApp.findOneAndUpdate(
        {
          _id: app._id,
          latestVersionNumber: app.latestVersionNumber,
          activeVersionId: app.activeVersionId ?? null,
          deletion: { $exists: false },
          ...liveSourceGuard(),
        },
        {
          $set: {
            title: input.title,
            sourceMetadata: canonicalSource,
            'marketplace.listed': true,
            latestVersionNumber: nextNumber,
            activeVersionId: versionSeed.artifactVersionId,
            ...(input.version.preview ? { preview: input.version.preview } : {}),
          },
          ...(!input.version.preview ? { $unset: { preview: 1 } } : {}),
        },
        { new: true, ...createOptions },
      ).exec();
      if (!updatedApp) {
        await throwIfSourceUnavailable(app._id);
        throw new ArtifactSyncRetryError('[syncArtifactAppWithVersion] Concurrent app update');
      }
      const [version] = await ArtifactVersion.create([versionSeed], createOptions);
      return {
        app: toAppRecord(updatedApp),
        version: toVersionRecord(version),
        created: false,
        versionCreated: true,
      };
    };

    if (!(await supportsTransactions(mongoose))) {
      for (let attempt = 0; attempt < syncOptions.syncWriteRetryAttempts; attempt++) {
        try {
          return await applyStandaloneSync();
        } catch (error) {
          if (!isRetryableWriteError(error) || attempt === syncOptions.syncWriteRetryAttempts - 1) {
            throw error;
          }
        }
      }
      throw new Error('[syncArtifactAppWithVersion] Standalone sync exhausted retries');
    }

    for (let attempt = 0; attempt < syncOptions.syncWriteRetryAttempts; attempt++) {
      const session = await mongoose.startSession();
      try {
        let result: SyncArtifactAppResult | undefined;
        await session.withTransaction(async () => {
          result = await applySync(session);
        });
        if (!result) {
          throw new Error('[syncArtifactAppWithVersion] Transaction produced no result');
        }
        return result;
      } catch (error) {
        if (!isRetryableWriteError(error) || attempt === syncOptions.syncWriteRetryAttempts - 1) {
          throw error;
        }
      } finally {
        await session.endSession();
      }
    }
    throw new Error('[syncArtifactAppWithVersion] Transaction sync exhausted retries');
  }

  async function resolveArtifactAppId(query: ArtifactAppQuery): Promise<string | null> {
    const doc = await getApp()
      .findOne({
        artifactAppId: query.artifactAppId,
        deletion: { $exists: false },
        status: { $ne: 'archived' },
      })
      .select({ _id: 1, artifactAppId: 1 })
      .lean<{ _id: Types.ObjectId; artifactAppId: string }>()
      .exec();
    return doc?._id.toString() ?? null;
  }

  async function listArtifactApps(options: ArtifactAppListOptions): Promise<ArtifactAppListPage> {
    let ownershipFilter: FilterQuery<IArtifactApp> = {
      deletion: { $exists: false },
      status: { $ne: 'archived' },
    };
    if (options.createdBy) {
      ownershipFilter = {
        createdBy: options.createdBy,
        deletion: { $exists: false },
        status: { $ne: 'archived' },
      };
    } else if (options.excludeCreatedBy) {
      ownershipFilter = {
        createdBy: { $ne: options.excludeCreatedBy },
        deletion: { $exists: false },
        status: { $ne: 'archived' },
      };
    }
    const cursor = options.cursor ? decodeAppCursor(options.cursor) : null;
    const cursorFilter: FilterQuery<IArtifactApp> | undefined = cursor
      ? {
          $or: [
            { updatedAt: { $lt: cursor.updatedAt } },
            { updatedAt: cursor.updatedAt, _id: { $lt: cursor.id } },
          ],
        }
      : undefined;
    const filters: FilterQuery<IArtifactApp>[] = [ownershipFilter];
    if (cursorFilter) {
      filters.push(cursorFilter);
    }
    const search = options.search?.trim();
    if (search) {
      const searchRegex = new RegExp(escapeRegExp(search), 'i');
      filters.push({
        $or: [
          { title: searchRegex },
          { description: searchRegex },
          { category: searchRegex },
          { tags: searchRegex },
        ],
      });
    }
    const apps = await getApp()
      .find(filters.length === 1 ? filters[0] : { $and: filters })
      .select({ _id: 1, updatedAt: 1 })
      .sort({ updatedAt: -1, _id: -1 })
      .limit(options.limit + 1)
      .lean<Array<Pick<IArtifactApp, '_id' | 'updatedAt'>>>()
      .exec();
    const hasMore = apps.length > options.limit;
    const page = hasMore ? apps.slice(0, options.limit) : apps;
    const entries = page.map((app) => ({ id: app._id.toString(), cursor: encodeAppCursor(app) }));
    return {
      entries,
      hasMore,
      after: hasMore ? (entries[entries.length - 1]?.cursor ?? null) : null,
    };
  }

  async function getArtifactAppsByIds(ids: string[]): Promise<ArtifactAppRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const uniqueIds = [...new Set(ids)];
    const apps = await getApp()
      .find({
        _id: { $in: uniqueIds },
        deletion: { $exists: false },
        status: { $ne: 'archived' },
      })
      .lean<IArtifactApp[]>()
      .exec();
    const appsById = new Map(apps.map((app) => [app._id.toString(), toAppRecord(app)]));
    return ids.flatMap((id) => {
      const app = appsById.get(id);
      return app ? [app] : [];
    });
  }

  async function updateArtifactApp(
    query: ArtifactAppQuery,
    update: ArtifactAppUpdate,
  ): Promise<ArtifactAppRecord | null> {
    const app = await getApp()
      .findOneAndUpdate(
        {
          artifactAppId: query.artifactAppId,
          deletion: { $exists: false },
          status: { $ne: 'archived' },
        },
        { $set: update },
        { new: true },
      )
      .lean<IArtifactApp>()
      .exec();
    return app ? toAppRecord(app) : null;
  }

  async function deleteArtifactApp(
    query: ArtifactAppQuery,
  ): Promise<{ deletedApp: boolean; deletedVersions: number }> {
    const performDelete = async (session?: ClientSession) => {
      const appQuery = getApp().findOne({ artifactAppId: query.artifactAppId });
      if (session) appQuery.session(session);
      const app = await appQuery.exec();
      if (!app) {
        return { deletedApp: false, deletedVersions: 0 };
      }
      const versionResult = await getVersion().deleteMany(
        { artifactAppId: query.artifactAppId },
        session ? { session } : undefined,
      );
      const appResult = await getApp().deleteOne(
        { _id: app._id },
        session ? { session } : undefined,
      );
      return {
        deletedApp: appResult.deletedCount === 1,
        deletedVersions: versionResult.deletedCount ?? 0,
      };
    };

    if (!(await supportsTransactions(mongoose))) {
      return performDelete();
    }
    const session = await mongoose.startSession();
    try {
      let result: { deletedApp: boolean; deletedVersions: number } | undefined;
      await session.withTransaction(async () => {
        result = await performDelete(session);
      });
      return result ?? { deletedApp: false, deletedVersions: 0 };
    } finally {
      await session.endSession();
    }
  }

  async function prepareArtifactAppDeletion(
    query: ArtifactAppQuery,
    requestedBy: string,
  ): Promise<ArtifactAppDeletionResult> {
    const prepare = async (session?: ClientSession): Promise<ArtifactAppDeletionResult> => {
      const claimQuery = getApp().findOneAndUpdate(
        {
          artifactAppId: query.artifactAppId,
          deletion: { $exists: false },
        },
        { $set: { deletion: { requestedBy, requestedAt: new Date() } } },
        { new: true, ...(session ? { session } : {}) },
      );
      let app = await claimQuery.exec();
      if (!app) {
        const resumableQuery = getApp().findOne({
          artifactAppId: query.artifactAppId,
          deletion: { $exists: true },
        });
        if (session) resumableQuery.session(session);
        app = await resumableQuery.exec();
        if (!app) {
          return { found: false, deletedVersions: 0 };
        }
      }
      const versionResult = await getVersion().deleteMany(
        { artifactAppId: query.artifactAppId },
        session ? { session } : undefined,
      );
      return {
        found: true,
        resourceId: app._id.toString(),
        deletedVersions: versionResult.deletedCount ?? 0,
      };
    };

    if (!(await supportsTransactions(mongoose))) {
      return prepare();
    }
    const session = await mongoose.startSession();
    try {
      let result: ArtifactAppDeletionResult | undefined;
      await session.withTransaction(async () => {
        result = await prepare(session);
      });
      return result ?? { found: false, deletedVersions: 0 };
    } finally {
      await session.endSession();
    }
  }

  async function finalizeArtifactAppDeletion(
    query: ArtifactAppQuery,
    _requestedBy: string,
  ): Promise<boolean> {
    const result = await getApp()
      .updateOne(
        {
          artifactAppId: query.artifactAppId,
          deletion: { $exists: true },
        },
        {
          $set: {
            'deletion.finalizedAt': new Date(),
            status: 'archived',
            archivedAt: new Date(),
            'marketplace.listed': false,
          },
          $unset: { activeVersionId: 1, syncLock: 1 },
        },
      )
      .exec();
    return result.matchedCount === 1;
  }

  async function getArtifactVersion(
    query: ArtifactVersionQuery,
  ): Promise<ArtifactVersionRecord | null> {
    const version = await getVersion()
      .findOne(buildVersionFilter(query))
      .lean<IArtifactVersion>()
      .exec();
    return version ? toVersionRecord(version) : null;
  }

  async function listArtifactVersions(
    options: ArtifactVersionListOptions,
  ): Promise<ArtifactVersionListPage> {
    const beforeVersion = options.cursor ? decodeVersionCursor(options.cursor) : null;
    const filter: FilterQuery<IArtifactVersion> = {
      artifactAppId: options.artifactAppId,
      ...(beforeVersion != null ? { versionNumber: { $lt: beforeVersion } } : {}),
      ...(options.excludeWithdrawn ? { 'publication.state': { $ne: 'withdrawn' } } : {}),
    };
    const versions = await getVersion()
      .find(filter)
      .select({ sourceSnapshot: 0, runtimeConfig: 0, integrity: 0 })
      .sort({ versionNumber: -1 })
      .limit(options.limit + 1)
      .lean<IArtifactVersion[]>()
      .exec();
    const hasMore = versions.length > options.limit;
    const page = hasMore ? versions.slice(0, options.limit) : versions;
    const lastVersion = page[page.length - 1];
    return {
      versions: page.map(toVersionSummary),
      hasMore,
      after: hasMore && lastVersion ? encodeVersionCursor(lastVersion.versionNumber) : null,
    };
  }

  async function releaseArtifactVersion(
    query: ArtifactVersionQuery,
    releasedBy: string,
  ): Promise<ArtifactVersionRecord | null> {
    const version = await getVersion().findOne(buildVersionFilter(query)).exec();
    if (!version) {
      return null;
    }
    if (version.publication.state === 'released') {
      return toVersionRecord(version);
    }
    version.publication = {
      state: 'released',
      releasedBy,
      releasedAt: new Date(),
    };
    await version.save();
    return toVersionRecord(version);
  }

  async function activateArtifactVersion(
    query: ArtifactVersionQuery,
  ): Promise<ArtifactAppWithVersion | null> {
    const versionFilter = buildVersionFilter(query);
    const activate = async (session?: ClientSession): Promise<ArtifactAppWithVersion | null> => {
      // Re-asserting 'released' as a $set (not just a filter) makes this a real write to the
      // version document, so a concurrent withdraw's write to that same document collides with
      // it under a transaction instead of racing silently — one side aborts and retries, and
      // the retry sees the other's committed result instead of activating stale state.
      const versionQuery = getVersion().findOneAndUpdate(
        { ...versionFilter, 'publication.state': 'released' },
        { $set: { 'publication.state': 'released' } },
        { new: true },
      );
      if (session) {
        versionQuery.session(session);
      }
      const version = await versionQuery.exec();
      if (!version) {
        const existingQuery = getVersion().findOne(versionFilter);
        if (session) {
          existingQuery.session(session);
        }
        const existing = await existingQuery.exec();
        if (!existing) {
          return null;
        }
        throw new Error('[activateArtifactVersion] Only released versions can be activated');
      }
      const appQuery = getApp().findOneAndUpdate(
        { artifactAppId: query.artifactAppId },
        version.preview
          ? { $set: { activeVersionId: version.artifactVersionId, preview: version.preview } }
          : {
              $set: { activeVersionId: version.artifactVersionId },
              $unset: { preview: 1 },
            },
        { new: true },
      );
      if (session) {
        appQuery.session(session);
      }
      const app = await appQuery.exec();
      if (!app) {
        return null;
      }
      return { app: toAppRecord(app), version: toVersionRecord(version) };
    };

    if (!(await supportsTransactions(mongoose))) {
      const result = await activate();
      if (!result) {
        return result;
      }
      // Standalone mode has no cross-document atomicity, so the version-write and the
      // app-write below can straddle a concurrent withdraw with nothing to collide with —
      // verify the version is still released immediately after, and self-heal by reverting
      // the pointer (mirroring withdrawArtifactVersion's own CAS-guarded clear) if not.
      const stillReleased = await getVersion()
        .findOne({
          artifactVersionId: result.version.artifactVersionId,
          'publication.state': 'released',
        })
        .exec();
      if (!stillReleased) {
        await getApp()
          .updateOne(
            {
              artifactAppId: query.artifactAppId,
              activeVersionId: result.version.artifactVersionId,
            },
            { $unset: { activeVersionId: 1, preview: 1 } },
          )
          .exec();
        throw new Error('[activateArtifactVersion] Only released versions can be activated');
      }
      return result;
    }
    const session = await mongoose.startSession();
    try {
      let result: ArtifactAppWithVersion | null = null;
      await session.withTransaction(async () => {
        result = await activate(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async function withdrawArtifactVersion(
    query: ArtifactVersionQuery,
  ): Promise<ArtifactVersionRecord | null> {
    const withdraw = async (session?: ClientSession): Promise<IArtifactVersion | null> => {
      const versionQuery = getVersion().findOneAndUpdate(
        buildVersionFilter(query),
        { $set: { 'publication.state': 'withdrawn' } },
        { new: true },
      );
      if (session) {
        versionQuery.session(session);
      }
      const version = await versionQuery.exec();
      if (!version) {
        return null;
      }
      // A withdrawn version must stop being served as the app's active snapshot, or shared
      // viewers keep executing it via the detail endpoint's activeVersionId lookup. The
      // preview thumbnail is sourced from that same version, so it comes down with it —
      // otherwise catalog listings keep publicly showing a snapshot of withdrawn content.
      const appQuery = getApp().updateOne(
        { artifactAppId: query.artifactAppId, activeVersionId: version.artifactVersionId },
        { $unset: { activeVersionId: 1, preview: 1 } },
      );
      if (session) {
        appQuery.session(session);
      }
      await appQuery.exec();
      return version;
    };

    if (!(await supportsTransactions(mongoose))) {
      const version = await withdraw();
      return version ? toVersionRecord(version) : null;
    }
    const session = await mongoose.startSession();
    try {
      let version: IArtifactVersion | null = null;
      await session.withTransaction(async () => {
        version = await withdraw(session);
      });
      return version ? toVersionRecord(version) : null;
    } finally {
      await session.endSession();
    }
  }

  async function deleteUserArtifactApps(
    userId: string,
  ): Promise<{ deletedApps: number; deletedVersions: number }> {
    const apps = await getApp()
      .find({ createdBy: userId })
      .select({ _id: 1, artifactAppId: 1 })
      .lean<Array<{ _id: Types.ObjectId; artifactAppId: string }>>()
      .exec();
    const Tombstone = getArtifactSourceTombstoneModel(mongoose);
    if (Tombstone) {
      await Tombstone.deleteMany({ createdBy: userId }).exec();
    }
    if (apps.length === 0) {
      return { deletedApps: 0, deletedVersions: 0 };
    }

    const resourceIds = apps.map((app) => app._id);
    const artifactAppIds = apps.map((app) => app.artifactAppId);
    const AclEntry = mongoose.models.AclEntry as Model<IAclEntry> | undefined;
    if (AclEntry) {
      await AclEntry.deleteMany({
        resourceType: ResourceType.ARTIFACT_APP,
        resourceId: { $in: resourceIds },
      }).exec();
    }

    const versionResult = await getVersion()
      .deleteMany({ artifactAppId: { $in: artifactAppIds } })
      .exec();
    const appResult = await getApp()
      .deleteMany({ createdBy: userId, _id: { $in: resourceIds } })
      .exec();
    return {
      deletedApps: appResult.deletedCount ?? 0,
      deletedVersions: versionResult.deletedCount ?? 0,
    };
  }

  return {
    createArtifactAppWithVersion,
    syncArtifactAppWithVersion,
    getArtifactAppByAppId,
    getArtifactAppBySource,
    getDeletedArtifactAppBySource,
    restoreArtifactAppWithVersion,
    resolveArtifactAppId,
    listArtifactApps,
    getArtifactAppsByIds,
    updateArtifactApp,
    deleteArtifactApp,
    prepareArtifactAppDeletion,
    finalizeArtifactAppDeletion,
    deleteUserArtifactApps,
    recordArtifactSourceTombstones: (createdBy, conversationIds) =>
      recordArtifactSourceTombstones(mongoose, createdBy, conversationIds),
    getArtifactVersion,
    listArtifactVersions,
    releaseArtifactVersion,
    activateArtifactVersion,
    withdrawArtifactVersion,
  };
}
