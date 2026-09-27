import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { ensureHandler } from '@langchain/core/callbacks/manager';
import { Run, Providers, Constants, HookRegistry } from '@librechat/agents';
import {
  KnownEndpoints,
  EModelEndpoint,
  ReasoningEffort,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_RUN_CONFIGS,
  extractEnvVariable,
  providerEndpointMap,
  normalizeEndpointName,
  mapModelToAzureConfig,
  resolveUseResponsesApi,
} from 'librechat-data-provider';
import type {
  SummarizationConfig as AgentSummarizationConfig,
  MultiAgentGraphConfig,
  ContextPruningConfig,
  CompactionSemanticIndex,
  OpenAIClientOptions,
  StandardGraphConfig,
  StreamPreemption,
  LCToolRegistry,
  SubagentConfig,
  SubagentResolveContext,
  SubagentConfigEntry,
  HookCallback,
  AgentInputs,
  FallbackConfig,
  GenericTool,
  RunConfig,
  IState,
  LCTool,
  SubagentTaskConfig,
} from '@librechat/agents';
import type {
  Agent,
  ImageDetail,
  TAzureConfig,
  CodeApprovalMode,
  TAgentsEndpoint,
  AgentModelParameters,
  AgentSubagentsConfig,
  AgentSubagentGraph,
  ReasoningResponseKey,
  SummarizationConfig,
} from 'librechat-data-provider';
import type { AppConfig, IAgentFadingTier, IUser } from '@librechat/data-schemas';
import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import type { ModelBoundChatModelCallback } from '~/middleware/modelBoundContent';
import type { ModelErrorTrackerCallback } from '~/agents/failures/tracker';
import type { ToolInputValidationError } from '~/agents/toolValidation';
import type { ResolvedToolApprovalHook } from '~/agents/hitl/hooks';
import type { TerminalSteerHook } from '~/agents/steering/runtime';
import type { LangfuseTraceContext } from '~/langfuse/identity';
import type { ResolvedAlwaysApplySkill } from '~/agents/skills';
import type { CodeExecutionContext } from '~/agents/execution';
import type { MCPToolAlias } from '~/tools/classification';
import type { SubagentUsageEvent } from '~/agents/usage';
import type { RunFileSession } from './files/session';
import type { RunFadingTiers } from './fading';
import type * as t from '~/types';
import {
  assertAttachedCodeEnvironmentApprovalSupported,
  collectAttachedCodeEnvironmentAgentIds,
  collectAttachedCodeEnvironmentPolicySettings,
  createAttachedCodeEnvironmentPolicyHook,
  resolveAttachedCodeApprovalMode,
} from '~/agents/hitl/byom';
import {
  CHECK_BACKGROUND_TASK_NAME,
  registerBackgroundTaskTool,
  stripBackgroundFromToolRegistry,
  stripBackgroundFromToolDefinitions,
} from '~/agents/background';
import {
  createSubagentWakeupHandleHook,
  agentUsesSubagentCompletionWakeups,
  usesSubagentCompletionWakeups,
} from '~/agents/subagentDelivery';
import {
  resolveStreamLimits,
  resolveModelTransportTimeouts,
  resolveSubagentMaxTurns,
  resolveRecursionLimit,
} from '~/agents/config';
import {
  isSteeringSupported,
  isSteerPreemptSupported,
  isSteerTerminalContinuationSupported,
} from '~/agents/steering/runtime';
import {
  resolveToolApprovalPolicy,
  healToolApprovalPolicy,
  exemptAskUserQuestionFromApproval,
} from '~/agents/hitl/policy';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
} from '~/agents/hitl/askUserQuestionTool';
import {
  createRunFileTools,
  eventOnlyRunFileTools,
  isRunFileSharingSupported,
} from './files/runtime';
import { applyCustomHandoffPromptKeyCompatibility } from '~/agents/handoffPromptKeyCompatibility';
import { stripIntentFromToolRegistry, stripIntentFromToolDefinitions } from '~/agents/intent';
import { resolveConfigHeaders, resolveModelHeaders, mergeHeaders } from '~/utils/headers';
import { extractDefaultParams, resolveReasoningParams } from '~/endpoints/openai/llm';
import { getLLMConfig as getAnthropicLLMConfig } from '~/endpoints/anthropic/llm';
import { CREATE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME } from '~/agents/tools';
import { buildAgentInitialToolSessions } from '~/agents/codeFilesSession';
import { getDirectDispatcher, getProxyDispatcher } from '~/utils/proxy';
import { getAzureCredentials, constructAzureURL } from '~/utils/azure';
import { getBuiltInBaseURL } from '~/endpoints/openai/initialize';
import { getProviderConfig } from '~/endpoints/config/providers';
import { buildToolApprovalHooks } from '~/agents/hitl/hooks';
import { getAgentCheckpointer } from '~/agents/checkpointer';
import { getPluginHookSource } from '~/agents/hooks/source';
import { getOpenAIConfig } from '~/endpoints/openai/config';
import { createStepBudgetHook } from '~/agents/stepBudget';
import { buildHITLRunWiring } from '~/agents/hitl/runtime';
import { buildLangfuseConfig } from '~/langfuse/config';
import { applyTestRunHook } from '~/agents/testHook';
import { isUserProvided } from '~/utils/common';
import { createSafeUser } from '~/utils/env';

/** Expected shape of JSON tool search results */
interface ToolSearchJsonResult {
  found?: number;
  tools?: Array<{ name: string }>;
}

/**
 * Parses tool names from JSON-formatted tool_search output.
 * Format: { "found": N, "tools": [{ "name": "tool_name", ... }], ... }
 *
 * @param content - The JSON string content
 * @param discoveredTools - Set to add discovered tool names to
 * @returns true if parsing succeeded, false otherwise
 */
function parseToolSearchJson(content: string, discoveredTools: Set<string>): boolean {
  try {
    const parsed = JSON.parse(content) as ToolSearchJsonResult;
    if (!parsed.tools || !Array.isArray(parsed.tools)) {
      return false;
    }
    for (const tool of parsed.tools) {
      if (tool.name && typeof tool.name === 'string') {
        discoveredTools.add(tool.name);
      }
    }
    return parsed.tools.length > 0;
  } catch {
    return false;
  }
}

/**
 * Parses tool names from legacy text-formatted tool_search output.
 * Format: "- tool_name (score: X.XX)"
 *
 * @param content - The text content
 * @param discoveredTools - Set to add discovered tool names to
 */
function parseToolSearchLegacy(content: string, discoveredTools: Set<string>): void {
  const toolNameRegex = /^- ([^\s(]+)\s*\(score:/gm;
  let match: RegExpExecArray | null;
  while ((match = toolNameRegex.exec(content)) !== null) {
    const toolName = match[1];
    if (toolName) {
      discoveredTools.add(toolName);
    }
  }
}

/**
 * Extracts discovered tool names from message history by parsing tool_search results.
 * When the LLM calls tool_search, the result contains tool names that were discovered.
 * These tools should have defer_loading overridden to false on subsequent turns.
 *
 * Supports both:
 * - New JSON format: { "tools": [{ "name": "tool_name" }] }
 * - Legacy text format: "- tool_name (score: X.XX)"
 *
 * @param messages - The conversation message history
 * @returns Set of tool names that were discovered via tool_search
 */
export function extractDiscoveredToolsFromHistory(messages: BaseMessage[]): Set<string> {
  const discoveredTools = new Set<string>();

  for (const message of messages) {
    const msgType = message._getType?.() ?? message.constructor?.name ?? '';
    if (msgType !== 'tool') {
      continue;
    }

    const name = (message as { name?: string }).name;
    if (name !== Constants.TOOL_SEARCH) {
      continue;
    }

    const content = message.content;
    if (typeof content !== 'string') {
      continue;
    }

    /** Try JSON format first (new), fall back to regex (legacy) */
    if (!parseToolSearchJson(content, discoveredTools)) {
      parseToolSearchLegacy(content, discoveredTools);
    }
  }

  return discoveredTools;
}

export interface RunDiscoverySnapshot {
  getDiscoveredTools?: () => string[];
  getRunMessages?: () => BaseMessage[] | undefined;
}

/** Reads canonical run discovery state, with best-effort history parsing for older releases. */
export function getRunDiscoveredTools(run: RunDiscoverySnapshot): string[] {
  if (typeof run.getDiscoveredTools === 'function') {
    const discoveredTools = run.getDiscoveredTools();
    if (Array.isArray(discoveredTools)) {
      return Array.from(new Set(discoveredTools));
    }
  }

  if (typeof run.getRunMessages !== 'function') {
    return [];
  }
  const messages = run.getRunMessages();
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  return Array.from(extractDiscoveredToolsFromHistory(messages));
}

/**
 * Extracts skill names that were invoked in previous turns from raw message payload.
 * Scans assistant messages for tool_call content parts where name === 'skill'.
 * Works with TPayload (raw message objects) so it can run before formatAgentMessages.
 *
 * @param payload - The raw conversation message payload
 * @returns Set of skill names that were previously invoked
 */
export function extractInvokedSkillsFromPayload(
  payload: Array<Partial<{ role: string; content: unknown }>>,
): Set<string> {
  const invokedSkills = new Set<string>();

  for (const message of payload) {
    if (message.role !== 'assistant') {
      continue;
    }

    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }

    for (const part of content) {
      if (
        part == null ||
        typeof part !== 'object' ||
        (part as { type?: string }).type !== 'tool_call'
      ) {
        continue;
      }
      const toolCall = (part as { tool_call?: { name?: string; args?: unknown } }).tool_call;
      if (toolCall?.name !== Constants.SKILL_TOOL) {
        continue;
      }
      const rawArgs = toolCall.args;
      const args =
        typeof rawArgs === 'string'
          ? (() => {
              try {
                return JSON.parse(rawArgs) as Record<string, unknown>;
              } catch {
                return {};
              }
            })()
          : (rawArgs as Record<string, unknown> | undefined);
      const skillName = args?.skillName;
      if (typeof skillName === 'string' && skillName.length > 0) {
        invokedSkills.add(skillName);
      }
    }
  }

  return invokedSkills;
}

/**
 * Overrides defer_loading to false for tools that were already discovered via tool_search.
 * This prevents the LLM from having to re-discover tools on every turn.
 *
 * @param toolRegistry - The tool registry to modify (mutated in place)
 * @param discoveredTools - Set of tool names that were previously discovered
 * @returns Number of tools that had defer_loading overridden
 */
export function overrideDeferLoadingForDiscoveredTools(
  toolRegistry: LCToolRegistry,
  discoveredTools: Set<string>,
): number {
  let overrideCount = 0;
  for (const toolName of discoveredTools) {
    const toolDef = toolRegistry.get(toolName);
    if (toolDef && toolDef.defer_loading === true) {
      toolDef.defer_loading = false;
      overrideCount++;
    }
  }
  return overrideCount;
}

const customProviders = new Set([
  Providers.XAI,
  Providers.DEEPSEEK,
  Providers.MOONSHOT,
  Providers.OPENROUTER,
  KnownEndpoints.ollama,
]);

type AgentReasoningKey = 'reasoning_content' | 'reasoning';

function includesOpenRouter(value?: string | null): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(KnownEndpoints.openrouter);
}

export function getReasoningKey(
  provider: Providers,
  llmConfig: t.RunLLMConfig,
  agentEndpoint?: string | null,
  customReasoningKey?: ReasoningResponseKey,
): AgentReasoningKey {
  if (customReasoningKey) {
    return customReasoningKey as AgentReasoningKey;
  }

  let reasoningKey: AgentReasoningKey = 'reasoning_content';
  if (provider === Providers.GOOGLE) {
    reasoningKey = 'reasoning';
  } else if (
    includesOpenRouter(llmConfig.configuration?.baseURL) ||
    includesOpenRouter(agentEndpoint)
  ) {
    reasoningKey = 'reasoning';
  } else if (
    (llmConfig as OpenAIClientOptions).useResponsesApi === true &&
    (provider === Providers.OPENAI || provider === Providers.AZURE)
  ) {
    reasoningKey = 'reasoning';
  }
  return reasoningKey;
}

const DEEPSEEK_MODEL_PATTERN = /^deepseek(?:[-/]|$)/i;
const OPENROUTER_LATEST_ROUTING_PREFIX = /^~/;

function matchesDeepSeekModel(model?: string | null): boolean {
  if (typeof model !== 'string' || model.length === 0) {
    return false;
  }
  return DEEPSEEK_MODEL_PATTERN.test(model.replace(OPENROUTER_LATEST_ROUTING_PREFIX, ''));
}

/**
 * Whether the (provider, model) pair targets DeepSeek's thinking-mode
 * tool-calling contract, which requires `reasoning_content` to be replayed
 * on every prior assistant message that emitted `tool_calls`.
 * @see https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
 */
export function isDeepSeekReasoningProvider(
  provider: string | Providers | undefined | null,
  model?: string | null,
): boolean {
  if (typeof provider === 'string' && provider.length > 0) {
    const normalized = provider.toLowerCase();
    if (normalized === Providers.DEEPSEEK) {
      return true;
    }
    if (normalized === Providers.OPENROUTER) {
      return matchesDeepSeekModel(model);
    }
  }
  return matchesDeepSeekModel(model);
}

/**
 * Whether prior assistant tool-call messages should have `reasoning_content`
 * reconstructed when reformatting persisted history (cross-turn replay): either
 * DeepSeek thinking-mode (#13366) or a custom OpenAI-compatible endpoint that
 * opted in via `customParams.includeReasoningHistory` (e.g. Xiaomi MiMo, Kimi).
 */
export function shouldReplayReasoningContent(
  agent?: {
    provider?: string | Providers | null;
    model?: string | null;
    model_parameters?: { model?: string | null } | null;
    includeReasoningHistory?: boolean | null;
  } | null,
): boolean {
  if (agent == null) {
    return false;
  }
  if (agent.includeReasoningHistory === true) {
    return true;
  }
  return isDeepSeekReasoningProvider(agent.provider, agent.model_parameters?.model ?? agent.model);
}

