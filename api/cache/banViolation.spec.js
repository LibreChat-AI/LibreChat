const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ViolationTypes } = require('librechat-data-provider');
const { deleteAllUserSessions } = require('~/models');
const getLogStores = require('./getLogStores');
const banViolation = require('./banViolation');

// Mock deleteAllUserSessions since we're testing ban logic, not session deletion
jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  deleteAllUserSessions: jest.fn().mockResolvedValue(true),
}));

describe('banViolation', () => {
  let mongoServer;
  let req, res, errorMessage;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    req = {
      ip: '127.0.0.1',
      cookies: {
        refreshToken: 'someToken',
      },
    };
    res = {
      clearCookie: jest.fn(),
    };
    errorMessage = {
      type: 'someViolation',
      user_id: new mongoose.Types.ObjectId().toString(), // Use valid ObjectId
      prev_count: 0,
      violation_count: 0,
    };
    process.env.BAN_VIOLATIONS = 'true';
    process.env.BAN_DURATION = '7200000'; // 2 hours in ms
    process.env.BAN_INTERVAL = '20';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should not ban if BAN_VIOLATIONS are not enabled', async () => {
    process.env.BAN_VIOLATIONS = 'false';
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeFalsy();
  });

  it('should not ban if errorMessage is not provided', async () => {
    await banViolation(req, res, null);
    expect(errorMessage.ban).toBeFalsy();
  });

  it('[1/3] should ban if violation_count crosses the interval threshold: 19 -> 39', async () => {
    errorMessage.prev_count = 19;
    errorMessage.violation_count = 39;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeTruthy();
  });

  it('[2/3] should ban if violation_count crosses the interval threshold: 19 -> 20', async () => {
    errorMessage.prev_count = 19;
    errorMessage.violation_count = 20;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeTruthy();
  });

  const randomValueAbove = Math.floor(20 + Math.random() * 100);
  it(`[3/3] should ban if violation_count crosses the interval threshold: 19 -> ${randomValueAbove}`, async () => {
    errorMessage.prev_count = 19;
    errorMessage.violation_count = randomValueAbove;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeTruthy();
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'bans only the user for a verified trigger request from %s',
    async (ip) => {
      const banLogs = getLogStores(ViolationTypes.BAN);
      await banLogs.delete(ip);
      req.ip = ip;
      req._isAgentTrigger = true;
      errorMessage.violation_count = 20;

      await banViolation(req, res, errorMessage);

      expect(await banLogs.get(errorMessage.user_id)).toEqual(
        expect.objectContaining({ violation_count: 20 }),
      );
      expect(await banLogs.get(ip)).toBeUndefined();
      expect(deleteAllUserSessions).toHaveBeenCalledWith({ userId: errorMessage.user_id });
      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(errorMessage.ban).toBe(true);
      expect(req.ip).toBe(ip);
    },
  );

  it('still bans the IP when an ordinary request sends a trigger header', async () => {
    req.headers = { 'x-lc-agent-trigger': '1' };
    errorMessage.violation_count = 20;

    await banViolation(req, res, errorMessage);

    const banLogs = getLogStores(ViolationTypes.BAN);
    expect(await banLogs.get(req.ip)).toEqual(
      expect.objectContaining({ user_id: errorMessage.user_id, violation_count: 20 }),
    );
  });

  it('should handle invalid BAN_INTERVAL and default to 20', async () => {
    process.env.BAN_INTERVAL = 'invalid';
    errorMessage.prev_count = 19;
    errorMessage.violation_count = 39;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeTruthy();
  });

  it('should ban if BAN_DURATION is invalid as default is 2 hours', async () => {
    process.env.BAN_DURATION = 'invalid';
    errorMessage.prev_count = 19;
    errorMessage.violation_count = 39;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeTruthy();
  });

  it('should not ban if BAN_DURATION is 0 but should clear cookies', async () => {
    process.env.BAN_DURATION = '0';
    errorMessage.prev_count = 19;
    errorMessage.violation_count = 39;
    await banViolation(req, res, errorMessage);
    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
    expect(res.clearCookie).toHaveBeenCalledWith('openid_sub');
  });

  it('should not ban if violation_count does not change', async () => {
    errorMessage.prev_count = 0;
    errorMessage.violation_count = 0;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeFalsy();
  });

  it('[1/2] should not ban if violation_count does not cross the interval threshold: 0 -> 19', async () => {
    errorMessage.prev_count = 0;
    errorMessage.violation_count = 19;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeFalsy();
  });

  const randomValueUnder = Math.floor(1 + Math.random() * 19);
  it(`[2/2] should not ban if violation_count does not cross the interval threshold: 0 -> ${randomValueUnder}`, async () => {
    errorMessage.prev_count = 0;
    errorMessage.violation_count = randomValueUnder;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeFalsy();
  });

  it('[EDGE CASE] should not ban if violation_count is lower', async () => {
    errorMessage.prev_count = 0;
    errorMessage.violation_count = -10;
    await banViolation(req, res, errorMessage);
    expect(errorMessage.ban).toBeFalsy();
  });
});
