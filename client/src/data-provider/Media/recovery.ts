import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  QueryKeys,
  MutationKeys,
  mediaRecoveryJobSchema,
  mediaRecoveryPageSchema,
  mediaRecoveryCapabilitiesSchema,
} from 'librechat-data-provider';
import type { MediaRecoveryJob, MediaRecoveryRequest } from 'librechat-data-provider';
export type PendingMediaRecovery = { job: MediaRecoveryJob; request: MediaRecoveryRequest };
import type { MediaQueryScope } from './queries';

export type MediaRecoveryScope = Pick<MediaQueryScope, 'scope' | 'isCurrentSession'>;

export function useMediaRecoveryCapabilities(host: MediaRecoveryScope, enabled: boolean) {
  return useQuery(
    [QueryKeys.mediaRecoveryCapabilities, host.scope],
    async ({ signal }) => {
      const capabilities = mediaRecoveryCapabilitiesSchema.parse(
        await dataService.getMediaRecoveryCapabilities(signal),
      );
      if (!host.isCurrentSession()) throw new Error('Session ended');
      return capabilities;
    },
    { enabled, retry: false },
  );
}

export function useMediaRecoveryJobs(host: MediaRecoveryScope, enabled: boolean) {
  return useInfiniteQuery(
    [QueryKeys.mediaRecovery, host.scope],
    async ({ pageParam, signal }) => {
      const page = mediaRecoveryPageSchema.parse(
        await dataService.listMediaRecoveryJobs({ cursor: pageParam }, signal),
      );
      if (!host.isCurrentSession()) throw new Error('Session ended');
      return page;
    },
    {
      enabled,
      retry: false,
      refetchOnWindowFocus: false,
      getNextPageParam: (page) => page.nextCursor,
    },
  );
}

export function useMediaRecoveryMutation(host: MediaRecoveryScope) {
  const client = useQueryClient();
  return useMutation(
    [MutationKeys.recoverMediaJob],
    async ({ job, request }: PendingMediaRecovery) => {
      const result = mediaRecoveryJobSchema.parse(
        await dataService.recoverMediaJob(job.ownerId, job.jobId, request),
      );
      if (!host.isCurrentSession()) throw new Error('Session ended');
      return result;
    },
    {
      retry: false,
      onSuccess: async () => {
        if (host.isCurrentSession())
          await client.invalidateQueries([QueryKeys.mediaRecovery, host.scope]);
      },
    },
  );
}
