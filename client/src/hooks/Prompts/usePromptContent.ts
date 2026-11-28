import { useCallback } from 'react';
import type {
  TPromptGroup,
  PromptSelection,
  TResolvedPromptResponse,
} from 'librechat-data-provider';
import {
  isExternalPromptGroup,
  PromptContentBlockedError,
  PromptRevisionNotFoundError,
} from '~/utils';
import { useGetPrompts, useResolvePromptGroup, useResolvePromptGroupFn } from '~/data-provider';

export interface PromptContent {
  /** The prompt text to use: the selected revision's text for a native group,
   *  the live Langfuse read for an external one. */
  text: string;
  /** The raw `/resolve` response, present only for an externally managed
   *  group; callers read `version`, `labels` and `sourceUrl` from it when
   *  `resolved.source === 'langfuse'`. */
  resolved?: TResolvedPromptResponse;
  isLoading: boolean;
  error: unknown;
  /** Re-issues the request after a failure. A no-op for a native group's
   *  Production, which never requests the server. */
  refetch: () => void;
}

/**
 * Switches a prompt group's content between its sources. `selection` picks
 * the revision and defaults to Production:
 * - native Production: the group's `productionPrompt`, already loaded with
 *   the group, so no request is made;
 * - native exact: the revision with `promptId`, read from the group's prompt
 *   list;
 * - Langfuse: resolved live through `useResolvePromptGroup`, by Production or
 *   by the exact `version`.
 * Every query is always called, since hook calls cannot be conditional, and
 * is gated by `enabled` so only the selected source makes a request.
 */
export default function usePromptContent(
  group: TPromptGroup | undefined,
  options?: { enabled?: boolean; selection?: PromptSelection },
): PromptContent {
  const enabled = options?.enabled ?? true;
  const selection = options?.selection;
  const groupId = group?._id ?? '';
  const isExternal = isExternalPromptGroup(group);
  const exactPromptId =
    !isExternal && selection?.type === 'exact' && 'promptId' in selection
      ? selection.promptId
      : undefined;
  const exactVersion =
    isExternal && selection?.type === 'exact' && 'version' in selection
      ? selection.version
      : undefined;

  const resolveQuery = useResolvePromptGroup(groupId, {
    enabled: enabled && isExternal && groupId !== '',
    version: exactVersion,
  });
  // Reloads on each mount, so a revision added after the list was cached is found.
  const promptsQuery = useGetPrompts(
    { groupId },
    { enabled: enabled && exactPromptId != null && groupId !== '', refetchOnMount: 'always' },
  );

  if (exactPromptId != null) {
    const prompts = promptsQuery.data;
    const revision = Array.isArray(prompts)
      ? prompts.find((prompt) => prompt._id === exactPromptId)
      : undefined;
    // Waits for the reload, so cached text never shows for a revision since blocked or deleted.
    const isLoading = promptsQuery.isInitialLoading || promptsQuery.isFetching;
    let error: unknown = promptsQuery.error;
    let text = '';
    if (error == null && !isLoading && promptsQuery.isSuccess) {
      // A 200 with `{ message }` instead of a list is a load failure, not a missing revision.
      if (!Array.isArray(prompts)) {
        error = new Error('Prompt list failed to load');
      } else if (revision == null) {
        error = new PromptRevisionNotFoundError();
      } else if (revision.contentFilterBlocked === true) {
        error = new PromptContentBlockedError();
      } else {
        text = revision.prompt;
      }
    }
    return {
      text,
      resolved: undefined,
      isLoading,
      error,
      refetch: () => void promptsQuery.refetch(),
    };
  }

  if (!isExternal) {
    const blocked = group?.productionPrompt?.contentFilterBlocked === true;
    return {
      text: blocked ? '' : (group?.productionPrompt?.prompt ?? ''),
      resolved: undefined,
      isLoading: false,
      error: blocked ? new PromptContentBlockedError() : undefined,
      refetch: () => {},
    };
  }

  return {
    text: resolveQuery.data?.prompt ?? '',
    resolved: resolveQuery.data,
    // `isInitialLoading` (unlike `isLoading`) is false while the query is
    // disabled, so a native group or a not-yet-enabled Langfuse one never
    // reads as loading.
    isLoading: resolveQuery.isInitialLoading,
    error: resolveQuery.error,
    refetch: () => void resolveQuery.refetch(),
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
