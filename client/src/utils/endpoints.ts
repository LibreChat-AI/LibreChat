import {
  Constants,
  EModelEndpoint,
  defaultEndpoints,
  modularEndpoints,
  LocalStorageKeys,
  getEndpointField,
  isAgentsEndpoint,
  isEphemeralAgentId,
  isAssistantsEndpoint,
  resolveModelSpecEndpoint,
} from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import { getTimestampedValue } from './timestamps';
import { getAgentAvatarUrl } from './agents';

/**
 * Clears model for non-ephemeral agent conversations.
 * Agents use their configured model internally, so the conversation model should be undefined.
 * Mutates the template in place.
 */
export function clearModelForNonEphemeralAgent<
  T extends {
    endpoint?: EModelEndpoint | string | null;
    agent_id?: string | null;
    model?: string | null;
  },
>(template: T): void {
  if (
    isAgentsEndpoint(template.endpoint) &&
    template.agent_id &&
    !isEphemeralAgentId(template.agent_id)
  ) {
    template.model = undefined as T['model'];
  }
}

export const getEntityName = ({
  name = '',
  localize,
  isAgent,
}: {
  name?: string;
  isAgent?: boolean;
  localize: LocalizeFunction;
}) => {
  if (name && name.length > 0) {
    return name;
  } else {
    return isAgent === true ? localize('com_ui_agent') : localize('com_ui_assistant');
  }
};

export const getEndpointsFilter = (endpointsConfig: t.TEndpointsConfig) => {
  const filter: Record<string, boolean> = {};
  if (!endpointsConfig) {
    return filter;
  }
  for (const key of Object.keys(endpointsConfig)) {
    filter[key] = !!endpointsConfig[key];
  }
  return filter;
};

export const getAvailableEndpoints = (
  filter: Record<string, boolean>,
  endpointsConfig: t.TEndpointsConfig,
) => {
  const defaultSet = new Set(defaultEndpoints);
  const availableEndpoints: EModelEndpoint[] = [];

  for (const endpoint in endpointsConfig) {
    // Check if endpoint is in the filter or its type is in defaultEndpoints
    if (
      filter[endpoint] ||
      (endpointsConfig[endpoint]?.type &&
        defaultSet.has(endpointsConfig[endpoint]?.type as EModelEndpoint))
    ) {
      availableEndpoints.push(endpoint as EModelEndpoint);
    }
  }

  return availableEndpoints;
};

export function mapEndpoints(endpointsConfig: t.TEndpointsConfig) {
  const filter = getEndpointsFilter(endpointsConfig);
  return getAvailableEndpoints(filter, endpointsConfig).sort(
    (a, b) => (endpointsConfig?.[a]?.order ?? 0) - (endpointsConfig?.[b]?.order ?? 0),
  );
}

const firstLocalConvoKey = LocalStorageKeys.LAST_CONVO_SETUP + '_0';

/**
 * Ensures the last selected model stays up to date, as conversation may
 * update without updating last convo setup when same endpoint */
export function updateLastSelectedModel({
  endpoint,
  model = '',
}: {
  endpoint: string;
  model?: string;
}) {
  if (!model) {
    return;
  }
  /* Note: an empty string value is possible */
  const lastConversationSetup = JSON.parse(
    (localStorage.getItem(firstLocalConvoKey) ?? '{}') || '{}',
  );

  if (lastConversationSetup.endpoint === endpoint) {
    lastConversationSetup.model = model;
    localStorage.setItem(firstLocalConvoKey, JSON.stringify(lastConversationSetup));
  }

  const lastSelectedModels = JSON.parse(
    (localStorage.getItem(LocalStorageKeys.LAST_MODEL) ?? '{}') || '{}',
  );
  lastSelectedModels[endpoint] = model;
  localStorage.setItem(LocalStorageKeys.LAST_MODEL, JSON.stringify(lastSelectedModels));
}

interface ConversationInitParams {
  conversation: t.TConversation | null;
  newEndpoint: EModelEndpoint | string | null;
  endpointsConfig: t.TEndpointsConfig;
  modularChat?: boolean;
}

