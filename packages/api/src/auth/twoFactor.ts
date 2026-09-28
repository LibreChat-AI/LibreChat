import jwt from 'jsonwebtoken';
import { logger } from '@librechat/data-schemas';
import { createHash, randomBytes } from 'node:crypto';
import { isTwoFactorPolicyProvider } from 'librechat-data-provider';
import type {
  IUser,
  TwoFactorEnrollmentGuard,
  TwoFactorEnrollmentUpdate,
} from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import { isEnabled } from '~/utils';

const TWO_FACTOR_SETUP_TOKEN_EXPIRY = '10m';
const TWO_FACTOR_SETUP_ACKNOWLEDGEMENT_TOKEN_EXPIRY = '5m';
const TWO_FACTOR_SETUP_FINALIZATION_TOKEN_EXPIRY = '5m';
const TWO_FACTOR_LOGIN_CHALLENGE_TOKEN_EXPIRY = '5m';
const TWO_FACTOR_SETUP_UNAVAILABLE = '2FA setup is not available for this user';
const TWO_FACTOR_SETUP_NOT_INITIATED = '2FA setup not initiated';
const TWO_FACTOR_SETUP_STALE = 'This two-factor setup step expired. Confirm your code again.';
const TWO_FACTOR_INVALID_TOKEN = 'Invalid token';
const TWO_FACTOR_ENROLLMENT_PROJECTION =
  '+pendingTotpSecret +pendingBackupCodes _id twoFactorEnabled provider';

export const TWO_FACTOR_TOKEN_PURPOSE = {
  LOGIN_CHALLENGE: 'login_2fa_challenge',
  REQUIRED_SETUP: 'required_2fa_setup',
  REQUIRED_ACKNOWLEDGEMENT: 'required_2fa_acknowledgement',
  REQUIRED_FINALIZATION: 'required_2fa_finalization',
} as const;

interface TwoFactorSetupBody {
  tempToken?: string;
  acknowledgementToken?: string;
  finalizationToken?: string;
}

/**
 * The account events that retire every bearer token minted before them.
 *
 * Widened past `IUser`'s `Date`, because callers pass lean documents whose stamps can arrive
 * already serialized, and a cutoff that fails to parse must not lock every session out.
 */
export interface TokenRetirementSignals {
  twoFactorEnrolledAt?: Date | string | number | null;
  credentialsChangedAt?: Date | string | number | null;
}

/** The user fields `isTokenRetired` needs, for callers that read with an explicit projection. */
export const TOKEN_RETIREMENT_FIELDS = 'twoFactorEnrolledAt credentialsChangedAt';

/** Identity plus the one-time nonce a required-enrollment credential carries. */
export interface TwoFactorEnrollmentCredential {
  userId: string;
  nonce: string;
}

/**
 * When a bearer token was minted, coarsely and exactly.
 *
 * `iat` is whole seconds, which cannot order a token against a cutoff that lands in the same
 * second. `issuedAtMs` is stamped at mint time to settle exactly that, and is absent on tokens
 * minted before the claim existed and on any this deployment did not sign.
 */
export interface TokenIssuance {
  issuedAt?: number;
  issuedAtMs?: number;
}

/** Identity plus the mint time that lets a later account event retire the credential. */
export interface TwoFactorTokenCredential extends TokenIssuance {
  userId: string;
}

/** An Express request that a required-enrollment credential has been validated for. */
export type TwoFactorEnrollmentRequest = Request & {
  user?: { id: string };
  twoFactorEnrollmentNonce?: string;
  twoFactorSetupIssuedAt?: number;
  twoFactorSetupIssuedAtMs?: number;
};

export type TwoFactorSetupUser = Pick<
  IUser,
  '_id' | 'provider' | 'twoFactorEnabled' | 'pendingTotpSecret' | 'pendingBackupCodes'
>;

export interface TwoFactorEnrollmentDependencies {
  getUserById: (userId: string, projection: string) => Promise<TwoFactorSetupUser | null>;
  getTOTPSecret: (storedSecret: string) => Promise<string | null>;
  verifyTOTP: (secret: string, token: string) => Promise<boolean>;
  generateBackupCodes: () => Promise<{
    plainCodes: string[];
    codeObjects: NonNullable<IUser['backupCodes']>;
  }>;
  updateTwoFactorEnrollment: (
    userId: string,
    guard: TwoFactorEnrollmentGuard,
    update: TwoFactorEnrollmentUpdate,
  ) => Promise<IUser | null>;
}

