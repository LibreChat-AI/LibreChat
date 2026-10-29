const mockRunStorage = { read: jest.fn() };
const mockIdentityStorage = {};
const mockResponseStorage = {};
const mockAuthority = {
  resolvePrincipal: jest.fn(),
  authorizeTrigger: jest.fn(),
  authorizeGeneration: jest.fn(),
  authorizeResume: jest.fn(),
};
const mockCredentials = {
  provision: jest.fn(),
  authorizeRequest: jest.fn(),
  authorizeSource: jest.fn(),
};
const mockCreateAuthority = jest.fn(() => mockAuthority);
const mockCreateCredentials = jest.fn(() => mockCredentials);
const mockCheckAccess = jest.fn();
const mockGetAgent = jest.fn();
const mockGetChannelMetadata = jest.fn();
const mockGetConfig = jest.fn();

jest.mock('@librechat/api', () => ({
  createChannelAuthority: (...args) => mockCreateAuthority(...args),
  createChannelResponseCredentials: (...args) => mockCreateCredentials(...args),
  checkRemoteAgentAccess: (...args) => mockCheckAccess(...args),
  encryptCredential: jest.fn(),
  decryptCredential: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  createChannelIdentityStorage: () => mockIdentityStorage,
  createChannelRunStorage: () => mockRunStorage,
  createResponseStorage: () => mockResponseStorage,
}));
jest.mock('./Config', () => ({ getAppConfig: (...args) => mockGetConfig(...args) }));
jest.mock('./PermissionService', () => ({ getEffectivePermissions: jest.fn() }));
jest.mock('~/models', () => ({
  getAgent: (...args) => mockGetAgent(...args),
  getAgentChannelMetadata: mockGetChannelMetadata,
  findUser: jest.fn(),
  getRoleByName: jest.fn(),
  isAgentTriggerPrincipalActive: jest.fn(),
  createAgentApiKey: jest.fn(),
  getAgentApiKeyById: jest.fn(),
  deleteAgentApiKey: jest.fn(),
}));
jest.mock('./Responses', () => {
  throw new Error('Authority must not import the Responses host');
});
jest.mock('./Agents/triggers', () => {
  throw new Error('Authority must not import the trigger host');
});

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockGetConfig.mockResolvedValue({ endpoints: { agents: { channels: {} } } });
});

it('shares the exact run storage and live principal resolver across authority and credentials', () => {
  const leaf = require('./ChannelAuthority');
  expect(mockCreateAuthority.mock.calls[0][0]).toMatchObject({
    channels: { getAgentChannel: mockGetChannelMetadata },
    identityStorage: mockIdentityStorage,
    runs: mockRunStorage,
  });
  expect(mockCreateCredentials.mock.calls[0][0]).toMatchObject({
    storage: mockRunStorage,
    responses: mockResponseStorage,
    getChannel: mockGetChannelMetadata,
    resolvePrincipal: mockAuthority.resolvePrincipal,
  });
  expect(leaf.storage).toBe(mockRunStorage);
  expect(leaf.authority).toBe(mockAuthority);
  expect(leaf.responseCredentials).toBe(mockCredentials);
  expect(leaf.authorizeChannelResponseKeyRequest).toBe(mockCredentials.authorizeRequest);
  expect(leaf.authorizeChannelResponseKeySource).toBe(mockCredentials.authorizeSource);
  expect(leaf.authorizeGeneration).toBe(mockAuthority.authorizeGeneration);
  expect(leaf.authorizeResume).toBe(mockAuthority.authorizeResume);
  expect(leaf.authorizeTrigger).toBe(mockAuthority.authorizeTrigger);
});

it('uses the shared Agent access check with the current principal and resource resolvers', async () => {
  require('./ChannelAuthority');
  const { getAgentPermissions } = mockCreateAuthority.mock.calls[0][0];
  const user = { id: 'owner', role: 'USER' };
  mockCheckAccess.mockResolvedValue({ permissions: 0 });
  await expect(getAgentPermissions('agent', user)).resolves.toBe(0);
  mockCheckAccess.mockResolvedValue({ permissions: 4 });
  await expect(getAgentPermissions('agent', user)).resolves.toBe(4);
  expect(mockCheckAccess).toHaveBeenLastCalledWith({
    agentId: 'agent',
    userId: 'owner',
    role: 'USER',
    getAgent: expect.any(Function),
    getEffectivePermissions: expect.any(Function),
  });
  const { getAgent } = mockCheckAccess.mock.calls[0][0];
  await getAgent({ id: 'agent' });
  expect(mockGetAgent).toHaveBeenCalledWith({ id: 'agent' });
});

it('reads existing configured credential lifetime and propagates configuration failure', async () => {
  require('./ChannelAuthority');
  const { lifetimeMs } = mockCreateCredentials.mock.calls[0][0];
  mockGetConfig.mockResolvedValue({
    endpoints: { agents: { channels: { responseCredentialLifetimeMs: 120000 } } },
  });
  await expect(lifetimeMs()).resolves.toBe(120000);
  expect(mockGetConfig).toHaveBeenCalledWith({ baseOnly: true });
  mockGetConfig.mockRejectedValue(new Error('configuration unavailable'));
  await expect(lifetimeMs()).rejects.toThrow('configuration unavailable');
});
