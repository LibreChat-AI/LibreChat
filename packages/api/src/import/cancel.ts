import { logger } from '@librechat/data-schemas';

/** Minimum gap between cancellation reads inside the conversation loop. The
 * job store can be Redis, so an unthrottled check is a network round trip per
 * conversation, tens of thousands of them on a large export, for a signal a
 * user produces at most once. The first check is never delayed, and a second
 * of extra work after a cancel is under the client's own poll interval. */
const CANCEL_CHECK_INTERVAL_MS = 1000;

/** Wraps a cancellation check so it hits the store at most once per interval
 * and answers from the last read in between. */
export function throttleCancelCheck(isCancelled?: () => Promise<boolean>): () => Promise<boolean> {
  if (!isCancelled) {
    return async () => false;
  }
  let lastCheck = 0;
  let lastResult = false;
  return async () => {
    if (lastResult) {
      return true;
    }
    const now = Date.now();
    if (now - lastCheck < CANCEL_CHECK_INTERVAL_MS) {
      return false;
    }
    lastCheck = now;
    try {
      lastResult = await isCancelled();
    } catch (error) {
      logger.error('[import] Could not read asset-import cancellation state', error);
      lastResult = false;
    }
    return lastResult;
  };
}
