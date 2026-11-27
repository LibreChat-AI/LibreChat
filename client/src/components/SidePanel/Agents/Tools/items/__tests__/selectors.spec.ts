import { AgentCapabilities, Constants } from 'librechat-data-provider';
import type { AgentItem } from '../types';
import { makePlugin, makeSkill, makeMcpServer, makeAction } from 'test/itemFactories';
import { deriveSelectedItems, matchesMcpServer } from '../selectors';

const mcpServerToken = (serverName: string) =>
  `${Constants.mcp_server}${Constants.mcp_delimiter}${serverName}`;
const mcpToolToken = (toolName: string, serverName: string) =>
  `${toolName}${Constants.mcp_delimiter}${serverName}`;

const sampleCatalog: AgentItem[] = [
  { kind: 'builtin', id: 'execute_code', name: 'Code', description: '', iconKey: 'execute_code' },
  { kind: 'builtin', id: 'web_search', name: 'Web', description: '', iconKey: 'web_search' },
  { kind: 'builtin', id: 'artifacts', name: 'Art', description: '', iconKey: 'artifacts' },
  { kind: 'builtin', id: 'context', name: 'Ctx', description: '', iconKey: 'context' },
  { kind: 'builtin', id: 'file_search', name: 'FS', description: '', iconKey: 'file_search' },
  { kind: 'builtin', id: 'memory', name: 'Memory', description: '', iconKey: 'memory' },
  {
    kind: 'tool',
    id: 'dalle',
    name: 'DALL-E',
    description: '',
    iconKey: 'tool',
    plugin: makePlugin({ pluginKey: 'dalle' }),
  },
  {
    kind: 'skill',
    id: 's1',
    name: 'Skill1',
    description: '',
    iconKey: 'skill',
    skill: makeSkill({ _id: 's1', name: 'Skill1' }),
  },
];

const emptyFormState = {
  execute_code: false,
  web_search: false,
  file_search: false,
  memory: false,
  artifacts: '',
  tools: [] as string[],
  skills: [] as string[],
  context_files: [] as Array<[string, unknown]>,
  knowledge_files: [] as Array<[string, unknown]>,
  code_files: [] as Array<[string, unknown]>,
};

