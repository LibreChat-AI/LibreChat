import { logger } from '@librechat/data-schemas';
import type { Agents, TToolApprovalPolicy } from 'librechat-data-provider';
import type { PluginHookSource } from '~/agents/hooks/source';
import type { MCPToolAlias } from '~/tools/classification';
import type { ToolApprovalHookContext } from './hooks';
import { buildToolApprovalHooks, resolvedToolApprovalHooksCanMatch } from './hooks';
import { healToolApprovalPolicy, isHITLEnabled } from './policy';
import { isStatefulCodeEnvironmentToolName } from './byom';
import { getSafeErrorMetadata } from '~/utils/errors';

/** Default for `toolApproval.allowAlwaysMaxTools`: remembered tools per conversation. */
export const MAX_CONVERSATION_TOOL_ALLOWS = 64;
/** Default for `toolApproval.allowAlwaysMaxToolNameLength`. */
export const MAX_ALLOWED_TOOL_NAME_LENGTH = 256;

/** Configured cap on remembered tools per conversation. */
export function getToolAllowAlwaysMaxTools(policy: TToolApprovalPolicy | undefined): number {
  return policy?.allowAlwaysMaxTools ?? MAX_CONVERSATION_TOOL_ALLOWS;
}

/** Agent shape that carries the MCP key-spelling aliases createRun heals against. */
export interface ToolAllowAlwaysAgent {
  readonly mcpToolAliases?: readonly MCPToolAlias[];
}

function collectAgentAliases(
  agents: readonly (ToolAllowAlwaysAgent | null | undefined)[] | undefined,
): MCPToolAlias[] {
  const aliases: MCPToolAlias[] = [];
  for (const agent of agents ?? []) {
    aliases.push(...(agent?.mcpToolAliases ?? []));
  }
  return aliases;
}

/** Anchored glob match, identical to the SDK's `createToolPolicyHook` semantics. */
function matchesAny(patterns: readonly string[] | undefined, name: string): boolean {
  if (patterns == null || patterns.length === 0) {
    return false;
  }
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$').test(name);
  });
}

/** Whether the admin enabled remembered allows and the current mode can honor them. */
export function isToolAllowAlwaysEnabled(
  policy: TToolApprovalPolicy | undefined,
): policy is NonNullable<TToolApprovalPolicy> {
  return isHITLEnabled(policy) && policy.allowAlways === true && policy.mode !== 'dontAsk';
}

/**
 * Whether one concrete tool name may be remembered for a conversation.
 *
 * The name is stored and matched literally, so it must not contain the glob wildcard.
 * Admin `deny` and `ask` matches are ineligible (an `ask` entry is the admin's
 * "always prompt" rule), and LibreChat's native code tools stay under the code
 * approval picker instead.
 */
export function isToolAllowAlwaysEligible(
  policy: TToolApprovalPolicy | undefined,
  toolName: unknown,
): toolName is string {
  if (!isToolAllowAlwaysEnabled(policy)) {
    return false;
  }
  if (
    typeof toolName !== 'string' ||
    toolName.length === 0 ||
    toolName.length > (policy.allowAlwaysMaxToolNameLength ?? MAX_ALLOWED_TOOL_NAME_LENGTH) ||
    toolName.includes('*')
  ) {
    return false;
  }
  if (isStatefulCodeEnvironmentToolName(toolName)) {
    return false;
  }
  return !matchesAny(policy.deny, toolName) && !matchesAny(policy.ask, toolName);
}

/**
 * Every spelling the runtime can present for one tool: the name itself plus the other MCP
 * key spelling of any alias pair it belongs to. Only exact alias pairs are followed, so a
 * different tool with a similar name is never included.
 */
export function getEquivalentToolNames(
  toolName: string,
  aliases: readonly MCPToolAlias[] = [],
): string[] {
  const names = new Set([toolName]);
  for (const { name, aliasName } of aliases) {
    if (name === toolName) {
      names.add(aliasName);
    } else if (aliasName === toolName) {
      names.add(name);
    }
  }
  return [...names];
}

