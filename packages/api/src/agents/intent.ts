/**
 * @fileoverview Tool intent labels.
 *
 * Injects an optional `intent` string as the FIRST property of a tool's
 * schema so the model can declare, per call, one sentence stating what that
 * specific call is about to do ("Searching for OAuth handling in the
 * callback router"). Because the property is first, it is the first key
 * providers stream in the tool-call args, and the client renders it as the
 * call's live status label — the args already reach the client verbatim, so
 * no new event plumbing is involved. The label is inert server-side: the
 * only interception is stripping the arg before invoking a tool that did
 * not declare it.
 *
 * Opt-in mirrors `run_in_background`: an admin capability
 * (`AgentCapabilities.tool_intents`) gates the feature, and a per-tool
 * `tool_options[name].describe_intent` flag turns it on for a given tool.
 * Native host tools (web search, file authoring, memory, ask-user-question)
 * default ON while the capability is enabled — an explicit
 * `describe_intent: false` opts one out. SDK-native tools (the coding
 * suite, subagent, skill, tool_search) declare `intent` in their own
 * schemas and need no host injection.
 *
 * @module packages/api/src/agents/intent
 */

import { logger } from '@librechat/data-schemas';
import { Tools, Constants } from 'librechat-data-provider';
import {
  Constants as AgentConstants,
  INTENT_LABEL_MARKER,
  INTENT_DESCRIPTION,
} from '@librechat/agents';
import type { LCTool, LCToolRegistry, JsonSchemaType } from '@librechat/agents';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { CapabilityToolNames } from './selection';
import {
  resolveToolOption,
  getSelectionNames,
  warnUnmatchedSelectionNames,
  synthesizeSelectionToolOptions,
} from './selection';
import { SET_MEMORY_TOOL_NAME, DELETE_MEMORY_TOOL_NAME } from './memory';
import { ASK_USER_QUESTION_TOOL_NAME } from './hitl/askUserQuestionTool';
import { CREATE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME } from './tools';

/** Argument carrying the model-authored label for a tool call. */
export const INTENT_ARG = 'intent';

/** Log prefix for selection diagnostics, phrased in the spec's own field name. */
const INTENT_SELECTION_LABEL = '[intent] describeIntent';

/**
 * Host-native tools that default INTO intent labels while the capability is
 * enabled (an explicit `describe_intent: false` opts one out). These are the
 * least legible calls in the UI today, and the convention only becomes a
 * convention if our own tools model it.
 */
export const NATIVE_INTENT_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  Tools.web_search,
  CREATE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  SET_MEMORY_TOOL_NAME,
  DELETE_MEMORY_TOOL_NAME,
]);

/**
 * Tools that never get the injected param: the background poll tool is host
 * machinery, and handoff tools run through the direct path where no card
 * renders a label.
 *
 * `ask_user_question` is excluded because injection into its definition can
 * never reach the model: `createRun` strips the definition and rebuilds the
 * graph tool from its own Zod schema (also the HITL card's wire shape).
 * Excluding it makes an explicit selection warn as ineligible instead of
 * crediting a label that will be discarded. Its intent support lands with
 * the HITL slice, which threads the label into the interrupt payload on
 * purpose. Intent labels are otherwise inert, so — unlike background's
 * correctness-driven list — nothing else is excluded.
 */
const EXCLUDED_INTENT_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  String(Constants.CHECK_BACKGROUND_TASK),
  ASK_USER_QUESTION_TOOL_NAME,
]);

/** Whether a tool may carry an intent label. */
export function isIntentEligibleToolName(name: string): boolean {
  if (EXCLUDED_INTENT_TOOL_NAMES.has(name)) {
    return false;
  }
  return !name.startsWith(AgentConstants.LC_TRANSFER_TO_);
}

/**
 * Coerces tool-call args to an object, parsing a stringified JSON object
 * (some providers deliver args as a string). Returns undefined for
 * non-object args.
 */
