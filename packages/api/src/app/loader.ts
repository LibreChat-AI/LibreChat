import axios from 'axios';
import yaml from 'js-yaml';
import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import {
  configSchema,
  paramSettings,
  EModelEndpoint,
  EImageOutputType,
  getMaxSubagents,
  setMaxSubagents,
  agentParamSettings,
  validateSettingDefinitions,
} from 'librechat-data-provider';
import type { TCustomConfig, TEndpoint } from 'librechat-data-provider';
import type { ZodIssue } from 'zod';
import type { AllowedAddressEnvDropReason } from '../auth/allowedAddresses';
import { resolveConfigAllowedAddresses } from './addresses';
import { checkConfigTheme } from './theme';

/** The resolved value is never logged: a misconfigured variable may hold a URL with credentials. */
const ALLOWED_ADDRESS_DROP_MESSAGES: Record<AllowedAddressEnvDropReason, string> = {
  unset: 'the environment variable is unset or empty',
  invalid:
    'the environment variable does not resolve to a host:port entry in private address space',
  sensitive: 'the environment variable is an infrastructure secret and is never resolved',
};

type CustomParams = NonNullable<TEndpoint['customParams']>;
type CustomParamDefinition = NonNullable<CustomParams['paramDefinitions']>[number];

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

const OPENROUTER_PROMPT_CACHE_DEFAULT = {
  key: 'promptCache',
  default: true,
};

function includesOpenRouter(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(Providers.OPENROUTER);
}

function isOpenRouterEndpoint(endpoint: TEndpoint): boolean {
  return includesOpenRouter(endpoint.name) || includesOpenRouter(endpoint.baseURL);
}

function shouldPreserveCustomParams(customParams: CustomParams | undefined): boolean {
  const defaultEndpoint = customParams?.defaultParamsEndpoint;
  return (
    !!defaultEndpoint && defaultEndpoint !== 'custom' && defaultEndpoint !== Providers.OPENROUTER
  );
}

function addOpenRouterDefaults(endpoint: TEndpoint): void {
  if (!isOpenRouterEndpoint(endpoint) || shouldPreserveCustomParams(endpoint.customParams)) {
    return;
  }

  const customParams: CustomParams = endpoint.customParams ?? {
    defaultParamsEndpoint: 'custom',
  };
  const paramDefinitions = customParams.paramDefinitions ?? [];
  const hasPromptCache = paramDefinitions.some((param) => param.key === 'promptCache');

  endpoint.customParams = {
    ...customParams,
    defaultParamsEndpoint: Providers.OPENROUTER,
    paramDefinitions: hasPromptCache
      ? paramDefinitions
      : [...paramDefinitions, OPENROUTER_PROMPT_CACHE_DEFAULT],
  };
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

function parseCustomParams(endpointName: string | undefined, customParams: CustomParams): void {
  const paramEndpoint = customParams.defaultParamsEndpoint ?? 'custom';
  customParams.defaultParamsEndpoint = paramEndpoint;
  const paramDefinitions = customParams.paramDefinitions ?? [];
  customParams.paramDefinitions = paramDefinitions;

  const validEndpoints = new Set([
    ...Object.keys(paramSettings),
    ...Object.keys(agentParamSettings),
  ]);
  if (!validEndpoints.has(paramEndpoint)) {
    throw new Error(
      `defaultParamsEndpoint of "${endpointName}" endpoint is invalid. ` +
        `Valid options are ${Array.from(validEndpoints).join(', ')}`,
    );
  }

  const regularParams = paramSettings[paramEndpoint] ?? [];
  const agentParams = agentParamSettings[paramEndpoint] ?? [];
  const defaultParams = regularParams.concat(agentParams);
  const defaultParamsMap = new Map(
    defaultParams.map((param) => [param.key, param as CustomParamDefinition]),
  );
  const invalidKeys = paramDefinitions
    .map((param) => param.key)
    .filter((key) => !defaultParamsMap.has(key));
  if (invalidKeys.length > 0) {
    throw new Error(
      `paramDefinitions of "${endpointName}" endpoint contains invalid key(s). ` +
        `Valid parameter keys are ${Array.from(defaultParamsMap.keys()).join(', ')}`,
    );
  }

  const parsedDefinitions = paramDefinitions.map((param) => ({
    ...defaultParamsMap.get(param.key),
    ...param,
    optionType: 'custom',
  })) as CustomParamDefinition[];
  customParams.paramDefinitions = parsedDefinitions;

  try {
    validateSettingDefinitions(
      parsedDefinitions as Parameters<typeof validateSettingDefinitions>[0],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Custom parameter definitions for "${endpointName}" endpoint is malformed: ${message}`,
    );
  }
}

function isRemoteConfigPath(configPath: string): boolean {
  return /^https?:\/\//.test(configPath);
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

      setMaxSubagents(getConfiguredMaxSubagents(loadedConfig));
      const result = configSchema.strict().safeParse(loadedConfig);
      if (
        result.error?.errors.some(
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
        const speechError = result.error.errors.find(
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
            throw new ConfigReloadError(message, result.error, result.error.errors);
          }
          return null;
        }
        if (mode === 'reload') {
          throw new ConfigReloadError(message, result.error, result.error.errors);
        }

        logger.error(
          'Exiting due to invalid configuration. Set CONFIG_BYPASS_VALIDATION=true to bypass this check.',
        );
        process.exit(1);
      }

      const customConfig = loadedConfig as TCustomConfig;
      const customEndpoints = (customConfig.endpoints?.custom ?? []) as TEndpoint[];
      for (const endpoint of customEndpoints) {
        addOpenRouterDefaults(endpoint);
      }
      for (const endpoint of customEndpoints) {
        if (endpoint.customParams) {
          parseCustomParams(endpoint.name, endpoint.customParams);
        }
      }
      if (result.data.modelSpecs) {
        customConfig.modelSpecs = result.data.modelSpecs;
      }
      for (const drop of resolveConfigAllowedAddresses(customConfig, process.env)) {
        logger.warn(
          `[allowedAddresses] Dropped ${drop.path} entry ${drop.entry}: ${ALLOWED_ADDRESS_DROP_MESSAGES[drop.reason]}`,
        );
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
