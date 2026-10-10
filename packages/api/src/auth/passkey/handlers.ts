import { logger } from '@librechat/data-schemas';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { PasskeyCreateData, PasskeyRecord, AppConfig } from '@librechat/data-schemas';
import type { TPasskey } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { AppConfigUserLike, GetAppConfigOptions } from '~/app/service';
import type { PasskeyConfig, PasskeyChallengeStore } from '~/auth/passkey';
import type { ComparePasswordDeps } from '~/auth/password';
import type { UserDocumentId } from '~/auth/verification';
import {
  getPasskeyConfig,
  isPasskeyEnabled,
  defaultPasskeyName,
  resolveMaxPasskeysPerUser,
  verifyPasskeyRegistration,
  verifyPasskeyAuthentication,
  createPasskeyRegistrationOptions,
  createPasskeyAuthenticationOptions,
} from '~/auth/passkey';
import { grandfatherLegacyEmailVerification } from '~/auth/verification';
import { resolveStrictAppConfig } from '~/app/service';
import { comparePassword } from '~/auth/password';
import { isEnabled } from '~/utils';

const MAX_PASSKEY_NAME_LENGTH = 60;
const LOCAL_PROVIDER = 'local';
/** Single answer for every step-up failure so the endpoint reveals nothing extra. */
const INCORRECT_PASSWORD = 'Incorrect password';
/** Log tags keep the two step-up sites distinguishable in the audit trail. */
const REGISTRATION_STEP_UP = 'Registration step-up failed';
const DELETION_STEP_UP = 'Deletion step-up failed';

interface StepUpBody {
  password?: string;
}

interface RegistrationBody extends StepUpBody {
  credential?: RegistrationResponseJSON;
  name?: string;
}

interface RenameBody {
  name?: string;
}

interface AuthenticationBody {
  credential?: AuthenticationResponseJSON;
  sessionId?: string;
}

/**
 * The account fields the passkey routes read, as a plain shape: neither the
 * request's user nor the data-layer results carry Mongoose types across the
 * package boundary. `twoFactorEnabled` and `createdAt` are read after the
 * handoff to `loginController` and legacy-verification grandfathering, not by
 * the route handlers themselves.
 */
export interface PasskeyAccount extends AppConfigUserLike {
  id?: string;
  _id?: UserDocumentId;
  email?: string;
  name?: string;
  username?: string;
  emailVerified?: boolean;
  expiresAt?: Date | null;
  provider?: string;
  password?: string;
  twoFactorEnabled?: boolean;
  createdAt?: Date | string;
}

export type PasskeyRequest<TBody = StepUpBody> = Request<
  { passkeyId: string },
  object,
  TBody | undefined
> & {
  user?: PasskeyAccount;
  banned?: boolean;
  config?: AppConfig;
};

/** Every management route sits behind `requireJwtAuth`, so `req.user` is always populated. */
export type AuthenticatedPasskeyRequest<TBody = StepUpBody> = PasskeyRequest<TBody> & {
  user: PasskeyAccount & { id: string; email: string };
};

/** The client-facing summary, carrying dates before JSON serialization turns them into strings. */
export type PasskeySummary = Omit<TPasskey, 'transports' | 'createdAt' | 'lastUsedAt'> & {
  transports: string[];
  createdAt?: Date;
  lastUsedAt: Date | null;
};

type PasskeyResult = Promise<Response | void>;
type NextCallback = (err?: Error) => void;

/**
 * The handlers' data layer, in plain shapes. The data-schemas methods satisfy
 * these signatures structurally, so the wiring stays unchanged while Mongoose
 * types stay inside data-schemas.
 */
export interface PasskeyHandlersDeps {
  getUserById: (
    userId: string,
    fieldsToSelect?: string | string[] | null,
  ) => Promise<(PasskeyAccount & { _id: UserDocumentId }) | null>;
  /** Receives the raw document id, exactly as the password strategy passes it. */
  updateUser: (
    userId: UserDocumentId,
    update: Partial<PasskeyAccount>,
  ) => Promise<PasskeyAccount | null>;
  createPasskey: (data: PasskeyCreateData) => Promise<PasskeyRecord>;
  deletePasskey: (passkeyId: string, userId: string) => Promise<{ deletedCount: number }>;
  renamePasskey: (passkeyId: string, userId: string, name: string) => Promise<PasskeyRecord | null>;
  recordPasskeyUse: (credentialId: string, counter: number, backedUp?: boolean) => Promise<boolean>;
  findPasskeysByUser: (userId: string) => Promise<PasskeyRecord[]>;
  countPasskeysByUser: (userId: string) => Promise<number>;
  findPasskeyByCredentialId: (credentialId: string) => Promise<PasskeyRecord | null>;
  /** Resolves the cache backing pending WebAuthn ceremonies. */
  getChallengeCache: () => PasskeyChallengeStore;
  /** Resolves effective configuration for the authenticated principal. */
  getAppConfig?: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  compare: ComparePasswordDeps['compare'];
  /** The login ban middleware; reports an internal failure through `next(err)`. */
  checkBan: (
    req: PasskeyRequest<AuthenticationBody>,
    res: Response,
    next: NextCallback,
  ) => Promise<Response | void>;
}

