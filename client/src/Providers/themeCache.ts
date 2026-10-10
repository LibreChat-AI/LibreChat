import { resolveTheme, describeResolvedTheme } from '@librechat/client';
import { themeRoleFingerprint, DEPLOYMENT_THEME_BOOT_ID } from 'librechat-data-provider';
import type { TInterfaceConfig, TUser, DeploymentThemeBoot } from 'librechat-data-provider';
import type { ResolvedThemeStyle, ThemeDefinition } from '@librechat/client';

type DeploymentThemeValue = TInterfaceConfig['theme'];

/**
 * The last deployment theme a signed-in identity was served, kept apart from the
 * user's own theme keys. The boot script in `client/index.html` reads this key and
 * replays `modes` before the bundle runs, so its key and shape must stay in step.
 */
export const THEME_CACHE_KEY = 'deployment-theme';
/**
 * Derived from the registry's role set, so adding a role retires the entries stored before it.
 * `client/vite.config.ts` writes the same value into the boot script's version check.
 */
export const THEME_CACHE_VERSION = themeRoleFingerprint();
/**
 * The owner this tab last saw signed in. Session storage lives and dies with the tab, so
 * the cache is replayed only on a reload of a tab that was serving its owner; a new tab,
 * or one whose identity changed elsewhere, waits for its own answer. The boot script
 * reads this key too.
 */
export const THEME_OWNER_KEY = 'deployment-theme-owner';

export type ThemeCacheEntry = {
  v: string;
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

/**
 * A config answer; `current` is false while `keepPreviousData` shows the answer of another
 * query key. Only the signed-out answer of the same deployment is a safe stand-in, so
 * `signedOut` marks it.
 */
export type ThemeAnswer = { theme: DeploymentThemeValue; current: boolean; signedOut?: boolean };

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

const routePath = (pathname: string, basePath: string): string =>
  pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname.replace(/^\//, '');

/** `pathname` relative to the app's base path. */
export function isPublicRoute(pathname: string, basePath = '/'): boolean {
  return PUBLIC_ROUTE.test(routePath(pathname, basePath));
}

/** Shared links paint their own tenant's theme, so the deployment's base theme never stands in. */
const SHARE_ROUTE = /^share(?:\/|$)/i;

/**
 * The deployment's base `interface.theme`, which the server embeds in the shell
 * (`DEPLOYMENT_THEME_BOOT_ID`) for the boot script to paint before `/api/config` answers.
 * Absent on a shared link and wherever no server said (the Vite dev server).
 */
export function readShellTheme(
  pathname: string,
  basePath = '/',
): NonNullable<DeploymentThemeValue> | undefined {
  if (SHARE_ROUTE.test(routePath(pathname, basePath))) {
    return undefined;
  }
  try {
    const block = document.getElementById(DEPLOYMENT_THEME_BOOT_ID);
    const boot = block
      ? (JSON.parse(block.textContent ?? '') as Partial<DeploymentThemeBoot>)
      : null;
    return boot?.source ?? undefined;
  } catch {
    return undefined;
  }
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

/** The cache, only when this tab last saw its owner signed in, so the replay cannot cross identities. */
export function readOwnedThemeCache(): ThemeCacheEntry | undefined {
  try {
    const tabOwner = sessionStorage.getItem(THEME_OWNER_KEY);
    const entry = tabOwner ? readThemeCache() : undefined;
    return entry?.owner === tabOwner ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Records the tab's signed-in owner, or forgets it once no one is signed in. */
export function setThemeOwner(owner?: string): void {
  try {
    if (owner) {
      sessionStorage.setItem(THEME_OWNER_KEY, owner);
    } else {
      sessionStorage.removeItem(THEME_OWNER_KEY);
    }
  } catch {
    // Without session storage no owner is known, so the cache is never replayed.
  }
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
 * - otherwise the previous answer keeps painting while it is the signed-out one, which is
 *   the same deployment's; one from another signed-in key may be another identity's, so
 *   nothing paints until the current answer arrives.
 * Wherever nothing would paint, the deployment's base theme from the shell (`shell`) stands
 * in, as the signed-out answer does: it is served to everyone, so it is no one else's.
 * A theme that turns out invalid is cleared by the caller, which resolves it.
 */
export function reconcileThemeCache({
  cached,
  owner,
  answer,
  shell,
}: {
  cached?: ThemeCacheEntry;
  owner?: string;
  answer?: ThemeAnswer;
  shell?: DeploymentThemeValue;
}): { theme: DeploymentThemeValue; cache: ThemeCacheAction } {
  if (answer?.current) {
    if (!owner) {
      return { theme: answer.theme, cache: 'keep' };
    }
    return { theme: answer.theme, cache: answer.theme == null ? 'clear' : 'write' };
  }
  if (cached?.disowned) {
    return { theme: shell, cache: 'keep' };
  }
  if (cached && owner !== undefined && cached.owner !== owner) {
    return { theme: shell, cache: 'disown' };
  }
  if (cached) {
    return { theme: cached.source, cache: 'keep' };
  }
  if (answer && !answer.current && !answer.signedOut) {
    return { theme: shell, cache: 'keep' };
  }
  return { theme: answer ? answer.theme : shell, cache: 'keep' };
}
