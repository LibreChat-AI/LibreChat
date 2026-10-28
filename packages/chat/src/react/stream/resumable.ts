import { useState, useEffect, useCallback } from 'react';
import type { TSubmission } from 'librechat-data-provider';
import type { ResumableHost } from '../../core';
import type { StreamChat } from './host';
import {
  ResumableRun,
  mountSubmission,
  releaseSubmission,
  attachResumableStream,
} from '../../core';
import { useStreamHost } from './host';

/**
 * Hook for resumable SSE streams.
 * Separates generation start (POST) from stream subscription (GET EventSource).
 * Supports auto-reconnection with exponential backoff.
 *
 * Key behavior:
 * - Navigation away does NOT abort the generation (just closes SSE)
 * - Only explicit abort (via stop button, then the backend abort endpoint) stops generation
 * - Backend emits `done` event with `aborted: true` on abort, handled via finalHandler
 *
 * The run itself is `mountSubmission` and `attachResumableStream`; the host supplies the
 * services it runs on.
 */
export default function useResumableSSE(
  submission: TSubmission | null,
  chat: StreamChat,
  isAddedRequest = false,
  runIndex = 0,
): { streamId: string | null } {
  const [run] = useState(() => new ResumableRun());
  const [streamId, setStreamId] = useState<string | null>(null);
  const buildServices = useStreamHost().useResumableServices({
    run,
    chat,
    runIndex,
    isAddedRequest,
    setStreamId,
  });

  const buildHost = useCallback(
    (): ResumableHost => ({
      ...buildServices(),
      subscribe: (next) => attachResumableStream(run, buildHost(), next),
    }),
    [run, buildServices],
  );

  useEffect(() => {
    const host = buildHost();
    if (!submission || Object.keys(submission).length === 0) {
      releaseSubmission(run, host);
      return;
    }
    return mountSubmission(run, host, submission);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission]);

  return { streamId };
}
