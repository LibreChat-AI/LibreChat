import { createHash } from 'node:crypto';
import type { AgentInputs } from '@librechat/agents';
import type * as t from '~/types';
import { canonicalize } from '~/utils/canonicalize';

/**
 * Bumped when the hashed payload's shape changes, so an upgraded deployment
 * stops colliding with keys written by the previous shape instead of pointing
 * two different prefixes at one cache entry.
 */
export const PROMPT_CACHE_KEY_VERSION = 4;

/**
 * Everything a projection needs that is not the value itself.
 */
interface PromptCacheProjectionContext {
  /**
   * What each tool definition this conversation discovered looked like before
   * discovery touched it, keyed by name. `appended` means the definition was
   * not part of the configured request at all and leaves the identity;
   * otherwise `deferLoading` is the configured value discovery overwrote, put
   * back so a discovering and a fresh conversation hash the same agent.
   */
  readonly configuredToolState: t.PromptCacheConfiguredToolState | undefined;
}

type PromptCacheProjection = (value: unknown, context: PromptCacheProjectionContext) => unknown;

/**
 * Fields `createRun` writes for its own use and removes before the request is
 * sent. Declared once: a marker that reaches the digest, the wire, or an
 * agent author's reach is a defect, and three separate hand-kept lists is how
 * one gets there.
 */
export const PROMPT_CACHE_MARKER_FIELDS = [
  'promptCacheKeyEnabled',
  'promptCacheScope',
  'promptCacheScopeId',
  'promptCacheStableInstructions',
  'promptCacheConfiguredToolState',
] as const;

/**
 * The request-body spellings of the same controls, which `modelKwargs` would
 * otherwise forward verbatim. Administrator levers in another alphabet.
 */
export const PROMPT_CACHE_WIRE_FIELDS = [
  'prompt_cache_key',
  'prompt_cache_retention',
  'prompt_cache_options',
  'prompt_cache_breakpoint',
] as const;

/**
 * Each prompt-cache lever under every name an operator can drop it by.
 *
 * A lever does not stay where it was written: a value an administrator placed
 * in `modelKwargs` under the request-body spelling is promoted onto the
 * constructor field, because the serializer spreads the kwargs first and would
 * otherwise overwrite it with `undefined`. The generic `dropParams` cascade
 * looks only for the name it was given, so a lever resolved in one alphabet
 * and dropped in the other survived the drop. Matching and removal both read
 * this table, once, after that cascade has run.
 */
export const PROMPT_CACHE_KEY_LEVER = {
  field: 'promptCacheKey',
  wire: ['prompt_cache_key'],
} as const;

export const PROMPT_CACHE_RETENTION_LEVER = {
  field: 'promptCacheRetention',
  wire: ['prompt_cache_retention'],
} as const;

export const PROMPT_CACHE_EXPLICIT_LEVER = {
  field: 'promptCacheExplicit',
  wire: ['prompt_cache_options', 'prompt_cache_breakpoint'],
} as const;

export const PROMPT_CACHE_LEVERS = [
  PROMPT_CACHE_KEY_LEVER,
  PROMPT_CACHE_RETENTION_LEVER,
  PROMPT_CACHE_EXPLICIT_LEVER,
] as const;

export type PromptCacheLever = (typeof PROMPT_CACHE_LEVERS)[number];

/**
 * Whether an operator dropped this lever, under either of its names.
 */
export function isPromptCacheLeverDropped(
  lever: PromptCacheLever,
  dropParams?: string[] | null,
): boolean {
  if (dropParams == null) {
    return false;
  }
  return dropParams.includes(lever.field) || lever.wire.some((name) => dropParams.includes(name));
}

/**
 * Everything prompt caching is configured with, which is an administrator's
 * decision alone: the markers above plus the three wire levers. Stripped from
 * author-owned model parameters before policy resolution.
 */
export const PROMPT_CACHE_ADMIN_FIELDS = [
  'promptCacheKey',
  'promptCacheRetention',
  'promptCacheExplicit',
  ...PROMPT_CACHE_MARKER_FIELDS,
] as const;

