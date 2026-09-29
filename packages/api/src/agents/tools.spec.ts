/**
 * `@librechat/agents` may ship without the skill-flavored tool definitions on
 * older installed versions. Stub them so `registerCodeExecutionTools` (which
 * consumes only the three exports below) can be exercised deterministically.
 * Mirrors the same pattern used in `__tests__/skills.test.ts`.
 */
jest.mock('@librechat/agents', () => ({
  CODE_EXECUTION_TOOLS: new Set(['execute_code', 'bash_tool']),
  Constants: { READ_FILE: 'read_file', WRITE_FILE: 'write_file' },
  ReadFileToolDefinition: {
    name: 'read_file',
    description: 'read skill files using {skillName}/{filePath} and SKILL.md',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'For skill files: "{skillName}/{path}".',
        },
      },
    },
    responseFormat: 'content',
  },
  SkillToolDefinition: {
    name: 'skill',
    description: `Invoke a skill from the user's library.

CONSTRAINTS:
- Do not invoke a skill that is already active in this conversation.
- Skill names come from the catalog only. Do not guess names.`,
    parameters: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'intent' },
        skillName: {
          type: 'string',
          description: 'Must match a name from the "Available Skills" section.',
        },
        args: { type: 'string', description: 'Optional freeform arguments string.' },
      },
      required: ['skillName'],
    },
  },
  BashExecutionToolDefinition: {
    name: 'bash_tool',
    description: 'bash',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['command'],
    },
  },
  BashToolOutputReferencesGuide: '{{tool<idx>turn<turn>}}',
  /**
   * Deterministic stub mirroring the SDK's `buildBashExecutionToolDescription`:
   * appends an LLM-facing reference-syntax marker only when
   * `enableToolOutputReferences` is true.
   */
  buildBashExecutionToolDescription: ({
    enableToolOutputReferences,
  }: {
    enableToolOutputReferences?: boolean;
  } = {}): string =>
    enableToolOutputReferences === true ? 'bash {{tool<idx>turn<turn>}}' : 'bash',
}));

import fs from 'fs';
import path from 'path';
import { CODE_EXECUTION_TOOLS } from '@librechat/agents';
import type { LCTool, LCToolRegistry } from '@librechat/agents';
import { CODE_WORKSPACE_OPERATIONS, Constants } from 'librechat-data-provider';
import {
  buildToolSet,
  buildRunToolSet,
  buildHistoricalToolNames,
  BuildToolSetConfig,
  registerCodeExecutionTools,
  registerFileAuthoringTools,
  FILE_AUTHORING_TOOL_NAMES,
  isFileAuthoringToolDefinition,
  isCodeSessionToolName,
  isSkillToolAvailable,
  getSkillToolDefinition,
  buildAuthoringSkillToolDescription,
  buildAuthoringSkillToolParameters,
} from './tools';

/** Portable ceiling for OpenAI-compatible tool description validators. */
const TOOL_DESCRIPTION_ADVISORY_MAX_LENGTH = 1024;

function filePathDescription(tool?: LCTool): string {
  const parameters = tool?.parameters as
    | { properties?: { path?: { description?: string } } }
    | undefined;
  return parameters?.properties?.path?.description ?? '';
}

function maxToolDescriptionLength(definitions: LCTool[]): number {
  return definitions.reduce((max, definition) => {
    const length = definition.description?.length ?? Number.POSITIVE_INFINITY;
    return Math.max(max, length);
  }, 0);
}

