const mockGetUserById = jest.fn();
const mockDeleteMessages = jest.fn();
const mockDeleteAllUserSessions = jest.fn();
const mockDeleteUserById = jest.fn();
const mockDeleteAllSharedLinks = jest.fn();
const mockDeleteAllSharedLinksWithCleanup = jest.fn();
const mockDeletePresets = jest.fn();
const mockDeleteUserKey = jest.fn();
const mockDeleteConvos = jest.fn();
const mockDeleteFiles = jest.fn();
const mockGetFiles = jest.fn();
const mockUpdateUserPlugins = jest.fn();
const mockUpdateUser = jest.fn();
const mockFindToken = jest.fn();
const mockVerifyOTPOrBackupCode = jest.fn();
const mockDeleteUserPluginAuth = jest.fn();
const mockProcessDeleteRequest = jest.fn();
const mockDeleteToolCalls = jest.fn();
const mockDeleteUserAgents = jest.fn();
const mockDeleteUserPrompts = jest.fn();
const mockDeleteUserSkills = jest.fn();
const mockDeleteUserCodeEnvironments = jest.fn();
const mockInvalidateCodeEnvironmentConfigCache = jest.fn();
const mockGetCleanupBlockingJobIdsForUser = jest.fn();
const mockGetAgentJob = jest.fn();
const mockAbortJob = jest.fn();
const mockDrainAgentTriggerDeliveriesForUser = jest.fn();
const mockPrepareAgentTriggerUserPurge = jest.fn();
const mockCancelAgentTriggerUserPurge = jest.fn();
const mockPurgeAgentTriggerDeliveriesForUser = jest.fn();
const mockBeginAgentTriggerUserDeletion = jest.fn();
const mockCancelAgentTriggerUserDeletion = jest.fn();
const mockCancelAndDrainSubagentThreads = jest.fn();
const mockQuiesceUserSchedules = jest.fn();
const mockDeleteSchedulesByUser = jest.fn();
const mockRevokeUserCodeEnvironmentWorkers = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), info: jest.fn() },
  webSearchKeys: [],
}));

jest.mock('librechat-data-provider', () => ({
  Tools: {},
  CacheKeys: {},
  Constants: { mcp_delimiter: '::', mcp_prefix: 'mcp_' },
  FileSources: {},
}));

jest.mock('@librechat/api', () => ({
  MCPOAuthHandler: {},
  MCPTokenStorage: {},
  normalizeHttpError: jest.fn(),
  extractWebSearchEnvVars: jest.fn(),
  needsRefresh: jest.fn(),
  getNewS3URL: jest.fn(),
  deleteAllSharedLinksWithCleanup: (...args) => mockDeleteAllSharedLinksWithCleanup(...args),
  revokeUserCodeEnvironmentWorkers: (...args) => mockRevokeUserCodeEnvironmentWorkers(...args),
  GenerationJobManager: {
    getAccountCleanupJobIdsForUser: (...args) => mockGetCleanupBlockingJobIdsForUser(...args),
    getCleanupJob: (...args) => mockGetAgentJob(...args),
    abortJob: (...args) => mockAbortJob(...args),
  },
  getOwnedAgentCheckpointScope: jest.fn(() => undefined),
  isStopConfirmed: jest.fn(
    (result) => result?.success === true || result?.failureReason === 'already_settled',
  ),
  deleteOwnedAgentCheckpoints: jest.fn(),
  waitForGenerationPersistence: jest.requireActual(
    '../../../../packages/api/src/stream/persistence.ts',
  ).waitForGenerationPersistence,
  openCheckpointDeletion: jest.fn(async (userId, tenantId, _root, cfg) => ({
    remember: jest.fn(),
    cleanup: () =>
      jest
        .requireMock('@librechat/api')
        .deleteOwnedAgentCheckpoints(userId, tenantId, undefined, cfg),
    acknowledge: jest.fn(),
  })),
}));

