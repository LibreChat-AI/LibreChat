const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockGetActiveJobIdsForUser = jest.fn().mockResolvedValue([]);
const mockGetAgentJob = jest.fn().mockResolvedValue(null);
const mockAbortJob = jest.fn().mockResolvedValue({ success: true });
const mockDeleteOwnedAgentCheckpoints = jest.fn().mockResolvedValue(undefined);
const mockDeleteAgentCheckpoints = jest.fn(async (threadIds = []) => {
  const filter = { thread_id: { $in: threadIds } };
  await Promise.all([
    mongoose.connection.db.collection('agent_checkpoints').deleteMany(filter),
    mongoose.connection.db.collection('agent_checkpoint_writes').deleteMany(filter),
  ]);
});
const mockDrainAgentTriggerDeliveriesForUser = jest.fn().mockResolvedValue(undefined);
const mockPrepareAgentTriggerUserPurge = jest.fn().mockResolvedValue(undefined);
const mockCancelAgentTriggerUserPurge = jest.fn().mockResolvedValue(true);
const mockPurgeAgentTriggerDeliveriesForUser = jest.fn().mockResolvedValue(undefined);
const mockCancelAndDrainSubagentThreads = jest.fn().mockResolvedValue(undefined);
const mockQuiesceUserSchedules = jest.fn().mockResolvedValue(true);
const mockRestoreUserSchedules = jest.fn().mockResolvedValue(undefined);
const mockGetWebSearchInstallEntries = jest.fn();
const mockInvalidateCodeEnvironmentConfigCache = jest.fn().mockResolvedValue(undefined);
const mockRevokeUserCodeEnvironmentWorkers = jest.fn().mockResolvedValue(0);

jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual('@librechat/data-schemas');
  return {
    ...actual,
    logger: {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    },
  };
});

jest.mock('~/models', () => {
  const _mongoose = require('mongoose');
  return {
    deleteAllUserSessions: jest.fn().mockResolvedValue(undefined),
    deleteAllSharedLinks: jest.fn().mockResolvedValue(undefined),
    deleteAllAgentApiKeys: jest.fn().mockResolvedValue(undefined),
    deleteConversationTags: jest.fn().mockResolvedValue(undefined),
    deleteAllUserMemories: jest.fn().mockResolvedValue(undefined),
    deleteSchedulesByUser: jest.fn().mockResolvedValue(undefined),
    deleteTransactions: jest.fn().mockResolvedValue(undefined),
    deleteAclEntries: jest.fn().mockResolvedValue(undefined),
    updateUserPlugins: jest.fn(),
    deleteAssistants: jest.fn().mockResolvedValue(undefined),
    deleteUserById: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    beginAgentTriggerUserDeletion: jest.fn().mockResolvedValue('acquired'),
    cancelAgentTriggerUserDeletion: jest.fn().mockResolvedValue(true),
    deleteUserPrompts: jest.fn().mockResolvedValue(undefined),
    deleteUserSkills: jest.fn().mockResolvedValue(undefined),
    deleteUserCodeEnvironments: jest.fn().mockResolvedValue(undefined),
    deleteMessages: jest.fn().mockResolvedValue(undefined),
    deleteBalances: jest.fn().mockResolvedValue(undefined),
    deleteActions: jest.fn().mockResolvedValue(undefined),
    deletePresets: jest.fn().mockResolvedValue(undefined),
    deleteUserKey: jest.fn().mockResolvedValue(undefined),
    deleteToolCalls: jest.fn().mockResolvedValue(undefined),
    deleteUserAgents: jest.fn().mockResolvedValue(undefined),
    deleteTokens: jest.fn().mockResolvedValue(undefined),
    deleteConvos: jest.fn().mockResolvedValue(undefined),
    deleteFiles: jest.fn().mockResolvedValue(undefined),
    updateUser: jest.fn(),
    acceptTerms: jest.fn(),
    getUserById: jest.fn().mockResolvedValue(null),
    findToken: jest.fn(),
    getFiles: jest.fn().mockResolvedValue([]),
    removeUserFromAllGroups: jest.fn().mockImplementation(async (userId) => {
      const Group = _mongoose.models.Group;
      await Group.updateMany({ memberIds: userId }, { $pullAll: { memberIds: [userId] } });
    }),
  };
});