type TwoFactorEnrollmentFailure = { ok: false; status: 400; message: string };

export type TwoFactorConfirmResult =
  | { ok: true; user: IUser; plainCodes: string[]; acknowledgementNonce: string }
  | TwoFactorEnrollmentFailure;

export type TwoFactorAcknowledgeResult =
  | { ok: true; user: IUser; finalizationNonce: string }
  | TwoFactorEnrollmentFailure;

export type TwoFactorFinalizeResult = { ok: true; user: IUser } | TwoFactorEnrollmentFailure;

const fail = (message: string): TwoFactorEnrollmentFailure => ({ ok: false, status: 400, message });

/** 256 bits of entropy, so the stored SHA-256 digest is not brute-forceable. */
const createEnrollmentNonce = (): string => randomBytes(32).toString('hex');

const hashEnrollmentNonce = (nonce: string): string =>
  createHash('sha256').update(nonce).digest('hex');

export function isTwoFactorEnrollmentRequired(
  user: (Pick<IUser, 'twoFactorEnabled'> & Partial<Pick<IUser, 'provider'>>) | null | undefined,
): boolean {
  if (!isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION) || user?.twoFactorEnabled) {
    return false;
  }

  return isTwoFactorPolicyProvider(user?.provider);
}

export function isTwoFactorSetupEligible(
  user: Partial<Pick<IUser, 'provider'>> | null | undefined,
): boolean {
  return isTwoFactorPolicyProvider(user?.provider);
}

/**
 * Whether a login that presented LibreChat-owned credentials must be refused outright.
 *
 * Only the local and LDAP strategies reach this point, so the credential was ours to check. A
 * record left on a federated provider can still carry a password, because a reset assigns one
 * without consulting `provider`, and the local strategy authenticates on the password alone. Such
 * a login satisfies neither the identity provider's MFA nor this policy, and enrollment cannot
 * remedy it because the account's credentials are not ours to promote. Under enforcement the
 * federated sign-in path is the only way in.
 */
export function isCredentialLoginBlockedByTwoFactorPolicy(
  user: Partial<Pick<IUser, 'provider'>> | null | undefined,
): boolean {
  return (
    isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION) &&
    !isTwoFactorPolicyProvider(user?.provider)
  );
}

function isTokenIssuedBefore(
  issuance: TokenIssuance,
  cutoff: Date | string | number | null | undefined,
  retireTies: boolean,
): boolean {
  if (cutoff == null) {
    return false;
  }

  const cutoffMs = new Date(cutoff).getTime();
  if (Number.isNaN(cutoffMs)) {
    return false;
  }

  const { issuedAtMs } = issuance;
  if (typeof issuedAtMs === 'number' && Number.isFinite(issuedAtMs)) {
    return retireTies ? issuedAtMs <= cutoffMs : issuedAtMs < cutoffMs;
  }

  const { issuedAt } = issuance;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    return true;
  }

  const cutoffSeconds = Math.floor(cutoffMs / 1000);
  return retireTies ? issuedAt <= cutoffSeconds : issuedAt < cutoffSeconds;
}

/**
 * Whether a bearer token was minted before an account event that retires it.
 *
 * Bearer tokens carry no server-side state, so nothing stops honouring one the moment the account
 * changes underneath it. Two events have to. Enrollment, because a token issued while the account
 * still had no second factor was only ever accepted for that reason, so promotion has to retire it
 * rather than reinstate it. And password recovery, because the credential the token was minted for
 * has been revoked; `deleteAllUserSessions` already drops the refresh sessions on that path with
 * the same intent, and a stateless token must not outlive the password that bought it.
 *
 * Both cutoffs are compared at whatever resolution the token can prove, and they differ only in how
 * they resolve a tie. Enrollment keeps the token, because `finalizeTwoFactorSetup` stamps
 * `twoFactorEnrolledAt` inside the promoting compare-and-swap and the session it hands back is
 * minted after that write and a session sweep, so the survivor postdates the cutoff outright.
 * Recovery retires it, because it mints nothing that has to live through it: a token dated to the
 * resetting instant was bought with the credential the reset revoked. `issuedAtMs` is what makes
 * either tie exact, sparing a token minted later in the same second that the whole-second fallback
 * cannot tell apart, and retiring one minted earlier in it that the fallback would have spared.
 * Tokens carrying no `issuedAtMs` surrender that whole second until they expire, and a token that
 * cannot be dated at all is refused once any cutoff is set.
 */
