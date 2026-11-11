import { useInfiniteQuery } from '@tanstack/react-query';
import { QueryKeys, dataService } from 'librechat-data-provider';

/** Share paged installation metadata without sharing cache entries between accounts/tenants. */
export function useSlackWorkspaces(principalKey: string, enabled = true) {
  return useInfiniteQuery(
    [QueryKeys.slackWorkspaces, principalKey],
    ({ pageParam }: { pageParam?: string }) => dataService.getSlackWorkspaces(pageParam),
    { enabled, retry: false, cacheTime: 0, getNextPageParam: (page) => page.next },
  );
}
