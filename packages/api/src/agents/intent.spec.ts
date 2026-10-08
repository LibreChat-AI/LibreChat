import { logger } from '@librechat/data-schemas';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import {
  INTENT_ARG,
  NATIVE_INTENT_TOOL_NAMES,
  isIntentEligibleToolName,
  hasIntentArg,
  readIntentArg,
  stripIntentArg,
  injectIntentParam,
  stripIntentFromToolDefinitions,
  stripIntentLabelsFromToolDefinitions,
  stripIntentFromToolRegistry,
  applyIntentLabels,
  sanitizeIntentLabels,
  synthesizeIntentToolOptions,
} from './intent';
import { applyBackgroundToolCalls, CHECK_BACKGROUND_TASK_NAME } from './background';
import { mergeSynthesizedToolOptions, TOOL_SELECTION_WILDCARD } from './selection';
import { toolOptionsSchema } from './validation';

const mcpDef = (name: string): LCTool =>
  ({
    name,
    description: `${name} description`,
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  }) as unknown as LCTool;

/** Mirrors an SDK-native intent schema: the label contract's marker text. */
const sdkNativeDef = (name: string): LCTool =>
  ({
    name,
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description:
            'ALWAYS write this field FIRST, before any other argument. One short sentence…',
        },
        query: { type: 'string' },
      },
      required: ['query'],
    },
  }) as unknown as LCTool;

describe('isIntentEligibleToolName', () => {
  it('excludes the poll tool, handoff tools, and the rebuilt ask tool', () => {
    expect(isIntentEligibleToolName(CHECK_BACKGROUND_TASK_NAME)).toBe(false);
    expect(isIntentEligibleToolName('lc_transfer_to_researcher')).toBe(false);
    /** `createRun` strips this definition and rebuilds the graph tool from
     *  its own Zod schema, so definition-level injection never reaches the
     *  model; eligibility must say so or a selection credits a dead label. */
    expect(isIntentEligibleToolName('ask_user_question')).toBe(false);
  });

  it('allows MCP, native, and code-execution tools (labels are inert)', () => {
    for (const name of [
      'search_mcp_docs',
      'web_search',
      'create_file',
      'edit_file',
      'set_memory',
      'delete_memory',
      'execute_code',
      'bash_tool',
      'file_search',
    ]) {
      expect(isIntentEligibleToolName(name)).toBe(true);
    }
  });
});

describe('hasIntentArg / readIntentArg / stripIntentArg', () => {
  it('detects and reads the arg on object and stringified args', () => {
    expect(hasIntentArg({ [INTENT_ARG]: 'Searching for OAuth handling' })).toBe(true);
    expect(hasIntentArg({})).toBe(false);
    expect(hasIntentArg('{"intent":"Searching"}')).toBe(true);
    expect(readIntentArg({ [INTENT_ARG]: 'Searching for OAuth handling' })).toBe(
      'Searching for OAuth handling',
    );
    expect(readIntentArg({ [INTENT_ARG]: '   ' })).toBeUndefined();
    expect(readIntentArg({ [INTENT_ARG]: 42 })).toBeUndefined();
    expect(readIntentArg('not json')).toBeUndefined();
  });

  it('strips the arg without mutating the original', () => {
    const args = { q: 'hi', [INTENT_ARG]: 'Searching' };
    const stripped = stripIntentArg(args) as Record<string, unknown>;
    expect(stripped).toEqual({ q: 'hi' });
    expect(INTENT_ARG in args).toBe(true);
  });

  it('returns non-object / arg-less args unchanged', () => {
    expect(stripIntentArg('str')).toBe('str');
    const noArg = { q: 'hi' };
    expect(stripIntentArg(noArg)).toBe(noArg);
    expect(stripIntentArg('{"intent":"Searching","q":"x"}')).toEqual({ q: 'x' });
    expect(stripIntentArg('{"q":"x"}')).toBe('{"q":"x"}');
  });
});

