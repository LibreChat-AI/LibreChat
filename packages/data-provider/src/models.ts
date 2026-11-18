import { z } from 'zod';
import type { AgentSubagentsConfig } from './types/agents';
import type { TModelSpecPreset } from './schemas';
import type { TEphemeralAgent } from './types';
import {
  EModelEndpoint,
  tModelSpecPresetSchema,
  eModelEndpointSchema,
  AuthType,
  authTypeSchema,
} from './schemas';
import { getMaxSubagents } from './limits';

type ModelSpecSubagentsConfig = Omit<AgentSubagentsConfig, 'graphs'>;

export type TModelSpec = {
  name: string;
  label: string;
  preset: TModelSpecPreset;
  order?: number;
  default?: boolean;
  softDefault?: boolean;
  description?: string;
  /**
   * Optional group name for organizing specs in the UI selector.
   * - If it matches an endpoint name (e.g., "openAI", "groq"), the spec appears nested under that endpoint
   * - If it's a custom name (doesn't match any endpoint), it creates a separate collapsible group
   * - If omitted, the spec appears as a standalone item at the top level
   */
  group?: string;
  /**
   * Optional icon URL for the group this spec belongs to.
   * Only needs to be set on one spec per group - the first one found with a groupIcon will be used.
   * Can be a URL or an endpoint name to use its icon.
   */
  groupIcon?: string | EModelEndpoint;
  showIconInMenu?: boolean;
  showIconInHeader?: boolean;
  /** Show this spec's label and description on the chat landing in place of the greeting. */
  showOnLanding?: boolean;
  /** Conversation starter prompts shown on the chat landing while this spec is active. */
  conversation_starters?: string[];
  /**
   * When false, the spec is omitted from the model selector menu and from the
   * client startup config, but remains usable when invoked explicitly by name
   * via the `spec` field (server-side resolution uses the full, unfiltered list).
   * Unlike `showIconInMenu` (which only hides the icon), this hides the whole entry.
   * Defaults to true (listed).
   */
  showInMenu?: boolean;
  iconURL?: string | EModelEndpoint; // Allow using project-included icons
  authType?: AuthType;
  /** Hide the chat input tool badge row while this model spec is active. */
  hideBadgeRow?: boolean;
  webSearch?: boolean;
  fileSearch?: boolean;
  executeCode?: boolean;
  memory?: boolean;
  /** Equip the spec's ephemeral agent with the `ask_user_question` HITL tool. */
  askUserQuestion?: boolean;
  /**
   * Let the model dispatch tool calls in the background (poll results via
   * `check_background_task`). Code execution is background-NATIVE: when the
   * admin enables the `run_in_background` agent capability, an
   * `executeCode: true` spec backgrounds code with no flag here. `true` opts
   * in every other eligible tool; a string array opts in only the named
   * tools, matched against the spec's resolved tool ids (e.g.
   * `['slow_report_mcp_analytics']`; `execute_code` and `bash_tool` both
   * select the code pair). `false`, the empty list, or a list that omits the
   * code pair explicitly opts it back out. Requires the `run_in_background`
   * agent capability.
   */
  runInBackground?: boolean | string[];
  /**
   * Inject the `intent` label param so each call streams a live status label.
   * `true` opts in every eligible tool; a string array opts in only the named
   * tools, matched against the spec's resolved tool ids (e.g.
   * `['web_search', 'search_code_mcp_github']`). Requires the `tool_intents`
   * agent capability to be enabled by the admin.
   */
  describeIntent?: boolean | string[];
  /**
   * Defer tool schemas until the model finds them with `tool_search`, so
   * equipped tools cost nothing in context until they are needed. Covers
   * system tools (web search, file search, code execution, memory) as well as
   * MCP tools. `true` defers every eligible tool; a string array defers only
   * the named ones, matched against the spec's resolved tool ids or a
   * capability (`['execute_code', 'web_search']`). `tool_search`, the
   * `skill` tool and the background poll tool always stay loaded. Requires
   * the `deferred_tools` agent capability.
   */
  deferLoading?: boolean | string[];
  artifacts?: string | boolean;
  mcpServers?: string[];
  skills?: boolean | string[];
  subagents?: ModelSpecSubagentsConfig;
};

