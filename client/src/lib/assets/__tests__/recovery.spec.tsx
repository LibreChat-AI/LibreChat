import { Suspense } from 'react';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import {
  ChunkLoadError,
  isChunkLoadError,
  requestStaleAssetRecovery,
  isStaleAssetRecoveryPending,
} from '../recovery';
import { importWithRecovery, lazyWithRecovery } from '../lazy';
import RouteErrorBoundary from '~/routes/RouteErrorBoundary';

jest.mock('~/hooks', () => {
  const translations: Record<string, string> = jest.requireActual('~/locales/en/translation.json');
  return { useLocalize: () => (key: string) => translations[key] ?? key };
});

const RECOVERY_KEY = 'lc-asset-recovery-at';

function loadRecoveryScript(): void {
  const html = readFileSync(resolve(__dirname, '../../../../index.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (m) => m[1]);
  const recoveryScript = scripts.find((script) => script.includes(RECOVERY_KEY));
  if (!recoveryScript) {
    throw new Error('Stale-asset recovery script not found in index.html');
  }
  new Function(recoveryScript)();
}

afterEach(() => {
  delete window.__lcRecoverStaleAssets;
  delete window.__lcStaleAssetRecoveryPending;
  sessionStorage.clear();
});

describe('isChunkLoadError', () => {
  it.each([
    new TypeError('Failed to fetch dynamically imported module: https://x.test/assets/a.js'),
    new TypeError('Importing a module script failed.'),
    new TypeError('error loading dynamically imported module: /assets/a.js'),
    new Error('Unable to preload CSS for /assets/a.css'),
    Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' }),
    new ChunkLoadError(),
    new Error('wrapped', { cause: new TypeError('Importing a module script failed.') }),
  ])('recognizes %p', (error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    new TypeError("Cannot read properties of undefined (reading 'default')"),
    new Error('Network Error'),
    'Failed to fetch dynamically imported module',
    null,
    undefined,
  ])('ignores %p', (error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe('requestStaleAssetRecovery', () => {
  it('asks the page recovery once per error object', () => {
    const recover = jest.fn(() => true);
    window.__lcRecoverStaleAssets = recover;
    const error = new ChunkLoadError();

    expect(requestStaleAssetRecovery(error)).toBe(true);
    expect(requestStaleAssetRecovery(error)).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('reports a declined recovery and never throws when the page script is missing', () => {
    window.__lcRecoverStaleAssets = jest.fn(() => false);
    expect(requestStaleAssetRecovery(new ChunkLoadError())).toBe(false);

    delete window.__lcRecoverStaleAssets;
    expect(requestStaleAssetRecovery(new ChunkLoadError())).toBe(false);
  });
});

describe('importWithRecovery', () => {
  it('turns a module the preload helper resolved to undefined into a ChunkLoadError', async () => {
    await expect(importWithRecovery(() => Promise.resolve(undefined))).rejects.toBeInstanceOf(
      ChunkLoadError,
    );
  });

  it('recovers required imports without claiming unrelated optional preload failures', async () => {
    const recover = jest.fn(() => true);
    window.__lcRecoverStaleAssets = recover;
    const optionalFailure = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(optionalFailure);
    expect(optionalFailure.defaultPrevented).toBe(false);
    expect(recover).not.toHaveBeenCalled();
    const requiredFailure = new TypeError('Importing a module script failed.');
    await expect(importWithRecovery(() => Promise.reject(requiredFailure))).rejects.toBe(
      requiredFailure,
    );
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('passes loaded modules and original failures through', async () => {
    const module = { default: 'value' };
    await expect(importWithRecovery(() => Promise.resolve(module))).resolves.toBe(module);
    const failure = new TypeError('Failed to fetch dynamically imported module');
    await expect(importWithRecovery(() => Promise.reject(failure))).rejects.toBe(failure);
  });
});

describe('index.html recovery script', () => {
  it('starts one recovery, joins later callers, and declines within the loop guard', () => {
    /* jsdom reports `location.reload()` as an unimplemented navigation. */
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    window.__lcRumQueue = [];
    loadRecoveryScript();
    const recover = window.__lcRecoverStaleAssets;
    if (!recover) {
      throw new Error('recovery not installed');
    }

    expect(recover()).toBe(true);
    expect(isStaleAssetRecoveryPending()).toBe(true);
    expect(recover()).toBe(true);
    expect(Number(sessionStorage.getItem(RECOVERY_KEY))).toBeGreaterThan(0);

    delete window.__lcStaleAssetRecoveryPending;
    window.__lcRumQueue = [];
    loadRecoveryScript();
    expect(window.__lcRecoverStaleAssets?.()).toBe(false);
    expect(isStaleAssetRecoveryPending()).toBe(false);
    expect(window.__lcRumQueue?.map((event) => event.type)).toEqual([
      'stale-asset-recovery-start',
      'stale-asset-recovery-reload',
      'stale-asset-recovery-declined',
    ]);
    consoleError.mockRestore();
  });
});

describe('lazyWithRecovery under the route boundary', () => {
  it('shows the updating state when the recovery claimed the failed chunk import', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    window.__lcStaleAssetRecoveryPending = true;
    window.__lcRecoverStaleAssets = jest.fn(() => true);
    const Panel = lazyWithRecovery(() =>
      Promise.resolve(undefined as unknown as { default: () => null }),
    );
    const router = createMemoryRouter([
      {
        path: '/',
        element: (
          <Suspense fallback={null}>
            <Panel />
          </Suspense>
        ),
        errorElement: <RouteErrorBoundary />,
      },
    ]);

    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('status')).toHaveTextContent('Updating to the latest version');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    consoleError.mockRestore();
  });
});
