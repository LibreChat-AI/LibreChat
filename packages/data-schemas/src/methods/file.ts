import { Types } from 'mongoose';
import { createHash } from 'crypto';
import { EToolResources, FileContext, FileSources, getCodeEnvRefs } from 'librechat-data-provider';
import type {
  TFile,
  CodeEnvRef,
  TFileWorkspaceImport,
  TFileWorkspaceImports,
} from 'librechat-data-provider';
import type { FilterQuery, SortOrder, Model } from 'mongoose';
import type {
  IMongoFile,
  RunArtifactFile,
  RunArtifactClaim,
  RunArtifactScope,
  CodeFileCommitData,
  RunArtifactRunScope,
  PublishRunArtifactInput,
  ClearFileCodeEnvRefsParams,
  FileStorageCleanupParams,
  DeleteFilesOptions,
  DeleteFilesResult,
} from '~/types/file';
import type { IChatProjectDocument } from '~/types';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { fileContentUpdate } from './fileContent';
import { escapeRegExp } from '~/utils/string';
import logger from '../config/winston';

/** A loaded file record, named by the fields that identify it: `file_id` is not unique alone. */
export type LegacySearchFileRef = {
  file_id: string;
  user: string;
  tenantId?: string;
};

/** A user's file's freshly computed digest, the copy placed in one workspace, or both. */
export type WorkspaceImportRecord = {
  file_id: string;
  user: string;
  /** The record's own tenant; an untenanted record is matched as untenanted. */
  tenantId?: string | null;
  /** `key` is an opaque hex digest of the conversation and workspace the copy went to. */
  copy?: { key: string; target: TFileWorkspaceImport };
  digest?: NonNullable<TFileWorkspaceImports['digest']>;
};

export type ClearFileEmbeddingsParams = {
  file_id: string;
  userId: string;
  tenantId?: string | null;
  updatedAt?: Date | string;
  embeddedEntities?: string[];
  ownershipTrackingStart?: string;
};

export const DEFAULT_AVAILABLE_PROJECT_FILES_LIMIT = 20;
export const MAX_AVAILABLE_PROJECT_FILES_LIMIT = 50;

/** Plain projection of a candidate file. The picker's response crosses into `@librechat/api`
 * and the client, so this names no Mongoose type: `_id` and `user` are already strings here. */
export type AvailableProjectFileRecord = {
  _id: string;
  file_id: string;
  filename: string;
  filepath: string;
  object: 'file';
  type: string;
  bytes: number;
  usage: number;
  embedded?: boolean;
  metadata?: { searchDestination?: boolean; routingMimeType?: string };
  context?: string;
  user: string;
  tenantId?: string;
};

type AvailableProjectFileRecordSource = Pick<
  IMongoFile,
  | '_id'
  | 'file_id'
  | 'filename'
  | 'filepath'
  | 'object'
  | 'type'
  | 'bytes'
  | 'usage'
  | 'embedded'
  | 'metadata'
  | 'context'
  | 'user'
  | 'tenantId'
>;

function normalizeAvailableProjectFileRecord(
  file: AvailableProjectFileRecordSource,
): AvailableProjectFileRecord {
  return {
    _id: file._id.toString(),
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    object: file.object,
    type: file.type,
    bytes: file.bytes,
    usage: file.usage,
    ...(file.embedded !== undefined ? { embedded: file.embedded } : {}),
    ...(file.metadata?.searchDestination !== undefined ||
    file.metadata?.routingMimeType !== undefined
      ? {
          metadata: {
            ...(file.metadata.searchDestination !== undefined
              ? { searchDestination: file.metadata.searchDestination }
              : {}),
            ...(file.metadata.routingMimeType !== undefined
              ? { routingMimeType: file.metadata.routingMimeType }
              : {}),
          },
        }
      : {}),
    ...(file.context !== undefined ? { context: file.context } : {}),
    user: file.user.toString(),
    ...(file.tenantId !== undefined ? { tenantId: file.tenantId } : {}),
  };
}

export type AvailableProjectFilesOptions = FileOwnerScope & {
  excludedFileIds?: string[];
  limit?: number;
  cursor?: string | null;
  search?: string;
  now?: Date;
};

export type AvailableProjectFilesResult = {
  files: AvailableProjectFileRecord[];
  nextCursor: string | null;
};

export type ProjectFileRecord = {
  _id: string;
  file_id: string;
  filename: string;
  filepath: string;
  object: 'file';
  type: string;
  bytes: number;
  usage: number;
  embedded?: boolean;
  metadata?: { searchDestination?: boolean; routingMimeType?: string };
  source?: string;
  storageKey?: string;
  storageRegion?: string;
  context?: string;
  expiredAt?: Date | null;
  user: string;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  previewRevision?: string;
  status?: 'pending' | 'ready' | 'failed';
  text?: string;
};

type ProjectFileRecordSource = Pick<
  IMongoFile,
  | '_id'
  | 'file_id'
  | 'filename'
  | 'filepath'
  | 'object'
  | 'type'
  | 'bytes'
  | 'usage'
  | 'embedded'
  | 'metadata'
  | 'source'
  | 'storageKey'
  | 'storageRegion'
  | 'context'
  | 'expiredAt'
  | 'user'
  | 'tenantId'
  | 'createdAt'
  | 'updatedAt'
  | 'previewRevision'
  | 'status'
  | 'text'
>;

function normalizeProjectFileRecord(file: ProjectFileRecordSource): ProjectFileRecord {
  return {
    _id: file._id.toString(),
    file_id: file.file_id,
    filename: file.filename,
    filepath: file.filepath,
    object: file.object,
    type: file.type,
    bytes: file.bytes,
    usage: file.usage,
    ...(file.embedded !== undefined ? { embedded: file.embedded } : {}),
    ...(file.metadata?.searchDestination !== undefined ||
    file.metadata?.routingMimeType !== undefined
      ? {
          metadata: {
            ...(file.metadata.searchDestination !== undefined
              ? { searchDestination: file.metadata.searchDestination }
              : {}),
            ...(file.metadata.routingMimeType !== undefined
              ? { routingMimeType: file.metadata.routingMimeType }
              : {}),
          },
        }
      : {}),
    ...(file.source !== undefined ? { source: file.source } : {}),
    ...(file.storageKey !== undefined ? { storageKey: file.storageKey } : {}),
    ...(file.storageRegion !== undefined ? { storageRegion: file.storageRegion } : {}),
    ...(file.context !== undefined ? { context: file.context } : {}),
    ...(file.expiredAt !== undefined ? { expiredAt: file.expiredAt } : {}),
    user: file.user.toString(),
    ...(file.tenantId !== undefined ? { tenantId: file.tenantId } : {}),
    ...(file.createdAt !== undefined ? { createdAt: file.createdAt } : {}),
    ...(file.updatedAt !== undefined ? { updatedAt: file.updatedAt } : {}),
    ...(file.previewRevision !== undefined ? { previewRevision: file.previewRevision } : {}),
    ...(file.status !== undefined ? { status: file.status } : {}),
    ...(file.text !== undefined ? { text: file.text } : {}),
  };
}

export type ProjectFilesOptions = FileOwnerScope & {
  fileIds: string[];
  includeContent?: boolean;
};

export class InvalidAvailableProjectFilesCursorError extends Error {
  constructor() {
    super('Invalid project file cursor');
    this.name = 'InvalidAvailableProjectFilesCursorError';
  }
}

export function parseAvailableProjectFilesCursor(cursor?: string | null): string | null {
  if (cursor == null || cursor === '') {
    return null;
  }
  if (cursor.length !== 24 || !Types.ObjectId.isValid(cursor)) {
    throw new InvalidAvailableProjectFilesCursorError();
  }
  return cursor;
}

export type FileOwnerScope = {
  userId: string;
  tenantId?: string | null;
};

export type ExpiredFileQueryOptions = {
  now?: Date;
};

export class FileStorageConflictError extends Error {
  readonly code: string = 'FILE_STORAGE_CONFLICT';

  constructor() {
    super('The file has a conflicting storage operation');
    this.name = 'FileStorageConflictError';
  }
}

function codeFileStorageFilter(): FilterQuery<IMongoFile> {
  return {
    'storageOperations.deletionPending': { $ne: true },
    'storageOperations.deleting': { $exists: false },
    'storageOperations.provisioning.0': { $exists: false },
  };
}

function rethrowCodeFileStorageConflict(error: unknown): never {
  if (error instanceof Error && 'code' in error && error.code === 11000) {
    throw new FileStorageConflictError();
  }
  throw error;
}

function assertValidCodeEnvironmentRouteKey(routeKey: string): void {
  if (routeKey.length === 0 || routeKey.includes('.') || routeKey.startsWith('$')) {
    throw new Error(`Invalid code environment route key "${routeKey}"`);
  }
}