describe('injectIntentParam', () => {
  it('PREPENDS intent as the FIRST property without mutating a frozen def', () => {
    const def = Object.freeze(mcpDef('search_mcp_docs')) as unknown as LCTool & {
      parameters: { properties: Record<string, unknown> };
    };
    const injected = injectIntentParam(def);
    const props = (injected.parameters as { properties: Record<string, { type: string }> })
      .properties;
    expect(Object.keys(props)).toEqual([INTENT_ARG, 'q']);
    expect(props[INTENT_ARG]).toEqual(expect.objectContaining({ type: 'string' }));
    expect(INTENT_ARG in def.parameters.properties).toBe(false);
  });

  it('never adds intent to required', () => {
    const injected = injectIntentParam(mcpDef('search_mcp_docs'));
    expect((injected.parameters as { required?: string[] }).required).toEqual(['q']);
  });

  it('creates an object schema when the tool declares no parameters', () => {
    const def = { name: 'no_params' } as unknown as LCTool;
    const injected = injectIntentParam(def);
    const params = injected.parameters as { type: string; properties: Record<string, unknown> };
    expect(params.type).toBe('object');
    expect(Object.keys(params.properties)).toEqual([INTENT_ARG]);
  });

  it('is a no-op when the param already exists (position preserved)', () => {
    const def = mcpDef('search_mcp_docs');
    const once = injectIntentParam(def);
    const twice = injectIntentParam(once);
    expect(twice).toBe(once);
    expect(Object.keys((twice.parameters as { properties: object }).properties)[0]).toBe(
      INTENT_ARG,
    );
  });

  it('embeds an extensible copy of the property, not a frozen shared instance', () => {
    const first = injectIntentParam(mcpDef('a'));
    const second = injectIntentParam(mcpDef('b'));
    const firstProp = (first.parameters as { properties: Record<string, object> }).properties[
      INTENT_ARG
    ];
    const secondProp = (second.parameters as { properties: Record<string, object> }).properties[
      INTENT_ARG
    ];
    expect(firstProp).not.toBe(secondProp);
    expect(Object.isFrozen(firstProp)).toBe(false);
  });
});