type RunAgent = Omit<Agent, 'tools'> & {
  azureOptions?: t.AzureOptions;
  tools?: GenericTool[];
  maxContextTokens?: number;
  /** Pre-ratio context budget from initializeAgent. */
  baseContextTokens?: number;
  useLegacyContent?: boolean;
  imageDetail?: ImageDetail;
  toolContextMap?: Record<string, unknown>;
  dynamicToolContextMap?: Record<string, unknown>;
  toolRegistry?: LCToolRegistry;
  /** Serializable tool definitions for event-driven execution */
  toolDefinitions?: LCTool[];
  /** Precomputed flag indicating if any tools have defer_loading enabled */
  hasDeferredTools?: boolean;
  /** Both-direction identity aliases for MCP tools whose key spelling changed */
  mcpToolAliases?: MCPToolAlias[];
  /** Names of tools injected with the `run_in_background` param (excluded from eager execution). */
  backgroundToolNames?: string[];
  /** Names of tools with the host-injected `intent` param (stripped from self-spawn inputs). */
  intentToolNames?: string[];
  /** Marker-verified tool names whose intent labels are safe compaction guidance. */
  semanticIntentToolNames?: string[];
  /**
   * Per-agent codeenv gate set by `initializeAgent`: admin-level
   * `execute_code` capability AND the agent actually requested
   * `execute_code` in its tools. Used here to enable
   * `RunConfig.toolOutputReferences` only on runs where the bash tool
   * is actually registered.
   */
  codeEnvAvailable?: boolean;
  /**
   * Per-agent stateful-session gate set by `initializeAgent`: the admin
   * `stateful_code_sessions` capability AND the agent's builder opt-in AND
   * `codeEnvAvailable`. Carried into per-agent tool loading and prewarming.
   */
  statefulCodeSessions?: boolean;
  /** Per-agent stateful workspace sharing scope. */
  statefulCodeEnvironment?: Agent['stateful_code_environment'];
  /** Trusted partition for transient code session ids and file references. */
  codeSessionKey?: string;
  /** Trusted Code API route selected during initialization. */
  codeExecutionContext?: CodeExecutionContext;
  /** Whether this initialized agent can route skills/ writes to persistent skill storage. */
  skillAuthoringAvailable?: boolean;
  /** Optional per-agent summarization overrides */
  summarization?: SummarizationConfig;
  /** Response field to read model reasoning from for custom OpenAI-compatible endpoints. */
  reasoningKey?: ReasoningResponseKey;
  /** Whether to reconstruct `reasoning_content` from persisted history across turns. */
  includeReasoningHistory?: boolean;
  /**
   * Maximum characters allowed in a single tool result before truncation.
   * Overrides the default computed from maxContextTokens.
   */
  maxToolResultChars?: number;
  /** Initialized subagent configs (loaded by initialize.js from agent.subagents.agent_ids). */
  subagentAgentConfigs?: RunAgent[];
  /**
   * Inert, VIEW-checked descriptors for explicit children that are initialized
   * only after the SDK selects them. These resolvers are request-scoped: they
   * may use the active request's authorization and tool-loading context.
   */
  lazySubagentConfigs?: LazySubagentAgent[];
  /** All-or-nothing saved-agent teams resolved by initialize.js. */
  subagentGraphConfigs?: Array<{
    definition: AgentSubagentGraph;
    memberConfigs: RunAgent[];
  }>;
  /** Member-scoped always-apply skills resolved during agent initialization. */
  alwaysApplySkillPrimes?: ResolvedAlwaysApplySkill[];
  /** Source subagent spawning configuration (enabled / allowSelf / agent_ids). */
  subagents?: AgentSubagentsConfig;
};

type LazySubagentAgent = Pick<
  RunAgent,
  | 'id'
  | 'name'
  | 'description'
  | 'provider'
  | 'model'
  | 'model_parameters'
  | 'recursion_limit'
  | 'subagents'
  | 'codeEnvAvailable'
  | 'statefulCodeSessions'
  | 'statefulCodeEnvironment'
  | 'codeExecutionContext'
  | 'codeSessionKey'
  | 'skillAuthoringAvailable'
  | 'includeReasoningHistory'
  | 'mcpToolAliases'
> & {
  configId: string;
  subagentAgentConfigs?: RunAgent[];
  lazySubagentConfigs?: LazySubagentAgent[];
  /** Lightweight graph-member metadata used only by run-wide capability gates. */
  subagentGraphMemberMetadata?: SubagentTreeNode[];
  resolve: (context: SubagentResolveContext) => Promise<RunAgent>;
};

type SubagentTreeNode = Pick<
  RunAgent,
  | 'id'
  | 'provider'
  | 'model'
  | 'model_parameters'
  | 'codeEnvAvailable'
  | 'statefulCodeSessions'
  | 'statefulCodeEnvironment'
  | 'codeExecutionContext'
  | 'codeSessionKey'
  | 'skillAuthoringAvailable'
  | 'includeReasoningHistory'
  | 'mcpToolAliases'
> & {
  subagentAgentConfigs?: SubagentTreeNode[];
  lazySubagentConfigs?: SubagentTreeNode[];
  subagentGraphMemberMetadata?: SubagentTreeNode[];
  subagentGraphConfigs?: Array<{ memberConfigs: SubagentTreeNode[] }>;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const UNRESOLVED_ENV_VAR_PLACEHOLDER = /\$\{[^}]+\}/;

function hasUnresolvedPlaceholder(value: string): boolean {
  return UNRESOLVED_ENV_VAR_PLACEHOLDER.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

const nullableAgentModelParameterKeys = [
  'temperature',
  'maxContextTokens',
  'max_context_tokens',
  'max_output_tokens',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
] satisfies Array<keyof AgentModelParameters>;

function normalizeAgentModelParameters(
  modelParameters: AgentModelParameters | undefined,
): Partial<AgentModelParameters> | undefined {
  if (!modelParameters) {
    return undefined;
  }
  const normalized: Partial<AgentModelParameters> = { ...modelParameters };
  for (const key of nullableAgentModelParameterKeys) {
    if (normalized[key] === null) {
      delete normalized[key];
    }
  }
  return normalized;
}

/**
 * Merges user-supplied summarization parameters on top of endpoint-resolved
 * overrides. User params win for top-level keys; `configuration` is
 * deep-merged so user additions (e.g. `defaultQuery`) don't wipe out the
 * resolved `baseURL`/`defaultHeaders`/`fetchOptions`. When transport resolution already
 * consumed the user's URL, retain its normalized form instead of restoring the raw template.
 */
function mergeParameters(
  overrides: SummarizationClientOverrides,
  userParams: SummarizationConfig['parameters'],
  resolvedTransport = false,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...overrides, ...(userParams ?? {}) };
  const userConfiguration = (userParams as Record<string, unknown> | undefined)?.configuration;
  if (isPlainObject(overrides.configuration) && isPlainObject(userConfiguration)) {
    merged.configuration = {
      ...overrides.configuration,
      ...userConfiguration,
      ...(resolvedTransport ? { baseURL: overrides.configuration.baseURL } : {}),
      defaultHeaders: mergeHeaders(
        overrides.configuration.defaultHeaders as Record<string, string> | undefined,
        userConfiguration.defaultHeaders as Record<string, string> | undefined,
      ),
      defaultQuery: {
        ...(isPlainObject(overrides.configuration.defaultQuery)
          ? overrides.configuration.defaultQuery
          : {}),
        ...(isPlainObject(userConfiguration.defaultQuery) ? userConfiguration.defaultQuery : {}),
      },
    };
  }
  return merged;
}

/** `model_parameters` is the agent's resolved `llmConfig`, whose kwargs the schema type omits. */
function agentModelKwargs(
  modelParameters: AgentModelParameters | undefined,
): Record<string, unknown> | undefined {
  if (modelParameters == null || !('modelKwargs' in modelParameters)) {
    return undefined;
  }
  return isPlainObject(modelParameters.modelKwargs) ? modelParameters.modelKwargs : undefined;
}

/**
 * `getOpenAILLMConfig` carries an Azure Astra deployment alias in
 * `modelKwargs.model`, which langchain spreads after `model`. The SDK's
 * same-provider summarizer copies the agent's client options and overrides only
 * `model`, so a summarizer on another model would still reach the agent's
 * deployment. Hand it the agent's kwargs without the alias.
 */
function summarizationModelKwargs(
  agentKwargs: Record<string, unknown> | undefined,
  agentModel: string | undefined,
  summarizationModel: string | undefined,
): Record<string, unknown> | undefined {
  if (agentKwargs == null || !('model' in agentKwargs)) {
    return undefined;
  }
  if (!isNonEmptyString(summarizationModel) || summarizationModel === agentModel) {
    return undefined;
  }
  const { model: _alias, ...kwargs } = agentKwargs;
  return kwargs;
}

/**
 * Mirrors `getOpenAIConfig`'s `llmConfig` shape (plus its `configOptions`
 * assigned to `configuration`). Index signature covers fields that the
 * helper emits dynamically per provider variant.
 */
interface SummarizationClientOverrides {
  apiKey?: string;
  streaming?: boolean;
  configuration?: t.OpenAIConfiguration;
  [key: string]: unknown;
}

/**
 * A user-supplied base URL in `summarization.parameters` points the summarizer
 * at a gateway whose contract is not the built-in provider's, so no built-in
 * request shaping may be claimed for it.
 */
function hasBaseURLOverride(parameters: SummarizationConfig['parameters']): boolean {
  if (!isPlainObject(parameters)) {
    return false;
  }
  const params = parameters as Record<string, unknown>;
  if (isNonEmptyString(params.baseURL)) {
    return true;
  }
  return isPlainObject(params.configuration) && 'baseURL' in params.configuration;
}

/**
 * The scalar `reasoning_effort` the yaml schema accepts, when it names a known
 * effort. `getOpenAIConfig` reads the effort from `modelOptions` — the merged
 * `parameters` reach it too late — so a summarizer that configures one has to
 * hand it over for the same API routing the agent flow performs.
 */
function summarizationReasoningEffort(
  parameters: SummarizationConfig['parameters'],
): ReasoningEffort | undefined {
  if (!isPlainObject(parameters)) {
    return undefined;
  }
  const effort = (parameters as Record<string, unknown>).reasoning_effort;
  const known = Object.values(ReasoningEffort) as string[];
  return typeof effort === 'string' && known.includes(effort)
    ? (effort as ReasoningEffort)
    : undefined;
}

/**
 * Builds the model-specific request shaping a built-in provider's client needs,
 * for the cross-provider case where the SDK builds that client from these
 * parameters alone.
 *
 * The custom-endpoint path below already runs `getOpenAIConfig`; built-in
 * providers skipped it entirely, so a summarizer never learned which API its
 * model takes or whether its endpoint is first-party — and the agents SDK
 * defaults its model-specific constraints off without that declaration
 * (LibreChat#15598).
 *
 * Credentials and base URLs are not returned: the SDK still resolves them as
 * before. Cross-provider OpenAI-family clients do receive the Agent transport
 * timeout policy, even when a URL override prevents built-in request shaping.
 */
function resolveBuiltInClientOverrides(
  provider: string,
  target: {
    model?: string;
    parameters?: SummarizationConfig['parameters'];
    agentProvider?: string;
  },
  appConfig: AppConfig,
): SummarizationClientOverrides | undefined {
  const { model, parameters } = target;
  /**
   * Mirrors the SDK's own condition: when the summarization provider matches the
   * agent's, `buildSummarizationClientConfig` spreads the agent's resolved client
   * options and these parameters layer on top. A custom-endpoint agent is
   * normalized to the `openAI` provider while keeping its own endpoint name, so
   * declaring built-in constraints here would claim OpenAI's contract for that
   * gateway.
   */
  if (provider === target.agentProvider) {
    return undefined;
  }
  let transportOverrides: SummarizationClientOverrides | undefined;
  if (provider === Providers.OPENAI || provider === Providers.AZURE) {
    const timeouts = resolveModelTransportTimeouts(appConfig.endpoints?.agents);
    transportOverrides = {
      configuration: {
        fetchOptions: {
          dispatcher:
            getProxyDispatcher(process.env.PROXY, timeouts) ?? getDirectDispatcher(timeouts),
        },
      },
    };
  }
  const baseURL = getBuiltInBaseURL(provider);
  /** URL overrides still get timeouts, but must not inherit first-party request shaping. */
  if (!isNonEmptyString(model) || hasBaseURLOverride(parameters) || isUserProvided(baseURL)) {
    return transportOverrides;
  }
  const { llmConfig } = getOpenAIConfig(
    '',
    {
      modelOptions: { model, reasoning_effort: summarizationReasoningEffort(parameters) },
      reverseProxyUrl: baseURL,
    },
    provider,
  );
  const {
    apiKey: _apiKey,
    model: _model,
    modelName: _modelName,
    streaming: _streaming,
    ...shaping
  } = llmConfig;
  return Object.keys(shaping).length > 0
    ? { ...shaping, ...transportOverrides }
    : transportOverrides;
}

/**
 * Memory bound for the warning deduplication below, not an operator setting: it only decides when a
 * warning for one of more than this many distinct, concurrently recurring problems is logged again.
 */
const MAX_UNRESOLVED_SUMMARIZATION_WARNINGS = 256;
/** Reported summarization misconfigurations per tenant, least recently seen first. */
const unresolvedSummarizationWarnings = new Set<string>();

function warnUnresolvedSummarization(message: string, tenantId?: string): void {
  const key = `${tenantId ?? ''}\n${message}`;
  if (unresolvedSummarizationWarnings.delete(key)) {
    unresolvedSummarizationWarnings.add(key);
    return;
  }
  if (unresolvedSummarizationWarnings.size >= MAX_UNRESOLVED_SUMMARIZATION_WARNINGS) {
    const [leastRecentlySeen] = unresolvedSummarizationWarnings;
    unresolvedSummarizationWarnings.delete(leastRecentlySeen);
  }
  unresolvedSummarizationWarnings.add(key);
  if (tenantId == null) {
    logger.warn(`[createRun] ${message}`);
    return;
  }
  logger.warn(`[createRun] ${message}`, { tenantId });
}

/** Azure base URL templates the client fills from its own options rather than the environment. */
const AZURE_URL_TEMPLATE = /(\$\{(?:INSTANCE_NAME|DEPLOYMENT_NAME)\})/;

/** The URL's segments around Azure's reserved templates, which sit at the odd indexes. */
function splitAzureURLTemplates(url: string): string[] {
  return url.split(AZURE_URL_TEMPLATE);
}

/** Expands environment references in a URL, leaving Azure's reserved templates for an Azure client. */
function expandTransportURL(url: string, targetsAzure: boolean): string {
  if (!targetsAzure) {
    return extractEnvVariable(url);
  }
  return splitAzureURLTemplates(url)
    .map((segment, index) => (index % 2 === 1 ? segment : extractEnvVariable(segment)))
    .join('');
}

/**
 * Admin-authored transport values may reference environment variables, as endpoint credentials
 * do. Expanded once, before resolution and before the parameters are layered over the client.
 */
function expandSummarizationTransport(
  parameters: SummarizationConfig['parameters'],
  targetsAzure: boolean,
): SummarizationConfig['parameters'] {
  if (!isPlainObject(parameters)) {
    return parameters;
  }
  const params = parameters as Record<string, unknown>;
  const expanded: Record<string, unknown> = { ...params };
  if (typeof params.apiKey === 'string') {
    expanded.apiKey = extractEnvVariable(params.apiKey);
  }
  if (typeof params.baseURL === 'string') {
    expanded.baseURL = expandTransportURL(params.baseURL, targetsAzure);
  }
  if (isPlainObject(params.configuration) && typeof params.configuration.baseURL === 'string') {
    expanded.configuration = {
      ...params.configuration,
      baseURL: expandTransportURL(params.configuration.baseURL, targetsAzure),
    };
  }
  return expanded as SummarizationConfig['parameters'];
}

