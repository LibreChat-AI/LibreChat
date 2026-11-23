import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { CapabilityToolNames } from './selection';
import { isDeferrableToolName } from './deferral';

type Callers = NonNullable<LCTool['allowed_callers']>;

/** An entry under the tool's own name wins, then the first capability marker that registered it. */
function resolveCallers(
  name: string,
  toolOptions: AgentToolOptions,
  capabilityToolNames?: CapabilityToolNames,
): Callers | undefined {
  const explicit = toolOptions[name]?.allowed_callers;
  if (explicit?.length) {
    return explicit;
  }
  for (const [marker, names] of capabilityToolNames ?? []) {
    const callers = toolOptions[marker]?.allowed_callers;
    if (callers?.length && names.includes(name)) {
      return callers;
    }
  }
  return undefined;
}

/**
 * Applies `tool_options[name | marker].allowed_callers` to system tools, the way the MCP
 * registry build already does for MCP tools. MCP entries are left alone (they were resolved
 * upstream), as are the orchestration tools, which must stay directly callable.
 */
export function applyToolCallers(params: {
  toolDefinitions: LCTool[];
  toolRegistry: LCToolRegistry | undefined;
  toolOptions: AgentToolOptions | undefined;
  capabilityToolNames?: CapabilityToolNames;
}): { toolDefinitions: LCTool[]; hasProgrammaticTools: boolean } {
  const { toolOptions, toolRegistry, capabilityToolNames } = params;
  let changed = false;
  const toolDefinitions = params.toolDefinitions.map((def) => {
    const entry = toolRegistry?.get(def.name);
    if (!toolOptions || entry?.toolType === 'mcp' || !isDeferrableToolName(def.name)) {
      return def;
    }
    const allowed_callers = resolveCallers(def.name, toolOptions, capabilityToolNames);
    if (!allowed_callers) {
      return def;
    }
    const next: LCTool = { ...entry, ...def, allowed_callers };
    toolRegistry?.set(def.name, next);
    changed = true;
    return next;
  });
  const result = changed ? toolDefinitions : params.toolDefinitions;
  return {
    toolDefinitions: result,
    hasProgrammaticTools: result.some((def) => def.allowed_callers?.includes('code_execution')),
  };
}