function withOwnerScope<T extends FilterQuery<IMongoFile>>(
  filter: T,
  ownerScope?: FileOwnerScope,
): T & FilterQuery<IMongoFile> {
  if (!ownerScope) {
    return filter;
  }

  const scopedFilter: T & FilterQuery<IMongoFile> = {
    ...filter,
    user: ownerScope.userId,
  };
  if (ownerScope.tenantId) {
    scopedFilter.tenantId = ownerScope.tenantId;
  }
  return scopedFilter;
}

/** Re-provisioned copies keep their parent row and erasure retry anchor. */
function fileStorageCleanupFilter(data: FileStorageCleanupParams): FilterQuery<IMongoFile> {
  return {
    file_id: data.file_id,
    user: data.userId,
    $and: [{ tenantId: data.tenantId ?? null }],
    updatedAt: data.updatedAt ?? { $exists: false },
    'metadata.codeEnvRef': null,
    'metadata.codeEnvRefs': { $in: [null, {}] },
    'storageOperations.provisioning.0': { $exists: false },
    'storageOperations.deleting': { $exists: false },
    ...(data.source === FileSources.vectordb
      ? {
          embedded: data.embedded ?? { $ne: true },
          'metadata.embeddedEntities': data.embeddedEntities ?? null,
        }
      : { embedded: { $ne: true } }),
  };
}

type PlainFileDocument = Omit<TFile, 'user' | '_id'> & {
  user: IMongoFile['user'];
  _id?: IMongoFile['_id'];
};

type RunArtifactDocument = Omit<RunArtifactFile, 'user' | '_id'> & PlainFileDocument;

function runArtifactFilter(scope: RunArtifactRunScope): FilterQuery<IMongoFile> {
  const required = [scope.userId, scope.conversationId, scope.runId];
  if (required.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
    throw new Error('A complete run artifact owner scope is required');
  }
  if (scope.tenantId != null && scope.tenantId.trim().length === 0) {
    throw new Error('An empty run artifact tenant is invalid');
  }
  return {
    user: scope.userId,
    tenantId: scope.tenantId ?? null,
    conversationId: scope.conversationId,
    context: FileContext.run_artifact,
    'metadata.runFile.runId': scope.runId,
  };
}

function runArtifactIdentityFilter(scope: RunArtifactScope): FilterQuery<IMongoFile> {
  const filter = runArtifactFilter(scope);
  if (
    [scope.executionId, scope.agentId, scope.sourceFileId].some(
      (value) => typeof value !== 'string' || value.trim().length === 0,
    )
  ) {
    throw new Error('A complete run artifact execution scope is required');
  }
  return {
    ...filter,
    'metadata.runFile.executionId': scope.executionId,
    'metadata.runFile.agentId': scope.agentId,
    'metadata.runFile.sourceFileId': scope.sourceFileId,
  };
}

