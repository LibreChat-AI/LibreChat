import crypto from 'crypto';
import { logger } from '@librechat/data-schemas';
import { SystemRoles } from 'librechat-data-provider';
import type {
  AppConfig,
  UserRecord,
  NewUserData,
  BalanceConfig,
  CreateUserIfAbsentResult,
} from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { EmbedApp } from './apps';
import { sanitizeUserForAuthResponse } from '~/auth/localRefresh';
import { verifyEmbedToken } from './token';
import { resolveEmbedApps } from './apps';

/** The provider every embed-provisioned account carries. */
export const EMBED_PROVIDER = 'embed';

/** The cache the session handler records consumed token ids in; entries expire with the token. */
export interface EmbedReplayStore {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: true, ttl: number) => Promise<unknown>;
}

export interface EmbedSessionDependencies {
  /** The deployment's base config, which carries the `embed` section. */
  getAppConfig: () => Promise<AppConfig>;
  findUser: (fields: Record<string, string>) => Promise<UserRecord | null>;
  createUserIfAbsent: (
    data: NewUserData,
    balanceConfig?: BalanceConfig,
  ) => Promise<CreateUserIfAbsentResult>;
  getBalanceConfig: (appConfig: AppConfig) => BalanceConfig | null | undefined;
  /** Mints the LibreChat access token (`expiresIn` in milliseconds). */
  generateToken: (user: UserRecord, expiresIn: number) => Promise<string>;
  replayStore: EmbedReplayStore;
}

export type EmbedSessionErrorCode =
  | 'embed_disabled'
  | 'invalid_request'
  | 'unknown_app'
  | 'origin_not_allowed'
  | 'invalid_token'
  | 'token_lifetime_too_long'
  | 'token_replayed'
  | 'identity_conflict'
  | 'embed_session_failed';

const ERROR_STATUS: Record<EmbedSessionErrorCode, number> = {
  embed_disabled: 404,
  invalid_request: 400,
  unknown_app: 403,
  origin_not_allowed: 403,
  invalid_token: 401,
  token_lifetime_too_long: 401,
  token_replayed: 401,
  identity_conflict: 409,
  embed_session_failed: 500,
};

const MAX_TOKEN_LENGTH = 8192;

interface EmbedSessionBody {
  app?: unknown;
  token?: unknown;
  origin?: unknown;
}

/**
 * The account an embed identity maps to: one per app and host user id. The email is derived
 * from both and uses the reserved `.invalid` domain, so the unique email index makes the account
 * one per identity and it can never collide with, or be merged into, a real user's account.
 */
export function getEmbedAccountKeys(
  appId: string,
  subject: string,
): { identity: string; email: string } {
  const identity = `${appId}:${subject}`;
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return { identity, email: `${digest}@${appId}.embed.invalid` };
}

const isEmbedAccount = (user: UserRecord, identity: string) =>
  user.provider === EMBED_PROVIDER && user.idOnTheSource === identity;

const appsByConfig = new WeakMap<object, Map<string, EmbedApp>>();

/** Resolves the apps once per loaded config instead of on every session request. */
function getEmbedApps(appConfig: AppConfig): Map<string, EmbedApp> {
  const embed = appConfig.embed;
  if (!embed) {
    return new Map();
  }
  let apps = appsByConfig.get(embed);
  if (!apps) {
    apps = resolveEmbedApps(embed);
    appsByConfig.set(embed, apps);
  }
  return apps;
}

type AccountResult =
  | { ok: true; value: UserRecord }
  | { ok: false; error: { code: 'identity_conflict' } };

async function findOrCreateEmbedAccount(
  deps: EmbedSessionDependencies,
  appConfig: AppConfig,
  app: EmbedApp,
  subject: string,
  name: string | undefined,
): Promise<AccountResult> {
  const { identity, email } = getEmbedAccountKeys(app.id, subject);
  const existing = await deps.findUser({ email });
  if (existing) {
    return isEmbedAccount(existing, identity)
      ? { ok: true, value: existing }
      : { ok: false, error: { code: 'identity_conflict' } };
  }

  const created = await deps.createUserIfAbsent(
    {
      email,
      emailVerified: true,
      provider: EMBED_PROVIDER,
      idOnTheSource: identity,
      name: name ?? subject,
      username: '',
      role: app.role ?? SystemRoles.USER,
    },
    deps.getBalanceConfig(appConfig) ?? undefined,
  );
  if (created.ok) {
    return created;
  }

  /** A concurrent first session for the same identity won the insert. */
  const winner = await deps.findUser({ email });
  if (winner && isEmbedAccount(winner, identity)) {
    return { ok: true, value: winner };
  }
  return { ok: false, error: { code: 'identity_conflict' } };
}

const sendError = (res: Response, code: EmbedSessionErrorCode): Response =>
  res.status(ERROR_STATUS[code]).json({ code });

/**
 * `POST /api/embed/session`: exchanges a host-signed token for a LibreChat access token.
 *
 * The framed client posts `{ app, token, origin }`, where `origin` is the host page that handed
 * it the token. The handler checks the origin against the app's allow-list, verifies the token,
 * refuses a token id it has already accepted, then finds or creates the embed account and
 * returns `{ token, user, expiresAt }`, the shape of a refresh response. No cookie is set: the
 * framed client keeps the token in memory and asks its host for a new one before it expires.
 */
export function createEmbedSessionHandler(
  deps: EmbedSessionDependencies,
): (req: Request, res: Response) => Promise<Response> {
  return async (req: Request, res: Response) => {
    try {
      const appConfig = await deps.getAppConfig();
      const apps = getEmbedApps(appConfig);
      if (apps.size === 0) {
        return sendError(res, 'embed_disabled');
      }

      const { app: appId, token, origin } = (req.body ?? {}) as EmbedSessionBody;
      if (
        typeof appId !== 'string' ||
        typeof origin !== 'string' ||
        typeof token !== 'string' ||
        token.length === 0 ||
        token.length > MAX_TOKEN_LENGTH
      ) {
        return sendError(res, 'invalid_request');
      }

      const app = apps.get(appId);
      if (!app) {
        return sendError(res, 'unknown_app');
      }
      if (!app.allowedOrigins.includes(origin)) {
        return sendError(res, 'origin_not_allowed');
      }

      const verified = verifyEmbedToken(token, app);
      if (!verified.ok) {
        return sendError(res, verified.error.code);
      }

      const { subject, name, jti, expiresAt } = verified.value;
      const replayKey = `${app.id}:${jti}`;
      if (await deps.replayStore.get(replayKey)) {
        return sendError(res, 'token_replayed');
      }
      await deps.replayStore.set(replayKey, true, Math.max(expiresAt - Date.now(), 0) + 60_000);

      const account = await findOrCreateEmbedAccount(deps, appConfig, app, subject, name);
      if (!account.ok) {
        logger.warn(`[embed] Identity conflict for embed app "${app.id}"; no session issued.`);
        return sendError(res, account.error.code);
      }

      const sessionMs = app.sessionSeconds * 1000;
      const accessToken = await deps.generateToken(account.value, sessionMs);
      return res.status(200).json({
        token: accessToken,
        user: sanitizeUserForAuthResponse(account.value),
        expiresAt: Date.now() + sessionMs,
      });
    } catch (error) {
      logger.error('[embed] Failed to issue an embed session', error);
      return sendError(res, 'embed_session_failed');
    }
  };
}
