import { useAtomValue, useStore } from 'jotai';
import { DynamicQueryKeys, MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import {
  useIsFetching,
  useIsMutating,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  TConversation,
  CodeEnvironmentUserSettings,
  TCodeEnvironmentMoveRequest,
  TCodeEnvironmentMoveResponse,
  TCodeEnvironmentPairingResponse,
  TCodeEnvironmentStatusResponse,
  TCodeEnvironmentsResponse,
} from 'librechat-data-provider';
import type { QueryFilters } from '@tanstack/react-query';
import type { SetterOrUpdater } from 'recoil';
import type { CodeEnvironmentReconciliationRequest } from '~/store/codeEnvironmentReconciliation';
import {
  CONVERSATION_LIST_KEYS,
  updateConvoInAllQueries,
  getCodeWorkspaceErrorReason,
  getResponseStatus,
} from '~/utils';
import { codeEnvironmentReconciliationsAtom } from '~/store/codeEnvironmentReconciliation';
import { hasSameCodeDecision } from '~/hooks/Agents/codeDecision';
import { retryTransientQuery } from './retry';

export type CodeEnvironmentPairingResponse = TCodeEnvironmentPairingResponse;

export function useCodeEnvironmentsQuery(enabled = true) {
  return useQuery<TCodeEnvironmentsResponse>(
    [QueryKeys.codeEnvironments],
    () => dataService.getCodeEnvironments(),
    { enabled },
  );
}

function codeEnvironmentStatusOptions(id: string, enabled: boolean) {
  return {
    queryKey: DynamicQueryKeys.codeEnvironmentStatus(id),
    queryFn: (): Promise<TCodeEnvironmentStatusResponse> =>
      dataService.getCodeEnvironmentStatus(id),
    enabled: enabled && id.length > 0,
    staleTime: 10_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    retry: retryTransientQuery,
  };
}

export function useCodeEnvironmentStatusQuery(id: string, enabled = true) {
  return useQuery(codeEnvironmentStatusOptions(id, enabled));
}

export function useCodeEnvironmentStatusQueries(ids: string[], enabled = true) {
  return useQueries({ queries: ids.map((id) => codeEnvironmentStatusOptions(id, enabled)) });
}

/** Refresh discovery, not the conversation draft or expanded agent editor records. */
const isWorkspaceDiscovery: NonNullable<QueryFilters['predicate']> = ({ queryKey }) =>
  queryKey[0] === QueryKeys.endpoints ||
  queryKey[0] === QueryKeys.agents ||
  queryKey[0] === QueryKeys.codeEnvironments ||
  (queryKey[0] === QueryKeys.agent && queryKey.length === 2);

export function useCodeWorkspaceRefresh() {
  const queryClient = useQueryClient();
  const isRefreshing = useIsFetching({ predicate: isWorkspaceDiscovery }) > 0;
  return {
    isRefreshing,
    refresh: () => queryClient.invalidateQueries({ predicate: isWorkspaceDiscovery }),
  };
}

export function usePairCodeEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation<
    TCodeEnvironmentPairingResponse,
    Error,
    { name: string; controlPlaneId: string }
  >([MutationKeys.pairCodeEnvironment], dataService.pairCodeEnvironment, {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.codeEnvironments]);
      queryClient.invalidateQueries([QueryKeys.endpoints]);
    },
  });
}

export function useDeleteCodeEnvironmentMutation() {
  const queryClient = useQueryClient();
  return useMutation<
    { environment: TCodeEnvironmentsResponse['environments'][number] },
    Error,
    string
  >([MutationKeys.deleteCodeEnvironment], dataService.deleteCodeEnvironment, {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.codeEnvironments]);
      queryClient.invalidateQueries([QueryKeys.endpoints]);
    },
  });
}

export function useUpdateCodeEnvironmentSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation<
    { environment: TCodeEnvironmentsResponse['environments'][number] },
    Error,
    { id: string; settings: CodeEnvironmentUserSettings }
  >([MutationKeys.updateCodeEnvironmentSettings], dataService.updateCodeEnvironmentSettings, {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.codeEnvironments]);
      queryClient.invalidateQueries([QueryKeys.endpoints]);
    },
  });
}

/** Pending and failed authoritative reads both leave the local decision unconfirmed. */
export function useConversationCodeEnvironmentRecovery(conversationId?: string | null) {
  const reconciliations = useAtomValue(codeEnvironmentReconciliationsAtom);
  return conversationId == null ? undefined : reconciliations.get(conversationId);
}

/** Block pending transitions and unresolved decision reads for this conversation only. */
export function useIsReplacingConversationCodeEnvironment(conversationId?: string | null): boolean {
  const recovery = useConversationCodeEnvironmentRecovery(conversationId);
  const pending =
    useIsMutating({
      predicate: (mutation) =>
        [
          MutationKeys.moveConversationCodeEnvironment,
          'reconcileConversationCodeEnvironment',
        ].includes(String(mutation.options.mutationKey?.[0])) &&
        conversationId != null &&
        (mutation.state.variables as TCodeEnvironmentMoveRequest | undefined)?.conversationId ===
          conversationId,
    }) > 0;
  return recovery != null || pending;
}

