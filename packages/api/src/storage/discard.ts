import { logger } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '../utils/errors';

/** Where a strategy stored an object: `${basePath}/${userId}/${fileName}`. */
export interface StoredObjectRef {
  userId: string;
  fileName: string;
  basePath?: string;
}

/**
 * Removes an object a strategy stored but could not resolve to a URL, so no file record will
 * reference it. Strategies without a path-based delete pass no `remove`. Never throws, so the
 * caller's original error is what surfaces.
 */
export async function discardUnresolvedFile({
  remove,
  ...target
}: StoredObjectRef & { remove?: (target: StoredObjectRef) => Promise<void> }): Promise<void> {
  if (!remove) {
    return;
  }

  try {
    await remove(target);
  } catch (error) {
    logger.warn('[discardUnresolvedFile] Could not remove the unresolved stored file', {
      ...getSafeErrorMetadata(error),
    });
  }
}
