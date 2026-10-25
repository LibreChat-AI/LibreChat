import { useCallback } from 'react';
import type { TPromptGroup, TResolvedPromptResponse } from 'librechat-data-provider';
import { useResolvePromptGroup, useResolvePromptGroupFn } from '~/data-provider';
import { isExternalPromptGroup } from '~/utils';

export interface PromptContent {
  /** The prompt text to use: production text for a native group, the live
   *  Langfuse read for an external one. */
  text: string;
  /** The raw `/resolve` response, present only for an externally managed
   *  group; callers read `version`, `labels` and `sourceUrl` from it when
   *  `resolved.source === 'langfuse'`. */
  resolved?: TResolvedPromptResponse;
  isLoading: boolean;
  error: unknown;
  /** Re-issues the live Langfuse resolve after a failure. A no-op for a native
   *  group, which never requests the server. */
  refetch: () => void;
}

/**
 * Switches a prompt group's content between its two sources: a native
 * group's `productionPrompt` is already loaded with the group, so this
 * reads it directly with no request; an externally managed group (for
 * example Langfuse) has no stored content, so this resolves it live through
 * `useResolvePromptGroup`. `useResolvePromptGroup` is always called, since
 * hook calls cannot be conditional, but it is disabled for a native group so
 * no request is made.
 */
export default function usePromptContent(
  group: TPromptGroup | undefined,
  options?: { enabled?: boolean },
): PromptContent {
  const enabled = options?.enabled ?? true;
  const isExternal = isExternalPromptGroup(group);

  const query = useResolvePromptGroup(group?._id ?? '', {
    enabled: enabled && isExternal && Boolean(group?._id),
  });

  if (!isExternal) {
    return {
      text: group?.productionPrompt?.prompt ?? '',
      resolved: undefined,
      isLoading: false,
      error: undefined,
      refetch: () => {},
    };
  }

  return {
    text: query.data?.prompt ?? '',
    resolved: query.data,
    // `isInitialLoading` (unlike `isLoading`) is false while the query is
    // disabled, so a native group or a not-yet-enabled Langfuse one never
    // reads as loading.
    isLoading: query.isInitialLoading,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/**
 * Imperative counterpart to `usePromptContent`, for a caller that resolves a
 * group's text once (for example a slash-command submit) rather than
 * rendering against a query. Native resolution never requests the server.
 */
export function usePromptContentResolver(): (group: TPromptGroup) => Promise<string> {
  const fetchResolved = useResolvePromptGroupFn();
  return useCallback(
    (group: TPromptGroup): Promise<string> => {
      if (!isExternalPromptGroup(group)) {
        return Promise.resolve(group.productionPrompt?.prompt ?? '');
      }
      return fetchResolved(group._id ?? '').then((resolved) => resolved.prompt);
    },
    [fetchResolved],
  );
}
