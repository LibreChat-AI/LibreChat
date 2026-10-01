import { removeNullishValues } from 'librechat-data-provider';
import type { TCustomConfig, TConfigDefaults } from 'librechat-data-provider';
import type { AppConfig } from '~/types/app';
import { isMemoryEnabled } from './memory';

/**
 * Loads the default interface object.
 * @param params - The loaded custom configuration.
 * @param params.config - The loaded custom configuration.
 * @param params.configDefaults - The custom configuration default values.
 * @returns default interface object.
 */
export async function loadDefaultInterface({
  config,
  configDefaults,
}: {
  config?: Partial<TCustomConfig>;
  configDefaults: TConfigDefaults;
}): Promise<AppConfig['interfaceConfig']> {
  const { interface: interfaceConfig } = config ?? {};
  const { interface: defaults } = configDefaults;
  const hasModelSpecs = (config?.modelSpecs?.list?.length ?? 0) > 0;
  const includesAddedEndpoints = (config?.modelSpecs?.addedEndpoints?.length ?? 0) > 0;

  const memoryConfig = config?.memory;
  const memoryEnabled = isMemoryEnabled(memoryConfig);
  /** Only disable memories if memory config is present and explicitly disabled */
  const shouldDisableMemories = memoryConfig && !memoryEnabled;

  const loadedInterface: AppConfig['interfaceConfig'] = removeNullishValues({
    // UI elements - use schema defaults
    modelSelect:
      interfaceConfig?.modelSelect ??
      (hasModelSpecs ? includesAddedEndpoints : defaults.modelSelect),
    codeHighlightThrottleMs:
      interfaceConfig?.codeHighlightThrottleMs ?? defaults.codeHighlightThrottleMs,
    agentSelectorLimit: interfaceConfig?.agentSelectorLimit ?? defaults.agentSelectorLimit,
    parameters: interfaceConfig?.parameters ?? (hasModelSpecs ? false : defaults.parameters),
    presets: interfaceConfig?.presets ?? (hasModelSpecs ? false : defaults.presets),
    privacyPolicy: interfaceConfig?.privacyPolicy ?? defaults.privacyPolicy,
    termsOfService: interfaceConfig?.termsOfService ?? defaults.termsOfService,
    mcpServers: interfaceConfig?.mcpServers ?? defaults.mcpServers,
    customWelcome: interfaceConfig?.customWelcome ?? defaults.customWelcome,
    autoSubmitFromUrl: interfaceConfig?.autoSubmitFromUrl ?? defaults.autoSubmitFromUrl,
    buildInfo: interfaceConfig?.buildInfo ?? defaults.buildInfo,
    contextUsage: interfaceConfig?.contextUsage ?? defaults.contextUsage,
    contextCost: interfaceConfig?.contextCost ?? defaults.contextCost,
    tokenThroughput: interfaceConfig?.tokenThroughput ?? defaults.tokenThroughput,
    feedback: interfaceConfig?.feedback ?? defaults.feedback,
    currency: interfaceConfig?.currency ?? defaults.currency,

    // Permissions and related settings - only include if explicitly configured
    bookmarks: interfaceConfig?.bookmarks,
    memories: shouldDisableMemories ? false : interfaceConfig?.memories,
    prompts: interfaceConfig?.prompts,
    multiConvo: interfaceConfig?.multiConvo,
    agents: interfaceConfig?.agents,
    temporaryChat: interfaceConfig?.temporaryChat,
    temporaryChatRetention: interfaceConfig?.temporaryChatRetention,
    generalChatRetention: interfaceConfig?.generalChatRetention,
    retentionMode: interfaceConfig?.retentionMode,
    retainAgentFiles: interfaceConfig?.retainAgentFiles,
    runCode: interfaceConfig?.runCode,
    webSearch: interfaceConfig?.webSearch,
    fileSearch: interfaceConfig?.fileSearch,
    fileCitations: interfaceConfig?.fileCitations,
    traceViewer: interfaceConfig?.traceViewer,
    defaultPinnedTools: interfaceConfig?.defaultPinnedTools,
    peoplePicker: interfaceConfig?.peoplePicker,
    marketplace: interfaceConfig?.marketplace,
    remoteAgents: interfaceConfig?.remoteAgents,
    skills: interfaceConfig?.skills,
    sharedLinks: interfaceConfig?.sharedLinks,
    schedules: interfaceConfig?.schedules,
  });

  return loadedInterface;
}
