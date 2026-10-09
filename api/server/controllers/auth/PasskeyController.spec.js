const mockCheckBan = jest.fn();
const mockGetLogStores = jest.fn();
const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: mockGetAppConfig }));
const mockModels = {
  getUserById: jest.fn(),
  updateUser: jest.fn(),
  createPasskey: jest.fn(),
  deletePasskey: jest.fn(),
  renamePasskey: jest.fn(),
  recordPasskeyUse: jest.fn(),
  findPasskeysByUser: jest.fn(),
  countPasskeysByUser: jest.fn(),
  findPasskeyByCredentialId: jest.fn(),
};

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return { ...actual, createPasskeyHandlers: jest.fn(actual.createPasskeyHandlers) };
});
jest.mock('~/models', () => mockModels);
jest.mock('~/cache', () => ({ getLogStores: (...args) => mockGetLogStores(...args) }));
jest.mock('~/server/middleware', () => ({
  checkBan: (...args) => mockCheckBan(...args),
}));

const bcrypt = require('bcryptjs');
const { CacheKeys } = require('librechat-data-provider');
const { createPasskeyHandlers } = require('@librechat/api');
const controller = require('./PasskeyController');

const [deps] = createPasskeyHandlers.mock.calls[0];

const PASSWORD = 'correct horse battery staple';

function buildRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

const originalAllow = process.env.ALLOW_PASSKEY_LOGIN;

beforeAll(() => {
  process.env.ALLOW_PASSKEY_LOGIN = 'true';
});

afterAll(() => {
  if (originalAllow === undefined) {
    delete process.env.ALLOW_PASSKEY_LOGIN;
  } else {
    process.env.ALLOW_PASSKEY_LOGIN = originalAllow;
  }
});

describe('PasskeyController wiring', () => {
  it('exports the handlers the auth routes mount', () => {
    expect(Object.keys(controller).sort()).toEqual(
      [
        'authenticatePasskey',
        'listPasskeys',
        'loginPasskeyOptions',
        'registerPasskeyOptions',
        'registerPasskeyVerify',
        'removePasskey',
        'updatePasskey',
      ].sort(),
    );
  });

  it('hands the model methods, bcrypt and the ban check to the handler factory', () => {
    expect(deps.compare).toBe(bcrypt.compare);
    expect(deps.getAppConfig).toBe(mockGetAppConfig);
    for (const name of Object.keys(mockModels)) {
      expect(deps[name]).toBe(mockModels[name]);
    }

    const args = [{}, {}, jest.fn()];
    deps.checkBan(...args);
    expect(mockCheckBan).toHaveBeenCalledWith(...args);
  });

  it('backs the challenge store with the passkey challenge cache namespace', () => {
    const cache = {};
    mockGetLogStores.mockReturnValue(cache);

    expect(deps.getChallengeCache()).toBe(cache);
    expect(mockGetLogStores).toHaveBeenCalledWith(CacheKeys.PASSKEY_CHALLENGE);
  });

  it('confirms a step-up against a real bcrypt hash', async () => {
    mockModels.getUserById.mockResolvedValue({
      _id: 'u1',
      password: bcrypt.hashSync(PASSWORD, 4),
    });
    mockModels.deletePasskey.mockResolvedValue({ deletedCount: 1 });
    const res = buildRes();

    await controller.removePasskey(
      { user: { id: 'u1' }, params: { passkeyId: 'p1' }, body: { password: PASSWORD } },
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockModels.deletePasskey).toHaveBeenCalledWith('p1', 'u1');
  });

  it('fails a sign-in closed when the challenge cache holds no challenge for the session', async () => {
    mockModels.findPasskeyByCredentialId.mockResolvedValue({
      user: 'u1',
      credentialId: 'cred-1',
      publicKey: Buffer.from('pk'),
      counter: 0,
      transports: [],
    });
    const res = buildRes();
    const next = jest.fn();
    mockGetLogStores.mockReturnValue({
      get: async () => undefined,
      set: async () => true,
      delete: async () => true,
    });

    await controller.authenticatePasskey(
      { body: { credential: { id: 'cred-1', response: {} }, sessionId: 's1' } },
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(mockCheckBan).not.toHaveBeenCalled();
  });
});