/**
 * What one field of a finished agent input contributes to the cached prefix's
 * identity.
 *
 * `identity` fields are hashed, optionally through a projection for values
 * `canonicalize` cannot walk. `excluded` fields carry the reason they cannot
 * change the prefix, which is the part that has to survive review: an
 * exclusion is a claim about the wire request, and a wrong one is exactly the
 * defect this module keeps being corrected for.
 */
type PromptCacheDisposition =
  | { readonly role: 'identity'; readonly project?: PromptCacheProjection }
  | { readonly role: 'excluded'; readonly because: string };

const identity = (project?: PromptCacheProjection): PromptCacheDisposition => ({
  role: 'identity',
  ...(project != null ? { project } : {}),
});

const excluded = (because: string): PromptCacheDisposition => ({ role: 'excluded', because });

/**
 * Client options a request sends for reasons other than the prompt: sampling,
 * transport, credentials, and the host's own cache markers. Everything else on
 * the object shapes how the instruction and tool prefix is serialized, so it
 * reaches {@link clientOptionsIdentity}.
 *
 * Kept as an exclusion list rather than a selection, because per-request
 * transport data is the one thing that must never enter a cross-conversation
 * identity: `resolveConfigHeaders` resolves `${conversationId}` and per-user
 * token placeholders into `configuration.defaultHeaders`, so hashing the
 * transport would partition the cache per conversation and per turn.
 */
/**
 * One field, two spellings. LangChain takes `topP` where the provider
 * documents `top_p`, and `addParams` lets an administrator write either — the
 * unknown one lands in `modelKwargs` and the known one on the options object,
 * but both mean the same request. Exclusions are matched on a normalized form
 * so a set has to name a field once rather than in every alphabet it arrives
 * in, which is where this kept going wrong.
 */
function normalizeOptionKey(key: string): string {
  return key.replace(/_/g, '').toLowerCase();
}

function normalizedKeySet(keys: readonly string[]): ReadonlySet<string> {
  return new Set(keys.map(normalizeOptionKey));
}

const nonPrefixClientOptionNames: readonly string[] = [
  /** Credentials and transport. */
  'apiKey',
  'organization',
  'configuration',
  'clientConfig',
  'client',
  'streaming',
  'streamUsage',
  'usage',
  'timeout',
  'maxRetries',
  'callbacks',
  'callbackManager',
  'metadata',
  'tags',
  'cache',
  'verbose',
  'disableStreaming',
  '_lc_stream_delay',
  'streamSmoothing',
  /**
   * Sampling and budget parameters. They change what the model returns, never
   * the prefix it reads, and a user moving one of these sliders mid-project
   * must not retire the cached prefix.
   */
  'temperature',
  'topP',
  'top_p',
  'topLogprobs',
  'logprobs',
  'logitBias',
  'frequencyPenalty',
  'presencePenalty',
  'n',
  'seed',
  'stop',
  'stopSequences',
  /** Scheduling and cost, not prefix: `default`, `flex` and `priority` read one prompt. */
  'service_tier',
  'serviceTier',
  'maxTokens',
  'maxCompletionTokens',
  'max_tokens',
  'reasoning',
  'reasoning_effort',
  'verbosity',
  'includeReasoningContent',
  'include_reasoning',
  'reasoningKey',
  'user',
  /** Cache levers. The key cannot hash itself, and the rest only route it. */
  ...PROMPT_CACHE_ADMIN_FIELDS,
  'promptCache',
  'promptCacheTtl',
  /**
   * Azure credentials. `getOpenAILLMConfig` copies the resource key onto the
   * Chat Completions options, and rotating a key changes nothing the model
   * reads — the deployment below is what identifies the request.
   */
  'azureOpenAIApiKey',
  'azureOpenAIBasePath',
  'azureOpenAIEndpoint',
  'azureADTokenProvider',
  ...PROMPT_CACHE_WIRE_FIELDS,
  'firstPartyEndpoint',
  'useLegacyContent',
  'provider',
  'fallbacks',
  /** Streaming delivery, in both spellings. */
  'stream',
  'streamOptions',
  /** The Responses output cap, which a stored agent can set at the top level. */
  'maxOutputTokens',
  /**
   * Which of the bound tools the model may call this turn. The schemas it
   * chooses among are hashed above; the choice policy is not part of the
   * prefix they form. `functionCall` is the legacy spelling of the same
   * decision, and `knownOpenAIParams` still accepts it, so it belongs here
   * with its successors rather than partitioning the cache on its own.
   */
  'toolChoice',
  'parallelToolCalls',
  'functionCall',
];

