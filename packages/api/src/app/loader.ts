import axios from 'axios';
import yaml from 'js-yaml';
import { logger } from '@librechat/data-schemas';
import {
  configSchema,
  EModelEndpoint,
  EImageOutputType,
  getMaxSubagents,
  setMaxSubagents,
} from 'librechat-data-provider';
import type { TCustomConfig, TEndpoint } from 'librechat-data-provider';
import type { ConfigOverrideIssue } from '@librechat/data-schemas';
import type { ZodIssue } from 'zod';
import { checkConfigPolicyLinks } from './interface';
import { expandCustomEndpoint } from './params';
import { checkConfigTheme } from './theme';

export type CustomConfigLoadMode = 'startup' | 'reload';

export interface CustomConfigLoadOptions {
  mode?: CustomConfigLoadMode;
}

export interface CustomConfigLoaderOptions {
  defaultConfigPath: string;
  loadLocal: (configPath: string) => unknown;
  fetchRemote?: (configPath: string) => Promise<unknown>;
  redactConfig: (config: TCustomConfig) => TCustomConfig;
}

export class ConfigReloadError extends Error {
  readonly validationErrors?: readonly ZodIssue[];
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown, validationErrors?: readonly ZodIssue[]) {
    super(message);
    this.name = 'ConfigReloadError';
    this.cause = cause;
    this.validationErrors = validationErrors;
  }
}

/**
 * Why librechat.yaml did not load again: `CONFIG_INVALID` when the loader refused the file
 * (missing, unreadable or not fetched, unparseable, or failing `configSchema`, whose issues it
 * lists by location), `LOAD_FAILED` when anything else failed, such as building the config from
 * a file that loaded. The instance keeps its last good config.
 */
export type ConfigLoadFailure =
  | { code: 'CONFIG_INVALID'; issues: ConfigOverrideIssue[] }
  | { code: 'LOAD_FAILED' };

export type ConfigLoadResult = { ok: true } | { ok: false; error: ConfigLoadFailure };

function toLoadIssue(segments: string[], code: string): ConfigOverrideIssue {
  return { path: segments.join('.'), segments, code };
}

/**
 * Locations and zod codes only, since schema messages can echo the file's values; an
 * unrecognized key is reported at its own location.
 */
export function getConfigLoadFailure(error: unknown): ConfigLoadFailure {
  if (!(error instanceof ConfigReloadError)) {
    return { code: 'LOAD_FAILED' };
  }
  const issues = (error.validationErrors ?? []).flatMap((issue) => {
    const segments = issue.path.map(String);
    if (issue.code !== 'unrecognized_keys') {
      return [toLoadIssue(segments, issue.code)];
    }
    return issue.keys.map((key) => toLoadIssue([...segments, key], issue.code));
  });
  return { code: 'CONFIG_INVALID', issues };
}

function getConfiguredMaxSubagents(config: unknown): number | undefined {
  if (typeof config !== 'object' || config == null || !('endpoints' in config)) {
    return undefined;
  }
  const endpoints = config.endpoints;
  if (typeof endpoints !== 'object' || endpoints == null || !(EModelEndpoint.agents in endpoints)) {
    return undefined;
  }
  const agents = endpoints[EModelEndpoint.agents];
  if (typeof agents !== 'object' || agents == null || !('maxSubagents' in agents)) {
    return undefined;
  }
  return typeof agents.maxSubagents === 'number' ? agents.maxSubagents : undefined;
}

function isRemoteConfigPath(configPath: string): boolean {
  return /^https?:\/\//.test(configPath);
}

function reportPolicyLinkCheck(configPath: string, dropped: string[]): void {
  if (dropped.length === 0) {
    return;
  }
  logger.warn(
    `Ignoring policy links in ${configPath} that are not http(s), mailto:, tel: or relative URLs; no link is published for them:\n` +
      dropped.map((path) => `- ${path}`).join('\n'),
  );
}

function reportThemeCheck(configPath: string, errors: string[], warnings: string[]): void {
  if (errors.length > 0) {
    logger.warn(
      `Ignoring interface.theme in ${configPath}; the default theme applies instead:\n` +
        errors.map((error) => `- ${error}`).join('\n'),
    );
  }
  if (warnings.length > 0) {
    logger.warn(
      `interface.theme in ${configPath} names tokens this version ignores:\n` +
        warnings.map((warning) => `- ${warning}`).join('\n'),
    );
  }
}

