import { useState, useMemo, useCallback } from 'react';
import { Search } from 'lucide-react';
import { useFormContext } from 'react-hook-form';
import { AgentCapabilities, removeCodeExecutionCaller } from 'librechat-data-provider';
import {
  Input,
  OGDialog,
  OGDialogTitle,
  OGDialogContent,
  OGDialogDescription,
  useMediaQuery,
  useToastContext,
} from '@librechat/client';
import type { AgentItem, AgentItemKind, ItemFilter } from './items/types';
import type { CapabilityFileCounts } from './items/capabilities';
import type { AgentForm } from '~/common';
import {
  itemKey,
  mcpAllToken,
  mcpServerToken,
  matchesMcpServer,
  mcpServerIds,
} from './items/selectors';
import { useAgentFileEntries, useAgentItems, useUninstallToolCredentials } from './hooks';
import MarketplaceSidebar, { MarketplaceFilterBar } from './MarketplaceSidebar';
import { requiresFileManagerRemoval } from './items/capabilities';
import AddMcpServerDialog from './ItemDialog/AddMcpServerDialog';
import { computeToggleAction } from './items/mutations';
import { useLocalize, useToolFavorites } from '~/hooks';
import MarketplaceCatalog from './MarketplaceCatalog';
import ItemDialog from './ItemDialog/ItemDialog';
import { applyFilter } from './items/filtering';
import { NEW_ACTION_ID } from './items/types';
import { isEphemeralAgent } from '~/common';

interface ToolsMarketplaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
}

type View = NonNullable<ItemFilter['view']>;
type Kind = AgentItemKind | 'all';

