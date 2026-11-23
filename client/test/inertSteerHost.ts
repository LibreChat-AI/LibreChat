import type { SteerHost } from '@librechat/chat/react';

/** A steer host whose transport does nothing, for specs that mount the package list
 *  outside the app shell. */
export const inertSteerHost: SteerHost = {
  useSteerMessage: () => () => undefined,
  useSteerMessageAsync: () => async () => ({
    status: 'queued',
    steerId: 'steer-1',
    position: 0,
    conversationId: 'convo-1',
  }),
  useCancelSteer: () => async () => ({ removed: true }),
  useArmSteer: () => async () => ({ armed: true }),
  useMarkFilesUsage: () => () => undefined,
  useEnqueueQueuedTurn: () => () => undefined,
  useCancelQueuedTurn: () => async () => {
    throw new Error('not queued');
  },
  useQueuedTurns: () => undefined,
  useQueuedTurnCache: () => ({ read: () => ({}), subscribe: () => () => undefined }),
  useFetchStreamStatus: () => async () => ({ active: false }),
  useRouteConversationId: () => undefined,
  useCodeApprovalInputs: () => ({ conversation: null, reachable: { agents: [], complete: true } }),
  useLocalize: () => (key) => key,
  useNotify: () => () => undefined,
  useFileMap: () => undefined,
  useClearFilesToDelete: () => () => undefined,
  useSettings: () => ({
    duringRunDefaultAction: 'steer',
    setDuringRunDefaultAction: () => undefined,
    getPaneConversations: () => [],
  }),
};