type EphemeralToolToggles = Pick<
  TEphemeralAgent,
  'web_search' | 'file_search' | 'execute_code' | 'memory' | 'ask_user_question'
>;

type SpecToolToggles = Pick<
  TModelSpec,
  'webSearch' | 'fileSearch' | 'executeCode' | 'memory' | 'askUserQuestion'
>;

export const modelSpecSubagentsSchema = z
  .object({
    enabled: z.boolean().optional(),
    allowSelf: z.boolean().optional(),
    shareFiles: z.boolean().optional(),
    agent_ids: z.array(z.string()).optional(),
  })
  .superRefine((subagents, ctx) => {
    const maxSubagents = getMaxSubagents();
    if ((subagents.agent_ids?.length ?? 0) > maxSubagents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_ids'],
        message: `agent_ids must contain at most ${maxSubagents} item(s)`,
      });
    }
  });

/**
 * The endpoint a spec targets. Only the agents endpoint can serve a preset that
 * names an `agent_id`, so an omitted `endpoint` is inferred rather than left
 * undefined — otherwise the spec matches no endpoint at all, the client sends
 * no endpoint when it is selected, and the request is rejected as a mismatch.
 *
 * Shared so the selector and the request pipeline resolve a spec identically.
 */
/**
 * Structural view of the fields endpoint resolution reads, so partial spec
 * shapes (e.g. `AppConfig['modelSpecs']`, which is deep-partial) qualify.
 */
type ModelSpecEndpointSource = {
  preset?: Pick<TModelSpecPreset, 'endpoint' | 'agent_id'> | null;
};

export function resolveModelSpecEndpoint(
  modelSpec: ModelSpecEndpointSource | undefined,
): string | undefined {
  const preset = modelSpec?.preset;
  if (preset?.endpoint != null) {
    return preset.endpoint;
  }
  /**
   * An explicit `endpoint: null` is a statement, not an omission — such specs
   * validated (and were skipped downstream) before inference existed, so
   * inferring here would silently activate them. Only an absent key infers,
   * and only from a non-empty `agent_id`: form-backed writers persist
   * untouched fields as `''`, which names no agent.
   */
  if (preset?.endpoint === null) {
    return undefined;
  }
  return preset?.agent_id ? EModelEndpoint.agents : undefined;
}

/**
 * Writes each spec's resolved endpoint back onto its preset so every consumer —
 * endpoint matching, the selector, access filters, startup presets, provider-key
 * reachability — reads a complete spec instead of re-deriving it. Apply once
 * where the effective config is assembled (YAML load and DB-override merge);
 * downstream code then needs no awareness of inference.
 *
 * Returns the original object, and the original spec objects, when nothing
 * needs filling in, so cached configs and memoized consumers see no new
 * identities.
 */
export function materializeModelSpecEndpoints<
  T extends { list?: ModelSpecEndpointSource[] } | null | undefined,
>(modelSpecs: T): T {
  const list = modelSpecs?.list;
  if (!list?.length) {
    return modelSpecs;
  }

  let changed = false;
  const materialized = list.map((spec) => {
    if (spec?.preset == null || spec.preset.endpoint != null) {
      return spec;
    }
    const endpoint = resolveModelSpecEndpoint(spec);
    if (endpoint == null) {
      return spec;
    }
    changed = true;
    return { ...spec, preset: { ...spec.preset, endpoint } };
  });

  if (!changed) {
    return modelSpecs;
  }
  return { ...modelSpecs, list: materialized } as T;
}