describe('applyIntentLabels', () => {
  it('injects only opted-in tools and mirrors the registry entry', () => {
    const optedIn = mcpDef('search_mcp_docs');
    const notOpted = mcpDef('lookup_customer');
    const toolRegistry: LCToolRegistry = new Map([
      ['search_mcp_docs', optedIn],
      ['lookup_customer', notOpted],
    ]);
    const { toolDefinitions, intentToolNames } = applyIntentLabels({
      toolDefinitions: [optedIn, notOpted],
      toolRegistry,
      toolOptions: { search_mcp_docs: { describe_intent: true } },
    });
    expect(intentToolNames).toEqual(['search_mcp_docs']);
    const injected = toolDefinitions.find((d) => d.name === 'search_mcp_docs');
    expect(Object.keys((injected?.parameters as { properties: object }).properties)[0]).toBe(
      INTENT_ARG,
    );
    expect(toolDefinitions.find((d) => d.name === 'lookup_customer')).toBe(notOpted);
    const registryProps = (
      toolRegistry.get('search_mcp_docs')?.parameters as { properties: object }
    ).properties;
    expect(Object.keys(registryProps)[0]).toBe(INTENT_ARG);
  });

  it('defaults native host tools ON, with explicit false opting out', () => {
    const webSearch = mcpDef('web_search');
    const setMemory = mcpDef('set_memory');
    const { toolDefinitions, intentToolNames } = applyIntentLabels({
      toolDefinitions: [webSearch, setMemory],
      toolRegistry: undefined,
      toolOptions: { set_memory: { describe_intent: false } },
    });
    expect(intentToolNames).toEqual(['web_search']);
    expect(toolDefinitions.find((d) => d.name === 'set_memory')).toBe(setMemory);
  });

  it('covers every advertised native tool name', () => {
    const defs = [...NATIVE_INTENT_TOOL_NAMES].map((name) => mcpDef(name));
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: defs,
      toolRegistry: undefined,
      toolOptions: undefined,
    });
    expect(intentToolNames.sort()).toEqual([...NATIVE_INTENT_TOOL_NAMES].sort());
  });

  it('skips SDK-native defs that already declare intent (not counted as host-injected)', () => {
    const sdkNative = {
      name: 'read_file',
      parameters: {
        type: 'object',
        properties: { intent: { type: 'string' }, path: { type: 'string' } },
      },
    } as unknown as LCTool;
    const { toolDefinitions, intentToolNames } = applyIntentLabels({
      toolDefinitions: [sdkNative],
      toolRegistry: undefined,
      toolOptions: { read_file: { describe_intent: true } },
    });
    expect(intentToolNames).toEqual([]);
    expect(toolDefinitions[0]).toBe(sdkNative);
  });

  it('strips an SDK-native intent property on explicit opt-out (def and registry)', () => {
    const sdkNative = sdkNativeDef('web_search');
    const toolRegistry: LCToolRegistry = new Map([['web_search', sdkNative]]);
    const { toolDefinitions, intentToolNames } = applyIntentLabels({
      toolDefinitions: [sdkNative],
      toolRegistry,
      toolOptions: { web_search: { describe_intent: false } },
    });
    expect(intentToolNames).toEqual([]);
    const strippedProps = (toolDefinitions[0].parameters as { properties: object }).properties;
    expect(Object.keys(strippedProps)).toEqual(['query']);
    const registryProps = (toolRegistry.get('web_search')?.parameters as { properties: object })
      .properties;
    expect(INTENT_ARG in registryProps).toBe(false);
    expect(INTENT_ARG in (sdkNative.parameters as { properties: object }).properties).toBe(true);
  });

  it('never strips a tool-owned business `intent` parameter on opt-out', () => {
    const businessIntent = {
      name: 'create_record',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'CRM intent category for the record' },
          title: { type: 'string' },
        },
        required: ['intent'],
      },
    } as unknown as LCTool;
    const { toolDefinitions } = applyIntentLabels({
      toolDefinitions: [businessIntent],
      toolRegistry: undefined,
      toolOptions: { create_record: { describe_intent: false } },
    });
    expect(toolDefinitions[0]).toBe(businessIntent);
  });

  it('skips a non-object (string-input) schema without rewriting it', () => {
    const stringInput = {
      name: 'legacy_tool',
      parameters: { type: 'string' },
    } as unknown as LCTool;
    const { toolDefinitions, intentToolNames } = applyIntentLabels({
      toolDefinitions: [stringInput],
      toolRegistry: undefined,
      toolOptions: { legacy_tool: { describe_intent: true } },
    });
    expect(intentToolNames).toEqual([]);
    expect(toolDefinitions[0]).toBe(stringInput);
  });

  it('skips PTC-only tools (no card ever renders)', () => {
    const ptcOnly = {
      ...mcpDef('sandbox_helper'),
      allowed_callers: ['code_execution'],
    } as unknown as LCTool;
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [ptcOnly],
      toolRegistry: undefined,
      toolOptions: { sandbox_helper: { describe_intent: true } },
    });
    expect(intentToolNames).toEqual([]);
  });

  it('honors the host excludeTool predicate', () => {
    const def = mcpDef('search_mcp_ephemeral');
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [def],
      toolRegistry: undefined,
      toolOptions: { search_mcp_ephemeral: { describe_intent: true } },
      excludeTool: () => true,
    });
    expect(intentToolNames).toEqual([]);
  });

  it('keeps intent FIRST when background injection runs after it', () => {
    const def = mcpDef('search_mcp_docs');
    const toolRegistry: LCToolRegistry = new Map([['search_mcp_docs', def]]);
    const toolOptions = {
      search_mcp_docs: { describe_intent: true, run_in_background: true },
    };
    const intentResult = applyIntentLabels({
      toolDefinitions: [def],
      toolRegistry,
      toolOptions,
    });
    const backgroundResult = applyBackgroundToolCalls({
      toolDefinitions: intentResult.toolDefinitions,
      toolRegistry,
      toolOptions,
    });
    const finalDef = backgroundResult.toolDefinitions.find((d) => d.name === 'search_mcp_docs');
    const keys = Object.keys((finalDef?.parameters as { properties: object }).properties);
    expect(keys[0]).toBe(INTENT_ARG);
    expect(keys).toContain('run_in_background');
    expect(backgroundResult.backgroundToolNames).toEqual(['search_mcp_docs']);
  });

  it('keeps intent FIRST when injected AFTER background (initialize.ts ordering)', () => {
    const def = mcpDef('search_mcp_docs');
    const toolRegistry: LCToolRegistry = new Map([['search_mcp_docs', def]]);
    const toolOptions = {
      search_mcp_docs: { describe_intent: true, run_in_background: true },
    };
    const backgroundResult = applyBackgroundToolCalls({
      toolDefinitions: [def],
      toolRegistry,
      toolOptions,
    });
    const intentResult = applyIntentLabels({
      toolDefinitions: backgroundResult.toolDefinitions,
      toolRegistry,
      toolOptions,
    });
    const finalDef = intentResult.toolDefinitions.find((d) => d.name === 'search_mcp_docs');
    const keys = Object.keys((finalDef?.parameters as { properties: object }).properties);
    expect(keys[0]).toBe(INTENT_ARG);
    expect(keys).toContain('run_in_background');
  });
});

