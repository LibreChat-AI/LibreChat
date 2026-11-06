import { logger } from '@librechat/data-schemas';
import { Providers, SkillToolDefinition, ToolSearchToolDefinition } from '@librechat/agents';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import {
  isDeferrableToolName,
  applyDeferredToolLoading,
  synthesizeDeferralToolOptions,
} from './deferral';
import { createToolSearchDefinition } from '~/tools/classification';
import { overrideDeferLoadingForDiscoveredTools } from './run';
import { CHECK_BACKGROUND_TASK_NAME } from './background';
import { TOOL_SELECTION_WILDCARD } from './selection';

const def = (name: string): LCTool => ({
  name,
  description: `${name} description`,
  parameters: { type: 'object', properties: { input: { type: 'string' } } },
});

/** Definitions and registry entries as the system-tool registrars leave them: separate objects. */
function systemTools(names: string[]): { defs: LCTool[]; registry: LCToolRegistry } {
  const defs = names.map(def);
  const registry: LCToolRegistry = new Map(
    defs.map((d) => [d.name, { name: d.name, allowed_callers: ['direct'] } as LCTool]),
  );
  return { defs, registry };
}

const deferredNames = (defs: LCTool[]): string[] =>
  defs.filter((d) => d.defer_loading === true).map((d) => d.name);

describe('synthesizeDeferralToolOptions', () => {
  it('records `true` as a wildcard opt-in', () => {
    expect(synthesizeDeferralToolOptions({ modelSpec: { deferLoading: true } })).toEqual({
      [TOOL_SELECTION_WILDCARD]: { defer_loading: true },
    });
  });

  it('records a list as a wildcard opt-out plus the named opt-ins', () => {
    expect(
      synthesizeDeferralToolOptions({
        modelSpec: { deferLoading: ['execute_code', 'web_search'] },
      }),
    ).toEqual({
      [TOOL_SELECTION_WILDCARD]: { defer_loading: false },
      execute_code: { defer_loading: true },
      web_search: { defer_loading: true },
    });
  });

  it('returns nothing for `false`, an omitted field, or no spec', () => {
    expect(synthesizeDeferralToolOptions({ modelSpec: { deferLoading: false } })).toBeUndefined();
    expect(synthesizeDeferralToolOptions({ modelSpec: {} })).toBeUndefined();
    expect(synthesizeDeferralToolOptions({ modelSpec: null })).toBeUndefined();
  });
});

