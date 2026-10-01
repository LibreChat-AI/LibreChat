import { useState, useMemo } from 'react';
import * as Ariakit from '@ariakit/react/menu';
import { Button, DropdownPopup } from '@librechat/client';
import { Permissions, PermissionTypes, AgentCapabilities } from 'librechat-data-provider';
import { LayoutGrid, ListFilter, Wrench, Server, Workflow, Star, User, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AgentItemKind, ItemFilter } from './items/types';
import { useLocalize, useHasAccess } from '~/hooks';
import { useAgentPanelContext } from '~/Providers';
import { cn } from '~/utils';

type View = NonNullable<ItemFilter['view']>;
type Kind = AgentItemKind | 'all';

interface MarketplaceSidebarProps {
  activeView: View;
  activeKind: Kind;
  onSelectView: (view: View) => void;
  onSelectKind: (kind: Kind) => void;
  counts: Record<AgentItemKind, number>;
  totalCount: number;
  onCreateNew?: (kind: 'mcp' | 'action') => void;
}

interface SidebarEntry {
  id: string;
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  count?: number;
}

/** Kind and view navigation shared by the desktop rail and the mobile chip row. */
function useMarketplaceNav({
  activeView,
  activeKind,
  onSelectView,
  onSelectKind,
  counts,
  totalCount,
}: MarketplaceSidebarProps) {
  const localize = useLocalize();
  const selectKind = (kind: Kind) => {
    onSelectView('marketplace');
    onSelectKind(kind);
  };
  const selectView = (view: View) => {
    onSelectView(view);
    onSelectKind('all');
  };

  const kindEntries: SidebarEntry[] = [
    {
      id: 'all',
      icon: <LayoutGrid className="size-4" />,
      label: localize('com_ui_all_proper'),
      active: activeKind === 'all' && activeView === 'marketplace',
      onClick: () => selectKind('all'),
      count: totalCount,
    },
    {
      id: 'builtin',
      icon: <ListFilter className="size-4" />,
      label: localize('com_ui_tools_kind_official'),
      active: activeKind === 'builtin' && activeView === 'marketplace',
      onClick: () => selectKind('builtin'),
      count: counts.builtin,
    },
    {
      id: 'tool',
      icon: <Wrench className="size-4" />,
      label: localize('com_ui_tools_kind_tools'),
      active: activeKind === 'tool' && activeView === 'marketplace',
      onClick: () => selectKind('tool'),
      count: counts.tool,
    },
    {
      id: 'mcp',
      icon: <Server className="size-4" />,
      label: localize('com_ui_tools_kind_mcp'),
      active: activeKind === 'mcp' && activeView === 'marketplace',
      onClick: () => selectKind('mcp'),
      count: counts.mcp,
    },
    {
      id: 'action',
      icon: <Workflow className="size-4" />,
      label: localize('com_ui_tools_kind_actions'),
      active: activeKind === 'action' && activeView === 'marketplace',
      onClick: () => selectKind('action'),
      count: counts.action,
    },
  ];

  const viewEntries: SidebarEntry[] = [
    {
      id: 'mine',
      icon: <User className="size-4" />,
      label: localize('com_ui_tools_view_made_by_you'),
      active: activeView === 'mine',
      onClick: () => selectView('mine'),
    },
    {
      id: 'favorites',
      icon: <Star className="size-4" />,
      label: localize('com_ui_tools_view_favorites'),
      active: activeView === 'favorites',
      onClick: () => selectView('favorites'),
    },
  ];

  return { kindEntries, viewEntries };
}

function useCreateItems(onCreateNew?: (kind: 'mcp' | 'action') => void) {
  const localize = useLocalize();
  const { agentsConfig } = useAgentPanelContext();
  const hasMcpCreateAccess = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.CREATE,
  });
  const actionsEnabled = useMemo(
    () => agentsConfig?.capabilities?.includes(AgentCapabilities.actions) ?? false,
    [agentsConfig],
  );

  return useMemo(() => {
    const items: Array<{ label: string; icon: ReactNode; onClick: () => void }> = [];
    if (hasMcpCreateAccess) {
      items.push({
        label: localize('com_ui_tools_kind_mcp'),
        icon: <Server className="size-4" aria-hidden="true" />,
        onClick: () => onCreateNew?.('mcp'),
      });
    }
    if (actionsEnabled) {
      items.push({
        label: localize('com_ui_tools_kind_actions'),
        icon: <Workflow className="size-4" aria-hidden="true" />,
        onClick: () => onCreateNew?.('action'),
      });
    }
    return items;
  }, [localize, onCreateNew, hasMcpCreateAccess, actionsEnabled]);
}

