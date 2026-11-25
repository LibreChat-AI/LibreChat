import {
  FileSources,
  AgentCapabilities,
  MAX_SUBAGENT_GRAPH_NODES,
  MAX_GRAPH_SUBAGENT_MEMBERS,
} from 'librechat-data-provider';
import type {
  Agent,
  Agents,
  AgentSubagentGraph,
  AgentSubagentsConfig,
} from 'librechat-data-provider';
import type { ResumeContentProtectionDependencies } from './protection';
import type { PreflightResumeContentInput } from './preflight';
import { getResumeProvenance, preflightResumeContent } from './preflight';

const user = {
  id: 'user-1',
  role: 'USER',
  email: 'user@example.com',
  emailVerified: true,
  provider: 'local',
} as PreflightResumeContentInput['user'];

function createDependencies(): ResumeContentProtectionDependencies {
  return {
    getAgentCheckpointer: jest.fn().mockResolvedValue(undefined),
    checkAccess: jest.fn(),
    getMessages: jest.fn().mockResolvedValue([]),
    getFiles: jest.fn().mockResolvedValue([]),
    getAgent: jest.fn().mockResolvedValue(null),
    getActions: jest.fn().mockResolvedValue([]),
    getUserMemories: jest.fn().mockResolvedValue([]),
    getRoleByName: jest.fn(),
    decryptMetadata: jest.fn(),
    canAccessAgent: jest.fn().mockResolvedValue(true),
  };
}

function createAskPendingAction(toolCallId = 'ask-2'): Agents.PendingAction {
  return {
    actionId: 'action-1',
    streamId: 'conversation-1',
    conversationId: 'conversation-1',
    createdAt: 1,
    payload: {
      type: 'ask_user_question',
      question: { question: 'Which environment?' },
      tool_call_id: toolCallId,
    },
  };
}

function createInput(
  overrides: Partial<PreflightResumeContentInput> = {},
): PreflightResumeContentInput {
  return {
    appConfig: undefined,
    endpointOption: undefined,
    conversationId: 'conversation-1',
    user,
    jobMetadata: {
      responseMessageId: 'assistant-1',
      userMessage: {
        messageId: 'user-message-1',
        parentMessageId: 'parent-1',
        text: 'Please continue',
      },
    },
    pendingAction: createAskPendingAction(),
    body: { answer: 'staging' },
    resumeValue: { answer: 'staging' },
    resumeState: {
      runSteps: [],
      aggregatedContent: [
        {
          type: 'tool_call',
          tool_call: { type: 'tool_call', id: 'ask-1', name: 'ask_user_question', args: '' },
        },
        {
          type: 'tool_call',
          tool_call: { type: 'tool_call', id: 'ask-2', name: 'ask_user_question', args: '' },
        },
      ],
    },
    liveFiles: [],
    isTemporary: false,
    checkpointNamespace: 'generation-1',
    resolvedAddedAgent: undefined,
    ...overrides,
  };
}