/** Eligible only when every spelling of the tool is, so a `deny`/`ask` on either spelling wins. */
function isToolAllowAlwaysGroupEligible(
  policy: TToolApprovalPolicy | undefined,
  toolName: unknown,
  aliases: readonly MCPToolAlias[],
): toolName is string {
  if (!isToolAllowAlwaysEligible(policy, toolName)) {
    return false;
  }
  return getEquivalentToolNames(toolName, aliases).every((name) =>
    isToolAllowAlwaysEligible(policy, name),
  );
}

/**
 * Whether a programmatic or plugin `PreToolUse` hook could decide for any spelling of a tool.
 * The interrupt payload does not record which hook asked, so a remembered `allow` cannot be
 * shown to hold whenever such a hook can run for the tool: it folds `ask` over the stored
 * allow and the next call pauses again. Agent-scoped hooks count regardless of agent here.
 */
function toolApprovalHookCanApply(
  names: readonly string[],
  hookContext: ToolApprovalHookContext,
  pluginHookSource: PluginHookSource | undefined,
): boolean {
  const hooks = buildToolApprovalHooks(hookContext).map(({ hook, matcher }) => ({ hook, matcher }));
  if (resolvedToolApprovalHooksCanMatch(hooks, names)) {
    return true;
  }
  if (pluginHookSource == null) {
    return false;
  }
  return pluginHookSource.hasToolApprovalHooks != null
    ? pluginHookSource.hasToolApprovalHooks(names)
    : pluginHookSource.hasHooks();
}

/**
 * The approval policy a run actually evaluates: `deny`/`ask`/`allow` healed against the
 * tools' other MCP key spellings, then the conversation's remembered tools folded in as
 * exact-name allows for every spelling of each remembered tool. Every "Always allow" decision (offer, resume re-check, scheduled
 * admission, run) reads this one shape so they cannot drift apart.
 */
export function buildEffectiveToolApprovalPolicy(
  policy: TToolApprovalPolicy | undefined,
  aliases: readonly MCPToolAlias[],
  allowedTools?: readonly string[],
): TToolApprovalPolicy | undefined {
  return applyConversationToolAllows(
    healToolApprovalPolicy(policy, aliases),
    allowedTools,
    aliases,
  );
}

export interface MarkToolApprovalAllowAlwaysOptions {
  /** Endpoint `toolApproval` policy, before healing. */
  policy: TToolApprovalPolicy | undefined;
  /** Reachable agents of the paused run; their MCP aliases heal `deny`/`ask`. */
  agents?: readonly (ToolAllowAlwaysAgent | null | undefined)[];
  /** Tools the conversation already remembers, to keep offers within the cap. */
  storedTools?: readonly string[];
  /** Request context the run resolves programmatic approval hooks with. */
  hookContext?: ToolApprovalHookContext;
  /** Deployment plugin hooks the run registers after the policy hooks. */
  pluginHookSource?: PluginHookSource;
}

/**
 * Mark every review config whose tool the user may approve for the rest of the
 * conversation. The offer is made only when storing the name would auto-approve the next
 * identical call on the run's own decision path: every spelling passes the healed static
 * policy, no programmatic or plugin hook can apply to it, and the conversation's remembered
 * list stays within `allowAlwaysMaxTools`.
 */
export function markToolApprovalAllowAlways(
  payload: Agents.ToolApprovalInterruptPayload,
  {
    policy,
    agents,
    storedTools = [],
    hookContext = {},
    pluginHookSource,
  }: MarkToolApprovalAllowAlwaysOptions,
): Agents.ToolApprovalInterruptPayload {
  if (!isToolAllowAlwaysEnabled(policy)) {
    return payload;
  }
  const aliases = collectAgentAliases(agents);
  const effective = buildEffectiveToolApprovalPolicy(policy, aliases);
  const stored = new Set(storedTools);
  let room = getToolAllowAlwaysMaxTools(policy) - stored.size;
  const nameByToolCallId = new Map(
    payload.action_requests.map((request) => [request.tool_call_id, request.name]),
  );
  const offeredNames = new Set<string>();
  let changed = false;
  const review_configs = payload.review_configs.map((config) => {
    const name = nameByToolCallId.get(config.tool_call_id);
    if (
      !config.allowed_decisions.includes('approve') ||
      !isToolAllowAlwaysGroupEligible(effective, name, aliases) ||
      toolApprovalHookCanApply(getEquivalentToolNames(name, aliases), hookContext, pluginHookSource)
    ) {
      return config;
    }
    if (!stored.has(name) && !offeredNames.has(name)) {
      if (room <= 0) {
        return config;
      }
      room--;
      offeredNames.add(name);
    }
    changed = true;
    return { ...config, allow_always: true };
  });
  return changed ? { ...payload, review_configs } : payload;
}

