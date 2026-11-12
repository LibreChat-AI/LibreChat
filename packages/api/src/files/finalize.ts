import type {
  DeleteFilesOptions,
  DeleteFilesResult,
  FileDeletionSnapshot,
} from '@librechat/data-schemas';
import type { FileDeletionOutcome } from './deletion';
import { getSafeErrorMetadata } from '../utils/errors';

/** Finalizes only confirmed metadata deletions, preserving failed snapshots for retry. */
export async function finalizeFileDeletion(
  {
    deletedFileIds,
    failedFileIds,
    files,
    userId,
  }: {
    deletedFileIds: string[];
    failedFileIds: string[];
    files: FileDeletionSnapshot[];
    userId: string;
  },
  {
    deleteFiles,
    removeAgentResourceFilesFromAllAgents,
    logger,
  }: {
    deleteFiles: (
      ids: string[],
      user?: string,
      options?: DeleteFilesOptions,
    ) => Promise<DeleteFilesResult>;
    removeAgentResourceFilesFromAllAgents: (params: { file_ids: string[] }) => Promise<unknown>;
    logger: { error: (message: string, metadata: unknown) => void };
  },
): Promise<Required<FileDeletionOutcome>> {
  const failed = new Set(failedFileIds);
  const pending = [...new Set(deletedFileIds)].filter((id) => !failed.has(id));
  if (pending.length === 0) return { deletedFileIds: [], failedFileIds: [...failed] };

  let confirmed: string[];
  try {
    const result = await deleteFiles(pending, undefined, { files, userId });
    if (!Array.isArray(result?.deletedFileIds) || !Array.isArray(result?.failedFileIds)) {
      throw new Error('File metadata deletion was not confirmed');
    }
    const requested = new Set(pending);
    const deleted = new Set(result.deletedFileIds);
    for (const id of result.failedFileIds) {
      if (!requested.has(id) || deleted.has(id)) throw new Error('Invalid file deletion outcome');
      failed.add(id);
    }
    for (const id of deleted) {
      if (!requested.has(id)) throw new Error('Invalid file deletion outcome');
    }
    confirmed = pending.filter((id) => deleted.has(id));
    for (const id of pending) {
      if (!deleted.has(id)) failed.add(id);
    }
  } catch (error) {
    logger.error(
      'Error deleting file metadata after storage deletion',
      getSafeErrorMetadata(error),
    );
    throw error;
  }

  if (confirmed.length > 0) {
    try {
      await removeAgentResourceFilesFromAllAgents({ file_ids: confirmed });
    } catch (error) {
      logger.error('Error cleaning up orphaned agent file references', getSafeErrorMetadata(error));
    }
  }
  return { deletedFileIds: confirmed, failedFileIds: [...failed] };
}
