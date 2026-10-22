import { randomBytes } from 'node:crypto';
import { DEFAULT_OAUTH_STATE_TTL_MS, OPENID_CHECK_RECEIPT } from 'librechat-data-provider';
import type { OpenIDSessionCheckStatus } from 'librechat-data-provider';
import type { RequestHandler, Response } from 'express';
import type { Keyv } from 'keyv';
import type { OpenIDRequest, SessionOpenIDTokens } from '../types';
import type { CheckProof, ProviderCheckResult } from './provider';
import { getOpenIDCheckIdentity, getValidOpenIDReuseCredential } from '../reuseCredential';
import { reloadOpenIDSessionIfPersisted } from '../errors';
import { newOpenIDAuthGeneration } from './generation';
import { normalizeOpenIdIssuer } from '~/auth/openid';
import { TOKEN_PROVIDER_COOKIE } from '~/oauth/csrf';
import { consumeCacheEntry } from '~/cache/consume';
import { isEnabled } from '~/utils/common';

const STATE_PREFIX = 'lc-check.';
const randomToken = () => randomBytes(32).toString('base64url');

type Outcome = Exclude<OpenIDSessionCheckStatus, 'not_required'>;
type CheckRequest = OpenIDRequest & {
  body?: { returnTo?: unknown; receipt?: unknown };
  query?: Record<string, unknown>;
  originalUrl?: string;
  openidLoginGeneration?: string;
};
type Config = { registration?: { openidSessionCheck?: boolean; oauthStateTtlMs?: number } };
type Binding = { sessionId: string; generation: string; issuer: string; subject: string };
type Transaction = Binding & CheckProof & { returnTo: string; createdAt: number };
type Receipt = Binding & { status: Outcome };

export interface OpenIDCheckDependencies {
  cache: Keyv;
  jwtRefreshSecret?: string;
  limiter?: RequestHandler;
  getConfig: () => Promise<Config>;
  clientDomain: string;
  serverDomain: string;
  provider: {
    authorize: (proof: CheckProof) => Promise<string>;
    verify: (url: URL, proof: CheckProof) => Promise<ProviderCheckResult>;
  };
  retire: (req: OpenIDRequest, tokens: SessionOpenIDTokens) => Promise<void>;
  clear: (req: OpenIDRequest, res: Response, tokens: SessionOpenIDTokens) => void;
  observe: (event: { outcome: Outcome | 'stale'; durationMs: number }) => void;
}

export function validateOpenIDSessionCheck(config: Config, env: NodeJS.ProcessEnv): void {
  if (!config.registration?.openidSessionCheck) return;
  const configured =
    isEnabled(env.ALLOW_SOCIAL_LOGIN) &&
    env.OPENID_CLIENT_ID &&
    env.OPENID_ISSUER &&
    env.OPENID_SCOPE &&
    env.OPENID_SESSION_SECRET &&
    env.OPENID_CALLBACK_URL &&
    (isEnabled(env.OPENID_USE_PKCE) || env.OPENID_CLIENT_SECRET?.trim());
  if (!configured || !isEnabled(env.OPENID_REUSE_TOKENS)) {
    throw new Error(
      'registration.openidSessionCheck requires enabled OpenID authentication and OPENID_REUSE_TOKENS=true',
    );
  }
}

function isOpenIDBrowser(req: CheckRequest): boolean {
  const provider = req.cookies?.[TOKEN_PROVIDER_COOKIE];
  return provider ? provider === 'openid' : req.session?.openidTokens != null;
}

function binding(req: CheckRequest): Binding | undefined {
  if (!req.openidLoginGeneration && !isOpenIDBrowser(req)) return;
  const tokens = req.session?.openidTokens;
  if (
    !req.sessionID ||
    !tokens?.authGenerationId ||
    !tokens.openidIssuer ||
    !tokens.openidSubject
  ) {
    return;
  }
  return {
    sessionId: req.sessionID,
    generation: tokens.authGenerationId,
    issuer: tokens.openidIssuer,
    subject: tokens.openidSubject,
  };
}

