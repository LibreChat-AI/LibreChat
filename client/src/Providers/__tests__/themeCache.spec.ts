import {
  themeRoleFingerprint,
  THEME_CACHE_EPOCH,
  themeAppearanceTokens,
} from 'librechat-data-provider';
import {
  resolveTheme,
  themeBrandTokens,
  themeColorTokens,
  libreChatTheme,
  clickHouseTheme,
  validateThemeDefinition,
} from '@librechat/client';
import type { ThemeDefinition } from '@librechat/client';
import type { ThemeCacheEntry } from '../themeCache';
import {
  themeOwner,
  isPublicRoute,
  readThemeCache,
  buildThemeCache,
  clearThemeCache,
  writeThemeCache,
  THEME_CACHE_KEY,
  THEME_CACHE_VERSION,
  reconcileThemeCache,
} from '../themeCache';

const OWNER = 'tenant-a:user-1';
const cached: ThemeCacheEntry = buildThemeCache(OWNER, 'clickhouse', clickHouseTheme);

describe('reconcileThemeCache', () => {
  it('paints the cached theme before any config answers', () => {
    expect(reconcileThemeCache({ cached })).toEqual({ theme: 'clickhouse', cache: 'keep' });
    expect(reconcileThemeCache({ cached, owner: OWNER })).toEqual({
      theme: 'clickhouse',
      cache: 'keep',
    });
  });

  it('prefers the cache over a previous answer served to another identity', () => {
    expect(
      reconcileThemeCache({ cached, owner: OWNER, answer: { theme: undefined, current: false } }),
    ).toEqual({ theme: 'clickhouse', cache: 'keep' });
  });

  it('lets a changed theme served to the signed-in identity win and rewrite the cache', () => {
    expect(
      reconcileThemeCache({ cached, owner: OWNER, answer: { theme: 'librechat', current: true } }),
    ).toEqual({ theme: 'librechat', cache: 'write' });
  });

  it('lets a removed theme win and clears the cache', () => {
    expect(
      reconcileThemeCache({ cached, owner: OWNER, answer: { theme: undefined, current: true } }),
    ).toEqual({ theme: undefined, cache: 'clear' });
  });

  it('never paints or keeps a theme cached for another tenant or user', () => {
    const otherTenant = reconcileThemeCache({ cached, owner: 'tenant-b:user-1' });
    expect(otherTenant).toEqual({ theme: undefined, cache: 'disown' });

    const otherUser = reconcileThemeCache({
      cached,
      owner: 'tenant-a:user-2',
      answer: { theme: 'librechat', current: false },
    });
    expect(otherUser).toEqual({ theme: undefined, cache: 'disown' });
  });

  it('never paints a disowned entry, even once the identity is unknown again', () => {
    const disowned = { ...cached, disowned: true as const };
    expect(reconcileThemeCache({ cached: disowned })).toEqual({ theme: undefined, cache: 'keep' });
    expect(
      reconcileThemeCache({
        cached: disowned,
        owner: OWNER,
        answer: { theme: 'librechat', current: true },
      }),
    ).toEqual({ theme: 'librechat', cache: 'write' });
  });

  it('applies a signed-out answer without writing or clearing the cache', () => {
    expect(reconcileThemeCache({ cached, answer: { theme: undefined, current: true } })).toEqual({
      theme: undefined,
      cache: 'keep',
    });
  });

  it('keeps the uncached behavior when nothing is cached', () => {
    expect(reconcileThemeCache({})).toEqual({ theme: undefined, cache: 'keep' });
    expect(
      reconcileThemeCache({
        owner: OWNER,
        answer: { theme: 'clickhouse', current: false, signedOut: true },
      }),
    ).toEqual({ theme: 'clickhouse', cache: 'keep' });
  });

  it('paints no previous answer that came from another signed-in key', () => {
    expect(
      reconcileThemeCache({ owner: OWNER, answer: { theme: 'clickhouse', current: false } }),
    ).toEqual({ theme: undefined, cache: 'keep' });
    expect(
      reconcileThemeCache({ answer: { theme: 'clickhouse', current: false, signedOut: false } }),
    ).toEqual({ theme: undefined, cache: 'keep' });
  });

  it('stamps entries with a version derived from the registry roles', () => {
    expect(cached.v).toBe(themeRoleFingerprint());
    expect(THEME_CACHE_VERSION).toBe(themeRoleFingerprint());
  });
});

