import { getConfigDefaults, removeNullishValues } from 'librechat-data-provider';
import type { TCustomConfig, TConfigDefaults } from 'librechat-data-provider';
import type { AppConfig } from '~/types/app';
import { isMemoryEnabled } from './memory';

/** The interface controls model specs turn off unless librechat.yaml or an override sets them. */
export const SPEC_INTERFACE_FIELDS = ['modelSelect', 'parameters', 'presets'] as const;

export type SpecInterfaceField = (typeof SPEC_INTERFACE_FIELDS)[number];

/**
 * `modelSelect`, `parameters` and `presets` as {@link loadDefaultInterface} decides them for the
 * model specs served, wherever `explicit` (the librechat.yaml-shaped interface, overrides merged
 * in) leaves them unset: with specs, the model selector stays only for `addedEndpoints` and
 * parameters and presets are off; without, each takes its default. Run on the final config, so a
 * profile that adds specs turns them off and one that removes every served spec (a tombstone, an
 * empty list, or tenant scoping) turns them back on. Only `fields` are derived (all three by
 * default). A config without an interface (a layer tombstoned it) gets one holding the fields
 * derived, which would otherwise read as off. Returns `interfaceConfig` itself when nothing
 * changes.
 */
export function deriveSpecInterface(
  interfaceConfig: AppConfig['interfaceConfig'],
  explicit: TCustomConfig['interface'] | undefined,
  modelSpecs: AppConfig['modelSpecs'],
  options: {
    fields?: readonly SpecInterfaceField[];
    defaults?: TConfigDefaults['interface'];
  } = {},
): AppConfig['interfaceConfig'] {
  const { fields = SPEC_INTERFACE_FIELDS, defaults = getConfigDefaults().interface } = options;
  const current: NonNullable<AppConfig['interfaceConfig']> = interfaceConfig ?? {};
  const hasModelSpecs = (modelSpecs?.list?.length ?? 0) > 0;
  const includesAddedEndpoints = (modelSpecs?.addedEndpoints?.length ?? 0) > 0;
  const derived: Record<SpecInterfaceField, boolean | undefined> = {
    modelSelect:
      explicit?.modelSelect ?? (hasModelSpecs ? includesAddedEndpoints : defaults.modelSelect),
    parameters: explicit?.parameters ?? (hasModelSpecs ? false : defaults.parameters),
    presets: explicit?.presets ?? (hasModelSpecs ? false : defaults.presets),
  };
  const changed = fields.filter((field) => current[field] !== derived[field]);
  if (changed.length === 0) {
    return interfaceConfig;
  }
  const next = { ...current };
  for (const field of changed) {
    if (derived[field] === undefined) {
      delete next[field];
    } else {
      next[field] = derived[field];
    }
  }
  return next;
}

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
    runningChatRename: interfaceConfig?.runningChatRename ?? defaults.runningChatRename,
    codeHighlightThrottleMs:
      interfaceConfig?.codeHighlightThrottleMs ?? defaults.codeHighlightThrottleMs,
    agentSelectorLimit: interfaceConfig?.agentSelectorLimit ?? defaults.agentSelectorLimit,
    parameters: interfaceConfig?.parameters ?? (hasModelSpecs ? false : defaults.parameters),
    presets: interfaceConfig?.presets ?? (hasModelSpecs ? false : defaults.presets),
    privacyPolicy: interfaceConfig?.privacyPolicy ?? defaults.privacyPolicy,
    termsOfService: interfaceConfig?.termsOfService ?? defaults.termsOfService,
    mcpServers: interfaceConfig?.mcpServers ?? defaults.mcpServers,
    customWelcome: interfaceConfig?.customWelcome ?? defaults.customWelcome,
    landingHeading: interfaceConfig?.landingHeading ?? defaults.landingHeading,
    landingFooter: interfaceConfig?.landingFooter ?? defaults.landingFooter,
    autoSubmitFromUrl: interfaceConfig?.autoSubmitFromUrl ?? defaults.autoSubmitFromUrl,
    colorModeFromUrl: interfaceConfig?.colorModeFromUrl ?? defaults.colorModeFromUrl,
    buildInfo: interfaceConfig?.buildInfo ?? defaults.buildInfo,
    mascot: interfaceConfig?.mascot ?? defaults.mascot,
    contextUsage: interfaceConfig?.contextUsage ?? defaults.contextUsage,
    artifactUndocking: interfaceConfig?.artifactUndocking ?? defaults.artifactUndocking,
    contextCost: interfaceConfig?.contextCost ?? defaults.contextCost,
    feedback: interfaceConfig?.feedback ?? defaults.feedback,
    currency: interfaceConfig?.currency ?? defaults.currency,
    theme: interfaceConfig?.theme,
    steerArmConfirmationTimeoutMs:
      interfaceConfig?.steerArmConfirmationTimeoutMs ?? defaults.steerArmConfirmationTimeoutMs,
    queuedTurnReconciliationTimeoutMs:
      interfaceConfig?.queuedTurnReconciliationTimeoutMs ??
      defaults.queuedTurnReconciliationTimeoutMs,
    queuedSendLockTimeoutMs:
      interfaceConfig?.queuedSendLockTimeoutMs ?? defaults.queuedSendLockTimeoutMs,
    composerRecentFiles: interfaceConfig?.composerRecentFiles ?? defaults.composerRecentFiles,
    historyCacheTtlMs: interfaceConfig?.historyCacheTtlMs ?? defaults.historyCacheTtlMs,
    historyCacheRecent: interfaceConfig?.historyCacheRecent ?? defaults.historyCacheRecent,
    historyCacheMaxBytes: interfaceConfig?.historyCacheMaxBytes ?? defaults.historyCacheMaxBytes,

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

    /* Merged per field rather than taken whole, so an operator who sets one capability keeps
       the defaults for the rest instead of silently turning the others off. */
    replyNotifications: {
      ...defaults.replyNotifications,
      ...interfaceConfig?.replyNotifications,
    },
  });

  return loadedInterface;
}
