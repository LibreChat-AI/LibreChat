import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, MutationKeys, QueryKeys } from 'librechat-data-provider';
import type {
  TAgentQueuedTurnReceipt,
  TEnqueueAgentQueuedTurnRequest,
} from 'librechat-data-provider';

export type AgentQueuedTurnReceipt = TAgentQueuedTurnReceipt;
export type EnqueueAgentQueuedTurnRequest = TEnqueueAgentQueuedTurnRequest;

/** Keep one cache authority for a conversation. Known receipt ids change the
 * server projection, not the identity of the durable queue. Giving every id
 * set its own key can resurrect an older cached projection after an id is
 * retired. */
export const agentQueuedTurnsQueryKey = (conversationId: string) =>
  [QueryKeys.agentQueuedTurns, conversationId] as const;

function queuedTurnErrorResponse(error: unknown): { status?: number; code?: string } {
  const response = (
    error as { response?: { status?: unknown; data?: { code?: unknown } } } | undefined
  )?.response;
  return {
    ...(typeof response?.status === 'number' && { status: response.status }),
    ...(typeof response?.data?.code === 'string' && { code: response.data.code }),
  };
}

export function isDefiniteQueuedTurnsUnsupported(error: unknown): boolean {
  const { status, code } = queuedTurnErrorResponse(error);
  return (
    (status === 404 && code == null) ||
    (status === 501 &&
      (code == null ||
        code === 'QUEUED_TURNS_UNSUPPORTED' ||
        code === 'QUEUED_TURN_PRIORITY_UNSUPPORTED'))
  );
}

/** A bounded origin 4xx proves the queued row was not committed. Timeouts and
 * early-data responses can be generated while the origin request continues,
 * so those remain outcome-ambiguous and must reconcile by request identity. */
export function isDefiniteQueuedTurnRejection(error: unknown): boolean {
  const { status } = queuedTurnErrorResponse(error);
  return (
    !isDefiniteQueuedTurnsUnsupported(error) &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 425
  );
}

export async function fetchAgentQueuedTurns(
  conversationId: string,
  clientRequestIds?: string[],
): Promise<AgentQueuedTurnReceipt[]> {
  const response = await dataService.listAgentQueuedTurns(conversationId, clientRequestIds);
  return response.queuedTurns;
}

export async function enqueueAgentQueuedTurn(
  input: EnqueueAgentQueuedTurnRequest,
): Promise<AgentQueuedTurnReceipt> {
  const response = await dataService.enqueueAgentQueuedTurn(input);
  return response.receipt;
}

export async function cancelAgentQueuedTurn(input: {
  conversationId: string;
  queuedTurnId: string;
}): Promise<AgentQueuedTurnReceipt> {
  const response = await dataService.cancelAgentQueuedTurn(input.queuedTurnId);
  return response.receipt;
}

/** Indeterminate admission deliberately retains its durable claim until exact
 * source evidence arrives. It can still be refreshed on mount/focus, but a
 * two-second loop cannot resolve it and disguises permanent quarantine as
 * ordinary progress. */
export function shouldPollAgentQueuedTurns(
  receipts: unknown,
  reconcileUntil?: number,
  observedAt = Date.now(),
  expectsReceipts = false,
): boolean {
  return (
    expectsReceipts ||
    (reconcileUntil != null && observedAt < reconcileUntil) ||
    (Array.isArray(receipts) &&
      receipts.some(
        (item: AgentQueuedTurnReceipt) =>
          item.status === 'queued' ||
          (item.status === 'claimed' && item.failure?.code !== 'ADMISSION_INDETERMINATE'),
      ))
  );
}

/**
 * Whether the backend owes this conversation a run it will start itself.
 *
 * Wider than {@link shouldPollAgentQueuedTurns} in exactly one way: `admitted`.
 * The receipt poll stops there because there is nothing left to wait for — but
 * for a pane that is not attached, `admitted` is the strongest evidence it will
 * get that a run exists, and the receipt is dropped from the projection almost
 * immediately after (the chip goes, so its id leaves the known set). Anyone
 * deciding whether to keep listening for that run must count it.
 */
export function isQueuedTurnSuccessorOwed(receipts: unknown): boolean {
  return (
    Array.isArray(receipts) &&
    receipts.some(
      (item: AgentQueuedTurnReceipt) =>
        item.status === 'queued' ||
        item.status === 'admitted' ||
        (item.status === 'claimed' && item.failure?.code !== 'ADMISSION_INDETERMINATE'),
    )
  );
}

/**
 * `expectsReceipts` keeps the poll alive while the caller still holds a
 * server-owned row the projection has not settled. A snapshot fetched while
 * the enqueue is still committing can come back empty, and a poll that stops
 * on that answer would leave a fast successor unnoticed until the next focus.
 */
export function useAgentQueuedTurns(
  conversationId: string,
  enabled: boolean,
  clientRequestIds: string[] = [],
  reconcileUntil?: number,
  expectsReceipts = false,
) {
  const queryClient = useQueryClient();
  const knownIds = [...new Set(clientRequestIds)].sort();
  const knownIdsSignature = knownIds.join('\u0000');
  const previousRequest = useRef({ conversationId, knownIdsSignature });
  const query = useQuery({
    queryKey: agentQueuedTurnsQueryKey(conversationId),
    queryFn: () => fetchAgentQueuedTurns(conversationId, knownIds),
    enabled: enabled && conversationId.length > 0,
    staleTime: 1_000,
    /** A stopped indeterminate row can receive exact proof at any time. Its
     * cache may still be inside `staleTime`, so mount/focus must bypass the
     * ordinary freshness gate rather than waiting for another user cycle. */
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchInterval: (receipts) =>
      shouldPollAgentQueuedTurns(receipts, reconcileUntil, Date.now(), expectsReceipts)
        ? 2_000
        : false,
    retry: false,
  });
  const { refetch } = query;

  useEffect(() => {
    const previous = previousRequest.current;
    previousRequest.current = { conversationId, knownIdsSignature };
    if (
      !enabled ||
      conversationId.length === 0 ||
      previous.conversationId !== conversationId ||
      previous.knownIdsSignature === knownIdsSignature
    ) {
      return;
    }

    let superseded = false;
    const refreshProjection = async () => {
      /** React Query cannot replace an initial fetch that has no cached data
       * through `refetch` alone. Cancel it explicitly so the next request
       * captures the current reconciliation identities. */
      await queryClient.cancelQueries({
        queryKey: agentQueuedTurnsQueryKey(conversationId),
        exact: true,
      });
      if (!superseded) {
        await refetch({ cancelRefetch: true });
      }
    };
    void refreshProjection();

    return () => {
      superseded = true;
    };
  }, [conversationId, enabled, knownIdsSignature, queryClient, refetch]);

  return query;
}

export function useEnqueueAgentQueuedTurnMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [MutationKeys.enqueueAgentQueuedTurn],
    mutationFn: enqueueAgentQueuedTurn,
    /** A retry can encounter admission middleware while the first request is
     * still committing. Reconcile ambiguous outcomes through the read-only
     * known-id projection instead of issuing a second mutating POST. */
    retry: false,
    onSettled: (_receipt, _error, input) =>
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.agentQueuedTurns, input.conversationId],
      }),
  });
}

export function useCancelAgentQueuedTurnMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [MutationKeys.cancelAgentQueuedTurn],
    mutationFn: cancelAgentQueuedTurn,
    onSuccess: (_receipt, input) =>
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.agentQueuedTurns, input.conversationId],
      }),
  });
}
