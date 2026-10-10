import { EmptyState, MCPIcon } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { MCPServerStatusIconProps } from '~/components/MCP/MCPServerStatusIcon';
import type { MCPServerDefinition } from '~/hooks';
import { useLocalize, useHasAccess } from '~/hooks';
import MCPServerCard from './MCPServerCard';

interface MCPServerListProps {
  servers: MCPServerDefinition[];
  getServerStatusIconProps: (serverName: string) => MCPServerStatusIconProps;
  isFiltered?: boolean;
}

/**
 * Renders a list of MCP server cards with empty state handling
 */
export default function MCPServerList({
  servers,
  getServerStatusIconProps,
  isFiltered = false,
}: MCPServerListProps) {
  const localize = useLocalize();
  const canCreateEditMCPs = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.CREATE,
  });

  if (servers.length === 0) {
    if (isFiltered) {
      return <EmptyState icon={MCPIcon} description={localize('com_ui_no_mcp_servers_match')} />;
    }
    return (
      <EmptyState
        icon={MCPIcon}
        title={localize('com_ui_no_mcp_servers')}
        description={localize('com_ui_add_first_mcp_server')}
      />
    );
  }

  return (
    <div className="space-y-2" role="list" aria-label={localize('com_ui_mcp_servers')}>
      {servers.map((server) => (
        <div key={`card_${server.serverName}`} role="listitem">
          <MCPServerCard
            server={server}
            getServerStatusIconProps={getServerStatusIconProps}
            canCreateEditMCPs={canCreateEditMCPs}
          />
        </div>
      ))}
    </div>
  );
}
