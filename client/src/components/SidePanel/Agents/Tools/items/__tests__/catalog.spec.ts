import { AgentCapabilities } from 'librechat-data-provider';
import type { BuildCatalogInputs } from '../catalog';
import { makePlugin, makeSkill, makeAction } from 'test/itemFactories';
import { buildCatalog } from '../catalog';

const emptyInputs: BuildCatalogInputs = {
  agentsConfig: { capabilities: [] },
  regularTools: [],
  mcpServersMap: new Map(),
  skills: [],
  actions: [],
  permissions: { mcp: true, skills: true, webSearch: true, runCode: true, fileSearch: true },
};

const toolInputs: BuildCatalogInputs = {
  ...emptyInputs,
  agentsConfig: { capabilities: [AgentCapabilities.tools] },
};

const askInputs: BuildCatalogInputs = {
  ...emptyInputs,
  agentsConfig: { capabilities: [AgentCapabilities.ask_user_question] },
};

describe('buildCatalog', () => {
  test('returns empty when nothing is enabled', () => {
    expect(buildCatalog(emptyInputs)).toEqual([]);
  });

  test('emits built-in items only for capabilities the admin enabled', () => {
    const items = buildCatalog({
      ...emptyInputs,
      agentsConfig: {
        capabilities: [AgentCapabilities.execute_code, AgentCapabilities.web_search],
      },
    });
    expect(items.filter((i) => i.kind === 'builtin').map((i) => i.id)).toEqual([
      AgentCapabilities.execute_code,
      AgentCapabilities.web_search,
    ]);
  });

  test('emits the memory builtin only when showMemory is set', () => {
    const memoryId = (i: { kind: string; id: string }) =>
      i.kind === 'builtin' && i.id === AgentCapabilities.memory;
    expect(buildCatalog(emptyInputs).find(memoryId)).toBeUndefined();
    expect(buildCatalog({ ...emptyInputs, showMemory: true }).find(memoryId)).toBeDefined();
  });

  test('flags web_search userProvidedAuth from the webSearchUserProvided input', () => {
    const findWebSearch = (inputs: BuildCatalogInputs) =>
      buildCatalog(inputs).find(
        (i) => i.kind === 'builtin' && i.id === AgentCapabilities.web_search,
      );
    const base = {
      ...emptyInputs,
      agentsConfig: { capabilities: [AgentCapabilities.web_search] },
    };
    const userProvided = findWebSearch({ ...base, webSearchUserProvided: true });
    const systemDefined = findWebSearch({ ...base, webSearchUserProvided: false });
    expect(userProvided?.kind === 'builtin' && userProvided.userProvidedAuth).toBe(true);
    expect(systemDefined?.kind === 'builtin' && systemDefined.userProvidedAuth).toBe(false);
  });

  test('surfaces ask_user_question as a BUILTIN (not a plugin) when the server lists it', () => {
    const askPlugin = makePlugin({ pluginKey: 'ask_user_question', name: 'Ask User' });
    const items = buildCatalog({ ...askInputs, regularTools: [askPlugin] });
    const builtin = items.find((i) => i.kind === 'builtin' && i.id === 'ask_user_question');
    expect(builtin).toBeDefined();
    expect(builtin?.iconKey).toBe('ask_user_question');
    // never double-listed in the plugin section
    expect(items.find((i) => i.kind === 'tool' && i.id === 'ask_user_question')).toBeUndefined();
  });

  test('gates the ask_user_question builtin on its OWN capability, not the generic tools one', () => {
    const askPlugin = makePlugin({ pluginKey: 'ask_user_question', name: 'Ask User' });
    // admin filtered (not in regularTools) despite the capability being on
    expect(
      buildCatalog(askInputs).find((i) => i.kind === 'builtin' && i.id === 'ask_user_question'),
    ).toBeUndefined();
    // ask_user_question capability off — the generic `tools` capability does NOT stand in for it
    expect(
      buildCatalog({ ...toolInputs, regularTools: [askPlugin] }).find(
        (i) => i.kind === 'builtin' && i.id === 'ask_user_question',
      ),
    ).toBeUndefined();
  });

  test('hides MCP items when the user lacks MCP permission', () => {
    const map = new Map();
    map.set('srv', { serverName: 'srv', isConfigured: true, tools: [] });
    const items = buildCatalog({
      ...emptyInputs,
      mcpServersMap: map,
      permissions: { ...emptyInputs.permissions, mcp: false },
    });
    expect(items.find((i) => i.kind === 'mcp')).toBeUndefined();
  });

  test('emits MCP items with tool counts', () => {
    const map = new Map();
    map.set('everything', {
      serverName: 'everything',
      isConfigured: true,
      tools: [{}, {}, {}],
    });
    const items = buildCatalog({ ...emptyInputs, mcpServersMap: map });
    const mcp = items.find((i) => i.kind === 'mcp');
    expect(mcp).toBeDefined();
    if (mcp?.kind === 'mcp') {
      expect(mcp.toolCount).toBe(3);
      expect(mcp.id).toBe('everything');
    }
  });

  test('excludes consume-only MCP servers from the catalog', () => {
    const map = new Map();
    map.set('attachable', { serverName: 'attachable', isConfigured: true, tools: [] });
    map.set('chat-only', {
      serverName: 'chat-only',
      isConfigured: true,
      tools: [],
      consumeOnly: true,
    });
    const items = buildCatalog({ ...emptyInputs, mcpServersMap: map });
    expect(items.filter((i) => i.kind === 'mcp').map((i) => i.id)).toEqual(['attachable']);
  });

  test('emits skill items when permission granted', () => {
    const items = buildCatalog({
      ...emptyInputs,
      skills: [
        makeSkill({ _id: 's1', name: 'Reviewer', description: 'Reviews', category: 'code' }),
      ],
    });
    const skill = items.find((i) => i.kind === 'skill');
    expect(skill?.name).toBe('Reviewer');
  });

  test('emits tool items when the tools capability is enabled', () => {
    const items = buildCatalog({
      ...toolInputs,
      regularTools: [makePlugin({ pluginKey: 'dalle', name: 'DALL-E', description: 'Images' })],
    });
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool?.id).toBe('dalle');
  });

  test('hides tool items when the admin disabled the tools capability', () => {
    const items = buildCatalog({
      ...emptyInputs,
      regularTools: [makePlugin({ pluginKey: 'dalle', name: 'DALL-E', description: 'Images' })],
    });
    expect(items.find((i) => i.kind === 'tool')).toBeUndefined();
  });

  test('marks an auth-requiring, unauthenticated tool as needs_setup', () => {
    const items = buildCatalog({
      ...toolInputs,
      regularTools: [
        makePlugin({
          pluginKey: 'serpapi',
          name: 'SerpApi',
          description: 'Search',
          authConfig: [{ authField: 'SERPAPI_API_KEY', label: 'Key', description: '' }],
          authenticated: false,
        }),
      ],
    });
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool?.status).toBe('needs_setup');
  });

  test('leaves status undefined for an authenticated auth-requiring tool', () => {
    const items = buildCatalog({
      ...toolInputs,
      regularTools: [
        makePlugin({
          pluginKey: 'serpapi',
          name: 'SerpApi',
          description: 'Search',
          authConfig: [{ authField: 'SERPAPI_API_KEY', label: 'Key', description: '' }],
          authenticated: true,
        }),
      ],
    });
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool?.status).toBeUndefined();
  });

  test('leaves status undefined for a tool with no authConfig', () => {
    const items = buildCatalog({
      ...toolInputs,
      regularTools: [makePlugin({ pluginKey: 'dalle', name: 'DALL-E', description: 'Images' })],
    });
    const tool = items.find((i) => i.kind === 'tool');
    expect(tool?.status).toBeUndefined();
  });

  test('flags builtin status from builtinAuthMap', () => {
    const items = buildCatalog({
      ...emptyInputs,
      agentsConfig: { capabilities: [AgentCapabilities.web_search] },
      builtinAuthMap: new Map([[AgentCapabilities.web_search, true]]),
    });
    const builtin = items.find((i) => i.kind === 'builtin');
    expect(builtin?.status).toBe('needs_setup');
  });

  test('marks a skill authored by the current user as ownedByUser', () => {
    const items = buildCatalog({
      ...emptyInputs,
      currentUserId: 'u1',
      skills: [
        makeSkill({ _id: 's1', name: 'Mine', description: '', category: 'code', author: 'u1' }),
        makeSkill({ _id: 's2', name: 'Theirs', description: '', category: 'code', author: 'u2' }),
      ],
    });
    const skills = items.filter((i) => i.kind === 'skill');
    expect(skills.find((s) => s.id === 's1')?.ownedByUser).toBe(true);
    expect(skills.find((s) => s.id === 's2')?.ownedByUser).toBe(false);
  });

  test('leaves ownedByUser false when no currentUserId is provided', () => {
    const items = buildCatalog({
      ...emptyInputs,
      skills: [makeSkill({ _id: 's1', name: 'S1', description: '', author: 'u1' })],
    });
    const skill = items.find((i) => i.kind === 'skill');
    expect(skill?.ownedByUser).toBe(false);
  });

  test('emits action items with endpoint counts', () => {
    const items = buildCatalog({
      ...emptyInputs,
      actions: [
        makeAction({
          action_id: 'a1',
          metadata: { domain: 'linear.app', oauth_client_id: 'x' },
          settings: { paths: { '/issues': {}, '/teams': {} } },
        }),
      ],
    });
    const action = items.find((i) => i.kind === 'action');
    expect(action?.id).toBe('a1');
    if (action?.kind === 'action') {
      expect(action.endpointCount).toBe(2);
    }
  });

  describe.each([
    { cap: AgentCapabilities.web_search, field: 'webSearch' as const },
    { cap: AgentCapabilities.execute_code, field: 'runCode' as const },
    { cap: AgentCapabilities.file_search, field: 'fileSearch' as const },
  ])('gates the $cap builtin on its role permission', ({ cap, field }) => {
    const findBuiltin = (items: ReturnType<typeof buildCatalog>) =>
      items.find((i) => i.kind === 'builtin' && i.id === cap);

    test('absent when the role permission is false and the capability is enabled', () => {
      const items = buildCatalog({
        ...emptyInputs,
        agentsConfig: { capabilities: [cap] },
        permissions: { ...emptyInputs.permissions, [field]: false },
      });
      expect(findBuiltin(items)).toBeUndefined();
    });

    test('present when both the role permission and the capability are true', () => {
      const items = buildCatalog({
        ...emptyInputs,
        agentsConfig: { capabilities: [cap] },
        permissions: { ...emptyInputs.permissions, [field]: true },
      });
      expect(findBuiltin(items)).toBeDefined();
    });

    test('absent when the capability is off regardless of the role grant', () => {
      const items = buildCatalog({
        ...emptyInputs,
        agentsConfig: { capabilities: [] },
        permissions: { ...emptyInputs.permissions, [field]: true },
      });
      expect(findBuiltin(items)).toBeUndefined();
    });
  });

  test('returns items in stable order: builtin -> mcp -> tool -> skill -> action', () => {
    const map = new Map();
    map.set('srv', { serverName: 'srv', isConfigured: true, tools: [] });
    const items = buildCatalog({
      ...emptyInputs,
      agentsConfig: { capabilities: [AgentCapabilities.execute_code, AgentCapabilities.tools] },
      regularTools: [makePlugin({ pluginKey: 't1', name: 'T1', description: '' })],
      mcpServersMap: map,
      skills: [makeSkill({ _id: 's1', name: 'S1', description: '' })],
      actions: [
        makeAction({ action_id: 'a1', metadata: { domain: 'd' }, settings: { paths: {} } }),
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['builtin', 'mcp', 'tool', 'skill', 'action']);
  });
});
