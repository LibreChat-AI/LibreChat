import { mcpRefreshDefaults } from 'librechat-data-provider';
import { useMCPConnectionStatusQuery } from '~/data-provider/Tools/queries';
import { useGetStartupConfig } from '~/data-provider/Endpoints/queries';
import { useMCPToolsQuery } from '~/data-provider/MCP/queries';

/** Reconcile server-side MCP changes only while a consuming UI is visible. */
export function useMCPRefresh({ enabled, tools = false }: { enabled: boolean; tools?: boolean }) {
  const { data: startupConfig } = useGetStartupConfig();
  const config = startupConfig?.interface?.mcpServers;
  const statusInterval = config?.statusRefreshInterval ?? mcpRefreshDefaults.statusRefreshInterval;
  const toolsInterval = config?.toolsRefreshInterval ?? mcpRefreshDefaults.toolsRefreshInterval;

  useMCPConnectionStatusQuery({
    enabled,
    refetchInterval: enabled && statusInterval > 0 ? statusInterval : false,
  });
  useMCPToolsQuery({
    enabled: enabled && tools,
    refetchInterval: enabled && tools && toolsInterval > 0 ? toolsInterval : false,
  });
}
