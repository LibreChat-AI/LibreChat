import { randomUUID, createHash } from 'crypto';
import {
  openAIBaseSchema,
  googleBaseSchema,
  anthropicBaseSchema,
  reasoningOverrideSchema,
} from 'librechat-data-provider';
import type { Agents, TReasoningOverride, TToolApprovalPolicy } from 'librechat-data-provider';
import type { ToolPolicyConfig } from '@librechat/agents';
import type { MCPToolAlias } from '~/tools/classification';

/**
 * Default decisions offered to the user for a paused tool call.
 *
 * `'respond'` is intentionally NOT in the default set: it represents the agent
 * substituting a synthetic tool result, which is rarely the right ergonomic for
 * a stock approval prompt. Hosts that want it can pass an override.
 */
const DEFAULT_REVIEW_DECISIONS: Agents.ToolApprovalDecisionType[] = ['approve', 'reject', 'edit'];

/**
 * Layered sources that combine into the effective tool-approval policy for a turn.
 *
 * Endpoint policy remains the administrative baseline. Attached code environments
 * also activate LibreChat's built-in BYOM baseline; `agent` and `skills` remain
 * reserved seams for future persisted overrides.
 */
export interface ToolApprovalPolicyLayers {
  /**
   * App/endpoint policy — `endpoints.agents.toolApproval` from librechat.yaml.
   * The baseline, and the sole owner of the `enabled` kill switch.
   */
  endpoint?: TToolApprovalPolicy;
  /**
   * Per-agent override (not yet wired). Layered over `endpoint` to refine
   * `mode`/`allow`/`deny`/`ask`/`reason` for a specific agent. Must NOT flip
   * `enabled` — enablement stays endpoint-level by design.
   */
  agent?: TToolApprovalPolicy;
  /**
   * Skill-contributed policy (not yet wired). May only TIGHTEN — contribute
   * `ask`/`deny` entries — never grant `bypass` or widen `allow`, so a selected
   * skill can never silently auto-approve a tool.
   */
  skills?: TToolApprovalPolicy[];
  /**
   * At least one agent in this run executes in an attached, user-operated environment.
   * Attached environments get LibreChat's safe approval baseline without requiring
   * an administrator to opt the whole endpoint into prompts.
   */
  attachedCodeEnvironment?: boolean;
}

/**
 * Resolve the effective tool-approval policy for a turn from its layered sources.
 *
 * This is the single seam where policy sources combine, kept out of the run call
 * site so adding per-agent or per-skill policy later is a change to ONE function
 * rather than to `createRun`. Intended precedence once those layers are wired:
 *   - `endpoint` is the baseline and owns the `enabled` kill switch;
 *   - `agent` overrides `mode`/`allow`/`deny`/`ask`/`reason`;
 *   - `skills` may only tighten (add `ask`/`deny`), never loosen.
 *
 * When no endpoint policy is active, BYOM adds `enabled: true, mode: 'bypass'` and
 * an agent-scoped hook supplies its coding decisions. An already-enabled endpoint
 * policy remains the run-wide administrative baseline, including its unmatched-tool
 * mode. An explicit endpoint `enabled: false` remains the administrator emergency
 * override. `agent`/`skills` are accepted but not yet merged.
 */
export function resolveToolApprovalPolicy(
  layers: ToolApprovalPolicyLayers,
): TToolApprovalPolicy | undefined {
  if (
    layers.attachedCodeEnvironment === true &&
    layers.endpoint?.enabled !== true &&
    layers.endpoint?.enabled !== false
  ) {
    return {
      ...layers.endpoint,
      enabled: true,
      mode: 'bypass',
    };
  }
  return layers.endpoint;
}

/**
 * Whether the HITL machinery should run for this policy.
 *
 * HITL remains default-off for the rollout; `enabled: true` is the explicit
 * opt-in. Users wanting "stop asking me" after opting in should use
 * `mode: 'bypass'` instead, which keeps the machinery in place but auto-approves.
 *
 * **Wiring caveat (Slice B):** when this returns `true` and the host passes
 * `humanInTheLoop: { enabled: true }` to `Run.create`, the host MUST also
 * supply `compileOptions.checkpointer` with a durable saver
 * (`LibreChatCheckpointSaver`). Otherwise the SDK installs a process-local
 * `MemorySaver` fallback, which silently breaks resume across worker hops in
 * any multi-process deployment. Pair this predicate with the checkpointer
 * assignment at the `Run.create` call site.
 */