function matches(req: CheckRequest, captured: Binding, secret?: string): boolean {
  const current = binding(req);
  if (req.cookies?.openid_user_id) {
    const browserIdentity = req.cookies.refreshToken
      ? getValidOpenIDReuseCredential(req.cookies, secret, req.cookies.refreshToken)
      : null;
    if (
      !browserIdentity ||
      browserIdentity.authGenerationId !== captured.generation ||
      browserIdentity.userId !== req.session?.openidTokens?.appUserId ||
      (browserIdentity.openidIssuer != null && browserIdentity.openidIssuer !== captured.issuer) ||
      (browserIdentity.openidSubject != null && browserIdentity.openidSubject !== captured.subject)
    )
      return false;
  }
  return (
    current != null &&
    current.sessionId === captured.sessionId &&
    current.generation === captured.generation &&
    current.issuer === captured.issuer &&
    current.subject === captured.subject
  );
}

function safeReturnTo(value: unknown, clientDomain: string): string {
  const base = new URL(`${clientDomain.replace(/\/$/, '')}/`);
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return base.href;
  }
  const target = new URL(value, base);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    return base.href;
  }
  target.searchParams.delete(OPENID_CHECK_RECEIPT);
  return target.href;
}

async function save(req: CheckRequest): Promise<void> {
  if (!req.session?.save) throw new Error('OpenID session is unavailable');
  await new Promise<void>((resolve, reject) =>
    req.session!.save!((error) => (error ? reject(error) : resolve())),
  );
}

/** Check callbacks use their own transactions, never Passport's pending-login slot. */
export interface OpenIDSessionCheckService {
  start: RequestHandler;
  callback: RequestHandler;
  complete: RequestHandler;
  prepareLogin: RequestHandler;
  finishLogin(req: CheckRequest, res: Response, redirectUri: string): Promise<void>;
}