describe('buildToolSet', () => {
  describe('event-driven mode (toolDefinitions)', () => {
    it('builds toolSet from toolDefinitions when available', () => {
      const agentConfig: BuildToolSetConfig = {
        toolDefinitions: [
          { name: 'tool_search', description: 'Search for tools' },
          { name: 'list_commits_mcp_github', description: 'List commits' },
          { name: 'calculator', description: 'Calculate' },
        ],
        tools: [],
      };

      const toolSet = buildToolSet(agentConfig);

      expect(toolSet.size).toBe(3);
      expect(toolSet.has('tool_search')).toBe(true);
      expect(toolSet.has('list_commits_mcp_github')).toBe(true);
      expect(toolSet.has('calculator')).toBe(true);
    });

    it('includes tool_search in toolSet for deferred tools workflow', () => {
      const agentConfig: BuildToolSetConfig = {
        toolDefinitions: [
          { name: 'tool_search', description: 'Search for deferred tools' },
          { name: 'deferred_tool_1', description: 'A deferred tool', defer_loading: true },
          { name: 'deferred_tool_2', description: 'Another deferred tool', defer_loading: true },
        ],
      };

      const toolSet = buildToolSet(agentConfig);

      expect(toolSet.has('tool_search')).toBe(true);
      expect(toolSet.has('deferred_tool_1')).toBe(true);
      expect(toolSet.has('deferred_tool_2')).toBe(true);
    });

    it('prefers toolDefinitions over tools when both are present', () => {
      const agentConfig: BuildToolSetConfig = {
        toolDefinitions: [{ name: 'from_definitions' }],
        tools: [{ name: 'from_tools' }],
      };

      const toolSet = buildToolSet(agentConfig);

      expect(toolSet.size).toBe(1);
      expect(toolSet.has('from_definitions')).toBe(true);
      expect(toolSet.has('from_tools')).toBe(false);
    });
  });

  describe('legacy mode (tools)', () => {
    it('falls back to tools when toolDefinitions is empty', () => {
      const agentConfig: BuildToolSetConfig = {
        toolDefinitions: [],
        tools: [{ name: 'web_search' }, { name: 'calculator' }],
      };

      const toolSet = buildToolSet(agentConfig);

      expect(toolSet.size).toBe(2);
      expect(toolSet.has('web_search')).toBe(true);
      expect(toolSet.has('calculator')).toBe(true);
    });

    it('falls back to tools when toolDefinitions is undefined', () => {
      const agentConfig: BuildToolSetConfig = {
        tools: [{ name: 'tool_a' }, { name: 'tool_b' }],
      };

      const toolSet = buildToolSet(agentConfig);

      expect(toolSet.size).toBe(2);
      expect(toolSet.has('tool_a')).toBe(true);
      expect(toolSet.has('tool_b')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('includes names retained on unresolved lazy agent descriptors', () => {
      const toolSet = buildToolSet({
        historicalToolNames: ['lazy_search', 'lazy_calculator'],
      });

      expect(toolSet).toEqual(new Set(['lazy_search', 'lazy_calculator']));
    });

    it('returns empty set when agentConfig is null', () => {
      const toolSet = buildToolSet(null);
      expect(toolSet.size).toBe(0);
    });

    it('returns empty set when agentConfig is undefined', () => {
      const toolSet = buildToolSet(undefined);
      expect(toolSet.size).toBe(0);
    });

    it('returns empty set when both toolDefinitions and tools are empty', () => {
      const agentConfig: BuildToolSetConfig = {
        toolDefinitions: [],
        tools: [],
      };

      const toolSet = buildToolSet(agentConfig);
      expect(toolSet.size).toBe(0);
    });

    it('filters out null/undefined tool entries', () => {
      const agentConfig: BuildToolSetConfig = {
        tools: [{ name: 'valid_tool' }, null, undefined, { name: 'another_valid' }],
      };

      const toolSet = buildToolSet(agentConfig);

      expect(toolSet.size).toBe(2);
      expect(toolSet.has('valid_tool')).toBe(true);
      expect(toolSet.has('another_valid')).toBe(true);
    });

    it('filters out empty string tool names', () => {
      const agentConfig: BuildToolSetConfig = {
        toolDefinitions: [{ name: 'valid' }, { name: '' }, { name: 'also_valid' }],
      };

      const toolSet = buildToolSet(agentConfig);

      expect(toolSet.size).toBe(2);
      expect(toolSet.has('valid')).toBe(true);
      expect(toolSet.has('also_valid')).toBe(true);
      expect(toolSet.has('')).toBe(false);
    });
  });
});

describe('buildRunToolSet', () => {
  const agent = (id: string, ...toolNames: string[]) => ({
    id,
    toolDefinitions: toolNames.map((name) => ({ name })),
  });

  it('returns an empty set without a primary or additional agent', () => {
    expect(buildRunToolSet(null)).toEqual(new Set());
  });

  it('collects tools recursively across every reachable agent shape', () => {
    const eager = agent('eager', 'eager_tool');
    const lazy = {
      id: 'lazy',
      historicalToolNames: ['lazy_tool'],
    };
    const metadata = agent('metadata', 'metadata_tool');
    const graphMember = agent('graph-member', 'graph_tool');
    const primary = {
      ...agent('primary', 'primary_tool'),
      subagentAgentConfigs: [eager],
      lazySubagentConfigs: [lazy],
      subagentGraphMemberMetadata: [metadata],
      subagentGraphConfigs: [{ memberConfigs: [graphMember] }],
    };

    expect(buildRunToolSet(primary)).toEqual(
      new Set([
        'subagent',
        'conditional_transfer',
        'primary_tool',
        'eager_tool',
        'lazy_tool',
        'metadata_tool',
        'graph_tool',
      ]),
    );
  });

  it('adds only effective handoff destinations as transfer tools', () => {
    const primary = {
      ...agent('primary', 'primary_tool'),
      edges: [
        { from: 'primary', to: 'writer', edgeType: 'handoff' as const },
        { from: 'writer', to: ['reviewer', 'publisher'] },
        { from: 'publisher', to: 'archive', edgeType: 'direct' as const },
      ],
    };

    const toolSet = buildRunToolSet(primary, [agent('disconnected', 'disconnected_tool')]);

    expect(toolSet).toEqual(
      new Set([
        'subagent',
        'conditional_transfer',
        'primary_tool',
        'disconnected_tool',
        'lc_transfer_to_writer',
        'lc_transfer_to_reviewer',
        'lc_transfer_to_publisher',
      ]),
    );
  });

  it('includes host-generated controls supplied by the run', () => {
    expect(buildRunToolSet(agent('primary'), null, ['check_background_task'])).toEqual(
      new Set(['subagent', 'conditional_transfer', 'check_background_task']),
    );
  });
});

describe('buildHistoricalToolNames', () => {
  it('normalizes MCP names and expands toolkits and deferred search', () => {
    expect(
      buildHistoricalToolNames({
        configuredToolNames: ['search_mcp_Connector: Company', 'image_gen_oai'],
        toolOptions: {
          'search_mcp_Connector: Company': { defer_loading: true },
        },
        rawMcpServerNames: ['Connector: Company'],
        deferredToolsAvailable: true,
      }),
    ).toEqual(
      new Set(['search_mcp_Connector__Company', 'image_gen_oai', 'image_edit_oai', 'tool_search']),
    );
  });

  it('expands code, memory, skill, programmatic, and background controls', () => {
    expect(
      buildHistoricalToolNames({
        configuredToolNames: ['execute_code', 'memory', 'lookup'],
        alwaysApplyToolNames: ['skill_allowed_tool'],
        toolOptions: { lookup: { allowed_callers: ['code_execution'], run_in_background: true } },
        codeExecutionAvailable: true,
        memoryAvailable: true,
        skillsAvailable: true,
        skillAuthoringAvailable: true,
        programmaticToolsAvailable: true,
        backgroundToolsAvailable: true,
      }),
    ).toEqual(
      new Set([
        'execute_code',
        'memory',
        'lookup',
        'skill_allowed_tool',
        'bash_tool',
        'read_file',
        'create_file',
        'edit_file',
        'search_workspace',
        'list_workspace_files',
        'set_memory',
        'delete_memory',
        'skill',
        'run_tools_with_bash',
        'check_background_task',
      ]),
    );
  });

  it('keeps skill file access without exposing the skill invocation tool', () => {
    expect(
      buildHistoricalToolNames({
        skillsAvailable: false,
        skillFileAccessAvailable: true,
      }),
    ).toEqual(new Set(['read_file']));
  });

  it('exposes the skill invocation tool on an authoring run with an empty catalog', () => {
    expect(
      buildHistoricalToolNames({
        skillsAvailable: false,
        skillFileAccessAvailable: false,
        skillAuthoringAvailable: true,
      }),
    ).toEqual(new Set(['skill', 'read_file', 'create_file', 'edit_file']));
  });

  it('normalizes Action names and their options', () => {
    expect(
      buildHistoricalToolNames({
        configuredToolNames: [
          `${Constants.mcp_all}${Constants.mcp_delimiter}warehouse`,
          'lookup_action_api---example---com',
        ],
        toolOptions: {
          'lookup_action_api---example---com': { defer_loading: true },
        },
        deferredToolsAvailable: true,
      }),
    ).toEqual(
      new Set([
        `${Constants.mcp_all}${Constants.mcp_delimiter}warehouse`,
        'lookup_action_api_example_com',
        'tool_search',
      ]),
    );
  });

  it('accepts only historical calls covered by an MCP wildcard server suffix', () => {
    const primary = {
      id: 'primary',
      accessibleMcpServerNames: ['bar', 'foo_mcp_bar', 'Connector: Company'],
      toolDefinitions: [
        { name: `${Constants.mcp_all}${Constants.mcp_delimiter}bar` },
        { name: `${Constants.mcp_all}${Constants.mcp_delimiter}Connector: Company` },
      ],
    };
    const messages = [
      {
        content: [
          { tool_call: { name: 'search_mcp_Connector__Company' } },
          { tool_call: { name: 'search_mcp_attacker' } },
          {
            tool_call: {
              name: 'subagent',
              subagent_content: [{ tool_call: { name: 'run_query_mcp_bar' } }],
            },
          },
        ],
      },
      {
        tool_calls: [{ name: 'lookup_mcp_Connector__Company' }],
        additional_kwargs: {
          tool_calls: [{ function: { name: 'legacy_mcp_Connector__Company' } }],
        },
      },
      { tool_calls: [{ name: 'lookup_mcp_foo_mcp_bar' }] },
      {
        tool_calls: [{ name: 'gitlab-get_mcp_server_version_mcp_bar', mcpServerName: 'bar' }],
      },
      { tool_calls: [{ name: 'legacy_mcp_tool_mcp_bar' }] },
    ];

    expect(buildRunToolSet(primary, null, null, messages)).toEqual(
      new Set([
        'subagent',
        'conditional_transfer',
        `${Constants.mcp_all}${Constants.mcp_delimiter}bar`,
        `${Constants.mcp_all}${Constants.mcp_delimiter}Connector: Company`,
        'search_mcp_Connector__Company',
        'run_query_mcp_bar',
        'lookup_mcp_Connector__Company',
        'legacy_mcp_Connector__Company',
        'gitlab-get_mcp_server_version_mcp_bar',
      ]),
    );
    expect(buildRunToolSet(primary, null, null, messages, true)).toContain(
      'legacy_mcp_tool_mcp_bar',
    );
  });

  it('does not inspect history when the run has no MCP wildcard', () => {
    const message = {};
    Object.defineProperty(message, 'content', {
      get: () => {
        throw new Error('history should not be inspected');
      },
    });

    expect(() =>
      buildRunToolSet({ toolDefinitions: [{ name: 'web' }] }, null, null, [message]),
    ).not.toThrow();
  });
});

describe('isSkillToolAvailable', () => {
  it('registers for a visible catalog, for an authoring run, and for neither', () => {
    expect(isSkillToolAvailable({ modelInvocableSkillsAvailable: true })).toBe(true);
    expect(isSkillToolAvailable({ skillAuthoringAvailable: true })).toBe(true);
    expect(
      isSkillToolAvailable({ modelInvocableSkillsAvailable: true, skillAuthoringAvailable: true }),
    ).toBe(true);
    expect(
      isSkillToolAvailable({
        modelInvocableSkillsAvailable: false,
        skillAuthoringAvailable: false,
      }),
    ).toBe(false);
    expect(isSkillToolAvailable({})).toBe(false);
  });
});

describe('getSkillToolDefinition', () => {
  function skillNameDescription(definition: LCTool): string {
    const parameters = definition.parameters as
      | { properties?: { skillName?: { description?: string } } }
      | undefined;
    return parameters?.properties?.skillName?.description ?? '';
  }

  it('keeps the catalog-only guidance when the run cannot author skills', () => {
    const definition = getSkillToolDefinition(false);

    expect(definition.name).toBe('skill');
    expect(definition.description).toContain('Skill names come from the catalog only');
    expect(skillNameDescription(definition)).toBe(
      'Must match a name from the "Available Skills" section.',
    );
  });

  it('accepts a skill authored during the run when the run can author skills', () => {
    const definition = getSkillToolDefinition(true);

    expect(definition.description).not.toContain('Skill names come from the catalog only');
    expect(definition.description).toContain('a skill you created in this conversation');
    expect(definition.description).toContain('Creating a skill does not load it');
    expect(definition.description).toContain(
      'Do not invoke a skill that is already active in this conversation.',
    );
    expect(skillNameDescription(definition)).toContain(
      'the name of a skill you created in this conversation',
    );
  });

  it('leaves the rest of the schema and the non-authoring definition untouched', () => {
    const authoring = getSkillToolDefinition(true);
    const parameters = authoring.parameters as {
      type?: string;
      required?: string[];
      properties?: Record<string, { description?: string }>;
    };

    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['skillName']);
    expect(Object.keys(parameters.properties ?? {})).toEqual(['intent', 'skillName', 'args']);
    expect(parameters.properties?.args?.description).toBe('Optional freeform arguments string.');
    expect(skillNameDescription(getSkillToolDefinition(false))).toBe(
      'Must match a name from the "Available Skills" section.',
    );
    expect(getSkillToolDefinition(true)).toBe(authoring);
  });
});

describe('buildAuthoringSkillToolDescription', () => {
  it('rewrites the catalog-only constraint in place, keeping every other one', () => {
    const base = [
      'Invoke a skill.',
      '',
      'CONSTRAINTS:',
      '- Do not invoke a skill that is already active in this conversation.',
      '- Skill names come from the catalog only. Do not guess names.',
    ].join('\n');

    const result = buildAuthoringSkillToolDescription(base);

    expect(result).not.toContain('Skill names come from the catalog only');
    expect(result).toContain(
      '- Do not invoke a skill that is already active in this conversation.',
    );
    expect(result).toContain('a skill you created in this conversation');
    /* Rewritten in place, so the guidance stays inside CONSTRAINTS rather than
       trailing after it. */
    expect(
      result.endsWith(
        'Creating a skill does not load it. Invoke it here when you want to follow its instructions.',
      ),
    ).toBe(true);
  });

  it('appends the guidance when the SDK no longer carries that sentence', () => {
    /* Drift branch: the sentence was reworded or dropped upstream. The authored
       -skill guidance must still reach the model, appended rather than lost. */
    const drifted = [
      'Invoke a skill.',
      '',
      'CONSTRAINTS:',
      '- Do not invoke a skill that is already active in this conversation.',
    ].join('\n');

    const result = buildAuthoringSkillToolDescription(drifted);

    expect(result.startsWith(drifted)).toBe(true);
    expect(result).toContain('a skill you created in this conversation');
    expect(result).toContain('Creating a skill does not load it');
  });
});

describe('buildAuthoringSkillToolParameters', () => {
  it('retargets skillName guidance while preserving the rest of the schema', () => {
    const base = {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'intent' },
        skillName: { type: 'string', description: 'catalog only' },
      },
      required: ['skillName'],
    } as unknown as LCTool['parameters'];

    const result = buildAuthoringSkillToolParameters(base) as unknown as {
      type?: string;
      required?: string[];
      properties?: Record<string, { type?: string; description?: string }>;
    };

    expect(result.properties?.skillName?.description).toContain(
      'a skill you created in this conversation',
    );
    /* The property keeps its own non-description fields, and its siblings are
       untouched. */
    expect(result.properties?.skillName?.type).toBe('string');
    expect(result.properties?.intent?.description).toBe('intent');
    expect(result.type).toBe('object');
    expect(result.required).toEqual(['skillName']);
  });

  it('returns the schema unchanged when the SDK has no skillName property', () => {
    /* Drift branch: the installed package disagrees with the types it shipped.
       Losing the authored-skill hint beats failing the packages/api import,
       which is what an unguarded dereference at module load would do. */
    const base = {
      type: 'object',
      properties: { intent: { type: 'string' } },
    } as unknown as LCTool['parameters'];

    expect(buildAuthoringSkillToolParameters(base)).toBe(base);
  });
});

