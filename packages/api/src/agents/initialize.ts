import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import {
  Tools,
  Constants,
  ErrorTypes,
  EModelEndpoint,
  EToolResources,
  paramEndpoints,
  isAgentsEndpoint,
  AgentCapabilities,
  resolveAllowedStatefulCodeEnvironments,
  hasActivePiiFields,
  hasActivePiiPatterns,
  replaceSpecialVars,
  providerEndpointMap,
} from 'librechat-data-provider';
import type {
  AgentToolResources,
  AgentToolOptions,
  TEndpointOption,
  ReasoningResponseKey,
  StatefulCodeEnvironment,
  TurnDeliveryRouting,
  ImageDetail,
  TFile,
  Agent,
  TUser,
  TurnFileConsumers,
} from 'librechat-data-provider';
import type { GenericTool, LCToolRegistry, ToolMap, LCTool } from '@librechat/agents';
import type { IMongoFile, FileOwnerScope } from '@librechat/data-schemas';
import type { Request, Response as ServerResponse } from 'express';
import type {
  TFileUpdate,
  ProvisionState,
  TFilterFilesByAgentAccess,
  TProvisionToCodeEnv,
  TProvisionToVectorDB,
  TCheckSessionsAlive,
  TLoadCodeApiKey,
} from './resources';
import type {
  ResolvedManualSkill,
  ResolvedAlwaysApplySkill,
  ResolvedSkillCatalog,
  TListSkillsByAccess,
  TGetSkillByName,
} from './skills';
import type {
  ServerRequest,
  RequestBody,
  EndpointDbMethods,
  EndpointTokenConfig,
  InitializeResultBase,
} from '~/types';
import type { LCAvailableTools, RequestScopedMCPConnectionStore } from '../mcp/types';
import type { ContentTraversalLimitError } from '../protection/adapters/nested';
import type { SkillContentInput } from '../protection/adapters/submissions';
import type { RepositoryInstructionSource } from '../code/instructions';
import type { TextContentFragment } from '../protection/types';
import type { CheckAccessParams } from '../middleware/access';
import type { MCPToolAlias } from '~/tools/classification';
import type { AgentExecutionContext } from './runtime';
import {
  injectSkillCatalog,
  resolveSkillCatalog,
  resolveManualSkills,
  resolveAlwaysApplySkills,
  selectSkillPrimesForTurn,
  unionPrimeAllowedTools,
  MAX_PRIMED_SKILLS_PER_TURN,
} from './skills';
import {
  normalizeStatefulCodeEnvironment,
  resolveCodeExecutionContext,
  type CodeEnvironmentConfig,
  type CodeExecutionContext,
} from './execution';
import {
  getContentTraversalFragments,
  isContentTraversalProtected,
  isContentTraversalLimitError,
} from '../protection/adapters/nested';
import {
  optionalChainWithEmptyCheck,
  extractLibreChatParams,
  getSafeErrorMetadata,
  getModelMaxTokens,
  getThreadData,
} from '~/utils';
import {
  isCodeFileToolName,
  registerCodeExecutionTools,
  registerFileAuthoringTools,
  isFileAuthoringToolDefinition,
} from './tools';
import {
  normalizeServerName,
  requiresEphemeralUserConnection,
  splitMCPToolKey,
  normalizeAgentToolKeys,
} from '~/mcp/utils';
import {
  createStatefulCodeEnvironmentPolicyError,
  isFatalAgentInitializationError,
} from './errors';
import { extractAgentContent, extractSkillContent } from '../protection/adapters/submissions';
import { createConfiguredContentInspector, inspectContent } from '../protection/runtime';
import { assertAgentAttachmentLimits, isModelBoundAttachmentFile } from './attachments';
import { resolveAttachedWorkspaceCommandTimeoutMax } from '~/code/command';
import { assertModelBoundContent } from '../middleware/modelBoundContent';
import { isImplicitStatefulCodeRouteAvailable } from '../code/config';
import { registerMemoryTools, memoryToolUsageGuard } from './memory';
import { applyIntentLabels, sanitizeIntentLabels } from './intent';
import { ContentFilterError } from '../middleware/contentFilter';
import { resolveToolRoleGrants } from '~/tools/rolePermissions';
import { createRequestAgentExecutionContext } from './runtime';
import { resolveTurnDeliveryRouting } from './files/delivery';
import { filterFilesByEndpointRuntimeConfig } from '~/files';
import { hasActiveFileFieldPolicy } from '~/protection';
import { PARTIAL_RESOLVED_CONVERSATION } from './guard';
import { applyBackgroundToolCalls } from './background';
import { applyTurnDelivery } from './files/delivery';
import { generateArtifactsPrompt } from '~/prompts';
import { getProviderConfig } from '~/endpoints';
import { primeResources } from './resources';

/**
 * Fraction of context budget reserved as headroom when no explicit maxContextTokens is set.
 * Reduced from 0.10 to 0.05 alongside the introduction of summarization, which actively
 * manages overflow. `createRun` can further override this via `SummarizationConfig.reserveRatio`.
 */
const DEFAULT_RESERVE_RATIO = 0.05;

/**
 * Bytes these files spend against the endpoint's total-size allowance, counting a file
 * that appears in more than one set once. The sets overlap, an embedded attachment still
 * missing the active code route being the case in point, and they are merged with the
 * same deduplication downstream, so charging it twice spends an allowance the request
 * never uses and drops another file that fits.
 */
/**
 * Splits persistent files into those this request already screened and charged, and those
 * still to screen. A setup file can also be the turn's attachment, and the sets are merged
 * by id downstream, so charging it again against the remaining size allowance spends it
 * twice and drops another file that would have fit.
 */
export function partitionCommittedFiles<T extends { file_id?: string }>(
  files: T[],
  committed: Array<{ file_id?: string }>,
): { committed: T[]; pending: T[] } {
  const ids = new Set(
    committed.map((file) => file.file_id).filter((id): id is string => id != null),
  );
  const alreadyCommitted: T[] = [];
  const pending: T[] = [];
  for (const file of files) {
    if (file.file_id != null && ids.has(file.file_id)) {
      alreadyCommitted.push(file);
      continue;
    }
    pending.push(file);
  }
  return { committed: alreadyCommitted, pending };
}

function sumUniqueBytes(files: Array<{ file_id?: string; bytes?: number }>): number {
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (file.file_id != null) {
      if (seen.has(file.file_id)) {
        continue;
      }
      seen.add(file.file_id);
    }
    total += file.bytes ?? 0;
  }
  return total;
}

const temporalSpecialVarRegex = /{{\s*(current_date|current_datetime|iso_datetime)\s*}}/i;
const geminiModelVersionRegex = /^gemini-(\d+)(?:\.(\d+))?(?:-|$)/;
const googleToolCombinationTextModels = [
  'gemini-3-flash-preview',
  'gemini-3-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
];
const googleToolCombinationExcludedModalityRegex =
  /(?:^|-)image(?:-|$)|(?:^|-)live(?:-|$)|(?:^|-)tts(?:-|$)/;

function assertResolvedSkillContentAllowed(
  skills: readonly SkillContentInput[],
  filters: NonNullable<ServerRequest['config']>['filters'] | undefined,
): void {
  const pii = filters?.skills?.pii;
  if (!hasActivePiiPatterns(pii) || skills.length === 0) {
    return;
  }

  const inspectionSession = createConfiguredContentInspector({ filters })?.createSession();
  if (inspectionSession == null) {
    return;
  }
  const selectedFields = pii?.fields == null ? null : new Set<string>(pii.fields);
  const selected = (field: string): boolean => selectedFields == null || selectedFields.has(field);
  const traversalErrors: ContentTraversalLimitError[] = [];
  let firstFinding: ReturnType<typeof inspectionSession.inspect> = null;
  for (const skill of skills) {
    const projected: SkillContentInput = {
      ...(selected('name') && { name: skill.name }),
      ...(selected('display_title') && { displayTitle: skill.displayTitle }),
      ...(selected('description') && { description: skill.description }),
      ...(selected('category') && { category: skill.category }),
      ...(selected('instructions') && {
        body: skill.body,
        instructions: skill.instructions,
      }),
      ...(selected('imported_text') && { importedText: skill.importedText }),
      ...(selected('frontmatter') && { frontmatter: skill.frontmatter }),
      ...((selected('file_name') || selected('file_text')) && {
        files: skill.files?.map((file) => ({
          ...(selected('file_name') && { name: file?.name, filename: file?.filename }),
          ...(selected('file_text') && { text: file?.text, content: file?.content }),
        })),
      }),
    };
    let fragments: readonly TextContentFragment[];
    try {
      fragments = extractSkillContent(projected);
    } catch (error) {
      if (!isContentTraversalLimitError(error)) {
        throw error;
      }
      fragments = getContentTraversalFragments(error);
      traversalErrors.push(error);
    }
    const finding = inspectionSession.inspect(fragments);
    if (finding != null) {
      firstFinding ??= finding;
      if (!inspectionSession.hasAuditRules) {
        throw new ContentFilterError(finding);
      }
    }
  }
  if (firstFinding != null) {
    throw new ContentFilterError(firstFinding);
  }
  const protectedTraversal = traversalErrors.find((error) =>
    isContentTraversalProtected({ error, filters }),
  );
  if (protectedTraversal != null) {
    throw protectedTraversal;
  }
}

function hasTemporalSpecialVars(text: string): boolean {
  return temporalSpecialVarRegex.test(text);
}

function appendAdditionalInstructions(agent: Agent, text?: string | null): void {
  if (text == null || text === '') {
    return;
  }
  agent.additional_instructions = [agent.additional_instructions ?? '', text]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The request middleware already read this conversation once (`null` = looked up, absent).
 * A stored document without `files` genuinely has none; only the branded lineage-only
 * partial from a bound agent-event continuation cannot speak for the database.
 */
export function readResolvedConversationFiles(
  runtime: Pick<AgentExecutionContext, 'resolvedConversation'>,
  conversationId: string,
): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(runtime, 'resolvedConversation')) {
    return undefined;
  }
  const resolved = runtime.resolvedConversation;
  if (resolved === null) {
    return [];
  }
  if (
    resolved == null ||
    resolved.conversationId !== conversationId ||
    (resolved as Record<symbol, unknown>)[PARTIAL_RESOLVED_CONVERSATION] === true
  ) {
    return undefined;
  }
  return resolved.files ?? [];
}

export interface ResolveResendToolResourcesParams {
  /** Tool names as configured on the agent. */
  tools?: string[] | null;
  /** `execute_code` capability AND the caller's `RUN_CODE` grant. */
  codeEnvAvailable: boolean;
  /**
   * `file_search` capability AND the caller's `FILE_SEARCH` grant. `undefined`
   * where the caller resolved neither, which leaves priming as it was.
   */
  fileSearchAvailable?: boolean;
}

/**
 * Tool resources whose prior-turn files this run re-hydrates on resend.
 *
 * Both role-gated tools are filtered here rather than after hydration, because
 * priming is not free: the files are read, their usage counters are bumped, and
 * they are primed into `tool_resources` for a tool the loader is about to drop.
 * Each flag is the deployment capability AND the role grant, so this reaches the
 * same verdict the loader will.
 */
export function resolveResendToolResources({
  tools,
  codeEnvAvailable,
  fileSearchAvailable,
}: ResolveResendToolResourcesParams): Set<EToolResources> {
  const toolResourceSet = new Set<EToolResources>();
  for (const tool of tools ?? []) {
    if (isCodeFileToolName(tool) && !codeEnvAvailable) {
      continue;
    }
    if (tool === Tools.file_search && fileSearchAvailable === false) {
      continue;
    }
    if (isCodeFileToolName(tool)) {
      toolResourceSet.add(EToolResources.execute_code);
    }
    if (EToolResources[tool as keyof typeof EToolResources]) {
      toolResourceSet.add(EToolResources[tool as keyof typeof EToolResources]);
    }
  }
  return toolResourceSet;
}

function getMaxCatalogSkills(runtime: AgentExecutionContext): number | undefined {
  const endpoints = runtime.appConfig?.endpoints as
    | Record<string, { skills?: { maxCatalogSkills?: number } } | undefined>
    | undefined;
  return endpoints?.[EModelEndpoint.agents]?.skills?.maxCatalogSkills;
}

function getToolName(tool: unknown): string | undefined {
  if (tool == null || typeof tool !== 'object') {
    return undefined;
  }
  const { name } = tool as { name?: unknown };
  return typeof name === 'string' ? name : undefined;
}

function hasToolDefinition(toolDefinitions: LCTool[] | undefined, name: string): boolean {
  return toolDefinitions?.some((toolDefinition) => toolDefinition.name === name) === true;
}

function hasGoogleSearchTool(tool: unknown): boolean {
  if (tool == null || typeof tool !== 'object') {
    return false;
  }
  return 'googleSearch' in tool || 'googleSearchRetrieval' in tool;
}