describe('deriveSelectedItems', () => {
  test('returns nothing when nothing is selected', () => {
    expect(deriveSelectedItems(emptyFormState, sampleCatalog, [])).toEqual([]);
  });

  test('selects built-in capabilities by their flags', () => {
    const result = deriveSelectedItems(
      { ...emptyFormState, execute_code: true, artifacts: 'default' },
      sampleCatalog,
      [],
    );
    const ids = result.map((i) => i.id);
    expect(ids).toContain(AgentCapabilities.execute_code);
    expect(ids).toContain(AgentCapabilities.artifacts);
    expect(ids).not.toContain(AgentCapabilities.web_search);
  });

  test('selects the memory builtin by its flag', () => {
    const result = deriveSelectedItems({ ...emptyFormState, memory: true }, sampleCatalog, []);
    expect(result.map((i) => i.id)).toContain(AgentCapabilities.memory);
  });

  test('treats non-empty knowledge_files as file_search selected even without an explicit flag', () => {
    const result = deriveSelectedItems(
      { ...emptyFormState, knowledge_files: [['f', {}]] },
      sampleCatalog,
      [],
    );
    expect(result.find((i) => i.id === AgentCapabilities.file_search)).toBeDefined();
  });

  test('treats non-empty context_files as context selected even without an explicit flag', () => {
    const result = deriveSelectedItems(
      { ...emptyFormState, context_files: [['f', {}]] },
      sampleCatalog,
      [],
    );
    expect(result.find((i) => i.id === AgentCapabilities.context)).toBeDefined();
  });

  test('selects tools, skills, and MCP servers based on form arrays', () => {
    const catalog: AgentItem[] = [
      ...sampleCatalog,
      {
        kind: 'mcp',
        id: 'srv',
        name: 'srv',
        description: '',
        iconKey: 'mcp',
        server: makeMcpServer({ serverName: 'srv' }),
        toolCount: 0,
      },
    ];
    const result = deriveSelectedItems(
      { ...emptyFormState, tools: ['dalle', 'mcp_srv'], skills: ['s1'] },
      catalog,
      [],
    );
    const kinds = result.map((i) => i.kind);
    expect(kinds).toContain('tool');
    expect(kinds).toContain('skill');
    expect(kinds).toContain('mcp');
  });

  test('treats a per-tool MCP token as selecting the server', () => {
    const catalog: AgentItem[] = [
      ...sampleCatalog,
      {
        kind: 'mcp',
        id: 'srv',
        name: 'srv',
        description: '',
        iconKey: 'mcp',
        server: makeMcpServer({ serverName: 'srv' }),
        toolCount: 0,
      },
    ];
    const result = deriveSelectedItems(
      { ...emptyFormState, tools: [mcpToolToken('search', 'srv')] },
      catalog,
      [],
    );
    expect(result.find((i) => i.kind === 'mcp')?.id).toBe('srv');
  });

  test('treats a server represented only by its server token as attached', () => {
    const catalog: AgentItem[] = [
      ...sampleCatalog,
      {
        kind: 'mcp',
        id: 'srv',
        name: 'srv',
        description: '',
        iconKey: 'mcp',
        server: makeMcpServer({ serverName: 'srv' }),
        toolCount: 0,
      },
    ];
    const result = deriveSelectedItems(
      { ...emptyFormState, tools: [mcpServerToken('srv')] },
      catalog,
      [],
    );
    expect(result.find((i) => i.kind === 'mcp')?.id).toBe('srv');
  });

  test('an exact normalized MCP token selects only its collision owner', () => {
    const serverNames = ['foo mcp bar', 'foo_mcp_bar'];
    const catalog: AgentItem[] = [
      ...sampleCatalog,
      ...serverNames.map(
        (serverName): AgentItem => ({
          kind: 'mcp',
          id: serverName,
          name: serverName,
          description: '',
          iconKey: 'mcp',
          server: makeMcpServer({ serverName }),
          toolCount: 0,
        }),
      ),
    ];

    const result = deriveSelectedItems(
      { ...emptyFormState, tools: ['mcp_foo_mcp_bar'] },
      catalog,
      [],
    );

    expect(result.filter((item) => item.kind === 'mcp').map((item) => item.id)).toEqual([
      'foo_mcp_bar',
    ]);
  });

  test('deselect-all (empty tools) leaves no MCP server selected', () => {
    const catalog: AgentItem[] = [
      ...sampleCatalog,
      {
        kind: 'mcp',
        id: 'srv',
        name: 'srv',
        description: '',
        iconKey: 'mcp',
        server: makeMcpServer({ serverName: 'srv' }),
        toolCount: 0,
      },
    ];
    const result = deriveSelectedItems({ ...emptyFormState, tools: [] }, catalog, []);
    expect(result.find((i) => i.kind === 'mcp')).toBeUndefined();
  });

  test('selects all agent actions passed in', () => {
    const catalog: AgentItem[] = [
      ...sampleCatalog,
      {
        kind: 'action',
        id: 'a1',
        name: 'A1',
        description: '',
        iconKey: 'action',
        action: makeAction({ action_id: 'a1', agent_id: 'agt' }),
        endpointCount: 1,
      },
    ];
    const result = deriveSelectedItems(emptyFormState, catalog, [makeAction({ action_id: 'a1' })]);
    expect(result.find((i) => i.kind === 'action')?.id).toBe('a1');
  });

  test('selected items preserve stable kind ordering (builtin → mcp → tool → skill → action)', () => {
    const result = deriveSelectedItems(
      { ...emptyFormState, execute_code: true, tools: ['dalle'], skills: ['s1'] },
      sampleCatalog,
      [],
    );
    const kindOrder = result.map((i) => i.kind);
    expect(kindOrder.indexOf('builtin')).toBeLessThan(kindOrder.indexOf('tool'));
    expect(kindOrder.indexOf('tool')).toBeLessThan(kindOrder.indexOf('skill'));
  });
});