/** The base URL and API key a summarization target's own parameters set, which replace the resolved ones. */
function summarizationTransportOverrides(parameters: SummarizationConfig['parameters']): {
  baseURL?: string;
  apiKey?: string;
} {
  const configuration = (parameters as Record<string, unknown> | undefined)?.configuration;
  const configurationBaseURL =
    isPlainObject(configuration) && typeof configuration.baseURL === 'string'
      ? configuration.baseURL
      : undefined;
  return {
    baseURL:
      configurationBaseURL ??
      (typeof parameters?.baseURL === 'string' ? parameters.baseURL : undefined),
    apiKey: typeof parameters?.apiKey === 'string' ? parameters.apiKey : undefined,
  };
}

/** Reject unusable transports while shaping the run, before a compaction client can fail it. */
function isSummarizationURLAvailable(baseURL: string | undefined, azure?: t.AzureOptions): boolean {
  if (baseURL == null) {
    return azure == null || isNonEmptyString(azure.azureOpenAIApiInstanceName);
  }
  try {
    const url = new URL(constructAzureURL({ baseURL, azureOptions: azure }));
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && !hasUnresolvedPlaceholder(url.href)
    );
  } catch {
    return false;
  }
}

/**
 * Azure Responses shares OpenAI's SDK provider, so switching endpoints must replace its transport.
 * Returns `undefined` when the OpenAI credentials cannot be resolved without a per-user lookup.
 */
function resolveOpenAISummarization(
  model: string,
  appConfig: AppConfig | undefined,
  parameters: SummarizationConfig['parameters'],
  headerContext: { user?: IUser; tenantId?: string; requestBody?: t.RequestBody },
): { provider: string; clientOverrides: SummarizationClientOverrides } | undefined {
  const overrides = summarizationTransportOverrides(parameters);
  const baseURL = overrides.baseURL ?? getBuiltInBaseURL(EModelEndpoint.openAI);
  const apiKey = overrides.apiKey ?? process.env.OPENAI_API_KEY;
  if (
    !apiKey ||
    !isSummarizationURLAvailable(baseURL) ||
    isUserProvided(baseURL) ||
    isUserProvided(apiKey) ||
    hasUnresolvedPlaceholder(apiKey) ||
    (baseURL != null && hasUnresolvedPlaceholder(baseURL))
  ) {
    warnUnresolvedSummarization(
      `Summarization with OpenAI model "${model}" is disabled for Azure OpenAI agents: it needs a server-configured OpenAI API key and base URL.`,
      headerContext.tenantId,
    );
    return undefined;
  }
  const headers = mergeHeaders(
    appConfig?.endpoints?.all?.headers,
    appConfig?.endpoints?.openAI?.headers,
  );
  const { llmConfig, configOptions } = getOpenAIConfig(
    apiKey,
    {
      modelOptions: {
        model,
        reasoning_effort: summarizationReasoningEffort(parameters),
        useResponsesApi:
          typeof parameters?.useResponsesApi === 'boolean' ? parameters.useResponsesApi : undefined,
      },
      reverseProxyUrl: baseURL,
      proxy: process.env.PROXY ?? undefined,
      headers: resolveModelHeaders({
        headers: headers ?? {},
        user: createSafeUser(headerContext.user),
        tenantId: headerContext.tenantId,
        body: headerContext.requestBody,
      }),
      transportTimeouts: resolveModelTransportTimeouts(appConfig?.endpoints?.agents),
    },
    EModelEndpoint.openAI,
  );
  return {
    provider: Providers.OPENAI,
    clientOverrides: {
      ...llmConfig,
      apiKey,
      useResponsesApi: llmConfig.useResponsesApi ?? false,
      firstPartyEndpoint: llmConfig.firstPartyEndpoint ?? false,
      reasoning: llmConfig.reasoning,
      modelKwargs: llmConfig.modelKwargs ?? {},
      configuration: configOptions,
    },
  };
}

type AzureSummarizationTarget = Omit<ReturnType<typeof mapModelToAzureConfig>, 'azureOptions'> & {
  azureOptions: t.AzureOptions;
  group?: TAzureConfig['groupMap'][string];
};

/**
 * The summary model's Azure credentials, resolved the way `initializeOpenAI` resolves an agent's:
 * the `azureOpenAI` configuration when present, otherwise the legacy environment credentials.
 * Returns `undefined` (reported once) when the configuration does not define the model.
 */
function resolveAzureSummarizationTarget(
  model: string,
  azureConfig: TAzureConfig | undefined,
  tenantId: string | undefined,
): AzureSummarizationTarget | undefined {
  if (!azureConfig) {
    return { azureOptions: getAzureCredentials() };
  }
  try {
    const groupName = azureConfig.modelGroupMap[model]?.group;
    return {
      ...mapModelToAzureConfig({
        modelName: model,
        modelGroupMap: azureConfig.modelGroupMap,
        groupMap: azureConfig.groupMap,
      }),
      group: groupName ? azureConfig.groupMap[groupName] : undefined,
    };
  } catch (error) {
    warnUnresolvedSummarization(
      `Summarization with Azure OpenAI model "${model}" is disabled: ${(error as Error).message}`,
      tenantId,
    );
    return undefined;
  }
}

/** Reuse request-resolved credentials for self-summaries, including user-provided Azure keys. */
function azureSummarizationSource(agent: RunAgent): AzureSummarizationTarget {
  const options = agent.model_parameters as Partial<t.OAIClientOptions> & t.AzureOptions;
  const configuration = options.configuration;
  const baseURL = configuration?.baseURL ?? options.azureOpenAIBasePath;
  const deployment = agentModelKwargs(agent.model_parameters)?.model;
  return {
    serverless: agent.useLegacyContent === true,
    baseURL: baseURL ?? undefined,
    azureOptions: {
      azureOpenAIApiKey:
        options.azureOpenAIApiKey ??
        (typeof options.apiKey === 'string' ? options.apiKey : undefined),
      azureOpenAIApiInstanceName:
        options.azureOpenAIApiInstanceName ?? agent.azureOptions?.azureOpenAIApiInstanceName,
      azureOpenAIApiDeploymentName:
        options.azureOpenAIApiDeploymentName ??
        (typeof deployment === 'string' ? deployment : options.model),
      azureOpenAIApiVersion:
        options.azureOpenAIApiVersion ??
        agent.azureOptions?.azureOpenAIApiVersion ??
        configuration?.defaultQuery?.['api-version'] ??
        undefined,
    },
  };
}

/**
 * Resolve the summary model's deployment and transport before the SDK inherits agent options.
 * A same-provider summarizer layers these over the agent's client options, so a summary group
 * without a base path clears the agent's instead of sending its deployment to that resource.
 * Returns `undefined` when the model cannot be resolved without a per-user lookup.
 */
function resolveAzureSummarization(
  model: string,
  appConfig: AppConfig | undefined,
  parameters: SummarizationConfig['parameters'],
  headerContext: { user?: IUser; tenantId?: string; requestBody?: t.RequestBody },
  source?: RunAgent,
): { provider: string; clientOverrides: SummarizationClientOverrides } | undefined {
  const sourceOptions = source?.model_parameters as Partial<t.OAIClientOptions> | undefined;
  const target = source
    ? azureSummarizationSource(source)
    : resolveAzureSummarizationTarget(
        model,
        appConfig?.endpoints?.[EModelEndpoint.azureOpenAI],
        headerContext.tenantId,
      );
  if (!target) {
    return undefined;
  }
  const { baseURL, headers, serverless, group } = target;
  const overrides = summarizationTransportOverrides(parameters);
  const azureOptions: t.AzureOptions = {
    ...target.azureOptions,
    azureOpenAIApiKey: overrides.apiKey ?? target.azureOptions.azureOpenAIApiKey,
  };
  const resolvedBaseURL =
    overrides.baseURL ?? baseURL ?? getBuiltInBaseURL(EModelEndpoint.azureOpenAI);
  if (
    !azureOptions.azureOpenAIApiKey ||
    !isSummarizationURLAvailable(resolvedBaseURL, serverless ? undefined : azureOptions) ||
    Object.values(azureOptions).some(
      (value) =>
        typeof value === 'string' && (isUserProvided(value) || hasUnresolvedPlaceholder(value)),
    ) ||
    isUserProvided(resolvedBaseURL) ||
    (resolvedBaseURL != null &&
      splitAzureURLTemplates(resolvedBaseURL).some(
        (segment, index) => index % 2 === 0 && hasUnresolvedPlaceholder(segment),
      ))
  ) {
    warnUnresolvedSummarization(
      `Summarization with Azure OpenAI model "${model}" is disabled: it needs a server-configured Azure OpenAI API key and base URL.`,
      headerContext.tenantId,
    );
    return undefined;
  }
  const resolvedHeaders = sourceOptions
    ? (sourceOptions.configuration?.defaultHeaders as Record<string, string> | undefined)
    : resolveModelHeaders({
        headers: mergeHeaders(appConfig?.endpoints?.all?.headers, headers) ?? {},
        user: createSafeUser(headerContext.user),
        tenantId: headerContext.tenantId,
        body: headerContext.requestBody,
      });
  const { llmConfig, configOptions } = getOpenAIConfig(
    azureOptions.azureOpenAIApiKey,
    {
      azure: serverless ? undefined : azureOptions,
      reverseProxyUrl: resolvedBaseURL,
      proxy: process.env.PROXY ?? undefined,
      headers:
        serverless || sourceOptions != null
          ? { ...resolvedHeaders, 'api-key': azureOptions.azureOpenAIApiKey }
          : resolvedHeaders,
      defaultQuery:
        serverless && azureOptions.azureOpenAIApiVersion
          ? { 'api-version': azureOptions.azureOpenAIApiVersion }
          : undefined,
      modelOptions: {
        model: source?.model ?? model,
        reasoning_effort: summarizationReasoningEffort(parameters),
        useResponsesApi:
          typeof parameters?.useResponsesApi === 'boolean'
            ? parameters.useResponsesApi
            : sourceOptions?.useResponsesApi,
      },
      addParams: {
        ...group?.addParams,
        ...(typeof parameters?.useResponsesApi === 'boolean'
          ? { useResponsesApi: parameters.useResponsesApi }
          : {}),
      },
      dropParams: group?.dropParams?.filter(
        (key) => key !== 'useResponsesApi' || typeof parameters?.useResponsesApi !== 'boolean',
      ),
      transportTimeouts: resolveModelTransportTimeouts(appConfig?.endpoints?.agents),
    },
    EModelEndpoint.azureOpenAI,
  );
  const sourceKwargs = agentModelKwargs(source?.model_parameters);
  const preservesApiMode = !!sourceOptions?.useResponsesApi === !!llmConfig.useResponsesApi;
  const sourceTokenLimit = sourceKwargs?.max_output_tokens ?? sourceKwargs?.max_completion_tokens;
  const inheritedTokenLimit =
    typeof sourceTokenLimit === 'number'
      ? {
          [llmConfig.useResponsesApi ? 'max_output_tokens' : 'max_completion_tokens']:
            sourceTokenLimit,
        }
      : {};
  return {
    provider: !serverless && !llmConfig.useResponsesApi ? Providers.AZURE : Providers.OPENAI,
    clientOverrides: {
      ...sourceOptions,
      azureOpenAIBasePath: undefined,
      azureOpenAIApiKey: undefined,
      azureOpenAIApiInstanceName: undefined,
      azureOpenAIApiDeploymentName: undefined,
      azureOpenAIApiVersion: undefined,
      ...llmConfig,
      apiKey: azureOptions.azureOpenAIApiKey,
      useResponsesApi: llmConfig.useResponsesApi ?? false,
      firstPartyEndpoint: llmConfig.firstPartyEndpoint ?? false,
      reasoning: llmConfig.reasoning ?? (preservesApiMode ? sourceOptions?.reasoning : undefined),
      modelKwargs: {
        ...(preservesApiMode ? sourceKwargs : undefined),
        ...inheritedTokenLimit,
        ...llmConfig.modelKwargs,
        model: llmConfig.modelKwargs?.model ?? llmConfig.model,
      },
      configuration: sourceOptions
        ? { ...sourceOptions.configuration, ...configOptions }
        : configOptions,
    },
  };
}

/**
 * Resolves a summarization provider string (which may be a custom-endpoint name
 * like "Ollama") into the SDK-recognized provider and any client-option
 * overrides required to talk to that endpoint.
 *
 * Without this step, a `summarization.provider: "Ollama"` entry in
 * `librechat.yaml` flows verbatim to the agents SDK, which only knows a fixed
 * set of provider names and throws "Unsupported LLM provider: Ollama".
 */
