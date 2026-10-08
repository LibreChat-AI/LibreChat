import helmet from 'helmet';
import { logger } from '@librechat/data-schemas';

import type { RequestHandler } from 'express';

import { parseEnvSwitch, normalizeEnvValue, isFalsyEnvValue } from './env';

const DEFAULT_HSTS_MAX_AGE = 31536000;

export type FrameOptionsAction = 'deny' | 'sameorigin';
export type OpenerPolicy =
  | 'same-origin'
  | 'same-origin-allow-popups'
  | 'noopener-allow-popups'
  | 'unsafe-none';
export type ResourcePolicy = 'same-origin' | 'same-site' | 'cross-origin';
export type ReferrerPolicyToken =
  | 'no-referrer'
  | 'no-referrer-when-downgrade'
  | 'same-origin'
  | 'origin'
  | 'strict-origin'
  | 'origin-when-cross-origin'
  | 'strict-origin-when-cross-origin'
  | 'unsafe-url';

export interface HstsOptions {
  maxAge: number;
  includeSubDomains: boolean;
  preload: boolean;
}

export interface SecurityHeaderOptions {
  contentSecurityPolicy: false;
  hsts: HstsOptions | false;
  frameguard: { action: FrameOptionsAction } | false;
  crossOriginOpenerPolicy: { policy: OpenerPolicy } | false;
  crossOriginResourcePolicy: { policy: ResourcePolicy } | false;
  referrerPolicy: { policy: ReferrerPolicyToken } | false;
}

const FRAME_ACTIONS = new Set<FrameOptionsAction>(['deny', 'sameorigin']);
const OPENER_POLICIES = new Set<OpenerPolicy>([
  'same-origin',
  'same-origin-allow-popups',
  'noopener-allow-popups',
  'unsafe-none',
]);
const RESOURCE_POLICIES = new Set<ResourcePolicy>(['same-origin', 'same-site', 'cross-origin']);
const REFERRER_TOKENS = new Set<ReferrerPolicyToken>([
  'no-referrer',
  'no-referrer-when-downgrade',
  'same-origin',
  'origin',
  'strict-origin',
  'origin-when-cross-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);

function parseMaxAge(value: string | undefined, fallback: number): number {
  const normalized = normalizeEnvValue(value);
  if (normalized === '') {
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn(`[SecurityHeaders] Ignoring invalid HSTS_MAX_AGE="${value}"; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/**
 * Resolves a header that is either disabled outright or set to one of a fixed
 * set of policy tokens. Returns `false` when the operator disabled it.
 */
function parsePolicy<T extends string>(
  name: string,
  value: string | undefined,
  allowed: ReadonlySet<T>,
  fallback: T,
): T | false {
  const normalized = normalizeEnvValue(value);
  if (normalized === '') {
    return fallback;
  }
  if (isFalsyEnvValue(normalized)) {
    return false;
  }
  if (allowed.has(normalized as T)) {
    return normalized as T;
  }
  logger.warn(`[SecurityHeaders] Ignoring invalid ${name}="${value}"; using "${fallback}".`);
  return fallback;
}

function buildHsts(env: NodeJS.ProcessEnv): HstsOptions | false {
  if (!parseEnvSwitch('HSTS_ENABLED', env.HSTS_ENABLED, true)) {
    return false;
  }
  return {
    maxAge: parseMaxAge(env.HSTS_MAX_AGE, DEFAULT_HSTS_MAX_AGE),
    /* Opt-in rather than helmet's on-by-default: a bare-domain or `chat.example.com`
     * deployment would otherwise pin every sibling subdomain to HTTPS for a year in
     * every visitor's browser, and reversing that means serving `max-age=0` from each
     * affected host. */
    includeSubDomains: parseEnvSwitch(
      'HSTS_INCLUDE_SUBDOMAINS',
      env.HSTS_INCLUDE_SUBDOMAINS,
      false,
    ),
    preload: parseEnvSwitch('HSTS_PRELOAD', env.HSTS_PRELOAD, false),
  };
}

/**
 * Builds helmet options from the environment. CSP is always disabled here so the
 * CSP-independent headers never depend on a directive allow-list staying current
 * with whichever optional features a deployment has enabled.
 */
export function buildSecurityHeaderOptions(
  env: NodeJS.ProcessEnv = process.env,
): SecurityHeaderOptions | null {
  if (!parseEnvSwitch('SECURITY_HEADERS', env.SECURITY_HEADERS, true)) {
    return null;
  }

  const frameAction = parsePolicy(
    'X_FRAME_OPTIONS',
    env.X_FRAME_OPTIONS,
    FRAME_ACTIONS,
    'sameorigin',
  );
  const openerPolicy = parsePolicy(
    'CROSS_ORIGIN_OPENER_POLICY',
    env.CROSS_ORIGIN_OPENER_POLICY,
    OPENER_POLICIES,
    'same-origin',
  );
  const resourcePolicy = parsePolicy(
    'CROSS_ORIGIN_RESOURCE_POLICY',
    env.CROSS_ORIGIN_RESOURCE_POLICY,
    RESOURCE_POLICIES,
    'same-origin',
  );
  const referrerToken = parsePolicy(
    'REFERRER_POLICY',
    env.REFERRER_POLICY,
    REFERRER_TOKENS,
    'no-referrer',
  );

  return {
    contentSecurityPolicy: false,
    hsts: buildHsts(env),
    frameguard: frameAction === false ? false : { action: frameAction },
    crossOriginOpenerPolicy: openerPolicy === false ? false : { policy: openerPolicy },
    crossOriginResourcePolicy: resourcePolicy === false ? false : { policy: resourcePolicy },
    referrerPolicy: referrerToken === false ? false : { policy: referrerToken },
  };
}

/**
 * Creates the baseline security-header middleware, or `null` when the operator
 * disabled it via `SECURITY_HEADERS=false`.
 *
 * @example
 * const securityHeaders = createSecurityHeaders();
 * if (securityHeaders) {
 *   app.use(securityHeaders);
 * }
 */
export function createSecurityHeaders(env: NodeJS.ProcessEnv = process.env): RequestHandler | null {
  const options = buildSecurityHeaderOptions(env);
  if (!options) {
    logger.warn('[SecurityHeaders] Disabled via SECURITY_HEADERS; no baseline headers are set.');
    return null;
  }
  return helmet(options) as RequestHandler;
}
