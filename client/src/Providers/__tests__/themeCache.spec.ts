import { themeRoleFingerprint, themeAppearanceTokens } from 'librechat-data-provider';
import {
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
 * The baseline the cache's persisted output is pinned to. The cache version keys on the role set
 * and a hand-bumped `THEME_CACHE_EPOCH`, so a release that changes what a cacheable theme
 * resolves to without adding a role would replay stale styling at boot. The digest covers what
 * the cache persists (`buildThemeCache(...).modes`) for `librechat` and `clickhouse`, the
 * definitions that can enter the cache (the boot script never replays one under high contrast),
 * and for every role three definitions that override only that role: theme-wide, light only and
 * dark only. Every fallback path is covered and a new role joins on its own.
 */
const PIN = { fingerprint: '1.1.xbzud8', digest: 'upmlr6' };

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

type Scope = 'both' | 'light' | 'dark';
const SCOPES: Scope[] = ['both', 'light', 'dark'];
type Fixture = { key: string; theme: ThemeDefinition };

const scoped = (scope: Scope, block: (mode: 'light' | 'dark') => object) => ({
  light: scope === 'dark' ? {} : block('light'),
  dark: scope === 'light' ? {} : block('dark'),
});

/** For every role, three definitions overriding only that role: theme-wide, light and dark. */
function roleFixtures(): Fixture[] {
  const base = { version: 1 as const };
  const missing: string[] = [];
  const colors = themeColorTokens.flatMap((token) =>
    SCOPES.map((scope) => ({
      key: `color:${token}:${scope}`,
      theme: {
        ...base,
        name: token,
        modes: scoped(scope, (mode) => ({
          colors: { [token]: mode === 'light' ? '1 2 3' : '4 5 6' },
        })),
      } as ThemeDefinition,
    })),
  );
  const brands = themeBrandTokens.flatMap((token) => [
    {
      key: `brand:${token}:both`,
      theme: {
        ...base,
        name: token,
        brands: { [token]: '#123456' },
        modes: { light: {}, dark: {} },
      } as ThemeDefinition,
    },
    ...(['light', 'dark'] as const).map((scope) => ({
      key: `brand:${token}:${scope}`,
      theme: {
        ...base,
        name: token,
        modes: scoped(scope, () => ({ brands: { [token]: '#123456' } })),
      } as ThemeDefinition,
    })),
  ]);
  const appearance = themeAppearanceTokens.flatMap((token) =>
    SCOPES.flatMap((scope) => {
      const valid = APPEARANCE_CANDIDATES.map(
        (value) =>
          ({
            ...base,
            name: token,
            modes: scoped(scope, () => ({ appearance: { [token]: value } })),
          }) as ThemeDefinition,
      ).find((theme) => validateThemeDefinition(theme).length === 0);
      if (!valid) {
        missing.push(token);
        return [];
      }
      return [{ key: `appearance:${token}:${scope}`, theme: valid }];
    }),
  );
  if (missing.length > 0) {
    throw new Error(`Add valid samples to APPEARANCE_CANDIDATES for: ${missing.join(', ')}`);
  }
  return [...colors, ...brands, ...appearance];
}

const persistedOutput = () => {
  const fixtures: Fixture[] = [
    { key: 'a:librechat', theme: libreChatTheme },
    { key: 'a:clickhouse', theme: clickHouseTheme },
    ...roleFixtures(),
  ].sort((a, b) => a.key.localeCompare(b.key));
  return fixtures.map(({ key, theme }) => [key, buildThemeCache(OWNER, key, theme).modes]);
};

/** What the contributor has to do, or an empty string when the pin is current. */
function pinStatus(actual: { fingerprint: string; digest: string }): string {
  const refreshed = JSON.stringify({ fingerprint: actual.fingerprint, digest: actual.digest });
  if (actual.fingerprint !== PIN.fingerprint) {
    return `The cache version changed (role set, theme version or epoch), which already retires cached entries: set PIN to ${refreshed}.`;
  }
  if (actual.digest !== PIN.digest) {
    return `The persisted output changed without a version change: bump THEME_CACHE_EPOCH in packages/data-provider/src/theme.ts, then set PIN to the refreshed fingerprint and digest (digest ${actual.digest}).`;
  }
  return '';
}

describe('resolver output pin', () => {
  it('matches the persisted output of every cacheable definition and role fixture', () => {
    const status = pinStatus({
      fingerprint: themeRoleFingerprint(),
      digest: digestOf(JSON.stringify(persistedOutput())),
    });
    expect(status).toBe('');
  });

  it('tells a version change from an output change', () => {
    expect(pinStatus({ ...PIN, fingerprint: 'other' })).toMatch(/cache version changed/);
    expect(pinStatus({ ...PIN, digest: 'other' })).toMatch(/bump THEME_CACHE_EPOCH/);
    expect(pinStatus(PIN)).toBe('');
  });
});