describe('installed @librechat/agents skill tool canary', () => {
  /**
   * The two things the authoring variant reads off the real SDK export. This
   * suite mocks `@librechat/agents`, so these assertions deliberately reach
   * past the mock to the installed package.
   *
   * When either fails, do not "fix" the test: the authoring variant is silently
   * degraded against that version. A moved sentence leaves the reworded
   * catalog-only constraint standing beside guidance that contradicts it (the
   * append branch above), and a moved `skillName` property drops the authored
   * -skill wording from the parameter. Re-point `CATALOG_ONLY_SKILL_CONSTRAINT`
   * in `tools.ts` at the new text instead.
   */
  it('still ships the constraint sentence and skillName property the variant rewrites', () => {
    const { SkillToolDefinition } = jest.requireActual('@librechat/agents') as {
      SkillToolDefinition: {
        description: string;
        parameters: { properties?: Record<string, { description?: string } | undefined> };
      };
    };

    expect(SkillToolDefinition.description).toContain(
      '- Skill names come from the catalog only. Do not guess names.',
    );
    expect(SkillToolDefinition.parameters.properties?.skillName).toBeDefined();
  });
});

describe('e2e skill assertion harness agreement', () => {
  /**
   * `e2e/setup/fake-model.js` tells an authoring run apart from a skills-off run
   * by grepping the advertised `skill` description for one sentence. Both runs
   * can reach the model with nothing in the catalog, and only that sentence
   * separates them, so the harness reports `authoring-only` for one and `none`
   * for the other. Reword the description without this test and the harness
   * silently calls every authoring run skills-off, which reads as an
   * `agent-skills.spec.ts` failure with no mention of the rewording.
   *
   * The literal is read from the harness rather than repeated here: a copy
   * would keep passing after the harness changed.
   */
  const guidance = (() => {
    const harness = fs.readFileSync(
      path.resolve(__dirname, '../../../../e2e/setup/fake-model.js'),
      'utf8',
    );
    const match = /const AUTHORED_SKILL_GUIDANCE = '([^']+)';/.exec(harness);
    if (!match) {
      throw new Error('AUTHORED_SKILL_GUIDANCE was not found in e2e/setup/fake-model.js');
    }
    return match[1];
  })();

  it('ships the sentence the harness greps for, only on the authoring variant', () => {
    const { SkillToolDefinition } = jest.requireActual('@librechat/agents') as {
      SkillToolDefinition: { description: string };
    };

    expect(buildAuthoringSkillToolDescription(SkillToolDefinition.description)).toContain(guidance);
    expect(SkillToolDefinition.description).not.toContain(guidance);
  });
});

