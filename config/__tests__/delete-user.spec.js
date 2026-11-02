const { AsyncLocalStorage } = require('async_hooks');

const mockTenantStorage = new AsyncLocalStorage();
const mockModelRegistry = {};
const mockModelFor = (name) => {
  if (!mockModelRegistry[name]) {
    mockModelRegistry[name] = {
      findOne: jest.fn(async () => null),
      deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
      updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
    };
  }
  return mockModelRegistry[name];
};

const mockMethods = {
  beginAgentTriggerUserDeletion: jest.fn(),
  recoverStaleAgentTriggerUserDeletion: jest.fn(),
  prepareAgentTriggerUserPurge: jest.fn(),
  suspendUserSchedulesForDeletion: jest.fn(),
  restoreUserSchedulesFromDeletion: jest.fn(),
  countActiveAgentTriggerDeliveriesByUser: jest.fn(),
  deleteSchedulesByUser: jest.fn(),
  deleteUserCodeEnvironments: jest.fn(),
  deleteUserById: jest.fn(),
  deleteAgentTriggerDeliveriesByUser: jest.fn(),
  cancelAgentTriggerUserPurge: jest.fn(),
  cancelAgentTriggerUserDeletion: jest.fn(),
  deleteUserPrompts: jest.fn(),
};
const mockGetCleanupBlockingJobIdsForUser = jest.fn();
const mockAbortJob = jest.fn();
const mockDestroy = jest.fn();
const mockSilentExit = jest.fn();
const mockAskQuestion = jest.fn();
const mockGetAppConfig = jest.fn();
const mockRevokeUserCodeEnvironmentWorkers = jest.fn();
const mockEraseUserData = jest.fn();
const mockProcessDeleteRequest = jest.fn();
const mockInvalidateCachedTools = jest.fn();
const mockInitializeFileStorage = jest.fn();
const mockOpenCheckpointDeletion = jest.fn();
const mockDeleteAllSharedLinksWithCleanup = jest.fn();

jest.mock('../connect', () => jest.fn(async () => undefined));
jest.mock('mongoose', () => ({ disconnect: jest.fn(async () => undefined) }));
jest.mock('@librechat/data-schemas', () => ({
  createModels: () => new Proxy({}, { get: (_target, prop) => mockModelFor(prop) }),
  createMethods: () => mockMethods,
  runAsSystem: (operation) => operation(),
  tenantStorage: mockTenantStorage,
}));
jest.mock('@librechat/api', () => ({
  waitForKeyvRedisClient: jest.fn(async () => undefined),
  createStreamServices: jest.fn(() => ({ isRedis: true })),
  GenerationJobManager: {
    configure: jest.fn(),
    initialize: jest.fn(),
    getCleanupBlockingJobIdsForUser: (...args) => mockGetCleanupBlockingJobIdsForUser(...args),
    abortJob: (...args) => mockAbortJob(...args),
    destroy: (...args) => mockDestroy(...args),
  },
  revokeUserCodeEnvironmentWorkers: (...args) => mockRevokeUserCodeEnvironmentWorkers(...args),
  eraseUserData: (...args) => mockEraseUserData(...args),
  initializeFileStorage: (...args) => mockInitializeFileStorage(...args),
  openCheckpointDeletion: mockOpenCheckpointDeletion,
  deleteAllSharedLinksWithCleanup: mockDeleteAllSharedLinksWithCleanup,
}));
jest.mock('~/cache/getLogStores', () => jest.fn());
jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));
jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: (...args) => mockProcessDeleteRequest(...args),
}));
jest.mock('~/server/services/Config/getCachedTools', () => ({
  invalidateCachedTools: (...args) => mockInvalidateCachedTools(...args),
}));
jest.mock('../helpers', () => ({
  ...jest.requireActual('../helpers'),
  askQuestion: mockAskQuestion,
  silentExit: mockSilentExit,
}));

const USER_ID = 'user-being-deleted';

const runCli = () =>
  new Promise((resolve, reject) => {
    mockSilentExit.mockImplementation((code = 0) => resolve(code));
    jest.spyOn(process, 'exit').mockImplementation((code) => {
      resolve(code);
    });
    jest.isolateModules(() => {
      try {
        require('../delete-user');
      } catch (error) {
        reject(error);
      }
    });
  });