function resolveSummarizationProvider(
  rawProvider: string,
  appConfig: AppConfig | undefined,
  headerContext: { user?: IUser; tenantId?: string; requestBody?: t.RequestBody },
  target: {
    model?: string;
    parameters?: SummarizationConfig['parameters'];
    agentProvider?: string;
  } = {},
): {
  provider: string;
  clientOverrides?: SummarizationClientOverrides;
} {
  if (!appConfig || !isNonEmptyString(rawProvider)) {
    return { provider: rawProvider };
  }
  try {
    const { overrideProvider, customEndpointConfig } = getProviderConfig({
      provider: rawProvider,
      appConfig,
    });
    if (!customEndpointConfig) {
      return {
        provider: overrideProvider,
        clientOverrides: resolveBuiltInClientOverrides(overrideProvider, target, appConfig),
      };
    }
    const rawApiKey = customEndpointConfig.apiKey ?? '';
    const rawBaseURL = customEndpointConfig.baseURL ?? '';
    /**
     * User-provided credentials require an async DB lookup and expiry checks
     * that are out of scope here. Keep the raw provider so the SDK surfaces
     * a clear "Unsupported LLM provider" error rather than silently
     * remapping to `openAI` and routing summaries to the default backend.
     * Callers wanting user-provided summarization against a non-agent
     * endpoint must hit the same endpoint as the agent (handled upstream).
     */
    if (isUserProvided(rawApiKey) || isUserProvided(rawBaseURL)) {
      return { provider: rawProvider };
    }
    const apiKey = extractEnvVariable(rawApiKey);
    const baseURL = extractEnvVariable(rawBaseURL);
    /**
     * `extractEnvVariable` leaves any unresolved `${VAR}` placeholder in place
     * — including in the middle of a prefix/suffix string — when the env var
     * is missing. If the value is still broken, keep the raw provider so the
     * SDK errors out loudly instead of forwarding a malformed URL/key.
     */
    if (
      !apiKey ||
      !baseURL ||
      hasUnresolvedPlaceholder(apiKey) ||
      hasUnresolvedPlaceholder(baseURL)
    ) {
      return { provider: rawProvider };
    }
    /**
     * Resolve templated header values (e.g. `${PORTKEY_API_KEY}`,
     * `{{LIBRECHAT_BODY_PARENTMESSAGEID}}`) before handing them to
     * `getOpenAIConfig`, matching the agent main flow where `resolveHeaders`
     * runs on `llmConfig.configuration.defaultHeaders`.
     */
    const resolvedHeaders =
      customEndpointConfig.headers != null
        ? resolveModelHeaders({
            headers: customEndpointConfig.headers as Record<string, string>,
            user: createSafeUser(headerContext.user),
            tenantId: headerContext.tenantId,
            body: headerContext.requestBody,
          })
        : undefined;
    /**
     * Native Anthropic custom endpoints must build their config with the
     * Anthropic client (`/v1/messages`), not `getOpenAIConfig` (which would emit
     * OpenAI-shaped requests). The self-summarize case is handled earlier by
     * `isSameEndpointAsAgent`; this covers summarizing against a *different*
     * Anthropic-native custom endpoint.
     */
    if (customEndpointConfig.provider === EModelEndpoint.anthropic) {
      const { llmConfig } = getAnthropicLLMConfig(apiKey, {
        modelOptions: {},
        proxy: process.env.PROXY ?? undefined,
        reverseProxyUrl: baseURL,
        headers: resolvedHeaders,
        addParams: customEndpointConfig.addParams,
        dropParams: customEndpointConfig.dropParams,
        defaultParams: extractDefaultParams(customEndpointConfig.customParams?.paramDefinitions),
      });
      const { apiKey: resolvedApiKey, ...llmConfigOverrides } = llmConfig as Record<
        string,
        unknown
      >;
      const clientOverrides: SummarizationClientOverrides = { ...llmConfigOverrides };
      if (typeof resolvedApiKey === 'string') {
        clientOverrides.apiKey = resolvedApiKey;
      }
      /** Strip the default model so the user-supplied `summarization.model` wins. */
      delete clientOverrides.model;
      delete clientOverrides.modelName;
      return { provider: Providers.ANTHROPIC, clientOverrides };
    }

    /**
     * Run the endpoint config through `getOpenAIConfig` so summarization
     * inherits the same `headers`, `defaultQuery`, `addParams`/`dropParams`,
     * and `customParams` transforms that `initializeCustom` applies for the
     * main agent flow. Without this, summarization drops endpoint-specific
     * behavior (e.g. Anthropic/Google param transforms, required headers)
     * that the main agent relied on. `proxy` is forwarded so outbound proxy
     * dispatchers (`PROXY` env var) apply to cross-endpoint summarization.
     */
    const {
      llmConfig,
      configOptions,
      provider: detectedProvider,
    } = getOpenAIConfig(
      apiKey,
      {
        reverseProxyUrl: baseURL,
        proxy: process.env.PROXY ?? null,
        headers: resolvedHeaders,
        addParams: customEndpointConfig.addParams,
        dropParams: customEndpointConfig.dropParams,
        customParams: customEndpointConfig.customParams,
        directEndpoint: customEndpointConfig.directEndpoint,
        transportTimeouts: resolveModelTransportTimeouts(appConfig?.endpoints?.agents),
      },
      rawProvider,
    );
    const { apiKey: resolvedApiKey, ...llmConfigOverrides } = llmConfig;
    const clientOverrides: SummarizationClientOverrides = { ...llmConfigOverrides };
    if (typeof resolvedApiKey === 'string') {
      clientOverrides.apiKey = resolvedApiKey;
    }
    if (configOptions) {
      clientOverrides.configuration = configOptions;
    }
    /**
     * `model`/`modelName` on `llmConfig` default to whatever `getOpenAIConfig`
     * produces from empty modelOptions. Strip them so the user-supplied
     * `summarization.model` wins.
     */
    delete clientOverrides.model;
    delete clientOverrides.modelName;
    /**
     * `getOpenAIConfig` detects OpenRouter from the resolved `baseURL`, which
     * `getProviderConfig` cannot do for an endpoint whose config name isn't
     * `openrouter` — it reports `openAI` for those. Prefer the detected
     * provider so a cross-endpoint summarizer builds the same client the main
     * agent flow builds for that endpoint (`initializeAgent` applies the same
     * precedence).
     */
    const provider = detectedProvider ?? overrideProvider;
    /**
     * On the agent's provider the SDK layers these over the agent's own client options, so this
     * different endpoint replaces the agent's API mode, first-party declaration, reasoning and
     * request kwargs (an Azure Astra agent's Responses routing, for one) instead of inheriting them.
     */
    if (provider === target.agentProvider) {
      clientOverrides.useResponsesApi ??= false;
      clientOverrides.firstPartyEndpoint ??= false;
      clientOverrides.modelKwargs ??= {};
      clientOverrides.reasoning ??= undefined;
    }
    return { provider, clientOverrides };
  } catch (error) {
    logger.warn(
      `[resolveSummarizationProvider] failed to resolve "${rawProvider}"; falling back to raw provider`,
      error,
    );
    return { provider: rawProvider };
  }
}

/** Shapes a SummarizationConfig into the format expected by AgentInputs. */
function shapeSummarizationConfig(
  config: SummarizationConfig | undefined,
  fallbackProvider: string,
  fallbackModel: string | undefined,
  appConfig: AppConfig | undefined,
  agentEndpoint: string | undefined,
  headerContext: { user?: IUser; tenantId?: string; requestBody?: t.RequestBody },
  agent?: RunAgent,
) {
  const rawProvider = config?.provider ?? fallbackProvider;
  /**
   * When the summarization provider resolves to the same custom endpoint as
   * the main agent, skip client-option overrides. The SDK's self-summarize
   * path will reuse `agentContext.clientOptions` as-is, preserving any
   * request-resolved dynamic headers, fetch/proxy options, and other state
   * that `getOpenAIConfig` produced from raw yaml config does not capture.
   */
  const isSameEndpointAsAgent =
    agentEndpoint != null &&
    isNonEmptyString(rawProvider) &&
    normalizeEndpointName(rawProvider) === normalizeEndpointName(agentEndpoint);

  const model = config?.model ?? fallbackModel;
  const targetsAzure =
    rawProvider === EModelEndpoint.azureOpenAI ||
    (agentEndpoint === EModelEndpoint.azureOpenAI && config?.provider == null);
  const userParameters = expandSummarizationTransport(config?.parameters, targetsAzure);

  const selfAzureModel =
    agentEndpoint === EModelEndpoint.azureOpenAI &&
    (model === fallbackModel || model === agent?.model);
  const transportOverrides = summarizationTransportOverrides(userParameters);
  const overridesAzureTransport =
    transportOverrides.baseURL != null ||
    transportOverrides.apiKey != null ||
    typeof userParameters?.useResponsesApi === 'boolean';
  const selectsAzureDeployment =
    targetsAzure &&
    isNonEmptyString(model) &&
    config?.enabled !== false &&
    (agentEndpoint !== EModelEndpoint.azureOpenAI ||
      model !== fallbackModel ||
      overridesAzureTransport);
  const azureOverrides = selectsAzureDeployment
    ? resolveAzureSummarization(
        model,
        appConfig,
        userParameters,
        headerContext,
        selfAzureModel ? agent : undefined,
      )
    : undefined;
  const selectsOpenAIForAzureAgent =
    agentEndpoint === EModelEndpoint.azureOpenAI &&
    config?.provider === EModelEndpoint.openAI &&
    config.enabled !== false &&
    isNonEmptyString(model);
  const openAIOverrides = selectsOpenAIForAzureAgent
    ? resolveOpenAISummarization(model, appConfig, userParameters, headerContext)
    : undefined;
  /**
   * A target resolved here is not handed to another client when resolution fails. Azure Responses
   * shares the `openAI` provider, so the SDK would summarize an OpenAI target through the agent's
   * Azure resource, and would send an unmapped Azure model name where a deployment belongs.
   */
  const targetUnavailable =
    (selectsAzureDeployment && azureOverrides == null) ||
    (selectsOpenAIForAzureAgent && openAIOverrides == null);
  const { provider, clientOverrides } =
    openAIOverrides ??
    azureOverrides ??
    (isSameEndpointAsAgent
      ? { provider: fallbackProvider, clientOverrides: undefined }
      : resolveSummarizationProvider(rawProvider, appConfig, headerContext, {
          model,
          parameters: userParameters,
          agentProvider: fallbackProvider,
        }));
  const trigger =
    config?.trigger?.type && typeof config?.trigger?.value === 'number'
      ? { type: config.trigger.type, value: config.trigger.value }
      : undefined;

  /**
   * Custom-endpoint overrides are merged into `parameters` so the SDK's
   * `buildSummarizationClientConfig` spreads them onto the summarization
   * client options. Azure self-summaries with explicit transport overrides also resolve here,
   * using the initialized agent's identity and credentials instead of a new configuration lookup.
   *
   * Order matters: `clientOverrides` supplies endpoint defaults (baseURL,
   * apiKey, headers, transforms), then explicit user `summarization.parameters`
   * are spread on top so settings like `streaming: false` still win over
   * `getOpenAIConfig`'s defaults. `configuration` is deep-merged so a user
   * adding e.g. `configuration.defaultQuery` keeps the resolved `baseURL`
   * and `defaultHeaders` rather than replacing the whole object.
   */
  const mergedParameters =
    clientOverrides != null
      ? mergeParameters(
          clientOverrides,
          userParameters,
          azureOverrides != null || openAIOverrides != null,
        )
      : userParameters;
  /** Placed first so an explicit user `modelKwargs` still replaces the agent's wholesale. */
  const modelKwargs =
    provider === fallbackProvider
      ? summarizationModelKwargs(agentModelKwargs(agent?.model_parameters), fallbackModel, model)
      : undefined;
  /**
   * A scalar `reasoning_effort` — the only reasoning shape the yaml schema
   * accepts — is inert as a client option and leaves the summarizer running at
   * whatever effort the main agent resolved. Translate it the way the main
   * flow's `getOpenAIConfig` would for the summarization target.
   */
  let parameters = resolveReasoningParams({
    provider,
    model,
    parameters: modelKwargs != null ? { modelKwargs, ...mergedParameters } : mergedParameters,
  });

  /** The SDK sets maxTokens for this cap, but LangChain spreads modelKwargs after it. */
  const parameterTokenCap = userParameters?.maxSummaryTokens;
  const summaryTokenCap =
    typeof parameterTokenCap === 'number' && parameterTokenCap > 0
      ? parameterTokenCap
      : config?.maxSummaryTokens;
  const inheritedKwargs =
    provider === fallbackProvider ? agentModelKwargs(agent?.model_parameters) : undefined;
  const effectiveKwargs = isPlainObject(parameters?.modelKwargs)
    ? parameters.modelKwargs
    : inheritedKwargs;
  if (typeof summaryTokenCap === 'number' && effectiveKwargs != null) {
    const {
      max_tokens: _maxTokens,
      max_completion_tokens: _maxCompletionTokens,
      max_output_tokens: _maxOutputTokens,
      ...kwargs
    } = effectiveKwargs;
    parameters = { ...parameters, modelKwargs: kwargs };
  }

  return {
    enabled:
      !targetUnavailable &&
      config?.enabled !== false &&
      isNonEmptyString(provider) &&
      isNonEmptyString(model),
    config: {
      trigger,
      provider,
      model,
      parameters,
      prompt: config?.prompt,
      updatePrompt: config?.updatePrompt,
      reserveRatio: config?.reserveRatio,
      maxSummaryTokens: config?.maxSummaryTokens,
      retainRecent: config?.retainRecent,
    } satisfies AgentSummarizationConfig,
    contextPruning: config?.contextPruning as ContextPruningConfig | undefined,
    reserveRatio: config?.reserveRatio,
  };
}

/**
 * Below this context budget a summarization cycle cannot make progress: the
 * summary allocation rounds down to a handful of tokens, the rewritten history
 * still overflows, and the graph re-triggers summarization on every step until
 * the recursion limit aborts the run. Dozens of wasted LLM calls surfaced to
 * the user as an opaque LangGraph error. Falling back to plain pruning instead
 * either fits the request or fails fast with the actionable `empty_messages`
 * token-budget breakdown. Matches the floor `initializeAgent` applies when the
 * user supplies no override.
 */
const MIN_SUMMARIZATION_CONTEXT_TOKENS = 1024;

/**
 * Applies `reserveRatio` against the pre-ratio base context budget, falling
 * back to the pre-computed `maxContextTokens` from initializeAgent.
 */
function computeEffectiveMaxContextTokens(
  reserveRatio: number | undefined,
  baseContextTokens: number | undefined,
  maxContextTokens: number | undefined,
): number | undefined {
  if (reserveRatio == null || reserveRatio <= 0 || reserveRatio >= 1 || baseContextTokens == null) {
    return maxContextTokens;
  }
  const ratioComputed = Math.max(1024, Math.round(baseContextTokens * (1 - reserveRatio)));
  return Math.min(maxContextTokens ?? ratioComputed, ratioComputed);
}

type CallbackClientOptions = {
  callbacks?: Callbacks;
  fallbacks?: FallbackConfig[];
};

type RunModelCallback = ModelBoundChatModelCallback | ModelErrorTrackerCallback;

/**
 * Installs run-stable callbacks on the model client itself. Subagent child
 * graphs intentionally replace invocation callbacks with their own event
 * forwarders, while intrinsic client callbacks survive root, child, detached,
 * and summarization calls.
 */
function withModelCallbacks<T extends object>(
  options: T,
  modelCallbacks: readonly RunModelCallback[] | undefined,
): T {
  if (!modelCallbacks?.length) {
    return options;
  }

  const callbackOptions = options as T & CallbackClientOptions;
  const existingCallbacks = callbackOptions.callbacks;
  /** The domain callback consumes only the model-bound message prefix of
   *  LangChain's callback arguments; the trailing run metadata is ignored. */
  const modelHandlers = modelCallbacks as unknown as readonly CallbackHandlerMethods[];
  let callbacks: CallbackClientOptions['callbacks'];
  if (existingCallbacks == null || Array.isArray(existingCallbacks)) {
    callbacks = [...(existingCallbacks ?? []), ...modelHandlers];
  } else {
    const manager = existingCallbacks.copy();
    for (const callback of modelHandlers) {
      manager.addHandler(ensureHandler(callback), true);
    }
    callbacks = manager;
  }
  const withCallbacks = {
    ...callbackOptions,
    callbacks,
  } as T & CallbackClientOptions;

  if (Array.isArray(callbackOptions.fallbacks)) {
    withCallbacks.fallbacks = callbackOptions.fallbacks.map((fallback) => ({
      ...fallback,
      clientOptions: withModelCallbacks({ ...(fallback.clientOptions ?? {}) }, modelCallbacks),
    }));
  }

  return withCallbacks;
}

/** Identifier for the self-spawn subagent (reuses parent's AgentInputs in an isolated child graph). */
const SELF_SUBAGENT_TYPE = 'self';

