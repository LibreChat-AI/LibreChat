import { resolve } from 'path';
import { readFileSync } from 'fs';
import { render } from '@testing-library/react';
import { ThemeProvider, applyResolvedTheme, resolveTheme } from '@librechat/client';
import type { ThemeDefinition } from '@librechat/client';
import {
  isPublicRoute,
  buildThemeCache,
  writeThemeCache,
  THEME_CACHE_KEY,
  THEME_CACHE_VERSION,
} from '../themeCache';
import { THEME_CACHE_VERSION_PLACEHOLDER, injectThemeCacheVersion } from '../bootVersion';

/** The inline shell script in `client/index.html`, run as the browser runs it. */
const bootScript = (() => {
  const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((source) => source.includes('deployment-theme'));
  if (!script) {
    throw new Error('client/index.html has no deployment theme boot script');
  }
  return injectThemeCacheVersion(script);
})();

const acme: ThemeDefinition = {
  version: 1,
  name: 'acme',
  modes: {
    light: {
      colors: { 'rgb-surface-primary': '240 244 255', 'rgb-surface-primary-alt': '230 234 250' },
      appearance: { controlRadius: '2px', disabledStyle: 'fill' },
    },
    dark: {
      colors: { 'rgb-surface-primary': '12 16 32', 'rgb-surface-primary-alt': '8 10 24' },
      appearance: { controlRadius: '2px', fieldFocusStyle: 'border' },
    },
  },
};

const root = () => document.documentElement;

function mockMedia(dark: boolean) {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: dark && query === '(prefers-color-scheme: dark)',
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
}

function boot() {
  new Function(bootScript)();
}

/** What `applyResolvedTheme` writes for `mode`, read off a detached element. */
function appliedStyle(mode: 'light' | 'dark') {
  const element = document.createElement('div');
  applyResolvedTheme(resolveTheme(acme, mode), element);
  return element;
}

