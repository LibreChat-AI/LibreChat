import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPConnection } from './connection';
import type { ParsedServerConfig } from './types';
import { requiresEphemeralUserConnection, hasRuntimeUrlPlaceholders } from './utils';

export type StatusConnection = Pick<MCPConnection, 'isStale' | 'getConnectionState' | 'usesOAuth'>;

export interface MCPStatusDependencies {
  getConfigurationState: (
    serverName: string,
    config: ParsedServerConfig,
  ) => Promise<MCPServerStatus['configurationState']>;
  isReconnecting: (userId: string, serverName: string) => boolean;
  getOAuthFlowStatus: (
    userId: string,
    serverName: string,
  ) => Promise<{ hasActiveFlow: boolean; hasFailedFlow: boolean }>;
  hasAuthorization: (
    userId: string,
    serverName: string,
    config: ParsedServerConfig,
  ) => Promise<boolean>;
}

/** A missing or idle transport is no observation of the user's integration on other replicas. */
export async function resolveMCPConnectionStatus(
  userId: string,
  serverName: string,
  config: ParsedServerConfig,
  appConnections: ReadonlyMap<string, StatusConnection>,
  userConnections: ReadonlyMap<string, StatusConnection>,
  oauthServers: ReadonlySet<string>,
  dependencies: MCPStatusDependencies,
): Promise<MCPServerStatus> {
  const connection = appConnections.get(serverName) || userConnections.get(serverName);
  const isStaleOrDoNotExist = connection ? connection.isStale(config.updatedAt ?? 0) : true;
  const configuredOAuth = oauthServers.has(serverName);
  const liveConnectionOAuth = connection?.usesOAuth?.() === true;
  const runtimeOAuthCandidate =
    config.requiresOAuth == null && config.apiKey == null && hasRuntimeUrlPlaceholders(config);
  const effectiveOAuth = configuredOAuth || liveConnectionOAuth;
  const requestScoped = requiresEphemeralUserConnection(config);
  const configurationState = await dependencies.getConfigurationState(serverName, config);

  const baseConnectionState = isStaleOrDoNotExist
    ? 'disconnected'
    : connection?.getConnectionState() || 'disconnected';
  let finalConnectionState = baseConnectionState;
  let connectionStateSource: MCPServerStatus['connectionStateSource'] = isStaleOrDoNotExist
    ? 'unobserved'
    : 'transport';
  let requiresOAuth = effectiveOAuth;
  let authorizationState: MCPServerStatus['authorizationState'] = effectiveOAuth
    ? 'needs_authorization'
    : 'not_required';

  // connection state overrides specific to OAuth servers
  if (effectiveOAuth && baseConnectionState === 'connected') {
    authorizationState = 'authorized';
  } else if (effectiveOAuth && baseConnectionState === 'connecting') {
    authorizationState = 'authorizing';
  } else if (effectiveOAuth && baseConnectionState === 'error') {
    authorizationState = 'error';
  } else if (baseConnectionState === 'disconnected' && (effectiveOAuth || runtimeOAuthCandidate)) {
    // check if server is actively being reconnected
    if (dependencies.isReconnecting(userId, serverName)) {
      connectionStateSource = 'authorization';
      requiresOAuth = true;
      finalConnectionState = 'connecting';
      authorizationState = 'authorizing';
    } else {
      const { hasActiveFlow, hasFailedFlow } = await dependencies.getOAuthFlowStatus(
        userId,
        serverName,
      );

      if (hasFailedFlow) {
        connectionStateSource = 'authorization';
        requiresOAuth = true;
        finalConnectionState = 'error';
        authorizationState = 'error';
      } else if (hasActiveFlow) {
        connectionStateSource = 'authorization';
        requiresOAuth = true;
        finalConnectionState = 'connecting';
        authorizationState = 'authorizing';
      } else if (await dependencies.hasAuthorization(userId, serverName, config)) {
        connectionStateSource = 'authorization';
        /** OAuth readiness is durable even when this pod has no live connection. */
        requiresOAuth = true;
        finalConnectionState = 'connected';
        authorizationState = 'authorized';
      }
    }
  }

  return {
    requiresOAuth,
    ...(requestScoped && { requestScoped: true }),
    ...(configurationState && { configurationState }),
    connectionState: finalConnectionState,
    connectionStateSource,
    authorizationState,
  };
}

/** Retain static metadata without inventing observations when a status lookup fails. */
export function getMCPUnavailableStatus(
  config: ParsedServerConfig,
  requiresOAuth: boolean,
): MCPServerStatus {
  return {
    requiresOAuth,
    ...(requiresEphemeralUserConnection(config) && { requestScoped: true }),
    connectionState: 'error',
    connectionStateSource: 'unavailable',
  };
}