interface SubagentBuildState {
  configCount: number;
  rootAgentIds: string[];
}

function countSubagentConfig(state: SubagentBuildState): void {
  state.configCount += 1;
  if (state.configCount > MAX_SUBAGENT_RUN_CONFIGS) {
    logger.warn('[createRun] Subagent run configuration limit exceeded', {
      expandedConfigCount: state.configCount,
      maxSubagentRunConfigs: MAX_SUBAGENT_RUN_CONFIGS,
      rootAgentIds: state.rootAgentIds,
    });
    throw new Error(
      `Subagent run configuration exceeds the maximum of ${MAX_SUBAGENT_RUN_CONFIGS} expanded entries.`,
    );
  }
}

function assertSubagentDepth(depth: number, agentId: string): void {
  if (depth > MAX_SUBAGENT_DEPTH) {
    logger.warn('[createRun] Subagent graph depth limit exceeded', {
      agentId,
      depth,
      maxSubagentDepth: MAX_SUBAGENT_DEPTH,
    });
    throw new Error(
      `Subagent graph exceeds the maximum depth of ${MAX_SUBAGENT_DEPTH} at agent ${agentId}.`,
    );
  }
}

function createLazySubagentConfig(
  child: LazySubagentAgent,
  toInput: (child: RunAgent, opts?: { isSubagent?: boolean }) => AgentInputs,
  agentsEConfig: Partial<TAgentsEndpoint> | undefined,
  ancestors: Set<string>,
  depth: number,
  prebuiltGraphInputs?: ReadonlyMap<string, AgentInputs>,
  onResolvedAgent?: (agent: RunAgent) => void,
): SubagentConfig {
  return {
    type: child.id,
    name: child.name ?? child.id,
    description:
      child.description ??
      `Delegate a subtask to the ${child.name ?? child.id} agent in an isolated context.`,
    configId: child.configId,
    allowNested: true,
    maxTurns: resolveSubagentMaxTurns(agentsEConfig, child),
    resolveAgentInputs: async (context) => {
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error('Subagent resolution was aborted.');
      }
      const resolvedChild = await child.resolve(context);
      if (context.signal.aborted) {
        throw context.signal.reason ?? new Error('Subagent resolution was aborted.');
      }
      onResolvedAgent?.(resolvedChild);
      const childInputs = buildIsolatedAgentInputs(resolvedChild, toInput);
      const resolutionState: SubagentBuildState = {
        configCount: 1,
        rootAgentIds: [resolvedChild.id],
      };
      const grandchildConfigs = buildSubagentConfigs(
        resolvedChild,
        childInputs,
        toInput,
        resolutionState,
        agentsEConfig,
        ancestors,
        depth,
        prebuiltGraphInputs,
        false,
        onResolvedAgent,
      );
      if (grandchildConfigs.length > 0) {
        childInputs.subagentConfigs = grandchildConfigs;
      }
      return childInputs;
    },
  };
}

function enqueueSubagentChildren(
  agent: SubagentTreeNode,
  pending: Array<SubagentTreeNode | null | undefined>,
  visited: ReadonlySet<string>,
  includeLazyDescriptors = true,
  includeCapabilityMetadata = true,
): void {
  for (const child of agent.subagentAgentConfigs ?? []) {
    if (child != null && !visited.has(child.id)) {
      pending.push(child);
    }
  }
  if (includeLazyDescriptors) {
    for (const child of agent.lazySubagentConfigs ?? []) {
      if (!visited.has(child.id)) {
        pending.push(child);
      }
    }
  }
  if (includeCapabilityMetadata) {
    for (const member of agent.subagentGraphMemberMetadata ?? []) {
      if (!visited.has(member.id)) {
        pending.push(member);
      }
    }
  }
  for (const graph of agent.subagentGraphConfigs ?? []) {
    for (const member of graph.memberConfigs) {
      if (member != null && !visited.has(member.id)) {
        pending.push(member);
      }
    }
  }
}

/**
 * Collect MCP key-spelling aliases from every eagerly known agent in the run.
 * Lazy descriptors are revisited when they resolve, because initializing MCP
 * tools solely to discover aliases would defeat lazy loading.
 */
export function collectRunMCPToolAliases(
  agents: Array<RunAgent | SubagentTreeNode | null | undefined>,
): MCPToolAlias[] {
  const aliases: MCPToolAlias[] = [];
  const seenAliases = new Set<string>();
  const visited = new Set<string>();
  const pending: Array<RunAgent | SubagentTreeNode | null | undefined> = [...agents];

  for (let index = 0; index < pending.length; index++) {
    const agent = pending[index];
    if (agent == null) {
      continue;
    }
    for (const alias of agent.mcpToolAliases ?? []) {
      const key = `${alias.name}\u0000${alias.aliasName}`;
      if (!seenAliases.has(key)) {
        seenAliases.add(key);
        aliases.push(alias);
      }
    }
    if (visited.has(agent.id)) {
      // The same saved agent can appear as both a lazy descriptor and a
      // pre-initialized graph member. Keep traversing each representation so
      // its unique children stay reachable, but avoid descending forever.
      enqueueSubagentChildren(agent, pending, visited);
      continue;
    }
    visited.add(agent.id);
    enqueueSubagentChildren(agent, pending, visited);
  }
  return aliases;
}

/**
 * Recursive any-true check across the agent tree: returns `true` if this
 * agent or any subagent (transitively) has the per-agent codeenv gate
 * enabled.
 *
 * The SDK's tool-output reference registry is shared across every
 * `ToolNode` compiled from the run's graph (parent + every subagent
 * alike), so a single subagent with `bash_tool` registered is enough to
 * make `RunConfig.toolOutputReferences` worth activating for the whole
 * run — without it, the subagent's `{{tool<idx>turn<turn>}}`
 * placeholders would pass through to the shell unsubstituted.
 *
 * Cycle-safe via a `visited` set. The bash tool description itself is
 * still gated per-agent in `initializeAgent`, so only agents that actually
 * have bash registered learn the `{{…}}` syntax — broadening the run-level
 * registry gate doesn't broaden the model-facing surface.
 */
function anyAgentHasCodeEnv(agents: RunAgent[]): boolean {
  const visited = new Set<string>();
  const pending: SubagentTreeNode[] = [...agents];

  for (let index = 0; index < pending.length; index++) {
    const agent = pending[index];
    if (visited.has(agent.id)) {
      continue;
    }
    visited.add(agent.id);
    if (agent.codeEnvAvailable === true) {
      return true;
    }
    enqueueSubagentChildren(agent, pending, visited);
  }
  return false;
}

/**
 * Whether a single agent's tool surface includes the `ask_user_question` tool, in any
 * of the three places a tool can live on a `RunAgent`: loaded instances (`tools`), the
 * schema-only registry (`toolRegistry`), or serialized definitions (`toolDefinitions`).
 * Checked against TOP-LEVEL agents only (not subagents — the tool is stripped from
 * child configs in `buildAgentInput`, since a child graph executing outside the parent
 * run's stream cannot pause the parent).
 *
 * Exported for AgentClient's pre-turn orphan-checkpoint prune gate: the prune must
 * fire whenever THIS turn may attach a checkpointer, which since the ask tool is no
 * longer coupled to `toolApproval.enabled` includes ask-capable runs.
 */
export function agentRequestsAskUserQuestion(agent: {
  tools?: unknown[];
  toolRegistry?: Map<string, unknown>;
  toolDefinitions?: Array<{ name: string }>;
}): boolean {
  return (
    agent.tools?.some(
      (tool) => (tool as { name?: string } | undefined)?.name === ASK_USER_QUESTION_TOOL_NAME,
    ) === true ||
    agent.toolRegistry?.has(ASK_USER_QUESTION_TOOL_NAME) === true ||
    agent.toolDefinitions?.some((def) => def.name === ASK_USER_QUESTION_TOOL_NAME) === true
  );
}

/**
 * Whether the admin tool filter (`includedTools` allowlist, else `filteredTools`
 * exclude list — same precedence as `loadAndFormatTools`) disables
 * `ask_user_question`. Enforced at RUN BUILD, not just in the tools-dialog listing:
 * agents saved before an admin filtered the tool out would otherwise keep exposing
 * it to the model, attaching checkpointers, and pausing runs — for a run-pausing
 * tool the filter must be an actual kill switch.
 */
export function isAskUserQuestionAdminDisabled(appConfig?: AppConfig): boolean {
  const included = appConfig?.includedTools;
  if (included != null && included.length > 0) {
    return !included.includes(ASK_USER_QUESTION_TOOL_NAME);
  }
  return appConfig?.filteredTools?.includes(ASK_USER_QUESTION_TOOL_NAME) === true;
}

/**
 * Whether any agent reachable in the run — primary, handoff/parallel, or a
 * nested subagent — opts into cross-turn `reasoning_content` reconstruction.
 * Walks `subagentAgentConfigs` like {@link anyAgentHasCodeEnv}, since an
 * opted-in custom endpoint may appear only as a (possibly pruned) subagent.
 */
export function anyAgentReplaysReasoningContent(
  agents: Array<RunAgent | null | undefined>,
): boolean {
  const visited = new Set<string>();
  const pending: Array<SubagentTreeNode | null | undefined> = [...agents];

  for (let index = 0; index < pending.length; index++) {
    const agent = pending[index];
    if (agent == null || visited.has(agent.id)) {
      continue;
    }
    visited.add(agent.id);
    if (shouldReplayReasoningContent(agent)) {
      return true;
    }
    enqueueSubagentChildren(agent, pending, visited);
  }
  return false;
}

/**
 * Builds SubagentConfig entries for an agent: optional self-spawn plus any
 * explicit eager children and inert lazy descriptors. Returns an empty array
 * when subagents are disabled or no spawn targets are available.
 */
function buildIsolatedAgentInputs(
  child: RunAgent,
  toInput: (agent: RunAgent, opts?: { isSubagent?: boolean }) => AgentInputs,
): AgentInputs {
  const childInputs = toInput(child, { isSubagent: true });
  const alwaysApplySkillPrimes = child.alwaysApplySkillPrimes;
  if (alwaysApplySkillPrimes && alwaysApplySkillPrimes.length > 0) {
    const skillInstructions = alwaysApplySkillPrimes
      .map((prime) => `# Always-apply skill: ${prime.name}\n${prime.body}`)
      .join('\n\n');
    childInputs.additional_instructions = [childInputs.additional_instructions, skillInstructions]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n\n');
  }
  if ((child.backgroundToolNames?.length ?? 0) > 0) {
    childInputs.toolDefinitions = stripBackgroundFromToolDefinitions(
      childInputs.toolDefinitions,
      child.backgroundToolNames,
    );
    childInputs.toolRegistry = stripBackgroundFromToolRegistry(
      childInputs.toolRegistry,
      child.backgroundToolNames,
    );
  }
  if ((child.intentToolNames?.length ?? 0) > 0) {
    childInputs.toolDefinitions = stripIntentFromToolDefinitions(
      childInputs.toolDefinitions,
      child.intentToolNames,
    );
    childInputs.toolRegistry = stripIntentFromToolRegistry(
      childInputs.toolRegistry,
      child.intentToolNames,
    );
  }
  return childInputs;
}

function buildSubagentConfigs(
  agent: RunAgent,
  agentInput: AgentInputs,
  toInput: (child: RunAgent, opts?: { isSubagent?: boolean }) => AgentInputs,
  state: SubagentBuildState,
  agentsEConfig: Partial<TAgentsEndpoint> | undefined,
  ancestors: Set<string> = new Set(),
  depth = 0,
  prebuiltGraphInputs?: ReadonlyMap<string, AgentInputs>,
  detachedTasksEnabled = false,
  onResolvedAgent?: (agent: RunAgent) => void,
): SubagentConfigEntry[] {
  if (!agent.subagents?.enabled) {
    return [];
  }

  const configs: SubagentConfigEntry[] = [];
  const allowSelf = agent.subagents.allowSelf !== false;

  if (allowSelf) {
    const selfName = agentInput.name ?? agent.name ?? 'self';
    countSubagentConfig(state);
    /**
     * Self-spawn reuses the parent's AgentInputs. When the parent has
     * background or host-injected intent tools, provide a sanitized copy so
     * the isolated child — which runs the direct/child-graph path rather
     * than the host interceptors — doesn't advertise `run_in_background` /
     * `check_background_task` or an injected `intent` param its direct tool
     * invocations would forward to tools that never declared it. The
     * resolver keeps a provided `agentInputs` even with `self: true`.
     */
    const hasBackground = detachedTasksEnabled || (agent.backgroundToolNames?.length ?? 0) > 0;
    const hasInjectedIntent = (agent.intentToolNames?.length ?? 0) > 0;
    const sanitizedToolRegistry = stripIntentFromToolRegistry(
      stripBackgroundFromToolRegistry(agentInput.toolRegistry, agent.backgroundToolNames),
      agent.intentToolNames,
    );
    configs.push({
      self: true,
      type: SELF_SUBAGENT_TYPE,
      name: selfName,
      description: `Spawn ${selfName} in an isolated context to handle a focused subtask. Verbose tool output stays in the child's context; only a summary returns.`,
      /** Self-spawn reuses the parent's config, so mirror the parent's recursion limit. */
      maxTurns: resolveSubagentMaxTurns(agentsEConfig, agent),
      ...(hasBackground || hasInjectedIntent
        ? {
            agentInputs: {
              ...agentInput,
              toolDefinitions: stripIntentFromToolDefinitions(
                stripBackgroundFromToolDefinitions(
                  agentInput.toolDefinitions,
                  agent.backgroundToolNames,
                ),
                agent.intentToolNames,
              ),
              /** `registerBackgroundTaskTool` mutates the parent registry after
               * configs are built. Detach its self-child snapshot so the host
               * poll tool cannot appear there through that shared Map. */
              toolRegistry:
                detachedTasksEnabled && sanitizedToolRegistry != null
                  ? new Map(sanitizedToolRegistry)
                  : sanitizedToolRegistry,
            },
          }
        : {}),
    });
  }

  /** Cycle-safety: include the current agent in `ancestors` before
   *  descending into children so a `A → B → A` configuration stops at
   *  the second encounter of A rather than recursing forever. Skip
   *  `A → A` too (already guarded) and anything that would re-enter
   *  an ancestor. */
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(agent.id);

  for (const child of agent.subagentAgentConfigs ?? []) {
    if (!child?.id || child.id === agent.id) {
      continue;
    }
    if (ancestors.has(child.id)) {
      continue;
    }
    const childDepth = depth + 1;
    assertSubagentDepth(childDepth, child.id);
    countSubagentConfig(state);
    const childInputs = buildIsolatedAgentInputs(child, toInput);
    /**
     * Recursively resolve the child's own spawn targets so multi-level
     * delegation (A → B → C) works. Without this, a child whose own
     * `subagents.enabled` is true loses every explicit target when
     * invoked as a subagent — only the top-level loop attaches
     * `subagentConfigs`, and that only runs for the outer agents in
     * `agents[]`. Cycle-safe via `nextAncestors`.
     */
    const grandchildConfigs = buildSubagentConfigs(
      child,
      childInputs,
      toInput,
      state,
      agentsEConfig,
      nextAncestors,
      childDepth,
      prebuiltGraphInputs,
      detachedTasksEnabled,
      onResolvedAgent,
    );
    if (grandchildConfigs.length > 0) {
      childInputs.subagentConfigs = grandchildConfigs;
    }
    configs.push({
      type: child.id,
      name: child.name ?? child.id,
      description:
        child.description ??
        `Delegate a subtask to the ${child.name ?? child.id} agent in an isolated context.`,
      agentInputs: childInputs,
      /** Preserve the child's resolved subagent configs when the SDK builds its isolated graph. */
      allowNested: true,
      /** Honor each child agent's own resolved recursion limit. */
      maxTurns: resolveSubagentMaxTurns(agentsEConfig, child),
    });
  }

  for (const child of agent.lazySubagentConfigs ?? []) {
    if (!child.id || child.id === agent.id || ancestors.has(child.id)) {
      continue;
    }
    const childDepth = depth + 1;
    assertSubagentDepth(childDepth, child.id);
    countSubagentConfig(state);
    configs.push(
      createLazySubagentConfig(
        child,
        toInput,
        agentsEConfig,
        nextAncestors,
        childDepth,
        prebuiltGraphInputs,
        onResolvedAgent,
      ),
    );
  }

  for (const { definition, memberConfigs } of agent.subagentGraphConfigs ?? []) {
    if (memberConfigs.length === 0) {
      continue;
    }
    countSubagentConfig(state);
    const maxTurns = Math.min(
      ...memberConfigs.map((member) => resolveSubagentMaxTurns(agentsEConfig, member)),
    );
    configs.push({
      kind: 'graph',
      type: definition.type,
      name: definition.name,
      description: definition.description,
      agents: memberConfigs.map(
        (member) =>
          prebuiltGraphInputs?.get(member.id) ?? buildIsolatedAgentInputs(member, toInput),
      ),
      /**
       * The persisted API accepts `excludeResults: false` as the explicit
       * form of the default. The SDK reserves this field for prompted edges
       * and rejects any defined value when no prompt exists, so erase the
       * no-op false value at the host boundary.
       */
      edges: definition.edges.map((edge) => {
        if (edge.excludeResults !== false) {
          return edge;
        }
        const { excludeResults: _excludeResults, ...normalizedEdge } = edge;
        return normalizedEdge;
      }),
      entryAgentId: definition.entry_agent_id,
      resultAgentId: definition.result_agent_id,
      maxTurns,
    });
  }

  return configs;
}

