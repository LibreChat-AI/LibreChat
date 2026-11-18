import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPServerDefinition } from '~/hooks/MCP/useMCPServerManager';
import type { MCPServerStatusIconProps } from './MCPServerStatusIcon';
import type { MCPConnectionView } from '~/hooks/MCP/connection';
import { getMCPConnectionView } from '~/hooks/MCP/connection';

export type { MCPServerStatus };

export interface SelectedIconInfo {
  key: string;
  serverName: string;
  iconPath: string | null;
  displayName: string;
}

export type ConnectionStatusMap = Record<string, MCPServerStatus>;

/**
 * Generates a list of icons to display for selected MCP servers.
 * - Custom icons are shown individually
 * - Multiple default icons are consolidated into one
 * - Limited to maxIcons with overflow count
 */
export function getSelectedServerIcons(
  selectedServers: MCPServerDefinition[],
  maxIcons: number = 3,
): { icons: SelectedIconInfo[]; overflowCount: number; defaultServerNames: string[] } {
  const customIcons: SelectedIconInfo[] = [];
  const defaultServerNames: string[] = [];

  for (const server of selectedServers) {
    const displayName = server.config?.title || server.serverName;
    if (server.config?.iconPath) {
      customIcons.push({
        key: server.serverName,
        serverName: server.serverName,
        iconPath: server.config.iconPath,
        displayName,
      });
    } else {
      defaultServerNames.push(server.serverName);
    }
  }

  // Add one default icon entry if any server uses default icon
  // Custom icons are prioritized first, default icon comes last
  const allIcons: SelectedIconInfo[] =
    defaultServerNames.length > 0
      ? [
          ...customIcons,
          {
            key: '_default_',
            serverName: defaultServerNames[0],
            iconPath: null,
            displayName: 'MCP',
          },
        ]
      : customIcons;

  const visibleIcons = allIcons.slice(0, maxIcons);
  const overflowCount = Math.max(0, allIcons.length - maxIcons);

  return { icons: visibleIcons, overflowCount, defaultServerNames };
}

/**
 * Unified status color system following UX best practices:
 * - Green: Connected/Active (success)
 * - Blue: Connecting/In-progress or request-scoped on-demand
 * - Amber: Needs user action (OAuth required, config missing)
 * - Gray: Disconnected/Inactive (neutral - server is simply off)
 * - Red: Error (failed, needs retry)
 *
 * Key insight: "Disconnected" is neutral (gray), not a warning.
 * Amber is reserved for states requiring user intervention.
 */
export function getStatusColor(
  serverName: string,
  connectionStatus?: ConnectionStatusMap,
  isInitializing?: (serverName: string) => boolean,
  view?: MCPConnectionView,
): string {
  const state = (
    view ??
    getMCPConnectionView(connectionStatus?.[serverName], undefined, undefined, {
      initializing: isInitializing?.(serverName),
    })
  ).state;
  if (state === 'connecting' || state === 'on_demand') return 'bg-status-info';
  if (state === 'needs_authorization' || state === 'needs_configuration')
    return 'bg-status-warning';
  if (state === 'connected' || state === 'authorized' || state === 'succeeded')
    return 'bg-status-success';
  if (state === 'error' || state === 'failed') return 'bg-status-error';
  return 'bg-status-neutral';
}

export function getStatusTextKey(
  serverName: string,
  connectionStatus?: ConnectionStatusMap,
  isInitializing?: (serverName: string) => boolean,
  view?: MCPConnectionView,
): string {
  if (isInitializing?.(serverName)) return 'com_nav_mcp_status_initializing';
  const state = (view ?? getMCPConnectionView(connectionStatus?.[serverName])).state;
  const keys = {
    connecting: 'com_nav_mcp_status_connecting',
    connected: 'com_nav_mcp_status_connected',
    authorized: 'com_nav_mcp_status_authorized',
    succeeded: 'com_nav_mcp_status_last_success',
    failed: 'com_nav_mcp_status_last_failure',
    error: 'com_nav_mcp_status_error',
    needs_authorization: 'com_nav_mcp_status_needs_auth',
    needs_configuration: 'com_ui_tools_mcp_status_unconfigured',
    on_demand: 'com_nav_mcp_status_on_demand',
    unknown: 'com_nav_mcp_status_unknown',
    disconnected: 'com_nav_mcp_status_disconnected',
  };
  return keys[state];
}

/**
 * Request-scoped servers are usable without an idle transport connection once
 * their authorization requirement is satisfied. Agent tooling uses this
 * readiness signal to attach the runtime wildcard instead of waiting for a
 * tool catalog that can only be discovered during a chat request.
 */
export function isMCPServerReadyForAgent(
  status: MCPServerStatus | undefined,
  requestScoped: boolean,
  hasCustomUserVars = false,
  view?: MCPConnectionView,
): boolean {
  if (view) return view.canUse;
  if (status?.configurationState === 'needs_configuration') {
    return false;
  }
  if (status?.connectionState === 'connected') {
    return true;
  }
  if (!requestScoped || (hasCustomUserVars && status?.configurationState !== 'configured')) {
    return false;
  }
  return (
    status?.authorizationState === 'not_required' || status?.authorizationState === 'authorized'
  );
}

/**
 * Determines if an action button should be shown for a server status.
 * Returns true only when the button would be actionable (not just informational).
 */
export function shouldShowActionButton(statusIconProps?: MCPServerStatusIconProps | null): boolean {
  if (!statusIconProps) return false;

  const { serverStatus, canCancel, hasCustomUserVars, isInitializing, view } = statusIconProps;
  if (view?.state === 'succeeded' || view?.state === 'failed' || view?.state === 'unknown')
    return true;

  // Show cancel button during OAuth flow
  if (isInitializing && canCancel) return true;
  // Don't show spinner-only state (no action available)
  if (isInitializing) return false;

  if (!serverStatus) return false;
  const { connectionState, requiresOAuth, requestScoped } = serverStatus;

  // Request-scoped servers can only be initialized with an active MCP request context,
  // but their per-user variables must remain configurable while idle.
  if ((connectionState === 'disconnected' || connectionState === 'error') && requestScoped) {
    return hasCustomUserVars === true;
  }
  if (connectionState === 'connected' && requestScoped) return hasCustomUserVars === true;
  // Show for disconnected/error (can reconnect/configure)
  if (connectionState === 'disconnected' || connectionState === 'error') return true;
  // Show a cancel action for pending OAuth connections.
  if (connectionState === 'connecting' && requiresOAuth && canCancel) return true;
  // Don't show connecting spinner when no action is available.
  if (connectionState === 'connecting') return false;
  // Connected: only show if there's config to manage
  if (connectionState === 'connected') return hasCustomUserVars || requiresOAuth;

  return false;
}
