/**
 * @fileoverview Who may call each tool: the model directly, code that the
 * programmatic tool runs (`code_execution`), or both.
 *
 * `allowed_callers` is a selection field like `defer_loading` or
 * `describe_intent`: an explicit `tool_options` entry, a capability marker
 * that registered the tool, or a model spec's wildcard decides it, through
 * {@link resolveToolCallers}. Unlike those fields it can widen what a tool is
 * exposed to, and calls made from code skip the approval hook. So a tool takes
 * part only when its registrar allows it:
 *
 * - {@link allowCodeExecutionCallers} lets the policy decide the tool's callers.
 *   MCP tools are the registrations that allow it.
 * - {@link declareDirectOnly} pins the tool to direct calls. It wins over the
 *   allowance and over every config value, so a tool whose calls must reach
 *   the approval hook stays where the hook runs.
 * - A tool with neither declaration keeps the callers its registrar set.
 *
 * The declarations are symbol-keyed, so object spreads keep them and provider
 * payloads cannot carry them.
 *
 * @module packages/api/src/agents/callers
 */

import { logger } from '@librechat/data-schemas';
import type { AgentToolOptions, AllowedCaller } from 'librechat-data-provider';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { CapabilityToolNames } from './selection';
import {
  getSelectionNames,
  resolveToolCallers,
  TOOL_SELECTION_WILDCARD,
  warnUnmatchedSelectionNames,
} from './selection';

const CALLERS_SELECTION_LABEL = '[callers] Model spec programmaticTools';

const selectableKey: unique symbol = Symbol.for('librechat.toolCallersSelectable');
const directOnlyKey: unique symbol = Symbol.for('librechat.toolDirectOnly');

type CallerDeclarations = {
  [selectableKey]?: true;
  [directOnlyKey]?: true;
};

const DIRECT_CALLERS: AllowedCaller[] = ['direct'];
const PROGRAMMATIC_CALLERS: AllowedCaller[] = ['direct', 'code_execution'];

/** Lets the shared policy decide this tool's callers. */
export function allowCodeExecutionCallers<T extends object>(tool: T): T {
  (tool as CallerDeclarations)[selectableKey] = true;
  return tool;
}

/** Pins this tool to direct calls, whatever the policy or the allowance says. */
export function declareDirectOnly<T extends object>(tool: T): T {
  (tool as CallerDeclarations)[directOnlyKey] = true;
  return tool;
}

export function isDirectOnlyTool(tool: object | undefined): boolean {
  return tool != null && (tool as CallerDeclarations)[directOnlyKey] === true;
}

function allowsCallerSelection(tool: object | undefined): boolean {
  return tool != null && (tool as CallerDeclarations)[selectableKey] === true;
}

export interface AllowedCallersResolution {
  callers: AllowedCaller[];
  /** The `tool_options` key that decided; absent when a direct-only pin did. */
  source?: string;
}

/**
 * Resolves a tool's callers from its declarations and the policy. `tools` are
 * the objects that describe the tool, usually its definition and its registry
 * entry; a declaration on any of them counts. Returns undefined when the
 * registrar's own value stands: the tool does not allow selection, or no
 * policy speaks for it.
 */
export function resolveAllowedCallers(
  name: string,
  tools: object | ReadonlyArray<object | undefined>,
  toolOptions: AgentToolOptions | undefined,
  capabilityToolNames?: CapabilityToolNames,
): AllowedCallersResolution | undefined {
  const declared: ReadonlyArray<object | undefined> = Array.isArray(tools) ? tools : [tools];
  if (declared.some(isDirectOnlyTool)) {
    return { callers: DIRECT_CALLERS };
  }
  if (!declared.some(allowsCallerSelection)) {
    return undefined;
  }
  const resolved = resolveToolCallers(name, toolOptions, capabilityToolNames);
  return resolved ? { callers: resolved.value, source: resolved.source } : undefined;
}