export function isTokenRetired(
  issuance: TokenIssuance,
  user: TokenRetirementSignals | null | undefined,
): boolean {
  return (
    isTokenIssuedBefore(issuance, user?.twoFactorEnrolledAt, false) ||
    isTokenIssuedBefore(issuance, user?.credentialsChangedAt, true)
  );
}

/**
 * Whether password recovery landed after an enrollment was promoted.
 *
 * Recovery clears the staged enrollment in the same write that stamps `credentialsChangedAt`, so a reset
 * that lands first loses `finalizeTwoFactorSetup`'s compare-and-swap. One that lands in the gap
 * between that swap and the session hand-off does not, and the credential minted in that gap
 * postdates the cutoff, so `isTokenRetired` has nothing to catch it by. Comparing the two stamps is
 * what closes that ordering, and it is only meaningful against an enrollment just written.
 *
 * Compared at full resolution rather than the whole seconds `iat` forces, and ties resolve against
 * the enrollment: a reset stamped in the very millisecond of promotion is the race, not a race-free
 * coincidence.
 */
export function isEnrollmentSupersededByRecovery(
  enrolledAt: Date | string | number | null | undefined,
  credentialsChangedAt: Date | string | number | null | undefined,
): boolean {
  if (enrolledAt == null || credentialsChangedAt == null) {
    return false;
  }

  const enrolledMs = new Date(enrolledAt).getTime();
  const resetMs = new Date(credentialsChangedAt).getTime();
  if (Number.isNaN(enrolledMs) || Number.isNaN(resetMs)) {
    return false;
  }

  return resetMs >= enrolledMs;
}

/**
 * Whether password recovery landed after the read that authorized a password login.
 *
 * A password is not a bearer token: it carries no mint stamp, so `isTokenRetired` cannot order it
 * against `credentialsChangedAt`. The strategy compares the hash against a document it read beforehand,
 * and every credential the login hands back is stamped after that comparison, so a reset landing in
 * between produces a credential that postdates the cutoff and no downstream gate would retire it.
 * Comparing the stamp the authenticating read saw against the stamp the record carries once the
 * credential exists is what orders the two, and it is only meaningful against a read taken after
 * the mint. A record that reports no reset at all is treated as unchanged rather than as evidence,
 * so a lookup that comes back empty cannot lock out a login that nothing has revoked.
 */
export function hasPasswordResetSince(
  seenAt: Date | string | number | null | undefined,
  currentAt: Date | string | number | null | undefined,
): boolean {
  const currentMs = toTimestamp(currentAt);
  if (currentMs == null) {
    return false;
  }

  const seenMs = toTimestamp(seenAt);
  return seenMs == null || currentMs > seenMs;
}

