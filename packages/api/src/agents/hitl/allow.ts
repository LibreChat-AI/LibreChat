import { logger } from '@librechat/data-schemas';
import type { Agents, TToolApprovalPolicy } from 'librechat-data-provider';
import { isStatefulCodeEnvironmentToolName } from './byom';
import { getSafeErrorMetadata } from '~/utils/errors';
import { isHITLEnabled } from './policy';

/** Upper bound on remembered tools per conversation; later choices are not stored. */
export const MAX_CONVERSATION_TOOL_ALLOWS = 64;
/** Longest tool name accepted as a remembered allow. */
const MAX_ALLOWED_TOOL_NAME_LENGTH = 256;

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
    toolName.length > MAX_ALLOWED_TOOL_NAME_LENGTH ||
    toolName.includes('*')
  ) {
    return false;
  }
  if (isStatefulCodeEnvironmentToolName(toolName)) {
    return false;
  }
  return !matchesAny(policy.deny, toolName) && !matchesAny(policy.ask, toolName);
}

/** Mark every review config whose tool the user may approve for the rest of the conversation. */
export function markToolApprovalAllowAlways(
  payload: Agents.ToolApprovalInterruptPayload,
  policy: TToolApprovalPolicy | undefined,
): Agents.ToolApprovalInterruptPayload {
  if (!isToolAllowAlwaysEnabled(policy)) {
    return payload;
  }
  const nameByToolCallId = new Map(
    payload.action_requests.map((request) => [request.tool_call_id, request.name]),
  );
  let changed = false;
  const review_configs = payload.review_configs.map((config) => {
    const name = nameByToolCallId.get(config.tool_call_id);
    if (!config.allowed_decisions.includes('approve') || !isToolAllowAlwaysEligible(policy, name)) {
      return config;
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
    if (isToolAllowAlwaysEligible(policy, name)) {
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
 * entries. The SDK checks `deny` then `ask` before `allow`, and programmatic hooks fold
 * `deny > ask > allow` on top, so a remembered tool can never loosen an admin rule.
 * Call this AFTER alias healing so healed `deny`/`ask` names still take precedence.
 */
export function applyConversationToolAllows(
  policy: TToolApprovalPolicy | undefined,
  allowedTools: readonly string[] | undefined,
): TToolApprovalPolicy | undefined {
  if (!isToolAllowAlwaysEnabled(policy) || allowedTools == null || allowedTools.length === 0) {
    return policy;
  }
  const additions = allowedTools
    .slice(0, MAX_CONVERSATION_TOOL_ALLOWS)
    .filter((name) => isToolAllowAlwaysEligible(policy, name));
  if (additions.length === 0) {
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
 * expose them to the run rebuilt by the same request. The approval itself is already
 * claimed, so a storage failure is logged and degrades to a one-time approval: later
 * calls prompt again, which is the safe direction.
 */
export async function recordToolApprovalAllows({
  userId,
  conversationId,
  policy,
  pendingAction,
  resolutions,
  request,
  addConvoToolApprovalAllows,
}: RecordToolApprovalAllowsInput): Promise<string[]> {
  const payload = pendingAction.payload;
  if (payload?.type !== 'tool_approval' || !Array.isArray(resolutions)) {
    return [];
  }
  const toolNames = collectToolApprovalAllows(
    payload,
    resolutions as Agents.ToolApprovalResolution[],
    policy,
  );
  if (toolNames.length === 0) {
    return [];
  }
  let stored = false;
  try {
    stored = await addConvoToolApprovalAllows({
      user: userId,
      conversationId,
      toolNames,
      max: MAX_CONVERSATION_TOOL_ALLOWS,
    });
  } catch (error) {
    logger.warn(
      '[recordToolApprovalAllows] Failed to store allowed tools',
      getSafeErrorMetadata(error),
    );
    return [];
  }
  if (!stored) {
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