/** Creates one process-local custom-config reader. */
export function createCustomConfigLoader({
  defaultConfigPath,
  loadLocal,
  redactConfig,
  fetchRemote = async (configPath: string): Promise<unknown> => (await axios.get(configPath)).data,
}: CustomConfigLoaderOptions): (
  printConfig?: boolean,
  options?: CustomConfigLoadOptions,
) => Promise<TCustomConfig | null> {
  let hasLoggedSourceFailure = false;

  return async function loadCustomConfig(
    printConfig = true,
    options: CustomConfigLoadOptions = {},
  ): Promise<TCustomConfig | null> {
    const mode = options.mode ?? 'startup';
    const configPath = process.env.CONFIG_PATH || defaultConfigPath;
    const previousMaxSubagents = getMaxSubagents();
    let loadedSuccessfully = false;

    const failSourceLoad = (
      message: string,
      cause?: unknown,
      startupLogLevel: 'error' | 'info' = 'error',
    ): null => {
      if (mode === 'reload') {
        if (cause == null) {
          logger.error(message);
        } else {
          logger.error(message, cause);
        }
        throw new ConfigReloadError(message, cause);
      }
      if (!hasLoggedSourceFailure) {
        if (startupLogLevel === 'error') {
          logger.error(message, cause);
        } else if (cause == null) {
          logger.info(message);
        } else {
          logger.info(message, cause);
        }
        hasLoggedSourceFailure = true;
      }
      return null;
    };

    try {
      let loadedConfig: unknown;
      if (isRemoteConfigPath(configPath)) {
        try {
          loadedConfig = await fetchRemote(configPath);
        } catch (error) {
          return failSourceLoad(`Failed to fetch the remote config file from ${configPath}`, error);
        }
      } else {
        loadedConfig = loadLocal(configPath);
        if (!loadedConfig) {
          return failSourceLoad(
            'Custom config file missing or YAML format invalid.\n\n' +
              'Check out the latest config file guide for configurable options and features.\n' +
              'https://www.librechat.ai/docs/configuration/librechat_yaml\n\n',
            undefined,
            'info',
          );
        }
        if (
          loadedConfig instanceof Error ||
          (typeof loadedConfig === 'object' &&
            loadedConfig != null &&
            ('reason' in loadedConfig || 'stack' in loadedConfig))
        ) {
          return failSourceLoad('Config file YAML format is invalid:', loadedConfig);
        }
      }

      if (typeof loadedConfig === 'string') {
        try {
          loadedConfig = yaml.load(loadedConfig);
        } catch (error) {
          return failSourceLoad(
            `Failed to parse the YAML config from ${configPath}`,
            error,
            'info',
          );
        }
      }

      const themeCheck = checkConfigTheme(loadedConfig);
      loadedConfig = themeCheck.config;
      reportThemeCheck(configPath, themeCheck.errors, themeCheck.warnings);
      const linkCheck = checkConfigPolicyLinks(loadedConfig);
      loadedConfig = linkCheck.config;
      reportPolicyLinkCheck(configPath, linkCheck.dropped);

      setMaxSubagents(getConfiguredMaxSubagents(loadedConfig));
      const result = configSchema.strict().safeParse(loadedConfig);
      if (
        result.error?.issues.some(
          (error) => error.path != null && error.path.includes('imageOutputType'),
        )
      ) {
        throw new Error(
          `\nPlease specify a correct \`imageOutputType\` value (case-sensitive).\n\n` +
            'The available options are:\n' +
            `- ${EImageOutputType.JPEG}\n` +
            `- ${EImageOutputType.PNG}\n` +
            `- ${EImageOutputType.WEBP}\n\n` +
            'Refer to the latest config file guide for more information:\n' +
            'https://www.librechat.ai/docs/configuration/librechat_yaml',
        );
      }
      if (!result.success) {
        const message = `Invalid custom config file at ${configPath}:\n${JSON.stringify(result.error, null, 2)}`;
        logger.error(message);
        const speechError = result.error.issues.find(
          (error) =>
            error.code === 'unrecognized_keys' &&
            (error.message?.includes('stt') || error.message?.includes('tts')),
        );
        if (speechError) {
          logger.warn(
            '\nThe Speech-to-text and Text-to-speech configuration format has recently changed.\n' +
              "If you're getting this error, please refer to the latest documentation:\n\n" +
              'https://www.librechat.ai/docs/configuration/stt_tts',
          );
        }

        if (process.env.CONFIG_BYPASS_VALIDATION === 'true') {
          logger.warn(
            'CONFIG_BYPASS_VALIDATION is enabled. Continuing with default configuration despite validation errors.',
          );
          if (mode === 'reload') {
            throw new ConfigReloadError(message, result.error, result.error.issues);
          }
          return null;
        }
        if (mode === 'reload') {
          throw new ConfigReloadError(message, result.error, result.error.issues);
        }

        logger.error(
          'Exiting due to invalid configuration. Set CONFIG_BYPASS_VALIDATION=true to bypass this check.',
        );
        process.exit(1);
      }

      const customConfig = loadedConfig as TCustomConfig;
      /** Expanded copies are discarded: AppService serves them, and the config stays as written. */
      for (const endpoint of (customConfig.endpoints?.custom ?? []) as TEndpoint[]) {
        expandCustomEndpoint(endpoint);
      }
      if (result.data.modelSpecs) {
        customConfig.modelSpecs = result.data.modelSpecs;
      }

      if (printConfig) {
        const loggableConfig = redactConfig(customConfig);
        logger.info('Custom config file loaded:');
        logger.info(JSON.stringify(loggableConfig, null, 2));
        logger.debug('Custom config:', loggableConfig);
      }

      loadedSuccessfully = true;
      return customConfig;
    } catch (error) {
      if (mode === 'reload' && !(error instanceof ConfigReloadError)) {
        throw new ConfigReloadError(`Failed to reload custom config from ${configPath}`, error);
      }
      throw error;
    } finally {
      if (!loadedSuccessfully) {
        setMaxSubagents(previousMaxSubagents);
      }
    }
  };
}
