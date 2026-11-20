import React, { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { MCPIcon, IconButton } from '@librechat/client';
import { ComposerChip as Chip } from '@librechat/chat/components';
import type { PaletteEntry } from '~/hooks/Input/usePaletteEntries';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import { useBadgeRowContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import Catalog from './Catalog';

/** The bar key of the MCP Servers control. Not `mcp:`-prefixed, so it cannot
 *  collide with the `mcp:${serverName}` chip of a selected server. */
export const SERVERS_KEY = 'mcp-servers';

const noop = () => {};

/**
 * The MCP Servers quick control, pinned like the built-in tools: seeded once by
 * `interface.defaultPinnedTools` (`'mcp'` or a server name), then the user's own
 * choice. The palette lists only its first few servers, so this opens the full
 * list in one step. Null while unpinned or when there is no server to list.
 */
export function useServersEntry(entries: PaletteEntry[], onOpen: () => void): PaletteEntry | null {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const manager = context?.mcpServerManager;
  const isPinned = manager?.isPinned === true;
  const setIsPinned = manager?.setIsPinned;
  /* MCP rows exist only when this endpoint takes tools, the role may use MCP
     and the chat menu offers a server, so they carry every gate at once. */
  const listable = useMemo(() => entries.some((entry) => entry.section === 'mcp'), [entries]);
  const label = localize('com_ui_mcp_servers');

  return useMemo<PaletteEntry | null>(() => {
    if (!listable || !isPinned || setIsPinned == null) {
      return null;
    }
    return {
      key: SERVERS_KEY,
      itemType: 'mcp',
      itemId: SERVERS_KEY,
      label,
      icon: <MCPIcon className="h-4 w-4" aria-hidden="true" />,
      section: 'mcp',
      active: false,
      pinned: true,
      favoritable: false,
      onSelect: onOpen,
      onUnpin: () => setIsPinned(false),
    };
  }, [listable, isPinned, setIsPinned, label, onOpen]);
}

interface ServersChipProps {
  entry: PaletteEntry;
  /** Where focus returns when the dialog it opens closes. */
  triggerRef: React.Ref<HTMLButtonElement>;
}

/** A pinned chip like the built-in tools', whose `+` opens the full server list. */
export function ServersChip({ entry, triggerRef }: ServersChipProps) {
  const localize = useLocalize();
  return (
    <Chip
      label={entry.label}
      icon={entry.icon}
      trailing={
        <IconButton
          ref={triggerRef}
          label={localize('com_ui_composer_show_all_label', { 0: entry.label })}
          size="xs"
          className="-mr-1"
          aria-haspopup="dialog"
          onClick={entry.onSelect}
        >
          <Plus className="text-text-secondary size-3" aria-hidden="true" />
        </IconButton>
      }
      onRemove={entry.onUnpin}
      removeLabel={localize('com_ui_unpin')}
      data-testid="composer-mcp-servers"
    />
  );
}

interface ServersCatalogProps {
  open: boolean;
  onClose: () => void;
  entries: PaletteEntry[];
  returnFocusRef: React.RefObject<HTMLElement | null>;
}

/** The palette's own MCP "Show all" dialog, opened from the chip instead. */
export function ServersCatalog({ open, onClose, entries, returnFocusRef }: ServersCatalogProps) {
  /* The cards show live connection states, as they do behind the palette. */
  useMCPRefresh({ enabled: open });
  return (
    <Catalog
      section={open ? 'mcp' : null}
      onClose={onClose}
      entries={entries}
      onAttach={noop}
      returnFocusRef={returnFocusRef}
    />
  );
}