const nonPrefixClientOptionKeys = normalizedKeySet(nonPrefixClientOptionNames);

/**
 * Reasoning and verbosity controls the SDK routes through `modelKwargs`. A
 * user can change either mid-project, and neither changes the instruction or
 * tool prefix the model reads, so they must not retire a cached prefix. The
 * rest of `modelKwargs` is admin-configured (`addParams`) or wire identity
 * (`model` carries the Azure Astra deployment), so it is hashed.
 */
const nonPrefixModelKwargsKeys = normalizedKeySet([
  'verbosity',
  'reasoning',
  'reasoning_effort',
  'reasoning_summary',
  'reasoning_mode',
  'reasoning_context',
  'max_tokens',
  'max_completion_tokens',
  'max_output_tokens',
  /**
   * Sampling in its provider spelling: `knownOpenAIParams` carries only the
   * camelCase names, so these arrive here instead of on the options object.
   */
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'top_logprobs',
  'stream_options',
  /** And the cache levers themselves, which route the key without shaping it. */
  ...PROMPT_CACHE_WIRE_FIELDS,
  ...PROMPT_CACHE_ADMIN_FIELDS,
]);

/**
 * `applyResponsesVerbosity` moves verbosity onto `modelKwargs.text`, and a
 * Responses agent can supply the native shape on the top-level `text` — both
 * carry the output schema and the verbosity on one object. Only the verbosity
 * leaves; a different JSON schema there is a different prefix.
 */
function responsesTextIdentity(value: unknown): unknown {
  if (value == null || typeof value !== 'object') {
    return safeIdentity(value);
  }
  const { verbosity: _verbosity, ...rest } = value as Record<string, unknown>;
  return safeIdentity(rest);
}

/**
 * An absent field, an empty string, an empty list and an empty object all
 * describe the same absent surface, and have to hash the same way: the
 * difference between `tools: []` and no `tools` at all is not something the
 * model can see.
 */
function isAbsentSurface(value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    /** Plain records, including the null-prototype ones the projections build. */
    if (prototype === Object.prototype || prototype === null) {
      return Object.keys(value).length === 0;
    }
  }
  return false;
}

function modelKwargsIdentity(value: unknown): unknown {
  if (value == null || typeof value !== 'object') {
    return safeIdentity(value);
  }
  const kwargs = value as Record<string, unknown>;
  const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(kwargs)) {
    if (nonPrefixModelKwargsKeys.has(normalizeOptionKey(key))) {
      continue;
    }
    const value = key === 'text' ? responsesTextIdentity(kwargs[key]) : safeIdentity(kwargs[key]);
    if (isAbsentSurface(value)) {
      continue;
    }
    projected[key] = value;
  }
  return projected;
}

/**
 * Fields whose own shape decides what belongs in the identity: the request
 * kwargs and the Responses `text` object, which carry the output schema
 * alongside settings that do not reach the prefix.
 */
const clientOptionProjections: Record<string, ((value: unknown) => unknown) | undefined> = {
  modelKwargs: modelKwargsIdentity,
  text: responsesTextIdentity,
};

/**
 * The finalized wire identity of one request's prefix.
 *
 * `model` is the model the request actually addresses, which on Azure Astra is
 * the deployment carried in the `modelKwargs` override rather than the visible
 * name in `model`. `useResponsesApi` is part of it because Chat Completions and
 * the Responses API serialize the same instructions and tools into different
 * wire shapes, so one identity must not cover both. Everything else that is
 * not excluded above rides along under its own name, which is what stops a
 * newly supported request field from silently sharing an older identity.
 */
function clientOptionsIdentity(value: unknown): unknown {
  if (value == null || typeof value !== 'object') {
    return null;
  }
  const options = value as Partial<t.OAIClientOptions> & {
    modelKwargs?: { model?: unknown };
    [key: string]: unknown;
  };
  const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (nonPrefixClientOptionKeys.has(normalizeOptionKey(key))) {
      continue;
    }
    const projectedValue =
      clientOptionProjections[key]?.(options[key]) ?? safeIdentity(options[key]);
    if (isAbsentSurface(projectedValue)) {
      continue;
    }
    projected[key] = projectedValue;
  }
  projected.model =
    typeof options.modelKwargs?.model === 'string' ? options.modelKwargs.model : options.model;
  /**
   * Two states, not three: `false` and absent both select Chat Completions, so
   * an agent that spells the default out must reuse the entry of one that does
   * not.
   */
  projected.useResponsesApi = options.useResponsesApi === true ? 'responses' : 'chat-completions';
  return projected;
}

