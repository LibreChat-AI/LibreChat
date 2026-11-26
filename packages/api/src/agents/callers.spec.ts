import type { LCTool, LCToolRegistry } from '@librechat/agents';
import type { AgentToolOptions } from 'librechat-data-provider';
import {
  applyToolCallers,
  isDirectOnlyTool,
  declareDirectOnly,
  resolveAllowedCallers,
  allowCodeExecutionCallers,
  synthesizeCallerToolOptions,
} from './callers';
import { buildToolRegistryFromAgentOptions } from '~/tools/classification';
import { synthesizeToggleToolOptions } from './toggles';
import { TOOL_SELECTION_WILDCARD } from './selection';

const MARKER = 'example_marker';
const READ_TOOL = 'read_example';
const WRITE_TOOL = 'write_example';

const specOptions = (programmaticTools: boolean | string[]): AgentToolOptions | undefined =>
  synthesizeToggleToolOptions({ modelSpec: { programmaticTools } });

/** Mirrors a marker registrar: definitions and registry entries are the same objects. */
function registerMarkerTools(): { defs: LCTool[]; registry: LCToolRegistry } {
  const read = allowCodeExecutionCallers<LCTool>({ name: READ_TOOL });
  const write = declareDirectOnly(allowCodeExecutionCallers<LCTool>({ name: WRITE_TOOL }));
  const host: LCTool = { name: 'host_tool' };
  const defs = [read, write, host];
  return { defs, registry: new Map(defs.map((def) => [def.name, def])) };
}

const capabilityToolNames = new Map([[MARKER, [READ_TOOL, WRITE_TOOL]]]);

const callersOf = (defs: LCTool[] | undefined): Record<string, unknown> =>
  Object.fromEntries((defs ?? []).map((def) => [def.name, def.allowed_callers]));

describe('synthesizeCallerToolOptions', () => {
  it('records true as a wildcard that keeps direct calls', () => {
    expect(synthesizeCallerToolOptions({ modelSpec: { programmaticTools: true } })).toEqual({
      [TOOL_SELECTION_WILDCARD]: { allowed_callers: ['direct', 'code_execution'] },
    });
  });

  it('records a list as a direct-only wildcard plus the named entries', () => {
    expect(
      synthesizeCallerToolOptions({ modelSpec: { programmaticTools: [MARKER, '*'] } }),
    ).toEqual({
      [TOOL_SELECTION_WILDCARD]: { allowed_callers: ['direct'] },
      [MARKER]: { allowed_callers: ['direct', 'code_execution'] },
    });
  });

  it('records nothing when the spec is silent or false', () => {
    expect(synthesizeCallerToolOptions({ modelSpec: {} })).toBeUndefined();
    expect(
      synthesizeCallerToolOptions({ modelSpec: { programmaticTools: false } }),
    ).toBeUndefined();
  });

  it('composes with the other spec selections', () => {
    expect(
      synthesizeToggleToolOptions({ modelSpec: { deferLoading: true, programmaticTools: true } }),
    ).toEqual({
      [TOOL_SELECTION_WILDCARD]: {
        defer_loading: true,
        allowed_callers: ['direct', 'code_execution'],
      },
    });
  });
});

