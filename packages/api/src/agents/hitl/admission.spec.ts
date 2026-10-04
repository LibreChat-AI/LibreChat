import { Constants } from 'librechat-data-provider';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { PluginHookSource } from '~/agents/hooks/source';
import type { ToolApprovalAdmissionAgent } from './admission';
import type { ToolApprovalHook } from './hooks';
import {
  agentRunUsesCheckpointer,
  canAgentGraphPause,
  copyToolApprovalAdmissionMetadata,
} from './admission';
import { loadToolDefinitions } from '~/tools/definitions';
import { formatMCPServerTools } from '~/mcp/tools';

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

const normalizedLazySelections = [
  { selected: 'db_query_mcp_DB', current: 'query_mcp_DB', raw: 'DB' },
  { selected: 'db_ops_query_mcp_db ops', current: 'query_mcp_db_ops', raw: 'db ops' },
  { selected: 'db_ops_query_mcp_db_ops', current: 'query_mcp_db ops', raw: 'db ops' },
  { selected: 'db_ops_query_mcp_db ops', current: 'query_mcp_db ops', raw: 'db ops' },
  {
    selected: 'finance_mcp_eu_get_mcp_version_mcp_Finance_mcp_EU',
    current: 'get_mcp_version_mcp_Finance_mcp_EU',
    raw: 'Finance_mcp_EU',
  },
];
for (const placement of ['lazySubagentConfigs', 'subagentGraphMemberMetadata'] as const) {
  test.each(normalizedLazySelections)(
    `${placement} predicts runtime normalization without proving an alias ($selected)`,
    ({ selected, current, raw }) => {
      const source = {
        tools: [selected],
        tool_options: { [current]: { approval_mode: 'chat' as const } },
      };
      const metadata = copyToolApprovalAdmissionMetadata({ id: 'child' }, source, {
        rawMcpServerNames: [raw],
      });
      const descriptor = copyToolApprovalAdmissionMetadata({ id: 'child' }, metadata);
      const policy = { enabled: true, mode: 'bypass' as const };
      expect(canAgentGraphPause({ policy, agents: [{ [placement]: [descriptor] }] })).toBe(true);
      expect(
        canAgentGraphPause({
          policy: { ...policy, enabled: false },
          agents: [{ [placement]: [descriptor] }],
        }),
      ).toBe(false);
      expect(descriptor).not.toHaveProperty('mcpToolAliases');
      expect(descriptor).not.toHaveProperty('tools');
      expect(source).toEqual({
        tools: [selected],
        tool_options: { [current]: { approval_mode: 'chat' } },
      });
      const closed = copyToolApprovalAdmissionMetadata(
        { id: 'child' },
        { ...source, toolDefinitions: [{ name: selected }] },
        { rawMcpServerNames: [raw] },
      );
      expect(canAgentGraphPause({ policy, agents: [{ [placement]: [closed] }] })).toBe(false);
    },
  );
}

test('catalog-free stripping follows runtime reserved-name and classification protections', () => {
  for (const current of ['oauth', 'mcp_all', 'mcp_server', 'mcp_db', 'lc_transfer_to_child']) {
    const selected = `db_${current}_mcp_db`;
    const descriptor = copyToolApprovalAdmissionMetadata(
      { id: 'child' },
      { tools: [selected], tool_options: { [`${current}_mcp_db`]: { approval_mode: 'ask' } } },
    );
    expect(
      canAgentGraphPause({
        policy: { enabled: true, mode: 'bypass' },
        agents: [{ lazySubagentConfigs: [descriptor] }],
      }),
    ).toBe(false);
  }
});

