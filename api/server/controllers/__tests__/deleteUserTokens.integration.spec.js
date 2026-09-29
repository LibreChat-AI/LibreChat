const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

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
// Keep the bulk of @librechat/api real; only double the deletion fan-out collaborators
// that need generation/checkpoint/code-environment infrastructure the harness has not
// provisioned. None of these touch the token collections.
jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    GenerationJobManager: {
      ...actual.GenerationJobManager,
      getAccountCleanupJobIdsForUser: jest.fn().mockResolvedValue([]),
      getCleanupJob: jest.fn().mockResolvedValue(undefined),
      abortJob: jest.fn().mockResolvedValue({ status: 'confirmed' }),
    },
    isStopConfirmed: jest.fn().mockReturnValue(true),
    waitForGenerationPersistence: jest.fn().mockResolvedValue(undefined),
    openCheckpointDeletion: jest.fn().mockResolvedValue({
      remember: jest.fn(),
      cleanup: jest.fn().mockResolvedValue(undefined),
      acknowledge: jest.fn().mockResolvedValue(undefined),
    }),
    deleteAllSharedLinksWithCleanup: jest.fn().mockResolvedValue(undefined),
    revokeUserCodeEnvironmentWorkers: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock('~/server/services/AuthService', () => ({
  verifyEmail: jest.fn(),
  resendVerificationEmail: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
  invalidateCodeEnvironmentConfigCache: jest.fn().mockResolvedValue(undefined),
}));
// The deletion fan-out reaches collaborators that require durable infrastructure
// (agent-trigger delivery, schedule quiescing, subagent-thread task store, generation
// job manager, code-environment workers) which is not provisioned under
// mongodb-memory-server. Double them as benign no-ops so the fan-out no longer throws
// and the controller reaches its 200, letting the REAL token deletions run against the
// in-memory database. The token collections themselves are NOT mocked.
jest.mock('~/server/services/Agents/triggers', () => ({
  beginAgentTriggerUserDeletion: jest.fn().mockResolvedValue('missing'),
  prepareAgentTriggerUserPurge: jest.fn().mockResolvedValue(undefined),
  drainAgentTriggerDeliveriesForUser: jest.fn().mockResolvedValue(undefined),
  cancelAgentTriggerUserPurge: jest.fn().mockResolvedValue(undefined),
  purgeAgentTriggerDeliveriesForUser: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('~/server/services/Schedules', () => ({
  quiesceUserSchedules: jest.fn().mockResolvedValue(true),
  restoreUserSchedulesFromDeletion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({
  cancelAndDrainForOwner: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('~/server/services/Config/getCachedTools', () => ({
  invalidateCachedTools: jest.fn(),
}));
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(),
  getFlowStateManager: jest.fn(),
  getMCPServersRegistry: jest.fn(),
}));
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(),
}));

const { deleteUserController } = require('~/server/controllers/UserController');
const { Token, AuthToken } = require('~/db/models');
const db = require('~/models');

let mongoServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await Promise.all([
    Token.deleteMany({}),
    AuthToken.deleteMany({}),
    mongoose.models.User.deleteMany({}),
  ]);
});

function createRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createReq(userId) {
  return {
    user: { id: userId.toString(), _id: userId, email: `${userId.toString()}@test.com` },
    body: {},
    config: {},
  };
}

/**
 * Seeds `tokens` with the OAuth material that stays behind after the relocation and
 * `authtokens` with the relocated auth-flow material, including the legacy shape whose
 * `email`, `identifier`, and `type` are all null.
 */
async function seedBothCollections(userId) {
  // A real user document must exist for the deletion to commit: the controller throws
  // (and returns 500) unless `deleteUserById` reports exactly one deleted document.
  await mongoose.models.User.create({
    _id: userId,
    email: `${userId.toString()}@test.com`,
    provider: 'local',
  });
  await Promise.all([
    db.createToken({
      userId,
      type: 'mcp_oauth',
      identifier: 'mcp:server',
      token: 'a',
      expiresIn: 900,
    }),
    db.createToken({
      userId,
      type: 'oauth_refresh',
      identifier: 'oauth:refresh',
      token: 'b',
      expiresIn: 900,
    }),
  ]);
  await Promise.all([
    db.authTokens.createToken({
      userId,
      type: 'password_reset',
      email: 'reset@test.com',
      token: 'c',
      expiresIn: 900,
    }),
    db.authTokens.createToken({
      userId,
      type: 'email_verification',
      email: 'verify@test.com',
      token: 'd',
      expiresIn: 900,
    }),
    db.authTokens.createToken({
      userId,
      email: 'invitee@test.com',
      identifier: 'invite-identifier',
      token: 'e',
      expiresIn: 900,
    }),
    db.authTokens.createToken({
      userId,
      email: null,
      identifier: null,
      type: null,
      token: 'f',
      expiresIn: 900,
    }),
  ]);
}

describe('deleteUserController - token cleanup against a real database', () => {
  it('leaves zero authtokens and zero tokens documents for the deleted user', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedBothCollections(userId);

    expect(await Token.countDocuments({ userId })).toBe(2);
    expect(await AuthToken.countDocuments({ userId })).toBe(4);

    const res = createRes();
    await deleteUserController(createReq(userId), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: 'User deleted' });
    expect(await AuthToken.countDocuments({ userId })).toBe(0);
    expect(await Token.countDocuments({ userId })).toBe(0);
  });

  it('deletes the legacy-shape authtokens document whose email, identifier, and type are null', async () => {
    const userId = new mongoose.Types.ObjectId();
    await seedBothCollections(userId);

    const legacyFilter = { userId, email: null, identifier: null, type: null };
    expect(await AuthToken.countDocuments(legacyFilter)).toBe(1);

    await deleteUserController(createReq(userId), createRes());

    expect(await AuthToken.countDocuments(legacyFilter)).toBe(0);
  });

  it('sweeps only the deleted user from both collections', async () => {
    const userId = new mongoose.Types.ObjectId();
    const otherUserId = new mongoose.Types.ObjectId();
    await seedBothCollections(userId);
    await seedBothCollections(otherUserId);

    await deleteUserController(createReq(userId), createRes());

    expect(await Token.countDocuments({ userId })).toBe(0);
    expect(await AuthToken.countDocuments({ userId })).toBe(0);
    expect(await Token.countDocuments({ userId: otherUserId })).toBe(2);
    expect(await AuthToken.countDocuments({ userId: otherUserId })).toBe(4);
  });
});
