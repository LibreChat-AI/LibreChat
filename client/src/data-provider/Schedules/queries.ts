/* Scheduled chats */
import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { TSchedulesResponse, TScheduledOboTarget } from 'librechat-data-provider';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';

export const useSchedulesQuery = (
  config?: UseQueryOptions<TSchedulesResponse>,
): QueryObserverResult<TSchedulesResponse> => {
  return useQuery<TSchedulesResponse>([QueryKeys.schedules], () => dataService.getSchedules(), {
    // Automatic runs mutate nextRunAt/lastRun/auto-disable server-side while the
    // panel is open; refresh on focus and on a modest interval so it stays current.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: 60_000,
    ...config,
  });
};

/** A consent preview is immutable while open and never reused for a new dialog. */
export const useScheduledOboTargetQuery = (id: string, server: string | null) =>
  useQuery<TScheduledOboTarget, Error>(
    [QueryKeys.scheduledOboTarget, id, server],
    ({ signal }) => dataService.inspectScheduledObo(id, server!, signal),
    {
      enabled: server != null,
      cacheTime: 0,
      staleTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  );
