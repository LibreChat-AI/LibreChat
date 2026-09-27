import React, { useMemo, useState } from 'react';
import {
  Input,
  Button,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { AgentItem } from '~/components/SidePanel/Agents/Tools/items/types';
import type { PaletteEntry } from '~/hooks/Input/usePaletteEntries';
import type { TranslationKeys } from '~/hooks';
import MarketplaceCatalog from '~/components/SidePanel/Agents/Tools/MarketplaceCatalog';
import { itemKey } from '~/components/SidePanel/Agents/Tools/items/selectors';
import FilePreview from '~/components/Chat/Input/Files/FilePreview';
import { useLocalize, useToolFavorites } from '~/hooks';
import { useGetFiles } from '~/data-provider';
import { getFileType } from '~/utils';

export type CatalogSection = 'skill' | 'mcp' | 'files';

const TITLE: Record<CatalogSection, TranslationKeys> = {
  skill: 'com_ui_skills',
  mcp: 'com_ui_mcp_servers',
  files: 'com_ui_composer_files',
};

const SEARCH: Record<CatalogSection, TranslationKeys> = {
  skill: 'com_ui_composer_search_skills',
  mcp: 'com_ui_composer_search_mcp',
  files: 'com_ui_composer_search_files',
};

/** The palette row as the agent builder's card expects it. Rows without a
 *  catalog record (a skill staged by name before the catalog loaded) have no
 *  card to show and are left to the chip in the bar. */
function toItem(entry: PaletteEntry): AgentItem | null {
  if (entry.section === 'skill') {
    if (entry.skill == null) {
      return null;
    }
    return {
      kind: 'skill',
      id: entry.itemId,
      name: entry.label,
      description: entry.description ?? '',
      iconKey: 'skill',
      skill: entry.skill,
    };
  }
  if (entry.section === 'mcp') {
    return {
      kind: 'mcp',
      id: entry.itemId,
      name: entry.label,
      description: entry.description ?? '',
      iconKey: 'mcp',
      toolCount: 0,
      server: {
        serverName: entry.itemId,
        tools: [],
        isConfigured: true,
        isConnected: true,
        metadata: { name: entry.label, pluginKey: entry.itemId, icon: entry.iconUrl },
      },
    };
  }
  return null;
}

const matches = (query: string, ...fields: Array<string | undefined>) =>
  query === '' || fields.some((field) => field?.toLowerCase().includes(query) === true);

function EntryGrid({
  section,
  entries,
  query,
}: {
  section: 'skill' | 'mcp';
  entries: PaletteEntry[];
  query: string;
}) {
  const localize = useLocalize();
  const { favoriteKeys, toggle } = useToolFavorites();

  const { items, selectedIds, byKey } = useMemo(() => {
    const nextItems: AgentItem[] = [];
    const selected = new Set<string>();
    const keyed = new Map<string, PaletteEntry>();
    for (const entry of entries) {
      if (entry.section !== section || !matches(query, entry.label, entry.description)) {
        continue;
      }
      const item = toItem(entry);
      if (item == null) {
        continue;
      }
      const key = itemKey(item);
      nextItems.push(item);
      keyed.set(key, entry);
      if (entry.active) {
        selected.add(key);
      }
    }
    return { items: nextItems, selectedIds: selected, byKey: keyed };
  }, [entries, section, query]);

  return (
    <MarketplaceCatalog
      items={items}
      selectedIds={selectedIds}
      onToggle={(item) => byKey.get(itemKey(item))?.onSelect()}
      favoriteKeys={favoriteKeys}
      onToggleFavorite={toggle}
      emptyKey="com_ui_composer_no_results"
      ariaLabel={localize(TITLE[section])}
    />
  );
}

function FileList({ query, onAttach }: { query: string; onAttach: (file: TFile) => void }) {
  const localize = useLocalize();
  const { data: files = [] } = useGetFiles<TFile[]>();
  const visible = useMemo(
    () => files.filter((file) => matches(query, file.filename)),
    [files, query],
  );

  if (visible.length === 0) {
    return (
      <p role="status" className="text-text-secondary py-16 text-center text-sm">
        {localize('com_ui_composer_no_results')}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1" aria-label={localize('com_ui_composer_files')}>
      {visible.map((file) => (
        <li key={file.file_id}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onAttach(file)}
            className="h-auto w-full justify-start text-left"
          >
            <FilePreview
              file={file}
              fileType={getFileType(file.type)}
              className="size-8 shrink-0 rounded-md"
            />
            <span className="min-w-0 flex-1 truncate">{file.filename}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

interface CatalogProps {
  section: CatalogSection | null;
  onClose: () => void;
  entries: PaletteEntry[];
  onAttach: (file: TFile) => void;
  /** Where focus returns on close: the palette that opened this is gone. */
  returnFocusRef: React.RefObject<HTMLElement | null>;
}

/**
 * Everything behind a palette section's "Show all": the palette keeps a short
 * list per section, and this is where the rest of it lives. Skills and MCP
 * servers reuse the agent builder's card grid, toggled through the same
 * handlers as the palette rows so the two cannot disagree.
 */
export default function Catalog({
  section,
  onClose,
  entries,
  onAttach,
  returnFocusRef,
}: CatalogProps) {
  const localize = useLocalize();
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState(section);
  if (section !== shown) {
    setShown(section);
    if (section != null) {
      setSearch('');
    }
  }
  const current = section ?? shown;
  const query = search.trim().toLowerCase();

  return (
    <OGDialog
      open={section != null}
      triggerRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      {current != null && (
        <OGDialogContent className="flex h-[80vh] max-h-[720px] w-11/12 max-w-[960px] flex-col overflow-hidden">
          <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
            <div className="flex flex-col gap-3 pr-8">
              <OGDialogTitle>{localize(TITLE[current])}</OGDialogTitle>
              <OGDialogDescription className="sr-only">
                {localize(SEARCH[current])}
              </OGDialogDescription>
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={localize(SEARCH[current])}
                aria-label={localize(SEARCH[current])}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {current === 'files' ? (
                <FileList query={query} onAttach={onAttach} />
              ) : (
                <EntryGrid section={current} entries={entries} query={query} />
              )}
            </div>
          </div>
        </OGDialogContent>
      )}
    </OGDialog>
  );
}
