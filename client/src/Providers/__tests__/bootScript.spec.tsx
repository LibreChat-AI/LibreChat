import { resolve } from 'path';
import { readFileSync } from 'fs';
import { render } from '@testing-library/react';
import { DEPLOYMENT_THEME_BOOT_ID } from 'librechat-data-provider';
import {
  ThemeProvider,
  resolveTheme,
  clickHouseTheme,
  applyResolvedTheme,
} from '@librechat/client';
import type { DeploymentThemeBoot } from 'librechat-data-provider';
import type { ThemeDefinition } from '@librechat/client';
import {
  isPublicRoute,
  setThemeOwner,
  buildThemeCache,
  writeThemeCache,
  THEME_CACHE_KEY,
  THEME_CACHE_VERSION,
} from '../themeCache';
import {
  bundledThemeBoot,
  injectThemeCacheVersion,
  THEME_CACHE_VERSION_PLACEHOLDER,
} from '../bootVersion';

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
function appliedStyle(mode: 'light' | 'dark', theme: ThemeDefinition = acme) {
  const element = document.createElement('div');
  applyResolvedTheme(resolveTheme(theme, mode), element);
  return element;
}

/** The block the server embeds ahead of the boot script for the deployment's base theme. */
function embedShellTheme(boot: DeploymentThemeBoot | string) {
  const block = document.createElement('script');
  block.type = 'application/json';
  block.id = DEPLOYMENT_THEME_BOOT_ID;
  block.textContent = typeof boot === 'string' ? boot : JSON.stringify(boot);
  document.head.prepend(block);
}

const clickhouseShell = (): DeploymentThemeBoot => ({
  source: 'clickhouse',
  modes: bundledThemeBoot().clickhouse,
});

describe('index.html deployment theme boot script', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    root().removeAttribute('style');
    root().removeAttribute('class');
    [...root().attributes].forEach(({ name }) => {
      if (name.startsWith('data-')) {
        root().removeAttribute(name);
      }
    });
    document.head
      .querySelectorAll(`style, base, #${DEPLOYMENT_THEME_BOOT_ID}`)
      .forEach((element) => element.remove());
    const base = document.createElement('base');
    base.href = '/';
    document.head.append(base);
    mockMedia(false);
    window.history.pushState({}, '', '/c/new');
    writeThemeCache(buildThemeCache('tenant-a:user-1', 'acme', acme));
    setThemeOwner('tenant-a:user-1');
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

  it.each([
    ['a tab that has not seen its owner signed in', undefined],
    ['a tab last signed in as someone else', 'tenant-b:user-2'],
  ])('paints no cached theme in %s', (_, tabOwner) => {
    setThemeOwner(tabOwner);
    boot();
    expect(root().getAttribute('style')).toBeNull();
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(root().hasAttribute('data-theme-boot')).toBe(false);
    expect(document.head.textContent).toContain('background-color: #ffffff');
  });

  it('paints no cached theme that names no owner', () => {
    const stored = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) ?? 'null');
    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ ...stored, owner: undefined }));
    boot();
    expect(root().getAttribute('style')).toBeNull();
    expect(root().hasAttribute('data-theme')).toBe(false);
  });

  it('paints nothing on a first-ever visit to a shell no server embedded a theme in', () => {
    localStorage.clear();
    boot();
    expect(root().getAttribute('style')).toBeNull();
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(root().hasAttribute('data-theme-boot')).toBe(false);
    expect(root().classList.contains('light')).toBe(true);
  });

  describe('the deployment theme the server embeds in the shell', () => {
    beforeEach(() => {
      localStorage.clear();
      sessionStorage.clear();
      embedShellTheme(clickhouseShell());
    });

    it.each(['light', 'dark'] as const)(
      'paints a first-ever visit in %s exactly as the provider would',
      (mode) => {
        localStorage.setItem('color-theme', mode);
        boot();

        const expected = appliedStyle(mode, clickHouseTheme);
        expect(root().getAttribute('style')).toBe(expected.getAttribute('style'));
        expect(root().dataset.theme).toBe('clickhouse');
        expect(root().hasAttribute('data-theme-boot')).toBe(true);
        const canvas = resolveTheme(clickHouseTheme, mode).colors['rgb-surface-canvas'];
        expect(document.head.textContent).toContain(
          `background-color: rgb(${canvas?.split(' ').join(', ')})`,
        );
      },
    );

    it('yields to the copy this tab cached for its signed-in owner', () => {
      writeThemeCache(buildThemeCache('tenant-a:user-1', 'acme', acme));
      setThemeOwner('tenant-a:user-1');
      boot();
      expect(root().dataset.theme).toBe('acme');
    });

    it('stands in for a copy cached for someone else', () => {
      writeThemeCache(buildThemeCache('tenant-a:user-1', 'acme', acme));
      setThemeOwner('tenant-b:user-2');
      boot();
      expect(root().dataset.theme).toBe('clickhouse');
    });

    it.each(['/login', '/register', '/oauth/success'])(
      'paints on %s, which renders the same signed-out theme',
      (path) => {
        window.history.pushState({}, '', path);
        boot();
        expect(root().dataset.theme).toBe('clickhouse');
      },
    );

    it.each(['/share/abc', '/Share/abc'])(
      "does not paint on %s, which paints its own tenant's theme",
      (path) => {
        window.history.pushState({}, '', path);
        boot();
        expect(root().getAttribute('style')).toBeNull();
        expect(root().hasAttribute('data-theme')).toBe(false);
      },
    );

    it('leaves the shell alone under high contrast', () => {
      localStorage.setItem('color-theme', 'high-contrast-light');
      boot();
      expect(root().getAttribute('style')).toBeNull();
      expect(root().hasAttribute('data-theme')).toBe(false);
    });

    it('leaves an inline definition, which the build has not resolved, to the bundle', () => {
      document.getElementById(DEPLOYMENT_THEME_BOOT_ID)?.remove();
      embedShellTheme({ source: { version: 1, name: 'acme', modes: acme.modes } });
      boot();
      expect(root().getAttribute('style')).toBeNull();
      expect(root().hasAttribute('data-theme')).toBe(false);
    });

    it('paints the stock shell for a malformed block', () => {
      document.getElementById(DEPLOYMENT_THEME_BOOT_ID)?.remove();
      embedShellTheme('{not json');
      localStorage.setItem('color-theme', 'dark');
      boot();
      expect(root().getAttribute('style')).toBeNull();
      expect(document.head.textContent).toContain('background-color: #0d0d0d');
    });
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