describe('stripIntentLabelsFromToolDefinitions', () => {
  it('strips host-injected AND SDK-native labels, sparing business intent params', () => {
    const hostInjected = injectIntentParam(mcpDef('search_mcp_docs'));
    const sdkNative = sdkNativeDef('read_file');
    const businessIntent = {
      name: 'create_record',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'CRM intent category' },
        },
        required: ['intent'],
      },
    } as unknown as LCTool;
    const stripped = stripIntentLabelsFromToolDefinitions([
      hostInjected,
      sdkNative,
      businessIntent,
    ]);
    expect(INTENT_ARG in (stripped[0].parameters as { properties: object }).properties).toBe(false);
    expect(INTENT_ARG in (stripped[1].parameters as { properties: object }).properties).toBe(false);
    expect(stripped[2]).toBe(businessIntent);
  });

  it('returns the same array when nothing carries a label', () => {
    const defs = [mcpDef('a'), mcpDef('b')];
    expect(stripIntentLabelsFromToolDefinitions(defs)).toBe(defs);
  });
});

describe('stripIntentFromToolDefinitions / stripIntentFromToolRegistry', () => {
  it('removes the injected param only from named tools, without mutating inputs', () => {
    const injected = injectIntentParam(mcpDef('search_mcp_docs'));
    const sdkNative = injectIntentParam(mcpDef('read_file'));
    const defs = [injected, sdkNative];
    const stripped = stripIntentFromToolDefinitions(defs, ['search_mcp_docs']);
    const searchDef = stripped.find((d) => d.name === 'search_mcp_docs');
    expect(INTENT_ARG in (searchDef?.parameters as { properties: object }).properties).toBe(false);
    expect(stripped.find((d) => d.name === 'read_file')).toBe(sdkNative);
    expect(INTENT_ARG in (injected.parameters as { properties: object }).properties).toBe(true);
  });

  it('returns the same references when nothing is named', () => {
    const defs = [injectIntentParam(mcpDef('a'))];
    expect(stripIntentFromToolDefinitions(defs, [])).toBe(defs);
    const registry: LCToolRegistry = new Map([['a', defs[0]]]);
    expect(stripIntentFromToolRegistry(registry, undefined)).toBe(registry);
  });

  it('registry strip returns a NEW registry with the param removed', () => {
    const injected = injectIntentParam(mcpDef('search_mcp_docs'));
    const registry: LCToolRegistry = new Map([['search_mcp_docs', injected]]);
    const next = stripIntentFromToolRegistry(registry, ['search_mcp_docs']);
    expect(next).not.toBe(registry);
    const props = (next?.get('search_mcp_docs')?.parameters as { properties: object }).properties;
    expect(INTENT_ARG in props).toBe(false);
    const originalProps = (registry.get('search_mcp_docs')?.parameters as { properties: object })
      .properties;
    expect(INTENT_ARG in originalProps).toBe(true);
  });
});

