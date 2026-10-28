import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import type {
  IUser,
  TwoFactorEnrollmentGuard,
  TwoFactorEnrollmentUpdate,
} from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import type {
  TokenIssuance,
  TwoFactorEnrollmentDependencies,
  TwoFactorEnrollmentRequest,
} from './twoFactor';
import {
  confirmTwoFactorSetup,
  finalizeTwoFactorSetup,
  acknowledgeTwoFactorSetup,
  TWO_FACTOR_TOKEN_PURPOSE,
  generateTwoFactorSetupFinalizationToken,
  generateTwoFactorSetupAcknowledgementToken,
  generateTwoFactorLoginChallengeToken,
  generateTwoFactorSetupToken,
  isTwoFactorEnrollmentRequired,
  isTwoFactorSetupEligible,
  isCredentialLoginBlockedByTwoFactorPolicy,
  isTokenRetired,
  isEnrollmentSupersededByRecovery,
  hasPasswordResetSince,
  requireTwoFactorSetupToken,
  createBlockRetiredSetupToken,
  requireTwoFactorSetupFinalizationToken,
  requireTwoFactorSetupAcknowledgementToken,
  verifyTwoFactorSetupToken,
  verifyTwoFactorSetupFinalizationToken,
  verifyTwoFactorSetupAcknowledgementToken,
  verifyTwoFactorLoginChallengeToken,
  blockTwoFactorDisableWhenRequired,
  withdrawMintedSession,
} from './twoFactor';

const jwtSecret = 'two-factor-setup-test-secret';
const nonce = 'test-nonce';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('isTwoFactorEnrollmentRequired', () => {
  const originalPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;

  afterAll(() => {
    if (originalPolicy === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalPolicy;
    }
  });

  it.each(['local', 'ldap', undefined])('requires enrollment for %s users', (provider) => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';

    expect(isTwoFactorEnrollmentRequired({ provider, twoFactorEnabled: false })).toBe(true);
  });

  it.each(['openid', 'google', 'saml'])('preserves federated provider scope for %s', (provider) => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';

    expect(isTwoFactorEnrollmentRequired({ provider, twoFactorEnabled: false })).toBe(false);
  });

  it('does not require enrollment for enrolled users or when policy is disabled', () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    expect(isTwoFactorEnrollmentRequired({ provider: 'local', twoFactorEnabled: true })).toBe(
      false,
    );

    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    expect(isTwoFactorEnrollmentRequired({ provider: 'local', twoFactorEnabled: false })).toBe(
      false,
    );
  });
});

describe('isTwoFactorSetupEligible', () => {
  it.each(['local', 'ldap', undefined])('allows %s users', (provider) => {
    expect(isTwoFactorSetupEligible({ provider })).toBe(true);
  });

  it.each(['openid', 'google', 'saml'])('rejects federated %s users', (provider) => {
    expect(isTwoFactorSetupEligible({ provider })).toBe(false);
  });
});

describe('isCredentialLoginBlockedByTwoFactorPolicy', () => {
  const originalPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;

  afterAll(() => {
    if (originalPolicy === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalPolicy;
    }
  });

  /**
   * A reset assigns a password without consulting `provider`, and the local strategy authenticates
   * on the password alone, so a federated record can be signed in with a password.
   */
  it.each(['openid', 'google', 'saml'])('blocks a %s record under enforcement', (provider) => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';

    expect(isCredentialLoginBlockedByTwoFactorPolicy({ provider })).toBe(true);
  });

  it.each(['local', 'ldap', undefined])('allows %s records under enforcement', (provider) => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';

    expect(isCredentialLoginBlockedByTwoFactorPolicy({ provider })).toBe(false);
  });

  it('blocks nothing when the policy is disabled', () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';

    expect(isCredentialLoginBlockedByTwoFactorPolicy({ provider: 'openid' })).toBe(false);
  });

  it('treats a missing user as nothing to block', () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';

    expect(isCredentialLoginBlockedByTwoFactorPolicy(null)).toBe(false);
  });
});

