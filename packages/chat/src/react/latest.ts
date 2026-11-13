import { useCallback, useMemo } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { getMessageBranchSiblingParentIds, selectActiveBranchTail } from '../core';
import { siblingKey, useSiblingIndexes } from './thread';

const EMPTY_PARENT_IDS: (string | null)[] = [];

function useMessagesCacheSelect<TData>(
  messagesQueryId: string | null | undefined,
  select: (messages: TMessage[]) => TData,
): TData | null {
  const queryClient = useQueryClient();
  const queryKey = [QueryKeys.messages, messagesQueryId ?? ''];

  const { data } = useQuery<TMessage[], unknown, TData>(
    queryKey,
    async () => queryClient.getQueryData<TMessage[]>(queryKey) ?? [],
    {
      enabled: false,
      select,
    },
  );

  if (!messagesQueryId) {
    return null;
  }

  return data ?? null;
}

/**
 * A projection of the tail of the branch on screen, read from the messages cached under
 * `messagesQueryId`. `rootSiblingKey` keys the root's siblings when the messages name no
 * conversation. `pick` must be stable; a projection streaming leaves untouched stays referentially
 * stable through the query's structural sharing, so its readers skip per-delta renders.
 */
export function useBranchTailSelect<TData>(
  rootSiblingKey: string | null,
  messagesQueryId: string | null | undefined,
  pick: (tail: TMessage | null) => TData | null,
): TData | null {
  const selectParentIds = useCallback(
    (messages: TMessage[]) =>
      getMessageBranchSiblingParentIds(messages, messages[0]?.conversationId ?? rootSiblingKey),
    [rootSiblingKey],
  );
  const parentIds = useMessagesCacheSelect(messagesQueryId, selectParentIds) ?? EMPTY_PARENT_IDS;
  const parentKeys = useMemo(() => parentIds.map(siblingKey), [parentIds]);
  const siblingIndexes = useSiblingIndexes(parentKeys);
  const select = useCallback(
    (messages: TMessage[]) =>
      pick(
        selectActiveBranchTail(
          messages,
          messages[0]?.conversationId ?? rootSiblingKey,
          (parentId) => siblingIndexes[siblingKey(parentId)] ?? 0,
        ),
      ),
    [pick, rootSiblingKey, siblingIndexes],
  );
  return useMessagesCacheSelect(messagesQueryId, select);
}

const pickTail = (tail: TMessage | null): TMessage | null => tail;
const pickTailId = (tail: TMessage | null): string | null => tail?.messageId ?? null;

/** The tail of the branch on screen. */
export function useBranchTail(
  rootSiblingKey: string | null,
  messagesQueryId: string | null | undefined,
): TMessage | null {
  return useBranchTailSelect(rootSiblingKey, messagesQueryId, pickTail);
}

/** The id of {@link useBranchTail}, subscribed on its own. */
export function useBranchTailId(
  rootSiblingKey: string | null,
  messagesQueryId: string | null | undefined,
): string | null {
  return useBranchTailSelect(rootSiblingKey, messagesQueryId, pickTailId);
}