describe('capability marker projection', () => {
  const memoryDefs = (): LCTool[] => [mcpDef('set_memory'), mcpDef('delete_memory')];
  /** What `initializeAgent` records from the registrars' own reports. */
  const MEMORY_MAP = new Map([['memory', ['set_memory', 'delete_memory']]]);
  const CODE_MAP = new Map([
    ['execute_code', ['read_file', 'bash_tool', 'create_file', 'edit_file']],
  ]);

  it('projects a marker OPT-OUT onto the names its capability registered', () => {
    /** A spec's tools carry `memory`, but initialization registers
     *  set_memory/delete_memory — both default-on natives, so without
     *  projection a marker opt-out would leave them labelled. */
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: memoryDefs(),
      toolRegistry: undefined,
      toolOptions: { memory: { describe_intent: false } },
      capabilityToolNames: MEMORY_MAP,
    });
    expect(intentToolNames).toEqual([]);
  });

  it('projects a marker OPT-IN onto the names its capability registered', () => {
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [mcpDef('bash_tool')],
      toolRegistry: undefined,
      toolOptions: { execute_code: { describe_intent: true } },
      capabilityToolNames: CODE_MAP,
    });
    expect(intentToolNames).toEqual(['bash_tool']);
  });

  it('covers file-authoring tools registered by the code capability', () => {
    /** create_file/edit_file are default-on natives the code capability
     *  registers, so a code opt-out must reach them, not just bash_tool. */
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [mcpDef('create_file'), mcpDef('edit_file')],
      toolRegistry: undefined,
      toolOptions: { execute_code: { describe_intent: false } },
      capabilityToolNames: CODE_MAP,
    });
    expect(intentToolNames).toEqual([]);
  });

  it('lets an explicit per-tool entry win over the marker', () => {
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: memoryDefs(),
      toolRegistry: undefined,
      toolOptions: {
        memory: { describe_intent: false },
        set_memory: { describe_intent: true },
      },
      capabilityToolNames: MEMORY_MAP,
    });
    expect(intentToolNames).toEqual(['set_memory']);
  });

  it('lets an opting-in marker win over an opting-out one for a shared tool', () => {
    /** read_file registers under both code and skills; opting into skills
     *  must not be vetoed by a code opt-out. */
    const shared = new Map([
      ['execute_code', ['read_file', 'bash_tool']],
      ['skills', ['skill', 'read_file']],
    ]);
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [mcpDef('read_file')],
      toolRegistry: undefined,
      toolOptions: {
        execute_code: { describe_intent: false },
        skills: { describe_intent: true },
      },
      capabilityToolNames: shared,
    });
    expect(intentToolNames).toEqual(['read_file']);
  });

  it('carries a marker opt-out through the capability-on sanitize pass', () => {
    /** SDK-native labels persist unless sanitize resolves an opt-out. */
    const nativeBash = sdkNativeDef('bash_tool');
    const { toolDefinitions } = sanitizeIntentLabels({
      toolDefinitions: [nativeBash],
      toolRegistry: undefined,
      toolOptions: { execute_code: { describe_intent: false } },
      capabilityEnabled: true,
      capabilityToolNames: CODE_MAP,
    });
    expect(INTENT_ARG in (toolDefinitions[0].parameters as { properties: object }).properties).toBe(
      false,
    );
  });

  it('leaves options untouched when no marker is present', () => {
    const options = { web_search: { describe_intent: true } };
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [mcpDef('web_search')],
      toolRegistry: undefined,
      toolOptions: options,
    });
    expect(intentToolNames).toEqual(['web_search']);
    expect(options).toEqual({ web_search: { describe_intent: true } });
  });
});