describe('isTokenRetired', () => {
  const enrolledAt = new Date('2026-01-01T00:00:10.500Z');
  const enrolledSecond = Math.floor(enrolledAt.getTime() / 1000);

  it('leaves accounts that never enrolled untouched', () => {
    expect(isTokenRetired({ issuedAt: 0 }, { twoFactorEnrolledAt: null })).toBe(false);
    expect(isTokenRetired({ issuedAt: 0 }, { twoFactorEnrolledAt: undefined })).toBe(false);
  });

  it('refuses a token issued before the enrolling second', () => {
    expect(
      isTokenRetired({ issuedAt: enrolledSecond - 1 }, { twoFactorEnrolledAt: enrolledAt }),
    ).toBe(true);
  });

  it('keeps the session minted within the enrolling second', () => {
    expect(isTokenRetired({ issuedAt: enrolledSecond }, { twoFactorEnrolledAt: enrolledAt })).toBe(
      false,
    );
    expect(
      isTokenRetired({ issuedAt: enrolledSecond + 1 }, { twoFactorEnrolledAt: enrolledAt }),
    ).toBe(false);
  });

  /**
   * `finalizeTwoFactorSetup` stamps the enrollment inside the promoting compare-and-swap, and the
   * session it hands back is minted after that write and a session sweep, so the survivor always
   * postdates the cutoff. A token dated to the millisecond therefore does not need the whole second
   * spared: keeping it would let a bearer minted just before the promotion outlive it, which is the
   * one thing enrollment retirement exists to stop.
   */
  it('retires a pre-enrollment bearer minted earlier in the enrolling second', () => {
    expect(
      isTokenRetired(
        { issuedAt: enrolledSecond, issuedAtMs: enrolledAt.getTime() - 1 },
        { twoFactorEnrolledAt: enrolledAt },
      ),
    ).toBe(true);
    expect(
      isTokenRetired(
        { issuedAt: enrolledSecond - 1, issuedAtMs: enrolledAt.getTime() - 1000 },
        { twoFactorEnrolledAt: enrolledAt },
      ),
    ).toBe(true);
  });

  it('keeps the session finalization mints, which postdates the enrollment stamp', () => {
    expect(
      isTokenRetired(
        { issuedAt: enrolledSecond, issuedAtMs: enrolledAt.getTime() },
        { twoFactorEnrolledAt: enrolledAt },
      ),
    ).toBe(false);
    expect(
      isTokenRetired(
        { issuedAt: enrolledSecond, issuedAtMs: enrolledAt.getTime() + 1 },
        { twoFactorEnrolledAt: enrolledAt },
      ),
    ).toBe(false);
  });

  it('accepts a stamp that arrives as a string or epoch value', () => {
    expect(
      isTokenRetired(
        { issuedAt: enrolledSecond - 1 },
        {
          twoFactorEnrolledAt: enrolledAt.toISOString(),
        },
      ),
    ).toBe(true);
    expect(
      isTokenRetired(
        { issuedAt: enrolledSecond - 1 },
        { twoFactorEnrolledAt: enrolledAt.getTime() },
      ),
    ).toBe(true);
  });

  it('refuses an undatable token once the account is enrolled', () => {
    expect(isTokenRetired({ issuedAt: undefined }, { twoFactorEnrolledAt: enrolledAt })).toBe(true);
    expect(isTokenRetired({ issuedAt: Number.NaN }, { twoFactorEnrolledAt: enrolledAt })).toBe(
      true,
    );
  });

  it('ignores an unparseable stamp rather than locking every session out', () => {
    expect(
      isTokenRetired({ issuedAt: enrolledSecond }, { twoFactorEnrolledAt: 'not-a-date' }),
    ).toBe(false);
  });

  describe('password recovery', () => {
    const resetAt = new Date('2026-02-02T00:00:10.500Z');
    const resetMs = resetAt.getTime();
    const resetSecond = Math.floor(resetMs / 1000);

    it('refuses a token minted for the credential the reset revoked', () => {
      expect(isTokenRetired({ issuedAt: resetSecond - 1 }, { credentialsChangedAt: resetAt })).toBe(
        true,
      );
    });

    it('keeps a token minted from the new credential', () => {
      expect(isTokenRetired({ issuedAt: resetSecond + 1 }, { credentialsChangedAt: resetAt })).toBe(
        false,
      );
    });

    it('retires a token minted earlier in the resetting second', () => {
      expect(
        isTokenRetired(
          { issuedAt: resetSecond, issuedAtMs: resetMs - 1 },
          { credentialsChangedAt: resetAt },
        ),
      ).toBe(true);
    });

    it('retires a token minted in the very millisecond of the reset', () => {
      expect(
        isTokenRetired(
          { issuedAt: resetSecond, issuedAtMs: resetMs },
          { credentialsChangedAt: resetAt },
        ),
      ).toBe(true);
    });

    /**
     * The session a sign-in lands in the resetting second buys is minted from the new credential,
     * so retiring it would 401 every request until the user signed in again.
     */
    it('keeps a token minted after the reset, even inside the same second', () => {
      expect(
        isTokenRetired(
          { issuedAt: resetSecond, issuedAtMs: resetMs + 1 },
          { credentialsChangedAt: resetAt },
        ),
      ).toBe(false);
    });

    /** Without the claim there is nothing to order within the second, so the whole second goes. */
    it('surrenders the resetting second for a token minted before the claim existed', () => {
      expect(isTokenRetired({ issuedAt: resetSecond }, { credentialsChangedAt: resetAt })).toBe(
        true,
      );
      expect(isTokenRetired({ issuedAt: undefined }, { credentialsChangedAt: resetAt })).toBe(true);
    });

    it('keeps the enrolling second while refusing the resetting one', () => {
      expect(
        isTokenRetired({ issuedAt: enrolledSecond }, { twoFactorEnrolledAt: enrolledAt }),
      ).toBe(false);
      expect(isTokenRetired({ issuedAt: resetSecond }, { credentialsChangedAt: resetAt })).toBe(
        true,
      );
    });

    it('leaves accounts that never reset untouched', () => {
      expect(isTokenRetired({ issuedAt: 0 }, { credentialsChangedAt: null })).toBe(false);
      expect(isTokenRetired({ issuedAt: 0 }, {})).toBe(false);
      expect(isTokenRetired({ issuedAt: 0 }, null)).toBe(false);
      expect(isTokenRetired({ issuedAt: resetSecond, issuedAtMs: resetMs }, {})).toBe(false);
      expect(isTokenRetired({ issuedAt: resetSecond, issuedAtMs: resetMs }, null)).toBe(false);
    });

    it('retires on whichever cutoff the token predates', () => {
      expect(
        isTokenRetired(
          { issuedAt: resetSecond - 1 },
          { twoFactorEnrolledAt: enrolledAt, credentialsChangedAt: resetAt },
        ),
      ).toBe(true);
      expect(
        isTokenRetired(
          { issuedAt: enrolledSecond - 1 },
          { twoFactorEnrolledAt: enrolledAt, credentialsChangedAt: resetAt },
        ),
      ).toBe(true);
      expect(
        isTokenRetired(
          { issuedAt: resetSecond + 1 },
          { twoFactorEnrolledAt: enrolledAt, credentialsChangedAt: resetAt },
        ),
      ).toBe(false);
    });

    it('refuses an undatable token once the account has reset', () => {
      expect(isTokenRetired({ issuedAt: undefined }, { credentialsChangedAt: resetAt })).toBe(true);
    });

    it('ignores an unparseable reset stamp rather than stranding the session', () => {
      expect(
        isTokenRetired(
          { issuedAt: resetSecond, issuedAtMs: resetMs },
          { credentialsChangedAt: 'not-a-date' },
        ),
      ).toBe(false);
    });
  });
});

