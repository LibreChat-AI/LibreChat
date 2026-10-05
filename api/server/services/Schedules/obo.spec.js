const mockRequestGrant = jest.fn();
const mockFindUser = jest.fn();
const mockGetSchedule = jest.fn();
const mockListIdentifiers = jest.fn(async () => []);
const mockFindToken = jest.fn();

jest.mock('openid-client', () => ({ genericGrantRequest: mockRequestGrant }));
jest.mock('@librechat/api', () => {
  const grants = jest.requireActual('@librechat/api');
  return {
    createLazyScheduledOboGrantService: grants.createLazyScheduledOboGrantService,
    createScheduledOboGrantService: grants.createScheduledOboGrantService,
    MCPTokenStorage: {},
    createSignalBoundGrantRequest: () => mockRequestGrant,
  };
});
jest.mock('~/config', () => ({
  getMCPServersRegistry: jest.fn(),
  getFlowStateManager: jest.fn(() => ({})),
}));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/strategies/openidStrategy', () => ({ getOpenIdConfig: jest.fn() }));
jest.mock('./access', () => ({ resolveAgentFireAccess: jest.fn() }));
jest.mock('~/server/services/OboPolicyService', () => ({ createOboTrustChecker: jest.fn() }));
jest.mock('~/server/services/OpenIDSessionRefresh', () => ({ isLiveAccessTokenValid: jest.fn() }));
jest.mock('~/cache', () => ({ getLogStores: jest.fn() }));
jest.mock('~/models', () => ({
  findUser: mockFindUser,
  getScheduleById: mockGetSchedule,
  listScheduledOboGrantIdentifiers: mockListIdentifiers,
  findToken: mockFindToken,
}));

const grants = require('./obo');

it('keeps the default host closed without agent-consent and read-only authorization', async () => {
  expect(grants.isAvailable()).toBe(false);
  await expect(grants.enroll('owner', 'schedule', 'Files', 'assertion')).rejects.toMatchObject({
    reason: 'missing_upstream_provider',
    retryable: false,
  });
  await expect(
    grants.resolve(
      { id: 'owner' },
      {
        context: {
          ownerId: 'owner',
          scheduleId: 'schedule',
          agentId: 'root',
          invocationMode: 'delegated',
        },
        target: { mcpServer: 'Files', url: 'https://mcp.test/tools', scopes: 'read' },
      },
    ),
  ).resolves.toBeUndefined();
  expect(mockFindUser).not.toHaveBeenCalled();
  expect(mockGetSchedule).not.toHaveBeenCalled();
  expect(mockFindToken).not.toHaveBeenCalled();
  expect(mockRequestGrant).not.toHaveBeenCalled();

  await expect(grants.listEnrolled('owner')).resolves.toEqual({});
  expect(mockListIdentifiers).toHaveBeenCalledWith('owner');
});