/**
 * Records a model spec's `programmaticTools` as selection policy. `true` lets
 * code call every tool that allows it, a list only the named tools or
 * capability markers, and `false` is the same as omitting it. Selected tools
 * stay directly callable.
 */
export function synthesizeCallerToolOptions(sources: {
  modelSpec?: { programmaticTools?: boolean | string[] } | null;
}): AgentToolOptions | undefined {
  const selection = sources.modelSpec?.programmaticTools;
  if (selection == null || selection === false) {
    return undefined;
  }
  if (selection === true) {
    return { [TOOL_SELECTION_WILDCARD]: { allowed_callers: PROGRAMMATIC_CALLERS } };
  }
  const toolOptions: AgentToolOptions = {
    [TOOL_SELECTION_WILDCARD]: { allowed_callers: DIRECT_CALLERS },
  };
  for (const name of selection) {
    if (name === TOOL_SELECTION_WILDCARD) {
      logger.warn(
        `${CALLERS_SELECTION_LABEL} contains the reserved wildcard "${TOOL_SELECTION_WILDCARD}"; ignoring it. Set the option to true to cover every eligible tool.`,
      );
      continue;
    }
    toolOptions[name] = { allowed_callers: PROGRAMMATIC_CALLERS };
  }
  return toolOptions;
}

function hasCallerPolicy(toolOptions: AgentToolOptions | undefined): boolean {
  if (!toolOptions) {
    return false;
  }
  for (const options of Object.values(toolOptions)) {
    if (options?.allowed_callers != null && options.allowed_callers.length > 0) {
      return true;
    }
  }
  return false;
}

function sameCallers(current: AllowedCaller[] | undefined, next: AllowedCaller[]): boolean {
  const effective = current ?? DIRECT_CALLERS;
  return effective.length === next.length && effective.every((caller) => next.includes(caller));
}

/**
 * Resolves `allowed_callers` for every final definition in one pass, after
 * capability markers have expanded, so a marker or wildcard entry reaches the
 * tools its registration produced. The definition and its registry entry get
 * the same value; when they are one object they stay one object. Definitions
 * are copied rather than mutated, since some registrars share module-level
 * objects.
 */
export function applyToolCallers(params: {
  toolDefinitions: LCTool[] | undefined;
  toolRegistry: LCToolRegistry | undefined;
  toolOptions: AgentToolOptions | undefined;
  capabilityToolNames?: CapabilityToolNames;
}): { toolDefinitions: LCTool[] | undefined } {
  const { toolDefinitions, toolRegistry, toolOptions, capabilityToolNames } = params;
  if (!toolDefinitions || toolDefinitions.length === 0 || !hasCallerPolicy(toolOptions)) {
    return { toolDefinitions };
  }

  const selectionNames = getSelectionNames(toolOptions, 'allowed_callers');
  const effectiveSources = new Set<string>();
  let changed = false;

  const nextDefs = toolDefinitions.map((def) => {
    const entry = toolRegistry?.get(def.name);
    const resolved = resolveAllowedCallers(
      def.name,
      [def, entry],
      toolOptions,
      capabilityToolNames,
    );
    if (resolved == null) {
      return def;
    }
    if (resolved.source != null && resolved.callers.includes('code_execution')) {
      effectiveSources.add(resolved.source);
    }
    const { callers } = resolved;
    if (sameCallers(def.allowed_callers, callers) && sameCallers(entry?.allowed_callers, callers)) {
      return def;
    }
    const next: LCTool = { ...def, allowed_callers: callers };
    if (entry === def) {
      toolRegistry?.set(def.name, next);
    } else if (entry != null) {
      toolRegistry?.set(def.name, { ...entry, allowed_callers: callers });
    }
    changed = true;
    return next;
  });

  warnUnmatchedSelectionNames(selectionNames, effectiveSources, CALLERS_SELECTION_LABEL);
  return { toolDefinitions: changed ? nextDefs : toolDefinitions };
}