/**
 * Whether a provider-built tool is that provider's own web search.
 *
 * Each provider spells it differently — OpenAI `{ type: 'web_search' }`, Anthropic
 * `{ type: 'web_search_20250305', name: 'web_search' }`, Google `{ googleSearch: {} }` —
 * and the tool is already built by the time it reaches here, so the shape is what
 * identifies it rather than the parameter that asked for it.
 */
function isProviderWebSearchTool(tool: unknown): boolean {
  if (tool == null || typeof tool !== 'object') {
    return false;
  }
  if (hasGoogleSearchTool(tool)) {
    return true;
  }
  if (getToolName(tool) === Tools.web_search) {
    return true;
  }
  const { type } = tool as { type?: unknown };
  return typeof type === 'string' && type.startsWith(Tools.web_search);
}

/**
 * Removes OpenRouter's web-search plugin from a built LLM config.
 *
 * OpenRouter does not receive web search as a tool — `getOpenAIConfig` encodes it
 * as `modelKwargs.plugins: [{ id: 'web' }]` and pushes no tool at all — so the
 * provider-tool filter has nothing to strip on that path and the plugin would
 * still reach the provider for a role that was denied.
 */
function stripWebSearchPlugin(llmConfig: Record<string, unknown>): number {
  const modelKwargs = llmConfig.modelKwargs as { plugins?: unknown } | undefined;
  if (modelKwargs == null || !Array.isArray(modelKwargs.plugins)) {
    return 0;
  }
  const plugins = modelKwargs.plugins as Array<{ id?: unknown }>;
  const remaining = plugins.filter((plugin) => !isWebSearchPlugin(plugin));
  const removed = plugins.length - remaining.length;
  if (removed === 0) {
    return 0;
  }
  if (remaining.length > 0) {
    modelKwargs.plugins = remaining;
  } else {
    delete modelKwargs.plugins;
  }
  return removed;
}

function isWebSearchPlugin(plugin: unknown): boolean {
  return (plugin as { id?: unknown } | null)?.id === 'web';
}

/**
 * Whether a built provider config turns native web search on, as a tool or as
 * OpenRouter's plugin.
 *
 * Read from the builder's output rather than from `model_parameters.web_search`:
 * the parameter is one of several inputs — an endpoint's `defaultParams`,
 * `customParams` defaults and `addParams` all reach the same switch, and
 * `addParams` is applied last — so the output is the only place every route
 * has already converged.
 */
function hasProviderWebSearch(
  tools: unknown[] | undefined,
  llmConfig: Record<string, unknown>,
): boolean {
  if (tools?.some(isProviderWebSearchTool) === true) {
    return true;
  }
  const plugins = (llmConfig.modelKwargs as { plugins?: unknown } | undefined)?.plugins;
  return Array.isArray(plugins) && plugins.some(isWebSearchPlugin);
}

/**
 * Resolves the `WEB_SEARCH` grant for provider-native search.
 *
 * A caller-supplied resolver wins, so a route that memoizes grants on its own
 * request — and reaches here with `runtime` and no `req` — joins that read
 * instead of issuing another. Without one, the grant is resolved for `user`
 * through `db.getRoleByName`; with neither there is no role to consult.
 *
 * Fails closed: a resolver that throws denies.
 */
async function resolveWebSearchGrant({
  req,
  user,
  resolve,
  getRoleByName,
}: {
  req?: Request;
  user?: CheckAccessParams['user'] | null;
  resolve?: () => Promise<boolean>;
  getRoleByName?: CheckAccessParams['getRoleByName'];
}): Promise<boolean> {
  try {
    if (resolve != null) {
      return await resolve();
    }
    if (getRoleByName == null) {
      return true;
    }
    const grants = await resolveToolRoleGrants({
      req,
      user,
      getRoleByName,
      context: 'initializeAgent',
    });
    return grants.webSearch;
  } catch {
    logger.error(
      `[initializeAgent][User: ${user?.id}] Failed to resolve the WEB_SEARCH grant; denying provider-native web search`,
    );
    return false;
  }
}

function normalizeGoogleModelName(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.split('/').pop() ?? normalized;
}

function isKnownGoogleToolCombinationTextModel(model: string): boolean {
  return googleToolCombinationTextModels.some(
    (knownModel) => model === knownModel || model.startsWith(`${knownModel}-`),
  );
}

function isGemini35OrLater(model: string): boolean {
  const match = geminiModelVersionRegex.exec(model);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? '0');
  return major > 3 || (major === 3 && minor >= 5);
}

function supportsGoogleToolCombination(model: unknown): boolean {
  if (typeof model !== 'string') {
    return false;
  }
  const normalized = normalizeGoogleModelName(model);
  if (googleToolCombinationExcludedModalityRegex.test(normalized)) {
    return false;
  }
  return isKnownGoogleToolCombinationTextModel(normalized) || isGemini35OrLater(normalized);
}

function isGoogleToolCombinationProvider(provider?: string): boolean {
  return provider === Providers.GOOGLE || provider === Providers.VERTEXAI;
}

function shouldIncludeGoogleServerSideToolInvocations({
  provider,
  hasProviderTools,
  hasAgentTools,
}: {
  provider?: string;
  hasProviderTools: boolean;
  hasAgentTools: boolean;
}): boolean {
  return isGoogleToolCombinationProvider(provider) && hasProviderTools && hasAgentTools;
}

function assertGoogleToolCombinationSupport(model: unknown): void {
  if (!supportsGoogleToolCombination(model)) {
    throw new Error(`{ "type": "${ErrorTypes.GOOGLE_TOOL_CONFLICT}"}`);
  }
}

function enableGoogleServerSideToolInvocations({
  agent,
  llmConfig,
}: {
  agent: Agent;
  llmConfig: Record<string, unknown>;
}): void {
  llmConfig.includeServerSideToolInvocations = true;
  if (agent.model_parameters) {
    (agent.model_parameters as Record<string, unknown>).includeServerSideToolInvocations = true;
  }
}

function resolveProviderToolConflicts({
  provider,
  tools,
  toolDefinitions,
  webSearchDenied = false,
}: {
  provider?: string;
  tools?: unknown[];
  toolDefinitions?: LCTool[];
  /**
   * Whether the build turned native web search on for a role that denies
   * `WEB_SEARCH.USE`. The built tool is stripped, which holds however the build
   * was asked for it.
   */
  webSearchDenied?: boolean;
}): unknown[] | undefined {
  if (!tools?.length) {
    return tools;
  }

  if (!webSearchDenied && !hasToolDefinition(toolDefinitions, Tools.web_search)) {
    return tools;
  }

  const shouldRemoveTool = (tool: unknown): boolean => {
    if (webSearchDenied) {
      return isProviderWebSearchTool(tool);
    }
    if (provider === Providers.ANTHROPIC) {
      return getToolName(tool) === Tools.web_search;
    }
    if (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) {
      return hasGoogleSearchTool(tool);
    }
    return false;
  };

  let removed = 0;
  const resolvedTools = tools.filter((tool) => {
    const shouldRemove = shouldRemoveTool(tool);
    if (shouldRemove) {
      removed += 1;
    }
    return !shouldRemove;
  });

  if (removed > 0) {
    logger.debug(
      webSearchDenied
        ? `[initializeAgent] Removed ${removed} ${provider} native web search tool(s); role denies WEB_SEARCH.`
        : `[initializeAgent] Removed ${removed} ${provider} native web search tool(s); LibreChat web_search is enabled.`,
    );
  }

  return resolvedTools;
}

/**
 * Extended agent type with additional fields needed after initialization
 */
export type InitializedAgent = Agent & {
  /** Request-resolved Azure identity for self-summarization; never persisted on the agent. */
  azureOptions?: InitializeResultBase['azureOptions'];
  tools: GenericTool[];
  /** @deprecated use requestAttachments or agentContextAttachments based on sharing semantics. */
  attachments: IMongoFile[];
  /** Message files admitted for this agent, including historical files when resend is enabled. */
  requestAttachments: IMongoFile[];
  /** Only hydrated attachments from the current request; excludes history and agent setup files. */
  currentRequestAttachments: TFile[];
  /** Files attached to this agent's permanent context via tool_resources. */
  agentContextAttachments: IMongoFile[];
  /** File-reading tools this turn runs, which decide when a tool-routed file falls back to text. */
  fileConsumers?: TurnFileConsumers;
  toolContextMap: Record<string, unknown>;
  dynamicToolContextMap?: Record<string, unknown>;
  maxContextTokens: number;
  /** Pre-ratio context budget (agentMaxContextNum - maxOutputTokensNum). Used by createRun to apply a configurable reserve ratio. */
  baseContextTokens?: number;
  useLegacyContent: boolean;
  resendFiles: boolean;
  /** Detail level LibreChat encodes image content blocks with, from the agent's
   * model parameters. Absent when the agent does not configure one. */
  imageDetail?: ImageDetail;
  /** How this agent receives its attachments this turn, settled once every routing input is final. */
  deliveryRouting: TurnDeliveryRouting;
  tool_resources?: AgentToolResources;
  userMCPAuthMap?: Record<string, Record<string, string>>;
  /** Tool map for ToolNode to use when executing tools (required for PTC) */
  toolMap?: ToolMap;
  /** Tool registry for PTC and tool search (only present when MCP tools with env classification exist) */
  toolRegistry?: LCToolRegistry;
  /** Run-scoped MCP tool definitions for request-scoped servers. */
  mcpAvailableTools?: Record<string, LCAvailableTools>;
  /** Run-scoped MCP connections for request-scoped servers. */
  requestScopedConnections?: RequestScopedMCPConnectionStore;
  /** Serializable tool definitions for event-driven execution */
  toolDefinitions?: LCTool[];
  /** Both-direction identity aliases for MCP tools whose key spelling changed */
  mcpToolAliases?: MCPToolAlias[];
  /** Precomputed flag indicating if any tools have defer_loading enabled (for efficient runtime checks) */
  hasDeferredTools?: boolean;
  /**
   * Names of this agent's tools that were injected with the `run_in_background`
   * param (capability enabled AND per-tool opt-in AND eligible). Threaded to the
   * tool executor via `configurable` so it can enforce the per-tool background
   * opt-in and gate the `check_background_task` poll tool at execution time.
   */
  backgroundToolNames?: string[];
  /**
   * Names of this agent's tools that received the host-injected `intent`
   * param (capability enabled AND opted in AND eligible). Threaded to the
   * tool executor via `configurable` so the arg is stripped before invoking
   * tools that don't declare it, and stripped from schemas a self-spawn
   * child or PTC sandbox inherits. SDK-native intent schemas are the tools'
   * own and are never listed here.
   */
  intentToolNames?: string[];
  /** Marker-verified tool names whose model-authored intent labels are safe compaction guidance. */
  semanticIntentToolNames?: string[];
  /** Tool names whose unverified schemas veto global semantic-intent trust for same-name calls. */
  semanticIntentBlockedToolNames?: string[];
  /** Whether the inline memory tools (`set_memory`/`delete_memory`) were
   *  registered for this agent. Authoritative LibreChat-only signal of the
   *  inline memory opt-in for the execution path, since some contexts hold the
   *  initialized config (the `memory` marker already expanded out of `tools`)
   *  rather than the raw agent document. */
  memoryToolsRegistered?: boolean;
  /** Whether the actions capability is enabled (resolved during tool loading) */
  actionsEnabled?: boolean;
  /**
   * The COMPLETE accessible-server audit this initialization resolved (via
   * the agent-key or skill-prime heal). Retained so deferred/event-driven
   * execution reuses the same snapshot instead of repeating the merged
   * registry read — a transient failure there would fail-closed a tool the
   * turn already advertised from the successful first audit.
   */
  accessibleMcpServerNames?: readonly string[];
  /** Maximum characters allowed in a single tool result before truncation. */
  maxToolResultChars?: number;
  /** Response field to read model reasoning from for custom OpenAI-compatible endpoints. */
  reasoningKey?: ReasoningResponseKey;
  /** Whether to reconstruct `reasoning_content` from persisted history across turns (custom endpoint opt-in). */
  includeReasoningHistory?: boolean;
  /**
   * Whether the code-execution environment is available *for this agent*.
   * Narrower than the incoming `params.codeEnvAvailable` admin flag — this
   * is `admin_capability_enabled && agent.tools.includes('execute_code')`,
   * computed once here so downstream code (`injectSkillCatalog`,
   * `enrichWithSkillConfigurable`, `primeInvokedSkills`) doesn't have to
   * re-scan the tool list on every runtime handler invocation.
   * Authoritative for both persisted and ephemeral agents: the
   * ephemeral-agent toggle is reconciled into `agent.tools` upstream
   * (`packages/api/src/agents/added.ts`), so the check is uniform.
   */
  codeEnvAvailable: boolean;
  /**
   * Whether stateful code sessions are active *for this agent*: the admin
   * `stateful_code_sessions` capability AND the agent's builder opt-in
   * (`agent.stateful_code_sessions`) AND `codeEnvAvailable`. Resolved once
   * here and carried with the agent so execution routing never needs a
   * graph-global stateful flag.
   */
  statefulCodeSessions: boolean;
  /** Sharing scope for this agent's stateful code environment. */
  statefulCodeEnvironment: Agent['stateful_code_environment'];
  /** Trusted partition for transient code session ids and file references. */
  codeSessionKey: string;
  /** Trusted endpoint/profile context for artifact processing and runtime tools. */
  codeExecutionContext: CodeExecutionContext;
  /** Whether host-side skill file authoring is available for this agent/run. */
  skillAuthoringAvailable: boolean;
  /** Host-side file authoring tool names registered for this run. */
  fileAuthoringToolNames?: Set<string>;
  /** Accessible skill IDs for ACL checking at execute time */
  accessibleSkillIds?: import('mongoose').Types.ObjectId[];
  /**
   * Names of skills the runtime can resolve, mirroring `accessibleSkillIds`.
   * Surfaced to the runtime so handlers like `read_file` can decide if a
   * `{firstSegment}/...` path refers to a real skill (vs. a code-env path
   * that should be routed to the bash fallback) without an extra DB lookup.
   */
  activeSkillNames?: Set<string>;
  /** Number of skills in the catalog (used to determine if SkillTool should be registered) */
  skillCount?: number;
  /**
   * Skills the user manually invoked for this turn via the `$` popover, resolved
   * to their SKILL.md bodies. The AgentClient injects these as meta user
   * messages right before the latest user message in the LLM's formatted
   * message array — deterministic priming without a tool roundtrip.
   */
  manualSkillPrimes?: ResolvedManualSkill[];
  /**
   * Skills auto-primed this turn because their `always-apply` frontmatter
   * flag is set. Resolved against the same `accessibleSkillIds` set and
   * subjected to the same active-state / ACL filters as the catalog, then
   * handed to the AgentClient for splicing alongside manual primes. Their
   * `allowedTools` entries also union into the agent's effective tool set
   * via `unionPrimeAllowedTools` (same pipeline as manual primes).
   */
  alwaysApplySkillPrimes?: ResolvedAlwaysApplySkill[];
  /**
   * Pre-uploaded code-env file refs from `tool_resources.execute_code`
   * (carries the conversation's prior-turn generated artifacts and any
   * user uploads). Captured by the `loadTools` callback; the AgentClient
   * merges these across all run agents into `Graph.sessions[EXECUTE_CODE]`
   * before run start so the very first `execute_code` / `bash_tool` call
   * sees them as `_injected_files`. Without this seed the agents-side
   * `CodeExecutor` falls back to `/files/{session_id}` — but `session_id`
   * is itself only populated by a previous successful execution, so on
   * call #1 the sandbox can't see the files at all.
   */
  primedCodeFiles?: import('@librechat/agents').CodeEnvFile[];
  /**
   * Resolved token/pricing config for this agent's endpoint (admin static
   * `tokenConfig` and/or fetched custom-endpoint config). Surfaced from the
   * provider `getOptions` result so the AgentClient bills, prices, and resolves
   * context limits with the same numbers the UI shows — not default rates.
   */
  endpointTokenConfig?: EndpointTokenConfig;
  /** Warnings from lazy file provisioning (e.g., failed uploads) */
  provisionWarnings?: string[];
  /** State for deferred file provisioning — actual uploads happen at tool invocation time */
  provisionState?: ProvisionState;
};