jest.mock('~/models', () => ({
  deleteAllUserSessions: (...args) => mockDeleteAllUserSessions(...args),
  deleteAllSharedLinks: (...args) => mockDeleteAllSharedLinks(...args),
  updateUserPlugins: (...args) => mockUpdateUserPlugins(...args),
  deleteUserById: (...args) => mockDeleteUserById(...args),
  beginAgentTriggerUserDeletion: (...args) => mockBeginAgentTriggerUserDeletion(...args),
  cancelAgentTriggerUserDeletion: (...args) => mockCancelAgentTriggerUserDeletion(...args),
  deleteMessages: (...args) => mockDeleteMessages(...args),
  deletePresets: (...args) => mockDeletePresets(...args),
  deleteUserKey: (...args) => mockDeleteUserKey(...args),
  getUserById: (...args) => mockGetUserById(...args),
  deleteConvos: (...args) => mockDeleteConvos(...args),
  deleteFiles: (...args) => mockDeleteFiles(...args),
  updateUser: (...args) => mockUpdateUser(...args),
  findToken: (...args) => mockFindToken(...args),
  getFiles: (...args) => mockGetFiles(...args),
  deleteToolCalls: (...args) => mockDeleteToolCalls(...args),
  deleteUserAgents: (...args) => mockDeleteUserAgents(...args),
  deleteUserPrompts: (...args) => mockDeleteUserPrompts(...args),
  deleteUserSkills: (...args) => mockDeleteUserSkills(...args),
  deleteUserCodeEnvironments: (...args) => mockDeleteUserCodeEnvironments(...args),
  deleteTransactions: jest.fn(),
  deleteBalances: jest.fn(),
  deleteAllAgentApiKeys: jest.fn(),
  deleteAssistants: jest.fn(),
  deleteConversationTags: jest.fn(),
  deleteAllUserMemories: jest.fn(),
  deleteActions: jest.fn(),
  deleteTokens: jest.fn(),
  removeUserFromAllGroups: jest.fn(),
  deleteAclEntries: jest.fn(),
  deleteSchedulesByUser: (...args) => mockDeleteSchedulesByUser(...args),
  getSoleOwnedResourceIds: jest.fn().mockResolvedValue([]),
}));

jest.mock('~/server/services/PluginService', () => ({
  updateUserPluginAuth: jest.fn(),
  deleteUserPluginAuth: (...args) => mockDeleteUserPluginAuth(...args),
}));

