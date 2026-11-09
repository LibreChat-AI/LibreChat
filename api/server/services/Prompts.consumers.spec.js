const mockDb = {
  getPromptGroupAccessContext: jest.fn(),
  getRoleByName: jest.fn(),
  marker: 'db',
};
jest.mock('~/models', () => mockDb);

const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config', () => ({
  getAppConfig: mockGetAppConfig,
}));

const mockGrantPermission = jest.fn();
const mockGetEffectivePermissions = jest.fn();
const mockGetResourcePermissionsMap = jest.fn();
jest.mock('~/server/services/PermissionService', () => ({
  grantPermission: mockGrantPermission,
  getEffectivePermissions: mockGetEffectivePermissions,
  getResourcePermissionsMap: mockGetResourcePermissionsMap,
}));

const mockCacheStore = { get: jest.fn(), set: jest.fn(), delete: jest.fn() };
const mockDistributedLock = { acquire: jest.fn(), extend: jest.fn(), release: jest.fn() };
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => mockCacheStore),
  distributedLock: mockDistributedLock,
}));

// `routes/prompts.js` pulls in `~/server/middleware`'s full index, which (via
// `buildEndpointOption` -> agents `initialize`) reaches
// `createSubagentThreadTaskStore` and validates the full `db` method surface.
// This test only cares which `promptService` reference reaches each factory,
// so the route file's other middleware imports are stubbed the same way
// `routes/prompts.test.js` stubs them.
jest.mock('~/server/middleware', () => ({
  canAccessPromptGroupResource: jest.fn(() => (_req, _res, next) => next()),
  canAccessPromptViaGroup: jest.fn(() => (_req, _res, next) => next()),
  promptUsageLimiter: jest.fn((_req, _res, next) => next()),
  promptResolveLimiter: jest.fn((_req, _res, next) => next()),
  requireJwtAuth: jest.fn((_req, _res, next) => next()),
  configMiddleware: jest.fn((_req, _res, next) => next()),
}));

describe('Prompts consumers', () => {
  it('passes the one process promptService, by identity, into every @librechat/api composition factory', () => {
    const api = jest.requireActual('@librechat/api');

    // The CJS dist exports these factories as plain `exports.x = x` assignments
    // (verified via grep on packages/api/dist/index.cjs), so `jest.spyOn` can
    // replace the property in place and every later `require('@librechat/api')`
    // in this test run (same module-registry entry) observes the spy.
    const createPromptHandlersSpy = jest.spyOn(api, 'createPromptHandlers');
    const createLinkedInstructionsResolverSpy = jest.spyOn(api, 'createLinkedInstructionsResolver');
    const createInstructionsPromptAccessSpy = jest.spyOn(api, 'createInstructionsPromptAccess');
    const createLangfusePromptSyncRunnerSpy = jest.spyOn(api, 'createLangfusePromptSyncRunner');

    const { promptService } = require('~/server/services/Prompts');
    expect(typeof promptService.importSourceGroup).toBe('function');

    require('~/server/routes/prompts');
    require('~/server/services/Endpoints/agents/linkedInstructions');
    require('~/server/services/Agents/instructionsPrompt');
    require('~/server/services/LangfusePromptSync');

    expect(createPromptHandlersSpy).toHaveBeenCalledTimes(1);
    expect(createPromptHandlersSpy.mock.calls[0][0].service).toBe(promptService);

    expect(createLinkedInstructionsResolverSpy).toHaveBeenCalledTimes(1);
    expect(createLinkedInstructionsResolverSpy.mock.calls[0][0].promptService).toBe(promptService);

    expect(createInstructionsPromptAccessSpy).toHaveBeenCalledTimes(1);
    expect(createInstructionsPromptAccessSpy.mock.calls[0][0].promptService).toBe(promptService);

    expect(createLangfusePromptSyncRunnerSpy).toHaveBeenCalledTimes(1);
    expect(createLangfusePromptSyncRunnerSpy.mock.calls[0][0].promptService).toBe(promptService);
  });
});
