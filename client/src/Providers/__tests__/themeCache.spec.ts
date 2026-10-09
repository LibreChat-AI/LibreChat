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
 *   dark only (the other mode absent), with each enum literal, `none` in either case and each
 *   spelling of zero the role accepts as further samples;
 * - every role the resolver derives from others, found by diffing its resolved output against the
 *   bare theme and then against its other sources named together, so a source that acts only
 *   beside another joins too; each is generated with all of its sources named, with every pair of
 *   them, and with the role named as well, every named role taking its own value, so fallback
 *   precedence and opting out are covered without listing the chains by hand;
 * - every brand set theme-wide, in light and in dark with conflicting values;
 * - every pair of candidates for roles validated together;
 * - definitions with one or both mode blocks absent.
 * A new role, or a new fallback, joins by construction.
 */
const PIN = { fingerprint: '1.3.fgvuqz', digest: '82mvtk' };

const digestOf = (text: string): string => {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
};

/** Locale-independent, so the digest does not depend on the collation Jest runs under. */
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

/**
 * Values a role may switch on or canonicalize: every enum literal an appearance validator names,
 * `none` in either case for the composable shadows, and zero written more than one way. The
 * validators are predicates, so these are listed, not read from them.
 */
const SPECIAL_CANDIDATES = [
  'soft',
  'dim',
  'fill',
  'transparent',
  'inherit',
  'ring',
  'border',
  'none',
  'None',
  '0',
  '.0',
  '0.0',
];

const APPEARANCE_CANDIDATES = [
  ...SPECIAL_CANDIDATES,
  '0.5rem',
  '1rem',
  '1.25rem',
  '2rem',
  '9rem',
  '24px',
  '40px',
  '600',
  '0.5',
  '150ms',
  '0 1px 2px 0 rgb(0 0 0 / 0.2)',
  'ui-sans-serif, sans-serif',
  'Georgia, serif',
  '1.5',
].sort(byCodePoint);

/** Roles the validator checks together, so a pair can be rejected though each side is valid alone. */
const JOINTLY_VALIDATED: ReadonlyArray<[string, string]> = [['switchWidth', 'switchHeight']];

type Scope = 'both' | 'light' | 'dark';
type Mode = 'light' | 'dark';
type Kind = 'colors' | 'appearance';
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

const isValid = (theme: ThemeDefinition): boolean => validateThemeDefinition(theme).length === 0;
const isValidAppearance = (appearance: Record<string, string>): boolean =>
  isValid(define('probe', () => ({ appearance }), 'both'));

/**
 * Every candidate the validator accepts for each appearance role, keyed in code point order so
 * reordering the validators changes nothing, and pinned so a narrowing or widening shows.
 */
const ACCEPTED: Record<string, string[]> = Object.fromEntries(
  [...themeAppearanceTokens]
    .sort(byCodePoint)
    .map((token) => [
      token,
      APPEARANCE_CANDIDATES.filter((value) => isValidAppearance({ [token]: value })),
    ]),
);

/** Every pair of candidates the validator accepts for each jointly validated pair of roles. */
const ACCEPTED_PAIRS: Record<string, Array<[string, string]>> = Object.fromEntries(
  JOINTLY_VALIDATED.map(([first, second]) => [
    `${first}+${second}`,
    APPEARANCE_CANDIDATES.flatMap((a) =>
      APPEARANCE_CANDIDATES.filter((b) => isValidAppearance({ [first]: a, [second]: b })).map(
        (b): [string, string] => [a, b],
      ),
    ),
  ]),
);

const SPECIAL = new Set(SPECIAL_CANDIDATES);

/** The first sample the validator accepts for an appearance role, and every special one it takes. */
function appearanceSamples(token: string): string[] {
  const accepted = ACCEPTED[token];
  if (accepted.length === 0) {
    throw new Error(`Add a valid sample for the appearance role ${token} to APPEARANCE_CANDIDATES`);
  }
  return [...new Set([accepted[0], ...accepted.filter((value) => SPECIAL.has(value))])];
}

const SAMPLES = Object.fromEntries(
  themeAppearanceTokens.map((token) => [token, appearanceSamples(token)]),
);

const colorOverrides = (tokens: readonly string[], mode: Mode): Record<string, string> =>
  Object.fromEntries(tokens.map((token, index) => [token, COLOR_SENTINEL[mode](index)]));