describe('sanitizeIntentLabels', () => {
  it('strips every SDK-native label when the capability is disabled (kill switch)', () => {
    const skill = sdkNativeDef('skill');
    const search = sdkNativeDef('tool_search');
    const toolRegistry: LCToolRegistry = new Map([
      ['skill', skill],
      ['tool_search', search],
    ]);
    const { toolDefinitions } = sanitizeIntentLabels({
      toolDefinitions: [skill, search],
      toolRegistry,
      toolOptions: undefined,
      capabilityEnabled: false,
    });
    for (const def of toolDefinitions) {
      expect(INTENT_ARG in (def.parameters as { properties: object }).properties).toBe(false);
    }
    for (const entry of toolRegistry.values()) {
      expect(INTENT_ARG in (entry.parameters as { properties: object }).properties).toBe(false);
    }
    expect(INTENT_ARG in (skill.parameters as { properties: object }).properties).toBe(true);
  });

  it('leaves defs untouched when the capability is on and nothing opted out', () => {
    const skill = sdkNativeDef('skill');
    const defs = [skill];
    const { toolDefinitions, semanticIntentToolNames } = sanitizeIntentLabels({
      toolDefinitions: defs,
      toolRegistry: undefined,
      toolOptions: undefined,
      capabilityEnabled: true,
    });
    expect(toolDefinitions).toBe(defs);
    expect(semanticIntentToolNames).toEqual(['skill']);
  });

  it('projects only surviving marker-verified intent schemas for compaction', () => {
    const skill = sdkNativeDef('skill');
    const hostInjected = injectIntentParam(mcpDef('web_search'));
    const optedOut = sdkNativeDef('read_file');
    const businessIntent = {
      name: 'create_record',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'CRM intent category for the record' },
        },
      },
    } as unknown as LCTool;
    const registryOnly = sdkNativeDef('tool_search');
    const toolRegistry: LCToolRegistry = new Map([['tool_search', registryOnly]]);

    const { semanticIntentToolNames, semanticIntentBlockedToolNames } = sanitizeIntentLabels({
      toolDefinitions: [skill, hostInjected, optedOut, businessIntent],
      toolRegistry,
      toolOptions: { read_file: { describe_intent: false } },
      capabilityEnabled: true,
    });

    expect(semanticIntentToolNames).toEqual(['skill', 'web_search', 'tool_search']);
    expect(semanticIntentBlockedToolNames).toEqual(['read_file', 'create_record']);
  });

  it('projects no semantic intent names when the capability is disabled', () => {
    const { semanticIntentToolNames, semanticIntentBlockedToolNames } = sanitizeIntentLabels({
      toolDefinitions: [sdkNativeDef('skill')],
      toolRegistry: undefined,
      toolOptions: undefined,
      capabilityEnabled: false,
    });

    expect(semanticIntentToolNames).toEqual([]);
    expect(semanticIntentBlockedToolNames).toEqual(['skill']);
  });

  it('enforces explicit opt-outs on late-registered defs when the capability is on', () => {
    const skill = sdkNativeDef('skill');
    const toolRegistry: LCToolRegistry = new Map([['skill', skill]]);
    const { toolDefinitions } = sanitizeIntentLabels({
      toolDefinitions: [skill],
      toolRegistry,
      toolOptions: { skill: { describe_intent: false } },
      capabilityEnabled: true,
    });
    expect(INTENT_ARG in (toolDefinitions[0].parameters as { properties: object }).properties).toBe(
      false,
    );
    expect(
      INTENT_ARG in (toolRegistry.get('skill')?.parameters as { properties: object }).properties,
    ).toBe(false);
  });

  it('spares tool-owned business intent params in both modes', () => {
    const businessIntent = {
      name: 'create_record',
      parameters: {
        type: 'object',
        properties: {
          intent: { type: 'string', description: 'CRM intent category for the record' },
        },
        required: ['intent'],
      },
    } as unknown as LCTool;
    for (const capabilityEnabled of [true, false]) {
      const { toolDefinitions } = sanitizeIntentLabels({
        toolDefinitions: [businessIntent],
        toolRegistry: undefined,
        toolOptions: { create_record: { describe_intent: false } },
        capabilityEnabled,
      });
      expect(toolDefinitions[0]).toBe(businessIntent);
    }
  });
});