/** A versioned, scoped UUID reserves no incomplete file document or downloadable bytes. */
function runArtifactFileId(scope: RunArtifactScope): string {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify([
        'librechat-run-artifact:v1',
        scope.userId,
        scope.tenantId ?? null,
        scope.conversationId,
        scope.runId,
        scope.executionId,
        scope.agentId,
        scope.sourceFileId,
      ]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function serializeRunArtifact(
  file: RunArtifactDocument,
  scope?: RunArtifactScope,
): RunArtifactFile {
  if (scope != null && file.metadata.runFile.agentId !== scope.agentId) {
    throw new Error('The run artifact belongs to a different producing agent');
  }
  const { _id, user, ...fields } = file;
  return { ...fields, user: user.toString(), ...(_id == null ? {} : { _id: String(_id) }) };
}

/** Factory function that takes mongoose instance and returns the file methods */
export function createFileMethods(mongoose: typeof import('mongoose')): {
  getRunFileCandidates: (fileIds: readonly string[], tenantId?: string | null) => Promise<TFile[]>;
  claimRunArtifactFile: (scope: RunArtifactScope) => Promise<RunArtifactClaim>;
  publishRunArtifactFile: (input: PublishRunArtifactInput) => Promise<RunArtifactFile>;
  findRunArtifactFile: (scope: RunArtifactScope) => Promise<RunArtifactFile | null>;
  listRunArtifacts: (scope: RunArtifactRunScope) => Promise<RunArtifactFile[]>;
  findFileById: (file_id: string, options?: Record<string, unknown>) => Promise<IMongoFile | null>;
  getFiles: (
    filter: FilterQuery<IMongoFile>,
    _sortOptions?: Record<string, SortOrder> | null,
    selectFields?: Record<string, 0 | 1> | string | null,
    limit?: number | null,
  ) => Promise<IMongoFile[] | null>;
  getProjectFiles: (options: ProjectFilesOptions) => Promise<ProjectFileRecord[]>;
  getAvailableProjectFiles: (
    options: AvailableProjectFilesOptions,
  ) => Promise<AvailableProjectFilesResult>;
  getExpiredFiles: (limit?: number, options?: ExpiredFileQueryOptions) => Promise<IMongoFile[]>;
  incrementFileDeletionAttempts: (file_id: string) => Promise<number>;
  deferExpiredFile: (file_id: string, deletionRetryAt: Date) => Promise<void>;
  getToolFilesByIds: (
    fileIds: string[],
    toolResourceSet?: Set<EToolResources>,
    ownerScope?: FileOwnerScope,
  ) => Promise<IMongoFile[]>;
  getCodeGeneratedFiles: (
    conversationId: string,
    threadFileIds?: string[],
    ownerScope?: FileOwnerScope,
  ) => Promise<IMongoFile[]>;
  getUserCodeFiles: (fileIds: string[], ownerScope: FileOwnerScope) => Promise<IMongoFile[]>;
  getDeferredProvisionFiles: (
    fileIds: string[],
    ownerScope: FileOwnerScope,
    resources?: {
      code?: boolean;
      search?: boolean;
      codeRouteKey?: string;
      searchNamespaces?: string[];
      hydrateProvisioned?: boolean;
    },
  ) => Promise<IMongoFile[]>;
  claimCodeFile: (data: {
    filename: string;
    conversationId: string;
    file_id: string;
    user: string;
    tenantId?: string | null;
    sourceDispatchedAt?: number;
  }) => Promise<IMongoFile>;
  commitCodeFile: (data: CodeFileCommitData, sourceDispatchedAt?: number) => Promise<boolean>;
  createFile: (data: Partial<IMongoFile>, disableTTL?: boolean) => Promise<IMongoFile | null>;
  updateFile: (
    data: Partial<IMongoFile> & { file_id: string },
    extraFilter?: FilterQuery<IMongoFile>,
  ) => Promise<IMongoFile | null>;
  updateFileCodeEnvRef: (data: {
    file_id: string;
    routeKey: string;
    ref: CodeEnvRef;
    legacyRef?: CodeEnvRef;
  }) => Promise<IMongoFile | null>;
  clearFileCodeEnvRefs: (data: ClearFileCodeEnvRefsParams) => Promise<boolean>;
  clearFileEmbeddings: (data: ClearFileEmbeddingsParams) => Promise<boolean>;
  isFileStorageClean: (data: FileStorageCleanupParams) => Promise<boolean>;
  addFileEmbeddedEntity: (data: {
    file_id: string;
    entityId: string;
  }) => Promise<IMongoFile | null>;
  recordFileWorkspaceImport: (data: WorkspaceImportRecord) => Promise<boolean>;
  adoptLegacySearchEmbeddings: (data: {
    files: LegacySearchFileRef[];
    agentId: string;
  }) => Promise<string[]>;
  updateFileUsage: (data: {
    file_id: string;
    inc?: number;
    user?: string;
    tenantId?: string | null;
  }) => Promise<IMongoFile | null>;
  deleteFile: (file_id: string) => Promise<IMongoFile | null>;
  deleteFiles: (
    file_ids: string[],
    user?: string,
    options?: DeleteFilesOptions,
  ) => Promise<DeleteFilesResult>;
  deleteFileByFilter: (filter: FilterQuery<IMongoFile>) => Promise<IMongoFile | null>;
  batchUpdateFiles: (
    updates: Array<{
      file_id: string;
      filepath: string;
      storageKey?: string;
      storageRegion?: string;
    }>,
  ) => Promise<void>;
  updateFilesUsage: (
    files: Array<{ file_id: string }>,
    fileIds?: string[],
    options?: { user?: string; tenantId?: string | null },
  ) => Promise<IMongoFile[]>;
  extendFilesTTL: (
    fileIds: string[],
    hold: { renewMs: number; maxLifetimeMs: number },
    owner: { user: string; tenantId?: string | null },
  ) => Promise<number>;
  sweepOrphanedPreviews: (maxAgeMs?: number) => Promise<number>;
} {
  /** Hydrates only host-selected IDs; the caller applies its existing agent-file authorization. */
  async function getRunFileCandidates(
    fileIds: readonly string[],
    tenantId?: string | null,
  ): Promise<TFile[]> {
    if (fileIds.length === 0) {
      return [];
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    const files = await File.find({
      file_id: { $in: fileIds },
      tenantId: tenantId ?? null,
    }).lean<PlainFileDocument[]>();
    return files.map(({ user, _id, ...file }) => ({
      ...file,
      user: String(user),
      embedded: file.embedded === true,
      ...(_id == null ? {} : { _id: String(_id) }),
    }));
  }

  async function findRunArtifactFile(scope: RunArtifactScope): Promise<RunArtifactFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const file = await File.findOne(runArtifactIdentityFilter(scope)).lean<RunArtifactDocument>();
    return file == null ? null : serializeRunArtifact(file, scope);
  }

  async function listRunArtifacts(scope: RunArtifactRunScope): Promise<RunArtifactFile[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const files = await File.find(runArtifactFilter(scope))
      .sort({ createdAt: 1, file_id: 1 })
      .lean<RunArtifactDocument[]>();
    return files.map((file) => serializeRunArtifact(file));
  }

  async function claimRunArtifactFile(scope: RunArtifactScope): Promise<RunArtifactClaim> {
    const file = await findRunArtifactFile(scope);
    return file == null ? { file_id: runArtifactFileId(scope) } : { file_id: file.file_id, file };
  }

  /** Publishes one complete storage result. Retried writers cannot replace its bytes or grants. */
  async function publishRunArtifactFile({
    scope,
    file,
    provenance,
  }: PublishRunArtifactInput): Promise<RunArtifactFile> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const filter = runArtifactIdentityFilter(scope);
    if (
      provenance.runId !== scope.runId ||
      provenance.executionId !== scope.executionId ||
      provenance.agentId !== scope.agentId ||
      provenance.sourceFileId !== scope.sourceFileId ||
      !Number.isFinite(Date.parse(provenance.publishedAt))
    ) {
      throw new Error('Run artifact provenance does not match its publication scope');
    }
    if (
      !file.filepath ||
      !file.filename ||
      !file.type ||
      file.source === FileSources.execute_code ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0
    ) {
      throw new Error('A durable stored file is required to publish a run artifact');
    }
    const now = new Date();
    const insert = {
      filename: file.filename,
      filepath: file.filepath,
      bytes: file.bytes,
      type: file.type,
      storageKey: file.storageKey,
      storageRegion: file.storageRegion,
      text: file.text,
      textFormat: file.textFormat,
      status: file.status,
      previewError: file.previewError,
      previewRevision: file.previewRevision,
      width: file.width,
      height: file.height,
      messageId: file.messageId,
      expiredAt: file.expiredAt,
      file_id: runArtifactFileId(scope),
      user: scope.userId,
      tenantId: scope.tenantId ?? undefined,
      conversationId: scope.conversationId,
      context: FileContext.run_artifact,
      object: 'file',
      source: file.source ?? FileSources.local,
      embedded: false,
      embeddingOwnersComplete: true,
      embeddingOwnersTrackedAt: new Date(),
      usage: 1,
      llmDeliveryPath: file.llmDeliveryPath ?? 'none',
      metadata: {
        ...file.metadata,
        // The source is a private execution object. Consumers must provision the
        // immutable durable copy, never reuse that potentially mutable source.
        codeEnvRef: undefined,
        codeEnvRefs: undefined,
        embeddedEntities: undefined,
        destinationChosen: false,
        runFile: provenance,
      },
      createdAt: now,
      updatedAt: now,
    };
    try {
      const published = await File.findOneAndUpdate(
        filter,
        { $setOnInsert: insert },
        { upsert: true, new: true, runValidators: true, timestamps: false },
      ).lean<RunArtifactDocument>();
      if (published == null) {
        throw new Error('Run artifact publication did not produce a file');
      }
      return serializeRunArtifact(published, scope);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 11000) {
        const existing = await findRunArtifactFile(scope);
        if (existing != null) {
          return existing;
        }
      }
      throw error;
    }
  }

  /**
   * Finds a file by its file_id with additional query options.
   * @param file_id - The unique identifier of the file
   * @param options - Query options for filtering, projection, etc.
   * @returns A promise that resolves to the file document or null
   */
  async function findFileById(
    file_id: string,
    options: Record<string, unknown> = {},
  ): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    return File.findOne({ file_id, ...options }).lean<IMongoFile>();
  }

  /** Select fields for query projection - 0 to exclude, 1 to include */
  type SelectProjection = Record<string, 0 | 1>;

  /**
   * Retrieves files matching a given filter, sorted by the most recently updated.
   * @param filter - The filter criteria to apply
   * @param _sortOptions - Optional sort parameters
   * @param selectFields - Fields to include/exclude in the query results. Default excludes the 'text' field
   * @param limit - Optional max number of documents to return (newest first)
   * @returns A promise that resolves to an array of file documents
   */
  async function getFiles(
    filter: FilterQuery<IMongoFile>,
    _sortOptions?: Record<string, SortOrder> | null,
    selectFields?: string | Record<string, 0 | 1> | null | undefined,
    limit?: number | null,
  ): Promise<IMongoFile[] | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const sortOptions = { updatedAt: -1 as SortOrder, ..._sortOptions };
    const query = File.find(filter);
    if (selectFields != null) {
      query.select(selectFields);
    } else {
      query.select({ text: 0 });
    }
    if (limit != null && limit > 0) {
      query.limit(limit);
    }
    return await query.sort(sortOptions).lean<IMongoFile[]>();
  }
  async function getProjectFiles({
    fileIds,
    userId,
    tenantId,
    includeContent = false,
  }: ProjectFilesOptions): Promise<ProjectFileRecord[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const query = File.find({
      file_id: { $in: fileIds },
      user: userId,
      $or: [{ embedded: true }, { 'metadata.searchDestination': true }],
      context: FileContext.message_attachment,
      // Mongo's null predicate matches explicit null and legacy missing tenant fields.
      tenantId: tenantId != null && tenantId !== '' ? tenantId : null,
    });
    if (includeContent) {
      query.select({});
    } else {
      query.select({
        _id: 1,
        file_id: 1,
        filename: 1,
        filepath: 1,
        object: 1,
        type: 1,
        bytes: 1,
        usage: 1,
        embedded: 1,
        'metadata.searchDestination': 1,
        'metadata.routingMimeType': 1,
        source: 1,
        storageKey: 1,
        storageRegion: 1,
        context: 1,
        expiredAt: 1,
        user: 1,
        tenantId: 1,
        createdAt: 1,
        updatedAt: 1,
        previewRevision: 1,
        status: 1,
      });
    }
    const files = (await query.lean<ProjectFileRecordSource[]>()) ?? [];
    return files.map(normalizeProjectFileRecord);
  }

  async function getAvailableProjectFiles({
    userId,
    tenantId,
    excludedFileIds = [],
    limit = DEFAULT_AVAILABLE_PROJECT_FILES_LIMIT,
    cursor,
    search,
    now = new Date(),
  }: AvailableProjectFilesOptions): Promise<AvailableProjectFilesResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AVAILABLE_PROJECT_FILES_LIMIT) {
      throw new RangeError('Invalid project file limit');
    }

    const decodedCursor = parseAvailableProjectFilesCursor(cursor);
    const filters: FilterQuery<IMongoFile>[] = [
      {
        user: userId,
        tenantId: tenantId != null && tenantId !== '' ? tenantId : null,
        $or: [{ embedded: true }, { 'metadata.searchDestination': true }],
        context: FileContext.message_attachment,
        $and: [{ $or: [{ expiredAt: null }, { expiredAt: { $gt: now } }] }],
      },
    ];
    if (excludedFileIds.length > 0) {
      filters[0].file_id = { $nin: excludedFileIds };
    }
    const normalizedSearch = search?.trim();

    if (normalizedSearch) {
      filters.push({
        filename: { $regex: escapeRegExp(normalizedSearch), $options: 'i' },
      });
    }
    if (decodedCursor) {
      filters.push({ _id: { $lt: new Types.ObjectId(decodedCursor) } });
    }

    const File = mongoose.models.File as Model<IMongoFile>;
    const files = await File.find(filters.length === 1 ? filters[0] : { $and: filters })
      .select({
        _id: 1,
        file_id: 1,
        filename: 1,
        filepath: 1,
        object: 1,
        type: 1,
        bytes: 1,
        usage: 1,
        embedded: 1,
        'metadata.searchDestination': 1,
        'metadata.routingMimeType': 1,
        context: 1,
        user: 1,
        tenantId: 1,
      })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<AvailableProjectFileRecordSource[]>();

    let nextCursor: string | null = null;
    if (files.length > limit) {
      files.pop();
      const lastFile = files[files.length - 1];
      if (lastFile) {
        nextCursor = lastFile._id.toString();
      }
    }
    return { files: files.map(normalizeAvailableProjectFileRecord), nextCursor };
  }

  /**
   * Expired files the sweep may attempt right now, oldest deadline first.
   *
   * `deletionRetryAt` is the only thing holding a file back: one that keeps
   * failing is deferred on a growing backoff, and one that exhausts its
   * attempts is parked far enough out to stop crowding the batch. Without
   * it a permanently undeletable file sorts to the front of this bounded
   * batch on every pass and starves every file that expired after it.
   *
   * The deferral is deliberately a deadline rather than a flag, so nothing
   * here is ever excluded for good. File records are reused across content
   * lifecycles — a code-output row is repurposed for a repeated
   * `(filename, conversationId)`, keeping fields it was not asked to change
   * — so bookkeeping that permanently excluded a row would eventually
   * strand a *different* object than the one it was recorded against. A
   * deadline can only ever delay that; it cannot lose it.
   *
   * An absent field means "never attempted", so records written before it
   * existed remain eligible.
   */
  async function getExpiredFiles(
    limit = 100,
    { now = new Date() }: ExpiredFileQueryOptions = {},
  ): Promise<IMongoFile[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    return await File.find({
      expiredAt: { $ne: null, $lte: now },
      $or: [{ deletionRetryAt: null }, { deletionRetryAt: { $lte: now } }],
    })
      .sort({ expiredAt: 1 })
      .limit(limit)
      .lean<IMongoFile[]>();
  }

  /**
   * Records one failed sweep deletion and returns the file's resulting
   * consecutive-failure count.
   *
   * The count comes back from the increment itself rather than being
   * re-derived from the caller's snapshot. Two nodes sweeping the same file
   * would otherwise each read the same value and each believe itself to be
   * the same attempt, pushing the stored count past the give-up cap while
   * both still think it is below — so the give-up would never be reported.
   * Returning it here gives every caller a distinct attempt number.
   */
  async function incrementFileDeletionAttempts(file_id: string): Promise<number> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const file = await File.findOneAndUpdate(
      { file_id },
      { $inc: { deletionAttempts: 1 } },
      /** `timestamps: false`: sweep bookkeeping is not a content write.
       *  `processCodeOutput` falls back to `updatedAt` as the writer-order
       *  stamp for records predating `metadata.sourceDispatchedAt`, so
       *  bumping it here would make a failed sweep look like a newer writer
       *  and a background harvest would drop its attachment. Same reasoning
       *  as `claimCodeFile`. */
      { new: true, projection: { deletionAttempts: 1 }, timestamps: false },
    ).lean<Pick<IMongoFile, 'deletionAttempts'> | null>();

    return file?.deletionAttempts ?? 0;
  }

  /**
   * Holds a file back from the sweep until `deletionRetryAt`.
   *
   * Written with `$max` so a deferral can only ever move later. A node that
   * computed a shorter backoff from a lower attempt count cannot pull the
   * file forward past a longer one another node already committed.
   */
  async function deferExpiredFile(file_id: string, deletionRetryAt: Date): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    await File.updateOne({ file_id }, { $max: { deletionRetryAt } }, { timestamps: false }).exec();
  }

  /**
   * Retrieves tool files (files that are embedded or have a fileIdentifier) from an array of file IDs.
   * Note: execute_code files are handled separately by getCodeGeneratedFiles.
   * @param fileIds - Array of file_id strings to search for
   * @param toolResourceSet - Optional filter for tool resources
   * @returns Files that match the criteria
   */
  async function getToolFilesByIds(
    fileIds: string[],
    toolResourceSet?: Set<EToolResources>,
    ownerScope?: FileOwnerScope,
  ): Promise<IMongoFile[]> {
    if (!fileIds || !fileIds.length || !toolResourceSet?.size) {
      return [];
    }

    try {
      const orConditions: FilterQuery<IMongoFile>[] = [];

      if (toolResourceSet.has(EToolResources.context)) {
        orConditions.push({ text: { $exists: true, $ne: null }, context: FileContext.agents });
      }
      if (toolResourceSet.has(EToolResources.file_search)) {
        orConditions.push({ embedded: true });
      }

      // If no conditions to match, return empty
      if (orConditions.length === 0) {
        return [];
      }

      const filter = withOwnerScope(
        {
          file_id: { $in: fileIds },
          context: { $ne: FileContext.execute_code },
          $or: orConditions,
        },
        ownerScope,
      );

      const selectFields: SelectProjection = { text: 0 };
      const sortOptions = { updatedAt: -1 as SortOrder };

      const results = await getFiles(filter, sortOptions, selectFields);
      return results ?? [];
    } catch (error) {
      logger.error('[getToolFilesByIds] Error retrieving tool files:', error);
      throw new Error('Error retrieving tool files');
    }
  }

  /**
   * Retrieves files generated by code execution for a given conversation.
   * These files are stored locally with `metadata.codeEnvRef` for code env re-upload.
   *
   * Filtered by `file_id IN threadFileIds` (the file_ids referenced from
   * messages in the current thread's `files` arrays) rather than by
   * `messageId IN threadMessageIds` (the File record's own creator id).
   * This mirrors `getUserCodeFiles` and fixes the branched-conversation
   * case where:
   *   1. Sibling A creates `output.csv` via processCodeOutput → File
   *      record persists with `messageId = A`.
   *   2. Sibling N (a regeneration of A's parent) recreates `output.csv`.
   *      `claimCodeFile` is keyed by `(filename, conversationId, context)`
   *      and finds A's record; `processCodeOutput` deliberately preserves
   *      A's `messageId` to keep file→original-creator provenance intact.
   *   3. Turn N+1's user message has `parentMessageId = N` (sibling of A).
   *      `getThreadData` walks back from N: thread = [N, root]. A is
   *      NOT in that thread, so a `messageId IN [N, root]` filter
   *      excludes the file.
   * The message at N references the file via `messages.files = [...]`,
   * so `threadFileIds` (collected from that array during thread walk)
   * DOES include the file_id. Filtering by that key reaches the right
   * file regardless of which sibling first created it.
   *
   * @param conversationId - The conversation ID to search for
   * @param threadFileIds - Array of file_ids referenced by messages in
   *   the current thread (collected from `messages.files[].file_id`).
   *   While technically optional, this function returns empty if not
   *   provided — code-generated files must be filtered by thread to
   *   avoid pulling in files from other branches of a conversation.
   * @returns Files generated by code execution in the conversation,
   *   filtered to those referenced by the current thread.
   */
  async function getCodeGeneratedFiles(
    conversationId: string,
    threadFileIds?: string[],
    ownerScope?: FileOwnerScope,
  ): Promise<IMongoFile[]> {
    if (!conversationId) {
      return [];
    }

    /**
     * Return early if threadFileIds not provided — same rationale as
     * the messageIds-based predecessor: code-generated files must be
     * filtered by thread to ensure we only return files relevant to
     * the current conversation branch, not orphaned files from other
     * branches or deleted messages.
     */
    if (!threadFileIds || threadFileIds.length === 0) {
      return [];
    }

    try {
      const filter = withOwnerScope(
        {
          conversationId,
          context: FileContext.execute_code,
          file_id: { $in: threadFileIds },
          $or: [
            { 'metadata.codeEnvRef': { $exists: true } },
            { 'metadata.codeEnvRefs': { $exists: true } },
            { 'metadata.codeDestination': true },
          ],
        },
        ownerScope,
      );

      const selectFields: SelectProjection = { text: 0 };
      const sortOptions = { createdAt: 1 as SortOrder };

      const results = await getFiles(filter, sortOptions, selectFields);
      return results ?? [];
    } catch (error) {
      logger.error('[getCodeGeneratedFiles] Error retrieving code generated files:', error);
      return [];
    }
  }

  /**
   * Retrieves conversation attachments that were accepted but never provisioned, so a
   * later turn can still queue them.
   *
   * Lazy provisioning defers the upload to the sandbox or vector store until a tool
   * actually runs. The other hydration queries only return files that already carry
   * the result of that work: `getToolFilesByIds` matches `embedded: true` for
   * file_search, and `getUserCodeFiles` requires an existing `codeEnvRef`. A file
   * whose tool was never called on its upload turn therefore satisfies neither and
   * disappears. This fills exactly that gap: attachments with no code reference and
   * no embedding.
   *
   * Kept separate from delivery hydration deliberately. These records are candidates
   * for provisioning only; feeding them back into the model's attachments would
   * re-send earlier uploads on every subsequent turn.
   *
   * Selection is per requested resource, not per file. A file embedded for an earlier
   * file_search agent still has no code reference, so a later execute_code agent must
   * see it; requiring both results to be absent would hide exactly that case.
   *
   * @param fileIds - Candidate file IDs from the current thread
   * @param ownerScope - Authenticated owner scope
   * @param resources - Which provisioning results the current agent needs
   * @returns Attachments still awaiting a result the current agent needs
   */
  async function getDeferredProvisionFiles(
    fileIds: string[],
    ownerScope: FileOwnerScope,
    resources: {
      code?: boolean;
      search?: boolean;
      codeRouteKey?: string;
      searchNamespaces?: string[];
      /** Set when no other query hydrates already-provisioned files this turn. */
      hydrateProvisioned?: boolean;
    } = {
      code: true,
      search: true,
    },
  ): Promise<IMongoFile[]> {
    if (!fileIds || fileIds.length === 0) {
      return [];
    }

    const missingConditions: FilterQuery<IMongoFile>[] = [];
    /* When no other query hydrates this turn's files, every eligible record has to be
     * loaded, not only the unprovisioned ones: priming adds the provisioned ones to the
     * tool resources, and the code probe screens a default-route session for liveness.
     * Left behind, a file the previous turn provisioned successfully is the one that
     * goes missing, while one that failed is retried. This holds for search as much as
     * for code: an attachment embedded on an earlier turn is hydrated by nothing else,
     * so the next search runs with no reference to it. */
    const hydrateEverything =
      resources.hydrateProvisioned === true &&
      (resources.code === true || resources.search === true);
    if (resources.code && !hydrateEverything) {
      /* A reference for another deployment does not make the file usable here, and with
       * resendFiles off nothing downstream re-reads the record to notice, so eligibility
       * is judged against the route this turn will actually execute on. The legacy
       * pointer counts only when it resolves to that same route, mirroring how
       * mergeCodeEnvRef keys it: executionRouteKey, then executionProfile, then default. */
      const routeKey = resources.codeRouteKey ?? 'default';
      assertValidCodeEnvironmentRouteKey(routeKey);
      const usableForRoute: FilterQuery<IMongoFile>[] = [
        { [`metadata.codeEnvRefs.${routeKey}`]: { $exists: true } },
        { 'metadata.codeEnvRef.executionRouteKey': routeKey },
        {
          'metadata.codeEnvRef': { $exists: true },
          'metadata.codeEnvRef.executionRouteKey': { $exists: false },
          'metadata.codeEnvRef.executionProfile': routeKey,
        },
      ];
      if (routeKey === 'default') {
        usableForRoute.push({
          'metadata.codeEnvRef': { $exists: true },
          'metadata.codeEnvRef.executionRouteKey': { $exists: false },
          'metadata.codeEnvRef.executionProfile': { $in: [null, 'default'] },
        });
      }
      missingConditions.push({ $nor: usableForRoute });
    }
    if (resources.search && !hydrateEverything) {
      /* The record-wide flag only says the file was embedded somewhere, so for a record
       * whose vectors live in an agent namespace it cannot answer whether the namespace
       * this turn searches has them. Membership is not known here, so a record missing
       * from any candidate namespace is loaded and judged later, where it is. */
      const namespaces = resources.searchNamespaces ?? [];
      if (namespaces.length === 0) {
        missingConditions.push({ embedded: { $ne: true } });
      } else {
        missingConditions.push({
          $or: [
            { context: { $ne: FileContext.agents }, embedded: { $ne: true } },
            ...namespaces.map((namespace) => ({
              context: FileContext.agents,
              'metadata.embeddedEntities': { $ne: namespace },
            })),
          ],
        });
      }
    }
    if (!hydrateEverything && missingConditions.length === 0) {
      return [];
    }

    try {
      const filter = withOwnerScope(
        {
          file_id: { $in: fileIds },
          context: { $ne: FileContext.execute_code },
          ...(hydrateEverything ? {} : { $or: missingConditions }),
        },
        ownerScope,
      );

      const selectFields: SelectProjection = { text: 0 };
      const sortOptions = { createdAt: 1 as SortOrder };

      const results = await getFiles(filter, sortOptions, selectFields);
      return results ?? [];
    } catch (error) {
      /* An empty list here is indistinguishable from nothing needing provisioning, so the
       * turn would build no provisioning state and let the tool run without the
       * attachment. The callback aborts on missing inputs precisely to avoid that, so a
       * read failure has to surface rather than be flattened into a benign answer. */
      logger.error('[getDeferredProvisionFiles] Error retrieving deferred files:', error);
      throw error;
    }
  }

  /**
   * Retrieves user-uploaded execute_code files (not code-generated) by their file IDs.
   * These are files with fileIdentifier metadata but context is NOT execute_code (e.g., agents or message_attachment).
   * File IDs should be collected from message.files arrays in the current thread.
   * @param fileIds - Array of file IDs to fetch (from message.files in the thread)
   * @param ownerScope - Authenticated owner scope used to constrain historical refs
   * @returns User-uploaded execute_code files
   */
  async function getUserCodeFiles(
    fileIds: string[],
    ownerScope: FileOwnerScope,
  ): Promise<IMongoFile[]> {
    if (!fileIds || fileIds.length === 0) {
      return [];
    }

    try {
      const filter = withOwnerScope(
        {
          file_id: { $in: fileIds },
          context: { $ne: FileContext.execute_code },
          $or: [
            { 'metadata.codeEnvRef': { $exists: true } },
            { 'metadata.codeEnvRefs': { $exists: true } },
            { 'metadata.codeDestination': true },
          ],
        },
        ownerScope,
      );

      const selectFields: SelectProjection = { text: 0 };
      const sortOptions = { createdAt: 1 as SortOrder };

      const results = await getFiles(filter, sortOptions, selectFields);
      return results ?? [];
    } catch (error) {
      logger.error('[getUserCodeFiles] Error retrieving user code files:', error);
      return [];
    }
  }

  /**
   * Atomically claims a file_id for a code-execution output by compound key.
   * Uses $setOnInsert so concurrent calls for the same (filename, conversationId)
   * converge on a single record instead of creating duplicates.
   */
  async function claimCodeFile(data: {
    filename: string;
    conversationId: string;
    file_id: string;
    user: string;
    tenantId?: string | null;
    /** The claimant's dispatch-order stamp, persisted on INSERT so a
     *  freshly claimed (not-yet-written) row still carries an ownership
     *  signal for the background harvest's stale-output guard. */
    sourceDispatchedAt?: number;
  }): Promise<IMongoFile> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const tenantFilter = data.tenantId ? { tenantId: data.tenantId } : { tenantId: null };
    const insertData = {
      embeddingOwnersComplete: true,
      embeddingOwnersTrackedAt: new Date(),
      file_id: data.file_id,
      user: data.user,
      ...(data.tenantId ? { tenantId: data.tenantId } : {}),
      ...(data.sourceDispatchedAt != null
        ? { metadata: { sourceDispatchedAt: data.sourceDispatchedAt } }
        : {}),
    };
    let result: IMongoFile | null;
    try {
      result = await File.findOneAndUpdate(
        {
          filename: data.filename,
          conversationId: data.conversationId,
          context: FileContext.execute_code,
          ...tenantFilter,
          ...codeFileStorageFilter(),
        },
        { $setOnInsert: insertData },
        /** `timestamps: false`: a claim is an id reservation, not a content
         *  write — bumping `updatedAt` here would make the row look freshly
         *  written to the background harvest's out-of-order guard, which
         *  compares `updatedAt` against the harvest's start time. */
        { upsert: true, new: true, timestamps: false },
      ).lean<IMongoFile>();
    } catch (error) {
      rethrowCodeFileStorageConflict(error);
    }
    if (!result) {
      throw new Error(
        `[claimCodeFile] Failed to claim file "${data.filename}" for conversation ${data.conversationId}`,
      );
    }
    return result;
  }

  /**
   * Creates a new file with a TTL of 1 hour.
   * @param data - The file data to be created, must contain file_id
   * @param disableTTL - Whether to disable the TTL
   * @returns A promise that resolves to the created file document
   */
  async function createFile(
    data: Partial<IMongoFile> | CodeFileCommitData,
    disableTTL?: boolean,
  ): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const fileData: (Partial<IMongoFile> | CodeFileCommitData) & { expiresAt?: Date } = {
      ...data,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    };

    if (disableTTL) {
      delete fileData.expiresAt;
    }

    const generatedOutput = data.context === FileContext.execute_code;
    try {
      return await File.findOneAndUpdate(
        {
          file_id: data.file_id,
          ...(generatedOutput
            ? {
                ...codeFileStorageFilter(),
                user: data.user,
                tenantId: data.tenantId ?? null,
              }
            : {}),
        },
        {
          ...fileContentUpdate(fileData),
          $setOnInsert: { embeddingOwnersComplete: true, embeddingOwnersTrackedAt: new Date() },
        },
        { new: true, upsert: true },
      ).lean<IMongoFile>();
    } catch (error) {
      if (generatedOutput) rethrowCodeFileStorageConflict(error);
      throw error;
    }
  }

  /**
   * Updates a file identified by file_id with new data and removes the TTL.
   *
   * `extraFilter` extends the by-id query with additional conditions
   * (e.g. `{ previewRevision: '<expected uuid>' }`). When provided, the
   * update is conditional — it commits only if the document still
   * matches the extra filter, returning `null` otherwise. Used by the
   * deferred-preview render to guard against an older render of the
   * same `file_id` overwriting a newer turn's record on cross-turn
   * filename reuse.
   *
   * Content timestamps advance only when the caller actually writes a
   * field. Clearing the upload TTL alone is bookkeeping: image reuse
   * calls this with nothing but the id on every turn, and consumers that
   * fingerprint content by `updatedAt` (Project resume compatibility)
   * would otherwise read a new version and reject an approved turn.
   *
   * @param data - The data to update, must contain file_id
   * @param extraFilter - Optional extra equality filter merged into the query.
   * @returns A promise that resolves to the updated file document, or
   *   null if the conditional filter excluded it (or the file was
   *   deleted).
   */
  async function updateFile(
    data: (Partial<IMongoFile> & { file_id: string }) | CodeFileCommitData,
    extraFilter?: FilterQuery<IMongoFile>,
  ): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const { file_id, ...update } = data;
    const updateOperation = {
      ...fileContentUpdate(update),
      $unset: { expiresAt: '' },
    };
    const query: FilterQuery<IMongoFile> = extraFilter ? { file_id, ...extraFilter } : { file_id };
    return File.findOneAndUpdate(query, updateOperation, {
      new: true,
      timestamps: Object.keys(update).length > 0,
    }).lean<IMongoFile>();
  }

  /** Background outputs commit only while their dispatch still owns the claimed filename. */
  async function commitCodeFile(
    data: CodeFileCommitData,
    sourceDispatchedAt?: number,
  ): Promise<boolean> {
    if (sourceDispatchedAt == null) {
      await createFile(data, true);
      return true;
    }
    const committed = await updateFile(data, {
      ...codeFileStorageFilter(),
      user: data.user,
      tenantId: data.tenantId ?? null,
      $or: [
        { 'metadata.sourceDispatchedAt': { $exists: false } },
        { 'metadata.sourceDispatchedAt': { $lte: sourceDispatchedAt } },
      ],
    });
    return committed != null;
  }

  /**
   * Records one code-environment route pointer without rewriting the rest of `metadata`.
   * Agents provisioning the same file to different deployments write concurrently, and a
   * whole-object `$set` built from each caller's pre-provisioning snapshot would drop the
   * sibling route that landed in between.
   *
   * @param data - The file, its route key, the pointer to store, and an optional legacy pointer
   * @returns A promise that resolves to the updated file document, or null when absent
   */
  async function updateFileCodeEnvRef(data: {
    file_id: string;
    routeKey: string;
    ref: CodeEnvRef;
    legacyRef?: CodeEnvRef;
  }): Promise<IMongoFile | null> {
    const { file_id, routeKey, ref, legacyRef } = data;
    /* Route keys become dotted update paths, so a key carrying `.` or a leading `$` would
     * write somewhere other than the intended entry. They come from server config, which
     * makes a malformed one a configuration error worth surfacing. */
    assertValidCodeEnvironmentRouteKey(routeKey);
    const File = mongoose.models.File as Model<IMongoFile>;
    const update: Record<string, CodeEnvRef> = {
      [`metadata.codeEnvRefs.${routeKey}`]: ref,
    };
    if (legacyRef) {
      update['metadata.codeEnvRef'] = legacyRef;
    }
    return File.findOneAndUpdate(
      { file_id },
      { $set: update, $unset: { expiresAt: '' } },
      { new: true },
    ).lean<IMongoFile>();
  }

  /** Confirms targeted routes are absent after reconciling deleted snapshots. */
  async function clearFileCodeEnvRefs(data: ClearFileCodeEnvRefsParams): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    /* Tenant middleware adds its own predicate; it must not replace the snapshot scope. */
    const query: FilterQuery<IMongoFile> = {
      file_id: data.file_id,
      user: data.userId,
      $and: [{ tenantId: data.tenantId ?? null }],
    };
    /* Compare contract fields individually: BSON object equality depends on field order. */
    const matchesRef = (path: string, ref: CodeEnvRef): FilterQuery<IMongoFile> => {
      const fields = {
        kind: ref.kind,
        id: ref.id,
        storage_session_id: ref.storage_session_id,
        file_id: ref.file_id,
        executionProfile: ref.executionProfile,
        executionRouteKey: ref.executionRouteKey,
        provisionedAt: ref.provisionedAt,
        sandboxFilename: ref.sandboxFilename,
        version: 'version' in ref ? ref.version : undefined,
      };
      const match: FilterQuery<IMongoFile> = {};
      for (const [field, value] of Object.entries(fields)) {
        match[`${path}.${field}`] =
          value === undefined ? { $exists: false } : { $eq: value, $exists: true };
      }
      return match;
    };
    const matchesByPath = new Map<string, FilterQuery<IMongoFile>[]>();
    const addMatch = (path: string, ref: CodeEnvRef): void => {
      const matches = matchesByPath.get(path) ?? [];
      matches.push(matchesRef(path, ref));
      matchesByPath.set(path, matches);
    };
    for (const { routeKey, ref } of data.refs) {
      assertValidCodeEnvironmentRouteKey(routeKey);
      addMatch(`metadata.codeEnvRefs.${routeKey}`, ref);
      if ((ref.executionRouteKey ?? ref.executionProfile ?? 'default') === routeKey) {
        addMatch('metadata.codeEnvRef', ref);
      }
    }
    const results = await Promise.allSettled(
      [...matchesByPath].map(async ([path, matches]) =>
        File.updateOne(
          { ...query, $or: matches },
          { $unset: { [path]: '' }, $set: { 'metadata.codeDestination': true } },
          { timestamps: false },
        ),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
    const stored = await File.findOne(query, {
      _id: 0,
      'metadata.codeEnvRef': 1,
      'metadata.codeEnvRefs': 1,
    }).lean<Pick<IMongoFile, 'metadata'>>();
    if (!stored) {
      return false;
    }
    const remaining = getCodeEnvRefs(stored.metadata);
    if (data.refs.length === 0) {
      return remaining.length === 0;
    }
    const routes = new Set(data.refs.map(({ routeKey }) => routeKey));
    return !remaining.some(([routeKey]) => routes.has(routeKey));
  }

  /** Clears only the embedding snapshot whose vector deletion was confirmed. */
  async function clearFileEmbeddings(data: ClearFileEmbeddingsParams): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const start =
      data.ownershipTrackingStart == null ? NaN : Date.parse(data.ownershipTrackingStart);
    const now = new Date();
    const ownership =
      Number.isFinite(start) && start <= now.getTime()
        ? [
            {
              embedded: true,
              embeddingOwnersComplete: true,
              embeddingOwnersTrackedAt: { $gte: new Date(start), $lte: now },
              'metadata.embeddedEntities': data.embeddedEntities ?? null,
            },
          ]
        : [];
    const query: FilterQuery<IMongoFile> = {
      file_id: data.file_id,
      user: data.userId,
      $and: [{ tenantId: data.tenantId ?? null }],
      updatedAt: data.updatedAt ?? { $exists: false },
      $or: [...ownership, { embedded: false, 'metadata.embeddedEntities': { $exists: false } }],
    };
    const result = await File.updateOne(
      query,
      {
        $set: { embedded: false, 'metadata.searchDestination': true },
        $unset: { 'metadata.embeddedEntities': '' },
      },
      { timestamps: false },
    );
    return result.matchedCount === 1;
  }

  /** Checks the final content/presence snapshot before removing primary storage. */
  async function isFileStorageClean(data: FileStorageCleanupParams): Promise<boolean> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const filter = fileStorageCleanupFilter(data);
    delete filter['storageOperations.deleting'];
    if ((await File.exists(filter)) != null) return true;
    if (
      !data.allowMissingFileRecord ||
      (data.source !== FileSources.openai && data.source !== FileSources.azure)
    ) {
      return false;
    }
    return (
      (await File.exists({
        file_id: data.file_id,
        user: data.userId,
        $and: [{ tenantId: data.tenantId ?? null }],
      })) == null
    );
  }

  /**
   * Records a workspace copy of a user's file and/or the digest of the stored bytes, without
   * rewriting sibling targets another turn wrote in between. A digest is kept even when the
   * copy fails, so a refused file is not hashed again every turn. The target key becomes a
   * dotted path, so only an opaque hex digest is accepted; the owner filter keeps a caller
   * from marking another user's record.
   *
   * @returns Whether a record matched.
   */
  async function recordFileWorkspaceImport({
    file_id,
    user,
    tenantId,
    copy,
    digest,
  }: WorkspaceImportRecord): Promise<boolean> {
    if (copy != null && !/^[a-f0-9]{32,64}$/.test(copy.key)) {
      throw new Error('Workspace import keys must be hex digests');
    }
    const update: Record<
      string,
      TFileWorkspaceImport | NonNullable<TFileWorkspaceImports['digest']>
    > = {};
    if (copy != null) {
      update[`metadata.workspaceImports.targets.${copy.key}`] = copy.target;
    }
    if (digest != null) {
      update['metadata.workspaceImports.digest'] = digest;
    }
    if (Object.keys(update).length === 0) {
      return false;
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      { file_id, user, tenantId: tenantId ?? null },
      { $set: update },
      /** Bookkeeping, not a content change: project resource versions include `updatedAt`. */
      { timestamps: false },
    );
    return result.matchedCount > 0;
  }

  /**
   * Records that a file has been embedded into one vector namespace, without disturbing
   * the namespaces already recorded. Agents that share a file record, as a duplicate does
   * with its source, each need their own embedding.
   *
   * @param data - The file and the entity whose namespace now holds its vectors
   * @returns A promise that resolves to the updated file document, or null when absent
   */
  async function addFileEmbeddedEntity(data: {
    file_id: string;
    entityId: string;
  }): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    return File.findOneAndUpdate(
      { file_id: data.file_id },
      {
        $set: { embedded: true },
        $addToSet: { 'metadata.embeddedEntities': data.entityId },
        $unset: { expiresAt: '' },
      },
      { new: true },
    ).lean<IMongoFile>();
  }

  /**
   * Records an agent's namespace on embedded files whose vectors the caller has confirmed are
   * in it, keeping any namespaces already recorded. Each record is matched by its owner and
   * tenant as well as its `file_id`, which is not unique on its own.
   *
   * @param data - Verified file records, and the agent whose namespace holds their vectors
   * @returns The file ids that now record the agent's namespace
   */
  async function adoptLegacySearchEmbeddings(data: {
    files: LegacySearchFileRef[];
    agentId: string;
  }): Promise<string[]> {
    if (data.files.length === 0) {
      return [];
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    /* An untenanted record is matched as untenanted: omitting the predicate would let a
     * same-id record under a tenant match instead. Each write settles on its own, so a
     * committed one is reported even when a sibling fails. */
    const settled = await Promise.allSettled(
      data.files.map((file) =>
        File.findOneAndUpdate(
          {
            file_id: file.file_id,
            user: file.user,
            tenantId: file.tenantId ?? null,
            context: FileContext.agents,
            embedded: true,
          },
          { $addToSet: { 'metadata.embeddedEntities': data.agentId } },
          { projection: { file_id: 1 } },
        ).lean<Pick<IMongoFile, 'file_id'>>(),
      ),
    );
    const adopted: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error('[adoptLegacySearchEmbeddings] Failed to record a confirmed embedding', {
          file_id: data.files[index].file_id,
          error: (result.reason as Error)?.message,
        });
      } else if (result.value) {
        adopted.push(result.value.file_id);
      }
    });
    return adopted;
  }

  /**
   * Increments the usage of a file identified by file_id.
   * @param data - The data to update, must contain file_id and the increment value for usage
   * @returns A promise that resolves to the updated file document
   */
  async function updateFileUsage(data: {
    file_id: string;
    inc?: number;
    user?: string;
    tenantId?: string | null;
  }): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const { file_id, inc = 1, user, tenantId } = data;
    const updateOperation = {
      $inc: { usage: inc },
      $unset: { expiresAt: '', temp_file_id: '' },
    };
    // Owner scoping is fail-closed: mismatches leave usage and TTL metadata unchanged.
    const query: FilterQuery<IMongoFile> = user
      ? withOwnerScope({ file_id }, { userId: user, tenantId })
      : { file_id };
    /** Usage and temporary-upload cleanup are bookkeeping, not content writes. */
    return File.findOneAndUpdate(query, updateOperation, {
      new: true,
      timestamps: false,
    }).lean<IMongoFile>();
  }

  /**
   * Removes deleted file ids from the owner's Chat Projects so a project never
   * keeps a dangling reference, bumping the revision of every project it changes.
   */
  async function detachFilesFromProjects(
    files: { file_id: string; user: { toString(): string }; tenantId?: string | null }[],
  ): Promise<void> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument> | undefined;
    if (!ChatProject || files.length === 0) {
      return;
    }
    const idsByScope = new Map<
      string,
      { user: string; tenantId: string | null; fileIds: string[] }
    >();
    for (const file of files) {
      const user = file.user.toString();
      const tenantId = file.tenantId ?? null;
      const key = JSON.stringify([user, tenantId]);
      const scope = idsByScope.get(key);
      if (scope) {
        scope.fileIds.push(file.file_id);
      } else {
        idsByScope.set(key, { user, tenantId, fileIds: [file.file_id] });
      }
    }
    try {
      await Promise.all(
        [...idsByScope.values()].map(({ user, tenantId, fileIds }) =>
          ChatProject.updateMany(
            { user, $and: [{ tenantId }], file_ids: { $in: fileIds } },
            { $pull: { file_ids: { $in: fileIds } }, $inc: { contextRevision: 1 } },
          ),
        ),
      );
    } catch (error) {
      logger.warn('[detachFilesFromProjects] Failed to detach deleted files from projects', error);
    }
  }

  /** Clears every project file reference of a user whose files were all deleted. */
  async function detachAllUserFilesFromProjects(user: string): Promise<void> {
    const ChatProject = mongoose.models.ChatProject as Model<IChatProjectDocument> | undefined;
    if (!ChatProject) {
      return;
    }
    try {
      await ChatProject.updateMany(
        { user, 'file_ids.0': { $exists: true } },
        { $set: { file_ids: [] }, $inc: { contextRevision: 1 } },
      );
    } catch (error) {
      logger.warn('[detachAllUserFilesFromProjects] Failed to detach deleted files', error);
    }
  }

  /**
   * Deletes a file identified by file_id.
   * @param file_id - The unique identifier of the file to delete
   * @returns A promise that resolves to the deleted file document or null
   */
  async function deleteFile(file_id: string): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const deleted = await File.findOneAndDelete({ file_id }).lean<IMongoFile>();
    if (deleted) {
      await detachFilesFromProjects([deleted]);
    }
    return deleted;
  }

  /**
   * Deletes a file identified by a filter.
   * @param filter - The filter criteria to apply
   * @returns A promise that resolves to the deleted file document or null
   */
  async function deleteFileByFilter(filter: FilterQuery<IMongoFile>): Promise<IMongoFile | null> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const deleted = await File.findOneAndDelete(filter).lean<IMongoFile>();
    if (deleted) {
      await detachFilesFromProjects([deleted]);
    }
    return deleted;
  }

  /**
   * Deletes multiple files identified by an array of file_ids.
   * @param file_ids - The unique identifiers of the files to delete
   * @param user - Optional user ID to filter by
   * @returns A promise that resolves to the result of the deletion operation
   */
  async function deleteFiles(
    file_ids: string[],
    user?: string,
    options?: DeleteFilesOptions,
  ): Promise<DeleteFilesResult> {
    const File = mongoose.models.File as Model<IMongoFile>;
    if (options) {
      const ids = new Set(file_ids);
      if (ids.size === 0) return { deletedCount: 0, deletedFileIds: [], failedFileIds: [] };
      const snapshots = new Map(options.files.map((file) => [file.file_id, file]));
      const scopes = [...ids].map((id) => {
        const file = snapshots.get(id);
        if (!file) throw new Error('Missing file deletion snapshot');
        return {
          file_id: id,
          userId: file.user?.toString() ?? options.userId,
          tenantId: file.tenantId,
          updatedAt: file.updatedAt,
          source: file.source,
          embedded: file.embedded,
          embeddedEntities: file.metadata?.embeddedEntities,
        };
      });
      const deleteQuery = { $or: scopes.map(fileStorageCleanupFilter) };
      const candidates = await File.find(deleteQuery)
        .select({ _id: 1, file_id: 1, user: 1, tenantId: 1 })
        .lean<Pick<IMongoFile, '_id' | 'file_id' | 'user' | 'tenantId'>[]>();
      const result = await File.deleteMany({
        ...deleteQuery,
        _id: { $in: candidates.map((file) => file._id) },
      });
      const remaining = await File.find({
        $or: scopes.map((scope) => ({
          file_id: scope.file_id,
          user: scope.userId,
          $and: [{ tenantId: scope.tenantId ?? null }],
        })),
      })
        .select({ file_id: 1 })
        .lean<Pick<IMongoFile, 'file_id'>[]>();
      const remainingIds = new Set(remaining.map((file) => file.file_id));
      const deletedFileIds: string[] = [];
      const failedFileIds: string[] = [];
      const detached = [];
      for (const scope of scopes) {
        if (remainingIds.has(scope.file_id)) {
          failedFileIds.push(scope.file_id);
        } else {
          deletedFileIds.push(scope.file_id);
          detached.push({ file_id: scope.file_id, user: scope.userId, tenantId: scope.tenantId });
        }
      }
      await detachFilesFromProjects(detached);
      return { deletedCount: result.deletedCount, deletedFileIds, failedFileIds };
    }
    if (user) {
      const result = await File.deleteMany({ user });
      await detachAllUserFilesFromProjects(user);
      return result;
    }
    const deleteQuery: FilterQuery<IMongoFile> = { file_id: { $in: file_ids } };
    const doomed = await File.find(deleteQuery)
      .select({ file_id: 1, user: 1, tenantId: 1 })
      .lean<IMongoFile[]>();
    const result = await File.deleteMany(deleteQuery);
    await detachFilesFromProjects(doomed);
    return result;
  }

  /**
   * Batch updates files with new signed URLs in MongoDB
   * @param updates - Array of updates in the format { file_id, filepath, storageKey?, storageRegion? }
   */
  async function batchUpdateFiles(
    updates: Array<{
      file_id: string;
      filepath: string;
      storageKey?: string;
      storageRegion?: string;
    }>,
  ): Promise<void> {
    if (!updates || updates.length === 0) {
      return;
    }

    const File = mongoose.models.File as Model<IMongoFile>;
    const bulkOperations = updates.map((update) => ({
      updateOne: {
        filter: { file_id: update.file_id },
        update: {
          $set: {
            filepath: update.filepath,
            ...(update.storageKey ? { storageKey: update.storageKey } : {}),
            ...(update.storageRegion ? { storageRegion: update.storageRegion } : {}),
          },
        },
      },
    }));

    const result = await tenantSafeBulkWrite(File, bulkOperations, { timestamps: false });
    logger.info(`Updated ${result.modifiedCount} files with new S3 URLs`);
  }

  /**
   * Updates usage tracking for multiple files.
   * Processes files and optional fileIds, updating their usage count in the database.
   *
   * @param files - Array of file objects to process
   * @param fileIds - Optional array of file IDs to process
   * @returns Array of updated file documents (with null results filtered out)
   */
  async function updateFilesUsage(
    files: Array<{ file_id: string }>,
    fileIds?: string[],
    options?: { user?: string; tenantId?: string | null },
  ): Promise<IMongoFile[]> {
    const promises: Promise<IMongoFile | null>[] = [];
    const seen = new Set<string>();
    // Preserve the same owner scope for every deduped ID in this batch.
    const user = options?.user;
    const tenantId = options?.tenantId;

    for (const file of files) {
      const { file_id } = file;
      if (seen.has(file_id)) {
        continue;
      }
      seen.add(file_id);
      promises.push(updateFileUsage({ file_id, user, tenantId }));
    }

    if (!fileIds) {
      const results = await Promise.all(promises);
      return results.filter((result): result is IMongoFile => result != null);
    }

    for (const file_id of fileIds) {
      if (seen.has(file_id)) {
        continue;
      }
      seen.add(file_id);
      promises.push(updateFileUsage({ file_id, user, tenantId }));
    }

    const results = await Promise.all(promises);
    return results.filter((result): result is IMongoFile => result != null);
  }

  /**
   * Widens the upload-window TTL of owned, still-temporary files to
   * `min(now + renewMs, createdAt + maxLifetimeMs)`.
   *
   * A renewable hold, not a release: unlike `updateFileUsage` this never
   * unsets `expiresAt`, so a file that is held but never actually sent is
   * still reaped once the hold lapses. Candidates are read first, then each
   * doc gets a guarded write — no aggregation-pipeline update, which Amazon
   * DocumentDB rejects. Four properties hold by construction, which is what
   * makes the write safe to drive from a client-supplied id list:
   * - capping the renewal at `createdAt + maxLifetimeMs` anchors it to an
   *   immutable ceiling, so repeated calls converge on a fixed deadline
   *   instead of walking a file's lifetime forward a window at a time;
   * - renewing from `now` up to that ceiling lets a queue that is still
   *   draining keep its attachments alive across successive runs, while an
   *   abandoned queue lapses a single `renewMs` after its last touch rather
   *   than surviving to the ceiling;
   * - the `expiresAt: { $lt: next }` write guard means a hold only ever
   *   widens, even against renewals landing between the read and the write;
   * - `expiresAt: { $exists: true }` in the read filter and the write guard
   *   means a file whose TTL was already cleared by a real send stays
   *   permanent. Re-adding `expiresAt` there would schedule a live file for
   *   deletion.
   *
   * `createdAt` is required rather than defaulted: without the anchor there
   * is no ceiling to enforce, so such a file is skipped instead of held.
   *
   * The owner scope is required, not optional: an unscoped call would hold
   * every user's matching file. A missing owner is a no-op, not a wide
   * update.
   *
   * @param fileIds - File IDs to hold
   * @param hold - `renewMs` granted from now, capped at `maxLifetimeMs` from upload
   * @param owner - Owner scope; mismatches leave the TTL unchanged
   * @returns Number of files whose hold was widened
   */
  async function extendFilesTTL(
    fileIds: string[],
    hold: { renewMs: number; maxLifetimeMs: number },
    owner: { user: string; tenantId?: string | null },
  ): Promise<number> {
    const renewMs = hold?.renewMs;
    const maxLifetimeMs = hold?.maxLifetimeMs;
    if (fileIds.length === 0 || !owner?.user || !(renewMs > 0) || !(maxLifetimeMs > 0)) {
      return 0;
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    const filter = withOwnerScope(
      {
        file_id: { $in: [...new Set(fileIds)] },
        expiresAt: { $exists: true },
        createdAt: { $exists: true },
      },
      { userId: owner.user, tenantId: owner.tenantId },
    );
    const renewUntil = Date.now() + renewMs;
    const candidates = await File.find(filter)
      .select({ _id: 1, expiresAt: 1, createdAt: 1 })
      .lean<Pick<IMongoFile, '_id' | 'expiresAt' | 'createdAt'>[]>();
    const holdOps = candidates.flatMap((file) => {
      if (!file.createdAt || !file.expiresAt) {
        return [];
      }
      const next = new Date(Math.min(renewUntil, file.createdAt.getTime() + maxLifetimeMs));
      if (file.expiresAt.getTime() >= next.getTime()) {
        return [];
      }
      return [
        {
          updateOne: {
            filter: { _id: file._id, expiresAt: { $exists: true, $lt: next } },
            update: { $set: { expiresAt: next } },
          },
        },
      ];
    });
    if (holdOps.length === 0) {
      return 0;
    }
    /** `timestamps: false`: a hold is TTL bookkeeping, not a content write.
     *  Bumping `updatedAt` would also make every re-touch count as a
     *  modification, hiding whether the deadline actually moved. */
    const result = await tenantSafeBulkWrite(File, holdOps, { timestamps: false });
    return result.modifiedCount ?? 0;
  }

  /**
   * Mark stale `status: 'pending'` file records as `'failed'` with
   * `previewError: 'orphaned'`. Recovers from the one case the
   * in-process deferred-preview render can't handle on its own: a
   * backend restart mid-render loses the in-memory promise, leaving
   * the record stuck pending forever.
   *
   * Cheap to run on boot — the `status` field is indexed and the typical
   * cutoff (5 min) bounds the candidate set to whatever was in flight at
   * the prior shutdown. The 60s render timeout means anything older
   * than a few minutes that's still pending is definitively orphaned.
   *
   * @param maxAgeMs - Cutoff in milliseconds; records whose `updatedAt`
   *   is older than `now - maxAgeMs` are marked failed. Defaults to 5
   *   minutes (well above the 60s render ceiling).
   * @returns Number of records updated.
   */
  async function sweepOrphanedPreviews(maxAgeMs: number = 5 * 60 * 1000): Promise<number> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const cutoff = new Date(Date.now() - maxAgeMs);
    const result = await File.updateMany(
      { status: 'pending', updatedAt: { $lt: cutoff } },
      { $set: { status: 'failed', previewError: 'orphaned' } },
    );
    if (result.modifiedCount > 0) {
      logger.info(
        `[sweepOrphanedPreviews] Marked ${result.modifiedCount} stale 'pending' files as 'failed' (cutoff: ${cutoff.toISOString()})`,
      );
    }
    return result.modifiedCount ?? 0;
  }

  return {
    getRunFileCandidates,
    claimRunArtifactFile,
    publishRunArtifactFile,
    findRunArtifactFile,
    listRunArtifacts,
    findFileById,
    getFiles,
    getProjectFiles,
    getAvailableProjectFiles,
    getExpiredFiles,
    incrementFileDeletionAttempts,
    deferExpiredFile,
    getToolFilesByIds,
    getCodeGeneratedFiles,
    getUserCodeFiles,
    getDeferredProvisionFiles,
    claimCodeFile,
    commitCodeFile,
    createFile,
    updateFile,
    updateFileCodeEnvRef,
    clearFileCodeEnvRefs,
    addFileEmbeddedEntity,
    recordFileWorkspaceImport,
    clearFileEmbeddings,
    isFileStorageClean,
    adoptLegacySearchEmbeddings,
    updateFileUsage,
    deleteFile,
    deleteFiles,
    deleteFileByFilter,
    batchUpdateFiles,
    updateFilesUsage,
    extendFilesTTL,
    sweepOrphanedPreviews,
  };
}

export type FileMethods = ReturnType<typeof createFileMethods>;
