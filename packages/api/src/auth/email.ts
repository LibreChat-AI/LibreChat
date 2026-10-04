import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { logger, hashToken, getRandomValues, isValidObjectIdString } from '@librechat/data-schemas';
import type { EmailChangeErrorCode, TCustomConfig } from 'librechat-data-provider';
import { isEmailDomainAllowed } from './domain';
import { isEnabled } from '../utils/common';

export type { EmailChangeErrorCode } from 'librechat-data-provider';

export const EMAIL_CHANGE_TOKEN_TYPE = 'email_change';
const PASSWORD_RESET_TOKEN_TYPE = 'password_reset';

export function isEmailChangeAllowed(
  value: string | undefined = process.env.ALLOW_EMAIL_CHANGE,
): boolean {
  return value === undefined || isEnabled(value);
}

/**
 * yaml wins over the environment, which wins over the documented default, so a deployment
 * that sets neither keeps exactly the behavior it has today.
 */
export function resolveEmailChangeSettings(
  config?: TCustomConfig['emailChange'],
  env: NodeJS.ProcessEnv = process.env,
): EmailChangeSettings {
  return {
    enabled: config?.enabled ?? isEmailChangeAllowed(env.ALLOW_EMAIL_CHANGE),
    tokenTTLSeconds: config?.tokenTTLSeconds ?? DEFAULT_EMAIL_CHANGE_TOKEN_TTL_SECONDS,
  };
}

export const DEFAULT_EMAIL_CHANGE_TOKEN_TTL_SECONDS: number = 15 * 60;

const SUBMITTED_ID_PATTERN = /^[a-f\d]{24}$/i;

/**
 * The confirmation endpoint is unauthenticated, so its per-submission allowance is keyed on
 * the address the request came from together with the account it names. The submitted id is
 * untrusted: one that cannot identify an account collapses to a single bucket, so a caller
 * cannot mint a fresh allowance per malformed value.
 */
export function emailChangeSubmissionKey(ip: string, submittedUserId: unknown): string {
  const userId =
    typeof submittedUserId === 'string' && SUBMITTED_ID_PATTERN.test(submittedUserId)
      ? submittedUserId.toLowerCase()
      : 'invalid';
  return `ip:${ip}:user:${userId}`;
}
const EMAIL_CHANGE_ERROR_MESSAGE = 'Invalid or expired email change request';

const requestSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newEmail: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
});

const confirmSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  token: z.string().min(1),
  userId: z.string().refine(isValidObjectIdString),
});

/**
 * The service speaks in plain records so a caller can implement it without Mongoose. The
 * adapter that owns the database is the one that turns documents into these.
 */
export interface EmailChangeUser {
  _id?: string;
  id?: string;
  email: string;
  name?: string;
  username?: string;
  password?: string;
  provider?: string;
  role?: string;
  tenantId?: string;
  /** Null is a resolved answer, absent is unknown; principal resolution distinguishes them. */
  idOnTheSource?: string | null;
}

/** `lean()` yields a Map for a Mongoose map field, so reads tolerate either shape. */
export type EmailChangeTokenMetadata =
  | { requestIp?: string; passwordFingerprint?: string }
  | Map<string, unknown>;

export interface EmailChangeToken {
  userId: string;
  token: string;
  email?: string;
  scope?: string;
  identifier?: string;
  expiresAt?: Date | string;
  metadata?: EmailChangeTokenMetadata;
  tenantId?: string;
}

/** `null` matches a stored field that is absent, which is how legacy reset tokens are found. */
export interface EmailChangeTokenQuery {
  userId?: string;
  email?: string | null;
  identifier?: string | null;
  type?: string | null;
  scope?: string;
  token?: string;
}

export interface EmailChangeTokenData {
  userId: string;
  email: string;
  scope: string;
  identifier: string;
  type: string;
  token: string;
  expiresIn: number;
  metadata?: EmailChangeTokenMetadata;
}

/** What an operator may set, resolved once per call from yaml, then env, then the default. */
export interface EmailChangeSettings {
  enabled: boolean;
  tokenTTLSeconds: number;
}

/** The effective policy for one account, read in that account's own principal scope. */
export interface EmailChangePolicy {
  settings: EmailChangeSettings;
  allowedDomains?: string[] | null;
}

interface EmailData {
  email: string;
  subject: string;
  payload: Record<string, string>;
  template: string;
}