describe('isEnrollmentSupersededByRecovery', () => {
  const enrolledAt = new Date('2026-01-01T00:00:10.500Z');

  it('reports nothing when either stamp is missing', () => {
    expect(isEnrollmentSupersededByRecovery(null, new Date())).toBe(false);
    expect(isEnrollmentSupersededByRecovery(enrolledAt, null)).toBe(false);
    expect(isEnrollmentSupersededByRecovery(undefined, undefined)).toBe(false);
  });

  it('reports a reset that landed after the enrollment was promoted', () => {
    expect(isEnrollmentSupersededByRecovery(enrolledAt, new Date(enrolledAt.getTime() + 1))).toBe(
      true,
    );
  });

  it('leaves an enrollment that followed an older reset alone', () => {
    expect(isEnrollmentSupersededByRecovery(enrolledAt, new Date(enrolledAt.getTime() - 1))).toBe(
      false,
    );
  });

  /** `iat` rounds to whole seconds, so a same-millisecond reset is the race, not a coincidence. */
  it('resolves a tie against the enrollment', () => {
    expect(isEnrollmentSupersededByRecovery(enrolledAt, new Date(enrolledAt.getTime()))).toBe(true);
  });

  it('accepts stamps that arrive as strings or epoch values', () => {
    expect(
      isEnrollmentSupersededByRecovery(enrolledAt.toISOString(), enrolledAt.getTime() + 1),
    ).toBe(true);
  });

  it('ignores an unparseable stamp rather than withdrawing every enrollment', () => {
    expect(isEnrollmentSupersededByRecovery('not-a-date', new Date())).toBe(false);
    expect(isEnrollmentSupersededByRecovery(enrolledAt, 'not-a-date')).toBe(false);
  });
});

describe('hasPasswordResetSince', () => {
  const seenAt = new Date('2026-01-01T00:00:10.500Z');

  it('reports a reset that landed after the authenticating read', () => {
    expect(hasPasswordResetSince(seenAt, new Date(seenAt.getTime() + 1))).toBe(true);
  });

  it('reports the first reset an account has ever had', () => {
    expect(hasPasswordResetSince(null, seenAt)).toBe(true);
    expect(hasPasswordResetSince(undefined, seenAt)).toBe(true);
  });

  it('leaves the stamp the authenticating read already saw alone', () => {
    expect(hasPasswordResetSince(seenAt, new Date(seenAt.getTime()))).toBe(false);
    expect(hasPasswordResetSince(seenAt, seenAt.toISOString())).toBe(false);
  });

  /** Nothing revoked the password, so an account that never reset one cannot be refused. */
  it('reports nothing when the record carries no reset at all', () => {
    expect(hasPasswordResetSince(null, null)).toBe(false);
    expect(hasPasswordResetSince(seenAt, undefined)).toBe(false);
  });

  it('accepts stamps that arrive as strings or epoch values', () => {
    expect(hasPasswordResetSince(seenAt.toISOString(), seenAt.getTime() + 1)).toBe(true);
    expect(hasPasswordResetSince(seenAt.getTime(), seenAt.toISOString())).toBe(false);
  });

  it('ignores an unparseable stamp rather than refusing every login', () => {
    expect(hasPasswordResetSince(seenAt, 'not-a-date')).toBe(false);
  });

  /** An unreadable prior stamp is no evidence of what the authenticating read saw. */
  it('treats an unparseable prior stamp as a reset it cannot rule out', () => {
    expect(hasPasswordResetSince('not-a-date', seenAt)).toBe(true);
  });
});

function createResponse(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as Partial<Response> as Response;
}