/**
 * Creates a new Run instance with custom handlers and configuration.
 *
 * @param options - The options for creating the Run instance.
 * @param options.agents - The agents for this run.
 * @param options.signal - The signal for this run.
 * @param options.runId - Optional run ID; otherwise, a new run ID will be generated.
 * @param options.customHandlers - Custom event handlers.
 * @param options.streaming - Whether to use streaming.
 * @param options.streamUsage - Whether to stream usage information.
 * @param options.messages - Optional message history to extract discovered tools from.
 *   When provided, tools that were previously discovered via tool_search will have
 *   their defer_loading overridden to false, preventing redundant re-discovery.
 * @returns {Promise<Run<IState>>} A promise that resolves to a new Run instance.
 */
/** The caller's trace context over run-derived defaults for the fields it left unset. */
function resolveRunTraceContext({
  agents,
  conversationId,
  requestBody,
  traceContext,
}: {
  agents: RunAgent[];
  conversationId?: string;
  requestBody?: t.RequestBody;
  traceContext?: LangfuseTraceContext;
}): LangfuseTraceContext {
  const primaryAgent = agents[0];
  return {
    ...traceContext,
    conversationId: traceContext?.conversationId ?? conversationId ?? requestBody?.conversationId,
    provider: traceContext?.provider ?? primaryAgent?.provider,
    model: traceContext?.model ?? primaryAgent?.model_parameters?.model ?? primaryAgent?.model,
  };
}