export interface PasskeyHandlers {
  listPasskeys: (req: AuthenticatedPasskeyRequest, res: Response) => PasskeyResult;
  registerPasskeyOptions: (req: AuthenticatedPasskeyRequest, res: Response) => PasskeyResult;
  registerPasskeyVerify: (
    req: AuthenticatedPasskeyRequest<RegistrationBody>,
    res: Response,
  ) => PasskeyResult;
  updatePasskey: (req: AuthenticatedPasskeyRequest<RenameBody>, res: Response) => PasskeyResult;
  removePasskey: (req: AuthenticatedPasskeyRequest, res: Response) => PasskeyResult;
  loginPasskeyOptions: (req: PasskeyRequest, res: Response) => PasskeyResult;
  authenticatePasskey: (
    req: PasskeyRequest<AuthenticationBody>,
    res: Response,
    next: () => void,
  ) => PasskeyResult;
}

/**
 * Challenge store handed to the ceremony helpers. `getDel` is exposed only when the
 * cache has a native one; otherwise `consumeChallenge` arbitrates on `delete`, which
 * reports removal to exactly one concurrent caller.
 */
export function createPasskeyChallengeStore(cache: PasskeyChallengeStore): PasskeyChallengeStore {
  const nativeGetDel = cache.getDel?.bind(cache);
  return {
    get: (key) => cache.get(key),
    set: (key, value, ttl) => cache.set(key, value, ttl),
    delete: (key) => cache.delete(key),
    ...(nativeGetDel ? { getDel: nativeGetDel } : {}),
  };
}

/**
 * Passkeys are a local-account credential. An account provisioned by an identity
 * provider must keep authenticating through it, otherwise the passkey becomes a
 * login path that bypasses IdP-side MFA, conditional access and deprovisioning.
 */
const isLocalAccount = (user: PasskeyAccount | null | undefined): boolean =>
  user?.provider === LOCAL_PROVIDER;

/** Shapes a stored credential into the safe summary the client renders. */
export const serializePasskey = (passkey: PasskeyRecord): PasskeySummary => ({
  id: passkey.id,
  name: passkey.name,
  deviceType: passkey.deviceType,
  backedUp: passkey.backedUp,
  transports: passkey.transports ?? [],
  createdAt: passkey.createdAt,
  lastUsedAt: passkey.lastUsedAt ?? null,
});

/** Base64URL-decodes the assertion's user handle so it can be matched to the credential owner. */
const decodeUserHandle = (userHandle: string | undefined): string | null => {
  if (typeof userHandle !== 'string' || !userHandle) {
    return null;
  }
  try {
    return Buffer.from(userHandle, 'base64url').toString('utf8');
  } catch {
    return null;
  }
};

type MongoWriteError = { code?: number | string } | null | undefined;

const isDuplicateKeyError = (err: MongoWriteError): boolean =>
  err?.code === 11000 || err?.code === 'E11000';

/** Responds 403 when the authenticated account is not a local one. */
const requireLocalAccount = (req: AuthenticatedPasskeyRequest, res: Response): boolean => {
  if (isLocalAccount(req.user)) {
    return true;
  }
  res.status(403).json({ message: 'Passkeys are only available for local accounts' });
  return false;
};

/**
 * Guard shared by every passkey endpoint. Responds 404 when the feature is off
 * so a disabled deployment does not advertise the routes.
 */
const requirePasskeysEnabled = (res: Response): PasskeyConfig | null => {
  const config = getPasskeyConfig();
  if (!isPasskeyEnabled(config)) {
    res.status(404).json({ message: 'Passkey authentication is not enabled' });
    return null;
  }
  return config;
};

/**
 * Answers a failed step-up. The rejection is logged because these endpoints would
 * otherwise be a silent password oracle for a stolen access token: they are keyed
 * by user id rather than by IP, so the login ban system never sees these attempts.
 */