interface InitiatedTemplateResult {
  template: Partial<t.TPreset>;
  shouldSwitch: boolean;
  isExistingConversation: boolean;
  isCurrentModular: boolean;
  isNewModular: boolean;
  newEndpointType: EModelEndpoint | undefined;
}

type StoredModelSelection = Pick<
  t.TConversation,
  'model' | 'spec' | 'agent_id' | 'assistant_id'
> & { endpoint?: EModelEndpoint | string | null };

function hasSelectionValue(value?: string | null): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function parseStoredModelSelection(
  value: string | null,
): Partial<StoredModelSelection> | undefined {
  if (!value) {
    return;
  }

  try {
    return JSON.parse(value) as Partial<StoredModelSelection>;
  } catch {
    return;
  }
}

function isStoredAgentPick(
  selection?: Partial<StoredModelSelection> | null,
): selection is Partial<StoredModelSelection> & { agent_id: string } {
  return (
    isAgentsEndpoint(selection?.endpoint ?? '') &&
    hasSelectionValue(selection?.agent_id) &&
    !isEphemeralAgentId(selection?.agent_id ?? '')
  );
}

export function hasModelSelection(selection?: Partial<StoredModelSelection> | null): boolean {
  if (!selection) {
    return false;
  }

  return (
    hasSelectionValue(selection.spec) ||
    hasSelectionValue(selection.agent_id) ||
    hasSelectionValue(selection.assistant_id) ||
    hasSelectionValue(selection.model) ||
    hasSelectionValue(selection.endpoint)
  );
}

/**
 * Whether the selector offers any ephemeral endpoint → model options.
 * False when the endpoints menu is hidden (`modelSelect` disabled) or only
 * agents/assistants picks remain; an empty endpoints config means not loaded.
 */
function hasEphemeralModelOptions({
  endpointsConfig,
  addedEndpoints,
  modelSelect,
}: {
  endpointsConfig?: t.TEndpointsConfig;
  addedEndpoints?: Array<EModelEndpoint | string>;
  modelSelect?: boolean;
}): boolean {
  if (!modelSelect) {
    return false;
  }
  const included = new Set(addedEndpoints ?? []);
  const includesEphemeral =
    included.size === 0 ||
    [...included].some(
      (endpoint) => !isAgentsEndpoint(endpoint) && !isAssistantsEndpoint(endpoint),
    );
  if (!includesEphemeral) {
    return false;
  }
  if (endpointsConfig == null || Object.keys(endpointsConfig).length === 0) {
    return true;
  }
  return Object.entries(endpointsConfig).some(
    ([endpoint, config]) =>
      config != null &&
      !isAgentsEndpoint(endpoint) &&
      !isAssistantsEndpoint(endpoint) &&
      (included.size === 0 || included.has(endpoint)),
  );
}

/**
 * Whether the stored setup names a concrete agent/assistant pick the selector
 * still offers. Picker-only deployments (e.g. `addedEndpoints: [agents]`) have
 * no ephemeral endpoint → model options, yet an agent selected there is a real
 * choice the soft default must carry forward; ephemeral agent ids and picks
 * whose endpoint left the allow-list or endpoints config remain residue.
 */
function hasSelectableEntitySelection({
  selection,
  endpointsConfig,
  addedEndpoints,
  modelSelect,
}: {
  selection?: Partial<StoredModelSelection>;
  endpointsConfig?: t.TEndpointsConfig;
  addedEndpoints?: Array<EModelEndpoint | string>;
  modelSelect?: boolean;
}): boolean {
  const endpoint = selection?.endpoint;
  if (!modelSelect || !endpoint) {
    return false;
  }
  const isAgentPick = isStoredAgentPick(selection);
  const isAssistantPick =
    isAssistantsEndpoint(endpoint) && hasSelectionValue(selection.assistant_id);
  if (!isAgentPick && !isAssistantPick) {
    return false;
  }
  const included = new Set(addedEndpoints ?? []);
  if (included.size > 0 && !included.has(endpoint)) {
    return false;
  }
  if (endpointsConfig == null || Object.keys(endpointsConfig).length === 0) {
    return true;
  }
  return endpointsConfig[endpoint] != null;
}

