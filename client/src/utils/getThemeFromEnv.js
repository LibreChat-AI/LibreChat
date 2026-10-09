import { themeColorTokens } from '@librechat/client';

const toEnvName = (token) => `REACT_APP_THEME_${token.slice(4).toUpperCase().replace(/-/g, '_')}`;

/**
 * Loads the canonical color-token registry from build-time environment variables.
 * Values are inlined by Vite and continue to use the existing REACT_APP_THEME_* names.
 * @param {Record<string, string | undefined>} [env] Environment source, defaults to the build-time env
 * @returns {import('@librechat/client').IThemeRGB | undefined}
 */
export function getThemeFromEnv(env = import.meta.env) {
  const theme = themeColorTokens.reduce((colors, token) => {
    const value = env[toEnvName(token)];
    if (value) {
      colors[token] = value;
    }
    return colors;
  }, {});

  return Object.keys(theme).length > 0 ? theme : undefined;
}