describe('two-factor setup tokens', () => {
  it('round-trips only a purpose-scoped login challenge token', () => {
    const loginToken = generateTwoFactorLoginChallengeToken('user-1', jwtSecret);
    const setupToken = generateTwoFactorSetupToken('user-1', jwtSecret);
    const acknowledgementToken = generateTwoFactorSetupAcknowledgementToken(
      'user-1',
      nonce,
      jwtSecret,
    );
    const finalizationToken = generateTwoFactorSetupFinalizationToken('user-1', nonce, jwtSecret);

    expect(verifyTwoFactorLoginChallengeToken(loginToken, jwtSecret)).toEqual({
      userId: 'user-1',
      issuedAt: expect.any(Number),
      issuedAtMs: expect.any(Number),
    });
    expect(verifyTwoFactorLoginChallengeToken(setupToken, jwtSecret)).toBeUndefined();
    expect(verifyTwoFactorLoginChallengeToken(acknowledgementToken, jwtSecret)).toBeUndefined();
    expect(verifyTwoFactorLoginChallengeToken(finalizationToken, jwtSecret)).toBeUndefined();
  });

  it('dates a login challenge to the millisecond so a same-second reset can retire it', () => {
    const before = Date.now();
    const credential = verifyTwoFactorLoginChallengeToken(
      generateTwoFactorLoginChallengeToken('user-1', jwtSecret),
      jwtSecret,
    );
    const after = Date.now();

    expect(credential?.issuedAtMs).toBeGreaterThanOrEqual(before);
    expect(credential?.issuedAtMs).toBeLessThanOrEqual(after);
    expect(
      isTokenRetired(credential as TokenIssuance, {
        credentialsChangedAt: new Date(credential?.issuedAtMs as number),
      }),
    ).toBe(true);
    expect(
      isTokenRetired(credential as TokenIssuance, {
        credentialsChangedAt: new Date((credential?.issuedAtMs as number) - 1),
      }),
    ).toBe(false);
  });

  it('reads a legacy login challenge that predates the millisecond claim', () => {
    const legacyToken = jwt.sign(
      { userId: 'user-1', purpose: TWO_FACTOR_TOKEN_PURPOSE.LOGIN_CHALLENGE },
      jwtSecret,
      { expiresIn: '5m' },
    );

    expect(verifyTwoFactorLoginChallengeToken(legacyToken, jwtSecret)).toEqual({
      userId: 'user-1',
      issuedAt: expect.any(Number),
      issuedAtMs: undefined,
    });
  });

  it('round-trips a purpose-scoped setup token', () => {
    const token = generateTwoFactorSetupToken('user-2', jwtSecret);

    expect(verifyTwoFactorSetupToken(token, jwtSecret)).toEqual({
      userId: 'user-2',
      issuedAt: expect.any(Number),
      issuedAtMs: expect.any(Number),
    });
  });

  it('dates a setup token to the millisecond so a same-second reset can retire it', () => {
    const before = Date.now();
    const credential = verifyTwoFactorSetupToken(
      generateTwoFactorSetupToken('user-2', jwtSecret),
      jwtSecret,
    );
    const after = Date.now();

    expect(credential?.issuedAtMs).toBeGreaterThanOrEqual(before);
    expect(credential?.issuedAtMs).toBeLessThanOrEqual(after);
  });

  it('reads a legacy setup token that predates the millisecond claim', () => {
    const legacyToken = jwt.sign(
      { userId: 'user-2', purpose: TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_SETUP },
      jwtSecret,
      { expiresIn: '10m' },
    );

    expect(verifyTwoFactorSetupToken(legacyToken, jwtSecret)).toEqual({
      userId: 'user-2',
      issuedAt: expect.any(Number),
      issuedAtMs: undefined,
    });
  });

  it('rejects a normal 2FA challenge token for setup', () => {
    const token = jwt.sign(
      { userId: 'user-1', purpose: TWO_FACTOR_TOKEN_PURPOSE.LOGIN_CHALLENGE },
      jwtSecret,
      { expiresIn: '5m' },
    );

    expect(verifyTwoFactorSetupToken(token, jwtSecret)).toBeUndefined();
    expect(verifyTwoFactorSetupFinalizationToken(token, jwtSecret)).toBeUndefined();
  });

  it('rejects legacy purpose-less tokens', () => {
    const token = jwt.sign({ userId: 'user-1', twoFASetupRequired: true }, jwtSecret, {
      expiresIn: '5m',
    });

    expect(verifyTwoFactorSetupToken(token, jwtSecret)).toBeUndefined();
    expect(verifyTwoFactorSetupFinalizationToken(token, jwtSecret)).toBeUndefined();
  });

  it('rejects expired setup tokens', () => {
    const token = jwt.sign(
      { userId: 'user-1', purpose: TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_SETUP },
      jwtSecret,
      { expiresIn: -1 },
    );

    expect(verifyTwoFactorSetupToken(token, jwtSecret)).toBeUndefined();
  });

  it('round-trips only purpose-scoped finalization credentials', () => {
    const token = generateTwoFactorSetupFinalizationToken('user-1', nonce, jwtSecret);
    const setupToken = generateTwoFactorSetupToken('user-1', jwtSecret);

    expect(verifyTwoFactorSetupFinalizationToken(token, jwtSecret)).toEqual({
      userId: 'user-1',
      nonce,
    });
    expect(verifyTwoFactorSetupFinalizationToken(setupToken, jwtSecret)).toBeUndefined();
    expect(verifyTwoFactorSetupToken(token, jwtSecret)).toBeUndefined();
  });

  it('round-trips only purpose-scoped acknowledgement credentials', () => {
    const token = generateTwoFactorSetupAcknowledgementToken('user-1', nonce, jwtSecret);
    const setupToken = generateTwoFactorSetupToken('user-1', jwtSecret);
    const finalizationToken = generateTwoFactorSetupFinalizationToken('user-1', nonce, jwtSecret);

    expect(verifyTwoFactorSetupAcknowledgementToken(token, jwtSecret)).toEqual({
      userId: 'user-1',
      nonce,
    });
    expect(verifyTwoFactorSetupAcknowledgementToken(setupToken, jwtSecret)).toBeUndefined();
    expect(verifyTwoFactorSetupAcknowledgementToken(finalizationToken, jwtSecret)).toBeUndefined();
  });

  it.each([
    ['acknowledgement', generateTwoFactorSetupAcknowledgementToken],
    ['finalization', generateTwoFactorSetupFinalizationToken],
  ])('rejects a nonce-less %s credential', (_label, generate) => {
    const purpose =
      generate === generateTwoFactorSetupAcknowledgementToken
        ? TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_ACKNOWLEDGEMENT
        : TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_FINALIZATION;
    const token = jwt.sign({ userId: 'user-1', purpose }, jwtSecret, { expiresIn: '5m' });

    expect(verifyTwoFactorSetupAcknowledgementToken(token, jwtSecret)).toBeUndefined();
    expect(verifyTwoFactorSetupFinalizationToken(token, jwtSecret)).toBeUndefined();
  });
});

