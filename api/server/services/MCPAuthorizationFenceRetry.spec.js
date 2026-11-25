const mockStorage = {
  upsert: jest.fn(),
  deleteVersion: jest.fn(),
  deferVersion: jest.fn(),
  list: jest.fn(),
};
const mockGetTenantId = jest.fn();
const mockTenantRun = jest.fn((_context, fn) => fn());
const mockRetryService = {
  clear: jest.fn(),
  drain: jest.fn(),
  persist: jest.fn(),
  start: jest.fn(),
};
let capturedDeps;

jest.mock('mongoose', () => ({}));
jest.mock('@librechat/data-schemas', () => ({
  createMCPAuthorizationFenceRetryStorage: jest.fn(() => mockStorage),
  getTenantId: (...args) => mockGetTenantId(...args),
  tenantStorage: { run: (...args) => mockTenantRun(...args) },
}));
jest.mock('@librechat/api', () => ({
  createMCPAuthorizationFenceRetryService: (deps) => {
    capturedDeps = deps;
    return mockRetryService;
  },
}));

const retryAdapter = require('./MCPAuthorizationFenceRetry');

describe('MCPAuthorizationFenceRetry adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('exports the package-owned retry lifecycle', () => {
    expect(Object.keys(retryAdapter).sort()).toEqual([
      'clearMCPAuthorizationFenceRetry',
      'drainMCPAuthorizationFenceRetries',
      'persistMCPAuthorizationFenceRetry',
      'startMCPAuthorizationFenceRetryWorker',
    ]);
  });

  it('restores tenant context for replay', async () => {
    const retry = {
      tenantId: 'tenant-a',
      userId: 'user-1',
      serverName: 'github',
      version: 'v1',
    };
    retryAdapter.startMCPAuthorizationFenceRetryWorker();
    expect(capturedDeps.storage).toBe(mockStorage);
    const operation = jest.fn().mockResolvedValue(undefined);
    await capturedDeps.runInRetryScope(retry, operation);

    expect(mockTenantRun).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', userId: 'user-1' },
      operation,
    );
  });
});
