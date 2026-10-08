import type { FCPMetricWithAttribution } from 'web-vitals/attribution';
import {
  discardEarlyRumQueue,
  flushEarlyRumQueue,
  queueSpaRouteChange,
  registerFcpAttribution,
  restoreRumEmitter,
  testExports,
  forwardQueuedAssetEvents,
} from './diagnostics';
import {
  startClientLogs,
  stopClientLogs,
  reportBoundaryError,
  testExports as logTestExports,
} from './logs';

const mockOnFCP = jest.fn();

jest.mock('web-vitals/attribution', () => ({
  onFCP: (...args: unknown[]) => mockOnFCP(...args),
}));

describe('rum diagnostics', () => {
  const addAction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    testExports.resetDiagnosticsState();
    window.history.replaceState({}, '', '/c/65a5e0a7d1c2b3a4f5e6d789?token=secret#hash');
    window.__lcRumQueue = undefined;
    window.__lcRumPush = undefined;
    sessionStorage.clear();
    jest.spyOn(performance, 'now').mockReturnValue(1234.4);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('flushes early queued lifecycle events once', () => {
    window.__lcRumQueue = [
      {
        type: 'sw-controller',
        at: 2.2,
        visibilityState: 'hidden',
        attributes: {
          scriptPath: '/service-worker.js',
          fullUrl: 'https://example.com/c/secret',
          ignored: { nested: true },
        },
      },
    ];

    flushEarlyRumQueue({ addAction });
    flushEarlyRumQueue({ addAction });

    expect(addAction).toHaveBeenCalledTimes(1);
    expect(addAction).toHaveBeenCalledWith('early-sw-controller', {
      clientBuildId: 'unknown',
      at: 2,
      visibilityState: 'hidden',
      scriptPath: '/service-worker.js',
      fullPath: '/c/:conversationId',
    });
    expect(window.__lcRumQueue).toEqual([]);
  });

  it('routes SPA changes through the early RUM queue', () => {
    window.__lcRumPush = jest.fn();

    queueSpaRouteChange('/login', '/c/65a5e0a7d1c2b3a4f5e6d789');

    expect(window.__lcRumPush).toHaveBeenCalledWith('spa-route-change', {
      fromPath: '/login',
      toPath: '/c/:conversationId',
      pageElapsedMs: 1234,
    });
  });

  it('emits queued SPA route changes without an early prefix', () => {
    window.__lcRumQueue = [
      {
        type: 'spa-route-change',
        at: 1234.4,
        visibilityState: 'visible',
        attributes: {
          fromPath: '/login?token=secret',
          toPath: '/c/65a5e0a7d1c2b3a4f5e6d789',
        },
      },
    ];

    flushEarlyRumQueue({ addAction });

    expect(addAction).toHaveBeenCalledWith('spa-route-change', {
      clientBuildId: 'unknown',
      fromPath: '/login',
      toPath: '/c/:conversationId',
      at: 1234,
      visibilityState: 'visible',
    });
  });

  it('keeps post-flush queue pushes non-throwing when HyperDX rejects an action', () => {
    const throwingAddAction = jest.fn(() => {
      throw new Error('sdk failure');
    });

    flushEarlyRumQueue({ addAction: throwingAddAction });

    expect(() => window.__lcRumPush?.('stale-asset-recovery-start')).not.toThrow();
    expect(throwingAddAction).toHaveBeenCalledWith(
      'early-stale-asset-recovery-start',
      expect.any(Object),
    );
  });

  it('discards persisted early RUM when the page is not sampled', () => {
    window.__lcRumQueue = [
      {
        type: 'asset-load-error',
        attributes: { tagName: 'SCRIPT' },
      },
    ];
    window.__lcRumPush = jest.fn();
    sessionStorage.setItem('lc-rum-queue', JSON.stringify(window.__lcRumQueue));

    discardEarlyRumQueue();
    window.__lcRumPush?.('spa-route-change', { fromPath: '/login', toPath: '/c/new' });

    expect(window.__lcRumQueue).toEqual([]);
    expect(sessionStorage.getItem('lc-rum-queue')).toBeNull();
  });

  it('restores the HyperDX-backed emitter after the early queue was discarded', () => {
    window.__lcRumQueue = [];
    discardEarlyRumQueue();

    restoreRumEmitter({ addAction });
    window.__lcRumPush?.('spa-route-change', { fromPath: '/login', toPath: '/c/new' });

    expect(addAction).toHaveBeenCalledWith(
      'spa-route-change',
      expect.objectContaining({
        fromPath: '/login',
        toPath: '/c/new',
      }),
    );
  });

  it('builds FCP attribution from web-vitals attribution metrics', () => {
    const metric = {
      name: 'FCP',
      value: 11568.4,
      rating: 'poor',
      delta: 11568.4,
      id: 'v1-123',
      navigationType: 'navigate',
      entries: [],
      attribution: {
        timeToFirstByte: 10955.4,
        firstByteToFCP: 613,
        loadState: 'complete',
        fcpEntry: { startTime: 11568.4 },
        navigationEntry: {
          name: 'https://example.com/c/new?orgId=secret',
          type: 'navigate',
          redirectCount: 0,
          workerStart: 300,
          fetchStart: 10866,
          requestStart: 10870,
          responseStart: 10955,
          responseEnd: 10956,
          activationStart: 0,
        },
      },
    } as unknown as FCPMetricWithAttribution;

    expect(testExports.fcpAttributes(metric, '/c/:conversationId')).toEqual(
      expect.objectContaining({
        currentPath: '/c/:conversationId',
        currentRoute: '/c/:conversationId',
        fcp: 11568,
        fcpEntryStart: 11568,
        timeToFirstByte: 10955,
        firstByteToFCP: 613,
        loadState: 'complete',
        navigationType: 'navigate',
        initialPath: '/c/new',
        workerStart: 300,
        fetchStart: 10866,
        responseStart: 10955,
      }),
    );
  });

  it('emits one page-load diagnostic action from FCP attribution', async () => {
    const metric = {
      name: 'FCP',
      value: 12000.2,
      rating: 'poor',
      delta: 12000.2,
      id: 'v1-123',
      navigationType: 'navigate',
      entries: [],
      attribution: {
        timeToFirstByte: 11000.2,
        firstByteToFCP: 1000,
        loadState: 'complete',
        fcpEntry: { startTime: 12000.2 },
        navigationEntry: {
          name: 'https://example.com/c/new',
          type: 'navigate',
          fetchStart: 10866,
          responseStart: 11000,
        },
      },
    } as unknown as FCPMetricWithAttribution;

    await registerFcpAttribution({ addAction }, () => '/c/new');
    mockOnFCP.mock.calls[0][0](metric);

    expect(addAction).toHaveBeenCalledTimes(1);
    expect(addAction).toHaveBeenCalledWith(
      'page-load-diagnostics',
      expect.objectContaining({
        currentRoute: '/c/new',
        fcp: 12000,
        firstByteToFCP: 1000,
        fetchStart: 10866,
        initialPath: '/c/new',
        responseStart: 11000,
      }),
    );
  });

  it('allows FCP attribution registration to retry after registration failures', async () => {
    mockOnFCP.mockImplementationOnce(() => {
      throw new Error('registration failed');
    });

    await registerFcpAttribution({ addAction }, () => '/c/new');
    await registerFcpAttribution({ addAction }, () => '/c/new');

    expect(mockOnFCP).toHaveBeenCalledTimes(2);
  });
});

