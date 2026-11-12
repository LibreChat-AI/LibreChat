import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type {
  TStartupConfig,
  TPullRequestConnectStart,
  TPullRequestConnection,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import { useGetStartupConfig } from '../Endpoints';

/**
 * The credential the server looks this user's pull requests up with, as the status shows it:
 * the user's own account (the grant a given sign-in produced, when the server names it) or the
 * server's token, on the provider the deployment now uses.
 */
const credentialOf = (status: TPullRequestConnection): string =>
  status.connected
    ? `user:${status.provider ?? ''}:${status.flowId ?? ''}`
    : `server:${status.provider ?? ''}`;

/** Per app, the credential its cached pull requests were last refreshed under. */
const refreshedUnder = new Map<QueryClient, string>();

/**
 * Refetches every cached pull request under the credential the server now uses. In-flight loads
 * are cancelled first: an invalidation alone joins a first load that is still running, so one
 * that started with the old credential would land afterwards and stand.
 */
function refetchPullRequests(queryClient: QueryClient): void {
  void queryClient
    .cancelQueries([QueryKeys.conversationPullRequest])
    .then(() => queryClient.invalidateQueries([QueryKeys.conversationPullRequest]));
}

/** Every app that has asked for the status, so the session reset reaches its cache even when no
 *  answer was ever synced there (Settings closed before the first status arrived). */
const statusClients = new Set<QueryClient>();

/** Counts sessions, so work a session started does not touch the next one's cache. */
let epoch = 0;

/** Forgets every app's credential with the session, so the next one starts from its own. */
export function resetPullRequestCredentials(): void {
  /** The status cached for the account that is leaving is not the next one's: an account switch
   *  without a logout keeps the query cache, so it is reset (and refetched where watched). */
  for (const queryClient of new Set([...statusClients, ...refreshedUnder.keys()])) {
    void queryClient.resetQueries([QueryKeys.pullRequestConnection]);
  }
  refreshedUnder.clear();
  epoch += 1;
}

/**
 * Reads the status afresh and syncs pull requests to it, with or without Settings open: an
 * invalidation alone refetches only a status something is still watching. A request already in
 * flight is cancelled first, since it may have been sent before the change it must observe.
 */
async function reconcileConnection(queryClient: QueryClient, startedIn: number): Promise<void> {
  await queryClient.cancelQueries([QueryKeys.pullRequestConnection]);
  const status = await queryClient.fetchQuery<TPullRequestConnection>(
    [QueryKeys.pullRequestConnection],
    () => dataService.getPullRequestConnection(),
    { staleTime: 0, retry: false },
  );
  if (startedIn === epoch) {
    syncPullRequestConnection(queryClient, status);
  }
}

/**
 * Refetches every cached pull request when a status shows a different credential than the one
 * they were last refreshed under: connecting, disconnecting, or a connection moving to another
 * provider. The first status of a session always refreshes them once, whatever it says, since
 * pull requests fetched before it may have used a grant this app never saw. Every path that
 * learns the status goes through here, so a change refetches pull requests once.
 */
export function syncPullRequestConnection(
  queryClient: QueryClient,
  status: TPullRequestConnection,
): void {
  const credential = credentialOf(status);
  const previous = refreshedUnder.get(queryClient);
  refreshedUnder.set(queryClient, credential);
  if (previous === credential) {
    return;
  }
  refetchPullRequests(queryClient);
}

/**
 * Whether asking for the connection can find anything: on any deployment with pull requests on,
 * not only one advertising an app to connect, because a grant made before the app was turned off
 * must still be found to be disconnected.
 */
const isConnectionKnowable = (startupConfig?: Partial<TStartupConfig>): boolean =>
  startupConfig?.pullRequestsEnabled === true || startupConfig?.pullRequestsConnect != null;

/**
 * Whether the signed-in user has connected their own account. Asked on a deployment with pull
 * requests on, and again when the window regains focus; a sign-in in progress is
 * watched by `watchPullRequestSignIn`, which outlives this hook. A change in either direction
 * swaps the token the server looks pull requests up with, so every cached pull request is
 * refetched.
 */
export const usePullRequestConnectionQuery = () => {
  const queryClient = useQueryClient();
  statusClients.add(queryClient);
  const { data: startupConfig } = useGetStartupConfig();
  const query = useQuery<TPullRequestConnection>(
    [QueryKeys.pullRequestConnection],
    () => dataService.getPullRequestConnection(),
    {
      enabled: isConnectionKnowable(startupConfig),
      retry: false,
      refetchOnWindowFocus: true,
      /** The row renders inside Settings, whose visibility check (`usePullRequestConnectionStatus`)
       *  asks as Settings mounts; the row reuses that answer instead of asking again. */
      refetchOnMount: false,
    },
  );

  const { data } = query;
  useEffect(() => {
    if (data != null) {
      syncPullRequestConnection(queryClient, data);
    }
  }, [data, queryClient]);

  return query;
};

/**
 * The same status for what contains the Settings row, so an app the server no longer has hides
 * the whole section, and a later answer that it has one again brings the section back. It shares
 * the row's query.
 */
export const usePullRequestConnectionStatus = () => {
  const queryClient = useQueryClient();
  statusClients.add(queryClient);
  const { data: startupConfig } = useGetStartupConfig();
  const { data } = useQuery<TPullRequestConnection>(
    [QueryKeys.pullRequestConnection],
    () => dataService.getPullRequestConnection(),
    {
      enabled: isConnectionKnowable(startupConfig),
      retry: false,
      refetchOnWindowFocus: true,
    },
  );
  /** Synced here too: a status that hides the row (a grant removed while its app is off) must
   *  still refetch pull requests looked up with that grant. A status already synced is a no-op. */
  useEffect(() => {
    if (data != null) {
      syncPullRequestConnection(queryClient, data);
    }
  }, [data, queryClient]);
  return data;
};

/** Starts the provider's sign-in; the caller navigates a window it opened to the returned url. */
export const useConnectPullRequestAccountMutation = () =>
  useMutation<TPullRequestConnectStart, unknown, void>({
    mutationKey: [MutationKeys.connectPullRequestAccount],
    mutationFn: () => dataService.connectPullRequestAccount(),
  });

export const useDisconnectPullRequestAccountMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, void, number>({
    mutationKey: [MutationKeys.disconnectPullRequestAccount],
    mutationFn: () => dataService.disconnectPullRequestAccount(),
    /** The session the disconnect was sent in: an answer after it ended belongs to nobody here. */
    onMutate: () => epoch,
    onSuccess: (_data, _variables, startedIn) => {
      if (startedIn !== epoch) {
        return;
      }
      const status = queryClient.setQueryData<TPullRequestConnection>(
        [QueryKeys.pullRequestConnection],
        (current) => (current == null ? current : { ...current, connected: false }),
      );
      queryClient.invalidateQueries([QueryKeys.pullRequestConnection]);
      /** A disconnect always leaves the server's token, whatever this app saw before. */
      refreshedUnder.set(
        queryClient,
        credentialOf({ configured: true, provider: status?.provider, connected: false }),
      );
      refetchPullRequests(queryClient);
    },
    /** A failed request may still have ended the connection (the server fences the grant before
     *  removing it), so the status is asked again and a change refetches pull requests. A status
     *  read that fails too leaves the status invalidated for the next look at it. */
    onError: (_error, _variables, startedIn) => {
      if (startedIn == null || startedIn !== epoch) {
        return;
      }
      reconcileConnection(queryClient, startedIn).catch(() =>
        queryClient.invalidateQueries([QueryKeys.pullRequestConnection]),
      );
    },
  });
};
