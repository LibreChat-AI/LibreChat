import * as Sentry from '@sentry/browser';
import { captureBoundaryError, startErrorReporting, testExports } from './index';

jest.mock('@sentry/browser', () => {
  const scope = { setTag: jest.fn() };
  return {
    init: jest.fn(),
    captureException: jest.fn(),
    withScope: jest.fn((callback: (s: typeof scope) => void) => callback(scope)),
    globalHandlersIntegration: jest.fn(() => ({ name: 'GlobalHandlers' })),
    linkedErrorsIntegration: jest.fn(() => ({ name: 'LinkedErrors' })),
    dedupeIntegration: jest.fn(() => ({ name: 'Dedupe' })),
    eventFiltersIntegration: jest.fn(() => ({ name: 'EventFilters' })),
    functionToStringIntegration: jest.fn(() => ({ name: 'FunctionToString' })),
  };
});

const config = {
  dsn: 'https://key@glitchtip.example.com/5',
  environment: 'dev',
  release: 'abc',
  sampleRate: 1,
};

describe('error reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    testExports.reset();
  });

  it('does nothing without a config', async () => {
    await startErrorReporting(undefined);
    captureBoundaryError('route', new Error('boom'));

    expect(Sentry.init).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('initializes once with no PII collection and no default integrations', async () => {
    await startErrorReporting(config);
    await startErrorReporting({ ...config, dsn: 'https://other@x.example.com/1' });

    expect(Sentry.init).toHaveBeenCalledTimes(1);
    expect(Sentry.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: config.dsn,
        environment: 'dev',
        release: 'abc',
        defaultIntegrations: false,
        maxBreadcrumbs: 0,
        enhanceFetchErrorMessages: false,
        dataCollection: expect.objectContaining({ userInfo: false, cookies: false }),
      }),
    );
  });

  it('drops stale-chunk errors in beforeSend', async () => {
    await startErrorReporting(config);
    const { beforeSend } = (Sentry.init as jest.Mock).mock.calls[0][0];
    const chunkError = new TypeError('Failed to fetch dynamically imported module: /assets/a.js');

    expect(beforeSend({ event_id: 'e' }, { originalException: chunkError })).toBeNull();
    expect(beforeSend({ event_id: 'e', user: { id: 'u' } }, {})).not.toHaveProperty('user');
  });

  it('reports a boundary crash once, tagged with its boundary', async () => {
    await startErrorReporting(config);
    const error = new Error('render failed');

    captureBoundaryError('markdown', error);
    captureBoundaryError('markdown', error);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(error, expect.anything());
  });
});