export function createOpenIDSessionCheck(deps: OpenIDCheckDependencies): OpenIDSessionCheckService {
  const ttl = (config: Config) =>
    config.registration?.oauthStateTtlMs ?? DEFAULT_OAUTH_STATE_TTL_MS;
  const result = (res: Response, status: Outcome | 'not_required', code = 200) =>
    res.status(code).set('Cache-Control', 'no-store').json({ status });

  async function receipt(req: CheckRequest, status: Outcome, returnTo: string, maxAge: number) {
    const captured = binding(req);
    if (!captured) throw new Error('OpenID session identity is unavailable');
    const code = randomToken();
    await deps.cache.set(`receipt:${code}`, { ...captured, status } satisfies Receipt, maxAge);
    const target = new URL(returnTo);
    target.searchParams.set(OPENID_CHECK_RECEIPT, code);
    return target.href;
  }

  const start: RequestHandler = async (request, res) => {
    const req = request as CheckRequest;
    try {
      const config = await deps.getConfig();
      if (!config.registration?.openidSessionCheck) return void result(res, 'not_required');
      if (!isOpenIDBrowser(req)) return void result(res, 'not_required');
      if (req.session && !req.session.openidTokens) {
        const identity = getOpenIDCheckIdentity(req.cookies ?? {}, deps.jwtRefreshSecret);
        if (!identity) return void result(res, 'login_required');
        req.session.openidTokens = identity;
        await save(req);
      }
      const captured = binding(req);
      if (!captured) return void result(res, 'login_required');
      const state = `${STATE_PREFIX}${randomToken()}`;
      const transaction: Transaction = {
        ...captured,
        state,
        verifier: randomToken(),
        nonce: randomToken(),
        returnTo: safeReturnTo(req.body?.returnTo, deps.clientDomain),
        createdAt: Date.now(),
      };
      await deps.cache.set(`transaction:${state}`, transaction, ttl(config));
      const authorizationUrl = await deps.provider.authorize(transaction);
      res.set('Cache-Control', 'no-store').json({ status: 'redirect', authorizationUrl });
    } catch {
      deps.observe({ outcome: 'unavailable', durationMs: 0 });
      result(res, 'unavailable', 503);
    }
  };

  const rejectCallback = (res: Response) => {
    const target = new URL(deps.clientDomain);
    target.searchParams.set(OPENID_CHECK_RECEIPT, 'invalid');
    res.redirect(target.href);
  };

  const callback: RequestHandler = async (request, res, next) => {
    const req = request as CheckRequest;
    const state = req.query?.state;
    if (typeof state !== 'string' || !state.startsWith(STATE_PREFIX)) return next();
    res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
    try {
      const config = await deps.getConfig();
      if (!config.registration?.openidSessionCheck) return void rejectCallback(res);
      const transaction = await deps.cache.get<Transaction>(`transaction:${state}`);
      if (!transaction || transaction.sessionId !== req.sessionID) return void rejectCallback(res);
      const consumed = await consumeCacheEntry<Transaction>(deps.cache, `transaction:${state}`);
      if (!consumed) return void rejectCallback(res);
      const restored = await reloadOpenIDSessionIfPersisted(req.session);
      if (!restored || !matches(req, consumed, deps.jwtRefreshSecret))
        return void rejectCallback(res);
      let status: Outcome;
      try {
        const checked = await deps.provider.verify(
          new URL(req.originalUrl!, deps.serverDomain),
          consumed,
        );
        if (checked.status === 'verified') {
          const sameIdentity =
            normalizeOpenIdIssuer(checked.identity.iss) ===
              normalizeOpenIdIssuer(consumed.issuer) && checked.identity.sub === consumed.subject;
          status = sameIdentity ? 'verified' : 'login_required';
        } else {
          status = checked.status;
        }
      } catch {
        status = 'unavailable';
      }
      const current = await reloadOpenIDSessionIfPersisted(req.session);
      if (!current || !matches(req, consumed, deps.jwtRefreshSecret))
        return void rejectCallback(res);
      deps.observe({ outcome: status, durationMs: Date.now() - consumed.createdAt });
      res.redirect(await receipt(req, status, consumed.returnTo, ttl(config)));
    } catch {
      deps.observe({ outcome: 'unavailable', durationMs: 0 });
      rejectCallback(res);
    }
  };

  const complete: RequestHandler = async (request, res) => {
    const req = request as CheckRequest;
    try {
      const code = req.body?.receipt;
      if (typeof code !== 'string' || !/^[\w-]{43}$/.test(code))
        return void result(res, 'unavailable', 400);
      const stored = await deps.cache.get<Receipt>(`receipt:${code}`);
      if (!stored || stored.sessionId !== req.sessionID)
        return void result(res, 'unavailable', 400);
      const consumed = await consumeCacheEntry<Receipt>(deps.cache, `receipt:${code}`);
      if (!consumed) return void result(res, 'unavailable', 400);
      const restored = await reloadOpenIDSessionIfPersisted(req.session);
      if (!restored || !matches(req, consumed, deps.jwtRefreshSecret))
        return void result(res, 'unavailable', 409);
      if (consumed.status === 'login_required') {
        const tokens = { ...req.session!.openidTokens! };
        await deps.retire(req, tokens);
        const current = await reloadOpenIDSessionIfPersisted(req.session);
        if (!current || !matches(req, consumed, deps.jwtRefreshSecret))
          return void result(res, 'unavailable', 409);
        deps.clear(req, res, tokens);
        await save(req);
      }
      result(res, consumed.status);
    } catch {
      deps.observe({ outcome: 'unavailable', durationMs: 0 });
      result(res, 'unavailable', 503);
    }
  };

  const prepareLogin: RequestHandler = async (request, _res, next) => {
    const req = request as CheckRequest;
    try {
      if ((await deps.getConfig()).registration?.openidSessionCheck)
        req.openidLoginGeneration = newOpenIDAuthGeneration(req);
      next();
    } catch (error) {
      next(error);
    }
  };

  async function finishLogin(req: CheckRequest, res: Response, redirectUri: string): Promise<void> {
    if (!req.openidLoginGeneration || !binding(req)) {
      res.redirect(redirectUri);
      return;
    }
    await save(req);
    const destination = new URL(redirectUri);
    const config = await deps.getConfig();
    res.redirect(
      await receipt(
        req,
        'verified',
        safeReturnTo(
          destination.pathname + destination.search + destination.hash,
          deps.clientDomain,
        ),
        ttl(config),
      ),
    );
  }

  const limited =
    (handler: RequestHandler): RequestHandler =>
    (req, res, next) => {
      if (!deps.limiter) return handler(req, res, next);
      return deps.limiter(req, res, (error) => (error ? next(error) : handler(req, res, next)));
    };
  const limitedCallback = limited(callback);
  const dispatch: RequestHandler = (req, res, next) => {
    if (typeof req.query.state !== 'string' || !req.query.state.startsWith(STATE_PREFIX))
      return next();
    return limitedCallback(req, res, next);
  };
  return {
    start: limited(start),
    callback: dispatch,
    complete: limited(complete),
    prepareLogin,
    finishLogin,
  };
}