describe('applyDeferredToolLoading', () => {
  it('returns the same definitions untouched when no tool option asks for deferral', () => {
    const { defs, registry } = systemTools(['web_search', 'file_search']);
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { web_search: { run_in_background: true } },
    });
    expect(result.toolDefinitions).toBe(defs);
    expect(result.hasDeferredTools).toBe(false);
    expect(deferredNames(result.toolDefinitions)).toEqual([]);
  });

  it('passes an upstream MCP deferral through when it has nothing to add', () => {
    const { defs, registry } = systemTools(['web_search']);
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: undefined,
      hasDeferredTools: true,
    });
    expect(result.hasDeferredTools).toBe(true);
  });

  it('defers every eligible system tool under a wildcard and keeps orchestration tools bound', () => {
    const { defs, registry } = systemTools([
      'web_search',
      'file_search',
      'bash_tool',
      'read_file',
      SkillToolDefinition.name,
      CHECK_BACKGROUND_TASK_NAME,
    ]);
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { [TOOL_SELECTION_WILDCARD]: { defer_loading: true } },
    });

    expect(deferredNames(result.toolDefinitions)).toEqual([
      'web_search',
      'file_search',
      'bash_tool',
      'read_file',
    ]);
    expect(result.hasDeferredTools).toBe(true);
    const toolSearch = result.toolDefinitions.filter(
      (d) => d.name === ToolSearchToolDefinition.name,
    );
    expect(toolSearch).toHaveLength(1);
    expect(toolSearch[0].defer_loading).not.toBe(true);
    expect(registry.get(ToolSearchToolDefinition.name)?.allowed_callers).toEqual(['direct']);
  });

  it('gives each deferred tool one object shared by its definition and registry entry', () => {
    const { defs, registry } = systemTools(['web_search']);
    const original = defs[0];
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { web_search: { defer_loading: true } },
    });
    const deferred = result.toolDefinitions.find((d) => d.name === 'web_search');

    expect(deferred).toBe(registry.get('web_search'));
    expect(deferred).toMatchObject({
      name: 'web_search',
      description: original.description,
      parameters: original.parameters,
      allowed_callers: ['direct'],
      defer_loading: true,
    });
    expect(original.defer_loading).toBeUndefined();
  });

  it('binds a discovered system tool again once the run host restores it', () => {
    const { defs, registry } = systemTools(['web_search', 'file_search']);
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { [TOOL_SELECTION_WILDCARD]: { defer_loading: true } },
    });
    /** The SDK binds an event-driven definition by its own `defer_loading` flag. */
    const active = (defs: LCTool[]): string[] =>
      defs.filter((d) => d.defer_loading !== true).map((d) => d.name);

    expect(active(result.toolDefinitions)).toEqual([ToolSearchToolDefinition.name]);
    overrideDeferLoadingForDiscoveredTools(registry, new Set(['web_search']));
    expect(active(result.toolDefinitions)).toEqual(['web_search', ToolSearchToolDefinition.name]);
  });

  it('resolves a capability marker onto the tools that capability registered', () => {
    const { defs, registry } = systemTools(['web_search', 'bash_tool', 'read_file']);
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: {
        [TOOL_SELECTION_WILDCARD]: { defer_loading: false },
        execute_code: { defer_loading: true },
      },
      capabilityToolNames: new Map([['execute_code', ['bash_tool', 'read_file']]]),
    });
    expect(deferredNames(result.toolDefinitions)).toEqual(['bash_tool', 'read_file']);
  });

  it('lets an explicit per-tool opt-out win over the wildcard', () => {
    const { defs, registry } = systemTools(['web_search', 'file_search']);
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: {
        [TOOL_SELECTION_WILDCARD]: { defer_loading: true },
        web_search: { defer_loading: false },
      },
    });
    expect(deferredNames(result.toolDefinitions)).toEqual(['file_search']);
  });

  it('does not add a second tool_search when MCP classification already registered one', () => {
    const mcpTool: LCTool = { ...def('lookup_mcp_docs'), defer_loading: true };
    const toolSearch = createToolSearchDefinition();
    const registry: LCToolRegistry = new Map([
      [mcpTool.name, mcpTool],
      [toolSearch.name, { name: toolSearch.name, allowed_callers: ['direct'] }],
      ['web_search', { name: 'web_search', allowed_callers: ['direct'] }],
    ]);
    const result = applyDeferredToolLoading({
      toolDefinitions: [mcpTool, toolSearch, def('web_search')],
      toolRegistry: registry,
      toolOptions: { [TOOL_SELECTION_WILDCARD]: { defer_loading: true } },
      hasDeferredTools: true,
    });
    expect(
      result.toolDefinitions.filter((d) => d.name === ToolSearchToolDefinition.name),
    ).toHaveLength(1);
    expect(deferredNames(result.toolDefinitions)).toEqual(['lookup_mcp_docs', 'web_search']);
  });

  it('registers the Gemini-safe tool_search schema for Google agents', () => {
    const { defs, registry } = systemTools(['web_search']);
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { web_search: { defer_loading: true } },
      provider: Providers.GOOGLE,
    });
    const toolSearch = result.toolDefinitions.find((d) => d.name === ToolSearchToolDefinition.name);
    expect(toolSearch?.parameters).toEqual(createToolSearchDefinition(Providers.GOOGLE).parameters);
    expect(toolSearch?.parameters).not.toEqual(createToolSearchDefinition().parameters);
  });

  it('warns about selected names that matched no deferrable tool', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const { defs, registry } = systemTools(['web_search']);
    applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: {
        [TOOL_SELECTION_WILDCARD]: { defer_loading: false },
        web_search: { defer_loading: true },
        web_serch: { defer_loading: true },
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('web_serch'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('web_search,'));
    warn.mockRestore();
  });

  it('leaves the definitions alone without a registry to restore them from', () => {
    const defs = [def('web_search')];
    const result = applyDeferredToolLoading({
      toolDefinitions: defs,
      toolRegistry: undefined,
      toolOptions: { [TOOL_SELECTION_WILDCARD]: { defer_loading: true } },
    });
    expect(result.toolDefinitions).toBe(defs);
    expect(result.hasDeferredTools).toBe(false);
  });
});

describe('isDeferrableToolName', () => {
  it('excludes the tools that find, orchestrate, or are invoked from instructions', () => {
    expect(isDeferrableToolName(ToolSearchToolDefinition.name)).toBe(false);
    expect(isDeferrableToolName(SkillToolDefinition.name)).toBe(false);
    expect(isDeferrableToolName(CHECK_BACKGROUND_TASK_NAME)).toBe(false);
    expect(isDeferrableToolName('web_search')).toBe(true);
  });
});
