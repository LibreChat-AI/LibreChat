/**
 * @fileoverview Deferred loading for every tool an agent is equipped with.
 *
 * MCP tools get `defer_loading` while their registry is built, but system tools
 * (web search, file search, the code-execution family, memory) are registered
 * later in `initializeAgent` and were always bound, so their schemas were paid
 * for on every turn. This pass runs once over the FINAL definition set and marks
 * whichever tools the agent's `tool_options` select, resolving capability
 * markers (`execute_code`, `memory`) and a model spec's wildcard through the
 * same policy as background and intent selections.
 *
 * A deferred definition and its registry entry must be the SAME object: the run
 * host restores a discovered tool by flipping `defer_loading` on the registry
 * entry, and the SDK binds by the definition's own flag. MCP tools already share
 * one object; system tools are given one here.
 *
 * @module packages/api/src/agents/deferral
 */

import { Constants, AgentCapabilities } from 'librechat-data-provider';
import {
  SkillToolDefinition,
  ToolSearchToolDefinition,
  BashProgrammaticToolCallingDefinition,
} from '@librechat/agents';
import type { LCTool, LCToolRegistry, Providers } from '@librechat/agents';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { CapabilityToolNames } from './selection';
import {
  resolveToolOption,
  getSelectionNames,
  warnUnmatchedSelectionNames,
  synthesizeSelectionToolOptions,
} from './selection';
import { createToolSearchDefinition } from '~/tools/classification';

const DEFERRAL_SELECTION_LABEL = '[deferral] Model spec deferLoading';

/**
 * Tools that must stay bound. `tool_search` is how deferred tools are found;
 * the programmatic bash tool and the background poll tool orchestrate other
 * calls; the skill catalog in the instructions tells the model to call `skill`
 * directly; `ask_user_question` runs as an in-graph instance, never as a
 * definition.
 */
const NON_DEFERRABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolSearchToolDefinition.name,
  BashProgrammaticToolCallingDefinition.name,
  `${Constants.CHECK_BACKGROUND_TASK}`,
  SkillToolDefinition.name,
  /** The tool shares the capability's name; importing the tool module here would cycle. */
  AgentCapabilities.ask_user_question,
]);

/** Whether a tool may be deferred at all. */
export function isDeferrableToolName(name: string): boolean {
  return !NON_DEFERRABLE_TOOL_NAMES.has(name);
}

/**
 * Records a model spec's `deferLoading` as selection policy for ephemeral and
 * model-spec agents, which carry no per-tool options of their own. `true`
 * defers every eligible tool, a list defers only the named ones, and `false`
 * is the same as omitting it.
 */
export function synthesizeDeferralToolOptions(sources: {
  modelSpec?: { deferLoading?: boolean | string[] } | null;
}): AgentToolOptions | undefined {
  const selection = sources.modelSpec?.deferLoading;
  if (selection == null || selection === false) {
    return undefined;
  }
  return synthesizeSelectionToolOptions(
    'defer_loading',
    selection,
    false,
    DEFERRAL_SELECTION_LABEL,
  );
}

/** Cheap pre-check so agents with no deferral policy skip the pass entirely. */
function hasDeferralPolicy(toolOptions: AgentToolOptions | undefined): boolean {
  if (!toolOptions) {
    return false;
  }
  for (const options of Object.values(toolOptions)) {
    if (options?.defer_loading === true) {
      return true;
    }
  }
  return false;
}

export interface DeferredToolLoadingResult {
  toolDefinitions: LCTool[];
  /** The registry the definitions resolve against; created when the agent had none. */
  toolRegistry: LCToolRegistry | undefined;
  /** True when any definition, MCP or system, is deferred after the pass. */
  hasDeferredTools: boolean;
}

/**
 * Marks the agent's selected tools `defer_loading` in one pass over the final
 * definitions and registers `tool_search` when something is deferred and it is
 * not already present. Definitions are copied rather than mutated, since some
 * registrars hand out shared module-level objects.
 *
 * Every deferred tool leaves the pass as one object shared by its definition
 * and registry entry, including MCP tools deferred upstream whose schema a
 * background or intent pass later replaced with separate copies. An agent whose
 * loader returned no registry (no configured tools, only late skill
 * registrations) gets one built from its definitions, since `tool_search`
 * searches the registry.
 */