test('normalized current options win while explicit selected options and server deny remain authoritative', () => {
  const policy = { enabled: true, mode: 'bypass' as const };
  const contexts = { rawMcpServerNames: ['db ops'] };
  const scenarios: AgentToolOptions[] = [
    {
      query_mcp_db_ops: { approval_mode: 'allow' as const },
      'query_mcp_db ops': { approval_mode: 'ask' as const },
    },
    {
      'query_mcp_db ops': { approval_mode: 'ask' as const },
      query_mcp_db_ops: { approval_mode: 'allow' as const },
    },
    {
      query_mcp_db_ops: { approval_mode: 'ask' as const },
      db_ops_query_mcp_db_ops: { approval_mode: 'allow' as const },
    },
  ];
  for (const tool_options of scenarios) {
    const descriptor = copyToolApprovalAdmissionMetadata(
      { id: 'child' },
      { tools: ['db_ops_query_mcp_db ops'], tool_options },
      contexts,
    );
    expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [descriptor] }] })).toBe(
      false,
    );
  }
  const descriptor = copyToolApprovalAdmissionMetadata(
    { id: 'child' },
    { tools: ['db_query_mcp_DB'], tool_options: { query_mcp_DB: { approval_mode: 'ask' } } },
  );
  for (const name of ['db_query_mcp_DB', 'query_mcp_DB']) {
    expect(
      canAgentGraphPause({
        policy: { ...policy, deny: [name] },
        agents: [{ lazySubagentConfigs: [descriptor] }],
      }),
    ).toBe(false);
  }
});

for (const placement of ['lazySubagentConfigs', 'subagentGraphMemberMetadata'] as const) {
  test.each(['query_mcp_db_ops', 'db_ops_query_mcp_db ops'])(
    `${placement} includes resolved skill-only tools with empty saved selection (%s)`,
    (contributed) => {
      const skillPrimes = [{ name: 'analysis', allowedTools: [contributed, contributed] }];
      const source = {
        tools: [],
        tool_options: { query_mcp_db_ops: { approval_mode: 'ask' as const } },
      };
      const metadata = copyToolApprovalAdmissionMetadata({ id: 'child' }, source, {
        skillPrimes,
        rawMcpServerNames: ['db ops'],
        toolsAvailable: true,
      });
      const descriptor = copyToolApprovalAdmissionMetadata({ id: 'child' }, metadata);
      skillPrimes[0].allowedTools.length = 0;
      const policy = { enabled: true, mode: 'bypass' as const };
      expect(canAgentGraphPause({ policy, agents: [{ [placement]: [descriptor] }] })).toBe(true);
      expect(
        canAgentGraphPause({
          policy: { ...policy, deny: ['query_mcp_db_ops'] },
          agents: [{ [placement]: [descriptor] }],
        }),
      ).toBe(false);
      expect(JSON.stringify(descriptor)).not.toContain('query');
      expect(Object.keys(source.tool_options)).toEqual(['query_mcp_db_ops']);
    },
  );
}

test('skill projection preserves absent surfaces, inactive/default modes, MCP capability gates and unrelated selections', () => {
  const policy = { enabled: true, mode: 'bypass' as const };
  for (const mode of ['ask', 'chat', 'always', 'allow', undefined] as const) {
    const source = { tools: [], tool_options: { query_mcp_db: { approval_mode: mode } } };
    const project = (allowedTools: string[], toolsAvailable = true) =>
      copyToolApprovalAdmissionMetadata({ id: 'child' }, source, {
        skillPrimes: [{ name: 'analysis', allowedTools }],
        toolsAvailable,
      });
    for (const descriptor of [
      project([]),
      project(['other_mcp_db']),
      project(['query_mcp_db'], false),
    ]) {
      expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [descriptor] }] })).toBe(
        false,
      );
    }
    expect(
      canAgentGraphPause({
        policy,
        agents: [{ lazySubagentConfigs: [project(['query_mcp_db'])] }],
      }),
    ).toBe(mode != null && mode !== 'allow');
  }
  const unresolved = copyToolApprovalAdmissionMetadata(
    { id: 'child' },
    { tool_options: { query_mcp_db: { approval_mode: 'ask' } } },
  );
  expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [unresolved] }] })).toBe(
    true,
  );
});

