import { useQuery } from '@tanstack/react-query';
import { Constants, QueryKeys, dataService } from 'librechat-data-provider';
import type { TConversationPullRequestResponse } from 'librechat-data-provider';
import type { UseQueryOptions } from '@tanstack/react-query';
import { createPullRequestBatcher } from './batch';
import { useGetStartupConfig } from '../Endpoints';

const SETTLED_REFRESH_MS = 60_000;
/** Checks and conflict state change while a pull request is being worked on. */
const ACTIVE_REFRESH_MS = 20_000;

/**
 * Poll faster only while something can still change. A closed or merged pull request has no
 * mergeability left to settle, but its checks can still be running, so those keep the active
 * interval until they finish; only then does polling stop.
 */
export const pullRequestRefetchInterval = (
  response: TConversationPullRequestResponse | undefined,
): number | false => {
  const pr = response?.pullRequest;
  if (pr == null) return SETTLED_REFRESH_MS;
  if (pr.checks === 'running') return ACTIVE_REFRESH_MS;
  if (pr.state !== 'open') return false;
  return pr.mergeable === 'unknown' ? ACTIVE_REFRESH_MS : SETTLED_REFRESH_MS;
};

const isSavedConversation = (conversationId: string) =>
  conversationId !== '' &&
  conversationId !== Constants.NEW_CONVO &&
  conversationId !== Constants.PENDING_CONVO;

/**
 * Asks only when the deployment advertises the feature and the conversation is a saved one, so a
 * default installation never calls the endpoint. The server answers no pull request for a chat
 * that has no code lane, which keeps a non-code chat to one cheap, slow poll.
 */
export const useConversationPullRequestQuery = (
  conversationId: string,
  config?: UseQueryOptions<TConversationPullRequestResponse>,
) => {
  const { data: startupConfig } = useGetStartupConfig();
  return useQuery<TConversationPullRequestResponse>(
    [QueryKeys.conversationPullRequest, conversationId],
    () => dataService.getConversationPullRequest(conversationId),
    {
      enabled: startupConfig?.pullRequestsEnabled === true && isSavedConversation(conversationId),
      staleTime: 15_000,
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: pullRequestRefetchInterval,
      refetchIntervalInBackground: false,
      ...config,
    },
  );
};

/** One batcher for the app: every sidebar row mounted in the same moment shares one request. */
const rowBatcher = createPullRequestBatcher({
  fetchMany: (conversationIds) => dataService.getConversationPullRequests(conversationIds),
});

/**
 * The pull request of a sidebar row. It shares its cache entry with the header's query, so the
 * open conversation is never fetched twice, but it never polls: a list of rows would otherwise
 * poll GitHub once per row. It refreshes when the window regains focus and a row's answer is
 * older than a minute; every mounted row asks in the same moment, so the batcher turns that
 * into one request for the whole list rather than one per row.
 */
export const useRowPullRequestQuery = (conversationId: string) => {
  const { data: startupConfig } = useGetStartupConfig();
  return useQuery<TConversationPullRequestResponse>(
    [QueryKeys.conversationPullRequest, conversationId],
    () => rowBatcher.load(conversationId),
    {
      enabled: startupConfig?.pullRequestsEnabled === true && isSavedConversation(conversationId),
      staleTime: SETTLED_REFRESH_MS,
      retry: false,
      refetchOnWindowFocus: true,
    },
  );
};
