import {
  Constants,
  MAX_SUBAGENT_GRAPH_NODES,
  MAX_GRAPH_SUBAGENT_MEMBERS,
  getSubagentGraphMemberCount,
} from 'librechat-data-provider';
import type { Agent, AgentSubagentGraph } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { getResumeContentInspection, getResumeAgentSnapshot } from './inspection';

const strictExtractedTextConfig = {
  filters: {
    files: {
      pii: {
        fields: ['extracted_text'],
        starterPatterns: [],
        uninspectable: 'block',
      },
    },
  },
} as unknown as AppConfig;

function buildInput(trustLiveFileContent?: boolean) {
  return {
    appConfig: strictExtractedTextConfig,
    conversationId: 'conversation-1',
    targetMessageId: 'message-1',
    user: { id: 'user-1' },
    supplementalMessages: [
      {
        messageId: 'message-1',
        conversationId: 'conversation-1',
        parentMessageId: String(Constants.NO_PARENT),
        text: '',
        isCreatedByUser: true,
        files: [{ file_id: 'owned-file' }],
      },
    ],
    submittedMessages: [],
    liveFiles: [
      {
        file_id: 'owned-file',
        filename: 'forged.txt',
        type: 'text/plain',
        source: 'text',
        text: 'forged safe extraction',
      },
    ],
    ...(trustLiveFileContent != null && { trustLiveFileContent }),
    isTemporary: false,
    getMessages: jest.fn().mockResolvedValue([]),
    getFiles: jest.fn().mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'opaque.pdf',
        type: 'application/pdf',
        source: 'local',
      },
    ]),
  };
}

describe('resume file inspection trust boundary', () => {
  it('resumes a long persisted branch with one batched owner-file lookup', async () => {
    const input = buildInput();
    const history = Array.from({ length: 58 }, (_, index) => ({
      messageId: `history-${index}`,
      parentMessageId: index === 0 ? String(Constants.NO_PARENT) : `history-${index - 1}`,
      conversationId: 'conversation-1',
      isCreatedByUser: true,
      content: Array.from({ length: 80 }, () => ({ type: 'text', text: 'safe history' })),
      files: index === 57 ? [{ file_id: 'owned-file' }] : [],
    }));
    input.getMessages.mockResolvedValue(history);
    input.getFiles.mockResolvedValue([{ file_id: 'owned-file', text: 'safe extraction' }]);
    const result = await getResumeContentInspection({
      ...input,
      targetMessageId: 'history-57',
      supplementalMessages: [],
      fileReferenceInputs: history,
    });
    expect(result.storedMessages).toHaveLength(58);
    expect(result.originalStoredMessages).toEqual(history);
    expect(result.hydratedFiles).toEqual([{ file_id: 'owned-file', text: 'safe extraction' }]);
    expect(input.getFiles).toHaveBeenCalledTimes(1);
  });

  it('does not accept request/job file metadata as extraction coverage', async () => {
    await expect(getResumeContentInspection(buildInput())).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
  });

  it('accepts explicitly trusted server-hydrated runtime extraction', async () => {
    await expect(getResumeContentInspection(buildInput(true))).resolves.toMatchObject({
      hydratedFiles: [
        expect.objectContaining({
          file_id: 'owned-file',
          filename: 'opaque.pdf',
          text: 'forged safe extraction',
        }),
      ],
    });
  });

  it('hydrates file references carried only by additional checkpoint structures', async () => {
    const input = {
      ...buildInput(),
      fileReferenceInputs: [
        {
          tool_calls: [{ arguments: { file_id: 'checkpoint-only-file' } }],
        },
      ],
    };
    input.getFiles.mockResolvedValue([
      {
        file_id: 'owned-file',
        filename: 'safe.txt',
        type: 'text/plain',
        source: 'local',
        content: 'safe extracted content',
        extractedText: 'safe extracted content',
      },
    ]);

    await expect(getResumeContentInspection(input)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(input.getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: expect.arrayContaining(['owned-file', 'checkpoint-only-file']) },
        user: 'user-1',
      },
      {},
      {},
    );
  });

  it('does not reload persisted history for an inert message sibling policy', async () => {
    const getMessages = jest.fn().mockRejectedValue(new Error('history should not be loaded'));
    const result = await getResumeContentInspection({
      appConfig: {
        filters: {
          skills: {
            pii: {
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private', regex: 'PRIVATE-[A-Z]+' }],
            },
          },
          messages: { pii: { starterPatterns: [] } },
          toolArguments: { pii: { starterPatterns: [] } },
        },
      } as unknown as AppConfig,
      conversationId: 'conversation-1',
      targetMessageId: 'missing-message',
      user: { id: 'user-1' },
      supplementalMessages: [],
      submittedMessages: [],
      liveFiles: [],
      isTemporary: false,
      getMessages,
      getFiles: jest.fn().mockResolvedValue([]),
    });

    expect(result.storedMessages).toEqual([]);
    expect(getMessages).not.toHaveBeenCalled();
  });
});