const inverseSelections = [
  { selected: 'query_mcp_db', option: 'db_query_mcp_db', server: 'db' },
  { selected: 'query_mcp_DB', option: 'db_query_mcp_DB', server: 'DB' },
  { selected: 'query_mcp_DB', option: 'DB_query_mcp_DB', server: 'DB' },
  { selected: 'query_mcp_db ops', option: 'db_ops_query_mcp_db_ops', server: 'db ops' },
  { selected: 'query_mcp_db_ops', option: 'DB_OPS_query_mcp_db ops', server: 'db ops' },
  {
    selected: 'get_mcp_version_mcp_Finance_mcp_EU',
    option: 'finance_mcp_eu_get_mcp_version_mcp_Finance_mcp_EU',
    server: 'Finance_mcp_EU',
  },
];
for (const placement of ['lazySubagentConfigs', 'subagentGraphMemberMetadata'] as const) {
  test.each(inverseSelections)(
    `${placement} considers inverse option spellings without assigning identity ($option)`,
    ({ selected, option, server }) => {
      const source = {
        tools: [selected],
        tool_options: { [option]: { approval_mode: 'chat' as const } },
      };
      const metadata = copyToolApprovalAdmissionMetadata({ id: 'child' }, source, {
        rawMcpServerNames: [server],
      });
      const descriptor = copyToolApprovalAdmissionMetadata({ id: 'child' }, metadata);
      const policy = { enabled: true, mode: 'bypass' as const };
      expect(canAgentGraphPause({ policy, agents: [{ [placement]: [descriptor] }] })).toBe(true);
      expect(
        canAgentGraphPause({
          policy: { ...policy, enabled: false },
          agents: [{ [placement]: [descriptor] }],
        }),
      ).toBe(false);
      expect(canAgentGraphPause({ policy, agents: [descriptor] })).toBe(false);
      expect(descriptor).not.toHaveProperty('mcpToolAliases');
      expect(JSON.stringify(descriptor)).not.toContain(option);
      expect(source.tool_options[option].approval_mode).toBe('chat');
    },
  );
}

test('selected keys, closed catalogs and administrator deny win over an inverse option hint', () => {
  const policy = { enabled: true, mode: 'bypass' as const };
  for (const entry of [{ approval_mode: 'allow' as const }, { defer_loading: true }]) {
    const descriptor = copyToolApprovalAdmissionMetadata(
      { id: 'child' },
      {
        tools: ['query_mcp_db'],
        tool_options: { db_query_mcp_db: { approval_mode: 'ask' }, query_mcp_db: entry },
      },
    );
    expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [descriptor] }] })).toBe(
      false,
    );
  }
  for (const name of ['query_mcp_db', 'db_query_mcp_db']) {
    const descriptor = copyToolApprovalAdmissionMetadata(
      { id: 'child' },
      { tools: ['query_mcp_db'], tool_options: { db_query_mcp_db: { approval_mode: 'ask' } } },
    );
    expect(
      canAgentGraphPause({
        policy: { ...policy, deny: [name] },
        agents: [{ lazySubagentConfigs: [descriptor] }],
      }),
    ).toBe(false);
  }
  const closed = copyToolApprovalAdmissionMetadata(
    { id: 'child' },
    {
      tools: ['query_mcp_db'],
      toolDefinitions: [{ name: 'query_mcp_db' }],
      tool_options: { db_query_mcp_db: { approval_mode: 'ask' } },
    },
  );
  expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [closed] }] })).toBe(false);
});

for (const placement of ['lazySubagentConfigs', 'subagentGraphMemberMetadata'] as const) {
  test.each(['db', 'db ops', 'Finance_mcp_EU'])(
    `${placement} wildcard modes are scoped to the exact selected server (%s)`,
    (server) => {
      const normalized = server.replace(/ /g, '_');
      const marker = `${Constants.mcp_all}${Constants.mcp_delimiter}${server}`;
      const project = (tool_options: AgentToolOptions) =>
        copyToolApprovalAdmissionMetadata(
          { id: 'child' },
          { tools: [marker], tool_options },
          { rawMcpServerNames: [server, 'other', `other_mcp_${normalized}`] },
        );
      const policy = { enabled: true, mode: 'bypass' as const };
      for (const other of [
        'read_mcp_other',
        `read_mcp_other_mcp_${normalized}`,
        `read_mcp_not${normalized}`,
      ]) {
        const descriptor = project({ [other]: { approval_mode: 'ask' } });
        expect(canAgentGraphPause({ policy, agents: [{ [placement]: [descriptor] }] })).toBe(false);
      }
      for (const suffix of [server, normalized]) {
        const name = `get_mcp_version_mcp_${suffix}`;
        const descriptor = project({ [name]: { approval_mode: 'always' } });
        expect(canAgentGraphPause({ policy, agents: [{ [placement]: [descriptor] }] })).toBe(true);
        expect(
          canAgentGraphPause({
            policy: { ...policy, deny: ['get_mcp_version_mcp_*'] },
            agents: [{ [placement]: [descriptor] }],
          }),
        ).toBe(false);
        expect(descriptor).not.toHaveProperty('rawMcpServerNames');
      }
    },
  );
}

