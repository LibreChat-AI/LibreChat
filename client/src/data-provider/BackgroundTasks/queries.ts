import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Constants, MutationKeys, QueryKeys, dataService } from 'librechat-data-provider';
import type {
  BackgroundTaskCancelResponse,
  BackgroundTaskCancelRequest,
  BackgroundTaskIndex,
} from 'librechat-data-provider';
import type { UseQueryOptions } from '@tanstack/react-query';

const RUNNING_REFRESH_MS = 2_000;
/** Undelivered results wait on the agent's turn, so they change slowly. */
const AWAITING_DELIVERY_REFRESH_MS = 10_000;
const SUBMITTING_REFRESH_MS = 5_000;
const POST_SUBMIT_DISCOVERY_MS = 10_000;
const QUIET_REFRESH_MS = 60_000;

/** Fast discovery around submissions, with a visible-tab fallback for server-started work. */
export const backgroundTasksRefetchInterval = (
  index: BackgroundTaskIndex | undefined,
  isSubmitting = false,
  discoveryDeadline = 0,
  now = Date.now(),
): number | false => {
  if (index?.tasks.some((task) => task.status === 'running') === true) {
    return RUNNING_REFRESH_MS;
  }
  if (now < discoveryDeadline) return RUNNING_REFRESH_MS;
  if (isSubmitting) return SUBMITTING_REFRESH_MS;
  if (index?.tasks.some((task) => task.delivery === 'pending') === true) {
    return AWAITING_DELIVERY_REFRESH_MS;
  }
  return QUIET_REFRESH_MS;
};

export const useBackgroundTasksQuery = (
  conversationId: string,
  config?: UseQueryOptions<BackgroundTaskIndex>,
  isSubmitting = false,
) => {
  const previous = useRef({ conversationId, isSubmitting });
  const [discoveryDeadline, setDiscoveryDeadline] = useState(0);
  const query = useQuery<BackgroundTaskIndex>(
    [QueryKeys.backgroundTasks, conversationId],
    () => dataService.getBackgroundTasks(conversationId),
    {
      enabled:
        conversationId !== '' &&
        conversationId !== Constants.NEW_CONVO &&
        conversationId !== Constants.PENDING_CONVO,
      staleTime: 1_000,
      refetchOnWindowFocus: true,
      refetchInterval: (index) =>
        backgroundTasksRefetchInterval(index, isSubmitting, discoveryDeadline),
      refetchIntervalInBackground: false,
      ...config,
    },
  );

  const { refetch } = query;
  useEffect(() => {
    const last = previous.current;
    previous.current = { conversationId, isSubmitting };
    if (last.conversationId !== conversationId) {
      setDiscoveryDeadline(0);
      return;
    }
    if (last.isSubmitting && !isSubmitting && config?.enabled !== false) {
      setDiscoveryDeadline(Date.now() + POST_SUBMIT_DISCOVERY_MS);
      void refetch();
    }
  }, [conversationId, isSubmitting, refetch, config?.enabled]);

  return query;
};

export type CancelBackgroundTasksVariables = {
  conversationId: string;
  body: BackgroundTaskCancelRequest;
};

export const useCancelBackgroundTasksMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<BackgroundTaskCancelResponse, Error, CancelBackgroundTasksVariables>(
    ({ conversationId, body }) => dataService.cancelBackgroundTasks(conversationId, body),
    {
      mutationKey: [MutationKeys.cancelBackgroundTasks],
      onSettled: (_data, _error, { conversationId }) =>
        queryClient.invalidateQueries([QueryKeys.backgroundTasks, conversationId]),
    },
  );
};
