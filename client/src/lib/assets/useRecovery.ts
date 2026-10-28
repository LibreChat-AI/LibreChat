import { useEffect, useState } from 'react';
import {
  isChunkLoadError,
  requestStaleAssetRecovery,
  isStaleAssetRecoveryPending,
} from './recovery';

/**
 * For an error caught by a boundary, decides whether to show the "updating" state: a chunk
 * failure from a stale build (or any error while a recovery reload is already underway) asks the
 * page-level recovery to reload. When its loop guard declines, this returns `false` so the
 * boundary renders its normal error UI with a manual reload instead of looping.
 */
export default function useStaleAssetRecovery(error: unknown): boolean {
  const eligible = isChunkLoadError(error) || isStaleAssetRecoveryPending();
  const [declinedError, setDeclinedError] = useState<unknown>(undefined);

  useEffect(() => {
    if (!eligible) {
      return;
    }
    if (!requestStaleAssetRecovery(error)) {
      setDeclinedError(error);
    }
  }, [eligible, error]);

  return eligible && declinedError !== error;
}
