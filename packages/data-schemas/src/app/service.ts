import {
  AgentCapabilities,
  EModelEndpoint,
  filtersConfigSchema,
  hasActiveFiltersConfig,
  getConfigDefaults,
  langfuseConfigSchema,
  skillSyncConfigSchema,
  summarizationConfigSchema,
} from 'librechat-data-provider';
import type {
  FileSources,
  DeepPartial,
  TCustomConfig,
  TAgentsEndpoint,
} from 'librechat-data-provider';
import type { AppConfig, FunctionTool } from '~/types/app';
import { loadMemoryConfig, isMemoryEnabled } from './memory';
import { loadDefaultInterface } from './interface';
import { loadTurnstileConfig } from './turnstile';
import { agentsConfigSetup } from './agents';
import { loadWebSearchConfig } from './web';
import { processModelSpecs } from './specs';
import { loadEndpoints } from './endpoints';
import { loadOCRConfig } from './ocr';
import logger from '~/config/winston';

export function loadSummarizationConfig(
  config: DeepPartial<TCustomConfig>,
): AppConfig['summarization'] {
  const raw = config.summarization;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  if (
    raw.trigger &&
    typeof raw.trigger === 'object' &&
    (raw.trigger as { type?: unknown }).type === 'token_count'
  ) {
    logger.warn(
      "[AppService] `summarization.trigger.type: 'token_count'` is no longer supported. " +
        "Use 'token_ratio' (0-1), 'remaining_tokens' (positive integer), or " +
        "'messages_to_refine' (positive integer). Your `summarization` config will be " +
        'ignored and summarization will fall back to self-summarize defaults (the ' +
        "agent's own provider/model, fires on every pruning event) until this is " +
        'corrected.',
    );
    return undefined;
  }

  const parsed = summarizationConfigSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('[AppService] Invalid summarization config', parsed.error.flatten());
    return undefined;
  }

  return {
    ...parsed.data,
    enabled: parsed.data.enabled !== false,
  };
}

export function loadSkillSyncConfig(config: DeepPartial<TCustomConfig>): AppConfig['skillSync'] {
  const raw = config.skillSync;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const parsed = skillSyncConfigSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('[AppService] Invalid skill sync config', parsed.error.flatten());
    return undefined;
  }

  return parsed.data;
}

export function loadLangfuseConfig(config: DeepPartial<TCustomConfig>): AppConfig['langfuse'] {
  const raw = config.langfuse;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const parsed = langfuseConfigSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('[AppService] Invalid Langfuse config', parsed.error.flatten());
    return undefined;
  }

  return parsed.data;
}

export function loadFiltersConfig(config: DeepPartial<TCustomConfig>): AppConfig['filters'] {
  const raw = config.filters;
  if (raw === undefined) {
    return undefined;
  }

  const parsed = filtersConfigSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('[AppService] Invalid filters config', parsed.error.flatten());
    throw new Error('Invalid filters config');
  }

  return hasActiveFiltersConfig(parsed.data) ? parsed.data : undefined;
}

export type Paths = {
  root: string;
  uploads: string;
  clientPath: string;
  dist: string;
  publicPath: string;
  fonts: string;
  assets: string;
  imageOutput: string;
  structuredTools: string;
  pluginManifest: string;
};

/**
 * Loads custom config and initializes app-wide variables.
 * @function AppService
 */
export const AppService = async (params?: {
  config: DeepPartial<TCustomConfig>;
  paths?: Paths;
  systemTools?: Record<string, FunctionTool>;
}): Promise<AppConfig> => {
  const { config, paths, systemTools } = params || {};
  if (!config) {
    throw new Error('Config is required');
  }
  const configDefaults = getConfigDefaults();

  const ocr = loadOCRConfig(config.ocr);
  const webSearch = loadWebSearchConfig(config.webSearch);
  const memory = loadMemoryConfig(config.memory);
  const summarization = loadSummarizationConfig(config);
  const skillSync = loadSkillSyncConfig(config);
  const filteredTools = config.filteredTools;
  const includedTools = config.includedTools;
  const fileStrategy = (config.fileStrategy ?? configDefaults.fileStrategy) as
    | FileSources.local
    | FileSources.s3
    | FileSources.firebase
    | FileSources.azure_blob
    | FileSources.cloudfront;
  const startBalance = process.env.START_BALANCE;
  const balance = config.balance ?? {
    enabled: process.env.CHECK_BALANCE?.toLowerCase().trim() === 'true',
    startBalance: startBalance ? parseInt(startBalance, 10) : undefined,
  };
  const transactions = config.transactions ?? configDefaults.transactions;
  const imageOutputType = config?.imageOutputType ?? configDefaults.imageOutputType;

  process.env.CDN_PROVIDER = fileStrategy;

  const availableTools = systemTools;

  const mcpServersConfig = config.mcpServers || null;
  const mcpSettings = config.mcpSettings || null;
  const classification = config.classification || null;
  const actions = config.actions;
  const registration = config.registration ?? configDefaults.registration;
  const interfaceConfig = await loadDefaultInterface({ config, configDefaults });
  const turnstileConfig = loadTurnstileConfig(config, configDefaults);
  const speech = config.speech;
  const filters = loadFiltersConfig(config);
  const messageFilter = config.messageFilter;
  const langfuse = loadLangfuseConfig(config);

  const defaultConfig = {
    ocr,
    paths,
    config,
    memory,
    speech,
    actions,
    balance,
    skillSync,
    webSearch,
    mcpSettings,
    classification,
    fileStrategy,
    registration,
    transactions,
    filteredTools,
    includedTools,
    filters,
    langfuse,
    messageFilter,
    summarization,
    availableTools,
    imageOutputType,
    interfaceConfig,
    turnstileConfig,
    mcpConfig: mcpServersConfig,
    fileStrategies: config.fileStrategies,
    cloudfront: config.cloudfront as AppConfig['cloudfront'],
    secureImageLinks: config.secureImageLinks !== false,
  };

  const agentsDefaults = agentsConfigSetup(config);

  /** The `memory` capability only functions when memory is configured and
   *  enabled. Drop it from the served capability set otherwise so the agent
   *  builder toggle, ephemeral badge, and backend capability gate stay
   *  consistent instead of exposing an inert memory toggle. Applied to the
   *  final served agents config — `loadEndpoints` reparses any
   *  `endpoints.agents` block and would otherwise restore the default
   *  capability. */
  const memoryDisabled = !isMemoryEnabled(memory);
  const stripInertMemoryCapability = (agentsEndpoint?: Partial<TAgentsEndpoint>): void => {
    if (!memoryDisabled || !agentsEndpoint || !Array.isArray(agentsEndpoint.capabilities)) {
      return;
    }
    agentsEndpoint.capabilities = agentsEndpoint.capabilities.filter(
      (capability) => capability !== AgentCapabilities.memory,
    );
  };
  stripInertMemoryCapability(agentsDefaults);

  if (!Object.keys(config).length) {
    const appConfig = {
      ...defaultConfig,
      endpoints: {
        [EModelEndpoint.agents]: agentsDefaults,
      },
    };
    return appConfig;
  }

  const loadedEndpoints = loadEndpoints(config, agentsDefaults);
  stripInertMemoryCapability(loadedEndpoints[EModelEndpoint.agents]);

  const appConfig: AppConfig = {
    ...defaultConfig,
    fileConfig: config?.fileConfig as AppConfig['fileConfig'],
    modelSpecs: processModelSpecs(config?.endpoints, config.modelSpecs, interfaceConfig),
    endpoints: loadedEndpoints,
  };

  return appConfig;
};