export const DEFAULT_MAX_CONTEXT_TOKENS = 32000;

/** Returns true when a conversation-level choice disables an attached environment. */
export function optsOutOfAttachedCodeEnvironment(
  agent: Agent,
  requestBody: RequestBody | undefined,
  environments: readonly CodeEnvironmentConfig[] | undefined,
  implicitStatefulRouteAvailable = false,
): boolean {
  if (requestBody?.codeEnvironmentMode !== 'without_attached') return false;
  const configured = agent.code_environment_id
    ? environments?.find(({ id }) => id === agent.code_environment_id)
    : environments?.find(({ default: isDefault }) => isDefault === true);
  return (
    agent.stateful_code_sessions === true &&
    (configured?.type === 'attached' ||
      (configured == null &&
        (Boolean(agent.code_environment_id) || !implicitStatefulRouteAvailable)))
  );
}

/**
 * Parameters for initializing an agent
 * Matches the CJS signature from api/server/services/Endpoints/agents/agent.js
 */
export interface InitializeAgentParams {
  /** Cancellation signal owned by the run performing initialization. */
  signal?: AbortSignal;
  /** Explicit transport-free execution state. */
  runtime?: AgentExecutionContext;
  /** Request-backed compatibility adapter for callers not yet migrated. */
  req?: ServerRequest;
  /** Deprecated response adapter retained only for source compatibility. */
  res?: ServerResponse;
  /** Agent to initialize */
  agent: Agent;
  /** Conversation ID (optional) */
  conversationId?: string | null;
  /** Parent message ID for determining the current thread (optional) */
  parentMessageId?: string | null;
  /** Normalized body used by MCP runtime placeholders during tool discovery. */
  requestBody?: RequestBody;
  /** Request files */
  requestFiles?: IMongoFile[];
  /** Host-authorized, hydrated inputs for an isolated execution. Suppresses parent history reads. */
  authorizedRunFiles?: readonly TFile[];
  /** Function to load agent tools */
  loadTools?: (params: {
    provider: string;
    agentId: string;
    tools: string[];
    model: string | null;
    tool_options: AgentToolOptions | undefined;
    tool_resources: AgentToolResources | undefined;
    requestBody?: RequestBody;
    /** Trusted endpoint/profile resolved for this agent before any code-file priming. */
    codeExecutionContext: CodeExecutionContext;
    /** Full accessible MCP server names (operator + user DB) when the heal
     *  already fetched them — lets execution-side collision guards see
     *  cross-tier shadowing without another registry round-trip. */
    accessibleMcpServerNames?: readonly string[];
  }) => Promise<{
    /** Full tool instances (only present when definitionsOnly=false) */
    tools?: GenericTool[];
    toolContextMap?: Record<string, unknown>;
    dynamicToolContextMap?: Record<string, unknown>;
    userMCPAuthMap?: Record<string, Record<string, string>>;
    toolRegistry?: LCToolRegistry;
    mcpAvailableTools?: Record<string, LCAvailableTools>;
    requestScopedConnections?: RequestScopedMCPConnectionStore;
    /** Serializable tool definitions for event-driven mode */
    toolDefinitions?: LCTool[];
    hasDeferredTools?: boolean;
    mcpToolAliases?: MCPToolAlias[];
    actionsEnabled?: boolean;
    /** Action tool names backed by OAuth — excluded from background dispatch. */
    oauthActionToolNames?: string[];
    /**
     * Pre-uploaded code-env file refs for the agent's
     * `tool_resources.execute_code`. Bubbled up so the run host can seed
     * `Graph.sessions[EXECUTE_CODE]` before the first tool call —
     * otherwise `_injected_files` is empty on call #1 and prior-turn
     * artifacts don't reach the sandbox.
     */
    primedCodeFiles?: import('@librechat/agents').CodeEnvFile[];
    /** Live workspace binding resolved by the execution-side loader. */
    codeExecutionContext?: CodeExecutionContext;
    repositoryInstructionSource?: RepositoryInstructionSource;
  } | null>;
  /** Endpoint option (contains model_parameters and endpoint info) */
  endpointOption?: Partial<TEndpointOption>;
  /** Set of allowed providers */
  allowedProviders: Set<string>;
  /** Whether this is the initial agent */
  isInitialAgent?: boolean;
  /** Accessible skill IDs for this user (pre-computed by the caller via ACL query) */
  accessibleSkillIds?: import('mongoose').Types.ObjectId[];
  /** Whether skill file authoring should be exposed even before a user has viewable skills. */
  skillAuthoringAvailable?: boolean;
  /** Whether the code execution environment is available (execute_code capability enabled) */
  codeEnvAvailable?: boolean;
  /**
   * Whether `file_search` is available to this caller — the capability AND the
   * `FILE_SEARCH` role grant. Read only when re-hydrating a conversation's
   * prior-turn files: `false` skips priming resources for a tool the loader will
   * drop anyway. Absent leaves priming unconditional, so a caller that has not
   * resolved the grant keeps its current behavior.
   */
  fileSearchAvailable?: boolean;
  /**
   * Resolves this caller's `WEB_SEARCH` role grant for provider-native web search.
   * Called only when the built provider config turns native search on, so an
   * agent without it costs no role read. Callers that reach `initializeAgent`
   * with `runtime` and no `req` — the OpenAI-compatible and Responses routes,
   * and the embedder surface in `agents/openai/service.ts` — pass one that joins
   * the grants their request already memoizes. Absent, the grant is resolved
   * from `db.getRoleByName`.
   */
  resolveWebSearchGrant?: () => Promise<boolean>;
  /**
   * Whether the `run_in_background` capability is enabled for this run. When
   * true, tools the agent opted in via `tool_options[name].run_in_background`
   * (plus the background-native code pair, unless explicitly opted out) get a
   * `run_in_background` schema param and the `check_background_task` poll
   * tool is registered.
   */
  backgroundToolsAvailable?: boolean;
  /**
   * Whether the `tool_intents` capability is enabled for this run. When true,
   * tools opted in via `tool_options[name].describe_intent` (native host
   * tools default on) get an `intent` string injected as the FIRST schema
   * property, rendered by the client as the call's live status label.
   */
  toolIntentsAvailable?: boolean;
  /** Whether stateful code sessions are available (stateful_code_sessions capability enabled) */
  statefulSessionsAvailable?: boolean;
  /** Explicit deployment allowlist for request types that do not carry LibreChat config on req. */
  allowedStatefulCodeEnvironments?: readonly StatefulCodeEnvironment[];
  /** Whether inline memory tools are available (memory capability enabled, memory
   *  configured, and the user permitted). When true and the agent lists the `memory`
   *  capability, `set_memory` + `delete_memory` are registered for the LLM. */
  memoryAvailable?: boolean;
  /** Per-user skill active/inactive overrides for filtering the skill catalog. */
  skillStates?: Record<string, boolean>;
  /** Admin-configured default for shared skills (`true` = shared skills auto-activate). */
  defaultActiveOnShare?: boolean;
  /**
   * Skill names the user invoked manually for this turn via the `$` popover.
   * Resolved here (ACL + active-state filtered) and attached to the returned
   * InitializedAgent as `manualSkillPrimes` for the AgentClient to inject as
   * meta user messages before the LLM call.
   */
  manualSkills?: string[];
}

/**
 * Database methods required for agent initialization
 * Most methods come from data-schemas via createMethods()
 * getConvoFiles not yet in data-schemas but included here for consistency
 */
export interface InitializeAgentDbMethods extends EndpointDbMethods {
  /**
   * Names of every MCP server the user can reach (operator config + user DB).
   * Consulted by the legacy-key heal ONLY when a configured name needs
   * normalization: collision detection must see user-DB servers, or healing a
   * raw key could produce a key that direct-first resolution routes to a
   * different (DB) server. Optional — without it the heal falls back to the
   * operator-config names.
   */
  getAccessibleMcpServerNames?: (userId?: string, role?: string) => Promise<string[]>;
  /** Update usage tracking for multiple files */
  updateFilesUsage: (
    files: Array<{ file_id: string }>,
    fileIds?: string[],
    options?: { user?: string; tenantId?: string | null },
  ) => Promise<unknown[]>;
  /** Get files from database */
  getFiles: (filter: unknown, sort: unknown, select: unknown) => Promise<unknown[]>;
  /** Filter files by agent access permissions (ownership or agent attachment) */
  filterFilesByAgentAccess?: TFilterFilesByAgentAccess;
  /** Get tool files by IDs (user-uploaded files only, code files handled separately) */
  getToolFilesByIds: (
    fileIds: string[],
    toolSet: Set<EToolResources>,
    ownerScope?: FileOwnerScope,
  ) => Promise<unknown[]>;
  /** Get conversation file IDs */
  getConvoFiles: (conversationId: string) => Promise<string[] | null>;
  /** Get code-generated files by conversation ID and the file_ids
   *  referenced from messages in the current thread (collected via
   *  `messages.files[].file_id` during thread walk). */
  getCodeGeneratedFiles?: (
    conversationId: string,
    threadFileIds?: string[],
    ownerScope?: FileOwnerScope,
  ) => Promise<unknown[]>;
  /** Get user-uploaded execute_code files by file IDs (from message.files in thread) */
  getUserCodeFiles?: (fileIds: string[], ownerScope: FileOwnerScope) => Promise<unknown[]>;
  getDeferredProvisionFiles?: (
    fileIds: string[],
    ownerScope: FileOwnerScope,
    resources?: {
      code?: boolean;
      search?: boolean;
      codeRouteKey?: string;
      searchNamespaces?: string[];
      hydrateProvisioned?: boolean;
    },
  ) => Promise<unknown[]>;
  /** Get messages for a conversation (supports select for field projection) */
  getMessages?: (
    filter: { conversationId: string },
    select?: string,
  ) => Promise<Array<{
    messageId: string;
    parentMessageId?: string;
    files?: Array<{ file_id: string }>;
  }> | null>;
  /** List skill summaries for catalog injection (paginated, omits body/frontmatter) */
  listSkillsByAccess?: TListSkillsByAccess;
  /** Load a single skill by name, constrained to an ACL-accessible ID set. */
  getSkillByName?: TGetSkillByName;
  /**
   * Load accessible skills with `alwaysApply: true`, eagerly including
   * `body` so the priming pipeline can splice at turn start without a
   * per-skill round-trip. Cursor-paginated so the resolver can fill its
   * active-state budget even when early-sorted rows are inactive for
   * the current user.
   */
  listAlwaysApplySkills?: (params: {
    accessibleIds: import('mongoose').Types.ObjectId[];
    limit: number;
    cursor?: string | null;
  }) => Promise<{
    skills: Array<{
      _id: import('mongoose').Types.ObjectId;
      name: string;
      body: string;
      author: import('mongoose').Types.ObjectId;
      allowedTools?: string[];
      /** True for deployment-directory skills that are loaded in memory. */
      deployment?: boolean;
    }>;
    has_more?: boolean;
    after?: string | null;
  }>;
  /** Optional: provision a file to the code execution environment */
  provisionToCodeEnv?: TProvisionToCodeEnv;
  /** Optional: provision a file to the vector DB for file_search */
  provisionToVectorDB?: TProvisionToVectorDB;
  /** Optional: batch-check code env file liveness */
  checkSessionsAlive?: TCheckSessionsAlive;
  /** Optional: load CODE_API_KEY once per request */
  loadCodeApiKey?: TLoadCodeApiKey;
  /** Optional: persist file metadata updates after provisioning */
  updateFile?: (data: TFileUpdate) => Promise<unknown>;
  /** Resolves a role by name for the tool role-permission grants. Optional: when
   *  absent the role half of the web-search gate is not applied. */
  getRoleByName?: CheckAccessParams['getRoleByName'];
}

