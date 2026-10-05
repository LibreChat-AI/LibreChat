import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  MutationKeys,
  mediaImportReceiptSchema,
  mediaSubmissionReceiptSchema,
  mediaThreadsDeletionReceiptSchema,
} from 'librechat-data-provider';
import type {
  MediaImportInput,
  MediaImportReceipt,
  MediaRetryRequest,
  MediaSubmissionInput,
  MediaSubmissionReceipt,
  MediaThreadUpdate,
  MediaThreadsDeleteRequest,
} from 'librechat-data-provider';
import type { MediaQueryScope } from './queries';
import { invalidateMedia } from './queries';

type MutationScope = Pick<MediaQueryScope, 'scope' | 'isCurrentSession'>;

/** Media writes settle by invalidating the scope's reads, but only while the session that
 * issued them is still the current one; a late response from a signed-out account must not
 * refresh the next account's views. */
function useSettle(host: MutationScope) {
  const client = useQueryClient();
  return async () => {
    if (host.isCurrentSession()) await invalidateMedia(client, host.scope);
  };
}

export function useMediaThreadMutations(host: MutationScope) {
  const settle = useSettle(host);
  const update = useMutation(
    [MutationKeys.updateMediaThread],
    (input: { threadId: string; update: MediaThreadUpdate }) =>
      dataService.updateMediaThread(input.threadId, input.update),
    { onSuccess: settle },
  );
  return { update };
}

export function useDeleteMediaThreads(host: MutationScope) {
  const settle = useSettle(host);
  return useMutation(
    [MutationKeys.deleteMediaThreads],
    async (input: MediaThreadsDeleteRequest) =>
      mediaThreadsDeletionReceiptSchema.parse(await dataService.deleteMediaThreads(input)),
    { onSettled: settle },
  );
}

export function useMediaJobMutations(host: MutationScope) {
  const settle = useSettle(host);
  const cancel = useMutation(
    [MutationKeys.cancelMediaJob],
    (jobId: string) => dataService.cancelMediaJob(jobId),
    { onSettled: settle },
  );
  return { cancel };
}

export function useMediaCommandMutations(host: MutationScope) {
  const settle = useSettle(host);
  const submit = useMutation(
    [MutationKeys.submitMedia],
    async (request: MediaSubmissionInput): Promise<MediaSubmissionReceipt> =>
      mediaSubmissionReceiptSchema.parse(await dataService.submitMedia(request)),
    { onSuccess: settle },
  );
  const retry = useMutation(
    [MutationKeys.retryMediaJob],
    async (input: { jobId: string; request: MediaRetryRequest }): Promise<MediaSubmissionReceipt> =>
      mediaSubmissionReceiptSchema.parse(
        await dataService.retryMediaJob(input.jobId, input.request),
      ),
    { onSuccess: settle },
  );
  const importMedia = useMutation(
    [MutationKeys.importMedia],
    async (request: MediaImportInput): Promise<MediaImportReceipt> =>
      mediaImportReceiptSchema.parse(await dataService.importMedia(request)),
    { onSuccess: settle },
  );
  return { submit, retry, importMedia };
}
