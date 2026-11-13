const mockRunStorage = { read: jest.fn() };
const mockIdentityStorage = { readChannelIdentity: jest.fn(), saveChannelIdentity: jest.fn() };
const mockResponseStorage = {};
const mockGetChannelMetadata = jest.fn();
const mockGetConfig = jest.fn();
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  createChannelIdentityStorage: () => mockIdentityStorage,
  createChannelRunStorage: () => mockRunStorage,
  createResponseStorage: () => mockResponseStorage,
}));
jest.mock('./Config', () => ({ getAppConfig: (...args) => mockGetConfig(...args) }));
jest.mock('./PermissionService', () => ({ getEffectivePermissions: jest.fn() }));
jest.mock('~/models', () => ({
  getAgent: jest.fn(),
  getAgentChannelMetadata: (...args) => mockGetChannelMetadata(...args),
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
const originalOrigin = process.env.DOMAIN_CLIENT;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.DOMAIN_CLIENT = 'http://192.168.1.50:3080';
  mockIdentityStorage.readChannelIdentity.mockResolvedValue(null);
  mockGetConfig.mockResolvedValue({ endpoints: { agents: { channels: { enabled: false } } } });
});
afterEach(() => {
  if (originalOrigin === undefined) delete process.env.DOMAIN_CLIENT;
  else process.env.DOMAIN_CLIENT = originalOrigin;
});

it('loads the actual disabled host without validating a link origin or reading configuration', () => {
  const leaf = require('./ChannelAuthority');
  expect(leaf.storage).toBe(mockRunStorage);
  expect(leaf.authority.identity).toBeDefined();
  expect(leaf.responseCredentials.isCurrent).toBeDefined();
  expect(leaf.authorizeTrigger).toBeUndefined();
  expect(mockGetConfig).not.toHaveBeenCalled();
});

it('loads effective current-principal policy without bypassing database overrides', async () => {
  const leaf = require('./ChannelAuthority');
  expect((await leaf.policy.config({ _id: 'owner', role: 'USER' })).enabled).toBe(false);
  expect(mockGetConfig).toHaveBeenCalledWith({
    tenantId: undefined,
    userId: 'owner',
    role: 'USER',
    idOnTheSource: undefined,
    failClosed: true,
  });
});

it('refuses an unsafe origin at actual ticket issuance before persisting a ticket', async () => {
  const leaf = require('./ChannelAuthority');
  mockGetChannelMetadata.mockResolvedValue({
    channelId: 'channel',
    agentId: 'agent',
    revision: 'v1',
    status: 'active',
    slack: { teamId: 'T1' },
  });
  await expect(
    leaf.authority.identity.issue({
      tenantId: '_',
      channelId: 'channel',
      agentId: 'agent',
      channelRevision: 'v1',
      teamId: 'T1',
      externalUserId: 'U1',
    }),
  ).rejects.toThrow('HTTPS');
  expect(mockGetChannelMetadata).toHaveBeenCalledWith('channel');
  expect(mockIdentityStorage.saveChannelIdentity).not.toHaveBeenCalled();
});

it('issues a ticket to the installed link page using the trusted deployment origin', async () => {
  process.env.DOMAIN_CLIENT = 'https://chat.example.test';
  const leaf = require('./ChannelAuthority');
  mockGetChannelMetadata.mockResolvedValue({
    channelId: 'channel',
    agentId: 'agent',
    revision: 'v1',
    status: 'active',
    slack: { teamId: 'T1' },
  });
  mockIdentityStorage.saveChannelIdentity.mockResolvedValue(true);
  const result = await leaf.authority.identity.issue({
    tenantId: '_',
    channelId: 'channel',
    agentId: 'agent',
    channelRevision: 'v1',
    teamId: 'T1',
    externalUserId: 'U1',
  });
  expect(result.ok).toBe(true);
  expect(new URL(result.value.url).origin).toBe('https://chat.example.test');
  expect(new URL(result.value.url).pathname).toBe('/channels/link');
  expect(mockIdentityStorage.saveChannelIdentity).toHaveBeenCalledTimes(1);
});
