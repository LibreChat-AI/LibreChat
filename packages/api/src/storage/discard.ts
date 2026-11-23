import { logger } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '../utils/errors';

/** Where a strategy stored an object: `${basePath}/${userId}/${fileName}`. */
export interface StoredObjectRef {
  userId: string;
  fileName: string;
  basePath?: string;
}

/**
 * Fails a save whose stored object could not be resolved to a URL. The object is removed first
 * (best effort) so no unreferenced file is left behind; strategies without a path-based delete
 * pass no `remove`. A failed delete is logged and the missing-URL error is what surfaces.
 */
export async function failUnresolvedFile({
  source,
  remove,
  ...target
}: StoredObjectRef & {
  source: string;
  remove?: (target: StoredObjectRef) => Promise<void>;
}): Promise<never> {
  if (remove) {
    try {
      await remove(target);
    } catch (error) {
      logger.warn('[failUnresolvedFile] Could not remove the unresolved stored file', {
        ...getSafeErrorMetadata(error),
      });
    }
  }

  throw new Error(`Strategy "${source}" did not return a file URL for "${target.fileName}"`);
}
