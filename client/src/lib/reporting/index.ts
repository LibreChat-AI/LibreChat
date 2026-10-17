import type { TClientErrorReporting } from 'librechat-data-provider';
import { isChunkLoadError } from '~/lib/assets/recovery';
import { getClientPlatform } from '~/lib/rum/redact';
import { scrubEvent } from './scrub';

type SentryBrowser = typeof import('@sentry/browser');

/**
 * Browser error reporting to GlitchTip (Sentry-compatible), configured by the startup config's
 * `errorReporting` block, which the server sends only when `errorReporting.client.enabled` is on
 * and `SENTRY_DSN` is set. The SDK is fetched only then, so deployments without it pay nothing.
 *
 * Reports uncaught errors and unhandled rejections (global handlers) and every error-boundary
 * crash that goes through `reportBoundaryError`. Every event is rebuilt by `scrubEvent`.
 */
let sentry: SentryBrowser | undefined;
let starting: Promise<void> | undefined;
const reported = new WeakSet<object>();

/** Stale-asset failures after a deploy are expected and recovered by `~/lib/assets`. */
function isExpectedNoise(error: unknown): boolean {
  return isChunkLoadError(error);
}

async function load(config: TClientErrorReporting): Promise<void> {
  const Sentry = await import('@sentry/browser');
  const platform = getClientPlatform(navigator.userAgent);
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    sampleRate: config.sampleRate,
    tracesSampleRate: 0,
    sendClientReports: false,
    /* The default rewrites `Failed to fetch` to name the host, on the live error object too. */
    enhanceFetchErrorMessages: false,
    maxBreadcrumbs: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.globalHandlersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
    ],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    initialScope: { tags: { browser: platform.browser, os: platform.os } },
    beforeSend: (event, hint) =>
      isExpectedNoise(hint.originalException) ? null : scrubEvent(event, window.location.pathname),
  });
  sentry = Sentry;
}

/** Idempotent: the first valid config wins for the life of the page. */
export function startErrorReporting(config: TClientErrorReporting | undefined): Promise<void> {
  if (!config?.dsn || starting) {
    return starting ?? Promise.resolve();
  }
  starting = load(config).catch(() => {
    /* Reporting must never break the app; a failed SDK fetch just leaves it off. */
  });
  return starting;
}

/** Reports an error a React boundary caught. A no-op until reporting has started. */
export function captureBoundaryError(boundary: string, error: unknown): void {
  if (!sentry || isExpectedNoise(error)) {
    return;
  }
  if (typeof error === 'object' && error !== null) {
    if (reported.has(error)) {
      return;
    }
    reported.add(error);
  }
  const Sentry = sentry;
  try {
    Sentry.withScope((scope) => {
      scope.setTag('boundary', boundary);
      Sentry.captureException(error, { mechanism: { type: 'react.boundary', handled: true } });
    });
  } catch {
    /* Reporting must never affect the caller. */
  }
}

export const testExports = {
  reset() {
    sentry = undefined;
    starting = undefined;
  },
};
