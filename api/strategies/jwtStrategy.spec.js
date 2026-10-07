const { SystemRoles } = require('librechat-data-provider');

let capturedVerifyCallback;
let capturedStrategyOptions;
jest.mock('passport-jwt', () => ({
  Strategy: jest.fn((opts, verifyCallback) => {
    capturedStrategyOptions = opts;
    capturedVerifyCallback = verifyCallback;
    return { name: 'jwt' };
  }),
  ExtractJwt: {
    fromAuthHeaderAsBearerToken: jest.fn(() => 'mock-extractor'),
    fromHeader: jest.fn((name) => `mock-header-extractor:${name}`),
    fromExtractors: jest.fn((extractors) => extractors),
  },
}));

jest.mock('@librechat/api', () => ({
  createJwtExtractor: jest.fn(() => 'mock-configured-extractor'),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('~/models', () => ({
  getUserById: jest.fn(),
  updateUser: jest.fn(),
}));

const jwtLogin = require('./jwtStrategy');
const { createJwtExtractor } = require('@librechat/api');
const { getUserById, updateUser } = require('~/models');

function invokeVerify(payload) {
  return new Promise((resolve, reject) => {
    capturedVerifyCallback(payload, (err, user, info) => {
      if (err) {
        return reject(err);
      }
      resolve({ user, info });
    });
  });
}

describe('jwtStrategy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateUser.mockResolvedValue({});
    jwtLogin();
  });

  it('coerces missing idOnTheSource to null for local users', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-1' },
      role: SystemRoles.USER,
    });

    const { user } = await invokeVerify({ id: 'user-1' });

    expect(user.id).toBe('user-1');
    expect(user.idOnTheSource).toBeNull();
  });

  it('preserves a stored idOnTheSource for federated users', async () => {
    getUserById.mockResolvedValue({
      _id: { toString: () => 'user-2' },
      role: SystemRoles.USER,
      idOnTheSource: 'entra-oid-123',
    });

    const { user } = await invokeVerify({ id: 'user-2' });

    expect(user.idOnTheSource).toBe('entra-oid-123');
  });

  it('returns false when no user is found', async () => {
    getUserById.mockResolvedValue(null);

    const { user } = await invokeVerify({ id: 'missing' });

    expect(user).toBe(false);
  });
});

describe('jwtStrategy token extraction', () => {
  const originalHeader = process.env.JWT_AUTH_HEADER;

  afterEach(() => {
    if (originalHeader === undefined) {
      delete process.env.JWT_AUTH_HEADER;
    } else {
      process.env.JWT_AUTH_HEADER = originalHeader;
    }
  });

  it('builds the extractor from JWT_AUTH_HEADER with Authorization as the fallback', () => {
    process.env.JWT_AUTH_HEADER = 'X-Original-Authorization';
    jwtLogin();

    expect(createJwtExtractor).toHaveBeenCalledWith('X-Original-Authorization', 'mock-extractor');
    expect(capturedStrategyOptions.jwtFromRequest).toBe('mock-configured-extractor');
  });

  it('passes an unset value through, leaving the decision to the extractor', () => {
    delete process.env.JWT_AUTH_HEADER;
    jwtLogin();

    expect(createJwtExtractor).toHaveBeenCalledWith(undefined, 'mock-extractor');
  });
});
