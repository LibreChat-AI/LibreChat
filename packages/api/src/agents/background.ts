/**
 * @fileoverview Background tool calls.
 *
 * Lets the model dispatch an eligible (event-driven) tool call detached: the
 * host executor returns a synthetic handle immediately so the graph superstep
 * resolves, while the real work runs as a floating promise whose result lands
 * in an in-process registry. The model retrieves it via the
 * `check_background_task` poll tool. No `@librechat/agents` change is required —
 * a backgrounded call and the poll call are both synchronous from the graph's
 * view.
 *
 * Scope: execution remains owned by one Node process, independently of the
 * dispatch turn's abort signal. The host gives the detached invoke a separate
 * deadline signal and accepts a timeout only after the invoke settles; an
 * abort-resistant tool remains indeterminate and pollable. Terminal results
 * can also be persisted onto the invoking response so another run or replica
 * can consume them, but process death during execution does not recreate the
 * live tool. Ephemeral request-scoped MCP tools (runtime `{{LIBRECHAT_BODY_*}}`
 * placeholders) are never backgrounded — their connection is torn down at
 * request end, so the executor runs them in the foreground instead. Detached
 * subagents use the separate host task store; Redis-backed hosts may route
 * their poll/control operations to the owning process without moving the live
 * executor or making ordinary background tool results durable.
 *
 * Opt-in mirrors `deferred_tools`: an admin capability
 * (`AgentCapabilities.run_in_background`) gates the feature, and a per-tool
 * `tool_options[name].run_in_background` flag turns it on for a given tool,
 * which injects a `run_in_background` boolean into that tool's schema. The
 * code-execution pair (`execute_code`/`bash_tool`) is background-NATIVE:
 * while the capability is enabled it defaults on without a per-tool flag, and
 * an explicit `run_in_background: false` opts it out.
 *
 * @module packages/api/src/agents/background
 */

import { logger } from '@librechat/data-schemas';
import { createHash, randomUUID } from 'node:crypto';
import { Constants as AgentConstants } from '@librechat/agents';
import {
  Tools,
  Constants,
  imageGenTools,
  AGENT_BACKGROUND_SHUTDOWN_INTERRUPT_GRACE_MS_DEFAULT,
} from 'librechat-data-provider';
import type {
  LCTool,
  LCToolRegistry,
  JsonSchemaType,
  SubagentTaskClaim,
  SubagentTaskConfig,
  SubagentTaskSnapshot,
  SubagentTaskControlCommand,
  SubagentTaskControlResult,
  SubagentTaskStore,
} from '@librechat/agents';
import type {
  BackgroundToolResultClaim,
  BackgroundToolResultRecord,
} from '@librechat/data-schemas';
import type { AgentToolOptions, BackgroundTaskDelivery } from 'librechat-data-provider';
import type { BackgroundToolResultState } from './harvest';
import type { CapabilityToolNames } from './selection';
import {
  BACKGROUND_TASK_TIMEOUT_MS,
  BACKGROUND_TASK_SHUTDOWN_MESSAGE,
  BACKGROUND_SHUTDOWN_FLUSH_RESERVE_MS,
  BACKGROUND_SHUTDOWN_TEARDOWN_RESERVE_MS,
  type PendingBackgroundCompletion,
  type BackgroundToolDeadClaimRecovery,
  type BackgroundToolWakeupAdmission,
  type PendingBackgroundCompletionControls,
} from './backgroundCompletion';
import {
  CREATE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
} from './tools';
import {
  resolveToolOption,
  getSelectionNames,
  warnUnmatchedSelectionNames,
  synthesizeSelectionToolOptions,
} from './selection';
import { SUBAGENT_WAKEUP_GUIDANCE, agentUsesSubagentCompletionWakeups } from './subagentDelivery';
import { registerShutdownTask, getRemainingShutdownMs } from '~/app/shutdown';
import { SubagentTaskOwnerUnavailableError } from './subagentTaskRouting';
import { SET_MEMORY_TOOL_NAME, DELETE_MEMORY_TOOL_NAME } from './memory';
import { ASK_USER_QUESTION_TOOL_NAME } from './hitl/askUserQuestionTool';
import { normalizeActionToolName } from '~/actions/tools';
import { truncateMiddle } from '~/utils';

/** Argument the model sets on a tool call to dispatch it in the background. */
export const RUN_IN_BACKGROUND_ARG = 'run_in_background';

/** Log prefix for selection diagnostics, phrased in the spec's own field name. */
const BACKGROUND_SELECTION_LABEL = '[background] runInBackground';
const MAX_BACKGROUND_TASK_ID_CHARS = 256;
const MAX_BACKGROUND_CONTROL_ID_CHARS = 256;
const MAX_BACKGROUND_CONTROL_MESSAGE_CHARS = 64 * 1024;

/**
 * `type` of the synthetic attachment emitted on a poll turn when a harvested
 * code task settles — the live "this backgrounded call finished" signal for
 * the original tool-call card (stdout-only runs emit no file attachments, so
 * attachment presence alone can't signal completion). Rides the existing
 * `attachment` SSE channel; never persisted. Mirrored in
 * `client/src/components/Chat/Messages/Content/Parts/handle.ts`.
 */
export const BACKGROUND_STATUS_ATTACHMENT_TYPE = 'background_task_status';

/** Poll tool name (LibreChat host-special-cased, not an SDK tool). */
export const CHECK_BACKGROUND_TASK_NAME: string = Constants.CHECK_BACKGROUND_TASK;

/**
 * Tools that must never be backgrounded — they either run through the SDK's
 * direct/host-special path (so the host `ON_TOOL_EXECUTE` interception never
 * sees them), depend on synchronous artifact/code-session continuity, or are
 * the background machinery itself.
 *
 * `execute_code`/`bash_tool` are NOT excluded: they flow through the generic
 * `ON_TOOL_EXECUTE` path, the detached invoke carries their code-session
 * config, and their completion is harvested onto the dispatch turn's message
 * (files persisted + tool-call output patched), with the exec session folded
 * back into the run's shared code session on poll.
 */
const EXCLUDED_BACKGROUND_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  AgentConstants.READ_FILE,
  AgentConstants.SKILL_TOOL,
  AgentConstants.TOOL_SEARCH,
  AgentConstants.PROGRAMMATIC_TOOL_CALLING,
  AgentConstants.BASH_PROGRAMMATIC_TOOL_CALLING,
  AgentConstants.SUBAGENT,
  CREATE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  SET_MEMORY_TOOL_NAME,
  DELETE_MEMORY_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  CHECK_BACKGROUND_TASK_NAME,
  /**
   * Built-ins whose results are turned into user-visible attachments/citations
   * by the foreground `toolEndCallback`; a detached run stores only content, so
   * backgrounding them would silently drop those sources/files. Image-generation
   * tools are artifact-first — their files can't be reliably attached to an
   * already-saved turn — so they're excluded rather than degraded. Sourced from
   * the shared `imageGenTools` set plus the OAI toolkit ids it doesn't cover.
   */
  Tools.web_search,
  Tools.file_search,
  ...imageGenTools,
  'image_gen_oai',
  'image_edit_oai',
]);

/**
 * Agents persist action tool names with the raw encoded domain (`---` for short
 * hostnames), while the runtime definitions those names must match against are
 * always `_`-collapsed. The builder writes `tool_options` keyed by the persisted
 * name, so alias every action-shaped key to its normalized form; without this
 * the opt-in silently never resolves for short-hostname actions. Merge the raw
 * background option into any normalized entry while keeping an explicit
 * normalized background value authoritative.
 */
function expandActionToolOptions(toolOptions: AgentToolOptions): AgentToolOptions {
  let expanded: AgentToolOptions | undefined;
  for (const [name, options] of Object.entries(toolOptions)) {
    const normalized = normalizeActionToolName(name);
    const runInBackground = options?.run_in_background;
    if (
      normalized === name ||
      runInBackground == null ||
      toolOptions[normalized]?.run_in_background != null
    ) {
      continue;
    }
    expanded = expanded ?? { ...toolOptions };
    expanded[normalized] = {
      ...toolOptions[normalized],
      run_in_background: runInBackground,
    };
  }
  return expanded ?? toolOptions;
}

/**
 * Whether a tool may be dispatched in the background. Handoff tools
 * (`lc_transfer_to_*`) run through the direct path and are excluded by prefix.
 */
export function isBackgroundEligibleToolName(name: string): boolean {
  if (EXCLUDED_BACKGROUND_TOOL_NAMES.has(name)) {
    return false;
  }
  return !name.startsWith(AgentConstants.LC_TRANSFER_TO_);
}

/**
 * Tools that are background-NATIVE: they default INTO background dispatch
 * while the capability is enabled, and an explicit `run_in_background: false`
 * opts one out. Code executions are the paradigmatic slow, detachable call —
 * they flow through the generic execute path and their completion is
 * harvested onto the dispatch turn — so they carry the param without
 * per-agent opt-in, the same way the SDK's coding tools carry `intent`
 * natively. Mirrors `NATIVE_INTENT_TOOL_NAMES` in `intent.ts`.
 */
export const NATIVE_BACKGROUND_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  String(AgentConstants.EXECUTE_CODE),
  String(AgentConstants.BASH_TOOL),
]);

/**
 * Coerces tool-call args to an object, parsing a stringified JSON object (some
 * providers deliver args as a string). Returns undefined for non-object args.
 */
