import { FileSources, getCodeEnvRefs } from 'librechat-data-provider';
import type { ClearFileEmbeddingsParams, FileStorageCleanupParams } from '@librechat/data-schemas';
import type { CodeEnvReferenceSet } from 'librechat-data-provider';
import type { FileStorageDeletionObserver } from './dispatch';
import type { FileDeleteStorage } from './operations';
import { withFileDeletion, isDefinitiveFileStorageFailure } from './operations';
import { getSafeErrorMetadata } from '../utils/errors';

const MISSING_STORAGE_CODES = new Set<string | number>([
  404,
  '404',
  'ENOENT',
  'NoSuchKey',
  'NotFound',
  'ResourceNotFound',
]);

type StorageFile = {
  file_id?: string;
  user?: { toString(): string };
  tenantId?: string;
  updatedAt?: Date | string;
  embedded?: boolean;
  metadata?: Record<string, unknown>;
};

type DeleteStorageFile<TRequest, TFile, TClient = never> = (
  req: TRequest,
  file: TFile,
  client?: TClient,
  onDelete?: FileStorageDeletionObserver,
) => Promise<unknown>;

export function isMissingStorageError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') {
    return false;
  }
  const response = 'response' in error ? error.response : undefined;
  const codes = [
    'code' in error ? error.code : undefined,
    'status' in error ? error.status : undefined,
    'statusCode' in error ? error.statusCode : undefined,
    response != null && typeof response === 'object' && 'status' in response
      ? response.status
      : undefined,
  ];
  if (
    codes.some(
      (code) =>
        (typeof code === 'string' || typeof code === 'number') && MISSING_STORAGE_CODES.has(code),
    )
  ) {
    return true;
  }
  return (
    'message' in error &&
    typeof error.message === 'string' &&
    /(?:file|object|blob|key|resource) (?:not found|does not exist)|no such (?:file|key)/i.test(
      error.message,
    )
  );
}

function readEmbeddedEntities(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((entity): entity is string => typeof entity === 'string')
  ) {
    throw new Error('Invalid file embedding snapshot');
  }
  return value;
}

/** Keep the primary readable until every secondary has settled successfully or is already absent. */
export function createDeleteFileWithSecondaryStorage<
  TRequest extends {
    user: { id: string; tenantId?: string };
    config?: {
      fileConfig?: { retainedFileCleanup?: boolean; vectorOwnershipTrackingStart?: string };
    };
    body?: { assistant_id?: string };
  },
  TFile extends StorageFile,
  TClient,