describe('index.html deployment theme boot script', () => {
  beforeEach(() => {
    localStorage.clear();
    root().removeAttribute('style');
    root().removeAttribute('class');
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
    window.history.pushState({}, '', '/c/new');
    writeThemeCache(buildThemeCache('tenant-a:user-1', 'acme', acme));
  });

  it.each(['light', 'dark'] as const)(
    'paints the cached %s theme exactly as the provider would, before the bundle',
    (mode) => {
      localStorage.setItem('color-theme', mode);
      boot();

      const expected = appliedStyle(mode);
      expect(root().getAttribute('style')).toBe(expected.getAttribute('style'));
      expect(root().dataset.theme).toBe('acme');
      expect(root().getAttribute('data-theme-disabled')).toBe(
        expected.getAttribute('data-theme-disabled'),
      );
      expect(root().getAttribute('data-theme-field-focus')).toBe(
        expected.getAttribute('data-theme-field-focus'),
      );
      expect(root().hasAttribute('data-theme-boot')).toBe(true);
      expect(root().classList.contains(mode)).toBe(true);
      const surface = acme.modes[mode]?.colors?.['rgb-surface-primary-alt'];
      expect(document.head.textContent).toContain(
        `background-color: rgb(${surface?.split(' ').join(', ')})`,
      );
    },
  );

  it('leaves the placeholder out of the script the build serves', () => {
    expect(bootScript).not.toContain(THEME_CACHE_VERSION_PLACEHOLDER);
    expect(bootScript).toContain(`'${THEME_CACHE_VERSION}'`);
  });

  it('does not replay an entry stored against another role set', () => {
    const stored = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null');
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ ...stored, v: 'before-a-new-role' }));
    boot();
    expect(root().getAttribute('style')).toBeNull();
    expect(root().hasAttribute('data-theme')).toBe(false);
  });

  it('paints nothing on a first-ever visit, leaving the operator theme to the config answer', () => {
    localStorage.clear();
    boot();
    expect(root().getAttribute('style')).toBeNull();
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(root().hasAttribute('data-theme-boot')).toBe(false);
    expect(root().classList.contains('light')).toBe(true);
  });

  it('follows the OS scheme under `system`', () => {
    mockMedia(true);
    boot();
    expect(root().style.getPropertyValue('--surface-primary')).toBe('12 16 32');
    expect(root().classList.contains('dark')).toBe(true);
  });

  it('leaves the shell alone under high contrast, which outranks the deployment theme', () => {
    localStorage.setItem('color-theme', 'high-contrast-dark');
    boot();
    expect(root().getAttribute('style')).toBeNull();
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(document.head.textContent).toContain('background-color: #000000');
  });

  it.each(['/login', '/register', '/share/abc', '/Share/abc', '/reset-password', '/oauth/success'])(
    'does not replay the cache on %s, which never renders the signed-in config',
    (path) => {
      window.history.pushState({}, '', path);
      localStorage.setItem('color-theme', 'dark');
      boot();
      expect(root().getAttribute('style')).toBeNull();
      expect(root().hasAttribute('data-theme')).toBe(false);
      expect(isPublicRoute(path)).toBe(true);
    },
  );

  it('replays the cache on app routes', () => {
    for (const path of ['/c/new', '/c/login-notes', '/agents', '/']) {
      window.history.pushState({}, '', path);
      expect(isPublicRoute(path)).toBe(false);
    }
    window.history.pushState({}, '', '/c/new');
    boot();
    expect(root().dataset.theme).toBe('acme');
  });

  it('keeps a cached surface that is not an RGB triple out of the shell stylesheet', () => {
    localStorage.setItem('color-theme', 'dark');
    const entry = buildThemeCache('tenant-a:user-1', 'acme', acme);
    entry.modes.dark.properties = entry.modes.dark.properties.map(([name, value]) =>
      name === '--surface-primary-alt' || name === '--surface-canvas'
        ? [name, '0 0 0;}</style><b>x']
        : [name, value],
    );
    writeThemeCache(entry);
    boot();
    expect(document.head.textContent).toContain('background-color: #0d0d0d');
    expect(document.head.textContent).not.toContain('</style>');
  });

  it('paints the cached canvas over the split surface it follows by default', () => {
    localStorage.setItem('color-theme', 'dark');
    const entry = buildThemeCache('tenant-a:user-1', 'acme', acme);
    entry.modes.dark.properties = entry.modes.dark.properties.map(([name, value]) =>
      name === '--surface-canvas' ? [name, '1 2 3'] : [name, value],
    );
    writeThemeCache(entry);
    boot();
    expect(document.head.textContent).toContain('background-color: rgb(1, 2, 3)');
  });

  it('keeps the split surface on routes that do not paint the canvas', () => {
    localStorage.setItem('color-theme', 'dark');
    const entry = buildThemeCache('tenant-a:user-1', 'acme', acme);
    entry.modes.dark.properties = entry.modes.dark.properties.map(([name, value]) =>
      name === '--surface-canvas' ? [name, '1 2 3'] : [name, value],
    );
    writeThemeCache(entry);
    window.history.pushState({}, '', '/agents');
    boot();
    expect(document.head.textContent).toContain('background-color: rgb(8, 10, 24)');
  });

  it('paints the canvas for the prompt redirect that lands on a new chat', () => {
    localStorage.setItem('color-theme', 'dark');
    const entry = buildThemeCache('tenant-a:user-1', 'acme', acme);
    entry.modes.dark.properties = entry.modes.dark.properties.map(([name, value]) =>
      name === '--surface-canvas' ? [name, '1 2 3'] : [name, value],
    );
    writeThemeCache(entry);
    window.history.pushState({}, '', '/prompts/new');
    boot();
    expect(document.head.textContent).toContain('background-color: rgb(1, 2, 3)');
  });

  it.each([
    ['/d', 'rgb(1, 2, 3)'],
    ['/d/', 'rgb(1, 2, 3)'],
    ['/d/prompts', 'rgb(1, 2, 3)'],
    ['/d/prompts/', 'rgb(1, 2, 3)'],
    ['/d/prompts/new', 'rgb(1, 2, 3)'],
    ['/d/anything', 'rgb(1, 2, 3)'],
    ['/d/prompts/abc123', 'rgb(8, 10, 24)'],
    ['/D/Prompts/abc123', 'rgb(8, 10, 24)'],
    ['/D/Prompts/New', 'rgb(1, 2, 3)'],
    ['/C/new', 'rgb(1, 2, 3)'],
  ])('classifies the legacy dashboard path %s by where it lands', (path, expected) => {
    localStorage.setItem('color-theme', 'dark');
    const entry = buildThemeCache('tenant-a:user-1', 'acme', acme);
    entry.modes.dark.properties = entry.modes.dark.properties.map(([name, value]) =>
      name === '--surface-canvas' ? [name, '1 2 3'] : [name, value],
    );
    writeThemeCache(entry);
    window.history.pushState({}, '', path);
    boot();
    expect(document.head.textContent).toContain(`background-color: ${expected}`);
  });

  it('accepts any whitespace between the cached surface channels', () => {
    localStorage.setItem('color-theme', 'dark');
    const entry = buildThemeCache('tenant-a:user-1', 'acme', acme);
    entry.modes.dark.properties = entry.modes.dark.properties.map(([name, value]) =>
      name === '--surface-primary-alt' || name === '--surface-canvas'
        ? [name, ' 8  10\t24 ']
        : [name, value],
    );
    writeThemeCache(entry);
    boot();
    expect(document.head.textContent).toContain('background-color: rgb(8, 10, 24)');
  });

  it('paints the stock shell for a corrupt entry', () => {
    localStorage.setItem('color-theme', 'dark');
    localStorage.setItem('deployment-theme', '{not json');
    boot();
    expect(root().getAttribute('style')).toBeNull();
    expect(document.head.textContent).toContain('background-color: #0d0d0d');
  });

  it('is dropped by the provider, so a withdrawn theme restores the stylesheet, not the copy', () => {
    localStorage.setItem('color-theme', 'light');
    boot();

    const { rerender, unmount } = render(
      <ThemeProvider themeDefinition={acme} persistThemeDefinition={false}>
        {null}
      </ThemeProvider>,
    );
    expect(root().hasAttribute('data-theme-boot')).toBe(false);
    expect(root().style.getPropertyValue('--surface-primary')).toBe('240 244 255');

    rerender(<ThemeProvider persistThemeDefinition={false}>{null}</ThemeProvider>);
    expect(root().style.getPropertyValue('--surface-primary')).toBe('');
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(root().hasAttribute('data-theme-disabled')).toBe(false);
    unmount();
  });

  it('is dropped when the provider starts without a theme', () => {
    localStorage.setItem('color-theme', 'dark');
    boot();

    const { unmount } = render(<ThemeProvider>{null}</ThemeProvider>);
    expect(root().getAttribute('style') ?? '').toBe('');
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(root().hasAttribute('data-theme-boot')).toBe(false);
    expect(root().classList.contains('dark')).toBe(true);
    unmount();
  });
});