export default function ToolsMarketplaceDialog({
  open,
  onOpenChange,
  agentId,
}: ToolsMarketplaceDialogProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { getValues, setValue } = useFormContext<AgentForm>();
  const uninstallToolCredentials = useUninstallToolCredentials();

  /** Skills are excluded here — they have their own picker (`SkillsDialog`). */
  const { catalog, selected: selectedItems } = useAgentItems({ agentId });

  const { favoriteKeys, toggle: toggleFavorite } = useToolFavorites();

  const [view, setView] = useState<View>('marketplace');
  const [kind, setKind] = useState<Kind>('all');
  const [search, setSearch] = useState('');
  const [detailItem, setDetailItem] = useState<AgentItem | null>(null);
  const [addMcpOpen, setAddMcpOpen] = useState(false);

  /** The rail is md+; below it the same navigation renders as a chip row. */
  const isDesktop = useMediaQuery('(min-width: 768px)');

  const handleCreateNew = useCallback(
    (createKind: 'mcp' | 'action') => {
      if (createKind === 'mcp') {
        setAddMcpOpen(true);
        return;
      }
      /** Actions are persisted against the agent id, so an unsaved agent has
       * nothing to attach them to — surface the save-first error instead of
       * letting the editor fail on submit. */
      if (isEphemeralAgent(agentId)) {
        showToast({ message: localize('com_agents_no_agent_id_error'), status: 'error' });
        return;
      }
      setDetailItem({
        kind: 'action',
        id: NEW_ACTION_ID,
        name: localize('com_ui_new_action'),
        description: '',
        iconKey: 'action',
        endpointCount: 0,
      });
    },
    [agentId, localize, showToast],
  );

  const selectedIds = useMemo(() => new Set(selectedItems.map(itemKey)), [selectedItems]);
  const { knowledgeFiles, codeFiles } = useAgentFileEntries();
  const fileCounts: CapabilityFileCounts = useMemo(
    () => ({ knowledge_files: knowledgeFiles.length, code_files: codeFiles.length }),
    [knowledgeFiles, codeFiles],
  );

  const counts = useMemo(
    () => ({
      builtin: catalog.filter((i) => i.kind === 'builtin').length,
      tool: catalog.filter((i) => i.kind === 'tool').length,
      mcp: catalog.filter((i) => i.kind === 'mcp').length,
      skill: 0,
      action: catalog.filter((i) => i.kind === 'action').length,
    }),
    [catalog],
  );

  const filtered = useMemo(
    () =>
      applyFilter(catalog, { search, kind, category: 'all', view }, { favoritedIds: favoriteKeys }),
    [catalog, search, kind, view, favoriteKeys],
  );

  const handleToggle = useCallback(
    (item: AgentItem) => {
      const selected = selectedIds.has(itemKey(item));
      /** A file-backed built-in cannot be switched off by its flag while it holds
       * files — the row would stay selected and the save would disagree with it — so
       * send the user to the dialog that manages those files, as the tools list does. */
      if (selected && item.kind === 'builtin' && requiresFileManagerRemoval(item.id, fileCounts)) {
        setDetailItem(item);
        return;
      }
      const patch = computeToggleAction(item, { selected });
      switch (patch.type) {
        case 'builtin':
          setValue(patch.field as keyof AgentForm, patch.value as never, { shouldDirty: true });
          if (patch.field === AgentCapabilities.execute_code && patch.value === false) {
            setValue('tool_options', removeCodeExecutionCaller(getValues('tool_options')), {
              shouldDirty: true,
            });
          }
          break;
        case 'tool-add': {
          const current = (getValues('tools') ?? []) as string[];
          setValue('tools', Array.from(new Set([...current, patch.id])), { shouldDirty: true });
          break;
        }
        case 'tool-remove': {
          const current = (getValues('tools') ?? []) as string[];
          setValue(
            'tools',
            current.filter((t) => t !== patch.id),
            { shouldDirty: true },
          );
          uninstallToolCredentials(patch.id);
          break;
        }
        case 'mcp-add': {
          if (item.kind !== 'mcp') break;
          const toolIds =
            item.server.requestScoped || !item.server.tools?.length
              ? [mcpAllToken(item.id)]
              : (item.server.tools ?? []).map((t) => t.tool_id);
          const current = (getValues('tools') ?? []) as string[];
          setValue(
            'tools',
            Array.from(new Set([...current, mcpServerToken(item.id), ...toolIds])),
            { shouldDirty: true },
          );
          break;
        }
        case 'mcp-remove': {
          if (item.kind !== 'mcp') break;
          const toolIds = new Set((item.server.tools ?? []).map((t) => t.tool_id));
          const allServerNames = mcpServerIds(catalog);
          const current = (getValues('tools') ?? []) as string[];
          setValue(
            'tools',
            current.filter((t) => !matchesMcpServer(t, item.id, allServerNames) && !toolIds.has(t)),
            { shouldDirty: true },
          );
          break;
        }
        default:
          break;
      }
    },
    [getValues, setValue, selectedIds, uninstallToolCredentials, catalog, fileCounts],
  );

  const handleCardClick = useCallback(
    (item: AgentItem) => {
      /** Actions have no simple enable toggle — clicking always opens the editor. */
      if (item.kind === 'action') {
        setDetailItem(item);
        return;
      }
      if (item.kind === 'builtin' && item.id === 'context') {
        setDetailItem(item);
        return;
      }
      const wasSelected = selectedIds.has(itemKey(item));
      /** Ready servers can resolve their tools with user credentials at runtime,
       * even when the instance catalog is empty. Unready servers still need setup;
       * a selected toolless server must remain removable. */
      if (
        item.kind === 'mcp' &&
        item.toolCount === 0 &&
        !wasSelected &&
        !(item.server.isReadyForAgent ?? item.server.isConnected)
      ) {
        setDetailItem(item);
        return;
      }
      if (!wasSelected && item.status === 'needs_setup') {
        setDetailItem(item);
        return;
      }
      handleToggle(item);
    },
    [handleToggle, selectedIds],
  );

  const handleConfigure = useCallback((item: AgentItem) => {
    setDetailItem(item);
  }, []);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      {/* The body carries the height from md, the way it did before this change, so
          the shell wraps it and the two cannot disagree: an explicit height on the
          shell would leave its difference from the body's 840px ceiling as dead
          space below the catalog on a tall screen. Below md the shell is the
          full-bleed sheet and the body is capped to the same 100dvh, because its
          `h-full` resolves against a grid area sized to the whole catalog. */}
      <OGDialogContent className="h-[100dvh] max-h-[100dvh] w-full max-w-full overflow-hidden rounded-none border-border-medium p-0 shadow-xl md:h-auto md:max-h-[92vh] md:w-11/12 md:max-w-[1200px] md:rounded-2xl">
        <OGDialogTitle className="sr-only">{localize('com_ui_tools_marketplace')}</OGDialogTitle>
        <OGDialogDescription className="sr-only">
          {localize('com_ui_tools_marketplace_description')}
        </OGDialogDescription>
        {/* min-w-0: as a grid item of the dialog content, an `auto` minimum would
            size this column to the chip row's min-content and overflow the viewport. */}
        <div className="flex h-full max-h-[100dvh] min-w-0 flex-col md:h-[88vh] md:max-h-[840px] md:flex-row">
          {isDesktop && (
            <MarketplaceSidebar
              activeView={view}
              activeKind={kind}
              onSelectView={setView}
              onSelectKind={setKind}
              counts={counts}
              totalCount={catalog.length}
              onCreateNew={handleCreateNew}
            />
          )}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* md:pl-6, not md:px-6: a responsive variant is emitted after the base
                utilities, so md:px-6 would reset the pr-12 that keeps the search
                field clear of the dialog's close button. */}
            <div className="flex items-center gap-2 px-4 py-3 pr-12 md:py-4 md:pl-6">
              <div className="relative flex-1">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 z-[1] size-4 -translate-y-1/2 text-text-tertiary"
                  aria-hidden="true"
                />
                <Input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={localize('com_ui_tools_marketplace_search')}
                  aria-label={localize('com_ui_tools_marketplace_search')}
                  className="bg-transparent pl-9"
                />
              </div>
            </div>
            {!isDesktop && (
              <MarketplaceFilterBar
                activeView={view}
                activeKind={kind}
                onSelectView={setView}
                onSelectKind={setKind}
                counts={counts}
                totalCount={catalog.length}
                onCreateNew={handleCreateNew}
              />
            )}
            <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
              <MarketplaceCatalog
                items={filtered}
                selectedIds={selectedIds}
                onToggle={handleCardClick}
                onConfigure={handleConfigure}
                view={view}
                favoriteKeys={favoriteKeys}
                onToggleFavorite={toggleFavorite}
              />
            </div>
          </div>
        </div>
        <ItemDialog item={detailItem} agentId={agentId} onClose={() => setDetailItem(null)} />
        <AddMcpServerDialog open={addMcpOpen} onOpenChange={setAddMcpOpen} />
      </OGDialogContent>
    </OGDialog>
  );
}