jest.mock('~/server/services/PluginService', () => ({
  updateUserPluginAuth: jest.fn(),
  deleteUserPluginAuth: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('~/server/services/AuthService', () => ({
  verifyEmail: jest.fn(),
  resendVerificationEmail: jest.fn(),
}));

jest.mock('sharp', () =>
  jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({}),
    toFormat: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.alloc(0)),
  })),
);

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  needsRefresh: jest.fn(),
  getNewS3URL: jest.fn(),
  getWebSearchInstallEntries: (...args) => mockGetWebSearchInstallEntries(...args),
  revokeUserCodeEnvironmentWorkers: (...args) => mockRevokeUserCodeEnvironmentWorkers(...args),
  GenerationJobManager: {
    getAccountCleanupJobIdsForUser: (...args) => mockGetActiveJobIdsForUser(...args),
    getCleanupJob: (...args) => mockGetAgentJob(...args),
    abortJob: (...args) => mockAbortJob(...args),
  },
  deleteAgentCheckpoints: (...args) => mockDeleteAgentCheckpoints(...args),
  deleteOwnedAgentCheckpoints: (...args) => mockDeleteOwnedAgentCheckpoints(...args),
  openCheckpointDeletion: jest.fn(async (userId, tenantId, _root, cfg) => ({
    remember: jest.fn(async () => undefined),
    cleanup: async () => mockDeleteOwnedAgentCheckpoints(userId, tenantId, undefined, cfg),
    acknowledge: jest.fn(async () => undefined),
    conversationIds: () => [],
  })),
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
  restoreUserSchedulesFromDeletion: (...args) => mockRestoreUserSchedules(...args),
}));

jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(),
  getMCPServersRegistry: jest.fn(),
  invalidateCodeEnvironmentConfigCache: (...args) =>
    mockInvalidateCodeEnvironmentConfigCache(...args),
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(),
}));

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
});

const {
  deleteUserController,
  getUserController,
  acceptTermsController,
  updateUserPluginsController,
  resendVerificationController,
  verifyEmailController,
} = require('./UserController');
const { Group } = require('~/db/models');
const {
  deleteConvos,
  acceptTerms,
  deleteUserById,
  deleteUserCodeEnvironments,
  deleteMessages,
  beginAgentTriggerUserDeletion,
  cancelAgentTriggerUserDeletion,
} = require('~/models');
const { verifyEmail, resendVerificationEmail } = require('~/server/services/AuthService');
const { updateUserPluginAuth, deleteUserPluginAuth } = require('~/server/services/PluginService');
const { webSearchSelectionFields } = require('@librechat/data-schemas');

describe('updateUserPluginsController', () => {
  const mockRes = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not persist web-search selections after a credential write fails', async () => {
    mockGetWebSearchInstallEntries.mockReturnValue([
      ['KEENABLE_API_KEY', 'new-key'],
      [webSearchSelectionFields.selectedProvider, 'keenable'],
      [webSearchSelectionFields.selectedScraper, 'keenable'],
      [webSearchSelectionFields.selectedReranker, 'none'],
    ]);
    updateUserPluginAuth.mockResolvedValueOnce(new Error('credential write failed'));

    await updateUserPluginsController(
      {
        config: {
          webSearch: {
            keenableApiKey: '${KEENABLE_API_KEY}',
            keenableApiUrl: '${KEENABLE_API_URL}',
          },
        },
        user: { id: 'user-id', _id: 'user-id', plugins: [] },
        body: {
          pluginKey: 'web_search',
          action: 'install',
          isEntityTool: true,
          auth: {
            selectedProvider: 'keenable',
            selectedScraper: 'keenable',
            selectedReranker: 'none',
            keenableApiKey: 'new-key',
          },
        },
      },
      mockRes,
    );

    expect(updateUserPluginAuth).toHaveBeenCalledTimes(1);
    expect(updateUserPluginAuth).toHaveBeenCalledWith(
      'user-id',
      'KEENABLE_API_KEY',
      'web_search',
      'new-key',
    );
    for (const selectionField of Object.values(webSearchSelectionFields)) {
      expect(updateUserPluginAuth).not.toHaveBeenCalledWith(
        'user-id',
        selectionField,
        'web_search',
        expect.anything(),
      );
    }
  });

  it('deletes explicitly cleared web-search credentials', async () => {
    mockGetWebSearchInstallEntries.mockReturnValue([['KEENABLE_API_URL', '']]);

    await updateUserPluginsController(
      {
        config: {
          webSearch: {
            keenableApiUrl: '${KEENABLE_API_URL}',
          },
        },
        user: { id: 'user-id', _id: 'user-id', plugins: [] },
        body: {
          pluginKey: 'web_search',
          action: 'install',
          isEntityTool: true,
          auth: {
            keenableApiUrl: '',
          },
        },
      },
      mockRes,
    );

    expect(deleteUserPluginAuth).toHaveBeenCalledWith('user-id', 'KEENABLE_API_URL');
    expect(updateUserPluginAuth).not.toHaveBeenCalled();
  });
});