describe('synthesizeIntentToolOptions', () => {
  it('returns undefined when neither the ephemeral toggle nor the model spec enables it', () => {
    expect(synthesizeIntentToolOptions({})).toBeUndefined();
    expect(
      synthesizeIntentToolOptions({
        ephemeralAgent: { describe_intent: false },
        modelSpec: { describeIntent: false },
      }),
    ).toBeUndefined();
  });

  it('records boolean/ephemeral modes as a wildcard opt-in (no name enumeration)', () => {
    const expected = { [TOOL_SELECTION_WILDCARD]: { describe_intent: true } };
    expect(synthesizeIntentToolOptions({ modelSpec: { describeIntent: true } })).toEqual(expected);
    expect(synthesizeIntentToolOptions({ ephemeralAgent: { describe_intent: true } })).toEqual(
      expected,
    );
  });

  it('records a list as a wildcard opt-out plus verbatim opt-ins', () => {
    /** Names are recorded verbatim — markers, late-registered definitions,
     *  and lazily-expanded MCP names all resolve at injection time, where the
     *  final definitions exist. */
    expect(
      synthesizeIntentToolOptions({
        modelSpec: { describeIntent: ['web_search', 'execute_code'] },
      }),
    ).toEqual({
      [TOOL_SELECTION_WILDCARD]: { describe_intent: false },
      web_search: { describe_intent: true },
      execute_code: { describe_intent: true },
    });
  });

  it('treats an empty list as an explicit none', () => {
    expect(synthesizeIntentToolOptions({ modelSpec: { describeIntent: [] } })).toEqual({
      [TOOL_SELECTION_WILDCARD]: { describe_intent: false },
    });
  });

  it('drops and warns about a literal wildcard in the list (reserved)', () => {
    /** A verbatim `*` entry would overwrite the opt-out default and silently
     *  enable every tool instead of the named selection. */
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    expect(
      synthesizeIntentToolOptions({
        modelSpec: { describeIntent: [TOOL_SELECTION_WILDCARD, 'web_search'] },
      }),
    ).toEqual({
      [TOOL_SELECTION_WILDCARD]: { describe_intent: false },
      web_search: { describe_intent: true },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reserved'));
    warn.mockRestore();
  });

  it('the ephemeral toggle stays global even when the spec narrows', () => {
    /** The ephemeral switch has no per-tool UI, so it must not be narrowed by
     *  a co-present spec list — otherwise enabling it would silently cover
     *  fewer tools than the user asked for. */
    expect(
      synthesizeIntentToolOptions({
        ephemeralAgent: { describe_intent: true },
        modelSpec: { describeIntent: ['web_search'] },
      }),
    ).toEqual({ [TOOL_SELECTION_WILDCARD]: { describe_intent: true } });
  });
});

describe('selection policy at injection time', () => {
  it('a narrowing selection opts out defaults and SDK-native labels alike', () => {
    /** `describeIntent: []` with code enabled must reach EVERY definition the
     *  capability registered — bash_tool/read_file (SDK-native labels) and
     *  create_file/edit_file (default-on natives) — not just a legacy pair. */
    const toolOptions = synthesizeIntentToolOptions({ modelSpec: { describeIntent: [] } });
    const capabilityToolNames = new Map([
      ['execute_code', ['read_file', 'bash_tool', 'create_file', 'edit_file']],
    ]);
    const applied = applyIntentLabels({
      toolDefinitions: [
        sdkNativeDef('bash_tool'),
        sdkNativeDef('read_file'),
        mcpDef('create_file'),
        mcpDef('edit_file'),
      ],
      toolRegistry: undefined,
      toolOptions,
      capabilityToolNames,
    });
    expect(applied.intentToolNames).toEqual([]);
    const { toolDefinitions } = sanitizeIntentLabels({
      toolDefinitions: applied.toolDefinitions,
      toolRegistry: undefined,
      toolOptions,
      capabilityEnabled: true,
      capabilityToolNames,
    });
    for (const def of toolDefinitions) {
      expect(INTENT_ARG in (def.parameters as { properties: object }).properties).toBe(false);
    }
  });

  it('a narrowing selection governs the late-registered skill definition', () => {
    /** A spec's `skills` never reaches the `tools` array, so no load-time
     *  enumeration could see it; the wildcard opt-out reaches the definition
     *  in the post-catalog sanitize pass. */
    const toolOptions = synthesizeIntentToolOptions({
      modelSpec: { describeIntent: ['web_search'] },
    });
    const { toolDefinitions } = sanitizeIntentLabels({
      toolDefinitions: [sdkNativeDef('skill')],
      toolRegistry: undefined,
      toolOptions,
      capabilityEnabled: true,
      capabilityToolNames: new Map([['skills', ['skill', 'read_file']]]),
    });
    expect(INTENT_ARG in (toolDefinitions[0].parameters as { properties: object }).properties).toBe(
      false,
    );
  });

  it('naming `skills` in the selection keeps the skill label', () => {
    const toolOptions = synthesizeIntentToolOptions({ modelSpec: { describeIntent: ['skills'] } });
    const { toolDefinitions } = sanitizeIntentLabels({
      toolDefinitions: [sdkNativeDef('skill')],
      toolRegistry: undefined,
      toolOptions,
      capabilityEnabled: true,
      capabilityToolNames: new Map([['skills', ['skill', 'read_file']]]),
    });
    expect(INTENT_ARG in (toolDefinitions[0].parameters as { properties: object }).properties).toBe(
      true,
    );
  });

  it('a wildcard opt-in covers tools unknown at load time (lazy MCP expansion)', () => {
    const toolOptions = synthesizeIntentToolOptions({ modelSpec: { describeIntent: true } });
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [mcpDef('search_mcp_overlay_server')],
      toolRegistry: undefined,
      toolOptions,
    });
    expect(intentToolNames).toEqual(['search_mcp_overlay_server']);
  });

  it('diagnoses a selection naming the rebuilt ask tool instead of crediting a dead label', () => {
    /** The provisional `ask_user_question` definition is discarded by
     *  `createRun` and rebuilt without an intent field, so a selection
     *  naming it must warn rather than inject into a definition the model
     *  never sees. */
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const toolOptions = synthesizeIntentToolOptions({
      modelSpec: { describeIntent: ['ask_user_question'] },
    });
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [mcpDef('ask_user_question')],
      toolRegistry: undefined,
      toolOptions,
    });
    expect(intentToolNames).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ask_user_question'));
    warn.mockRestore();
  });

  it('still enforces eligibility for explicitly named tools, and diagnoses them', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const toolOptions = synthesizeIntentToolOptions({
      modelSpec: { describeIntent: ['web_search', CHECK_BACKGROUND_TASK_NAME] },
    });
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [mcpDef('web_search'), mcpDef(CHECK_BACKGROUND_TASK_NAME)],
      toolRegistry: undefined,
      toolOptions,
    });
    expect(intentToolNames).toEqual(['web_search']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(CHECK_BACKGROUND_TASK_NAME));
    warn.mockRestore();
  });

  it('warns about selection names that never took effect, rather than silently skipping', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const toolOptions = synthesizeIntentToolOptions({
      modelSpec: { describeIntent: ['web_search', 'typo_tool_name'] },
    });
    const { intentToolNames } = applyIntentLabels({
      toolDefinitions: [mcpDef('web_search')],
      toolRegistry: undefined,
      toolOptions,
    });
    expect(intentToolNames).toEqual(['web_search']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('typo_tool_name'));
    warn.mockRestore();
  });

  it('does not warn about saved-agent options with no narrowing policy', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    applyIntentLabels({
      toolDefinitions: [mcpDef('web_search')],
      toolRegistry: undefined,
      toolOptions: { stale_tool: { describe_intent: true } },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('mergeSynthesizedToolOptions', () => {
  it('merges per-tool entries without dropping sibling keys', () => {
    const merged = mergeSynthesizedToolOptions(
      { web_search: { run_in_background: true }, other: { defer_loading: true } },
      { web_search: { describe_intent: true } },
    );
    expect(merged).toEqual({
      web_search: { run_in_background: true, describe_intent: true },
      other: { defer_loading: true },
    });
  });

  it('passes through when either side is absent', () => {
    const base = { web_search: { run_in_background: true } };
    expect(mergeSynthesizedToolOptions(base, undefined)).toBe(base);
    const extra = { web_search: { describe_intent: true } };
    expect(mergeSynthesizedToolOptions(undefined, extra)).toBe(extra);
  });
});

describe('toolOptionsSchema', () => {
  it('preserves describe_intent alongside the existing options', () => {
    const parsed = toolOptionsSchema.parse({
      defer_loading: true,
      run_in_background: true,
      describe_intent: true,
    });
    expect(parsed).toEqual({
      defer_loading: true,
      run_in_background: true,
      describe_intent: true,
    });
  });

  it('strips unknown keys but keeps describe_intent', () => {
    const parsed = toolOptionsSchema.parse({ describe_intent: false, bogus: 1 });
    expect(parsed).toEqual({ describe_intent: false });
  });
});
