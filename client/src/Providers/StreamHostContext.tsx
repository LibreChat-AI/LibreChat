import { useMemo } from 'react';
import type { StreamHost } from '@librechat/chat/react';
import {
  useActiveJobs,
  useStreamStatus,
  useAgentQueuedTurns,
  extendActiveJobsGrace,
} from '~/data-provider';
import { useChatTransport } from '~/Providers/ChatTransportContext';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { useResumableServices } from '~/hooks/SSE/resumable';
import { useAuthContext } from '~/hooks/AuthContext';
import useSSE from '~/hooks/SSE/useSSE';

function useTransport() {
  const { token, isAuthenticated } = useAuthContext();
  const transport = useChatTransport();
  return useMemo(
    () => (isAuthenticated && token != null ? transport.stream({ token }) : null),
    [isAuthenticated, token, transport],
  );
}

/** The app's services behind the stream bindings: the resumable stream's handlers, cache and
 *  transport, the Assistants stream, which carries its own response, and the signed-in transport
 *  other feeds attach through. */
export const appStreamHost: StreamHost = {
  useResumableServices,
  useLegacyStream: useSSE,
  useTransport,
  /** Observes the receipts `useSteering` fetches, without competing for the fetch. */
  useQueuedTurnReceipts: (conversationId) => useAgentQueuedTurns(conversationId, false),
  useActiveJobs,
  extendActiveJobsGrace,
  useStreamStatus,
  useResumeSettings: (runIndex) => {
    const { config, usePaneConversation } = useChatSettings();
    return {
      configLoaded: config.loaded !== false,
      retentionMode: config.retentionMode,
      conversation: usePaneConversation(runIndex),
    };
  },
};

export { StreamHostProvider, useStreamHost } from '@librechat/chat/react';
