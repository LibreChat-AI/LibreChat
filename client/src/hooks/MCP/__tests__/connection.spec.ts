import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPConnectResult } from '~/store/mcp';
import { getMCPConnectKey, getMCPConnectionView, reconcileMCPConnectResult } from '../connection';

const server = {
  serverName: 'example',
  type: 'streamable-http' as const,
  url: 'https://example.test',
  updatedAt: 7,
};
const cold: MCPServerStatus = {
  requiresOAuth: false,
  connectionState: 'disconnected',
  connectionStateSource: 'unobserved',
  authorizationState: 'not_required',
  authorizationGeneration: 'generation',
};
const operation: MCPConnectResult = {
  id: 'attempt',
  configKey: getMCPConnectKey(server, 'owner'),
  configurationUpdatedAt: 7,
  state: 'connected',
  settledAt: 100,
  authorizationGeneration: 'generation',
};
const derive = (status: MCPServerStatus, result = operation, readStartedAt = 101) =>
  getMCPConnectionView(
    status,
    status,
    reconcileMCPConnectResult(result, status, server, 'owner', readStartedAt),
    { readStartedAt },
  );

it('retains operation evidence without turning a cold observation into a live connection', () => {
  const raw = Object.freeze({ ...cold });
  expect(derive(raw)).toMatchObject({
    state: 'succeeded',
    canUse: true,
    observation: raw,
    operation,
  });
  expect(derive(raw).observation).toBe(raw);
  expect(raw.connectionState).toBe('disconnected');
  expect(raw.authorizationGeneration).toBe('generation');
});
it('reports Unknown on cold-replica reload without session evidence', () => {
  expect(getMCPConnectionView(cold)).toMatchObject({ state: 'unknown', canUse: false });
});
it('keeps unavailable observation separate from historical success', () => {
  const raw = {
    ...cold,
    connectionStateSource: 'unavailable' as const,
    connectionState: 'error' as const,
  };
  expect(derive(raw)).toMatchObject({ state: 'succeeded', observation: raw });
  expect(getMCPConnectionView(raw)).toMatchObject({ state: 'unknown', canUse: false });
});
it.each(['error', 'connecting', 'disconnected', 'connected'] as const)(
  'newer actual transport %s wins',
  (connectionState) => {
    const view = derive({ ...cold, connectionState, connectionStateSource: 'transport' });
    if (connectionState === 'connected') expect(view.operation).toBe(operation);
    else expect(view.operation).toBeUndefined();
    expect(view.state).toBe(connectionState);
  },
);
it('recovery does not rewrite failed operation history', () => {
  const failed = Object.freeze({ ...operation, state: 'error' as const });
  expect(
    derive({ ...cold, connectionState: 'connected', connectionStateSource: 'transport' }, failed),
  ).toMatchObject({ state: 'connected', canUse: true });
  expect(failed.state).toBe('error');
});
it('older reads cannot rewrite the outcome or their own generations', () => {
  const raw = Object.freeze({
    ...cold,
    authorizationGeneration: 'old',
    authorizationState: 'error' as const,
  });
  expect(derive(raw, operation, 99).state).toBe('succeeded');
  expect(raw.authorizationGeneration).toBe('old');
});
it.each([
  { authorizationGeneration: 'new' },
  { authorizationState: 'needs_authorization' as const },
  { authorizationState: 'authorizing' as const },
  { configurationState: 'needs_configuration' as const },
])('new auth/config evidence %o wins', (change) => {
  expect(
    reconcileMCPConnectResult(operation, { ...cold, ...change }, server, 'owner', 101),
  ).toBeUndefined();
});
it('invalidates owner, configuration and used revision changes', () => {
  expect(reconcileMCPConnectResult(operation, cold, server, 'other', 101)).toBeUndefined();
  expect(
    reconcileMCPConnectResult(
      operation,
      cold,
      { ...server, url: 'https://changed.test' },
      'owner',
      101,
    ),
  ).toBeUndefined();
  expect(
    reconcileMCPConnectResult(operation, cold, { ...server, updatedAt: 8 }, 'owner', 101),
  ).toBeUndefined();
});
it('does not treat discovery metadata as configuration identity', () => {
  const discovered = { ...server, requiresOAuth: true, inspectionFailed: false };
  expect(getMCPConnectKey(discovered, 'owner')).toBe(getMCPConnectKey(server, 'owner'));
});
it('retains conservative handling for legacy unsourced status', () => {
  expect(derive({ ...cold, connectionStateSource: undefined })).toMatchObject({
    state: 'disconnected',
    canUse: false,
  });
});
it('distinguishes durable authorization from observed transport', () => {
  const raw = {
    ...cold,
    requiresOAuth: true,
    connectionState: 'connected' as const,
    connectionStateSource: 'authorization' as const,
    authorizationState: 'authorized' as const,
  };
  expect(getMCPConnectionView(raw)).toMatchObject({ state: 'authorized', canUse: true });
  expect(getMCPConnectionView({ ...raw, connectionStateSource: 'transport' })).toMatchObject({
    state: 'connected',
    canUse: true,
  });
});
it('requires known configuration for request-scoped readiness', () => {
  expect(
    getMCPConnectionView(cold, cold, undefined, { requestScoped: true, hasCustomUserVars: true }),
  ).toMatchObject({ state: 'unknown', canUse: false });
  expect(
    getMCPConnectionView(cold, { ...cold, configurationState: 'configured' }, undefined, {
      requestScoped: true,
      hasCustomUserVars: true,
    }),
  ).toMatchObject({ state: 'on_demand', canUse: true });
});

it.each([null, false, 5, 'tool', { arbitrary: true }, ['tool']])(
  'ignores discovery-only wire values without assumptions: %o',
  (tools) => {
    const discovered = { ...server, tools, toolFunctions: tools, capabilities: tools };
    expect(getMCPConnectKey(discovered, 'owner')).toBe(getMCPConnectKey(server, 'owner'));
  },
);

it('does not expose readiness for a removed configuration despite cached transport success', () => {
  const raw = {
    ...cold,
    connectionState: 'connected' as const,
    connectionStateSource: 'transport' as const,
  };
  expect(getMCPConnectionView(raw, raw, operation, { configured: false })).toMatchObject({
    state: 'unknown',
    canUse: false,
  });
  expect(raw.connectionState).toBe('connected');
});
