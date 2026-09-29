import type {
  MCPServerStatus,
  MCPServersResponse,
  MCPOAuthStatusResponse,
  MCPReinitializeResponse,
} from 'librechat-data-provider';

export function applyMCPDiscoveryAuthorizationState(
  connectionStatus: Record<string, MCPServerStatus> | undefined,
  discoveredTools: MCPServersResponse | undefined,
): Record<string, MCPServerStatus> | undefined {
  const reauthRequired = Object.entries(discoveredTools?.servers ?? {})
    .filter(([, server]) => server.authorizationState === 'reauth_required')
    .map(([serverName]) => serverName);
  if (reauthRequired.length === 0) {
    return connectionStatus;
  }

  const nextStatus = { ...(connectionStatus ?? {}) };
  let changed = false;
  for (const serverName of reauthRequired) {
    const discoveryGeneration = discoveredTools?.servers[serverName]?.authorizationGeneration;
    const current = nextStatus?.[serverName];
    const statusGeneration = current?.authorizationGeneration;
    const statusIsActive =
      current?.connectionState === 'connecting' || current?.authorizationState === 'authorizing';
    if (statusIsActive) {
      continue;
    }
    const statusAuthorizes =
      current?.connectionState === 'connected' || current?.authorizationState === 'authorized';
    if (statusAuthorizes && (discoveryGeneration == null || statusGeneration == null)) {
      continue;
    }
    if (
      discoveryGeneration != null &&
      statusGeneration != null &&
      discoveryGeneration !== statusGeneration
    ) {
      continue;
    }
    changed = true;
    nextStatus[serverName] = {
      ...current,
      requiresOAuth: true,
      connectionState: 'disconnected',
      authorizationState: 'needs_authorization',
    };
  }
  return changed ? nextStatus : connectionStatus;
}

export type MCPOAuthPollingOutcome = 'pending' | 'completed' | 'failed';

export function getMCPOAuthTimeout(
  attemptTimeout: number | undefined,
  connectionTimeout: number | undefined,
  fallback = 600_000,
): number {
  return attemptTimeout ?? connectionTimeout ?? fallback;
}

/**
 * A missing or unauthorized flow is terminal for this browser poll. Retrying it
 * forever leaves the OAuth spinner active after the shared flow record is gone.
 */
export function isTerminalMCPOAuthPollingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
  const status =
    typeof responseStatus === 'number' ? responseStatus : (error as { status?: unknown }).status;
  return status === 403 || status === 404;
}

export function getMCPOAuthPollingOutcome(status: MCPOAuthStatusResponse): MCPOAuthPollingOutcome {
  if (status.completed || status.status === 'COMPLETED') {
    return 'completed';
  }
  if (status.failed || status.status === 'FAILED') {
    return 'failed';
  }
  return 'pending';
}

/** An active flow endpoint is newer and more specific than cached connection status. */
export function shouldUseMCPConnectionStatus(
  flowId: string | undefined,
  terminalFlowError: boolean,
): boolean {
  return !flowId || terminalFlowError;
}

/** A legacy pod's missing flow route is not terminal while shared fallback state is active. */
export function shouldFailMCPOAuthFallback(
  terminalFlowError: boolean,
  serverStatus: MCPServerStatus | undefined,
): boolean {
  if (!terminalFlowError) {
    return false;
  }
  return (
    serverStatus?.authorizationState !== 'authorizing' &&
    serverStatus?.connectionState !== 'connecting'
  );
}

/** OAuth completion proves credentials were stored; reinitialization proves this request pod can use them. */
export function isMCPReadyAfterOAuth(response: MCPReinitializeResponse): boolean {
  return response.success && response.oauthRequired !== true;
}