jest.mock('~/server/services/twoFactorService', () => ({
  verifyOTPOrBackupCode: (...args) => mockVerifyOTPOrBackupCode(...args),
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

jest.mock('~/server/services/MCPAuthorizationFenceRetry', () => ({
  clearMCPAuthorizationFenceRetry: jest.fn(),
  persistMCPAuthorizationFenceRetry: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: (...args) => mockProcessDeleteRequest(...args),
}));

jest.mock('~/server/services/Agents/triggers', () => ({
  drainAgentTriggerDeliveriesForUser: (...args) => mockDrainAgentTriggerDeliveriesForUser(...args),
  prepareAgentTriggerUserPurge: (...args) => mockPrepareAgentTriggerUserPurge(...args),
  cancelAgentTriggerUserPurge: (...args) => mockCancelAgentTriggerUserPurge(...args),
  purgeAgentTriggerDeliveriesForUser: (...args) => mockPurgeAgentTriggerDeliveriesForUser(...args),
}));

jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({
  cancelAndDrainForOwner: (...args) => mockCancelAndDrainSubagentThreads(...args),
}));

jest.mock('~/server/services/Schedules', () => ({
  quiesceUserSchedules: (...args) => mockQuiesceUserSchedules(...args),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
  invalidateCodeEnvironmentConfigCache: (...args) =>
    mockInvalidateCodeEnvironmentConfigCache(...args),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(),
}));

const { deleteUserController } = require('~/server/controllers/UserController');
const { deleteOwnedAgentCheckpoints } = require('@librechat/api');

function createRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

function stubDeletionMocks() {
  mockDeleteMessages.mockResolvedValue();
  mockDeleteAllUserSessions.mockResolvedValue();
  mockDeleteUserKey.mockResolvedValue();
  mockDeletePresets.mockResolvedValue();
  mockDeleteConvos.mockResolvedValue();
  mockDeleteUserPluginAuth.mockResolvedValue();
  mockDeleteUserById.mockResolvedValue({ deletedCount: 1 });
  mockDeleteAllSharedLinks.mockResolvedValue();
  mockDeleteAllSharedLinksWithCleanup.mockResolvedValue({ deletedCount: 0 });
  mockGetFiles.mockResolvedValue([]);
  mockProcessDeleteRequest.mockResolvedValue({ deletedFileIds: [], failedFileIds: [] });
  mockDeleteFiles.mockResolvedValue();
  mockDeleteToolCalls.mockResolvedValue();
  mockDeleteUserAgents.mockResolvedValue();
  mockDeleteUserPrompts.mockResolvedValue();
  mockDeleteUserSkills.mockResolvedValue(0);
  mockInvalidateCodeEnvironmentConfigCache.mockResolvedValue(undefined);
  mockGetCleanupBlockingJobIdsForUser.mockResolvedValue([]);
  mockGetAgentJob.mockResolvedValue(null);
  mockAbortJob.mockResolvedValue({ success: true });
  mockDrainAgentTriggerDeliveriesForUser.mockResolvedValue();
  mockPrepareAgentTriggerUserPurge.mockResolvedValue();
  mockCancelAgentTriggerUserPurge.mockResolvedValue(true);
  mockPurgeAgentTriggerDeliveriesForUser.mockResolvedValue();
  mockBeginAgentTriggerUserDeletion.mockResolvedValue('acquired');
  mockCancelAgentTriggerUserDeletion.mockResolvedValue(true);
  mockCancelAndDrainSubagentThreads.mockResolvedValue();
  mockQuiesceUserSchedules.mockResolvedValue(true);
  mockDeleteSchedulesByUser.mockResolvedValue();
  mockRevokeUserCodeEnvironmentWorkers.mockResolvedValue(0);
}

beforeEach(() => {
  jest.clearAllMocks();
  stubDeletionMocks();
});

describe('deleteUserController - 2FA enforcement', () => {
  it('proceeds with deletion when 2FA is not enabled', async () => {
    const req = { user: { id: 'user1', _id: 'user1', email: 'a@b.com' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue({ _id: 'user1', twoFactorEnabled: false });

    await deleteUserController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: 'User deleted' });
    expect(mockDeleteMessages).toHaveBeenCalled();
    expect(mockDeleteUserAgents).toHaveBeenCalledWith('user1');
    expect(mockDeleteUserPrompts).toHaveBeenCalledWith('user1');
    expect(mockDeleteUserSkills).toHaveBeenCalledWith('user1');
    expect(mockInvalidateCodeEnvironmentConfigCache).toHaveBeenCalledWith(undefined);
    expect(mockRevokeUserCodeEnvironmentWorkers).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user1' }),
    );
    expect(mockVerifyOTPOrBackupCode).not.toHaveBeenCalled();
    expect(mockBeginAgentTriggerUserDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrepareAgentTriggerUserPurge.mock.invocationCallOrder[0],
    );
    expect(mockPrepareAgentTriggerUserPurge.mock.invocationCallOrder[0]).toBeLessThan(
      mockDrainAgentTriggerDeliveriesForUser.mock.invocationCallOrder[0],
    );
    expect(mockDrainAgentTriggerDeliveriesForUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteMessages.mock.invocationCallOrder[0],
    );
    expect(mockDeleteMessages.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteUserById.mock.invocationCallOrder[0],
    );
    expect(mockDeleteUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mockRevokeUserCodeEnvironmentWorkers.mock.invocationCallOrder[0],
    );
    expect(mockRevokeUserCodeEnvironmentWorkers.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteUserCodeEnvironments.mock.invocationCallOrder[0],
    );
    expect(mockCancelAgentTriggerUserDeletion).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerUserPurge).not.toHaveBeenCalled();
  });

  it('aborts active generation jobs before deleting account-owned records', async () => {
    const req = {
      user: { id: 'user1', _id: 'user1', email: 'a@b.com', tenantId: 'tenant-1' },
      body: {},
    };
    const res = createRes();
    mockGetUserById.mockResolvedValue({ _id: 'user1', twoFactorEnabled: false });
    mockGetCleanupBlockingJobIdsForUser.mockResolvedValueOnce(['stream-1']);
    mockGetAgentJob.mockResolvedValueOnce({
      metadata: { userId: 'user1', tenantId: 'tenant-1' },
      createdAt: 123,
    });
    mockAbortJob.mockResolvedValueOnce({ success: true });

    await deleteUserController(req, res);

    expect(mockGetCleanupBlockingJobIdsForUser).toHaveBeenCalledWith('user1', 'tenant-1');
    expect(mockAbortJob).toHaveBeenCalledWith('stream-1', {
      expectedCreatedAt: 123,
      awaitProviderDrain: true,
    });
    expect(mockAbortJob.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteMessages.mock.invocationCallOrder[0],
    );
  });

  it('deletes owner checkpoints before erasing the account after job records expire', async () => {
    const req = {
      user: { id: 'user1', _id: 'user1', email: 'a@b.com', tenantId: 'tenant-1' },
      body: {},
      config: { endpoints: { agents: { checkpointer: { ttl: 60 } } } },
    };
    const res = createRes();
    mockGetUserById.mockResolvedValue({ _id: 'user1', twoFactorEnabled: false });

    await deleteUserController(req, res);

    expect(deleteOwnedAgentCheckpoints).toHaveBeenCalledWith('user1', 'tenant-1', undefined, {
      ttl: 60,
    });
    expect(deleteOwnedAgentCheckpoints.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteUserById.mock.invocationCallOrder[0],
    );
  });

  it('preserves code environment records when revocation marking fails after deletion', async () => {
    const req = { user: { id: 'user1', _id: 'user1', email: 'a@b.com' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue({ _id: 'user1', twoFactorEnabled: false });
    mockRevokeUserCodeEnvironmentWorkers.mockRejectedValueOnce(new Error('worker unavailable'));

    await deleteUserController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockBeginAgentTriggerUserDeletion).toHaveBeenCalledTimes(1);
    expect(mockDeleteMessages).toHaveBeenCalled();
    expect(mockDeleteUserById).toHaveBeenCalledWith('user1');
    expect(mockDeleteUserCodeEnvironments).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerUserPurge).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerUserDeletion).not.toHaveBeenCalled();
  });

  it('proceeds with deletion when user has no 2FA record', async () => {
    const req = { user: { id: 'user1', _id: 'user1', email: 'a@b.com' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue(null);
    mockBeginAgentTriggerUserDeletion.mockResolvedValueOnce('missing');

    await deleteUserController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: 'User deleted' });
  });

  it('returns error when 2FA is enabled and verification fails with 400', async () => {
    const req = { user: { id: 'user1', _id: 'user1' }, body: {} };
    const res = createRes();
    mockGetUserById.mockResolvedValue({
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    });
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: false, status: 400 });

    await deleteUserController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockDeleteMessages).not.toHaveBeenCalled();
  });

  it('returns 401 when 2FA is enabled and invalid TOTP token provided', async () => {
    const existingUser = {
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    };
    const req = { user: { id: 'user1', _id: 'user1' }, body: { token: 'wrong' } };
    const res = createRes();
    mockGetUserById.mockResolvedValue(existingUser);
    mockVerifyOTPOrBackupCode.mockResolvedValue({
      verified: false,
      status: 401,
      message: 'Invalid token or backup code',
    });

    await deleteUserController(req, res);

    expect(mockVerifyOTPOrBackupCode).toHaveBeenCalledWith({
      user: existingUser,
      token: 'wrong',
      backupCode: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid token or backup code' });
    expect(mockDeleteMessages).not.toHaveBeenCalled();
  });

  it('returns 401 when 2FA is enabled and invalid backup code provided', async () => {
    const existingUser = {
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
      backupCodes: [],
    };
    const req = { user: { id: 'user1', _id: 'user1' }, body: { backupCode: 'bad-code' } };
    const res = createRes();
    mockGetUserById.mockResolvedValue(existingUser);
    mockVerifyOTPOrBackupCode.mockResolvedValue({
      verified: false,
      status: 401,
      message: 'Invalid token or backup code',
    });

    await deleteUserController(req, res);

    expect(mockVerifyOTPOrBackupCode).toHaveBeenCalledWith({
      user: existingUser,
      token: undefined,
      backupCode: 'bad-code',
    });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockDeleteMessages).not.toHaveBeenCalled();
  });

  it('deletes account when valid TOTP token provided with 2FA enabled', async () => {
    const existingUser = {
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
    };
    const req = {
      user: { id: 'user1', _id: 'user1', email: 'a@b.com' },
      body: { token: '123456' },
    };
    const res = createRes();
    mockGetUserById.mockResolvedValue(existingUser);
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: true });

    await deleteUserController(req, res);

    expect(mockVerifyOTPOrBackupCode).toHaveBeenCalledWith({
      user: existingUser,
      token: '123456',
      backupCode: undefined,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: 'User deleted' });
    expect(mockDeleteMessages).toHaveBeenCalled();
  });

  it('deletes account when valid backup code provided with 2FA enabled', async () => {
    const existingUser = {
      _id: 'user1',
      twoFactorEnabled: true,
      totpSecret: 'enc-secret',
      backupCodes: [{ codeHash: 'h1', used: false }],
    };
    const req = {
      user: { id: 'user1', _id: 'user1', email: 'a@b.com' },
      body: { backupCode: 'valid-code' },
    };
    const res = createRes();
    mockGetUserById.mockResolvedValue(existingUser);
    mockVerifyOTPOrBackupCode.mockResolvedValue({ verified: true });

    await deleteUserController(req, res);

    expect(mockVerifyOTPOrBackupCode).toHaveBeenCalledWith({
      user: existingUser,
      token: undefined,
      backupCode: 'valid-code',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: 'User deleted' });
    expect(mockDeleteMessages).toHaveBeenCalled();
  });
});
