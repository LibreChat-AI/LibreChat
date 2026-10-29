const {
  PermissionBits,
  ResourceType,
  Permissions,
  PermissionTypes,
} = require('librechat-data-provider');

const mockCreateResponseResumeValidation = jest.fn(() => ({}));
const mockGetEffectivePermissions = jest.fn();
const mockAuthorizeChannelResponseKeySource = jest.fn().mockResolvedValue(false);

jest.mock('@librechat/api', () => ({
  getRemoteAgentPermissions: jest.requireActual('../../../packages/api/src/apiKeys/service')
    .getRemoteAgentPermissions,
  createResponseResumeValidation: (...args) => mockCreateResponseResumeValidation(...args),
  createBackgroundResponseAuthority: jest.fn(() => jest.fn()),
  createResponseResumeAdmission: jest.fn(() => jest.fn()),
  createBackgroundResponsesHost: jest.fn(() => ({ initialize: jest.fn() })),
  GenerationJobManager: {},
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  createResponseStorage: jest.fn(),
  logger: {},
}));
jest.mock('./PermissionService', () => ({
  getEffectivePermissions: (...args) => mockGetEffectivePermissions(...args),
}));
jest.mock('./ActionService', () => ({ decryptMetadata: jest.fn() }));
jest.mock('./Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/models', () => ({}));
jest.mock('./ChannelAuthority', () => ({
  authorizeChannelResponseKeySource: (...args) => mockAuthorizeChannelResponseKeySource(...args),
}));

describe('Responses resume permission composition', () => {
  let canAccessAgent;
  const agent = { _id: 'stored-agent-resource-id' };
  const user = { id: 'verified-owner', role: 'USER' };

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetEffectivePermissions.mockReset();
    require('./Responses');
    canAccessAgent = mockCreateResponseResumeValidation.mock.calls[0][0].content.canAccessAgent;
  });

  it('inherits Remote Agent access from current Agent SHARE without a separate remote grant', async () => {
    mockGetEffectivePermissions.mockImplementation(async ({ resourceType }) =>
      resourceType === ResourceType.AGENT ? PermissionBits.SHARE : 0,
    );

    await expect(canAccessAgent(agent, user)).resolves.toBe(true);
    expect(mockGetEffectivePermissions).toHaveBeenCalledTimes(1);
    expect(mockGetEffectivePermissions).toHaveBeenCalledWith({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.AGENT,
      resourceId: agent._id,
    });
  });

  it('honors an explicit Remote Agent VIEW grant without Agent SHARE', async () => {
    mockGetEffectivePermissions.mockImplementation(async ({ resourceType }) =>
      resourceType === ResourceType.REMOTE_AGENT ? PermissionBits.VIEW : 0,
    );

    await expect(canAccessAgent(agent, user)).resolves.toBe(true);
    expect(mockGetEffectivePermissions).toHaveBeenLastCalledWith({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.REMOTE_AGENT,
      resourceId: agent._id,
    });
  });

  it('rejects absent grants and rechecks current permissions after revocation', async () => {
    mockGetEffectivePermissions.mockResolvedValue(PermissionBits.SHARE);
    await expect(canAccessAgent(agent, user)).resolves.toBe(true);

    mockGetEffectivePermissions.mockResolvedValue(0);
    await expect(canAccessAgent(agent, user)).resolves.toBe(false);
    expect(mockGetEffectivePermissions).toHaveBeenLastCalledWith({
      userId: user.id,
      role: user.role,
      resourceType: ResourceType.REMOTE_AGENT,
      resourceId: agent._id,
    });
  });

  it('delegates bound-key authority to Channels and still denies unknown bindings', async () => {
    const { createBackgroundResponseAuthority } = require('@librechat/api');
    const dependencies = createBackgroundResponseAuthority.mock.calls[0][0];
    expect(dependencies.authorizeBinding).toEqual(expect.any(Function));
    const createAuthority = jest.requireActual(
      '../../../packages/api/src/agents/responses/authority',
    ).createBackgroundResponseAuthority;
    const key = { binding: { kind: 'uninstalled-source', id: 'source' } };
    const authorize = createAuthority({
      ...dependencies,
      findUser: async () => ({ _id: 'owner', tenantId: 'tenant', role: 'USER' }),
      getKey: async () => key,
      getRole: async () => ({
        permissions: { [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true } },
      }),
      getConfig: async () => ({
        endpoints: { agents: { remoteApi: { background: { enabled: true } } } },
      }),
      getAgentPermissions: async () => PermissionBits.VIEW,
      isPrincipalActive: async () => true,
    });
    const owner = { userId: 'owner', tenantId: 'tenant' };
    await expect(authorize(owner, 'agent', 'key')).resolves.toBe(false);
    expect(mockAuthorizeChannelResponseKeySource).toHaveBeenCalledWith(
      key.binding,
      'key',
      owner,
      'agent',
    );
    mockAuthorizeChannelResponseKeySource.mockClear();
    delete key.binding;
    await expect(authorize(owner, 'agent', 'key')).resolves.toBe(true);
    expect(mockAuthorizeChannelResponseKeySource).not.toHaveBeenCalled();
  });

  it('uses the startup-injected queue without importing the trigger composition', async () => {
    const { createBackgroundResponsesHost } = require('@librechat/api');
    const enqueue = jest.fn().mockResolvedValue({ deliveryId: 'delivery' });
    const { initializeBackgroundResponses } = require('./Responses');
    expect(() =>
      createBackgroundResponsesHost.mock.calls[0][0].enqueue('uninitialized', 'options'),
    ).toThrow();
    expect(enqueue).not.toHaveBeenCalled();
    initializeBackgroundResponses('listener', enqueue);
    expect(createBackgroundResponsesHost.mock.results[0].value.initialize).toHaveBeenCalledWith(
      'listener',
    );
    await expect(
      createBackgroundResponsesHost.mock.calls[0][0].enqueue('envelope', 'options'),
    ).resolves.toEqual({ deliveryId: 'delivery' });
    expect(enqueue).toHaveBeenCalledWith('envelope', 'options');
  });
});
