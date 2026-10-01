import { useMemo } from 'react';
import { DEFAULT_COMPOSER_RECENT_FILES } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { AttachExistingContext } from '~/hooks/Files/useAttachExisting';
import { useGetFiles, useGetRecentFiles, useGetStartupConfig } from '~/data-provider';
import useAttachExisting from '~/hooks/Files/useAttachExisting';

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
  const { data: startupConfig } = useGetStartupConfig();
  const recentFileCount =
    startupConfig?.interface?.composerRecentFiles ?? DEFAULT_COMPOSER_RECENT_FILES;
  const query = search.trim().toLowerCase();
  const searching = query.length > 0;
  const { data: recent } = useGetRecentFiles(recentFileCount, {
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
