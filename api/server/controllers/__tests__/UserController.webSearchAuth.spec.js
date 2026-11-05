const mockUpdateUserPlugins = jest.fn();
const mockUpdateUserPluginAuth = jest.fn();
const mockDeleteUserPluginAuth = jest.fn();
const mockGetAppConfig = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
  getTenantId: jest.fn(),
  webSearchKeys: ['serperApiKey', 'firecrawlApiKey', 'jinaApiKey'],
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    Tools: { ...actual.Tools, web_search: 'web_search' },
  };
});

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  MCPOAuthHandler: {
    generateFlowId: jest.fn(),
    generateTokenFlowId: jest.fn(),
    deleteFlowAndStateMapping: jest.fn().mockResolvedValue(undefined),
    revokeOAuthToken: jest.fn(),
  },
  MCPTokenStorage: {
    getClientInfoAndMetadata: jest.fn(),
    getTokens: jest.fn(),
    assertCredentialSetBinding: jest.fn(),
    deleteUserTokens: jest.fn().mockResolvedValue(undefined),
  },
  normalizeHttpError: jest.fn((error) => error),
  getAppConfigOptionsFromUser: jest.fn((user) => ({ role: user?.role, userId: user?.id })),
  needsRefresh: jest.fn(),
  getNewS3URL: jest.fn(),
}));

jest.mock('~/models', () => ({
  updateUserPlugins: (...args) => mockUpdateUserPlugins(...args),
  findToken: jest.fn(),
  deleteTokens: jest.fn(),
}));

jest.mock('~/server/services/PluginService', () => ({
  updateUserPluginAuth: (...args) => mockUpdateUserPluginAuth(...args),
  deleteUserPluginAuth: (...args) => mockDeleteUserPluginAuth(...args),
}));

jest.mock('~/server/services/twoFactorService', () => ({
  verifyOTPOrBackupCode: jest.fn(),
}));

jest.mock('~/server/services/AuthService', () => ({
  verifyEmail: jest.fn(),
  resendVerificationEmail: jest.fn(),
}));

jest.mock('~/config', () => ({
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(),
  getMCPServersRegistry: jest.fn(),
}));

jest.mock('~/server/services/Config/getCachedTools', () => ({
  invalidateCachedTools: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
}));

jest.mock('~/server/services/Agents/triggers', () => ({
  drainAgentTriggerDeliveriesForUser: jest.fn(),
  prepareAgentTriggerUserPurge: jest.fn(),
  cancelAgentTriggerUserPurge: jest.fn(),
  purgeAgentTriggerDeliveriesForUser: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({
  cancelAndDrainForOwner: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(),
}));

const { updateUserPluginsController } = require('~/server/controllers/UserController');

function createResponse() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

function createRequest(auth, webSearch) {
  return {
    config: { webSearch },
    user: { id: 'user-1', _id: 'user-1', plugins: [], role: 'USER' },
    body: { pluginKey: 'web_search', action: 'install', auth },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateUserPlugins.mockResolvedValue();
  mockUpdateUserPluginAuth.mockResolvedValue({});
  mockGetAppConfig.mockResolvedValue({});
});

describe('updateUserPluginsController web search install', () => {
  it('stores each submitted value under its own environment variable', async () => {
    const req = createRequest(
      { serperApiKey: 'serper-secret', firecrawlApiKey: 'firecrawl-secret' },
      { serperApiKey: '${SERPER_API_KEY}', firecrawlApiKey: '${FIRECRAWL_API_KEY}' },
    );

    await updateUserPluginsController(req, createResponse());

    expect(mockUpdateUserPluginAuth.mock.calls.map(([, key, , value]) => [key, value])).toEqual([
      ['SERPER_API_KEY', 'serper-secret'],
      ['FIRECRAWL_API_KEY', 'firecrawl-secret'],
    ]);
  });

  it('does not shift values onto another provider when a submitted field is not configured', async () => {
    // The dialog posts every non-empty field it rendered, including fields for services
    // the deployment has not configured. Those are dropped from the key list, so a value
    // must not slide into the next key's slot.
    const req = createRequest(
      { firecrawlApiKey: 'firecrawl-secret', serperApiKey: 'serper-secret' },
      { serperApiKey: '${SERPER_API_KEY}' },
    );

    await updateUserPluginsController(req, createResponse());

    expect(mockUpdateUserPluginAuth.mock.calls.map(([, key, , value]) => [key, value])).toEqual([
      ['SERPER_API_KEY', 'serper-secret'],
    ]);
  });

  it('skips a configured field whose value is not an environment variable placeholder', async () => {
    const req = createRequest(
      { jinaApiKey: 'jina-secret', serperApiKey: 'serper-secret' },
      { jinaApiKey: 'literal-value', serperApiKey: '${SERPER_API_KEY}' },
    );

    await updateUserPluginsController(req, createResponse());

    expect(mockUpdateUserPluginAuth.mock.calls.map(([, key, , value]) => [key, value])).toEqual([
      ['SERPER_API_KEY', 'serper-secret'],
    ]);
  });
});