function toTimestamp(value: Date | string | number | null | undefined): number | null {
  if (value == null) {
    return null;
  }

  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Mints a credential that names a user and dates itself to the millisecond.
 *
 * Both credentials minted this way are redeemable without the account password, so both have to be
 * refusable the moment recovery revokes it. `iat` alone cannot do that: it is whole seconds, so a
 * token minted in the same second as the reset is indistinguishable from one minted just before it
 * and would otherwise outlive the credential it was bought with. `issuedAtMs` orders the two.
 */
function generateDatedTwoFactorToken(
  userId: string,
  jwtSecret: string,
  purpose: string,
  expiresIn: jwt.SignOptions['expiresIn'],
): string {
  return jwt.sign({ userId, purpose, issuedAtMs: Date.now() }, jwtSecret, { expiresIn });
}

export function generateTwoFactorSetupToken(userId: string, jwtSecret: string): string {
  return generateDatedTwoFactorToken(
    userId,
    jwtSecret,
    TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_SETUP,
    TWO_FACTOR_SETUP_TOKEN_EXPIRY,
  );
}

export function generateTwoFactorLoginChallengeToken(userId: string, jwtSecret: string): string {
  return generateDatedTwoFactorToken(
    userId,
    jwtSecret,
    TWO_FACTOR_TOKEN_PURPOSE.LOGIN_CHALLENGE,
    TWO_FACTOR_LOGIN_CHALLENGE_TOKEN_EXPIRY,
  );
}

function verifyDatedTwoFactorToken(
  token: string | undefined,
  jwtSecret: string | undefined,
  purpose: string,
): TwoFactorTokenCredential | undefined {
  if (!token || !jwtSecret) {
    return undefined;
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    if (
      typeof payload !== 'object' ||
      payload.purpose !== purpose ||
      typeof payload.userId !== 'string' ||
      !payload.userId
    ) {
      return undefined;
    }
    return {
      userId: payload.userId,
      issuedAt: payload.iat,
      issuedAtMs: typeof payload.issuedAtMs === 'number' ? payload.issuedAtMs : undefined,
    };
  } catch {
    return undefined;
  }
}

export function verifyTwoFactorLoginChallengeToken(
  tempToken: string | undefined,
  jwtSecret: string | undefined,
): TwoFactorTokenCredential | undefined {
  return verifyDatedTwoFactorToken(tempToken, jwtSecret, TWO_FACTOR_TOKEN_PURPOSE.LOGIN_CHALLENGE);
}

export function generateTwoFactorSetupFinalizationToken(
  userId: string,
  nonce: string,
  jwtSecret: string,
): string {
  return jwt.sign(
    { userId, nonce, purpose: TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_FINALIZATION },
    jwtSecret,
    { expiresIn: TWO_FACTOR_SETUP_FINALIZATION_TOKEN_EXPIRY },
  );
}

export function generateTwoFactorSetupAcknowledgementToken(
  userId: string,
  nonce: string,
  jwtSecret: string,
): string {
  return jwt.sign(
    { userId, nonce, purpose: TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_ACKNOWLEDGEMENT },
    jwtSecret,
    { expiresIn: TWO_FACTOR_SETUP_ACKNOWLEDGEMENT_TOKEN_EXPIRY },
  );
}

function verifyEnrollmentCredential(
  token: string | undefined,
  jwtSecret: string | undefined,
  purpose: string,
): TwoFactorEnrollmentCredential | undefined {
  if (!token || !jwtSecret) {
    return undefined;
  }

  try {
    const payload = jwt.verify(token, jwtSecret);
    if (
      typeof payload !== 'object' ||
      payload.purpose !== purpose ||
      typeof payload.userId !== 'string' ||
      !payload.userId ||
      typeof payload.nonce !== 'string' ||
      !payload.nonce
    ) {
      return undefined;
    }
    return { userId: payload.userId, nonce: payload.nonce };
  } catch {
    return undefined;
  }
}

export function verifyTwoFactorSetupAcknowledgementToken(
  acknowledgementToken: string | undefined,
  jwtSecret: string | undefined,
): TwoFactorEnrollmentCredential | undefined {
  return verifyEnrollmentCredential(
    acknowledgementToken,
    jwtSecret,
    TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_ACKNOWLEDGEMENT,
  );
}

export function verifyTwoFactorSetupFinalizationToken(
  finalizationToken: string | undefined,
  jwtSecret: string | undefined,
): TwoFactorEnrollmentCredential | undefined {
  return verifyEnrollmentCredential(
    finalizationToken,
    jwtSecret,
    TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_FINALIZATION,
  );
}

export function verifyTwoFactorSetupToken(
  tempToken: string | undefined,
  jwtSecret: string | undefined,
): TwoFactorTokenCredential | undefined {
  return verifyDatedTwoFactorToken(tempToken, jwtSecret, TWO_FACTOR_TOKEN_PURPOSE.REQUIRED_SETUP);
}

export interface BlockRetiredSetupTokenDependencies {
  getUserById: (userId: string, projection: string) => Promise<TokenRetirementSignals | null>;
}

/**
 * Refuses a required-enrollment setup token that a later account event has retired.
 *
 * The setup token is the one credential in the enrollment chain carrying no server-side nonce, so
 * nothing else can date it. Password recovery revokes the credential it was minted for and strands
 * the staged enrollment, but a holder of the old credential could otherwise present a setup token
 * from before the reset, stage a secret of their own, and promote it over the recovered account.
 * The later steps are already covered, because recovery clears the nonce hashes they consume.
 *
 * Runs after `requireTwoFactorSetupToken`, which verifies the signature and stamps the request.
 */
export function createBlockRetiredSetupToken(deps: BlockRetiredSetupTokenDependencies) {
  return async (req: Request, res: Response, next: NextFunction): Promise<Response | void> => {
    try {
      const setupRequest = req as TwoFactorEnrollmentRequest;
      const userId = setupRequest.user?.id;
      if (!userId) {
        return res.status(401).json({ message: 'Invalid or expired two-factor setup token' });
      }

      const user = await deps.getUserById(userId, TOKEN_RETIREMENT_FIELDS);
      if (!user) {
        return res.status(401).json({ message: 'Invalid or expired two-factor setup token' });
      }

      if (
        isTokenRetired(
          {
            issuedAt: setupRequest.twoFactorSetupIssuedAt,
            issuedAtMs: setupRequest.twoFactorSetupIssuedAtMs,
          },
          user,
        )
      ) {
        logger.warn(
          `[blockRetiredSetupToken] Setup token predates enrollment or password reset: userId=${userId}`,
        );
        return res.status(401).json({ message: 'Invalid or expired two-factor setup token' });
      }

      next();
    } catch (err) {
      logger.error('[blockRetiredSetupToken]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };
}

export function requireTwoFactorSetupToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Response | void {
  if (!isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION)) {
    return res.status(403).json({ message: 'Two-factor authentication setup is not required' });
  }

  const tempToken = (req.body as TwoFactorSetupBody | undefined)?.tempToken;
  const credential = verifyTwoFactorSetupToken(tempToken, process.env.JWT_SECRET);
  if (!credential) {
    return res.status(401).json({ message: 'Invalid or expired two-factor setup token' });
  }

  const setupRequest = req as TwoFactorEnrollmentRequest;
  setupRequest.user = { id: credential.userId };
  setupRequest.twoFactorSetupIssuedAt = credential.issuedAt;
  setupRequest.twoFactorSetupIssuedAtMs = credential.issuedAtMs;
  next();
}

export function requireTwoFactorSetupFinalizationToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Response | void {
  if (!isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION)) {
    return res.status(403).json({ message: 'Two-factor authentication setup is not required' });
  }

  const finalizationToken = (req.body as TwoFactorSetupBody | undefined)?.finalizationToken;
  const credential = verifyTwoFactorSetupFinalizationToken(
    finalizationToken,
    process.env.JWT_SECRET,
  );
  if (!credential) {
    return res.status(401).json({ message: 'Invalid or expired two-factor finalization token' });
  }

  const setupRequest = req as TwoFactorEnrollmentRequest;
  setupRequest.user = { id: credential.userId };
  setupRequest.twoFactorEnrollmentNonce = credential.nonce;
  next();
}

export function requireTwoFactorSetupAcknowledgementToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Response | void {
  if (!isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION)) {
    return res.status(403).json({ message: 'Two-factor authentication setup is not required' });
  }

  const acknowledgementToken = (req.body as TwoFactorSetupBody | undefined)?.acknowledgementToken;
  const credential = verifyTwoFactorSetupAcknowledgementToken(
    acknowledgementToken,
    process.env.JWT_SECRET,
  );
  if (!credential) {
    return res.status(401).json({ message: 'Invalid or expired two-factor acknowledgement token' });
  }

  const setupRequest = req as TwoFactorEnrollmentRequest;
  setupRequest.user = { id: credential.userId };
  setupRequest.twoFactorEnrollmentNonce = credential.nonce;
  next();
}

export function blockTwoFactorDisableWhenRequired(
  req: Request,
  res: Response,
  next: NextFunction,
): Response | void {
  if (
    !isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION) ||
    !isTwoFactorPolicyProvider((req.user as Partial<Pick<IUser, 'provider'>> | undefined)?.provider)
  ) {
    next();
    return;
  }

  return res.status(403).json({
    message: 'Two-factor authentication is required and cannot be disabled',
  });
}