describe('matchesMcpServer', () => {
  test('matches every persisted token format for the server', () => {
    expect(matchesMcpServer(`${Constants.mcp_server}${Constants.mcp_delimiter}srv`, 'srv')).toBe(
      true,
    );
    expect(matchesMcpServer('srv', 'srv')).toBe(true);
    expect(matchesMcpServer('mcp_srv', 'srv')).toBe(true);
    expect(matchesMcpServer('search_mcp_srv', 'srv')).toBe(true);
    expect(matchesMcpServer(`sys__all__sys${Constants.mcp_delimiter}srv`, 'srv')).toBe(true);
  });

  test('does not match tokens for other servers or plain tool ids', () => {
    expect(matchesMcpServer('mcp_other', 'srv')).toBe(false);
    expect(matchesMcpServer('search_mcp_other', 'srv')).toBe(false);
    expect(matchesMcpServer('dalle', 'srv')).toBe(false);
    expect(matchesMcpServer('srv2', 'srv')).toBe(false);
  });

  test('never claims a longer server name sharing the prefix', () => {
    expect(matchesMcpServer('mcp_github_extra', 'github')).toBe(false);
    expect(matchesMcpServer('github_extra', 'github')).toBe(false);
    expect(matchesMcpServer('search_mcp_github_extra', 'github')).toBe(false);
    expect(matchesMcpServer('mcp_github_extra', 'github_extra')).toBe(true);
    expect(matchesMcpServer('search_mcp_github_extra', 'github_extra')).toBe(true);
  });

  test('boundary-exact matching prevents a delimiter-bearing normalized name from double-matching', () => {
    /** Raw `foo mcp bar` normalizes to `foo_mcp_bar`, which suffix-matching
     *  would ALSO attribute to a server named `bar` — both cards would show
     *  selected and removing `bar` would strip the other server's tool.
     *  With the full server list, the token resolves once by longest match. */
    const allServers = ['foo mcp bar', 'bar'];
    expect(matchesMcpServer('search_mcp_foo_mcp_bar', 'foo mcp bar', allServers)).toBe(true);
    expect(matchesMcpServer('search_mcp_foo_mcp_bar', 'bar', allServers)).toBe(false);
    expect(matchesMcpServer('search_mcp_bar', 'bar', allServers)).toBe(true);
    expect(matchesMcpServer('search_mcp_bar', 'foo mcp bar', allServers)).toBe(false);
  });

  test('exact MCP tokens belong only to the configured owner of a normalized name', () => {
    /** `foo mcp bar` and the literal `foo_mcp_bar` normalize to the same
     *  model-facing name. An exact `mcp_foo_mcp_bar` token must follow the
     *  alias registry's identity-first ownership instead of selecting both. */
    const collidingServers = ['foo mcp bar', 'foo_mcp_bar'];
    expect(matchesMcpServer('mcp_foo_mcp_bar', 'foo mcp bar', collidingServers)).toBe(false);
    expect(matchesMcpServer('mcp_foo_mcp_bar', 'foo_mcp_bar', collidingServers)).toBe(true);

    /** Without an identity-name collision, the normalized exact token still
     *  resolves back to its special-character raw server as before. */
    expect(matchesMcpServer('mcp_foo_mcp_bar', 'foo mcp bar', ['foo mcp bar'])).toBe(true);
    expect(matchesMcpServer('mcp_foo mcp bar', 'foo mcp bar', collidingServers)).toBe(true);
    expect(matchesMcpServer('mcp_foo mcp bar', 'foo_mcp_bar', collidingServers)).toBe(false);

    /** If neither raw name is already normalized, the alias registry's
     *  deterministic first-configured owner is the only match. */
    const aliasCollision = ['foo!', 'foo?'];
    expect(matchesMcpServer('mcp_foo', 'foo!', aliasCollision)).toBe(true);
    expect(matchesMcpServer('mcp_foo', 'foo?', aliasCollision)).toBe(false);
  });

  test('matches normalized-spelling tool ids for a special-character server', () => {
    /** Model-facing tool ids embed `normalizeServerName(server)`, while the
     *  marketplace/server cards are keyed raw — both spellings must count as
     *  attached or a selected server renders as an unselected orphan. */
    expect(matchesMcpServer('search_mcp_Connector__Company', 'Connector: Company')).toBe(true);
    expect(matchesMcpServer('search_mcp_Connector: Company', 'Connector: Company')).toBe(true);
    expect(matchesMcpServer('mcp_Connector__Company', 'Connector: Company')).toBe(true);
    expect(matchesMcpServer('search_mcp_Connector__Company', 'Connector__Company')).toBe(true);
    expect(matchesMcpServer('search_mcp_Connector__Other', 'Connector: Company')).toBe(false);
  });
});

describe('selection — ask_user_question builtin rides agent.tools', () => {
  const catalogWithAsk: AgentItem[] = [
    ...sampleCatalog,
    {
      kind: 'builtin',
      id: 'ask_user_question',
      name: 'com_ui_ask_user',
      description: 'com_agents_ask_user_info',
      iconKey: 'ask_user_question',
    },
  ];

  test('selected iff agent.tools contains the tool (no capability field involved)', () => {
    const selected = deriveSelectedItems(
      { ...emptyFormState, tools: ['ask_user_question'] },
      catalogWithAsk,
      [],
    );
    expect(selected.map((i) => i.id)).toContain('ask_user_question');

    const none = deriveSelectedItems(emptyFormState, catalogWithAsk, []);
    expect(none.map((i) => i.id)).not.toContain('ask_user_question');
  });
});
