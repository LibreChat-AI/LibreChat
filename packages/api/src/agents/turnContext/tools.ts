import {
  Constants,
  actionDelimiter,
  isActionTool,
  normalizeServerName,
} from 'librechat-data-provider';
import { TOOL_DISPATCHER_NAME } from '@librechat/agents';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { ContextEntry, ContextSource, TurnContextAgent } from './registry';
import { builtinCapability, builtinRank, isUndispatchable, schemaProfile } from './builtins';
import { getToolDefinition } from '~/tools/registry/definitions';
import { formatMCPServerInstructions, sortNames } from '~/mcp/utils';
import { toolkitParent } from '~/tools/toolkits/mapping';

/**
 * Ledger key prefix of a tool group: `tool:builtin:<capability>`, `tool:mcp:<server>`,
 * `tool:action:<domain>`, `tool:agent:<tool>`.
 */
export const TOOL_GROUP_PREFIX = 'tool:';

const GroupKinds = { builtin: 'builtin', mcp: 'mcp', action: 'action', agent: 'agent' } as const;

export const isToolGroupKey = (key: string): boolean => key.startsWith(TOOL_GROUP_PREFIX);

const groupKey = (kind: string, name: string) => `${TOOL_GROUP_PREFIX}${kind}:${name}`;
const isBuiltinKey = (key: string) => key.startsWith(groupKey(GroupKinds.builtin, ''));
const builtinName = (key: string) => key.slice(groupKey(GroupKinds.builtin, '').length);

/** The schema part of a tool definition that reaches the provider. */
interface ToolSchema {
  name: string;
  description?: string;
  parameters?: LCTool['parameters'];
}

/** Stored value of a tool group: what the model is told about it. */
interface ToolGroupValue {
  instructions?: string;
  tools: ToolSchema[];
}

export interface LiveToolGroup {
  value: string;
  definitions: LCTool[];
}

/** The tool groups an agent has this turn, sampled when the user sends the message. */
export interface LiveToolGroups {
  /** Groups with at least one bindable tool, in their initial order. */
  groups: Map<string, LiveToolGroup>;
  /** Groups the agent selected whose tools failed to load (server unreachable, sign-in pending). */
  unavailable: Set<string>;
}

/** The fields of an initialized agent the tool plan reads and writes. */
export interface ToolPlanAgent {
  toolDefinitions?: LCTool[];
  toolRegistry?: LCToolRegistry;
  /** Tool names the agent asked for before loading (`agent.tools`). */
  selectedToolNames?: readonly string[];
  /** Binds the SDK's dispatcher tool for this run. */
  toolDispatch?: boolean;
  /** The tools as loaded, before a plan; isolated subagent copies of the agent run with these. */
  liveTools?: Pick<ToolPlanAgent, 'toolDefinitions' | 'toolRegistry'>;
  /** Built-in tool instructions, by tool name. */
  toolContextMap?: Record<string, unknown>;
  /** The skills capability owns the file tools only without a code environment. */
  codeEnvAvailable?: boolean;
}

const loadedDefinitions = (agent: ToolPlanAgent) =>
  agent.liveTools?.toolDefinitions ?? agent.toolDefinitions ?? [];

function mcpServerOf(definition: LCTool): string | undefined {
  if (definition.serverName) {
    return normalizeServerName(definition.serverName);
  }
  const index = definition.name.lastIndexOf(Constants.mcp_delimiter);
  return index > 0 ? definition.name.slice(index + Constants.mcp_delimiter.length) : undefined;
}

/** The group a tool belongs to; undefined for a tool no group owns, which stays live. */
export function getToolGroupKey(
  definition: LCTool,
  codeEnvAvailable?: boolean,
): string | undefined {
  const { name } = definition;
  if (isActionTool(name)) {
    return groupKey(
      GroupKinds.action,
      name.slice(name.indexOf(actionDelimiter) + actionDelimiter.length),
    );
  }
  const server =
    definition.serverName != null || name.includes(Constants.mcp_delimiter)
      ? mcpServerOf(definition)
      : undefined;
  if (server != null) {
    return groupKey(GroupKinds.mcp, server);
  }
  const capability = builtinCapability(name, codeEnvAvailable);
  if (capability != null) {
    return groupKey(GroupKinds.builtin, capability);
  }
  if (getToolDefinition(name) != null) {
    return groupKey(GroupKinds.agent, toolkitParent[name] ?? name);
  }
  return undefined;
}