/**
 * Each role takes the accepted value at its position, so roles sharing a validator, such as
 * `fontFamily` and `displayFontFamily`, carry distinct values and a role inheriting one of them
 * shows which it read.
 */
const appearanceOverrides = (tokens: readonly string[]): Record<string, string> =>
  Object.fromEntries(
    tokens.map((token, index) => [token, ACCEPTED[token][index % ACCEPTED[token].length]]),
  );

const OVERRIDES: Record<Kind, (tokens: readonly string[], mode: Mode) => Overrides> = {
  colors: (tokens, mode) => ({ colors: colorOverrides(tokens, mode) }),
  appearance: (tokens) => ({ appearance: appearanceOverrides(tokens) }),
};

const TOKENS: Record<Kind, readonly string[]> = {
  colors: themeColorTokens,
  appearance: themeAppearanceTokens,
};

/** The resolved roles of one kind in each mode, with `tokens` named. */
const resolvedRoles = (kind: Kind, tokens: readonly string[]): Array<Record<string, unknown>> =>
  MODES.map(
    (mode) =>
      resolveTheme(
        define('probe', (current) => OVERRIDES[kind](tokens, current), 'both'),
        mode,
      )[kind] as Record<string, unknown>,
  );

const differs = (
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
  key: string,
): boolean => before.some((roles, index) => roles[key] !== after[index][key]);

/**
 * Role to the roles that change it, read from the resolver: first each role named alone, then each
 * further role named beside a derived role's sources, which finds a source that only acts jointly.
 */
function findDerived(kind: Kind): Map<string, string[]> {
  const base = resolvedRoles(kind, []);
  const found = new Map<string, Set<string>>();
  TOKENS[kind].forEach((source) => {
    const after = resolvedRoles(kind, [source]);
    Object.keys(after[0])
      .filter((key) => key !== source && differs(base, after, key))
      .forEach((key) => found.set(key, (found.get(key) ?? new Set()).add(source)));
  });
  found.forEach((sources, target) => {
    const named = [...sources];
    const before = resolvedRoles(kind, named);
    TOKENS[kind]
      .filter((token) => token !== target && !named.includes(token))
      .filter((token) => differs(before, resolvedRoles(kind, [...named, token]), target))
      .forEach((token) => sources.add(token));
  });
  return new Map(
    [...found].map(([key, sources]) => [key, [...sources].sort(byCodePoint)] as [string, string[]]),
  );
}

let derived: Record<Kind, Map<string, string[]>> | undefined;
const derivedRoles = (): Record<Kind, Map<string, string[]>> => {
  derived ??= { colors: findDerived('colors'), appearance: findDerived('appearance') };
  return derived;
};

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
    SAMPLES[token].flatMap((value) =>
      SCOPES.map((scope) => ({
        key: `appearance:${token}:${value}:${scope}`,
        theme: define(token, () => ({ appearance: { [token]: value } }), scope),
      })),
    ),
  );
  return [...colors, ...brands, ...appearance];
}

/**
 * Each derived role with all of its sources named together, with every pair of them, and with the
 * role named as well.
 */
function derivedFixtures(): Fixture[] {
  const roles = derivedRoles();
  return (['colors', 'appearance'] as const).flatMap((kind) =>
    [...roles[kind]].flatMap(([target, sources]) => {
      const named = (tokens: string[], scope: Scope) =>
        define(target, (mode) => OVERRIDES[kind](tokens, mode), scope);
      const pairs = sources.flatMap((first, index) =>
        sources.slice(index + 1).map((second) => ({
          key: `derived:${kind}:${target}:pair:${first}+${second}`,
          theme: named([first, second], 'both'),
        })),
      );
      return [
        ...SCOPES.flatMap((scope) => [
          { key: `derived:${kind}:${target}:sources:${scope}`, theme: named(sources, scope) },
          {
            key: `derived:${kind}:${target}:named:${scope}`,
            theme: named([...sources, target], scope),
          },
        ]),
        ...pairs,
      ];
    }),
  );
}

