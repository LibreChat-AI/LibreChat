import React, { useRef, useMemo, useState, useEffect } from 'react';
import {
  Input,
  Label,
  Radio,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
} from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import type { AgentItem, ItemFilter } from '~/components/SidePanel/Agents/Tools/items/types';
import type { PaletteEntry } from '~/hooks/Input/usePaletteEntries';
import type { TranslationKeys } from '~/hooks';
import type { FileView } from './Files';
import MarketplaceCatalog from '~/components/SidePanel/Agents/Tools/MarketplaceCatalog';
import { matchesView } from '~/components/SidePanel/Agents/Tools/items/filtering';
import { itemKey } from '~/components/SidePanel/Agents/Tools/items/selectors';
import { useLocalize, useToolFavorites } from '~/hooks';
import FileGrid, { FILE_VIEWS } from './Files';

export type CatalogSection = 'skill' | 'mcp' | 'files';

type View = NonNullable<ItemFilter['view']>;

/** The agent builder's Skills dialog views, in the same order and wording. */
const VIEWS: Array<{ value: View; labelKey: TranslationKeys }> = [
  { value: 'marketplace', labelKey: 'com_ui_all_proper' },
  { value: 'mine', labelKey: 'com_ui_tools_view_made_by_you' },
  { value: 'favorites', labelKey: 'com_ui_tools_view_favorites' },
];

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

const FILTER: Record<CatalogSection, TranslationKeys> = {
  skill: 'com_ui_skills_filter',
  mcp: 'com_ui_composer_mcp_filter',
  files: 'com_ui_composer_files_filter',
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
      ownedByUser: entry.ownedByUser,
    };
  }
  if (entry.section === 'mcp') {
    return {
      kind: 'mcp',
      id: entry.itemId,
      name: entry.label,
      description: entry.description ?? '',
      iconKey: 'mcp',
      ownedByUser: entry.ownedByUser,
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
  view,
}: {
  section: 'skill' | 'mcp';
  entries: PaletteEntry[];
  query: string;
  view: View;
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
      if (item == null || !matchesView(item, view, { favoritedIds: favoriteKeys })) {
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
  }, [entries, section, query, view, favoriteKeys]);

  return (
    <MarketplaceCatalog
      items={items}
      selectedIds={selectedIds}
      onToggle={(item) => byKey.get(itemKey(item))?.onSelect()}
      view={view}
      statusFor={(item) => byKey.get(itemKey(item))?.status}
      favoriteKeys={favoriteKeys}
      onToggleFavorite={toggle}
      emptyKey={view === 'marketplace' || query !== '' ? 'com_ui_composer_no_results' : undefined}
      ariaLabel={localize(TITLE[section])}
    />
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
  const [view, setView] = useState<View>('marketplace');
  const [fileView, setFileView] = useState<FileView>('all');
  const [shown, setShown] = useState(section);
  if (section !== shown) {
    setShown(section);
    if (section != null) {
      setSearch('');
      setView('marketplace');
      setFileView('all');
    }
  }
  const current = section ?? shown;
  const viewOptions = useMemo(
    () =>
      (current === 'files' ? FILE_VIEWS : VIEWS).map((option) => ({
        value: option.value,
        label: localize(option.labelKey),
      })),
    [current, localize],
  );
  const query = search.trim().toLowerCase();

  /* Focus goes back to the message field only after a mouse or keyboard close:
     after a tap it would summon the on-screen keyboard the user just left, the
     same rule the palette applies to its own close. */
  const focusTargetRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (section == null) {
      return;
    }
    const aim = (touch: boolean) => {
      focusTargetRef.current = touch ? null : returnFocusRef.current;
    };
    aim(window.matchMedia('(pointer: coarse)').matches);
    const onPointer = (event: PointerEvent) => aim(event.pointerType !== 'mouse');
    const onKey = () => aim(false);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [section, returnFocusRef]);

  return (
    <OGDialog
      open={section != null}
      triggerRef={focusTargetRef}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      {current != null && (
        <OGDialogContent className="flex h-[80vh] max-h-[720px] w-11/12 max-w-[960px] flex-col overflow-hidden">
          <div className="flex h-full min-h-0 min-w-0 flex-col gap-3">
            <OGDialogTitle>{localize(TITLE[current])}</OGDialogTitle>
            <OGDialogDescription className="sr-only">
              {localize(SEARCH[current])}
            </OGDialogDescription>
            {/* Reaches into the dialog's right padding so the scrollbar sits at the
                edge, and pads the content back so the cards keep their inset. The
                controls ride inside it as a sticky header, so they share the cards'
                exact width whether the scrollbar takes space or overlays; the small
                left inset keeps the search field's focus ring from being clipped. */}
            <div className="-mr-5 -ml-1 min-h-0 flex-1 overflow-y-auto pr-5 pl-1">
              <div className="bg-surface-dialog sticky top-0 z-10 flex flex-wrap items-center gap-2 pt-1 pb-3">
                <div className="min-w-0 flex-1">
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={localize(SEARCH[current])}
                    aria-label={localize(SEARCH[current])}
                  />
                </div>
                <Label id="composer-catalog-view-label" className="sr-only">
                  {localize(FILTER[current])}
                </Label>
                <Radio
                  wrap
                  options={viewOptions}
                  value={current === 'files' ? fileView : view}
                  onChange={(value) =>
                    current === 'files' ? setFileView(value as FileView) : setView(value as View)
                  }
                  aria-labelledby="composer-catalog-view-label"
                />
              </div>
              {current === 'files' ? (
                <FileGrid query={query} view={fileView} onAttach={onAttach} />
              ) : (
                <EntryGrid section={current} entries={entries} query={query} view={view} />
              )}
            </div>
          </div>
        </OGDialogContent>
      )}
    </OGDialog>
  );
}