export function isHITLEnabled(
  policy: TToolApprovalPolicy | undefined,
): policy is NonNullable<TToolApprovalPolicy> {
  return policy?.enabled === true;
}

/**
 * Whether the configured policy can structurally return `ask` for any tool.
 *
 * `bypass` and `dontAsk` are non-pausing fallbacks; only an explicit ask rule
 * or a programmatic hook can tighten them to `ask`. A catch-all deny remains
 * non-pausing because deny wins over every hook/rule, while a catch-all allow
 * removes the default mode's unmatched-tool ask fallback. More-specific pattern
 * overlap is intentionally treated conservatively because the run's complete
 * lazy tool surface is not known at admission time.
 */
export function isToolApprovalPauseCapable(
  policy: TToolApprovalPolicy | undefined,
  hasProgrammaticHooks = false,
  toolNames?: readonly string[],
): boolean {
  if (!isHITLEnabled(policy)) {
    return false;
  }
  const enabledPolicy = policy;
  if (toolNames != null) {
    const names = Array.from(new Set(toolNames.filter((name) => name.length > 0)));
    if (names.length === 0) {
      return false;
    }
    const matches = (patterns: string[] | undefined, name: string): boolean =>
      patterns?.some((pattern) => globToRegex(pattern).test(name)) === true;
    return names.some((name) => {
      if (matches(enabledPolicy.deny, name)) {
        return false;
      }
      if (hasProgrammaticHooks || matches(enabledPolicy.ask, name)) {
        return true;
      }
      if (matches(enabledPolicy.allow, name)) {
        return false;
      }
      return enabledPolicy.mode !== 'bypass' && enabledPolicy.mode !== 'dontAsk';
    });
  }
  if (policy?.deny?.includes('*')) {
    return false;
  }
  if (hasProgrammaticHooks || (policy?.ask?.length ?? 0) > 0) {
    return true;
  }
  if (policy?.mode === 'bypass' || policy?.mode === 'dontAsk') {
    return false;
  }
  return policy?.allow?.includes('*') !== true;
}

/**
 * Map a LibreChat tool-approval policy to the SDK's `ToolPolicyConfig`.
 *
 * Returns `undefined` when there's nothing to configure (so the SDK's own
 * defaults apply). The `enabled` field is LibreChat-only and stripped here —
 * it's consumed separately via {@link isHITLEnabled} to gate the SDK opt-out.
 */
/** Anchored-glob matcher mirroring the SDK's `createToolPolicyHook` semantics exactly. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

/** Whether an enabled static policy unconditionally denies one concrete tool name. */
export function isToolDeniedByApprovalPolicy(
  policy: TToolApprovalPolicy | undefined,
  toolName: string,
): boolean {
  return (
    isHITLEnabled(policy) &&
    policy.deny?.some((pattern) => globToRegex(pattern).test(toolName)) === true
  );
}

/**
 * Extends each `toolApproval` pattern list with the names of tools whose
 * OTHER spelling matches, so admin YAML keeps applying when a tool's key
 * spelling changed in either direction: patterns written against pre-strip
 * upstream naming reach the stripped instances (a non-matching `deny` would
 * otherwise FAIL OPEN), and patterns written against the current catalog
 * naming reach legacy-named instances retained by unedited agents. Healing
 * is list-level (literal names appended, patterns never rewritten), so
 * `deny`/`ask`/`allow` precedence semantics are unchanged, and a name
 * already matched by its own list is skipped.
 */
