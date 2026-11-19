import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPServerDefinition } from '~/hooks/MCP/useMCPServerManager';
import type { MCPServerStatusIconProps } from './MCPServerStatusIcon';
import type { MCPConnectionView } from '~/hooks/MCP/connection';

export type { MCPServerStatus };

export interface SelectedIconInfo {
  key: string;
  serverName: string;
  iconPath: string | null;
  displayName: string;
}

export type ConnectionStatusMap = Record<string, MCPServerStatus>;

/** Show the established transport states without turning readiness into live health. */
export function getMCPDisplayStatus(
  status: MCPServerStatus | undefined,
  view?: MCPConnectionView,
): MCPServerStatus | undefined {
  switch (view?.state) {
    case 'failed':
      return {
        ...status,
        requiresOAuth: status?.requiresOAuth ?? false,
        requestScoped: false,
        connectionState: 'error',
      };
    case 'succeeded':
    case 'unknown':
    case 'authorized':
      return undefined;
    default:
      return status?.connectionStateSource === 'unavailable' ? undefined : status;
  }
}

/** Existing connection actions stay available after a confirmed Connect. */
export function getMCPControlState(
  status: MCPServerStatus | undefined,
  view?: MCPConnectionView,
): MCPServerStatus['connectionState'] | undefined {
  if (view?.state === 'succeeded') return 'connected';
  if (view?.state === 'failed') return 'error';
  return status?.connectionState;
}

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
  return getMCPStatusColor(
    getMCPDisplayStatus(connectionStatus?.[serverName], view),
    isInitializing?.(serverName),
  );
}

export function getMCPStatusColor(status?: MCPServerStatus, isInitializing?: boolean): string {
  if (isInitializing) {
    return 'bg-status-info';
  }

  if (!status) {
    return 'bg-status-neutral';
  }

  const { connectionState, requiresOAuth, requestScoped } = status;

  // Connecting: blue (in progress)
  if (connectionState === 'connecting') {
    return 'bg-status-info';
  }

  if (requestScoped) {
    return 'bg-status-info';
  }

  // Connected: green (success)
  if (connectionState === 'connected') {
    return 'bg-status-success';
  }

  // Error: red
  if (connectionState === 'error') {
    return 'bg-status-error';
  }

  // Disconnected: check if needs action or just inactive
  if (connectionState === 'disconnected') {
    // Needs OAuth = amber (requires user action)
    if (requiresOAuth) {
      return 'bg-status-warning';
    }
    // Simply disconnected = gray (neutral/inactive)
    return 'bg-status-neutral';
  }

  return 'bg-status-neutral';
}

export function getStatusTextKey(
  serverName: string,
  connectionStatus?: ConnectionStatusMap,
  isInitializing?: (serverName: string) => boolean,
  view?: MCPConnectionView,
): string {
  if (isInitializing?.(serverName)) {
    return 'com_nav_mcp_status_initializing';
  }

  const status = getMCPDisplayStatus(connectionStatus?.[serverName], view);
  if (!status) {
    return 'com_nav_mcp_status_unknown';
  }

  const { connectionState, requiresOAuth, requestScoped } = status;

  if (connectionState === 'connecting') {
    return 'com_nav_mcp_status_connecting';
  }

  if (requestScoped) {
    return 'com_nav_mcp_status_on_demand';
  }

  // Special case: disconnected but needs OAuth shows different text
  if (connectionState === 'disconnected' && requiresOAuth) {
    return 'com_nav_mcp_status_needs_auth';
  }

  const keyMap: Record<string, string> = {
    connected: 'com_nav_mcp_status_connected',
    connecting: 'com_nav_mcp_status_connecting',
    disconnected: 'com_nav_mcp_status_disconnected',
    error: 'com_nav_mcp_status_error',
  };

  return keyMap[connectionState] || 'com_nav_mcp_status_unknown';
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
  if (status?.configurationState === 'needs_configuration') return false;
  if (requestScoped && hasCustomUserVars && status?.configurationState !== 'configured') {
    return false;
  }
  if (status?.connectionState === 'connected') {
    return true;
  }
  if (!requestScoped) {
    return false;
  }
  return (
    status?.authorizationState === 'not_required' || status?.authorizationState === 'authorized'
  );
}

/** Both the menu slot and the icon use the same actionable state. */
export function getMCPServerAction({
  serverStatus,
  view,
  canCancel,
  hasCustomUserVars,
  isInitializing,
}: MCPServerStatusIconProps): 'cancel' | 'configure' | 'connect' | undefined {
  const connectionState = getMCPControlState(serverStatus, view);
  if (isInitializing || connectionState === 'connecting') {
    return canCancel ? 'cancel' : undefined;
  }
  const requestScoped = view?.requestScoped ?? serverStatus?.requestScoped;
  if (connectionState === 'connected' || requestScoped) {
    return hasCustomUserVars ? 'configure' : undefined;
  }
  if (connectionState === 'disconnected' || connectionState === 'error') return 'connect';
}

export function shouldShowActionButton(statusIconProps?: MCPServerStatusIconProps | null): boolean {
  return statusIconProps != null && getMCPServerAction(statusIconProps) != null;
}
