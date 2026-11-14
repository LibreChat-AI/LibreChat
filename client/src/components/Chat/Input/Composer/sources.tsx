import { useCallback } from 'react';
import type {
  PaletteSources,
  PaletteSourcesInput,
  PaletteCatalogSection,
} from '@librechat/chat/react';
import type { TToolFavoriteType } from 'librechat-data-provider';
import type { PaletteEntry } from '~/hooks/Input/usePaletteEntries';
import { SharePointPickerDialog } from '~/components/SharePoint';
import useToolFavorites from '~/hooks/Input/useToolFavorites';
import useRecentFiles from '~/hooks/Input/useRecentFiles';
import useAttachItems from '~/hooks/Input/useAttachItems';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import { useBadgeRowContext } from '~/Providers';
import { isUnifiedUploadMode } from '~/utils';
import Catalog from './Catalog';

/** The sections `Catalog` lists in full behind their "Show all" button. */
const CATALOGS: readonly PaletteCatalogSection[] = ['skill', 'mcp', 'files'];

/**
 * Favorites, upload destinations, recent files and the dialogs the palette hands off to.
 * The package draws the list; these reads stay here because they are the app's queries,
 * permissions and file pickers.
 */
export function usePaletteSources(input: PaletteSourcesInput): PaletteSources {
  const context = useBadgeRowContext();
  const mcpManager = context?.mcpServerManager;
  const configDialogOpen = mcpManager?.getConfigDialogProps()?.isOpen === true;
  /* The MCP catalog shows the same live statuses as the palette rows, so it keeps the refresh
     running after the palette hands over to it. */
  useMCPRefresh({
    enabled:
      (input.open || configDialogOpen || input.catalog === 'mcp') &&
      (mcpManager?.availableMCPServers.length ?? 0) > 0,
  });
  const favorites = useToolFavorites();
  const recent = useRecentFiles(
    input.mounted && input.canAttach,
    {
      files: input.files,
      setFiles: input.setFiles,
      conversation: input.conversation,
      endpoint: input.endpoint,
      endpointType: input.endpointType,
      endpointFileConfig: input.endpointFileConfig,
    },
    input.search,
  );
  const toggle = useCallback(
    (itemType: string, itemId: string) =>
      favorites.toggleFavorite(itemType as TToolFavoriteType, itemId),
    [favorites],
  );
  const attach = useAttachItems({
    index: input.index,
    agentId: input.agentId,
    endpoint: input.endpoint,
    endpointType: input.endpointType,
    endpointFileConfig: input.endpointFileConfig,
    useResponsesApi: input.useResponsesApi,
    conversationId: input.conversationId,
    conversation: input.conversation,
    files: input.files,
    setFiles: input.setFiles,
    setFilesLoading: input.setFilesLoading,
    isUnifiedMode: isUnifiedUploadMode(input.endpointFileConfig, input.canAttach),
  });

  return {
    favorites: true,
    favoriteKeys: favorites.keys,
    toggleFavorite: toggle,
    attachEntries: attach.entries,
    fileInputRef: attach.inputRef,
    onFileChange: attach.onFileChange,
    recentFiles: recent.files,
    attachFile: recent.attach,
    catalogs: CATALOGS,
    overlays: (
      <>
        <SharePointPickerDialog
          isOpen={attach.isSharePointDialogOpen}
          onOpenChange={attach.setIsSharePointDialogOpen}
          onFilesSelected={attach.onSharePointFilesSelected}
          isDownloading={attach.isProcessing}
          downloadProgress={attach.downloadProgress}
          maxSelectionCount={attach.maxSelectionCount}
        />
        <Catalog
          section={input.catalog}
          onClose={input.closeCatalog}
          entries={input.entries as PaletteEntry[]}
          returnFocusRef={input.catalogReturnRef}
          onAttach={(file) => {
            input.closeCatalog();
            recent.attach(file);
          }}
        />
      </>
    ),
  };
}