describe('applyToolCallers', () => {
  it('returns the definitions unchanged when no caller policy is present', () => {
    const { defs, registry } = registerMarkerTools();
    const result = applyToolCallers({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { [READ_TOOL]: { defer_loading: true } },
      capabilityToolNames,
    });
    expect(result.toolDefinitions).toBe(defs);
    expect(callersOf(result.toolDefinitions)).toEqual({
      [READ_TOOL]: undefined,
      [WRITE_TOOL]: undefined,
      host_tool: undefined,
    });
  });

  it("lets a model-spec wildcard reach a marker's expanded tools, except direct-only ones", () => {
    const { defs, registry } = registerMarkerTools();
    const result = applyToolCallers({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: specOptions(true),
      capabilityToolNames,
    });
    expect(callersOf(result.toolDefinitions)).toEqual({
      [READ_TOOL]: ['direct', 'code_execution'],
      [WRITE_TOOL]: undefined,
      host_tool: undefined,
    });
    const read = result.toolDefinitions?.find((def) => def.name === READ_TOOL);
    expect(registry.get(READ_TOOL)).toBe(read);
    expect(defs[0].allowed_callers).toBeUndefined();
  });

  it('lets a spec list that names the marker reach its expanded tools', () => {
    const { defs, registry } = registerMarkerTools();
    const result = applyToolCallers({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: specOptions([MARKER]),
      capabilityToolNames,
    });
    expect(callersOf(result.toolDefinitions)[READ_TOOL]).toEqual(['direct', 'code_execution']);
    expect(callersOf(result.toolDefinitions)[WRITE_TOOL]).toBeUndefined();
  });

  it('keeps a direct-only tool direct under every config value', () => {
    const policies: AgentToolOptions[] = [
      { [TOOL_SELECTION_WILDCARD]: { allowed_callers: ['code_execution'] } },
      { [MARKER]: { allowed_callers: ['direct', 'code_execution'] } },
      { [WRITE_TOOL]: { allowed_callers: ['code_execution'] } },
    ];
    for (const toolOptions of policies) {
      const { defs, registry } = registerMarkerTools();
      const result = applyToolCallers({
        toolDefinitions: defs,
        toolRegistry: registry,
        toolOptions,
        capabilityToolNames,
      });
      const write = result.toolDefinitions?.find((def) => def.name === WRITE_TOOL);
      expect(write?.allowed_callers ?? ['direct']).toEqual(['direct']);
      expect(registry.get(WRITE_TOOL)?.allowed_callers ?? ['direct']).toEqual(['direct']);
    }
  });

  it('clamps a direct-only tool whose registry entry was widened, and keeps the pin on copies', () => {
    const write = declareDirectOnly<LCTool>({ name: WRITE_TOOL });
    const registry: LCToolRegistry = new Map([
      [WRITE_TOOL, { name: WRITE_TOOL, allowed_callers: ['direct', 'code_execution'] }],
    ]);
    const result = applyToolCallers({
      toolDefinitions: [{ ...write }],
      toolRegistry: registry,
      toolOptions: specOptions(true),
    });
    expect(isDirectOnlyTool(result.toolDefinitions?.[0])).toBe(true);
    expect(registry.get(WRITE_TOOL)?.allowed_callers).toEqual(['direct']);
  });

  it('leaves tools that never allowed caller selection as their registrar set them', () => {
    const host: LCTool = { name: 'host_tool', allowed_callers: ['direct'] };
    const result = applyToolCallers({
      toolDefinitions: [host],
      toolRegistry: new Map([[host.name, host]]),
      toolOptions: { host_tool: { allowed_callers: ['code_execution'] }, ...specOptions(true) },
    });
    expect(result.toolDefinitions?.[0]).toBe(host);
  });
});

describe('MCP registry callers', () => {
  const mcpTools = [{ name: 'search_mcp_github' }, { name: 'issues_mcp_github' }];

  it('reads an explicit saved entry and defaults the rest to direct', () => {
    const registry = buildToolRegistryFromAgentOptions(mcpTools, {
      search_mcp_github: { allowed_callers: ['code_execution'] },
    });
    expect(registry.get('search_mcp_github')?.allowed_callers).toEqual(['code_execution']);
    expect(registry.get('issues_mcp_github')?.allowed_callers).toEqual(['direct']);
  });

  it('lets a model-spec wildcard reach MCP tools, with saved entries taking precedence', () => {
    const registry = buildToolRegistryFromAgentOptions(mcpTools, {
      ...specOptions(true),
      issues_mcp_github: { allowed_callers: ['direct'] },
    });
    expect(registry.get('search_mcp_github')?.allowed_callers).toEqual([
      'direct',
      'code_execution',
    ]);
    expect(registry.get('issues_mcp_github')?.allowed_callers).toEqual(['direct']);
  });

  it('marks MCP registry entries as allowing caller selection', () => {
    const registry = buildToolRegistryFromAgentOptions(mcpTools, {});
    const entry = registry.get('search_mcp_github');
    expect(entry).toBeDefined();
    expect(
      resolveAllowedCallers('search_mcp_github', entry as LCTool, specOptions(true))?.callers,
    ).toEqual(['direct', 'code_execution']);
  });
});
