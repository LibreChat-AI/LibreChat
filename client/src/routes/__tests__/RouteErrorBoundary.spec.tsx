import { useState } from 'react';
import { createMemoryRouter, RouterProvider, Outlet } from 'react-router-dom';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { stopClientLogs, testExports as logTestExports } from '~/lib/rum/logs';
import { ChunkLoadError } from '~/lib/assets/recovery';
import RouteErrorBoundary from '../RouteErrorBoundary';
import en from '~/locales/en/translation.json';
import WithRum from '~/lib/rum/WithRum';

jest.mock('~/hooks', () => {
  const translations: Record<string, string> = jest.requireActual('~/locales/en/translation.json');
  return { useLocalize: () => (key: string) => translations[key] ?? key };
});

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    isFetched: true,
    data: {
      rum: {
        provider: 'hyperdx',
        enabled: true,
        authMode: 'proxy',
        url: '/api/rum',
        serviceName: 'test',
        clientLogs: true,
      },
    },
  }),
}));
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ token: 'session-jwt', user: { id: 'user-1' } }),
}));
jest.mock('@hyperdx/browser', () => ({
  __esModule: true,
  default: { init: jest.fn(), addAction: jest.fn(), setGlobalAttributes: jest.fn() },
}));

type ErrorFactory = () => unknown;

function renderRouteThatThrows(createError: ErrorFactory) {
  const error = createError();
  const Thrower = () => {
    throw error;
  };
  const router = createMemoryRouter([
    { path: '/', element: <Thrower />, errorElement: <RouteErrorBoundary /> },
  ]);
  return render(<RouterProvider router={router} />);
}

describe('RouteErrorBoundary stale-asset recovery', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    delete window.__lcStaleAssetRecoveryPending;
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete window.__lcRecoverStaleAssets;
    delete window.__lcStaleAssetRecoveryPending;
  });

  it.each([
    ['Chromium', () => new TypeError('Failed to fetch dynamically imported module: /assets/x.js')],
    ['Safari', () => new TypeError('Importing a module script failed.')],
    ['Firefox', () => new TypeError('error loading dynamically imported module')],
    ['CSS preload', () => new Error('Unable to preload CSS for /assets/panel.css')],
    ['ChunkLoadError', () => new ChunkLoadError()],
  ])('shows the updating state and recovers once for a %s chunk failure', async (_label, make) => {
    const recover = jest.fn(() => true);
    window.__lcRecoverStaleAssets = recover;

    renderRouteThatThrows(make);

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Updating to the latest version…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
  });

  it('falls back to the error UI with a reload action when recovery declines', async () => {
    const recover = jest.fn(() => false);
    window.__lcRecoverStaleAssets = recover;

    renderRouteThatThrows(() => new TypeError('Failed to fetch dynamically imported module'));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: en.com_ui_refresh_page }).length).toBeGreaterThan(
      0,
    );
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('keeps the error page for ordinary errors without asking for recovery', async () => {
    const recover = jest.fn(() => true);
    window.__lcRecoverStaleAssets = recover;

    renderRouteThatThrows(() => new TypeError("Cannot read properties of undefined (reading 'x')"));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(en.com_ui_error_unexpected)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(recover).not.toHaveBeenCalled();
  });

  it('shows the updating state for any error while a recovery reload is already underway', async () => {
    const recover = jest.fn(() => true);
    window.__lcRecoverStaleAssets = recover;
    window.__lcStaleAssetRecoveryPending = true;

    renderRouteThatThrows(
      () => new TypeError("Cannot read properties of undefined (reading 'default')"),
    );

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('authenticated route reporting lifetime', () => {
  const failRouteText = 'Fail route';
  const publicShareText = 'Public share';
  let originalFetch: typeof window.fetch;
  beforeEach(() => {
    originalFetch = window.fetch;
    jest.useFakeTimers();
    logTestExports.resetPageState();
  });
  afterEach(() => {
    stopClientLogs();
    Object.defineProperty(window, 'fetch', {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
    jest.useRealTimers();
    delete window.__lcRecoverStaleAssets;
    delete window.__lcStaleAssetRecoveryPending;
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'reports a route failure (chunk=%s, initial=%s), then stops on a public route',
    async (chunk, initial) => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      window.__lcRecoverStaleAssets = jest.fn(() => false);
      const transport = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(() =>
        Promise.resolve({ status: 200 } as Response),
      );
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        writable: true,
        value: transport,
      });
      function Chat() {
        const [failed, setFailed] = useState(initial);
        if (failed) {
          throw chunk ? new ChunkLoadError() : new Error('application failure');
        }
        return <button onClick={() => setFailed(true)}>{failRouteText}</button>;
      }
      const router = createMemoryRouter(
        [
          {
            element: (
              <WithRum>
                <Outlet />
              </WithRum>
            ),
            children: [
              {
                errorElement: <RouteErrorBoundary />,
                children: [{ path: '/c/new', element: <Chat /> }],
              },
            ],
          },
          { path: '/share/example', element: <div>{publicShareText}</div> },
        ],
        { initialEntries: ['/c/new'] },
      );
      render(<RouterProvider router={router} />);
      if (!initial) {
        fireEvent.click(screen.getByRole('button', { name: 'Fail route' }));
      }
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_000);
      });
      const records = transport.mock.calls.flatMap(
        (call) => JSON.parse(String(call[1]?.body)).resourceLogs[0].scopeLogs[0].logRecords,
      );
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attributes: expect.arrayContaining([
              { key: 'error.boundary', value: { stringValue: 'route' } },
            ]),
          }),
        ]),
      );
      await act(async () => {
        await router.navigate('/share/example');
      });
      expect(screen.getByText('Public share')).toBeInTheDocument();
      const count = transport.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10_000);
      });
      expect(transport).toHaveBeenCalledTimes(count);
    },
  );
});
