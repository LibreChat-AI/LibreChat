/**
 * @fileoverview Tool-selection policy for capability-injected per-tool options.
 *
 * A model spec / ephemeral agent expresses per-tool capability choices
 * (`describeIntent`, `runInBackground`, `deferLoading`, `programmaticTools`)
 * against its LOAD-TIME tool entries:
 * capability markers (`execute_code`, `memory`), lazy `mcp_all` placeholders,
 * and fields that never reach the `tools` array at all (`skills`). The
 * definitions those choices must govern only exist at INITIALIZATION time,
 * after markers expand and late registrations (file authoring, the skill
 * catalog) run — so any option pre-keyed by a load-time name risks being a
 * silent no-op against the final definition set.
 *
 * This module removes that name-space gap instead of bridging it per case:
 *
 * - Synthesis records the selection as a POLICY, not per-name entries: a
 *   wildcard `*` entry carries the default (`true` for "every tool", `false`
 *   for "only the named ones"), and listed names are recorded verbatim as
 *   explicit opt-ins.
 * - Resolution happens at injection time, per final definition:
 *   explicit name → capability projection → wildcard → caller's default.
 *   The capability projection maps a marker entry onto the definition names
 *   its registration ACTUALLY produced this run (reported by the registrars
 *   themselves in `initializeAgent`), so the mapping cannot drift from what
 *   gets registered.
 *
 * Saved agents are untouched by the wildcard (their `tool_options` come from
 * the builder, keyed by real names or markers) but gain the same projection,
 * replacing the hand-maintained marker→names constants that kept leaking
 * (create_file/edit_file, the skill catalog, memory-in-background).
 *
 * @module packages/api/src/agents/selection
 */

import { logger } from '@librechat/data-schemas';
import type { AgentToolOptions, AllowedCaller } from 'librechat-data-provider';

/**
 * Reserved `tool_options` key holding a synthesized selection's default for
 * every tool without a more specific entry. Provider tool-name grammars
 * (`^[a-zA-Z0-9_-]+$`) cannot produce it, and every other consumer of
 * `tool_options` reads by exact definition name, so the entry is inert
 * outside the resolution below. Never persisted — it only appears on
 * synthesized ephemeral/model-spec options.
 */
export const TOOL_SELECTION_WILDCARD = '*';

/**
 * Capability marker → tool definition names its registration produced for
 * this run. Built by `initializeAgent` from the registrars' own reports, so
 * an option keyed by a marker (a spec selection or a hand-edited saved
 * agent) projects onto exactly what got registered.
 */
export type CapabilityToolNames = ReadonlyMap<string, readonly string[]>;

type BooleanSelectionField = 'describe_intent' | 'run_in_background' | 'defer_loading';

/** Per-tool options resolved through the selection policy below. */
export type SelectionField = BooleanSelectionField | 'allowed_callers';

type ToolOptionEntry = AgentToolOptions[string] | undefined;

/**
 * How one field reads its value from a `tool_options` entry, and which
 * values opt in. `read` returns undefined when the entry does not speak.
 */
interface SelectionCodec<T> {
  read: (options: ToolOptionEntry) => T | undefined;
  optsIn: (value: T) => boolean;
}

function booleanCodec(field: BooleanSelectionField): SelectionCodec<boolean> {
  return {
    read: (options) => (options?.[field] == null ? undefined : options[field] === true),
    optsIn: (value) => value,
  };
}

/** An empty list does not speak, matching how the MCP registry always read it. */
const callersCodec: SelectionCodec<AllowedCaller[]> = {
  read: (options) =>
    options?.allowed_callers != null && options.allowed_callers.length > 0
      ? options.allowed_callers
      : undefined,
  optsIn: (callers) => callers.includes('code_execution'),
};

interface ResolvedSelection<T> {
  value: T;
  /** The `tool_options` key that decided the value: the definition's own
   *  name, a capability marker that registered it, or the wildcard. */
  source: string;
}

export type ResolvedToolOption = ResolvedSelection<boolean>;

export type ResolvedToolCallers = ResolvedSelection<AllowedCaller[]>;

/**
 * The one precedence every selection field shares: an explicit entry under
 * the definition's own name, then capability markers whose registrations
 * include the name (an opting-in marker wins over an opting-out one when two
 * capabilities register the same tool, e.g. `read_file` under both code and
 * skills), then the wildcard default.
 */
function resolveSelection<T>(
  name: string,
  codec: SelectionCodec<T>,
  toolOptions: AgentToolOptions | undefined,
  capabilityToolNames?: CapabilityToolNames,
): ResolvedSelection<T> | undefined {
  if (!toolOptions) {
    return undefined;
  }
  const explicit = codec.read(toolOptions[name]);
  if (explicit !== undefined) {
    return { value: explicit, source: name };
  }
  let markerOptOut: ResolvedSelection<T> | undefined;
  if (capabilityToolNames) {
    for (const [marker, names] of capabilityToolNames) {
      const markerValue = codec.read(toolOptions[marker]);
      if (markerValue === undefined || !names.includes(name)) {
        continue;
      }
      if (codec.optsIn(markerValue)) {
        return { value: markerValue, source: marker };
      }
      markerOptOut ??= { value: markerValue, source: marker };
    }
  }
  if (markerOptOut) {
    return markerOptOut;
  }
  const wildcard = codec.read(toolOptions[TOOL_SELECTION_WILDCARD]);
  if (wildcard !== undefined) {
    return { value: wildcard, source: TOOL_SELECTION_WILDCARD };
  }
  return undefined;
}