/**
 * Verifies the current pending TOTP secret and stages deliverable backup codes.
 *
 * Nothing is promoted here: `twoFactorEnabled` stays false and the live secret is untouched, so
 * every existing JWT and refresh session remains blocked until finalization. A lost response is
 * safe to retry with the same setup token and a current TOTP; each attempt rotates the pending
 * codes and mints a fresh acknowledgement nonce, invalidating any earlier one.
 */
export async function confirmTwoFactorSetup(
  userId: string,
  token: string | undefined,
  deps: TwoFactorEnrollmentDependencies,
): Promise<TwoFactorConfirmResult> {
  const user = await deps.getUserById(userId, TWO_FACTOR_ENROLLMENT_PROJECTION);
  if (!user || user.twoFactorEnabled || !isTwoFactorSetupEligible(user)) {
    return fail(TWO_FACTOR_SETUP_UNAVAILABLE);
  }
  if (!user.pendingTotpSecret || !user.pendingBackupCodes?.length) {
    return fail(TWO_FACTOR_SETUP_NOT_INITIATED);
  }
  if (!token) {
    return fail(TWO_FACTOR_INVALID_TOKEN);
  }

  const secret = await deps.getTOTPSecret(user.pendingTotpSecret);
  if (!secret) {
    return fail(TWO_FACTOR_SETUP_NOT_INITIATED);
  }
  if (!(await deps.verifyTOTP(secret, token))) {
    return fail(TWO_FACTOR_INVALID_TOKEN);
  }

  const { plainCodes, codeObjects } = await deps.generateBackupCodes();
  const acknowledgementNonce = createEnrollmentNonce();
  if (!isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION)) {
    return fail(TWO_FACTOR_SETUP_UNAVAILABLE);
  }

  const updatedUser = await deps.updateTwoFactorEnrollment(
    userId,
    {
      pendingTotpSecret: user.pendingTotpSecret,
      pendingBackupCodes: user.pendingBackupCodes,
    },
    {
      pendingBackupCodes: codeObjects,
      twoFactorAcknowledgementNonceHash: hashEnrollmentNonce(acknowledgementNonce),
      twoFactorFinalizationNonceHash: null,
    },
  );
  if (!updatedUser) {
    return fail(TWO_FACTOR_SETUP_UNAVAILABLE);
  }

  return { ok: true, user: updatedUser, plainCodes, acknowledgementNonce };
}