export interface EmailChangeDeps {
  findUserByEmail: (email: string, tenantId?: string) => Promise<EmailChangeUser | null>;
  getUserById: (userId: string, tenantId?: string) => Promise<EmailChangeUser | null>;
  updateUser: (
    userId: string,
    update: Pick<EmailChangeUser, 'email'> & { emailVerified: boolean; emailChangedAt: Date },
    expectedState: Pick<EmailChangeUser, 'email' | 'password' | 'provider'>,
    tenantId?: string,
  ) => Promise<EmailChangeUser | null>;
  findToken: (query: EmailChangeTokenQuery, tenantId?: string) => Promise<EmailChangeToken | null>;
  replaceTokenIfCurrent: (
    scope: string,
    expectedToken: string | null,
    data: EmailChangeTokenData,
    tenantId?: string,
  ) => Promise<boolean>;
  deleteTokens: (
    query: EmailChangeTokenQuery,
    tenantId?: string,
  ) => Promise<{ deletedCount?: number }>;
  verifyPassword: (user: EmailChangeUser, password: string) => Promise<boolean>;
  /** The token owner's effective policy, so confirmation honors the scope that issued the
   * link: neither an address the allowlist stopped permitting, nor a change a tenant, role,
   * group, or user override has since disabled. */
  resolvePolicy: (user: EmailChangeUser) => Promise<EmailChangePolicy>;
  sendEmail: (data: EmailData) => Promise<void>;
  /** The deployment default, which answers only for a link that resolves to no owner: a
   * disabled deployment reports an unavailable endpoint rather than an invalid token. It
   * never decides a link that does resolve; `resolvePolicy` owns that. */
  resolveSettings: () => Promise<EmailChangeSettings>;
  clientDomain: string;
  appName: string;
}

export interface EmailChangeResult {
  status: number;
  message: string;
  code?: EmailChangeErrorCode;
}

export interface RequestEmailChangeInput {
  body: {
    currentPassword?: string;
    newEmail?: string;
  };
  userId: string;
  tenantId?: string;
  allowedDomains?: string[] | null;
  emailEnabled: boolean;
  /** Resolved from the effective config the request already loaded. */
  settings: EmailChangeSettings;
  ip?: string;
}

export interface ConfirmEmailChangeInput {
  body: {
    email?: string;
    token?: string;
    userId?: string;
  };
  ip?: string;
}

function result(status: number, message: string, code?: EmailChangeErrorCode): EmailChangeResult {
  return { status, message, ...(code ? { code } : {}) };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function userIdOf(user: EmailChangeUser): string | undefined {
  const userId = user._id ?? user.id;
  return userId?.toString();
}

function accountMatchesRequest(
  user: EmailChangeUser | null,
  userId: string,
  email: string,
  password: string,
): boolean {
  return (
    !!user &&
    userIdOf(user) === userId &&
    user.provider === 'local' &&
    user.password === password &&
    normalizeEmail(user.email) === email
  );
}

function displayName(user: EmailChangeUser): string {
  return user.name || user.username || user.email;
}

/**
 * The template promises a lifetime, so it has to be the one the token was issued with, and
 * never a longer one: rounding 90 minutes up to "2 hours" would keep claiming a link is
 * valid half an hour after it expired. Only a whole number of hours is said in hours.
 */
function formatLifetime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60 || minutes % 60 !== 0) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = minutes / 60;
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

async function tokenMatches(candidate: string, storedHash: string): Promise<boolean> {
  const candidateHash = await hashToken(candidate);
  const candidateBuffer = Buffer.from(candidateHash, 'hex');
  const storedBuffer = Buffer.from(storedHash, 'hex');
  return (
    candidateBuffer.length === storedBuffer.length && timingSafeEqual(candidateBuffer, storedBuffer)
  );
}

async function sendSecurityNotification(
  deps: EmailChangeDeps,
  data: EmailData,
  logContext: string,
): Promise<void> {
  try {
    await deps.sendEmail(data);
  } catch (error) {
    logger.error(`[emailChange] Failed to send ${logContext} notification`, error);
  }
}

function verificationLink(
  deps: EmailChangeDeps,
  userId: string,
  email: string,
  token: string,
): string {
  const query = new URLSearchParams({
    type: 'email-change',
    userId,
    email,
    token,
  });
  return `${deps.clientDomain.replace(/\/$/, '')}/verify?${query.toString()}`;
}