/** Keeps every cached copy of the conversation on the decision the server just persisted. */
export function useMoveConversationCodeEnvironmentMutation(
  setConversation?: SetterOrUpdater<TConversation | null>,
) {
  const queryClient = useQueryClient();
  const { mutateAsync: reconcile } =
    useReconcileConversationCodeEnvironmentMutation(setConversation);
  return useMutation<TCodeEnvironmentMoveResponse, Error, TCodeEnvironmentMoveRequest>(
    [MutationKeys.moveConversationCodeEnvironment],
    dataService.moveConversationCodeEnvironment,
    {
      onError: async (error, { conversationId, from }) => {
        const status = getResponseStatus(error);
        if (getCodeWorkspaceErrorReason(error) !== 'locked' && status != null && status < 500) {
          return;
        }
        // A conflict or lost response does not establish which decision the server holds.
        // Keep this in the mutation, not a component callback that navigation can discard.
        try {
          await reconcile({
            conversationId,
            attempted: {
              codeEnvironmentMode: from.length > 0 ? 'attached' : 'without_attached',
              codeWorkspaces: from.length > 0 ? from : undefined,
            },
          });
        } catch {
          // The conversation-scoped recovery state retains the failed read and offers retry.
        }
      },
      onSuccess: async ({ conversationId, codeEnvironmentMode, codeWorkspaces }) => {
        /** A read already in flight could land after this write and restore the replaced decision. */
        await Promise.all(
          [[QueryKeys.conversation, conversationId], [QueryKeys.pinnedConversations]]
            .concat(CONVERSATION_LIST_KEYS.map((listKey) => [listKey]))
            .map((queryKey) => queryClient.cancelQueries({ queryKey })),
        );
        const applyDecision = (conversation: TConversation): TConversation => ({
          ...conversation,
          codeEnvironmentMode,
          codeWorkspaces,
        });
        updateConvoInAllQueries(queryClient, conversationId, applyDecision);
        setConversation?.((current) =>
          current?.conversationId === conversationId ? applyDecision(current) : current,
        );
        queryClient.setQueryData<TConversation | undefined>(
          [QueryKeys.conversation, conversationId],
          (conversation) => (conversation == null ? conversation : applyDecision(conversation)),
        );
      },
    },
  );
}

/** A terminal error does not say whether the server persisted the attempted decision. Read it,
 * rather than rolling back a decision a failed turn may already have established. */
export function useReconcileConversationCodeEnvironmentMutation(
  setConversation?: SetterOrUpdater<TConversation | null>,
) {
  const queryClient = useQueryClient();
  const store = useStore();
  return useMutation({
    mutationKey: ['reconcileConversationCodeEnvironment'],
    onMutate: (request: CodeEnvironmentReconciliationRequest) => {
      const token = Symbol();
      store.set(codeEnvironmentReconciliationsAtom, (current) =>
        new Map(current).set(request.conversationId, { request, token, status: 'pending' }),
      );
      return { token };
    },
    mutationFn: async ({ conversationId }: CodeEnvironmentReconciliationRequest) => {
      const queryKey = [QueryKeys.conversation, conversationId];
      await queryClient.cancelQueries({ queryKey });
      return queryClient.fetchQuery(
        queryKey,
        async () => {
          const persisted = await dataService.getConversationById(conversationId);
          if (persisted?.conversationId !== conversationId) {
            throw new Error(
              'Conversation decision reconciliation returned a different conversation',
            );
          }
          return persisted;
        },
        { staleTime: 0 },
      );
    },
    onSuccess: (persisted, { conversationId, attempted }, context) => {
      if (
        store.get(codeEnvironmentReconciliationsAtom).get(conversationId)?.token !== context?.token
      ) {
        return;
      }
      const apply = (current: TConversation): TConversation =>
        current.conversationId === conversationId && hasSameCodeDecision(current, attempted)
          ? {
              ...current,
              codeEnvironmentMode: persisted.codeEnvironmentMode,
              codeWorkspaces: persisted.codeWorkspaces,
            }
          : current;
      updateConvoInAllQueries(queryClient, conversationId, apply);
      setConversation?.((current) => (current == null ? current : apply(current)));
      store.set(codeEnvironmentReconciliationsAtom, (current) => {
        const next = new Map(current);
        next.delete(conversationId);
        return next;
      });
    },
    onError: (_error, { conversationId }, context) => {
      store.set(codeEnvironmentReconciliationsAtom, (current) => {
        const recovery = current.get(conversationId);
        if (recovery == null || recovery.token !== context?.token) return current;
        return new Map(current).set(conversationId, { ...recovery, status: 'error' });
      });
    },
  });
}
