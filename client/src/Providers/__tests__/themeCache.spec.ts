import {
  THEME_VERSION,
  themeRoleFingerprint,
  themeAppearanceTokens,
} from 'librechat-data-provider';
import {
  themeBrandTokens,
  themeColorTokens,
  resolveTheme,
  libreChatTheme,
  clickHouseTheme,
  validateThemeDefinition,
} from '@librechat/client';
import type { ThemeDefinition, ResolvedThemeStyle } from '@librechat/client';
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
 * the cache persists (`buildThemeCache(...).modes`, with the property order canonicalized) for
 * `librechat` and `clickhouse`, the definitions that can enter the cache (the boot script never
 * replays one under high contrast), and for generated definitions:
 * - every color, brand and appearance role overridden alone, theme-wide, in light only and in
 *   dark only (the other mode absent), plus a `none` sample for each shadow-like role;
 * - every role the resolver derives from others, found by diffing its resolved output against the
 *   bare theme, with all of its sources named together and again with the role named as well, theme-wide and per mode, so
 *   fallback precedence and opting out are covered without listing the chains by hand;
 * - every brand set theme-wide, in light and in dark with conflicting values;
 * - definitions with one or both mode blocks absent.
 * A new role, or a new fallback, joins by construction.
 */
const PIN = { fingerprint: '1.1.xbzud8', digest: '1cm12nf' };

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
type Mode = 'light' | 'dark';
type Overrides = {
  colors?: Record<string, string>;
  appearance?: Record<string, string>;
  brands?: Record<string, string>;
};
type Fixture = { key: string; theme: ThemeDefinition };

const SCOPES: Scope[] = ['both', 'light', 'dark'];
const MODES: Mode[] = ['light', 'dark'];
const COLOR_SENTINEL: Record<Mode, (index: number) => string> = {
  light: (index) => `${10 + index} 20 30`,
  dark: (index) => `${200 - index} 210 220`,
};

/** A definition whose inactive mode block is absent, not empty. */
const define = (
  name: string,
  overrides: (mode: Mode) => Overrides,
  scope: Scope,
  wideBrands?: Record<string, string>,
): ThemeDefinition =>
  ({
    version: THEME_VERSION,
    name,
    ...(wideBrands && { brands: wideBrands }),
    modes: Object.fromEntries(
      MODES.filter((mode) => scope === 'both' || scope === mode).map((mode) => [
        mode,
        overrides(mode),
      ]),
    ),
  }) as ThemeDefinition;

const BARE = define('bare', () => ({}), 'both');
const isValid = (theme: ThemeDefinition): boolean => validateThemeDefinition(theme).length === 0;

/** The first sample the validator accepts for an appearance role, and `none` when it takes it. */
function appearanceSamples(token: string): string[] {
  const accepted = APPEARANCE_CANDIDATES.filter((value) =>
    isValid(define(token, () => ({ appearance: { [token]: value } }), 'both')),
  );
  if (accepted.length === 0) {
    throw new Error(`Add a valid sample for the appearance role ${token} to APPEARANCE_CANDIDATES`);
  }
  return [...new Set([accepted[0], ...accepted.filter((value) => value === 'none')])];
}

const SAMPLES = Object.fromEntries(
  themeAppearanceTokens.map((token) => [token, appearanceSamples(token)]),
);

const colorOverrides = (tokens: readonly string[], mode: Mode): Record<string, string> =>
  Object.fromEntries(tokens.map((token, index) => [token, COLOR_SENTINEL[mode](index)]));

const appearanceOverrides = (tokens: readonly string[]): Record<string, string> =>
  Object.fromEntries(tokens.map((token) => [token, SAMPLES[token][0]]));

/** Role to the roles whose single override changes it, read from the resolver. */
function derivedRoles(): { colors: Map<string, string[]>; appearance: Map<string, string[]> } {
  const base = MODES.map((mode) => resolveTheme(BARE, mode));
  const found = {
    colors: new Map<string, Set<string>>(),
    appearance: new Map<string, Set<string>>(),
  };
  const note = (kind: 'colors' | 'appearance', source: string, theme: ThemeDefinition) =>
    MODES.forEach((mode, index) => {
      const resolved = resolveTheme(theme, mode);
      const before = base[index][kind] as Record<string, unknown>;
      const after = resolved[kind] as Record<string, unknown>;
      Object.keys(after)
        .filter((key) => key !== source && after[key] !== before[key])
        .forEach((key) => found[kind].set(key, (found[kind].get(key) ?? new Set()).add(source)));
    });
  themeColorTokens.forEach((token) =>
    note(
      'colors',
      token,
      define(token, (mode) => ({ colors: colorOverrides([token], mode) }), 'both'),
    ),
  );
  themeAppearanceTokens.forEach((token) =>
    note(
      'appearance',
      token,
      define(token, () => ({ appearance: appearanceOverrides([token]) }), 'both'),
    ),
  );
  const sorted = (map: Map<string, Set<string>>) =>
    new Map([...map].map(([key, sources]) => [key, [...sources].sort()] as [string, string[]]));
  return { colors: sorted(found.colors), appearance: sorted(found.appearance) };
}

