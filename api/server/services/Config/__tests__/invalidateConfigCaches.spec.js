// ── Mocks ──────────────────────────────────────────────────────────────

const mockClearAppConfigCache = jest.fn().mockResolvedValue(undefined);
const mockClearOverrideCache = jest.fn().mockResolvedValue(undefined);

jest.mock('~/cache/getLogStores', () => {
  return jest.fn(() => ({}));
});

jest.mock('~/server/services/start/tools', () => ({
  loadAndFormatTools: jest.fn(() => ({})),
}));

jest.mock('../loadCustomConfig', () => jest.fn().mockResolvedValue({}));

jest.mock('@librechat/data-schemas', () => {
  return {
    AppService: jest.fn(() => ({ availableTools: {} })),
    logger: { error: jest.fn() },
  };
});

jest.mock('~/models', () => ({
  initializeMessageBudget: jest.fn(),
  getApplicableConfigs: jest.fn().mockResolvedValue([]),
  getUserPrincipals: jest.fn().mockResolvedValue([]),
}));

const mockInvalidateCachedTools = jest.fn().mockResolvedValue(undefined);
jest.mock('../getCachedTools', () => ({
  setCachedTools: jest.fn().mockResolvedValue(undefined),
  invalidateCachedTools: mockInvalidateCachedTools,
}));

const mockClearMcpConfigCache = jest.fn().mockResolvedValue(undefined);
jest.mock('@librechat/api', () => ({
  createAppConfigService: jest.fn(() => ({
    getAppConfig: jest.fn().mockResolvedValue({ availableTools: {} }),
    clearAppConfigCache: mockClearAppConfigCache,
    clearOverrideCache: mockClearOverrideCache,
  })),
  clearMcpConfigCache: mockClearMcpConfigCache,
  createCodeEnvironmentRegistry: jest.fn(() => ({})),
  mergeAccessibleCodeEnvironments: jest.fn(({ appConfig }) => appConfig),
}));

// ── Tests ──────────────────────────────────────────────────────────────

const { getAppConfig, invalidateConfigCaches } = require('../app');
const { initializeMessageBudget } = require('~/models');
// Capture module-composition calls before clearMocks resets the spy history.
const budgetInitializations = [...initializeMessageBudget.mock.calls];

test('Config supplies its actual reader exactly once during composition', () => {
  expect(budgetInitializations).toEqual([[getAppConfig]]);
});

describe('invalidateConfigCaches', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('clears all caches', async () => {
    await invalidateConfigCaches();

    expect(mockClearAppConfigCache).toHaveBeenCalledTimes(1);
    expect(mockClearOverrideCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({ invalidateGlobal: true });
    expect(mockClearMcpConfigCache).toHaveBeenCalledTimes(1);
  });

  it('passes tenantId through to clearOverrideCache', async () => {
    await invalidateConfigCaches('tenant-a');

    expect(mockClearOverrideCache).toHaveBeenCalledWith('tenant-a');
    expect(mockClearAppConfigCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({ invalidateGlobal: true });
  });

  it('all operations run in parallel (not sequentially)', async () => {
    const order = [];

    mockClearAppConfigCache.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => {
            order.push('base');
            r();
          }, 10),
        ),
    );
    mockClearOverrideCache.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => {
            order.push('override');
            r();
          }, 10),
        ),
    );
    mockInvalidateCachedTools.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => {
            order.push('tools');
            r();
          }, 10),
        ),
    );
    mockClearMcpConfigCache.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => {
            order.push('mcp');
            r();
          }, 10),
        ),
    );

    await invalidateConfigCaches();

    expect(order).toHaveLength(4);
    expect(new Set(order)).toEqual(new Set(['base', 'override', 'tools', 'mcp']));
  });

  it('resolves even when clearAppConfigCache throws (partial failure)', async () => {
    mockClearAppConfigCache.mockRejectedValueOnce(new Error('cache connection lost'));

    await expect(invalidateConfigCaches()).resolves.not.toThrow();

    expect(mockClearOverrideCache).toHaveBeenCalledTimes(1);
    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({ invalidateGlobal: true });
  });
});
