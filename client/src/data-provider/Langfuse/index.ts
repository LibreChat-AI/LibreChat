import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type {
  TLangfuseConnectionStatus,
  TUpdateLangfuseConnectionRequest,
  TLangfuseConnectionTestRequest,
  TLangfuseConnectionTestResponse,
  TLangfuseSessionLinkResponse,
  TUpdateLangfusePromptSyncRequest,
  TLangfusePromptListParams,
  TLangfusePromptListResponse,
  TLangfusePromptGetParams,
  TLangfusePromptGetResponse,
} from 'librechat-data-provider';
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query';

export const useGetLangfuseConnectionQuery = (
  enabled = true,
): UseQueryResult<TLangfuseConnectionStatus> =>
  useQuery<TLangfuseConnectionStatus>(
    [QueryKeys.langfuseConnection],
    () => dataService.getLangfuseConnection(),
    { enabled, refetchOnWindowFocus: false },
  );

export const useGetLangfuseSessionLinkQuery = (
  conversationId: string,
  enabled = true,
): UseQueryResult<TLangfuseSessionLinkResponse> =>
  useQuery<TLangfuseSessionLinkResponse>(
    [QueryKeys.langfuseSessionLink, conversationId],
    () => dataService.getLangfuseSessionLink(conversationId),
    { enabled, refetchOnWindowFocus: false },
  );

export const useUpdateLangfuseConnectionMutation = (): UseMutationResult<
  TLangfuseConnectionStatus,
  unknown,
  TUpdateLangfuseConnectionRequest
> => {
  const queryClient = useQueryClient();
  return useMutation(
    (payload: TUpdateLangfuseConnectionRequest) => dataService.updateLangfuseConnection(payload),
    {
      mutationKey: [MutationKeys.updateLangfuseConnection],
      onSuccess: (data) => {
        queryClient.setQueryData([QueryKeys.langfuseConnection], data);
        queryClient.removeQueries([QueryKeys.langfuseSessionLink]);
        // A rotated destination or credential invalidates any prompt list/get
        // results already cached under the old connection — the always-mounted
        // prompts dialog must never show a previous connection's prompts.
        queryClient.removeQueries({ queryKey: [QueryKeys.langfusePrompts] });
        queryClient.removeQueries({ queryKey: [QueryKeys.langfusePrompt] });
      },
    },
  );
};

export const useTestLangfuseConnectionMutation = (): UseMutationResult<
  TLangfuseConnectionTestResponse,
  unknown,
  TLangfuseConnectionTestRequest
> =>
  useMutation(
    (payload: TLangfuseConnectionTestRequest) => dataService.testLangfuseConnection(payload),
    { mutationKey: [MutationKeys.testLangfuseConnection] },
  );

export const useUpdateLangfusePromptSyncMutation = (): UseMutationResult<
  TLangfuseConnectionStatus,
  unknown,
  TUpdateLangfusePromptSyncRequest
> => {
  const queryClient = useQueryClient();
  return useMutation(
    (payload: TUpdateLangfusePromptSyncRequest) => dataService.updateLangfusePromptSync(payload),
    {
      mutationKey: [MutationKeys.updateLangfusePromptSync],
      onSuccess: (data) => {
        queryClient.setQueryData([QueryKeys.langfuseConnection], data);
        // Toggling the switch off and back on must never resurface a previous
        // project's cached prompt list/get results in the always-mounted dialog.
        queryClient.removeQueries({ queryKey: [QueryKeys.langfusePrompts] });
        queryClient.removeQueries({ queryKey: [QueryKeys.langfusePrompt] });
      },
    },
  );
};

/**
 * Lists Langfuse prompts for the test dialog, keyed on the last SUBMITTED filters rather
 * than the live form state, so editing the inputs after a submit never changes the key out
 * from under the shown result. Idle until the dialog submits once; `submitCount` forces a
 * new request on an identical resubmit, since the params alone would hash to the same key.
 * Never retried: each call reaches the tenant's Langfuse project and a failure there is
 * deterministic.
 */
export const useLangfusePromptsQuery = (
  params: TLangfusePromptListParams | undefined,
  submitCount: number,
): UseQueryResult<TLangfusePromptListResponse> =>
  useQuery<TLangfusePromptListResponse>(
    [QueryKeys.langfusePrompts, params, submitCount],
    () => dataService.getLangfusePrompts(params),
    { enabled: params != null, retry: false, refetchOnWindowFocus: false },
  );

/**
 * Resolves one Langfuse prompt (Production or an exact version) for the test dialog, keyed
 * the same way as {@link useLangfusePromptsQuery} and for the same reason. Never retried.
 */
export const useLangfusePromptQuery = (
  params: TLangfusePromptGetParams | undefined,
  submitCount: number,
): UseQueryResult<TLangfusePromptGetResponse> =>
  useQuery<TLangfusePromptGetResponse>(
    [QueryKeys.langfusePrompt, params, submitCount],
    () => {
      if (params == null) {
        throw new Error('Langfuse prompt query is disabled');
      }
      return dataService.getLangfusePrompt(params);
    },
    { enabled: params != null, retry: false, refetchOnWindowFocus: false },
  );