/**
 * Tool names the user approved with `scope: 'session'` in a validated resume batch.
 * Eligibility is re-checked against the live policy, so a pause created before an
 * admin tightened the config cannot store a now-ineligible name.
 */
export function collectToolApprovalAllows(
  payload: Agents.ToolApprovalInterruptPayload,
  resolutions: readonly Agents.ToolApprovalResolution[],
  policy: TToolApprovalPolicy | undefined,
  aliases: readonly MCPToolAlias[] = [],
): string[] {
  if (!isToolAllowAlwaysEnabled(policy)) {
    return [];
  }
  const nameByToolCallId = new Map(
    payload.action_requests.map((request) => [request.tool_call_id, request.name]),
  );
  const offered = new Set(
    payload.review_configs
      .filter((config) => config.allow_always === true)
      .map((config) => config.tool_call_id),
  );
  const names = new Set<string>();
  for (const resolution of resolutions) {
    if (
      resolution.decision !== 'approve' ||
      resolution.scope !== 'session' ||
      !offered.has(resolution.tool_call_id)
    ) {
      continue;
    }
    const name = nameByToolCallId.get(resolution.tool_call_id);
    if (isToolAllowAlwaysGroupEligible(policy, name, aliases)) {
      names.add(name);
    }
  }
  return [...names];
}

/** Stored allows for the conversation the run executes, or none for any other record. */
export function getConversationToolApprovalAllows(
  conversation: { conversationId?: string | null; toolApprovalAllows?: unknown } | null | undefined,
  conversationId: string | null | undefined,
): string[] {
  if (
    conversation == null ||
    typeof conversationId !== 'string' ||
    conversationId === '' ||
    conversation.conversationId !== conversationId ||
    !Array.isArray(conversation.toolApprovalAllows)
  ) {
    return [];
  }
  return conversation.toolApprovalAllows.filter((name): name is string => typeof name === 'string');
}

/**
 * Remembered tools a run may honor: none unless the endpoint policy enables the feature,
 * and only from the stored record of the conversation the run executes.
 */
export function resolveRunToolApprovalAllows(
  endpointPolicy: TToolApprovalPolicy | undefined,
  conversation: { conversationId?: string | null; toolApprovalAllows?: unknown } | null | undefined,
  conversationId: string | null | undefined,
): string[] {
  if (!isToolAllowAlwaysEnabled(endpointPolicy)) {
    return [];
  }
  return getConversationToolApprovalAllows(conversation, conversationId);
}

/**
 * Fold a conversation's remembered tools into the static policy as exact-name `allow`
 * entries, one per spelling in `aliases` so a tool keeps its approval across its legacy and
 * stripped MCP keys. A tool with any `deny`/`ask`-matched spelling adds nothing. The SDK checks `deny` then `ask` before `allow`, and programmatic hooks fold
 * `deny > ask > allow` on top, so a remembered tool can never loosen an admin rule.
 * Call this AFTER alias healing so healed `deny`/`ask` names still take precedence.
 */
