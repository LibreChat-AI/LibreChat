import axios from 'axios';
import yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import {
  configSchema,
  persistenceConfigSchema,
  EModelEndpoint,
  EImageOutputType,
  getMaxSubagents,
  setMaxSubagents,
  setPiiRegexProgramSizer,
} from 'librechat-data-provider';
import type { TCustomConfig, TEndpoint } from 'librechat-data-provider';
import type { ConfigOverrideIssue } from '@librechat/data-schemas';
import type { ZodIssue } from 'zod';
import { getPiiRegexProgramSize } from '~/protection/programSize';
import { serviceRequestBudget } from '~/utils/timeouts';
import { checkConfigPolicyLinks } from './interface';
import { expandCustomEndpoint } from './params';
import { checkConfigTheme } from './theme';

export type CustomConfigLoadMode = 'startup' | 'reload';

export interface CustomConfigLoadOptions {
  mode?: CustomConfigLoadMode;
  /** Storage initialization must distinguish an absent default from an unreadable source. */
  storageSelection?: boolean;
}

export interface LoadedCustomConfig {
  config: TCustomConfig;
  /** {@link hashCustomConfig} of the file as parsed, before any check rewrote part of it. */
  digest: string;
}

export interface CustomConfigLoaderOptions {
  defaultConfigPath: string;
  loadLocal: (configPath: string) => unknown;
  fetchRemote?: (configPath: string) => Promise<unknown>;
  /** @deprecated Configuration values are no longer logged. */
  redactConfig?: (config: TCustomConfig) => TCustomConfig;
  /** Runs after each successful load, at startup and on reload, before the config is returned. */
  onLoad?: (loaded: LoadedCustomConfig) => void;
}

const CONFIG_DIGEST_LENGTH = 12;

/** Keys are unique within an object, and code-unit order does not vary by locale. */
function sortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * A short, stable hash of a parsed librechat.yaml: comments, formatting and key order do not
 * change it, so it moves only when the configuration does. Values are hashed, never logged.
 */
export function hashCustomConfig(config: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(config, sortKeys))
    .digest('hex')
    .slice(0, CONFIG_DIGEST_LENGTH);
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

/**
 * `interface.schedules.mcpConsent.readOnlyPolicy` used to decide which MCP tools a scheduled
 * chat could call. The schedule's owner chooses now, and the schema drops the key without a
 * word, so an operator who still relies on it is told.
 */
function reportRetiredScheduleToolPolicy(configPath: string, config: unknown): void {
  const schedules = (config as { interface?: { schedules?: unknown } } | null)?.interface
    ?.schedules;
  const consent = (schedules as { mcpConsent?: unknown } | null | undefined)?.mcpConsent;
  if (consent == null || typeof consent !== 'object' || !('readOnlyPolicy' in consent)) {
    return;
  }
  logger.warn(
    `Ignoring interface.schedules.mcpConsent.readOnlyPolicy in ${configPath}: it no longer limits ` +
      'which MCP tools a scheduled chat may call. Each schedule owner now chooses the allowed ' +
      'tools when granting consent. Remove the key.',
  );
}

/**
 * Under `delegated`, an API key run may use only the MCP tools the key's owner granted, and an
 * owner can grant only servers the operator declared. An operator who chooses that mode and
 * declares none has every key run's MCP tools refused with nothing to grant, so they are told.
 */
