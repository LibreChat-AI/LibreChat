import { useMemo } from 'react';
import type { TMessage } from 'librechat-data-provider';
import { hasParallelLanes } from '~/utils/lanes';

export type ContentMetadataResult = {
  /** Whether the message renders agent columns side by side */
  hasParallelContent: boolean;
};

/**
 * Hook to check if a message has parallel content — content the renderer lays
 * out as columns. Widens the message row, so it asks the same question the
 * renderer does: a group id backed by a single agent is not parallel content.
 *
 * @param message - The message to check
 * @returns ContentMetadataResult with hasParallelContent boolean
 */
export default function useContentMetadata(
  message: TMessage | null | undefined,
): ContentMetadataResult {
  return useMemo(() => {
    const content = message?.content;
    if (!content || !Array.isArray(content)) {
      return { hasParallelContent: false };
    }

    return { hasParallelContent: hasParallelLanes(content) };
  }, [message?.content]);
}
