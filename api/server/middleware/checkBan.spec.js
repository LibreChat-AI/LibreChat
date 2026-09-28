const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ErrorTypes, ViolationTypes } = require('librechat-data-provider');

/** Violation logs are file-backed in production; keep the real namespaced Keyv, swap only the store. */
jest.mock('~/cache/getLogStores', () => {
  const { Keyv } = jest.requireActual('keyv');
  const { ViolationTypes } = jest.requireActual('librechat-data-provider');
  const getLogStores = jest.requireActual('~/cache/getLogStores');
  const violationLogs = new Map();
  return (type) => {
    if (type === ViolationTypes.BAN) {
      return getLogStores(type);
    }
    if (!violationLogs.has(type)) {
      const namespace = type === ViolationTypes.GENERAL ? 'violations' : `violations:${type}`;
      violationLogs.set(type, new Keyv({ store: new Map(), namespace }));
    }
    return violationLogs.get(type);
  };
});

jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  deleteAllUserSessions: jest.fn().mockResolvedValue(true),
}));

process.env.BAN_VIOLATIONS = 'true';
process.env.BAN_INTERVAL = '20';
delete process.env.USE_REDIS;

const logViolation = require('~/cache/logViolation');
const checkBan = require('./checkBan');

/** Passport's social strategies hand the callback a lean user: an ObjectId `_id` and no `id`. */
const createOAuthCallbackReq = (userId, ip) => ({
  ip,
  user: { _id: userId },
  method: 'GET',
  headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0' },
  body: {},
  baseUrl: '/oauth',
  originalUrl: '/oauth/google/callback',
  isOAuthNavigation: true,
});

const createRes = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  redirect: jest.fn().mockReturnThis(),
  clearCookie: jest.fn(),
});

describe('checkBan with namespaced Keyv stores and ObjectId user ids', () => {
  let mongoServer;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('lets an unbanned OAuth user through without Redis', async () => {
    const next = jest.fn();
    const req = createOAuthCallbackReq(new mongoose.Types.ObjectId(), '10.0.0.1');

    await checkBan(req, createRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(req.banned).toBeUndefined();
  });

  it('enforces a ban recorded for the same user from another address', async () => {
    const userId = new mongoose.Types.ObjectId();
    const violationReq = createOAuthCallbackReq(userId, '10.0.0.2');
    const errorMessage = { type: ViolationTypes.LOGINS };

    await logViolation(violationReq, createRes(), ViolationTypes.LOGINS, errorMessage, 20);
    expect(errorMessage.ban).toBe(true);

    const next = jest.fn();
    const res = createRes();
    const req = createOAuthCallbackReq(new mongoose.Types.ObjectId(userId.toString()), '10.0.0.3');

    await checkBan(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(req.banned).toBe(true);
    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining(ErrorTypes.AUTH_BANNED));
  });
});