test('wildcards preserve raw direct-first collisions, distinct casing and genuinely unknown surfaces', () => {
  const marker = `${Constants.mcp_all}${Constants.mcp_delimiter}`;
  const policy = { enabled: true, mode: 'bypass' as const };
  const project = (
    tools: string[] | undefined,
    tool_options: AgentToolOptions,
    rawMcpServerNames: string[] = [],
  ) =>
    copyToolApprovalAdmissionMetadata(
      { id: 'child' },
      { tools, tool_options },
      { rawMcpServerNames },
    );
  for (const descriptor of [
    project([marker + 'db'], { read_mcp_DB: { approval_mode: 'ask' } }, ['db', 'DB']),
    project([marker + 'db_ops'], { 'read_mcp_db ops': { approval_mode: 'ask' } }, [
      'db ops',
      'db_ops',
    ]),
    project([marker + 'db'], { read_mcp_other: { approval_mode: 'allow' } }),
    project([], { read_mcp_other: { approval_mode: 'ask' } }),
  ])
    expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [descriptor] }] })).toBe(
      false,
    );
  const unknown = project(undefined, { read_mcp_other: { approval_mode: 'ask' } });
  expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [unknown] }] })).toBe(true);
  const selected = project(
    [marker + 'db', marker + 'other'],
    { read_mcp_other: { approval_mode: 'ask' } },
    ['db', 'other'],
  );
  expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [selected] }] })).toBe(true);
});

test('a skill-contributed current selection retains inverse review options privately', () => {
  const source = {
    tools: [],
    tool_options: { db_query_mcp_db: { approval_mode: 'ask' as const } },
  };
  const descriptor = copyToolApprovalAdmissionMetadata({ id: 'child' }, source, {
    skillPrimes: [{ name: 'analysis', allowedTools: ['query_mcp_db'] }],
    toolsAvailable: true,
    rawMcpServerNames: ['db'],
  });
  expect(
    canAgentGraphPause({
      policy: { enabled: true, mode: 'bypass' },
      agents: [{ lazySubagentConfigs: [descriptor] }],
    }),
  ).toBe(true);
  expect(source.tools).toEqual([]);
});

for (const tools of [['query_mcp_db'], [`${Constants.mcp_all}${Constants.mcp_delimiter}db`]]) {
  test.each(['ask', 'chat', 'always', 'allow', undefined] as const)(
    `unresolved admission matches actual stripped catalog loading for ${tools[0]} mode=%s`,
    async (mode) => {
      const option = 'db_query_mcp_db';
      const options: AgentToolOptions = { [option]: { approval_mode: mode } };
      const descriptor = copyToolApprovalAdmissionMetadata(
        { id: 'child' },
        { tools, tool_options: options },
        { rawMcpServerNames: ['db', 'other'] },
      );
      const catalog = formatMCPServerTools('db', [
        { name: 'db_query', inputSchema: { type: 'object', properties: {} } },
      ]);
      const result = await loadToolDefinitions(
        {
          userId: 'user',
          agentId: 'child',
          tools,
          toolOptions: { ...options },
          mcpServerNames: ['db', 'other'],
          rawServerNames: ['db', 'other'],
        },
        { getOrFetchMCPServerTools: async () => catalog, isBuiltInTool: () => false },
      );
      expect(result.mcpToolAliases).toContainEqual({ name: 'query_mcp_db', aliasName: option });
      const policy = { enabled: true, mode: 'bypass' as const };
      const actual = canAgentGraphPause({
        policy,
        agents: [
          {
            id: 'child',
            tool_options: options,
            toolDefinitions: result.toolDefinitions,
            mcpToolAliases: result.mcpToolAliases,
          },
        ],
      });
      expect(actual).toBe(mode != null && mode !== 'allow');
      expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [descriptor] }] })).toBe(
        actual,
      );
    },
  );
}