/**
 * Projects a value onto something stable to hash.
 *
 * Plain JSON — a schema-only tool definition, a structured-output schema, a
 * handoff edge — is hashed whole, because fields beyond the schema decide how
 * the model sees it: `defer_loading` withholds a tool from the binding until
 * tool search finds it, and `allowed_callers` can keep it off the model's
 * direct surface entirely. An allowlist of name, description and parameters
 * would let those flip without retiring the key.
 *
 * A runtime instance carries a Zod schema instead, which `canonicalize`
 * cannot represent: it drops the `shape` thunk that holds an object's fields,
 * and it refuses the self-reference an action built from an OpenAPI document
 * carries. Name and description alone would not be an identity:
 * a user-defined action's schema is editable at runtime, so its parameters
 * can change under an unchanged name and the prefix would move beneath a
 * key that stayed still. The shape is walked instead, guarded against the
 * cycles that made the schema unserializable in the first place.
 */
/**
 * A work budget, not a depth limit. A depth cutoff collapsed every subtree
 * below it to one constant, so two schemas sharing their first twelve levels
 * and differing underneath hashed identically — a collision, which is the one
 * failure mode this module exists to prevent. Cycles are already stopped by
 * the `seen` set; what remains to bound is total work, and counting nodes
 * bounds it without erasing structure at a fixed depth.
 *
 * Both bounds are horizons, not proofs: two schemas identical up to whichever
 * one they reach and differing past it still share `[truncated]` and so share
 * an identity. That is the same class the old cutoff made reachable at twelve
 * levels, moved out to sizes no Zod schema written by hand reaches, and
 * removing it for good means declining to key a request whose schema could
 * not be represented. Tracked at berry-13/LibreChat#63.
 */
const RUNTIME_SHAPE_NODE_BUDGET = 5000;

/**
 * A recursion bound, kept separate from the work budget because it guards a
 * different failure: the walk is recursive, so depth alone can exhaust the
 * call stack and throw `RangeError` while a key is being built, failing the
 * request outright. Twelve was low enough that ordinary schemas collided
 * under it; this is past anything a schema reaches and far short of the
 * stack.
 */
const RUNTIME_SHAPE_MAX_DEPTH = 64;

/**
 * The whole declared definition of a Zod schema, not a list of the fields
 * that seemed to matter: a constraint lives in `_def.checks`, a literal's
 * value in `_def.value`, a union's members in `_def.options`, and each of
 * those changes the schema the model is shown. Enumerating them by hand
 * means the next one is a collision, so every own entry is walked and the
 * type carries no privilege.
 *
 * Reading `_def` is reading an internal, and that is the safe direction: a
 * Zod release that reshapes it changes every digest at once, which retires
 * keys rather than colliding them. Functions are recorded as their presence
 * only, except a default's thunk: a refinement body cannot be hashed stably
 * and does not reach the wire.
 */
/**
 * Two Zod thunks hold what the JSON schema the model is shown carries: a
 * default's value and a lazy schema's target. Their results are what the
 * identity hashes; the walk's cycle and work guards still apply to a lazy
 * schema that refers back to itself. A thunk that throws is recorded as its
 * presence, like any other function.
 */
const SERIALIZED_THUNKS: Record<string, string> = { defaultValue: 'default', getter: 'lazy' };

function serializedThunk(key: string, entry: unknown): unknown {
  const label = Object.prototype.hasOwnProperty.call(SERIALIZED_THUNKS, key)
    ? SERIALIZED_THUNKS[key]
    : undefined;
  if (label == null || typeof entry !== 'function') {
    return entry;
  }
  try {
    return { [label]: (entry as () => unknown)() };
  } catch {
    return entry;
  }
}

