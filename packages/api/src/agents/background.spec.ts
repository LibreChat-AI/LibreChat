import { logger } from '@librechat/data-schemas';
import { InMemorySubagentTaskStore } from '@librechat/agents';
import type {
  LCTool,
  LCToolRegistry,
  SubagentTaskConfig,
  SubagentTaskRuntime,
} from '@librechat/agents';
import type { HostSubagentTaskConfig } from './subagentDelivery';
import {
  isBackgroundEligibleToolName,
  isBackgroundRequested,
  stripRunInBackgroundArg,
  injectRunInBackgroundParam,
  stripBackgroundFromToolDefinitions,
  stripBackgroundFromToolRegistry,
  applyBackgroundToolCalls,
  synthesizeBackgroundToolOptions,
  registerBackgroundTaskTool,
  buildBackgroundCapacityContent,
  buildBackgroundHandleContent,
  runCheckBackgroundTask,
  getBackgroundCodeDelivery,
  backgroundTaskRegistry,
  BackgroundTaskRegistryClass,
  CHECK_BACKGROUND_TASK_NAME,
  RUN_IN_BACKGROUND_ARG,
} from './background';
import { parseBackgroundHandle } from '../../../../client/src/components/Chat/Messages/Content/Parts/handle';
import { SUBAGENT_COMPLETION_DELIVERY, SUBAGENT_WAKEUP_GUIDANCE } from './subagentDelivery';
import { SubagentTaskOwnerUnavailableError } from './subagentTaskRouting';
import { TOOL_SELECTION_WILDCARD } from './selection';
import { toolOptionsSchema } from './validation';

const mcpDef = (name: string): LCTool =>
  ({
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  }) as unknown as LCTool;

async function waitForSubagentTaskToSettle(
  store: InMemorySubagentTaskStore,
  scopeId: string,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (store.get(scopeId, taskId)?.status !== 'running') {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the detached subagent task.');
}

describe('isBackgroundEligibleToolName', () => {
  it('excludes direct-path, host-special, and machinery tools', () => {
    for (const name of [
      'read_file',
      'skill',
      'tool_search',
      'run_tools_with_code',
      'run_tools_with_bash',
      'subagent',
      'create_file',
      'edit_file',
      'set_memory',
      'delete_memory',
      'ask_user_question',
      'web_search',
      'file_search',
      'dalle',
      'dall-e',
      'stable-diffusion',
      'flux',
      'gemini_image_gen',
      'image_gen_oai',
      'image_edit_oai',
      CHECK_BACKGROUND_TASK_NAME,
      'lc_transfer_to_researcher',
    ]) {
      expect(isBackgroundEligibleToolName(name)).toBe(false);
    }
  });

  it('allows MCP and other event-driven tools', () => {
    for (const name of ['search_mcp_docs', 'lookup_customer', 'fetch_weather']) {
      expect(isBackgroundEligibleToolName(name)).toBe(true);
    }
  });

  it('allows the code-execution pair (natively backgroundable)', () => {
    expect(isBackgroundEligibleToolName('execute_code')).toBe(true);
    expect(isBackgroundEligibleToolName('bash_tool')).toBe(true);
  });
});

describe('isBackgroundRequested / stripRunInBackgroundArg', () => {
  it('detects the flag only when explicitly true on an object', () => {
    expect(isBackgroundRequested({ [RUN_IN_BACKGROUND_ARG]: true })).toBe(true);
    expect(isBackgroundRequested({ [RUN_IN_BACKGROUND_ARG]: false })).toBe(false);
    expect(isBackgroundRequested({})).toBe(false);
    expect(isBackgroundRequested('run_in_background')).toBe(false);
    expect(isBackgroundRequested(undefined)).toBe(false);
    expect(isBackgroundRequested(null)).toBe(false);
  });

  it('strips the flag without mutating the original', () => {
    const args = { q: 'hi', [RUN_IN_BACKGROUND_ARG]: true };
    const stripped = stripRunInBackgroundArg(args) as Record<string, unknown>;
    expect(stripped).toEqual({ q: 'hi' });
    expect(RUN_IN_BACKGROUND_ARG in args).toBe(true);
  });

  it('returns non-object / flagless args unchanged', () => {
    expect(stripRunInBackgroundArg('str')).toBe('str');
    const noFlag = { q: 'hi' };
    expect(stripRunInBackgroundArg(noFlag)).toBe(noFlag);
  });

  it('handles stringified JSON args', () => {
    expect(isBackgroundRequested('{"run_in_background":true,"q":"x"}')).toBe(true);
    expect(isBackgroundRequested('{"q":"x"}')).toBe(false);
    expect(isBackgroundRequested('not json')).toBe(false);
    expect(stripRunInBackgroundArg('{"run_in_background":true,"q":"x"}')).toEqual({ q: 'x' });
    // flag absent -> string returned unchanged (no shape rewrite)
    expect(stripRunInBackgroundArg('{"q":"x"}')).toBe('{"q":"x"}');
  });
});

describe('injectRunInBackgroundParam', () => {
  it('preserves required command fields across injection and inherited-definition cleanup', () => {
    const definition = {
      name: 'bash_tool',
      description: 'Starts a command',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    } as LCTool;
    const injected = injectRunInBackgroundParam(definition);
    expect(injected.parameters?.required).toEqual(['command']);
    expect(injected.name).toBe('bash_tool');
    const [restored] = stripBackgroundFromToolDefinitions([injected], ['bash_tool']);
    expect(restored.parameters?.required).toEqual(['command']);
    expect(restored.parameters?.properties).toEqual(definition.parameters?.properties);
  });
  it('adds a run_in_background boolean without mutating a frozen def', () => {
    const def = Object.freeze(mcpDef('search_mcp_docs'));
    const injected = injectRunInBackgroundParam(def);
    const props = (injected.parameters as { properties: Record<string, { type: string }> })
      .properties;
    expect(props[RUN_IN_BACKGROUND_ARG]).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(props.q).toEqual({ type: 'string' });
    // original untouched
    expect(RUN_IN_BACKGROUND_ARG in (def.parameters as { properties: object }).properties).toBe(
      false,
    );
  });

  it('creates an object schema when the tool declares no parameters', () => {
    const def = { name: 'no_params' } as unknown as LCTool;
    const injected = injectRunInBackgroundParam(def);
    const params = injected.parameters as { type: string; properties: Record<string, unknown> };
    expect(params.type).toBe('object');
    expect(params.properties[RUN_IN_BACKGROUND_ARG]).toBeDefined();
  });

  it('is a no-op when the param already exists', () => {
    const def = mcpDef('search_mcp_docs');
    const once = injectRunInBackgroundParam(def);
    const twice = injectRunInBackgroundParam(once);
    expect(twice).toBe(once);
  });
});

describe('applyBackgroundToolCalls', () => {
  it('is a no-op when no tool opted in (returns the same defs, registers nothing)', () => {
    const defs = [mcpDef('search_mcp_docs')];
    const registry: LCToolRegistry = new Map();
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { search_mcp_docs: { defer_loading: true } },
    });
    expect(result.toolDefinitions).toBe(defs);
    expect(result.backgroundToolNames).toEqual([]);
    expect(registry.has(CHECK_BACKGROUND_TASK_NAME)).toBe(false);
  });

  it('injects only opted-in eligible tools and registers the poll tool', () => {
    const defs = [mcpDef('search_mcp_docs'), mcpDef('lookup_customer')];
    const registry: LCToolRegistry = new Map(defs.map((d) => [d.name, { ...d }]));
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { search_mcp_docs: { run_in_background: true } },
    });
    expect(result.backgroundToolNames).toEqual(['search_mcp_docs']);

    const searchDef = result.toolDefinitions.find((d) => d.name === 'search_mcp_docs');
    const lookupDef = result.toolDefinitions.find((d) => d.name === 'lookup_customer');
    expect(
      (searchDef?.parameters as { properties: Record<string, unknown> }).properties[
        RUN_IN_BACKGROUND_ARG
      ],
    ).toBeDefined();
    expect(
      (lookupDef?.parameters as { properties: Record<string, unknown> }).properties[
        RUN_IN_BACKGROUND_ARG
      ],
    ).toBeUndefined();

    expect(result.toolDefinitions.some((d) => d.name === CHECK_BACKGROUND_TASK_NAME)).toBe(true);
    expect(registry.has(CHECK_BACKGROUND_TASK_NAME)).toBe(true);
    // registry entry for the opted-in tool also carries the injected param
    expect(
      (registry.get('search_mcp_docs')?.parameters as { properties: Record<string, unknown> })
        .properties[RUN_IN_BACKGROUND_ARG],
    ).toBeDefined();
  });

  it('does not inject or register when an opted-in tool is excluded', () => {
    const defs = [mcpDef('read_file')];
    const registry: LCToolRegistry = new Map();
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { read_file: { run_in_background: true } },
    });
    expect(result.backgroundToolNames).toEqual([]);
    expect(registry.has(CHECK_BACKGROUND_TASK_NAME)).toBe(false);
  });

  it('skips a tool the host excludeTool predicate rejects (e.g. ephemeral MCP server)', () => {
    const defs = [mcpDef('ephemeral_mcp__body_server'), mcpDef('search_mcp_docs')];
    const registry: LCToolRegistry = new Map(defs.map((d) => [d.name, { ...d }]));
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: {
        ephemeral_mcp__body_server: { run_in_background: true },
        search_mcp_docs: { run_in_background: true },
      },
      excludeTool: (name) => name === 'ephemeral_mcp__body_server',
    });
    expect(result.backgroundToolNames).toEqual(['search_mcp_docs']);
    const ephemeralDef = result.toolDefinitions.find(
      (d) => d.name === 'ephemeral_mcp__body_server',
    );
    expect(
      (ephemeralDef?.parameters as { properties?: Record<string, unknown> }).properties?.[
        RUN_IN_BACKGROUND_ARG
      ],
    ).toBeUndefined();
  });

  it('resolves an action opt-in stored with the raw `---` domain against the collapsed def name', () => {
    /** Agents persist `swapi---tech`; the runtime def is named `swapi_tech`. */
    const defs = [mcpDef('getPerson_action_swapi_tech')];
    const registry: LCToolRegistry = new Map(defs.map((d) => [d.name, { ...d }]));
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { 'getPerson_action_swapi---tech': { run_in_background: true } },
    });
    expect(result.backgroundToolNames).toEqual(['getPerson_action_swapi_tech']);
    expect(registry.has(CHECK_BACKGROUND_TASK_NAME)).toBe(true);
  });

  it('merges a raw action opt-in into an existing normalized option entry', () => {
    const defs = [mcpDef('getPerson_action_swapi_tech')];
    const registry: LCToolRegistry = new Map(defs.map((d) => [d.name, { ...d }]));
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: {
        'getPerson_action_swapi---tech': { run_in_background: true },
        getPerson_action_swapi_tech: { defer_loading: true },
      },
    });
    expect(result.backgroundToolNames).toEqual(['getPerson_action_swapi_tech']);
  });

  it('keeps an explicit normalized action background option authoritative', () => {
    const defs = [mcpDef('getPerson_action_swapi_tech')];
    const registry: LCToolRegistry = new Map(defs.map((d) => [d.name, { ...d }]));
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: {
        'getPerson_action_swapi---tech': { run_in_background: true },
        getPerson_action_swapi_tech: { run_in_background: false },
      },
    });
    expect(result.backgroundToolNames).toEqual([]);
  });

  it('does not collapse hyphens in the operationId when normalizing an action key', () => {
    const defs = [
      mcpDef('get_foo---bar_action_swapi_tech'),
      mcpDef('get_foo_bar_action_swapi_tech'),
    ];
    const registry: LCToolRegistry = new Map(defs.map((d) => [d.name, { ...d }]));
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: { 'get_foo---bar_action_swapi---tech': { run_in_background: true } },
    });
    expect(result.backgroundToolNames).toEqual(['get_foo---bar_action_swapi_tech']);
  });

  it('injects an opted-in action tool but not one the OAuth excludeTool rejects', () => {
    const oauthActionNames = new Set(['sendMail_action_mail---example---com']);
    const defs = [
      mcpDef('getWeather_action_weather---com'),
      mcpDef('sendMail_action_mail---example---com'),
    ];
    const registry: LCToolRegistry = new Map(defs.map((d) => [d.name, { ...d }]));
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: {
        'getWeather_action_weather---com': { run_in_background: true },
        'sendMail_action_mail---example---com': { run_in_background: true },
      },
      excludeTool: (name) => oauthActionNames.has(name),
    });
    expect(result.backgroundToolNames).toEqual(['getWeather_action_weather---com']);
    const oauthDef = result.toolDefinitions.find(
      (d) => d.name === 'sendMail_action_mail---example---com',
    );
    expect(
      (oauthDef?.parameters as { properties?: Record<string, unknown> }).properties?.[
        RUN_IN_BACKGROUND_ARG
      ],
    ).toBeUndefined();
  });

  it('skips a non-object (string-input) schema without rewriting it', () => {
    const defs = [{ name: 'legacy_tool', parameters: { type: 'string' } } as unknown as LCTool];
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: new Map(),
      toolOptions: { legacy_tool: { run_in_background: true } },
    });
    expect(result.backgroundToolNames).toEqual([]);
    expect((result.toolDefinitions[0].parameters as { type: string }).type).toBe('string');
  });

  it('skips a tool that already declares its own run_in_background param', () => {
    const defs = [
      {
        name: 'owns_it',
        parameters: { type: 'object', properties: { run_in_background: { type: 'boolean' } } },
      } as unknown as LCTool,
    ];
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: new Map(),
      toolOptions: { owns_it: { run_in_background: true } },
    });
    expect(result.backgroundToolNames).toEqual([]);
  });
});

describe('stripBackgroundFromToolDefinitions', () => {
  it('removes the poll tool and the injected param (self-spawn sanitization)', () => {
    const injected = injectRunInBackgroundParam(mcpDef('search_mcp_docs'));
    const withPoll = registerBackgroundTaskTool({
      toolRegistry: new Map(),
      toolDefinitions: [injected],
    }).toolDefinitions;
    const stripped = stripBackgroundFromToolDefinitions(withPoll, ['search_mcp_docs']);
    expect(stripped.some((d) => d.name === CHECK_BACKGROUND_TASK_NAME)).toBe(false);
    const search = stripped.find((d) => d.name === 'search_mcp_docs');
    expect(
      (search?.parameters as { properties: Record<string, unknown> }).properties[
        RUN_IN_BACKGROUND_ARG
      ],
    ).toBeUndefined();
  });
});

describe('registerBackgroundTaskTool', () => {
  it('adds the poll tool once (idempotent)', () => {
    const registry: LCToolRegistry = new Map();
    const first = registerBackgroundTaskTool({ toolRegistry: registry, toolDefinitions: [] });
    expect(first.toolDefinitions).toHaveLength(1);
    const second = registerBackgroundTaskTool({
      toolRegistry: registry,
      toolDefinitions: first.toolDefinitions,
    });
    expect(second.toolDefinitions).toHaveLength(1);
  });

  it('reserves the name: shadows a colliding non-poll tool with the host poll schema', () => {
    const collidingDef = {
      name: CHECK_BACKGROUND_TASK_NAME,
      description: 'a user MCP tool that happens to share the name',
      parameters: { type: 'object', properties: {} },
    } as unknown as LCTool;
    const registry: LCToolRegistry = new Map([[CHECK_BACKGROUND_TASK_NAME, { ...collidingDef }]]);
    const result = registerBackgroundTaskTool({
      toolRegistry: registry,
      toolDefinitions: [collidingDef],
    });
    const matching = result.toolDefinitions.filter((d) => d.name === CHECK_BACKGROUND_TASK_NAME);
    expect(matching).toHaveLength(1);
    // the surviving def/registry entry is the host poll tool, not the user's
    expect(matching[0].description).not.toBe(collidingDef.description);
    expect(registry.get(CHECK_BACKGROUND_TASK_NAME)?.description).not.toBe(
      collidingDef.description,
    );
  });

  it('advertises automatic delivery for wakeup-enabled background work', () => {
    const registry: LCToolRegistry = new Map();
    const manual = registerBackgroundTaskTool({ toolRegistry: registry, toolDefinitions: [] });
    const manualDescription = manual.toolDefinitions[0].description ?? '';
    expect(manualDescription).toContain('Results are not pushed to you');

    const automatic = registerBackgroundTaskTool({
      toolRegistry: registry,
      toolDefinitions: manual.toolDefinitions,
      subagentCompletionWakeups: true,
    });
    expect(automatic.toolDefinitions).toHaveLength(1);
    expect(automatic.toolDefinitions[0].description).toContain(
      'Background tools and detached subagents use automatic completion delivery',
    );
    expect(automatic.toolDefinitions[0].description).toContain(
      'Ordinary tool execution remains process-local',
    );
    expect(automatic.toolDefinitions[0].description).toContain(
      'A task is outstanding until its result is delivered',
    );
    expect(automatic.toolDefinitions[0].description).toContain(
      'Polling or cancelling a finished task retires its pending delivery',
    );
  });
});

