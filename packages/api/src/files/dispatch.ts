import type { FileStorageUploadObserver } from './operations';
import { isDefinitiveFileStorageFailure } from './operations';

/** Definitive rejection closes this attempt before an outer retry can wait or cancel. */
export async function dispatchFileStorageOperation<T>(
  onStart: FileStorageUploadObserver | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  onStart?.();
  try {
    return await operation();
  } catch (error) {
    if (isDefinitiveFileStorageFailure(error)) onStart?.('rejected');
    throw error;
  }
}

export type FileStorageDeletionObserver = (outcome?: 'confirmed' | 'rejected') => void;

/** Mark only the mutation, after provider preflight has completed. */
export async function dispatchFileDeletion<T>(
  onDelete: FileStorageDeletionObserver | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  onDelete?.();
  try {
    const result = await operation();
    onDelete?.('confirmed');
    return result;
  } catch (error) {
    if (isDefinitiveFileStorageFailure(error)) onDelete?.('rejected');
    throw error;
  }
}
