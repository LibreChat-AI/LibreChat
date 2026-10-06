import React, { createContext, useContext, useState, useMemo, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { useLocation } from 'react-router-dom';
import { EModelEndpoint } from 'librechat-data-provider';
import type { MCP, Action, TPlugin } from 'librechat-data-provider';
import type { AgentPanelContextType, MCPServerInfo } from '~/common';
import {
  useAvailableToolsQuery,
  useGetActionsQuery,
  useGetStartupConfig,
  useMCPToolsQuery,
} from '~/data-provider';
import {
  useMCPServerManager,
  useGetAgentsConfig,
  activateCatalog,
  useCatalogReady,
  useLocalize,
} from '~/hooks';
import { isMCPServerReadyForAgent } from '~/components/MCP/mcpServerUtils';
import { useMCPRefresh } from '~/hooks/MCP/useMCPRefresh';
import { Panel } from '~/common';
import store from '~/store';

const AgentPanelContext = createContext<AgentPanelContextType | undefined>(undefined);

export function useAgentPanelContext() {
  const context = useContext(AgentPanelContext);
  if (context === undefined) {
    throw new Error('useAgentPanelContext must be used within an AgentPanelProvider');
  }
  return context;
}

/** Houses relevant state for the Agent Form Panels (formerly 'commonProps') */
export function AgentPanelProvider({
  children,
  observeToolAuthorization = true,
}: {
  children: React.ReactNode;
  observeToolAuthorization?: boolean;
}) {
  const localize = useLocalize();
  const location = useLocation();
  /** The panel stays mounted while the sidebar is hidden (collapsed, mobile
   * drawer, or the insights route collapsing it), so only a visible form
   * releases the MCP catalogs ahead of the background warmup schedule */
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  const panelVisible = sidebarExpanded && !location.pathname.startsWith('/insights');
  useEffect(() => {
    if (panelVisible) {
      activateCatalog('mcpServers');
      activateCatalog('mcpTools');
    }
  }, [panelVisible]);
  const observeVisibleToolAuthorization = panelVisible && observeToolAuthorization;
  const [mcp, setMcp] = useState<MCP | undefined>(undefined);
  const [mcps, setMcps] = useState<MCP[] | undefined>(undefined);
  const [action, setAction] = useState<Action | undefined>(undefined);
  const [activePanel, setActivePanel] = useState<Panel>(Panel.builder);
  const [agent_id, setCurrentAgentId] = useState<string | undefined>(undefined);
  const { availableMCPServers, isLoading, availableMCPServersMap, connectionStatus } =
    useMCPServerManager({ observeToolAuthorization: observeVisibleToolAuthorization });
  const { data: startupConfig } = useGetStartupConfig();
  const { data: actions } = useGetActionsQuery(EModelEndpoint.agents, {
    enabled: observeToolAuthorization,
  });

  const { data: regularTools } = useAvailableToolsQuery(EModelEndpoint.agents);

  /** The tools query keeps its own warmup gate: the servers list resolving
   * alone must not pull the heavier tools request ahead of its stagger. */
  const mcpToolsReady = useCatalogReady('mcpTools');
  useMCPRefresh({
    enabled:
      mcpToolsReady &&
      observeVisibleToolAuthorization &&
      !isLoading &&
      availableMCPServers.length > 0,
    tools: true,
  });
  const { data: mcpData, isFetching: mcpToolsFetching } = useMCPToolsQuery({
    enabled:
      mcpToolsReady &&
      observeVisibleToolAuthorization &&
      !isLoading &&
      availableMCPServers != null &&
      availableMCPServers.length > 0,
  });
  /** Tools are still arriving when the query is in flight and nothing is cached
   * yet (e.g., right after a hard refresh). Lets the MCP dialog show a skeleton. */
  const mcpToolsLoading = mcpToolsFetching && mcpData == null;

  const { agentsConfig, endpointsConfig } = useGetAgentsConfig();
  const mcpServerNames = useMemo(
    () => availableMCPServers.map((s) => s.serverName),
    [availableMCPServers],
  );

  //TODO to refactor when tools come from tool box
  const mcpServersMap = useMemo(() => {
    const configuredServers = new Set(mcpServerNames);
    const serversMap = new Map<string, MCPServerInfo>();

    if (mcpData?.servers) {
      for (const [serverName, serverData] of Object.entries(mcpData.servers)) {
        // Get title and description from config with fallbacks
        const serverConfig = availableMCPServersMap?.[serverName];
        const serverStatus = connectionStatus?.[serverName];
        const displayName = serverConfig?.title || serverName;
        const displayDescription =
          serverConfig?.description || `${localize('com_ui_tool_collection_prefix')} ${serverName}`;

        const metadata = {
          name: displayName,
          pluginKey: serverName,
          description: displayDescription,
          icon: serverData.icon || '',
          authConfig: serverData.authConfig,
          authenticated: serverData.authenticated,
        } as TPlugin;

        const tools = serverData.tools.map((tool) => ({
          tool_id: tool.pluginKey,
          metadata: {
            ...tool,
            icon: serverData.icon,
            authConfig: serverData.authConfig,
            authenticated: serverData.authenticated,
          } as TPlugin,
        }));

        serversMap.set(serverName, {
          serverName,
          tools,
          isConfigured: configuredServers.has(serverName),
          isConnected: serverStatus?.connectionState === 'connected',
          isReadyForAgent: isMCPServerReadyForAgent(
            serverStatus,
            serverConfig?.requestScoped === true,
            Object.keys(serverConfig?.customUserVars ?? {}).length > 0,
          ),
          requestScoped: serverConfig?.requestScoped,
          metadata,
          consumeOnly: serverConfig?.consumeOnly,
        });
      }
    }

    // Add configured servers that don't have tools yet
    for (const mcpServerName of mcpServerNames) {
      if (serversMap.has(mcpServerName)) {
        continue;
      }
      // Get title and description from config with fallbacks
      const serverConfig = availableMCPServersMap?.[mcpServerName];
      const serverStatus = connectionStatus?.[mcpServerName];
      const displayName = serverConfig?.title || mcpServerName;
      const displayDescription =
        serverConfig?.description ||
        `${localize('com_ui_tool_collection_prefix')} ${mcpServerName}`;

      const metadata = {
        icon: serverConfig?.iconPath || '',
        name: displayName,
        pluginKey: mcpServerName,
        description: displayDescription,
      } as TPlugin;

      serversMap.set(mcpServerName, {
        tools: [],
        metadata,
        isConfigured: true,
        serverName: mcpServerName,
        isConnected: serverStatus?.connectionState === 'connected',
        isReadyForAgent: isMCPServerReadyForAgent(
          serverStatus,
          serverConfig?.requestScoped === true,
          Object.keys(serverConfig?.customUserVars ?? {}).length > 0,
        ),
        requestScoped: serverConfig?.requestScoped,
        consumeOnly: serverConfig?.consumeOnly,
      });
    }

    return serversMap;
  }, [mcpData, localize, mcpServerNames, connectionStatus, availableMCPServersMap]);

  const value: AgentPanelContextType = {
    mcp,
    mcps,
    action,
    setMcp,
    actions,
    setMcps,
    agent_id,
    setAction,
    activePanel,
    regularTools,
    agentsConfig,
    startupConfig,
    mcpServersMap,
    mcpToolsLoading,
    setActivePanel,
    endpointsConfig,
    setCurrentAgentId,
    availableMCPServers,
    availableMCPServersMap,
  };

  return <AgentPanelContext.Provider value={value}>{children}</AgentPanelContext.Provider>;
}
