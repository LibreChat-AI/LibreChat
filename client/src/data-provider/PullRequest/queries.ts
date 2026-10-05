import { useQuery } from '@tanstack/react-query';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import type { TConversationPullRequestResponse } from 'librechat-data-provider';
import type { UseQueryOptions } from '@tanstack/react-query';

const SETTLED_REFRESH_MS = 60_000;
/** Checks and conflict state change while a pull request is being worked on. */
const ACTIVE_REFRESH_MS = 20_000;

/** Poll faster only while something can still change; a finished pull request needs no polling. */
export const pullRequestRefetchInterval = (
  response: TConversationPullRequestResponse | undefined,
): number | false => {
  const pr = response?.pullRequest;
  if (pr == null) return SETTLED_REFRESH_MS;
  if (pr.state !== 'open') return false;
  return pr.checks === 'running' || pr.mergeable === 'unknown'
    ? ACTIVE_REFRESH_MS
    : SETTLED_REFRESH_MS;
};

export const useConversationPullRequestQuery = (
  conversationId: string,
  config?: UseQueryOptions<TConversationPullRequestResponse>,
) =>
  useQuery<TConversationPullRequestResponse>(
    [QueryKeys.conversationPullRequest, conversationId],
    () => dataService.getConversationPullRequest(conversationId),
    {
      enabled:
        conversationId !== '' &&
        conversationId !== Constants.NEW_CONVO &&
        conversationId !== Constants.PENDING_CONVO,
      staleTime: 15_000,
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: pullRequestRefetchInterval,
      refetchIntervalInBackground: false,
      ...config,
    },
  );