export const tModelSpecSchema = z.object({
  name: z.string(),
  label: z.string(),
  preset: tModelSpecPresetSchema,
  order: z.number().optional(),
  default: z.boolean().optional(),
  softDefault: z.boolean().optional(),
  description: z.string().optional(),
  group: z.string().optional(),
  groupIcon: z.union([z.string(), eModelEndpointSchema]).optional(),
  showIconInMenu: z.boolean().optional(),
  showIconInHeader: z.boolean().optional(),
  showOnLanding: z.boolean().optional(),
  conversation_starters: z.array(z.string()).optional(),
  showInMenu: z.boolean().optional(),
  iconURL: z.union([z.string(), eModelEndpointSchema]).optional(),
  authType: authTypeSchema.optional(),
  hideBadgeRow: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  fileSearch: z.boolean().optional(),
  executeCode: z.boolean().optional(),
  memory: z.boolean().optional(),
  askUserQuestion: z.boolean().optional(),
  runInBackground: z.union([z.boolean(), z.array(z.string())]).optional(),
  describeIntent: z.union([z.boolean(), z.array(z.string())]).optional(),
  deferLoading: z.union([z.boolean(), z.array(z.string())]).optional(),
  artifacts: z.union([z.string(), z.boolean()]).optional(),
  mcpServers: z.array(z.string()).optional(),
  skills: z.union([z.boolean(), z.array(z.string())]).optional(),
  subagents: modelSpecSubagentsSchema.optional(),
});

/**
 * Ephemeral-agent toggle ↔ model-spec field pairs for the capabilities a spec
 * can pre-enable and the chat badge row can toggle. Consumed by both the
 * client (badge state) and the ephemeral agent loaders (tool equipping) so the
 * two never drift.
 */
export const SPEC_TOOL_TOGGLES: ReadonlyArray<
  readonly [keyof EphemeralToolToggles, keyof SpecToolToggles]
> = [
  ['execute_code', 'executeCode'],
  ['file_search', 'fileSearch'],
  ['web_search', 'webSearch'],
  ['memory', 'memory'],
  ['ask_user_question', 'askUserQuestion'],
];

/**
 * A model spec pre-enables a capability as a DEFAULT, not a mandate: an
 * explicit user toggle — `false` included — decides. A spec that gives the
 * user no control over its tools (`specWithholdsUserToggles`) is the exception.
 */
export function resolveSpecToolFlag(
  userValue: boolean | undefined,
  specValue: boolean | undefined,
): boolean {
  return typeof userValue === 'boolean' ? userValue : specValue === true;
}

/**
 * Every ephemeral toggle paired with the model-spec field that configures it.
 * A superset of `SPEC_TOOL_TOGGLES`, which covers only the toggles that equip a
 * tool; this one also carries the capabilities configured by other means
 * (MCP servers, skills, artifacts, background execution, intent labels).
 */
export const SPEC_CAPABILITY_FIELDS: ReadonlyArray<
  readonly [keyof TEphemeralAgent, keyof TModelSpec]
> = [
  ['web_search', 'webSearch'],
  ['file_search', 'fileSearch'],
  ['execute_code', 'executeCode'],
  ['memory', 'memory'],
  ['ask_user_question', 'askUserQuestion'],
  ['mcp', 'mcpServers'],
  ['skills', 'skills'],
  ['artifacts', 'artifacts'],
  ['run_in_background', 'runInBackground'],
  ['describe_intent', 'describeIntent'],
];

const SPEC_FIELD_BY_TOGGLE = new Map<string, keyof TModelSpec>(SPEC_CAPABILITY_FIELDS);

/**
 * Whether a spec gives the user no control over its tools: it hides the badge
 * row, or it is left out of the model menu (`showInMenu: false`). A hidden spec
 * never reaches the client's config, so the badges shown beside it were never
 * seeded from it and a toggle sent against it does not answer its defaults.
 */
export function specWithholdsUserToggles<T extends Pick<TModelSpec, 'hideBadgeRow' | 'showInMenu'>>(
  modelSpec: T | null | undefined,
): modelSpec is T {
  return modelSpec?.hideBadgeRow === true || modelSpec?.showInMenu === false;
}

/**
 * Whether a spec holds authority over one capability: it gives the user no
 * control over its tools (`specWithholdsUserToggles`) AND it configures that
 * capability itself. Such a spec silent on a capability has nothing to
 * protect, so the user's own value still decides there.
 *
 * Shared with the client, which must filter its restored per-conversation
 * toggles by the same rule: erasing a stored value the server would have
 * honored puts the two out of step in the one direction the server cannot
 * correct, because by then the value is already gone.
 */