function roleFixtures(): Fixture[] {
  const colors = themeColorTokens.flatMap((token) =>
    SCOPES.map((scope) => ({
      key: `color:${token}:${scope}`,
      theme: define(token, (mode) => ({ colors: colorOverrides([token], mode) }), scope),
    })),
  );
  const brands = themeBrandTokens.flatMap((token) => [
    {
      key: `brand:${token}:wide`,
      theme: define(token, () => ({}), 'both', { [token]: '#123456' }),
    },
    ...MODES.map((mode) => ({
      key: `brand:${token}:${mode}`,
      theme: define(token, () => ({ brands: { [token]: '#123456' } }), mode),
    })),
    {
      key: `brand:${token}:conflict`,
      theme: define(
        token,
        (mode) => ({ brands: { [token]: mode === 'light' ? '#aa0000' : '#00aa00' } }),
        'both',
        { [token]: '#0000aa' },
      ),
    },
  ]);
  const appearance = themeAppearanceTokens.flatMap((token) =>
    SAMPLES[token].flatMap((value, index) =>
      SCOPES.map((scope) => ({
        key: `appearance:${token}:${index}:${scope}`,
        theme: define(token, () => ({ appearance: { [token]: value } }), scope),
      })),
    ),
  );
  return [...colors, ...brands, ...appearance];
}

/** Each derived role with all of its sources named together, then with the role named as well. */
function derivedFixtures(): Fixture[] {
  const { colors, appearance } = derivedRoles();
  const fixtures = (
    kind: 'color' | 'appearance',
    chains: Map<string, string[]>,
    overrides: (tokens: string[], mode: Mode) => Overrides,
  ) =>
    [...chains].flatMap(([target, sources]) =>
      SCOPES.flatMap((scope) => [
        {
          key: `derived:${kind}:${target}:sources:${scope}`,
          theme: define(target, (mode) => overrides(sources, mode), scope),
        },
        {
          key: `derived:${kind}:${target}:named:${scope}`,
          theme: define(target, (mode) => overrides([...sources, target], mode), scope),
        },
      ]),
    );
  return [
    ...fixtures('color', colors, (tokens, mode) => ({ colors: colorOverrides(tokens, mode) })),
    ...fixtures('appearance', appearance, (tokens) => ({
      appearance: appearanceOverrides(tokens),
    })),
  ];
}

/** Mode blocks that are missing or empty, on a bare theme and on a bundled one. */
function modeFixtures(): Fixture[] {
  const without = (theme: ThemeDefinition, mode: Mode): ThemeDefinition => {
    const modes = { ...theme.modes };
    delete modes[mode];
    return { ...theme, modes };
  };
  return [
    { key: 'modes:none', theme: { version: THEME_VERSION, name: 'none', modes: {} } },
    { key: 'modes:empty', theme: define('empty', () => ({}), 'both') },
    { key: 'modes:clickhouse:no-light', theme: without(clickHouseTheme, 'light') },
    { key: 'modes:clickhouse:no-dark', theme: without(clickHouseTheme, 'dark') },
  ];
}

/** Property order is positional in the cache entry and means nothing to the page. */
const canonical = ({ properties, attributes }: ResolvedThemeStyle) => ({
  properties: [...properties].sort(([a], [b]) => a.localeCompare(b)),
  attributes: Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))),
});

const persistedOutput = () => {
  const fixtures: Fixture[] = [
    { key: 'a:librechat', theme: libreChatTheme },
    { key: 'a:clickhouse', theme: clickHouseTheme },
    ...roleFixtures(),
    ...derivedFixtures(),
    ...modeFixtures(),
  ].sort((a, b) => a.key.localeCompare(b.key));
  return fixtures.map(({ key, theme }) => {
    const { light, dark } = buildThemeCache(OWNER, key, theme).modes;
    return [key, canonical(light), canonical(dark)];
  });
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
  it('matches the persisted output of every cacheable definition and generated fixture', () => {
    const status = pinStatus({
      fingerprint: themeRoleFingerprint(),
      digest: digestOf(JSON.stringify(persistedOutput())),
    });
    expect(status).toBe('');
  });

  it('finds the fallback chains in the resolver, not in a list', () => {
    const { colors, appearance } = derivedRoles();
    expect(colors.get('rgb-surface-code')).toContain('rgb-surface-primary-alt');
    expect(colors.get('rgb-link-prose')).toContain('rgb-link');
    expect(appearance.get('menuShadow')).toContain('shadowLg');
  });

  it('tells a version change from an output change', () => {
    expect(pinStatus({ ...PIN, fingerprint: 'other' })).toMatch(/cache version changed/);
    expect(pinStatus({ ...PIN, digest: 'other' })).toMatch(/bump THEME_CACHE_EPOCH/);
    expect(pinStatus(PIN)).toBe('');
  });
});
