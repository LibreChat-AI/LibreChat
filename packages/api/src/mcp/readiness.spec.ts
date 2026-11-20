import type { MCPStatusDependencies, StatusConnection } from './readiness';
import type { ParsedServerConfig } from './types';
import { resolveMCPConnectionStatus } from './readiness';

const config: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.example.test',
  startup: false,
  requiresOAuth: false,
};
const dependencies: MCPStatusDependencies = {
  getConfigurationState: async () => undefined,
  isReconnecting: () => false,
  getOAuthFlowStatus: async () => ({ hasActiveFlow: false, hasFailedFlow: false }),
  hasAuthorization: async () => false,
};
const connection = (
  connectionState: ReturnType<StatusConnection['getConnectionState']>,
): StatusConnection => ({
  isStale: () => false,
  usesOAuth: () => false,
  getConnectionState: () => connectionState,
});
const resolve = (connections: Map<string, StatusConnection>, deps = dependencies, oauth = false) =>
  resolveMCPConnectionStatus(
    'user',
    'server',
    config,
    new Map(),
    connections,
    new Set(oauth ? ['server'] : []),
    deps,
  );

describe('MCP status observations', () => {
  it('distinguishes a connected A from an unobserved cold B without inferring a failure', async () => {
    expect(await resolve(new Map([['server', connection('connected')]]))).toMatchObject({
      connectionState: 'connected',
      connectionStateSource: 'transport',
    });
    expect(await resolve(new Map())).toMatchObject({
      connectionState: 'disconnected',
      connectionStateSource: 'unobserved',
      authorizationState: 'not_required',
    });
  });
  it.each(['error', 'connecting', 'disconnected'] as const)(
    'keeps an explicit %s observable',
    async (state) => {
      expect(await resolve(new Map([['server', connection(state)]]))).toMatchObject({
        connectionState: state,
        connectionStateSource: 'transport',
      });
    },
  );
  it('evaluates required variables for ordinary servers as well as request-scoped servers', async () => {
    expect(
      await resolve(new Map(), {
        ...dependencies,
        getConfigurationState: async () => 'needs_configuration',
      }),
    ).toMatchObject({ configurationState: 'needs_configuration' });
  });
  it('preserves durable OAuth readiness on cold B', async () => {
    expect(
      await resolve(new Map(), { ...dependencies, hasAuthorization: async () => true }, true),
    ).toMatchObject({
      connectionState: 'connected',
      authorizationState: 'authorized',
      connectionStateSource: 'authorization',
    });
  });
  it.each(['pending', 'failed'] as const)('preserves the %s OAuth transition', async (flow) => {
    expect(
      await resolve(
        new Map(),
        {
          ...dependencies,
          getOAuthFlowStatus: async () => ({
            hasActiveFlow: flow === 'pending',
            hasFailedFlow: flow === 'failed',
          }),
        },
        true,
      ),
    ).toMatchObject({
      connectionState: flow === 'pending' ? 'connecting' : 'error',
      authorizationState: flow === 'pending' ? 'authorizing' : 'error',
      connectionStateSource: 'authorization',
    });
  });
});

it('keeps a stale loaded client unobserved', async () => {
  expect(
    await resolve(new Map([['server', { ...connection('connected'), isStale: () => true }]])),
  ).toMatchObject({ connectionState: 'disconnected', connectionStateSource: 'unobserved' });
});
