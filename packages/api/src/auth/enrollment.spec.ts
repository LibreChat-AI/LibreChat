import type { EnrollmentControllerDependencies } from './enrollment';
import type { StoredTwoFactorAccount } from './twoFactor';
import { generateTwoFactorLoginChallengeToken } from './twoFactor';
import { createEnrollmentControllers } from './enrollment';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_ENFORCE_2FA = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;

function mockResponse() {
  const res: { status: jest.Mock; json: jest.Mock } = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as import('express').Response;
}

function makeUser(overrides: Partial<StoredTwoFactorAccount> = {}): StoredTwoFactorAccount {
  return {
    _id: 'user-1',
    provider: 'local',
    twoFactorEnabled: false,
    ...overrides,
  } as unknown as StoredTwoFactorAccount;
}

function makeDeps(
  overrides: Partial<EnrollmentControllerDependencies> = {},
): EnrollmentControllerDependencies {
  return {
    updateUser: jest.fn().mockResolvedValue(null),
    awaitAuthUserDocEviction: jest.fn().mockResolvedValue(undefined),
    getUserById: jest.fn().mockResolvedValue(null),
    getTOTPSecret: jest.fn().mockResolvedValue(null),
    verifyTOTP: jest.fn().mockResolvedValue(false),
    verifyBackupCode: jest.fn().mockResolvedValue(false),
    generateBackupCodes: jest.fn().mockResolvedValue({ plainCodes: [], codeObjects: [] }),
    updateTwoFactorEnrollment: jest.fn().mockResolvedValue(null),
    deleteAllUserSessions: jest.fn().mockResolvedValue({}),
    clearCloudFrontCookies: jest.fn(),
    setAuthTokens: jest.fn().mockResolvedValue('jwt-token'),
    ...overrides,
  };
}

describe('createEnrollmentControllers authMethod', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  });

  afterAll(() => {
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
    if (ORIGINAL_ENFORCE_2FA === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = ORIGINAL_ENFORCE_2FA;
    }
  });

  it('marks a password + TOTP login as authMethod local, not blank', async () => {
    const user = makeUser({ twoFactorEnabled: true, totpSecret: 'encrypted-secret' });
    const tempToken = generateTwoFactorLoginChallengeToken('user-1', process.env.JWT_SECRET!);
    const setAuthTokens = jest.fn().mockResolvedValue('jwt-token');
    const deps = makeDeps({
      getUserById: jest.fn().mockResolvedValue(user),
      getTOTPSecret: jest.fn().mockResolvedValue('plain-secret'),
      verifyTOTP: jest.fn().mockResolvedValue(true),
      setAuthTokens,
    });
    const { verify2FAWithTempToken } = createEnrollmentControllers(deps);
    const req = { body: { tempToken, token: '123456' } } as unknown as Parameters<
      typeof verify2FAWithTempToken
    >[0];
    const res = mockResponse();

    await verify2FAWithTempToken(req, res);

    expect(setAuthTokens).toHaveBeenCalledWith(
      user._id,
      res,
      null,
      req,
      expect.objectContaining({ authMethod: 'local' }),
    );
  });

  it('marks a fresh 2FA-setup promotion as authMethod local, not blank', async () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const promotedUser = makeUser({ twoFactorEnabled: true });
    const pendingUser = makeUser({
      twoFactorEnabled: false,
      pendingTotpSecret: 'pending-secret',
      pendingBackupCodes: [{ codeHash: 'hash', used: false }],
    });
    const setAuthTokens = jest.fn().mockResolvedValue('jwt-token');
    const deps = makeDeps({
      getUserById: jest.fn().mockResolvedValue(pendingUser),
      updateTwoFactorEnrollment: jest.fn().mockResolvedValue(promotedUser),
      setAuthTokens,
    });
    const { finalize2FASetup } = createEnrollmentControllers(deps);
    const req = {
      user: { id: 'user-1' },
      twoFactorEnrollmentNonce: 'finalization-nonce',
    } as unknown as Parameters<typeof finalize2FASetup>[0];
    const res = mockResponse();

    await finalize2FASetup(req, res);

    expect(setAuthTokens).toHaveBeenCalledWith(
      promotedUser._id,
      res,
      null,
      req,
      expect.objectContaining({ authMethod: 'local' }),
    );
  });
});
