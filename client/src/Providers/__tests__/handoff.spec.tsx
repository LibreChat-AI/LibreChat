import { resolve } from 'path';
import { readFileSync } from 'fs';
import { act, render } from '@testing-library/react';
import { ThemeProvider, useTheme } from '@librechat/client';
import { injectThemeCacheVersion } from '../bootVersion';

/** The inline shell script in `client/index.html` that paints the colour mode. */
const bootScript = (() => {
  const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((source) => source.includes('data-color-mode-from-url'));
  if (!script) {
    throw new Error('client/index.html has no colour-mode handoff in its boot script');
  }
  return injectThemeCacheVersion(script);
})();

const root = () => document.documentElement;

function mockMedia(dark: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: dark && query === '(prefers-color-scheme: dark)',
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
}

function boot(url: string, enabled = true) {
  window.history.replaceState({ key: 'entry' }, '', url);
  if (enabled) {
    root().setAttribute('data-color-mode-from-url', '');
  }
  new Function(bootScript)();
}

const address = () => `${location.pathname}${location.search}${location.hash}`;
const painted = () => (root().classList.contains('dark') ? 'dark' : 'light');

describe('index.html colour-mode handoff', () => {
  beforeEach(() => {
    localStorage.clear();
    root().removeAttribute('class');
    root().removeAttribute('style');
    [...root().attributes].forEach(({ name }) => {
      if (name.startsWith('data-')) {
        root().removeAttribute(name);
      }
    });
    document.head.querySelectorAll('style, base').forEach((element) => element.remove());
    const base = document.createElement('base');
    base.href = '/';
    document.head.append(base);
    mockMedia(false);
  });

  it.each([
    ['dark', 'light'],
    ['light', 'dark'],
  ] as const)('paints and stores ?theme=%s over a stored %s mode', (mode, stored) => {
    localStorage.setItem('color-theme', stored);
    boot(`/c/new?theme=${mode}`);

    expect(painted()).toBe(mode);
    expect(localStorage.getItem('color-theme')).toBe(mode);
    expect(address()).toBe('/c/new');
  });

  it('applies the handoff on a fresh profile and keeps the history entry state', () => {
    boot('/c/new?theme=dark');

    expect(painted()).toBe('dark');
    expect(localStorage.getItem('color-theme')).toBe('dark');
    expect(window.history.state).toEqual({ key: 'entry' });
  });

  it('hands `system` back to the OS scheme', () => {
    localStorage.setItem('color-theme', 'light');
    mockMedia(true);
    boot('/c/new?theme=system');

    expect(painted()).toBe('dark');
    expect(localStorage.getItem('color-theme')).toBe('system');
  });

  it('removes only its own parameter, keeping the rest of the link', () => {
    boot('/c/new?prompt=hello&theme=dark&submit=true#composer');

    expect(address()).toBe('/c/new?prompt=hello&submit=true#composer');
  });

  it.each(['Dark', 'high-contrast-dark', 'blue', '', 'dark%20', '%3Cscript%3E'])(
    'ignores the unsupported value %p',
    (value) => {
      localStorage.setItem('color-theme', 'light');
      boot(`/c/new?theme=${value}`);

      expect(painted()).toBe('light');
      expect(localStorage.getItem('color-theme')).toBe('light');
      expect(location.search).toBe(`?theme=${value}`);
    },
  );

  it('ignores the parameter when the deployment has not enabled the handoff', () => {
    localStorage.setItem('color-theme', 'light');
    boot('/c/new?theme=dark', false);

    expect(painted()).toBe('light');
    expect(localStorage.getItem('color-theme')).toBe('light');
    expect(location.search).toBe('?theme=dark');
  });

  it('keeps a high-contrast choice of the requested scheme', () => {
    localStorage.setItem('color-theme', 'high-contrast-dark');
    boot('/c/new?theme=dark');

    expect(painted()).toBe('dark');
    expect(localStorage.getItem('color-theme')).toBe('high-contrast-dark');
    expect(document.head.textContent).toContain('background-color: #000000');
    expect(address()).toBe('/c/new');
  });

  it('still paints the handed-over mode when storage refuses the write', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    boot('/c/new?theme=dark');
    setItem.mockRestore();

    expect(painted()).toBe('dark');
    expect(address()).toBe('/c/new');
  });

  it('starts the app in the handed-over mode, and a later in-app choice wins', () => {
    let setTheme: (theme: string) => void = () => undefined;
    function Selector() {
      setTheme = useTheme().setTheme;
      return null;
    }

    boot('/c/new?theme=dark');
    const { unmount } = render(
      <ThemeProvider>
        <Selector />
      </ThemeProvider>,
    );

    expect(painted()).toBe('dark');
    expect(localStorage.getItem('color-theme')).toBe('dark');

    act(() => setTheme('light'));
    unmount();
    root().removeAttribute('class');
    boot('/c/new');

    expect(localStorage.getItem('color-theme')).toBe('light');
    expect(painted()).toBe('light');
  });
});
