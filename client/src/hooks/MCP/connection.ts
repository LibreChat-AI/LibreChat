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
  // Inspection can change derived fields. The used revision fences configuration edits.
  const configuration = Object.fromEntries(
    Object.entries(server ?? {}).filter(([key]) => !discoveryFields.has(key)),
  );
  return JSON.stringify([owner, configuration]);
}

/** Reconcile one session outcome with a scoped status observation. */
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
    result.configurationUpdatedAt !== server.updatedAt
  )
    return;
  if (current?.connectionStateSource === 'unavailable') return result;
  if (
    current?.configurationState === 'needs_configuration' ||
    (result.authorizationGeneration != null &&
      current?.authorizationGeneration != null &&
      result.authorizationGeneration !== current.authorizationGeneration)
  )
    return;
  if (
    result.state !== 'connecting' &&
    (current?.authorizationState === 'needs_authorization' ||
      current?.authorizationState === 'authorizing' ||
      current?.authorizationState === 'error')
  )
    return;
  const observedAfterConnect =
    result.settledAt != null && readStartedAt != null && readStartedAt > result.settledAt;
  if (
    result.state === 'connected' &&
    (result.settledAt == null || observedAfterConnect) &&
    current &&
    (current.connectionState === 'error' ||
      current.connectionState === 'connecting' ||
      (current.connectionState === 'disconnected' &&
        current.connectionStateSource !== 'unobserved' &&
        current.connectionStateSource != null))
  )
    return;
  if (
    result.state === 'error' &&
    current?.connectionState === 'connected' &&
    current.connectionStateSource === 'transport' &&
    observedAfterConnect
  )
    return { ...result, state: 'connected' };
  return result;
}

/** A missing local client cannot undo the session's confirmed connection outcome. */
export function applyMCPConnectResults(
  statuses: Record<string, MCPServerStatus> | undefined,
  results: Record<string, MCPConnectResult>,
  servers: MCPServersListResponse | undefined,
  owner: string,
  readStartedAt?: number,
): Record<string, MCPServerStatus> | undefined {
  let next = statuses;
  for (const [name, result] of Object.entries(results)) {
    if (servers && !servers[name]) continue;
    const current = statuses?.[name];
    const reconciled = reconcileMCPConnectResult(
      result,
      current,
      servers?.[name],
      owner,
      readStartedAt,
    );
    if (!reconciled) continue;
    next = {
      ...next,
      [name]: {
        requiresOAuth: false,
        authorizationState: 'not_required',
        ...current,
        ...(current?.connectionStateSource === 'unavailable' && {
          connectionStateSource: 'unobserved',
          authorizationState: current.requiresOAuth ? undefined : 'not_required',
        }),
        connectionState: reconciled.state,
      },
    };
  }
  return next;
}
