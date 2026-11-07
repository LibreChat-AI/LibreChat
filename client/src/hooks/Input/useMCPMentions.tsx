import { useMemo } from 'react';
import { Button, MCPIcon } from '@librechat/client';
import type { CommandOption } from '@librechat/chat/components';
import type { ReactNode } from 'react';
import { useBadgeRowContext } from '~/Providers/BadgeRowContext';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import CustomIcon from '~/components/ui/CustomIcon';
import useLocalize from '~/hooks/useLocalize';

export interface MCPMentionOption extends CommandOption {
  type: 'mcp';
  selected: boolean;
}

export default function useMCPMentions(enabled: boolean) {
  const localize = useLocalize();
  const manager = useBadgeRowContext()?.mcpServerManager;
  useMCPRefresh({ enabled: enabled && (manager?.availableMCPServers.length ?? 0) > 0 });
  const options = useMemo<MCPMentionOption[]>(() => {
    if (!enabled || !manager) {
      return [];
    }
    const selected = new Set(manager.mcpValues);
    const labels = {
      connected: localize('com_nav_mcp_status_connected'),
      connecting: localize('com_ui_connecting'),
      disconnected: localize('com_nav_mcp_status_disconnected'),
      error: localize('com_nav_mcp_status_error'),
    };
    return manager.selectableServers.map((server) => {
      const status = manager.connectionStatus?.[server.serverName];
      let statusLabel = status
        ? labels[status.connectionState]
        : localize('com_nav_mcp_status_unknown');
      if (manager.isInitializing(server.serverName)) {
        statusLabel = localize('com_nav_mcp_status_initializing');
      } else if (status?.requestScoped) {
        statusLabel = localize('com_nav_mcp_status_on_demand');
      } else if (status?.connectionState === 'disconnected' && status.requiresOAuth) {
        statusLabel = localize('com_nav_mcp_status_needs_auth');
      }
      const isSelected = selected.has(server.serverName);
      return {
        type: 'mcp',
        value: server.serverName,
        label: server.config.title || server.serverName,
        group: localize('com_ui_mcp_servers'),
        selected: isSelected,
        description: [
          server.serverName,
          localize('com_ui_mcp_mention_server'),
          statusLabel,
          ...(isSelected ? [localize('com_ui_mcp_mention_selected')] : []),
        ].join(' · '),
        icon: server.config.iconPath ? (
          <CustomIcon src={server.config.iconPath} className="h-5 w-5" alt="" />
        ) : (
          <MCPIcon className="h-5 w-5" aria-hidden="true" />
        ),
      };
    });
  }, [enabled, manager, localize]);

  const isLoading = enabled && manager?.isLoading === true;
  let notice: ReactNode;
  if (enabled && manager?.isCatalogError) {
    notice = (
      <>
        {localize('com_ui_mcp_mention_failed')}{' '}
        <Button
          type="button"
          variant="link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void manager.refetchServers()}
        >
          {localize('com_ui_retry')}
        </Button>
      </>
    );
  } else if (isLoading) {
    notice = localize('com_ui_mcp_mention_loading');
  } else if (enabled && options.length === 0) {
    notice = localize('com_ui_mcp_mention_empty');
  }

  return { options, isLoading, notice, selectServer: manager?.selectServer };
}
