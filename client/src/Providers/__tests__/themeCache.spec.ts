import { libreChatTheme, clickHouseTheme } from '@librechat/client';
import { themeRoleFingerprint, THEME_CACHE_EPOCH } from 'librechat-data-provider';
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
 * The cache version keys on the role set and a hand-bumped epoch, so a release that changes what
 * a cacheable theme resolves to (a palette value, a fallback, an emitted attribute) without
 * adding a role would replay stale styling at boot. The pin covers exactly the definitions that
 * can enter the cache: `librechat`, `clickhouse` and an inline definition with role overrides and the fallbacks around them. The
 * high-contrast palettes are not replayed by the boot script, so they are not pinned. A change
 * fails here: bump `THEME_CACHE_EPOCH` in `packages/data-provider/src/theme.ts`, then update the pin.
 */
describe('resolver output pin', () => {
  const digest = (text: string): string => {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  };

  it('moves only together with THEME_CACHE_EPOCH', () => {
    const resolved = [
      buildThemeCache(OWNER, 'librechat', libreChatTheme).modes,
      buildThemeCache(OWNER, 'clickhouse', clickHouseTheme).modes,
      buildThemeCache(OWNER, 'inline', {
        version: 1,
        name: 'inline',
        modes: {
          light: { colors: { 'rgb-text-primary': '10 20 30' } },
          dark: { colors: { 'rgb-text-primary': '230 220 210' } },
        },
      }).modes,
    ];
    expect({
      epoch: THEME_CACHE_EPOCH,
      digest: digest(JSON.stringify(resolved)),
    }).toEqual({
      epoch: 1,
      digest: 'f37285',
    });
  });
});