/** Every accepted pair of the jointly validated roles. */
function jointFixtures(): Fixture[] {
  return JOINTLY_VALIDATED.flatMap(([first, second]) =>
    ACCEPTED_PAIRS[`${first}+${second}`].map(([a, b]) => ({
      key: `joint:${first}:${a}:${second}:${b}`,
      theme: define(first, () => ({ appearance: { [first]: a, [second]: b } }), 'both'),
    })),
  );
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
  properties: [...properties].sort(([a], [b]) => byCodePoint(a, b)),
  attributes: Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => byCodePoint(a, b))),
});

const persistedOutput = () => {
  const fixtures: Fixture[] = [
    { key: 'a:librechat', theme: libreChatTheme },
    { key: 'a:clickhouse', theme: clickHouseTheme },
    ...roleFixtures(),
    ...derivedFixtures(),
    ...jointFixtures(),
    ...modeFixtures(),
  ].sort((a, b) => byCodePoint(a.key, b.key));
  return fixtures.map(({ key, theme }) => {
    const { light, dark } = buildThemeCache(OWNER, key, theme).modes;
    return [key, canonical(light), canonical(dark)];
  });
};

/** What the contributor has to do, or an empty string when the pin is current. */
function pinStatus(actual: typeof PIN): string {
  const refreshed = JSON.stringify(actual);
  if (actual.fingerprint !== PIN.fingerprint) {
    return `The cache version changed (role set, theme version or epoch), which already retires cached entries: set PIN to ${refreshed}.`;
  }
  if (actual.digest !== PIN.digest) {
    return `The persisted output or the accepted appearance values changed without a version change: bump THEME_CACHE_EPOCH in packages/data-provider/src/theme.ts, then set PIN to the refreshed fingerprint and digest (digest ${actual.digest}).`;
  }
  return '';
}

describe('resolver output pin', () => {
  it('matches the persisted output of every cacheable definition and generated fixture', () => {
    const status = pinStatus({
      fingerprint: themeRoleFingerprint(),
      digest: digestOf(
        JSON.stringify({
          accepted: ACCEPTED,
          acceptedPairs: ACCEPTED_PAIRS,
          output: persistedOutput(),
        }),
      ),
    });
    expect(status).toBe('');
  });

  it('finds the fallback chains in the resolver, not in a list', () => {
    const { colors, appearance } = derivedRoles();
    expect(colors.get('rgb-surface-code')).toContain('rgb-surface-primary-alt');
    expect(colors.get('rgb-link-prose')).toContain('rgb-link');
    expect(appearance.get('menuShadow')).toContain('shadowLg');
  });

  it('finds a source that acts only beside another', () => {
    expect(derivedRoles().colors.get('rgb-series-8')).toEqual(
      expect.arrayContaining(['rgb-series-1', 'rgb-text-secondary']),
    );
  });

  it('gives roles sharing a validator distinct values', () => {
    const named = appearanceOverrides(['fontFamily', 'displayFontFamily']);
    expect(named.fontFamily).not.toBe(named.displayFontFamily);
    expect(derivedRoles().appearance.get('dialogTitleFontFamily')).toEqual(
      expect.arrayContaining(['displayFontFamily', 'fontFamily']),
    );
  });

  it('samples every enum literal, both cases of none and each spelling of zero', () => {
    expect(SAMPLES.fieldFillStyle).toEqual(expect.arrayContaining(['fill', 'transparent']));
    expect(SAMPLES.labelFontWeight).toContain('inherit');
    expect(SAMPLES.shadowLg).toEqual(expect.arrayContaining(['none', 'None']));
    expect(SAMPLES.chromeBorderAlpha).toEqual(expect.arrayContaining(['0', '.0', '0.0']));
  });

  it('pins the pairs a joint rule accepts, not only each side alone', () => {
    const pairs = ACCEPTED_PAIRS['switchWidth+switchHeight'];
    expect(pairs).toContainEqual(['1rem', '0.5rem']);
    expect(pairs).not.toContainEqual(['0.5rem', '1rem']);
    expect(ACCEPTED.switchWidth).not.toContain('1rem');
  });

  it('tells a version change from an output change', () => {
    expect(pinStatus({ ...PIN, fingerprint: 'other' })).toMatch(/cache version changed/);
    expect(pinStatus({ ...PIN, digest: 'other' })).toMatch(/bump THEME_CACHE_EPOCH/);
    expect(pinStatus(PIN)).toBe('');
  });
});
