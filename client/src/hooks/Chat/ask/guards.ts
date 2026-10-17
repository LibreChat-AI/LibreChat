import { QueryKeys } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';

/** A revalidating cache younger than this is locally authoritative (the run
 * that just streamed wrote it) and stays sendable; older ones wait for the
 * refetch so a send can't fork from an outdated tail. */
const STALE_SEND_REVALIDATION_MS = 5_000;

/** Whether the cached history is mid-refetch and old enough that a send could fork from it. */
export function isHistoryRevalidating(
  queryClient: QueryClient,
  conversationId: string | null,
): boolean {
  const messagesQueryState = queryClient.getQueryState<TMessage[]>([
    QueryKeys.messages,
    conversationId,
  ]);
  const isRevalidating =
    messagesQueryState?.isInvalidated === true && messagesQueryState.fetchStatus === 'fetching';
  const cacheAgeMs = Date.now() - (messagesQueryState?.dataUpdatedAt ?? 0);
  return isRevalidating && cacheAgeMs > STALE_SEND_REVALIDATION_MS;
}