/**
 * Initializes an agent for use in requests.
 * Handles file processing, tool loading, provider configuration, and context token calculations.
 *
 * This function is exported from @librechat/api and replaces the CJS version from
 * api/server/services/Endpoints/agents/agent.js
 *
 * @param params - Initialization parameters
 * @param deps - Optional dependency injection for testing
 * @returns Promise resolving to initialized agent with tools and configuration
 * @throws Error if agent provider is not allowed or if required dependencies are missing
 */
export async function initializeAgent(
  params: InitializeAgentParams,
  db?: InitializeAgentDbMethods,
): Promise<InitializedAgent> {
  const {
    agent,
    loadTools,
    requestFiles = [],
    authorizedRunFiles,
    conversationId,
    endpointOption,
    parentMessageId,
    requestBody,
    allowedProviders,
    isInitialAgent = false,
  } = params;
  const runtime =
    params.runtime ?? (params.req ? createRequestAgentExecutionContext(params.req) : null);
  if (runtime == null) {
    throw new Error('initializeAgent requires an explicit execution context');
  }
  const { user, appConfig } = runtime;
  const requestFileOwnerId = user?.id;
  const requestFileOwnerScope: FileOwnerScope | undefined = requestFileOwnerId
    ? { userId: requestFileOwnerId, tenantId: user?.tenantId }
    : undefined;

  if (!db) {
    throw new Error('initializeAgent requires db methods to be passed');
  }

  /**
   * Reject the stored agent definition before initialization performs usage
   * accounting, resource priming, tool/MCP loading, or provider setup. Inspect
   * definition fragments directly here: the raw agent may still contain
   * canonical file IDs that can only be validated after resource hydration.
   */
  let agentFragments: readonly TextContentFragment[] = [];
  let agentTraversalError: ContentTraversalLimitError | null = null;
  try {
    agentFragments = extractAgentContent(
      agent as unknown as Parameters<typeof extractAgentContent>[0],
    );
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    agentFragments = getContentTraversalFragments(error);
    agentTraversalError = error;
  }
  const agentDefinitionFinding = inspectContent(agentFragments, {
    filters: appConfig?.filters,
  });
  if (agentDefinitionFinding != null) {
    throw new ContentFilterError(agentDefinitionFinding);
  }
  if (
    agentTraversalError != null &&
    isContentTraversalProtected({
      error: agentTraversalError,
      filters: appConfig?.filters,
    })
  ) {
    throw agentTraversalError;
  }

  /**
   * Heal legacy MCP tool keys ONCE, before anything reads them: model-facing
   * keys embed the normalized server name (cache keys, definition names,
   * runtime instance names), so an agent document persisted with raw-named
   * keys would neither load those tools nor have any of its per-tool
   * `tool_options` honored. Every downstream consumer — the tool loader, the
   * defer/programmatic classification, the background and intent passes —
   * reads `agent.tools` / `agent.tool_options` after this point.
   */
  const configRawServerNames = Object.keys(appConfig?.mcpConfig ?? {});
  const configNeedsNormalization = configRawServerNames.some(
    (name) => normalizeServerName(name) !== name,
  );
  /**
   * Rewriting legacy keys requires a COMPLETE collision audit: the normalized
   * form of an operator name may belong to a user-DB server, and healing into
   * that key would route the tool to the wrong server. The audit therefore
   * uses the full accessible set — fetched lazily, once, and ONLY when a
   * configured name actually needs normalization AND the caller has
   * delimiter-bearing keys to heal (a non-MCP agent never pays the lookup).
   * When the audit cannot complete (no dep, or a transient failure), healing
   * is SKIPPED entirely: un-healed raw keys still resolve through the
   * direct-first candidates, so skipping is safe while rewriting is not.
   */
  let healNamesPromise: Promise<readonly string[] | null> | undefined;
  const resolveHealNames = (): Promise<readonly string[] | null> => {
    if (!configNeedsNormalization) {
      return Promise.resolve(configRawServerNames);
    }
    if (db.getAccessibleMcpServerNames == null) {
      return Promise.resolve(null);
    }
    healNamesPromise ??= db
      .getAccessibleMcpServerNames(user?.id, user?.role)
      /** The merged registry read tolerates config-server init failures and
       *  can silently omit config-only servers; the snapshot-derived config
       *  names restore them so the audit stays genuinely complete. */
      .then((names): readonly string[] => [...new Set([...names, ...configRawServerNames])])
      .catch((error): null => {
        logger.warn(
          '[initializeAgent] Failed to resolve accessible MCP server names; skipping legacy-key healing (collision audit unavailable):',
          error,
        );
        return null;
      });
    return healNamesPromise;
  };
  const hasMCPKeyCandidates =
    (agent.tools ?? []).some(
      (tool) => typeof tool === 'string' && tool.includes(Constants.mcp_delimiter),
    ) || Object.keys(agent.tool_options ?? {}).some((key) => key.includes(Constants.mcp_delimiter));
  /**
   * The COMPLETE audit set actually resolved this initialization — from the
   * agent-key heal or the skill-prime heal — threaded to the tool loader so
   * its collision guards neither repeat the lookup nor mistake the
   * operator-only list for a complete audit.
   */
  let resolvedAuditNames: readonly string[] | undefined;
  if (hasMCPKeyCandidates) {
    const mcpHealNames = await resolveHealNames();
    if (mcpHealNames != null) {
      resolvedAuditNames = mcpHealNames;
      const healedKeys = normalizeAgentToolKeys({
        tools: agent.tools ?? undefined,
        toolOptions: agent.tool_options,
        rawServerNames: mcpHealNames,
      });
      agent.tools = healedKeys.tools;
      agent.tool_options = healedKeys.toolOptions;
    }
  }

  if (
    isAgentsEndpoint(endpointOption?.endpoint) &&
    allowedProviders.size > 0 &&
    !allowedProviders.has(agent.provider)
  ) {
    throw new Error(
      `{ "type": "${ErrorTypes.INVALID_AGENT_PROVIDER}", "info": "${agent.provider}" }`,
    );
  }

  /**
   * Manual and always-apply skill resolution is read-only. Resolve and inspect
   * those exact model-bound skill bodies before file usage/resource priming or
   * tool loading, then reuse the results below when expanding allowed tools.
   */
  const hasSkillAccess = (params.accessibleSkillIds?.length ?? 0) > 0;
  const skillAuthoringAvailable = params.skillAuthoringAvailable === true;
  let manualSkillPrimes: ResolvedManualSkill[] | undefined;
  let alwaysApplySkillPrimes: ResolvedAlwaysApplySkill[] | undefined;
  let extraAllowedToolNames: string[] = [];
  let perSkillExtras: Map<string, string[]> = new Map();
  let resolvedSkillCatalog: ResolvedSkillCatalog | undefined;
  if (hasSkillAccess) {
    const [manualPrimesResult, alwaysApplyPrimesResult, catalogResult] = await Promise.all([
      params.manualSkills?.length && db.getSkillByName
        ? resolveManualSkills({
            names: params.manualSkills,
            getSkillByName: db.getSkillByName,
            accessibleSkillIds: params.accessibleSkillIds!,
            userId: user?.id,
            skillStates: params.skillStates,
            defaultActiveOnShare: params.defaultActiveOnShare,
          })
        : Promise.resolve<ResolvedManualSkill[] | undefined>(undefined),
      db.listAlwaysApplySkills
        ? resolveAlwaysApplySkills({
            listAlwaysApplySkills: db.listAlwaysApplySkills,
            accessibleSkillIds: params.accessibleSkillIds!,
            userId: user?.id,
            skillStates: params.skillStates,
            defaultActiveOnShare: params.defaultActiveOnShare,
          })
        : Promise.resolve<ResolvedAlwaysApplySkill[] | undefined>(undefined),
      hasActivePiiFields(appConfig?.filters?.skills?.pii, ['name', 'description'])
        ? resolveSkillCatalog({
            accessibleSkillIds: params.accessibleSkillIds!,
            listSkillsByAccess: db.listSkillsByAccess,
            userId: user?.id,
            skillStates: params.skillStates,
            defaultActiveOnShare: params.defaultActiveOnShare,
            maxCatalogSkills: getMaxCatalogSkills(runtime),
          })
        : Promise.resolve<ResolvedSkillCatalog | undefined>(undefined),
    ]);

    manualSkillPrimes = manualPrimesResult;
    alwaysApplySkillPrimes = alwaysApplyPrimesResult;
    resolvedSkillCatalog = catalogResult;

    const selectedPrimes = selectSkillPrimesForTurn({
      manualSkillPrimes: manualSkillPrimes ?? [],
      alwaysApplySkillPrimes: alwaysApplySkillPrimes ?? [],
    });
    if (selectedPrimes.alwaysApplyDedupedFromManual > 0) {
      logger.info(
        `[initializeAgent] Dropped ${selectedPrimes.alwaysApplyDedupedFromManual} always-apply prime(s) already present in the manual list; same-named skills prime only once per turn.`,
      );
    }
    if (selectedPrimes.alwaysApplyDropped > 0) {
      logger.warn(
        `[initializeAgent] Combined primes exceeds MAX_PRIMED_SKILLS_PER_TURN (${MAX_PRIMED_SKILLS_PER_TURN}); truncating ${selectedPrimes.alwaysApplyDropped} always-apply prime(s) so every initializer consumer sees the model-bound set.`,
      );
    }
    manualSkillPrimes = manualSkillPrimes == null ? undefined : selectedPrimes.manualSkillPrimes;
    alwaysApplySkillPrimes =
      alwaysApplySkillPrimes == null ? undefined : selectedPrimes.alwaysApplySkillPrimes;

    assertResolvedSkillContentAllowed(
      [
        ...(manualSkillPrimes ?? []),
        ...(alwaysApplySkillPrimes ?? []),
        ...(resolvedSkillCatalog?.activeSkills.filter(
          (skill) => skill.disableModelInvocation !== true,
        ) ?? []),
      ],
      appConfig?.filters,
    );
  }

  let currentFiles: Array<IMongoFile | TFile> | undefined;

  const _modelOptions = structuredClone(
    Object.assign(
      { model: agent.model },
      agent.model_parameters ?? { model: agent.model },
      isInitialAgent === true ? endpointOption?.model_parameters : {},
    ),
  );

  const { resendFiles, maxContextTokens, imageDetail, modelOptions } = extractLibreChatParams(
    _modelOptions as Record<string, unknown>,
  );

  const provider = agent.provider;
  agent.endpoint = provider;

  /** Settle the provider and its client options before any attachment is judged. The file
   * policy reads the endpoint's own name, but the route each attachment takes also depends on
   * the backing client and on the Responses API decision `getOptions` makes, and nothing
   * between here and tool loading feeds either. */
  const { getOptions, overrideProvider, customEndpointConfig } = getProviderConfig({
    provider,
    appConfig,
  });
  if (overrideProvider !== agent.provider) {
    agent.provider = overrideProvider;
  }

  const finalModelOptions = {
    ...modelOptions,
    model: agent.model,
  };

  const options: InitializeResultBase = await getOptions({
    runtime: {
      appConfig,
      user,
      requestBody: runtime.requestBody,
    },
    endpoint: provider,
    model_parameters: finalModelOptions,
    db,
  });

  const llmConfig = options.llmConfig as Record<string, unknown>;
  const webSearchDenied =
    hasProviderWebSearch(options.tools, llmConfig) &&
    !(await resolveWebSearchGrant({
      req: params.req as Request | undefined,
      user,
      resolve: params.resolveWebSearchGrant,
      getRoleByName: db.getRoleByName,
    }));
  if (webSearchDenied && stripWebSearchPlugin(llmConfig) > 0) {
    logger.debug(
      `[initializeAgent] Removed the OpenRouter web search plugin; role denies WEB_SEARCH.`,
    );
  }
  const tokensModel =
    agent.provider === EModelEndpoint.azureOpenAI ? agent.model : (llmConfig?.model as string);
  const maxOutputTokens = optionalChainWithEmptyCheck(
    llmConfig?.maxOutputTokens as number | undefined,
    llmConfig?.maxTokens as number | undefined,
    0,
  );
  const agentMaxContextTokens = optionalChainWithEmptyCheck(
    maxContextTokens,
    getModelMaxTokens(
      tokensModel ?? '',
      providerEndpointMap[overrideProvider as keyof typeof providerEndpointMap],
      options.endpointTokenConfig,
    ),
    DEFAULT_MAX_CONTEXT_TOKENS,
  );

  if (
    agent.endpoint === EModelEndpoint.azureOpenAI &&
    (llmConfig?.azureOpenAIApiInstanceName as string | undefined) == null
  ) {
    agent.provider = Providers.OPENAI;
  }

  if (options.provider != null) {
    agent.provider = options.provider;
  }

  const deliveryRouting = resolveTurnDeliveryRouting({
    agent: {
      provider: agent.provider,
      endpoint: agent.endpoint,
      model_parameters: {
        useResponsesApi:
          typeof llmConfig.useResponsesApi === 'boolean' ? llmConfig.useResponsesApi : undefined,
      },
    },
    config: appConfig,
  });

  /** Resolve the per-agent Code API route before resource/tool priming. A
   * stateful agent must perform freshness checks and recovery uploads against
   * the same isolated deployment its eventual `/exec` request will use. */
  const agentRequestsCodeExec = (agent.tools ?? []).includes(Tools.execute_code);
  const configuredCodeEnvironments =
    appConfig?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments;
  const attachedEnvironmentOptOut = optsOutOfAttachedCodeEnvironment(
    agent,
    requestBody,
    configuredCodeEnvironments,
    isImplicitStatefulCodeRouteAvailable(
      process.env.CODE_ENVIRONMENT_DECISION_VERSION,
      process.env.LIBRECHAT_CODE_BASEURL_STATEFUL,
    ),
  );
  const effectiveCodeEnvAvailable =
    params.codeEnvAvailable === true && agentRequestsCodeExec && !attachedEnvironmentOptOut;
  const effectiveStatefulSessions =
    effectiveCodeEnvAvailable &&
    params.statefulSessionsAvailable === true &&
    agent.stateful_code_sessions === true;
  const statefulCodeEnvironment = normalizeStatefulCodeEnvironment(agent.stateful_code_environment);
  if (effectiveStatefulSessions) {
    const allowedStatefulCodeEnvironments = resolveAllowedStatefulCodeEnvironments(
      params.allowedStatefulCodeEnvironments ??
        appConfig?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.allowedEnvironments,
    );
    if (!allowedStatefulCodeEnvironments.includes(statefulCodeEnvironment)) {
      throw createStatefulCodeEnvironmentPolicyError(statefulCodeEnvironment);
    }
  }
  const codeExecutionContext = resolveCodeExecutionContext({
    statefulSessions: effectiveStatefulSessions,
    environment: statefulCodeEnvironment,
    environmentId: agent.code_environment_id,
    environments: configuredCodeEnvironments,
    userId: requestFileOwnerId,
    agentId: agent.id,
    conversationId,
  });
  const attachedWorkspaceTools =
    effectiveCodeEnvAvailable && codeExecutionContext.environmentType === 'attached';
  const requestFileIds = [
    ...new Set(
      requestFiles
        .map((file) => file.file_id)
        .filter((fileId): fileId is string => typeof fileId === 'string' && fileId.length > 0),
    ),
  ];
  const toolFileIds: string[] = [];
  /** Earlier-turn attachments still awaiting provisioning; provisioning input only. */
  let deferredProvisionFiles: IMongoFile[] = [];
  let deferredProvisionFileIds: string[] = [];

  /** Build the role-gated resource set from the agent and its effective skills. */
  const resourceToolNames = [...(agent.tools ?? [])];
  /* A skill's allowed-tools can contribute file_search or execute_code that the agent
   * itself does not list. Eligibility has to reflect the effective tool set, or invoking
   * the skill's tool searches or runs code with nothing provisioned. The primes are
   * resolved above, so this needs no reordering, and the MCP name heal applied to the
   * union later never rewrites these plain resource names. */
  for (const prime of [...(manualSkillPrimes ?? []), ...(alwaysApplySkillPrimes ?? [])]) {
    for (const tool of prime.allowedTools ?? []) {
      resourceToolNames.push(tool);
    }
  }
  const toolResourceSet = resolveResendToolResources({
    tools: resourceToolNames,
    codeEnvAvailable: params.codeEnvAvailable === true && !attachedEnvironmentOptOut,
    fileSearchAvailable: params.fileSearchAvailable,
  });
  let runtimeToolResources = agent.tool_resources;
  if (attachedEnvironmentOptOut && runtimeToolResources != null) {
    runtimeToolResources = { ...runtimeToolResources };
    delete runtimeToolResources[EToolResources.execute_code];
  }

  /**
   * Load conversation files for ALL agents, not just the initial agent.
   * This enables handoff agents to access files that were uploaded earlier
   * in the conversation. Without this, file_search and execute_code tools
   * on handoff agents would fail to find previously attached files.
   */
  /* `resendFiles` governs whether earlier attachments are sent to the model again, so
   * it gates the delivery queries below. Deferred provisioning candidates are already
   * excluded from delivery, and a sandbox or search call still needs its inputs, so
   * that lookup runs whichever way the setting is configured. */
  const wantsCodeFiles = toolResourceSet.has(EToolResources.execute_code);
  const wantsSearchFiles = toolResourceSet.has(EToolResources.file_search);
  const fileConsumers: TurnFileConsumers = {
    executeCode: wantsCodeFiles,
    fileSearch: wantsSearchFiles,
  };
  const wantsProvisioning = wantsCodeFiles || wantsSearchFiles;

  if (
    authorizedRunFiles === undefined &&
    conversationId != null &&
    (resendFiles || wantsProvisioning)
  ) {
    const getThreadMessages = db.getMessages;
    /** Falsy anchors cannot match a parent chain, so they get no walk. */
    const threadAnchor =
      parentMessageId && parentMessageId !== Constants.NO_PARENT ? parentMessageId : null;
    /* Either provisioning resource needs the anchor: deferred attachments for
     * file_search are found by thread file ids just as code files are. */
    const needsThreadWalk = wantsProvisioning && threadAnchor != null && getThreadMessages != null;

    /**
     * The conversation's file refs and the thread walk share no inputs, so they resolve
     * together. Both gate the model call, and this runs on every turn — each serialized
     * round trip here is time-to-first-token the user waits through.
     *
     * Thread walk selects only the fields traversal needs. Both `files` (user uploads)
     * and `attachments` (code-execution outputs from `processCodeOutput`) carry the
     * `file_id` refs the next turn must prime — selecting only `files` silently drops
     * every code-output ref.
     */
    const [convoFileIds, threadMessages] = await Promise.all([
      readResolvedConversationFiles(runtime, conversationId) ?? db.getConvoFiles(conversationId),
      needsThreadWalk && getThreadMessages
        ? getThreadMessages({ conversationId }, 'messageId parentMessageId files attachments')
        : null,
    ]);
    const fileIds = convoFileIds ?? [];

    /** Walk the parent chain and collect file_ids referenced by
     *  any message in the thread (`messages.files[].file_id` +
     *  `messages.attachments[].file_id`). Used as the primary
     *  anchor for both `getCodeGeneratedFiles` and
     *  `getUserCodeFiles` — message ids no longer needed at
     *  this layer. */
    const threadFileIds =
      threadMessages && threadMessages.length > 0
        ? getThreadData(threadMessages, threadAnchor).fileIds
        : undefined;

    /* Linear continuation APIs supply no anchor: the Responses API always continues via
     * `previous_response_id`, and chat completions may send `conversation_id` alone. There
     * is no branch to walk in either case, so the conversation's own file refs are both the
     * correct scope and the only one available. Without this the deferred lookup never runs
     * there, and a later code or search call executes without the attachment.
     *
     * An anchored walk keeps its own result even when empty. Widening a branch that
     * references no files to the whole conversation would provision a sibling branch's
     * attachments, sending files this branch never mentioned to the Code API or RAG. */
    const provisionFileIds = threadAnchor == null ? fileIds : (threadFileIds ?? []);

    /**
     * Retrieve execute_code files filtered to the current thread.
     * This includes both code-generated files and user-uploaded execute_code files.
     *
     * Code-generated and user-uploaded execute_code files share the same primary anchor:
     * file_ids referenced by messages in the current thread. The two queries differ only
     * by `context` (`execute_code` for generated outputs, others for uploads). Anchoring
     * both on `threadFileIds` reaches files regardless of which sibling first generated
     * them — see `getCodeGeneratedFiles` for the branched-conversation rationale.
     */
    /* Attachments accepted on an earlier turn whose tool never ran are absent from the
     * three queries below, since those match only files that already carry the result
     * of provisioning. Fetched alongside them, not after: it is independent of all
     * three, and this runs on the agent initialization path. */
    const [toolFiles, codeGeneratedFiles, userCodeFiles, deferredFiles] = await Promise.all([
      resendFiles && requestFileOwnerScope
        ? (db.getToolFilesByIds(fileIds, toolResourceSet, requestFileOwnerScope) as Promise<
            IMongoFile[]
          >)
        : ([] as IMongoFile[]),
      resendFiles && wantsCodeFiles && db.getCodeGeneratedFiles && requestFileOwnerScope
        ? (db.getCodeGeneratedFiles(
            conversationId,
            threadFileIds,
            requestFileOwnerScope,
          ) as Promise<IMongoFile[]>)
        : ([] as IMongoFile[]),
      resendFiles &&
      wantsCodeFiles &&
      db.getUserCodeFiles &&
      requestFileOwnerScope &&
      threadFileIds &&
      threadFileIds.length > 0
        ? (db.getUserCodeFiles(threadFileIds, requestFileOwnerScope) as Promise<IMongoFile[]>)
        : ([] as IMongoFile[]),
      wantsProvisioning &&
      db.getDeferredProvisionFiles &&
      requestFileOwnerScope &&
      provisionFileIds.length > 0
        ? (db.getDeferredProvisionFiles(provisionFileIds, requestFileOwnerScope, {
            code: wantsCodeFiles,
            search: wantsSearchFiles,
            codeRouteKey:
              codeExecutionContext.executionRouteKey ?? codeExecutionContext.executionProfile,
            /* Both namespaces an attachment can be embedded under this turn: this agent's,
             * for its own resource files, and the user's for everything else. */
            searchNamespaces: [agent.id, requestFileOwnerId].filter(
              (id): id is string => typeof id === 'string',
            ),
            /* With resendFiles on, getToolFilesByIds already loads provisioned files and
             * both priming and the staleness probe see them. Off, this query is the only
             * one that runs, for search as well as for code. */
            hydrateProvisioned: !resendFiles,
          }) as Promise<IMongoFile[]>)
        : ([] as IMongoFile[]),
    ]);

    /* Ids only: these are hydrated with the request's own files below so the same
     * content policy applies before their bytes can reach the Code API or RAG. They
     * are kept out of the delivery set, not out of inspection. */
    deferredProvisionFileIds = deferredFiles
      .map((file) => file.file_id)
      .filter((fileId): fileId is string => typeof fileId === 'string');

    const allToolFiles = toolFiles.concat(codeGeneratedFiles, userCodeFiles);
    const snapshotFileIds = new Set(requestFileIds);
    for (const file of allToolFiles) {
      if (typeof file.file_id !== 'string' || snapshotFileIds.has(file.file_id)) {
        continue;
      }
      snapshotFileIds.add(file.file_id);
      toolFileIds.push(file.file_id);
    }
  }

  /**
   * Hydrate the complete candidate set through one owner-scoped, read-only
   * query. Some discovery queries intentionally omit file text; this snapshot
   * includes the content fields needed by policy checks. `updateFilesUsage`
   * both mutates usage and returns hydrated rows, so it cannot be the hydrator:
   * keep this exact snapshot authoritative for inspection, priming, and the
   * later usage update to avoid a post-inspection re-read.
   */
  const snapshotFileIds = [...requestFileIds, ...toolFileIds, ...deferredProvisionFileIds];
  let requestUsageFiles: IMongoFile[] = [];
  let toolUsageFiles: IMongoFile[] = [];
  if (authorizedRunFiles === undefined && requestFileOwnerScope && snapshotFileIds.length > 0) {
    const hydratedFiles =
      ((await db.getFiles(
        {
          file_id: { $in: snapshotFileIds },
          user: requestFileOwnerScope.userId,
          ...(requestFileOwnerScope.tenantId != null && {
            tenantId: requestFileOwnerScope.tenantId,
          }),
        },
        {},
        {},
      )) as IMongoFile[] | null) ?? [];
    const hydratedFilesById = new Map(
      hydratedFiles
        .filter((file) => snapshotFileIds.includes(file.file_id))
        .map((file) => [file.file_id, file]),
    );
    requestUsageFiles = requestFileIds
      .map((fileId) => hydratedFilesById.get(fileId))
      .filter((file): file is IMongoFile => file != null);
    toolUsageFiles = toolFileIds
      .map((fileId) => hydratedFilesById.get(fileId))
      .filter((file): file is IMongoFile => file != null);
    deferredProvisionFiles = deferredProvisionFileIds
      .map((fileId) => hydratedFilesById.get(fileId))
      .filter((file): file is IMongoFile => file != null);
  }
  if (authorizedRunFiles !== undefined) {
    for (const file of authorizedRunFiles) {
      if (
        file.user !== requestFileOwnerId ||
        (file.tenantId ?? null) !== (user?.tenantId ?? null)
      ) {
        throw new Error('Run file inputs do not match the authenticated owner');
      }
    }
    currentFiles = authorizedRunFiles.map((file) => structuredClone(file));
  } else if (requestFiles.length > 0 || toolFileIds.length > 0) {
    currentFiles = requestUsageFiles.concat(toolUsageFiles);
  }
  if (currentFiles?.length) {
    /* Before any check reads the route: endpoint filtering, model-bound limits and content
     * inspection below all have to judge each file by the route this turn delivers it by. */
    currentFiles = applyTurnDelivery(currentFiles, {
      routing: deliveryRouting,
      consumers: fileConsumers,
    });
  }

  let endpointFileType: EModelEndpoint | undefined;
  if (!paramEndpoints.has(agent.endpoint ?? '')) {
    endpointFileType = EModelEndpoint.custom;
  }
  if ((currentFiles && currentFiles.length) || deferredProvisionFiles.length > 0) {
    const endpointType = endpointFileType;

    currentFiles = filterFilesByEndpointRuntimeConfig(appConfig, {
      files: currentFiles,
      endpoint: agent.endpoint ?? '',
      endpointType,
      skipTotalSizeLimit: true,
      preserveTextSources: true,
    });
    const requestUsageFileIds = new Set(
      (authorizedRunFiles ?? requestUsageFiles).map((file) => file.file_id),
    );
    assertAgentAttachmentLimits({
      attachments: currentFiles.filter(
        (file) => requestUsageFileIds.has(file.file_id) && isModelBoundAttachmentFile(file),
      ),
      fileConfig: appConfig?.fileConfig,
      endpoint: agent.endpoint ?? '',
      endpointType,
    });

    /* The same endpoint configuration governs both paths. A file this endpoint refuses
     * by size, MIME type, or a files-disabled setting must not reach the Code API or
     * RAG through provisioning just because it left the delivery set. */
    if (deferredProvisionFiles.length > 0) {
      /* One request, one total-size allowance. Filtering each set from zero would let a
       * delivery attachment and a provisioning candidate that each fit alone exceed the
       * limit together once withDeferredCandidates merges them.
       *
       * A file can appear in both sets, an embedded attachment still missing the active
       * code route being the case in point, and the merge deduplicates afterwards. Charging
       * it twice would spend an allowance the request never uses and drop a different
       * candidate that fits, so the shared ones are counted once. */
      const deferredFileIds = new Set(
        deferredProvisionFiles
          .map((file) => file.file_id)
          .filter((fileId): fileId is string => fileId != null),
      );
      deferredProvisionFiles = filterFilesByEndpointRuntimeConfig(appConfig, {
        files: deferredProvisionFiles,
        endpoint: agent.endpoint ?? '',
        endpointType,
        /* The deferred pass charges its own list as it walks it, so a file in both sets
         * is counted there. Only what delivery spends on files the deferred pass will
         * not see is carried in. */
        consumedBytes: sumUniqueBytes(
          (currentFiles ?? []).filter(
            (file) => file.file_id == null || !deferredFileIds.has(file.file_id),
          ),
        ),
      }) as IMongoFile[];
    }
  }

  assertModelBoundContent({
    filters: appConfig?.filters,
    files: currentFiles,
  });

  /* Provisioning candidates are inspected under the same policy before their bytes can
   * be sent to the Code API or RAG. A violator is dropped rather than failing the turn:
   * these were not attached by this request, and before deferred hydration existed they
   * were simply absent, so refusing the conversation over a historical record would be
   * a harsher outcome than the one this change replaced. */
  if (deferredProvisionFiles.length > 0) {
    deferredProvisionFiles = deferredProvisionFiles.filter((file) => {
      try {
        assertModelBoundContent({ filters: appConfig?.filters, files: [file] });
        return true;
      } catch (error) {
        logger.warn(
          `[initializeAgent] Skipping provisioning for "${file.filename}" (${file.file_id}): content policy`,
          getSafeErrorMetadata(error),
        );
        return false;
      }
    });
  }

  /**
   * Usage accounting is the first file mutation. It runs only after every
   * hydrated file in the exact snapshot above has passed endpoint filtering
   * and current content policy checks. Ignore returned rows so priming cannot
   * observe a different post-inspection snapshot.
   */
  if (requestFileOwnerId && requestUsageFiles.length > 0) {
    await db.updateFilesUsage(requestUsageFiles, undefined, {
      user: requestFileOwnerId,
      tenantId: user?.tenantId,
    });
  }
  if (requestFileOwnerId && toolUsageFiles.length > 0) {
    await db.updateFilesUsage(toolUsageFiles, undefined, {
      user: requestFileOwnerId,
      tenantId: user?.tenantId,
    });
  }

  const {
    attachments: primedAttachments,
    requestAttachments: primedRequestAttachments,
    agentContextAttachments: primedAgentContextAttachments,
    tool_resources,
    provisionState,
    warnings: provisionWarnings,
  } = await primeResources({
    req: params.req,
    principal: user,
    getFiles: db.getFiles as never,
    filterFiles: db.filterFilesByAgentAccess,
    appConfig,
    agentId: agent.id,
    attachments: currentFiles
      ? (Promise.resolve(currentFiles) as unknown as Promise<TFile[]>)
      : undefined,
    tool_resources: runtimeToolResources,
    requestFileSet: new Set((authorizedRunFiles ?? requestFiles).map((file) => file.file_id)),
    enabledToolResources: toolResourceSet,
    checkSessionsAlive: db.checkSessionsAlive,
    loadCodeApiKey: db.loadCodeApiKey,
    provisionCandidates: deferredProvisionFiles as unknown as TFile[],
    codeRouteKey: codeExecutionContext.executionRouteKey ?? codeExecutionContext.executionProfile,
    codeBaseUrl: codeExecutionContext.baseUrl,
    screenPersistentFiles: (files) => {
      /* Persistent agent files are read inside primeResources, so they miss both checks
       * the caller already applied to this turn's other files. They face the same
       * endpoint policy under the remainder of the one total-size allowance the current
       * and deferred sets have already drawn on, and the same content policy, which can
       * have changed since the file was attached. */
      const committedFiles = [...(currentFiles ?? []), ...deferredProvisionFiles];
      const { committed, pending } = partitionCommittedFiles(files, committedFiles);
      const withinPolicy = filterFilesByEndpointRuntimeConfig(appConfig, {
        files: pending as unknown as IMongoFile[],
        endpoint: agent.endpoint ?? '',
        endpointType: endpointFileType,
        consumedBytes: sumUniqueBytes(committedFiles),
      }) as unknown as TFile[];

      /* Dropped rather than fatal, matching the deferred candidates: these were not
       * attached by this request, so refusing the conversation over a historical record
       * would be harsher than leaving it out. */
      return committed.concat(withinPolicy).filter((file) => {
        try {
          assertModelBoundContent({
            filters: appConfig?.filters,
            files: [file] as unknown as IMongoFile[],
          });
          return true;
        } catch (error) {
          logger.warn(
            `[initializeAgent] Skipping persistent agent file "${file.filename}" (${file.file_id}): content policy`,
            error,
          );
          return false;
        }
      });
    },
  });

  /**
   * Pre-resolve manually-invoked + always-apply skill primes so their
   * `allowed-tools` can be unioned into the agent's effective tool set
   * BEFORE `loadTools` runs. Single load is correctness-critical: a
   * second `loadTools` pass would compute its own `userMCPAuthMap` /
   * `toolContextMap` / OAuth flow state that the InitializedAgent never
   * sees, so an MCP tool added via `allowed-tools` would be visible to
   * the model but fail at execution time without its per-user auth
   * context.
   *
   * Resolution uses `params.accessibleSkillIds` (not the active-filtered
   * subset that `injectSkillCatalog` will produce later) — see
   * `resolveManualSkills` doc for why a skill outside the catalog cap can
   * still be authorizable for direct manual invocation.
   *
   * Manual + always-apply primes feed the same `unionPrimeAllowedTools`
   * call — the helper is pure / set-based, so concatenating the two
   * lists gives the right union with no double-counting. Manual primes
   * go first so their names win on dedup (primes earlier in the list
   * contribute before the same name gets deduped on a later prime).
   */
  if (hasSkillAccess) {
    /** Skill `allowed-tools` are legacy-heal candidates too: a raw MCP key
     *  declared before the normalized-key convention would neither dedupe
     *  against the healed agent tools nor match the normalized-keyed tool
     *  map, silently dropping the skill-contributed tool. Same lazy audit
     *  and skip-on-unavailable semantics as the agent-key heal. */
    const combinedPrimes = [...(manualSkillPrimes ?? []), ...(alwaysApplySkillPrimes ?? [])];
    const primesNeedHeal = combinedPrimes.some((prime) =>
      prime.allowedTools?.some((name) => name.includes(Constants.mcp_delimiter)),
    );
    const primeHealNames = primesNeedHeal ? await resolveHealNames() : null;
    if (primeHealNames != null) {
      resolvedAuditNames = primeHealNames;
    }
    const primesForUnion =
      primeHealNames != null
        ? combinedPrimes.map((prime) =>
            prime.allowedTools?.length
              ? {
                  ...prime,
                  allowedTools: normalizeAgentToolKeys({
                    tools: prime.allowedTools,
                    toolOptions: undefined,
                    rawServerNames: primeHealNames,
                  }).tools,
                }
              : prime,
          )
        : combinedPrimes;
    if (primesForUnion.length > 0) {
      const union = unionPrimeAllowedTools({
        primes: primesForUnion,
        agentToolNames: agent.tools ?? [],
      });
      extraAllowedToolNames = union.extraToolNames;
      perSkillExtras = union.perSkillExtras;
    }
  }

  const baseToolNames = agent.tools ?? [];
  const requestedToolNames =
    extraAllowedToolNames.length > 0 ? [...baseToolNames, ...extraAllowedToolNames] : baseToolNames;

  /**
   * `loadTools` failures take two forms:
   *   1. The wrapper throws — rare; only when something around the
   *      try/catch in `createToolLoader` itself fails.
   *   2. The wrapper returns `undefined` — the typical CJS path for errors
   *      that remain soft-failures. Runtime loaders rethrow invariant
   *      failures such as an explicitly configured MCP tool set resolving
   *      to zero, but preserve the legacy `undefined` result for unrelated
   *      failures. Without explicit handling, the empty
   *      fallback object below would silently drop the agent's baseline
   *      tools for the turn (not just the skill-added extras).
   *
   * If a skill-contributed `allowed-tools` entry is the culprit, retry
   * with just `agent.tools` so the agent's own tools still load (the
   * dropped-tools debug log below picks up which extras vanished). If
   * the retry-without-extras also fails, propagate / fall through with
   * the empty fallback — the agent's own tools are the problem.
   */
  const callLoadTools = async (tools: string[]) =>
    loadTools?.({
      provider,
      agentId: agent.id,
      tools,
      model: agent.model,
      tool_options: agent.tool_options,
      tool_resources,
      requestBody,
      codeExecutionContext,
      accessibleMcpServerNames: resolvedAuditNames,
    });

  let loadToolsResult;
  const initialFailedSilently = (result: unknown) =>
    result == null && extraAllowedToolNames.length > 0;
  try {
    loadToolsResult = await callLoadTools(requestedToolNames);
  } catch (err) {
    if (
      isFatalAgentInitializationError(err, {
        signal: params.signal,
        allowExpectedMCPFallback: true,
      })
    ) {
      throw err;
    }
    if (extraAllowedToolNames.length > 0) {
      logger.warn(
        `[allowedTools] loadTools threw with ${extraAllowedToolNames.length} skill-added extra(s); retrying without them`,
        { errorName: err instanceof Error ? err.name : 'UnknownError' },
      );
      loadToolsResult = await callLoadTools(baseToolNames);
    } else {
      throw err;
    }
  }
  if (initialFailedSilently(loadToolsResult)) {
    /* Runtime loaders may swallow non-invariant errors and return undefined. Treat that
       the same as a throw when extras were requested — the agent's own
       tools must still load. */
    logger.warn(
      `[allowedTools] loadTools returned no result with ${extraAllowedToolNames.length} skill-added extra(s); retrying without them.`,
    );
    loadToolsResult = await callLoadTools(baseToolNames);
  }

  const {
    toolRegistry,
    toolContextMap,
    dynamicToolContextMap,
    userMCPAuthMap,
    toolDefinitions: loadedToolDefinitions,
    mcpAvailableTools,
    requestScopedConnections,
    hasDeferredTools,
    mcpToolAliases,
    actionsEnabled,
    oauthActionToolNames,
    tools: structuredTools,
    primedCodeFiles,
    codeExecutionContext: loadedCodeExecutionContext,
    repositoryInstructionSource,
  } = loadToolsResult ?? {
    tools: [],
    toolContextMap: {},
    dynamicToolContextMap: {},
    userMCPAuthMap: undefined,
    toolRegistry: undefined,
    mcpAvailableTools: undefined,
    requestScopedConnections: undefined,
    toolDefinitions: [],
    hasDeferredTools: false,
    mcpToolAliases: [],
    actionsEnabled: undefined,
    oauthActionToolNames: undefined,
    primedCodeFiles: undefined,
    codeExecutionContext: undefined,
    repositoryInstructionSource: undefined,
  };
  const trustedCodeExecutionContext = loadedCodeExecutionContext ?? codeExecutionContext;
  const attachedWorkspaceOperations =
    trustedCodeExecutionContext.environmentType === 'attached'
      ? new Set(trustedCodeExecutionContext.codeWorkspace?.operations ?? [])
      : undefined;
  const attachedWorkspaceCommandTimeoutMaxMs =
    trustedCodeExecutionContext.environmentType === 'attached'
      ? resolveAttachedWorkspaceCommandTimeoutMax(
          trustedCodeExecutionContext.codeEnvironmentConfigSchema,
          trustedCodeExecutionContext.codeWorkspace?.maxCommandTimeoutMs,
        )
      : undefined;
  if (
    attachedWorkspaceOperations &&
    !attachedWorkspaceOperations.has('preview_edit') &&
    hasActiveFileFieldPolicy(appConfig?.filters, ['content', 'extracted_text'])
  ) {
    attachedWorkspaceOperations.delete('edit_file');
  }

  let toolDefinitions = loadedToolDefinitions;

  /**
   * Tolerant filter: anything `loadTools` couldn't resolve (capability
   * disabled, plugin missing, name unknown to the registry) is silently
   * dropped with an attributed debug log. Cross-ecosystem skills authored
   * against tools LibreChat hasn't shipped yet (Claude Code's `edit_file`,
   * etc.) import without breaking — they light up automatically once
   * support lands. Skips when there were no extras to begin with.
   */
  if (extraAllowedToolNames.length > 0) {
    const loadedNames = new Set((toolDefinitions ?? []).map((d) => d.name));
    const dropped = extraAllowedToolNames.filter((n) => !loadedNames.has(n));
    if (dropped.length > 0) {
      logger.debug(
        `[allowedTools] Dropped ${dropped.length} unrecognized tool name(s) from ${perSkillExtras.size} skill(s)`,
      );
    }
  }

  /**
   * Unify code-execution tools around `bash_tool` + `read_file` when the
   * agent explicitly lists `execute_code` in its tools and the admin
   * capability is enabled for the run. The legacy `execute_code` tool
   * (backed by `CodeExecutionToolDefinition` + `primeCodeFiles`) is no
   * longer registered; the string `execute_code` on the agent document
   * stays as the capability-trigger marker but expands into the
   * `bash_tool` + `read_file` pair here. The initial `read_file`
   * definition is code-only; `injectSkillCatalog` upgrades it later in
   * this initializer when skill files are actually available.
   *
   * `effectiveCodeEnvAvailable` is the per-agent truth: the admin-level
   * `params.codeEnvAvailable` AND the agent actually asking for code
   * execution. Computed once and reused by the expansion block below,
   * the `injectSkillCatalog` call, and the returned `InitializedAgent`.
   * Downstream handlers (runtime `configurable`, `primeInvokedSkills`)
   * read it from the stored per-agent value so a skills-only agent
   * never accidentally registers `bash_tool` or primes sandbox files
   * just because the admin globally enabled code execution.
   *
   * Done before provider-tool merging so execute-code-only agents on
   * Google/Vertex still surface as external function definitions when
   * provider-specific tools are also configured. Also before
   * `injectSkillCatalog` so the skill path's own
   * `registerCodeExecutionTools` call upgrades `read_file` from the
   * code-only description to the skill-aware description without adding a
   * duplicate — exactly one copy of each tool reaches the LLM.
   */
  /**
   * Capability marker → definition names its registration produced this run,
   * reported by the registrars themselves. `tool_options` entries keyed by a
   * marker (`execute_code`, `memory`, `skills`) — from a model-spec selection
   * or a hand-edited saved agent — resolve onto exactly these names in the
   * background/intent passes, so the projection cannot drift from what
   * actually got registered.
   */
  const capabilityToolNames = new Map<string, readonly string[]>();
  const recordCapabilityToolNames = (capability: string, toolNames: readonly string[]): void => {
    if (toolNames.length === 0) {
      return;
    }
    const existing = capabilityToolNames.get(capability);
    capabilityToolNames.set(capability, existing ? [...existing, ...toolNames] : toolNames);
  };
  if (effectiveCodeEnvAvailable) {
    const codeExecResult = registerCodeExecutionTools({
      toolRegistry,
      toolDefinitions,
      includeBash: true,
      includeSkillFileInstructions: false,
      enableToolOutputReferences: effectiveCodeEnvAvailable,
      statefulSessions: effectiveStatefulSessions,
      workspaceTools: attachedWorkspaceTools,
      workspaceOperations: attachedWorkspaceOperations,
      workspaceCommandTimeoutMaxMs: attachedWorkspaceCommandTimeoutMaxMs,
      workspaceEnvironment: trustedCodeExecutionContext.codeWorkspace?.environment,
    });
    toolDefinitions = codeExecResult.toolDefinitions;
    recordCapabilityToolNames(AgentCapabilities.execute_code, codeExecResult.toolNames);
  } else if (agentRequestsCodeExec) {
    /**
     * Agent asked for `execute_code` but the admin-level gate is off —
     * surface a debug log so operators tracing "why isn't code
     * interpreter working?" get a clear signal. The event-driven tool
     * loader (`loadToolDefinitionsWrapper`) doesn't log capability-
     * disabled warnings for the definitions-only path, so without this,
     * the tool silently vanishes from the LLM's definitions with no trace.
     */
    logger.debug(
      `[initializeAgent] Agent "${agent.id}" requests execute_code but codeEnvAvailable=${String(params.codeEnvAvailable)}; skipping bash_tool + read_file registration.`,
    );
  }

  /**
   * Expand the `memory` capability marker into the inline `set_memory` +
   * `delete_memory` tool pair, mirroring the `execute_code` expansion above.
   * `params.memoryAvailable` is the full run-level gate (capability enabled,
   * memory configured, user permitted); the marker on `agent.tools` is the
   * per-agent opt-in. The runtime instances are created in the tool service.
   */
  const agentRequestsMemory = (agent.tools ?? []).includes(Tools.memory);
  const inlineMemoryRegistered = params.memoryAvailable === true && agentRequestsMemory;
  if (inlineMemoryRegistered) {
    const memoryResult = registerMemoryTools({
      toolRegistry,
      toolDefinitions,
      validKeys: appConfig?.memory?.validKeys,
    });
    toolDefinitions = memoryResult.toolDefinitions;
    recordCapabilityToolNames(AgentCapabilities.memory, memoryResult.toolNames);
    appendAdditionalInstructions(agent, memoryToolUsageGuard);
  } else if (agentRequestsMemory) {
    logger.debug(
      `[initializeAgent] Agent "${agent.id}" requests memory but memoryAvailable=${String(params.memoryAvailable)}; skipping set_memory + delete_memory registration.`,
    );
  }

  if (skillAuthoringAvailable) {
    const skillReadResult = registerCodeExecutionTools({
      toolRegistry,
      toolDefinitions,
      includeBash: false,
      includeSkillFileInstructions: true,
      enableToolOutputReferences: effectiveCodeEnvAvailable,
      workspaceTools: attachedWorkspaceTools,
      workspaceOperations: attachedWorkspaceOperations,
      workspaceCommandTimeoutMaxMs: attachedWorkspaceCommandTimeoutMaxMs,
    });
    toolDefinitions = skillReadResult.toolDefinitions;
    recordCapabilityToolNames(AgentCapabilities.skills, skillReadResult.toolNames);
  }

  if (effectiveCodeEnvAvailable || skillAuthoringAvailable) {
    const fileAuthoringResult = registerFileAuthoringTools({
      toolRegistry,
      toolDefinitions,
      includeSkillFileInstructions: skillAuthoringAvailable,
      workspaceTools: attachedWorkspaceTools,
      workspaceOperations: attachedWorkspaceOperations,
    });
    toolDefinitions = fileAuthoringResult.toolDefinitions;
    /** File authoring is owned by whichever capability switched it on —
     *  both, when both are active, so either marker's selection governs. */
    if (effectiveCodeEnvAvailable) {
      recordCapabilityToolNames(AgentCapabilities.execute_code, fileAuthoringResult.toolNames);
    }
    if (skillAuthoringAvailable) {
      recordCapabilityToolNames(AgentCapabilities.skills, fileAuthoringResult.toolNames);
    }
  }

  let intentToolNames: string[] | undefined;
  let semanticIntentToolNames: string[] | undefined;
  let semanticIntentBlockedToolNames: string[] | undefined;

  /**
   * Inject the `run_in_background` param into eligible opted-in tools and
   * register the `check_background_task` poll tool. Runs after all built-in
   * tool registration so the full, final `toolDefinitions` set is considered.
   * Opt-in is per-tool via `tool_options` for both saved and ephemeral agents;
   * the code-execution pair is background-native and needs no opt-in.
   */
  let backgroundToolNames: string[] | undefined;
  if (params.backgroundToolsAvailable === true) {
    /** Tool names embed `normalizeServerName(server)` (see MCP.js tool keys)
     *  while `mcpConfig` keys the original name, so index the ephemeral
     *  servers by their normalized form. */
    const ephemeralServerNames = new Set<string>();
    for (const [serverName, serverConfig] of Object.entries(appConfig?.mcpConfig ?? {})) {
      if (serverConfig != null && requiresEphemeralUserConnection(serverConfig)) {
        ephemeralServerNames.add(normalizeServerName(serverName));
      }
    }
    /** Resolve the boundary against every configured server, not just the
     *  ephemeral subset: a non-ephemeral name ending in an ephemeral one would
     *  otherwise be misread as ephemeral. */
    const allServerNames = Object.keys(appConfig?.mcpConfig ?? {}).map(normalizeServerName);
    const oauthActionNames = new Set(oauthActionToolNames ?? []);
    const backgroundResult = applyBackgroundToolCalls({
      toolDefinitions,
      toolRegistry,
      toolOptions: agent.tool_options,
      capabilityToolNames,
      /** Tools of ephemeral request-scoped MCP servers (runtime body
       *  placeholders) never get the param: their connection dies at request
       *  end, so the executor would only downgrade the call to foreground.
       *  Unknown servers stay eligible — the executor's per-instance tag is
       *  the fail-safe for those. OAuth-backed action tools are excluded too:
       *  a detached call can block on an interactive login prompt the user
       *  never sees. */
      excludeTool: (toolName) => {
        if (oauthActionNames.has(toolName)) {
          return true;
        }
        const [, serverName] = splitMCPToolKey(toolName, allServerNames);
        return serverName != null && ephemeralServerNames.has(serverName);
      },
    });
    toolDefinitions = backgroundResult.toolDefinitions;
    if (backgroundResult.backgroundToolNames.length > 0) {
      backgroundToolNames = backgroundResult.backgroundToolNames;
    }
  }

  /** Check for tool presence from either full instances or definitions (event-driven mode) */
  const hasAgentTools = (structuredTools?.length ?? 0) > 0 || (toolDefinitions?.length ?? 0) > 0;
  const providerTools = resolveProviderToolConflicts({
    provider: agent.provider,
    tools: options.tools,
    toolDefinitions,
    webSearchDenied,
  });
  const hasProviderTools = (providerTools?.length ?? 0) > 0;

  let tools: GenericTool[] = hasProviderTools
    ? (providerTools as GenericTool[])
    : (structuredTools ?? []);

  if (isGoogleToolCombinationProvider(agent.provider) && hasProviderTools && hasAgentTools) {
    assertGoogleToolCombinationSupport(llmConfig.model);
    if (
      shouldIncludeGoogleServerSideToolInvocations({
        provider: agent.provider,
        hasProviderTools,
        hasAgentTools,
      })
    ) {
      enableGoogleServerSideToolInvocations({ agent, llmConfig });
    }
    if (structuredTools?.length) {
      tools = structuredTools.concat(providerTools as GenericTool[]);
    }
  } else if (
    (agent.provider === Providers.OPENAI ||
      agent.provider === Providers.AZURE ||
      agent.provider === Providers.ANTHROPIC) &&
    hasProviderTools &&
    structuredTools?.length
  ) {
    tools = structuredTools.concat(providerTools as GenericTool[]);
  }

  agent.model_parameters = { ...options.llmConfig } as Agent['model_parameters'];
  if (options.configOptions) {
    (agent.model_parameters as Record<string, unknown>).configuration = options.configOptions;
  }

  if (agent.instructions && agent.instructions !== '') {
    const resolvedInstructions = replaceSpecialVars({
      text: agent.instructions,
      user: user ? (user as unknown as TUser) : null,
      now: runtime.turnStartedAt,
      timezone: runtime.requestBody.timezone,
    });
    if (hasTemporalSpecialVars(agent.instructions)) {
      agent.instructions = undefined;
      appendAdditionalInstructions(agent, resolvedInstructions);
    } else {
      agent.instructions = resolvedInstructions;
    }
  }

  const repositoryInstructionBlock = repositoryInstructionSource
    ? await repositoryInstructionSource.load({
        ...repositoryInstructionSource,
        mode: agent.repositoryInstructions,
        signal: params.signal,
        timeoutMs: appConfig?.endpoints?.agents?.repositoryInstructions?.timeoutMs,
        assertContent: (content) =>
          assertModelBoundContent({
            filters: appConfig?.filters,
            agents: [{ instructions: content }],
          }),
      })
    : undefined;
  if (repositoryInstructionBlock) {
    agent.instructions = [agent.instructions, repositoryInstructionBlock]
      .filter(Boolean)
      .join('\n\n');
  }

  if (typeof agent.artifacts === 'string' && agent.artifacts !== '') {
    const artifactsPromptResult = generateArtifactsPrompt({
      endpoint: agent.provider,
      artifacts: agent.artifacts as never,
    });
    appendAdditionalInstructions(agent, artifactsPromptResult);
  }

  let skillCount = 0;
  /**
   * IDs authorized for runtime skill execution — starts as the ACL-scoped set
   * and gets replaced with the active-filtered subset after catalog injection.
   * Ensures `getSkillByName` cannot resolve a deactivated skill even if the
   * LLM (or a direct-invocation path) names one.
   */
  let executableSkillIds = params.accessibleSkillIds;
  let activeSkillNames: Set<string> | undefined;
  const { accessibleSkillIds } = params;
  /**
   * Authoring runs go through catalog injection even with nothing accessible:
   * `injectSkillCatalog` owns the `skill` tool registration, and a model that
   * can write `skills/{skillName}/SKILL.md` needs the tool bound at init to
   * invoke what it creates later in the same conversation.
   */
  if ((accessibleSkillIds && accessibleSkillIds.length > 0) || skillAuthoringAvailable) {
    const skillResult = await injectSkillCatalog({
      agent,
      toolDefinitions,
      toolRegistry,
      accessibleSkillIds: accessibleSkillIds ?? [],
      skillAuthoringAvailable,
      contextWindowTokens: Number(agentMaxContextTokens) || 200_000,
      listSkillsByAccess: db?.listSkillsByAccess,
      codeEnvAvailable: effectiveCodeEnvAvailable,
      statefulSessions: effectiveStatefulSessions,
      workspaceTools: attachedWorkspaceTools,
      workspaceOperations: attachedWorkspaceOperations,
      userId: user?.id,
      workspaceCommandTimeoutMaxMs: attachedWorkspaceCommandTimeoutMaxMs,
      workspaceEnvironment: trustedCodeExecutionContext.codeWorkspace?.environment,
      skillStates: params.skillStates,
      defaultActiveOnShare: params.defaultActiveOnShare,
      maxCatalogSkills: getMaxCatalogSkills(runtime),
      resolvedCatalog: resolvedSkillCatalog,
    });
    toolDefinitions = skillResult.toolDefinitions;
    skillCount = skillResult.skillCount;
    executableSkillIds = skillResult.activeSkillIds;
    activeSkillNames = skillResult.activeSkillNames;
    recordCapabilityToolNames(AgentCapabilities.skills, skillResult.toolNames);
  }

  /**
   * Intent labels run LAST, after every registration step — the skill
   * catalog above both appends its own definition and REPLACES upgraded ones
   * (e.g. the skill-aware `read_file`), so an earlier injection would be
   * clobbered. Injection PREPENDS while background's param APPENDS, so
   * `intent` is the first schema property regardless of this ordering.
   * The sanitize pass then enforces the flip side: with the capability off
   * it strips SDK-native intent labels (a real admin kill switch); with it
   * on it enforces explicit per-tool opt-outs on late-registered
   * definitions. Both are marker-guarded — a tool's own `intent` business
   * parameter is never touched.
   */
  if (params.toolIntentsAvailable === true) {
    const intentResult = applyIntentLabels({
      toolDefinitions,
      toolRegistry,
      toolOptions: agent.tool_options,
      capabilityToolNames,
    });
    toolDefinitions = intentResult.toolDefinitions;
    if (intentResult.intentToolNames.length > 0) {
      intentToolNames = intentResult.intentToolNames;
    }
  }
  const intentSanitized = sanitizeIntentLabels({
    toolDefinitions,
    toolRegistry,
    toolOptions: agent.tool_options,
    capabilityEnabled: params.toolIntentsAvailable === true,
    capabilityToolNames,
  });
  toolDefinitions = intentSanitized.toolDefinitions;
  if (intentSanitized.semanticIntentToolNames.length > 0) {
    semanticIntentToolNames = intentSanitized.semanticIntentToolNames;
  }
  if (intentSanitized.semanticIntentBlockedToolNames.length > 0) {
    semanticIntentBlockedToolNames = intentSanitized.semanticIntentBlockedToolNames;
  }

  const hasFinalAgentTools =
    (structuredTools?.length ?? 0) > 0 || (toolDefinitions?.length ?? 0) > 0;
  if (isGoogleToolCombinationProvider(agent.provider) && hasProviderTools && hasFinalAgentTools) {
    assertGoogleToolCombinationSupport(llmConfig.model);
    if (
      shouldIncludeGoogleServerSideToolInvocations({
        provider: agent.provider,
        hasProviderTools,
        hasAgentTools: hasFinalAgentTools,
      })
    ) {
      enableGoogleServerSideToolInvocations({ agent, llmConfig });
    }
  }

  const agentMaxContextNum = Number(agentMaxContextTokens) || DEFAULT_MAX_CONTEXT_TOKENS;
  const maxOutputTokensNum = Number(maxOutputTokens) || 0;
  const baseContextTokens = Math.max(0, agentMaxContextNum - maxOutputTokensNum);

  const toMongoFiles = (files: Array<TFile | undefined> | undefined): IMongoFile[] =>
    (files ?? []).filter((a): a is TFile => a != null).map((a) => a as unknown as IMongoFile);

  const loadedFileToolNames = new Set([
    ...(structuredTools ?? []).map((tool) => tool.name),
    ...(toolDefinitions ?? []).map((tool) => tool.name),
  ]);
  const finalFileConsumers: TurnFileConsumers = {
    executeCode:
      wantsCodeFiles &&
      (loadedFileToolNames.has(Tools.execute_code) ||
        (loadedFileToolNames.has('bash_tool') && loadedFileToolNames.has('read_file'))),
    fileSearch: wantsSearchFiles && loadedFileToolNames.has(Tools.file_search),
  };
  const consumersChanged =
    fileConsumers.executeCode !== finalFileConsumers.executeCode ||
    fileConsumers.fileSearch !== finalFileConsumers.fileSearch;
  Object.assign(fileConsumers, finalFileConsumers);
  const finalizeAttachments = (files: Array<TFile | undefined> | undefined): IMongoFile[] => {
    const hydrated = toMongoFiles(files);
    return consumersChanged
      ? applyTurnDelivery(hydrated, { routing: deliveryRouting, consumers: fileConsumers })
      : hydrated;
  };
  const finalAttachments = finalizeAttachments(primedAttachments);
  const finalRequestAttachments = consumersChanged
    ? applyTurnDelivery(
        (primedRequestAttachments ?? []).filter((file): file is TFile => file != null),
        {
          routing: deliveryRouting,
          consumers: fileConsumers,
        },
      )
    : primedRequestAttachments;
  const requestAttachments = toMongoFiles(finalRequestAttachments);
  const agentContextAttachments = finalizeAttachments(primedAgentContextAttachments);
  if (consumersChanged) {
    /* A loader may drop a reader, including a skill extra on retry. Newly model-bound text
     * must pass admission before it can escape initialization, just like initial fallback. */
    const admissionFileIds = new Set(
      (authorizedRunFiles ?? requestUsageFiles).map((file) => file.file_id),
    );
    assertAgentAttachmentLimits({
      attachments: requestAttachments.filter(
        (file) => admissionFileIds.has(file.file_id) && isModelBoundAttachmentFile(file),
      ),
      fileConfig: appConfig?.fileConfig,
      endpoint: agent.endpoint ?? '',
      endpointType: endpointFileType,
    });
    assertModelBoundContent({
      filters: appConfig?.filters,
      files: [...finalAttachments, ...requestAttachments, ...agentContextAttachments],
    });
  }
  const currentRequestFileIds = new Set(requestFileIds);
  const currentRequestAttachments: TFile[] = (finalRequestAttachments ?? [])
    .filter((file): file is TFile => file != null && currentRequestFileIds.has(file.file_id))
    .map((file) => ({
      ...file,
      user: String(file.user),
      ...(file._id == null ? {} : { _id: String(file._id) }),
    }));

  const compatibilityAttachments =
    finalAttachments.length > 0
      ? finalAttachments
      : requestAttachments.concat(agentContextAttachments);

  const endpointConfigs = appConfig?.endpoints;
  const providerConfig =
    customEndpointConfig ?? endpointConfigs?.[agent.provider as keyof typeof endpointConfigs];
  const providerMaxToolResultChars =
    providerConfig != null &&
    typeof providerConfig === 'object' &&
    !Array.isArray(providerConfig) &&
    'maxToolResultChars' in providerConfig
      ? (providerConfig.maxToolResultChars as number | undefined)
      : undefined;
  const maxToolResultCharsResolved =
    providerMaxToolResultChars ?? endpointConfigs?.all?.maxToolResultChars;
  const fileAuthoringToolNames = new Set(
    (toolDefinitions ?? [])
      .filter((toolDefinition) => isFileAuthoringToolDefinition(toolDefinition))
      .map((toolDefinition) => toolDefinition.name),
  );

  const initializedAgent: InitializedAgent = {
    ...agent,
    azureOptions: options.azureOptions,
    resendFiles,
    imageDetail,
    deliveryRouting,
    toolRegistry,
    mcpAvailableTools,
    requestScopedConnections,
    tool_resources,
    userMCPAuthMap,
    toolDefinitions,
    hasDeferredTools,
    mcpToolAliases,
    backgroundToolNames,
    intentToolNames,
    semanticIntentToolNames,
    semanticIntentBlockedToolNames,
    actionsEnabled,
    accessibleMcpServerNames: resolvedAuditNames,
    baseContextTokens,
    memoryToolsRegistered: inlineMemoryRegistered,
    codeEnvAvailable: effectiveCodeEnvAvailable,
    statefulCodeSessions: effectiveStatefulSessions,
    statefulCodeEnvironment,
    codeSessionKey: trustedCodeExecutionContext.codeSessionKey,
    codeExecutionContext: trustedCodeExecutionContext,
    reasoningKey: customEndpointConfig?.customParams?.reasoningKey,
    includeReasoningHistory: customEndpointConfig?.customParams?.includeReasoningHistory,
    skillAuthoringAvailable,
    fileAuthoringToolNames: fileAuthoringToolNames.size > 0 ? fileAuthoringToolNames : undefined,
    skillCount,
    accessibleSkillIds: executableSkillIds,
    activeSkillNames,
    manualSkillPrimes,
    alwaysApplySkillPrimes,
    attachments: compatibilityAttachments,
    requestAttachments,
    currentRequestAttachments,
    agentContextAttachments,
    fileConsumers,
    toolContextMap: toolContextMap ?? {},
    dynamicToolContextMap: dynamicToolContextMap ?? {},
    useLegacyContent: !!options.useLegacyContent,
    tools: (tools ?? []) as GenericTool[] & string[],
    maxToolResultChars: maxToolResultCharsResolved,
    provisionState,
    provisionWarnings:
      provisionWarnings != null && provisionWarnings.length > 0 ? provisionWarnings : undefined,
    maxContextTokens:
      maxContextTokens != null && maxContextTokens > 0
        ? maxContextTokens
        : Math.max(1024, Math.round(baseContextTokens * (1 - DEFAULT_RESERVE_RATIO))),
    primedCodeFiles,
    endpointTokenConfig: options.endpointTokenConfig,
  };

  return initializedAgent;
}