describe('registerCodeExecutionTools', () => {
  it('advertises selected named actions to the model', () => {
    const result = registerCodeExecutionTools({
      toolRegistry: undefined,
      toolDefinitions: [],
      includeBash: true,
      workspaceTools: true,
      workspaceOperations: new Set(['execute_command']),
      workspaceEnvironment: {
        fingerprint: 'a'.repeat(64),
        repo: 'owner/app',
        ref: 'main',
        actions: ['check'],
      },
    });
    const bash = result.toolDefinitions.find((def) => def.name === 'bash_tool');
    expect(bash?.parameters).toMatchObject({
      required: [],
      properties: { environmentAction: { enum: ['check'] } },
    });
    expect(bash?.description).toContain('owner/app');
  });
  const makeRegistry = (): LCToolRegistry => new Map() as unknown as LCToolRegistry;

  describe('fresh run (no pre-existing defs or registry entries)', () => {
    it('registers read_file + bash_tool when includeBash=true', () => {
      const toolRegistry = makeRegistry();
      const result = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: [],
        includeBash: true,
      });

      const names = result.toolDefinitions.map((d) => d.name).sort();
      expect(names).toEqual(['bash_tool', 'read_file']);
      expect(result.registered.sort()).toEqual(['bash_tool', 'read_file']);
      expect(toolRegistry.has('read_file')).toBe(true);
      expect(toolRegistry.has('bash_tool')).toBe(true);
    });

    it('registers read_file only when includeBash=false', () => {
      const toolRegistry = makeRegistry();
      const result = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: [],
        includeBash: false,
      });

      expect(result.toolDefinitions.map((d) => d.name)).toEqual(['read_file']);
      expect(result.registered).toEqual(['read_file']);
      expect(toolRegistry.has('read_file')).toBe(true);
      expect(toolRegistry.has('bash_tool')).toBe(false);
    });

    it('uses a code-only read_file description when skill instructions are disabled', () => {
      const toolRegistry = makeRegistry();
      const result = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: false,
      });

      const readFile = result.toolDefinitions.find((d) => d.name === 'read_file');
      expect(readFile?.description).toContain('code-sandbox');
      expect(readFile?.description).toContain('/mnt/data/');
      expect(readFile?.description).toContain('Do not run ls/find');
      expect(readFile?.description).toContain('only retained files under /mnt/data');
      expect(readFile?.description).toContain('$HOME');
      expect(readFile?.description).toContain('/tmp');
      expect(readFile?.description).toContain('global installs');
      expect(readFile?.description).toContain('background processes are call-local');
      expect(readFile?.description).toContain('truncates around 256KB');
      expect(readFile?.description).toContain('png, jpeg, gif, and webp images');
      expect(readFile?.description).toContain('filesystem discovery');
      expect(readFile?.description).not.toContain('{skillName}');
      expect(readFile?.description).not.toContain('SKILL.md');
      expect(JSON.stringify(readFile?.parameters)).not.toContain('{skillName}');
    });

    it('advertises explicit workspace paths and pagination for attached environments', () => {
      const result = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: false,
        workspaceTools: true,
        workspaceOperations: new Set(CODE_WORKSPACE_OPERATIONS),
      });

      const readFile = result.toolDefinitions.find((definition) => definition.name === 'read_file');
      const bashTool = result.toolDefinitions.find((definition) => definition.name === 'bash_tool');
      const searchWorkspace = result.toolDefinitions.find(
        (definition) => definition.name === 'search_workspace',
      );
      const listWorkspaceFiles = result.toolDefinitions.find(
        (definition) => definition.name === 'list_workspace_files',
      );
      expect(readFile?.description).toContain('workspace/');
      expect(readFile?.description).toContain('attached');
      expect(readFile?.description).toContain(
        'Only the registered workspace persists for attached commands',
      );
      expect(readFile?.description).toContain('operator-managed');
      expect(readFile?.parameters).toMatchObject({
        properties: {
          start_line: { type: 'integer' },
          max_lines: { type: 'integer', maximum: 500 },
        },
      });
      expect(bashTool?.description).toContain('selected attached environment');
      expect(bashTool?.description).toContain('empty directory');
      expect(bashTool?.description).toContain('Network access follows the sandbox policy');
      expect(bashTool?.description).not.toContain('/mnt/data');
      expect(bashTool?.parameters).toMatchObject({
        properties: {
          command: { type: 'string' },
          args: { type: 'array' },
          cwd: { type: 'string', maxLength: 4096 },
          timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
        },
        required: ['command'],
      });
      expect(searchWorkspace).toMatchObject({
        name: 'search_workspace',
        parameters: {
          properties: {
            query: { type: 'string' },
            path: { type: 'string' },
            max_results: { type: 'integer', maximum: 200 },
          },
          required: ['query'],
        },
      });
      expect(searchWorkspace?.description).toContain('literal text');
      expect(listWorkspaceFiles).toMatchObject({
        name: 'list_workspace_files',
        parameters: {
          properties: {
            path: { type: 'string' },
            max_results: { type: 'integer', maximum: 500 },
            after_path: { type: 'string' },
          },
        },
      });
      expect(listWorkspaceFiles?.description).toContain('empty directory');
      expect(listWorkspaceFiles?.description).toContain('after_path');
      expect(filePathDescription(listWorkspaceFiles)).toContain('canonical relative');
    });

    it('advertises the configured attached-command timeout ceiling', () => {
      const result = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        workspaceTools: true,
        workspaceOperations: new Set(['execute_command'] as const),
        workspaceCommandTimeoutMaxMs: 120_000,
      });

      expect(
        result.toolDefinitions.find((definition) => definition.name === 'bash_tool'),
      ).toMatchObject({
        parameters: {
          properties: { timeoutMs: { minimum: 1, maximum: 120_000 } },
        },
      });
    });

    it('registers only operations advertised by the selected workspace', () => {
      const result = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: false,
        workspaceTools: true,
        workspaceOperations: new Set(['read_file', 'list_files']),
      });

      expect(result.toolDefinitions.map(({ name }) => name).sort()).toEqual([
        'list_workspace_files',
        'read_file',
      ]);
    });

    it('fails closed when attached workspace operations were not validated', () => {
      const result = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: false,
        workspaceTools: true,
      });

      expect(result.toolDefinitions).toEqual([]);
    });

    it('upgrades a code-only read_file definition when skills are enabled later in the run', () => {
      const toolRegistry = makeRegistry();
      const codeOnly = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: false,
      });
      const upgraded = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: codeOnly.toolDefinitions,
        includeBash: false,
        includeSkillFileInstructions: true,
      });

      const readFile = upgraded.toolDefinitions.find((d) => d.name === 'read_file');
      expect(upgraded.registered).toEqual([]);
      expect(readFile?.description).toContain('{skillName}/{filePath}');
      expect(readFile?.description).toContain('skills/{skillName}/');
      expect(readFile?.description).toContain('SKILL.md');
      expect(toolRegistry.get('read_file')?.description).toBe(readFile?.description);
    });

    it('preserves attached workspace instructions when skills upgrade read_file', () => {
      const toolRegistry = makeRegistry();
      const codeOnly = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: false,
        workspaceTools: true,
        workspaceOperations: new Set(CODE_WORKSPACE_OPERATIONS),
      });
      const upgraded = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: codeOnly.toolDefinitions,
        includeBash: false,
        includeSkillFileInstructions: true,
        workspaceTools: true,
        workspaceOperations: new Set(CODE_WORKSPACE_OPERATIONS),
      });

      const readFile = upgraded.toolDefinitions.find(
        (definition) => definition.name === 'read_file',
      );
      expect(readFile?.description).toContain('skills/{skillName}/');
      expect(readFile?.description).toContain('workspace/');
      expect(readFile?.parameters).toMatchObject({
        properties: { max_lines: { maximum: 500 } },
      });
    });

    it('preserves pre-existing unrelated tool definitions', () => {
      const toolRegistry = makeRegistry();
      const existing: LCTool[] = [
        { name: 'calculator', description: 'calc', parameters: undefined } as LCTool,
      ];
      const result = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: existing,
        includeBash: true,
      });

      const names = result.toolDefinitions.map((d) => d.name);
      expect(names).toEqual(['calculator', 'read_file', 'bash_tool']);
    });

    it('keeps code-execution tool descriptions within provider advisory limits', () => {
      const skillAwareWithRefs = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: true,
        enableToolOutputReferences: true,
      });
      const codeOnlyWithoutRefs = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: false,
        enableToolOutputReferences: false,
      });
      const attachedWithoutRefs = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        includeSkillFileInstructions: false,
        enableToolOutputReferences: false,
        workspaceTools: true,
        workspaceOperations: new Set(CODE_WORKSPACE_OPERATIONS),
      });

      expect(
        maxToolDescriptionLength([
          ...skillAwareWithRefs.toolDefinitions,
          ...codeOnlyWithoutRefs.toolDefinitions,
          ...attachedWithoutRefs.toolDefinitions,
        ]),
      ).toBeLessThanOrEqual(TOOL_DESCRIPTION_ADVISORY_MAX_LENGTH);
    });
  });

  describe('idempotence (second call in same run)', () => {
    it('is a no-op when both tools already live in the registry', () => {
      const toolRegistry = makeRegistry();
      const first = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: [],
        includeBash: true,
      });
      /* Second call simulates skills-path + execute_code-path overlap. */
      const second = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: first.toolDefinitions,
        includeBash: true,
      });

      expect(second.registered).toEqual([]);
      expect(second.toolDefinitions).toHaveLength(2);
      const names = second.toolDefinitions.map((d) => d.name).sort();
      expect(names).toEqual(['bash_tool', 'read_file']);
    });

    it('is a no-op when tools already live in toolDefinitions (no registry available)', () => {
      const existing: LCTool[] = [
        { name: 'read_file', description: 'pre', parameters: undefined } as LCTool,
        { name: 'bash_tool', description: 'pre', parameters: undefined } as LCTool,
      ];
      const result = registerCodeExecutionTools({
        toolRegistry: undefined,
        toolDefinitions: existing,
        includeBash: true,
      });

      expect(result.registered).toEqual([]);
      expect(result.toolDefinitions).toEqual(existing);
    });

    it('only adds the missing half when one is already registered', () => {
      const toolRegistry = makeRegistry();
      toolRegistry.set('read_file', {
        name: 'read_file',
        description: 'prev',
        parameters: undefined,
      } as LCTool);
      const result = registerCodeExecutionTools({
        toolRegistry,
        toolDefinitions: [],
        includeBash: true,
      });

      expect(result.registered).toEqual(['bash_tool']);
      const names = result.toolDefinitions.map((d) => d.name);
      expect(names).toEqual(['bash_tool']);
      expect(toolRegistry.has('read_file')).toBe(true);
      expect(toolRegistry.has('bash_tool')).toBe(true);
    });
  });

  describe('no-registry variant', () => {
    it('still returns merged toolDefinitions when toolRegistry is undefined', () => {
      const result = registerCodeExecutionTools({
        toolRegistry: undefined,
        toolDefinitions: [],
        includeBash: true,
      });

      const names = result.toolDefinitions.map((d) => d.name).sort();
      expect(names).toEqual(['bash_tool', 'read_file']);
      expect(result.registered.sort()).toEqual(['bash_tool', 'read_file']);
    });
  });

  describe('enableToolOutputReferences', () => {
    const findBashDef = (defs: LCTool[]): LCTool | undefined =>
      defs.find((d) => d.name === 'bash_tool');

    it('appends the {{tool<idx>turn<turn>}} guide when flag is true', () => {
      const result = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        enableToolOutputReferences: true,
      });

      const bash = findBashDef(result.toolDefinitions);
      expect(bash?.description).toContain('{{tool<idx>turn<turn>}}');
    });

    it('omits the {{tool<idx>turn<turn>}} guide when flag is false', () => {
      const result = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        enableToolOutputReferences: false,
      });

      const bash = findBashDef(result.toolDefinitions);
      expect(bash?.description).not.toContain('{{tool<idx>turn<turn>}}');
    });

    it('omits the guide by default when flag is unspecified', () => {
      const result = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
      });

      const bash = findBashDef(result.toolDefinitions);
      expect(bash?.description).not.toContain('{{tool<idx>turn<turn>}}');
    });

    it('returns the same frozen bash_tool reference across calls with the same flag', () => {
      /**
       * The two `bash_tool` variants are cached at module scope so
       * repeated agent inits in the same process don't re-allocate
       * + re-freeze + re-build the description on every call.
       * Asserting reference equality across two fresh registries
       * pins that contract — a regression that switches back to a
       * per-call `Object.freeze` would fail this test.
       */
      const a = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        enableToolOutputReferences: true,
      });
      const b = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        enableToolOutputReferences: true,
      });

      expect(findBashDef(a.toolDefinitions)).toBe(findBashDef(b.toolDefinitions));
    });

    it('returns distinct frozen references for the two flag variants', () => {
      /**
       * Sanity check on the two-singleton cache: the with-refs and
       * without-refs definitions are distinct objects so toggling
       * the flag in `registerCodeExecutionTools` actually picks up
       * the alternate description, not the same cached reference.
       */
      const withRefs = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        enableToolOutputReferences: true,
      });
      const withoutRefs = registerCodeExecutionTools({
        toolRegistry: makeRegistry(),
        toolDefinitions: [],
        includeBash: true,
        enableToolOutputReferences: false,
      });

      const a = findBashDef(withRefs.toolDefinitions);
      const b = findBashDef(withoutRefs.toolDefinitions);
      expect(a).not.toBe(b);
      expect(a?.description).toContain('{{tool<idx>turn<turn>}}');
      expect(b?.description).not.toContain('{{tool<idx>turn<turn>}}');
    });
  });
});

