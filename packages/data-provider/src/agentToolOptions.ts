import type { TEphemeralAgent } from './types';
import type { Agent } from './types/agents';
import {
  Tools,
  actionDelimiter,
  actionDomainSeparator,
  isActionTool,
  type AgentToolOptions,
  type AllowedCaller,
} from './types/tools';
import { Constants, splitMCPToolKey, normalizeMCPToolKey, normalizeServerName } from './config';

const actionDomainSeparatorRegex = new RegExp(actionDomainSeparator, 'g');

/**
 * Collapses the encoded-domain suffix of an action tool name to the shape used
 * by runtime tool definitions. The operation id is deliberately preserved.
 */
export function normalizeActionToolName(toolName: string): string {
  if (!isActionTool(toolName)) {
    return toolName;
  }
  const delimiterIndex = toolName.lastIndexOf(actionDelimiter);
  const prefixEnd = delimiterIndex + actionDelimiter.length;
  const encodedDomain = toolName.slice(prefixEnd);
  return toolName.slice(0, prefixEnd) + encodedDomain.replace(actionDomainSeparatorRegex, '_');
}

/**
 * Removes Code Interpreter as an allowed caller without mutating the input.
 * Tool entries and unrelated options are preserved; an empty entry is removed.
 */
export function removeCodeExecutionCaller(
  toolOptions: AgentToolOptions | undefined,
): AgentToolOptions | undefined {
  if (toolOptions == null) {
    return toolOptions;
  }

  const normalized: AgentToolOptions = {};
  for (const [toolName, options] of Object.entries(toolOptions)) {
    const callers = options.allowed_callers;
    if (callers?.includes('code_execution') !== true) {
      normalized[toolName] = options;
      continue;
    }

    const allowedCallers = callers.filter(
      (caller): caller is AllowedCaller => caller !== 'code_execution',
    );
    const { allowed_callers: _removed, ...remainingOptions } = options;
    const nextOptions =
      allowedCallers.length > 0
        ? { ...remainingOptions, allowed_callers: allowedCallers }
        : remainingOptions;
    if (Object.keys(nextOptions).length > 0) {
      normalized[toolName] = nextOptions;
    }
  }

  return normalized;
}

export const switchableBuiltinTools = [
  Tools.web_search,
  Tools.execute_code,
  Tools.file_search,
] as const;

export type SwitchableBuiltinTool = (typeof switchableBuiltinTools)[number];

/** `tool_options` key for a whole MCP server (`sys__server__sys_mcp_<server>`). */
export function mcpServerToggleKey(serverName: string): string {
  return `${Constants.mcp_server}${Constants.mcp_delimiter}${serverName}`;
}

export interface AgentToolSwitches {
  /** Switchable built-ins attached to the agent; value = starts on. */
  builtins: Partial<Record<SwitchableBuiltinTool, boolean>>;
  /** Switchable attached MCP servers by name; value = starts on. */
  mcp: Record<string, boolean>;
}

type SwitchableAgent = Pick<Agent, 'tools' | 'tool_options'>;

const mcpServerTogglePrefix = mcpServerToggleKey('');

/** Configured names of the servers carrying a `user_toggle`, attached or not. */
export function getMCPSwitchServerNames(toolOptions: AgentToolOptions | undefined): string[] {
  return Object.entries(toolOptions ?? {})
    .filter(
      ([key, options]) => key.startsWith(mcpServerTogglePrefix) && options.user_toggle != null,
    )
    .map(([key]) => key.slice(mcpServerTogglePrefix.length));
}

/** Only the `user_toggle` of each entry, so a view-only reader learns nothing else. */
export function pickUserToggleOptions(
  toolOptions: AgentToolOptions | undefined,
): AgentToolOptions | undefined {
  if (toolOptions == null) {
    return undefined;
  }
  const picked: AgentToolOptions = {};
  for (const [key, options] of Object.entries(toolOptions)) {
    if (options.user_toggle != null) {
      picked[key] = { user_toggle: options.user_toggle };
    }
  }
  return picked;
}

/** Tool keys carry the normalized server name, which may itself contain the MCP
 *  delimiter; the switch servers' key names disambiguate the split. Placeholder and
 *  wildcard tokens may still carry the raw configured name, so that is normalized first. */
function toolServerName(
  tool: string,
  serverNames: string[],
  keyServerNames: string[],
): string | undefined {
  return splitMCPToolKey(normalizeMCPToolKey(tool, serverNames), keyServerNames)[1];
}

/** The creator's switchable set and defaults. Locked or unattached tools never appear. */
export function getAgentToolSwitches(agent: SwitchableAgent): AgentToolSwitches {
  const tools = agent.tools ?? [];
  const options = agent.tool_options ?? {};
  const switches: AgentToolSwitches = { builtins: {}, mcp: {} };
  for (const tool of switchableBuiltinTools) {
    const toggle = options[tool]?.user_toggle;
    if (toggle != null && tools.includes(tool)) {
      switches.builtins[tool] = toggle === 'on';
    }
  }
  const serverNames = getMCPSwitchServerNames(options);
  const keyServerNames = serverNames.map(normalizeServerName);
  const attached = new Set(tools.map((tool) => toolServerName(tool, serverNames, keyServerNames)));
  serverNames.forEach((serverName, index) => {
    if (attached.has(keyServerNames[index])) {
      switches.mcp[serverName] = options[mcpServerToggleKey(serverName)]?.user_toggle === 'on';
    }
  });
  return switches;
}

/** The agent's tools after applying the chat's untrusted switch state. Only ever removes. */
export function applyAgentToolSwitches(
  agent: SwitchableAgent,
  requested: TEphemeralAgent | null | undefined,
): { tools: string[]; mcp: string[] } {
  const tools = agent.tools ?? [];
  const { builtins, mcp } = getAgentToolSwitches(agent);
  const dropped = new Set<string>();
  for (const tool of switchableBuiltinTools) {
    const requestedValue = requested?.[tool];
    const defaultValue = builtins[tool];
    const isOn = typeof requestedValue === 'boolean' ? requestedValue : defaultValue;
    if (defaultValue != null && !isOn) {
      dropped.add(tool);
    }
  }
  const requestedServers = Array.isArray(requested?.mcp) ? requested.mcp : undefined;
  const serverNames = getMCPSwitchServerNames(agent.tool_options);
  const keyServerNames = serverNames.map(normalizeServerName);
  const offServers = new Set(
    Object.entries(mcp)
      .filter(
        ([name, isDefaultOn]) =>
          !(requestedServers ? requestedServers.includes(name) : isDefaultOn),
      )
      .map(([name]) => normalizeServerName(name)),
  );
  const kept: string[] = [];
  const keptServers = new Set<string>();
  for (const tool of tools) {
    const serverName = toolServerName(tool, serverNames, keyServerNames);
    if (dropped.has(tool) || (serverName != null && offServers.has(serverName))) {
      continue;
    }
    kept.push(tool);
    if (serverName != null) {
      keptServers.add(serverName);
    }
  }
  return { tools: kept, mcp: Array.from(keptServers) };
}
