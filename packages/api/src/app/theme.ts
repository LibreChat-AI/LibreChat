import {
  bundledThemeNames,
  collectThemeIssues,
  isBundledThemeName,
  isPlainThemeRecord,
  deploymentThemeSchema,
  collectThemeWarningIssues,
} from 'librechat-data-provider';
import type { ThemeIssue } from 'librechat-data-provider';

const THEME_PATH = ['interface', 'theme'];

export interface ConfigThemeCheck {
  /** The config to validate and return: the input itself unless the theme had to be dropped. */
  config: unknown;
  /** Why the theme was dropped, one `path: reason` line per problem. */
  errors: string[];
  /** Tokens the client will ignore while still applying the rest of the theme. */
  warnings: string[];
}

const formatIssue = ({ path, message }: ThemeIssue): string =>
  `${[...THEME_PATH, ...path].join('.')}: ${message}`;

function collectErrors(theme: unknown): ThemeIssue[] {
  if (typeof theme !== 'string' && !isPlainThemeRecord(theme)) {
    return [{ path: [], message: 'Expected a bundled theme name or an inline theme definition' }];
  }
  if (typeof theme === 'string') {
    return isBundledThemeName(theme)
      ? []
      : [
          {
            path: [],
            message: `Unknown bundled theme "${theme}", expected one of: ${bundledThemeNames.join(', ')}`,
          },
        ];
  }
  const issues = collectThemeIssues(theme);
  if (issues.length > 0) {
    return issues;
  }
  const result = deploymentThemeSchema.safeParse(theme);
  if (result.success) {
    return [];
  }
  return result.error.errors.map(({ path, message }) => ({
    path: path.map(String),
    message,
  }));
}

/**
 * Checks `interface.theme` with the rules the client applies before painting it. A theme the
 * client would reject is removed, so the deployment falls back to the default theme and the rest
 * of the config still loads; unknown appearance tokens, which the client drops on its own, only
 * warn. A config without a theme, or with a valid one, is returned as the same object.
 */
export function checkConfigTheme(config: unknown): ConfigThemeCheck {
  const unchanged: ConfigThemeCheck = { config, errors: [], warnings: [] };
  if (!isPlainThemeRecord(config) || !isPlainThemeRecord(config.interface)) {
    return unchanged;
  }
  const interfaceConfig = config.interface;
  if (!('theme' in interfaceConfig) || interfaceConfig.theme === undefined) {
    return unchanged;
  }

  const theme = interfaceConfig.theme;
  const errors = collectErrors(theme).map(formatIssue);
  if (errors.length === 0) {
    return { config, errors, warnings: collectThemeWarningIssues(theme).map(formatIssue) };
  }

  const { theme: _dropped, ...rest } = interfaceConfig;
  return { config: { ...config, interface: rest }, errors, warnings: [] };
}
