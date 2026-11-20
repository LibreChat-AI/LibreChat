import type { MCPServerStatus, MCPServersListResponse } from 'librechat-data-provider';
import type { MCPConnectResult } from '~/store/mcp';

const discoveryFields = new Set([
  'tools',
  'toolFunctions',
  'initDuration',
  'capabilities',
  'inspectionFailed',
  'requiresOAuth',
  'updatedAt',
]);

export function getMCPConnectKey(
  server: MCPServersListResponse[string] | undefined,
  owner: string,
): string {
  const configuration = Object.fromEntries(
    Object.entries(server ?? {}).filter(([key]) => !discoveryFields.has(key)),
  );
  return JSON.stringify([owner, configuration]);
}

/** Only relevant operation evidence may influence presentation; observations remain untouched. */
export function reconcileMCPConnectResult(
  result: MCPConnectResult,
  current: MCPServerStatus | undefined,
  server: MCPServersListResponse[string] | undefined,
  owner: string,
  readStartedAt?: number,
): MCPConnectResult | undefined {
  if (result.configKey !== getMCPConnectKey(server, owner)) return;
  if (
    result.state !== 'connecting' &&
    result.configurationUpdatedAt != null &&
    server?.updatedAt != null &&
    result.configurationUpdatedAt !== server.updatedAt &&
    result.requestedConfigurationUpdatedAt !== server.updatedAt
  )
    return;
  if (result.state === 'connecting') return result;
  const newer =
    result.settledAt == null || readStartedAt == null || readStartedAt > result.settledAt;
  if (!newer || current?.connectionStateSource === 'unavailable') return result;
  if (
    current?.configurationState === 'needs_configuration' ||
    (result.authorizationGeneration != null &&
      current?.authorizationGeneration != null &&
      result.authorizationGeneration !== current.authorizationGeneration) ||
    current?.authorizationState === 'needs_authorization' ||
    current?.authorizationState === 'authorizing' ||
    current?.authorizationState === 'error'
  )
    return;
  if (
    (current?.connectionStateSource === 'transport' &&
      (current.connectionState !== 'connected' || result.state === 'error')) ||
    (current?.connectionStateSource == null &&
      (current?.connectionState === 'error' || current?.connectionState === 'disconnected'))
  )
    return;
  return result;
}

export type MCPConnectionState =
  | 'connecting'
  | 'connected'
  | 'authorized'
  | 'succeeded'
  | 'failed'
  | 'error'
  | 'needs_authorization'
  | 'needs_configuration'
  | 'on_demand'
  | 'unknown'
  | 'disconnected';

export interface MCPConnectionView {
  state: MCPConnectionState;
  canUse: boolean;
  requestScoped?: boolean;
  observation?: MCPServerStatus;
  operation?: MCPConnectResult;
}

/** A local presentation model, never an API status or a claim about another replica's health. */
export function getMCPConnectionView(
  observation: MCPServerStatus | undefined,
  status = observation,
  operation?: MCPConnectResult,
  options: {
    initializing?: boolean;
    requestScoped?: boolean;
    hasCustomUserVars?: boolean;
    configured?: boolean;
    readStartedAt?: number;
  } = {},
): MCPConnectionView {
  const view = (state: MCPConnectionState, canUse = false): MCPConnectionView => ({
    state,
    canUse,
    requestScoped: options.requestScoped || status?.requestScoped,
    observation,
    operation,
  });
  if (options.initializing || operation?.state === 'connecting') return view('connecting');
  if (options.configured === false) return view('unknown');
  const observedAfterOperation =
    operation?.settledAt == null ||
    options.readStartedAt == null ||
    options.readStartedAt > operation.settledAt;
  if (
    operation?.state === 'connected' &&
    !(
      status?.connectionState === 'connected' &&
      (status.connectionStateSource === 'authorization' ||
        (status.connectionStateSource === 'transport' && observedAfterOperation))
    )
  )
    return view('succeeded', true);
  if (operation?.state === 'error') return view('failed');
  if (status?.configurationState === 'needs_configuration') return view('needs_configuration');
  if (status?.authorizationState === 'authorizing') return view('connecting');
  if (status?.authorizationState === 'needs_authorization') return view('needs_authorization');
  if (status?.authorizationState === 'error') return view('error');
  if (!status || status.connectionStateSource === 'unavailable') return view('unknown');
  if (status.connectionState === 'connecting') return view('connecting');
  const requestScoped = options.requestScoped || status.requestScoped;
  if (requestScoped && options.hasCustomUserVars && status.configurationState !== 'configured') {
    return view('unknown');
  }
  if (requestScoped && status.connectionState !== 'error') {
    const ready =
      status.authorizationState === 'authorized' || status.authorizationState === 'not_required';
    return view('on_demand', ready);
  }
  if (status.connectionState === 'error') return view('error');
  if (
    status.authorizationState === 'authorized' &&
    status.connectionStateSource === 'authorization'
  ) {
    return view('authorized', true);
  }
  if (status.connectionState === 'connected') return view('connected', true);
  if (status.connectionStateSource === 'unobserved') return view('unknown');
  if (status.requiresOAuth) return view('needs_authorization');
  return view('disconnected');
}