function coerceArgsObject(args: unknown): Record<string, unknown> | undefined {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string' && args.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Whether tool-call args carry the `intent` key at all (any value). */
export function hasIntentArg(args: unknown): boolean {
  const obj = coerceArgsObject(args);
  return obj != null && INTENT_ARG in obj;
}

/** Reads the model-authored intent from tool-call args (handles stringified args). */
export function readIntentArg(args: unknown): string | undefined {
  const value = coerceArgsObject(args)?.[INTENT_ARG];
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Returns the args without the injected `intent` key so a tool that did not
 * declare the parameter never receives it. Parses stringified JSON object
 * args; returns the value unchanged when the key is absent.
 */
export function stripIntentArg(args: unknown): unknown {
  const obj = coerceArgsObject(args);
  if (!obj || !(INTENT_ARG in obj)) {
    return args;
  }
  const { [INTENT_ARG]: _omit, ...rest } = obj;
  return rest;
}

/**
 * Canonical (frozen) shape of the injected property. Injection embeds a
 * copy so downstream schema tooling that mutates subschemas (JSON-schema
 * dereferencers stamp URI markers) never trips on a frozen shared instance.
 *
 * The description is the SDK's, not a local copy: host-injected tools and
 * SDK-native tools must present the model with one identical instruction, and
 * a divergent copy would also miss the SDK's token trimming.
 */
const INTENT_PROPERTY: JsonSchemaType = Object.freeze<JsonSchemaType>({
  type: 'string',
  description: INTENT_DESCRIPTION,
});

/**
 * Returns a copy of the tool definition with `intent` PREPENDED as the first
 * property of its parameters — first key in the schema means first key in
 * the streamed input, which is what lets the label render before the rest of
 * the args exist. Never mutates the input (built-in defs are frozen and MCP
 * defs may be shared); no-op if the property already exists. Never added to
 * `required`.
 */
export function injectIntentParam(def: LCTool): LCTool {
  const params = def.parameters;
  const existingProps = params?.properties ?? {};
  if (INTENT_ARG in existingProps) {
    return def;
  }
  const nextParams: JsonSchemaType = {
    ...params,
    type: 'object',
    properties: { [INTENT_ARG]: { ...INTENT_PROPERTY }, ...existingProps },
  };
  return { ...def, parameters: nextParams };
}

/**
 * Whether the `intent` param can be cleanly injected into a tool. False for
 * non-object (e.g. string-input/DynamicTool) schemas — rewriting them to an
 * object would break the tool's input contract — and for definitions whose
 * `allowed_callers` never includes `direct` (no card ever renders for a
 * PTC-only tool, so the label would be pure token cost).
 */
function canInjectIntentParam(def: LCTool): boolean {
  const callers = def.allowed_callers;
  if (callers != null && !callers.includes('direct')) {
    return false;
  }
  const params = def.parameters;
  if (params == null) {
    return true;
  }
  return params.type == null || params.type === 'object';
}

/**
 * Discriminates the intent LABEL property (host-injected here, or SDK-native
 * from `@librechat/agents`) from a tool's own business parameter that merely
 * shares the name. Both contracts open with this exact instruction, while an
 * MCP/action tool's real `intent` argument will not — removal paths must
 * never strip a parameter the tool actually needs.
 *
 * Imported rather than redeclared: a local copy that drifts from the SDK's
 * would make every removal path here stop recognizing SDK-native labels, and
 * it would fail OPEN — labels left in schemas, opt-outs silently inert, no
 * error anywhere.
 */
function isIntentLabelProperty(property: JsonSchemaType | undefined): boolean {
  return (
    property != null &&
    property.type === 'string' &&
    typeof property.description === 'string' &&
    property.description.startsWith(INTENT_LABEL_MARKER)
  );
}

/** Returns a copy of the def without the intent LABEL property (marker-guarded). */
function removeIntentParam(def: LCTool): LCTool {
  const params = def.parameters;
  if (params?.properties == null || !isIntentLabelProperty(params.properties[INTENT_ARG])) {
    return def;
  }
  const { [INTENT_ARG]: _omit, ...restProps } = params.properties;
  return { ...def, parameters: { ...params, properties: restProps } };
}

/**
 * Removes the host-injected `intent` param from a tool-definition list. Used
 * to sanitize a self-spawn subagent's inherited inputs so the isolated child
 * path doesn't advertise a schema the parent injected. Only the named
 * (host-injected) tools are touched — SDK-native intent schemas are the
 * tool's own and stay.
 */
export function stripIntentFromToolDefinitions(
  toolDefinitions: LCTool[] | undefined,
  intentToolNames: string[] | undefined,
): LCTool[] {
  const defs = toolDefinitions ?? [];
  const intentSet = new Set(intentToolNames ?? []);
  if (intentSet.size === 0) {
    return defs;
  }
  let changed = false;
  const next = defs.map((def) => {
    if (!intentSet.has(def.name)) {
      return def;
    }
    const stripped = removeIntentParam(def);
    if (stripped !== def) {
      changed = true;
    }
    return stripped;
  });
  return changed ? next : defs;
}

/**
 * Marker-guarded removal of intent LABELS from every definition —
 * host-injected AND SDK-native alike. Used for the schemas the PTC sandbox
 * bridge advertises: no card renders for an inner call, so any label there
 * is pure token cost for the generating model. Business `intent` params
 * survive (marker guard).
 */
export function stripIntentLabelsFromToolDefinitions(
  toolDefinitions: LCTool[] | undefined,
): LCTool[] {
  const defs = toolDefinitions ?? [];
  let changed = false;
  const next = defs.map((def) => {
    const stripped = removeIntentParam(def);
    if (stripped !== def) {
      changed = true;
    }
    return stripped;
  });
  return changed ? next : defs;
}

/**
 * Registry counterpart of {@link stripIntentFromToolDefinitions}. Returns a
 * NEW registry (never mutates the shared parent one) with the injected param
 * removed, so a self-spawn child that uses tool_search/deferred loading
 * can't rediscover a host-injected schema it can't honor.
 */
export function stripIntentFromToolRegistry(
  toolRegistry: LCToolRegistry | undefined,
  intentToolNames: string[] | undefined,
): LCToolRegistry | undefined {
  if (!toolRegistry) {
    return toolRegistry;
  }
  const intentSet = new Set(intentToolNames ?? []);
  if (intentSet.size === 0) {
    return toolRegistry;
  }
  const next: LCToolRegistry = new Map();
  for (const [name, def] of toolRegistry) {
    next.set(name, intentSet.has(name) ? removeIntentParam(def) : def);
  }
  return next;
}

/**
 * Injects the `intent` param into every opted-in, eligible tool definition,
 * mirroring the injection into the registry entry so a deferred tool
 * discovered later (tool_search reads the registry) arrives with the same
 * schema. Definitions that already declare `intent` (SDK-native tools) are
 * left alone and NOT counted as host-injected — their schema is their own —
 * unless the tool is opted OUT, in which case the property is removed so the
 * opt-out actually disables the arg's token cost (the SDK tool bodies
 * tolerate its absence).
 *
 * Opt-in resolves per FINAL definition via {@link resolveToolOption}
 * (explicit name → capability marker projection → wildcard), with native
 * host tools defaulting on when no policy speaks. Both saved agents and
 * ephemeral/model-spec agents reach this with `tool_options` populated, so
 * the logic is written once. When a narrowing selection is present, names
 * that never took effect on any definition are warned about here — the one
 * place the final definition set is known.
 */
export function applyIntentLabels(params: {
  toolDefinitions: LCTool[] | undefined;
  toolRegistry: LCToolRegistry | undefined;
  toolOptions: AgentToolOptions | undefined;
  /** Capability marker → registered definition names, from `initializeAgent`. */
  capabilityToolNames?: CapabilityToolNames;
  /** Extra host-context exclusion, mirroring `applyBackgroundToolCalls`. */
  excludeTool?: (toolName: string) => boolean;
}): { toolDefinitions: LCTool[]; intentToolNames: string[] } {
  const { toolRegistry, toolOptions, capabilityToolNames, excludeTool } = params;
  const defs = params.toolDefinitions ?? [];
  const selectionNames = getSelectionNames(toolOptions, 'describe_intent');
  const effectiveSources = new Set<string>();

  let changed = false;
  const intentToolNames: string[] = [];
  const mirrorRegistryEntry = (def: LCTool): void => {
    const registryEntry = toolRegistry?.get(def.name);
    if (registryEntry) {
      toolRegistry?.set(def.name, { ...registryEntry, parameters: def.parameters });
    }
  };
  const nextDefs = defs.map((def) => {
    const resolved = resolveToolOption(
      def.name,
      'describe_intent',
      toolOptions,
      capabilityToolNames,
    );
    if (resolved?.value === false) {
      const stripped = removeIntentParam(def);
      if (stripped !== def) {
        changed = true;
        mirrorRegistryEntry(stripped);
      }
      return stripped;
    }
    if (resolved == null && !NATIVE_INTENT_TOOL_NAMES.has(def.name)) {
      return def;
    }
    if (!isIntentEligibleToolName(def.name) || excludeTool?.(def.name) === true) {
      return def;
    }
    if (!canInjectIntentParam(def)) {
      if (def.allowed_callers == null || def.allowed_callers.includes('direct')) {
        logger.warn(
          `[intent] Skipping describe_intent for "${def.name}": non-object schema cannot carry the injected parameter.`,
        );
      }
      return def;
    }
    const injected = injectIntentParam(def);
    /** The selection took effect whether the label was injected here or the
     *  definition already carries its own (SDK-native) one. */
    if (resolved != null) {
      effectiveSources.add(resolved.source);
    }
    if (injected === def) {
      return def;
    }
    changed = true;
    intentToolNames.push(def.name);
    mirrorRegistryEntry(injected);
    return injected;
  });

  warnUnmatchedSelectionNames(selectionNames, effectiveSources, INTENT_SELECTION_LABEL);

  if (!changed) {
    return { toolDefinitions: defs, intentToolNames };
  }
  return { toolDefinitions: nextDefs, intentToolNames };
}

/**
 * Post-registration sanitize pass, run AFTER every tool registration step —
 * including the skill catalog, which appends its definition after the
 * injection pass. Removes intent LABEL properties that must not be
 * advertised: every one when the capability is disabled (the admin kill
 * switch over SDK-native schemas, which otherwise pay the token cost with
 * the feature off), or the explicitly opted-out ones when it is enabled.
 * Marker-guarded, so a tool's own `intent` business parameter survives.
 */
export function sanitizeIntentLabels(params: {
  toolDefinitions: LCTool[] | undefined;
  toolRegistry: LCToolRegistry | undefined;
  toolOptions: AgentToolOptions | undefined;
  capabilityEnabled: boolean;
  /** Capability marker → registered definition names, from `initializeAgent`. */
  capabilityToolNames?: CapabilityToolNames;
}): {
  toolDefinitions: LCTool[];
  semanticIntentToolNames: string[];
  semanticIntentBlockedToolNames: string[];
} {
  const { toolRegistry, toolOptions, capabilityEnabled, capabilityToolNames } = params;
  const defs = params.toolDefinitions ?? [];
  const shouldStrip = (name: string): boolean =>
    capabilityEnabled
      ? resolveToolOption(name, 'describe_intent', toolOptions, capabilityToolNames)?.value ===
        false
      : true;

  let changed = false;
  const semanticIntentToolNames = new Set<string>();
  const semanticIntentBlockedToolNames = new Set<string>();
  const projectSemanticTrust = (def: LCTool): void => {
    if (isIntentLabelProperty(def.parameters?.properties?.[INTENT_ARG])) {
      semanticIntentToolNames.add(def.name);
      return;
    }
    semanticIntentBlockedToolNames.add(def.name);
  };
  const nextDefs = defs.map((def) => {
    if (!shouldStrip(def.name)) {
      projectSemanticTrust(def);
      return def;
    }
    const stripped = removeIntentParam(def);
    projectSemanticTrust(stripped);
    if (stripped !== def) {
      changed = true;
      const registryEntry = toolRegistry?.get(def.name);
      if (registryEntry) {
        toolRegistry?.set(def.name, { ...registryEntry, parameters: stripped.parameters });
      }
    }
    return stripped;
  });
  if (toolRegistry) {
    for (const [name, entry] of toolRegistry) {
      if (!shouldStrip(name)) {
        projectSemanticTrust(entry);
        continue;
      }
      const stripped = removeIntentParam(entry);
      projectSemanticTrust(stripped);
      if (stripped !== entry) {
        toolRegistry.set(name, stripped);
      }
    }
  }
  return {
    toolDefinitions: changed ? nextDefs : defs,
    semanticIntentToolNames: Array.from(semanticIntentToolNames),
    semanticIntentBlockedToolNames: Array.from(semanticIntentBlockedToolNames),
  };
}

/**
 * Records the intent selection for ephemeral and model-spec agents, which
 * carry no per-tool options of their own. Returns undefined when disabled.
 *
 * A model spec's `describeIntent` selects the scope: `true` opts in every
 * eligible tool, while a string array opts in ONLY the named ones — a list
 * is a SELECTION POLICY, not an additive filter, so everything unselected is
 * opted out (natives and SDK-native labels alike), and an empty list is an
 * explicit "none". Selecting per tool matters because the label costs schema
 * tokens on every request, so an admin may want it on a handful of illegible
 * calls rather than the whole toolset. The ephemeral toggle stays boolean
 * and never narrows; it has no per-tool UI to drive a selection.
 *
 * The selection is recorded as policy (wildcard default + verbatim names)
 * and resolved against the FINAL definition set in `applyIntentLabels` /
 * `sanitizeIntentLabels`, so capability markers (`execute_code`, `memory`),
 * spec fields that never reach `tools` (`skills`), and lazily-expanded MCP
 * servers are all governed — and misspelled or unsupported names are
 * diagnosed where the real definitions are known.
 */
export function synthesizeIntentToolOptions(sources: {
  ephemeralAgent?: { describe_intent?: boolean } | null;
  modelSpec?: { describeIntent?: boolean | string[] } | null;
}): AgentToolOptions | undefined {
  return synthesizeSelectionToolOptions(
    'describe_intent',
    sources.modelSpec?.describeIntent,
    sources.ephemeralAgent?.describe_intent === true,
    INTENT_SELECTION_LABEL,
  );
}
