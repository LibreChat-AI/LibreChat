import { useState, useRef, useMemo, useEffect, useId } from 'react';
import { Plus } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { useLocation } from 'react-router-dom';
import { SystemRoles, PermissionTypes, Permissions } from 'librechat-data-provider';
import { Button, FilterInput, OGDialogTrigger, TooltipAnchor } from '@librechat/client';
import {
  useLocalize,
  useMCPServerManager,
  useHasAccess,
  useAuthContext,
  activateCatalog,
} from '~/hooks';
import { PanelFooter, PanelContent, PanelHeader } from '~/components/ui';
import MCPConfigDialog from '~/components/MCP/MCPConfigDialog';
import MCPServerCardSkeleton from './MCPServerCardSkeleton';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import MCPAdminSettings from './MCPAdminSettings';
import MCPServerDialog from './MCPServerDialog';
import MCPServerList from './MCPServerList';
import store from '~/store';

export default function MCPBuilderPanel() {
  const localize = useLocalize();
  const headingId = useId();
  const location = useLocation();
  /** The panel stays mounted while the sidebar is hidden (collapsed, mobile
   * drawer, or the insights route collapsing it), so only a visible panel
   * releases its catalog ahead of the background warmup schedule */
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  const panelVisible = sidebarExpanded && !location.pathname.startsWith('/insights');
  useEffect(() => {
    if (panelVisible) {
      activateCatalog('mcpServers');
    }
  }, [panelVisible]);
  const { user } = useAuthContext();
  const { availableMCPServers, isLoading, getServerStatusIconProps, getConfigDialogProps } =
    useMCPServerManager({ observeToolAuthorization: panelVisible });
  useMCPRefresh({ enabled: panelVisible && !isLoading && availableMCPServers.length > 0 });

  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.CREATE,
  });
  const [showDialog, setShowDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const configDialogProps = getConfigDialogProps();

  const filteredServers = useMemo(() => {
    if (!searchQuery.trim()) {
      return availableMCPServers;
    }
    const query = searchQuery.toLowerCase();
    return availableMCPServers.filter((server) => {
      const displayName = server.config?.title || server.serverName;
      return (
        displayName.toLowerCase().includes(query) || server.serverName.toLowerCase().includes(query)
      );
    });
  }, [availableMCPServers, searchQuery]);

  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className="flex h-full w-full flex-col overflow-hidden pt-2"
    >
      {/* Sticky header: title, create, search */}
      <PanelHeader
        title={localize('com_ui_mcp_servers')}
        titleId={headingId}
        action={
          hasCreateAccess && (
            <MCPServerDialog
              open={showDialog}
              onOpenChange={setShowDialog}
              triggerRef={addButtonRef}
            >
              <OGDialogTrigger asChild>
                <TooltipAnchor
                  description={localize('com_ui_add_mcp')}
                  side="bottom"
                  render={
                    <Button
                      ref={addButtonRef}
                      variant="ghost"
                      size="icon"
                      className="size-8 shrink-0"
                      onClick={() => setShowDialog(true)}
                      aria-label={localize('com_ui_add_mcp')}
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  }
                />
              </OGDialogTrigger>
            </MCPServerDialog>
          )
        }
        search={
          <FilterInput
            inputId="mcp-filter"
            label={localize('com_ui_filter_mcp_servers')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        }
      />

      {/* Only the list scrolls */}
      <PanelContent
        isLoading={isLoading}
        skeleton={<MCPServerCardSkeleton />}
        className="px-3 pb-3"
      >
        <MCPServerList
          servers={filteredServers}
          getServerStatusIconProps={getServerStatusIconProps}
          isFiltered={searchQuery.trim().length > 0}
        />
      </PanelContent>

      {/* Config Dialog for custom user vars */}
      {configDialogProps && <MCPConfigDialog {...configDialogProps} />}

      {user?.role === SystemRoles.ADMIN && (
        <PanelFooter>
          <MCPAdminSettings />
        </PanelFooter>
      )}
    </div>
  );
}
