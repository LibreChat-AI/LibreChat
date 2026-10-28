import type { StreamHost } from '@librechat/chat/react';
import { useResumableServices } from '~/hooks/SSE/resumable';
import useSSE from '~/hooks/SSE/useSSE';

/** The app's services behind the stream bindings: the resumable stream's handlers, cache and
 *  transport, and the Assistants stream, which carries its own response. */
export const appStreamHost: StreamHost = {
  useResumableServices,
  useLegacyStream: useSSE,
};

export { StreamHostProvider, useStreamHost } from '@librechat/chat/react';