function coerceArgsObject(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string' && args.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Whether tool-call args request background dispatch (handles stringified args). */
export function isBackgroundRequested(args: unknown): boolean {
  return coerceArgsObject(args)?.[RUN_IN_BACKGROUND_ARG] === true;
}

/** Whether tool-call args carry the `run_in_background` key at all (any value). */
export function hasRunInBackgroundArg(args: unknown): boolean {
  const obj = coerceArgsObject(args);
  return obj != null && RUN_IN_BACKGROUND_ARG in obj;
}

/**
 * Returns the args without the injected `run_in_background` key so the real
 * tool never receives a parameter it doesn't declare. Parses stringified JSON
 * object args; returns the value unchanged when the flag is absent.
 */
export function stripRunInBackgroundArg(args: unknown): unknown {
  const obj = coerceArgsObject(args);
  if (!obj || !(RUN_IN_BACKGROUND_ARG in obj)) {
    return args;
  }
  const { [RUN_IN_BACKGROUND_ARG]: _omit, ...rest } = obj;
  return rest;
}

const RUN_IN_BACKGROUND_PROPERTY: JsonSchemaType = Object.freeze<JsonSchemaType>({
  type: 'boolean',
  description:
    'Set true to run this tool call in the background: it returns immediately with a background_task_id instead of blocking, so you can keep working while it runs. Poll check_background_task with that id to collect the result. The task persists on this server, so you may collect it later in this turn or in a following turn (it does not survive a server restart). Use for a slow call whose result you do not need right away.',
});

/**
 * Returns a copy of the tool definition with a `run_in_background` boolean
 * added to its parameters. Never mutates the input (built-in defs are frozen
 * and MCP defs may be shared), and is a no-op if the property already exists.
 */
export function injectRunInBackgroundParam(def: LCTool): LCTool {
  const params = def.parameters;
  const existingProps = params?.properties ?? {};
  if (RUN_IN_BACKGROUND_ARG in existingProps) {
    return def;
  }
  const nextParams: JsonSchemaType = {
    ...params,
    type: 'object',
    properties: { ...existingProps, [RUN_IN_BACKGROUND_ARG]: RUN_IN_BACKGROUND_PROPERTY },
  };
  return { ...def, parameters: nextParams };
}

/**
 * Whether the `run_in_background` param can be cleanly injected into a tool.
 * False for non-object (e.g. string-input/DynamicTool) schemas — rewriting them
 * to an object would break the tool's input contract — and for tools that
 * already declare their own `run_in_background` parameter (which the executor
 * would otherwise hijack/strip).
 */
function canInjectRunInBackgroundParam(def: LCTool): boolean {
  const params = def.parameters;
  if (params == null) {
    return true;
  }
  if (params.type != null && params.type !== 'object') {
    return false;
  }
  return !(params.properties != null && RUN_IN_BACKGROUND_ARG in params.properties);
}

/** Returns a copy of the def without the injected `run_in_background` property. */
function removeRunInBackgroundParam(def: LCTool): LCTool {
  const params = def.parameters;
  if (params?.properties == null || !(RUN_IN_BACKGROUND_ARG in params.properties)) {
    return def;
  }
  const { [RUN_IN_BACKGROUND_ARG]: _omit, ...restProps } = params.properties;
  return { ...def, parameters: { ...params, properties: restProps } };
}

/**
 * Removes the background additions (the injected param + the `check_background_task`
 * def) from a tool-definition list. Used to sanitize a self-spawn subagent's
 * inherited inputs so it doesn't advertise a background schema the isolated child
 * path can't honor.
 */
export function stripBackgroundFromToolDefinitions(
  toolDefinitions: LCTool[] | undefined,
  backgroundToolNames: string[] | undefined,
): LCTool[] {
  const defs = toolDefinitions ?? [];
  const bgSet = new Set(backgroundToolNames ?? []);
  const next: LCTool[] = [];
  let changed = false;
  for (const def of defs) {
    if (def.name === CHECK_BACKGROUND_TASK_NAME) {
      changed = true;
      continue;
    }
    const stripped = bgSet.size > 0 && bgSet.has(def.name) ? removeRunInBackgroundParam(def) : def;
    if (stripped !== def) {
      changed = true;
    }
    next.push(stripped);
  }
  return changed ? next : defs;
}

/**
 * Registry counterpart of {@link stripBackgroundFromToolDefinitions}. Returns a
 * NEW registry (never mutates the shared parent one) without the poll tool and
 * with the injected param removed, so a self-spawn child that uses
 * tool_search/deferred loading can't rediscover the host-only background schema.
 */
export function stripBackgroundFromToolRegistry(
  toolRegistry: LCToolRegistry | undefined,
  backgroundToolNames: string[] | undefined,
): LCToolRegistry | undefined {
  if (!toolRegistry) {
    return toolRegistry;
  }
  const bgSet = new Set(backgroundToolNames ?? []);
  if (bgSet.size === 0 && !toolRegistry.has(CHECK_BACKGROUND_TASK_NAME)) {
    return toolRegistry;
  }
  const next: LCToolRegistry = new Map();
  for (const [name, def] of toolRegistry) {
    if (name === CHECK_BACKGROUND_TASK_NAME) {
      continue;
    }
    next.set(name, bgSet.has(name) ? removeRunInBackgroundParam(def) : def);
  }
  return next;
}

const CHECK_BACKGROUND_TASK_DESCRIPTION = `Check, control, and retrieve tool or subagent tasks previously dispatched in the background (with run_in_background: true).

Provide a background_task_id to poll one task; omit it to list every background task in this thread. A task is only finished when its status is "completed", "error", or "cancelled" — never assume completion without polling. Results are not pushed to you; you must call this tool to collect them. The cancel action applies to subagents and to ordinary tools when enabled by the deployment; steer, queue, interrupt, and cancel_message apply only to subagents. Live controls route to process-local executors and do not survive an owning-process restart. A completed subagent thread may be continued later through the subagent tool's durable thread id.`;

const CHECK_BACKGROUND_TASK_WAKEUP_DESCRIPTION = `Check, control, and retrieve tool or subagent tasks previously dispatched in the background (with run_in_background: true).

Provide a background_task_id to inspect one task; omit it to list every background task in this thread. Background tools and detached subagents use automatic completion delivery: continue independent work or end the turn instead of repeatedly polling an unchanged running task, and the host will resume you when one finishes. Use this tool for explicit status, steer, queue, interrupt, cancel, or cancel_message actions, or as a fallback if automatic delivery is unavailable. A task is outstanding until its result is delivered, not merely until it stops running: a finished task whose delivery is "pending" will still arrive as a new turn, so never report it as done or cancelled on the strength of its status alone. Polling or cancelling a finished task retires its pending delivery so it never arrives as a new turn: a poll returns the result now, and cancelling a result this turn can no longer poll discards it. Ordinary tool execution remains process-local and does not survive restart; once its result is persisted, completion delivery may continue on another replica. Live subagent controls route across API replicas but do not survive a restart of the process that owns the executor. A completed subagent thread may be continued later through the subagent tool's durable thread id.`;

function checkBackgroundTaskDescription(subagentCompletionWakeups: boolean): string {
  return subagentCompletionWakeups
    ? CHECK_BACKGROUND_TASK_WAKEUP_DESCRIPTION
    : CHECK_BACKGROUND_TASK_DESCRIPTION;
}

/**
 * `maxLength` is valid JSON Schema and is honored by providers, but the SDK's
 * `JsonSchemaType` does not declare it, so the model-facing bounds are typed here.
 * Runtime argument validation enforces the same limits as defense in depth.
 */
interface BoundedStringSchema {
  type: 'string';
  maxLength: number;
  description: string;
}

interface CheckBackgroundTaskParameters {
  type: 'object';
  properties: {
    background_task_id: BoundedStringSchema;
    action: { type: 'string'; enum: string[]; description: string };
    message: BoundedStringSchema;
    control_id: BoundedStringSchema;
  };
  required: string[];
}

const CHECK_BACKGROUND_TASK_PARAMETERS = Object.freeze<CheckBackgroundTaskParameters>({
  type: 'object',
  properties: {
    background_task_id: {
      type: 'string',
      maxLength: MAX_BACKGROUND_TASK_ID_CHARS,
      description:
        'The id returned when the tool or subagent was dispatched. Omit to list all background tasks in this thread.',
    },
    action: {
      type: 'string',
      enum: ['poll', 'steer', 'queue', 'interrupt', 'cancel', 'cancel_message'],
      description:
        'Defaults to poll. Cancel applies to subagents and may apply to ordinary tools when enabled by the deployment; other controls apply only to subagents.',
    },
    message: {
      type: 'string',
      maxLength: MAX_BACKGROUND_CONTROL_MESSAGE_CHARS,
      description: 'Required for steer, queue, or interrupt.',
    },
    control_id: {
      type: 'string',
      maxLength: MAX_BACKGROUND_CONTROL_ID_CHARS,
      description: 'Required for cancel_message; use the id returned by a prior control action.',
    },
  },
  required: [],
});

function buildCheckBackgroundTaskDefinition(subagentCompletionWakeups: boolean): LCTool {
  return {
    name: CHECK_BACKGROUND_TASK_NAME,
    description: checkBackgroundTaskDescription(subagentCompletionWakeups),
    parameters: CHECK_BACKGROUND_TASK_PARAMETERS,
  };
}

/**
 * Idempotently registers the `check_background_task` poll tool into the run's
 * tool definitions and registry. Mirrors `registerCodeExecutionTools`.
 */
export function registerBackgroundTaskTool(params: {
  toolRegistry: LCToolRegistry | undefined;
  toolDefinitions: LCTool[] | undefined;
  subagentCompletionWakeups?: boolean;
}): { toolDefinitions: LCTool[] } {
  const { toolRegistry, toolDefinitions, subagentCompletionWakeups = false } = params;
  const defs = toolDefinitions ?? [];
  const desiredDescription = checkBackgroundTaskDescription(subagentCompletionWakeups);
  const isOurs = (tool?: { description?: string }): boolean =>
    tool?.description === CHECK_BACKGROUND_TASK_DESCRIPTION ||
    tool?.description === CHECK_BACKGROUND_TASK_WAKEUP_DESCRIPTION;

  const existingDef = defs.find((d) => d.name === CHECK_BACKGROUND_TASK_NAME);
  const existingRegistry = toolRegistry?.get(CHECK_BACKGROUND_TASK_NAME);

  /** Already registered by us — idempotent no-op. */
  if (
    existingDef?.description === desiredDescription &&
    (existingRegistry == null || existingRegistry.description === desiredDescription)
  ) {
    return { toolDefinitions: defs };
  }

  /**
   * The name is reserved: since the executor intercepts every
   * `check_background_task` call in a background-enabled run, a user/MCP tool
   * with the same name must not be advertised (its schema would mismatch the
   * interception). Overwrite so the model sees the poll schema the host honors,
   * and warn that the colliding tool is shadowed.
   */
  const collides = existingDef != null || existingRegistry != null;
  const foreignCollision =
    (existingDef != null && !isOurs(existingDef)) ||
    (existingRegistry != null && !isOurs(existingRegistry));
  if (foreignCollision) {
    logger.warn(
      `[background] A tool named "${CHECK_BACKGROUND_TASK_NAME}" collides with the reserved background poll tool; the host poll tool takes precedence and the colliding tool is shadowed for this run.`,
    );
  }
  toolRegistry?.set(CHECK_BACKGROUND_TASK_NAME, {
    name: CHECK_BACKGROUND_TASK_NAME,
    description: desiredDescription,
    parameters: CHECK_BACKGROUND_TASK_PARAMETERS,
    allowed_callers: ['direct'],
  });
  const withoutCollision = collides
    ? defs.filter((d) => d.name !== CHECK_BACKGROUND_TASK_NAME)
    : defs;
  return {
    toolDefinitions: [
      ...withoutCollision,
      buildCheckBackgroundTaskDefinition(subagentCompletionWakeups),
    ],
  };
}

/**
 * Injects the `run_in_background` param into every opted-in, eligible tool and
 * registers the poll tool when at least one tool became backgroundable.
 *
 * Opt-in resolves per FINAL definition via {@link resolveToolOption}
 * (explicit name → capability marker projection → wildcard), so a saved
 * agent's `execute_code` entry reaches `bash_tool` and a spec selection
 * reaches lazily-registered definitions. When no policy speaks at all, the
 * background-native code pair defaults IN — so this pass runs on every
 * capability-enabled request, not just explicitly opted-in agents. Both
 * saved agents and ephemeral/model-spec agents reach this with the same
 * `tool_options` shape, so the logic is written once. When a narrowing
 * selection is present, names that never took effect — including markers
 * whose every runtime definition is background-excluded, like `memory` —
 * are warned about here.
 */
export function applyBackgroundToolCalls(params: {
  toolDefinitions: LCTool[] | undefined;
  toolRegistry: LCToolRegistry | undefined;
  toolOptions: AgentToolOptions | undefined;
  /** Capability marker → registered definition names, from `initializeAgent`. */
  capabilityToolNames?: CapabilityToolNames;
  /**
   * Extra host-context exclusion (e.g. tools of ephemeral request-scoped MCP
   * servers, whose connection dies at request end): a `true` return skips the
   * param injection entirely so the model is never shown an option the
   * executor would silently downgrade to foreground.
   */
  excludeTool?: (toolName: string) => boolean;
}): { toolDefinitions: LCTool[]; backgroundToolNames: string[] } {
  const { toolRegistry, capabilityToolNames, excludeTool } = params;
  const toolOptions = params.toolOptions && expandActionToolOptions(params.toolOptions);
  const defs = params.toolDefinitions ?? [];
  const selectionNames = getSelectionNames(toolOptions, 'run_in_background');
  const effectiveSources = new Set<string>();

  const backgroundToolNames: string[] = [];
  const nextDefs = defs.map((def) => {
    const resolved = resolveToolOption(
      def.name,
      'run_in_background',
      toolOptions,
      capabilityToolNames,
    );
    const optedIn = resolved != null ? resolved.value : NATIVE_BACKGROUND_TOOL_NAMES.has(def.name);
    if (!optedIn || !isBackgroundEligibleToolName(def.name) || excludeTool?.(def.name) === true) {
      return def;
    }
    if (!canInjectRunInBackgroundParam(def)) {
      logger.warn(
        `[background] Skipping run_in_background for "${def.name}": non-object schema or the tool already declares the parameter.`,
      );
      return def;
    }
    if (resolved != null) {
      effectiveSources.add(resolved.source);
    }
    backgroundToolNames.push(def.name);
    const injected = injectRunInBackgroundParam(def);
    if (injected === def) {
      return def;
    }
    const registryEntry = toolRegistry?.get(def.name);
    if (registryEntry) {
      toolRegistry?.set(def.name, { ...registryEntry, parameters: injected.parameters });
    }
    return injected;
  });

  warnUnmatchedSelectionNames(selectionNames, effectiveSources, BACKGROUND_SELECTION_LABEL);

  if (backgroundToolNames.length === 0) {
    return { toolDefinitions: defs, backgroundToolNames: [] };
  }

  const withPoll = registerBackgroundTaskTool({ toolRegistry, toolDefinitions: nextDefs });
  return { toolDefinitions: withPoll.toolDefinitions, backgroundToolNames };
}

/**
 * Records the background selection for ephemeral and model-spec agents, which
 * carry no per-tool options of their own. Returns undefined when disabled.
 *
 * A model spec's `runInBackground` selects the scope: `true` opts in every
 * eligible tool, while a string array opts in ONLY the named ones. Selecting
 * per tool matters more here than for intent labels — backgrounding changes
 * execution semantics, so an admin may want it on one slow MCP call without
 * letting the model detach every other tool in the spec. The ephemeral toggle
 * stays boolean and never narrows; it has no per-tool UI to drive it.
 *
 * A spec's `runInBackground: false` is the boolean spelling of the empty
 * list — an explicit "none" that also opts the background-native code pair
 * out. Pre-native, `false` was behaviorally identical to omitting the field,
 * so a config that wrote it must not silently flip to backgrounding code.
 * The EPHEMERAL toggle's `false` stays no-policy — a badge default, not a
 * decision — so the native default holds for ephemeral chats.
 *
 * The selection is recorded as policy (wildcard default + verbatim names)
 * and resolved against the FINAL definition set in
 * `applyBackgroundToolCalls`, so capability markers and lazily-expanded MCP
 * servers are governed, and names that never take effect — a typo, or a
 * marker like `memory` whose runtime definitions are all
 * background-excluded — are diagnosed where the real definitions are known.
 */
export function synthesizeBackgroundToolOptions(sources: {
  ephemeralAgent?: { run_in_background?: boolean } | null;
  modelSpec?: { runInBackground?: boolean | string[] } | null;
}): AgentToolOptions | undefined {
  const specSelection = sources.modelSpec?.runInBackground;
  return synthesizeSelectionToolOptions(
    'run_in_background',
    specSelection === false ? [] : specSelection,
    sources.ephemeralAgent?.run_in_background === true,
    BACKGROUND_SELECTION_LABEL,
  );
}

export type BackgroundTaskStatus = 'running' | 'completed' | 'error' | 'cancelled';

export interface BackgroundTask {
  id: string;
  toolName: string;
  toolCallId: string;
  /** Stable run-step identity; provider tool-call ids may repeat within one response. */
  stepId?: string;
  /** The dispatch turn's response messageId, for post-hoc result anchoring. */
  messageId?: string;
  /** The dispatching agent, disambiguating repeated provider tool-call ids
   *  (e.g. `call_0`) across agents when patching the dispatch turn. */
  agentId?: string;
  status: BackgroundTaskStatus;
  /** Set when an owner asked the live invocation to abort. The task remains
   * running until the invocation actually settles, so capacity and status do
   * not imply that external effects have stopped prematurely. */
  cancellationRequestedAt?: number;
  /** Tool result content once completed. */
  result?: string;
  /**
   * The completed tool's artifact, held until the poll turn collects it (a
   * backgrounded call's own turn is finalized before the artifact resolves, so
   * it can't ride that turn). Cleared once delivered to free memory.
   */
  artifact?: unknown;
  /**
   * Attachments persisted onto the dispatch turn's message by the
   * completion-time harvest (code tools). Retained until the task is swept so
   * every poll can re-emit them on its live stream (the client upserts by
   * `file_id`, so re-emission is idempotent) and re-anchor the row patch.
   */
  attachments?: unknown[];
  /**
   * True when a completion-time harvest was dispatched for this task (code
   * tools with a wired persister). Suppresses the poll turn's legacy
   * `toolEndCallback` delivery — the harvest already persisted the files with
   * the ORIGINAL tool-call identity.
   */
  harvestStarted?: boolean;
  /** True until completion-time file inspection/persistence accepts or rejects the artifact. */
  harvestPending?: boolean;
  /** True once the artifact has been handed to a live poll turn's callback. */
  artifactDelivered?: boolean;
  /** Terminal policy rejection: blocked artifact bytes must never be restored or claimed. */
  artifactBlocked?: boolean;
  /** Error message when status === 'error'. */
  error?: string;
  /** One consumer owns presentation of the terminal result. A manual claim is
   * copied into the durable receipt when the dispatch row settles. */
  resultClaim?: {
    kind: 'manual' | 'wakeup';
    claimId: string;
    claimedAt: number;
    generationId?: string;
  };
  /** The declared tool may return a process-local live artifact. A terminal
   * same-generation poll may therefore deliver from the local claim after it
   * retires the unclaimed wakeup, without waiting for the dispatch row to
   * finalize and deadlocking that same generation. */
  liveArtifactPollRequired?: boolean;
  completionWakeup?: boolean;
  /** The automatic delivery was durably retired before a manual poll took over. */
  completionWakeupRetired?: boolean;
  /** True while the terminal result is being persisted for automatic delivery. */
  completionPersistencePending?: boolean;
  /** Process-local cancellation handle for the preregistered durable delivery.
   * A same-generation manual claim retires it before exposing the result. */
  completionWakeupRetire?: BackgroundToolWakeupAdmission['retire'];
  completionPersistenceFailed?: boolean;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
}

interface TaskBucket {
  key: string;
  userId: string;
  tasks: Map<string, BackgroundTask>;
  /** toolCallId -> taskId, for dispatch idempotency across graph re-execution. */
  byToolCall: Map<string, string>;
  /** Caller-owned local permits acquired before a caller persists external
   * launch authority. They prevent capacity rejection from creating a durable
   * action that was definitely never launched. */
  capacityPermits: Map<string, { dedupeKey: string }>;
  lastAccess: number;
}

interface RetainedPayloadUsage {
  result: number;
  artifact: number;
  attachments: number;
  error: number;
}

export interface BackgroundTaskCapacityPermit {
  id: string;
  userId: string;
  conversationId: string;
}

export type BackgroundTaskCapacityScope =
  | 'conversation_running'
  | 'conversation_retention'
  | 'user_running'
  | 'user_retention'
  | 'global_running'
  | 'global_retention'
  | 'shutting_down';

type BackgroundTaskCapacityRejection = {
  atCapacity: true;
  scope: BackgroundTaskCapacityScope;
};

/** Process-local controls a running task registers so graceful shutdown can settle it. */
export interface BackgroundTaskShutdownHandle {
  /** Resolves once the task's result is durable, or once the task finished when it has
   * no durable delivery. Never rejects. */
  settled: Promise<void>;
  /** Aborts the live invocation because the server is shutting down. */
  interrupt: (reason: string) => void;
  /** Stores the best result available now: the task's own result when it has settled,
   * otherwise an interrupted failure. */
  flush: (reason: string) => Promise<void>;
}

export interface BackgroundTaskDrainSummary {
  /** Tasks with an unsettled result when the drain began. */
  tracked: number;
  /** Tasks still running when the drain aborted them. */
  interrupted: number;
  /** Tasks whose result was still not durable, so the drain stored one. */
  flushed: number;
  /** Tasks whose durable result was still unconfirmed at the deadline. */
  unsettled: number;
}

/** Resolves when `promise` settles or at `deadlineAt`, whichever comes first. */
function waitUntil(promise: Promise<unknown>, deadlineAt: number): Promise<void> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, remainingMs);
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    promise.then(finish, finish);
  });
}

