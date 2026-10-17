type SentryNode = typeof import('@sentry/node');

/**
 * Server error reporting to GlitchTip (Sentry-compatible), TensorGrid's project `tchat` at
 * https://glitchtip.tensorgrid.space. Off unless `SENTRY_DSN` is set, so local runs and tests
 * send nothing.
 *
 * Only errors are reported. Tracing stays with the existing OpenTelemetry setup
 * (`src/telemetry`): Sentry registers no tracer provider and no load-time module hooks, and its
 * default integrations are replaced by passive ones, so it never installs process handlers that
 * would change how `api/server/index.js` treats uncaught errors.
 *
 * Privacy: no user info, cookies, headers, bodies or query strings. Conversations and provider
 * keys travel in exactly those places.
 *
 * `@sentry/node` is loaded only once a DSN is set. Importing it runs `promisify(fs.readFile)`,
 * which throws in every spec that mocks `fs` and loads `@librechat/api`.
 */
export interface ErrorReportingContext {
  /** Where the error surfaced, e.g. `express`, `uncaughtException`. */
  source: string;
  /** Request path without the query string, when the error belongs to a request. */
  path?: string;
}

let sentry: SentryNode | undefined;

export function initErrorReporting(env: NodeJS.ProcessEnv = process.env): boolean {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy: see module note
  const Sentry = require('@sentry/node') as SentryNode;
  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || undefined,
    release: env.SENTRY_RELEASE?.trim() || env.npm_package_version,
    serverName: env.SENTRY_SERVER_NAME?.trim() || 'tchat-api',
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.contextLinesIntegration(),
      Sentry.nodeContextIntegration(),
    ],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
  });
  sentry = Sentry;
  return true;
}

/** Reports an error that reached a boundary (request, process). A no-op when reporting is off. */
export function reportError(error: unknown, context: ErrorReportingContext): void {
  if (!sentry) {
    return;
  }
  const Sentry = sentry;
  Sentry.withScope((scope) => {
    scope.setTag('source', context.source);
    if (context.path) {
      scope.setTag('path', context.path.split('?')[0]);
    }
    Sentry.captureException(error);
  });
}