describe('preflightResumeContent', () => {
  it('stamps and attributes an ask answer to the exact tool call', async () => {
    const input = createInput();
    const originalContent = input.resumeState?.aggregatedContent;

    const result = await preflightResumeContent(input, createDependencies());

    expect(result.seedContent).toEqual([
      {
        type: 'tool_call',
        tool_call: { type: 'tool_call', id: 'ask-1', name: 'ask_user_question', args: '' },
      },
      {
        type: 'tool_call',
        tool_call: {
          type: 'tool_call',
          id: 'ask-2',
          name: 'ask_user_question',
          args: JSON.stringify({ question: 'Which environment?' }),
          output: 'staging',
          progress: 1,
        },
      },
    ]);
    expect(originalContent?.[1]).toEqual({
      type: 'tool_call',
      tool_call: { type: 'tool_call', id: 'ask-2', name: 'ask_user_question', args: '' },
    });
    expect(result.userSubmittedMessageFieldPaths).toEqual([
      { path: '/content/1/tool_call/output', field: 'answer' },
    ]);
    expect(result.storedMessages).toEqual([
      expect.objectContaining({ messageId: 'user-message-1', isCreatedByUser: true, role: 'user' }),
      expect.objectContaining({
        messageId: 'assistant-1',
        parentMessageId: 'user-message-1',
        isCreatedByUser: false,
        role: 'assistant',
        content: result.seedContent,
        userSubmittedMessageFieldPaths: result.userSubmittedMessageFieldPaths,
      }),
    ]);
  });

  it('falls back to the newest unanswered ask when the interrupt has no tool-call id', async () => {
    const pendingAction: Agents.PendingAction = {
      actionId: 'action-legacy',
      streamId: 'conversation-1',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Which environment?' },
      },
    };
    const result = await preflightResumeContent(
      createInput({
        pendingAction,
        body: { answer: 'production' },
        resumeValue: { answer: 'production' },
        resumeState: {
          runSteps: [],
          aggregatedContent: [
            {
              type: 'tool_call',
              tool_call: {
                type: 'tool_call',
                id: 'ask-1',
                name: 'ask_user_question',
                args: '{}',
                output: 'staging',
              },
            },
            {
              type: 'tool_call',
              tool_call: {
                type: 'tool_call',
                id: 'ask-2',
                name: 'ask_user_question',
                args: '',
              },
            },
          ],
        },
      }),
      createDependencies(),
    );

    expect(result.seedContent[0]?.tool_call?.output).toBe('staging');
    expect(result.seedContent[1]?.tool_call?.output).toBe('production');
    expect(result.userSubmittedMessageFieldPaths).toEqual([
      { path: '/content/1/tool_call/output', field: 'answer' },
    ]);
  });

  it('does not attribute an ID-less current answer to an older unanswered ask', () => {
    const pendingAction: Agents.PendingAction = {
      actionId: 'action-legacy',
      streamId: 'conversation-1',
      createdAt: 1,
      payload: {
        type: 'ask_user_question',
        question: { question: 'Which environment?' },
      },
    };
    const content = [
      {
        type: 'tool_call',
        tool_call: {
          id: 'ask-1',
          name: 'ask_user_question',
          args: JSON.stringify({ question: 'Earlier question?' }),
          output: '',
        },
      },
      {
        type: 'tool_call',
        tool_call: {
          id: 'ask-2',
          name: 'ask_user_question',
          args: JSON.stringify({ question: 'Which environment?' }),
          output: 'production',
        },
      },
    ];

    expect(
      getResumeProvenance({
        content,
        pendingAction,
        body: { answer: 'production' },
      }).userSubmittedMessageFieldPaths,
    ).toEqual([{ path: '/content/1/tool_call/output', field: 'answer' }]);
  });

  it('deduplicates accumulated edit, response, reject, and steer provenance', () => {
    const content = [
      { type: 'tool_call', tool_call: { id: 'edit-1', name: 'edit_tool', args: '{}' } },
      { type: 'tool_call', tool_call: { id: 'respond-1', name: 'respond_tool', args: '{}' } },
      { type: 'tool_call', tool_call: { id: 'reject-1', name: 'reject_tool', args: '{}' } },
      { type: 'steer', text: 'Please change course' },
    ];
    const pendingAction: Agents.PendingAction = {
      actionId: 'action-2',
      streamId: 'conversation-1',
      createdAt: 2,
      payload: {
        type: 'tool_approval',
        action_requests: [],
        review_configs: [],
      },
    };

    expect(
      getResumeProvenance({
        content,
        pendingAction,
        body: {
          decisions: [
            { tool_call_id: 'edit-1', decision: 'edit', editedArguments: { query: 'new' } },
            { tool_call_id: 'respond-1', decision: 'respond', responseText: 'response' },
            { tool_call_id: 'reject-1', decision: 'reject', reason: 'reason' },
          ],
        },
        existingPaths: ['/content/0/tool_call/args'],
        existingMessageFieldPaths: [
          { path: '/content/1/tool_call/output', field: 'decision_response' },
        ],
      }),
    ).toEqual({
      userSubmittedPaths: ['/content/0/tool_call/args', '/content/3'],
      userSubmittedMessageFieldPaths: [
        { path: '/content/1/tool_call/output', field: 'decision_response' },
        { path: '/content/2/tool_call/output', field: 'decision_reason' },
      ],
    });
  });

  it('does not synthesize stored messages when paused user metadata is unavailable', async () => {
    const result = await preflightResumeContent(
      createInput({ jobMetadata: { responseMessageId: 'assistant-1' } }),
      createDependencies(),
    );

    expect(result.storedMessages).toEqual([]);
  });

  it('rejects a protected ask answer before returning prepared content', async () => {
    const pattern = [{ id: 'private', label: 'private', regex: 'PRIVATE-ANSWER' }];
    const input = createInput({
      appConfig: {
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: 'webp',
        filters: {
          messages: {
            pii: { fields: ['answer'], starterPatterns: [], customPatterns: pattern },
          },
        },
      },
      body: { answer: 'PRIVATE-ANSWER' },
      resumeValue: { answer: 'PRIVATE-ANSWER' },
      isTemporary: true,
    });

    await expect(preflightResumeContent(input, createDependencies())).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'answer' },
    });
  });

  it('inspects user-attributed seed content when a legacy job has no response id', async () => {
    const pattern = [{ id: 'private', label: 'private', regex: 'PRIVATE-SEED' }];
    const input = createInput({
      appConfig: {
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: 'webp',
        filters: {
          messages: {
            pii: { fields: ['content_part'], starterPatterns: [], customPatterns: pattern },
          },
        },
      },
      jobMetadata: {
        userMessage: {
          messageId: 'user-message-1',
          parentMessageId: 'parent-1',
          text: 'Please continue',
        },
        userSubmittedPaths: ['/content/0'],
      },
      pendingAction: {
        actionId: 'action-legacy',
        streamId: 'conversation-1',
        createdAt: 1,
        payload: { type: 'tool_approval', action_requests: [], review_configs: [] },
      },
      body: { decisions: [] },
      resumeValue: undefined,
      resumeState: {
        runSteps: [],
        aggregatedContent: [{ type: 'text', text: 'PRIVATE-SEED' }],
      },
      isTemporary: true,
    });

    await expect(preflightResumeContent(input, createDependencies())).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'content_part' },
    });
  });
});

