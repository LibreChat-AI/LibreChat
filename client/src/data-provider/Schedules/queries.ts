/* Scheduled chats */
import { useQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';
import type { UseQueryOptions, QueryObserverResult } from '@tanstack/react-query';
import type { TSchedulesResponse } from 'librechat-data-provider';

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