function runtimeSchemaShape(
  value: unknown,
  seen: Set<object>,
  budget: { left: number } = { left: RUNTIME_SHAPE_NODE_BUDGET },
  depth = 0,
): unknown {
  if (typeof value === 'function') {
    return '[fn]';
  }
  if (value == null || typeof value !== 'object') {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? value
      : null;
  }
  /**
   * A regular expression carries everything it means on two non-enumerable
   * properties, so the generic branch below would read no own keys and file
   * every pattern under one empty identity — while the schema the model is
   * shown spells the pattern out. A Zod `regex` check, and an OpenAPI
   * `pattern` translated into one, both arrive here.
   */
  if (value instanceof RegExp) {
    return { source: value.source, flags: value.flags };
  }
  if (seen.has(value)) {
    return '[cycle]';
  }
  if (budget.left <= 0 || depth >= RUNTIME_SHAPE_MAX_DEPTH) {
    return '[truncated]';
  }
  budget.left -= 1;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => runtimeSchemaShape(entry, seen, budget, depth + 1));
    }
    const node = value as { _def?: unknown; shape?: unknown };
    const walk = (entry: unknown): unknown => runtimeSchemaShape(entry, seen, budget, depth + 1);
    const entries = (source: unknown): unknown =>
      source != null && typeof source === 'object' && !Array.isArray(source)
        ? Object.keys(source as Record<string, unknown>)
            .sort()
            .map((key) => [
              key,
              walk(serializedThunk(key, (source as Record<string, unknown>)[key])),
            ])
        : walk(source);
    /**
     * `shape` is a getter on a Zod object and its keys are the schema the
     * model reads, so it is taken from the instance rather than from `_def`,
     * where it hides behind a thunk.
     */
    const shape = typeof node.shape === 'object' && node.shape != null ? node.shape : undefined;
    return {
      ...(node._def != null ? { def: entries(node._def) } : {}),
      ...(shape != null ? { shape: entries(shape) } : {}),
      ...(node._def == null && shape == null ? { value: entries(value) } : {}),
    };
  } finally {
    seen.delete(value);
  }
}

function runtimeToolIdentity(value: object): unknown {
  const candidate = value as { name?: unknown; description?: unknown; schema?: unknown };
  return {
    name: typeof candidate.name === 'string' ? candidate.name : null,
    ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
    ...(candidate.schema != null
      ? { schema: runtimeSchemaShape(candidate.schema, new Set()) }
      : {}),
  };
}

/**
 * A Zod schema keeps an object's fields behind its `shape` thunk, which
 * `canonicalize` drops like any function, so an acyclic schema canonicalizes
 * without throwing and without its fields. Recognized by `_def`, the schema
 * goes to the walk whether or not it is cyclic.
 */
function hasRuntimeSchema(value: object): boolean {
  const schema = (value as { schema?: unknown }).schema;
  return schema != null && typeof schema === 'object' && '_def' in schema;
}

function safeIdentity(value: unknown): unknown {
  if (value == null || typeof value !== 'object') {
    return typeof value === 'function' ? null : value;
  }
  if (hasRuntimeSchema(value)) {
    return runtimeToolIdentity(value);
  }
  try {
    return canonicalize(value);
  } catch {
    return runtimeToolIdentity(value);
  }
}

function toolsIdentity(value: unknown): unknown {
  return Array.isArray(value) ? value.map(safeIdentity) : safeIdentity(value);
}

/**
 * The definitions the agent is configured to send, which is a narrower set
 * than the ones the request carries: `buildAgentInput` promotes a deferred
 * tool's definition onto the request once a conversation has discovered it
 * through `tool_search`. Hashing those would make the identity follow each
 * conversation's discovery state — the one thing the key exists to be
 * independent of.
 */
function toolDefinitionsIdentity(value: unknown, context: PromptCacheProjectionContext): unknown {
  const state = context.configuredToolState;
  if (!Array.isArray(value) || state == null) {
    return toolsIdentity(value);
  }
  const identities: unknown[] = [];
  for (const tool of value) {
    const name = (tool as { name?: unknown } | null)?.name;
    const configured =
      typeof name === 'string' && Object.prototype.hasOwnProperty.call(state, name)
        ? state[name]
        : undefined;
    if (configured == null) {
      identities.push(safeIdentity(tool));
      continue;
    }
    if (configured.appended === true) {
      continue;
    }
    /**
     * Configured, and still hashed: only the flag discovery overwrote is put
     * back — to its recorded value, which may be `false` or absent after an
     * administrator changed it — so a change to this tool's schema or
     * classification still retires the key while discovering it does not.
     */
    const restored: Record<string, unknown> = { ...(tool as Record<string, unknown>) };
    if (configured.deferLoading === undefined) {
      delete restored.defer_loading;
    } else {
      restored.defer_loading = configured.deferLoading;
    }
    identities.push(safeIdentity(restored));
  }
  return identities;
}