describe('requireTwoFactorSetupAcknowledgementToken', () => {
  beforeEach(() => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    process.env.JWT_SECRET = jwtSecret;
  });

  it('attaches the acknowledgement identity and its one-time nonce', () => {
    const req = {
      body: {
        acknowledgementToken: generateTwoFactorSetupAcknowledgementToken(
          'user-5',
          nonce,
          jwtSecret,
        ),
      },
    } as Request;
    const res = createResponse();
    const next = jest.fn();

    requireTwoFactorSetupAcknowledgementToken(req, res, next);

    expect(req.user).toEqual({ id: 'user-5' });
    expect((req as TwoFactorEnrollmentRequest).twoFactorEnrollmentNonce).toBe(nonce);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    generateTwoFactorSetupToken('user-5', jwtSecret),
    generateTwoFactorSetupFinalizationToken('user-5', nonce, jwtSecret),
    generateTwoFactorLoginChallengeToken('user-5', jwtSecret),
  ])('rejects a wrong-purpose token', (acknowledgementToken) => {
    const req = { body: { acknowledgementToken } } as Request;
    const res = createResponse();
    const next = jest.fn();

    requireTwoFactorSetupAcknowledgementToken(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireTwoFactorSetupFinalizationToken', () => {
  const originalPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    process.env.JWT_SECRET = jwtSecret;
  });

  afterAll(() => {
    if (originalPolicy === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalPolicy;
    }
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  it('attaches the finalization identity and its one-time nonce', () => {
    const req = {
      body: {
        finalizationToken: generateTwoFactorSetupFinalizationToken('user-4', nonce, jwtSecret),
      },
    } as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    requireTwoFactorSetupFinalizationToken(req, res, next);

    expect(req.user).toEqual({ id: 'user-4' });
    expect((req as TwoFactorEnrollmentRequest).twoFactorEnrollmentNonce).toBe(nonce);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid and wrong-purpose tokens', () => {
    const tokens = [
      'invalid',
      generateTwoFactorSetupToken('user-4', jwtSecret),
      generateTwoFactorSetupAcknowledgementToken('user-4', nonce, jwtSecret),
      generateTwoFactorLoginChallengeToken('user-4', jwtSecret),
      jwt.sign({ userId: 'user-4' }, jwtSecret),
    ];

    for (const finalizationToken of tokens) {
      const req = { body: { finalizationToken } } as Request;
      const res = createResponse();
      const next = jest.fn() as jest.MockedFunction<NextFunction>;

      requireTwoFactorSetupFinalizationToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });

  it('rejects finalization when global enforcement is disabled', () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    const req = {
      body: {
        finalizationToken: generateTwoFactorSetupFinalizationToken('user-4', nonce, jwtSecret),
      },
    } as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    requireTwoFactorSetupFinalizationToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireTwoFactorSetupToken', () => {
  const originalPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
  const originalSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    process.env.JWT_SECRET = jwtSecret;
  });

  afterAll(() => {
    if (originalPolicy === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalPolicy;
    }
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  });

  it('attaches the setup user and continues for a valid token', () => {
    const req = {
      body: { tempToken: generateTwoFactorSetupToken('user-2', jwtSecret) },
    } as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    requireTwoFactorSetupToken(req, res, next);

    expect(req.user).toEqual({ id: 'user-2' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('stamps the mint time, so a later account event can retire the token', () => {
    const req = {
      body: { tempToken: generateTwoFactorSetupToken('user-2', jwtSecret) },
    } as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    requireTwoFactorSetupToken(req, res, next);

    const setupRequest = req as TwoFactorEnrollmentRequest;
    const issuedAt = setupRequest.twoFactorSetupIssuedAt;
    const issuedAtMs = setupRequest.twoFactorSetupIssuedAtMs;
    expect(typeof issuedAt).toBe('number');
    expect(typeof issuedAtMs).toBe('number');
    expect(
      isTokenRetired({ issuedAt }, { credentialsChangedAt: new Date((issuedAt as number) * 1000) }),
    ).toBe(true);
    expect(
      isTokenRetired(
        { issuedAt },
        { credentialsChangedAt: new Date(((issuedAt as number) + 1) * 1000) },
      ),
    ).toBe(true);

    /** The millisecond claim is what still spares a setup token minted after the reset landed. */
    expect(
      isTokenRetired(
        { issuedAt, issuedAtMs },
        { credentialsChangedAt: new Date((issuedAtMs as number) - 1) },
      ),
    ).toBe(false);
  });

  it('rejects setup when the deployment policy is disabled', () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    const req = {
      body: { tempToken: generateTwoFactorSetupToken('user-2', jwtSecret) },
    } as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    requireTwoFactorSetupToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects missing or invalid setup tokens', () => {
    const req = { body: { tempToken: 'invalid' } } as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    requireTwoFactorSetupToken(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects login challenge, acknowledgement, and finalization tokens', () => {
    const tokens = [
      jwt.sign({ userId: 'user-2', purpose: TWO_FACTOR_TOKEN_PURPOSE.LOGIN_CHALLENGE }, jwtSecret),
      generateTwoFactorSetupAcknowledgementToken('user-2', nonce, jwtSecret),
      generateTwoFactorSetupFinalizationToken('user-2', nonce, jwtSecret),
    ];

    for (const tempToken of tokens) {
      const req = { body: { tempToken } } as Request;
      const res = createResponse();
      const next = jest.fn() as jest.MockedFunction<NextFunction>;

      requireTwoFactorSetupToken(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });
});

describe('createBlockRetiredSetupToken', () => {
  const resetAt = new Date('2026-02-02T00:00:10.500Z');
  const resetSecond = Math.floor(resetAt.getTime() / 1000);
  const getUserById = jest.fn();
  const blockRetiredSetupToken = createBlockRetiredSetupToken({ getUserById });

  const run = async (req: Partial<TwoFactorEnrollmentRequest>) => {
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;
    await blockRetiredSetupToken(req as Request, res, next);
    return { res, next };
  };

  beforeEach(() => {
    getUserById.mockReset();
    getUserById.mockResolvedValue({ _id: 'user-1' });
  });

  it('continues when nothing has retired the setup token', async () => {
    const { res, next } = await run({
      user: { id: 'user-1' },
      twoFactorSetupIssuedAt: resetSecond,
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('refuses a setup token minted before the password reset', async () => {
    getUserById.mockResolvedValue({ _id: 'user-1', credentialsChangedAt: resetAt });

    const { res, next } = await run({
      user: { id: 'user-1' },
      twoFactorSetupIssuedAt: resetSecond - 1,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('admits a setup token minted after the password reset', async () => {
    getUserById.mockResolvedValue({ _id: 'user-1', credentialsChangedAt: resetAt });

    const { res, next } = await run({
      user: { id: 'user-1' },
      twoFactorSetupIssuedAt: resetSecond + 1,
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('refuses a setup token minted earlier in the second the password reset landed', async () => {
    getUserById.mockResolvedValue({ _id: 'user-1', credentialsChangedAt: resetAt });

    const { res, next } = await run({
      user: { id: 'user-1' },
      twoFactorSetupIssuedAt: resetSecond,
      twoFactorSetupIssuedAtMs: resetAt.getTime() - 1,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('admits a setup token minted later in the second the password reset landed', async () => {
    getUserById.mockResolvedValue({ _id: 'user-1', credentialsChangedAt: resetAt });

    const { res, next } = await run({
      user: { id: 'user-1' },
      twoFactorSetupIssuedAt: resetSecond,
      twoFactorSetupIssuedAtMs: resetAt.getTime() + 1,
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('refuses a setup token minted before enrollment promoted the account', async () => {
    getUserById.mockResolvedValue({ _id: 'user-1', twoFactorEnrolledAt: resetAt });

    const { res, next } = await run({
      user: { id: 'user-1' },
      twoFactorSetupIssuedAt: resetSecond - 1,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('refuses an undatable setup token once a cutoff is set', async () => {
    getUserById.mockResolvedValue({ _id: 'user-1', credentialsChangedAt: resetAt });

    const { res, next } = await run({ user: { id: 'user-1' } });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('reads only the fields the cutoff needs', async () => {
    await run({ user: { id: 'user-1' }, twoFactorSetupIssuedAt: resetSecond });

    expect(getUserById).toHaveBeenCalledWith('user-1', 'twoFactorEnrolledAt credentialsChangedAt');
  });

  it('refuses when the named account no longer exists', async () => {
    getUserById.mockResolvedValue(null);

    const { res, next } = await run({
      user: { id: 'user-1' },
      twoFactorSetupIssuedAt: resetSecond,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('refuses when no setup user was stamped on the request', async () => {
    const { res, next } = await run({});

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('fails closed when the lookup throws', async () => {
    getUserById.mockRejectedValue(new Error('mongo is down'));

    const { res, next } = await run({
      user: { id: 'user-1' },
      twoFactorSetupIssuedAt: resetSecond,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

type BackupCode = NonNullable<IUser['backupCodes']>[number];

interface EnrollmentDocument {
  _id: string;
  provider?: string;
  twoFactorEnabled: boolean;
  twoFactorEnrolledAt?: Date;
  totpSecret?: string | null;
  backupCodes?: BackupCode[];
  pendingTotpSecret?: string | null;
  pendingBackupCodes?: BackupCode[];
  twoFactorAcknowledgementNonceHash?: string | null;
  twoFactorFinalizationNonceHash?: string | null;
}

const ELIGIBLE_PROVIDERS = new Set(['local', 'ldap']);

/**
 * A faithful in-memory stand-in for the guarded `updateTwoFactorEnrollment` write: it reproduces
 * the invariant filter (unenrolled, policy-eligible provider) plus exact-value predicates, so
 * replay and race behaviour is exercised for real rather than stubbed.
 */
function createEnrollmentStore(overrides: Partial<EnrollmentDocument> = {}) {
  let doc: EnrollmentDocument = {
    _id: 'user-3',
    provider: 'local',
    twoFactorEnabled: false,
    pendingTotpSecret: 'encrypted-secret',
    pendingBackupCodes: [{ codeHash: 'staged-hash', used: false }],
    twoFactorAcknowledgementNonceHash: null,
    twoFactorFinalizationNonceHash: null,
    ...overrides,
  };
  const writes: TwoFactorEnrollmentUpdate[] = [];

  const matchesGuard = (guard: TwoFactorEnrollmentGuard): boolean => {
    if (doc.twoFactorEnabled) {
      return false;
    }
    if (doc.provider != null && !ELIGIBLE_PROVIDERS.has(doc.provider)) {
      return false;
    }
    return Object.entries(guard).every(
      ([key, value]) =>
        JSON.stringify(doc[key as keyof EnrollmentDocument] ?? null) ===
        JSON.stringify(value ?? null),
    );
  };

  const deps: TwoFactorEnrollmentDependencies = {
    getUserById: jest.fn(async () => ({ ...doc }) as unknown as IUser),
    getTOTPSecret: jest.fn().mockResolvedValue('plain-secret'),
    verifyTOTP: jest.fn().mockResolvedValue(true),
    generateBackupCodes: jest.fn(async () => ({
      plainCodes: [`code-${writes.length + 1}`],
      codeObjects: [{ codeHash: `hash-${writes.length + 1}`, used: false, usedAt: null }],
    })),
    updateTwoFactorEnrollment: jest.fn(async (_userId, guard, update) => {
      if (!matchesGuard(guard)) {
        return null;
      }
      writes.push(update);
      doc = { ...doc, ...update };
      return { ...doc } as unknown as IUser;
    }),
  };

  return {
    deps,
    writes,
    read: () => ({ ...doc }),
    mutate: (patch: Partial<EnrollmentDocument>) => {
      doc = { ...doc, ...patch };
    },
  };
}

describe('required two-factor enrollment lifecycle', () => {
  const originalPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;

  beforeEach(() => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
  });

  afterAll(() => {
    if (originalPolicy === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalPolicy;
    }
  });

  it('stages deliverable codes and an acknowledgement nonce without enabling 2FA', async () => {
    const store = createEnrollmentStore();

    const result = await confirmTwoFactorSetup('user-3', '123456', store.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.plainCodes).toEqual(['code-1']);
    expect(store.read()).toMatchObject({
      twoFactorEnabled: false,
      pendingTotpSecret: 'encrypted-secret',
      pendingBackupCodes: [{ codeHash: 'hash-1', used: false, usedAt: null }],
      twoFactorAcknowledgementNonceHash: sha256(result.acknowledgementNonce),
      twoFactorFinalizationNonceHash: null,
    });
    expect(store.read().totpSecret).toBeFalsy();
    expect(isTwoFactorEnrollmentRequired(result.user)).toBe(true);
    expect(store.deps.updateTwoFactorEnrollment).toHaveBeenCalledTimes(1);
    expect(store.deps.updateTwoFactorEnrollment).toHaveBeenCalledWith(
      'user-3',
      {
        pendingTotpSecret: 'encrypted-secret',
        pendingBackupCodes: [{ codeHash: 'staged-hash', used: false }],
      },
      expect.objectContaining({ twoFactorFinalizationNonceHash: null }),
    );
  });

  it('stays retryable after a lost confirmation response, rotating codes and nonces', async () => {
    const store = createEnrollmentStore();

    const first = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    const second = await confirmTwoFactorSetup('user-3', '123456', store.deps);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(second.plainCodes).not.toEqual(first.plainCodes);
    expect(second.acknowledgementNonce).not.toBe(first.acknowledgementNonce);
    expect(store.read()).toMatchObject({
      twoFactorEnabled: false,
      twoFactorAcknowledgementNonceHash: sha256(second.acknowledgementNonce),
    });

    const stale = await acknowledgeTwoFactorSetup('user-3', first.acknowledgementNonce, store.deps);

    expect(stale).toEqual({
      ok: false,
      status: 400,
      message: 'This two-factor setup step expired. Confirm your code again.',
    });
  });

  it('rejects users who already have 2FA enabled', async () => {
    const store = createEnrollmentStore({ twoFactorEnabled: true });

    const result = await confirmTwoFactorSetup('user-3', '123456', store.deps);

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: '2FA setup is not available for this user',
    });
    expect(store.deps.generateBackupCodes).not.toHaveBeenCalled();
    expect(store.deps.updateTwoFactorEnrollment).not.toHaveBeenCalled();
  });

  it('rejects a federated provider before generating anything', async () => {
    const store = createEnrollmentStore({ provider: 'openid' });

    const result = await confirmTwoFactorSetup('user-3', '123456', store.deps);

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: '2FA setup is not available for this user',
    });
    expect(store.deps.generateBackupCodes).not.toHaveBeenCalled();
  });

  it('rejects an invalid TOTP without mutating the user', async () => {
    const store = createEnrollmentStore();
    (store.deps.verifyTOTP as jest.Mock).mockResolvedValue(false);

    const result = await confirmTwoFactorSetup('user-3', '000000', store.deps);

    expect(result).toEqual({ ok: false, status: 400, message: 'Invalid token' });
    expect(store.deps.generateBackupCodes).not.toHaveBeenCalled();
    expect(store.deps.updateTwoFactorEnrollment).not.toHaveBeenCalled();
  });

  it('rejects confirmation when the deployment policy flips off before the write', async () => {
    const store = createEnrollmentStore();
    (store.deps.verifyTOTP as jest.Mock).mockImplementation(async () => {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
      return true;
    });

    const result = await confirmTwoFactorSetup('user-3', '123456', store.deps);

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: '2FA setup is not available for this user',
    });
    expect(store.deps.generateBackupCodes).toHaveBeenCalledTimes(1);
    expect(store.deps.updateTwoFactorEnrollment).not.toHaveBeenCalled();
  });

  it('fails closed when a concurrent setup regeneration moves the pending snapshot', async () => {
    const store = createEnrollmentStore();
    (store.deps.verifyTOTP as jest.Mock).mockImplementation(async () => {
      store.mutate({ pendingBackupCodes: [{ codeHash: 'regenerated', used: false }] });
      return true;
    });

    const result = await confirmTwoFactorSetup('user-3', '123456', store.deps);

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: '2FA setup is not available for this user',
    });
    expect(store.read().twoFactorAcknowledgementNonceHash).toBeNull();
  });

  it('exchanges the acknowledgement nonce for a finalization nonce without enabling 2FA', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }

    const result = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(store.read()).toMatchObject({
      twoFactorEnabled: false,
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: sha256(result.finalizationNonce),
    });
    expect(store.read().totpSecret).toBeFalsy();
    expect(isTwoFactorEnrollmentRequired(result.user)).toBe(true);
  });

  it('rejects a replayed acknowledgement credential without issuing anything', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    const first = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );
    if (!first.ok) {
      throw new Error('acknowledgement should succeed');
    }

    const replay = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );

    expect(replay.ok).toBe(false);
    expect(store.read().twoFactorFinalizationNonceHash).toBe(sha256(first.finalizationNonce));
  });

  it('rejects acknowledgement when the deployment policy is disabled', async () => {
    const store = createEnrollmentStore({ twoFactorAcknowledgementNonceHash: sha256('nonce-a') });
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';

    const result = await acknowledgeTwoFactorSetup('user-3', 'nonce-a', store.deps);

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: '2FA setup is not available for this user',
    });
    expect(store.deps.updateTwoFactorEnrollment).not.toHaveBeenCalled();
  });

  it('promotes only at finalization and clears every enrollment field', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    const acknowledged = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );
    if (!acknowledged.ok) {
      throw new Error('acknowledgement should succeed');
    }

    const result = await finalizeTwoFactorSetup(
      'user-3',
      acknowledged.finalizationNonce,
      store.deps,
    );

    expect(result.ok).toBe(true);
    expect(store.read()).toMatchObject({
      twoFactorEnabled: true,
      totpSecret: 'encrypted-secret',
      backupCodes: [{ codeHash: 'hash-1', used: false, usedAt: null }],
      pendingTotpSecret: null,
      pendingBackupCodes: [],
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: null,
    });
    expect(result.ok && isTwoFactorEnrollmentRequired(result.user)).toBe(false);
  });

  it('stamps the cutoff that retires pre-enrollment access tokens', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    const acknowledged = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );
    if (!acknowledged.ok) {
      throw new Error('acknowledgement should succeed');
    }
    const beforeFinalize = Date.now();

    const result = await finalizeTwoFactorSetup(
      'user-3',
      acknowledged.finalizationNonce,
      store.deps,
    );

    expect(result.ok).toBe(true);
    const enrolledAt = store.read().twoFactorEnrolledAt;
    expect(enrolledAt).toBeInstanceOf(Date);
    expect((enrolledAt as Date).getTime()).toBeGreaterThanOrEqual(beforeFinalize);
    /** The token minted a moment earlier is now stale, the one finalization returns is not. */
    expect(
      isTokenRetired(
        { issuedAt: Math.floor(beforeFinalize / 1000) - 1 },
        { twoFactorEnrolledAt: enrolledAt as Date },
      ),
    ).toBe(true);
    expect(
      isTokenRetired(
        { issuedAt: Math.ceil(Date.now() / 1000) },
        { twoFactorEnrolledAt: enrolledAt as Date },
      ),
    ).toBe(false);
  });

  it('leaves the cutoff unset on the steps that do not promote', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    expect(store.read().twoFactorEnrolledAt).toBeUndefined();

    await acknowledgeTwoFactorSetup('user-3', confirmed.acknowledgementNonce, store.deps);

    expect(store.read().twoFactorEnrolledAt).toBeUndefined();
  });

  it('rejects a replayed finalization credential without a second promotion', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    const acknowledged = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );
    if (!acknowledged.ok) {
      throw new Error('acknowledgement should succeed');
    }
    await finalizeTwoFactorSetup('user-3', acknowledged.finalizationNonce, store.deps);
    const writesAfterFirst = store.writes.length;

    const replay = await finalizeTwoFactorSetup(
      'user-3',
      acknowledged.finalizationNonce,
      store.deps,
    );

    expect(replay).toEqual({
      ok: false,
      status: 400,
      message: '2FA setup is not available for this user',
    });
    expect(store.writes).toHaveLength(writesAfterFirst);
  });

  it('rejects finalization carrying a stale nonce after a re-confirmation', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    const acknowledged = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );
    if (!acknowledged.ok) {
      throw new Error('acknowledgement should succeed');
    }
    await confirmTwoFactorSetup('user-3', '123456', store.deps);

    const result = await finalizeTwoFactorSetup(
      'user-3',
      acknowledged.finalizationNonce,
      store.deps,
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: 'This two-factor setup step expired. Confirm your code again.',
    });
    expect(store.read().twoFactorEnabled).toBe(false);
  });

  it('rejects finalization without a nonce before reading the user', async () => {
    const store = createEnrollmentStore();

    const result = await finalizeTwoFactorSetup('user-3', undefined, store.deps);

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: 'This two-factor setup step expired. Confirm your code again.',
    });
    expect(store.deps.getUserById).not.toHaveBeenCalled();
  });

  it.each([
    ['a federated provider transition', { provider: 'openid' }],
    ['an already-enabled transition', { twoFactorEnabled: true }],
  ])('rejects finalization after %s', async (_label, transition) => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    const acknowledged = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );
    if (!acknowledged.ok) {
      throw new Error('acknowledgement should succeed');
    }
    store.mutate(transition);

    const result = await finalizeTwoFactorSetup(
      'user-3',
      acknowledged.finalizationNonce,
      store.deps,
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: '2FA setup is not available for this user',
    });
    expect(store.read().totpSecret).toBeFalsy();
  });

  it('rejects finalization when the deployment policy is disabled', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    const acknowledged = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );
    if (!acknowledged.ok) {
      throw new Error('acknowledgement should succeed');
    }
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';

    const result = await finalizeTwoFactorSetup(
      'user-3',
      acknowledged.finalizationNonce,
      store.deps,
    );

    expect(result).toEqual({
      ok: false,
      status: 400,
      message: '2FA setup is not available for this user',
    });
    expect(store.read().twoFactorEnabled).toBe(false);
  });

  it('rejects finalization once the pending setup has been cleared', async () => {
    const store = createEnrollmentStore();
    const confirmed = await confirmTwoFactorSetup('user-3', '123456', store.deps);
    if (!confirmed.ok) {
      throw new Error('confirmation should succeed');
    }
    const acknowledged = await acknowledgeTwoFactorSetup(
      'user-3',
      confirmed.acknowledgementNonce,
      store.deps,
    );
    if (!acknowledged.ok) {
      throw new Error('acknowledgement should succeed');
    }
    store.mutate({ pendingTotpSecret: null, pendingBackupCodes: [] });

    const result = await finalizeTwoFactorSetup(
      'user-3',
      acknowledged.finalizationNonce,
      store.deps,
    );

    expect(result).toEqual({ ok: false, status: 400, message: '2FA setup not initiated' });
  });
});

describe('blockTwoFactorDisableWhenRequired', () => {
  const originalPolicy = process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;

  afterAll(() => {
    if (originalPolicy === undefined) {
      delete process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION;
    } else {
      process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = originalPolicy;
    }
  });

  it('blocks disabling 2FA when it is required', () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const req = {} as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    blockTwoFactorDisableWhenRequired(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows disabling 2FA when it is optional', () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'false';
    const req = {} as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    blockTwoFactorDisableWhenRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows federated users to manage provider-exempt 2FA', () => {
    process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION = 'true';
    const req = { user: { provider: 'openid' } } as Partial<Request> as Request;
    const res = createResponse();
    const next = jest.fn() as jest.MockedFunction<NextFunction>;

    blockTwoFactorDisableWhenRequired(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('withdrawMintedSession', () => {
  /** A 500 that still carried the minted cookies could refresh once the database recovers. */
  it('clears the minted cookies even when the session deletion fails', async () => {
    const clearCookie = jest.fn();
    const res = { clearCookie } as unknown as Response;
    const clearCloudFrontCookies = jest.fn();
    const deletion = new Error('database unavailable');

    await expect(
      withdrawMintedSession(res, { tenantId: 'tenant-a' }, 'user-1', {
        deleteAllUserSessions: jest.fn().mockRejectedValue(deletion),
        clearCloudFrontCookies,
      }),
    ).rejects.toBe(deletion);

    expect(clearCookie).toHaveBeenCalledWith('refreshToken');
    expect(clearCookie).toHaveBeenCalledWith('token_provider');
    expect(clearCloudFrontCookies).toHaveBeenCalledWith(res, {
      userId: 'user-1',
      tenantId: 'tenant-a',
      storageRegion: undefined,
    });
  });
});
