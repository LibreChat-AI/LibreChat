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
  /** Leaves the file out (`true`) or takes it back in. */
  setExcluded: (fileId: string, excluded: boolean) => void;
  /** The last change was refused; `full` when because too many files are already left out. */
  failed: false | 'error' | 'full';
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
  const { data } = useFileExclusionQuery(conversationId, { enabled: enabled && rows.length > 0 });
  const { mutate, error, isError } = useFileExclusionMutation();
  const excluded = useMemo(() => new Set(data?.excludedFiles ?? []), [data?.excludedFiles]);
  const setExcluded = useCallback(
    (fileId: string, next: boolean) =>
      mutate({ conversationId, fileIds: [fileId], excluded: next }),
    [conversationId, mutate],
  );
  let failed: SessionFilesView['failed'] = false;
  if (isError) {
    failed = statusOf(error) === 409 ? 'full' : 'error';
  }
  return useMemo(
    () => ({ rows, excluded, setExcluded, failed }),
    [rows, excluded, setExcluded, failed],
  );
}