/** Group keys named by the agent's selected tools, loaded or not. */
function selectedGroupKeys(names: readonly string[], codeEnvAvailable?: boolean): Set<string> {
  const keys = new Set<string>();
  for (const name of names) {
    const mcpIndex = name.lastIndexOf(Constants.mcp_delimiter);
    if (isActionTool(name)) {
      keys.add(getToolGroupKey({ name }) as string);
    } else if (mcpIndex > 0) {
      keys.add(groupKey(GroupKinds.mcp, name.slice(mcpIndex + Constants.mcp_delimiter.length)));
    } else {
      const key = getToolGroupKey({ name }, codeEnvAvailable);
      if (key != null) {
        keys.add(key);
      }
    }
  }
  return keys;
}

const isBindable = (definition: LCTool) =>
  definition.defer_loading !== true &&
  (definition.allowed_callers == null || definition.allowed_callers.includes('direct'));

const toSchema = ({ name, description, parameters }: LCTool): ToolSchema => ({
  name,
  ...(description != null && { description }),
  ...(parameters != null && { parameters }),
});

function byName(a: { name: string }, b: { name: string }): number {
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
}

/** Instructions of a built-in group's tools, by tool name. */
function builtinInstructions(agent: ToolPlanAgent, definitions: LCTool[]): string | undefined {
  const texts = definitions
    .map(({ name }) => agent.toolContextMap?.[name])
    .filter((text): text is string => typeof text === 'string' && text !== '');
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Samples the agent's tool groups. The initial order is the order a new anchor
 * binds them in: built-in capabilities in a fixed order, MCP servers by name,
 * then the other groups in the order the agent lists them; tools inside a group
 * by name.
 *
 * @param getInstructions - raw MCP server name to its instructions
 */
export async function collectToolGroups({
  agent,
  getInstructions,
}: {
  agent: ToolPlanAgent;
  getInstructions?: (servers: string[]) => Promise<Record<string, string>>;
}): Promise<LiveToolGroups> {
  const members = new Map<string, LCTool[]>();
  const rawServers = new Map<string, string>();
  for (const definition of loadedDefinitions(agent)) {
    const key = getToolGroupKey(definition, agent.codeEnvAvailable);
    if (key == null || !isBindable(definition)) {
      continue;
    }
    members.set(key, [...(members.get(key) ?? []), definition]);
    if (key.startsWith(groupKey(GroupKinds.mcp, ''))) {
      rawServers.set(key, definition.serverName ?? key.slice(groupKey(GroupKinds.mcp, '').length));
    }
  }
  const instructions =
    rawServers.size > 0 && getInstructions != null
      ? await getInstructions(sortNames(new Set(rawServers.values())))
      : {};

  const builtinKeys = [...members.keys()]
    .filter(isBuiltinKey)
    .sort((a, b) => builtinRank(builtinName(a)) - builtinRank(builtinName(b)));
  const mcpKeys = sortNames([...members.keys()].filter((key) => rawServers.has(key)));
  const otherKeys = [...members.keys()].filter((key) => !rawServers.has(key) && !isBuiltinKey(key));
  const groups = new Map<string, LiveToolGroup>();
  for (const key of [...builtinKeys, ...mcpKeys, ...otherKeys]) {
    const definitions = members.get(key) as LCTool[];
    const server = rawServers.get(key);
    const groupInstructions =
      server != null
        ? instructions[server]
        : isBuiltinKey(key) && builtinInstructions(agent, definitions);
    const value: ToolGroupValue = {
      ...(groupInstructions && { instructions: groupInstructions }),
      tools: definitions.map(toSchema).sort(byName),
    };
    groups.set(key, { value: JSON.stringify(value), definitions });
  }
  const unavailable = new Set(
    [...selectedGroupKeys(agent.selectedToolNames ?? [], agent.codeEnvAvailable)].filter(
      (key) => !groups.has(key),
    ),
  );
  return { groups, unavailable };
}

function readGroupValue(value: string | null | undefined): ToolGroupValue | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as ToolGroupValue;
    return Array.isArray(parsed?.tools) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function describeGroup(key: string): string {
  const [kind, ...rest] = key.slice(TOOL_GROUP_PREFIX.length).split(':');
  const name = rest.join(':');
  if (kind === GroupKinds.mcp) {
    return `MCP server \`${name}\``;
  }
  if (kind === GroupKinds.builtin) {
    return `built-in capability \`${name}\``;
  }
  return kind === GroupKinds.action ? `action \`${name}\`` : `tool \`${name}\``;
}

function describeSchema(tool: ToolSchema): string[] {
  return [
    `- ${tool.name}: ${tool.description ?? ''}`.trimEnd(),
    `  parameters: ${JSON.stringify(tool.parameters ?? { type: 'object' })}`,
  ];
}

const sameSchema = (a: ToolSchema, b: ToolSchema) =>
  a.description === b.description && JSON.stringify(a.parameters) === JSON.stringify(b.parameters);

/**
 * Announces what changed in a group the model already knows. The `tools` parameter keeps
 * the schemas of the anchor, so a changed schema is stated here, in the message: calls follow
 * these parameters, and tools that are new reach the model through the dispatcher.
 */
function renderGroupChange(label: string, previous: ToolGroupValue, current: ToolGroupValue) {
  const before = new Map(previous.tools.map((tool) => [tool.name, tool]));
  const now = new Map(current.tools.map((tool) => [tool.name, tool]));
  const added = current.tools.filter((tool) => !before.has(tool.name));
  const changed = current.tools.filter(
    (tool) => before.has(tool.name) && !sameSchema(before.get(tool.name) as ToolSchema, tool),
  );
  const removed = previous.tools.filter((tool) => !now.has(tool.name));
  const lines = [`Tools of ${label} changed.`];
  if (added.length > 0) {
    lines.push(
      `New tools. They are not in your tool list: call them with \`${TOOL_DISPATCHER_NAME}\`, giving "name" and "arguments" (a JSON object string following "parameters").`,
    );
    added.forEach((tool) => lines.push(...describeSchema(tool)));
  }
  if (changed.length > 0) {
    lines.push(
      'Changed tools. Your tool list still shows their previous parameters: call them directly, following these.',
    );
    changed.forEach((tool) => lines.push(...describeSchema(tool)));
  }
  if (removed.length > 0) {
    lines.push(
      `Removed tools, calls to them will fail: ${removed.map(({ name }) => name).join(', ')}.`,
    );
  }
  if (previous.instructions !== current.instructions) {
    lines.push(
      current.instructions
        ? `Updated instructions:\n${current.instructions}`
        : 'The server no longer has instructions.',
    );
  }
  return lines.join('\n');
}

/**
 * Announces a group made available mid-segment with everything the model needs
 * to call it through the dispatcher, since its schemas are not in `tools`; or what changed
 * in a group it already knows.
 */
function renderToolGroupUpdate(
  key: string,
  value: string | null,
  previous: string | null,
  _agent: TurnContextAgent,
  wasKnown = false,
  lastSeen: string | null = null,
): string {
  const label = describeGroup(key);
  if (value == null) {
    return `Tools of ${label} were switched off; calls to them will fail.`;
  }
  const group = readGroupValue(value);
  const earlier = readGroupValue(previous);
  if (group != null && earlier != null) {
    return renderGroupChange(label, earlier, group);
  }
  if (wasKnown) {
    /** Back after being switched off: state what changed while it was off, if anything. */
    const before = readGroupValue(lastSeen);
    if (group != null && before != null && lastSeen !== value) {
      return `Tools of ${label} are available again.\n${renderGroupChange(label, before, group)}`;
    }
    return `Tools of ${label} are available again.`;
  }
  const lines = [
    `Tools of ${label} are now available. They are not in your tool list: call them with \`${TOOL_DISPATCHER_NAME}\`, giving "name" and "arguments" (a JSON object string following "parameters").`,
  ];
  if (group?.instructions) {
    lines.push(group.instructions);
  }
  (group?.tools ?? []).forEach((tool) => lines.push(...describeSchema(tool)));
  return lines.join('\n');
}

/**
 * Tool groups as a ledger source. The anchor binds a group's tools from its
 * stored schemas; a group added later is announced and reached through the
 * dispatcher, and one switched off stays bound but refuses calls. A schema that
 * changes server-side is announced with the new schema when the user next sends
 * a message; `tools` itself changes only with the next anchor.
 */
export const toolGroupSource: ContextSource = {
  key: TOOL_GROUP_PREFIX,
  kind: 'state',
  keepOrder: true,
  collect: ({ toolGroups }) =>
    [...(toolGroups?.groups ?? [])].map(([key, { value }]): [string, string] => [key, value]),
  renderAnchor: () => '',
  renderUpdate: renderToolGroupUpdate,
};

const byToolName = (groups: ReadonlyMap<string, LiveToolGroup>) =>
  new Map(
    [...groups.values()].flatMap(({ definitions }) =>
      definitions.map((definition): [string, LCTool] => [definition.name, definition]),
    ),
  );

/** What a turn binds, derived from the segment anchor and the live tool groups. */
export interface ToolPlan {
  toolDefinitions: LCTool[];
  /** Registry entries that change: deferred, disabled, or known only from the anchor. */
  registryEntries: LCTool[];
  dispatch: boolean;
  /** Instructions of the anchored MCP servers, for the stable system prompt. */
  mcpInstructions: string;
  /** Instructions of the anchored built-in capabilities, by capability. */
  toolContext: Record<string, string>;
}

/**
 * Plans the tools of one turn. Anchored groups are bound from their stored
 * schemas in anchor order, after the tools that are not grouped; an anchored
 * group that is off now stays bound with `disabled`. Live groups the anchor
 * does not bind are deferred. Anchored MCP and built-in instructions are
 * returned for the system prompt.
 */
export function planTools({
  agent,
  anchor,
  toolGroups,
  dispatch,
}: {
  agent: ToolPlanAgent;
  anchor: readonly ContextEntry[];
  toolGroups?: LiveToolGroups;
  dispatch: boolean;
}): ToolPlan {
  const live = toolGroups?.groups ?? new Map<string, LiveToolGroup>();
  const registry = agent.liveTools?.toolRegistry ?? agent.toolRegistry;
  /** By name across groups: a file tool moves between the code and skills groups with the code environment. */
  const liveByName = byToolName(live);
  const bound: LCTool[] = [];
  const registryEntries: LCTool[] = [];
  const instructions: Record<string, string> = {};
  const toolContext: Record<string, string> = {};
  for (const { key, value } of anchor) {
    const group = isToolGroupKey(key) ? readGroupValue(value) : undefined;
    if (group == null) {
      continue;
    }
    if (group.instructions && key.startsWith(groupKey(GroupKinds.mcp, ''))) {
      instructions[key.slice(groupKey(GroupKinds.mcp, '').length)] = group.instructions;
    } else if (group.instructions && isBuiltinKey(key)) {
      toolContext[builtinName(key)] = group.instructions;
    }
    const liveGroup = live.get(key);
    const reason =
      liveGroup == null && toolGroups?.unavailable.has(key) !== true
        ? 'switched off'
        : 'unavailable';
    for (const tool of group.tools) {
      const liveTool = liveByName.get(tool.name);
      const definition: LCTool = {
        ...liveTool,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      };
      if (liveTool == null) {
        definition.disabled = { reason };
        registryEntries.push({ ...(registry?.get(tool.name) ?? tool), disabled: { reason } });
      }
      bound.push(definition);
    }
  }
  const boundNames = new Set(bound.map(({ name }) => name));
  const unbound = loadedDefinitions(agent)
    .filter(({ name }) => !boundNames.has(name))
    .map((definition) => {
      if (
        definition.defer_loading === true ||
        getToolGroupKey(definition, agent.codeEnvAvailable) == null
      ) {
        return definition;
      }
      const registered = registry?.get(definition.name);
      registryEntries.push({ ...(registered ?? definition), defer_loading: true });
      return { ...definition, defer_loading: true };
    });
  return {
    toolDefinitions: [...unbound, ...bound],
    registryEntries,
    dispatch,
    mcpInstructions: formatMCPServerInstructions(instructions),
    toolContext,
  };
}

/** Applies a tool plan to the agent the run is built from, keeping the loaded tools aside. */
export function applyToolPlan(agent: ToolPlanAgent, plan: ToolPlan): void {
  agent.liveTools ??= { toolDefinitions: agent.toolDefinitions, toolRegistry: agent.toolRegistry };
  agent.toolDefinitions = plan.toolDefinitions;
  if (plan.registryEntries.length > 0) {
    const registry = new Map(agent.liveTools.toolRegistry ?? []);
    for (const entry of plan.registryEntries) {
      registry.set(entry.name, entry);
    }
    agent.toolRegistry = registry;
  }
  agent.toolDispatch = plan.dispatch || undefined;
  /** Built-in instructions come from the anchor, like the tools they describe. */
  const ungrouped = Object.entries(agent.toolContextMap ?? {}).filter(
    ([name]) => getToolGroupKey({ name }, agent.codeEnvAvailable) == null,
  );
  agent.toolContextMap = { ...Object.fromEntries(ungrouped), ...plan.toolContext };
}

/**
 * Why the live tools cannot keep the anchored `tools` byte for byte, if they
 * cannot: an anchored tool gained or lost a schema-profile parameter (tool
 * intents, background runs), or a group the dispatcher cannot reach was enabled.
 */
export function findToolResets(
  anchor: readonly ContextEntry[],
  toolGroups: LiveToolGroups,
): string[] {
  const reasons = new Set<string>();
  const liveByName = byToolName(toolGroups.groups);
  const anchored = new Set<string>();
  for (const { key, value } of anchor) {
    const group = isToolGroupKey(key) ? readGroupValue(value) : undefined;
    if (group == null) {
      continue;
    }
    anchored.add(key);
    for (const tool of group.tools) {
      const liveTool = liveByName.get(tool.name);
      if (
        liveTool != null &&
        schemaProfile(liveTool.parameters) !== schemaProfile(tool.parameters)
      ) {
        reasons.add('tool_profile');
      }
    }
  }
  for (const key of toolGroups.groups.keys()) {
    if (isBuiltinKey(key) && isUndispatchable(builtinName(key)) && !anchored.has(key)) {
      reasons.add('tools');
    }
  }
  return [...reasons];
}