export function healToolApprovalPolicy(
  policy: TToolApprovalPolicy | undefined,
  aliases: readonly MCPToolAlias[],
): TToolApprovalPolicy | undefined {
  if (!policy || aliases.length === 0) {
    return policy;
  }
  const healList = (patterns: string[] | undefined): string[] | undefined => {
    if (!patterns || patterns.length === 0) {
      return patterns;
    }
    const regexes = patterns.map(globToRegex);
    const appended: string[] = [];
    for (const { name, aliasName } of aliases) {
      if (name === aliasName || regexes.some((regex) => regex.test(name))) {
        continue;
      }
      if (regexes.some((regex) => regex.test(aliasName))) {
        appended.push(name);
      }
    }
    return appended.length > 0 ? [...patterns, ...appended] : patterns;
  };
  return {
    ...policy,
    allow: healList(policy.allow),
    deny: healList(policy.deny),
    ask: healList(policy.ask),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Names whose OTHER spelling matches a programmatic hook's regex matcher
 * while their own name does not — the hook must also fire for these or its
 * argument-, user-, or tenant-specific deny/ask decisions are silently
 * skipped for renamed tools. Mirrors the SDK's unanchored `new RegExp(pattern)`
 * matcher semantics; an invalid pattern matches nothing there, so it aliases
 * nothing here.
 */
export function collectAliasMatcherNames(
  matcher: string | undefined,
  aliases: readonly MCPToolAlias[],
): string[] {
  if (!matcher || aliases.length === 0) {
    return [];
  }
  let regex: RegExp;
  try {
    regex = new RegExp(matcher);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const { name, aliasName } of aliases) {
    if (name !== aliasName && !regex.test(name) && regex.test(aliasName)) {
      names.push(name);
    }
  }
  return names;
}

/** Anchored exact-name pattern for the alias-matched names of one hook matcher. */
export function buildAliasMatcherPattern(names: readonly string[]): string {
  return `^(?:${names.map(escapeRegExp).join('|')})$`;
}

export function mapToolApprovalPolicy(
  policy: TToolApprovalPolicy | undefined,
): ToolPolicyConfig | undefined {
  if (!policy) {
    return undefined;
  }
  const config: ToolPolicyConfig = {};
  if (policy.mode) {
    config.mode = policy.mode;
  }
  if (policy.allow && policy.allow.length > 0) {
    config.allow = policy.allow;
  }
  if (policy.deny && policy.deny.length > 0) {
    config.deny = policy.deny;
  }
  if (policy.ask && policy.ask.length > 0) {
    config.ask = policy.ask;
  }
  if (policy.reason) {
    config.reason = policy.reason;
  }
  return Object.keys(config).length > 0 ? config : undefined;
}

/** Tool-call shape consumed by {@link buildToolApprovalPayload}. */
export interface ToolApprovalCallInput {
  name: string;
  arguments: string | Record<string, unknown>;
  tool_call_id: string;
  description?: string;
}

/**
 * Build a tool-approval interrupt payload from one or more paused tool calls.
 *
 * Mirrors the SDK's `ToolApprovalInterruptPayload` shape so this can be used
 * to synthesize payloads in tests, or by the host before the SDK upgrade ships.
 */
export function buildToolApprovalPayload(
  toolCalls: ToolApprovalCallInput[],
  decisionsByToolName?: Record<string, Agents.ToolApprovalDecisionType[]>,
): Agents.ToolApprovalInterruptPayload {
  return {
    type: 'tool_approval',
    action_requests: toolCalls.map((tc) => ({
      name: tc.name,
      arguments: tc.arguments,
      tool_call_id: tc.tool_call_id,
      description: tc.description,
    })),
    review_configs: toolCalls.map((tc) => ({
      action_name: tc.name,
      tool_call_id: tc.tool_call_id,
      allowed_decisions: decisionsByToolName?.[tc.name] ?? DEFAULT_REVIEW_DECISIONS,
    })),
  };
}

/** Require one uniquely identified review policy for every paused tool call. */
export function isToolApprovalPayloadValid(payload: Agents.ToolApprovalInterruptPayload): boolean {
  if (payload.action_requests.length !== payload.review_configs.length) {
    return false;
  }

  const requestedIds = new Set<string>();
  for (const request of payload.action_requests) {
    if (
      typeof request.tool_call_id !== 'string' ||
      request.tool_call_id.length === 0 ||
      requestedIds.has(request.tool_call_id)
    ) {
      return false;
    }
    requestedIds.add(request.tool_call_id);
  }

  const reviewedIds = new Set<string>();
  for (const config of payload.review_configs) {
    if (
      typeof config.tool_call_id !== 'string' ||
      config.tool_call_id.length === 0 ||
      reviewedIds.has(config.tool_call_id)
    ) {
      return false;
    }
    if (!requestedIds.has(config.tool_call_id)) {
      return false;
    }
    reviewedIds.add(config.tool_call_id);
  }

  return true;
}

/** Build an ask-user-question interrupt payload. */
export function buildAskUserQuestionPayload(
  question: Agents.AskUserQuestionRequest,
): Agents.AskUserQuestionInterruptPayload {
  return {
    type: 'ask_user_question',
    question,
  };
}

/** Job-context fields wrapped around a {@link Agents.HumanInterruptPayload}. */
export interface PendingActionContext {
  streamId: string;
  conversationId?: string;
  /** Stable per-turn identifier (e.g. responseMessageId or LangGraph checkpoint_ns). */
  runId?: string;
  responseMessageId?: string;
  /** Optional TTL (ms). When set, `expiresAt = createdAt + ttlMs`. */
  ttlMs?: number;
  /** Optional absolute upper bound inherited from an enclosing event binding. */
  expiresAt?: Date | string | number;
  /** Override actionId; defaults to a fresh uuid. */
  actionId?: string;
  /** SDK interrupt id (`RunInterruptResult.interruptId`) for cross-process resume. */
  interruptId?: string;
  /** LangGraph `thread_id` (`RunInterruptResult.threadId`) for cross-process resume. */
  threadId?: string;
  /** Fingerprint of the graph-determining request fields; see {@link computeAgentRequestFingerprint}. */
  requestFingerprint?: string;
  /** Current fingerprint; the legacy field remains populated for rolling-deploy compatibility. */
  requestFingerprintV2?: string;
  /** Graph-determining fields to replay on resume; see {@link RESUME_CONTEXT_KEYS}. */
  resumeContext?: Record<string, unknown>;
  /** Opaque server-only binding to the stateful code targets selected at pause time. */
  codeExecutionBinding?: Agents.CodeExecutionApprovalBinding;
}

/** Request fields that decide which agent/graph + tool set a turn runs. */
export interface AgentRequestFingerprintFields {
  endpoint?: string | null;
  endpointType?: string | null;
  agent_id?: string | null;
  model?: string | null;
  spec?: string | null;
  /** Ephemeral agents derive their system instructions from this; pin it too. */
  promptPrefix?: string | null;
  ephemeralAgent?: Record<string, unknown> | null;
  codeApprovalMode?: string | null;
  codeEnvironmentMode?: string | null;
  codeWorkspaces?: unknown;
}

/** Stable, order-independent serialization of the ephemeral capability config. */
function normalizeEphemeralAgent(ephemeral: Record<string, unknown> | null | undefined): unknown {
  if (ephemeral == null || typeof ephemeral !== 'object') {
    return null;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ephemeral).sort()) {
    const value = ephemeral[key];
    out[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  return out;
}

/**
 * Fingerprint the request fields that determine which agent/graph + tool set a turn
 * runs. Persisted on the pending action at pause time and recomputed on resume; a
 * mismatch means the resume would rebuild a DIFFERENT graph. This is the guard that
 * catches an ephemeral-agent config swap — those have an undefined `agent_id`, so the
 * id check alone can't tell two ephemeral configs apart.
 */
/**
 * Request fields that determine the agent/graph + tool set, persisted with the pending
 * action so the resume can REPLAY them server-side. The client can't reliably re-send
 * these after a reload (e.g. the ephemeralAgent state resets), so replaying them from
 * the job guarantees the rebuilt run is the SAME graph the pause used — durable resume
 * works across reloads/replicas, and a crafted resume can't swap the tool set.
 */
export const RESUME_CONTEXT_KEYS = [
  'endpoint',
  'endpointType',
  'agent_id',
  'spec',
  'model',
  'promptPrefix',
  'ephemeralAgent',
  'codeApprovalMode',
  'codeEnvironmentMode',
  // The selected attached workspace determines the code tools' execution root and
  // operation ceiling. Pin it across every pause type so a reload or crafted resume
  // cannot rebuild the graph against a different directory.
  'codeWorkspaces',
  // The agents build reads addedConvo into endpointOption to add parallel/secondary
  // agents; the resume POST can't reconstruct it, so replay it from the paused request.
  'addedConvo',
  // Feeds temporal prompt vars ({{current_datetime}} etc.) via initializeAgent. The
  // resume POST omits it, so without replay a different-tz client (or none) compiles a
  // different system prompt than the paused graph. Replay-only — not in the fingerprint.
  'timezone',
  // Manually-selected skills union their allowed-tools into the tool set before tools
  // load (initializeAgent → resolveManualSkills), so they're graph-determining. The
  // resume POST can't reliably re-send them after a reload; replay them, and the
  // delete-absent half of applyResumeContext stops a crafted resume from injecting a
  // different skill's tools (manualSkills isn't covered by the fingerprint). Replay-only.
  // (alwaysAppliedSkills is NOT here — it's resolved server-side from the DB, not req.body.)
  'manualSkills',
  // The one-shot reasoning selection is generation-determining and must
  // survive a HITL continuation across reloads/replicas.
  'reasoningOverride',
  // Graph-determining for ephemeral agents: `loadEphemeralAgent` encodes the agent id
  // (and thus the LangGraph node name / HITL checkpoint namespace) from
  // `sender = modelLabel ?? modelSpec.label ?? …`. `modelLabel` is stripped from the
  // RESOLVED llmConfig captured at pause (sanitizeResumeModelParameters reads the
  // initialized agent's model_parameters), so without replaying the original request
  // value the resumed id falls back to modelSpec.label → a DIFFERENT id → the interrupt
  // checkpoint (namespaced by the paused id) can't be re-entered → empty-graph resume
  // (#14253). It rides top-level on req.body and flows into model_parameters via the
  // build spread, so replaying it here restores the stable id. Replay-only.
  'modelLabel',
] as const;

export type ResumeContext = Partial<Record<(typeof RESUME_CONTEXT_KEYS)[number], unknown>> & {
  /** Resolved model params captured at pause (sanitized); replayed by the resume route. */
  model_parameters?: Record<string, unknown>;
  /** Original conversation values hidden from the provider runtime override. */
  reasoningOverrideBase?: {
    key: TReasoningOverride['key'];
    hadValue: boolean;
    value?: unknown;
    thinkingHadValue?: boolean;
    thinkingValue?: unknown;
  };
};

/** Exact (lowercased) parameter keys that carry credentials or server transport config. */
const SENSITIVE_PARAM_KEYS = new Set([
  'auth',
  'authoptions',
  'auth_options',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'idtoken',
  'id_token',
  'sessiontoken',
  'session_token',
  'configuration',
  'client',
  'clientoptions',
  'client_options',
  'fetchoptions',
  'fetch_options',
  'fetch',
  'httpagent',
  'httpsagent',
  'callbacks',
  'endpoint',
  'endpointhost',
  'endpoint_host',
]);

/** Key fragments matched anywhere in a (lowercased) key, e.g. `azureOpenAIApiKey`. */
const SENSITIVE_PARAM_KEY_FRAGMENTS = [
  'apikey',
  'api_key',
  'api-key',
  'apiurl',
  'api_url',
  'api-url',
  'secret',
  'password',
  'credential',
  'authorization',
  'azureopenai',
  'header',
  'proxy',
  'baseurl',
  'base_url',
  'basepath',
  'base_path',
];

function isSensitiveParamKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (SENSITIVE_PARAM_KEYS.has(normalized)) {
    return true;
  }
  return SENSITIVE_PARAM_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Bounded recursion guard for pathological / cyclic parameter graphs. */
const MAX_SANITIZE_DEPTH = 8;

function sanitizeParamValue(value: unknown, depth: number): unknown {
  if (typeof value === 'function') {
    return undefined;
  }
  if (Array.isArray(value)) {
    return depth >= MAX_SANITIZE_DEPTH
      ? undefined
      : value.map((item) => sanitizeParamValue(item, depth + 1));
  }
  if (value != null && typeof value === 'object') {
    if (depth >= MAX_SANITIZE_DEPTH) {
      return undefined;
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveParamKey(key) || typeof child === 'function') {
        continue;
      }
      sanitized[key] = sanitizeParamValue(child, depth + 1);
    }
    return sanitized;
  }
  return value;
}

/**
 * The resolved Anthropic `thinking` parameter is a provider-format object
 * (`{ type: 'enabled' | 'disabled' | 'adaptive', budget_tokens? }`) for Opus/Sonnet
 * 4+, but the request body — and the compact-convo schema (`thinking: z.boolean()`)
 * that the resume replay is validated against — expects the UI form. A stray object
 * fails that field, and the schema's `.catch(() => ({}))` drops the WHOLE parse
 * (`model`/`spec` included), surfacing as `missing_model` on resume of a
 * custom-endpoint ephemeral agent (#14253). Convert it back to
 * `{ thinking: boolean, thinkingBudget?, thinkingDisplay? }` so the replayed params
 * round-trip cleanly (an explicit `display: 'omitted'` choice survives too).
 */
function normalizeThinkingParam(params: Record<string, unknown>): void {
  const thinking = params.thinking;
  if (thinking == null || typeof thinking !== 'object' || Array.isArray(thinking)) {
    return;
  }
  const {
    type,
    display,
    budget_tokens: budget,
  } = thinking as {
    type?: unknown;
    display?: unknown;
    budget_tokens?: unknown;
  };
  params.thinking = type !== 'disabled';
  if (params.thinkingBudget == null && typeof budget === 'number') {
    params.thinkingBudget = budget;
  }
  if (params.thinkingDisplay == null && typeof display === 'string') {
    params.thinkingDisplay = display;
  }
}

/**
 * A non-default adaptive-thinking effort resolves into
 * `invocationKwargs.output_config.effort` (see `configureReasoning`), while the
 * request-body schema only accepts a top-level `effort`. Lift it back so the resumed
 * turn keeps the paused run's effort, and drop `invocationKwargs` entirely — it's
 * resolved transport config the compact-convo schema would discard anyway.
 */
function normalizeEffortParam(params: Record<string, unknown>): void {
  const kwargs = params.invocationKwargs as { output_config?: { effort?: unknown } } | undefined;
  if (kwargs == null || typeof kwargs !== 'object') {
    return;
  }
  const effort = kwargs.output_config?.effort;
  if (params.effort == null && typeof effort === 'string') {
    params.effort = effort;
  }
  delete params.invocationKwargs;
}

/**
 * Strip credentials and server transport config from resolved model parameters before
 * they are persisted for resume replay. The initialized agent's `model_parameters` are
 * the resolved `llmConfig` — they carry provider secrets (`apiKey`, Azure key names,
 * Google `authOptions`, Bedrock `credentials`) and gateway config (`configuration`,
 * headers, base URLs). Resume re-resolves all of those server-side from env/config, so
 * only the user-level generation params (temperature, max tokens, custom endpoint
 * params, …) need to survive the round trip. Provider-format params that conflict with
 * the request-body schema on replay are normalized back to the UI form (see
 * {@link normalizeThinkingParam}).
 */
export function sanitizeResumeModelParameters(
  params: unknown,
): Record<string, unknown> | undefined {
  if (params == null || typeof params !== 'object' || Array.isArray(params)) {
    return undefined;
  }
  const sanitized = sanitizeParamValue(params, 0) as Record<string, unknown>;
  normalizeThinkingParam(sanitized);
  normalizeEffortParam(sanitized);
  return sanitized;
}

/** Bedrock body params its compact schema accepts; hand-listed because
 *  `bedrockInputSchema` wraps the pick in a transform, hiding `.shape`. */
const BEDROCK_PARAM_KEYS = [
  'region',
  'system',
  'maxTokens',
  'reasoning_effort',
  'additionalModelRequestFields',
];

/** Schema-accepted keys owned elsewhere: replayed via {@link RESUME_CONTEXT_KEYS}
 *  (`model`, `spec`, `promptPrefix`, `modelLabel`) or derived server-side / identity
 *  fields the resume request must keep as its own. */
const RESUME_PARAM_EXCLUDED = new Set([
  'model',
  'spec',
  'iconURL',
  'greeting',
  'modelLabel',
  'promptPrefix',
  'chatProjectId',
]);

/**
 * Request-body generation params worth replaying on resume: the union of the
 * compact-convo schemas' fields. Only these keys can influence the rebuilt run —
 * `buildOptions` derives `model_parameters` from the PARSED body, and
 * `parseCompactConvo` strips everything else.
 */
const RESUME_PARAM_KEYS: string[] = Array.from(
  new Set(
    [openAIBaseSchema, anthropicBaseSchema, googleBaseSchema]
      .flatMap((schema) => Object.keys(schema.shape))
      .concat(BEDROCK_PARAM_KEYS),
  ),
).filter((key) => !RESUME_PARAM_EXCLUDED.has(key));

/**
 * Capture the model parameters to replay on resume. The paused request body is the
 * primary source — its fields are UI-form by construction (they already round-tripped
 * `parseCompactConvo` on the original turn), so replaying them can't trip the schema.
 * The resolved llmConfig only fills gaps: it's provider-format, where params are
 * renamed (`maxOutputTokens` → `maxTokens`, `top_p` → `topP`), relocated
 * (`effort` → `invocationKwargs`), or retyped (`thinking` → object) — the schema
 * silently drops or, worse, fails on them (see the `normalize*` helpers, #14253).
 */
export function captureResumeModelParameters(
  body: Record<string, unknown> | undefined | null,
  resolvedParams: unknown,
): Record<string, unknown> | undefined {
  const captured = sanitizeResumeModelParameters(resolvedParams) ?? {};
  if (body != null && typeof body === 'object') {
    for (const key of RESUME_PARAM_KEYS) {
      if (body[key] !== undefined) {
        captured[key] = sanitizeParamValue(body[key], 1);
      }
    }
    const reasoningOverride = reasoningOverrideSchema.safeParse(body.reasoningOverride);
    if (reasoningOverride.success) {
      captured[reasoningOverride.data.key] = reasoningOverride.data.value;
      if (
        reasoningOverride.data.key === 'effort' ||
        reasoningOverride.data.key === 'thinkingLevel' ||
        reasoningOverride.data.key === 'thinkingBudget'
      ) {
        captured.thinking = true;
      }
    }
  }
  return Object.keys(captured).length > 0 ? captured : undefined;
}

/** Extract the graph-determining fields from a request body for durable replay. */
export function pickResumeContext(body: Record<string, unknown> | undefined | null): ResumeContext {
  const ctx: ResumeContext = {};
  if (body == null) {
    return ctx;
  }
  for (const key of RESUME_CONTEXT_KEYS) {
    if (body[key] !== undefined) {
      ctx[key] = body[key];
    }
  }
  return ctx;
}

/**
 * Replay a persisted resume context onto a request body so the rebuilt run matches the
 * paused one. Every graph-determining field is forced to the persisted value: a key the
 * context HAS overwrites whatever the client sent; a key it LACKS is deleted from the
 * body. The delete is the security half — without it, a field the paused turn never
 * carried (e.g. `addedConvo`, which {@link computeAgentRequestFingerprint} does NOT
 * cover) could be injected by a crafted resume to rebuild the paused single-agent
 * checkpoint as a different multi-agent graph/tool set.
 */
export function applyResumeContext(
  body: Record<string, unknown> | undefined | null,
  ctx: ResumeContext | undefined | null,
): void {
  if (body == null || ctx == null) {
    return;
  }
  for (const key of RESUME_CONTEXT_KEYS) {
    if (ctx[key] !== undefined) {
      body[key] = ctx[key];
    } else {
      delete body[key];
    }
  }
}

/** Request-envelope fields that resolved provider params must never replace. */
const RESUME_REQUEST_CONTROL_KEYS = new Set<string>([
  ...RESUME_CONTEXT_KEYS,
  'conversationId',
  'generationCreatedAt',
  'generationProtocolVersion',
  'actionId',
  'decisions',
  'answer',
  'answers',
  'isTemporary',
]);

/**
 * Replay captured generation parameters without allowing provider configuration to
 * replace routing, graph identity, or resume-action fields. This guard also makes
 * pending actions captured by older versions safe to resume after an upgrade.
 */
export function applyResumeModelParameters(
  body: Record<string, unknown> | undefined | null,
  params: unknown,
): void {
  if (body == null || params == null || typeof params !== 'object' || Array.isArray(params)) {
    return;
  }
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (!RESUME_REQUEST_CONTROL_KEYS.has(key)) {
      body[key] = value;
    }
  }
}

export function computeAgentRequestFingerprint(fields: AgentRequestFingerprintFields): string {
  const canonical = JSON.stringify({
    endpoint: fields.endpoint ?? null,
    endpointType: fields.endpointType ?? null,
    agent_id: fields.agent_id ?? null,
    model: fields.model ?? null,
    spec: fields.spec ?? null,
    promptPrefix: fields.promptPrefix ?? null,
    ephemeralAgent: normalizeEphemeralAgent(fields.ephemeralAgent),
    ...(Object.prototype.hasOwnProperty.call(fields, 'codeApprovalMode')
      ? { codeApprovalMode: fields.codeApprovalMode ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(fields, 'codeEnvironmentMode')
      ? { codeEnvironmentMode: fields.codeEnvironmentMode ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(fields, 'codeWorkspaces')
      ? { codeWorkspaces: fields.codeWorkspaces ?? null }
      : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Fingerprint understood by replicas predating conversation-owned code environments.
 * Writers retain it in `requestFingerprint` while also storing the stricter current
 * fingerprint, allowing either replica generation to resume safely during a rollout.
 */
export function computeLegacyAgentRequestFingerprint(
  fields: AgentRequestFingerprintFields,
): string {
  const canonical = JSON.stringify({
    endpoint: fields.endpoint ?? null,
    endpointType: fields.endpointType ?? null,
    agent_id: fields.agent_id ?? null,
    model: fields.model ?? null,
    spec: fields.spec ?? null,
    promptPrefix: fields.promptPrefix ?? null,
    ephemeralAgent: normalizeEphemeralAgent(fields.ephemeralAgent),
    ...(Object.prototype.hasOwnProperty.call(fields, 'codeApprovalMode')
      ? { codeApprovalMode: fields.codeApprovalMode ?? null }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(fields, 'codeWorkspaces')
      ? { codeWorkspaces: fields.codeWorkspaces ?? null }
      : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Wrap a HumanInterruptPayload (from the SDK or synthesized locally) as a
 * {@link Agents.PendingAction} record persisted with the job.
 *
 * Accepts both interrupt categories (`tool_approval` and `ask_user_question`)
 * via the discriminated union — the host doesn't need to branch.
 */
export function buildPendingAction(
  payload: Agents.HumanInterruptPayload,
  ctx: PendingActionContext,
): Agents.PendingAction {
  if (payload.type === 'tool_approval' && !isToolApprovalPayloadValid(payload)) {
    throw new Error('Invalid tool approval payload');
  }
  const createdAt = Date.now();
  const ttlExpiresAt = typeof ctx.ttlMs === 'number' ? createdAt + ctx.ttlMs : undefined;
  let absoluteExpiresAt: number | undefined;
  if (typeof ctx.expiresAt === 'number') {
    absoluteExpiresAt = ctx.expiresAt;
  } else if (ctx.expiresAt instanceof Date) {
    absoluteExpiresAt = ctx.expiresAt.getTime();
  } else if (typeof ctx.expiresAt === 'string') {
    absoluteExpiresAt = new Date(ctx.expiresAt).getTime();
  }
  const finiteAbsoluteExpiresAt = Number.isFinite(absoluteExpiresAt)
    ? absoluteExpiresAt
    : undefined;
  let expiresAt = ttlExpiresAt;
  if (finiteAbsoluteExpiresAt != null) {
    expiresAt =
      ttlExpiresAt == null
        ? finiteAbsoluteExpiresAt
        : Math.min(ttlExpiresAt, finiteAbsoluteExpiresAt);
  }
  return {
    actionId: ctx.actionId ?? randomUUID(),
    streamId: ctx.streamId,
    conversationId: ctx.conversationId,
    runId: ctx.runId,
    responseMessageId: ctx.responseMessageId,
    payload,
    createdAt,
    expiresAt,
    interruptId: ctx.interruptId,
    threadId: ctx.threadId,
    requestFingerprint: ctx.requestFingerprint,
    requestFingerprintV2: ctx.requestFingerprintV2,
    resumeContext: ctx.resumeContext,
    codeExecutionBinding: ctx.codeExecutionBinding,
  };
}

/**
 * Client-facing projection of a pending action. `requestFingerprint`, `resumeContext`, and
 * `codeExecutionBinding`
 * are server-only replay state — `resumeContext` in particular carries the resolved
 * model parameters — so every copy that leaves the server (SSE, status, resume state)
 * must go through this. The full record stays in the job store for the resume route.
 */
export function toClientPendingAction(
  pendingAction: Agents.PendingAction | undefined | null,
): Agents.PendingAction | undefined {
  if (pendingAction == null) {
    return undefined;
  }
  const {
    requestFingerprint: _requestFingerprint,
    requestFingerprintV2: _requestFingerprintV2,
    resumeContext: _resumeContext,
    codeExecutionBinding: _codeExecutionBinding,
    ...clientSafe
  } = pendingAction;
  return clientSafe;
}

/**
 * Exempt `ask_user_question` from the tool-approval prompt unless the admin
 * mentioned it EXPLICITLY (in `allow`, `ask`, or `deny`). With approval enabled
 * in its default prompt-everything mode, the ask tool would otherwise trigger
 * an approval card for the act of asking a question — a double pause with no
 * safety upside: the tool is side-effect-free by construction (it only asks;
 * the payload is length-capped and rendered as text). An explicit admin entry
 * still wins, in either direction.
 */
export function exemptAskUserQuestionFromApproval(
  policy: TToolApprovalPolicy | undefined,
  toolName: string,
): TToolApprovalPolicy | undefined {
  if (!policy) {
    return policy;
  }
  const mentioned =
    policy.allow?.includes(toolName) === true ||
    policy.ask?.includes(toolName) === true ||
    policy.deny?.includes(toolName) === true;
  if (mentioned) {
    return policy;
  }
  return { ...policy, allow: [...(policy.allow ?? []), toolName] };
}
