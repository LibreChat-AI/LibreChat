import { FileSources } from 'librechat-data-provider';

import { getSafeErrorMetadata } from '~/utils/errors';

export type StoredUploadRef = {
  file_id: string;
  filepath: string;
  source: string;
  storageKey?: string;
  storageRegion?: string;
  /** Id of the file record that points at the object, when it differs from `file_id`. */
  recordId?: string;
  /** Owner of the stored object; defaults to the requesting user. */
  user?: string;
  tenantId?: string;
  /** Whether a vector copy exists; the delete strategies remove it only when this is set. */
  embedded?: boolean;
  embeddingOwnersComplete?: boolean;
  unrecordedUpload?: true;
  /** Secondary-copy references, such as a code environment ref, that delete strategies read. */
  metadata?: Record<string, unknown>;
};

export type StoredUploadCleanup = {
  stored: StoredUploadRef;
  /** Looks up the strategy's delete function; called only after a failure. */
  resolveDeleteFile: () => ((req: never, file: StoredUploadRef) => Promise<unknown>) | undefined;
  /** Settles whether a file record exists, since a rejected write may have committed. */
  recordExists: (stored: StoredUploadRef) => Promise<boolean>;
  req: { user?: { id?: string; tenantId?: string } };
  /** Set when `next` calls its `beginWrite` argument just before the record write; a failure
   * earlier than that cannot have committed a record, so the lookup is skipped. */
  trackWrite?: boolean;
  logger: { error: (message: string, meta?: unknown) => void };
};

/** A rejected write may have committed, so cleanup only removes an object no record points at. */
export const createRecordExists =
  (findFileById: (id: string) => Promise<unknown>) =>
  async ({ file_id, recordId }: StoredUploadRef): Promise<boolean> =>
    (await findFileById(recordId ?? file_id)) != null;

/**
 * Runs the steps that follow a storage upload and removes the stored object when one fails,
 * since no file record exists yet for retention, expiry or erasure to find it through.
 * The original failure is rethrown; a failed cleanup is logged and never replaces it.
 */
export async function withStoredUploadCleanup<T>(
  { stored, resolveDeleteFile, recordExists, req, logger, trackWrite }: StoredUploadCleanup,
  next: (beginWrite: () => void) => Promise<T>,
): Promise<T> {
  let writeBegun = trackWrite !== true;
  try {
    return await next(() => {
      writeBegun = true;
    });
  } catch (error) {
    try {
      /* A rejected write can still have committed; deleting then would strand the record. */
      if (!writeBegun || !(await recordExists(stored))) {
        /* Storage strategies validate ownership and tenant against the object key. */
        const ref: StoredUploadRef = {
          user: req.user?.id,
          tenantId: req.user?.tenantId,
          ...stored,
          // This rollback describes only the current upload, not a legacy file record.
          embeddingOwnersComplete: true,
          unrecordedUpload: true,
        };
        await resolveDeleteFile()?.(req as never, ref);
      }
    } catch (cleanupError) {
      logger.error(
        '[withStoredUploadCleanup] Failed to delete stored upload',
        getSafeErrorMetadata(cleanupError),
      );
    }
    throw error;
  }
}

export type StoredUploadTarget = { source: string; stored: StoredUploadRef };

/**
 * Picks the object an upload failure should remove. Assistants storage lives with the provider
 * and is released through its own file lifecycle, so only an object this process stored itself
 * (a locally stored upload, or the image converted for an Assistants upload) is returned.
 */
export function resolveStoredUploadTarget({
  isAssistantUpload,
  stored,
  convertedImage,
  storageMetadata,
}: {
  isAssistantUpload: boolean;
  stored: StoredUploadRef;
  convertedImage?: StoredUploadRef;
  storageMetadata?: Partial<StoredUploadRef>;
}): StoredUploadTarget | undefined {
  if (!isAssistantUpload) {
    return { source: stored.source, stored: { ...stored, ...storageMetadata } };
  }
  if (convertedImage != null) {
    return {
      source: convertedImage.source,
      stored: { ...convertedImage, ...storageMetadata, recordId: stored.file_id },
    };
  }
  return undefined;
}

type DeleteStoredFile = (req: never, file: StoredUploadRef) => Promise<unknown>;

/**
 * Builds the delete for an upload that has no file record yet. A record-driven delete retries
 * later, but here nothing does, so the primary object and each secondary copy it names (the
 * vector document, the code environment file) are attempted independently and the first
 * failure is rethrown once all have been tried.
 */
export function createStoredUploadDelete({
  source,
  getDeleteFile,
}: {
  source: string;
  getDeleteFile: (source: string) => DeleteStoredFile | undefined;
}): DeleteStoredFile {
  return async (req, file) => {
    const sources = [source];
    if (file.embedded === true && source !== FileSources.vectordb) {
      sources.push(FileSources.vectordb);
    }
    const hasCodeEnvRef = file.metadata?.codeEnvRef != null || file.metadata?.codeEnvRefs != null;
    if (hasCodeEnvRef && source !== FileSources.execute_code) {
      sources.push(FileSources.execute_code);
    }
    const results = await Promise.allSettled(
      sources.map(async (destination) => {
        // No record exists to retry this rollback. Attempt each store independently;
        // the vector task owns erasure, not the primary strategy's inline RAG cleanup.
        const ref =
          destination === source && source !== FileSources.vectordb && file.embedded === true
            ? { ...file, embedded: false }
            : file;
        const result = await getDeleteFile(destination)?.(req, ref);
        if (
          destination === FileSources.vectordb &&
          file.embedded === true &&
          (result == null ||
            typeof result !== 'object' ||
            !('deleted' in result) ||
            result.deleted !== true)
        ) {
          throw new Error('Vector deletion was not confirmed');
        }
        return result;
      }),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed != null) {
      throw (failed as PromiseRejectedResult).reason;
    }
  };
}