const denyPasswordConfirmation = (
  req: AuthenticatedPasskeyRequest,
  res: Response,
  tag: string,
): boolean => {
  logger.warn(`[Passkey] [${tag}] [User: ${req.user?.id}] [Request-IP: ${req.ip}]`);
  res.status(403).json({ message: INCORRECT_PASSWORD });
  return false;
};

/** Builds the passkey route handlers around the caller's data layer, cache and ban check. */
export function createPasskeyHandlers(deps: PasskeyHandlersDeps): PasskeyHandlers {
  const {
    compare,
    checkBan,
    updateUser,
    getUserById,
    createPasskey,
    deletePasskey,
    renamePasskey,
    recordPasskeyUse,
    getChallengeCache,
    findPasskeysByUser,
    getAppConfig,
    countPasskeysByUser,
    findPasskeyByCredentialId,
  } = deps;

  const getChallengeStore = (): PasskeyChallengeStore =>
    createPasskeyChallengeStore(getChallengeCache());

  /** Resolved per request, so a config reload changes the cap without a restart. */
  const resolveMaxPasskeys = async (req: AuthenticatedPasskeyRequest): Promise<number> => {
    const appConfig =
      req.config ??
      (getAppConfig ? await resolveStrictAppConfig(getAppConfig, req.user) : undefined);
    return resolveMaxPasskeysPerUser(appConfig?.passkeys);
  };

  /**
   * Step-up gate shared by the passkey endpoints that add or remove a login factor.
   * A passkey is a durable single-factor login that outlives session revocation, so
   * minting one, or stripping one the account relies on, takes the account password
   * and not merely a bearer token.
   *
   * Answers 403 rather than 401 on failure: the client turns a 401 into a token
   * refresh followed by a redirect to the login page, so a mistyped password would
   * sign the user out instead of showing an error.
   *
   * `allowPasswordless` waves through an account carrying no password hash instead
   * of refusing it. Resolves true when the caller may continue.
   */
  const requirePasswordConfirmation = async (
    req: AuthenticatedPasskeyRequest,
    res: Response,
    { tag, allowPasswordless = false }: { tag: string; allowPasswordless?: boolean },
  ): Promise<boolean> => {
    const password = req.body?.password;
    const submitted = typeof password === 'string' && password.length > 0;

    if (!submitted && !allowPasswordless) {
      return denyPasswordConfirmation(req, res, tag);
    }

    let account: PasskeyAccount | null;
    try {
      account = await getUserById(req.user.id, '+password');
    } catch (err) {
      logger.error('[requirePasswordConfirmation]', err);
      res.status(500).json({ message: 'Something went wrong' });
      return false;
    }

    if (!account?.password) {
      return allowPasswordless ? true : denyPasswordConfirmation(req, res, tag);
    }

    if (!submitted) {
      return denyPasswordConfirmation(req, res, tag);
    }

    const isMatch = await comparePassword({ password: account.password }, password, {
      compare,
    }).catch((err) => {
      logger.error('[requirePasswordConfirmation]', err);
      return false;
    });

    if (!isMatch) {
      return denyPasswordConfirmation(req, res, tag);
    }

    return true;
  };

  /** Lists the authenticated user's registered passkeys. */
  const listPasskeys: PasskeyHandlers['listPasskeys'] = async (req, res) => {
    if (!requirePasskeysEnabled(res)) {
      return;
    }

    try {
      const passkeys = await findPasskeysByUser(req.user.id);
      return res.status(200).json({ passkeys: passkeys.map(serializePasskey) });
    } catch (err) {
      logger.error('[listPasskeys]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  /** Issues a registration challenge for the authenticated user. */
  const registerPasskeyOptions: PasskeyHandlers['registerPasskeyOptions'] = async (req, res) => {
    const config = requirePasskeysEnabled(res);
    if (!config) {
      return;
    }

    if (!requireLocalAccount(req, res)) {
      return;
    }

    if (!(await requirePasswordConfirmation(req, res, { tag: REGISTRATION_STEP_UP }))) {
      return;
    }

    try {
      const [existingCredentials, maxPasskeys] = await Promise.all([
        findPasskeysByUser(req.user.id),
        resolveMaxPasskeys(req),
      ]);
      if (existingCredentials.length >= maxPasskeys) {
        return res.status(409).json({ message: 'Passkey limit reached' });
      }

      const options = await createPasskeyRegistrationOptions({
        config,
        store: getChallengeStore(),
        user: {
          id: req.user.id,
          email: req.user.email,
          name: req.user.name,
          username: req.user.username,
        },
        existingCredentials,
      });

      return res.status(200).json(options);
    } catch (err) {
      logger.error('[registerPasskeyOptions]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  /**
   * Verifies an attestation and stores the credential against the authenticated user.
   *
   * The step-up is repeated here rather than only on the options step because
   * `createPasskey` is the durable write, and gating only the challenge would leave
   * the write path itself uncontrolled.
   */
  const registerPasskeyVerify: PasskeyHandlers['registerPasskeyVerify'] = async (req, res) => {
    const config = requirePasskeysEnabled(res);
    if (!config) {
      return;
    }

    if (!requireLocalAccount(req, res)) {
      return;
    }

    if (!(await requirePasswordConfirmation(req, res, { tag: REGISTRATION_STEP_UP }))) {
      return;
    }

    try {
      const { credential, name } = req.body ?? {};
      if (!credential || typeof credential !== 'object') {
        return res.status(400).json({ message: 'Missing credential' });
      }

      const [count, maxPasskeys] = await Promise.all([
        countPasskeysByUser(req.user.id),
        resolveMaxPasskeys(req),
      ]);
      if (count >= maxPasskeys) {
        return res.status(409).json({ message: 'Passkey limit reached' });
      }

      const verified = await verifyPasskeyRegistration({
        config,
        store: getChallengeStore(),
        userId: req.user.id,
        response: credential,
      });

      if (!verified) {
        return res.status(400).json({ message: 'Passkey registration could not be verified' });
      }

      if (await findPasskeyByCredentialId(verified.credentialId)) {
        return res.status(409).json({ message: 'This passkey is already registered' });
      }

      const trimmedName = typeof name === 'string' ? name.trim() : '';
      const passkey = await createPasskey({
        user: req.user.id,
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        counter: verified.counter,
        transports: verified.transports,
        deviceType: verified.deviceType,
        backedUp: verified.backedUp,
        name:
          trimmedName.slice(0, MAX_PASSKEY_NAME_LENGTH) || defaultPasskeyName(verified.transports),
      });

      /**
       * The early count check races a concurrent ceremony for the same account:
       * both can observe a below-cap count and both insert. Re-counting after
       * the write and rolling this credential back keeps the stored set within
       * the cap without a transaction, at the cost of rejecting the whole race.
       */
      let countAfterWrite: number;
      try {
        countAfterWrite = await countPasskeysByUser(req.user.id);
      } catch (error) {
        await deletePasskey(passkey.id, req.user.id);
        throw error;
      }
      if (countAfterWrite > maxPasskeys) {
        await deletePasskey(passkey.id, req.user.id);
        return res.status(409).json({ message: 'Passkey limit reached' });
      }

      return res.status(201).json({ passkey: serializePasskey(passkey) });
    } catch (err) {
      if (isDuplicateKeyError(err as MongoWriteError)) {
        return res.status(409).json({ message: 'This passkey is already registered' });
      }
      logger.error('[registerPasskeyVerify]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  /** Renames one of the authenticated user's passkeys. */
  const updatePasskey: PasskeyHandlers['updatePasskey'] = async (req, res) => {
    if (!requirePasskeysEnabled(res)) {
      return;
    }

    try {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) {
        return res.status(400).json({ message: 'Name is required' });
      }

      const passkey = await renamePasskey(
        req.params.passkeyId,
        req.user.id,
        name.slice(0, MAX_PASSKEY_NAME_LENGTH),
      );

      if (!passkey) {
        return res.status(404).json({ message: 'Passkey not found' });
      }

      return res.status(200).json({ passkey: serializePasskey(passkey) });
    } catch (err) {
      logger.error('[updatePasskey]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  /**
   * Removes one of the authenticated user's passkeys.
   *
   * Password-confirmed for the same reason enrollment is: a stolen access token
   * must not be able to strip a login factor the account still depends on.
   *
   * The gate is skipped for an account carrying no password hash. That looks like a
   * hole and is not one. An SSO or LDAP account can never satisfy a password gate,
   * and a passkey enrolled on one before the provider check existed would otherwise
   * be stranded with no UI or API able to remove it. Allowing the removal grants an
   * attacker nothing either: `authenticatePasskey` already refuses a credential
   * whose owner is not a local account, so it is not a usable sign-in factor.
   */
  const removePasskey: PasskeyHandlers['removePasskey'] = async (req, res) => {
    if (!requirePasskeysEnabled(res)) {
      return;
    }

    if (
      !(await requirePasswordConfirmation(req, res, {
        tag: DELETION_STEP_UP,
        allowPasswordless: true,
      }))
    ) {
      return;
    }

    try {
      const result = await deletePasskey(req.params.passkeyId, req.user.id);
      if (!result?.deletedCount) {
        return res.status(404).json({ message: 'Passkey not found' });
      }
      return res.status(200).json({ message: 'Passkey deleted' });
    } catch (err) {
      logger.error('[removePasskey]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  /**
   * Issues an authentication challenge to an anonymous caller. No credential list
   * is returned, so the response is identical whether or not an account exists.
   */
  const loginPasskeyOptions: PasskeyHandlers['loginPasskeyOptions'] = async (_req, res) => {
    const config = requirePasskeysEnabled(res);
    if (!config) {
      return;
    }

    try {
      const { options, sessionId } = await createPasskeyAuthenticationOptions({
        config,
        store: getChallengeStore(),
      });
      return res.status(200).json({ options, sessionId });
    } catch (err) {
      logger.error('[loginPasskeyOptions]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  /**
   * Verifies an assertion and, on success, populates `req.user` with the
   * credential's owner. Handing off to the shared `loginController` keeps passkey
   * sign-in identical to password sign-in for 2FA gating and token issuance.
   */
  const authenticatePasskey: PasskeyHandlers['authenticatePasskey'] = async (req, res, next) => {
    const config = requirePasskeysEnabled(res);
    if (!config) {
      return;
    }

    const failure = (): Response =>
      res.status(401).json({ message: 'Passkey authentication failed' });

    try {
      const { credential, sessionId } = req.body ?? {};
      if (!credential || typeof credential !== 'object' || typeof sessionId !== 'string') {
        return res.status(400).json({ message: 'Missing credential' });
      }

      const passkey = await findPasskeyByCredentialId(credential.id);
      if (!passkey) {
        return failure();
      }

      const userHandle = decodeUserHandle(credential.response?.userHandle);
      if (userHandle && userHandle !== passkey.userId) {
        logger.warn('[authenticatePasskey] User handle does not match the credential owner');
        return failure();
      }

      const result = await verifyPasskeyAuthentication({
        config,
        store: getChallengeStore(),
        sessionId,
        response: credential,
        credential: {
          credentialId: passkey.credentialId,
          publicKey: passkey.publicKey,
          counter: passkey.counter,
          transports: passkey.transports,
        },
      });

      if (!result) {
        return failure();
      }

      const user = await getUserById(passkey.userId);
      if (!user) {
        return failure();
      }

      if (!isLocalAccount(user)) {
        logger.warn(
          '[authenticatePasskey] Rejected a passkey belonging to a non-local account; the identity provider must be used',
        );
        return failure();
      }

      /** Shared with the password strategy so both factors apply one account policy. */
      await grandfatherLegacyEmailVerification({ updateUser }, user);

      const unverifiedAllowed = isEnabled(process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN);
      if (user.expiresAt && unverifiedAllowed) {
        await updateUser(user._id, {});
      }
      if (!user.emailVerified && !unverifiedAllowed) {
        logger.warn('[authenticatePasskey] Rejected unverified email login');
        return failure();
      }

      /**
       * The counter write is the compare-and-swap for clone detection: losing it means
       * another assertion already consumed this counter value, so this one is a replay
       * or a clone even though the signature verified.
       */
      const counterAdvanced = await recordPasskeyUse(
        passkey.credentialId,
        result.newCounter,
        result.backedUp,
      );
      if (!counterAdvanced) {
        logger.warn(
          '[authenticatePasskey] Rejected an assertion that did not advance the signature counter',
        );
        return failure();
      }

      req.user = user;

      /**
       * `checkBan` defaults `next` to a no-op, so calling it bare would swallow an
       * internal failure and leave `req.banned` unset: the request would go on to be
       * issued tokens. Capture the error the middleware chain would have propagated
       * and refuse instead, so a ban check that cannot complete never admits anyone.
       */
      let banError: Error | undefined;
      await checkBan(req, res, (err) => {
        banError = err;
      });
      if (banError) {
        logger.error('[authenticatePasskey] Ban check failed to complete', banError);
        return res.headersSent ? undefined : failure();
      }
      if (req.banned) {
        return;
      }

      return next();
    } catch (err) {
      logger.error('[authenticatePasskey]', err);
      return res.status(500).json({ message: 'Something went wrong' });
    }
  };

  return {
    listPasskeys,
    updatePasskey,
    removePasskey,
    authenticatePasskey,
    loginPasskeyOptions,
    registerPasskeyOptions,
    registerPasskeyVerify,
  };
}