describe('forwardQueuedAssetEvents', () => {
  const fetchMock = jest.fn((_url: string, _init: RequestInit) => Promise.resolve({ status: 200 }));

  beforeEach(() => {
    jest.useFakeTimers();
    logTestExports.resetPageState();
    testExports.resetDiagnosticsState();
    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve({ status: 200 }));
    sessionStorage.clear();
    window.__lcRumQueue = [
      {
        type: 'stale-asset-recovery-start',
        at: 10,
        attributes: { clientBuildId: 'index-Old1.js' },
      },
      { type: 'pageshow', at: 11, attributes: { persisted: false } },
    ];
  });

  afterEach(() => {
    stopClientLogs();
    jest.useRealTimers();
  });

  const loggedEventNames = () =>
    fetchMock.mock.calls.flatMap(([, init]) =>
      JSON.parse(String(init.body)).resourceLogs[0].scopeLogs[0].logRecords.map(
        (record: { body: { stringValue: string } }) => record.body.stringValue,
      ),
    );

  it('delivers queued stale-asset events without the RUM SDK and never twice', async () => {
    startClientLogs({
      endpoint: '/api/rum/v1/logs',
      serviceName: 'librechat-web',
      buildId: 'index-New2.js',
      getToken: () => 'session-jwt',
      fetch: fetchMock,
    });

    forwardQueuedAssetEvents();
    forwardQueuedAssetEvents();
    expect(window.__lcRumQueue?.[0]).not.toHaveProperty('logged');

    await jest.advanceTimersByTimeAsync(5_000);

    expect(window.__lcRumQueue?.[0]).toEqual(expect.objectContaining({ logged: true }));
    expect(window.__lcRumQueue?.[1]).not.toHaveProperty('logged');
    expect(JSON.parse(sessionStorage.getItem('lc-rum-queue') ?? '[]')[0].logged).toBe(true);

    flushEarlyRumQueue({ addAction: jest.fn() });
    await jest.advanceTimersByTimeAsync(5_000);

    expect(loggedEventNames()).toEqual(['stale_asset.recovery_start']);
  });

  it('keeps an event persisted across the RUM SDK flush until its log record is acknowledged', async () => {
    const addAction = jest.fn();
    startClientLogs({
      endpoint: '/api/rum/v1/logs',
      serviceName: 'librechat-web',
      buildId: 'index-New2.js',
      getToken: () => 'session-jwt',
      fetch: fetchMock,
    });

    forwardQueuedAssetEvents();
    flushEarlyRumQueue({ addAction });

    const persisted = JSON.parse(sessionStorage.getItem('lc-rum-queue') ?? '[]');
    expect(persisted).toEqual([
      expect.objectContaining({ type: 'stale-asset-recovery-start', actionSent: true }),
    ]);
    expect(addAction).toHaveBeenCalledWith('early-stale-asset-recovery-start', expect.any(Object));

    await jest.advanceTimersByTimeAsync(5_000);

    expect(window.__lcRumQueue).toEqual([]);
    expect(sessionStorage.getItem('lc-rum-queue')).toBeNull();
    expect(loggedEventNames()).toEqual(['stale_asset.recovery_start']);
  });

  it('replays a persisted event after reload without repeating its RUM action', () => {
    const addAction = jest.fn();
    window.__lcRumQueue = [
      { type: 'stale-asset-recovery-start', at: 10, attributes: {}, actionSent: true },
    ];

    flushEarlyRumQueue({ addAction });

    expect(addAction).not.toHaveBeenCalledWith(
      'early-stale-asset-recovery-start',
      expect.anything(),
    );
  });

  it('keeps an undelivered event eligible for replay on the next page', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ status: 503 }));
    startClientLogs({
      endpoint: '/api/rum/v1/logs',
      serviceName: 'librechat-web',
      buildId: 'index-New2.js',
      getToken: () => 'session-jwt',
      fetch: fetchMock,
    });

    forwardQueuedAssetEvents();
    await jest.advanceTimersByTimeAsync(5_000);
    stopClientLogs();

    expect(fetchMock).toHaveBeenCalled();
    expect(window.__lcRumQueue?.[0]).not.toHaveProperty('logged');
    expect(sessionStorage.getItem('lc-rum-queue')).toBeNull();
  });

  it.each(['queued', 'sending'])(
    'retries an unacknowledged %s event after stop/start in the same page',
    async (state) => {
      if (state === 'sending') {
        fetchMock.mockImplementationOnce(() => new Promise(() => undefined));
      }
      const config = {
        endpoint: '/api/rum/v1/logs',
        serviceName: 'librechat-web',
        buildId: 'index-New2.js',
        getToken: () => 'session-jwt',
        fetch: fetchMock,
      };
      startClientLogs(config);
      forwardQueuedAssetEvents();
      flushEarlyRumQueue({ addAction: jest.fn() });
      if (state === 'sending') {
        await jest.advanceTimersByTimeAsync(5_000);
      }
      stopClientLogs();
      expect(JSON.parse(sessionStorage.getItem('lc-rum-queue') ?? '[]')).toHaveLength(1);
      fetchMock.mockImplementation(() => Promise.resolve({ status: 200 }));
      startClientLogs(config);
      forwardQueuedAssetEvents();
      await jest.advanceTimersByTimeAsync(5_000);
      expect(window.__lcRumQueue).toEqual([]);
      expect(sessionStorage.getItem('lc-rum-queue')).toBeNull();
    },
  );

  it('persists live asset events after the SDK emitter has replaced the early queue', async () => {
    startClientLogs({
      endpoint: '/api/rum/v1/logs',
      serviceName: 'librechat-web',
      buildId: 'index-New2.js',
      getToken: () => 'session-jwt',
      fetch: fetchMock,
    });
    window.__lcRumQueue = [];
    restoreRumEmitter({ addAction: jest.fn() });
    window.__lcRumPush?.('stale-asset-recovery-reload');
    expect(JSON.parse(sessionStorage.getItem('lc-rum-queue') ?? '[]')).toEqual([
      expect.objectContaining({ type: 'stale-asset-recovery-reload', actionSent: true }),
    ]);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(sessionStorage.getItem('lc-rum-queue')).toBeNull();
  });

  it('retains budget-rejected asset events across the SDK flush without false in-flight markers', async () => {
    startClientLogs({
      endpoint: '/api/rum/v1/logs',
      serviceName: 'librechat-web',
      buildId: 'index-New2.js',
      getToken: () => 'session-jwt',
      fetch: fetchMock,
    });
    for (let i = 0; i < 30; i += 1) {
      reportBoundaryError(`boundary-${i}`, new Error('failed'));
    }
    forwardQueuedAssetEvents();
    flushEarlyRumQueue({ addAction: jest.fn() });
    expect(JSON.parse(sessionStorage.getItem('lc-rum-queue') ?? '[]')).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(60_000);
    forwardQueuedAssetEvents();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(loggedEventNames()).toContain('stale_asset.recovery_start');
    expect(sessionStorage.getItem('lc-rum-queue')).toBeNull();
  });

  it('keeps an auth-dropped asset event persisted and eligible after token renewal', async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve({ status: 204 }));
    startClientLogs({
      endpoint: '/api/rum/v1/logs',
      serviceName: 'librechat-web',
      buildId: 'index-New2.js',
      getToken: () => 'expired-jwt',
      fetch: fetchMock,
    });
    forwardQueuedAssetEvents();
    flushEarlyRumQueue({ addAction: jest.fn() });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(window.__lcRumQueue?.[0]).not.toHaveProperty('logged');
    expect(JSON.parse(sessionStorage.getItem('lc-rum-queue') ?? '[]')).toHaveLength(1);
    stopClientLogs();
    startClientLogs({
      endpoint: '/api/rum/v1/logs',
      serviceName: 'librechat-web',
      buildId: 'index-New2.js',
      getToken: () => 'renewed-jwt',
      fetch: fetchMock,
    });
    forwardQueuedAssetEvents();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(window.__lcRumQueue).toEqual([]);
    expect(sessionStorage.getItem('lc-rum-queue')).toBeNull();
  });

  it('leaves events unmarked when client logs are off', () => {
    forwardQueuedAssetEvents();

    expect(window.__lcRumQueue?.[0]).not.toHaveProperty('logged');
    expect(sessionStorage.getItem('lc-rum-queue')).toBeNull();
  });
});
