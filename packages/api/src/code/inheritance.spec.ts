import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { agentSchema, createMethods } from '@librechat/data-schemas';
import {
  Tools,
  AgentCapabilities,
  MAX_SUBAGENT_GRAPH_NODES,
  resolveCodeWorkspaceInheritance,
} from 'librechat-data-provider';
import type {
  Agent,
  CodeWorkspaceSelection,
  CodeWorkspaceRoutingAgent,
} from 'librechat-data-provider';
import type { IAgent } from '@librechat/data-schemas';
import type { CodeWorkspaceInheritanceRoot, SubagentCodeRoutingAgent } from './inheritance';
import type { CodeEnvironmentConfig } from '~/agents/execution';
import { getSpawnableSubagentIds, resolveSubagentCodeWorkspaceInheritance } from './inheritance';
import { getResumeAgentSnapshot } from '../agents/hitl/inspection';
import { resolveCodeExecutionContext } from '~/agents/execution';

const SKYNET = 'code-yuwoQAAPhY1WMaDD6oIk';
const LIA_RAG = 'code-LTc54AG4yNobYdXzQg7g';
const LIA = 'agent_ZwXQuP527oibHg8S2qNV3';
const REVIEWER = 'agent_lOztazCW3rucC9f9K8kS7';

const environments: CodeEnvironmentConfig[] = [SKYNET, LIA_RAG].map((id) => ({
  id,
  name: id,
  type: 'attached',
  owner: 'deployment',
  baseURL: `https://${id}.example.com/v1`,
  workerId: `worker-${id}`,
}));

/** Lia and the PR Reviewer share these saved code settings on demo. */
const demoCodeSettings = {
  tools: [Tools.execute_code],
  stateful_code_sessions: true,
  stateful_code_environment: 'user' as const,
  code_environment_id: SKYNET,
  code_environment_ids: [LIA_RAG],
  code_workspace_id: '',
};

/** What an older client seals after the user picks Lia's machine: only Lia owns it. */
const incident: CodeWorkspaceSelection[] = [
  { environmentId: SKYNET, workspaceId: 'code-api' },
  { environmentId: LIA_RAG, workspaceId: 'agents', agentIds: [LIA] },
];

