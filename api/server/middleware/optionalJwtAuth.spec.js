const mockAuthenticate = jest.fn();
const mockTenantContextMiddleware = jest.fn((_req, _res, next) => next());
const mockIsTwoFactorEnrollmentRequired = jest.fn(() => false);
const mockClearCloudFrontCookies = jest.fn();

jest.mock('passport', () => ({
  _strategy: jest.fn(() => undefined),
  authenticate: (...args) => mockAuthenticate(...args),
}));

jest.mock('@librechat/api', () => ({
  continueAfterOptionalAuth: jest.requireActual('@librechat/api').continueAfterOptionalAuth,
  isEnabled: jest.fn(() => false),
  clearCloudFrontCookies: (...args) => mockClearCloudFrontCookies(...args),
  isTwoFactorEnrollmentRequired: (...args) => mockIsTwoFactorEnrollmentRequired(...args),
  tenantContextMiddleware: (...args) => mockTenantContextMiddleware(...args),
}));

const optionalJwtAuth = require('./optionalJwtAuth');

const run = (user) => {
  const req = { headers: {}, _mockUser: user };
  const res = {};
  const next = jest.fn();
  optionalJwtAuth(req, res, next);
  return { req, res, next };
};

describe('optionalJwtAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsTwoFactorEnrollmentRequired.mockReturnValue(false);
    mockAuthenticate.mockImplementation((_strategy, _options, callback) => {
      return (req) => callback(null, req._mockUser ?? false);
    });
  });

  it('establishes authenticated context when enrollment is not required', () => {
    const user = { id: 'viewer-1', provider: 'local', twoFactorEnabled: true };

    const { req, next } = run(user);

    expect(req.user).toBe(user);
    expect(req.authStrategy).toBe('jwt');
    expect(mockTenantContextMiddleware).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('treats a viewer with incomplete required enrollment as unauthenticated', () => {
    const user = { id: 'viewer-required', provider: 'local', twoFactorEnabled: false };
    mockIsTwoFactorEnrollmentRequired.mockReturnValue(true);

    const { req, res, next } = run(user);

    expect(req.user).toBeUndefined();
    expect(req.authStrategy).toBeUndefined();
    expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(res, {
      userId: 'viewer-required',
      tenantId: undefined,
      storageRegion: undefined,
    });
    expect(mockTenantContextMiddleware).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('continues anonymously when authentication does not resolve a user', () => {
    const { req, next } = run(undefined);

    expect(req.user).toBeUndefined();
    expect(mockTenantContextMiddleware).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