export function specOverridesUserToggle(
  modelSpec: TModelSpec | null | undefined,
  toggleField: keyof TEphemeralAgent,
): boolean {
  if (!specWithholdsUserToggles(modelSpec)) {
    return false;
  }
  const specField = SPEC_FIELD_BY_TOGGLE.get(toggleField);
  return specField != null && modelSpec[specField] != null;
}

/**
 * Drops the request's toggle for one capability when the spec holds authority
 * over it. For the sites that resolve a single field rather than a whole
 * ephemeral agent.
 */
export function resolveSpecUserToggle<T>(
  userValue: T | undefined,
  modelSpec: TModelSpec | null | undefined,
  toggleField: keyof TEphemeralAgent,
): T | undefined {
  return specOverridesUserToggle(modelSpec, toggleField) ? undefined : userValue;
}

/**
 * Strips from a request's ephemeral agent only the toggles whose capability the
 * spec holds authority over, leaving the rest to decide as usual. Fields with no
 * spec counterpart are always preserved, so a capability added later is not
 * silently suppressed before it has a spec field to be governed by. Returns the
 * object unchanged for every ordinary spec.
 */
export function resolveSpecUserToggles(
  userToggles: TEphemeralAgent | null | undefined,
  modelSpec: TModelSpec | null | undefined,
): TEphemeralAgent | undefined {
  if (userToggles == null) {
    return undefined;
  }
  if (!specWithholdsUserToggles(modelSpec)) {
    return userToggles;
  }
  const preserved: Record<string, unknown> = {};
  let preservedCount = 0;
  for (const key of Object.keys(userToggles)) {
    if (specOverridesUserToggle(modelSpec, key as keyof TEphemeralAgent)) {
      continue;
    }
    preserved[key] = (userToggles as Record<string, unknown>)[key];
    preservedCount++;
  }
  return preservedCount > 0 ? (preserved as TEphemeralAgent) : undefined;
}

/**
 * The artifacts mode for an ephemeral agent. A spec's `artifacts` seeds it —
 * `true` meaning the default renderer — and an explicit request value decides,
 * matching every other spec-configured capability. Returns undefined when
 * neither side asks for artifacts, so callers can leave the field unset.
 */
export function resolveSpecArtifacts(
  userValue: string | undefined,
  specValue: TModelSpec['artifacts'],
): string | undefined {
  if (typeof userValue === 'string') {
    return userValue || undefined;
  }
  if (specValue === true) {
    return 'default';
  }
  return typeof specValue === 'string' && specValue !== '' ? specValue : undefined;
}

/**
 * The user's MCP selection is authoritative whenever the client sends one — an
 * empty array is a deselection, not an absent value. A spec's `mcpServers`
 * seeds the picker, and applies only when no selection accompanies the request.
 */
export function resolveSpecMcpServers(
  userValue: string[] | undefined,
  specValue: string[] | undefined,
): string[] {
  return Array.isArray(userValue) ? userValue : (specValue ?? []);
}

/**
 * Skills follow the same default-not-mandate rule, with one exception kept
 * from the original semantics: a spec's explicit `skills: false` remains a
 * hard opt-out. Unlike the boolean tool flags — whose `false` has always been
 * a mere default the badge could turn back on — `skills: false` has always
 * pinned the agent off, and specs rely on it to keep a catalog out of reach.
 */
export function resolveSpecSkillsEnabled(
  userValue: boolean | undefined,
  specValue: TModelSpec['skills'],
): boolean {
  if (specValue === false) {
    return false;
  }
  if (typeof userValue === 'boolean') {
    return userValue;
  }
  return specValue === true || Array.isArray(specValue);
}

export const specsConfigSchema = z.object({
  enforce: z.boolean().default(false),
  prioritize: z.boolean().default(true),
  list: z.array(tModelSpecSchema).default([]),
  addedEndpoints: z.array(z.union([z.string(), eModelEndpointSchema])).optional(),
});

export type TSpecsConfig = z.infer<typeof specsConfigSchema>;
