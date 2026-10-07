import { themeRoleFingerprint } from 'librechat-data-provider';

export const THEME_CACHE_VERSION_PLACEHOLDER = '__THEME_CACHE_VERSION__';

/** Writes the cache version into the boot script's check, as the Vite build does for `index.html`. */
export const injectThemeCacheVersion = (html: string): string =>
  html.replace(THEME_CACHE_VERSION_PLACEHOLDER, themeRoleFingerprint());