const COMPLETED_TASK_TTL_MS = 60 * 60 * 1000;
const IDLE_BUCKET_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RUNNING_PER_BUCKET = 10;
const MAX_TASKS_PER_BUCKET = 200;
/** Cross-conversation limits prevent one principal from multiplying the bucket allowance. */
const MAX_RUNNING_PER_USER = 40;
const MAX_RUNNING_GLOBAL = 200;
const MAX_TASKS_PER_USER = 400;
const MAX_TASKS_GLOBAL = 2_000;
const MAX_RESULT_CHARS = 100_000;
const MAX_ARTIFACT_CHARS = 10_000_000;
/** JSON-character budgets bound large settled payloads independently of task metadata. */
const MAX_RETAINED_CHARS_PER_USER = 16_000_000;
const MAX_RETAINED_CHARS_GLOBAL = 64_000_000;
const GLOBAL_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Requests cancellation at the invocation deadline, but accepts terminal
 * timeout evidence only when the invocation subsequently settles. Rejecting
 * this wrapper while the underlying tool can still mutate externally would
 * publish a false failure and make a duplicate side effect appear safe.
 */
export function withBackgroundTaskTimeout<T>(
  invocation: Promise<T>,
  requestAbort: () => void,
  timeoutMs: number = BACKGROUND_TASK_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(requestAbort, timeoutMs);
    timeout.unref?.();
    invocation.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

let lastDispatchStamp = 0;
/**
 * Strictly-increasing dispatch stamp. `createdAt` orders writers in the
 * stale-output guard (`sourceDispatchedAt`), which accepts equal stamps so
 * idempotent re-commits of the SAME task pass — two same-millisecond
 * dispatches would tie on raw `Date.now()` and let the older task overwrite
 * the newer one's committed file. Process-local, like the registry itself.
 */
function nextDispatchStamp(now: number): number {
  lastDispatchStamp = lastDispatchStamp < now ? now : lastDispatchStamp + 1;
  return lastDispatchStamp;
}

function toStoredContent(content: unknown): string {
  const serialized = typeof content === 'string' ? content : JSON.stringify(content ?? '');
  const asString = serialized ?? String(content ?? '');
  return truncateMiddle(asString, MAX_RESULT_CHARS);
}

/**
 * Bounds retained artifact memory: an artifact is held for up to the completed
 * TTL, so a runaway payload (huge base64 blobs) is dropped rather than pinned.
 * Measurement failures (such as circular references) drop the artifact because
 * an unmeasurable value cannot safely participate in the aggregate budget.
 */
function toStoredArtifact(
  taskId: string,
  artifact: unknown,
): { artifact?: unknown; chars: number } {
  if (artifact == null) {
    return { chars: 0 };
  }
  try {
    const serialized = JSON.stringify(artifact);
    if (serialized == null) {
      logger.warn(`[background] Dropping unmeasurable artifact for task ${taskId}.`);
      return { chars: 0 };
    }
    const size = serialized.length;
    if (size > MAX_ARTIFACT_CHARS) {
      logger.warn(
        `[background] Dropping oversized artifact for task ${taskId} (${size} chars > ${MAX_ARTIFACT_CHARS}).`,
      );
      return { chars: 0 };
    }
    const storedArtifact: unknown = JSON.parse(serialized);
    return { artifact: storedArtifact, chars: size };
  } catch {
    logger.warn(`[background] Dropping unmeasurable artifact for task ${taskId}.`);
    return { chars: 0 };
  }
}

/**
 * In-process store of background tool tasks, scoped per user + conversation.
 *
 * MVP scope: single Node process. A task's result survives across turns within
 * the same server process (a floating promise keeps running on the event loop),
 * but is lost on restart and is not shared across Redis replicas — a run resumed
 * on another replica cannot see it. A Redis-backed store would slot in behind
 * this same interface as a follow-up.
 */
export class BackgroundTaskRegistryClass {
  private readonly buckets = new Map<string, TaskBucket>();
  private readonly retainedUsage = new WeakMap<BackgroundTask, RetainedPayloadUsage>();
  /** Live invocation controls are intentionally process-local and are never
   * exposed through task snapshots or durable receipts. */
  private readonly cancellationRequests = new WeakMap<BackgroundTask, () => boolean | void>();
  /** Tasks whose result is not yet durable, for the graceful-shutdown drain. */
  private readonly shutdownHandles = new Map<BackgroundTask, BackgroundTaskShutdownHandle>();
  private admissionClosed = false;
  private lastGlobalSweepAt = 0;

  private key(userId: string, conversationId: string): string {
    return `${userId}::${conversationId}`;
  }

  private releaseEvictedShutdownHandle(task: BackgroundTask): void {
    if (this.shutdownHandles.delete(task)) {
      logger.warn(`[background] Unconfirmed shutdown result for evicted task ${task.id}.`);
    }
  }

  private sweepBucketTasks(bucket: TaskBucket, now: number): void {
    for (const [taskId, task] of bucket.tasks) {
      if (
        task.status !== 'running' &&
        task.completionPersistencePending !== true &&
        now - task.updatedAt > COMPLETED_TASK_TTL_MS
      ) {
        bucket.tasks.delete(taskId);
        this.releaseEvictedShutdownHandle(task);
      }
    }
    /** Drop dedupe mappings whose task was evicted (keys are
     *  `agentId::runId::toolCallId`, so they can't be derived from a task alone). */
    for (const [dedupeKey, taskId] of bucket.byToolCall) {
      if (!bucket.tasks.has(taskId)) {
        bucket.byToolCall.delete(dedupeKey);
      }
    }
  }

  /**
   * Accessors always sweep the bucket they touch (so TTLs hold exactly for the
   * data being read), while the all-buckets pass — needed only for idle-bucket
   * eviction and untouched buckets — is throttled so a hot poll loop isn't
   * O(total tasks server-wide) on every call.
   */
  private sweep(now: number): void {
    if (now - this.lastGlobalSweepAt < GLOBAL_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastGlobalSweepAt = now;
    for (const [bucketKey, bucket] of this.buckets) {
      if (
        now - bucket.lastAccess > IDLE_BUCKET_TTL_MS &&
        bucket.capacityPermits.size === 0 &&
        ![...bucket.tasks.values()].some(
          (task) => task.status === 'running' || task.completionPersistencePending === true,
        )
      ) {
        for (const task of bucket.tasks.values()) {
          this.releaseEvictedShutdownHandle(task);
        }
        this.buckets.delete(bucketKey);
        continue;
      }
      this.sweepBucketTasks(bucket, now);
      if (bucket.tasks.size === 0 && bucket.capacityPermits.size === 0) {
        this.buckets.delete(bucketKey);
      }
    }
  }

  private getBucket(userId: string, conversationId: string, now: number): TaskBucket {
    const bucketKey = this.key(userId, conversationId);
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        key: bucketKey,
        userId,
        tasks: new Map(),
        byToolCall: new Map(),
        capacityPermits: new Map(),
        lastAccess: now,
      };
      this.buckets.set(bucketKey, bucket);
    }
    bucket.lastAccess = now;
    return bucket;
  }

  private dedupeKey(params: { toolCallId: string; runId?: string; agentId?: string }): string {
    return `${params.agentId ?? ''}::${params.runId ?? ''}::${params.toolCallId}`;
  }

  private runningCount(bucket: TaskBucket): number {
    let running = 0;
    for (const task of bucket.tasks.values()) {
      if (task.status === 'running') {
        running++;
      }
    }
    return running;
  }

  private payloadUsage(task: BackgroundTask): RetainedPayloadUsage {
    return (
      this.retainedUsage.get(task) ?? {
        result: 0,
        artifact: 0,
        attachments: 0,
        error: 0,
      }
    );
  }

  private payloadChars(task: BackgroundTask): number {
    const usage = this.payloadUsage(task);
    return usage.result + usage.artifact + usage.attachments + usage.error;
  }

  private updatePayloadUsage(task: BackgroundTask, patch: Partial<RetainedPayloadUsage>): void {
    this.retainedUsage.set(task, { ...this.payloadUsage(task), ...patch });
  }

  private aggregateUsage(userId: string): {
    runningForUser: number;
    runningGlobal: number;
    tasksForUser: number;
    tasksGlobal: number;
    retainedForUser: number;
    retainedGlobal: number;
  } {
    let runningForUser = 0;
    let runningGlobal = 0;
    let tasksForUser = 0;
    let tasksGlobal = 0;
    let retainedForUser = 0;
    let retainedGlobal = 0;
    for (const bucket of this.buckets.values()) {
      const isUser = bucket.userId === userId;
      tasksGlobal += bucket.tasks.size + bucket.capacityPermits.size;
      if (isUser) {
        tasksForUser += bucket.tasks.size + bucket.capacityPermits.size;
      }
      for (const task of bucket.tasks.values()) {
        if (task.status === 'running') {
          runningGlobal++;
          if (isUser) {
            runningForUser++;
          }
        }
        const retained = this.payloadChars(task);
        retainedGlobal += retained;
        if (isUser) {
          retainedForUser += retained;
        }
      }
      runningGlobal += bucket.capacityPermits.size;
      if (isUser) {
        runningForUser += bucket.capacityPermits.size;
      }
    }
    return {
      runningForUser,
      runningGlobal,
      tasksForUser,
      tasksGlobal,
      retainedForUser,
      retainedGlobal,
    };
  }

  private runningCapacityScope(userId: string): 'user_running' | 'global_running' | undefined {
    const usage = this.aggregateUsage(userId);
    if (usage.runningForUser >= MAX_RUNNING_PER_USER) {
      return 'user_running';
    }
    if (usage.runningGlobal >= MAX_RUNNING_GLOBAL) {
      return 'global_running';
    }
    return undefined;
  }

  private settledCandidates(params: {
    userId?: string;
    bucket?: TaskBucket;
    excludeTask?: BackgroundTask;
    requirePayload?: boolean;
  }): Array<{ bucket: TaskBucket; task: BackgroundTask }> {
    const candidates: Array<{ bucket: TaskBucket; task: BackgroundTask }> = [];
    for (const bucket of this.buckets.values()) {
      if (params.bucket != null && bucket !== params.bucket) {
        continue;
      }
      if (params.userId != null && bucket.userId !== params.userId) {
        continue;
      }
      for (const task of bucket.tasks.values()) {
        if (
          task.status !== 'running' &&
          task.harvestPending !== true &&
          task.completionPersistencePending !== true &&
          task !== params.excludeTask &&
          (params.requirePayload !== true || this.payloadChars(task) > 0)
        ) {
          candidates.push({ bucket, task });
        }
      }
    }
    return candidates.sort((a, b) => a.task.updatedAt - b.task.updatedAt);
  }

  private evictSelected(selected: Map<BackgroundTask, TaskBucket>): void {
    const touched = new Set<TaskBucket>();
    for (const [task, bucket] of selected) {
      bucket.tasks.delete(task.id);
      this.releaseEvictedShutdownHandle(task);
      touched.add(bucket);
    }
    const now = Date.now();
    for (const bucket of touched) {
      this.sweepBucketTasks(bucket, now);
      if (bucket.tasks.size === 0 && bucket.capacityPermits.size === 0) {
        this.buckets.delete(bucket.key);
      }
    }
  }

  private makeTaskRoom(userId: string, bucket?: TaskBucket): boolean {
    const usage = this.aggregateUsage(userId);
    const bucketRequired = Math.max(
      0,
      (bucket?.tasks.size ?? 0) + (bucket?.capacityPermits.size ?? 0) - MAX_TASKS_PER_BUCKET + 1,
    );
    const userRequired = Math.max(0, usage.tasksForUser - MAX_TASKS_PER_USER + 1);
    const globalRequired = Math.max(0, usage.tasksGlobal - MAX_TASKS_GLOBAL + 1);
    const selected = new Map<BackgroundTask, TaskBucket>();

    const selectCount = (
      candidates: Array<{ bucket: TaskBucket; task: BackgroundTask }>,
      required: number,
    ): boolean => {
      let remaining = required;
      for (const candidate of candidates) {
        if (remaining <= 0) {
          break;
        }
        if (selected.has(candidate.task)) {
          continue;
        }
        selected.set(candidate.task, candidate.bucket);
        remaining--;
      }
      return remaining === 0;
    };

    if (bucket != null && !selectCount(this.settledCandidates({ bucket }), bucketRequired)) {
      return false;
    }
    const selectedForUser = [...selected.values()].filter(
      (selectedBucket) => selectedBucket.userId === userId,
    ).length;
    if (
      !selectCount(this.settledCandidates({ userId }), Math.max(0, userRequired - selectedForUser))
    ) {
      return false;
    }
    if (!selectCount(this.settledCandidates({}), Math.max(0, globalRequired - selected.size))) {
      return false;
    }
    this.evictSelected(selected);
    return true;
  }

  private taskCapacityScope(
    userId: string,
    bucket?: TaskBucket,
  ): 'conversation_retention' | 'user_retention' | 'global_retention' {
    if (bucket != null && bucket.tasks.size + bucket.capacityPermits.size >= MAX_TASKS_PER_BUCKET) {
      return 'conversation_retention';
    }
    return this.aggregateUsage(userId).tasksForUser >= MAX_TASKS_PER_USER
      ? 'user_retention'
      : 'global_retention';
  }

  private makeRetainedRoom(userId: string, task: BackgroundTask, chars: number): boolean {
    const usage = this.aggregateUsage(userId);
    const userRequired = Math.max(0, usage.retainedForUser + chars - MAX_RETAINED_CHARS_PER_USER);
    const globalRequired = Math.max(0, usage.retainedGlobal + chars - MAX_RETAINED_CHARS_GLOBAL);
    const selected = new Map<BackgroundTask, TaskBucket>();

    const selectChars = (
      candidates: Array<{ bucket: TaskBucket; task: BackgroundTask }>,
      required: number,
    ): boolean => {
      let retained = 0;
      for (const candidate of candidates) {
        if (retained >= required) {
          break;
        }
        if (selected.has(candidate.task)) {
          continue;
        }
        selected.set(candidate.task, candidate.bucket);
        retained += this.payloadChars(candidate.task);
      }
      return retained >= required;
    };

    if (
      !selectChars(
        this.settledCandidates({ userId, excludeTask: task, requirePayload: true }),
        userRequired,
      )
    ) {
      return false;
    }
    let selectedChars = 0;
    for (const selectedTask of selected.keys()) {
      selectedChars += this.payloadChars(selectedTask);
    }
    if (
      !selectChars(
        this.settledCandidates({ excludeTask: task, requirePayload: true }),
        Math.max(0, globalRequired - selectedChars),
      )
    ) {
      return false;
    }
    this.evictSelected(selected);
    return true;
  }

  /** Acquires process-local capacity before a caller persists launch authority.
   * The synchronous permit closes the capacity-rejection crash window without
   * making ordinary background tasks durable. */
  reserveCapacity(params: {
    userId: string;
    conversationId: string;
    toolCallId: string;
    runId?: string;
    agentId?: string;
  }):
    | { permit: BackgroundTaskCapacityPermit }
    | { task: BackgroundTask; isNew: false }
    | BackgroundTaskCapacityRejection {
    const now = Date.now();
    this.sweep(now);
    const bucketKey = this.key(params.userId, params.conversationId);
    const existingBucket = this.buckets.get(bucketKey);
    if (existingBucket != null) {
      existingBucket.lastAccess = now;
      this.sweepBucketTasks(existingBucket, now);
    }
    const dedupeKey = this.dedupeKey(params);
    const existingId = existingBucket?.byToolCall.get(dedupeKey);
    const existing = existingId == null ? undefined : existingBucket?.tasks.get(existingId);
    if (existing != null) {
      return { task: existing, isNew: false };
    }
    if (this.admissionClosed) {
      return { atCapacity: true, scope: 'shutting_down' };
    }
    if (
      existingBucket != null &&
      this.runningCount(existingBucket) + existingBucket.capacityPermits.size >=
        MAX_RUNNING_PER_BUCKET
    ) {
      return { atCapacity: true, scope: 'conversation_running' };
    }
    const runningScope = this.runningCapacityScope(params.userId);
    if (runningScope != null) {
      return { atCapacity: true, scope: runningScope };
    }
    if (!this.makeTaskRoom(params.userId, existingBucket)) {
      return { atCapacity: true, scope: this.taskCapacityScope(params.userId, existingBucket) };
    }
    const bucket =
      this.buckets.get(bucketKey) ?? this.getBucket(params.userId, params.conversationId, now);
    const permit: BackgroundTaskCapacityPermit = {
      id: randomUUID(),
      userId: params.userId,
      conversationId: params.conversationId,
    };
    /** The permit is owned by the in-flight caller until it is consumed or
     * explicitly released. Expiring it by wall clock could strand a durable
     * reservation when MongoDB is slow; process death already clears local
     * permits without pretending the external launch happened. */
    bucket.capacityPermits.set(permit.id, { dedupeKey });
    return { permit };
  }

  releaseCapacity(permit: BackgroundTaskCapacityPermit): void {
    const bucketKey = this.key(permit.userId, permit.conversationId);
    const bucket = this.buckets.get(bucketKey);
    bucket?.capacityPermits.delete(permit.id);
    if (bucket?.tasks.size === 0 && bucket.capacityPermits.size === 0) {
      this.buckets.delete(bucketKey);
    }
  }

  /**
   * Registers a task for a tool call. Returns the existing task (and
   * `isNew: false`) only when the SAME run re-dispatched the same `toolCallId`
   * (a resume/replay) — the caller must not start the work twice. Returns
   * `atCapacity: true` when the per-conversation running cap is reached.
   *
   * The dedupe key includes `agentId` + `runId` because provider tool-call ids
   * repeat across turns AND across agents in one run (e.g. `call_0` per
   * response); keying on `toolCallId` alone would make a later turn's — or a
   * second agent's — identically-named call collide with a prior (retained)
   * task and hand back a stale/foreign result instead of executing.
   */
  create(params: {
    taskId?: string;
    userId: string;
    conversationId: string;
    toolCallId: string;
    stepId?: string;
    toolName: string;
    messageId?: string;
    runId?: string;
    agentId?: string;
    /** Set at dispatch when a settle-time harvest WILL run. */
    harvestStarted?: boolean;
    liveArtifactPollRequired?: boolean;
    capacityPermit?: BackgroundTaskCapacityPermit;
    /** Abort the already-created invocation signal. Ownership is enforced by
     * requestCancellation before this closure can be reached. */
    /** Returns false when another abort source already won the race. */
    requestCancellation?: () => boolean | void;
  }): { task: BackgroundTask; isNew: boolean } | BackgroundTaskCapacityRejection {
    const now = Date.now();
    this.sweep(now);
    const bucketKey = this.key(params.userId, params.conversationId);
    const existingBucket = this.buckets.get(bucketKey);
    if (existingBucket != null) {
      existingBucket.lastAccess = now;
      this.sweepBucketTasks(existingBucket, now);
    }

    const dedupeKey = this.dedupeKey(params);
    const existingId = existingBucket?.byToolCall.get(dedupeKey);
    if (existingId) {
      const existing = existingBucket?.tasks.get(existingId);
      if (existing) {
        if (params.capacityPermit != null) {
          this.releaseCapacity(params.capacityPermit);
        }
        return { task: existing, isNew: false };
      }
    }

    /** A permit already reserved launch authority before shutdown began, so it may still land. */
    if (this.admissionClosed && params.capacityPermit == null) {
      return { atCapacity: true, scope: 'shutting_down' };
    }

    if (params.capacityPermit != null) {
      if (existingBucket == null) {
        throw new Error('Background task capacity permit is stale');
      }
      const bucket = existingBucket;
      const permit = bucket.capacityPermits.get(params.capacityPermit.id);
      if (
        params.capacityPermit.userId !== params.userId ||
        params.capacityPermit.conversationId !== params.conversationId ||
        permit?.dedupeKey !== dedupeKey
      ) {
        throw new Error('Background task capacity permit is stale');
      }
      bucket.capacityPermits.delete(params.capacityPermit.id);
    }
    /** Only *running* tasks gate dispatch. */
    if (params.capacityPermit == null) {
      if (
        existingBucket != null &&
        this.runningCount(existingBucket) + existingBucket.capacityPermits.size >=
          MAX_RUNNING_PER_BUCKET
      ) {
        return { atCapacity: true, scope: 'conversation_running' };
      }
      const runningScope = this.runningCapacityScope(params.userId);
      if (runningScope != null) {
        return { atCapacity: true, scope: runningScope };
      }
    }
    if (!this.makeTaskRoom(params.userId, existingBucket)) {
      return { atCapacity: true, scope: this.taskCapacityScope(params.userId, existingBucket) };
    }
    /** Aggregate eviction may have removed `existingBucket` when its only
     * settled task was the oldest candidate. Never register into that detached map. */
    const bucket =
      this.buckets.get(bucketKey) ?? this.getBucket(params.userId, params.conversationId, now);
    const task: BackgroundTask = {
      id: params.taskId ?? randomUUID(),
      toolName: params.toolName,
      toolCallId: params.toolCallId,
      stepId: params.stepId,
      messageId: params.messageId,
      agentId: params.agentId,
      ...(params.harvestStarted === true ? { harvestStarted: true, harvestPending: true } : {}),
      ...(params.liveArtifactPollRequired === true ? { liveArtifactPollRequired: true } : {}),
      status: 'running',
      createdAt: nextDispatchStamp(now),
      updatedAt: now,
    };
    bucket.tasks.set(task.id, task);
    bucket.byToolCall.set(dedupeKey, task.id);
    if (params.requestCancellation != null) {
      this.cancellationRequests.set(task, params.requestCancellation);
    }
    return { task, isNew: true };
  }

  requestCancellation(
    userId: string,
    conversationId: string,
    taskId: string,
  ):
    | { status: 'not_found' }
    | { status: 'unavailable'; task: BackgroundTask }
    | { status: 'requested' | 'already_requested' | 'settled'; task: BackgroundTask } {
    const task = this.get(userId, conversationId, taskId);
    if (task == null) {
      return { status: 'not_found' };
    }
    if (task.status !== 'running') {
      return { status: 'settled', task };
    }
    if (task.cancellationRequestedAt != null) {
      return { status: 'already_requested', task };
    }
    const request = this.cancellationRequests.get(task);
    if (request == null) {
      return { status: 'unavailable', task };
    }
    if (request() === false) {
      return { status: 'unavailable', task };
    }
    task.cancellationRequestedAt = Date.now();
    task.updatedAt = task.cancellationRequestedAt;
    return { status: 'requested', task };
  }

  /** Refuses new background tasks; the server is shutting down. Replays still resolve. */
  closeAdmission(): void {
    this.admissionClosed = true;
  }

  isAdmissionClosed(): boolean {
    return this.admissionClosed;
  }

  /** Registers a new task's shutdown controls until its result is durable. */
  trackShutdown(task: BackgroundTask, handle: BackgroundTaskShutdownHandle): void {
    this.shutdownHandles.set(task, handle);
    const release = (): void => {
      if (this.shutdownHandles.get(task) === handle) {
        this.shutdownHandles.delete(task);
      }
    };
    handle.settled.then(release, release);
  }

  /**
   * Settles every tracked task before the process exits. Tasks first get whatever time
   * is left before `interruptGraceMs` and the flush reserve; tasks still running are then
   * aborted and get `interruptGraceMs` to settle on their own; the rest have a durable
   * result written for them. Without this, a restart abandons them and their automatic
   * deliveries dead-letter once the producer lease expires.
   */
  async drainForShutdown(options: {
    deadlineAt: number;
    interruptGraceMs: number;
    flushReserveMs: number;
    reason: string;
  }): Promise<BackgroundTaskDrainSummary> {
    this.closeAdmission();
    const tracked = this.shutdownHandles.size;
    if (tracked === 0) {
      return { tracked: 0, interrupted: 0, flushed: 0, unsettled: 0 };
    }
    const flushAt = options.deadlineAt - options.flushReserveMs;
    const interruptAt = flushAt - options.interruptGraceMs;

    await this.waitForShutdownHandles(interruptAt);
    let interrupted = 0;
    for (const [task, handle] of this.shutdownHandles) {
      if (task.status === 'running') {
        interrupted++;
        handle.interrupt(options.reason);
      }
    }

    await this.waitForShutdownHandles(flushAt);
    const remaining = [...this.shutdownHandles.values()];
    let durable = 0;
    await waitUntil(
      Promise.allSettled(
        remaining.map((handle) =>
          handle.flush(options.reason).then(() => {
            durable++;
          }),
        ),
      ),
      options.deadlineAt,
    );
    return {
      tracked,
      interrupted,
      flushed: remaining.length,
      unsettled: remaining.length - durable,
    };
  }

  private waitForShutdownHandles(deadlineAt: number): Promise<void> {
    const pending = [...this.shutdownHandles.values()].map((handle) => handle.settled);
    if (pending.length === 0) {
      return Promise.resolve();
    }
    return waitUntil(Promise.all(pending), deadlineAt);
  }

  private update(
    userId: string,
    conversationId: string,
    taskId: string,
    patch: Partial<BackgroundTask>,
  ): boolean {
    const bucket = this.buckets.get(this.key(userId, conversationId));
    const task = bucket?.tasks.get(taskId);
    if (!task || (task.artifactBlocked === true && patch.artifactBlocked !== true)) {
      return false;
    }
    Object.assign(task, patch, { updatedAt: Date.now() });
    return true;
  }

  complete(
    userId: string,
    conversationId: string,
    taskId: string,
    result: { content: unknown; artifact?: unknown; harvestStarted?: boolean },
  ): string {
    const storedContent = toStoredContent(result.content);
    const task = this.buckets.get(this.key(userId, conversationId))?.tasks.get(taskId);
    if (task == null || task.status !== 'running' || task.artifactBlocked === true) {
      return storedContent;
    }
    const storedArtifact = toStoredArtifact(taskId, result.artifact);
    const usage = this.payloadUsage(task);
    const desiredChars = storedContent.length + storedArtifact.chars;
    const currentChars = usage.result + usage.artifact;
    const hasRetainedCapacity = this.makeRetainedRoom(
      userId,
      task,
      Math.max(0, desiredChars - currentChars),
    );
    const retainedContent = hasRetainedCapacity ? storedContent : undefined;
    const artifact = hasRetainedCapacity ? storedArtifact.artifact : undefined;
    const artifactChars = hasRetainedCapacity ? storedArtifact.chars : 0;
    const updated = this.update(userId, conversationId, taskId, {
      status: 'completed',
      settledAt: Date.now(),
      result: retainedContent,
      artifact,
      error: undefined,
      ...(result.harvestStarted === true ? { harvestStarted: true, harvestPending: true } : {}),
      /** Marks that an artifact existed even after `claimArtifact` clears it,
       *  so re-polls keep the "produced an artifact" note. */
      artifactDelivered: false,
    });
    if (updated) {
      this.cancellationRequests.delete(task);
      this.updatePayloadUsage(task, {
        result: retainedContent?.length ?? 0,
        artifact: artifactChars,
        error: 0,
      });
    }
    return storedContent;
  }

  /**
   * Records the attachments a (possibly still in-flight when polled)
   * completion-time harvest persisted for a settled task. Arrives after
   * `complete()` because the harvest must not gate task completion — the
   * dispatch turn's message row may not exist until that turn finalizes.
   */
  attachHarvest(
    userId: string,
    conversationId: string,
    taskId: string,
    attachments: unknown[],
  ): void {
    if (attachments.length === 0) {
      return;
    }
    const task = this.buckets.get(this.key(userId, conversationId))?.tasks.get(taskId);
    if (task == null || task.status !== 'completed' || task.artifactBlocked === true) {
      return;
    }
    const measured = toStoredArtifact(taskId, attachments);
    const additionalChars = Math.max(0, measured.chars - this.payloadUsage(task).attachments);
    if (measured.artifact == null || !this.makeRetainedRoom(userId, task, additionalChars)) {
      return;
    }
    if (this.update(userId, conversationId, taskId, { attachments })) {
      this.updatePayloadUsage(task, { attachments: measured.chars });
    }
  }

  /** Marks completion-time inspection/persistence successful, unlocking artifact collection. */
  finishHarvest(
    userId: string,
    conversationId: string,
    taskId: string,
    attachments: unknown[] = [],
  ): void {
    const task = this.buckets.get(this.key(userId, conversationId))?.tasks.get(taskId);
    if (task == null || task.status !== 'completed' || task.artifactBlocked === true) {
      return;
    }
    if (attachments.length === 0) {
      this.update(userId, conversationId, taskId, { harvestPending: false });
      return;
    }
    const measured = toStoredArtifact(taskId, attachments);
    const additionalChars = Math.max(0, measured.chars - this.payloadUsage(task).attachments);
    const canStoreAttachments =
      measured.artifact != null && this.makeRetainedRoom(userId, task, additionalChars);
    const updated = this.update(userId, conversationId, taskId, {
      harvestPending: false,
      ...(attachments.length > 0 && canStoreAttachments ? { attachments } : {}),
    });
    if (updated && attachments.length > 0 && canStoreAttachments) {
      this.updatePayloadUsage(task, { attachments: measured.chars });
    }
  }

  /**
   * Returns a completed task's artifact exactly once, marking it delivered and
   * clearing it. The poll turn routes it to a live `toolEndCallback` so the
   * artifact isn't lost with the finalized dispatch turn. If handing it to the
   * callback throws synchronously, `restoreArtifact` puts it back so a later
   * poll can retry. Note the callback's own persistence is fire-and-forget
   * (failures are swallowed downstream), so delivery is at-most-once — the
   * same semantics a foreground tool's artifact has.
   */
  claimArtifact(
    userId: string,
    conversationId: string,
    taskId: string,
  ):
    | {
        toolName: string;
        toolCallId: string;
        stepId?: string;
        messageId?: string;
        harvestStarted?: boolean;
        artifact: unknown;
        content?: string;
      }
    | undefined {
    const bucket = this.buckets.get(this.key(userId, conversationId));
    const task = bucket?.tasks.get(taskId);
    if (
      !task ||
      task.status !== 'completed' ||
      task.harvestPending === true ||
      task.artifact == null ||
      task.artifactDelivered
    ) {
      return undefined;
    }
    const artifact = task.artifact;
    task.artifactDelivered = true;
    task.artifact = undefined;
    this.updatePayloadUsage(task, { artifact: 0 });
    return {
      toolName: task.toolName,
      toolCallId: task.toolCallId,
      stepId: task.stepId,
      messageId: task.messageId,
      harvestStarted: task.harvestStarted,
      artifact,
      content: task.result,
    };
  }

  /**
   * Puts a claimed artifact back after a synchronous delivery failure so the
   * next poll retries it. No-op if the task was swept or already holds an
   * artifact.
   */
  restoreArtifact(userId: string, conversationId: string, taskId: string, artifact: unknown): void {
    const bucket = this.buckets.get(this.key(userId, conversationId));
    const task = bucket?.tasks.get(taskId);
    if (
      !task ||
      task.status !== 'completed' ||
      task.artifactBlocked === true ||
      task.artifact != null
    ) {
      return;
    }
    /** Same size bound as `complete()` — a restore path must not resurrect
     *  an artifact the memory cap already discarded. */
    const storedArtifact = toStoredArtifact(taskId, artifact);
    if (
      storedArtifact.artifact == null ||
      !this.makeRetainedRoom(userId, task, storedArtifact.chars)
    ) {
      return;
    }
    task.artifact = storedArtifact.artifact;
    task.artifactDelivered = false;
    this.updatePayloadUsage(task, { artifact: storedArtifact.chars });
    task.updatedAt = Date.now();
  }

  fail(
    userId: string,
    conversationId: string,
    taskId: string,
    error: string,
    options?: { harvestStarted?: boolean },
  ): void {
    const storedError = truncateMiddle(error, MAX_RESULT_CHARS);
    const task = this.buckets.get(this.key(userId, conversationId))?.tasks.get(taskId);
    if (task == null || task.status !== 'running' || task.artifactBlocked === true) {
      return;
    }
    const hasRetainedCapacity = this.makeRetainedRoom(userId, task, storedError.length);
    const retainedError = hasRetainedCapacity ? storedError : undefined;
    const updated = this.update(userId, conversationId, taskId, {
      status: 'error',
      settledAt: Date.now(),
      error: retainedError,
      result: undefined,
      artifact: undefined,
      attachments: undefined,
      ...(options?.harvestStarted === true ? { harvestStarted: true, harvestPending: true } : {}),
    });
    if (updated) {
      this.cancellationRequests.delete(task);
      this.retainedUsage.set(task, {
        result: 0,
        artifact: 0,
        attachments: 0,
        error: retainedError?.length ?? 0,
      });
    }
  }

  cancel(
    userId: string,
    conversationId: string,
    taskId: string,
    error: string,
    options?: { harvestStarted?: boolean },
  ): void {
    const storedError = truncateMiddle(error, MAX_RESULT_CHARS);
    const task = this.buckets.get(this.key(userId, conversationId))?.tasks.get(taskId);
    if (task == null || task.status !== 'running' || task.artifactBlocked === true) {
      return;
    }
    const hasRetainedCapacity = this.makeRetainedRoom(userId, task, storedError.length);
    const retainedError = hasRetainedCapacity ? storedError : undefined;
    const updated = this.update(userId, conversationId, taskId, {
      status: 'cancelled',
      settledAt: Date.now(),
      error: retainedError,
      result: undefined,
      artifact: undefined,
      attachments: undefined,
      ...(options?.harvestStarted === true ? { harvestStarted: true, harvestPending: true } : {}),
    });
    if (updated) {
      this.cancellationRequests.delete(task);
      this.retainedUsage.set(task, {
        result: 0,
        artifact: 0,
        attachments: 0,
        error: retainedError?.length ?? 0,
      });
    }
  }

  markCompletionWakeup(
    userId: string,
    conversationId: string,
    taskId: string,
    admission?: BackgroundToolWakeupAdmission,
  ): void {
    this.update(userId, conversationId, taskId, {
      completionWakeup: true,
      ...(admission == null ? {} : { completionWakeupRetire: admission.retire }),
    });
  }

  markCompletionPersistencePending(userId: string, conversationId: string, taskId: string): void {
    this.update(userId, conversationId, taskId, { completionPersistencePending: true });
  }

  markCompletionPersistenceFinished(userId: string, conversationId: string, taskId: string): void {
    const bucket = this.buckets.get(this.key(userId, conversationId));
    const task = bucket?.tasks.get(taskId);
    if (bucket == null || task == null) return;
    /** Even a policy-blocked task must release retention protection. This only
     * clears lifecycle state; the immutable artifact block remains intact. */
    task.completionPersistencePending = undefined;
    task.updatedAt = Date.now();
    bucket.lastAccess = task.updatedAt;
  }

  markCompletionPersistenceFailed(userId: string, conversationId: string, taskId: string): void {
    this.update(userId, conversationId, taskId, {
      completionPersistencePending: undefined,
      completionPersistenceFailed: true,
      completionWakeupRetire: undefined,
    });
  }

  async retireCompletionWakeup(
    userId: string,
    conversationId: string,
    taskId: string,
    reason: string,
    options?: { onlyIfUnclaimed?: boolean; onlyIfDead?: boolean },
  ): Promise<boolean> {
    const task = this.get(userId, conversationId, taskId);
    if (task?.completionWakeupRetire == null) {
      return false;
    }
    const retired = await task.completionWakeupRetire(reason, options);
    if (retired) {
      task.completionWakeupRetire = undefined;
      task.completionWakeupRetired = true;
      task.updatedAt = Date.now();
    }
    return retired;
  }

  claimResult(
    userId: string,
    conversationId: string,
    taskId: string,
    claim: { kind: 'manual' | 'wakeup'; claimId: string; generationId?: string },
  ): 'acquired' | 'replay' | 'claimed' | 'not_ready' {
    const task = this.get(userId, conversationId, taskId);
    if (task == null || task.status === 'running') {
      return 'not_ready';
    }
    if (task.resultClaim == null) {
      task.resultClaim = { ...claim, claimedAt: Date.now() };
      task.updatedAt = Date.now();
      return 'acquired';
    }
    return task.resultClaim.kind === claim.kind && task.resultClaim.claimId === claim.claimId
      ? 'replay'
      : 'claimed';
  }

  releaseResultClaim(
    userId: string,
    conversationId: string,
    taskId: string,
    claim: { kind: 'manual' | 'wakeup'; claimId: string },
  ): void {
    const task = this.buckets.get(this.key(userId, conversationId))?.tasks.get(taskId);
    if (task?.resultClaim?.kind === claim.kind && task.resultClaim.claimId === claim.claimId) {
      task.resultClaim = undefined;
      task.updatedAt = Date.now();
    }
  }

  /** Permanently removes a policy-rejected artifact and exposes only the raw-free policy error. */
  blockArtifact(userId: string, conversationId: string, taskId: string, error: string): void {
    const task = this.buckets.get(this.key(userId, conversationId))?.tasks.get(taskId);
    if (task == null) {
      return;
    }
    const storedError = truncateMiddle(error, MAX_RESULT_CHARS);
    const hasRetainedCapacity = this.makeRetainedRoom(
      userId,
      task,
      Math.max(0, storedError.length - this.payloadChars(task)),
    );
    const retainedError = hasRetainedCapacity ? storedError : undefined;
    const updated = this.update(userId, conversationId, taskId, {
      status: 'error',
      settledAt: task.settledAt ?? Date.now(),
      error: retainedError,
      result: undefined,
      artifact: undefined,
      attachments: undefined,
      harvestStarted: undefined,
      harvestPending: undefined,
      artifactDelivered: false,
      artifactBlocked: true,
    });
    if (updated) {
      this.retainedUsage.set(task, {
        result: 0,
        artifact: 0,
        attachments: 0,
        error: retainedError?.length ?? 0,
      });
    }
  }

  /**
   * Reverses `harvestStarted` after the detached harvest failed to persist
   * anything, restoring the artifact if a poll already claimed it, so the
   * legacy poll-turn `toolEndCallback` delivery takes over on a later poll
   * instead of the files being silently lost.
   */
  revokeHarvest(userId: string, conversationId: string, taskId: string, artifact?: unknown): void {
    const bucket = this.buckets.get(this.key(userId, conversationId));
    const task = bucket?.tasks.get(taskId);
    if (!task || task.artifactBlocked === true) {
      return;
    }
    task.harvestStarted = undefined;
    task.harvestPending = undefined;
    if (task.artifact == null && artifact != null) {
      this.restoreArtifact(userId, conversationId, taskId, artifact);
    }
    task.updatedAt = Date.now();
  }

  get(userId: string, conversationId: string, taskId: string): BackgroundTask | undefined {
    const now = Date.now();
    /** Sweep before returning so repeated polling of a known id can't keep an
     *  expired task (and its retained result) alive past the completed TTL. */
    this.sweep(now);
    const bucket = this.buckets.get(this.key(userId, conversationId));
    if (!bucket) {
      return undefined;
    }
    bucket.lastAccess = now;
    this.sweepBucketTasks(bucket, now);
    if (bucket.tasks.size === 0 && bucket.capacityPermits.size === 0) {
      this.buckets.delete(bucket.key);
      return undefined;
    }
    return bucket.tasks.get(taskId);
  }

  list(userId: string, conversationId: string): BackgroundTask[] {
    const now = Date.now();
    this.sweep(now);
    const bucket = this.buckets.get(this.key(userId, conversationId));
    if (!bucket) {
      return [];
    }
    bucket.lastAccess = now;
    this.sweepBucketTasks(bucket, now);
    if (bucket.tasks.size === 0 && bucket.capacityPermits.size === 0) {
      this.buckets.delete(bucket.key);
      return [];
    }
    return [...bucket.tasks.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
}

export const backgroundTaskRegistry: BackgroundTaskRegistryClass =
  new BackgroundTaskRegistryClass();

export interface BackgroundTaskShutdownOptions {
  /** `endpoints.agents.backgroundTasks.shutdownInterruptGraceMs`. */
  interruptGraceMs?: number;
  /** Shutdown time left for the drain; defaults to the local coordinator's remaining budget.
   * A clustered worker passes its primary's tighter deadline. */
  getBudgetMs?: () => number | null;
  registry?: BackgroundTaskRegistryClass;
}

/**
 * Registers the graceful-shutdown steps for background tools: stop admitting new tasks
 * while the HTTP server drains, then, after generations are finalized, settle every task
 * whose result is not yet durable.
 */
export function registerBackgroundTaskShutdown(options: BackgroundTaskShutdownOptions = {}): void {
  const registry = options.registry ?? backgroundTaskRegistry;
  const getBudgetMs = options.getBudgetMs ?? getRemainingShutdownMs;
  registerShutdownTask('background task admission', () => registry.closeAdmission(), {
    phase: 'pre-drain',
    priority: 110,
  });
  registerShutdownTask(
    'background tasks',
    async () => {
      const budgetMs = getBudgetMs();
      if (budgetMs == null) {
        registry.closeAdmission();
        return;
      }
      const summary = await registry.drainForShutdown({
        deadlineAt: Date.now() + Math.max(0, budgetMs - BACKGROUND_SHUTDOWN_TEARDOWN_RESERVE_MS),
        interruptGraceMs:
          options.interruptGraceMs ?? AGENT_BACKGROUND_SHUTDOWN_INTERRUPT_GRACE_MS_DEFAULT,
        flushReserveMs: BACKGROUND_SHUTDOWN_FLUSH_RESERVE_MS,
        reason: BACKGROUND_TASK_SHUTDOWN_MESSAGE,
      });
      if (summary.tracked === 0) {
        return;
      }
      if (summary.unsettled > 0) {
        logger.warn('[background] Shutdown left background task results unconfirmed', summary);
        return;
      }
      logger.info('[background] Drained background tasks for shutdown', summary);
    },
    /** After the generation job manager (100) finalizes interrupted turns, so completion
     * deliveries anchored to them can resolve; before the subagent task store (90). */
    { priority: 95 },
  );
}

/** Content for the synthetic ToolMessage returned when a call is backgrounded. */
export function buildBackgroundHandleContent(
  task: Pick<BackgroundTask, 'id' | 'toolName' | 'status'>,
  options: { completionWakeup?: boolean; liveArtifactPollRequired?: boolean } = {},
): string {
  let message: string;
  if (options.liveArtifactPollRequired === true) {
    message = `Started "${task.toolName}" in the background. This tool can return a live artifact, so you must call ${CHECK_BACKGROUND_TASK_NAME} with background_task_id "${task.id}" until it completes; do not end the turn expecting artifact delivery from an automatic continuation. If the settled result is content-only, the host may still resume you automatically.`;
  } else if (options.completionWakeup === true) {
    message = `Started "${task.toolName}" in the background. Continue independent work or end the turn; the host will resume you when task "${task.id}" finishes. Use ${CHECK_BACKGROUND_TASK_NAME} only for an explicit status check or as a fallback.`;
  } else {
    message = `Started "${task.toolName}" in the background. Call ${CHECK_BACKGROUND_TASK_NAME} with background_task_id "${task.id}" to check progress and retrieve the result; it persists on this server, so you may poll it later in this turn or in a following turn. Do not assume it has finished until you have polled and seen status "completed".`;
  }
  return JSON.stringify({
    background_task_id: task.id,
    tool: task.toolName,
    status: task.status,
    message: `${message} The tool field identifies the originating tool, not the polling tool. Status request: ${JSON.stringify({ name: CHECK_BACKGROUND_TASK_NAME, arguments: { background_task_id: task.id } })}`,
  });
}

/** Content returned when a background registry capacity limit is hit. */
export function buildBackgroundCapacityContent(
  toolName: string,
  scope: BackgroundTaskCapacityScope = 'conversation_running',
): string {
  let message: string;
  if (scope === 'user_running') {
    message = `Too many background tasks are already active for this user (limit ${MAX_RUNNING_PER_USER}, including pending launch reservations). Wait for existing background work to settle, or run this call in the foreground.`;
  } else if (scope === 'user_retention') {
    message = `This user is retaining the maximum number of background tasks (${MAX_TASKS_PER_USER}), and pending result processing prevents safe eviction. Wait for background result processing to finish, or run this call in the foreground.`;
  } else if (scope === 'global_running') {
    message = `The server-wide background task registry is at capacity (running limit ${MAX_RUNNING_GLOBAL}). Retry later, or run this call in the foreground.`;
  } else if (scope === 'global_retention') {
    message = `The server-wide background task registry is retaining its maximum number of tasks (${MAX_TASKS_GLOBAL}), and pending result processing prevents safe eviction. Retry later, or run this call in the foreground.`;
  } else if (scope === 'shutting_down') {
    message =
      'This server is shutting down and is not starting new background tasks. Run this call in the foreground, or dispatch it again after the server restarts.';
  } else if (scope === 'conversation_retention') {
    message = `This conversation is retaining the maximum number of background tasks (${MAX_TASKS_PER_BUCKET}), and pending result processing prevents safe eviction. Wait for background result processing to finish, or run this call in the foreground.`;
  } else {
    message = `Too many background tasks are already running in this conversation (limit ${MAX_RUNNING_PER_BUCKET}). Poll ${CHECK_BACKGROUND_TASK_NAME} to collect finished results before dispatching more, or run this call in the foreground.`;
  }
  return JSON.stringify({
    status: 'rejected',
    tool: toolName,
    scope,
    message,
  });
}

/**
 * Serializes a task for the poll tool. The list path (`includeResult: false`)
 * returns metadata only — never the full `result` — so a status-list poll can't
 * inject megabytes of retained tool output into the next model step. The full
 * result is only returned when a specific `background_task_id` is requested.
 */
interface SerializedBackgroundTask {
  background_task_id: string;
  tool: string;
  status: BackgroundTaskStatus;
  /** Coarse 0..1: no intermediate progress exists, only running vs settled. */
  progress: number;
  cancellation_requested?: boolean;
  /** ISO-8601 dispatch time, the app's serialization for every timestamp. */
  started_at?: string;
  /** ISO-8601 terminal time. Absent while the task is still running. */
  settled_at?: string;
  /** Dispatch to settlement, or dispatch to this poll while still running. */
  elapsed_ms?: number;
  result?: string;
  result_available?: boolean;
  result_chars?: number;
  /** Whether the result has reached the conversation. `pending` results still
   * arrive as a new turn unless polled or cancelled first. Absent when the task
   * has no automatic delivery, so only a poll ever surfaces its result. */
  delivery?: BackgroundTaskDelivery;
  note?: string;
  error?: string;
}

const FAILED_DELIVERY_GUIDANCE =
  'Automatic delivery failed for some finished tasks (delivery: "failed"); they will not arrive as a new turn. Poll each to collect its result.';

const SUBAGENT_PENDING_DELIVERY_GUIDANCE =
  'Some finished subagents have not been delivered yet (delivery: "pending"); each will arrive as a new turn. Poll one to collect its result now. Do not report them as finished until then.';

const PENDING_DELIVERY_GUIDANCE =
  'Some finished tasks have not been delivered yet (delivery: "pending"); each will arrive as a new turn. Poll one to collect its result now, or cancel it so it does not arrive. Do not report these tasks as finished or cancelled until then.';

/**
 * Model-facing task timings. The registry keeps epoch milliseconds; everything the
 * app serializes carries ISO-8601 (`toISOString`), so the poll payload does too.
 * `elapsed_ms` is served alongside them because a polling model has no clock of its
 * own: without it, "running" carries no age and a caller cannot tell a task that
 * started seconds ago from one stuck for an hour.
 *
 * `createdAt` is the strictly-increasing dispatch stamp, so a same-millisecond
 * dispatch can read a few milliseconds after its real start and, for an instantly
 * settled task, after `updatedAt`; clamping keeps `settled_at` from preceding
 * `started_at` and `elapsed_ms` from going negative.
 */
function taskTimings(task: {
  status: string;
  createdAt: number;
  updatedAt: number;
}): Pick<SerializedBackgroundTask, 'started_at' | 'settled_at' | 'elapsed_ms'> {
  const settled = task.status !== 'running';
  const settledAt = Math.max(task.updatedAt, task.createdAt);
  return {
    started_at: new Date(task.createdAt).toISOString(),
    ...(settled ? { settled_at: new Date(settledAt).toISOString() } : {}),
    elapsed_ms: Math.max(0, (settled ? settledAt : Date.now()) - task.createdAt),
  };
}

function resultFields(
  task: BackgroundTask,
  includeResult: boolean,
): Pick<SerializedBackgroundTask, 'result' | 'result_available' | 'result_chars'> {
  if (task.result === undefined) {
    return {};
  }
  if (includeResult) {
    return { result: task.result };
  }
  return { result_available: true, result_chars: task.result.length };
}

function taskNote(task: BackgroundTask): Pick<SerializedBackgroundTask, 'note'> {
  if (task.attachments != null && task.attachments.length > 0) {
    return {
      note: 'Generated files were saved and attached to the tool call that dispatched this task.',
    };
  }
  if (task.harvestStarted === true && task.status === 'completed') {
    return {
      note: 'Output and any generated files are being attached to the tool call that dispatched this task.',
    };
  }
  if (task.artifact != null || task.artifactDelivered === true) {
    return { note: 'The tool produced an artifact that is not included inline.' };
  }
  return {};
}

function taskDelivery(task: BackgroundTask): Pick<SerializedBackgroundTask, 'delivery'> {
  if (task.completionWakeup !== true || task.completionPersistenceFailed === true) {
    return {};
  }
  if (task.resultClaim != null || task.completionWakeupRetired === true) {
    return { delivery: 'delivered' };
  }
  return { delivery: 'pending' };
}

/** A completion known only to the durable delivery store: dispatched in an earlier
 * turn, on another replica, or before a restart, and not delivered yet. */
function serializePendingCompletion(
  completion: PendingBackgroundCompletion,
): SerializedBackgroundTask {
  const settled = completion.result;
  return {
    background_task_id: completion.taskId,
    tool: completion.toolName,
    status: settled?.status ?? 'running',
    progress: settled == null ? 0 : 1,
    started_at: completion.dispatchedAt.toISOString(),
    ...(settled != null && { settled_at: settled.settledAt.toISOString() }),
    delivery: 'pending',
    note:
      settled == null
        ? 'Still running outside this turn; its result will arrive as a new turn when it finishes.'
        : 'Finished, but its result has not been delivered; it will arrive as a new turn unless you poll or cancel it.',
  };
}

/** One conversation's durable delivery evidence, split from what this process holds. */
export interface DurableCompletionView {
  /** Undelivered completions this process does not hold. */
  pending: PendingBackgroundCompletion[];
  /** Dead-lettered completions this process does not hold; only a poll recovers them. */
  dead: PendingBackgroundCompletion[];
  /** Every undelivered task id, present only when the listing was complete: a local
   * task absent from it was delivered on this or another replica. */
  pendingTaskIds?: ReadonlySet<string>;
  deadTaskIds: ReadonlySet<string>;
}

/** Reads the durable delivery store, which outlives the process-local registry.
 * Rejects when the store is unreachable; callers keep their local view then. */
export async function readDurableCompletions(
  controls: Pick<PendingBackgroundCompletionControls, 'list'>,
  input: { userId: string; conversationId: string },
  localTaskIds: ReadonlySet<string>,
): Promise<DurableCompletionView> {
  const durable = await controls.list(input);
  const remote = (completion: PendingBackgroundCompletion) => !localTaskIds.has(completion.taskId);
  return {
    pending: durable.completions.filter(remote),
    dead: durable.dead.filter(remote),
    ...(durable.complete && {
      pendingTaskIds: new Set(durable.completions.map(({ taskId }) => taskId)),
    }),
    deadTaskIds: new Set(durable.dead.map(({ taskId }) => taskId)),
  };
}

/** A local task whose durable delivery settled elsewhere (an automatic wake-up
 * on any replica) no longer holds a local claim; the complete durable listing is
 * the evidence. An incomplete listing proves nothing, so the local view stands. */
export function resolveTaskDelivery(
  task: BackgroundTask,
  durable?: Pick<DurableCompletionView, 'pendingTaskIds' | 'deadTaskIds'>,
): BackgroundTaskDelivery | undefined {
  const local = taskDelivery(task).delivery;
  if (local !== 'pending' || task.status === 'running' || durable == null) {
    return local;
  }
  if (durable.deadTaskIds.has(task.id)) {
    return 'failed';
  }
  if (durable.pendingTaskIds == null || durable.pendingTaskIds.has(task.id)) {
    return local;
  }
  return 'delivered';
}

/** A completion whose automatic delivery dead-lettered and that this process no
 * longer holds: never delivered, so only a poll can still collect its result. */
function serializeDeadCompletion(
  completion: PendingBackgroundCompletion,
): SerializedBackgroundTask {
  return {
    ...serializePendingCompletion(completion),
    delivery: 'failed',
    note: 'Automatic delivery failed; this result will not arrive as a new turn. Poll it to collect the result.',
  };
}

function serializeTask(
  task: BackgroundTask,
  { includeResult }: { includeResult: boolean },
): SerializedBackgroundTask {
  return {
    background_task_id: task.id,
    tool: task.toolName,
    status: task.status,
    progress: task.status === 'running' ? 0 : 1,
    ...(task.status === 'running' && task.cancellationRequestedAt != null
      ? { cancellation_requested: true }
      : {}),
    ...taskTimings(task),
    ...resultFields(task, includeResult),
    ...taskDelivery(task),
    ...taskNote(task),
    ...(task.error !== undefined ? { error: task.error } : {}),
  };
}

/**
 * A durable receipt is what a poll sees once process-local state is gone (another
 * replica, or after a restart). It records when the task settled but not when it was
 * dispatched, so it carries `settled_at` alone: no start, hence no elapsed span.
 */
function serializeDurableTask(task: BackgroundToolResultRecord): SerializedBackgroundTask {
  return {
    background_task_id: task.taskId,
    tool: task.toolName,
    status: task.status,
    progress: 1,
    ...(task.settledAt == null ? {} : { settled_at: task.settledAt.toISOString() }),
    ...(task.status === 'completed' ? { result: task.output } : { error: task.output }),
  };
}

interface SerializedSubagentTask {
  background_task_id: string;
  subagent_thread_id?: string;
  tool: string;
  subagent_type: string;
  status: string;
  progress: number;
  progress_detail?: SubagentTaskSnapshot['progress'];
  started_at?: string;
  settled_at?: string;
  elapsed_ms?: number;
  result?: string;
  result_available?: boolean;
  result_claimed?: boolean;
  pending_controls?: number;
  error?: string;
  control_id?: string;
  message?: string;
  /** A finished subagent whose result will still resume the parent turn. */
  delivery?: 'pending';
}

function serializeSubagentSnapshot(
  task: SubagentTaskSnapshot,
  options: {
    includeResult?: string;
    status?: string;
    controlId?: string;
    completionWakeups?: boolean;
  } = {},
): SerializedSubagentTask {
  return {
    background_task_id: task.taskId,
    ...(task.threadId == null ? {} : { subagent_thread_id: task.threadId }),
    tool: String(AgentConstants.SUBAGENT),
    subagent_type: task.subagentType,
    status: options.status ?? task.status,
    progress: task.status === 'running' ? 0 : 1,
    ...(task.progress == null ? {} : { progress_detail: task.progress }),
    /** Timings follow the task's own lifecycle, never a control receipt's status. */
    ...taskTimings(task),
    ...(options.includeResult == null ? {} : { result: options.includeResult }),
    ...(task.resultAvailable ? { result_available: true } : {}),
    ...(task.resultClaimed ? { result_claimed: true } : {}),
    ...(task.pendingControls > 0 ? { pending_controls: task.pendingControls } : {}),
    ...(task.error == null ? {} : { error: task.error }),
    ...(options.controlId == null ? {} : { control_id: options.controlId }),
    ...(options.completionWakeups === true && task.status === 'running'
      ? { message: SUBAGENT_WAKEUP_GUIDANCE }
      : {}),
  };
}

function serializeSubagentClaim(
  claim: SubagentTaskClaim,
  completionWakeups: boolean,
): SerializedSubagentTask | undefined {
  if (claim.status === 'not_found') {
    return undefined;
  }
  if (claim.status === 'completed') {
    return serializeSubagentSnapshot(claim.task, { includeResult: claim.result });
  }
  if (claim.status === 'error' || claim.status === 'cancelled') {
    return {
      ...serializeSubagentSnapshot(claim.task, { status: claim.status }),
      error: claim.error,
    };
  }
  return serializeSubagentSnapshot(claim.task, { status: claim.status, completionWakeups });
}

function serializeSubagentControl(
  result: SubagentTaskControlResult,
): SerializedSubagentTask | { status: string; message?: string } | undefined {
  if (result.status === 'not_found') {
    return undefined;
  }
  if (result.status === 'invalid') {
    return { status: result.status, message: result.message };
  }
  return serializeSubagentSnapshot(result.task, {
    status: result.status,
    ...(result.status === 'accepted' && result.controlId != null
      ? { controlId: result.controlId }
      : {}),
  });
}

function buildSubagentControlCommand(
  args: Record<string, unknown>,
  action: string,
): SubagentTaskControlCommand | undefined {
  if (action === 'cancel') {
    return { action: 'cancel' };
  }
  if (action === 'cancel_message') {
    return typeof args.control_id === 'string' &&
      args.control_id.length <= MAX_BACKGROUND_CONTROL_ID_CHARS
      ? { action: 'cancel_message', controlId: args.control_id }
      : undefined;
  }
  if (action === 'steer' || action === 'queue' || action === 'interrupt') {
    return typeof args.message === 'string' &&
      args.message.length <= MAX_BACKGROUND_CONTROL_MESSAGE_CHARS
      ? { action, message: args.message }
      : undefined;
  }
  return undefined;
}

/**
 * One tool call is one invocation, of a control or of the poll that collects a result.
 * A provider tool-call id such as `call_0` repeats across runs and agents, so the
 * identity also carries the run and executing agent; replaying that same call stays
 * idempotent while a later run's identical id is a new invocation. Hashing keeps every
 * derived identity inside the routed bound.
 */
function controlInvocationId(params: {
  toolCallId?: string;
  agentId?: string;
  runId?: string;
}): string {
  const toolCallId = params.toolCallId?.trim();
  if (toolCallId == null || toolCallId === '') {
    return randomUUID();
  }
  return createHash('sha256')
    .update(`${params.runId ?? ''}\u0000${params.agentId ?? ''}\u0000${toolCallId}`)
    .digest('base64url')
    .slice(0, 32);
}

/** Executes a `check_background_task` call and returns the ToolMessage content. */
interface RoutedSubagentTaskStore {
  claimTask(scopeId: string, taskId: string, invocationId: string): Promise<SubagentTaskClaim>;
  controlTask(
    scopeId: string,
    taskId: string,
    command: SubagentTaskControlCommand,
    invocationId: string,
  ): Promise<SubagentTaskControlResult>;
  listTasks(scopeId: string): Promise<SubagentTaskSnapshot[]>;
}

function routedSubagentStore(store: SubagentTaskStore): RoutedSubagentTaskStore | undefined {
  const candidate = store as SubagentTaskStore & Partial<RoutedSubagentTaskStore>;
  return typeof candidate.claimTask === 'function' &&
    typeof candidate.controlTask === 'function' &&
    typeof candidate.listTasks === 'function'
    ? (candidate as RoutedSubagentTaskStore)
    : undefined;
}

export async function runCheckBackgroundTask(params: {
  userId: string;
  conversationId: string;
  args: unknown;
  /** The provider's tool-call id: one control invocation, stable across replays. */
  toolCallId?: string;
  /** Scopes that tool-call id, whose provider ids repeat across runs and agents. */
  agentId?: string;
  runId?: string;
  /** Stable response-message identity used to fence abandoned manual claims. */
  generationId?: string;
  subagentTasks?: SubagentTaskConfig;
  claimBackgroundToolResult?: (params: {
    userId: string;
    conversationId: string;
    messageId?: string;
    taskId: string;
    agentId?: string;
    kind: 'manual';
    claimId: string;
    generationId?: string;
    allowUnfinished?: boolean;
  }) => Promise<BackgroundToolResultClaim>;
  recoverDeadBackgroundToolClaim?: BackgroundToolDeadClaimRecovery;
  /** Trusted deployment policy. Defaults false for backward compatibility. */
  ordinaryToolCancellation?: boolean;
  /** Durable view of this conversation's undelivered background completions. */
  pendingCompletions?: PendingBackgroundCompletionControls;
}): Promise<string> {
  const { userId, conversationId } = params;
  const args = coerceArgsObject(params.args) ?? {};
  const rawId = args.background_task_id;
  if (typeof rawId === 'string' && rawId.trim().length > MAX_BACKGROUND_TASK_ID_CHARS) {
    return JSON.stringify({
      status: 'invalid',
      message: `A background_task_id cannot exceed ${MAX_BACKGROUND_TASK_ID_CHARS} characters.`,
    });
  }
  const taskId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : undefined;
  const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'poll';
  const invocationId = controlInvocationId(params);

  if (taskId) {
    const task = backgroundTaskRegistry.get(userId, conversationId, taskId);
    if (task != null) {
      if (action !== 'poll') {
        if (action === 'cancel') {
          /** A finished task has no execution to stop, so the live-cancellation
           * policy does not apply: cancelling it falls through to the poll path,
           * which retires its pending delivery. */
          if (params.ordinaryToolCancellation !== true && task.status === 'running') {
            return JSON.stringify({
              status: 'invalid',
              background_task_id: taskId,
              message: 'Cancellation is not enabled for ordinary background tools.',
            });
          }
          const cancellation = backgroundTaskRegistry.requestCancellation(
            userId,
            conversationId,
            taskId,
          );
          if (cancellation.status === 'settled') {
            /** Settlement won the race. Fall through to the ordinary poll path
             * so durable result-claim arbitration still elects one consumer. */
          } else if (
            cancellation.status === 'requested' ||
            cancellation.status === 'already_requested'
          ) {
            return JSON.stringify({
              ...serializeTask(cancellation.task, { includeResult: false }),
              status: 'cancellation_requested',
              cancellation_requested: true,
              message:
                'Cancellation was requested. The task remains active until its executor settles; poll again for a terminal result.',
            });
          } else {
            return JSON.stringify({
              status: 'unavailable',
              background_task_id: taskId,
              message:
                'This server no longer owns a live cancellation handle for the task. Poll for its outcome; do not assume execution stopped.',
            });
          }
        } else {
          return JSON.stringify({
            status: 'invalid',
            background_task_id: taskId,
            message: 'This control action is supported only for subagent tasks.',
          });
        }
      }
      if (task.status !== 'running') {
        if (
          task.completionWakeup === true &&
          task.completionPersistenceFailed !== true &&
          params.claimBackgroundToolResult != null &&
          task.messageId != null
        ) {
          const durableClaimInput = {
            userId,
            conversationId,
            messageId: task.messageId,
            taskId,
            agentId: task.agentId,
            kind: 'manual' as const,
            claimId: invocationId,
            ...(params.generationId == null ? {} : { generationId: params.generationId }),
          };
          let durableClaim = await params.claimBackgroundToolResult(durableClaimInput);
          if (durableClaim.status === 'claimed') {
            let recovered = false;
            let recoveryUnavailable = false;
            const existingClaim = durableClaim.claim;
            const recoverableClaim =
              existingClaim?.kind === 'wakeup' ||
              (existingClaim?.kind === 'manual' && existingClaim.generationId != null);
            if (
              recoverableClaim &&
              existingClaim != null &&
              params.recoverDeadBackgroundToolClaim != null
            ) {
              try {
                recovered = await params.recoverDeadBackgroundToolClaim({
                  userId,
                  conversationId,
                  messageId: task.messageId,
                  claimId: existingClaim.claimId,
                  ...(existingClaim.kind === 'manual'
                    ? {
                        kind: 'manual' as const,
                        generationId: existingClaim.generationId,
                      }
                    : {}),
                });
              } catch (error) {
                recoveryUnavailable = true;
                logger.warn(
                  `[background] Failed to reconcile claimed completion for manual poll ${taskId}:`,
                  error,
                );
              }
            }
            if (!recovered) {
              return JSON.stringify({
                status: recoveryUnavailable ? 'result_persisting' : 'delivery_scheduled',
                background_task_id: taskId,
                message: recoveryUnavailable
                  ? 'The automatic delivery recovery is temporarily unavailable. Retry this poll shortly.'
                  : 'This result is already assigned to an automatic continuation.',
              });
            }
            durableClaim = await params.claimBackgroundToolResult(durableClaimInput);
            if (durableClaim.status === 'claimed') {
              return JSON.stringify({
                status: 'delivery_scheduled',
                background_task_id: taskId,
                message: 'This result is already assigned to another continuation.',
              });
            }
            if (durableClaim.status !== 'acquired') {
              return JSON.stringify({
                status: 'result_persisting',
                background_task_id: taskId,
                message:
                  'The task is finished and its result is being recovered. Retry this poll shortly.',
              });
            }
          }
          if (durableClaim.status === 'acquired' && task.completionWakeupRetired !== true) {
            /** The result reaches the agent here, so its automatic delivery is redundant. */
            await backgroundTaskRegistry
              .retireCompletionWakeup(
                userId,
                conversationId,
                taskId,
                'completion claimed by manual poll',
                { onlyIfUnclaimed: true },
              )
              .catch((error: unknown) =>
                logger.warn(
                  `[background] Failed to retire the delivery of manually claimed task ${taskId}:`,
                  error,
                ),
              );
          }
          if (durableClaim.status === 'not_found' || durableClaim.status === 'not_ready') {
            const localReplay =
              task.resultClaim?.kind === 'manual' && task.resultClaim.claimId === invocationId;
            const pollOwnsOriginatingGeneration =
              params.generationId != null && params.generationId === task.messageId;
            const localClaimAllowed =
              pollOwnsOriginatingGeneration || task.liveArtifactPollRequired === true;
            let localClaimNeedsNoDurableConfirmation = localReplay && localClaimAllowed;
            if (!localReplay) {
              /** Retire the still-unclaimed delivery before creating local
               * ownership. A live resolver lease wins. Once that resolver is
               * irreversibly dead-lettered, a dead-only repair reopens the
               * process-local poll fallback without stealing live work. */
              let retired = task.completionWakeupRetired === true;
              if (!retired) {
                try {
                  retired = await backgroundTaskRegistry.retireCompletionWakeup(
                    userId,
                    conversationId,
                    taskId,
                    'completion claimed by same-generation manual poll',
                    { onlyIfUnclaimed: true },
                  );
                  if (!retired) {
                    retired = await backgroundTaskRegistry.retireCompletionWakeup(
                      userId,
                      conversationId,
                      taskId,
                      'dead completion recovered by same-generation manual poll',
                      { onlyIfDead: true },
                    );
                    if (retired) {
                      localClaimNeedsNoDurableConfirmation = true;
                      backgroundTaskRegistry.markCompletionPersistenceFailed(
                        userId,
                        conversationId,
                        taskId,
                      );
                    }
                  }
                } catch (error) {
                  logger.warn(
                    `[background] Failed to retire automatic completion for manual claim ${taskId}:`,
                    error,
                  );
                }
              }
              if (!retired) {
                return JSON.stringify({
                  status: 'result_persisting',
                  background_task_id: taskId,
                  message:
                    'The task is finished and completion ownership is being settled. Retry this poll shortly.',
                });
              }
              if (localClaimAllowed) {
                const localClaim = backgroundTaskRegistry.claimResult(
                  userId,
                  conversationId,
                  taskId,
                  {
                    kind: 'manual',
                    claimId: invocationId,
                    ...(params.generationId == null ? {} : { generationId: params.generationId }),
                  },
                );
                if (localClaim === 'claimed') {
                  return JSON.stringify({
                    status: 'delivery_scheduled',
                    background_task_id: taskId,
                    message: 'This result is already assigned to an automatic continuation.',
                  });
                }
                if (localClaim === 'not_ready') {
                  return JSON.stringify({
                    status: 'result_persisting',
                    background_task_id: taskId,
                    message:
                      'The task is finished and its result is being made durable. Retry this poll shortly.',
                  });
                }
                /** The poll is executing inside the unfinished dispatch
                 * generation, or it must deliver a live artifact. Waiting for
                 * the durable row would require that generation to end first.
                 * The retired unclaimed wakeup plus this local manual claim is
                 * authoritative for this owner process; the persistence retry
                 * re-reads and copies the claim after finalization. */
                localClaimNeedsNoDurableConfirmation = true;
              }
            }
            /** Ordinary polls claim the durable terminal receipt directly.
             * They never reserve a process-local claim while the receipt is
             * absent: a later poll has a different provider tool-call id and
             * could never take over that abandoned reservation. A poll owned
             * by the originating generation cannot wait for that same
             * generation to finalize its durable response row. */
            if (!localClaimNeedsNoDurableConfirmation) {
              const reconciledClaim = await params.claimBackgroundToolResult({
                ...durableClaimInput,
                /** Retirement above makes this owner-process takeover safe;
                 * the terminal row may still be a mid-turn partial save. */
                allowUnfinished: true,
              });
              if (reconciledClaim.status === 'claimed') {
                backgroundTaskRegistry.releaseResultClaim(userId, conversationId, taskId, {
                  kind: 'manual',
                  claimId: invocationId,
                });
                return JSON.stringify({
                  status: 'delivery_scheduled',
                  background_task_id: taskId,
                  message: 'This result is already assigned to an automatic continuation.',
                });
              }
              if (reconciledClaim.status !== 'acquired') {
                return JSON.stringify({
                  status: 'result_persisting',
                  background_task_id: taskId,
                  message:
                    'The task is finished and its result is being made durable. Retry this poll shortly.',
                });
              }
              /** The response's final full save can overwrite a claim stamped
               * on its unfinished partial row. Mirror only a DURABLY acquired
               * claim so the persistence retry re-applies that ownership after
               * finalization; never create an unanchored local reservation. */
              const mirroredClaim = backgroundTaskRegistry.claimResult(
                userId,
                conversationId,
                taskId,
                {
                  kind: 'manual',
                  claimId: invocationId,
                  ...(params.generationId == null ? {} : { generationId: params.generationId }),
                },
              );
              if (mirroredClaim === 'claimed') {
                logger.error(
                  `[background] Durable manual claim for ${taskId} conflicts with process-local ownership.`,
                );
              }
            }
          }
        }
      }
      return JSON.stringify(serializeTask(task, { includeResult: true }));
    }

    /** A failed lookup must not mask a subagent the controls below can still reach. */
    let discardFailed = false;
    if (action === 'cancel' && params.pendingCompletions != null) {
      let outcome: Awaited<ReturnType<PendingBackgroundCompletionControls['discard']>> =
        'not_pending';
      try {
        outcome = await params.pendingCompletions.discard({ userId, conversationId, taskId });
      } catch (error) {
        logger.warn(`[background] Failed to discard pending completion ${taskId}:`, error);
        discardFailed = true;
      }
      if (outcome === 'discarded') {
        return JSON.stringify({
          status: 'cancelled',
          background_task_id: taskId,
          message: 'The finished result was discarded and will not arrive as a new turn.',
        });
      }
      if (outcome === 'running') {
        return JSON.stringify({
          status: 'unavailable',
          background_task_id: taskId,
          delivery: 'pending',
          message:
            'This task is still running outside this turn and cannot be stopped from here. Its result will arrive as a new turn when it finishes; cancel it then to discard the result.',
        });
      }
      if (outcome === 'delivering') {
        return JSON.stringify({
          status: 'delivery_scheduled',
          background_task_id: taskId,
          message: 'This result is already being delivered as a new turn.',
        });
      }
    }

    const subagentTasks = params.subagentTasks;
    let subagentPollChecked = false;
    let subagentPollError: unknown;
    /** Routed subagents have their own durable/cross-replica store. Resolve
     * them before ordinary-tool Mongo recovery so two fallback reads—or a
     * message-store outage—cannot delay or mask a healthy subagent result. */
    if (action === 'poll' && subagentTasks != null) {
      subagentPollChecked = true;
      try {
        const routedStore = routedSubagentStore(subagentTasks.store);
        const claim =
          routedStore == null
            ? subagentTasks.store.claim(subagentTasks.scopeId, taskId)
            : await routedStore.claimTask(subagentTasks.scopeId, taskId, invocationId);
        const claimed = serializeSubagentClaim(
          claim,
          agentUsesSubagentCompletionWakeups(subagentTasks, params.agentId),
        );
        if (claimed != null) {
          return JSON.stringify(claimed);
        }
      } catch (error) {
        /** This id may still belong to an ordinary background tool whose
         * durable receipt is healthy. Defer the subagent failure until after
         * that independent recovery path has had a chance to identify it. */
        subagentPollError = error;
      }
    }

    if (action === 'poll' && params.claimBackgroundToolResult != null) {
      const durableClaimInput = {
        userId,
        conversationId,
        taskId,
        agentId: params.agentId,
        kind: 'manual' as const,
        claimId: invocationId,
        ...(params.generationId == null ? {} : { generationId: params.generationId }),
      };
      let durableClaim: BackgroundToolResultClaim;
      try {
        durableClaim = await params.claimBackgroundToolResult(durableClaimInput);
        const claimedResult = durableClaim.status === 'claimed' ? durableClaim : undefined;
        const existingClaim = claimedResult?.claim;
        const recoverableClaim =
          existingClaim?.kind === 'wakeup' ||
          (existingClaim?.kind === 'manual' && existingClaim.generationId != null);
        if (
          recoverableClaim &&
          existingClaim != null &&
          claimedResult?.messageId != null &&
          params.recoverDeadBackgroundToolClaim != null
        ) {
          const recovered = await params.recoverDeadBackgroundToolClaim({
            userId,
            conversationId,
            messageId: claimedResult.messageId,
            claimId: existingClaim.claimId,
            ...(existingClaim.kind === 'manual'
              ? {
                  kind: 'manual' as const,
                  generationId: existingClaim.generationId,
                }
              : {}),
          });
          if (recovered) {
            durableClaim = await params.claimBackgroundToolResult(durableClaimInput);
          }
        }
      } catch (error) {
        logger.warn(`[background] Failed to recover durable task ${taskId} during polling:`, error);
        return JSON.stringify({
          status: 'result_unavailable',
          background_task_id: taskId,
          message:
            'The durable task receipt is temporarily unavailable. Do not repeat a mutating operation; retry this status check later.',
        });
      }
      if (durableClaim.status === 'acquired') {
        const durableTask = durableClaim.results.find((result) => result.taskId === taskId);
        if (durableTask != null) {
          /** The result reaches the agent here, so its automatic delivery is redundant. */
          await params.pendingCompletions
            ?.settleClaimed({ userId, conversationId, taskId })
            .catch((error: unknown) =>
              logger.warn(
                `[background] Failed to retire the delivery of manually claimed task ${taskId}:`,
                error,
              ),
            );
          return JSON.stringify(serializeDurableTask(durableTask));
        }
        return JSON.stringify({
          status: 'result_persisting',
          background_task_id: taskId,
          message: 'The task receipt is settling. Retry this poll shortly.',
        });
      }
      if (durableClaim.status === 'claimed') {
        return JSON.stringify({
          status: 'delivery_scheduled',
          background_task_id: taskId,
          message: 'This result is already assigned to another poll or automatic continuation.',
        });
      }
      if (durableClaim.status === 'outcome_unknown') {
        return JSON.stringify({
          status: 'outcome_unknown',
          background_task_id: taskId,
          tool: durableClaim.toolName,
          message:
            'The task was launched, but this server cannot confirm a live executor or a durable terminal receipt. Do not repeat a mutating operation automatically; inspect the target system before retrying.',
        });
      }
      if (durableClaim.status === 'not_ready') {
        return JSON.stringify({
          status: 'result_persisting',
          background_task_id: taskId,
          message:
            'The task exists, but its terminal receipt is not ready. Do not repeat a mutating operation; retry this status check later.',
        });
      }
    }

    if (subagentTasks != null) {
      try {
        const routedStore = routedSubagentStore(subagentTasks.store);
        if (action === 'poll') {
          if (!subagentPollChecked) {
            const claim =
              routedStore == null
                ? subagentTasks.store.claim(subagentTasks.scopeId, taskId)
                : await routedStore.claimTask(subagentTasks.scopeId, taskId, invocationId);
            const claimed = serializeSubagentClaim(
              claim,
              agentUsesSubagentCompletionWakeups(subagentTasks, params.agentId),
            );
            if (claimed != null) {
              return JSON.stringify(claimed);
            }
          } else if (subagentPollError != null) {
            if (subagentPollError instanceof SubagentTaskOwnerUnavailableError) {
              return JSON.stringify({
                status: 'unavailable',
                background_task_id: taskId,
                message: subagentPollError.message,
              });
            }
            throw subagentPollError;
          }
        } else {
          const command = buildSubagentControlCommand(args, action);
          if (command == null) {
            return JSON.stringify({
              status: 'invalid',
              background_task_id: taskId,
              message: 'This subagent control action is unknown or missing its required argument.',
            });
          }
          const result =
            routedStore == null
              ? subagentTasks.store.control(subagentTasks.scopeId, taskId, command)
              : await routedStore.controlTask(subagentTasks.scopeId, taskId, command, invocationId);
          const controlled = serializeSubagentControl(result);
          if (controlled != null) {
            return JSON.stringify(controlled);
          }
        }
      } catch (error) {
        if (error instanceof SubagentTaskOwnerUnavailableError) {
          return JSON.stringify({
            status: 'unavailable',
            background_task_id: taskId,
            message: error.message,
          });
        }
        throw error;
      }
    }

    if (discardFailed) {
      return JSON.stringify({
        status: 'unavailable',
        background_task_id: taskId,
        message:
          'The pending result could not be discarded right now. It may still arrive as a new turn; retry the cancel shortly.',
      });
    }
    return JSON.stringify({
      status: 'not_found',
      background_task_id: taskId,
      message: 'No background task with that id exists in this thread.',
    });
  }

  if (action !== 'poll') {
    return JSON.stringify({
      status: 'invalid',
      message: 'A background_task_id is required for control actions.',
    });
  }

  const tasks = backgroundTaskRegistry.list(userId, conversationId);
  let subagentTasks: SerializedSubagentTask[] = [];
  const listWarnings: string[] = [];
  let durable: DurableCompletionView | undefined;
  if (params.pendingCompletions != null) {
    try {
      durable = await readDurableCompletions(
        params.pendingCompletions,
        { userId, conversationId },
        new Set(tasks.map((task) => task.id)),
      );
      if (durable.pendingTaskIds == null) {
        listWarnings.push(
          'The undelivered or failed result list may be incomplete; pending results not shown may still arrive as new turns.',
        );
      }
    } catch (error) {
      logger.warn('[background] Failed to list undelivered background completions:', error);
      listWarnings.push(
        'Undelivered results from earlier turns could not be listed; some may still arrive as new turns.',
      );
    }
  }
  const completionWakeups = agentUsesSubagentCompletionWakeups(
    params.subagentTasks,
    params.agentId,
  );
  if (params.subagentTasks != null) {
    try {
      const routedStore = routedSubagentStore(params.subagentTasks.store);
      const snapshots =
        routedStore == null
          ? params.subagentTasks.store.list(params.subagentTasks.scopeId)
          : await routedStore.listTasks(params.subagentTasks.scopeId);
      subagentTasks = snapshots.map((task) => serializeSubagentSnapshot(task));
    } catch (error) {
      if (error instanceof SubagentTaskOwnerUnavailableError) {
        /** Cross-replica discovery is an additive source. A Redis outage must not
         * hide ordinary tasks or subagents owned by this process; surface the
         * incomplete view explicitly so the caller can retry for remote tasks. */
        subagentTasks = params.subagentTasks.store
          .list(params.subagentTasks.scopeId)
          .map((task) => serializeSubagentSnapshot(task));
        listWarnings.push(`Cross-replica subagent tasks could not be listed: ${error.message}`);
      } else {
        throw error;
      }
    }
  }
  const ordinaryTasks = [
    ...tasks.map((task) => {
      const serialized = serializeTask(task, { includeResult: false });
      const delivery = resolveTaskDelivery(task, durable);
      return delivery == null ? serialized : { ...serialized, delivery };
    }),
    ...(durable?.pending ?? []).map(serializePendingCompletion),
    ...(durable?.dead ?? []).map(serializeDeadCompletion),
  ];
  /** Pending only with durable evidence: whether a subagent's wake-up exists depends on
   * the policy when it was admitted, not on this request's configuration. */
  const finishedSubagents = subagentTasks.filter(
    (task) => task.status !== 'running' && task.result_claimed !== true,
  );
  if (finishedSubagents.length > 0 && params.pendingCompletions != null) {
    try {
      const wakeups = await params.pendingCompletions.listSubagentWakeups({
        userId,
        conversationId,
      });
      const waiting = new Set(wakeups.taskIds);
      subagentTasks = subagentTasks.map((task) =>
        task.status !== 'running' &&
        task.result_claimed !== true &&
        waiting.has(task.background_task_id)
          ? { ...task, delivery: 'pending' as const }
          : task,
      );
    } catch (error) {
      logger.warn('[background] Failed to list undelivered subagent completions:', error);
      listWarnings.push(
        'Undelivered subagent results could not be checked; some may still arrive as new turns.',
      );
    }
  }
  /** Work is outstanding until its result reaches the conversation: a finished
   * task with a pending delivery is still going to resume the agent. */
  const isOutstanding = (task: { status: string; delivery?: string }): boolean =>
    task.status === 'running' || task.delivery === 'pending' || task.delivery === 'failed';
  const outstanding =
    ordinaryTasks.filter(isOutstanding).length + subagentTasks.filter(isOutstanding).length;
  const isFinishedPending = (task: { status: string; delivery?: string }): boolean =>
    task.status !== 'running' && task.delivery === 'pending';
  const guidance = [
    ...(ordinaryTasks.some(isFinishedPending) ? [PENDING_DELIVERY_GUIDANCE] : []),
    ...(ordinaryTasks.some((task) => task.delivery === 'failed') ? [FAILED_DELIVERY_GUIDANCE] : []),
    ...(subagentTasks.some(isFinishedPending) ? [SUBAGENT_PENDING_DELIVERY_GUIDANCE] : []),
    ...(completionWakeups && subagentTasks.some((task) => task.status === 'running')
      ? [SUBAGENT_WAKEUP_GUIDANCE]
      : []),
  ];
  logger.debug(
    `[background] check_background_task listed ${ordinaryTasks.length + subagentTasks.length} task(s), ${outstanding} outstanding`,
  );
  return JSON.stringify({
    tasks: [...ordinaryTasks, ...subagentTasks],
    outstanding,
    ...(guidance.length > 0 && { message: guidance.join(' ') }),
    ...(listWarnings.length > 0 && { partial: true, warning: listWarnings.join(' ') }),
  });
}

/** Returns a read-only snapshot of the specifically requested task, if any. */
export function getBackgroundTaskSnapshot(params: {
  userId: string;
  conversationId: string;
  args: unknown;
}): Readonly<BackgroundTask> | undefined {
  const rawId = coerceArgsObject(params.args)?.background_task_id;
  const taskId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : undefined;
  if (!taskId) {
    return undefined;
  }
  const task = backgroundTaskRegistry.get(params.userId, params.conversationId, taskId);
  if (!task) {
    return undefined;
  }
  return {
    ...task,
    ...(task.attachments != null ? { attachments: [...task.attachments] } : {}),
  };
}

/**
 * When a `check_background_task` call targets a specific completed task that
 * produced an artifact, returns that artifact once (marking it delivered) so the
 * poll turn's live callback can persist it. Returns undefined for the list form,
 * an unknown id, or an already-delivered/artifact-less task.
 */
export function claimBackgroundArtifact(params: {
  userId: string;
  conversationId: string;
  args: unknown;
  /** Evaluated before claiming; a `false` return leaves the artifact held. */
  shouldClaim?: (task: BackgroundTask) => boolean;
}):
  | {
      taskId: string;
      toolName: string;
      toolCallId: string;
      stepId?: string;
      messageId?: string;
      harvestStarted?: boolean;
      artifact: unknown;
      content?: string;
    }
  | undefined {
  const rawId = coerceArgsObject(params.args)?.background_task_id;
  const taskId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : undefined;
  if (!taskId) {
    return undefined;
  }
  if (params.shouldClaim) {
    const task = backgroundTaskRegistry.get(params.userId, params.conversationId, taskId);
    if (!task || !params.shouldClaim(task)) {
      return undefined;
    }
  }
  const claimed = backgroundTaskRegistry.claimArtifact(
    params.userId,
    params.conversationId,
    taskId,
  );
  return claimed ? { taskId, ...claimed } : undefined;
}

/**
 * Read-only view of a settled code task's harvest state for the poll turn:
 * attachments to re-emit on the live stream and the identity needed to
 * re-anchor the row patch (a HITL-pause/resume full-row save can revert it;
 * re-application is idempotent). Independent of the one-shot artifact claim so
 * late-landing harvests still deliver on subsequent polls.
 */
export function getBackgroundCodeDelivery(params: {
  userId: string;
  conversationId: string;
  args: unknown;
}):
  | {
      taskId: string;
      status: BackgroundTaskStatus;
      toolName: string;
      toolCallId: string;
      stepId?: string;
      messageId?: string;
      agentId?: string;
      harvestStarted?: boolean;
      result?: string;
      error?: string;
      attachments?: unknown[];
      backgroundTask?: BackgroundToolResultState;
    }
  | undefined {
  const rawId = coerceArgsObject(params.args)?.background_task_id;
  const taskId = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : undefined;
  if (!taskId) {
    return undefined;
  }
  const task = backgroundTaskRegistry.get(params.userId, params.conversationId, taskId);
  if (
    !task ||
    task.harvestStarted !== true ||
    (task.status === 'completed' && task.harvestPending === true)
  ) {
    return undefined;
  }
  return {
    taskId,
    status: task.status,
    toolName: task.toolName,
    toolCallId: task.toolCallId,
    stepId: task.stepId,
    messageId: task.messageId,
    agentId: task.agentId,
    harvestStarted: task.harvestStarted,
    result: task.result,
    error: task.error,
    attachments: task.attachments,
    ...(task.status === 'running'
      ? {}
      : {
          backgroundTask: {
            taskId: task.id,
            toolName: task.toolName,
            status: task.status === 'cancelled' ? 'error' : task.status,
            ...(task.status === 'cancelled' ? { cancelled: true } : {}),
            settledAt: new Date(task.updatedAt),
            ...(task.completionWakeup === true ? { completionWakeup: true } : {}),
            ...(task.resultClaim == null
              ? {}
              : {
                  resultClaim: {
                    kind: task.resultClaim.kind,
                    claimId: task.resultClaim.claimId,
                    claimedAt: new Date(task.resultClaim.claimedAt),
                    ...(task.resultClaim.generationId == null
                      ? {}
                      : { generationId: task.resultClaim.generationId }),
                  },
                }),
          },
        }),
  };
}

/** Reverses a `claimBackgroundArtifact` after a failed delivery (see `restoreArtifact`). */
export function restoreBackgroundArtifact(params: {
  userId: string;
  conversationId: string;
  taskId: string;
  artifact: unknown;
}): void {
  backgroundTaskRegistry.restoreArtifact(
    params.userId,
    params.conversationId,
    params.taskId,
    params.artifact,
  );
}