describe('synthesizeBackgroundToolOptions', () => {
  it('returns undefined when neither the ephemeral toggle nor the model spec carries a policy', () => {
    expect(synthesizeBackgroundToolOptions({})).toBeUndefined();
    /** The ephemeral toggle is a badge default, not a decision — its `false`
     *  stays no-policy so the background-native code pair keeps its default. */
    expect(
      synthesizeBackgroundToolOptions({
        ephemeralAgent: { run_in_background: false },
      }),
    ).toBeUndefined();
  });

  it('records a spec runInBackground: false as an explicit "none", like the empty list', () => {
    /** Pre-native, `false` and absent were behaviorally identical (off); a
     *  config that wrote `false` must not silently flip to backgrounding code. */
    expect(synthesizeBackgroundToolOptions({ modelSpec: { runInBackground: false } })).toEqual({
      [TOOL_SELECTION_WILDCARD]: { run_in_background: false },
    });
  });

  it('records boolean/ephemeral modes as a wildcard opt-in (no name enumeration)', () => {
    const expected = { [TOOL_SELECTION_WILDCARD]: { run_in_background: true } };
    expect(synthesizeBackgroundToolOptions({ modelSpec: { runInBackground: true } })).toEqual(
      expected,
    );
    expect(
      synthesizeBackgroundToolOptions({ ephemeralAgent: { run_in_background: true } }),
    ).toEqual(expected);
  });

  it('records a list as a wildcard opt-out plus verbatim opt-ins', () => {
    expect(
      synthesizeBackgroundToolOptions({
        modelSpec: { runInBackground: ['slow_report_mcp_analytics', 'execute_code'] },
      }),
    ).toEqual({
      [TOOL_SELECTION_WILDCARD]: { run_in_background: false },
      slow_report_mcp_analytics: { run_in_background: true },
      execute_code: { run_in_background: true },
    });
  });

  it('treats an empty list as enabling nothing', () => {
    expect(synthesizeBackgroundToolOptions({ modelSpec: { runInBackground: [] } })).toEqual({
      [TOOL_SELECTION_WILDCARD]: { run_in_background: false },
    });
  });

  it('drops and warns about a literal wildcard in the list (reserved)', () => {
    /** `runInBackground: ['*']` would otherwise overwrite the opt-out default
     *  and detach-enable every eligible tool instead of selecting one. */
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    expect(
      synthesizeBackgroundToolOptions({
        modelSpec: { runInBackground: [TOOL_SELECTION_WILDCARD, 'search_mcp_docs'] },
      }),
    ).toEqual({
      [TOOL_SELECTION_WILDCARD]: { run_in_background: false },
      search_mcp_docs: { run_in_background: true },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reserved'));
    warn.mockRestore();
  });

  it('the ephemeral toggle stays global even when the spec narrows', () => {
    expect(
      synthesizeBackgroundToolOptions({
        ephemeralAgent: { run_in_background: true },
        modelSpec: { runInBackground: ['search_mcp_docs'] },
      }),
    ).toEqual({ [TOOL_SELECTION_WILDCARD]: { run_in_background: true } });
  });
});

describe('selection policy at injection time', () => {
  it('a wildcard opt-in reaches eligible definitions and skips excluded built-ins', () => {
    const toolOptions = synthesizeBackgroundToolOptions({ modelSpec: { runInBackground: true } });
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [
        mcpDef('search_mcp_overlay_server'),
        mcpDef('web_search'),
        mcpDef('ask_user_question'),
      ],
      toolRegistry: undefined,
      toolOptions,
    });
    expect(backgroundToolNames).toEqual(['search_mcp_overlay_server']);
  });

  it('keeps host-side workspace search in the foreground', () => {
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('search_workspace')],
      toolRegistry: undefined,
      toolOptions: { search_workspace: { run_in_background: true } },
    });
    expect(backgroundToolNames).toEqual([]);
  });

  it('keeps host-side workspace file listing in the foreground', () => {
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('list_workspace_files')],
      toolRegistry: undefined,
      toolOptions: { list_workspace_files: { run_in_background: true } },
    });
    expect(backgroundToolNames).toEqual([]);
  });

  it('rejects and diagnoses a marker whose runtime definitions are all excluded', () => {
    /** `runInBackground: ['memory']` used to record a successful-looking
     *  option under the marker while set_memory/delete_memory — the
     *  definitions it expands into — are background-excluded; nothing
     *  consumed the entry and nothing warned. */
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const toolOptions = synthesizeBackgroundToolOptions({
      modelSpec: { runInBackground: ['memory'] },
    });
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('set_memory'), mcpDef('delete_memory')],
      toolRegistry: undefined,
      toolOptions,
      capabilityToolNames: new Map([['memory', ['set_memory', 'delete_memory']]]),
    });
    expect(backgroundToolNames).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('memory'));
    warn.mockRestore();
  });

  it('projects a saved-agent execute_code entry onto the bash_tool definition', () => {
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('bash_tool')],
      toolRegistry: undefined,
      toolOptions: { execute_code: { run_in_background: true } },
      capabilityToolNames: new Map([['execute_code', ['read_file', 'bash_tool']]]),
    });
    expect(backgroundToolNames).toEqual(['bash_tool']);
  });

  it('backgrounds the code pair natively, with no tool_options at all', () => {
    const defs = [mcpDef('bash_tool'), mcpDef('search_mcp_docs')];
    const registry: LCToolRegistry = new Map(defs.map((d) => [d.name, { ...d }]));
    const result = applyBackgroundToolCalls({
      toolDefinitions: defs,
      toolRegistry: registry,
      toolOptions: undefined,
    });
    expect(result.backgroundToolNames).toEqual(['bash_tool']);
    const bashDef = result.toolDefinitions.find((d) => d.name === 'bash_tool');
    expect(
      (bashDef?.parameters as { properties: Record<string, unknown> }).properties[
        RUN_IN_BACKGROUND_ARG
      ],
    ).toBeDefined();
    const searchDef = result.toolDefinitions.find((d) => d.name === 'search_mcp_docs');
    expect(
      (searchDef?.parameters as { properties: Record<string, unknown> }).properties[
        RUN_IN_BACKGROUND_ARG
      ],
    ).toBeUndefined();
    expect(registry.has(CHECK_BACKGROUND_TASK_NAME)).toBe(true);
  });

  it('an explicit false opts the native pair out — by definition name or by marker projection', () => {
    const byName = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('bash_tool')],
      toolRegistry: new Map(),
      toolOptions: { bash_tool: { run_in_background: false } },
    });
    expect(byName.backgroundToolNames).toEqual([]);

    const registry: LCToolRegistry = new Map();
    const byMarker = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('bash_tool')],
      toolRegistry: registry,
      toolOptions: { execute_code: { run_in_background: false } },
      capabilityToolNames: new Map([['execute_code', ['read_file', 'bash_tool']]]),
    });
    expect(byMarker.backgroundToolNames).toEqual([]);
    expect(registry.has(CHECK_BACKGROUND_TASK_NAME)).toBe(false);
  });

  it('a narrowing selection that omits the code pair opts it out via the wildcard', () => {
    const options = synthesizeBackgroundToolOptions({
      modelSpec: { runInBackground: ['slow_report_mcp_analytics'] },
    });
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('bash_tool'), mcpDef('slow_report_mcp_analytics')],
      toolRegistry: undefined,
      toolOptions: options,
    });
    expect(backgroundToolNames).toEqual(['slow_report_mcp_analytics']);
  });

  it('a selection can name the code pair by its runtime name (bash_tool)', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const options = synthesizeBackgroundToolOptions({
      modelSpec: { runInBackground: ['bash_tool'] },
    });
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('bash_tool'), mcpDef('search_mcp_docs')],
      toolRegistry: undefined,
      toolOptions: options,
      capabilityToolNames: new Map([['execute_code', ['read_file', 'bash_tool']]]),
    });
    expect(backgroundToolNames).toEqual(['bash_tool']);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still enforces eligibility for explicitly named tools, and diagnoses them', () => {
    /** Backgrounding these would silently drop attachments/citations or break
     *  artifact continuity, so a list must not be able to force them on. */
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const toolOptions = synthesizeBackgroundToolOptions({
      modelSpec: { runInBackground: ['search_mcp_docs', 'web_search', 'ask_user_question'] },
    });
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [
        mcpDef('search_mcp_docs'),
        mcpDef('web_search'),
        mcpDef('ask_user_question'),
      ],
      toolRegistry: undefined,
      toolOptions,
    });
    expect(backgroundToolNames).toEqual(['search_mcp_docs']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('web_search'));
    warn.mockRestore();
  });

  it('warns about selection names the spec does not equip, rather than silently skipping', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const toolOptions = synthesizeBackgroundToolOptions({
      modelSpec: { runInBackground: ['search_mcp_docs', 'typo_tool_name'] },
    });
    const { backgroundToolNames } = applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('search_mcp_docs')],
      toolRegistry: undefined,
      toolOptions,
    });
    expect(backgroundToolNames).toEqual(['search_mcp_docs']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('typo_tool_name'));
    warn.mockRestore();
  });

  it('does not warn about saved-agent options with no narrowing policy', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    applyBackgroundToolCalls({
      toolDefinitions: [mcpDef('search_mcp_docs')],
      toolRegistry: undefined,
      toolOptions: { stale_tool: { run_in_background: true } },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('BackgroundTaskRegistryClass', () => {
  it('requests cancellation idempotently without settling or releasing running capacity', () => {
    const registry = new BackgroundTaskRegistryClass();
    const requestCancellation = jest.fn();
    const created = registry.create({
      userId: 'cancel-owner',
      conversationId: 'cancel-conversation',
      toolCallId: 'cancel-call',
      toolName: 'bash_tool',
      requestCancellation,
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }

    expect(
      registry.requestCancellation('other-owner', 'cancel-conversation', created.task.id),
    ).toEqual({ status: 'not_found' });
    expect(
      registry.requestCancellation('cancel-owner', 'other-conversation', created.task.id),
    ).toEqual({ status: 'not_found' });
    expect(
      registry.requestCancellation('cancel-owner', 'cancel-conversation', created.task.id).status,
    ).toBe('requested');
    expect(
      registry.requestCancellation('cancel-owner', 'cancel-conversation', created.task.id).status,
    ).toBe('already_requested');
    expect(requestCancellation).toHaveBeenCalledTimes(1);
    expect(created.task).toMatchObject({
      status: 'running',
      cancellationRequestedAt: expect.any(Number),
    });

    for (let index = 0; index < 9; index += 1) {
      const admitted = registry.create({
        userId: 'cancel-owner',
        conversationId: 'cancel-conversation',
        toolCallId: `other-call-${index}`,
        toolName: 'background-tool',
      });
      expect('atCapacity' in admitted).toBe(false);
    }
    expect(
      registry.create({
        userId: 'cancel-owner',
        conversationId: 'cancel-conversation',
        toolCallId: 'blocked-until-settlement',
        toolName: 'background-tool',
      }),
    ).toEqual({ atCapacity: true, scope: 'conversation_running' });

    registry.cancel(
      'cancel-owner',
      'cancel-conversation',
      created.task.id,
      'Background task cancellation requested',
    );
    expect(created.task.status).toBe('cancelled');
    expect(
      registry.create({
        userId: 'cancel-owner',
        conversationId: 'cancel-conversation',
        toolCallId: 'admitted-after-settlement',
        toolName: 'background-tool',
      }),
    ).toMatchObject({ isNew: true });
    expect(
      registry.requestCancellation('cancel-owner', 'cancel-conversation', created.task.id).status,
    ).toBe('settled');
  });

  it('lets actual completion win when an abort-resistant invocation settles successfully', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'race-owner',
      conversationId: 'race-conversation',
      toolCallId: 'race-call',
      toolName: 'mutation',
      requestCancellation: jest.fn(),
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }

    registry.requestCancellation('race-owner', 'race-conversation', created.task.id);
    registry.complete('race-owner', 'race-conversation', created.task.id, {
      content: 'completed despite cancellation request',
    });
    registry.cancel('race-owner', 'race-conversation', created.task.id, 'cancelled too late');

    expect(created.task).toMatchObject({
      status: 'completed',
      result: 'completed despite cancellation request',
    });
  });

  it('does not record a manual cancellation when another abort source already won', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'timeout-owner',
      conversationId: 'timeout-conversation',
      toolCallId: 'timeout-call',
      toolName: 'mutation',
      requestCancellation: () => false,
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }

    expect(
      registry.requestCancellation('timeout-owner', 'timeout-conversation', created.task.id),
    ).toMatchObject({ status: 'unavailable' });
    expect(created.task.cancellationRequestedAt).toBeUndefined();
  });

  it('creates, completes, and reads a task', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_1',
      toolName: 'search_mcp_docs',
    });
    expect('atCapacity' in created).toBe(false);
    if ('atCapacity' in created) {
      return;
    }
    expect(created.isNew).toBe(true);
    expect(created.task.status).toBe('running');

    registry.complete('u1', 'c1', created.task.id, { content: 'DONE' });
    const task = registry.get('u1', 'c1', created.task.id);
    expect(task?.status).toBe('completed');
    expect(task?.result).toBe('DONE');
  });

  it('stamps strictly-increasing createdAt even for same-millisecond dispatches', () => {
    /* `createdAt` orders writers in the stale-output guard, which accepts
     * equal stamps for idempotent re-commits — a wall-clock tie between two
     * DIFFERENT dispatches would let the older one overwrite the newer. */
    const registry = new BackgroundTaskRegistryClass();
    const frozenNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(frozenNow);
    try {
      const first = registry.create({
        userId: 'u1',
        conversationId: 'c1',
        toolCallId: 'call_a',
        toolName: 'execute_code',
      });
      const second = registry.create({
        userId: 'u1',
        conversationId: 'c1',
        toolCallId: 'call_b',
        toolName: 'execute_code',
      });
      if ('atCapacity' in first || 'atCapacity' in second) {
        throw new Error('unexpected capacity');
      }
      expect(second.task.createdAt).toBeGreaterThan(first.task.createdAt);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('is idempotent within the same run (never double-dispatches on replay)', () => {
    const registry = new BackgroundTaskRegistryClass();
    const first = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_dup',
      toolName: 'search_mcp_docs',
      runId: 'run-A',
    });
    const second = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_dup',
      toolName: 'search_mcp_docs',
      runId: 'run-A',
    });
    if ('atCapacity' in first || 'atCapacity' in second) {
      throw new Error('unexpected capacity');
    }
    expect(second.isNew).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });

  it('does NOT collide when the same provider toolCallId repeats in a later run/turn', () => {
    const registry = new BackgroundTaskRegistryClass();
    const turn1 = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_0',
      toolName: 'search_mcp_docs',
      runId: 'run-turn-1',
    });
    const turn2 = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_0',
      toolName: 'search_mcp_docs',
      runId: 'run-turn-2',
    });
    if ('atCapacity' in turn1 || 'atCapacity' in turn2) {
      throw new Error('unexpected capacity');
    }
    expect(turn2.isNew).toBe(true);
    expect(turn2.task.id).not.toBe(turn1.task.id);
  });

  it('does NOT collide when two agents in the same run emit the same toolCallId', () => {
    const registry = new BackgroundTaskRegistryClass();
    const agentA = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_0',
      toolName: 'search_mcp_docs',
      runId: 'run-1',
      agentId: 'agent-A',
    });
    const agentB = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_0',
      toolName: 'search_mcp_docs',
      runId: 'run-1',
      agentId: 'agent-B',
    });
    if ('atCapacity' in agentA || 'atCapacity' in agentB) {
      throw new Error('unexpected capacity');
    }
    expect(agentB.isNew).toBe(true);
    expect(agentB.task.id).not.toBe(agentA.task.id);
  });

  it('records failures', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_err',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.fail('u1', 'c1', created.task.id, 'boom');
    expect(registry.get('u1', 'c1', created.task.id)?.status).toBe('error');
    expect(registry.get('u1', 'c1', created.task.id)?.error).toBe('boom');
  });

  it('holds a completed artifact and claims it exactly once', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_art',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u1', 'c1', created.task.id, {
      content: 'DONE',
      artifact: { files: ['a.png'] },
    });
    expect(registry.get('u1', 'c1', created.task.id)?.artifact).toEqual({ files: ['a.png'] });

    const claimed = registry.claimArtifact('u1', 'c1', created.task.id);
    expect(claimed).toEqual({
      toolName: 'search_mcp_docs',
      toolCallId: 'call_art',
      artifact: { files: ['a.png'] },
      content: 'DONE',
    });
    // second claim yields nothing (delivered once), and the artifact is freed
    expect(registry.claimArtifact('u1', 'c1', created.task.id)).toBeUndefined();
    expect(registry.get('u1', 'c1', created.task.id)?.artifact).toBeUndefined();
  });

  it('keeps harvest state (messageId, attachments) independent of the one-shot artifact claim', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_code',
      toolName: 'execute_code',
      messageId: 'dispatch-msg',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u1', 'c1', created.task.id, {
      content: 'stdout',
      artifact: { session_id: 'exec-1', files: [{ id: 'f1' }] },
      harvestStarted: true,
    });
    registry.finishHarvest('u1', 'c1', created.task.id);

    const claimed = registry.claimArtifact('u1', 'c1', created.task.id);
    expect(claimed).toEqual({
      toolName: 'execute_code',
      toolCallId: 'call_code',
      messageId: 'dispatch-msg',
      harvestStarted: true,
      artifact: { session_id: 'exec-1', files: [{ id: 'f1' }] },
      content: 'stdout',
    });
    expect(registry.claimArtifact('u1', 'c1', created.task.id)).toBeUndefined();

    /** Attachments can land AFTER the artifact was claimed (harvest is
     *  detached) and stay retrievable on every later poll. */
    const attachments = [{ file_id: 'f1', toolCallId: 'call_code' }];
    registry.attachHarvest('u1', 'c1', created.task.id, attachments);
    expect(registry.get('u1', 'c1', created.task.id)?.attachments).toEqual(attachments);
  });

  it('releases claimed artifact capacity before detached harvest attachments arrive', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u-artifact-budget',
      conversationId: 'c-artifact-budget',
      toolCallId: 'call_code_budget',
      toolName: 'execute_code',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-artifact-budget', 'c-artifact-budget', created.task.id, {
      content: 'stdout',
      artifact: { payload: 'a'.repeat(9_000_000) },
    });
    expect(
      registry.claimArtifact('u-artifact-budget', 'c-artifact-budget', created.task.id),
    ).toBeDefined();

    const attachments = [{ payload: 'b'.repeat(8_000_000) }];
    registry.attachHarvest('u-artifact-budget', 'c-artifact-budget', created.task.id, attachments);
    expect(
      registry.get('u-artifact-budget', 'c-artifact-budget', created.task.id)?.attachments,
    ).toBe(attachments);
  });

  it('replaces retained attachments without double-counting their payload', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u-attachment-replace',
      conversationId: 'c-attachment-replace',
      toolCallId: 'call_attachment_replace',
      toolName: 'execute_code',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-attachment-replace', 'c-attachment-replace', created.task.id, {
      content: 'stdout',
    });
    const first = [{ payload: 'a'.repeat(9_000_000) }];
    const replacement = [{ payload: 'b'.repeat(9_000_000) }];
    registry.attachHarvest('u-attachment-replace', 'c-attachment-replace', created.task.id, first);
    registry.attachHarvest(
      'u-attachment-replace',
      'c-attachment-replace',
      created.task.id,
      replacement,
    );
    expect(
      registry.get('u-attachment-replace', 'c-attachment-replace', created.task.id)?.attachments,
    ).toBe(replacement);
  });

  it('revokeHarvest hands a pending artifact to the fallback path', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_code',
      toolName: 'execute_code',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    const artifact = { session_id: 'exec-1', files: [{ id: 'f1' }] };
    registry.complete('u1', 'c1', created.task.id, {
      content: 'stdout',
      artifact,
      harvestStarted: true,
    });

    /** Pending inspection prevents poll delivery until the harvest settles. */
    expect(registry.claimArtifact('u1', 'c1', created.task.id)).toBeUndefined();
    /** A transient harvest failure unlocks the artifact for the legacy
     *  fallback and clears the suppression flag. */
    registry.revokeHarvest('u1', 'c1', created.task.id, artifact);
    const task = registry.get('u1', 'c1', created.task.id);
    expect(task?.harvestStarted).toBeUndefined();
    expect(task?.artifact).toEqual(artifact);
    expect(registry.claimArtifact('u1', 'c1', created.task.id)?.harvestStarted).toBeUndefined();
  });

  it('keeps a policy-blocked artifact terminal across later registry mutations', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_code_blocked',
      toolName: 'execute_code',
      harvestStarted: true,
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    const artifact = {
      session_id: 'exec-blocked',
      files: [{ id: 'f1', opaqueBytes: 'PROTECTED-REGISTRY-BYTES' }],
    };
    registry.complete('u1', 'c1', created.task.id, {
      content: 'safe stdout',
      artifact,
      harvestStarted: true,
    });
    registry.blockArtifact(
      'u1',
      'c1',
      created.task.id,
      'Submitted content could not be completely inspected before processing.',
    );

    registry.restoreArtifact('u1', 'c1', created.task.id, artifact);
    registry.revokeHarvest('u1', 'c1', created.task.id, artifact);
    registry.finishHarvest('u1', 'c1', created.task.id, [{ opaqueBytes: artifact }]);
    registry.attachHarvest('u1', 'c1', created.task.id, [{ opaqueBytes: artifact }]);
    registry.complete('u1', 'c1', created.task.id, {
      content: 'unsafe replacement',
      artifact,
      harvestStarted: true,
    });
    registry.fail('u1', 'c1', created.task.id, 'raw failure');

    const task = registry.get('u1', 'c1', created.task.id);
    expect(task).toEqual(
      expect.objectContaining({
        status: 'error',
        error: 'Submitted content could not be completely inspected before processing.',
        artifactBlocked: true,
      }),
    );
    expect(task?.result).toBeUndefined();
    expect(task?.artifact).toBeUndefined();
    expect(task?.attachments).toBeUndefined();
    expect(task?.harvestStarted).toBeUndefined();
    expect(registry.claimArtifact('u1', 'c1', created.task.id)).toBeUndefined();
    expect(JSON.stringify(task)).not.toContain('PROTECTED-REGISTRY-BYTES');
    expect(JSON.stringify(task)).not.toContain('raw failure');
  });

  it('does not account payloads from rejected late completion updates', () => {
    const registry = new BackgroundTaskRegistryClass();
    const blocked = registry.create({
      userId: 'u-blocked-accounting',
      conversationId: 'c-blocked',
      toolCallId: 'call_blocked',
      toolName: 'execute_code',
    });
    if ('atCapacity' in blocked) {
      throw new Error('unexpected capacity');
    }
    registry.blockArtifact('u-blocked-accounting', 'c-blocked', blocked.task.id, 'blocked');
    registry.complete('u-blocked-accounting', 'c-blocked', blocked.task.id, {
      content: 'late',
      artifact: { payload: 'a'.repeat(10_000_000 - 20) },
    });

    const next = registry.create({
      userId: 'u-blocked-accounting',
      conversationId: 'c-next',
      toolCallId: 'call_next',
      toolName: 'execute_code',
    });
    if ('atCapacity' in next) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-blocked-accounting', 'c-next', next.task.id, {
      content: 'next',
      artifact: { payload: 'b'.repeat(8_000_000) },
    });
    expect(registry.get('u-blocked-accounting', 'c-blocked', blocked.task.id)?.error).toBe(
      'blocked',
    );
  });

  it('keeps abort-resistant tasks nonterminal instead of exposing false timeout evidence', () => {
    jest.useFakeTimers();
    try {
      const created = backgroundTaskRegistry.create({
        userId: 'reap_user',
        conversationId: 'reap_convo',
        toolCallId: 'call_reaped',
        toolName: 'execute_code',
        messageId: 'dispatch-msg',
        harvestStarted: true,
      });
      if ('atCapacity' in created) {
        throw new Error('unexpected capacity');
      }

      /** The invocation owner may have requested abort, but registry age alone
       * cannot prove that an external side effect stopped. */
      jest.advanceTimersByTime(31 * 60 * 1000);
      const delivery = getBackgroundCodeDelivery({
        userId: 'reap_user',
        conversationId: 'reap_convo',
        args: { background_task_id: created.task.id },
      });
      expect(delivery).toEqual(
        expect.objectContaining({
          status: 'running',
          toolCallId: 'call_reaped',
          messageId: 'dispatch-msg',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('fail() can mark a task harvested so failed code tasks join the heal path', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_code_err',
      toolName: 'execute_code',
      messageId: 'dispatch-msg',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.fail('u1', 'c1', created.task.id, 'Execution error:\n\nboom', {
      harvestStarted: true,
    });
    const task = registry.get('u1', 'c1', created.task.id);
    expect(task?.status).toBe('error');
    expect(task?.harvestStarted).toBe(true);
  });

  it('truncates an oversized stored result with an explicit marker (not a silent cut)', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_big',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u1', 'c1', created.task.id, { content: 'x'.repeat(150_000) });
    const stored = registry.get('u1', 'c1', created.task.id)?.result ?? '';
    expect(stored.length).toBeLessThanOrEqual(100_000);
    expect(stored).toContain('[truncated: 150000 chars exceeded 100000 limit]');
  });

  it('drops artifacts whose JSON serialization returns undefined', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u-unmeasurable',
      conversationId: 'c-unmeasurable',
      toolCallId: 'call_unmeasurable',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-unmeasurable', 'c-unmeasurable', created.task.id, {
      content: 'done',
      artifact: { payload: 'x'.repeat(1_000_000), toJSON: () => undefined },
    });
    expect(registry.get('u-unmeasurable', 'c-unmeasurable', created.task.id)?.artifact).toBe(
      undefined,
    );
  });

  it('retains only an artifact JSON projection without hidden object state', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u-hidden-artifact',
      conversationId: 'c-hidden-artifact',
      toolCallId: 'call_hidden_artifact',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    const artifact = { visible: 'safe' };
    Object.defineProperty(artifact, 'hidden', {
      value: 'x'.repeat(1_000_000),
      enumerable: false,
    });
    registry.complete('u-hidden-artifact', 'c-hidden-artifact', created.task.id, {
      content: 'done',
      artifact,
    });
    const stored = registry.get(
      'u-hidden-artifact',
      'c-hidden-artifact',
      created.task.id,
    )?.artifact;
    expect(stored).toEqual({ visible: 'safe' });
    expect(stored).not.toBe(artifact);
  });

  it('restores a claimed artifact after a failed delivery so a later claim retries', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_art_retry',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u1', 'c1', created.task.id, {
      content: 'DONE',
      artifact: { files: ['a.png'] },
    });

    const claimed = registry.claimArtifact('u1', 'c1', created.task.id);
    expect(claimed?.artifact).toEqual({ files: ['a.png'] });
    // delivery failed: restore, then a fresh claim gets the same artifact once
    registry.restoreArtifact('u1', 'c1', created.task.id, claimed?.artifact);
    expect(registry.claimArtifact('u1', 'c1', created.task.id)).toEqual({
      toolName: 'search_mcp_docs',
      toolCallId: 'call_art_retry',
      artifact: { files: ['a.png'] },
      content: 'DONE',
    });
    expect(registry.claimArtifact('u1', 'c1', created.task.id)).toBeUndefined();
  });

  it('does not reap an abort-resistant running task by wall clock alone', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_stuck',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    // Backdate past the abort deadline; only invocation settlement is terminal proof.
    created.task.createdAt = Date.now() - 31 * 60 * 1000;
    registry.list('u1', 'c1');
    expect(created.task.status).toBe('running');
    expect(created.task.error).toBeUndefined();
  });

  it('sweeps an expired completed task on direct get() (no indefinite retention)', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_old',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u1', 'c1', created.task.id, { content: 'X' });
    // backdate completion past the 1-hour completed TTL
    created.task.updatedAt = Date.now() - 61 * 60 * 1000;
    expect(registry.get('u1', 'c1', created.task.id)).toBeUndefined();
  });

  it.each(['completed', 'error', 'cancelled', 'blocked'] as const)(
    'preserves pending %s results through both TTLs and releases protection afterward',
    async (status) => {
      jest.useFakeTimers();
      try {
        const registry = new BackgroundTaskRegistryClass();
        const created = registry.create({
          userId: 'u',
          conversationId: 'c',
          toolCallId: 'call',
          toolName: 'execute_code',
          harvestStarted: true,
        });
        if ('atCapacity' in created) throw new Error('Unexpected capacity rejection');
        if (status === 'cancelled') registry.cancel('u', 'c', created.task.id, 'cancelled');
        else if (status === 'error') registry.fail('u', 'c', created.task.id, 'failed');
        else
          registry.complete('u', 'c', created.task.id, { content: 'result', harvestStarted: true });
        registry.markCompletionPersistencePending('u', 'c', created.task.id);
        registry.finishHarvest('u', 'c', created.task.id, [{ file_id: 'file' }]);
        if (status === 'blocked') registry.blockArtifact('u', 'c', created.task.id, 'blocked');
        registry.claimResult('u', 'c', created.task.id, { kind: 'manual', claimId: 'poll' });
        await jest.advanceTimersByTimeAsync(7 * 60 * 60_000);
        expect(registry.get('u', 'c', created.task.id)).toMatchObject({
          completionPersistencePending: true,
        });
        registry.markCompletionPersistenceFinished('u', 'c', created.task.id);
        expect(
          registry.get('u', 'c', created.task.id)?.completionPersistencePending,
        ).toBeUndefined();
        if (status === 'blocked')
          expect(registry.get('u', 'c', created.task.id)).toMatchObject({
            artifactBlocked: true,
            artifact: undefined,
          });
        if (status === 'completed')
          expect(registry.get('u', 'c', created.task.id)).toMatchObject({
            result: 'result',
            resultClaim: { kind: 'manual', claimId: 'poll' },
          });
        await jest.advanceTimersByTimeAsync(61 * 60_000);
        expect(registry.get('u', 'c', created.task.id)).toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('caps concurrent running tasks per conversation', () => {
    const registry = new BackgroundTaskRegistryClass();
    let atCapacity = false;
    for (let i = 0; i < 25; i++) {
      const created = registry.create({
        userId: 'u1',
        conversationId: 'c-cap',
        toolCallId: `call_${i}`,
        toolName: 'search_mcp_docs',
      });
      if ('atCapacity' in created) {
        atCapacity = true;
        break;
      }
    }
    expect(atCapacity).toBe(true);
  });

  it('caps concurrent running tasks per user across conversations', () => {
    const registry = new BackgroundTaskRegistryClass();
    for (let i = 0; i < 40; i++) {
      const created = registry.create({
        userId: 'u-cap',
        conversationId: `c-${i}`,
        toolCallId: `call_${i}`,
        toolName: 'search_mcp_docs',
      });
      expect('atCapacity' in created).toBe(false);
    }
    expect(
      registry.create({
        userId: 'u-cap',
        conversationId: 'c-rejected',
        toolCallId: 'call_rejected',
        toolName: 'search_mcp_docs',
      }),
    ).toEqual({ atCapacity: true, scope: 'user_running' });
  });

  it('describes aggregate capacity rejections without blaming the conversation', () => {
    const content = JSON.parse(buildBackgroundCapacityContent('search', 'user_running')) as {
      scope: string;
      message: string;
    };
    expect(content.scope).toBe('user_running');
    expect(content.message).toContain('for this user');
    expect(content.message).not.toContain('in this conversation');
  });

  it('caps concurrent running tasks process-wide', () => {
    const registry = new BackgroundTaskRegistryClass();
    for (let i = 0; i < 200; i++) {
      const created = registry.create({
        userId: `u-${i}`,
        conversationId: `c-${i}`,
        toolCallId: `call_${i}`,
        toolName: 'search_mcp_docs',
      });
      expect('atCapacity' in created).toBe(false);
    }
    expect(
      registry.create({
        userId: 'u-rejected',
        conversationId: 'c-rejected',
        toolCallId: 'call_rejected',
        toolName: 'search_mcp_docs',
      }),
    ).toEqual({ atCapacity: true, scope: 'global_running' });
  });

  it('holds capacity permits before task registration and releases them explicitly', () => {
    const registry = new BackgroundTaskRegistryClass();
    const permits = Array.from({ length: 10 }, (_, index) =>
      registry.reserveCapacity({
        userId: 'u1',
        conversationId: 'c-permits',
        toolCallId: `call_${index}`,
        runId: 'run-1',
      }),
    );
    expect(permits.every((result) => 'permit' in result)).toBe(true);
    expect(
      registry.reserveCapacity({
        userId: 'u1',
        conversationId: 'c-permits',
        toolCallId: 'call_rejected',
        runId: 'run-1',
      }),
    ).toEqual({ atCapacity: true, scope: 'conversation_running' });
    const first = permits[0];
    if (!('permit' in first)) {
      throw new Error('expected capacity permit');
    }
    registry.releaseCapacity(first.permit);
    const replacement = registry.reserveCapacity({
      userId: 'u1',
      conversationId: 'c-permits',
      toolCallId: 'call_replacement',
      runId: 'run-1',
    });
    if (!('permit' in replacement)) {
      throw new Error('expected replacement permit');
    }
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c-permits',
      toolCallId: 'call_replacement',
      toolName: 'search_mcp_docs',
      runId: 'run-1',
      capacityPermit: replacement.permit,
    });
    expect('atCapacity' in created).toBe(false);
  });

  it('retains an in-flight capacity permit until durable reservation completes', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_787_000_000_000);
    const registry = new BackgroundTaskRegistryClass();
    const admission = registry.reserveCapacity({
      userId: 'u1',
      conversationId: 'c-slow-reservation',
      toolCallId: 'call_slow',
      runId: 'run-1',
    });
    if (!('permit' in admission)) {
      throw new Error('expected capacity permit');
    }

    /** Cross both the former one-minute permit timeout and idle-bucket TTL.
     * A slow durable reservation still owns this slot until its caller
     * consumes or releases it. */
    now.mockReturnValue(1_787_000_000_000 + 7 * 60 * 60 * 1000);
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c-slow-reservation',
      toolCallId: 'call_slow',
      toolName: 'search_mcp_docs',
      runId: 'run-1',
      capacityPermit: admission.permit,
    });

    expect('atCapacity' in created).toBe(false);
    now.mockRestore();
  });

  it('evicts oldest settled tasks instead of blocking when the total cap is full', () => {
    const registry = new BackgroundTaskRegistryClass();
    for (let i = 0; i < 200; i++) {
      const created = registry.create({
        userId: 'u1',
        conversationId: 'c-full',
        toolCallId: `call_${i}`,
        toolName: 't',
        runId: 'r',
        agentId: 'a',
      });
      if ('atCapacity' in created) {
        throw new Error(`unexpected capacity at ${i}`);
      }
      registry.complete('u1', 'c-full', created.task.id, { content: 'x' });
    }
    // bucket now holds the max number of settled tasks; a new dispatch must
    // succeed by evicting the oldest settled task, not be rejected.
    const next = registry.create({
      userId: 'u1',
      conversationId: 'c-full',
      toolCallId: 'call_new',
      toolName: 't',
      runId: 'r',
      agentId: 'a',
    });
    expect('atCapacity' in next).toBe(false);
    if ('atCapacity' in next) {
      return;
    }
    expect(next.isNew).toBe(true);
    // total held stays bounded (one evicted, one added)
    expect(registry.list('u1', 'c-full')).toHaveLength(200);
  });

  it('evicts oldest settled tasks at the per-user cap across conversations', () => {
    const registry = new BackgroundTaskRegistryClass();
    let firstTaskId = '';
    let latestTaskId = '';
    for (let i = 0; i <= 400; i++) {
      const created = registry.create({
        userId: 'u-aggregate',
        conversationId: `c-${i}`,
        toolCallId: `call_${i}`,
        toolName: 't',
      });
      if ('atCapacity' in created) {
        throw new Error(`unexpected capacity at ${i}`);
      }
      firstTaskId ||= created.task.id;
      latestTaskId = created.task.id;
      registry.complete('u-aggregate', `c-${i}`, created.task.id, { content: 'x' });
    }
    expect(registry.get('u-aggregate', 'c-0', firstTaskId)).toBeUndefined();
    expect(registry.get('u-aggregate', 'c-400', latestTaskId)?.status).toBe('completed');
  });

  it('recreates a target bucket when aggregate eviction removes it', () => {
    const registry = new BackgroundTaskRegistryClass();
    for (let i = 0; i < 400; i++) {
      const created = registry.create({
        userId: 'u-reused-bucket',
        conversationId: `c-${i}`,
        toolCallId: `call_${i}`,
        toolName: 't',
      });
      if ('atCapacity' in created) {
        throw new Error(`unexpected capacity at ${i}`);
      }
      registry.complete('u-reused-bucket', `c-${i}`, created.task.id, { content: 'x' });
    }

    const replacement = registry.create({
      userId: 'u-reused-bucket',
      conversationId: 'c-0',
      toolCallId: 'call_replacement',
      toolName: 't',
    });
    if ('atCapacity' in replacement) {
      throw new Error('unexpected replacement capacity');
    }
    registry.complete('u-reused-bucket', 'c-0', replacement.task.id, { content: 'replacement' });
    expect(registry.get('u-reused-bucket', 'c-0', replacement.task.id)?.result).toBe('replacement');
  });

  it('uses one local eviction to satisfy bucket and aggregate task caps', () => {
    const registry = new BackgroundTaskRegistryClass();
    let otherOldestId = '';
    let targetOldestId = '';
    for (let i = 0; i < 200; i++) {
      const other = registry.create({
        userId: 'u-local-first',
        conversationId: 'c-other',
        toolCallId: `call_other_${i}`,
        toolName: 't',
      });
      if ('atCapacity' in other) {
        throw new Error(`unexpected other capacity at ${i}`);
      }
      otherOldestId ||= other.task.id;
      registry.complete('u-local-first', 'c-other', other.task.id, { content: 'other' });
    }
    for (let i = 0; i < 200; i++) {
      const target = registry.create({
        userId: 'u-local-first',
        conversationId: 'c-target',
        toolCallId: `call_target_${i}`,
        toolName: 't',
      });
      if ('atCapacity' in target) {
        throw new Error(`unexpected target capacity at ${i}`);
      }
      targetOldestId ||= target.task.id;
      registry.complete('u-local-first', 'c-target', target.task.id, { content: 'target' });
    }

    const replacement = registry.create({
      userId: 'u-local-first',
      conversationId: 'c-target',
      toolCallId: 'call_replacement',
      toolName: 't',
    });
    expect('atCapacity' in replacement).toBe(false);
    expect(registry.get('u-local-first', 'c-other', otherOldestId)).toBeDefined();
    expect(registry.get('u-local-first', 'c-target', targetOldestId)).toBeUndefined();
  });

  it('evicts by settlement time instead of dispatch time', () => {
    const registry = new BackgroundTaskRegistryClass();
    let now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const slow = registry.create({
        userId: 'u-settlement-order',
        conversationId: 'c-slow',
        toolCallId: 'call_slow',
        toolName: 't',
      });
      if ('atCapacity' in slow) {
        throw new Error('unexpected slow-task capacity');
      }

      let oldestSettledId = '';
      for (let i = 0; i < 399; i++) {
        now++;
        const fast = registry.create({
          userId: 'u-settlement-order',
          conversationId: `c-fast-${i}`,
          toolCallId: `call_fast_${i}`,
          toolName: 't',
        });
        if ('atCapacity' in fast) {
          throw new Error(`unexpected fast-task capacity at ${i}`);
        }
        oldestSettledId ||= fast.task.id;
        registry.complete('u-settlement-order', `c-fast-${i}`, fast.task.id, {
          content: 'fast',
        });
      }

      now += 1_000;
      registry.complete('u-settlement-order', 'c-slow', slow.task.id, { content: 'slow' });
      now++;
      const replacement = registry.create({
        userId: 'u-settlement-order',
        conversationId: 'c-replacement',
        toolCallId: 'call_replacement',
        toolName: 't',
      });
      expect('atCapacity' in replacement).toBe(false);
      expect(registry.get('u-settlement-order', 'c-slow', slow.task.id)?.result).toBe('slow');
      expect(registry.get('u-settlement-order', 'c-fast-0', oldestSettledId)).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('evicts oldest settled tasks at the process-wide cap', () => {
    const registry = new BackgroundTaskRegistryClass();
    let firstTaskId = '';
    let latestTaskId = '';
    for (let i = 0; i <= 2_000; i++) {
      const created = registry.create({
        userId: `u-${i}`,
        conversationId: `c-${i}`,
        toolCallId: `call_${i}`,
        toolName: 't',
      });
      if ('atCapacity' in created) {
        throw new Error(`unexpected capacity at ${i}`);
      }
      firstTaskId ||= created.task.id;
      latestTaskId = created.task.id;
      registry.complete(`u-${i}`, `c-${i}`, created.task.id, { content: 'x' });
    }
    expect(registry.get('u-0', 'c-0', firstTaskId)).toBeUndefined();
    expect(registry.get('u-2000', 'c-2000', latestTaskId)?.status).toBe('completed');
  });

  it('bounds retained payloads per user across conversations', () => {
    const registry = new BackgroundTaskRegistryClass();
    let firstTaskId = '';
    let latestTaskId = '';
    for (let i = 0; i < 18; i++) {
      const created = registry.create({
        userId: 'u-payload',
        conversationId: `c-${i}`,
        toolCallId: `call_${i}`,
        toolName: 't',
      });
      if ('atCapacity' in created) {
        throw new Error(`unexpected capacity at ${i}`);
      }
      firstTaskId ||= created.task.id;
      latestTaskId = created.task.id;
      registry.complete('u-payload', `c-${i}`, created.task.id, {
        content: 'x',
        artifact: { payload: 'x'.repeat(1_000_000) },
      });
    }
    expect(registry.get('u-payload', 'c-0', firstTaskId)).toBeUndefined();
    expect(registry.get('u-payload', 'c-17', latestTaskId)?.artifact).toBeDefined();
  });

  it('does not evict a completed task while its harvest is pending', () => {
    const registry = new BackgroundTaskRegistryClass();
    const first = registry.create({
      userId: 'u-pending-harvest',
      conversationId: 'c-first',
      toolCallId: 'call_first',
      toolName: 'execute_code',
      harvestStarted: true,
    });
    const second = registry.create({
      userId: 'u-pending-harvest',
      conversationId: 'c-second',
      toolCallId: 'call_second',
      toolName: 'execute_code',
      harvestStarted: true,
    });
    if ('atCapacity' in first || 'atCapacity' in second) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-pending-harvest', 'c-first', first.task.id, {
      content: 'first',
      artifact: { payload: 'a'.repeat(9_000_000) },
      harvestStarted: true,
    });
    registry.complete('u-pending-harvest', 'c-second', second.task.id, {
      content: 'second',
      artifact: { payload: 'b'.repeat(9_000_000) },
      harvestStarted: true,
    });
    expect(registry.get('u-pending-harvest', 'c-first', first.task.id)?.artifact).toBeDefined();
    expect(registry.get('u-pending-harvest', 'c-second', second.task.id)?.artifact).toBeUndefined();
    expect(registry.get('u-pending-harvest', 'c-second', second.task.id)?.result).toBeUndefined();
  });

  it('does not evict an ordinary task while completion persistence is pending', () => {
    const registry = new BackgroundTaskRegistryClass();
    const first = registry.create({
      userId: 'u-pending-persistence',
      conversationId: 'c-first',
      toolCallId: 'call_first',
      toolName: 'search_mcp_docs',
    });
    const second = registry.create({
      userId: 'u-pending-persistence',
      conversationId: 'c-second',
      toolCallId: 'call_second',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in first || 'atCapacity' in second) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-pending-persistence', 'c-first', first.task.id, {
      content: 'first',
      artifact: { payload: 'a'.repeat(9_000_000) },
    });
    registry.markCompletionPersistencePending('u-pending-persistence', 'c-first', first.task.id);
    registry.complete('u-pending-persistence', 'c-second', second.task.id, {
      content: 'second',
      artifact: { payload: 'b'.repeat(9_000_000) },
    });
    expect(registry.get('u-pending-persistence', 'c-first', first.task.id)).toBeDefined();
    expect(
      registry.get('u-pending-persistence', 'c-second', second.task.id)?.result,
    ).toBeUndefined();
  });

  it('skips zero-byte records when evicting retained payloads', () => {
    const registry = new BackgroundTaskRegistryClass();
    const empty = registry.create({
      userId: 'u-zero-byte',
      conversationId: 'c-empty',
      toolCallId: 'call_empty',
      toolName: 't',
    });
    const retained = registry.create({
      userId: 'u-zero-byte',
      conversationId: 'c-retained',
      toolCallId: 'call_retained',
      toolName: 't',
    });
    const incoming = registry.create({
      userId: 'u-zero-byte',
      conversationId: 'c-incoming',
      toolCallId: 'call_incoming',
      toolName: 't',
    });
    if ('atCapacity' in empty || 'atCapacity' in retained || 'atCapacity' in incoming) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-zero-byte', 'c-empty', empty.task.id, { content: '' });
    registry.complete('u-zero-byte', 'c-retained', retained.task.id, {
      content: 'retained',
      artifact: { payload: 'a'.repeat(9_000_000) },
    });
    registry.complete('u-zero-byte', 'c-incoming', incoming.task.id, {
      content: 'incoming',
      artifact: { payload: 'b'.repeat(8_000_000) },
    });
    expect(registry.get('u-zero-byte', 'c-empty', empty.task.id)).toBeDefined();
    expect(registry.get('u-zero-byte', 'c-retained', retained.task.id)).toBeUndefined();
    expect(registry.get('u-zero-byte', 'c-incoming', incoming.task.id)?.artifact).toBeDefined();
  });

  it('does not partially evict global tasks when user retention cannot be satisfied', () => {
    const registry = new BackgroundTaskRegistryClass();
    for (let index = 0; index < 400; index++) {
      const conversationId = `c-atomic-${Math.floor(index / 200)}`;
      const created = registry.create({
        userId: 'u-atomic',
        conversationId,
        toolCallId: `call_atomic_${index}`,
        toolName: 't',
        harvestStarted: true,
      });
      if ('atCapacity' in created) {
        throw new Error(`unexpected capacity at ${index}: ${created.scope}`);
      }
      registry.complete('u-atomic', conversationId, created.task.id, {
        content: '',
        harvestStarted: true,
      });
    }

    let oldestGlobalTask: { userId: string; conversationId: string; taskId: string } | undefined;
    for (let userIndex = 0; userIndex < 8; userIndex++) {
      for (let taskIndex = 0; taskIndex < 200; taskIndex++) {
        const userId = `u-global-${userIndex}`;
        const conversationId = `c-global-${userIndex}`;
        const created = registry.create({
          userId,
          conversationId,
          toolCallId: `call_global_${userIndex}_${taskIndex}`,
          toolName: 't',
        });
        if ('atCapacity' in created) {
          throw new Error('unexpected capacity');
        }
        registry.complete(userId, conversationId, created.task.id, { content: '' });
        oldestGlobalTask ??= { userId, conversationId, taskId: created.task.id };
      }
    }

    const rejected = registry.create({
      userId: 'u-atomic',
      conversationId: 'c-atomic-new',
      toolCallId: 'call_atomic_rejected',
      toolName: 't',
    });
    expect(rejected).toEqual({ atCapacity: true, scope: 'user_retention' });
    if (oldestGlobalTask == null) {
      throw new Error('expected a global eviction candidate');
    }
    expect(
      registry.get(
        oldestGlobalTask.userId,
        oldestGlobalTask.conversationId,
        oldestGlobalTask.taskId,
      ),
    ).toBeDefined();
  });

  it('does not partially evict global payloads when user payload retention cannot be satisfied', () => {
    const registry = new BackgroundTaskRegistryClass();
    for (let index = 0; index < 2; index++) {
      const conversationId = `c-payload-protected-${index}`;
      const created = registry.create({
        userId: 'u-payload-atomic',
        conversationId,
        toolCallId: `call_payload_protected_${index}`,
        toolName: 't',
        harvestStarted: true,
      });
      if ('atCapacity' in created) {
        throw new Error('unexpected capacity');
      }
      registry.complete('u-payload-atomic', conversationId, created.task.id, {
        content: 'protected',
        artifact: { payload: 'p'.repeat(7_999_000) },
        harvestStarted: true,
      });
    }

    let oldestGlobalTask: { userId: string; conversationId: string; taskId: string } | undefined;
    for (let index = 0; index < 6; index++) {
      const userId = `u-payload-global-${index}`;
      const conversationId = `c-payload-global-${index}`;
      const created = registry.create({
        userId,
        conversationId,
        toolCallId: `call_payload_global_${index}`,
        toolName: 't',
      });
      if ('atCapacity' in created) {
        throw new Error('unexpected capacity');
      }
      registry.complete(userId, conversationId, created.task.id, {
        content: 'global',
        artifact: { payload: 'g'.repeat(7_999_000) },
      });
      oldestGlobalTask ??= { userId, conversationId, taskId: created.task.id };
    }

    const incoming = registry.create({
      userId: 'u-payload-atomic',
      conversationId: 'c-payload-incoming',
      toolCallId: 'call_payload_incoming',
      toolName: 't',
    });
    if ('atCapacity' in incoming) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-payload-atomic', 'c-payload-incoming', incoming.task.id, {
      content: 'incoming',
      artifact: { payload: 'i'.repeat(20_000) },
    });

    expect(registry.get('u-payload-atomic', 'c-payload-incoming', incoming.task.id)?.result).toBe(
      undefined,
    );
    if (oldestGlobalTask == null) {
      throw new Error('expected a global payload eviction candidate');
    }
    expect(
      registry.get(
        oldestGlobalTask.userId,
        oldestGlobalTask.conversationId,
        oldestGlobalTask.taskId,
      ),
    ).toBeDefined();
  });

  it('drops terminal errors when non-evictable payloads exhaust the user budget', () => {
    const registry = new BackgroundTaskRegistryClass();
    const first = registry.create({
      userId: 'u-error-budget',
      conversationId: 'c-first',
      toolCallId: 'call_first',
      toolName: 'execute_code',
      harvestStarted: true,
    });
    const second = registry.create({
      userId: 'u-error-budget',
      conversationId: 'c-second',
      toolCallId: 'call_second',
      toolName: 'execute_code',
      harvestStarted: true,
    });
    const failing = registry.create({
      userId: 'u-error-budget',
      conversationId: 'c-failing',
      toolCallId: 'call_failing',
      toolName: 'execute_code',
    });
    if ('atCapacity' in first || 'atCapacity' in second || 'atCapacity' in failing) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-error-budget', 'c-first', first.task.id, {
      content: 'a',
      artifact: { payload: 'a'.repeat(9_000_000) },
      harvestStarted: true,
    });
    registry.complete('u-error-budget', 'c-second', second.task.id, {
      content: 'b',
      artifact: { payload: 'b'.repeat(6_999_900) },
      harvestStarted: true,
    });
    registry.fail('u-error-budget', 'c-failing', failing.task.id, 'e'.repeat(100_000));
    const failed = registry.get('u-error-budget', 'c-failing', failing.task.id);
    expect(failed?.status).toBe('error');
    expect(failed?.error).toBeUndefined();
  });

  it('finishes an empty harvest without evicting payload capacity', () => {
    const registry = new BackgroundTaskRegistryClass();
    const first = registry.create({
      userId: 'u-empty-harvest',
      conversationId: 'c-first',
      toolCallId: 'call_first',
      toolName: 'execute_code',
    });
    const second = registry.create({
      userId: 'u-empty-harvest',
      conversationId: 'c-second',
      toolCallId: 'call_second',
      toolName: 'execute_code',
    });
    const empty = registry.create({
      userId: 'u-empty-harvest',
      conversationId: 'c-empty',
      toolCallId: 'call_empty',
      toolName: 'execute_code',
      harvestStarted: true,
    });
    if ('atCapacity' in first || 'atCapacity' in second || 'atCapacity' in empty) {
      throw new Error('unexpected capacity');
    }
    registry.complete('u-empty-harvest', 'c-first', first.task.id, {
      content: 'a',
      artifact: { payload: 'a'.repeat(9_000_000) },
    });
    registry.complete('u-empty-harvest', 'c-second', second.task.id, {
      content: 'b',
      artifact: { payload: 'b'.repeat(6_999_970) },
    });
    registry.complete('u-empty-harvest', 'c-empty', empty.task.id, {
      content: '',
      harvestStarted: true,
    });
    registry.finishHarvest('u-empty-harvest', 'c-empty', empty.task.id);
    expect(registry.get('u-empty-harvest', 'c-first', first.task.id)).toBeDefined();
    expect(registry.get('u-empty-harvest', 'c-empty', empty.task.id)?.harvestPending).toBe(false);
  });

  it('scopes tasks by user and conversation', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_scope',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    expect(registry.get('u2', 'c1', created.task.id)).toBeUndefined();
    expect(registry.get('u1', 'c2', created.task.id)).toBeUndefined();
    expect(registry.list('u2', 'c1')).toHaveLength(0);
  });
});