function SidebarItem({ icon, label, active, onClick, count }: SidebarEntry) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
        active
          ? 'bg-surface-active font-medium text-text-primary'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[11px] tabular-nums text-text-secondary">{count}</span>
      )}
    </button>
  );
}

/** The chip row is this layout's primary navigation, and it only exists where a
 *  finger is what reaches it, so the chips carry the shared tap-target floor
 *  rather than the compact height a mouse would be happy with. */
function SidebarChip({ icon, label, active, onClick, count }: SidebarEntry) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
        'touch:min-h-theme-control-touch touch:px-4',
        active
          ? 'border-border-medium bg-surface-active font-medium text-text-primary'
          : 'border-border-light text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
    >
      <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span className="text-[10px] tabular-nums text-text-secondary">{count}</span>
      )}
    </button>
  );
}

export default function MarketplaceSidebar(props: MarketplaceSidebarProps) {
  const localize = useLocalize();
  const [createOpen, setCreateOpen] = useState(false);
  const { kindEntries, viewEntries } = useMarketplaceNav(props);
  const createItems = useCreateItems(props.onCreateNew);

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-0.5 border-r border-border-light bg-surface-primary-alt p-3">
      <h2 className="px-2.5 pb-1 pt-1 text-base font-bold text-text-primary">
        {localize('com_ui_tools_marketplace')}
      </h2>

      {createItems.length > 0 && (
        <DropdownPopup
          portal={true}
          mountByState={true}
          unmountOnHide={true}
          isOpen={createOpen}
          setIsOpen={setCreateOpen}
          menuId="marketplace-create-new"
          className="pointer-events-auto"
          trigger={
            <Ariakit.MenuButton
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="mb-2 mt-1 w-full justify-center gap-1.5"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  <span className="truncate">{localize('com_ui_tools_create_new')}</span>
                </Button>
              }
            />
          }
          items={createItems}
        />
      )}

      {kindEntries.map((entry) => (
        <SidebarItem key={entry.id} {...entry} />
      ))}

      <div className="mx-2 my-3 h-px bg-border-light" />

      {viewEntries.map((entry) => (
        <SidebarItem key={entry.id} {...entry} />
      ))}
    </aside>
  );
}

/** Mobile stand-in for the sidebar rail: a horizontally scrollable chip row
 *  rendered under the search field when the rail is hidden. */
export function MarketplaceFilterBar(props: MarketplaceSidebarProps) {
  const localize = useLocalize();
  const [createOpen, setCreateOpen] = useState(false);
  const { kindEntries, viewEntries } = useMarketplaceNav(props);
  const createItems = useCreateItems(props.onCreateNew);

  return (
    /* The scrollbar hides only where a finger can drag the row instead. A narrow
       desktop window is below md too, and there a wheel scrolls the page rather
       than this row, so the bar is the only way to reach the trailing views. */
    <div
      role="group"
      className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border-light px-4 pb-2.5 touch:[scrollbar-width:none] touch:[&::-webkit-scrollbar]:hidden"
      aria-label={localize('com_ui_tools_marketplace')}
    >
      {createItems.length > 0 && (
        <DropdownPopup
          portal={true}
          mountByState={true}
          unmountOnHide={true}
          isOpen={createOpen}
          setIsOpen={setCreateOpen}
          menuId="marketplace-create-new-mobile"
          className="pointer-events-auto"
          trigger={
            <Ariakit.MenuButton
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 shrink-0 justify-center p-0 touch:size-theme-control-touch"
                  aria-label={localize('com_ui_tools_create_new')}
                >
                  <Plus className="size-4" aria-hidden="true" />
                </Button>
              }
            />
          }
          items={createItems}
        />
      )}
      {kindEntries.map((entry) => (
        <SidebarChip key={entry.id} {...entry} />
      ))}
      <span className="h-4 w-px shrink-0 bg-border-light" aria-hidden="true" />
      {viewEntries.map((entry) => (
        <SidebarChip key={entry.id} {...entry} />
      ))}
    </div>
  );
}