describe('Delete user CLI', () => {
  const originalArgv = process.argv;
  let logSpy;

  beforeEach(() => {
    process.argv = ['node', 'delete-user.js', 'deleted@example.com'];
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const model of Object.values(mockModelRegistry)) {
      for (const method of Object.values(model)) {
        method.mockClear();
      }
    }
    mockModelFor('User').findOne.mockResolvedValue({
      _id: { toString: () => USER_ID },
      email: 'deleted@example.com',
      role: 'USER',
      tenantId: 'tenant-1',
    });
    mockMethods.beginAgentTriggerUserDeletion.mockReset().mockResolvedValue('acquired');
    mockMethods.recoverStaleAgentTriggerUserDeletion.mockReset().mockResolvedValue('acquired');
    mockMethods.prepareAgentTriggerUserPurge.mockReset().mockResolvedValue(undefined);
    mockMethods.suspendUserSchedulesForDeletion.mockReset().mockResolvedValue(undefined);
    mockMethods.restoreUserSchedulesFromDeletion.mockReset().mockResolvedValue(undefined);
    mockMethods.countActiveAgentTriggerDeliveriesByUser.mockReset().mockResolvedValue(0);
    mockMethods.deleteSchedulesByUser.mockReset().mockResolvedValue(undefined);
    mockMethods.deleteUserCodeEnvironments.mockReset().mockResolvedValue(0);
    mockMethods.deleteUserById.mockReset().mockResolvedValue({ deletedCount: 1 });
    mockMethods.deleteAgentTriggerDeliveriesByUser.mockReset().mockResolvedValue(undefined);
    mockMethods.cancelAgentTriggerUserPurge.mockReset().mockResolvedValue(true);
    mockMethods.cancelAgentTriggerUserDeletion.mockReset().mockResolvedValue(true);
    mockMethods.deleteUserPrompts.mockReset().mockResolvedValue(undefined);
    mockGetCleanupBlockingJobIdsForUser.mockReset().mockResolvedValue([]);
    mockAbortJob.mockReset().mockResolvedValue({ success: true });
    mockDestroy.mockReset().mockResolvedValue(undefined);
    mockGetAppConfig.mockReset().mockResolvedValue({});
    mockRevokeUserCodeEnvironmentWorkers.mockReset().mockResolvedValue(0);
    mockEraseUserData.mockReset().mockResolvedValue(undefined);
    mockProcessDeleteRequest.mockReset().mockResolvedValue({ deletedFileIds: [] });
    mockInvalidateCachedTools.mockReset().mockResolvedValue(undefined);
    mockInitializeFileStorage.mockReset();
    mockAskQuestion.mockReset().mockResolvedValueOnce('y').mockResolvedValueOnce('n');
  });

  afterEach(() => {
    process.argv = originalArgv;
    logSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it('fences triggers and schedules before inspecting active work', async () => {
    expect(await runCli()).toBe(0);

    expect(mockMethods.beginAgentTriggerUserDeletion).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Date),
    );
    expect(mockMethods.prepareAgentTriggerUserPurge).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Date),
      'tenant-1',
    );
    expect(mockMethods.suspendUserSchedulesForDeletion).toHaveBeenCalledWith(
      USER_ID,
      expect.any(String),
    );
    expect(mockMethods.beginAgentTriggerUserDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.prepareAgentTriggerUserPurge.mock.invocationCallOrder[0],
    );
    expect(mockMethods.prepareAgentTriggerUserPurge.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.suspendUserSchedulesForDeletion.mock.invocationCallOrder[0],
    );
    expect(mockMethods.suspendUserSchedulesForDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.countActiveAgentTriggerDeliveriesByUser.mock.invocationCallOrder[0],
    );
    expect(
      mockMethods.countActiveAgentTriggerDeliveriesByUser.mock.invocationCallOrder[0],
    ).toBeLessThan(mockGetCleanupBlockingJobIdsForUser.mock.invocationCallOrder[0]);
  });

  it('aborts provider work before deleting account-owned records', async () => {
    mockGetCleanupBlockingJobIdsForUser.mockResolvedValueOnce(['stream-1']);

    expect(await runCli()).toBe(0);

    expect(mockGetCleanupBlockingJobIdsForUser).toHaveBeenCalledWith(USER_ID, 'tenant-1');
    expect(mockAbortJob).toHaveBeenCalledWith('stream-1', { awaitProviderDrain: true });
    expect(mockAbortJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockEraseUserData.mock.invocationCallOrder[0],
    );
    expect(mockEraseUserData.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.deleteUserById.mock.invocationCallOrder[0],
    );
  });

  it('deletes nothing and releases both fences when schedule quiescing fails', async () => {
    mockMethods.suspendUserSchedulesForDeletion.mockRejectedValueOnce(
      new Error('schedule write failed'),
    );

    expect(await runCli()).toBe(1);

    expect(mockEraseUserData).not.toHaveBeenCalled();
    expect(mockMethods.deleteSchedulesByUser).not.toHaveBeenCalled();
    expect(mockMethods.deleteUserById).not.toHaveBeenCalled();
    const deletionFence = mockMethods.beginAgentTriggerUserDeletion.mock.calls[0][1];
    expect(mockMethods.cancelAgentTriggerUserPurge).toHaveBeenCalledWith(USER_ID, deletionFence);
    expect(mockMethods.cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(USER_ID, deletionFence);
  });

  /**
   * The suspension is reversible, so a CLI attempt that does not commit must restore the
   * rows it suspended — and must do so while the user-deletion fence still refuses new
   * schedule writes, or an owner edit (or a second attempt re-suspending under a new token)
   * can race the restore and strand the disabled snapshot.
   */
  it('restores suspended schedules BEFORE releasing the deletion fence on failure', async () => {
    mockGetCleanupBlockingJobIdsForUser.mockResolvedValueOnce(['stream-1']);
    mockAbortJob.mockRejectedValueOnce(new Error('provider drain failed'));

    expect(await runCli()).toBe(1);

    const token = mockMethods.suspendUserSchedulesForDeletion.mock.calls[0][1];
    expect(token).toEqual(expect.any(String));
    expect(mockMethods.restoreUserSchedulesFromDeletion).toHaveBeenCalledWith(USER_ID, token);
    expect(mockMethods.restoreUserSchedulesFromDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.cancelAgentTriggerUserDeletion.mock.invocationCallOrder[0],
    );
  });

  it('never restores schedules after a committed deletion', async () => {
    expect(await runCli()).toBe(0);

    expect(mockEraseUserData).toHaveBeenCalled();
    expect(mockMethods.restoreUserSchedulesFromDeletion).not.toHaveBeenCalled();
  });

  it('commits the account before revoking workers and removing environment records', async () => {
    expect(await runCli()).toBe(0);

    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(mockRevokeUserCodeEnvironmentWorkers).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
    );
    expect(mockMethods.deleteUserCodeEnvironments).toHaveBeenCalledWith(USER_ID);
    expect(mockMethods.deleteUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mockRevokeUserCodeEnvironmentWorkers.mock.invocationCallOrder[0],
    );
    expect(mockRevokeUserCodeEnvironmentWorkers.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.deleteUserCodeEnvironments.mock.invocationCallOrder[0],
    );
  });

  it('preserves code environment records when revocation marking fails', async () => {
    mockRevokeUserCodeEnvironmentWorkers.mockRejectedValueOnce(new Error('mongo unavailable'));

    expect(await runCli()).toBe(0);

    expect(mockMethods.deleteUserCodeEnvironments).not.toHaveBeenCalled();
  });

  it('erases account data through the shared cascade before committing the user', async () => {
    const userConfig = { endpoints: { agents: { checkpointer: { ttl: 60 } } } };
    mockGetAppConfig.mockImplementation(async (options) => (options?.baseOnly ? {} : userConfig));

    expect(await runCli()).toBe(0);

    expect(mockGetAppConfig).toHaveBeenCalledWith({
      role: 'USER',
      userId: USER_ID,
      tenantId: 'tenant-1',
    });
    expect(mockInitializeFileStorage).toHaveBeenCalledWith(userConfig);
    expect(mockEraseUserData).toHaveBeenCalledTimes(1);
    const [params, deps] = mockEraseUserData.mock.calls[0];
    expect(params).toEqual({
      userId: USER_ID,
      tenantId: 'tenant-1',
      checkpointer: { ttl: 60 },
      keepTransactions: true,
    });
    expect(deps).toEqual(
      expect.objectContaining({
        ...mockMethods,
        openCheckpointDeletion: mockOpenCheckpointDeletion,
        deleteSharedLinks: expect.any(Function),
      }),
    );
    await deps.deleteSharedLinks(USER_ID);
    expect(mockDeleteAllSharedLinksWithCleanup).toHaveBeenCalledWith(USER_ID, {
      awaitCleanup: true,
    });

    const files = [{ file_id: 'file-1' }];
    await deps.deleteStoredFiles(files);
    expect(mockProcessDeleteRequest).toHaveBeenCalledWith({
      req: expect.objectContaining({
        user: expect.objectContaining({ id: USER_ID, tenantId: 'tenant-1' }),
        body: {},
        config: userConfig,
      }),
      files,
    });
    await deps.invalidateMCPServerTools('server-1');
    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({
      userId: USER_ID,
      serverName: 'server-1',
    });

    expect(mockEraseUserData.mock.invocationCallOrder[0]).toBeLessThan(
      mockMethods.deleteUserById.mock.invocationCallOrder[0],
    );
  });

  it('keeps file and MCP id-keyed cleanup in the deleted user tenant scope', async () => {
    const scopes = {};
    mockMethods.findMCPServerOAuthTokenUserIds = jest.fn(async () => {
      scopes.tokens = mockTenantStorage.getStore();
      return [];
    });
    mockProcessDeleteRequest.mockImplementation(async () => {
      scopes.files = mockTenantStorage.getStore();
    });
    mockEraseUserData.mockImplementation(async (_params, deps) => {
      scopes.cascade = mockTenantStorage.getStore();
      await deps.findMCPServerOAuthTokenUserIds('server-1', 'tenant-1');
      await deps.deleteStoredFiles([{ file_id: 'file-1' }]);
    });

    expect(await runCli()).toBe(0);

    expect(scopes.cascade).toBeUndefined();
    expect(scopes.files).toEqual({ tenantId: 'tenant-1', userId: USER_ID });
    expect(scopes.tokens).toEqual({ tenantId: 'tenant-1', userId: USER_ID });
    expect(mockMethods.findMCPServerOAuthTokenUserIds).toHaveBeenCalledWith('server-1', 'tenant-1');
  });

  it('supplies shared-user MCP OAuth cleanup to the cascade', async () => {
    expect(await runCli()).toBe(0);

    const [, deps] = mockEraseUserData.mock.calls[0];
    expect(deps.mcpOAuth).toEqual({
      getServerConfig: expect.any(Function),
      getUserPrincipals: expect.any(Function),
      resolveAllowlists: expect.any(Function),
      invalidateUserTools: expect.any(Function),
      uninstallOAuthMCP: expect.any(Function),
    });
    mockMethods.findMCPServerByObjectId = jest.fn(async () => ({ config: { type: 'sse' } }));
    expect(await deps.mcpOAuth.getServerConfig('server-1', 'server-id-1')).toEqual({ type: 'sse' });
    expect(mockMethods.findMCPServerByObjectId).toHaveBeenCalledWith('server-id-1');
    mockMethods.getUserById = jest.fn(async () => ({ role: 'VIEWER' }));
    mockGetAppConfig.mockImplementation(async (options) =>
      options?.userId === 'viewer-1' ? { mcpSettings: { allowedDomains: ['viewer.example'] } } : {},
    );
    expect(await deps.mcpOAuth.resolveAllowlists('viewer-1')).toEqual({
      allowedDomains: ['viewer.example'],
      allowedAddresses: undefined,
    });
    expect(mockGetAppConfig).toHaveBeenCalledWith({
      role: 'VIEWER',
      userId: 'viewer-1',
      tenantId: 'tenant-1',
    });
    await deps.mcpOAuth.invalidateUserTools('viewer-1', 'server-1');
    expect(mockInvalidateCachedTools).toHaveBeenCalledWith({
      userId: 'viewer-1',
      serverName: 'server-1',
    });
  });

  it('erases the transaction ledger when the operator confirms it', async () => {
    mockAskQuestion.mockReset().mockResolvedValueOnce('y').mockResolvedValueOnce('y');

    expect(await runCli()).toBe(0);

    expect(mockEraseUserData.mock.calls[0][0]).toEqual(
      expect.objectContaining({ keepTransactions: false }),
    );
  });

  it('keeps the user and releases both fences when the cascade fails', async () => {
    mockEraseUserData.mockRejectedValueOnce(new Error('storage unavailable'));

    expect(await runCli()).toBe(1);

    expect(mockMethods.deleteUserById).not.toHaveBeenCalled();
    const deletionFence = mockMethods.beginAgentTriggerUserDeletion.mock.calls[0][1];
    expect(mockMethods.restoreUserSchedulesFromDeletion).toHaveBeenCalled();
    expect(mockMethods.cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(USER_ID, deletionFence);
  });

  it('passes deleteUserPrompts through to the shared cascade, which keeps a synced group with a synthetic author untouched', async () => {
    expect(await runCli()).toBe(0);

    const [, deps] = mockEraseUserData.mock.calls[0];
    expect(deps.deleteUserPrompts).toBe(mockMethods.deleteUserPrompts);
  });

  it('deletes nothing and releases both fences when provider drain fails', async () => {
    mockGetCleanupBlockingJobIdsForUser.mockResolvedValueOnce(['stream-1']);
    mockAbortJob.mockRejectedValueOnce(new Error('provider drain failed'));

    expect(await runCli()).toBe(1);

    expect(mockEraseUserData).not.toHaveBeenCalled();
    expect(mockMethods.deleteSchedulesByUser).not.toHaveBeenCalled();
    expect(mockMethods.deleteUserById).not.toHaveBeenCalled();
    const deletionFence = mockMethods.beginAgentTriggerUserDeletion.mock.calls[0][1];
    expect(mockMethods.cancelAgentTriggerUserPurge).toHaveBeenCalledWith(USER_ID, deletionFence);
    expect(mockMethods.cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(USER_ID, deletionFence);
  });
});