describe('getBackgroundCodeDelivery (singleton)', () => {
  it('exposes harvest state for a settled task and stays available across polls', () => {
    const created = backgroundTaskRegistry.create({
      userId: 'delivery_user',
      conversationId: 'delivery_convo',
      toolCallId: 'call_code',
      toolName: 'execute_code',
      messageId: 'dispatch-msg',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('delivery_user', 'delivery_convo', created.task.id, {
      content: 'stdout',
      artifact: { session_id: 'exec-1' },
      harvestStarted: true,
    });
    backgroundTaskRegistry.finishHarvest('delivery_user', 'delivery_convo', created.task.id, [
      { file_id: 'f1' },
    ]);

    const args = { background_task_id: created.task.id };
    const first = getBackgroundCodeDelivery({
      userId: 'delivery_user',
      conversationId: 'delivery_convo',
      args,
    });
    expect(first).toEqual(
      expect.objectContaining({
        status: 'completed',
        toolName: 'execute_code',
        toolCallId: 'call_code',
        messageId: 'dispatch-msg',
        result: 'stdout',
        attachments: [{ file_id: 'f1' }],
        backgroundTask: expect.objectContaining({
          taskId: created.task.id,
          status: 'completed',
        }),
      }),
    );
    /** Not one-shot: a later poll can still re-emit / re-anchor. */
    expect(
      getBackgroundCodeDelivery({
        userId: 'delivery_user',
        conversationId: 'delivery_convo',
        args,
      })?.attachments,
    ).toEqual([{ file_id: 'f1' }]);
  });

  it('returns undefined for tasks without a harvest (non-code tools)', () => {
    const created = backgroundTaskRegistry.create({
      userId: 'delivery_user',
      conversationId: 'delivery_convo2',
      toolCallId: 'call_mcp',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('delivery_user', 'delivery_convo2', created.task.id, {
      content: 'RESULT',
    });
    expect(
      getBackgroundCodeDelivery({
        userId: 'delivery_user',
        conversationId: 'delivery_convo2',
        args: { background_task_id: created.task.id },
      }),
    ).toBeUndefined();
  });
});

describe('runCheckBackgroundTask (singleton)', () => {
  it('returns not_found for an unknown id', async () => {
    const content = await runCheckBackgroundTask({
      userId: 'poll_user',
      conversationId: 'poll_convo',
      args: { background_task_id: 'nope' },
    });
    expect(JSON.parse(content)).toEqual(
      expect.objectContaining({ status: 'not_found', background_task_id: 'nope' }),
    );
  });

  it('keeps ordinary cancellation disabled unless the deployment opts in', async () => {
    const requestCancellation = jest.fn();
    const created = backgroundTaskRegistry.create({
      userId: 'disabled-cancel-user',
      conversationId: 'disabled-cancel-conversation',
      toolCallId: 'disabled-cancel-call',
      toolName: 'bash_tool',
      requestCancellation,
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'disabled-cancel-user',
        conversationId: 'disabled-cancel-conversation',
        args: { background_task_id: created.task.id, action: 'cancel' },
      }),
    );
    expect(result).toMatchObject({ status: 'invalid', background_task_id: created.task.id });
    expect(requestCancellation).not.toHaveBeenCalled();
    backgroundTaskRegistry.fail(
      'disabled-cancel-user',
      'disabled-cancel-conversation',
      created.task.id,
      'test cleanup',
    );
  });

  it('uses normal durable claim arbitration when cancellation loses the settlement race', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'cancel-race-user',
      conversationId: 'cancel-race-conversation',
      toolCallId: 'cancel-race-call',
      toolName: 'bash_tool',
      messageId: 'cancel-race-message',
      requestCancellation: jest.fn(),
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.markCompletionWakeup(
      'cancel-race-user',
      'cancel-race-conversation',
      created.task.id,
      {
        renew: jest.fn(async () => true),
        retire: jest.fn(async () => true),
      },
    );
    backgroundTaskRegistry.complete(
      'cancel-race-user',
      'cancel-race-conversation',
      created.task.id,
      { content: 'settled result' },
    );
    const claimBackgroundToolResult = jest.fn(async () => ({
      status: 'claimed' as const,
      claim: { kind: 'wakeup' as const, claimId: 'automatic-delivery' },
    }));

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'cancel-race-user',
        conversationId: 'cancel-race-conversation',
        args: { background_task_id: created.task.id, action: 'cancel' },
        ordinaryToolCancellation: true,
        claimBackgroundToolResult,
      }),
    );
    expect(result).toMatchObject({
      status: 'delivery_scheduled',
      background_task_id: created.task.id,
    });
    expect(claimBackgroundToolResult).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized task id before local or cross-replica lookup', async () => {
    const store = Object.assign(new InMemorySubagentTaskStore(), {
      claimTask: jest.fn(),
      controlTask: jest.fn(),
      listTasks: jest.fn(),
    });
    const content = await runCheckBackgroundTask({
      userId: 'owner',
      conversationId: 'parent-thread',
      args: { background_task_id: 'x'.repeat(257) },
      subagentTasks: { store, scopeId: 'owner:parent-thread' },
    });

    expect(JSON.parse(content)).toEqual({
      status: 'invalid',
      message: 'A background_task_id cannot exceed 256 characters.',
    });
    expect(store.claimTask).not.toHaveBeenCalled();
    expect(store.controlTask).not.toHaveBeenCalled();
    expect(store.listTasks).not.toHaveBeenCalled();
  });

  it('returns a single task by id and lists all when omitted', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'poll_user',
      conversationId: 'poll_convo2',
      toolCallId: 'call_poll',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('poll_user', 'poll_convo2', created.task.id, {
      content: 'RESULT',
    });

    const single = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'poll_user',
        conversationId: 'poll_convo2',
        args: { background_task_id: created.task.id },
      }),
    );
    expect(single).toEqual(
      expect.objectContaining({
        status: 'completed',
        result: 'RESULT',
        background_task_id: created.task.id,
      }),
    );

    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'poll_user',
        conversationId: 'poll_convo2',
        args: {},
      }),
    );
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0].background_task_id).toBe(created.task.id);
    // list path must NOT dump full results (context-overflow guard); metadata only
    expect(listed.tasks[0].result).toBeUndefined();
    expect(listed.tasks[0]).toEqual(
      expect.objectContaining({ status: 'completed', result_available: true, result_chars: 6 }),
    );

    // stringified args must still resolve the specific task (with its full result)
    const singleFromString = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'poll_user',
        conversationId: 'poll_convo2',
        args: `{"background_task_id":"${created.task.id}"}`,
      }),
    );
    expect(singleFromString).toEqual(
      expect.objectContaining({ status: 'completed', result: 'RESULT' }),
    );
  });

  it('reports ISO dispatch and settlement stamps with the elapsed span', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      const created = backgroundTaskRegistry.create({
        userId: 'timing_user',
        conversationId: 'timing_convo',
        toolCallId: 'call_timing',
        toolName: 'search_mcp_docs',
      });
      if ('atCapacity' in created) {
        throw new Error('unexpected capacity');
      }
      /** The dispatch stamp is monotonic per process, so it is whatever the registry
       * assigned rather than the clock at this instant; drive the clock from it. */
      const dispatchedAt = created.task.createdAt;

      nowSpy.mockReturnValue(dispatchedAt + 90_000);
      const running = JSON.parse(
        await runCheckBackgroundTask({
          userId: 'timing_user',
          conversationId: 'timing_convo',
          args: { background_task_id: created.task.id },
        }),
      );
      expect(running).toMatchObject({
        status: 'running',
        started_at: new Date(dispatchedAt).toISOString(),
        elapsed_ms: 90_000,
      });
      /** A running task has not settled, so it must not claim a terminal stamp. */
      expect(running.settled_at).toBeUndefined();

      nowSpy.mockReturnValue(dispatchedAt + 120_000);
      backgroundTaskRegistry.complete('timing_user', 'timing_convo', created.task.id, {
        content: 'RESULT',
      });

      nowSpy.mockReturnValue(dispatchedAt + 600_000);
      const settled = JSON.parse(
        await runCheckBackgroundTask({
          userId: 'timing_user',
          conversationId: 'timing_convo',
          args: { background_task_id: created.task.id },
        }),
      );
      /** The span freezes at settlement instead of growing with every later poll. */
      expect(settled).toMatchObject({
        status: 'completed',
        started_at: new Date(dispatchedAt).toISOString(),
        settled_at: new Date(dispatchedAt + 120_000).toISOString(),
        elapsed_ms: 120_000,
      });

      const listed = JSON.parse(
        await runCheckBackgroundTask({
          userId: 'timing_user',
          conversationId: 'timing_convo',
          args: {},
        }),
      );
      expect(listed.tasks[0]).toMatchObject({
        started_at: new Date(dispatchedAt).toISOString(),
        settled_at: new Date(dispatchedAt + 120_000).toISOString(),
        elapsed_ms: 120_000,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('lets a later-generation poll collect a receipt without inheriting an abandoned local claim', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'claim_user',
      conversationId: 'claim_convo',
      toolCallId: 'call_claim',
      toolName: 'search_mcp_docs',
      messageId: 'response-claim',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('claim_user', 'claim_convo', created.task.id, {
      content: 'CLAIMED RESULT',
    });
    const retire = jest.fn(async () => true);
    backgroundTaskRegistry.markCompletionWakeup('claim_user', 'claim_convo', created.task.id, {
      renew: jest.fn(async () => true),
      retire,
    });
    const claimBackgroundToolResult = jest
      .fn()
      .mockResolvedValueOnce({ status: 'not_ready' })
      .mockResolvedValueOnce({ status: 'not_ready' })
      .mockResolvedValueOnce({ status: 'not_ready' })
      .mockResolvedValueOnce({ status: 'acquired', results: [] });
    const request = {
      userId: 'claim_user',
      conversationId: 'claim_convo',
      args: { background_task_id: created.task.id },
      agentId: 'agent_parent_1',
      runId: 'poll-run',
      generationId: 'response-later-poll',
      claimBackgroundToolResult,
    };

    const persisting = JSON.parse(
      await runCheckBackgroundTask({ ...request, toolCallId: 'poll-call-1' }),
    );
    expect(persisting).toMatchObject({ status: 'result_persisting' });
    expect(JSON.stringify(persisting)).not.toContain('CLAIMED RESULT');
    expect(
      backgroundTaskRegistry.get('claim_user', 'claim_convo', created.task.id)?.resultClaim,
    ).toBeUndefined();
    const laterPoll = JSON.parse(
      await runCheckBackgroundTask({ ...request, toolCallId: 'poll-call-2' }),
    );
    expect(laterPoll).toMatchObject({ status: 'completed', result: 'CLAIMED RESULT' });
    expect(
      backgroundTaskRegistry.get('claim_user', 'claim_convo', created.task.id)?.resultClaim,
    ).toMatchObject({ kind: 'manual', generationId: 'response-later-poll' });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith('completion claimed by same-generation manual poll', {
      onlyIfUnclaimed: true,
    });
    expect(claimBackgroundToolResult).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'response-claim',
        taskId: created.task.id,
        kind: 'manual',
        generationId: 'response-later-poll',
        allowUnfinished: true,
      }),
    );
  });

  it('delivers a completed result inside its originating generation before the response row finalizes', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'originating_user',
      conversationId: 'originating_convo',
      toolCallId: 'call_originating',
      toolName: 'search_mcp_docs',
      messageId: 'response-originating',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('originating_user', 'originating_convo', created.task.id, {
      content: 'ORIGINATING RESULT',
    });
    const retire = jest.fn(async () => true);
    backgroundTaskRegistry.markCompletionWakeup(
      'originating_user',
      'originating_convo',
      created.task.id,
      { renew: jest.fn(async () => true), retire },
    );
    const claimBackgroundToolResult = jest.fn(async () => ({ status: 'not_ready' as const }));
    const request = {
      userId: 'originating_user',
      conversationId: 'originating_convo',
      args: { background_task_id: created.task.id },
      toolCallId: 'poll-originating',
      runId: 'originating-run',
      generationId: 'response-originating',
      claimBackgroundToolResult,
    };

    const result = JSON.parse(await runCheckBackgroundTask(request));
    const replay = JSON.parse(await runCheckBackgroundTask(request));

    expect(result).toMatchObject({ status: 'completed', result: 'ORIGINATING RESULT' });
    expect(replay).toMatchObject({ status: 'completed', result: 'ORIGINATING RESULT' });
    expect(retire).toHaveBeenCalledTimes(1);
    expect(retire).toHaveBeenCalledWith('completion claimed by same-generation manual poll', {
      onlyIfUnclaimed: true,
    });
    expect(claimBackgroundToolResult).toHaveBeenCalledTimes(2);
    expect(
      backgroundTaskRegistry.get('originating_user', 'originating_convo', created.task.id)
        ?.resultClaim,
    ).toMatchObject({
      kind: 'manual',
      generationId: 'response-originating',
    });
  });

  it('reclaims a dead manual delivery after its owning generation is gone', async () => {
    const claimBackgroundToolResult = jest
      .fn()
      .mockResolvedValueOnce({
        status: 'claimed',
        messageId: 'response-recovered',
        claim: {
          kind: 'manual',
          claimId: 'abandoned-poll',
          generationId: 'response-abandoned',
        },
      })
      .mockResolvedValueOnce({
        status: 'acquired',
        messageId: 'response-recovered',
        results: [
          {
            taskId: 'task-recovered-manual',
            toolCallId: 'call-recovered-manual',
            toolName: 'mutating_tool',
            status: 'completed',
            output: 'mutation already completed',
          },
        ],
      });
    const recoverDeadBackgroundToolClaim = jest.fn(async () => true);

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'recovered_user',
        conversationId: 'recovered_convo',
        args: { background_task_id: 'task-recovered-manual' },
        toolCallId: 'replacement-poll',
        runId: 'replacement-run',
        generationId: 'response-replacement',
        claimBackgroundToolResult,
        recoverDeadBackgroundToolClaim,
      }),
    );

    expect(result).toMatchObject({
      status: 'completed',
      background_task_id: 'task-recovered-manual',
      result: 'mutation already completed',
    });
    expect(recoverDeadBackgroundToolClaim).toHaveBeenCalledWith({
      userId: 'recovered_user',
      conversationId: 'recovered_convo',
      messageId: 'response-recovered',
      claimId: 'abandoned-poll',
      kind: 'manual',
      generationId: 'response-abandoned',
    });
    expect(claimBackgroundToolResult).toHaveBeenCalledTimes(2);
  });

  it('delivers a mandatory live-artifact poll without waiting for its dispatch row', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'artifact_poll_user',
      conversationId: 'artifact_poll_convo',
      toolCallId: 'call_artifact_poll',
      toolName: 'artifact_tool',
      messageId: 'response-artifact-poll',
      liveArtifactPollRequired: true,
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('artifact_poll_user', 'artifact_poll_convo', created.task.id, {
      content: 'CONTENT WITH LIVE ARTIFACT',
      artifact: { type: 'test-artifact' },
    });
    const retire = jest.fn(async () => true);
    backgroundTaskRegistry.markCompletionWakeup(
      'artifact_poll_user',
      'artifact_poll_convo',
      created.task.id,
      { renew: jest.fn(async () => true), retire },
    );
    const claimBackgroundToolResult = jest.fn(async () => ({ status: 'not_ready' as const }));

    const request = {
      userId: 'artifact_poll_user',
      conversationId: 'artifact_poll_convo',
      args: { background_task_id: created.task.id },
      toolCallId: 'poll-live-artifact',
      runId: 'dispatch-run',
      claimBackgroundToolResult,
    };
    const result = JSON.parse(await runCheckBackgroundTask(request));
    const replay = JSON.parse(await runCheckBackgroundTask(request));

    expect(result).toMatchObject({ status: 'completed', result: 'CONTENT WITH LIVE ARTIFACT' });
    expect(replay).toMatchObject({ status: 'completed', result: 'CONTENT WITH LIVE ARTIFACT' });
    expect(retire).toHaveBeenCalledWith('completion claimed by same-generation manual poll', {
      onlyIfUnclaimed: true,
    });
    expect(claimBackgroundToolResult).toHaveBeenCalledTimes(2);
    expect(
      backgroundTaskRegistry.get('artifact_poll_user', 'artifact_poll_convo', created.task.id)
        ?.resultClaim,
    ).toMatchObject({ kind: 'manual' });
  });

  it('does not expose a result already assigned to an automatic continuation', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'scheduled_user',
      conversationId: 'scheduled_convo',
      toolCallId: 'call_scheduled',
      toolName: 'search_mcp_docs',
      messageId: 'response-scheduled',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('scheduled_user', 'scheduled_convo', created.task.id, {
      content: 'PRIVATE UNTIL CONTINUATION',
    });
    backgroundTaskRegistry.markCompletionWakeup(
      'scheduled_user',
      'scheduled_convo',
      created.task.id,
    );

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'scheduled_user',
        conversationId: 'scheduled_convo',
        args: { background_task_id: created.task.id },
        claimBackgroundToolResult: async () => ({ status: 'claimed' }),
      }),
    );
    expect(result).toMatchObject({ status: 'delivery_scheduled' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE UNTIL CONTINUATION');
  });

  it.each([
    { status: 'completed' as const, field: 'result', output: 'RECOVERED RESULT' },
    { status: 'error' as const, field: 'error', output: 'RECOVERED FAILURE' },
  ])('recovers a durable $status receipt after process-local state is lost', async (terminal) => {
    const settledAt = new Date('2026-09-22T09:00:00.000Z');
    const claimBackgroundToolResult = jest.fn(async () => ({
      status: 'acquired' as const,
      messageId: 'response-recovered',
      results: [
        {
          taskId: 'task-recovered',
          toolCallId: 'call-recovered',
          toolName: 'slow_tool',
          status: terminal.status,
          output: terminal.output,
          settledAt,
        },
      ],
    }));

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'recovered_user',
        conversationId: 'recovered_convo',
        args: { background_task_id: 'task-recovered' },
        toolCallId: 'recovery-poll',
        runId: 'recovery-run',
        claimBackgroundToolResult,
      }),
    );

    expect(result).toMatchObject({
      status: terminal.status,
      background_task_id: 'task-recovered',
      [terminal.field]: terminal.output,
      /** The receipt records settlement only, so a recovered poll reports no span. */
      settled_at: settledAt.toISOString(),
    });
    expect(result.started_at).toBeUndefined();
    expect(result.elapsed_ms).toBeUndefined();
    expect(claimBackgroundToolResult).toHaveBeenCalledWith(
      expect.not.objectContaining({ messageId: expect.anything() }),
    );
  });

  it('reports a lost executor without implying that a mutating task is safe to retry', async () => {
    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'unknown_user',
        conversationId: 'unknown_convo',
        args: { background_task_id: 'task-unknown' },
        toolCallId: 'unknown-poll',
        runId: 'unknown-run',
        claimBackgroundToolResult: async () => ({
          status: 'outcome_unknown',
          toolName: 'mutating_tool',
        }),
      }),
    );

    expect(result).toMatchObject({
      status: 'outcome_unknown',
      background_task_id: 'task-unknown',
      tool: 'mutating_tool',
    });
    expect(result.message).toContain('Do not repeat a mutating operation automatically');
  });

  it('recovers a result through its dead batch-owner claim', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'dead_claim_user',
      conversationId: 'dead_claim_convo',
      toolCallId: 'call_dead_claim',
      toolName: 'search_mcp_docs',
      messageId: 'response-dead-claim',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('dead_claim_user', 'dead_claim_convo', created.task.id, {
      content: 'RECOVERED CLAIMED RESULT',
    });
    backgroundTaskRegistry.markCompletionWakeup(
      'dead_claim_user',
      'dead_claim_convo',
      created.task.id,
    );
    const claimBackgroundToolResult = jest
      .fn()
      .mockResolvedValueOnce({
        status: 'claimed',
        claim: { kind: 'wakeup', claimId: 'sibling-batch-root' },
      })
      .mockResolvedValueOnce({ status: 'acquired', results: [] });
    const recoverDeadBackgroundToolClaim = jest.fn(async () => true);

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'dead_claim_user',
        conversationId: 'dead_claim_convo',
        args: { background_task_id: created.task.id },
        toolCallId: 'poll-dead-claim',
        runId: 'poll-run',
        claimBackgroundToolResult,
        recoverDeadBackgroundToolClaim,
      }),
    );

    expect(result).toMatchObject({ status: 'completed', result: 'RECOVERED CLAIMED RESULT' });
    expect(recoverDeadBackgroundToolClaim).toHaveBeenCalledWith({
      userId: 'dead_claim_user',
      conversationId: 'dead_claim_convo',
      messageId: 'response-dead-claim',
      claimId: 'sibling-batch-root',
    });
    expect(claimBackgroundToolResult).toHaveBeenCalledTimes(2);
  });

  it('does not expose a local result after its automatic resolver owns the lease', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'retire_user',
      conversationId: 'retire_convo',
      toolCallId: 'call_retire',
      toolName: 'search_mcp_docs',
      messageId: 'response-retire',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('retire_user', 'retire_convo', created.task.id, {
      content: 'DO NOT DUPLICATE',
    });
    const retire = jest.fn(async () => false);
    backgroundTaskRegistry.markCompletionWakeup('retire_user', 'retire_convo', created.task.id, {
      renew: jest.fn(async () => true),
      retire,
    });

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'retire_user',
        conversationId: 'retire_convo',
        args: { background_task_id: created.task.id },
        toolCallId: 'poll-retire',
        runId: 'poll-run',
        claimBackgroundToolResult: async () => ({ status: 'not_ready' }),
      }),
    );

    expect(result).toMatchObject({ status: 'result_persisting' });
    expect(JSON.stringify(result)).not.toContain('DO NOT DUPLICATE');
    expect(
      backgroundTaskRegistry.get('retire_user', 'retire_convo', created.task.id)?.resultClaim,
    ).toBeUndefined();
    expect(retire).toHaveBeenCalledWith('completion claimed by same-generation manual poll', {
      onlyIfUnclaimed: true,
    });
    expect(retire).toHaveBeenCalledWith(
      'dead completion recovered by same-generation manual poll',
      {
        onlyIfDead: true,
      },
    );
  });

  it('recovers a dead automatic completion into process-local polling', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'dead_user',
      conversationId: 'dead_convo',
      toolCallId: 'call_dead',
      toolName: 'search_mcp_docs',
      messageId: 'response-dead',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('dead_user', 'dead_convo', created.task.id, {
      content: 'RECOVERED RESULT',
    });
    const retire = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    backgroundTaskRegistry.markCompletionWakeup('dead_user', 'dead_convo', created.task.id, {
      renew: jest.fn(async () => true),
      retire,
    });

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'dead_user',
        conversationId: 'dead_convo',
        args: { background_task_id: created.task.id },
        toolCallId: 'poll-dead',
        runId: 'poll-run',
        claimBackgroundToolResult: async () => ({ status: 'not_ready' }),
      }),
    );

    expect(result).toMatchObject({ status: 'completed', result: 'RECOVERED RESULT' });
    expect(retire).toHaveBeenNthCalledWith(1, 'completion claimed by same-generation manual poll', {
      onlyIfUnclaimed: true,
    });
    expect(retire).toHaveBeenNthCalledWith(
      2,
      'dead completion recovered by same-generation manual poll',
      { onlyIfDead: true },
    );
    expect(
      backgroundTaskRegistry.get('dead_user', 'dead_convo', created.task.id)
        ?.completionPersistenceFailed,
    ).toBe(true);
  });

  it('preserves local task lists when cross-replica subagent discovery is unavailable', async () => {
    const ordinary = backgroundTaskRegistry.create({
      userId: 'partial-list-owner',
      conversationId: 'partial-list-parent',
      toolCallId: 'ordinary-call',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in ordinary) {
      throw new Error('unexpected capacity');
    }

    const store = new InMemorySubagentTaskStore();
    const started = store.start({
      scopeId: 'partial-list-owner:partial-list-parent',
      idempotencyKey: 'partial-list-run:parent-agent:subagent-call',
      parentRunId: 'partial-list-run',
      parentAgentId: 'parent-agent',
      parentToolCallId: 'subagent-call',
      input: 'Keep working locally.',
      subagentKind: 'agent',
      subagentType: 'researcher',
      run: async () => ({ content: 'local result' }),
    });
    if (!started.accepted) {
      throw new Error('Expected subagent task to start.');
    }
    await waitForSubagentTaskToSettle(
      store,
      'partial-list-owner:partial-list-parent',
      started.task.taskId,
    );

    const routedStore = Object.assign(store, {
      claimTask: jest.fn(),
      controlTask: jest.fn(),
      listTasks: jest.fn().mockRejectedValue(new SubagentTaskOwnerUnavailableError()),
    });
    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'partial-list-owner',
        conversationId: 'partial-list-parent',
        args: {},
        subagentTasks: {
          store: routedStore,
          scopeId: 'partial-list-owner:partial-list-parent',
        },
      }),
    );

    expect(listed).toEqual(
      expect.objectContaining({
        partial: true,
        warning:
          'Cross-replica subagent tasks could not be listed: The process running this subagent task is temporarily unavailable.',
      }),
    );
    expect(
      listed.tasks.map((task: { background_task_id: string }) => task.background_task_id),
    ).toEqual(expect.arrayContaining([ordinary.task.id, started.task.taskId]));
  });

  it('retrieves a task across turns: the poll is keyed only by id, not the dispatch run/turn', async () => {
    // Turn 1 dispatches under run-turn-1 and the result lands after the turn.
    const dispatched = backgroundTaskRegistry.create({
      userId: 'poll_user',
      conversationId: 'poll_xturn',
      toolCallId: 'call_xturn',
      toolName: 'search_mcp_docs',
      runId: 'run-turn-1',
      agentId: 'agent-A',
    });
    if ('atCapacity' in dispatched) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.complete('poll_user', 'poll_xturn', dispatched.task.id, {
      content: 'XTURN_RESULT',
    });

    // Turn 2 (a later run) polls with just the id; get/list carry no run/turn scope.
    const polled = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'poll_user',
        conversationId: 'poll_xturn',
        args: { background_task_id: dispatched.task.id },
      }),
    );
    expect(polled).toEqual(
      expect.objectContaining({
        status: 'completed',
        result: 'XTURN_RESULT',
        background_task_id: dispatched.task.id,
      }),
    );
  });

  it('polls and one-shot claims a detached subagent result', async () => {
    const store = new InMemorySubagentTaskStore();
    const subagentTasks: SubagentTaskConfig = { store, scopeId: 'owner:parent-thread' };
    const claimBackgroundToolResult = jest.fn(async () => {
      throw new Error('message recovery unavailable');
    });
    const started = store.start({
      scopeId: subagentTasks.scopeId,
      idempotencyKey: 'parent-run:parent-agent:call-1',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      parentToolCallId: 'call-1',
      input: 'Research this.',
      subagentKind: 'agent',
      subagentType: 'researcher',
      run: async () => ({ content: 'finished research' }),
    });
    if (!started.accepted) {
      throw new Error('Expected subagent task to start.');
    }
    await waitForSubagentTaskToSettle(store, subagentTasks.scopeId, started.task.taskId);

    const first = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'parent-thread',
        args: { background_task_id: started.task.taskId },
        subagentTasks,
        claimBackgroundToolResult,
      }),
    );
    expect(first).toEqual(
      expect.objectContaining({
        background_task_id: started.task.taskId,
        subagent_thread_id: started.task.threadId,
        tool: 'subagent',
        status: 'completed',
        result: 'finished research',
      }),
    );

    const second = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'parent-thread',
        args: { background_task_id: started.task.taskId },
        subagentTasks,
        claimBackgroundToolResult,
      }),
    );
    expect(second).toEqual(expect.objectContaining({ status: 'claimed', result_claimed: true }));
    expect(second.result).toBeUndefined();
    expect(claimBackgroundToolResult).not.toHaveBeenCalled();

    /** A subagent task reports the same timings as an ordinary one. */
    for (const polled of [first, second]) {
      expect(Number.isNaN(Date.parse(polled.started_at))).toBe(false);
      expect(Date.parse(polled.settled_at)).toBeGreaterThanOrEqual(Date.parse(polled.started_at));
      expect(polled.elapsed_ms).toBe(Date.parse(polled.settled_at) - Date.parse(polled.started_at));
    }
  });

  it('falls through cleanly when neither background store recognizes a poll id', async () => {
    const store = new InMemorySubagentTaskStore();
    const claimBackgroundToolResult = jest.fn(async () => ({ status: 'not_found' as const }));

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'parent-thread',
        args: { background_task_id: 'unknown-task' },
        subagentTasks: { store, scopeId: 'owner:parent-thread' },
        claimBackgroundToolResult,
      }),
    );

    expect(result).toEqual({
      status: 'not_found',
      background_task_id: 'unknown-task',
      message: 'No background task with that id exists in this thread.',
    });
    expect(claimBackgroundToolResult).toHaveBeenCalledTimes(1);
  });

  it('recovers an ordinary durable result even when the subagent store is unavailable', async () => {
    const store = Object.assign(new InMemorySubagentTaskStore(), {
      claimTask: jest.fn().mockRejectedValue(new SubagentTaskOwnerUnavailableError()),
    });
    const claimBackgroundToolResult = jest.fn(async () => ({
      status: 'acquired' as const,
      results: [
        {
          taskId: 'ordinary-task',
          toolCallId: 'ordinary-call',
          toolName: 'mutating_tool',
          status: 'completed' as const,
          output: 'ordinary result',
        },
      ],
    }));

    const result = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'parent-thread',
        args: { background_task_id: 'ordinary-task' },
        subagentTasks: { store, scopeId: 'owner:parent-thread' },
        claimBackgroundToolResult,
      }),
    );

    expect(result).toMatchObject({
      status: 'completed',
      background_task_id: 'ordinary-task',
      result: 'ordinary result',
    });
    expect(claimBackgroundToolResult).toHaveBeenCalledTimes(1);
  });

  it('counts a finished subagent as outstanding until its result is delivered', async () => {
    const store = new InMemorySubagentTaskStore();
    const subagentTasks: HostSubagentTaskConfig = {
      store,
      scopeId: 'owner:settled-subagent-parent',
      completionDelivery: SUBAGENT_COMPLETION_DELIVERY,
    };
    const started = store.start({
      scopeId: subagentTasks.scopeId,
      idempotencyKey: 'parent-run:parent-agent:call-settled',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      parentToolCallId: 'call-settled',
      input: 'Research this.',
      subagentKind: 'agent',
      subagentType: 'researcher',
      run: async () => ({ content: 'research done' }),
    });
    if (!started.accepted) {
      throw new Error('Expected subagent task to start.');
    }
    for (
      let i = 0;
      i < 50 && store.get(subagentTasks.scopeId, started.task.taskId)?.status === 'running';
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const listWithWakeups = async (subagentWakeups: string[]) =>
      JSON.parse(
        await runCheckBackgroundTask({
          userId: 'owner',
          conversationId: 'settled-subagent-parent',
          agentId: 'agent_parent',
          args: {},
          subagentTasks,
          pendingCompletions: {
            list: jest.fn(async () => ({ completions: [], dead: [], complete: true })),
            listSubagentWakeups: jest.fn(async () => ({
              taskIds: subagentWakeups,
              complete: true,
            })),
            discard: jest.fn(async () => 'not_pending' as const),
            settleClaimed: jest.fn(async () => false),
          },
        }),
      );

    /** No durable wake-up (admitted poll-only): nothing will arrive, so nothing is pending. */
    const pollOnly = await listWithWakeups([]);
    expect(pollOnly.tasks[0].delivery).toBeUndefined();
    expect(pollOnly.outstanding).toBe(0);

    const listed = await listWithWakeups([started.task.taskId]);
    expect(listed.tasks[0]).toEqual(
      expect.objectContaining({ status: 'completed', result_available: true, delivery: 'pending' }),
    );
    expect(listed.outstanding).toBe(1);
    expect(listed.message).toContain('Some finished subagents have not been delivered yet');
    expect(listed.message).not.toContain('cancel');
  });

  it('tells a wakeup-enabled parent to yield on an unchanged running subagent', async () => {
    const store = new InMemorySubagentTaskStore();
    const subagentTasks: HostSubagentTaskConfig = {
      store,
      scopeId: 'owner:wakeup-parent',
      completionDelivery: SUBAGENT_COMPLETION_DELIVERY,
    };
    const started = store.start({
      scopeId: subagentTasks.scopeId,
      idempotencyKey: 'parent-run:parent-agent:call-wakeup',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      parentToolCallId: 'call-wakeup',
      input: 'Research this.',
      subagentKind: 'agent',
      subagentType: 'researcher',
      run: (runtime: SubagentTaskRuntime) =>
        new Promise((_, reject) => {
          runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
            once: true,
          });
        }),
    });
    if (!started.accepted) {
      throw new Error('Expected subagent task to start.');
    }

    const polled = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'wakeup-parent',
        agentId: 'agent_parent',
        args: { background_task_id: started.task.taskId },
        subagentTasks,
      }),
    );
    expect(polled).toMatchObject({
      status: 'running',
      message: SUBAGENT_WAKEUP_GUIDANCE,
    });

    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'wakeup-parent',
        agentId: 'agent_parent',
        args: {},
        subagentTasks,
      }),
    );
    expect(listed.message).toBe(SUBAGENT_WAKEUP_GUIDANCE);
    expect(listed.tasks[0].message).toBeUndefined();

    const ephemeralPoll = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'wakeup-parent',
        agentId: 'openAI__gpt-4o',
        args: { background_task_id: started.task.taskId },
        subagentTasks,
      }),
    );
    expect(ephemeralPoll.status).toBe('running');
    expect(ephemeralPoll.message).toBeUndefined();

    store.control(subagentTasks.scopeId, started.task.taskId, { action: 'cancel' });
  });

  it('preserves poll-first running status when automatic delivery is disabled', async () => {
    const store = new InMemorySubagentTaskStore();
    const subagentTasks: SubagentTaskConfig = { store, scopeId: 'owner:manual-parent' };
    const started = store.start({
      scopeId: subagentTasks.scopeId,
      idempotencyKey: 'parent-run:parent-agent:call-manual',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      parentToolCallId: 'call-manual',
      input: 'Research this.',
      subagentKind: 'agent',
      subagentType: 'researcher',
      run: (runtime: SubagentTaskRuntime) =>
        new Promise((_, reject) => {
          runtime.signal.addEventListener('abort', () => reject(runtime.signal.reason), {
            once: true,
          });
        }),
    });
    if (!started.accepted) {
      throw new Error('Expected subagent task to start.');
    }

    const polled = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'manual-parent',
        args: { background_task_id: started.task.taskId },
        subagentTasks,
      }),
    );
    expect(polled).toMatchObject({ status: 'running' });
    expect(polled.message).toBeUndefined();

    store.control(subagentTasks.scopeId, started.task.taskId, { action: 'cancel' });
  });

  it('routes parent control actions only to detached subagent tasks', async () => {
    const store = new InMemorySubagentTaskStore();
    const subagentTasks: SubagentTaskConfig = { store, scopeId: 'owner:parent-thread' };
    let finish = (_value: { content: string }): void => undefined;
    const result = new Promise<{ content: string }>((resolve) => {
      finish = resolve;
    });
    const started = store.start({
      scopeId: subagentTasks.scopeId,
      idempotencyKey: 'parent-run:parent-agent:call-2',
      parentRunId: 'parent-run',
      parentAgentId: 'parent-agent',
      parentToolCallId: 'call-2',
      input: 'Keep working.',
      subagentKind: 'agent',
      subagentType: 'researcher',
      run: async () => result,
    });
    if (!started.accepted) {
      throw new Error('Expected subagent task to start.');
    }
    await Promise.resolve();

    const queued = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'parent-thread',
        args: {
          background_task_id: started.task.taskId,
          action: 'queue',
          message: 'Also verify the source.',
        },
        subagentTasks,
      }),
    );
    expect(queued).toEqual(
      expect.objectContaining({ status: 'accepted', control_id: expect.any(String) }),
    );

    const cancelledMessage = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'parent-thread',
        args: {
          background_task_id: started.task.taskId,
          action: 'cancel_message',
          control_id: queued.control_id,
        },
        subagentTasks,
      }),
    );
    expect(cancelledMessage.status).toBe('accepted');

    const cancelledTask = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'parent-thread',
        args: { background_task_id: started.task.taskId, action: 'cancel' },
        subagentTasks,
      }),
    );
    expect(cancelledTask.status).toBe('cancelled');
    finish({ content: 'late result' });
  });

  it('derives a bounded control invocation identity from the tool call', async () => {
    const controlTask = jest.fn().mockResolvedValue({
      status: 'not_running',
      task: {
        taskId: 'remote-task',
        subagentType: 'researcher',
        status: 'completed',
        createdAt: 1,
        updatedAt: 2,
        resultAvailable: false,
        resultClaimed: true,
        pendingControls: 0,
      },
    });
    const store = Object.assign(new InMemorySubagentTaskStore(), {
      claimTask: jest.fn(),
      controlTask,
      listTasks: jest.fn(),
    });
    const control = (toolCallId: string | undefined) =>
      runCheckBackgroundTask({
        userId: 'owner',
        conversationId: 'parent-thread',
        args: {
          background_task_id: 'remote-task',
          action: 'queue',
          message: 'Check one more source.',
        },
        toolCallId,
        subagentTasks: { store, scopeId: 'owner:parent-thread' },
      });

    /** Replaying one tool call keeps its identity, so routing can replay the result. */
    await control('call_abc');
    await control('call_abc');
    const [firstInvocation, replayedInvocation] = controlTask.mock.calls.map((call) => call[3]);
    expect(firstInvocation).toBe(replayedInvocation);
    expect(firstInvocation).toHaveLength(32);

    /** A separate tool call is a separate command even with an identical payload. */
    await control('call_def');
    expect(controlTask.mock.calls[2][3]).not.toBe(firstInvocation);

    /** The same provider id in another run or agent is a different command. */
    await runCheckBackgroundTask({
      userId: 'owner',
      conversationId: 'parent-thread',
      args: {
        background_task_id: 'remote-task',
        action: 'queue',
        message: 'Check one more source.',
      },
      toolCallId: 'call_abc',
      runId: 'run-2:0',
      subagentTasks: { store, scopeId: 'owner:parent-thread' },
    });
    expect(controlTask.mock.calls[3][3]).not.toBe(firstInvocation);

    /** A provider id far past the protocol bound still routes as a bounded identity. */
    const longToolCallId = `call_${'x'.repeat(200)}`;
    await control(longToolCallId);
    await control(longToolCallId);
    const [longInvocation, replayedLongInvocation] = controlTask.mock.calls
      .slice(4)
      .map((call) => call[3]);
    expect(longInvocation).toHaveLength(32);
    expect(replayedLongInvocation).toBe(longInvocation);

    /** Without a tool-call id each invocation stays distinct rather than colliding. */
    await control(undefined);
    await control(undefined);
    const [fallback, otherFallback] = controlTask.mock.calls.slice(6).map((call) => call[3]);
    expect(fallback).not.toBe(otherFallback);
    expect(fallback.length).toBeLessThanOrEqual(128);
  });

  it('reports an unreachable remote subagent owner without pretending the task is missing', async () => {
    const store = Object.assign(new InMemorySubagentTaskStore(), {
      claimTask: jest.fn().mockRejectedValue(new SubagentTaskOwnerUnavailableError()),
      controlTask: jest.fn().mockRejectedValue(new SubagentTaskOwnerUnavailableError()),
      listTasks: jest.fn().mockRejectedValue(new SubagentTaskOwnerUnavailableError()),
    });
    const content = await runCheckBackgroundTask({
      userId: 'owner',
      conversationId: 'parent-thread',
      args: { background_task_id: 'remote-task' },
      subagentTasks: { store, scopeId: 'owner:parent-thread' },
    });

    expect(JSON.parse(content)).toEqual({
      status: 'unavailable',
      background_task_id: 'remote-task',
      message: 'The process running this subagent task is temporarily unavailable.',
    });
  });
});

