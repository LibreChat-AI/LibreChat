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

const CONNECTION_SYSCALLS = new Set(['connect', 'getaddrinfo']);

/**
 * Whether a single-attempt HTTP request failed before a connection existed, so the server
 * never saw it. Name resolution and `connect` fail ahead of any request byte; an address
 * family fallback reports one such failure per address tried.
 *
 * Only meaningful for a transport that does not retry: a client that resends after a timeout
 * can end on a refused connection although an earlier attempt was delivered.
 */
export function isUndispatchedRequestError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    if ('response' in current && current.response != null) return false;
    if ('errors' in current && Array.isArray(current.errors) && current.errors.length > 0) {
      return current.errors.every(isUndispatchedRequestError);
    }
    if ('syscall' in current && typeof current.syscall === 'string') {
      return CONNECTION_SYSCALLS.has(current.syscall);
    }
    if (!('cause' in current)) return false;
    current = current.cause;
  }
  return false;
}

/**
 * Dispatches one Code API upload request on behalf of every file it carries. A refusal, or a
 * request that never reached the service, leaves nothing stored for any of them.
 */
export async function dispatchCodeApiUpload<T>(
  observers: ReadonlyArray<FileStorageUploadObserver | undefined>,
  operation: () => Promise<T>,
): Promise<T> {
  for (const onStart of observers) onStart?.();
  try {
    return await operation();
  } catch (error) {
    if (isDefinitiveFileStorageFailure(error) || isUndispatchedRequestError(error)) {
      for (const onStart of observers) onStart?.('rejected');
    }
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
