import { useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { QueryKeys } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { FileRow } from './files';
import { useFileExclusionMutation, useFileExclusionQuery } from '~/data-provider';
import { collectFiles } from './files';

export type SessionFilesView = {
  rows: FileRow[];
  /** Ids the conversation leaves out of later turns. */
  excluded: ReadonlySet<string>;
  /**
   * Whether `excluded` is what the conversation has stored. Until it is, a switch would show a
   * guess, and moving one would send the opposite of what its reader meant.
   */
  known: boolean;
  /** Leaves the file out (`true`) or takes it back in. Does nothing until the list is known. */
  setExcluded: (fileId: string, excluded: boolean) => void;
  /**
   * `load`: the stored list could not be read. Otherwise the last change was refused, `full`
   * when because too many files are already left out.
   */
  failed: false | 'load' | 'error' | 'full';
  /** Reads the stored list again. */
  retry: () => void;
};

const noRows: FileRow[] = [];

const statusOf = (error: unknown): number | undefined =>
  (error as { response?: { status?: number } } | null)?.response?.status;

/**
 * The files of a conversation and which of them it leaves out. Reads the loaded messages
 * without fetching, and only while `enabled`: structural sharing of the selected rows ignores
 * streaming text, so a response arriving does not render the list again.
 */
export default function useSessionFiles({
  conversationId,
  enabled,
}: {
  conversationId: string;
  enabled: boolean;
}): SessionFilesView {
  const select = useCallback(
    (messages: TMessage[]) => (enabled ? collectFiles(messages) : noRows),
    [enabled],
  );
  const { data: rows = noRows } = useQuery<TMessage[], unknown, FileRow[]>({
    queryKey: [QueryKeys.messages, conversationId],
    enabled: false,
    select,
  });
  const {
    data,
    refetch,
    isError: loadFailed,
  } = useFileExclusionQuery(conversationId, { enabled: enabled && rows.length > 0 });
  const { mutate, error, isError } = useFileExclusionMutation();
  const known = data != null;
  const excluded = useMemo(() => new Set(data?.excludedFiles ?? []), [data?.excludedFiles]);
  const setExcluded = useCallback(
    (fileId: string, next: boolean) => {
      if (known) {
        mutate({ conversationId, fileIds: [fileId], excluded: next });
      }
    },
    [conversationId, known, mutate],
  );
  const retry = useCallback(() => void refetch(), [refetch]);
  let failed: SessionFilesView['failed'] = false;
  if (!known && loadFailed) {
    failed = 'load';
  } else if (isError) {
    failed = statusOf(error) === 409 ? 'full' : 'error';
  }
  return useMemo(
    () => ({ rows, excluded, known, setExcluded, failed, retry }),
    [rows, excluded, known, setExcluded, failed, retry],
  );
}