/** Get the conditional logic for switching conversations */
export function getConvoSwitchLogic(params: ConversationInitParams): InitiatedTemplateResult {
  const { conversation, newEndpoint, endpointsConfig, modularChat = false } = params;

  const currentEndpoint = conversation?.endpoint;
  const template: Partial<t.TPreset> = {
    ...conversation,
    endpoint: newEndpoint,
    conversationId: 'new',
  };

  // Reset agent_id if switching to a non-agents endpoint but template has a non-ephemeral agent_id
  if (
    !isAgentsEndpoint(newEndpoint) &&
    template.agent_id &&
    !isEphemeralAgentId(template.agent_id)
  ) {
    template.agent_id = Constants.EPHEMERAL_AGENT_ID;
  }

  // Clear model for non-ephemeral agents - agents use their configured model internally
  clearModelForNonEphemeralAgent(template);

  const isAssistantSwitch =
    isAssistantsEndpoint(newEndpoint) &&
    isAssistantsEndpoint(currentEndpoint) &&
    currentEndpoint === newEndpoint;

  const conversationId = conversation?.conversationId ?? '';
  const isExistingConversation = !!(conversationId && conversationId !== 'new');

  const currentEndpointType =
    getEndpointField(endpointsConfig, currentEndpoint, 'type') ?? currentEndpoint;
  const newEndpointType =
    getEndpointField(endpointsConfig, newEndpoint, 'type') ??
    (newEndpoint as EModelEndpoint | undefined);

  const hasEndpoint = modularEndpoints.has(currentEndpoint ?? '');
  const hasCurrentEndpointType = modularEndpoints.has(currentEndpointType ?? '');
  const isCurrentModular = hasEndpoint || hasCurrentEndpointType || isAssistantSwitch;

  const hasNewEndpoint = modularEndpoints.has(newEndpoint ?? '');
  const hasNewEndpointType = modularEndpoints.has(newEndpointType ?? '');
  const isNewModular = hasNewEndpoint || hasNewEndpointType || isAssistantSwitch;

  const endpointsMatch = currentEndpoint === newEndpoint;
  const shouldSwitch = endpointsMatch || modularChat || isAssistantSwitch;

  return {
    template,
    shouldSwitch,
    isExistingConversation,
    isCurrentModular,
    newEndpointType,
    isNewModular,
  };
}

export function getModelSpec({
  specName,
  startupConfig,
}: {
  specName?: string | null;
  startupConfig?: t.TStartupConfig;
}): t.TModelSpec | undefined {
  if (!startupConfig || !specName) {
    return;
  }
  return startupConfig.modelSpecs?.list?.find((spec) => spec.name === specName);
}

