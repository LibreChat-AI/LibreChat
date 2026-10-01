import type { FCPMetricWithAttribution } from 'web-vitals/attribution';
import {
  discardEarlyRumQueue,
  flushEarlyRumQueue,
  queueSpaRouteChange,
  registerFcpAttribution,
  restoreRumEmitter,
  testExports,
} from './diagnostics';

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
