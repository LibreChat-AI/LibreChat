import { Constants } from 'librechat-data-provider';
import type { PluginHookSource } from '~/agents/hooks/source';
import type { ToolApprovalAdmissionAgent } from './admission';
import type { ToolApprovalHook } from './hooks';
import {
  agentRunUsesCheckpointer,
  canAgentGraphPause,
  copyToolApprovalAdmissionMetadata,
} from './admission';

const askHook: ToolApprovalHook = async () => ({ decision: 'ask' });

function pluginSource(
  hasToolApprovalHooks: PluginHookSource['hasToolApprovalHooks'],
): PluginHookSource {
  return {
    hasHooks: () => true,
    hasToolApprovalHooks,
    register: () => 0,
  };
}

describe('canAgentGraphPause', () => {
  test.each([
    ['configured tool names', { tools: ['read_file'] }, 'read_file'],
    ['loaded tool objects', { tools: [{ name: 'read_file' }] }, 'read_file'],
    ['tool definitions', { toolDefinitions: [{ name: 'read_file' }] }, 'read_file'],
    ['tool registries', { toolRegistry: new Map([['read_file', {}]]) }, 'read_file'],
  ])('discovers %s', (_label, agent, toolName) => {
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass', ask: [toolName] },
        agents: [agent],
      }),
    ).toBe(true);
  });

  test.each([
    ['initialized children', { subagentAgentConfigs: [{ tools: ['write_file'] }] }],
    ['lazy children', { lazySubagentConfigs: [{ tools: ['write_file'] }] }],
    ['graph members', { subagentGraphConfigs: [{ memberConfigs: [{ tools: ['write_file'] }] }] }],
    ['graph member metadata', { subagentGraphMemberMetadata: [{ tools: ['write_file'] }] }],
  ])('intersects approval policy with %s', (_label, agent) => {
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass', ask: ['write_*'] },
        agents: [agent],
      }),
    ).toBe(true);
  });

  test('fails closed for an unresolved lazy tool surface that could pause', () => {
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass', ask: ['write_*'] },
        agents: [{ lazySubagentConfigs: [{}] }],
      }),
    ).toBe(true);
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass' },
        agents: [{ lazySubagentConfigs: [{}] }],
      }),
    ).toBe(false);
  });

  test('does not match an approval rule outside the reachable tool surface', () => {
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass', ask: ['delete_*'] },
        agents: [{ tools: ['read_file'] }],
      }),
    ).toBe(false);
  });

  test('includes host-generated runtime tools in approval admission', () => {
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass', ask: ['check_background_task'] },
        agents: [{}],
        hostGeneratedToolNames: ['check_background_task'],
      }),
    ).toBe(true);
  });

  test('matches static and request-scoped rules against MCP aliases', () => {
    const agent: ToolApprovalAdmissionAgent = {
      tools: ['mcp__server__read_file'],
      mcpToolAliases: [{ name: 'mcp__server__read_file', aliasName: 'read_file' }],
    };
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass', ask: ['read_file'] },
        agents: [agent],
      }),
    ).toBe(true);
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass' },
        agents: [agent],
        resolvedProgrammaticHooks: [{ hook: askHook, matcher: '^read_file$' }],
      }),
    ).toBe(true);
  });

  test('asks deployment hook sources only about concrete runtime tool names', () => {
    const hasToolApprovalHooks = jest.fn(
      (names?: readonly string[]) => names?.includes('write_file') === true,
    );
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass' },
        agents: [{ tools: ['read_file', 'write_file'] }],
        pluginHookSource: pluginSource(hasToolApprovalHooks),
      }),
    ).toBe(true);
    expect(hasToolApprovalHooks).toHaveBeenCalledWith(['read_file']);
    expect(hasToolApprovalHooks).toHaveBeenCalledWith(['write_file']);
  });

  test('classifies top-level ask_user_question unless it is filtered or denied', () => {
    const agents = [{ tools: ['ask_user_question'] }];
    expect(canAgentGraphPause({ policy: undefined, agents })).toBe(true);
    expect(
      canAgentGraphPause({
        policy: { enabled: true, deny: ['ask_*'] },
        agents,
      }),
    ).toBe(false);
    expect(
      canAgentGraphPause({
        policy: { enabled: true },
        agents,
        askUserQuestionAdminDisabled: true,
      }),
    ).toBe(false);
  });

  test('does not promote nested ask_user_question to a parent pause capability', () => {
    expect(
      canAgentGraphPause({
        policy: undefined,
        agents: [{ subagentAgentConfigs: [{ tools: ['ask_user_question'] }] }],
      }),
    ).toBe(false);
  });
});