describe('graph-member preflight', () => {
  const agent = (id: string, subagents?: AgentSubagentsConfig): Agent =>
    ({
      id,
      name: id,
      description: null,
      created_at: 0,
      avatar: null,
      provider: 'openAI',
      model: 'test',
      model_parameters: {
        temperature: null,
        maxContextTokens: null,
        max_context_tokens: null,
        max_output_tokens: null,
        top_p: null,
        frequency_penalty: null,
        presence_penalty: null,
      },
      tools: [],
      subagents,
    }) as Agent;
  const graph = (id: string) => ({
    type: 'team',
    name: 'Team',
    description: 'Work',
    agent_ids: [id],
    edges: [],
    entry_agent_id: id,
    result_agent_id: id,
  });
  const policy = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'webp',
    endpoints: {
      agents: { capabilities: [AgentCapabilities.subagents, AgentCapabilities.subagent_graphs] },
    },
    filters: {
      agentInstructions: { pii: { fields: ['instructions'], starterPatterns: ['sk_prefix'] } },
    },
  } satisfies NonNullable<PreflightResumeContentInput['appConfig']>;

  it.each(['safe', 'blocked', 'missing', 'revoked', 'over-budget', 'inert'])(
    'enforces the exact member boundary through content-policy preflight: %s',
    async (state) => {
      const count = MAX_SUBAGENT_GRAPH_NODES + (state === 'over-budget' ? 1 : 0);
      const ids = Array.from({ length: count }, (_, index) => `member-${index}`);
      const graphs: AgentSubagentGraph[] = [];
      for (let start = 0; start < count; start += MAX_GRAPH_SUBAGENT_MEMBERS) {
        const members = ids.slice(start, start + MAX_GRAPH_SUBAGENT_MEMBERS);
        graphs.push({
          ...graph(members[0]),
          type: `team-${start}`,
          agent_ids: members,
          result_agent_id: members[members.length - 1],
          edges: members.slice(1).map((id, index) => ({
            from: members[index],
            to: id,
            edgeType: 'direct' as const,
          })),
        });
      }
      const subagents = { enabled: false, graphsEnabled: true, graphs };
      const primary = agent('primary', subagents);
      const last = ids[count - 1];
      const dependencies = createDependencies();
      dependencies.getAgent = jest.fn(async ({ id }) =>
        id === last && state === 'missing'
          ? null
          : {
              ...agent(id),
              instructions:
                id === last && state === 'blocked' ? 'Use sk-boundary-member-secret' : '',
            },
      );
      dependencies.canAccessAgent = jest.fn(async ({ id }) => id !== last || state !== 'revoked');
      const result = preflightResumeContent(
        createInput({
          appConfig: state === 'inert' ? { ...policy, filters: undefined } : policy,
          endpointOption: { agent: Promise.resolve(primary) },
          resolvedAddedAgent: agent('additional', subagents),
        }),
        dependencies,
      );
      if (state === 'safe' || state === 'inert') {
        await expect(result).resolves.toBeDefined();
      } else {
        await expect(result).rejects.toMatchObject({
          code: state === 'blocked' ? 'content_filter_block' : 'content_filter_uninspectable',
        });
      }
      expect(dependencies.getAgent).toHaveBeenCalledTimes(
        state === 'inert' || state === 'over-budget' ? 0 : count,
      );
      if (state !== 'inert' && state !== 'over-budget')
        expect(dependencies.getAgent).toHaveBeenCalledWith({ id: last });
    },
  );

  it.each(['safe', 'blocked', 'missing', 'revoked', 'over-budget'])(
    'classifies discovered handoffs before validating the member budget: %s',
    async (state) => {
      const count = MAX_SUBAGENT_GRAPH_NODES + (state === 'over-budget' ? 1 : 0);
      const ids = Array.from({ length: count }, (_, index) => `member-${index}`);
      const graphs: AgentSubagentGraph[] = [];
      for (let start = 0; start < count; start += 25) {
        const members = ids.slice(start, start + 25);
        graphs.push({
          ...graph(members[0]),
          type: `team-${start}`,
          agent_ids: members,
          result_agent_id: members[members.length - 1],
          edges: members
            .slice(1)
            .map((id, index) => ({ from: members[index], to: id, edgeType: 'direct' })),
        });
      }
      const primary = {
        ...agent('primary', { enabled: false, graphsEnabled: true, graphs }),
        edges: [{ from: 'primary', to: 'handoff', edgeType: 'handoff' as const }],
      };
      const dependencies = createDependencies();
      const last = ids[count - 1];
      dependencies.getAgent = jest.fn(async ({ id }) =>
        id === last && state === 'missing'
          ? null
          : {
              ...agent(id),
              instructions:
                id === last && state === 'blocked' ? 'Use sk-boundary-member-secret' : '',
            },
      );
      dependencies.canAccessAgent = jest.fn(async ({ id }) => id !== last || state !== 'revoked');
      const result = preflightResumeContent(
        createInput({ appConfig: policy, endpointOption: { agent: Promise.resolve(primary) } }),
        dependencies,
      );
      if (state === 'safe') await expect(result).resolves.toBeDefined();
      else
        await expect(result).rejects.toMatchObject({
          code: state === 'blocked' ? 'content_filter_block' : 'content_filter_uninspectable',
        });
      expect(dependencies.getAgent).toHaveBeenCalledWith({ id: 'handoff' });
      if (state !== 'over-budget') expect(dependencies.getAgent).toHaveBeenCalledWith({ id: last });
      expect(dependencies.getAgent).toHaveBeenCalledTimes(state === 'over-budget' ? 1 : count + 1);
    },
  );

  it.each(['missing', 'revoked', 'required-missing', 'required-revoked', 'extra-allowed'])(
    'counts admitted ordinary members at the real preflight boundary: %s',
    async (state) => {
      const ids = Array.from({ length: 49 }, (_, index) => `member-${index}`);
      const graphs: AgentSubagentGraph[] = [0, 25].map((start) => {
        const members = ids.slice(start, start + 25);
        return {
          ...graph(members[0]),
          type: `team-${start}`,
          agent_ids: members,
          result_agent_id: members[members.length - 1],
          edges: members
            .slice(1)
            .map((id, index) => ({ from: members[index], to: id, edgeType: 'direct' as const })),
        };
      });
      const primary = agent('primary', {
        enabled: true,
        graphsEnabled: true,
        agent_ids: ['child'],
        graphs,
      });
      const child = agent('child', {
        enabled: true,
        agent_ids: ['stale', ...(state === 'extra-allowed' ? ['extra'] : [])],
        ...(state.startsWith('required') ? { graphsEnabled: true, graphs: [graph('stale')] } : {}),
      });
      const dependencies = createDependencies();
      dependencies.getAgent = jest.fn(async ({ id }) => {
        if (id === 'stale' && !state.endsWith('revoked')) return null;
        return id === 'child' ? child : agent(id);
      });
      dependencies.canAccessAgent = jest.fn(async ({ id }) => id !== 'stale');
      const result = preflightResumeContent(
        createInput({ appConfig: policy, endpointOption: { agent: Promise.resolve(primary) } }),
        dependencies,
      );
      if (state === 'missing' || state === 'revoked') await expect(result).resolves.toBeDefined();
      else await expect(result).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
      expect(dependencies.getAgent).toHaveBeenCalledWith({ id: 'stale' });
      if (state === 'extra-allowed')
        expect(dependencies.getAgent).toHaveBeenCalledWith({ id: 'extra' });
    },
  );

  it('inspects current active members through the real preflight API', async () => {
    const dependencies = createDependencies();
    const member = { ...agent('member'), instructions: 'Use sk-edited-graph-member-secret' };
    dependencies.getAgent = jest.fn().mockResolvedValue(member);
    const primary = agent('primary', {
      enabled: false,
      graphsEnabled: true,
      graphs: [graph('member')],
    });
    await expect(
      preflightResumeContent(
        createInput({
          appConfig: policy,
          endpointOption: { agent: Promise.resolve(primary) },
        }),
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'content_filter_block' });
    expect(dependencies.getAgent).toHaveBeenCalledTimes(1);
    expect(dependencies.canAccessAgent).toHaveBeenCalledWith(member, user);
  });

  it.each([false, true])(
    'fails closed on unavailable active members, revoked=%s',
    async (revoked) => {
      const dependencies = createDependencies();
      dependencies.getAgent = jest.fn().mockResolvedValue(revoked ? agent('member') : null);
      dependencies.canAccessAgent = jest.fn().mockResolvedValue(!revoked);
      await expect(
        preflightResumeContent(
          createInput({
            appConfig: policy,
            endpointOption: {
              agent: Promise.resolve(
                agent('primary', {
                  enabled: false,
                  graphsEnabled: true,
                  graphs: [graph('member')],
                }),
              ),
            },
          }),
          dependencies,
        ),
      ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    },
  );

  it.each([false, true])(
    'upgrades shared terminal members without repeated loads, ordinary=%s',
    async (ordinary) => {
      const dependencies = createDependencies();
      const member = agent('member', { enabled: true, agent_ids: ['leaf'] });
      const leaf = { ...agent('leaf'), instructions: 'Use sk-nested-member-secret' };
      const bridge = agent('bridge', { enabled: true, agent_ids: ['member'] });
      const saved = new Map([member, leaf, bridge].map((value) => [value.id, value]));
      dependencies.getAgent = jest.fn(async ({ id }) => saved.get(id));
      const primary = agent('primary', {
        enabled: true,
        agent_ids: ordinary ? ['bridge'] : [],
        graphsEnabled: true,
        graphs: [graph('member')],
      });
      const result = preflightResumeContent(
        createInput({
          appConfig: policy,
          endpointOption: { agent: Promise.resolve(primary) },
        }),
        dependencies,
      );
      if (ordinary) {
        await expect(result).rejects.toMatchObject({ code: 'content_filter_block' });
        expect(dependencies.getAgent).toHaveBeenCalledTimes(3);
      } else {
        await expect(result).resolves.toBeDefined();
        expect(dependencies.getAgent).toHaveBeenCalledTimes(1);
      }
      expect(dependencies.getAgent).toHaveBeenCalledWith({ id: 'member' });
    },
  );
});
