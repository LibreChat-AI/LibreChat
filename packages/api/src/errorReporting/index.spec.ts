import * as Sentry from '@sentry/node';
import { initErrorReporting, reportError } from './index';

jest.mock('@sentry/node', () => {
  const scope = { setTag: jest.fn() };
  return {
    init: jest.fn(),
    captureException: jest.fn(),
    withScope: jest.fn((fn: (s: typeof scope) => void) => fn(scope)),
    eventFiltersIntegration: jest.fn(),
    functionToStringIntegration: jest.fn(),
    linkedErrorsIntegration: jest.fn(),
    dedupeIntegration: jest.fn(),
    contextLinesIntegration: jest.fn(),
    nodeContextIntegration: jest.fn(),
    __scope: scope,
  };
});

const scope = (Sentry as unknown as { __scope: { setTag: jest.Mock } }).__scope;

describe('errorReporting', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stays off without a DSN, and reporting is then a no-op', () => {
    expect(initErrorReporting({ SENTRY_DSN: '  ' })).toBe(false);
    reportError(new Error('boom'), { source: 'express' });

    expect(Sentry.init).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('starts without tracing, process hooks or collected request data, then reports', () => {
    expect(
      initErrorReporting({
        SENTRY_DSN: 'https://k@glitchtip.example/5',
        SENTRY_ENVIRONMENT: 'production',
      }),
    ).toBe(true);

    const options = (Sentry.init as jest.Mock).mock.calls[0][0];
    expect(options).toMatchObject({
      dsn: 'https://k@glitchtip.example/5',
      environment: 'production',
      serverName: 'tchat-api',
      enableOpenTelemetrySetup: false,
      enableRuntimeChannelInjection: false,
      tracesSampleRate: 0,
      defaultIntegrations: false,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
    });

    const error = new Error('boom');
    reportError(error, { source: 'express', path: '/api/convos/abc?token=secret' });
    expect(scope.setTag).toHaveBeenCalledWith('source', 'express');
    expect(scope.setTag).toHaveBeenCalledWith('path', '/api/convos/abc');
    expect(Sentry.captureException).toHaveBeenCalledWith(error);
  });
});