describe('theme cache storage', () => {
  beforeEach(() => localStorage.clear());

  it('matches public routes case-insensitively, as the router does', () => {
    expect(isPublicRoute('/Share/abc')).toBe(true);
    expect(isPublicRoute('/LOGIN')).toBe(true);
  });

  it('recognizes public routes under a subdirectory base path', () => {
    expect(isPublicRoute('/chat/login', '/chat/')).toBe(true);
    expect(isPublicRoute('/chat/share/abc', '/chat/')).toBe(true);
    expect(isPublicRoute('/chat/c/new', '/chat/')).toBe(false);
  });

  it('stamps the owner from the tenant and user id', () => {
    expect(themeOwner({ id: 'user-1', tenantId: 'tenant-a' })).toBe(OWNER);
    expect(themeOwner({ id: 'user-1' })).toBe(':user-1');
    expect(themeOwner(undefined)).toBeUndefined();
  });

  it('stores both modes of the resolved theme for the boot script', () => {
    expect(cached.modes.light.attributes['data-theme']).toBe('clickhouse');
    expect(cached.modes.dark.properties).toContainEqual([
      '--surface-primary',
      clickHouseTheme.modes.dark?.colors?.['rgb-surface-primary'],
    ]);
  });

  it('round-trips an entry and clears it', () => {
    writeThemeCache(cached);
    expect(readThemeCache()).toEqual(cached);
    clearThemeCache();
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  it('removes the superseded entry when a replacement cannot be stored', () => {
    writeThemeCache(cached);
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    writeThemeCache(buildThemeCache(OWNER, 'librechat', clickHouseTheme));
    setItem.mockRestore();
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  it('drops a corrupt or older entry instead of painting it', () => {
    localStorage.setItem(THEME_CACHE_KEY, '{not json');
    expect(readThemeCache()).toBeUndefined();

    localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ ...cached, v: 0 }));
    expect(readThemeCache()).toBeUndefined();
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });
});

/**
 * The baseline the resolver's output is pinned to. The cache version keys on the role set and a
 * hand-bumped `THEME_CACHE_EPOCH`, so a release that changes what a cacheable theme resolves to
 * without adding a role would replay stale styling at boot. The digest covers `librechat`,
 * `clickhouse` (the definitions that can enter the cache; the boot script never replays one under
 * high contrast) and one definition per role that overrides only that role, so every fallback
 * path is covered and a new role joins on its own.
 */
const PIN = { roles: 'xbzud8', epoch: 1, digest: 'cjwevq' };

const digestOf = (text: string): string => {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
};

const APPEARANCE_CANDIDATES = [
  '0.5rem',
  '1.25rem',
  'soft',
  'dim',
  'fill',
  '600',
  '0.5',
  '150ms',
  '9rem',
  '0 1px 2px 0 rgb(0 0 0 / 0.2)',
  'ui-sans-serif, sans-serif',
  '1.5',
  'ring',
  'border',
  'none',
];

/** One definition per role, overriding only that role with a value no default uses. */
function roleFixtures(): ThemeDefinition[] {
  const base = { version: 1 as const };
  const colors = themeColorTokens.map((token) => ({
    ...base,
    name: token,
    modes: {
      light: { colors: { [token]: '1 2 3' } },
      dark: { colors: { [token]: '4 5 6' } },
    },
  }));
  const brands = themeBrandTokens.map((token) => ({
    ...base,
    name: token,
    brands: { [token]: '#123456' },
    modes: { light: {}, dark: {} },
  }));
  const missing: string[] = [];
  const appearance = themeAppearanceTokens.flatMap((token) => {
    const valid = APPEARANCE_CANDIDATES.map((value) => ({
      ...base,
      name: token,
      modes: {
        light: { appearance: { [token]: value } },
        dark: { appearance: { [token]: value } },
      },
    })).find((theme) => validateThemeDefinition(theme as ThemeDefinition).length === 0);
    if (!valid) {
      missing.push(token);
    }
    return valid ? [valid] : [];
  });
  if (missing.length > 0) {
    throw new Error(`Add valid samples to APPEARANCE_CANDIDATES for: ${missing.join(', ')}`);
  }
  return [...colors, ...brands, ...appearance] as ThemeDefinition[];
}

const resolvedOutput = () => {
  const named: [string, ThemeDefinition][] = [
    ['librechat', libreChatTheme],
    ['clickhouse', clickHouseTheme],
  ];
  const definitions = [...named.map(([, theme]) => theme), ...roleFixtures()];
  return definitions.map((theme) => ({
    light: resolveTheme(theme, 'light'),
    dark: resolveTheme(theme, 'dark'),
  }));
};

/** What the contributor has to do, or an empty string when the pin is current. */
function pinStatus(actual: { roles: string; epoch: number; digest: string }): string {
  if (actual.roles !== PIN.roles) {
    return `The role set changed, which already retires cached entries: do not bump THEME_CACHE_EPOCH. Set PIN to ${JSON.stringify({ roles: actual.roles, epoch: PIN.epoch, digest: actual.digest })}.`;
  }
  if (actual.digest !== PIN.digest) {
    return `The resolved output changed without a role change: bump THEME_CACHE_EPOCH to ${PIN.epoch + 1} in packages/data-provider/src/theme.ts and set PIN to ${JSON.stringify({ roles: actual.roles, epoch: PIN.epoch + 1, digest: actual.digest })}.`;
  }
  if (actual.epoch !== PIN.epoch) {
    return `THEME_CACHE_EPOCH is ${actual.epoch}; set PIN.epoch to match.`;
  }
  return '';
}

describe('resolver output pin', () => {
  const current = () => ({
    roles: themeRoleFingerprint().split('.').pop() as string,
    epoch: THEME_CACHE_EPOCH,
    digest: digestOf(JSON.stringify(resolvedOutput())),
  });

  it('matches the resolved output of every cacheable definition and role fixture', () => {
    expect(pinStatus(current())).toBe('');
  });

  it('tells a role change from an output change', () => {
    const actual = { ...PIN };
    expect(pinStatus({ ...actual, roles: 'other' })).toMatch(/do not bump THEME_CACHE_EPOCH/);
    expect(pinStatus({ ...actual, digest: 'other' })).toMatch(/bump THEME_CACHE_EPOCH to/);
    expect(pinStatus({ ...actual, epoch: actual.epoch + 1 })).toMatch(/set PIN.epoch/);
  });
});
