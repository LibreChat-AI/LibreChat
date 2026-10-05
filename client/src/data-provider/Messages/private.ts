import { createContext, useEffect, useMemo } from 'react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';

export const OwnerQueryContext = createContext<QueryClient | undefined>(undefined);
const clients = new WeakMap<QueryClient, QueryClient>();

/** Shared by panes, but excluded from ordinary caches, devtools and persistence. */
export function getOwnerQueryClient(applicationClient: QueryClient): QueryClient {
  let client = clients.get(applicationClient);
  if (client == null) {
    client = new QueryClient({
      defaultOptions: { queries: { cacheTime: 0, retry: false, networkMode: 'always' } },
    });
    clients.set(applicationClient, client);
  }
  return client;
}

interface Original {
  messageId: string;
  canonicalText: string;
  revision: string;
  text: string;
}
interface OwnerTexts {
  messages: Original[];
  provisional: boolean;
}

export function useOwnerMessageTexts({
  messages,
  userId,
  tenantId,
  conversationId,
  isSubmitting,
}: {
  messages: readonly TMessage[] | null;
  userId?: string;
  tenantId?: string;
  conversationId?: string;
  isSubmitting: boolean;
}) {
  const client = useQueryClient({ context: OwnerQueryContext });
  const selected = useMemo(
    () =>
      (messages ?? [])
        .filter(
          (message) =>
            message.isCreatedByUser &&
            message.privacyRevision &&
            typeof message.text === 'string' &&
            message.conversationId === conversationId,
        )
        .map((message) => ({
          messageId: message.messageId,
          revision: message.privacyRevision!,
          canonicalText: message.text,
        }))
        .sort((a, b) => a.messageId.localeCompare(b.messageId)),
    [messages, conversationId],
  );
  const scope = [QueryKeys.ownerMessageTexts, userId, tenantId ?? '', conversationId];
  const queryKey = [...scope, selected];
  const query = useQuery<OwnerTexts>({
    context: OwnerQueryContext,
    queryKey,
    enabled: Boolean(userId && conversationId && selected.length),
    cacheTime: 0,
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const expected = new Map(selected.map((message) => [message.messageId, message]));
      const originals = new Map<string, Original>();
      // Reuse only validated rows still held by active queries in this exact owner scope.
      for (const [, prior] of client.getQueriesData<OwnerTexts>(scope)) {
        for (const message of prior?.messages ?? []) {
          const match = expected.get(message.messageId);
          if (
            match?.revision === message.revision &&
            match.canonicalText === message.canonicalText
          ) {
            originals.set(message.messageId, message);
          }
        }
      }
      const pending = selected.filter((message) => !originals.has(message.messageId));
      const result = (): OwnerTexts => ({
        messages: [...originals.values()],
        provisional: isSubmitting && originals.size < selected.length,
      });
      const publish = () => {
        if (!signal?.aborted) {
          client.setQueryData(queryKey, result());
        }
      };
      publish();
      let next = 0;
      let failed = false;
      // Transport batches are bounded; React Query owns deduplication, cancellation and retry.
      await Promise.all(
        Array.from({ length: Math.min(3, Math.ceil(pending.length / 50)) }, async () => {
          while (next < pending.length && !signal?.aborted) {
            const batch = pending.slice(next, (next += 50));
            try {
              const response = await dataService.getOwnerMessageTexts(
                conversationId!,
                batch.map((message) => message.messageId),
              );
              if (signal?.aborted) {
                return;
              }
              const batchIds = new Set(batch.map((message) => message.messageId));
              for (const message of response.messages) {
                const match = expected.get(message.messageId);
                if (
                  batchIds.has(message.messageId) &&
                  match?.revision === message.revision &&
                  match.canonicalText === message.canonicalText &&
                  typeof message.text === 'string'
                ) {
                  originals.set(message.messageId, { ...message, text: message.text });
                }
              }
              publish();
            } catch {
              failed = true;
            }
          }
        }),
      );
      if (failed) {
        // Never retain HTTP payloads or upstream error text in a query error.
        throw new Error('owner_text_unavailable');
      }
      return result();
    },
  });
  const { data, isFetching, refetch } = query;
  useEffect(() => {
    if (!isSubmitting && data?.provisional && !isFetching) {
      void refetch();
    }
  }, [isSubmitting, data?.provisional, isFetching, refetch]);
  const originals = useMemo(
    () => new Map((data?.messages ?? []).map((message) => [message.messageId, message])),
    [data],
  );
  return { messages: originals, loading: isFetching, retry: () => void refetch() };
}