/**
 * Projects the delegation tool the SDK generates from an agent's subagent
 * entries. `type` is the value that tool accepts as `subagent_type`, so a
 * child swapped for a different agent under the same display name changes the
 * enum the model sees.
 *
 * The rest of an entry stays out for a reason the tool projection does not
 * share: an entry carries the child's whole `agentInputs`, including the
 * child's own cache key, and a lazy entry carries a resolver function, so
 * hashing one whole would be both self-referential and unstable. `maxTurns`
 * and `allowNested` govern execution and never reach the model.
 */
function subagentConfigsIdentity(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return safeIdentity(value);
  }
  return value.map((entry) => {
    const config = entry as { name?: unknown; description?: unknown; type?: unknown };
    return {
      name: typeof config.name === 'string' ? `subagent:${config.name}` : null,
      description: typeof config.description === 'string' ? config.description : null,
      subagentType: typeof config.type === 'string' ? config.type : null,
    };
  });
}

/**
 * Every field of a finished `AgentInputs`, declared either as part of the
 * prompt identity or excluded with the reason it cannot change the prefix.
 *
 * Typed as a total map over `keyof AgentInputs` on purpose. The defect this
 * module was corrected for six times is the same one every time: a
 * model-facing surface that no one added to a hand-picked field list — tool
 * definitions, generated delegation tools, handoff edges, the subagent type
 * enum, the Responses output format, the API mode. A total map turns the next
 * one into a build failure in this file instead of a cache entry serving two
 * different prefixes, and a field present at runtime but absent from the map
 * is hashed rather than dropped, so a newer SDK than these types partitions
 * (a miss) instead of colliding (a wrong identity).
 */
const agentInputDispositions: Record<keyof AgentInputs, PromptCacheDisposition> = {
  /** The stable system prefix, and the wire shape it is serialized into. */
  instructions: identity(),
  clientOptions: identity(clientOptionsIdentity),
  /** Every surface the model is offered a tool from. */
  tools: identity(toolsIdentity),
  toolDefinitions: identity(toolDefinitionsIdentity),
  graphTools: identity(toolsIdentity),
  subagentConfigs: identity(subagentConfigsIdentity),
  /** The SDK puts an agent's name in the handoff context the model reads. */
  name: identity(),

  additional_instructions: excluded(
    'The dynamic system tail: the author\u2019s configured text joined with shared run context, memory, file context and dynamic tool instructions, rebuilt every turn. Hashing the joined string would partition the cache per conversation, which is where reuse is wanted; the configured half and an isolated child\u2019s always-apply skill bodies are hashed through the promptCacheStableInstructions marker instead.',
  ),
  discoveredTools: excluded(
    'Tool names this conversation already discovered through tool_search. The key names the agent as configured, not one turn\u2019s deferred-tool binding; hashing per-conversation discovery would give every chat its own entry.',
  ),
  toolRegistry: excluded(
    'The tool-search corpus. Only toolDefinitions reach the model binding, and a deferred entry stays off the prefix until discovery, which is per conversation.',
  ),
  toolMap: excluded('Executor wiring for direct tools; the bound surface is the arrays above.'),
  agentId: excluded(
    'Host identifier, never sent. Two agents whose prefix is byte-identical should share one entry.',
  ),
  provider: excluded('Selects the client. The wire model above carries routing identity.'),
  endpoint: excluded('Host routing label, not part of any request body.'),
  codeSessionKey: excluded('Partitions code-session ids and file refs, not the prompt.'),
  maxSubagentDepth: excluded(
    'Seeds the nesting countdown; the host sets one constant whenever subagentConfigs exist, and the advertised delegation tool comes from those entries.',
  ),
  maxContextTokens: excluded('Context budget. Governs history, never the prefix.'),
  maxToolResultChars: excluded('Truncates tool results, which are conversation content.'),
  toolSchemaTokens: excluded('Precomputed token count of schemas already hashed above.'),
  summarizationEnabled: excluded('Whether a separate summarization request may run.'),
  summarizeOnly: excluded(
    'Turns this run into a summarization pass; the summary request carries its own key.',
  ),
  summarizationConfig: excluded(
    'Configuration of that separate request, including its own client options.',
  ),
  compactionSemanticIndex: excluded('Per-run guidance about the messages being compacted.'),
  initialSummary: excluded('Cross-run summary injected into the dynamic tail; per conversation.'),
  contextPruningConfig: excluded('Prunes history; no effect on the prefix.'),
  initialSessions: excluded('Tool-session state the child starts with.'),
  useLegacyContent: excluded('Formats message content blocks, which are conversation, not prefix.'),
  reasoningKey: excluded('Names the field reasoning is parsed back out of.'),
  toolEnd: excluded('Ends the run after a tool call; execution control.'),
  streamBuffer: excluded('Stream chunking.'),
  langfuse: excluded('Tracing.'),
};

