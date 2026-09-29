import React, { memo, useRef, useMemo, useEffect } from 'react';
import * as Ariakit from '@ariakit/react';
import { ChevronDown } from 'lucide-react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { TooltipAnchor, composerControlClasses } from '@librechat/client';
import MCPServerMenuItem from '~/components/MCP/MCPServerMenuItem';
import MCPConfigDialog from '~/components/MCP/MCPConfigDialog';
import StackedMCPIcons from '~/components/MCP/StackedMCPIcons';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import { useHasAccess, useLocalize } from '~/hooks';
import { useBadgeRowContext } from '~/Providers';
import { cn } from '~/utils';

function MCPSelectContent() {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const { conversationId, storageContextKey, mcpServerManager: manager } = context ?? {};

  const menuStore = Ariakit.useMenuStore({ focusLoop: true });
  const isOpen = menuStore.useState('open');
  const configDialogOpen = manager?.getConfigDialogProps()?.isOpen === true;
  useMCPRefresh({
    enabled: (isOpen || configDialogOpen) && (manager?.availableMCPServers.length ?? 0) > 0,
  });

  /**
   * The menu closes with the dialog it launched. Ariakit only takes Escape for
   * a menu when the event target is the menu, its trigger, or `body`, so while
   * the config dialog holds focus the menu never sees it — the Escape that
   * closes the dialog leaves the menu open behind it, and `disabled={isOpen}`
   * then makes its trigger unclickable, stranding the reader
   * (`mcp-oauth-readiness` e2e). Keyed on the dialog CLOSING, not opening: the
   * menu stays mounted underneath while the dialog is up, which is where its
   * server rows are read from.
   */
  const configDialogWasOpen = useRef(false);
  useEffect(() => {
    if (configDialogWasOpen.current && !configDialogOpen) {
      menuStore.hide();
    }
    configDialogWasOpen.current = configDialogOpen;
  }, [configDialogOpen, menuStore]);

  const selectedServers = useMemo(() => {
    if (!manager?.mcpValues || manager.mcpValues.length === 0) {
      return [];
    }
    const selectedSet = new Set(manager.mcpValues);
    return manager.selectableServers?.filter((s) => selectedSet.has(s.serverName)) ?? [];
  }, [manager?.selectableServers, manager?.mcpValues]);

  /** Counts what the menu actually offers, never the raw selection: a name the
   *  catalog has not returned — or one the admin has hidden — renders no row,
   *  and billing it to the badge reads as a server that cannot be turned off. */
  const displayText = useMemo(() => {
    const selectedCount = selectedServers.length;
    if (selectedCount === 0) {
      return null;
    }
    if (selectedCount === 1) {
      const server = selectedServers[0];
      return server.config?.title || server.serverName;
    }
    return localize('com_ui_x_selected', { 0: selectedCount });
  }, [selectedServers, localize]);

  if (!manager) {
    return null;
  }

  const {
    isPinned,
    mcpValues,
    isInitializing,
    placeholderText,
    connectionStatus,
    selectableServers,
    getConfigDialogProps,
    toggleServerSelection,
    getServerStatusIconProps,
  } = manager;

  if (!isPinned && mcpValues?.length === 0) {
    return null;
  }

  const configDialogProps = getConfigDialogProps();

  return (
    <>
      <Ariakit.MenuProvider store={menuStore}>
        <TooltipAnchor
          description={placeholderText}
          disabled={isOpen}
          render={
            <Ariakit.MenuButton
              className={cn(
                composerControlClasses(),
                'min-w-theme-control px-2.5 md:w-fit md:justify-start md:px-theme-normal',
                isOpen && 'bg-surface-hover',
              )}
            />
          }
        >
          <StackedMCPIcons selectedServers={selectedServers} maxIcons={3} iconSize="sm" />
          <span className="hidden truncate text-text-primary md:block">
            {displayText || placeholderText}
          </span>
          <ChevronDown
            className={cn(
              'hidden h-3 w-3 text-text-secondary transition-transform md:block',
              isOpen && 'rotate-180',
            )}
          />
        </TooltipAnchor>

        <Ariakit.Menu
          portal={true}
          gutter={8}
          modal={true}
          unmountOnHide={true}
          aria-label={localize('com_ui_mcp_servers')}
          className={cn(
            'z-50 flex min-w-[260px] max-w-[320px] flex-col rounded-xl',
            'border border-border-light bg-presentation p-1.5 shadow-lg',
            'origin-top opacity-0 transition-[opacity,transform] duration-200 ease-out',
            'data-[enter]:scale-100 data-[enter]:opacity-100',
            'scale-95 data-[leave]:scale-95 data-[leave]:opacity-0',
          )}
        >
          <div className="flex max-h-[320px] flex-col gap-1 overflow-y-auto">
            {selectableServers.map((server) => (
              <MCPServerMenuItem
                key={server.serverName}
                server={server}
                isSelected={mcpValues?.includes(server.serverName) ?? false}
                connectionStatus={connectionStatus}
                isInitializing={isInitializing}
                statusIconProps={getServerStatusIconProps(server.serverName)}
                onToggle={toggleServerSelection}
              />
            ))}
          </div>
        </Ariakit.Menu>
      </Ariakit.MenuProvider>
      {configDialogProps && (
        <MCPConfigDialog
          {...configDialogProps}
          conversationId={conversationId}
          storageContextKey={storageContextKey}
        />
      )}
    </>
  );
}

function MCPSelect() {
  const context = useBadgeRowContext();
  const { selectableServers } = context?.mcpServerManager ?? {};
  const canUseMcp = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });

  if (!canUseMcp || !selectableServers || selectableServers.length === 0) {
    return null;
  }

  return <MCPSelectContent />;
}

export default memo(MCPSelect);