describe('agentRunUsesCheckpointer', () => {
  test('tracks checkpointer attachment independently from current pause capability', () => {
    const policy = { enabled: true, mode: 'bypass' as const };
    const agents = [{ tools: ['read_file'] }];
    expect(canAgentGraphPause({ policy, agents })).toBe(false);
    expect(agentRunUsesCheckpointer({ policy, agents })).toBe(true);
  });

  test('uses the same top-level ask-tool admin gate as createRun', () => {
    const agents = [{ tools: ['ask_user_question'] }];
    expect(agentRunUsesCheckpointer({ policy: undefined, agents })).toBe(true);
    expect(
      agentRunUsesCheckpointer({
        policy: undefined,
        agents,
        askUserQuestionAdminDisabled: true,
      }),
    ).toBe(false);
  });
});

for (const mode of ['ask', 'chat', 'always'] as const) {
  test.each([
    { tools: ['selected_mcp_db'] },
    { tools: [{ name: 'selected_mcp_db' }] },
    { toolDefinitions: [{ name: 'selected_mcp_db' }] },
    { toolRegistry: new Map([['selected_mcp_db', {}]]) },
  ])(`${mode} options only affect reachable initialized tools (%#)`, (surface) => {
    const policy = { enabled: true, mode: 'bypass' as const };
    const options = {
      selected_mcp_db: { approval_mode: 'allow' as const },
      deselected_mcp_db: { approval_mode: mode },
    };
    expect(canAgentGraphPause({ policy, agents: [{ ...surface, tool_options: options }] })).toBe(
      false,
    );
    expect(
      canAgentGraphPause({
        policy,
        agents: [
          {
            ...surface,
            tool_options: {
              ...options,
              selected_mcp_db: { approval_mode: mode },
            },
          },
        ],
      }),
    ).toBe(true);
    expect(
      canAgentGraphPause({
        policy: { ...policy, deny: ['selected_mcp_db'] },
        agents: [{ ...surface, tool_options: { selected_mcp_db: { approval_mode: mode } } }],
      }),
    ).toBe(false);
  });

  test(`${mode} inactive modes cannot borrow another agent's reachable tool`, () => {
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass' },
        agents: [
          {
            id: 'a',
            tools: ['other_mcp_db'],
            tool_options: { selected_mcp_db: { approval_mode: mode } },
          },
          {
            id: 'b',
            tools: ['selected_mcp_db'],
            tool_options: { selected_mcp_db: { approval_mode: 'allow' } },
          },
        ],
      }),
    ).toBe(false);
  });

  test(`${mode} follows verified aliases without changing saved options or overriding current entries`, () => {
    const policy = { enabled: true, mode: 'bypass' as const };
    const options = { db_query_mcp_db: { approval_mode: mode } };
    const agent = {
      tools: ['query_mcp_db'],
      tool_options: options,
      mcpToolAliases: [{ name: 'query_mcp_db', aliasName: 'db_query_mcp_db' }],
    };
    expect(canAgentGraphPause({ policy, agents: [agent] })).toBe(true);
    expect(Object.keys(options)).toEqual(['db_query_mcp_db']);
    expect(canAgentGraphPause({ policy, agents: [{ ...agent, mcpToolAliases: [] }] })).toBe(false);
    expect(
      canAgentGraphPause({
        policy,
        agents: [
          {
            ...agent,
            tool_options: {
              ...options,
              query_mcp_db: { approval_mode: 'allow' },
            },
          },
        ],
      }),
    ).toBe(false);
    expect(
      canAgentGraphPause({ policy: { ...policy, deny: ['db_query_mcp_db'] }, agents: [agent] }),
    ).toBe(false);
  });

  test(`${mode} remains conservative for unresolved lazy tools but ignores known deselection`, () => {
    const policy = { enabled: true, mode: 'bypass' as const };
    const option = { query_mcp_db: { approval_mode: mode } };
    expect(
      canAgentGraphPause({
        policy,
        agents: [{ lazySubagentConfigs: [{ id: 'lazy', tool_options: option }] }],
      }),
    ).toBe(true);
    expect(
      canAgentGraphPause({
        policy,
        agents: [
          {
            lazySubagentConfigs: [
              {
                id: 'lazy',
                tools: [`${Constants.mcp_all}${Constants.mcp_delimiter}db`],
                tool_options: option,
              },
            ],
          },
        ],
      }),
    ).toBe(true);
    expect(
      canAgentGraphPause({
        policy,
        agents: [{ lazySubagentConfigs: [{ id: 'lazy', tools: [], tool_options: option }] }],
      }),
    ).toBe(false);
    expect(
      canAgentGraphPause({
        policy,
        agents: [
          { lazySubagentConfigs: [{ id: 'lazy', tools: ['other_mcp_db'], tool_options: option }] },
        ],
      }),
    ).toBe(false);
    expect(
      canAgentGraphPause({
        policy,
        agents: [
          { lazySubagentConfigs: [{ id: 'lazy', toolDefinitions: [], tool_options: option }] },
        ],
      }),
    ).toBe(false);
    expect(
      canAgentGraphPause({
        policy: { ...policy, deny: ['query_mcp_db'] },
        agents: [{ lazySubagentConfigs: [{ tool_options: option }] }],
      }),
    ).toBe(false);
  });
}