export async function createRun({
  runId,
  signal,
  conversationId,
  agents,
  messages,
  discoveredToolNames,
  requestBody,
  codeApprovalMode: requestedCodeApprovalMode,
  user,
  tenantId,
  centralTraceExportEnabled,
  traceContext,
  tokenCounter,
  customHandlers,
  indexTokenCountMap,
  initialSessions,
  summarizationConfig,
  summarizeOnly = false,
  compactionSemanticIndex,
  initialSummary,
  modelCallbacks,
  clientToolNames,
  calibrationRatio,
  fadingTier,
  fadingTiers,
  appConfig,
  subagentUsageSink,
  subagentTasks,
  runFiles,
  steering,
  activityLabel,
  activityPhase,
  eventActorCheckpointing = false,
  hitlCapable = false,
  resolvedToolApprovalHooks,
  toolInputValidationErrors,
  sessionStartSource,
  streaming = true,
  streamUsage = true,
}: {
  agents: RunAgent[];
  signal: AbortSignal;
  runId?: string;
  /** Conversation-stable identity, used by the e2e run hook to tell a resumed
   *  run apart from a fresh attempt (a resume carries no messages). */
  conversationId?: string;
  streaming?: boolean;
  streamUsage?: boolean;
  requestBody?: t.RequestBody;
  codeApprovalMode?: CodeApprovalMode;
  user?: IUser;
  tenantId?: string;
  /**
   * Defaults to true. Set false to suppress central Langfuse export for this
   * run. Tenant fanout can still export when tenant routing is available.
   */
  centralTraceExportEnabled?: boolean;
  /**
   * Request values the deployment may export as Langfuse trace metadata
   * (`langfuse.trace.conversationMetadataFields`). The conversation id,
   * provider, and model default from the run itself.
   */
  traceContext?: LangfuseTraceContext;
  /** Message history for extracting previously discovered tools */
  messages?: BaseMessage[];
  /**
   * Pre-discovered deferred-tool names to force-load directly, bypassing message
   * extraction. The HITL resume path rebuilds the graph with `messages: []` (state
   * comes from the durable checkpoint), so the in-turn `tool_search` results that
   * would normally mark a deferred tool discovered aren't present — without this the
   * paused tool's schema would be absent from the rebuilt model binding. Captured at
   * pause from canonical run state (with message parsing for older SDK releases) and
   * replayed here. Merged with (not replacing) names extracted from `messages`.
   */
  discoveredToolNames?: string[];
  summarizationConfig?: SummarizationConfig;
  /**
   * Manual compaction: the primary agent summarizes the history outright and
   * the run ends after the summary without a model call. Applies to the
   * primary agent only; a chained or delegated agent never runs.
   */
  summarizeOnly?: boolean;
  /** Bounded, source-addressed navigation guidance derived with provider messages. */
  compactionSemanticIndex?: CompactionSemanticIndex;
  /** Cross-run summary from formatAgentMessages, forwarded to AgentContext */
  initialSummary?: { text: string; tokenCount: number };
  /** Model callbacks inherited by root, summary, fallback, and subagent clients. */
  modelCallbacks?: readonly RunModelCallback[];
  /** Caller-executed tools must never run eagerly before handoff is decided. */
  clientToolNames?: ReadonlySet<string>;
  /** Calibration ratio from previous run's contextMeta, seeds the pruner EMA */
  calibrationRatio?: number;
  /**
   * Default agent's latched context-fading tier from the previous run's
   * contextMeta. It seeds the pruner so the provider-only projection of
   * historical tool results keeps the same bytes across runs; graph messages
   * stay canonical. Legacy v1 tiers are not passed to the v2 SDK; it derives
   * them afresh using the current-turn exchange width.
   */
  fadingTier?: (IAgentFadingTier & { v: 2 }) | null;
  /**
   * Latched tiers keyed by agent ID from the previous run's contextMeta, so
   * every agent of a multi-agent run restores its own tier. Same SDK
   * availability as `fadingTier`.
   */
  fadingTiers?: RunFadingTiers | null;
  /**
   * Resolved app config. Used to translate custom-endpoint provider names
   * (e.g. "Ollama") in the summarization config to SDK-recognized providers.
   */
  appConfig?: AppConfig;
  /**
   * Receives per-model-call usage from subagent child runs so hosts can bill
   * them (child graphs execute outside the run's `streamEvents` loop, so
   * their usage never reaches `customHandlers`). Typed structurally — not as
   * `Pick<RunConfig, 'subagentUsageSink'>` — because the field ships in
   * `@librechat/agents` > 3.2.33; older SDK versions ignore it at runtime.
   * Switch to the `RunConfig` pick once the dependency is bumped.
   */
  subagentUsageSink?: (event: SubagentUsageEvent) => void;
  /** Host-owned detached-subagent task store and trusted parent-thread scope. */
  subagentTasks?: SubagentTaskConfig;
  /** Run-scoped file authorization and child context, supplied by the host. */
  runFiles?: RunFileSession;
  /**
   * The run-scoped steer-drain hook (a `PostToolBatch` callback built via
   * `createSteerDrainHook`). Registered on the run's hook registry independent
   * of the tool-approval policy — steering needs neither HITL nor a
   * checkpointer (injection merges via the messages reducer inside the tool
   * node). Only the resumable agents controller passes this; the
   * OpenAI-compatible and Responses controllers have no job/SSE surface.
   */
  steering?: {
    hook: HookCallback<'PostToolBatch'>;
    /**
     * The PreemptBoundary twin of `hook`, built via
     * `createSteerPreemptBoundaryHook` from the same drain closures. Fires
     * when the SDK seals a model stream mid-generation on a preempt request.
     */
    preemptHook?: HookCallback<'PreemptBoundary'>;
    /**
     * Atomically claims queued steers at the SDK's terminal Stop boundary or
     * seals admission so later messages become ordinary follow-up turns.
     */
    terminalHook?: TerminalSteerHook;
    /**
     * Level-triggered O(1) poll over the job's armed preempt requests
     * (`createSteerPreemptPoll`). Threaded into `RunConfig.preemption`, which
     * also makes the SDK reserve recursion-limit headroom for its seals.
     */
    preemption?: StreamPreemption;
  };
  /**
   * Run-scoped tool-batch summary hook (PostToolBatch). Like steering, it
   * registers independently of the approval policy and needs no checkpointer;
   * the hook returns immediately and generates off the critical path.
   */
  activityLabel?: { hook: HookCallback<'PostToolBatch'> };
  /** Run-wide parent phase collector; registered after child batch labels. */
  activityPhase?: { hook: HookCallback<'PostToolBatch'> };
  /** Persist clean terminal checkpoints for an isolated bound-event invocation. */
  eventActorCheckpointing?: boolean;
  /**
   * Whether the caller implements the HITL pause/resume lifecycle (inspects
   * `run.getInterrupt()`, persists a pending action, exposes a resume route). Gates the
   * tool-approval wiring: only AgentClient (chat + resume) sets this. The OpenAI-compatible
   * and Responses controllers leave it false, so an approval-gated tool can't pause on a
   * route that has no approval surface or resume endpoint (it would otherwise emit a normal
   * final response / `[DONE]` with the tool call left unresolved).
   */
  hitlCapable?: boolean;
  /**
   * Request-scoped approval hooks already resolved by the scheduled-run admission guard.
   * Reuse them here so a context-aware factory is evaluated exactly once for the run.
   */
  resolvedToolApprovalHooks?: readonly ResolvedToolApprovalHook[];
  /** Plugin-hook SessionStart lifecycle source: 'startup' (default) or 'resume' on HITL-rebuild paths. */
  sessionStartSource?: string;
  /** Request-scoped tool input failures consumed by the completion handler. */
  toolInputValidationErrors?: Map<string, ToolInputValidationError>;
} & Pick<
  RunConfig,
  'tokenCounter' | 'customHandlers' | 'indexTokenCountMap' | 'initialSessions'
>): Promise<Run<IState>> {
  const resolvedRunId = runId ?? randomUUID();
  const runFilesActive =
    runFiles?.activate(
      resolvedRunId,
      conversationId ?? requestBody?.conversationId ?? '',
      agents.map((agent) => agent.id),
      signal,
    ) === true;
  if (
    appConfig?.endpoints?.agents?.fileSharing?.enabled === true &&
    agents[0]?.subagents?.enabled === true &&
    agents[0]?.subagents?.shareFiles === true &&
    !runFilesActive
  ) {
    throw new Error('Run file sharing is not supported by this endpoint: a file host is required.');
  }
  if (runFilesActive && !isRunFileSharingSupported()) {
    throw new Error('Run file sharing requires an agents SDK with subagent context support.');
  }
  // Detached child threads resume in a new host request without this run's
  // input snapshot or publication routing. Shared children stay foreground.
  const activeSubagentTasks = runFilesActive ? undefined : subagentTasks;
  /**
   * Only extract discovered tools if:
   * 1. We have message history to parse
   * 2. At least one agent has deferred tools (using precomputed flag)
   *
   * This optimization avoids iterating through messages in the ~95% of cases
   * where no agent uses deferred tool loading.
   */
  const hasAnyDeferredTools = agents.some((agent) => agent.hasDeferredTools === true);

  const discoveredTools = new Set<string>();
  if (hasAnyDeferredTools) {
    // Normal path: extract from this run's message history (tool_search results).
    if (messages?.length) {
      for (const name of extractDiscoveredToolsFromHistory(messages)) {
        discoveredTools.add(name);
      }
    }
    // Resume path: replay names captured at pause, since `messages` is empty (the
    // paused run's tool_search results live only in the checkpoint, not here).
    if (discoveredToolNames?.length) {
      for (const name of discoveredToolNames) {
        discoveredTools.add(name);
      }
    }
  }

  /** Admin kill switch for the ask tool — see {@link isAskUserQuestionAdminDisabled}. */
  const askToolAdminDisabled = isAskUserQuestionAdminDisabled(appConfig);

  const buildAgentInput = (agent: RunAgent, opts: { isSubagent?: boolean } = {}): AgentInputs => {
    const isSubagent = opts.isSubagent === true;
    if (runFilesActive) {
      for (const { memberConfigs } of agent.subagentGraphConfigs ?? []) {
        const deliveryTargets = new Set(
          memberConfigs.map((member) =>
            JSON.stringify([
              member.provider,
              member.endpoint ?? member.provider,
              member.model_parameters?.model ?? member.model,
              resolveUseResponsesApi(member.model_parameters?.useResponsesApi) === true,
              // Unset detail inherits the request value, which may differ from explicit auto.
              member.imageDetail ?? null,
            ]),
          ),
        );
        if (deliveryTargets.size > 1) {
          throw new Error(
            'Shared-file subagent teams must use the same provider, endpoint, model, API mode, and image-detail setting for every member.',
          );
        }
      }
    }
    const provider =
      (providerEndpointMap[
        agent.provider as keyof typeof providerEndpointMap
      ] as unknown as Providers) ?? agent.provider;
    const selfModel = agent.model_parameters?.model ?? (agent.model as string | undefined);

    /**
     * Resolve request-based headers across provider-specific header locations
     * (OpenAI `configuration.defaultHeaders`, Anthropic `clientOptions.defaultHeaders`,
     * Google `customHeaders`). Done at this step because the request body may
     * contain dynamic values (e.g. conversationId) that are only known after
     * agent initialization. Resolve before a self-summary snapshots this configuration.
     */
    resolveConfigHeaders({
      llmConfig: agent.model_parameters as Partial<t.RunLLMConfig>,
      user: createSafeUser(user),
      tenantId,
      body: requestBody,
    });

    const modelParameters = normalizeAgentModelParameters(agent.model_parameters);
    const shapedSummarization = shapeSummarizationConfig(
      agent.summarization ?? summarizationConfig,
      provider as string,
      selfModel,
      appConfig,
      agent.endpoint ?? undefined,
      { user, tenantId, requestBody },
      agent,
    );
    const summarization = modelCallbacks?.length
      ? {
          ...shapedSummarization,
          config: {
            ...shapedSummarization.config,
            parameters: withModelCallbacks(
              { ...(shapedSummarization.config.parameters ?? {}) },
              modelCallbacks,
            ),
          },
        }
      : shapedSummarization;

    const hasExplicitStreamUsage = Object.prototype.hasOwnProperty.call(
      modelParameters ?? {},
      'streamUsage',
    );
    const llmConfig = withModelCallbacks(
      Object.assign(
        {
          provider,
          streaming,
          streamUsage,
        },
        modelParameters,
      ) as t.RunLLMConfig,
      modelCallbacks,
    );

    const joinInstructionMap = (map?: Record<string, unknown>) =>
      Object.values(map ?? {})
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .join('\n')
        .trim();

    const toolInstructions = joinInstructionMap(agent.toolContextMap);
    const dynamicToolInstructions = joinInstructionMap(agent.dynamicToolContextMap);

    const systemContent = [toolInstructions, agent.instructions ?? ''].join('\n').trim();

    const additionalInstructions = [dynamicToolInstructions, agent.additional_instructions ?? '']
      .join('\n')
      .trim();

    /** Resolves issues with new OpenAI usage field */
    if (
      customProviders.has(agent.provider) ||
      (agent.provider === Providers.OPENAI && agent.endpoint !== agent.provider)
    ) {
      if (!hasExplicitStreamUsage) {
        llmConfig.streamUsage = false;
      }
      llmConfig.usage = true;
    }

    /**
     * Override defer_loading for tools that were discovered in previous
     * turns. This prevents the LLM from having to re-discover tools via
     * tool_search. Also add the discovered tools' definitions so the
     * LLM has their schemas.
     *
     * Skipped for subagent children (`isSubagent`) — they run in an
     * isolated context by contract, so inheriting the parent's
     * tool-search state leaks unrelated history and pre-loads tools the
     * child shouldn't care about. Mutations on `agent.toolRegistry`
     * and additions to `toolDefinitions` both happen here, so the flag
     * has to gate the whole block (clearing fields post-return can't
     * undo registry writes).
     */
    let toolDefinitions = agent.toolDefinitions ?? [];
    let toolRegistry = agent.toolRegistry;
    if (!isSubagent && discoveredTools.size > 0 && agent.toolRegistry) {
      overrideDeferLoadingForDiscoveredTools(agent.toolRegistry, discoveredTools);

      /** Add discovered tools' definitions so the LLM can see their schemas */
      const existingToolNames = new Set(toolDefinitions.map((d) => d.name));
      for (const toolName of discoveredTools) {
        if (existingToolNames.has(toolName)) {
          continue;
        }
        const toolDef = agent.toolRegistry.get(toolName);
        if (toolDef) {
          toolDefinitions = [...toolDefinitions, toolDef];
        }
      }
    } else if (isSubagent && agent.toolRegistry) {
      /**
       * Subagent children: hand the child a deep-enough clone of the
       * registry so later parent-graph builds (e.g. when the same
       * agent also appears as a handoff target in the outer loop)
       * can't mutate `defer_loading` on tool definitions the child
       * already holds a reference to. Clone the `Map` *and* each
       * `LCTool` — `overrideDeferLoadingForDiscoveredTools` writes
       * through to the tool object itself, so a shallow Map copy
       * alone wouldn't isolate the flag.
       */
      toolRegistry = new Map();
      for (const [name, tool] of agent.toolRegistry.entries()) {
        toolRegistry.set(name, { ...tool });
      }
      /** Child's own `toolDefinitions` list gets the same shallow-
       *  copied view so any later parent mutation of shared definitions
       *  is contained to the parent-graph path. */
      toolDefinitions = toolDefinitions.map((def) => ({ ...def }));
    }

    /**
     * `ask_user_question` pauses via a LangGraph `interrupt()` raised from its own
     * tool body, so it must execute IN-PROCESS inside the graph's ToolNode — the
     * event-dispatched path runs tool bodies in the host handler outside the Pregel
     * task frame, where `interrupt()` throws and becomes an error ToolMessage. The
     * tool therefore never rides the schema-only `toolDefinitions`/`toolRegistry`
     * surfaces: on every path it is REMOVED from them (clone-before-mutate,
     * matching the registry-clone discipline above), and on the one path where it
     * can actually work — an HITL-capable caller's top-level agent, with the admin
     * filter allowing it — a real instance is supplied via `graphTools`, the SDK's
     * in-graph direct-tool seam (bound to the model, executed inside the task
     * frame; requires `@librechat/agents` > 3.2.57, older versions ignore the
     * field). Everywhere else (OpenAI-compatible + Responses controllers with no
     * resume surface, subagent child graphs that compile without a checkpointer,
     * admin-disabled) it is stripped fail-closed with no replacement.
     */
    let tools = agent.tools;
    let graphTools: GenericTool[] | undefined;
    if (agentRequestsAskUserQuestion(agent)) {
      tools = tools?.filter(
        (tool) => (tool as { name?: string } | undefined)?.name !== ASK_USER_QUESTION_TOOL_NAME,
      );
      toolDefinitions = toolDefinitions.filter((def) => def.name !== ASK_USER_QUESTION_TOOL_NAME);
      if (toolRegistry?.has(ASK_USER_QUESTION_TOOL_NAME)) {
        toolRegistry = new Map(toolRegistry);
        toolRegistry.delete(ASK_USER_QUESTION_TOOL_NAME);
      }
      if (hitlCapable && !isSubagent && !askToolAdminDisabled) {
        graphTools = [
          createAskUserQuestionTool(toolInputValidationErrors) as unknown as GenericTool,
        ];
      }
    }

    if (runFilesActive) {
      tools = eventOnlyRunFileTools(tools, toolDefinitions);
    }

    const effectiveMaxContextTokens = computeEffectiveMaxContextTokens(
      summarization.reserveRatio,
      agent.baseContextTokens,
      agent.maxContextTokens,
    );

    const summarizationViable =
      effectiveMaxContextTokens == null ||
      effectiveMaxContextTokens >= MIN_SUMMARIZATION_CONTEXT_TOKENS;
    if (summarization.enabled && !summarizationViable) {
      logger.warn(
        '[createRun] Summarization disabled for this run: context budget below viable minimum',
        {
          agentId: agent.id,
          effectiveMaxContextTokens,
          minimum: MIN_SUMMARIZATION_CONTEXT_TOKENS,
        },
      );
    }

    const reasoningKey = getReasoningKey(provider, llmConfig, agent.endpoint, agent.reasoningKey);
    const agentInput: AgentInputs = {
      provider,
      endpoint: agent.endpoint ?? provider,
      reasoningKey,
      toolDefinitions,
      agentId: agent.id,
      tools,
      clientOptions: llmConfig,
      instructions: systemContent,
      additional_instructions: additionalInstructions || undefined,
      name: agent.name ?? undefined,
      toolRegistry,
      maxContextTokens: effectiveMaxContextTokens,
      useLegacyContent: agent.useLegacyContent ?? false,
      discoveredTools:
        !isSubagent && discoveredTools.size > 0 ? Array.from(discoveredTools) : undefined,
      summarizationEnabled: summarization.enabled && summarizationViable,
      summarizationConfig: summarization.config,
      ...(!isSubagent && compactionSemanticIndex != null ? { compactionSemanticIndex } : {}),
      initialSummary: isSubagent ? undefined : initialSummary,
      contextPruningConfig: summarization.contextPruning,
      maxToolResultChars: agent.maxToolResultChars,
      initialSessions: buildAgentInitialToolSessions(agent, initialSessions),
      codeSessionKey: agent.codeSessionKey,
    };
    if (runFilesActive && runFiles != null && (isSubagent || agent.subagents?.enabled === true)) {
      graphTools = [...(graphTools ?? []), ...createRunFileTools(runFiles, agent.id, signal)];
    }
    if (graphTools) {
      /**
       * Typed structurally — not as `AgentInputs['graphTools']` — because the
       * field ships in `@librechat/agents` > 3.2.57 (agents#289); older SDK
       * versions ignore it at runtime (the tool is then simply absent, never
       * broken). Inline the field in the literal once the dependency is bumped.
       */
      (agentInput as AgentInputs & { graphTools?: GenericTool[] }).graphTools = graphTools;
    }
    return agentInput;
  };

  const agentsEndpointConfig = appConfig?.endpoints?.[EModelEndpoint.agents];
  const attachedCodeEnvironmentAgentIds = collectAttachedCodeEnvironmentAgentIds(agents);
  const attachedCodeEnvironmentSettings = collectAttachedCodeEnvironmentPolicySettings(agents);
  const codeApprovalMode = resolveAttachedCodeApprovalMode(
    requestedCodeApprovalMode,
    attachedCodeEnvironmentSettings,
    agentsEndpointConfig?.toolApproval?.enabled !== false,
  );
  assertAttachedCodeEnvironmentApprovalSupported({
    hasAttachedCodeEnvironment: attachedCodeEnvironmentAgentIds.size > 0,
    hitlCapable,
    approvalExplicitlyDisabled: agentsEndpointConfig?.toolApproval?.enabled === false,
  });

  // Assigned after the run-wide HITL registry is built. Lazy descriptors
  // capture this indirection now and report their aliases when they resolve.
  let registerResolvedMCPToolAliases: (agent: RunAgent) => void = () => undefined;
  const agentInputs: AgentInputs[] = [];
  const subagentBuildState: SubagentBuildState = {
    configCount: 0,
    rootAgentIds: agents.map((agent) => agent.id),
  };
  const prebuiltGraphInputs = new Map<string, AgentInputs>();
  const visitedConfigIds = new Set<string>();
  const pendingConfigs: Array<RunAgent | null | undefined> = [...agents];
  for (let index = 0; index < pendingConfigs.length; index++) {
    const config = pendingConfigs[index];
    if (!config?.id || visitedConfigIds.has(config.id)) {
      continue;
    }
    visitedConfigIds.add(config.id);
    if (!prebuiltGraphInputs.has(config.id)) {
      prebuiltGraphInputs.set(config.id, buildIsolatedAgentInputs(config, buildAgentInput));
    }
    for (const graph of config.subagentGraphConfigs ?? []) {
      for (const member of graph.memberConfigs) {
        if (!prebuiltGraphInputs.has(member.id)) {
          prebuiltGraphInputs.set(member.id, buildIsolatedAgentInputs(member, buildAgentInput));
        }
      }
    }
    enqueueSubagentChildren(config, pendingConfigs, visitedConfigIds, false, false);
  }
  for (const agent of agents) {
    const agentInput = buildAgentInput(agent);
    if (summarizeOnly && agent === agents[0]) {
      agentInput.summarizeOnly = true;
    }
    const subagentConfigs = buildSubagentConfigs(
      agent,
      agentInput,
      buildAgentInput,
      subagentBuildState,
      agentsEndpointConfig,
      undefined,
      0,
      prebuiltGraphInputs,
      activeSubagentTasks != null,
      (resolvedAgent) => registerResolvedMCPToolAliases(resolvedAgent),
    );
    if (subagentConfigs.length > 0) {
      agentInput.subagentConfigs = subagentConfigs;
      /** Seed the SDK countdown that bounds nested delegation across isolated child graphs. */
      agentInput.maxSubagentDepth = MAX_SUBAGENT_DEPTH;
    }
    if (activeSubagentTasks != null) {
      agentInput.toolDefinitions = registerBackgroundTaskTool({
        toolRegistry: agentInput.toolRegistry,
        toolDefinitions: agentInput.toolDefinitions,
        subagentCompletionWakeups: agentUsesSubagentCompletionWakeups(
          activeSubagentTasks,
          agent.id,
        ),
      }).toolDefinitions;
    }
    agentInputs.push(agentInput);
  }

  const graphConfig: RunConfig['graphConfig'] = {
    signal,
    agents: agentInputs,
    edges: agents[0].edges ?? [],
  };

  if (agentInputs.length > 1 || ((graphConfig as MultiAgentGraphConfig).edges?.length ?? 0) > 0) {
    (graphConfig as unknown as MultiAgentGraphConfig).type = 'multi-agent';
  } else {
    (graphConfig as StandardGraphConfig).type = 'standard';
  }

  /**
   * Enable tool-output references when the bash tool is actually
   * present anywhere in this run — top-level agent OR any subagent
   * (transitively). `codeEnvAvailable` on each `RunAgent` is the
   * per-agent gate (admin `execute_code` capability AND the agent's
   * own `tools` listing `execute_code`), so the feature follows the
   * same activation as the bash-tool registration in
   * `initializeAgent`. The walk into `subagentAgentConfigs` is
   * load-bearing: a parent without `execute_code` can spawn a
   * subagent that has it, and the SDK's shared registry serves
   * every `ToolNode` compiled from this run's graph — so missing
   * subagents in this gate would leave the child's
   * `{{tool<idx>turn<turn>}}` placeholders unsubstituted. SDK
   * defaults (~400 KB per output, 5 MB total) keep substituted
   * payloads inside typical shell ARG_MAX limits, so no overrides
   * are needed for the experimental rollout.
   */
  const enableToolOutputReferences = anyAgentHasCodeEnv(agents);

  /**
   * Human-in-the-loop tool approval — OFF by default. When the agents endpoint
   * opts in (`toolApproval.enabled`), attach the `PreToolUse` policy hook + the
   * `humanInTheLoop` switch, and bind a durable checkpointer so a run that pauses
   * for review can be rebuilt and resumed on any worker (see `agents/checkpointer.ts`
   * and the resume route). When disabled, nothing attaches and the run is identical
   * to before this feature shipped.
   */
  // Resolve the effective policy through the single seam so BYOM defaults and
  // future persisted per-agent / per-skill sources do not leak into this call site.
  const toolApprovalPolicy = resolveToolApprovalPolicy({
    endpoint: agentsEndpointConfig?.toolApproval,
    attachedCodeEnvironment: attachedCodeEnvironmentAgentIds.size > 0,
  });
  // Gate HITL to callers that actually implement the pause/resume lifecycle. The
  // OpenAI-compatible + Responses controllers also call createRun/processStream but never
  // inspect `run.getInterrupt()` or persist a pending action — so an approval-gated tool
  // would pause with no approval surface or resume endpoint, and the route would emit a
  // normal final response / `[DONE]` with the tool call dangling. Only AgentClient (chat +
  // resume) passes `hitlCapable`; without it the run is identical to the no-HITL path.
  /** Both-direction key-spelling aliases collected from every eagerly known
   *  agent, including explicit and graph subagents. Lazy subagents report
   *  theirs through `registerResolvedMCPToolAliases` below. */
  const mcpToolAliases = collectRunMCPToolAliases(agents);
  const mcpToolAliasKeys = new Set(
    mcpToolAliases.map(({ name, aliasName }) => `${name}\u0000${aliasName}`),
  );
  const effectiveToolApprovalPolicy = () =>
    exemptAskUserQuestionFromApproval(
      healToolApprovalPolicy(toolApprovalPolicy, mcpToolAliases),
      ASK_USER_QUESTION_TOOL_NAME,
    );
  const hitl = hitlCapable
    ? buildHITLRunWiring(
        // The ask tool is exempt from the approval prompt (unless explicitly
        // listed by the admin) — approving the right to ask a question is a
        // pure double-pause; the tool has no side effects to gate. Pattern
        // lists are healed against the tools' other key spellings first, so
        // admin globs written for pre-strip upstream names keep applying (a
        // non-matching deny would fail OPEN), and rules written against
        // current catalog names reach legacy-named instances.
        effectiveToolApprovalPolicy(),
        {
          userId: user?.id,
          conversationId: requestBody?.conversationId,
          tenantId: tenantId ?? user?.tenantId,
          appConfig,
        },
        mcpToolAliases,
        [
          ...(resolvedToolApprovalHooks ??
            buildToolApprovalHooks({
              userId: user?.id,
              conversationId: requestBody?.conversationId,
              tenantId: tenantId ?? user?.tenantId,
              appConfig,
            })),
          ...(attachedCodeEnvironmentAgentIds.size > 0
            ? [
                {
                  hook: createAttachedCodeEnvironmentPolicyHook(
                    attachedCodeEnvironmentAgentIds,
                    attachedCodeEnvironmentSettings,
                    codeApprovalMode,
                  ),
                },
              ]
            : []),
        ],
      )
    : undefined;
  registerResolvedMCPToolAliases = (resolvedAgent) => {
    if (resolvedAgent.codeExecutionContext?.environmentType === 'attached') {
      // The admission hook closes over these collections. A lazily resolved agent
      // therefore receives its own current machine policy before its first tool call;
      // a mode that machine does not permit safely falls back to ask/deny there.
      attachedCodeEnvironmentAgentIds.add(resolvedAgent.id);
      attachedCodeEnvironmentSettings.set(resolvedAgent.id, {
        configSchema: resolvedAgent.codeExecutionContext.codeEnvironmentConfigSchema,
        settings: resolvedAgent.codeExecutionContext.codeEnvironmentSettings,
        skillAuthoringAvailable: resolvedAgent.skillAuthoringAvailable === true,
      });
    }
    const discoveredAliases = collectRunMCPToolAliases([resolvedAgent]).filter(
      ({ name, aliasName }) => {
        const key = `${name}\u0000${aliasName}`;
        if (mcpToolAliasKeys.has(key)) {
          return false;
        }
        mcpToolAliasKeys.add(key);
        return true;
      },
    );
    if (discoveredAliases.length === 0) {
      return;
    }
    mcpToolAliases.push(...discoveredAliases);
    hitl?.addMCPToolAliases(discoveredAliases, effectiveToolApprovalPolicy());
  };
  /**
   * The `ask_user_question` tool pauses via LangGraph `interrupt()` from inside its own
   * body, which needs only a durable checkpointer — NOT the tool-approval policy
   * (`humanInTheLoop`/hooks stay off unless approval is separately enabled; verified
   * end-to-end in `api/.../agents/__tests__/askUserQuestion.e2e.spec.js`). Top-level
   * check only: subagent copies of the tool are stripped in `buildAgentInput`. Gated on
   * `hitlCapable` like approval, and the tool itself was stripped from non-HITL callers
   * above, so a checkpointer here always has a resume surface. The LazyMongoSaver only
   * persists when a run actually pauses, so attaching it is near-zero overhead.
   */
  const asksUserQuestions =
    hitlCapable && !askToolAdminDisabled && agents.some(agentRequestsAskUserQuestion);
  if (hitl || asksUserQuestions || eventActorCheckpointing) {
    const checkpointer = await getAgentCheckpointer(agentsEndpointConfig?.checkpointer);
    graphConfig.compileOptions = { ...graphConfig.compileOptions, checkpointer };
  }

  /**
   * The run's hook registry: the HITL policy hooks (when approval is enabled)
   * plus the steer-drain PostToolBatch hook. Steering registers independently
   * of the approval policy and requires no checkpointer, but is hard-gated on
   * SDK support — draining on an SDK that ignores `injectedMessages` would
   * silently drop the user's words (the steer controller 501s in that case;
   * this guard is defense in depth).
   */
  let hooks = hitl?.hooks;
  if (usesSubagentCompletionWakeups(activeSubagentTasks)) {
    hooks = hooks ?? new HookRegistry();
    hooks.register('PostToolUse', {
      pattern: String(Constants.SUBAGENT),
      hooks: [
        createSubagentWakeupHandleHook((agentId) =>
          agentUsesSubagentCompletionWakeups(activeSubagentTasks, agentId),
        ),
      ],
      internal: true,
    });
  }
  /** Activity labels register BEFORE the steer drain: the label must claim
   *  its slot while the batch's tool parts are still the content tail. If a
   *  steer drained first, its injected part would flush the tool block in
   *  sequential rendering and orphan the label outside its group. With the
   *  label claimed first, parts order as [tools…, label, steer] — the label
   *  terminates the group and the steer renders after it. */
  if (activityLabel != null) {
    hooks = hooks ?? new HookRegistry();
    hooks.register('PostToolBatch', { hooks: [activityLabel.hook] });
  }
  if (activityPhase != null) {
    hooks = hooks ?? new HookRegistry();
    hooks.register('PostToolBatch', { hooks: [activityPhase.hook] });
  }
  if (steering != null && isSteeringSupported()) {
    hooks = hooks ?? new HookRegistry();
    hooks.register('PostToolBatch', { hooks: [steering.hook] });
    if (steering.preemptHook != null && isSteerPreemptSupported()) {
      hooks.register('PreemptBoundary', { hooks: [steering.preemptHook] });
    }
    if (steering.terminalHook != null && isSteerTerminalContinuationSupported()) {
      const stopFinalizeRegistry = hooks as unknown as {
        register: (event: 'StopFinalize', matcher: { hooks: TerminalSteerHook[] }) => () => void;
      };
      stopFinalizeRegistry.register('StopFinalize', { hooks: [steering.terminalHook] });
    }
  }
  /**
   * Step-budget awareness. Registered unconditionally (no config, no checkpointer,
   * no SDK capability gate, since `additionalContext` has been part of `BaseHookOutput`
   * since hooks shipped) because running out of steps mid-turn is a failure mode on
   * every ingress, and a model that knows its budget is running low usually avoids
   * it. Registered after the label/steer hooks so their content-slot ordering is
   * untouched; `additionalContexts` accumulate independently of injected messages.
   */
  hooks = hooks ?? new HookRegistry();
  hooks.register('PostToolBatch', {
    hooks: [
      createStepBudgetHook({
        recursionLimit: resolveRecursionLimit(agentsEndpointConfig, agents[0]),
      }),
    ],
    internal: true,
  });
  /**
   * Deployment-plugin hooks (Agent Plugins `ai.librechat/hooks/hooks.json`)
   * register last so internal policy hooks (HITL, labels, steering) keep
   * their ordering. The source is wired at startup by the plugins package
   * (see `setPluginHookSource` in api/server/index.js) and stays empty
   * unless the operator installed plugins with hook documents AND opted in
   * via DEPLOYMENT_PLUGIN_HOOKS. The conversation id doubles as the plugin
   * "session", giving SessionStart its once-per-conversation scope.
   */
  const pluginHookSource = getPluginHookSource();
  if (pluginHookSource?.hasHooks() === true) {
    hooks = hooks ?? new HookRegistry();
    const primaryAgent = agents[0];
    pluginHookSource.register({
      registry: hooks,
      context: {
        sessionId: requestBody?.conversationId,
        userId: user?.id,
        sessionStartSource,
        model: primaryAgent?.model_parameters?.model ?? primaryAgent?.model ?? undefined,
        agentType: primaryAgent?.id,
      },
      // `ask` needs the checkpointer + resume surface; without HITL wiring the
      // source tightens plugin `ask` decisions to `deny` rather than stranding
      // the run on an un-resumable interrupt.
      askDecisionSupported: hitl != null,
    });
  }

  const streamLimits = resolveStreamLimits(agentsEndpointConfig);

  /**
   * Built as a variable (not an inline literal) so the extra
   * `subagentUsageSink` field passes assignability against SDK versions
   * whose `RunConfig` predates it (<= 3.2.33, where it is ignored at
   * runtime) — excess-property checks only apply to fresh literals. Inline
   * the field at the call site once the dependency is bumped.
   */
  const runConfig = {
    runId: resolvedRunId,
    graphConfig,
    tokenCounter,
    customHandlers,
    initialSessions,
    calibrationRatio,
    fadingTier,
    fadingTiers,
    indexTokenCountMap,
    subagentUsageSink,
    subagentTasks: activeSubagentTasks,
    ...(runFilesActive &&
      runFiles != null && {
        subagentContext: { prepare: runFiles.prepare, complete: runFiles.complete },
      }),
    // Exclude side-effecting / large-free-form-arg tools from eager execution.
    // Eager speculatively runs a tool mid-stream; for a big streamed arg (a
    // file body, a bash heredoc, a code block) the accumulated args can diverge
    // from the final tool call and trip the SDK's "changed after eager
    // execution" guard, and a speculative write/exec can land before the turn
    // commits. create_file/edit_file write files; execute_code/bash_tool run
    // code with large `code`/`command` args. `excludeToolNames` requires
    // @librechat/agents with the eager-exclusion support (agents#281); older
    // versions ignore the field. ask_user_question raises a LangGraph
    // `interrupt()` from its tool body, which must run inside the Pregel task
    // frame — a speculative eager execution could never pause the run.
    eagerEventToolExecution: {
      enabled: true,
      excludeToolNames: [
        CREATE_FILE_TOOL_NAME,
        EDIT_FILE_TOOL_NAME,
        Constants.EXECUTE_CODE,
        Constants.BASH_TOOL,
        ASK_USER_QUESTION_TOOL_NAME,
        /**
         * Background-capable tools: eager execution could launch the detached
         * task with speculative/partial args before the final tool call, and a
         * background side effect (unlike a foreground eager mismatch) can't be
         * canceled once dispatched. The poll tool is excluded for the same
         * reason: collecting a task's artifact is a one-shot claim that must
         * not fire from a speculative snapshot the SDK may later discard.
         */
        CHECK_BACKGROUND_TASK_NAME,
        ...agents.flatMap((agent) => agent.backgroundToolNames ?? []),
        ...(clientToolNames ?? []),
      ],
    },
    // Let host file tools share the code-execution sandbox session so a file
    // created with create_file/edit_file is visible to later
    // execute_code/bash_tool calls (and vice versa). The SDK folds these tools'
    // returned exec session/files into the shared code session and injects the
    // existing session into their requests. Membership here also stamps the
    // stateful `runtimeSessionHint` and excludes the tool from eager execution
    // — read_file needs both, or its sandbox `cat` runs hintless on the Code
    // API's per-user default runtime session and cannot see files bash_tool
    // just wrote in the conversation's session. Requires @librechat/agents
    // with codeSessionToolNames support (agents#283); older versions ignore it.
    // `check_background_task` participates so a backgrounded code call's exec
    // session/files (returned as the poll result's artifact when claimed) fold
    // into the shared code session, keeping same-run continuity for later
    // foreground code calls. Poll results carry an artifact only for code
    // tasks, so non-code polls never touch the session.
    codeSessionToolNames: [
      CREATE_FILE_TOOL_NAME,
      EDIT_FILE_TOOL_NAME,
      Constants.READ_FILE,
      CHECK_BACKGROUND_TASK_NAME,
    ],
    // Derive the Langfuse trace id deterministically from runId so message
    // feedback can be scored against the trace without a lookup (see the
    // feedback route in api/server/routes/messages.js). No-op unless Langfuse
    // tracing is enabled. Requires @librechat/agents >= 3.2.21.
    langfuse: buildLangfuseConfig({
      appConfig,
      runId: resolvedRunId,
      tenantId: tenantId ?? user?.tenantId,
      centralTraceExportEnabled,
      user,
      traceContext: resolveRunTraceContext({ agents, conversationId, requestBody, traceContext }),
    }),
    ...(enableToolOutputReferences && {
      toolOutputReferences: { enabled: true },
    }),
    // HITL opt-in: the `humanInTheLoop` switch + the PreToolUse policy hook. Spread
    // here (not just `compileOptions.checkpointer` above) so an `ask` decision raises
    // a real interrupt — without these the run would never pause. Absent when disabled.
    // The steer-drain hook rides the same registry but independently of the approval
    // policy: a PostToolBatch-only registry keeps the SDK's eager execution fast paths
    // (it gates on result-altering hooks, not registry presence).
    ...(hitl && { humanInTheLoop: hitl.humanInTheLoop }),
    ...(hooks && { hooks }),
    // Preemption is observation-only like the boundary hooks: the poll never
    // mutates and the SDK refuses to seal unless a PreemptBoundary matcher is
    // live, so gating both on the same capability keeps them in lockstep.
    ...(steering?.preemption != null &&
      isSteerPreemptSupported() && { preemption: steering.preemption }),
    // Stream circuit breakers (librechat.yaml endpoints.agents.maxToolCallArgBytes /
    // maxDeltaEventsPerTurn). Omitted when unset so the SDK defaults apply: a runaway
    // streamed tool-call argument aborts the run at 64 KiB, the per-turn delta event
    // cap stays off. Requires @librechat/agents with streamLimits support (agents#381);
    // older versions ignore the field.
    ...(streamLimits && { streamLimits }),
  };
  const run = await Run.create(runConfig);

  applyCustomHandoffPromptKeyCompatibility(run, runConfig.graphConfig);
  applyTestRunHook(run, {
    messages,
    agents,
    modelCallbacks,
    conversationId: conversationId ?? requestBody?.conversationId ?? undefined,
  });
  return run;
}