/**
 * Everything about a request's prefix that is not on the input itself.
 */
export interface PromptCacheIdentityContext {
  /**
   * Outgoing handoff edges, which the SDK turns into model-facing
   * `lc_transfer_to_*` tools. They arrive on the graph rather than on the
   * input, so adding, removing or retargeting one changes the wire tool prefix
   * without touching any field above.
   */
  handoffEdges?: readonly unknown[];
}

/**
 * Deterministic `prompt_cache_key` for requests that share a stable prefix.
 *
 * Before GPT-5.6 this key is a routing hint: requests carrying it are steered
 * toward a machine already holding the matching prefix. From GPT-5.6 on OpenAI
 * routes automatically and the key instead partitions cache accounting, which
 * is also what prevents cache-hit probing between partitions.
 *
 * Either way the digest is derived, not registered: a real change to the
 * instructions, tool schemas, output schema or API mode produces a new
 * identity with no explicit invalidation step, so a stale prefix can never be
 * reused under a key that no longer describes it.
 *
 * What it does *not* name is the exact tool list of one turn. Deferred tools
 * enter the binding when a conversation discovers them, and the dynamic system
 * tail is rebuilt every turn; both are excluded above with their reasons,
 * because a key that followed them would give every conversation its own
 * entry and there would be nothing left to reuse.
 */
export function buildPromptCacheKey(
  input: AgentInputs,
  context: PromptCacheIdentityContext = {},
): string {
  const markers = input.clientOptions as Partial<t.OAIClientOptions> | undefined;
  const projection: PromptCacheProjectionContext = {
    configuredToolState: markers?.promptCacheConfiguredToolState,
  };
  const payload: Record<string, unknown> = Object.assign(Object.create(null), {
    version: PROMPT_CACHE_KEY_VERSION,
    handoffEdges: (context.handoffEdges ?? []).map(safeIdentity),
  }) as Record<string, unknown>;
  const fields = input as unknown as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    const disposition = (agentInputDispositions as Record<string, PromptCacheDisposition>)[key];
    if (disposition?.role === 'excluded') {
      continue;
    }
    const value = fields[key];
    if (isAbsentSurface(value)) {
      continue;
    }
    const projected =
      disposition?.role === 'identity' && disposition.project != null
        ? disposition.project(value, projection)
        : safeIdentity(value);
    if (isAbsentSurface(projected)) {
      continue;
    }
    payload[key] = projected;
  }
  const options = markers;
  /**
   * Hashed with the prefix rather than appended to the key, so the user id an
   * operator sees in OpenAI's cache accounting stays opaque. `shared` opts the
   * whole deployment into one entry per prefix.
   */
  payload.scopeId =
    options?.promptCacheScope === 'shared' ? null : (options?.promptCacheScopeId ?? null);
  /**
   * Stable instruction sources the host appends to the volatile tail — an
   * isolated child's always-apply skill bodies — captured where they are known
   * to be stable, because by finalization they are indistinguishable from
   * memory and file context in the same string.
   */
  payload.stableInstructions = options?.promptCacheStableInstructions ?? null;

  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('base64url');
  return `librechat:${PROMPT_CACHE_KEY_VERSION}:${digest}`;
}