/**
 * Consumes the acknowledgement nonce the user was handed with their backup codes and issues a
 * finalization nonce in its place. Still no promotion and still no session.
 */
export async function acknowledgeTwoFactorSetup(
  userId: string,
  acknowledgementNonce: string | undefined,
  deps: TwoFactorEnrollmentDependencies,
): Promise<TwoFactorAcknowledgeResult> {
  if (!isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION)) {
    return fail(TWO_FACTOR_SETUP_UNAVAILABLE);
  }
  if (!acknowledgementNonce) {
    return fail(TWO_FACTOR_SETUP_STALE);
  }

  const finalizationNonce = createEnrollmentNonce();
  const updatedUser = await deps.updateTwoFactorEnrollment(
    userId,
    { twoFactorAcknowledgementNonceHash: hashEnrollmentNonce(acknowledgementNonce) },
    {
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: hashEnrollmentNonce(finalizationNonce),
    },
  );
  if (!updatedUser) {
    return fail(TWO_FACTOR_SETUP_STALE);
  }

  return { ok: true, user: updatedUser, finalizationNonce };
}

/**
 * The only step that promotes. It consumes the finalization nonce, the exact pending secret, and
 * the exact pending backup-code snapshot in one compare-and-swap, after revalidating deployment
 * policy and provider eligibility. A replayed credential finds no nonce and writes nothing.
 */
export async function finalizeTwoFactorSetup(
  userId: string,
  finalizationNonce: string | undefined,
  deps: TwoFactorEnrollmentDependencies,
): Promise<TwoFactorFinalizeResult> {
  if (!finalizationNonce) {
    return fail(TWO_FACTOR_SETUP_STALE);
  }

  const user = await deps.getUserById(userId, TWO_FACTOR_ENROLLMENT_PROJECTION);
  if (!user || user.twoFactorEnabled || !isTwoFactorSetupEligible(user)) {
    return fail(TWO_FACTOR_SETUP_UNAVAILABLE);
  }
  if (!user.pendingTotpSecret || !user.pendingBackupCodes?.length) {
    return fail(TWO_FACTOR_SETUP_NOT_INITIATED);
  }
  if (!isEnabled(process.env.ENFORCE_TWO_FACTOR_AUTHENTICATION)) {
    return fail(TWO_FACTOR_SETUP_UNAVAILABLE);
  }

  const updatedUser = await deps.updateTwoFactorEnrollment(
    userId,
    {
      pendingTotpSecret: user.pendingTotpSecret,
      pendingBackupCodes: user.pendingBackupCodes,
      twoFactorFinalizationNonceHash: hashEnrollmentNonce(finalizationNonce),
    },
    {
      totpSecret: user.pendingTotpSecret,
      backupCodes: user.pendingBackupCodes,
      twoFactorEnabled: true,
      twoFactorEnrolledAt: new Date(),
      pendingTotpSecret: null,
      pendingBackupCodes: [],
      twoFactorAcknowledgementNonceHash: null,
      twoFactorFinalizationNonceHash: null,
    },
  );
  if (!updatedUser) {
    return fail(TWO_FACTOR_SETUP_STALE);
  }

  return { ok: true, user: updatedUser };
}
