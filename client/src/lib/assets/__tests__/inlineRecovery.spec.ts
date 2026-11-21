import { resolve } from 'path';
import { readFileSync } from 'fs';

const RECOVERY_KEY = 'lc-asset-recovery-at';

function recoveryScript(): string {
  const html = readFileSync(resolve(__dirname, '../../../../index.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g), (m) => m[1]);
  const script = scripts.find((candidate) => candidate.includes(RECOVERY_KEY));
  if (!script) {
    throw new Error('Stale-asset recovery script not found in index.html');
  }
  return script;
}

type RecoveryEvent = {
  target?: unknown;
  message?: string;
  error?: { message?: string };
  reason?: unknown;
};
type RecoveryListener = (event: RecoveryEvent) => void;
type RecoveryHarness = {
  fakeWindow: {
    __lcRumQueue?: Array<{ type: string }>;
    location: { reload: jest.Mock; href: string };
  };
  listeners: Record<string, RecoveryListener>;
};

function createRecoveryHarness(): RecoveryHarness {
  const listeners: Record<string, RecoveryListener> = {};
  const values = new Map<string, string>();
  const fakeSessionStorage = {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, String(value));
    }),
  };
  const fakeWindow = {
    __lcRumQueue: [] as Array<{ type: string }>,
    location: { reload: jest.fn(), href: 'http://localhost/' },
    addEventListener: jest.fn((type: string, listener: RecoveryListener) => {
      listeners[type] = listener;
    }),
  };
  const fakeDocument = {
    baseURI: 'http://localhost/',
    visibilityState: 'visible',
    querySelectorAll: () => [],
  };

  new Function(
    'window',
    'sessionStorage',
    'document',
    'navigator',
    'performance',
    'URL',
    'Promise',
    recoveryScript(),
  )(fakeWindow, fakeSessionStorage, fakeDocument, {}, { now: () => 1 }, URL, Promise);

  return { fakeWindow, listeners };
}

describe('index.html runtime chunk recovery', () => {
  it.each([
    ['Chrome/Firefox', 'Spinner is not defined'],
    ['Safari', "Can't find variable: Spinner"],
    ['TDZ', "Cannot access 'Spinner' before initialization"],
  ])('recovers from a %s reference error', (_browser, message) => {
    const { fakeWindow, listeners } = createRecoveryHarness();

    listeners.error({
      target: fakeWindow,
      message,
      error: new ReferenceError(message),
    });

    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1);
    expect(fakeWindow.__lcRumQueue?.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'chunk-reference-error',
        'stale-asset-recovery-start',
        'stale-asset-recovery-reload',
      ]),
    );
  });

  it.each([
    ['Error object', new ReferenceError('Spinner is not defined')],
    ['string reason', 'Spinner is not defined'],
  ])('recovers from a reference error surfaced as an unhandled rejection (%s)', (_kind, reason) => {
    const { fakeWindow, listeners } = createRecoveryHarness();

    listeners.unhandledrejection({ reason });

    expect(fakeWindow.location.reload).toHaveBeenCalledTimes(1);
    expect(fakeWindow.__lcRumQueue?.map((event) => event.type)).toContain('chunk-reference-error');
  });

  it('ignores unrelated runtime errors while preserving dynamic-import recovery', () => {
    const unrelated = createRecoveryHarness();
    unrelated.listeners.error({
      target: unrelated.fakeWindow,
      message: "Cannot read properties of undefined (reading 'default')",
      error: new TypeError("Cannot read properties of undefined (reading 'default')"),
    });
    expect(unrelated.fakeWindow.location.reload).not.toHaveBeenCalled();
    expect(unrelated.fakeWindow.__lcRumQueue?.map((event) => event.type)).not.toContain(
      'chunk-reference-error',
    );

    const dynamicImport = createRecoveryHarness();
    dynamicImport.listeners.unhandledrejection({
      reason: new TypeError('Failed to fetch dynamically imported module: /assets/a.js'),
    });
    expect(dynamicImport.fakeWindow.location.reload).toHaveBeenCalledTimes(1);
    expect(dynamicImport.fakeWindow.__lcRumQueue?.map((event) => event.type)).toContain(
      'dynamic-import-error',
    );
  });
});