export function applyDeferredToolLoading(params: {
  toolDefinitions: LCTool[] | undefined;
  toolRegistry: LCToolRegistry | undefined;
  toolOptions: AgentToolOptions | undefined;
  capabilityToolNames?: CapabilityToolNames;
  provider?: Providers | string;
  /** Deferral already decided upstream (MCP classification). */
  hasDeferredTools?: boolean;
}): DeferredToolLoadingResult {
  const { toolOptions, capabilityToolNames, provider } = params;
  const defs = params.toolDefinitions ?? [];
  const upstreamDeferred = params.hasDeferredTools === true;
  const unchanged: DeferredToolLoadingResult = {
    toolDefinitions: defs,
    toolRegistry: params.toolRegistry,
    hasDeferredTools: upstreamDeferred,
  };
  if (defs.length === 0 || !hasDeferralPolicy(toolOptions)) {
    return unchanged;
  }
  const toolRegistry: LCToolRegistry =
    params.toolRegistry ?? new Map(defs.map((def) => [def.name, def]));

  const selectionNames = getSelectionNames(toolOptions, 'defer_loading');
  const effectiveSources = new Set<string>();
  let deferredCount = 0;
  let hasToolSearch = false;
  let changed = false;

  const nextDefs = defs.map((def) => {
    if (def.name === ToolSearchToolDefinition.name) {
      hasToolSearch = true;
      return def;
    }
    if (!isDeferrableToolName(def.name)) {
      return def;
    }
    const resolved = resolveToolOption(def.name, 'defer_loading', toolOptions, capabilityToolNames);
    if (def.defer_loading === true) {
      deferredCount++;
      if (resolved?.value === true) {
        effectiveSources.add(resolved.source);
      }
      const entry = toolRegistry.get(def.name);
      if (entry === def) {
        return def;
      }
      const rejoined: LCTool = { ...entry, ...def, defer_loading: true };
      toolRegistry.set(def.name, rejoined);
      changed = true;
      return rejoined;
    }
    if (resolved?.value !== true) {
      return def;
    }
    effectiveSources.add(resolved.source);
    const deferred: LCTool = { ...toolRegistry.get(def.name), ...def, defer_loading: true };
    toolRegistry.set(def.name, deferred);
    deferredCount++;
    changed = true;
    return deferred;
  });

  warnUnmatchedSelectionNames(selectionNames, effectiveSources, DEFERRAL_SELECTION_LABEL);

  if (deferredCount === 0) {
    return unchanged;
  }
  if (!hasToolSearch) {
    nextDefs.push(createToolSearchDefinition(provider));
    toolRegistry.set(ToolSearchToolDefinition.name, {
      name: ToolSearchToolDefinition.name,
      allowed_callers: ['direct'],
    });
    changed = true;
  }
  return { toolDefinitions: changed ? nextDefs : defs, toolRegistry, hasDeferredTools: true };
}

/**
 * Points each deferred definition back at its registry entry after a pass that
 * rewrote both sides separately, such as stripping background or intent schema
 * from a subagent's inherited inputs. Both sides went through the same
 * rewrite, so the registry entry is the definition's current form. Returns the
 * input array when nothing needed rejoining.
 */
export function shareDeferredDefinitions(
  toolDefinitions: LCTool[] | undefined,
  toolRegistry: LCToolRegistry | undefined,
): LCTool[] | undefined {
  if (!toolDefinitions || !toolRegistry) {
    return toolDefinitions;
  }
  let changed = false;
  const shared = toolDefinitions.map((def) => {
    if (def.defer_loading !== true) {
      return def;
    }
    const entry = toolRegistry.get(def.name);
    if (entry == null || entry === def || entry.defer_loading !== true) {
      return def;
    }
    changed = true;
    return entry;
  });
  return changed ? shared : toolDefinitions;
}