describe('resume agent snapshot budget', () => {
  const agent = (id: string, graphs: AgentSubagentGraph[] = []): Agent => ({
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
    subagents: { enabled: false, graphsEnabled: true, graphs },
  });
  const teams = (count: number): AgentSubagentGraph[] => {
    const graphs: AgentSubagentGraph[] = [];
    for (let start = 0; start < count; start += MAX_GRAPH_SUBAGENT_MEMBERS) {
      const ids = Array.from(
        { length: Math.min(MAX_GRAPH_SUBAGENT_MEMBERS, count - start) },
        (_, index) => `member-${start + index}`,
      );
      graphs.push({
        type: `team-${start}`,
        name: 'Team',
        description: 'Work',
        agent_ids: ids,
        entry_agent_id: ids[0],
        result_agent_id: ids[ids.length - 1],
        edges: ids.slice(1).map((id, index) => ({ from: ids[index], to: id, edgeType: 'direct' })),
      });
    }
    return graphs;
  };

  it.each([0, 2])(
    'excludes %s additional roots and deduplicates shared members at the exact budget',
    async (rootCount) => {
      const graphs = teams(MAX_SUBAGENT_GRAPH_NODES);
      const primaryAgent = agent('primary', [...graphs, { ...graphs[0], type: 'shared' }]);
      expect(getSubagentGraphMemberCount({ graphs: primaryAgent.subagents?.graphs })).toBe(
        MAX_SUBAGENT_GRAPH_NODES,
      );
      const additionalRoots = Array.from({ length: rootCount }, (_, index) =>
        agent(`root-${index}`, graphs),
      );
      const getAgent = jest.fn(async ({ id }: { id: string }) => agent(id));
      const canAccessAgent = jest.fn(async () => true);
      const snapshots = await getResumeAgentSnapshot({
        primaryAgent,
        additionalRoots: [...additionalRoots, ...additionalRoots],
        capabilities: ['subagent_graphs'],
        getAgent,
        canAccessAgent,
      });
      expect(snapshots).toHaveLength(1 + rootCount + MAX_SUBAGENT_GRAPH_NODES);
      expect(new Set(snapshots.map(({ id }) => id)).size).toBe(snapshots.length);
      expect(getAgent).toHaveBeenCalledTimes(MAX_SUBAGENT_GRAPH_NODES);
      expect(canAccessAgent).toHaveBeenCalledTimes(MAX_SUBAGENT_GRAPH_NODES);
      for (let index = 0; index < MAX_SUBAGENT_GRAPH_NODES; index++) {
        expect(getAgent).toHaveBeenCalledWith({ id: `member-${index}` });
      }
      expect(primaryAgent.subagents?.graphs).toHaveLength(graphs.length + 1);
    },
  );

  it.each(['chain', 'cycle', 'diamond'])(
    'excludes discovered %s roots from the exact member budget',
    async (shape) => {
      const primary = agent('primary', teams(MAX_SUBAGENT_GRAPH_NODES));
      const first = agent('first');
      const second = agent('second', teams(MAX_SUBAGENT_GRAPH_NODES));
      const shared = agent('shared', [
        {
          ...teams(2)[0],
          agent_ids: ['primary', 'first'],
          entry_agent_id: 'primary',
          result_agent_id: 'first',
          edges: [{ from: 'primary', to: 'first', edgeType: 'direct' }],
        },
      ]);
      primary.edges = [{ from: 'primary', to: 'first', edgeType: 'handoff' }];
      first.edges = [{ from: 'first', to: 'second', edgeType: 'handoff' }];
      second.edges = [
        { from: 'second', to: shape === 'cycle' ? 'primary' : 'shared', edgeType: 'handoff' },
      ];
      if (shape === 'diamond')
        primary.edges.push({ from: 'primary', to: 'shared', edgeType: 'handoff' });
      const saved = new Map([first, second, shared].map((value) => [value.id, value]));
      const getAgent = jest.fn(async ({ id }: { id: string }) => saved.get(id) ?? agent(id));
      const snapshots = await getResumeAgentSnapshot({
        primaryAgent: primary,
        capabilities: ['subagent_graphs'],
        getAgent,
        canAccessAgent: async () => true,
      });
      const roots = shape === 'cycle' ? 3 : 4;
      expect(snapshots).toHaveLength(roots + MAX_SUBAGENT_GRAPH_NODES);
      expect(getAgent).toHaveBeenCalledTimes(roots - 1 + MAX_SUBAGENT_GRAPH_NODES);
      expect(new Set(getAgent.mock.calls.map(([{ id }]) => id)).size).toBe(
        getAgent.mock.calls.length,
      );
    },
  );

  it('ignores isolated child handoffs and legacy chains but expands its ordinary children', async () => {
    const primary = agent('primary');
    primary.subagents = { enabled: true, agent_ids: ['child'] };
    const child = agent('child');
    child.subagents = { enabled: true, agent_ids: ['leaf'] };
    child.agent_ids = ['unused-chain'];
    child.edges = [{ from: 'child', to: 'unused-handoff', edgeType: 'handoff' }];
    const saved = new Map([child, agent('leaf')].map((value) => [value.id, value]));
    const getAgent = jest.fn(async ({ id }: { id: string }) => saved.get(id) ?? null);
    const snapshots = await getResumeAgentSnapshot({
      primaryAgent: primary,
      getAgent,
      capabilities: ['subagents'],
    });
    expect(snapshots.map(({ id }) => id)).toEqual(['primary', 'child', 'leaf']);
    expect(getAgent.mock.calls.map(([{ id }]) => id)).toEqual(['child', 'leaf']);
  });

  it.each(['ordinary', 'handoff'])(
    'upgrades terminal members through an independent %s path in either root order',
    async (path) => {
      const graphRoot = agent('graph-root', teams(1));
      const other = agent('other');
      if (path === 'ordinary') other.subagents = { enabled: true, agent_ids: ['member-0'] };
      else other.edges = [{ from: 'other', to: 'member-0', edgeType: 'handoff' }];
      const member = agent('member-0');
      member.subagents = { enabled: true, agent_ids: ['leaf'] };
      member.edges = [{ from: 'member-0', to: 'unused', edgeType: 'handoff' }];
      const leaf = agent('leaf');
      leaf.subagents = { enabled: true, agent_ids: ['member-0'] };
      const saved = new Map([member, leaf, agent('unused')].map((value) => [value.id, value]));
      for (const roots of [
        [graphRoot, other],
        [other, graphRoot],
      ]) {
        const getAgent = jest.fn(async ({ id }: { id: string }) => saved.get(id) ?? null);
        const snapshots = await getResumeAgentSnapshot({
          primaryAgent: roots[0],
          additionalRoots: [roots[1]],
          getAgent,
          capabilities: ['subagents', 'subagent_graphs'],
        });
        expect(new Set(snapshots.map(({ id }) => id))).toEqual(
          new Set([
            'graph-root',
            'other',
            'member-0',
            'leaf',
            ...(path === 'handoff' ? ['unused'] : []),
          ]),
        );
        expect(getAgent).toHaveBeenCalledTimes(path === 'handoff' ? 3 : 2);
        expect(new Set(getAgent.mock.calls.map(([{ id }]) => id)).size).toBe(
          getAgent.mock.calls.length,
        );
      }
    },
  );

  it.each([MAX_SUBAGENT_GRAPH_NODES, MAX_SUBAGENT_GRAPH_NODES + 1])(
    'bounds handoff-chain reads at %s roots',
    async (count) => {
      const primary = agent('primary');
      primary.edges = [{ from: primary.id, to: 'root-0', edgeType: 'handoff' }];
      const getAgent = jest.fn(async ({ id }: { id: string }) => {
        const index = Number(id.slice(5));
        return {
          ...agent(id),
          edges:
            index + 1 < count
              ? [{ from: id, to: `root-${index + 1}`, edgeType: 'handoff' as const }]
              : [],
        };
      });
      const result = getResumeAgentSnapshot({ primaryAgent: primary, getAgent, capabilities: [] });
      if (count === MAX_SUBAGENT_GRAPH_NODES) await expect(result).resolves.toHaveLength(count + 1);
      else await expect(result).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
      expect(getAgent).toHaveBeenCalledTimes(MAX_SUBAGENT_GRAPH_NODES);
    },
  );

  it('rejects oversized root fan-out before scheduling reads', async () => {
    const primary = agent('primary');
    primary.edges = [
      {
        from: primary.id,
        to: Array.from({ length: MAX_SUBAGENT_GRAPH_NODES + 1 }, (_, index) => `root-${index}`),
        edgeType: 'handoff',
      },
    ];
    const getAgent = jest.fn(async ({ id }: { id: string }) => agent(id));
    await expect(
      getResumeAgentSnapshot({ primaryAgent: primary, getAgent, capabilities: [] }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    expect(getAgent).not.toHaveBeenCalled();
  });

  it.each(['missing', 'revoked', 'uninspectable'])(
    'fails closed on a required graph member already probed as an unavailable root: %s',
    async (state) => {
      const primary = agent('primary', teams(1));
      primary.edges = [{ from: primary.id, to: 'member-0', edgeType: 'handoff' }];
      const getAgent = jest.fn(async ({ id }: { id: string }) => {
        if (state === 'uninspectable') throw new Error('unavailable');
        return state === 'missing' ? null : agent(id);
      });
      await expect(
        getResumeAgentSnapshot({
          primaryAgent: primary,
          getAgent,
          capabilities: ['subagent_graphs'],
          canAccessAgent: async () => false,
        }),
      ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
      expect(getAgent).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps capability-disabled graph members out of the member phase', async () => {
    const primary = agent('primary', teams(MAX_SUBAGENT_GRAPH_NODES));
    primary.edges = [{ from: primary.id, to: 'handoff', edgeType: 'handoff' }];
    const getAgent = jest.fn(async ({ id }: { id: string }) => agent(id));
    const snapshots = await getResumeAgentSnapshot({
      primaryAgent: primary,
      getAgent,
      capabilities: ['subagents'],
    });
    expect(snapshots.map(({ id }) => id)).toEqual(['primary', 'handoff']);
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it.each(
    [48, 49].flatMap((graphCount) =>
      ['missing', 'revoked'].map((state) => ({ graphCount, state })),
    ),
  )(
    'does not charge unavailable ordinary targets near the admitted-member cap: %j',
    async ({ graphCount, state }) => {
      const primary = agent('primary', teams(graphCount));
      primary.subagents = { ...primary.subagents, enabled: true, agent_ids: ['child'] };
      const child = agent('child');
      child.subagents = { enabled: true, agent_ids: ['stale-0', 'stale-1', 'member-0'] };
      const shared = agent('member-0');
      shared.subagents = { enabled: true, agent_ids: ['child', 'stale-0'] };
      const getAgent = jest.fn(async ({ id }: { id: string }) => {
        if (id.startsWith('stale') && state === 'missing') return null;
        if (id === 'child') return child;
        if (id === 'member-0') return shared;
        return agent(id);
      });
      const snapshots = await getResumeAgentSnapshot({
        primaryAgent: primary,
        getAgent,
        capabilities: ['subagents', 'subagent_graphs'],
        canAccessAgent: async ({ id }) => !id.startsWith('stale'),
      });
      expect(snapshots).toHaveLength(graphCount + 2);
      expect(snapshots.some(({ id }) => id.startsWith('stale'))).toBe(false);
      expect(getAgent).toHaveBeenCalledTimes(graphCount + 3);
      expect(new Set(getAgent.mock.calls.map(([{ id }]) => id)).size).toBe(
        getAgent.mock.calls.length,
      );
    },
  );

  it('allows more read attempts than admissions across a bounded ordinary graph', async () => {
    const primary = agent('primary');
    const ids = Array.from({ length: 6 }, (_, index) => `child-${index}`);
    primary.subagents = { enabled: true, agent_ids: ids };
    const children = ids.map((id, index) => ({
      ...agent(id),
      subagents: {
        enabled: true,
        agent_ids: [
          ids[index === 0 ? 1 : 0],
          ...Array.from({ length: 9 }, (_, missing) => `stale-${index}-${missing}`),
        ],
      },
    }));
    const saved = new Map(children.map((child) => [child.id, child]));
    const getAgent = jest.fn(async ({ id }: { id: string }) => saved.get(id) ?? null);
    const snapshots = await getResumeAgentSnapshot({
      primaryAgent: primary,
      getAgent,
      capabilities: ['subagents'],
    });
    expect(new Set(snapshots.map(({ id }) => id))).toEqual(new Set(['primary', ...ids]));
    expect(getAgent).toHaveBeenCalledTimes(60);
    expect(new Set(getAgent.mock.calls.map(([{ id }]) => id)).size).toBe(60);
  });

  it.each(['missing', 'revoked'])(
    'keeps cached required graph members fail-closed after an optional ordinary miss: %s',
    async (state) => {
      const ordinary = agent('ordinary');
      ordinary.subagents = { enabled: true, agent_ids: ['member-0'] };
      const graphRoot = agent('graph', teams(1));
      for (const roots of [
        [ordinary, graphRoot],
        [graphRoot, ordinary],
      ]) {
        const getAgent = jest.fn(async ({ id }: { id: string }) =>
          state === 'missing' ? null : agent(id),
        );
        await expect(
          getResumeAgentSnapshot({
            primaryAgent: roots[0],
            additionalRoots: [roots[1]],
            getAgent,
            capabilities: ['subagents', 'subagent_graphs'],
            canAccessAgent: async () => false,
          }),
        ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
        expect(getAgent).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('rejects a 51st admitted member after skipping absent ordinary targets', async () => {
    const primary = agent('primary', teams(49));
    primary.subagents = { ...primary.subagents, enabled: true, agent_ids: ['child'] };
    const child = agent('child');
    child.subagents = { enabled: true, agent_ids: ['stale', 'extra'] };
    const getAgent = jest.fn(async ({ id }: { id: string }) => {
      if (id === 'stale') return null;
      return id === 'child' ? child : agent(id);
    });
    await expect(
      getResumeAgentSnapshot({
        primaryAgent: primary,
        getAgent,
        capabilities: ['subagents', 'subagent_graphs'],
      }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    expect(getAgent).toHaveBeenCalledWith({ id: 'extra' });
    expect(getAgent).toHaveBeenCalledTimes(52);
  });

  it('bounds read attempts by the existing per-agent unique-target ceiling', async () => {
    const primary = agent('primary');
    primary.subagents = {
      enabled: true,
      agent_ids: Array.from(
        { length: MAX_SUBAGENT_GRAPH_NODES + 1 },
        (_, index) => `stale-${index}`,
      ),
    };
    const getAgent = jest.fn(async () => null);
    await expect(
      getResumeAgentSnapshot({ primaryAgent: primary, getAgent, capabilities: ['subagents'] }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    expect(getAgent).not.toHaveBeenCalled();
  });

  it.each([0, 2])('rejects budget +1 even with %s additional roots', async (rootCount) => {
    const graphs = teams(MAX_SUBAGENT_GRAPH_NODES + 1);
    const getAgent = jest.fn(async ({ id }: { id: string }) => agent(id));
    await expect(
      getResumeAgentSnapshot({
        primaryAgent: agent('primary', graphs),
        additionalRoots: Array.from({ length: rootCount }, (_, index) =>
          agent(`root-${index}`, graphs),
        ),
        capabilities: ['subagent_graphs'],
        getAgent,
        canAccessAgent: async () => true,
      }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    expect(getAgent).not.toHaveBeenCalled();
  });

  it.each(['missing', 'revoked', 'unavailable'])(
    'fails closed when the last boundary member is %s',
    async (reason) => {
      const last = `member-${MAX_SUBAGENT_GRAPH_NODES - 1}`;
      const getAgent = jest.fn(async ({ id }: { id: string }) => {
        if (id === last && reason === 'unavailable') throw new Error('unavailable');
        return id === last && reason === 'missing' ? null : agent(id);
      });
      const canAccessAgent = jest.fn(async ({ id }: Agent) => id !== last || reason !== 'revoked');
      await expect(
        getResumeAgentSnapshot({
          primaryAgent: agent('primary', teams(MAX_SUBAGENT_GRAPH_NODES)),
          additionalRoots: [agent('additional')],
          capabilities: ['subagent_graphs'],
          getAgent,
          canAccessAgent,
        }),
      ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
      expect(getAgent).toHaveBeenCalledWith({ id: last });
      expect(getAgent).toHaveBeenCalledTimes(MAX_SUBAGENT_GRAPH_NODES);
      expect(canAccessAgent).toHaveBeenCalledTimes(
        MAX_SUBAGENT_GRAPH_NODES - (reason === 'revoked' ? 0 : 1),
      );
    },
  );
});