>({
  source,
  deleteFile,
  getDeleteFile,
  clearFileEmbeddings,
  isFileStorageClean,
  fileStorage,
  logger,
}: {
  source: string;
  deleteFile: DeleteStorageFile<TRequest, TFile, TClient>;
  getDeleteFile: (source: string) => DeleteStorageFile<TRequest, TFile>;
  clearFileEmbeddings: (data: ClearFileEmbeddingsParams) => Promise<boolean>;
  isFileStorageClean: (data: FileStorageCleanupParams) => Promise<boolean>;
  fileStorage: FileDeleteStorage;
  logger: { warn: (message: string, error: unknown) => void };
}): DeleteStorageFile<TRequest, TFile, TClient> {
  return async (req, file, client) => {
    const hasCodeEnvRef =
      getCodeEnvRefs(file.metadata as CodeEnvReferenceSet | undefined).length > 0;
    const providerOnly =
      (source === FileSources.openai || source === FileSources.azure) &&
      req.body?.assistant_id != null &&
      file.user == null &&
      file.updatedAt == null &&
      file.embedded !== true &&
      !hasCodeEnvRef;
    if (
      (file.embedded === true || hasCodeEnvRef) &&
      req.config?.fileConfig?.retainedFileCleanup !== true
    ) {
      throw new Error('Retained file cleanup requires upgraded readers');
    }
    const deleteStorage = async (
      primaryDeleted: (confirmed?: boolean) => void,
      onOutcomeUnknown: () => void,
    ): Promise<void> => {
      const secondaries: Array<DeleteStorageFile<TRequest, TFile>> = [];
      let vectorIndex = -1;
      if (file.embedded === true && source !== FileSources.vectordb) {
        vectorIndex = secondaries.length;
        secondaries.push(getDeleteFile(FileSources.vectordb));
      }
      if (hasCodeEnvRef && source !== FileSources.execute_code) {
        secondaries.push(getDeleteFile(FileSources.execute_code));
      }

      let primaryStarted = false;
      const remove = async (
        operation: () => Promise<unknown>,
        primary = false,
      ): Promise<unknown> => {
        try {
          return await operation();
        } catch (error) {
          if (!isMissingStorageError(error)) {
            if ((!primary || primaryStarted) && !isDefinitiveFileStorageFailure(error)) {
              onOutcomeUnknown();
            }
            throw error;
          }
          logger.warn(
            'File storage was already missing during delete',
            getSafeErrorMetadata(error),
          );
          return { deleted: true };
        }
      };

      const reconcileVectors = async (): Promise<void> => {
        try {
          if (
            !file.file_id ||
            !(await clearFileEmbeddings({
              file_id: file.file_id,
              userId: file.user?.toString() ?? req.user.id,
              tenantId: file.tenantId,
              updatedAt: file.updatedAt,
              embeddedEntities: readEmbeddedEntities(file.metadata?.embeddedEntities),
              ownershipTrackingStart: req.config?.fileConfig?.vectorOwnershipTrackingStart,
            }))
          ) {
            throw new Error('Embedding snapshot changed');
          }
        } catch (error) {
          throw new Error('File embedding reconciliation failed', { cause: error });
        }
        file.embedded = false;
        file.metadata = { ...file.metadata, searchDestination: true };
        delete file.metadata.embeddedEntities;
      };
      const results = await Promise.allSettled(
        secondaries.map((deleteSecondary) => remove(() => deleteSecondary(req, file))),
      );
      const vectors = results[vectorIndex];
      if (vectorIndex >= 0 && vectors?.status === 'fulfilled') {
        if (
          vectors.value == null ||
          typeof vectors.value !== 'object' ||
          !('deleted' in vectors.value) ||
          vectors.value.deleted !== true
        ) {
          throw new Error('Vector deletion was not confirmed');
        }
        await reconcileVectors();
      }
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
      const code = results[vectorIndex >= 0 ? 1 : 0];
      if (
        hasCodeEnvRef &&
        source !== FileSources.execute_code &&
        code?.status === 'fulfilled' &&
        (code.value == null ||
          typeof code.value !== 'object' ||
          !('deleted' in code.value) ||
          code.value.deleted !== true)
      ) {
        throw new Error('Code storage deletion was not confirmed');
      }
      const confirmCleanup = async (): Promise<void> => {
        if (!file.file_id) return;
        try {
          if (
            !(await isFileStorageClean({
              file_id: file.file_id,
              userId: file.user?.toString() ?? req.user.id,
              tenantId: providerOnly ? req.user.tenantId : file.tenantId,
              updatedAt: file.updatedAt,
              ...(providerOnly ? { allowMissingFileRecord: true } : {}),
              source,
              embedded: file.embedded,
              embeddedEntities: readEmbeddedEntities(file.metadata?.embeddedEntities),
            }))
          ) {
            throw new Error('File storage snapshot changed');
          }
        } catch (error) {
          throw new Error('File storage cleanup was not confirmed', { cause: error });
        }
      };
      if (source !== FileSources.execute_code) await confirmCleanup();
      const onDelete: FileStorageDeletionObserver = (state) => {
        if (state === undefined) {
          primaryStarted = true;
          primaryDeleted(false);
        } else if (state === 'confirmed') {
          primaryDeleted(true);
        }
      };
      const marked =
        source === FileSources.s3 ||
        source === FileSources.cloudfront ||
        source === FileSources.azure_blob;
      if (!marked) onDelete();
      const primary = await remove(
        () => (marked ? deleteFile(req, file, client, onDelete) : deleteFile(req, file, client)),
        true,
      );
      if (
        ((source === FileSources.vectordb && file.embedded === true) ||
          (source === FileSources.execute_code && hasCodeEnvRef)) &&
        (primary == null ||
          typeof primary !== 'object' ||
          !('deleted' in primary) ||
          primary.deleted !== true)
      ) {
        throw new Error('Primary secondary-store deletion was not confirmed');
      }
      primaryDeleted(true);
      if (source === FileSources.vectordb && file.embedded === true) await reconcileVectors();
      if (source === FileSources.execute_code) await confirmCleanup();
    };
    if (!file.file_id || providerOnly)
      return deleteStorage(
        () => undefined,
        () => undefined,
      );
    return withFileDeletion({
      file: { ...file, file_id: file.file_id },
      userId: req.user.id,
      storage: fileStorage,
      operation: deleteStorage,
    });
  };
}
