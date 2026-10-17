import { logger } from '@librechat/data-schemas';
import type { TClientErrorReporting, TCustomConfig } from 'librechat-data-provider';
import { resolveBuildInfo } from '../app/build';

/**
 * Browser error reporting to GlitchTip (Sentry-compatible). The browser receives the same
 * `SENTRY_DSN` the server reports with, through the startup config, and only when
 * `errorReporting.client.enabled` is set in `librechat.yaml`. A DSN is a send-only credential,
 * which is what makes handing it to every visitor acceptable.
 */
export interface ClientErrorReportingOptions {
  config?: TCustomConfig['errorReporting'];
  env?: NodeJS.ProcessEnv;
  /** Release when `SENTRY_RELEASE` is unset; defaults to the build commit. */
  release?: string | null;
}

let warnedInvalidDsn = false;

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * Accepts the DSN shape a Sentry-compatible SDK can send with: `https://<key>@<host>/<project>`,
 * or plain http to localhost for local collectors. A secret key in the DSN is refused, since the
 * browser would publish it.
 */
export function parseClientDsn(raw: string | undefined): URL | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhost(url.hostname));
  if (!secure || !url.username || url.password || !/^\/(?:.+\/)?\d+$/.test(url.pathname)) {
    return undefined;
  }
  return url;
}

function resolveDsn(
  config: TCustomConfig['errorReporting'],
  env: NodeJS.ProcessEnv,
): URL | undefined {
  if (config?.client?.enabled !== true) {
    return undefined;
  }
  const dsn = parseClientDsn(env.SENTRY_DSN);
  if (!dsn && !warnedInvalidDsn) {
    warnedInvalidDsn = true;
    logger.warn(
      '[errorReporting] errorReporting.client.enabled is set but SENTRY_DSN is missing or not a public https DSN; browser error reporting stays off.',
    );
  }
  return dsn;
}

/** The startup-config block the browser initializes from, or `undefined` when reporting is off. */
export function resolveClientErrorReporting({
  config,
  env = process.env,
  release = resolveBuildInfo().commit,
}: ClientErrorReportingOptions): TClientErrorReporting | undefined {
  const dsn = resolveDsn(config, env);
  if (!dsn) {
    return undefined;
  }
  const environment = env.SENTRY_ENVIRONMENT?.trim();
  const resolvedRelease = env.SENTRY_RELEASE?.trim() || release || undefined;
  return {
    dsn: dsn.toString(),
    sampleRate: config?.client?.sampleRate ?? 1,
    ...(environment ? { environment } : {}),
    ...(resolvedRelease ? { release: resolvedRelease } : {}),
  };
}

/** `connect-src` sources the shell's CSP needs for the browser to reach the collector. */
export function clientErrorReportingConnectSources({
  config,
  env = process.env,
}: Omit<ClientErrorReportingOptions, 'release'>): string[] {
  const dsn = resolveDsn(config, env);
  return dsn ? [dsn.origin] : [];
}