function emailChangeTokenScope(userId: string): string {
  return `${EMAIL_CHANGE_TOKEN_TYPE}:${userId}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: number }).code === 11000
  );
}

function expiryOf(token: EmailChangeToken): number | null {
  if (!token.expiresAt) {
    return null;
  }
  const expiresAt = new Date(token.expiresAt).getTime();
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

function isTokenExpired(token: EmailChangeToken): boolean {
  const expiresAt = expiryOf(token);
  return expiresAt === null || expiresAt <= Date.now();
}

function remainingLifetimeSeconds(token: EmailChangeToken): number {
  const expiresAt = expiryOf(token);
  return expiresAt === null ? 0 : Math.floor((expiresAt - Date.now()) / 1000);
}

function tokenMetadataValue(
  token: EmailChangeToken,
  key: 'requestIp' | 'passwordFingerprint',
): unknown {
  if (token.metadata instanceof Map) {
    return token.metadata.get(key);
  }
  return token.metadata?.[key];
}

async function deleteTokensOrLog(
  deps: EmailChangeDeps,
  query: EmailChangeTokenQuery,
  tenantId: string | undefined,
  context: string,
): Promise<void> {
  try {
    await deps.deleteTokens(query, tenantId);
  } catch (error) {
    logger.error(`[emailChange] Failed to clean up ${context}`, error);
  }
}

type TokenClaim = 'claimed' | 'superseded' | 'unavailable';

/** Consumes the pending token only while the stored hash still matches the presented link,
 * so a confirmation that a newer request superseded finds nothing to claim. A failed delete
 * is reported separately because it must not be read as a superseded link. */
async function claimTokenIfCurrent(
  deps: EmailChangeDeps,
  query: EmailChangeTokenQuery,
  tenantId: string | undefined,
): Promise<TokenClaim> {
  try {
    const { deletedCount } = await deps.deleteTokens(query, tenantId);
    return deletedCount ? 'claimed' : 'superseded';
  } catch (error) {
    logger.error('[emailChange] Failed to claim the pending token', error);
    return 'unavailable';
  }
}

/** Reinstates a claimed token so a transient commit failure leaves the link usable. The
 * conditional insert is a no-op once a newer request owns the scope, and an elapsed
 * lifetime is left consumed rather than revived. */
async function restoreClaimedToken(
  deps: EmailChangeDeps,
  token: EmailChangeToken,
  scope: string,
  tenantId: string | undefined,
): Promise<void> {
  const expiresIn = remainingLifetimeSeconds(token);
  const { email, identifier } = token;
  /** A pending change always carries both; without them there is no link to reinstate. */
  if (expiresIn <= 0 || !email || !identifier) {
    return;
  }
  try {
    await deps.replaceTokenIfCurrent(
      scope,
      null,
      {
        userId: token.userId,
        email,
        scope,
        identifier,
        type: EMAIL_CHANGE_TOKEN_TYPE,
        token: token.token,
        expiresIn,
        metadata: token.metadata,
      },
      tenantId,
    );
  } catch (error) {
    logger.error('[emailChange] Failed to restore the claimed token', error);
  }
}

export function createEmailChangeService(deps: EmailChangeDeps): {
  requestEmailChange: (input: RequestEmailChangeInput) => Promise<EmailChangeResult>;
  confirmEmailChange: (input: ConfirmEmailChangeInput) => Promise<EmailChangeResult>;
} {
  async function requestEmailChange(input: RequestEmailChangeInput): Promise<EmailChangeResult> {
    const { settings } = input;
    if (!settings.enabled) {
      logger.warn(
        `[emailChange] Rejected disabled request [User ID: ${input.userId}] [IP: ${input.ip ?? 'unknown'}]`,
      );
      return result(403, 'Email changes are disabled', 'email_change_disabled');
    }

    const parsed = requestSchema.safeParse(input.body);
    if (!parsed.success) {
      return result(400, 'A valid new email and current password are required', 'invalid_request');
    }

    if (!input.emailEnabled) {
      return result(503, 'Email delivery is not configured', 'email_service_unavailable');
    }

    const user = await deps.getUserById(input.userId, input.tenantId);
    const userId = user ? userIdOf(user) : undefined;
    if (!user || !userId || user.provider !== 'local' || !user.password) {
      logger.warn(
        `[emailChange] Rejected non-local account request [User ID: ${input.userId}] [IP: ${input.ip ?? 'unknown'}]`,
      );
      return result(
        403,
        'Email changes are only available for local accounts',
        'local_account_required',
      );
    }

    const oldEmail = normalizeEmail(user.email);
    const newEmail = parsed.data.newEmail;
    if (newEmail === oldEmail) {
      return result(400, 'New email must be different from the current email', 'same_email');
    }

    const ip = input.ip ?? 'unknown';
    logger.info(
      `[emailChange] Change requested [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
    );
    await sendSecurityNotification(
      deps,
      {
        email: oldEmail,
        subject: 'Email change requested',
        payload: {
          appName: deps.appName,
          name: displayName(user),
          newEmail,
          ip,
          requestedAt: formatTimestamp(),
        },
        template: 'emailChangeAttempt.handlebars',
      },
      'email change attempt',
    );

    const passwordMatches = await deps.verifyPassword(user, parsed.data.currentPassword);
    if (!passwordMatches) {
      logger.warn(
        `[emailChange] Incorrect password [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
      );
      return result(403, 'Current password is incorrect', 'current_password_invalid');
    }

    if (!isEmailDomainAllowed(newEmail, input.allowedDomains)) {
      logger.warn(
        `[emailChange] Domain not allowed [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
      );
      return result(403, 'Email domain is not allowed', 'email_domain_not_allowed');
    }

    const tokenScope = emailChangeTokenScope(userId);
    /** Nothing here depends on another's result and all three stay scoped to the requesting
     * user's tenant, so issuance makes one round trip instead of three before delivery. The
     * results are still validated in the order they were, and none of them is acted on until
     * the check that owns it passes. */
    const [existingUser, previousToken, latestUser] = await Promise.all([
      deps.findUserByEmail(newEmail, user.tenantId),
      deps.findToken({ scope: tokenScope }, user.tenantId),
      deps.getUserById(input.userId, input.tenantId),
    ]);

    if (existingUser && userIdOf(existingUser) !== userId) {
      logger.warn(
        `[emailChange] Email already in use [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
      );
      return result(409, 'Email address is already linked to another account', 'email_in_use');
    }

    const rawToken = await getRandomValues(32);
    const tokenHash = await hashToken(rawToken);
    const passwordFingerprint = await hashToken(user.password);
    const tokenQuery = {
      userId,
      email: newEmail,
      type: EMAIL_CHANGE_TOKEN_TYPE,
      token: tokenHash,
    };

    /** The re-read above guards delivery: an account change during request validation must not
     * produce a verification message whose link can never be used. */
    if (!accountMatchesRequest(latestUser, userId, oldEmail, user.password)) {
      logger.warn(
        `[emailChange] Account changed while issuing [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
      );
      return result(409, 'Account was modified during the request', 'account_modified');
    }

    try {
      await deps.sendEmail({
        email: newEmail,
        subject: 'Verify your new email address',
        payload: {
          appName: deps.appName,
          name: displayName(user),
          newEmail,
          verificationLink: verificationLink(deps, userId, newEmail, rawToken),
          linkLifetime: formatLifetime(settings.tokenTTLSeconds),
          year: new Date().getFullYear().toString(),
        },
        template: 'verifyEmailChange.handlebars',
      });
    } catch (error) {
      logger.error(
        `[emailChange] Verification delivery failed [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
        error,
      );
      return result(500, 'Failed to send verification email', 'email_delivery_failed');
    }

    const replacement = {
      userId,
      email: newEmail,
      scope: tokenScope,
      identifier: oldEmail,
      type: EMAIL_CHANGE_TOKEN_TYPE,
      token: tokenHash,
      expiresIn: settings.tokenTTLSeconds,
      metadata: { requestIp: ip, passwordFingerprint },
    };
    let replacedToken = await deps.replaceTokenIfCurrent(
      tokenScope,
      previousToken?.token ?? null,
      replacement,
      user.tenantId,
    );
    /** The observed token can be swept by the expiry monitor while the message is in flight,
     * and a compare-and-set against a hash that no longer exists cannot tell that apart from
     * a competitor. The empty expectation answers it atomically: the scoped index admits the
     * insert only while nothing holds the scope, so a real competitor still refuses it and a
     * delivered link is not reported as a losing race. */
    if (!replacedToken && previousToken) {
      replacedToken = await deps.replaceTokenIfCurrent(
        tokenScope,
        null,
        replacement,
        user.tenantId,
      );
    }
    if (!replacedToken) {
      logger.warn(
        `[emailChange] Competing request completed first [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
      );
      return result(409, 'Another email change request completed first', 'request_in_progress');
    }

    /** Re-read after replacement: the prior token remains valid during delivery, so a
     * confirmation can move the account before the new token becomes active. */
    const committedUser = await deps.getUserById(input.userId, input.tenantId);
    if (!accountMatchesRequest(committedUser, userId, oldEmail, user.password)) {
      await deleteTokensOrLog(deps, tokenQuery, user.tenantId, 'token bound to a stale address');
      logger.warn(
        `[emailChange] Account changed while issuing [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
      );
      return result(409, 'Account was modified during the request', 'account_modified');
    }

    logger.info(
      `[emailChange] Verification issued [User ID: ${userId}] [New Email: ${newEmail}] [IP: ${ip}]`,
    );
    return result(200, 'Verification link sent to your new email address');
  }

  /** A link that names no owner has no policy to consult, so the deployment answers for it:
   * an operator who turned changes off gets an unavailable endpoint rather than a report
   * about the token. A link that does resolve is decided by its owner's policy alone. */
  async function unresolvedLink(): Promise<EmailChangeResult> {
    if (!(await deps.resolveSettings()).enabled) {
      return result(403, 'Email changes are disabled', 'email_change_disabled');
    }
    return result(400, EMAIL_CHANGE_ERROR_MESSAGE, 'invalid_token');
  }

  /** Issuance answers from the requesting user's effective configuration, so confirmation has
   * to answer from the same scope or a tenant, role, group, or user override that enables
   * changes would offer a link the deployment default then refuses. The toggle that decides a
   * real link is therefore read once, below, after the link names its owner. */
  async function confirmEmailChange(input: ConfirmEmailChangeInput): Promise<EmailChangeResult> {
    const parsed = confirmSchema.safeParse(input.body);
    if (!parsed.success) {
      return unresolvedLink();
    }

    const { email, token, userId } = parsed.data;
    const ip = input.ip ?? 'unknown';
    const scope = emailChangeTokenScope(userId);
    const tokenQuery = { userId, email, type: EMAIL_CHANGE_TOKEN_TYPE, scope };
    const emailChangeToken = await deps.findToken(tokenQuery);

    if (
      !emailChangeToken ||
      isTokenExpired(emailChangeToken) ||
      !(await tokenMatches(token, emailChangeToken.token))
    ) {
      logger.warn(
        `[emailChange] Invalid confirmation [User ID: ${userId}] [New Email: ${email}] [IP: ${ip}]`,
      );
      return unresolvedLink();
    }

    const tenantId = emailChangeToken.tenantId;
    const user = await deps.getUserById(userId, tenantId);
    const oldEmail = user ? normalizeEmail(user.email) : '';
    const passwordFingerprint = tokenMetadataValue(emailChangeToken, 'passwordFingerprint');
    if (
      !user ||
      userIdOf(user) !== userId ||
      user.provider !== 'local' ||
      !user.password ||
      typeof passwordFingerprint !== 'string' ||
      !(await tokenMatches(user.password, passwordFingerprint)) ||
      emailChangeToken.scope !== scope ||
      normalizeEmail(emailChangeToken.email ?? '') !== email ||
      normalizeEmail(emailChangeToken.identifier ?? '') !== oldEmail
    ) {
      logger.warn(
        `[emailChange] Stale confirmation [User ID: ${userId}] [New Email: ${email}] [IP: ${ip}]`,
      );
      return unresolvedLink();
    }

    /** The policy of the account the link names, which is the scope that issued it: a
     * deployment default reaches this through the same read when nothing overrides it. */
    const policy = await deps.resolvePolicy(user);
    if (!policy.settings.enabled) {
      logger.warn(
        `[emailChange] Rejected disabled confirmation for its owner [User ID: ${userId}] [IP: ${ip}]`,
      );
      return result(403, 'Email changes are disabled', 'email_change_disabled');
    }

    if (!isEmailDomainAllowed(email, policy.allowedDomains)) {
      logger.warn(
        `[emailChange] Domain no longer allowed [User ID: ${userId}] [New Email: ${email}] [IP: ${ip}]`,
      );
      return result(403, 'Email domain is not allowed', 'email_domain_not_allowed');
    }

    const existingUser = await deps.findUserByEmail(email, tenantId);
    if (existingUser && userIdOf(existingUser) !== userId) {
      return result(409, 'Email address is already linked to another account', 'email_in_use');
    }

    /** Claiming the exact hash that was presented binds the commit to this link: a request
     * that replaced the scoped token between the lookup and here leaves nothing to claim,
     * so a superseded address can no longer overwrite the one the user was last sent.
     * Reset tokens stay untouched until after the commit so a failed update cannot revoke
     * an unrelated password-reset link. */
    const claim = await claimTokenIfCurrent(
      deps,
      { ...tokenQuery, token: emailChangeToken.token },
      tenantId,
    );
    if (claim === 'unavailable') {
      logger.error(
        `[emailChange] Token claim failed [User ID: ${userId}] [New Email: ${email}] [IP: ${ip}]`,
      );
      return result(500, 'Failed to change email address');
    }
    if (claim === 'superseded') {
      logger.warn(
        `[emailChange] Superseded confirmation [User ID: ${userId}] [New Email: ${email}] [IP: ${ip}]`,
      );
      return result(400, EMAIL_CHANGE_ERROR_MESSAGE, 'invalid_token');
    }

    /** The compare-and-set remains the commit point and the single-use guard: a competing
     * confirmation cannot match `oldEmail` twice. The claimed token is put back when the
     * update fails transiently, so the link stays replayable. Reset tokens are not touched
     * here: a failed commit must leave the account's existing reset flow intact. */
    try {
      const updatedUser = await deps.updateUser(
        userId,
        { email, emailVerified: true, emailChangedAt: new Date() },
        { email: oldEmail, password: user.password, provider: 'local' },
        tenantId,
      );
      if (!updatedUser) {
        return result(400, EMAIL_CHANGE_ERROR_MESSAGE, 'invalid_token');
      }
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return result(409, 'Email address is already linked to another account', 'email_in_use');
      }
      logger.error(
        `[emailChange] Update failed [User ID: ${userId}] [New Email: ${email}] [IP: ${ip}]`,
        error,
      );
      await restoreClaimedToken(deps, emailChangeToken, scope, tenantId);
      return result(500, 'Failed to change email address');
    }

    /** After the commit only. Restricted to the address that moved, address-less typed
     * tokens, and untyped legacy tokens, so a reset another replica issued for the
     * committed address is not revoked with them. `resetPassword` also refuses those
     * leftovers via the address binding and `emailChangedAt` checks. No email change
     * token is swept here: the claim above already consumed the one this link
     * presented, and the scope is unique per user, so anything under it now belongs
     * to a request that started after the commit and still has a live link. */
    await Promise.all([
      deleteTokensOrLog(
        deps,
        { userId, email: oldEmail, type: PASSWORD_RESET_TOKEN_TYPE },
        tenantId,
        'password reset tokens bound to the previous address',
      ),
      deleteTokensOrLog(
        deps,
        { userId, email: null, type: PASSWORD_RESET_TOKEN_TYPE },
        tenantId,
        'address-less password reset tokens issued during the change',
      ),
      deleteTokensOrLog(
        deps,
        { userId, email: null, identifier: null, type: null },
        tenantId,
        'untyped legacy reset tokens issued before the change',
      ),
    ]);
    const confirmationPayload = {
      appName: deps.appName,
      name: displayName(user),
      oldEmail,
      newEmail: email,
      ip,
      changedAt: formatTimestamp(),
    };
    await Promise.all([
      sendSecurityNotification(
        deps,
        {
          email: oldEmail,
          subject: 'Your email address was changed',
          payload: confirmationPayload,
          template: 'emailChanged.handlebars',
        },
        'old-address confirmation',
      ),
      sendSecurityNotification(
        deps,
        {
          email,
          subject: 'Your email address was changed',
          payload: confirmationPayload,
          template: 'emailChanged.handlebars',
        },
        'new-address confirmation',
      ),
    ]);

    logger.info(
      `[emailChange] Change completed [User ID: ${userId}] [Old Email: ${oldEmail}] [New Email: ${email}] [IP: ${ip}]`,
    );
    return result(200, 'Email address changed successfully');
  }

  return { requestEmailChange, confirmEmailChange };
}
