import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { ChunkLoadError } from '~/lib/assets/recovery';
import RouteErrorBoundary from '../RouteErrorBoundary';
import en from '~/locales/en/translation.json';

jest.mock('~/hooks', () => {
  const translations: Record<string, string> = jest.requireActual('~/locales/en/translation.json');
  return { useLocalize: () => (key: string) => translations[key] ?? key };
});

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