export function applyModelSpecEphemeralAgent({
  convoId,
  modelSpec,
  updateEphemeralAgent,
}: {
  convoId?: string | null;
  modelSpec?: t.TModelSpec;
  updateEphemeralAgent: ((convoId: string, agent: t.TEphemeralAgent | null) => void) | undefined;
}) {
  if (!modelSpec || !updateEphemeralAgent) {
    return;
  }
  const key = (convoId ?? Constants.NEW_CONVO) || Constants.NEW_CONVO;
  const agent: t.TEphemeralAgent = {
    mcp: modelSpec.mcpServers ?? [],
    web_search: modelSpec.webSearch ?? false,
    file_search: modelSpec.fileSearch ?? false,
    execute_code: modelSpec.executeCode ?? false,
    memory: modelSpec.memory ?? false,
    artifacts: modelSpec.artifacts === true ? 'default' : modelSpec.artifacts || '',
  };

  // For existing conversations, layer per-conversation localStorage overrides
  // on top of spec defaults so user modifications persist across navigation.
  // If localStorage is empty (e.g., cleared), spec values stand alone.
  if (key !== Constants.NEW_CONVO) {
    const toolStorageMap: Array<[keyof t.TEphemeralAgent, string]> = [
      ['execute_code', LocalStorageKeys.LAST_CODE_TOGGLE_],
      ['web_search', LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_],
      ['file_search', LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_],
      ['artifacts', LocalStorageKeys.LAST_ARTIFACTS_TOGGLE_],
      ['memory', LocalStorageKeys.LAST_MEMORY_TOGGLE_],
    ];

    for (const [toolKey, storagePrefix] of toolStorageMap) {
      const raw = getTimestampedValue(`${storagePrefix}${key}`);
      if (raw !== null) {
        try {
          agent[toolKey] = JSON.parse(raw) as never;
        } catch {
          // ignore parse errors
        }
      }
    }

    const mcpRaw = localStorage.getItem(`${LocalStorageKeys.LAST_MCP_}${key}`);
    if (mcpRaw !== null) {
      try {
        const parsed = JSON.parse(mcpRaw);
        if (Array.isArray(parsed)) {
          agent.mcp = parsed;
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  updateEphemeralAgent(key, agent);
}

/**
 * Resolves the default model spec for a new chat. Priority: hard admin default →
 * the most recent conversation's own selection → soft default → legacy first spec.
 *
 * `LAST_CONVO_SETUP_0` is the single source of truth for prior intent: a setup naming
 * the soft spec is the soft default re-arming, any other spec/agent/endpoint is a
 * selection to carry forward, and an empty setup is a fresh start (clearing chats
 * wipes the selection, so a new chat then falls to the soft default). The soft default
 * also wins whenever the selector offers no ephemeral endpoint → model options — unless
 * the setup names a concrete agent/assistant the selector still offers, the one real
 * selection picker-only deployments provide — so lingering endpoint/model residue never
 * strands a new chat on an unselectable endpoint. The legacy first-spec fallback applies
 * only when specs are prioritized (or the model menu is hidden) and no soft default is
 * configured.
 *
 * A stored agent pick is trusted only until the agent list can weigh in: pass `agentsMap`
 * once loaded, and a pick naming an agent missing from it (deleted, or selected in another
 * org sharing this browser storage) is residue the soft default overrides. An undefined
 * map means the list is unknown and leaves the pick trusted; gate on
 * `defaultSpecAwaitsAgents` to defer the decision until the map settles.
 */
export function getDefaultModelSpec(
  startupConfig?: t.TStartupConfig,
  endpointsConfig?: t.TEndpointsConfig,
  agentsMap?: t.TAgentsMap,
):
  | {
      default?: t.TModelSpec;
      last?: t.TModelSpec;
      softDefault?: t.TModelSpec;
    }
  | undefined {
  const { modelSpecs, interface: interfaceConfig } = startupConfig ?? {};
  const { list, prioritize, addedEndpoints } = modelSpecs ?? {};
  if (!list) {
    return;
  }

  const defaultSpec = list.find((spec) => spec.default);
  if (defaultSpec) {
    return { default: defaultSpec };
  }

  const softDefaultSpec = list.find((spec) => spec.softDefault);
  const lastSetup = parseStoredModelSelection(
    localStorage.getItem(LocalStorageKeys.LAST_CONVO_SETUP + '_0'),
  );
  const lastSpec = hasSelectionValue(lastSetup?.spec)
    ? list.find((spec) => spec.name === lastSetup?.spec)
    : undefined;

  if (lastSpec && lastSpec.name !== softDefaultSpec?.name) {
    return { last: lastSpec };
  }

  if (softDefaultSpec) {
    if (lastSpec?.name === softDefaultSpec.name) {
      return { softDefault: softDefaultSpec };
    }
    const staleAgentPick =
      agentsMap != null && isStoredAgentPick(lastSetup) && agentsMap[lastSetup.agent_id] == null;
    if (staleAgentPick) {
      return { softDefault: softDefaultSpec };
    }
    const modelSelect = interfaceConfig?.modelSelect;
    const yieldsToSelection =
      (hasModelSelection(lastSetup) &&
        hasEphemeralModelOptions({ endpointsConfig, addedEndpoints, modelSelect })) ||
      hasSelectableEntitySelection({
        selection: lastSetup,
        endpointsConfig,
        addedEndpoints,
        modelSelect,
      });
    return yieldsToSelection ? undefined : { softDefault: softDefaultSpec };
  }

  if (prioritize === true || interfaceConfig?.modelSelect !== true) {
    return { default: list[0] };
  }
  return;
}

/**
 * Whether resolving the default spec for a new chat hinges on the agent list:
 * a soft default is configured, no hard default or stored spec decides first,
 * and the stored last setup names a concrete agent whose existence only the
 * loaded agent map can confirm. Callers should defer `getDefaultModelSpec`
 * until the agent list query settles (data or error) while this returns true.
 */
export function defaultSpecAwaitsAgents(
  startupConfig?: t.TStartupConfig,
  endpointsConfig?: t.TEndpointsConfig,
): boolean {
  const list = startupConfig?.modelSpecs?.list;
  if (!list || list.some((spec) => spec.default) || !list.some((spec) => spec.softDefault)) {
    return false;
  }

  /** With the selector disabled the soft default can never yield to a stored
   * pick, so the decision is deterministic without the agent list. */
  if (!startupConfig?.interface?.modelSelect) {
    return false;
  }

  const lastSetup = parseStoredModelSelection(
    localStorage.getItem(LocalStorageKeys.LAST_CONVO_SETUP + '_0'),
  );
  if (hasSelectionValue(lastSetup?.spec) && list.some((spec) => spec.name === lastSetup?.spec)) {
    return false;
  }

  return isStoredAgentPick(lastSetup) && endpointsConfig?.[EModelEndpoint.agents] != null;
}

export function getModelSpecPreset(modelSpec?: t.TModelSpec) {
  if (!modelSpec) {
    return;
  }
  return {
    ...modelSpec.preset,
    /**
     * Specs are materialized at config load, but a preset flowing into
     * `TPreset` contexts must carry an endpoint decision either way — resolve
     * here so startup and URL flows never receive an endpoint-less preset.
     */
    endpoint: resolveModelSpecEndpoint(modelSpec) ?? null,
    spec: modelSpec.name,
    iconURL: getModelSpecIconURL(modelSpec),
  };
}

/** Fields set by a model spec that should be cleared when switching to a non-spec conversation. */
export const specDisplayFieldReset = {
  spec: null as string | null,
  iconURL: null as string | null,
  modelLabel: null as string | null,
  greeting: undefined as string | undefined,
};

/**
 * Merges a spec preset base with URL query settings, clearing spec display fields
 * when the query doesn't explicitly set a spec. Prevents spec contamination on
 * agent/assistant share links.
 */
export function mergeQuerySettingsWithSpec(
  specPreset: t.TPreset | undefined,
  querySettings: t.TPreset,
): t.TPreset {
  return {
    ...specPreset,
    ...querySettings,
    ...(specPreset != null && querySettings.spec == null ? specDisplayFieldReset : {}),
  };
}

/**
 * Config authored through a form stores an untouched icon field as an empty
 * string rather than omitting it, so `??` would stop on it and suppress every
 * later candidate. `applyModelSpecPreset` already treats an empty `iconURL` as
 * unset; `showIconInMenu` is the explicit way to render no icon.
 */
function firstPresentIcon(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (candidate != null && candidate !== '') {
      return candidate;
    }
  }

  return '';
}

/** Gets the model spec iconURL by explicit icon, preset icon, agent avatar, then preset endpoint. */
export function getModelSpecIconURL(modelSpec: t.TModelSpec, agentAvatarURL?: string) {
  return firstPresentIcon(
    modelSpec.iconURL,
    modelSpec.preset?.iconURL,
    agentAvatarURL,
    modelSpec.preset?.endpoint,
  );
}

/**
 * Resolves the avatar of the agent a spec targets. Returns a primitive so callers
 * can hand it to memoized icon components without widening their comparison to
 * the identity of the whole agents map.
 */
export function getSpecAgentAvatarURL(
  modelSpec: t.TModelSpec,
  agentsMap?: t.TAgentsMap,
): string | undefined {
  const preset = modelSpec.preset;
  /**
   * `tModelSpecPresetSchema` permits `agent_id` alongside any endpoint, so a
   * leftover id on a non-agent spec would otherwise surface an unrelated
   * agent's identity ahead of that spec's own endpoint icon.
   */
  if (!isAgentsEndpoint(preset?.endpoint)) {
    return undefined;
  }

  const agentId = preset?.agent_id;
  if (agentId == null) {
    return undefined;
  }

  /** Agents persist `avatar` as either a URL string or an object. */
  return getAgentAvatarUrl(agentsMap?.[agentId]) ?? undefined;
}

/**
 * `label` is required by `tModelSpecSchema`, yet specs can still reach the
 * client without one when an external writer persists an incomplete config.
 * Normalizing on ingest keeps every consumer — row rendering, search
 * filtering, and the spec/endpoint discriminator — working from a complete
 * spec, rather than each guarding separately and one inevitably being missed.
 *
 * Returns the original array, and the original spec objects, when nothing
 * needs filling in, so memoized consumers see no new identities.
 */
export function normalizeModelSpecs(specs: t.TModelSpec[]): t.TModelSpec[] {
  let normalized: t.TModelSpec[] | null = null;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    if (spec.label) {
      normalized?.push(spec);
      continue;
    }
    /** Lazy copy: allocated only when the first incomplete spec is found. */
    normalized ??= specs.slice(0, i);
    normalized.push({ ...spec, label: spec.name });
  }
  return normalized ?? specs;
}

/**
 * Applies `normalizeModelSpecs` to a fetched startup config, so normalization
 * happens once at the query boundary and every consumer of
 * `startupConfig.modelSpecs.list` — the selector, mentions, favorites,
 * provider-key reachability — reads complete specs. Identity-preserving when
 * nothing needs filling in.
 */
export function normalizeStartupConfigModelSpecs(config: t.TStartupConfig): t.TStartupConfig {
  const modelSpecs = config?.modelSpecs;
  if (!modelSpecs?.list?.length) {
    return config;
  }
  const normalized = normalizeModelSpecs(modelSpecs.list);
  if (normalized === modelSpecs.list) {
    return config;
  }
  return { ...config, modelSpecs: { ...modelSpecs, list: normalized } };
}

/** Gets the default frontend-facing endpoint, dependent on iconURL definition.
 *
 * If the iconURL is defined in the endpoint config, use it, otherwise use the endpoint
 */
export function getIconEndpoint({
  endpointsConfig,
  iconURL,
  endpoint,
}: {
  endpointsConfig?: t.TEndpointsConfig;
  iconURL?: string | null;
  endpoint?: string | null;
}) {
  return (endpointsConfig?.[iconURL ?? ''] ? (iconURL ?? endpoint) : endpoint) ?? '';
}

export const getEntity = ({
  endpoint,
  assistant_id,
  agent_id,
  agentsMap,
  assistantMap,
}: {
  endpoint: EModelEndpoint | string | null | undefined;
  assistant_id: string | undefined;
  agent_id: string | undefined;
  agentsMap: t.TAgentsMap | undefined;
  assistantMap: t.TAssistantsMap | undefined;
}): {
  entity: t.Agent | t.Assistant | undefined | null;
  isAgent: boolean;
  isAssistant: boolean;
} => {
  const isAgent = isAgentsEndpoint(endpoint);
  const isAssistant = isAssistantsEndpoint(endpoint);

  if (isAgent) {
    const agent = agentsMap?.[agent_id ?? ''];
    return { entity: agent, isAgent, isAssistant };
  } else if (isAssistant) {
    const assistant = assistantMap?.[endpoint ?? '']?.[assistant_id ?? ''];
    return { entity: assistant, isAgent, isAssistant };
  }
  return { entity: null, isAgent, isAssistant };
};
