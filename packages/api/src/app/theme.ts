import {
  bundledThemeNames,
  collectThemeIssues,
  isBundledThemeName,
  isPlainThemeRecord,
  deploymentThemeSchema,
  collectThemeWarningIssues,
} from 'librechat-data-provider';
import type { ThemeIssue } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';

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
 * A client older than this server tolerates only the unknown color names it was built to expect,
 * so a token this version does not paint is left out of the served theme rather than handed to
 * a cached client that might reject the whole definition for it.
 */
function withoutUnknownColors(
  theme: Record<string, unknown>,
  warnings: ThemeIssue[],
): Record<string, unknown> {
  const unknown = warnings.filter(({ path }) => path[2] === 'colors');
  if (unknown.length === 0 || !isPlainThemeRecord(theme.modes)) {
    return theme;
  }
  const modes: Record<string, unknown> = { ...theme.modes };
  unknown.forEach(({ path: [, mode, , token] }) => {
    const definition = modes[mode];
    if (!isPlainThemeRecord(definition) || !isPlainThemeRecord(definition.colors)) {
      return;
    }
    const { [token]: _ignored, ...colors } = definition.colors;
    modes[mode] = { ...definition, colors };
  });
  return { ...theme, modes };
}

/**
 * Checks `interface.theme` with the rules the client applies before painting it. A theme the
 * client would reject is removed, so the deployment falls back to the default theme and the rest
 * of the config still loads; unknown color and appearance tokens, which the client drops on its
 * own, only warn, and unknown colors are left out of the returned theme. A config without a
 * theme, or with a valid one naming only known colors, is returned as the same object.
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
    const warningIssues = collectThemeWarningIssues(theme);
    const warnings = warningIssues.map(formatIssue);
    const served = isPlainThemeRecord(theme) ? withoutUnknownColors(theme, warningIssues) : theme;
    if (served === theme) {
      return { config, errors, warnings };
    }
    return {
      config: { ...config, interface: { ...interfaceConfig, theme: served } },
      errors,
      warnings,
    };
  }

  const { theme: _dropped, ...rest } = interfaceConfig;
  return { config: { ...config, interface: rest }, errors, warnings: [] };
}

export interface AppConfigThemeCheck {
  /** The assembled config, the input itself unless its theme had to be cleaned or dropped. */
  appConfig: AppConfig;
  errors: string[];
  warnings: string[];
}

/**
 * The same check for an assembled config whose theme a DB override supplied: overrides are
 * merged after the YAML loader ran, so their theme would otherwise reach the client unchecked.
 */
export function checkAppConfigTheme(appConfig: AppConfig): AppConfigThemeCheck {
  const { interfaceConfig } = appConfig;
  if (interfaceConfig?.theme === undefined) {
    return { appConfig, errors: [], warnings: [] };
  }
  const { config, errors, warnings } = checkConfigTheme({ interface: interfaceConfig });
  const checked = (config as { interface: AppConfig['interfaceConfig'] }).interface;
  if (checked === interfaceConfig) {
    return { appConfig, errors, warnings };
  }
  return { appConfig: { ...appConfig, interfaceConfig: checked }, errors, warnings };
}
