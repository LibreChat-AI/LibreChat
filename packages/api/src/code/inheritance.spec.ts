import mongoose from 'mongoose';
import { Tools } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { agentSchema, createMethods } from '@librechat/data-schemas';
import type { CodeWorkspaceSelection } from 'librechat-data-provider';
import type { IAgent } from '@librechat/data-schemas';
import type { CodeWorkspaceInheritanceRoot, SubagentCodeRoutingAgent } from './inheritance';
import type { CodeEnvironmentConfig } from '~/agents/execution';
import { resolveSubagentCodeWorkspaceInheritance } from './inheritance';
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
  ): string | undefined {
    return resolveCodeExecutionContext({
      statefulSessions: true,
      environmentId: agent.code_environment_id,
      environmentIds: agent.code_environment_ids,
      environments,
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
    const children = Array.from({ length: 50 }, (_, index) => `agent_child_${index}`);
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
    expect(load).toHaveBeenCalledTimes(50);
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
