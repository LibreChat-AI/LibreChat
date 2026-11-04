import express from 'express';
import { rateLimit } from 'express-rate-limit';
import {
  DEFAULT_OPENID_BACKCHANNEL_LOGOUT_DEADLINE_MS,
  DEFAULT_OPENID_BACKCHANNEL_LOGOUT_RATE_LIMIT_IP_MAX,
  DEFAULT_OPENID_BACKCHANNEL_LOGOUT_RATE_LIMIT_IP_WINDOW_MINUTES,
} from 'librechat-data-provider';
import type { OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type { Store } from 'express-rate-limit';
import type { BackchannelLogoutToken, BackchannelLogoutVerifier } from './token';
import type { OpenIDLogger } from '../types';
import { getSafeErrorMetadata } from '~/utils/errors';

export const BACKCHANNEL_LOGOUT_MAX_BODY_BYTES: number = 8 * 1024;

export type BackchannelLogoutReceiverMethods = Pick<
  OpenIDAuthorizationMethods,
  | 'recordOpenIDLogoutEvent'
  | 'markOpenIDLogoutEventEnforced'
  | 'upsertOpenIDSubjectBoundary'
  | 'recordOpenIDLogout'
>;

export interface BackchannelLogoutReceiverConfig {
  enabled: boolean;
  /** Must stay under Auth0's 5-second delivery timeout. */
  deadlineMs?: number;
  /** Omitted, an enforced event's `expiresAt` is left unset and it never expires. */
  logoutEventRetentionMs?: number;
}

export interface BackchannelLogoutReceiverDeps {
  methods: BackchannelLogoutReceiverMethods;
  verifier: BackchannelLogoutVerifier;
  config: BackchannelLogoutReceiverConfig;
  logger: Pick<OpenIDLogger, 'error' | 'warn'>;
  clock?: () => Date;
}

const DEADLINE_EXCEEDED = Symbol('openid-backchannel-logout-deadline-exceeded');

function extractLogoutToken(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const token = (body as Record<string, unknown>).logout_token;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/** Finishes step 2 for one token; idempotent, so a resumed or duplicate delivery replays it safely. */
async function enforceLogoutEvent(
  methods: BackchannelLogoutReceiverMethods,
  token: BackchannelLogoutToken,
  revokedAt: Date,
  retentionMs: number | undefined,
): Promise<void> {
  await methods.upsertOpenIDSubjectBoundary({
    issuer: token.issuer,
    clientId: token.clientId,
    subject: token.subject,
    boundaryIat: token.iat,
  });
  if (token.sid) {
    await methods.recordOpenIDLogout({
      issuer: token.issuer,
      clientId: token.clientId,
      subject: token.subject,
      sid: token.sid,
      revokedAt,
    });
  }
  await methods.markOpenIDLogoutEventEnforced({
    issuer: token.issuer,
    clientId: token.clientId,
    jti: token.jti,
    expiresAt: retentionMs ? new Date(revokedAt.getTime() + retentionMs) : undefined,
  });
}

/** Express body-parser for the one form field Auth0 posts; the route mounts it before this handler. */
export function createBackchannelLogoutBodyParser(
  maxBodyBytes: number = BACKCHANNEL_LOGOUT_MAX_BODY_BYTES,
): RequestHandler {
  return express.urlencoded({ extended: false, limit: maxBodyBytes });
}

export interface BackchannelLogoutRateLimitConfig {
  ipMax?: number;
  ipWindowInMinutes?: number;
}

export interface BackchannelLogoutRateLimitDeps {
  removePorts: (req: Request) => string | undefined;
  store?: Store;
}

/** IP-bounded limiter; the route carries no session, so there is no user to key on. */
export function createBackchannelLogoutRateLimiter(
  deps: BackchannelLogoutRateLimitDeps,
  config: BackchannelLogoutRateLimitConfig = {},
): RequestHandler {
  const windowMs =
    (config.ipWindowInMinutes ?? DEFAULT_OPENID_BACKCHANNEL_LOGOUT_RATE_LIMIT_IP_WINDOW_MINUTES) *
    60 *
    1000;
  return rateLimit({
    windowMs,
    limit: config.ipMax ?? DEFAULT_OPENID_BACKCHANNEL_LOGOUT_RATE_LIMIT_IP_MAX,
    keyGenerator: deps.removePorts as (req: Request) => string,
    store: deps.store,
    handler: (_req, res) => {
      res.status(429).end();
    },
  });
}

/** Factory for `POST /oauth/openid/backchannel-logout`; never logs the raw token. */
export function createBackchannelLogoutReceiver(
  deps: BackchannelLogoutReceiverDeps,
): RequestHandler {
  const { methods, verifier, config, logger, clock = () => new Date() } = deps;
  const deadlineMs = Math.min(
    config.deadlineMs ?? DEFAULT_OPENID_BACKCHANNEL_LOGOUT_DEADLINE_MS,
    4_999,
  );

  async function process(logoutToken: string): Promise<boolean> {
    const result = await verifier(logoutToken);
    if (!result.ok) {
      logger.warn('[openid:backchannelLogout] Rejected a logout token', { code: result.code });
      return false;
    }
    const recorded = await methods.recordOpenIDLogoutEvent({
      issuer: result.token.issuer,
      clientId: result.token.clientId,
      subject: result.token.subject,
      sid: result.token.sid,
      boundaryIat: result.token.iat,
      jti: result.token.jti,
      receivedAt: clock(),
    });
    if (recorded.event.state !== 'enforced') {
      /** Replays from the stored event, not the token just verified: a duplicate still in
       *  `received` must resume the first delivery's data, not this delivery's. */
      await enforceLogoutEvent(
        methods,
        {
          issuer: recorded.event.issuer,
          clientId: recorded.event.clientId,
          subject: recorded.event.subject,
          sid: recorded.event.sid,
          jti: recorded.event.jti,
          iat: recorded.event.boundaryIat,
        },
        recorded.event.receivedAt,
        config.logoutEventRetentionMs,
      );
    }
    return true;
  }

  return async function backchannelLogoutReceiver(req: Request, res: Response): Promise<void> {
    if (!config.enabled) {
      res.status(404).end();
      return;
    }

    const logoutToken = extractLogoutToken(req.body);
    if (!logoutToken) {
      res.status(400).end();
      return;
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    const deadline = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
      deadlineTimer = setTimeout(() => resolve(DEADLINE_EXCEEDED), deadlineMs);
      deadlineTimer.unref?.();
    });

    try {
      const outcome = await Promise.race([process(logoutToken), deadline]);
      clearTimeout(deadlineTimer);
      if (outcome === DEADLINE_EXCEEDED) {
        logger.error('[openid:backchannelLogout] Deadline exceeded processing a logout token');
        res.status(500).end();
        return;
      }
      res.status(outcome ? 200 : 400).end();
    } catch (error) {
      clearTimeout(deadlineTimer);
      logger.error(
        '[openid:backchannelLogout] Failed to record a logout event',
        getSafeErrorMetadata(error),
      );
      res.status(500).end();
    }
  };
}