describe('resolveSubagentCodeWorkspaceInheritance', () => {
  let mongoServer: MongoMemoryServer;
  let methods: ReturnType<typeof createMethods>;
  const author = new mongoose.Types.ObjectId();
  const hidden = new Set<string>();

  const toRouting = (doc: IAgent): SubagentCodeRoutingAgent => ({
    id: doc.id,
    tools: doc.tools,
    stateful_code_sessions: doc.stateful_code_sessions,
    code_environment_id: doc.code_environment_id,
    code_environment_ids: doc.code_environment_ids,
    subagents: doc.subagents,
  });

  const loadSubagent = jest.fn(async (agentId: string) => {
    if (hidden.has(agentId)) return null;
    const doc = await methods.getAgentWithVersionCount({ id: agentId });
    return doc == null ? null : toRouting(doc);
  });

  async function seed(
    id: string,
    overrides: Partial<Omit<IAgent, 'id'>> = {},
  ): Promise<SubagentCodeRoutingAgent> {
    return toRouting(
      await methods.createAgent({
        id,
        name: id,
        provider: 'openai',
        model: 'gpt-4.1',
        author,
        ...demoCodeSettings,
        ...overrides,
      }),
    );
  }

  function root(
    agent: SubagentCodeRoutingAgent,
    environmentId = LIA_RAG,
  ): CodeWorkspaceInheritanceRoot {
    return {
      id: agent.id,
      subagents: agent.subagents,
      statefulCodeSessions: true,
      codeExecutionContext: { environmentId, environmentType: 'attached' },
    };
  }

  function routeOf(
    agent: SubagentCodeRoutingAgent,
    selections: CodeWorkspaceSelection[],
    inheritedEnvironments?: ReadonlyMap<string, string>,
    configuredEnvironments: CodeEnvironmentConfig[] = environments,
  ): string | undefined {
    return resolveCodeExecutionContext({
      statefulSessions: true,
      environmentId: agent.code_environment_id,
      environmentIds: agent.code_environment_ids,
      environments: configuredEnvironments,
      allowEnvironmentSelection: true,
      workspaceSelections: selections,
      inheritedEnvironments,
      userId: 'user-1',
      agentId: agent.id,
      conversationId: 'chat-1',
    }).environmentId;
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    if (!mongoose.models.Agent) mongoose.model('Agent', agentSchema);
    await mongoose.connect(mongoServer.getUri());
    methods = createMethods(mongoose);
  }, 20000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.models.Agent.deleteMany({});
    hidden.clear();
    loadSubagent.mockClear();
  });

  it.each([false, true])(
    'ignores isolated child handoffs while retaining nested spawn inheritance, reverse=%s',
    async (reverse) => {
      const child = 'child';
      const leaf = 'leaf';
      const lia = await seed(LIA, {
        subagents: { enabled: true, agent_ids: reverse ? [REVIEWER, child] : [child, REVIEWER] },
      });
      await seed(child, {
        edges: [{ from: child, to: REVIEWER, edgeType: 'handoff' }],
        subagents: { enabled: true, agent_ids: [leaf] },
      });
      await seed(leaf);
      const reviewer = await seed(REVIEWER);
      const inherited = await resolveSubagentCodeWorkspaceInheritance({
        selections: incident,
        roots: [root(lia)],
        loadSubagent,
        environments,
        allowEnvironmentSelection: true,
        codeExecutionAvailable: true,
      });
      expect(inherited.get(REVIEWER)).toBe(LIA_RAG);
      expect(inherited.get(leaf)).toBe(LIA_RAG);
      expect(routeOf(reviewer, incident, inherited)).toBe(LIA_RAG);
      expect(new Set(loadSubagent.mock.calls.map(([id]) => id))).toEqual(
        new Set([child, leaf, REVIEWER]),
      );
      expect(loadSubagent).toHaveBeenCalledTimes(3);
    },
  );

  it("reproduces the PR Reviewer incident and routes the reviewer to Lia's workspace", async () => {
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    const reviewer = await seed(REVIEWER);
    expect(routeOf(reviewer, incident)).toBe(SKYNET);

    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });

    expect(inheritance).toEqual(new Map([[REVIEWER, LIA_RAG]]));
    expect(routeOf(reviewer, incident, inheritance)).toBe(LIA_RAG);
    expect(loadSubagent).toHaveBeenCalledTimes(1);
  });

  it('derives the same routes on every replay without touching the sealed decision', async () => {
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    await seed(REVIEWER);
    const sealed = structuredClone(incident);
    const resolve = () =>
      resolveSubagentCodeWorkspaceInheritance({
        selections: sealed,
        roots: [root(lia)],
        loadSubagent,
        environments,
        allowEnvironmentSelection: true,
        codeExecutionAvailable: true,
      });
    expect(await resolve()).toEqual(await resolve());
    expect(sealed).toEqual(incident);
  });

  it("keeps a child on its own default when it may not use the parent's machine", async () => {
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    const reviewer = await seed(REVIEWER, { code_environment_ids: [] });
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(inheritance.size).toBe(0);
    expect(routeOf(reviewer, incident, inheritance)).toBe(SKYNET);
  });

  it('keeps per-chat choice off when the deployment ceiling disables it', async () => {
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    await seed(REVIEWER);
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: false,
      codeExecutionAvailable: true,
    });
    expect(inheritance.size).toBe(0);
  });

  it("does not inherit a machine outside the principal's environment ACL", async () => {
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    await seed(REVIEWER);
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments: environments.filter(({ id }) => id !== LIA_RAG),
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(inheritance.size).toBe(0);
  });

  it('lets an explicit assignment for the child win', async () => {
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    const reviewer = await seed(REVIEWER);
    const explicit = [{ ...incident[0], agentIds: [REVIEWER] }, incident[1]];
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: explicit,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(inheritance.size).toBe(0);
    expect(routeOf(reviewer, explicit, inheritance)).toBe(SKYNET);
  });

  it('never walks through a subagent the principal cannot view', async () => {
    const middle = 'agent_hidden_planner';
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [middle] } });
    await seed(middle, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    await seed(REVIEWER);
    hidden.add(middle);
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(inheritance.size).toBe(0);
    expect(loadSubagent).not.toHaveBeenCalledWith(REVIEWER);
  });

  it('follows nested subagents and ignores disabled subagent lists', async () => {
    const verifier = 'agent_finding_verifier';
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    await seed(REVIEWER, { subagents: { enabled: true, agent_ids: [verifier] } });
    await seed(verifier);
    const nested = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(nested).toEqual(
      new Map([
        [REVIEWER, LIA_RAG],
        [verifier, LIA_RAG],
      ]),
    );

    const disabled = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [{ ...root(lia), subagents: { enabled: false, agent_ids: [REVIEWER] } }],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(disabled.size).toBe(0);
  });

  it('routes the members of a spawned subagent graph with their parent', async () => {
    const verifier = 'agent_finding_verifier';
    const lia = await seed(LIA, {
      subagents: {
        enabled: true,
        graphs: [
          {
            type: 'review-team',
            name: 'Review team',
            description: 'Reviews and verifies findings',
            agent_ids: [REVIEWER, verifier],
            edges: [],
            entry_agent_id: REVIEWER,
            result_agent_id: verifier,
          },
        ],
      },
    });
    await seed(REVIEWER);
    await seed(verifier);
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(inheritance).toEqual(
      new Map([
        [REVIEWER, LIA_RAG],
        [verifier, LIA_RAG],
      ]),
    );
  });

  it.each([false, true])(
    'keeps graph members terminal unless upgraded by an ordinary path, upgrade=%s',
    async (upgrade) => {
      const graph = {
        type: 'team',
        name: 'Team',
        description: 'Work',
        agent_ids: [REVIEWER],
        edges: [],
        entry_agent_id: REVIEWER,
        result_agent_id: REVIEWER,
      };
      const lia = await seed(LIA, {
        subagents: { enabled: false, graphsEnabled: true, graphs: [graph] },
      });
      await seed('middle', { subagents: { enabled: true, agent_ids: [REVIEWER] } });
      const ordinary = await seed('ordinary', {
        subagents: { enabled: true, agent_ids: ['middle'] },
      });
      await seed(REVIEWER, { subagents: { enabled: true, agent_ids: ['leaf'] } });
      await seed('leaf');
      for (const roots of [
        [root(lia), root(ordinary)],
        [root(ordinary), root(lia)],
      ]) {
        loadSubagent.mockClear();
        const inheritance = await resolveSubagentCodeWorkspaceInheritance({
          selections: [{ environmentId: LIA_RAG, workspaceId: 'agents' }],
          roots: upgrade ? roots : [root(lia)],
          loadSubagent,
          environments,
          allowEnvironmentSelection: true,
          codeExecutionAvailable: true,
          capabilities: [AgentCapabilities.subagents, AgentCapabilities.subagent_graphs],
        });
        expect(inheritance.get(REVIEWER)).toBe(LIA_RAG);
        expect(inheritance.has('leaf')).toBe(upgrade);
        expect(loadSubagent.mock.calls.filter(([id]) => id === REVIEWER)).toHaveLength(1);
        expect(loadSubagent).toHaveBeenCalledTimes(upgrade ? 3 : 1);
      }
    },
  );

  it('projects loaded descendants before a disabled graph can create conflicting parent routes', async () => {
    const middleId = 'agent_fixed_planner';
    const childMachine = 'code-child-machine';
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [middleId, REVIEWER] } });
    await seed(middleId, {
      code_environment_id: SKYNET,
      code_environment_ids: [],
      subagents: {
        enabled: false,
        graphsEnabled: true,
        graphs: [
          {
            type: 'disabled-team',
            name: 'Disabled',
            description: 'Work',
            agent_ids: [REVIEWER],
            edges: [],
            entry_agent_id: REVIEWER,
            result_agent_id: REVIEWER,
          },
        ],
      },
    });
    const reviewer = await seed(REVIEWER, {
      code_environment_id: childMachine,
      code_environment_ids: [SKYNET, LIA_RAG],
    });
    const configured = [...environments, { ...environments[0], id: childMachine }];
    const selection = [{ environmentId: LIA_RAG, workspaceId: 'agents', agentIds: [LIA] }];
    const storedMiddle = await methods.getAgentWithVersionCount({ id: middleId });
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: selection,
      roots: [root(lia)],
      loadSubagent,
      environments: configured,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
      capabilities: [AgentCapabilities.subagents],
    });
    expect(inheritance.get(REVIEWER)).toBe(LIA_RAG);
    expect(inheritance.has(middleId)).toBe(false);
    expect(loadSubagent).toHaveBeenCalledTimes(2);
    expect((await methods.getAgentWithVersionCount({ id: middleId }))?.subagents).toEqual(
      storedMiddle?.subagents,
    );
    expect(
      resolveCodeExecutionContext({
        statefulSessions: true,
        environmentId: reviewer.code_environment_id,
        environmentIds: reviewer.code_environment_ids,
        environments: configured,
        allowEnvironmentSelection: true,
        workspaceSelections: selection,
        inheritedEnvironments: inheritance,
        userId: 'user-1',
        agentId: REVIEWER,
        conversationId: 'chat-1',
      }).environmentId,
    ).toBe(LIA_RAG);
  });

  it.each([false, true])(
    'applies the graph capability to stored-only descendants, enabled=%s',
    async (graphCapability) => {
      const leaf = 'agent_graph_only_leaf';
      const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
      await seed(REVIEWER, {
        subagents: {
          enabled: false,
          graphsEnabled: true,
          agent_ids: ['disabled-single'],
          graphs: [
            {
              type: 'nested-team',
              name: 'Nested',
              description: 'Work',
              agent_ids: [leaf],
              edges: [],
              entry_agent_id: leaf,
              result_agent_id: leaf,
            },
          ],
        },
      });
      await seed(leaf);
      const inheritance = await resolveSubagentCodeWorkspaceInheritance({
        selections: incident,
        roots: [root(lia)],
        loadSubagent,
        environments,
        allowEnvironmentSelection: true,
        codeExecutionAvailable: true,
        capabilities: graphCapability
          ? [AgentCapabilities.subagents, AgentCapabilities.subagent_graphs]
          : [AgentCapabilities.subagents],
      });
      expect(inheritance.get(REVIEWER)).toBe(LIA_RAG);
      expect(inheritance.has(leaf)).toBe(graphCapability);
      expect(loadSubagent).not.toHaveBeenCalledWith('disabled-single');
      expect(loadSubagent.mock.calls.map(([id]) => id)).toEqual(
        graphCapability ? [REVIEWER, leaf] : [REVIEWER],
      );
    },
  );

  it('does not load ordinary or legacy targets under the graph capability alone', async () => {
    const lia = await seed(LIA, {
      subagents: {
        enabled: true,
        agent_ids: [REVIEWER],
        graphs: [
          {
            type: 'legacy-team',
            name: 'Legacy',
            description: 'Work',
            agent_ids: [REVIEWER],
            edges: [],
            entry_agent_id: REVIEWER,
            result_agent_id: REVIEWER,
          },
        ],
      },
    });
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
      capabilities: [AgentCapabilities.subagent_graphs],
    });
    expect(inheritance.size).toBe(0);
    expect(loadSubagent).not.toHaveBeenCalled();
    expect(
      getSpawnableSubagentIds({ ...lia, subagents: { ...lia.subagents, graphsEnabled: true } }, [
        AgentCapabilities.subagent_graphs,
      ]),
    ).toEqual([REVIEWER]);
  });

  async function seedBudgetGraph(count: number, ordinaryFirst = false, lateAdmission = false) {
    const fixedId = 'agent_fixed_cap';
    const thirdMachine = 'code-third-cap';
    const missing = Array.from({ length: 7 }, (_, index) => `missing-cap-${index}`);
    const ids = [
      'bridge-cap',
      'middle-cap',
      fixedId,
      REVIEWER,
      ...Array.from({ length: count - 4 }, (_, index) => `filler-cap-${index}`),
    ];
    const saved = await Promise.all(
      ids.map((id) =>
        seed(id, {
          ...(id === fixedId ? { code_environment_ids: [] } : {}),
          ...(id === REVIEWER
            ? { code_environment_id: thirdMachine, code_environment_ids: [SKYNET, LIA_RAG] }
            : {}),
          ...(id === 'bridge-cap'
            ? {
                subagents: {
                  enabled: true,
                  agent_ids: lateAdmission ? ['late-cap', ...missing, fixedId] : ['middle-cap'],
                },
              }
            : {}),
          ...(id === 'middle-cap' ? { subagents: { enabled: true, agent_ids: [fixedId] } } : {}),
          ...(id === fixedId ? { subagents: { enabled: true, agent_ids: [REVIEWER] } } : {}),
          ...(id === REVIEWER ? { subagents: { enabled: true, agent_ids: [fixedId] } } : {}),
        }),
      ),
    );
    if (lateAdmission) saved.push(await seed('late-cap'));
    const graphIds = ids.slice(1);
    const graphs = [0, 25].map((start) => {
      const members = graphIds.slice(start, start + 25);
      return {
        type: `cap-team-${start}`,
        name: 'Team',
        description: 'Work',
        agent_ids: members,
        entry_agent_id: members[0],
        result_agent_id: members[members.length - 1],
        edges: members
          .slice(1)
          .map((id, index) => ({ from: members[index], to: id, edgeType: 'direct' as const })),
      };
    });
    const lia = await seed(LIA, {
      subagents: {
        enabled: true,
        graphsEnabled: true,
        agent_ids: ordinaryFirst ? [fixedId, 'bridge-cap'] : ['bridge-cap'],
        graphs,
      },
    });
    const configured = [...environments, { ...environments[0], id: thirdMachine }];
    const selections = configured.map(({ id }) => ({ environmentId: id, workspaceId: 'project' }));
    const nodes = new Map<string, CodeWorkspaceRoutingAgent>(
      saved.map((agent) => [
        agent.id,
        {
          id: agent.id,
          routesCode: true,
          environmentId: agent.code_environment_id,
          environmentIds: agent.code_environment_ids,
          allowSelection: Boolean(agent.code_environment_ids?.length),
          subagentIds: getSpawnableSubagentIds(agent),
        },
      ]),
    );
    nodes.set(LIA, {
      id: LIA,
      routesCode: true,
      resolvedEnvironmentId: LIA_RAG,
      allowSelection: false,
      subagentIds: getSpawnableSubagentIds(lia),
    });
    const expected = resolveCodeWorkspaceInheritance({
      selections,
      rootIds: [LIA],
      agents: nodes,
      isAttachedEnvironment: (id) => configured.some((environment) => environment.id === id),
    });
    const reviewer = saved.find(({ id }) => id === REVIEWER);
    if (!reviewer) throw new Error('Missing reviewer fixture');
    return { lia, reviewer, configured, selections, expected, thirdMachine, missing };
  }

  it.each(
    [49, 50].flatMap((count) => [false, true].map((ordinaryFirst) => ({ count, ordinaryFirst }))),
  )(
    'keeps final routing parity after cached deep upgrades at the cap: %j',
    async ({ count, ordinaryFirst }) => {
      const fixture = await seedBudgetGraph(count, ordinaryFirst);
      const inherited = await resolveSubagentCodeWorkspaceInheritance({
        selections: fixture.selections,
        roots: [root(fixture.lia)],
        loadSubagent,
        environments: fixture.configured,
        allowEnvironmentSelection: true,
        codeExecutionAvailable: true,
      });
      expect(inherited).toEqual(fixture.expected);
      expect(inherited.has(REVIEWER)).toBe(false);
      expect(routeOf(fixture.reviewer, fixture.selections, inherited, fixture.configured)).toBe(
        fixture.thirdMachine,
      );
      expect(loadSubagent).toHaveBeenCalledTimes(count);
      expect(new Set(loadSubagent.mock.calls.map(([id]) => id)).size).toBe(count);
    },
  );

  it('drains cached upgrades after the last admission batch without repeating or widening reads', async () => {
    const fixture = await seedBudgetGraph(MAX_SUBAGENT_GRAPH_NODES - 1, false, true);
    const inherited = await resolveSubagentCodeWorkspaceInheritance({
      selections: fixture.selections,
      roots: [root(fixture.lia)],
      loadSubagent,
      environments: fixture.configured,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(inherited).toEqual(fixture.expected);
    expect(routeOf(fixture.reviewer, fixture.selections, inherited, fixture.configured)).toBe(
      fixture.thirdMachine,
    );
    expect(loadSubagent).toHaveBeenCalledTimes(MAX_SUBAGENT_GRAPH_NODES + fixture.missing.length);
    expect(new Set(loadSubagent.mock.calls.map(([id]) => id)).size).toBe(
      loadSubagent.mock.calls.length,
    );
  });

  it.each([false, true])(
    'matches runtime admission when an ordinary target is unavailable, revoked=%s',
    async (revoked) => {
      const ids = Array.from(
        { length: MAX_SUBAGENT_GRAPH_NODES - 1 },
        (_, index) => `member-c19-${index}`,
      );
      const graphs = [0, 25].map((start) => {
        const members = ids.slice(start, start + 25);
        return {
          type: `team-c19-${start}`,
          name: 'Team',
          description: 'Work',
          agent_ids: members,
          entry_agent_id: members[0],
          result_agent_id: members[members.length - 1],
          edges: members
            .slice(1)
            .map((id, index) => ({ from: members[index], to: id, edgeType: 'direct' as const })),
        };
      });
      const lia = await seed(LIA, {
        subagents: { enabled: true, graphsEnabled: true, agent_ids: ['child-c19'], graphs },
      });
      await Promise.all(ids.map((id) => seed(id)));
      await seed('child-c19', { subagents: { enabled: true, agent_ids: ['stale-c19'] } });
      if (revoked) {
        await seed('stale-c19');
        hidden.add('stale-c19');
      }
      const planned = await resolveSubagentCodeWorkspaceInheritance({
        selections: incident,
        roots: [root(lia)],
        loadSubagent,
        environments,
        allowEnvironmentSelection: true,
        codeExecutionAvailable: true,
      });
      const snapshot = (doc: IAgent): Agent => ({
        id: doc.id,
        name: doc.name ?? null,
        description: doc.description ?? null,
        avatar: null,
        created_at: 0,
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
        subagents: doc.subagents,
        edges: doc.edges,
        agent_ids: doc.agent_ids,
      });
      const primary = await methods.getAgentWithVersionCount({ id: LIA });
      if (!primary) throw new Error('Missing primary fixture');
      const getAgent = jest.fn(async ({ id }: { id: string }) => {
        const doc = await methods.getAgentWithVersionCount({ id });
        return doc ? snapshot(doc) : null;
      });
      const inspected = await getResumeAgentSnapshot({
        primaryAgent: snapshot(primary),
        getAgent,
        capabilities: [AgentCapabilities.subagents, AgentCapabilities.subagent_graphs],
        canAccessAgent: async ({ id }) => !hidden.has(id),
      });
      expect(planned.size).toBe(MAX_SUBAGENT_GRAPH_NODES);
      expect(new Set(inspected.filter(({ id }) => id !== LIA).map(({ id }) => id))).toEqual(
        new Set(planned.keys()),
      );
      expect(getAgent).toHaveBeenCalledTimes(MAX_SUBAGENT_GRAPH_NODES + 1);
      expect(new Set(getAgent.mock.calls.map(([{ id }]) => id)).size).toBe(
        getAgent.mock.calls.length,
      );
    },
  );

  it('counts only admitted subagents toward the node limit', async () => {
    const verifier = 'agent_finding_verifier';
    const stale = Array.from({ length: 49 }, (_, index) => `agent_deleted_${index}`);
    const lia = await seed(LIA, {
      subagents: { enabled: true, agent_ids: [...stale, REVIEWER] },
    });
    await seed(REVIEWER, { subagents: { enabled: true, agent_ids: [verifier] } });
    await seed(verifier);
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(inheritance.get(verifier)).toBe(LIA_RAG);
  });

  it('never re-routes a saved agent that is also a parallel root', async () => {
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    const reviewer = await seed(REVIEWER);
    const inheritance = await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [root(lia), root({ ...reviewer, id: `${REVIEWER}____1` }, SKYNET)],
      loadSubagent,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(inheritance.has(REVIEWER)).toBe(false);
    expect(loadSubagent).not.toHaveBeenCalled();
  });

  it('reads nothing past the node limit', async () => {
    const children = Array.from(
      { length: MAX_SUBAGENT_GRAPH_NODES + 1 },
      (_, index) => `agent_child_${index}`,
    );
    const load = jest.fn(
      async (agentId: string): Promise<SubagentCodeRoutingAgent> => ({
        id: agentId,
        ...demoCodeSettings,
        subagents: { enabled: true, agent_ids: [`${agentId}_leaf`] },
      }),
    );
    await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [
        {
          id: LIA,
          subagents: { enabled: true, agent_ids: children },
          statefulCodeSessions: true,
          codeExecutionContext: { environmentId: LIA_RAG, environmentType: 'attached' },
        },
      ],
      loadSubagent: load,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(load).toHaveBeenCalledTimes(MAX_SUBAGENT_GRAPH_NODES);
    expect(load).not.toHaveBeenCalledWith(children[MAX_SUBAGENT_GRAPH_NODES]);
  });

  it('keeps loading missing subagents in parallel batches near the node limit', async () => {
    const admittedIds = Array.from({ length: 49 }, (_, index) => `agent_child_${index}`);
    const missing = Array.from({ length: 40 }, (_, index) => `agent_missing_${index}`);
    let inFlight = 0;
    let peak = 0;
    const load = jest.fn(async (agentId: string): Promise<SubagentCodeRoutingAgent | null> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight--;
      if (agentId.startsWith('agent_missing_')) return null;
      return {
        id: agentId,
        ...demoCodeSettings,
        subagents: agentId === admittedIds[0] ? { enabled: true, agent_ids: missing } : undefined,
      };
    });
    await resolveSubagentCodeWorkspaceInheritance({
      selections: incident,
      roots: [
        {
          id: LIA,
          subagents: { enabled: true, agent_ids: admittedIds },
          statefulCodeSessions: true,
          codeExecutionContext: { environmentId: LIA_RAG, environmentType: 'attached' },
        },
      ],
      loadSubagent: load,
      environments,
      allowEnvironmentSelection: true,
      codeExecutionAvailable: true,
    });
    expect(load).toHaveBeenCalledTimes(admittedIds.length + missing.length);
    expect(peak).toBeGreaterThan(1);
  });

  it('reads nothing when the run cannot use stateful code or holds no selection', async () => {
    const lia = await seed(LIA, { subagents: { enabled: true, agent_ids: [REVIEWER] } });
    for (const [selections, codeExecutionAvailable] of [
      [incident, false],
      [[], true],
      [undefined, true],
    ] as const) {
      expect(
        (
          await resolveSubagentCodeWorkspaceInheritance({
            selections,
            roots: [root(lia)],
            loadSubagent,
            environments,
            allowEnvironmentSelection: true,
            codeExecutionAvailable,
          })
        ).size,
      ).toBe(0);
    }
    expect(loadSubagent).not.toHaveBeenCalled();
  });
});