describe('registerFileAuthoringTools', () => {
  const makeRegistry = (): LCToolRegistry => new Map() as unknown as LCToolRegistry;

  it('recognizes host-side file authoring tools as code-session-aware without mutating the shared set', () => {
    expect(isCodeSessionToolName('bash_tool')).toBe(true);
    expect(isCodeSessionToolName('search_workspace')).toBe(true);
    expect(isCodeSessionToolName('list_workspace_files')).toBe(true);
    expect(isCodeSessionToolName('create_file')).toBe(false);
    expect(isCodeSessionToolName('edit_file')).toBe(false);
    expect(isCodeSessionToolName('create_file', FILE_AUTHORING_TOOL_NAMES)).toBe(true);
    expect(isCodeSessionToolName('edit_file', FILE_AUTHORING_TOOL_NAMES)).toBe(true);
    expect(CODE_EXECUTION_TOOLS.has('create_file')).toBe(false);
    expect(CODE_EXECUTION_TOOLS.has('edit_file')).toBe(false);
  });

  it('registers create_file and edit_file with skill-aware descriptions', () => {
    const toolRegistry = makeRegistry();
    const result = registerFileAuthoringTools({
      toolRegistry,
      toolDefinitions: [],
      includeSkillFileInstructions: true,
    });

    const names = result.toolDefinitions.map((d) => d.name).sort();
    expect(names).toEqual(['create_file', 'edit_file']);
    expect(result.registered.sort()).toEqual(['create_file', 'edit_file']);
    expect(toolRegistry.has('create_file')).toBe(true);
    expect(toolRegistry.has('edit_file')).toBe(true);
    expect(result.toolDefinitions[0].responseFormat).toBe('content_and_artifact');
    expect(result.toolDefinitions.map((d) => d.description).join('\n')).toContain('skills/');
    expect(toolRegistry.get('create_file')?.description).toContain('frontmatter name must match');
    expect(toolRegistry.get('create_file')?.description).toContain('trigger-friendly');
    expect(toolRegistry.get('create_file')?.description).toContain('references/template.html');
    expect(toolRegistry.get('create_file')?.description).toContain('templates/{file}');
    expect(toolRegistry.get('edit_file')?.description).toContain('edit_file cannot rename skills');
    expect(toolRegistry.get('edit_file')?.description).toContain('Keep SKILL.md concise');
    expect(toolRegistry.get('edit_file')?.description).toContain('templates/');
    expect(filePathDescription(toolRegistry.get('create_file'))).toContain(
      'frontmatter name must match',
    );
    expect(filePathDescription(toolRegistry.get('edit_file'))).toContain(
      'edit_file cannot rename skills',
    );
  });

  it('registers code-only descriptions for code-exec-only agents', () => {
    const toolRegistry = makeRegistry();
    const result = registerFileAuthoringTools({
      toolRegistry,
      toolDefinitions: [],
      includeSkillFileInstructions: false,
    });

    const createFile = result.toolDefinitions.find((d) => d.name === 'create_file');
    const editFile = result.toolDefinitions.find((d) => d.name === 'edit_file');
    expect(createFile?.description).toContain('code-execution sandbox');
    expect(createFile?.description).toContain('/mnt/data/');
    expect(createFile?.description).not.toContain('skills/');
    expect(editFile?.description).toContain('code-execution sandbox');
    expect(editFile?.description).toContain('/mnt/data/');
    expect(editFile?.description).not.toContain('skills/');
    expect(filePathDescription(createFile)).toContain('code-execution sandbox');
    expect(filePathDescription(createFile)).not.toContain('skills/');
    expect(filePathDescription(createFile)).not.toContain('SKILL.md');
    expect(filePathDescription(editFile)).toContain('code-execution sandbox');
    expect(filePathDescription(editFile)).not.toContain('skills/');
    expect(filePathDescription(editFile)).not.toContain('rename skills');
  });

  it('registers attached-workspace paths and atomic edit semantics', () => {
    const result = registerFileAuthoringTools({
      toolRegistry: makeRegistry(),
      toolDefinitions: [],
      includeSkillFileInstructions: false,
      workspaceTools: true,
      workspaceOperations: new Set(CODE_WORKSPACE_OPERATIONS),
    });
    const createFile = result.toolDefinitions.find((d) => d.name === 'create_file');
    const editFile = result.toolDefinitions.find((d) => d.name === 'edit_file');

    expect(createFile?.description).toContain('workspace/{relativePath}');
    expect(createFile?.description).not.toContain('/mnt/data/');
    expect(editFile?.description).toContain('entire batch commits atomically');
    expect(filePathDescription(createFile)).toContain('workspace/{relativePath}');
    expect(filePathDescription(editFile)).toContain('workspace/{relativePath}');
    expect(isFileAuthoringToolDefinition(createFile)).toBe(true);
    expect(isFileAuthoringToolDefinition(editFile)).toBe(true);
  });

  it('registers only authoring operations advertised by the selected workspace', () => {
    const result = registerFileAuthoringTools({
      toolRegistry: makeRegistry(),
      toolDefinitions: [],
      includeSkillFileInstructions: false,
      workspaceTools: true,
      workspaceOperations: new Set(['edit_file']),
    });

    expect(result.toolDefinitions.map(({ name }) => name)).toEqual(['edit_file']);
  });

  it('fails closed when attached authoring operations were not validated', () => {
    const result = registerFileAuthoringTools({
      toolRegistry: makeRegistry(),
      toolDefinitions: [],
      includeSkillFileInstructions: false,
      workspaceTools: true,
    });

    expect(result.toolDefinitions).toEqual([]);
  });

  it('is idempotent across repeated registration calls', () => {
    const toolRegistry = makeRegistry();
    const first = registerFileAuthoringTools({
      toolRegistry,
      toolDefinitions: [],
    });
    const second = registerFileAuthoringTools({
      toolRegistry,
      toolDefinitions: first.toolDefinitions,
    });

    expect(second.registered).toEqual([]);
    expect(second.toolDefinitions).toHaveLength(2);
  });

  it('upgrades code-only definitions to skill-aware definitions', () => {
    const toolRegistry = makeRegistry();
    const codeOnly = registerFileAuthoringTools({
      toolRegistry,
      toolDefinitions: [],
      includeSkillFileInstructions: false,
    });
    const upgraded = registerFileAuthoringTools({
      toolRegistry,
      toolDefinitions: codeOnly.toolDefinitions,
      includeSkillFileInstructions: true,
    });
    expect(upgraded.registered).toEqual([]);
    expect(upgraded.toolDefinitions.find((d) => d.name === 'create_file')?.description).toContain(
      'skills/',
    );
    expect(toolRegistry.get('edit_file')?.description).toContain('skills/');
  });

  it('keeps file-authoring tool descriptions within provider advisory limits', () => {
    const skillAware = registerFileAuthoringTools({
      toolRegistry: makeRegistry(),
      toolDefinitions: [],
      includeSkillFileInstructions: true,
    });
    const codeOnlyRegistry = makeRegistry();
    const codeOnly = registerFileAuthoringTools({
      toolRegistry: codeOnlyRegistry,
      toolDefinitions: [],
      includeSkillFileInstructions: false,
    });
    const upgraded = registerFileAuthoringTools({
      toolRegistry: codeOnlyRegistry,
      toolDefinitions: codeOnly.toolDefinitions,
      includeSkillFileInstructions: true,
    });
    const attached = registerFileAuthoringTools({
      toolRegistry: makeRegistry(),
      toolDefinitions: [],
      includeSkillFileInstructions: true,
      workspaceTools: true,
      workspaceOperations: new Set(CODE_WORKSPACE_OPERATIONS),
    });

    expect(
      maxToolDescriptionLength([
        ...skillAware.toolDefinitions,
        ...codeOnly.toolDefinitions,
        ...upgraded.toolDefinitions,
        ...attached.toolDefinitions,
      ]),
    ).toBeLessThanOrEqual(TOOL_DESCRIPTION_ADVISORY_MAX_LENGTH);
  });

  it('distinguishes host file authoring definitions from user tools with matching names', () => {
    const result = registerFileAuthoringTools({
      toolRegistry: makeRegistry(),
      toolDefinitions: [],
      includeSkillFileInstructions: true,
    });
    const createFile = result.toolDefinitions.find((d) => d.name === 'create_file');

    expect(isFileAuthoringToolDefinition(createFile)).toBe(true);
    expect(
      isFileAuthoringToolDefinition({
        name: 'create_file',
        description: 'A user-defined create_file action',
        parameters: { type: 'object', properties: {} } as LCTool['parameters'],
      }),
    ).toBe(false);
  });
});