/**
 * Resolves one boolean selection field for a definition name through the
 * shared precedence. Returns undefined when no policy speaks, leaving the
 * caller's default (native intent tools, background's opt-in-only) in force.
 */
export function resolveToolOption(
  name: string,
  field: BooleanSelectionField,
  toolOptions: AgentToolOptions | undefined,
  capabilityToolNames?: CapabilityToolNames,
): ResolvedToolOption | undefined {
  return resolveSelection(name, booleanCodec(field), toolOptions, capabilityToolNames);
}

/**
 * Resolves `allowed_callers` for a definition name through the same
 * precedence. A marker or wildcard entry that admits `code_execution` opts
 * in. Returns undefined when no policy speaks. This reads policy only:
 * whether the tool may take the value is decided in `~/agents/callers`.
 */
export function resolveToolCallers(
  name: string,
  toolOptions: AgentToolOptions | undefined,
  capabilityToolNames?: CapabilityToolNames,
): ResolvedToolCallers | undefined {
  return resolveSelection(name, callersCodec, toolOptions, capabilityToolNames);
}

/**
 * Records a spec/ephemeral selection as policy entries. `true` (or the
 * ephemeral toggle, which has no per-tool UI and therefore never narrows)
 * becomes a wildcard opt-in; a list becomes a wildcard opt-out plus verbatim
 * opt-ins for the named entries — names are NOT validated here, because the
 * definitions they must match only exist at injection time, where
 * {@link resolveToolOption} consumes them and the apply pass diagnoses
 * selections that never took effect. The one exception is the reserved
 * wildcard itself: a literal `*` list entry would overwrite the opt-out
 * default and silently enable the capability for EVERY eligible tool, so it
 * is dropped and warned about here, where it is knowably invalid.
 */
export function synthesizeSelectionToolOptions(
  field: BooleanSelectionField,
  selection: boolean | string[] | undefined,
  ephemeralEnabled: boolean,
  label: string,
): AgentToolOptions | undefined {
  const selectedNames = Array.isArray(selection) ? selection : undefined;
  if (!ephemeralEnabled && selection !== true && selectedNames == null) {
    return undefined;
  }
  if (ephemeralEnabled || selection === true) {
    return { [TOOL_SELECTION_WILDCARD]: { [field]: true } };
  }
  const toolOptions: AgentToolOptions = { [TOOL_SELECTION_WILDCARD]: { [field]: false } };
  for (const name of selectedNames ?? []) {
    if (name === TOOL_SELECTION_WILDCARD) {
      logger.warn(
        `${label} contains the reserved wildcard "${TOOL_SELECTION_WILDCARD}"; ignoring it. Set the option to true to cover every eligible tool.`,
      );
      continue;
    }
    toolOptions[name] = { [field]: true };
  }
  return toolOptions;
}

/**
 * The names a narrowing selection opted in, or undefined when no narrowing
 * policy is present (boolean modes, saved agents). Presence of a wildcard
 * opt-out is the discriminator: only synthesized list selections carry one,
 * so saved agents with stale hand-edited entries are never warned about.
 */
export function getSelectionNames(
  toolOptions: AgentToolOptions | undefined,
  field: SelectionField,
): Set<string> | undefined {
  return field === 'allowed_callers'
    ? collectSelectionNames(toolOptions, callersCodec)
    : collectSelectionNames(toolOptions, booleanCodec(field));
}

function collectSelectionNames<T>(
  toolOptions: AgentToolOptions | undefined,
  codec: SelectionCodec<T>,
): Set<string> | undefined {
  const wildcard = codec.read(toolOptions?.[TOOL_SELECTION_WILDCARD]);
  if (toolOptions == null || wildcard === undefined || codec.optsIn(wildcard)) {
    return undefined;
  }
  const names = new Set<string>();
  for (const [name, options] of Object.entries(toolOptions)) {
    const value = codec.read(options);
    if (name !== TOOL_SELECTION_WILDCARD && value !== undefined && codec.optsIn(value)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Warns about selection names that never took effect on any definition — a
 * typo, a tool the spec doesn't equip, or a name whose every definition is
 * ineligible (e.g. `runInBackground: ['memory']`, whose expansion is
 * entirely background-excluded). A silent no-op would leave the misspelled
 * or unsupported entry undiagnosable, since the symptom is simply "nothing
 * happened".
 */
export function warnUnmatchedSelectionNames(
  selectionNames: ReadonlySet<string> | undefined,
  effectiveSources: ReadonlySet<string>,
  label: string,
): void {
  if (selectionNames == null || selectionNames.size === 0) {
    return;
  }
  const unmatched = [...selectionNames].filter((name) => !effectiveSources.has(name));
  if (unmatched.length === 0) {
    return;
  }
  logger.warn(
    `${label} named ${unmatched.length} tool(s) that are not eligible or not equipped on this spec: ${unmatched.join(', ')}`,
  );
}

/**
 * Deep-merges two synthesized `tool_options` maps per tool key, so the
 * ephemeral background and intent toggles compose instead of overwriting
 * each other's per-tool entries.
 */
export function mergeSynthesizedToolOptions(
  base: AgentToolOptions | undefined,
  extra: AgentToolOptions | undefined,
): AgentToolOptions | undefined {
  if (!extra) {
    return base;
  }
  if (!base) {
    return extra;
  }
  const merged: AgentToolOptions = { ...base };
  for (const [name, options] of Object.entries(extra)) {
    merged[name] = { ...merged[name], ...options };
  }
  return merged;
}