function reportUngrantableKeyRuns(configPath: string, config: unknown): void {
  const root = config as {
    endpoints?: { agents?: { remoteApi?: { integrations?: unknown } } };
  } | null;
  const integrations = root?.endpoints?.agents?.remoteApi?.integrations as
    | { mode?: unknown; resources?: unknown }
    | null
    | undefined;
  const declared =
    integrations?.resources != null &&
    typeof integrations.resources === 'object' &&
    Object.keys(integrations.resources).length > 0;
  if (integrations?.mode !== 'delegated' || declared) {
    return;
  }
  logger.warn(
    `Agent API key runs cannot use MCP tools with the configuration in ${configPath}: ` +
      'endpoints.agents.remoteApi.integrations.mode is "delegated", so a key may use only the ' +
      'servers and tools its owner granted it, and no server is declared under ' +
      'endpoints.agents.remoteApi.integrations.resources. Declare the servers keys may be ' +
      'granted, or remove the mode to let a key use every server its owner can.',
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

/** Whether `error` is the service request budget running out, not a refused or failed fetch. */
function isFetchTimeout(error: unknown): boolean {
  const { code, name, config } = (error ?? {}) as {
    code?: unknown;
    name?: unknown;
    config?: { signal?: { reason?: { name?: unknown } } };
  };
  return (
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    name === 'TimeoutError' ||
    config?.signal?.reason?.name === 'TimeoutError'
  );
}

/** Creates one process-local custom-config reader. */
export function createCustomConfigLoader({
  defaultConfigPath,
  loadLocal,
  onLoad,
  fetchRemote = async (configPath: string): Promise<unknown> =>
    (await axios.get(configPath, serviceRequestBudget())).data,
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
      if (
        options.storageSelection &&
        !(
          cause instanceof Error &&
          'code' in cause &&
          cause.code === 'ENOENT' &&
          !process.env.CONFIG_PATH
        )
      ) {
        throw new ConfigReloadError('Deployment config unavailable for storage selection');
      }
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
          if (isFetchTimeout(error)) {
            /** Booting on defaults would drop policy such as `registration.allowedDomains`. */
            throw new Error(`Timed out fetching the remote config file from ${configPath}`, {
              cause: error,
            });
          }
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

      /** The checks below return copies, but `modelSpecs` is assigned onto this object later. */
      if (
        typeof loadedConfig === 'object' &&
        loadedConfig != null &&
        'persistence' in loadedConfig
      ) {
        const persistence = persistenceConfigSchema.safeParse(loadedConfig.persistence);
        if (!persistence.success) {
          throw new ConfigReloadError('Invalid persistence configuration');
        }
      }
      const parsedConfig = loadedConfig;
      const themeCheck = checkConfigTheme(loadedConfig);
      loadedConfig = themeCheck.config;
      reportThemeCheck(configPath, themeCheck.errors, themeCheck.warnings);
      const linkCheck = checkConfigPolicyLinks(loadedConfig);
      loadedConfig = linkCheck.config;
      reportPolicyLinkCheck(configPath, linkCheck.dropped);
      reportRetiredScheduleToolPolicy(configPath, loadedConfig);
      reportUngrantableKeyRuns(configPath, loadedConfig);

      setMaxSubagents(getConfiguredMaxSubagents(loadedConfig));
      /* `filters` PII patterns are sized by RE2, which the shared schema cannot carry. Every
         entry point loads config through here, the CLI scripts included, so register it here. */
      setPiiRegexProgramSizer(getPiiRegexProgramSize);
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
      if (
        !result.success &&
        loadedConfig != null &&
        typeof loadedConfig === 'object' &&
        'outputProtection' in loadedConfig
      ) {
        throw new ConfigReloadError('Invalid configuration containing output protection');
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

        if (
          typeof loadedConfig === 'object' &&
          loadedConfig != null &&
          'persistence' in loadedConfig
        ) {
          throw new ConfigReloadError('Invalid configuration containing persistence selection');
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

      const digest = hashCustomConfig(parsedConfig);
      const customConfig = loadedConfig as TCustomConfig;
      /** Expanded copies are discarded: AppService serves them, and the config stays as written. */
      for (const endpoint of (customConfig.endpoints?.custom ?? []) as TEndpoint[]) {
        expandCustomEndpoint(endpoint);
      }
      if (result.data.modelSpecs) {
        customConfig.modelSpecs = result.data.modelSpecs;
      }

      if (printConfig) {
        logger.info(`Custom config file loaded (digest: ${digest})`);
      }

      onLoad?.({ config: customConfig, digest });
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