describe('stripBackgroundFromToolRegistry', () => {
  it('drops the poll entry and the injected param without mutating the input', () => {
    const searchDef = mcpDef('search_mcp_docs');
    const registry: LCToolRegistry = new Map([['search_mcp_docs', { ...searchDef }]]);
    applyBackgroundToolCalls({
      toolDefinitions: [searchDef],
      toolRegistry: registry,
      toolOptions: { search_mcp_docs: { run_in_background: true } },
    });
    expect(registry.has(CHECK_BACKGROUND_TASK_NAME)).toBe(true);

    const stripped = stripBackgroundFromToolRegistry(registry, ['search_mcp_docs']);
    expect(stripped?.has(CHECK_BACKGROUND_TASK_NAME)).toBe(false);
    expect(
      (stripped?.get('search_mcp_docs')?.parameters as { properties: Record<string, unknown> })
        .properties[RUN_IN_BACKGROUND_ARG],
    ).toBeUndefined();
    // original untouched (parent still needs background)
    expect(registry.has(CHECK_BACKGROUND_TASK_NAME)).toBe(true);
  });
});

describe('buildBackgroundHandleContent', () => {
  it.each([{}, { completionWakeup: true }, { liveArtifactPollRequired: true }])(
    'keeps the server handle compatible with the client parser: %j',
    (options) => {
      const content = buildBackgroundHandleContent(
        { id: '2a6b05c3-327d-43f4-8196-73a6c8d88706', toolName: 'bash_tool', status: 'running' },
        options,
      );
      expect(parseBackgroundHandle(content)).toEqual(JSON.parse(content));
    },
  );
  it('produces a running handle carrying the id and poll instruction', () => {
    const registry = new BackgroundTaskRegistryClass();
    const created = registry.create({
      userId: 'u1',
      conversationId: 'c1',
      toolCallId: 'call_h',
      toolName: 'search_mcp_docs',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    const parsed = JSON.parse(buildBackgroundHandleContent(created.task));
    expect(parsed.background_task_id).toBe(created.task.id);
    expect(parsed.status).toBe('running');
    expect(parsed.message).toContain(CHECK_BACKGROUND_TASK_NAME);
    expect(Object.keys(parsed).sort()).toEqual(['background_task_id', 'message', 'status', 'tool']);
    expect(JSON.parse(parsed.message.split('Status request: ')[1])).toEqual({
      name: CHECK_BACKGROUND_TASK_NAME,
      arguments: { background_task_id: created.task.id },
    });
  });

  it('requires polling when the tool can return a process-local live artifact', () => {
    const parsed = JSON.parse(
      buildBackgroundHandleContent(
        { id: 'artifact-task', toolName: 'artifact_tool', status: 'running' },
        { completionWakeup: true, liveArtifactPollRequired: true },
      ),
    );

    expect(parsed.message).toContain('must call check_background_task');
    expect(parsed.message).toContain('do not end the turn');
  });
});

describe('toolOptionsSchema', () => {
  it('preserves run_in_background alongside the existing options', () => {
    const parsed = toolOptionsSchema.parse({
      defer_loading: true,
      run_in_background: true,
      allowed_callers: ['direct'],
    });
    expect(parsed.run_in_background).toBe(true);
    expect(parsed.defer_loading).toBe(true);
  });

  it('strips unknown keys but keeps run_in_background', () => {
    const parsed = toolOptionsSchema.parse({
      run_in_background: true,
      bogus: 'x',
    } as Record<string, unknown>);
    expect(parsed).toEqual({ run_in_background: true });
  });
});

describe('runCheckBackgroundTask delivery semantics', () => {
  const pendingControls = (
    overrides: {
      list?: () => Promise<unknown[]>;
      complete?: boolean;
      dead?: unknown[];
      subagentWakeups?: string[];
      discard?: () => Promise<string>;
    } = {},
  ) =>
    ({
      list: jest.fn(async () => ({
        completions: await (overrides.list ?? (async () => []))(),
        dead: overrides.dead ?? [],
        complete: overrides.complete ?? true,
      })),
      listSubagentWakeups: jest.fn(async () => ({
        taskIds: overrides.subagentWakeups ?? [],
        complete: true,
      })),
      discard: jest.fn(overrides.discard ?? (async () => 'not_pending')),
      settleClaimed: jest.fn(async () => true),
    }) as never;

  function completedWithWakeup(userId: string, conversationId: string, toolCallId: string) {
    const created = backgroundTaskRegistry.create({
      userId,
      conversationId,
      toolCallId,
      toolName: 'bash_tool',
      messageId: `${toolCallId}-message`,
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    backgroundTaskRegistry.markCompletionWakeup(userId, conversationId, created.task.id, {
      renew: jest.fn(async () => true),
      retire: jest.fn(async () => true),
    });
    backgroundTaskRegistry.complete(userId, conversationId, created.task.id, {
      content: 'finished output',
    });
    return created.task.id;
  }

  it('counts a finished task as outstanding until its result is delivered', async () => {
    const taskId = completedWithWakeup('outstanding-user', 'outstanding-convo', 'outstanding-call');

    const before = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'outstanding-user',
        conversationId: 'outstanding-convo',
        args: {},
      }),
    );
    expect(before.tasks[0]).toEqual(
      expect.objectContaining({
        background_task_id: taskId,
        status: 'completed',
        delivery: 'pending',
      }),
    );
    expect(before.outstanding).toBe(1);
    expect(before.message).toContain('have not been delivered yet');

    expect(
      backgroundTaskRegistry.claimResult('outstanding-user', 'outstanding-convo', taskId, {
        kind: 'wakeup',
        claimId: 'automatic-delivery',
      }),
    ).toBe('acquired');
    const after = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'outstanding-user',
        conversationId: 'outstanding-convo',
        args: {},
      }),
    );
    expect(after.tasks[0].delivery).toBe('delivered');
    expect(after.outstanding).toBe(0);
    expect(after.message).toBeUndefined();
  });

  it('counts running work as outstanding without claiming undelivered results', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'running-user',
      conversationId: 'running-convo',
      toolCallId: 'running-call',
      toolName: 'bash_tool',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }

    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'running-user',
        conversationId: 'running-convo',
        args: {},
      }),
    );
    expect(listed.tasks[0]).toEqual(expect.objectContaining({ status: 'running' }));
    expect(listed.tasks[0].delivery).toBeUndefined();
    expect(listed.outstanding).toBe(1);
    expect(listed.message).toBeUndefined();
  });

  it('lists undelivered results the process-local registry no longer holds', async () => {
    const localTaskId = completedWithWakeup('durable-user', 'durable-convo', 'durable-local');
    const pendingCompletions = pendingControls({
      list: async () => [
        {
          taskId: localTaskId,
          toolCallId: `call-${localTaskId}`,
          toolName: 'bash_tool',
          dispatchedAt: new Date('2026-09-24T12:00:00Z'),
          result: { status: 'completed', settledAt: new Date('2026-09-24T12:01:00Z') },
          claimedByWakeup: false,
        },
        {
          taskId: 'earlier-turn-task',
          toolCallId: 'call-earlier-turn-task',
          toolName: 'slow_task',
          dispatchedAt: new Date('2026-09-24T11:00:00Z'),
          result: { status: 'error', settledAt: new Date('2026-09-24T11:05:00Z') },
          claimedByWakeup: false,
        },
        {
          taskId: 'other-replica-task',
          toolCallId: 'call-other-replica-task',
          toolName: 'slow_task',
          dispatchedAt: new Date('2026-09-24T11:30:00Z'),
          claimedByWakeup: false,
        },
      ],
    });

    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'durable-user',
        conversationId: 'durable-convo',
        args: {},
        pendingCompletions,
      }),
    );

    expect(
      listed.tasks.map((task: { background_task_id: string }) => task.background_task_id),
    ).toEqual([localTaskId, 'earlier-turn-task', 'other-replica-task']);
    expect(listed.tasks[1]).toEqual(
      expect.objectContaining({
        status: 'error',
        delivery: 'pending',
        started_at: '2026-09-24T11:00:00.000Z',
        settled_at: '2026-09-24T11:05:00.000Z',
      }),
    );
    expect(listed.tasks[2]).toEqual(
      expect.objectContaining({ status: 'running', delivery: 'pending', progress: 0 }),
    );
    expect(listed.tasks[1].result).toBeUndefined();
    expect(listed.outstanding).toBe(3);
  });

  it('keeps listing local work when the durable view is unavailable', async () => {
    const taskId = completedWithWakeup('degraded-user', 'degraded-convo', 'degraded-call');
    const pendingCompletions = pendingControls({
      list: async () => {
        throw new Error('delivery store unavailable');
      },
    });

    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'degraded-user',
        conversationId: 'degraded-convo',
        args: {},
        pendingCompletions,
      }),
    );

    expect(
      listed.tasks.map((task: { background_task_id: string }) => task.background_task_id),
    ).toEqual([taskId]);
    expect(listed.partial).toBe(true);
    expect(listed.warning).toContain('Undelivered results from earlier turns could not be listed');
  });

  it.each([
    ['discarded', 'cancelled', 'will not arrive as a new turn'],
    ['running', 'unavailable', 'cannot be stopped from here'],
    ['delivering', 'delivery_scheduled', 'already being delivered'],
  ])(
    'reports a %s undelivered completion this process does not hold',
    async (outcome, status, message) => {
      const pendingCompletions = pendingControls({ discard: async () => outcome });

      const cancelled = JSON.parse(
        await runCheckBackgroundTask({
          userId: 'discard-user',
          conversationId: 'discard-convo',
          args: { background_task_id: 'earlier-turn-task', action: 'cancel' },
          pendingCompletions,
        }),
      );

      expect(cancelled).toEqual(
        expect.objectContaining({ status, background_task_id: 'earlier-turn-task' }),
      );
      expect(cancelled.message).toContain(message);
    },
  );

  it('reports a local task delivered once the durable store no longer holds its delivery', async () => {
    const delivered = completedWithWakeup('reconcile-user', 'reconcile-convo', 'reconcile-done');
    const waiting = completedWithWakeup('reconcile-user', 'reconcile-convo', 'reconcile-waiting');
    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'reconcile-user',
        conversationId: 'reconcile-convo',
        args: {},
        pendingCompletions: pendingControls({
          list: async () => [
            {
              taskId: waiting,
              toolCallId: `call-${waiting}`,
              toolName: 'bash_tool',
              dispatchedAt: new Date('2026-09-24T12:00:00Z'),
              result: { status: 'completed', settledAt: new Date('2026-09-24T12:01:00Z') },
              claimedByWakeup: false,
            },
          ],
        }),
      }),
    );

    const byId = new Map(
      listed.tasks.map((task: { background_task_id: string; delivery?: string }) => [
        task.background_task_id,
        task.delivery,
      ]),
    );
    expect(byId.get(delivered)).toBe('delivered');
    expect(byId.get(waiting)).toBe('pending');
    expect(listed.outstanding).toBe(1);
  });

  it('reports a local task whose automatic delivery dead-lettered as failed, not delivered', async () => {
    const taskId = completedWithWakeup('dead-user', 'dead-convo', 'dead-call');
    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'dead-user',
        conversationId: 'dead-convo',
        args: {},
        pendingCompletions: pendingControls({
          dead: [
            {
              taskId,
              toolCallId: `call-${taskId}`,
              toolName: 'bash_tool',
              dispatchedAt: new Date('2026-09-24T12:00:00Z'),
              claimedByWakeup: false,
            },
            {
              taskId: 'restored-dead-task',
              toolCallId: 'call-restored-dead-task',
              toolName: 'slow_task',
              dispatchedAt: new Date('2026-09-24T11:00:00Z'),
              result: { status: 'completed', settledAt: new Date('2026-09-24T11:01:00Z') },
              claimedByWakeup: false,
            },
          ],
        }),
      }),
    );

    expect(listed.tasks[0]).toEqual(
      expect.objectContaining({ background_task_id: taskId, delivery: 'failed' }),
    );
    /** A dead letter this process no longer holds is listed from the durable store. */
    expect(listed.tasks[1]).toEqual(
      expect.objectContaining({
        background_task_id: 'restored-dead-task',
        status: 'completed',
        delivery: 'failed',
      }),
    );
    expect(listed.outstanding).toBe(2);
    expect(listed.message).toContain('Automatic delivery failed');
  });

  it('retires the pending delivery when a local poll claims the durable result', async () => {
    const created = backgroundTaskRegistry.create({
      userId: 'local-claim-user',
      conversationId: 'local-claim-convo',
      toolCallId: 'local-claim-call',
      toolName: 'bash_tool',
      messageId: 'local-claim-message',
    });
    if ('atCapacity' in created) {
      throw new Error('unexpected capacity');
    }
    const retire = jest.fn(async () => true);
    backgroundTaskRegistry.markCompletionWakeup(
      'local-claim-user',
      'local-claim-convo',
      created.task.id,
      {
        renew: jest.fn(async () => true),
        retire,
      },
    );
    backgroundTaskRegistry.complete('local-claim-user', 'local-claim-convo', created.task.id, {
      content: 'finished output',
    });

    const polled = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'local-claim-user',
        conversationId: 'local-claim-convo',
        args: { background_task_id: created.task.id },
        claimBackgroundToolResult: jest.fn(async () => ({
          status: 'acquired' as const,
          results: [],
        })) as never,
      }),
    );

    expect(polled.status).toBe('completed');
    expect(retire).toHaveBeenCalledWith('completion claimed by manual poll', {
      onlyIfUnclaimed: true,
    });
    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'local-claim-user',
        conversationId: 'local-claim-convo',
        args: {},
      }),
    );
    expect(listed.tasks[0].delivery).toBe('delivered');
    expect(listed.outstanding).toBe(0);
  });

  it('keeps the local view and warns when the durable listing is incomplete', async () => {
    const taskId = completedWithWakeup('truncated-user', 'truncated-convo', 'truncated-call');
    const listed = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'truncated-user',
        conversationId: 'truncated-convo',
        args: {},
        pendingCompletions: pendingControls({ complete: false }),
      }),
    );

    expect(listed.tasks[0]).toEqual(
      expect.objectContaining({ background_task_id: taskId, delivery: 'pending' }),
    );
    expect(listed.outstanding).toBe(1);
    expect(listed.partial).toBe(true);
    expect(listed.warning).toContain('result list may be incomplete');
  });

  it('lets a finished local task be cancelled without the live-cancellation policy', async () => {
    const taskId = completedWithWakeup(
      'settled-cancel-user',
      'settled-cancel-convo',
      'settled-cancel',
    );

    const cancelled = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'settled-cancel-user',
        conversationId: 'settled-cancel-convo',
        args: { background_task_id: taskId, action: 'cancel' },
      }),
    );

    expect(cancelled.status).not.toBe('invalid');
    expect(cancelled).toEqual(
      expect.objectContaining({ background_task_id: taskId, status: 'completed' }),
    );
  });

  it('retires the pending delivery of a remote task a manual poll just claimed', async () => {
    const pendingCompletions = pendingControls();
    const claimBackgroundToolResult = jest.fn(async () => ({
      status: 'acquired' as const,
      results: [
        {
          taskId: 'remote-task',
          toolName: 'slow_task',
          status: 'completed' as const,
          output: 'remote result',
          settledAt: new Date('2026-09-24T12:00:00Z'),
        },
      ],
    }));

    const polled = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'remote-user',
        conversationId: 'remote-convo',
        args: { background_task_id: 'remote-task' },
        claimBackgroundToolResult: claimBackgroundToolResult as never,
        pendingCompletions,
      }),
    );

    expect(polled).toEqual(
      expect.objectContaining({ status: 'completed', result: 'remote result' }),
    );
    expect(
      (pendingCompletions as unknown as { settleClaimed: jest.Mock }).settleClaimed,
    ).toHaveBeenCalledWith({
      userId: 'remote-user',
      conversationId: 'remote-convo',
      taskId: 'remote-task',
    });
  });

  it('reports a failed discard lookup only when nothing else claims the task', async () => {
    const cancelled = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'discard-user',
        conversationId: 'discard-convo',
        args: { background_task_id: 'unknown-task', action: 'cancel' },
        pendingCompletions: pendingControls({
          discard: async () => {
            throw new Error('delivery store unavailable');
          },
        }),
      }),
    );

    expect(cancelled).toEqual(expect.objectContaining({ status: 'unavailable' }));
    expect(cancelled.message).toContain('could not be discarded right now');
  });

  it('falls through to the ordinary lookup when nothing is pending for the task', async () => {
    const pendingCompletions = pendingControls({ discard: async () => 'not_pending' });

    const cancelled = JSON.parse(
      await runCheckBackgroundTask({
        userId: 'discard-user',
        conversationId: 'discard-convo',
        args: { background_task_id: 'unknown-task', action: 'cancel' },
        pendingCompletions,
      }),
    );

    expect(cancelled).toEqual(expect.objectContaining({ status: 'not_found' }));
  });
});