export function applyConversationToolAllows(
  policy: TToolApprovalPolicy | undefined,
  allowedTools: readonly string[] | undefined,
  aliases: readonly MCPToolAlias[] = [],
): TToolApprovalPolicy | undefined {
  if (!isToolAllowAlwaysEnabled(policy) || allowedTools == null || allowedTools.length === 0) {
    return policy;
  }
  const additions = new Set<string>();
  for (const name of allowedTools.slice(0, getToolAllowAlwaysMaxTools(policy))) {
    if (isToolAllowAlwaysGroupEligible(policy, name, aliases)) {
      getEquivalentToolNames(name, aliases).forEach((spelling) => additions.add(spelling));
    }
  }
  if (additions.size === 0) {
    return policy;
  }
  return { ...policy, allow: [...(policy.allow ?? []), ...additions] };
}

export interface RecordToolApprovalAllowsInput {
  userId: string;
  conversationId: string;
  policy: TToolApprovalPolicy | undefined;
  pendingAction: Pick<Agents.PendingAction, 'payload'>;
  resolutions: unknown;
  /** Reachable agents of the rebuilt run; eligibility heals against their MCP aliases. */
  agents?: readonly (ToolAllowAlwaysAgent | null | undefined)[];
  /** Request context the rebuilt run resolves programmatic approval hooks with. */
  hookContext?: ToolApprovalHookContext;
  /** Deployment plugin hooks the rebuilt run registers after the policy hooks. */
  pluginHookSource?: PluginHookSource;
  /** Request-scoped conversation reused by the resumed run's initialization. */
  request: {
    resolvedConversation?: { conversationId?: string; toolApprovalAllows?: unknown } | null;
  };
  addConvoToolApprovalAllows: (input: {
    user: string;
    conversationId: string;
    toolNames: string[];
    max: number;
  }) => Promise<boolean>;
}

/**
 * Persist the tools a claimed resume approved for the rest of the conversation and
 * expose them to the run rebuilt by the same request. Call only after every resume
 * fence passed. A tool is stored only when the rebuilt run would auto-approve it: the
 * live healed policy allows it and no programmatic or plugin hook can apply to it, so a
 * hook registered after the pause turns the choice into a one-time approval. The approval itself is already claimed, so a storage failure is logged
 * and degrades to a one-time approval: later calls prompt again, the safe direction.
 */
export async function recordToolApprovalAllows({
  userId,
  conversationId,
  policy,
  pendingAction,
  resolutions,
  agents,
  hookContext = {},
  pluginHookSource,
  request,
  addConvoToolApprovalAllows,
}: RecordToolApprovalAllowsInput): Promise<string[]> {
  const payload = pendingAction.payload;
  if (payload?.type !== 'tool_approval' || !Array.isArray(resolutions)) {
    return [];
  }
  const aliases = collectAgentAliases(agents);
  const eligible = collectToolApprovalAllows(
    payload,
    resolutions as Agents.ToolApprovalResolution[],
    buildEffectiveToolApprovalPolicy(policy, aliases),
    aliases,
  );
  const toolNames = eligible.filter(
    (name) =>
      !toolApprovalHookCanApply(
        getEquivalentToolNames(name, aliases),
        hookContext,
        pluginHookSource,
      ),
  );
  if (toolNames.length < eligible.length) {
    logger.info(
      '[recordToolApprovalAllows] An approval hook now applies to a remembered tool; approved once',
    );
  }
  if (toolNames.length === 0) {
    return [];
  }
  let stored = false;
  try {
    stored = await addConvoToolApprovalAllows({
      user: userId,
      conversationId,
      toolNames,
      max: getToolAllowAlwaysMaxTools(policy),
    });
  } catch (error) {
    logger.warn(
      '[recordToolApprovalAllows] Failed to store allowed tools',
      getSafeErrorMetadata(error),
    );
    return [];
  }
  if (!stored) {
    logger.warn('[recordToolApprovalAllows] Remembered tool limit reached; approved once');
    return [];
  }
  const resolved = request.resolvedConversation;
  if (resolved != null && resolved.conversationId === conversationId) {
    const existing = getConversationToolApprovalAllows(resolved, conversationId);
    request.resolvedConversation = {
      ...resolved,
      toolApprovalAllows: [...new Set([...existing, ...toolNames])],
    };
  }
  return toolNames;
}
