import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { TSubmission } from 'librechat-data-provider';
import type { StreamChat } from './host';
import useResumableSSE from './resumable';
import { useStreamHost } from './host';

/**
 * Adaptive SSE hook that switches between standard and resumable modes.
 * Uses resumable streams by default, falls back to the host's standard SSE for assistants
 * endpoints.
 *
 * Note: Both hooks are always called to comply with React's Rules of Hooks.
 * We pass null submission to the inactive one.
 */
export default function useAdaptiveSSE(
  submission: TSubmission | null,
  chat: StreamChat,
  isAddedRequest = false,
  runIndex = 0,
): { streamId: string | null; resumableEnabled: boolean } {
  const endpoint = submission?.conversation?.endpoint;
  const endpointType = submission?.conversation?.endpointType;
  const actualEndpoint = endpointType ?? endpoint;
  const isAssistants = isAssistantsEndpoint(actualEndpoint);
  const resumableEnabled = !isAssistants;

  useStreamHost().useLegacyStream(
    resumableEnabled ? null : submission,
    chat,
    isAddedRequest,
    runIndex,
  );

  const { streamId } = useResumableSSE(
    resumableEnabled ? submission : null,
    chat,
    isAddedRequest,
    runIndex,
  );

  return { streamId, resumableEnabled };
}
