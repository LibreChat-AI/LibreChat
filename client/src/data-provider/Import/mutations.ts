import { useMutation, useQueryClient } from '@tanstack/react-query';
import { QueryKeys, dataService, isImportJobStarted } from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';
import type { TImportResponse } from 'librechat-data-provider';
import { invalidateImportedConversations } from './queries';

export type ImportJobActionResult = { jobId: string };

export const useUploadImportMutation = (options?: {
  onSuccess?: (data: TImportResponse) => void;
  onError?: (error: unknown) => void;
}): UseMutationResult<TImportResponse, unknown, FormData> => {
  const queryClient = useQueryClient();

  return useMutation<TImportResponse, unknown, FormData>({
    mutationFn: (formData: FormData) => dataService.importConversationsFile(formData),
    onSuccess: (data) => {
      if (!isImportJobStarted(data)) {
        invalidateImportedConversations(queryClient);
      }
      options?.onSuccess?.(data);
    },
    onError: (error) => {
      options?.onError?.(error);
    },
  });
};

export const useStartImportMutation = (options?: {
  onError?: (error: unknown) => void;
}): UseMutationResult<ImportJobActionResult, unknown, string> => {
  const queryClient = useQueryClient();

  return useMutation<ImportJobActionResult, unknown, string>({
    mutationFn: (jobId: string) => dataService.startImportJob(jobId),
    onSuccess: (_data, jobId) => {
      queryClient.invalidateQueries([QueryKeys.importJob, jobId]);
    },
    /**
     * A failed `/start` does not mean the job did not start. The server
     * responds before launching the run, so a timeout or a dropped connection
     * leaves the client holding an error for an import that is underway, and
     * `awaiting_confirmation` is a phase the poller deliberately sits idle on,
     * so nothing would ever correct it. Refetching the job asks the server
     * which of the two happened instead of assuming.
     */
    onError: (error, jobId) => {
      queryClient.invalidateQueries([QueryKeys.importJob, jobId]);
      options?.onError?.(error);
    },
  });
};

export const useCancelImportMutation = (): UseMutationResult<
  ImportJobActionResult,
  unknown,
  string
> => {
  const queryClient = useQueryClient();

  return useMutation<ImportJobActionResult, unknown, string>({
    mutationFn: (jobId: string) => dataService.cancelImportJob(jobId),
    onSuccess: (_data, jobId) => {
      /**
       * Cancellation stops the background job between conversations, not
       * before the first one: everything already flushed to the database
       * up to that point is a real, permanent import. The conversation
       * list must be invalidated alongside the job query, or the sidebar
       * never reflects what was actually imported before cancelling.
       */
      queryClient.invalidateQueries([QueryKeys.importJob, jobId]);
      invalidateImportedConversations(queryClient);
    },
    /** A dropped response is ambiguous: cancellation may already have
     * succeeded while polling is paused on the confirmation screen. Refetch
     * both the job and any conversations the run may have committed. */
    onError: (_error, jobId) => {
      queryClient.invalidateQueries([QueryKeys.importJob, jobId]);
      invalidateImportedConversations(queryClient);
    },
  });
};