for (const placement of ['lazySubagentConfigs', 'subagentGraphMemberMetadata'] as const) {
  for (const mode of ['ask', 'chat', 'always'] as const) {
    test.each([
      { tools: undefined, options: 'query_mcp_db' },
      { tools: ['query_mcp_db'], options: 'query_mcp_db' },
      { tools: ['query_mcp_db'], options: 'db_query_mcp_db' },
      { tools: ['db_query_mcp_db'], options: 'query_mcp_db' },
      { tools: [`${Constants.mcp_all}${Constants.mcp_delimiter}db`], options: 'query_mcp_db' },
      { tools: ['db_ops_query_mcp_db ops'], options: 'query_mcp_db_ops' },
    ])(
      `${placement} omits disabled saved MCP selections in ${mode}: $options / $tools`,
      ({ tools, options }) => {
        const source = { tools, tool_options: { [options]: { approval_mode: mode } } };
        const project = (toolsAvailable: boolean) => {
          const metadata = copyToolApprovalAdmissionMetadata({ id: 'child' }, source, {
            toolsAvailable,
            rawMcpServerNames: ['db', 'db ops'],
            skillPrimes: [{ name: 'analysis', allowedTools: ['query_mcp_db'] }],
          });
          return copyToolApprovalAdmissionMetadata({ id: 'child' }, metadata);
        };
        const policy = { enabled: true, mode: 'bypass' as const };
        expect(canAgentGraphPause({ policy, agents: [{ [placement]: [project(false)] }] })).toBe(
          false,
        );
        expect(canAgentGraphPause({ policy, agents: [{ [placement]: [project(true)] }] })).toBe(
          true,
        );
        expect(source.tool_options[options].approval_mode).toBe(mode);
        expect(project(false)).not.toHaveProperty('tool_options');
      },
    );
  }
}

test('disabled MCP capability preserves independently enabled non-MCP review and unknown surfaces', () => {
  const policy = { enabled: true, mode: 'bypass' as const };
  for (const tools of [undefined, ['query_mcp_db', 'read_file']]) {
    const descriptor = copyToolApprovalAdmissionMetadata(
      { id: 'child' },
      {
        tools,
        tool_options: {
          query_mcp_db: { approval_mode: 'ask' },
          read_file: { approval_mode: 'chat' },
        },
      },
      {
        toolsAvailable: false,
        skillPrimes: [{ name: 'analysis', allowedTools: ['query_mcp_db', 'read_file'] }],
      },
    );
    expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [descriptor] }] })).toBe(
      true,
    );
    expect(
      canAgentGraphPause({
        policy: { ...policy, deny: ['read_file'] },
        agents: [{ lazySubagentConfigs: [descriptor] }],
      }),
    ).toBe(false);
  }
});

test('MCP capability filtering keeps action-classified keys with MCP text under their independent gate', () => {
  const action = 'query_mcp_docs_action_service';
  const mcp = 'query_action_method_mcp_service';
  const descriptor = copyToolApprovalAdmissionMetadata(
    { id: 'child' },
    {
      tools: [action, mcp],
      tool_options: { [action]: { approval_mode: 'ask' }, [mcp]: { approval_mode: 'chat' } },
    },
    { toolsAvailable: false },
  );
  const policy = { enabled: true, mode: 'bypass' as const };
  expect(canAgentGraphPause({ policy, agents: [{ lazySubagentConfigs: [descriptor] }] })).toBe(
    true,
  );
  expect(
    canAgentGraphPause({
      policy: { ...policy, deny: [action] },
      agents: [{ lazySubagentConfigs: [descriptor] }],
    }),
  ).toBe(false);
});
