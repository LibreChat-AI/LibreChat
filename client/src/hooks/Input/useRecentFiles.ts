import { useMemo } from 'react';
import type { TFile } from 'librechat-data-provider';
import type { AttachExistingContext } from '~/hooks/Files/useAttachExisting';
import { useGetFiles, useGetRecentFiles } from '~/data-provider';
import useAttachExisting from '~/hooks/Files/useAttachExisting';

/** How many recent uploads the unsearched palette shows; kept in step with the
 *  server `?limit=` so we never fetch more than we will render. */
export const RECENT_FILE_COUNT = 5;

/**
 * The user's files for the composer palette attach section.
 *
 * Unsearched: a short server-sorted page of the most recently touched files
 * (opened only while the palette is open). Searching: the full list, filtered
 * client-side by filename: the palette is a shortcut when idle, a finder
 * once the user starts typing.
 */
export default function useRecentFiles(
  enabled: boolean,
  context: AttachExistingContext,
  search = '',
): {
  files: TFile[];
  attach: (file: TFile) => void;
} {
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const { data: recent } = useGetRecentFiles(RECENT_FILE_COUNT, {
    enabled: enabled && !searching,
  });
  const { data: all } = useGetFiles<TFile[]>({ enabled: enabled && searching });
  const attach = useAttachExisting(context);

  const files = useMemo(() => {
    if (searching) {
      return (all ?? []).filter((file) => file.filename?.toLowerCase().includes(query));
    }
    return recent ?? [];
  }, [searching, query, all, recent]);

  return { files, attach };
}