test('disabled modes, inherited options, cycles and duplicate agent IDs preserve admission defaults', () => {
  const child: ToolApprovalAdmissionAgent = {
    id: 'same',
    tools: ['selected_mcp_db'],
    tool_options: { selected_mcp_db: { approval_mode: 'ask' } },
  };
  const parent: ToolApprovalAdmissionAgent = {
    id: 'same',
    tools: ['read_file'],
    subagentAgentConfigs: [child],
  };
  Object.assign(child, { subagentAgentConfigs: [parent] });
  expect(canAgentGraphPause({ policy: { enabled: true, mode: 'bypass' }, agents: [parent] })).toBe(
    true,
  );
  expect(canAgentGraphPause({ policy: { enabled: false, mode: 'bypass' }, agents: [parent] })).toBe(
    false,
  );
  expect(
    canAgentGraphPause({
      policy: { enabled: true, mode: 'bypass' },
      agents: [{ tools: ['read_file'], tool_options: { read_file: { defer_loading: true } } }],
    }),
  ).toBe(false);
});

for (const placement of ['lazySubagentConfigs', 'subagentGraphMemberMetadata'] as const) {
  test(`${placement} preserves private approval metadata across multiple projections`, () => {
    const source: ToolApprovalAdmissionAgent = {
      id: 'child',
      tools: ['query_mcp_db'],
      tool_options: {
        query_mcp_db: { approval_mode: 'chat' as const, approval_revision: 'revision' },
      },
    };
    const metadata = copyToolApprovalAdmissionMetadata({ id: source.id, name: 'Child' }, source);
    const descriptor = copyToolApprovalAdmissionMetadata(
      { id: source.id, configId: 'private-config' },
      metadata,
    );
    source.tool_options!.query_mcp_db.approval_mode = 'allow';
    const agents = [{ [placement]: [descriptor] }];
    const policy = { enabled: true, mode: 'bypass' as const };
    expect(canAgentGraphPause({ policy, agents })).toBe(true);
    expect(canAgentGraphPause({ policy: { ...policy, deny: ['query_mcp_db'] }, agents })).toBe(
      false,
    );
    expect(canAgentGraphPause({ policy: { ...policy, enabled: false }, agents })).toBe(false);
    expect(descriptor).not.toHaveProperty('tool_options');
    expect(descriptor).not.toHaveProperty('tools');
    expect(JSON.stringify(descriptor)).not.toContain('approval_');
    expect(Object.getOwnPropertySymbols(descriptor)).toEqual([]);
  });
}

test('private projections retain verified aliases and current-option precedence', () => {
  const source = {
    tools: ['query_mcp_db'],
    mcpToolAliases: [{ name: 'query_mcp_db', aliasName: 'db_query_mcp_db' }],
    tool_options: { db_query_mcp_db: { approval_mode: 'ask' as const } },
  };
  const descriptor = copyToolApprovalAdmissionMetadata({ id: 'child' }, source);
  const policy = { enabled: true, mode: 'bypass' as const };
  expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [descriptor] }] })).toBe(
    true,
  );
  const allow = copyToolApprovalAdmissionMetadata(
    { id: 'child' },
    {
      ...source,
      tool_options: {
        query_mcp_db: { approval_mode: 'allow' as const },
        db_query_mcp_db: { approval_mode: 'ask' as const },
      },
    },
  );
  expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [allow] }] })).toBe(false);
});

for (const placement of ['lazySubagentConfigs', 'subagentGraphMemberMetadata'] as const) {
  test.each(['db', 'finance_mcp_eu'])(
    `${placement} cannot treat unresolved legacy selection as a closed catalog (%s)`,
    (server) => {
      const canonical = `query${Constants.mcp_delimiter}${server}`;
      const selected = `${server}_query${Constants.mcp_delimiter}${server}`;
      const source = {
        id: 'child',
        tools: [selected],
        tool_options: { [canonical]: { approval_mode: 'chat' as const } },
      };
      const descriptor = copyToolApprovalAdmissionMetadata({ id: 'child' }, source);
      const policy = { enabled: true, mode: 'bypass' as const };
      expect(canAgentGraphPause({ policy, agents: [{ [placement]: [descriptor] }] })).toBe(true);
      expect(
        canAgentGraphPause({
          policy: { ...policy, deny: [canonical] },
          agents: [{ [placement]: [descriptor] }],
        }),
      ).toBe(false);
      const collision = copyToolApprovalAdmissionMetadata(
        { id: 'child' },
        { ...source, toolDefinitions: [{ name: selected }] },
      );
      expect(canAgentGraphPause({ policy, agents: [{ [placement]: [collision] }] })).toBe(false);
      const explicit = copyToolApprovalAdmissionMetadata(
        { id: 'child' },
        {
          ...source,
          tool_options: { ...source.tool_options, [selected]: { approval_mode: 'allow' as const } },
        },
      );
      expect(canAgentGraphPause({ policy, agents: [{ [placement]: [explicit] }] })).toBe(false);
    },
  );
}
