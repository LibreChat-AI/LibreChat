import { resolveTheme, describeResolvedTheme } from '@librechat/client';
import type { ResolvedThemeStyle, ThemeDefinition } from '@librechat/client';
import type { TInterfaceConfig, TUser } from 'librechat-data-provider';

type DeploymentThemeValue = TInterfaceConfig['theme'];

/**
 * The last deployment theme a signed-in identity was served, kept apart from the
 * user's own theme keys. The boot script in `client/index.html` reads this key and
 * replays `modes` before the bundle runs, so its key and shape must stay in step.
 */
export const THEME_CACHE_KEY = 'deployment-theme';
export const THEME_CACHE_VERSION = 1;

export type ThemeCacheEntry = {
  v: typeof THEME_CACHE_VERSION;
  /** `tenantId:userId` of the identity the theme was served to. */
  owner: string;
  /** The raw `interface.theme`, which the app resolves itself until the config answers. */
  source: NonNullable<DeploymentThemeValue>;
  modes: { light: ResolvedThemeStyle; dark: ResolvedThemeStyle };
  /** In memory only: an identity mismatch proved this entry is someone else's. */
  disowned?: true;
};

/**
 * `disown` removes the stored entry and marks the one in memory, so the identity mismatch
 * it proves keeps holding, even once the identity is unknown again, until a current
 * answer arrives.
 */
export type ThemeCacheAction = 'keep' | 'clear' | 'disown' | 'write';

/** A config answer; `current` is false while `keepPreviousData` shows another identity's answer. */
export type ThemeAnswer = { theme: DeploymentThemeValue; current: boolean };

/**
 * Routes that render without the viewer's signed-in config: the auth pages, and shared
 * links, which paint their own tenant's theme. Neither the boot script nor the first
 * commit replays the cache there; `client/index.html` keeps the same list.
 */
const PUBLIC_ROUTE =
  /^(?:share|oauth|login|register|forgot-password|reset-password|verify)(?:\/|$)/i;

/** The `<base href>` path, which a subdirectory deployment moves off `/`. */
export function appBasePath(): string {
  const base = document.querySelector('base');
  return base ? new URL(base.href).pathname : '/';
}

/** `pathname` relative to the app's base path. */
export function isPublicRoute(pathname: string, basePath = '/'): boolean {
  const path = pathname.startsWith(basePath)
    ? pathname.slice(basePath.length)
    : pathname.replace(/^\//, '');
  return PUBLIC_ROUTE.test(path);
}

export const themeOwner = (user?: Pick<TUser, 'id' | 'tenantId'>): string | undefined =>
  user?.id ? `${user.tenantId ?? ''}:${user.id}` : undefined;

const isStyle = (value: unknown): value is ResolvedThemeStyle =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as ResolvedThemeStyle).properties) &&
  typeof (value as ResolvedThemeStyle).attributes === 'object';

/** A corrupt or older entry reads as absent and is removed, so it is never painted again. */
export function readThemeCache(): ThemeCacheEntry | undefined {
  try {
    const raw = localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) {
      return undefined;
    }
    const entry = JSON.parse(raw) as Partial<ThemeCacheEntry> | null;
    if (
      entry?.v === THEME_CACHE_VERSION &&
      typeof entry.owner === 'string' &&
      entry.source != null &&
      isStyle(entry.modes?.light) &&
      isStyle(entry.modes?.dark)
    ) {
      return entry as ThemeCacheEntry;
    }
    localStorage.removeItem(THEME_CACHE_KEY);
  } catch {
    // Storage is an optional adapter: denied or corrupt storage paints no cached theme.
  }
  return undefined;
}

export function clearThemeCache(): void {
  try {
    localStorage.removeItem(THEME_CACHE_KEY);
  } catch {
    // Nothing to remove when storage is unavailable.
  }
}

export function buildThemeCache(
  owner: string,
  source: NonNullable<DeploymentThemeValue>,
  definition: ThemeDefinition,
): ThemeCacheEntry {
  return {
    v: THEME_CACHE_VERSION,
    owner,
    source,
    modes: {
      light: describeResolvedTheme(resolveTheme(definition, 'light')),
      dark: describeResolvedTheme(resolveTheme(definition, 'dark')),
    },
  };
}

/** Writes only when the entry changed, so a reload that is served the same theme costs a read. */
export function writeThemeCache(entry: ThemeCacheEntry): void {
  try {
    const raw = JSON.stringify(entry);
    if (localStorage.getItem(THEME_CACHE_KEY) !== raw) {
      localStorage.setItem(THEME_CACHE_KEY, raw);
    }
  } catch {
    /** A full storage must not keep the superseded entry for the next reload to paint;
     *  without one, that reload only loses its pre-paint theme. */
    clearThemeCache();
  }
}

/**
 * Which deployment theme paints, and what happens to the cache:
 * - an answer served to the current identity wins; a signed-in one rewrites the
 *   cache (a removed theme clears it), a signed-out one never touches it;
 * - with no current answer, the cache stands in, unless the signed-in identity is
 *   known and is not the one it was served to: then nothing paints until that
 *   identity's own answer arrives, since a previous answer may be the other one's;
 * - otherwise the previous answer, if any, keeps painting as before.
 * A theme that turns out invalid is cleared by the caller, which resolves it.
 */
export function reconcileThemeCache({
  cached,
  owner,
  answer,
}: {
  cached?: ThemeCacheEntry;
  owner?: string;
  answer?: ThemeAnswer;
}): { theme: DeploymentThemeValue; cache: ThemeCacheAction } {
  if (answer?.current) {
    if (!owner) {
      return { theme: answer.theme, cache: 'keep' };
    }
    return { theme: answer.theme, cache: answer.theme == null ? 'clear' : 'write' };
  }
  if (cached?.disowned) {
    return { theme: undefined, cache: 'keep' };
  }
  if (cached && owner !== undefined && cached.owner !== owner) {
    return { theme: undefined, cache: 'disown' };
  }
  if (cached) {
    return { theme: cached.source, cache: 'keep' };
  }
  return { theme: answer?.theme, cache: 'keep' };
}