describe('verifyEmailController', () => {
  const mockRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuiesceUserSchedules.mockResolvedValue(true);
    mockGetActiveJobIdsForUser.mockResolvedValue([]);
    mockGetAgentJob.mockResolvedValue(null);
    mockAbortJob.mockResolvedValue({ success: true });
    mockDeleteOwnedAgentCheckpoints.mockResolvedValue(undefined);
  });

  it('returns the generic verification error message from service failures', async () => {
    verifyEmail.mockResolvedValue(new Error('Invalid or expired email verification token'));

    await verifyEmailController(
      { body: { email: 'user%40example.com', token: 'not-the-token' } },
      mockRes,
    );

    expect(mockRes.status).toHaveBeenCalledWith(400);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Invalid or expired email verification token',
    });
  });

  it('uses the service status for resend verification responses', async () => {
    resendVerificationEmail.mockResolvedValue({ status: 500, message: 'Something went wrong.' });

    await resendVerificationController({ body: { email: 'user@example.com' } }, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Something went wrong.' });
  });
});

describe('getUserController', () => {
  const mockRes = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should only expose public user response fields from the request user', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const updatedAt = new Date('2026-01-02T00:00:00.000Z');
    const req = {
      config: {},
      user: {
        id: 'user-id',
        _id: 'user-id',
        name: 'OpenID User',
        username: 'openid-user',
        email: 'openid@test.com',
        emailVerified: true,
        avatar: '/avatars/user-id.png',
        provider: 'openid',
        role: 'USER',
        plugins: ['web_search'],
        twoFactorEnabled: true,
        termsAccepted: true,
        personalization: { memories: false },
        favorites: [{ model: 'gpt-5', endpoint: 'openAI' }],
        skillStates: { skill_one: true },
        createdAt,
        updatedAt,
        tenantId: 'tenant-id',
        password: 'hashed-password',
        __v: 1,
        totpSecret: 'totp-secret',
        backupCodes: [{ codeHash: 'backup-code' }],
        pendingTotpSecret: 'pending-totp-secret',
        pendingBackupCodes: [{ codeHash: 'pending-backup-code' }],
        refreshToken: [{ refreshToken: 'legacy-refresh-token' }],
        googleId: 'google-id',
        openidId: 'openid-id',
        openidIssuer: 'openid-issuer',
        idOnTheSource: 'external-source-id',
        federatedTokens: {
          access_token: 'access-token',
          id_token: 'id-token',
          refresh_token: 'refresh-token',
        },
        openidTokens: {
          access_token: 'openid-access-token',
          refresh_token: 'openid-refresh-token',
        },
        tokenset: {
          access_token: 'tokenset-access-token',
          refresh_token: 'tokenset-refresh-token',
        },
        safeLookingRuntimeField: 'internal-value',
      },
    };

    await getUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    const sentUser = mockRes.send.mock.calls[0][0];
    expect(sentUser).toMatchObject({
      id: 'user-id',
      _id: 'user-id',
      name: 'OpenID User',
      username: 'openid-user',
      email: 'openid@test.com',
      emailVerified: true,
      avatar: '/avatars/user-id.png',
      provider: 'openid',
      role: 'USER',
      plugins: ['web_search'],
      twoFactorEnabled: true,
      termsAccepted: true,
      personalization: { memories: false },
      favorites: [{ model: 'gpt-5', endpoint: 'openAI' }],
      skillStates: { skill_one: true },
      createdAt,
      updatedAt,
      tenantId: 'tenant-id',
    });
    expect(sentUser).not.toHaveProperty('password');
    expect(sentUser).not.toHaveProperty('__v');
    expect(sentUser).not.toHaveProperty('totpSecret');
    expect(sentUser).not.toHaveProperty('backupCodes');
    expect(sentUser).not.toHaveProperty('pendingTotpSecret');
    expect(sentUser).not.toHaveProperty('pendingBackupCodes');
    expect(sentUser).not.toHaveProperty('refreshToken');
    expect(sentUser).not.toHaveProperty('googleId');
    expect(sentUser).not.toHaveProperty('openidId');
    expect(sentUser).not.toHaveProperty('openidIssuer');
    expect(sentUser).not.toHaveProperty('idOnTheSource');
    expect(sentUser).not.toHaveProperty('federatedTokens');
    expect(sentUser).not.toHaveProperty('openidTokens');
    expect(sentUser).not.toHaveProperty('tokenset');
    expect(sentUser).not.toHaveProperty('safeLookingRuntimeField');
  });
});

