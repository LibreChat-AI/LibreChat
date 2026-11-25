import { installRumBootstrap } from './bootstrap';

type BootstrapTestWindow = {
  __lcRumPush?: unknown;
  __lcRumQueue?: unknown;
};

function bootstrapWindow(): BootstrapTestWindow {
  return window as unknown as BootstrapTestWindow;
}

describe('rum bootstrap', () => {
  beforeEach(() => {
    sessionStorage.clear();
    bootstrapWindow().__lcRumQueue = undefined;
    bootstrapWindow().__lcRumPush = undefined;
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: undefined,
    });
    jest.spyOn(performance, 'now').mockReturnValue(42.4);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forces the early RUM queue to an array and persists sanitized events', () => {
    bootstrapWindow().__lcRumQueue = 'bad';

    installRumBootstrap(window);
    window.__lcRumPush?.('asset-load-error', {
      assetUrl: '/assets/app.js?token=secret',
      nested: { dropped: true },
      tagName: 'SCRIPT',
    });

    const persistedQueue = JSON.parse(sessionStorage.getItem('lc-rum-queue') || '[]');
    expect(Array.isArray(window.__lcRumQueue)).toBe(true);
    expect(window.__lcRumQueue?.[0]).toEqual(
      expect.objectContaining({
        type: 'inline-start',
        attributes: expect.objectContaining({ currentPath: '/' }),
      }),
    );
    expect(persistedQueue.at(-1)).toEqual({
      type: 'asset-load-error',
      at: 42,
      visibilityState: 'visible',
      attributes: {
        assetUrl: '/assets/app.js?token=secret',
        tagName: 'SCRIPT',
        clientBuildId: 'unknown',
      },
    });
  });

  it('preserves inline guard events already in the queue', () => {
    bootstrapWindow().__lcRumQueue = [
      { type: 'asset-load-error', attributes: { tagName: 'SCRIPT' } },
    ];

    installRumBootstrap(window);

    expect(window.__lcRumQueue?.map((event) => event.type)).toEqual([
      'asset-load-error',
      'inline-start',
    ]);
  });

  it('records service worker pings without sending duplicate pongs', () => {
    const postMessage = jest.fn();
    let messageHandler: ((event: MessageEvent) => void) | undefined;
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        addEventListener: jest.fn((eventName, handler) => {
          if (eventName === 'message') {
            messageHandler = handler;
          }
        }),
        controller: undefined,
        getRegistrations: jest.fn(() => Promise.resolve([])),
      },
    });

    installRumBootstrap(window);
    messageHandler?.({
      data: { type: 'LC_SW_PING' },
      source: { postMessage },
    } as unknown as MessageEvent);

    expect(postMessage).not.toHaveBeenCalled();
    expect(window.__lcRumQueue?.map((event) => event.type)).toEqual(
      expect.arrayContaining(['sw-ping', 'sw-pong']),
    );
  });
});