describe('acceptTermsController', () => {
  const mockRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 404 when the user does not exist', async () => {
    acceptTerms.mockResolvedValueOnce(null);

    await acceptTermsController({ user: { id: 'missing-user' } }, mockRes);

    expect(acceptTerms).toHaveBeenCalledWith('missing-user');
    expect(mockRes.status).toHaveBeenCalledWith(404);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'User not found' });
  });

  it('returns the recorded acceptance timestamp on success', async () => {
    const acceptedAt = new Date('2026-06-14T10:00:00.000Z');
    acceptTerms.mockResolvedValueOnce({ termsAccepted: true, termsAcceptedAt: acceptedAt });

    await acceptTermsController({ user: { id: 'user-id' } }, mockRes);

    expect(acceptTerms).toHaveBeenCalledWith('user-id');
    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith({
      message: 'Terms accepted successfully',
      termsAcceptedAt: acceptedAt,
    });
  });

  it('returns 500 when the update throws', async () => {
    acceptTerms.mockRejectedValueOnce(new Error('db down'));

    await acceptTermsController({ user: { id: 'user-id' } }, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Error accepting terms' });
  });
});

describe('deleteUserController', () => {
  const mockRes = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuiesceUserSchedules.mockResolvedValue(true);
  });

  it('should return 200 on successful deletion', async () => {
    const userId = new mongoose.Types.ObjectId();
    const req = { user: { id: userId.toString(), _id: userId, email: 'test@test.com' } };

    await deleteUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.send).toHaveBeenCalledWith({ message: 'User deleted' });
    expect(beginAgentTriggerUserDeletion).toHaveBeenCalledWith(userId.toString(), expect.any(Date));
    expect(mockPrepareAgentTriggerUserPurge).toHaveBeenCalledWith(
      userId.toString(),
      expect.any(Date),
      undefined,
    );
    expect(mockDrainAgentTriggerDeliveriesForUser).toHaveBeenCalledWith(userId.toString());
    expect(mockCancelAndDrainSubagentThreads).toHaveBeenCalledWith(userId.toString(), undefined);
    expect(mockQuiesceUserSchedules).toHaveBeenCalledWith(userId.toString(), expect.any(String));
    expect(beginAgentTriggerUserDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrepareAgentTriggerUserPurge.mock.invocationCallOrder[0],
    );
    expect(mockPrepareAgentTriggerUserPurge.mock.invocationCallOrder[0]).toBeLessThan(
      mockDrainAgentTriggerDeliveriesForUser.mock.invocationCallOrder[0],
    );
    expect(mockDrainAgentTriggerDeliveriesForUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancelAndDrainSubagentThreads.mock.invocationCallOrder[0],
    );
    expect(mockCancelAndDrainSubagentThreads.mock.invocationCallOrder[0]).toBeLessThan(
      mockQuiesceUserSchedules.mock.invocationCallOrder[0],
    );
    expect(mockQuiesceUserSchedules.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMessages.mock.invocationCallOrder[0],
    );
    expect(deleteMessages.mock.invocationCallOrder[0]).toBeLessThan(
      deleteUserById.mock.invocationCallOrder[0],
    );
    expect(deleteUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mockPurgeAgentTriggerDeliveriesForUser.mock.invocationCallOrder[0],
    );
    expect(deleteUserById.mock.invocationCallOrder[0]).toBeLessThan(
      mockRevokeUserCodeEnvironmentWorkers.mock.invocationCallOrder[0],
    );
    expect(mockRevokeUserCodeEnvironmentWorkers.mock.invocationCallOrder[0]).toBeLessThan(
      deleteUserCodeEnvironments.mock.invocationCallOrder[0],
    );
    expect(mockPurgeAgentTriggerDeliveriesForUser).toHaveBeenCalledWith(userId.toString());
    expect(cancelAgentTriggerUserDeletion).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerUserPurge).not.toHaveBeenCalled();
    // A successful deletion hard-deletes the schedules; it must never restore them.
    expect(mockRestoreUserSchedules).not.toHaveBeenCalled();
  });

  it('does not erase checkpoint payload when conversation deletion fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    deleteConvos.mockImplementationOnce(async (_userId, _filter, options) => {
      await options.beforeDelete(['conversation-1']);
      throw new Error('conversation deletion failed');
    });
    await deleteUserController(
      { user: { id: userId.toString(), _id: userId, email: 'delete-failed@test.com' } },
      mockRes,
    );
    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockDeleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
    expect(deleteMessages).not.toHaveBeenCalled();
  });

  it('aborts generations admitted before the deletion fence before erasing messages', async () => {
    const userId = new mongoose.Types.ObjectId();
    mockGetActiveJobIdsForUser.mockResolvedValueOnce(['stream-1', 'stream-2']);
    mockGetAgentJob.mockImplementation(async (streamId) => ({
      metadata: { userId: userId.toString(), tenantId: 'tenant-1' },
      streamId,
      createdAt: 123,
    }));
    const req = {
      user: {
        id: userId.toString(),
        _id: userId,
        email: 'active@test.com',
        tenantId: 'tenant-1',
      },
    };

    await deleteUserController(req, mockRes);

    expect(mockGetActiveJobIdsForUser).toHaveBeenCalledWith(userId.toString(), 'tenant-1');
    expect(mockAbortJob).toHaveBeenCalledWith('stream-1', {
      expectedCreatedAt: 123,
      awaitProviderDrain: true,
    });
    expect(mockAbortJob).toHaveBeenCalledWith('stream-2', {
      expectedCreatedAt: 123,
      awaitProviderDrain: true,
    });
    expect(mockAbortJob.mock.invocationCallOrder[1]).toBeLessThan(
      deleteMessages.mock.invocationCallOrder[0],
    );
  });

  it.each(['terminalPersistencePending', 'terminalHostActionPending'])(
    'waits for %s after an already-settled abort',
    async (marker) => {
      const userId = new mongoose.Types.ObjectId();
      const job = {
        createdAt: 123,
        status: 'complete',
        metadata: { userId: userId.toString(), [marker]: true },
      };
      mockGetActiveJobIdsForUser.mockResolvedValueOnce(['terminal']);
      mockGetAgentJob
        .mockResolvedValueOnce(job)
        .mockImplementationOnce(async () => {
          expect(deleteMessages).not.toHaveBeenCalled();
          expect(mockDeleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
          return job;
        })
        .mockImplementationOnce(async () => {
          expect(deleteMessages).not.toHaveBeenCalled();
          return { ...job, metadata: { ...job.metadata, [marker]: false } };
        });
      mockAbortJob.mockResolvedValueOnce({ success: false, failureReason: 'already_settled' });
      await deleteUserController({ user: { id: userId.toString(), _id: userId } }, mockRes);
      expect(mockGetAgentJob).toHaveBeenCalledTimes(3);
      expect(deleteMessages).toHaveBeenCalled();
    },
  );

  it('retains account data when terminal persistence cannot be confirmed', async () => {
    const userId = new mongoose.Types.ObjectId();
    mockGetActiveJobIdsForUser.mockResolvedValueOnce(['terminal']);
    mockGetAgentJob
      .mockResolvedValueOnce({
        createdAt: 123,
        metadata: { userId: userId.toString(), terminalPersistencePending: true },
      })
      .mockRejectedValueOnce(new Error('terminal owner unavailable'));
    await deleteUserController({ user: { id: userId.toString(), _id: userId } }, mockRes);
    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(mockDeleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
  });

  it('normalizes an empty account tenant before checkpoint erasure', async () => {
    const userId = new mongoose.Types.ObjectId();
    const actual = jest.requireActual('@librechat/api');
    const owner = actual.checkpointOwnerNamespacePrefix(userId.toString());
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      await mongoose.connection.db.collection(name).insertMany([
        { thread_id: 'thread', checkpoint_ns: owner + 'event-actor/new', lc_owner: owner },
        { thread_id: 'thread', checkpoint_ns: 'foreign', lc_owner: 'foreign' },
      ]);
    }
    mockDeleteOwnedAgentCheckpoints.mockImplementationOnce((...args) =>
      actual.deleteOwnedAgentCheckpoints(...args),
    );
    await deleteUserController(
      { user: { id: userId.toString(), _id: userId, tenantId: '' } },
      mockRes,
    );
    expect(mockDeleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
      userId.toString(),
      undefined,
      undefined,
      undefined,
    );
    for (const name of ['agent_checkpoints', 'agent_checkpoint_writes']) {
      expect(
        (await mongoose.connection.db.collection(name).find().toArray()).map((row) => row.lc_owner),
      ).toEqual(['foreign']);
    }
  });

  it('prunes only account checkpoint receipts bound to the deleted user and tenant', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userIdString = userId.toString();
    const ownedNamespace = `lcg:v2:${require('crypto')
      .createHash('sha256')
      .update(JSON.stringify(['tenant-1', userIdString]))
      .digest('hex')}:00000000-0000-4000-8000-000000000001`;
    const foreignUserNamespace = 'lcg:v1:00000000-0000-4000-8000-000000000002';
    const foreignTenantNamespace = 'lcg:v1:00000000-0000-4000-8000-000000000003';
    const missingTenantNamespace = 'lcg:v1:00000000-0000-4000-8000-000000000004';
    const checkpointDocuments = [
      ownedNamespace,
      `${ownedNamespace}|subgraph`,
      foreignUserNamespace,
      foreignTenantNamespace,
      missingTenantNamespace,
      '',
    ].map((checkpointNamespace) => ({
      thread_id: 'collision-id',
      checkpoint_ns: checkpointNamespace,
    }));
    await mongoose.connection.db.collection('agent_checkpoints').insertMany(checkpointDocuments);
    await mongoose.connection.db
      .collection('agent_checkpoint_writes')
      .insertMany(checkpointDocuments);
    mockDeleteOwnedAgentCheckpoints.mockImplementationOnce((...args) =>
      jest.requireActual('@librechat/api').deleteOwnedAgentCheckpoints(...args),
    );
    deleteConvos.mockResolvedValueOnce({ deletedCount: 1, conversationIds: ['collision-id'] });
    mockGetActiveJobIdsForUser.mockResolvedValueOnce([
      'owned-run',
      'foreign-user-run',
      'foreign-tenant-run',
      'legacy-tenant-run',
      'legacy-run',
    ]);
    mockGetAgentJob.mockImplementation(async (streamId) => {
      const metadata = {
        'owned-run': {
          userId: userIdString,
          tenantId: 'tenant-1',
          conversationId: 'collision-id',
          checkpointNamespace: ownedNamespace,
          generationProtocolVersion: 2,
        },
        'foreign-user-run': {
          userId: 'foreign-user',
          tenantId: 'tenant-1',
          conversationId: 'collision-id',
          checkpointNamespace: foreignUserNamespace,
          generationProtocolVersion: 2,
        },
        'foreign-tenant-run': {
          userId: userIdString,
          tenantId: 'foreign-tenant',
          conversationId: 'collision-id',
          checkpointNamespace: foreignTenantNamespace,
          generationProtocolVersion: 2,
        },
        'legacy-run': {
          userId: userIdString,
          tenantId: 'tenant-1',
          conversationId: 'collision-id',
          checkpointNamespace: '',
          generationProtocolVersion: 1,
        },
        'legacy-tenant-run': {
          userId: userIdString,
          conversationId: 'collision-id',
          checkpointNamespace: missingTenantNamespace,
          generationProtocolVersion: 2,
        },
      }[streamId];
      return { metadata, streamId, createdAt: 123 };
    });
    const req = {
      user: {
        id: userIdString,
        _id: userId,
        email: 'account@test.com',
        tenantId: 'tenant-1',
      },
      config: {},
    };

    await deleteUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(
      await mongoose.connection.db
        .collection('agent_checkpoints')
        .find({ thread_id: 'collision-id' })
        .project({ _id: 0, checkpoint_ns: 1 })
        .sort({ checkpoint_ns: 1 })
        .toArray(),
    ).toEqual([
      { checkpoint_ns: '' },
      { checkpoint_ns: foreignUserNamespace },
      { checkpoint_ns: foreignTenantNamespace },
      { checkpoint_ns: missingTenantNamespace },
    ]);
    expect(mockAbortJob.mock.calls.map(([streamId]) => streamId)).toEqual([
      'owned-run',
      'legacy-tenant-run',
      'legacy-run',
    ]);
    expect(mockDeleteOwnedAgentCheckpoints).toHaveBeenCalledWith(
      userIdString,
      'tenant-1',
      undefined,
      undefined,
    );
  });

  it('fails closed when an account generation is replaced before abort', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userIdString = userId.toString();
    mockGetActiveJobIdsForUser.mockResolvedValueOnce(['replaced-run']);
    mockGetAgentJob.mockResolvedValueOnce({
      metadata: { userId: userIdString, tenantId: 'tenant-1' },
      streamId: 'replaced-run',
      createdAt: 123,
    });
    mockAbortJob.mockResolvedValueOnce({ success: false, failureReason: 'generation_replaced' });

    await deleteUserController(
      {
        user: {
          id: userIdString,
          _id: userId,
          email: 'account@test.com',
          tenantId: 'tenant-1',
        },
      },
      mockRes,
    );

    expect(mockAbortJob).toHaveBeenCalledWith('replaced-run', {
      expectedCreatedAt: 123,
      awaitProviderDrain: true,
    });
    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(mockDeleteOwnedAgentCheckpoints).not.toHaveBeenCalled();
  });

  it('fails closed and releases deletion fences when a provider cannot confirm drain', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userIdString = userId.toString();
    mockGetActiveJobIdsForUser.mockResolvedValueOnce(['stream-still-writing']);
    mockGetAgentJob.mockResolvedValueOnce({
      metadata: { userId: userIdString, tenantId: 'tenant-1' },
      streamId: 'stream-still-writing',
      createdAt: 123,
    });
    mockAbortJob.mockRejectedValueOnce(new Error('provider drain timed out'));
    const req = {
      user: {
        id: userIdString,
        _id: userId,
        email: 'active@test.com',
        tenantId: 'tenant-1',
      },
    };

    await deleteUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(deleteMessages).not.toHaveBeenCalled();
    const deletionFence = beginAgentTriggerUserDeletion.mock.calls[0][1];
    expect(mockCancelAgentTriggerUserPurge).toHaveBeenCalledWith(userIdString, deletionFence);
    expect(cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(userIdString, deletionFence);
    expect(deleteUserById).not.toHaveBeenCalled();
    // Account survives -> its suspended schedules are restored under the quiesce token.
    expect(mockRestoreUserSchedules).toHaveBeenCalledWith(
      userIdString,
      mockQuiesceUserSchedules.mock.calls[0][1],
    );
    // BEFORE the deletion fence is released: that fence is what refuses new schedule writes,
    // so restoring after it would let an owner PATCH — or a second deletion attempt
    // re-suspending under a new token — race the restore and strand the disabled snapshot.
    expect(mockRestoreUserSchedules.mock.invocationCallOrder[0]).toBeLessThan(
      cancelAgentTriggerUserDeletion.mock.invocationCallOrder[0],
    );
  });

  it('fails closed before data cleanup when detached subagents do not drain', async () => {
    const userId = new mongoose.Types.ObjectId();
    mockCancelAndDrainSubagentThreads.mockRejectedValueOnce(new Error('child drain timed out'));
    const req = {
      user: {
        id: userId.toString(),
        _id: userId,
        email: 'active-child@test.com',
        tenantId: 'tenant-1',
      },
    };

    await deleteUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(
      userId.toString(),
      expect.any(Date),
    );
    expect(deleteUserById).not.toHaveBeenCalled();
  });

  it('fails closed and releases deletion fences when schedules cannot be quiesced', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userIdString = userId.toString();
    mockQuiesceUserSchedules.mockResolvedValueOnce(false);
    const req = {
      user: {
        id: userIdString,
        _id: userId,
        email: 'scheduled@test.com',
        tenantId: 'tenant-1',
      },
    };

    await deleteUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(deleteMessages).not.toHaveBeenCalled();
    expect(mockGetActiveJobIdsForUser).not.toHaveBeenCalled();
    const deletionFence = beginAgentTriggerUserDeletion.mock.calls[0][1];
    expect(mockCancelAgentTriggerUserPurge).toHaveBeenCalledWith(userIdString, deletionFence);
    expect(cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(userIdString, deletionFence);
    expect(deleteUserById).not.toHaveBeenCalled();
    // Account survives -> its suspended schedules are restored under the quiesce token.
    expect(mockRestoreUserSchedules).toHaveBeenCalledWith(
      userIdString,
      mockQuiesceUserSchedules.mock.calls[0][1],
    );
    // BEFORE the deletion fence is released: that fence is what refuses new schedule writes,
    // so restoring after it would let an owner PATCH — or a second deletion attempt
    // re-suspending under a new token — race the restore and strand the disabled snapshot.
    expect(mockRestoreUserSchedules.mock.invocationCallOrder[0]).toBeLessThan(
      cancelAgentTriggerUserDeletion.mock.invocationCallOrder[0],
    );
  });

  it('should remove the user from all groups via $pullAll', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userIdStr = userId.toString();
    const otherUser = new mongoose.Types.ObjectId().toString();

    await Group.create([
      { name: 'Group A', memberIds: [userIdStr, otherUser], source: 'local' },
      { name: 'Group B', memberIds: [userIdStr], source: 'local' },
      { name: 'Group C', memberIds: [otherUser], source: 'local' },
    ]);

    const req = { user: { id: userIdStr, _id: userId, email: 'del@test.com' } };
    await deleteUserController(req, mockRes);

    const groups = await Group.find({}).sort({ name: 1 }).lean();
    expect(groups[0].memberIds).toEqual([otherUser]);
    expect(groups[1].memberIds).toEqual([]);
    expect(groups[2].memberIds).toEqual([otherUser]);
  });

  it('should handle user that exists in no groups', async () => {
    const userId = new mongoose.Types.ObjectId();
    await Group.create({ name: 'Empty', memberIds: ['someone-else'], source: 'local' });

    const req = { user: { id: userId.toString(), _id: userId, email: 'no-groups@test.com' } };
    await deleteUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(200);
    const group = await Group.findOne({ name: 'Empty' }).lean();
    expect(group.memberIds).toEqual(['someone-else']);
  });

  it('should remove duplicate memberIds if the user appears more than once', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userIdStr = userId.toString();

    await Group.create({
      name: 'Dupes',
      memberIds: [userIdStr, 'other', userIdStr],
      source: 'local',
    });

    const req = { user: { id: userIdStr, _id: userId, email: 'dupe@test.com' } };
    await deleteUserController(req, mockRes);

    const group = await Group.findOne({ name: 'Dupes' }).lean();
    expect(group.memberIds).toEqual(['other']);
  });

  it('fails closed when conversation deletion fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    deleteConvos.mockRejectedValueOnce(new Error('no convos'));

    const req = { user: { id: userId.toString(), _id: userId, email: 'convos@test.com' } };
    await deleteUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it('should return 500 when a critical operation fails', async () => {
    const userId = new mongoose.Types.ObjectId();
    const { deleteMessages } = require('~/models');
    deleteMessages.mockRejectedValueOnce(new Error('db down'));

    const req = { user: { id: userId.toString(), _id: userId, email: 'fail@test.com' } };
    await deleteUserController(req, mockRes);

    expect(mockRes.status).toHaveBeenCalledWith(500);
    expect(mockRes.json).toHaveBeenCalledWith({ message: 'Something went wrong.' });
    expect(cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(
      userId.toString(),
      expect.any(Date),
    );
    expect(mockCancelAgentTriggerUserPurge).toHaveBeenCalledWith(
      userId.toString(),
      expect.any(Date),
    );
    expect(deleteUserById).not.toHaveBeenCalled();
  });

  it('preserves queued trigger payloads when deletion fails before the user commit', async () => {
    const userId = new mongoose.Types.ObjectId();
    deleteMessages.mockRejectedValueOnce(new Error('db down'));

    await deleteUserController({ user: { id: String(userId), _id: userId } }, mockRes);

    expect(mockPurgeAgentTriggerDeliveriesForUser).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerUserPurge).toHaveBeenCalledWith(String(userId), expect.any(Date));
    expect(cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(String(userId), expect.any(Date));
  });

  it('does not purge trigger payloads when the user deletion did not commit', async () => {
    const userId = new mongoose.Types.ObjectId();
    deleteUserById.mockResolvedValueOnce({ deletedCount: 0 });

    await deleteUserController({ user: { id: String(userId), _id: userId } }, mockRes);

    expect(mockPurgeAgentTriggerDeliveriesForUser).not.toHaveBeenCalled();
    expect(mockCancelAgentTriggerUserPurge).toHaveBeenCalledWith(String(userId), expect.any(Date));
    expect(cancelAgentTriggerUserDeletion).toHaveBeenCalledWith(String(userId), expect.any(Date));
    expect(mockRes.status).toHaveBeenCalledWith(500);
  });

  it('should use string user.id (not ObjectId user._id) for memberIds removal', async () => {
    const userId = new mongoose.Types.ObjectId();
    const userIdStr = userId.toString();
    const otherUser = 'other-user-id';

    await Group.create({
      name: 'StringCheck',
      memberIds: [userIdStr, otherUser],
      source: 'local',
    });

    const req = { user: { id: userIdStr, _id: userId, email: 'stringcheck@test.com' } };
    await deleteUserController(req, mockRes);

    const group = await Group.findOne({ name: 'StringCheck' }).lean();
    expect(group.memberIds).toEqual([otherUser]);
    expect(group.memberIds).not.toContain(userIdStr);
  });
});
