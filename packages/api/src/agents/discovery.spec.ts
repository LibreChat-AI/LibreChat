import { ErrorTypes, EModelEndpoint, MAX_SUBAGENT_GRAPH_NODES } from 'librechat-data-provider';
import type { Agent, GraphEdge } from 'librechat-data-provider';
import type { Response } from 'express';
import type { GraphSubagentHostConfig } from './discovery';
import type { InitializedAgent } from './initialize';
import type { ServerRequest } from '~/types';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockInitializeAgent = jest.fn();
jest.mock('./initialize', () => ({
  initializeAgent: (...args: unknown[]) => mockInitializeAgent(...args),
}));

const mockValidateAgentModel = jest.fn();
jest.mock('./validation', () => ({
  validateAgentModel: (...args: unknown[]) => mockValidateAgentModel(...args),
}));

import { discoverConnectedAgents, resolveSubagentGraphs } from './discovery';

const makeReq = (userId = 'u1', role = 'USER'): ServerRequest =>
  ({
    user: { id: userId, role },
  }) as unknown as ServerRequest;

const makeRes = (): Response => ({}) as unknown as Response;

const makeAgent = (id: string, edges: GraphEdge[] = []): Agent =>
  ({
    id,
    _id: `mongo-${id}`,
    provider: 'openai',
    model: 'gpt-4o',
    edges,
  }) as unknown as Agent;

const makeConfig = (id: string, edges: GraphEdge[] = []): InitializedAgent =>
  ({
    id,
    provider: 'openai',
    model: 'gpt-4o',
    edges,
    tools: [],
  }) as unknown as InitializedAgent;

describe('discoverConnectedAgents', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateAgentModel.mockResolvedValue({ isValid: true });
    mockInitializeAgent.mockImplementation(async ({ agent }: { agent: Agent }) =>
      makeConfig(agent.id),
    );
  });

  it('returns empty configs and no edges for a single agent with no edges', async () => {
    const primaryConfig = makeConfig('A');
    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent: jest.fn(),
        checkPermission: jest.fn(),
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.agentConfigs.size).toBe(0);
    expect(result.edges).toEqual([]);
    expect(result.skippedAgentIds.size).toBe(0);
  });

  it('discovers handoff targets via BFS across a multi-hop chain A -> B -> C', async () => {
    const edgesAB: GraphEdge[] = [{ from: 'A', to: 'B', edgeType: 'handoff' }];
    const edgesBC: GraphEdge[] = [{ from: 'B', to: 'C', edgeType: 'handoff' }];
    const primaryConfig = makeConfig('A', edgesAB);

    const agents: Record<string, Agent> = {
      B: makeAgent('B', edgesBC),
      C: makeAgent('C', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agents[id] ?? null);
    const checkPermission = jest.fn().mockResolvedValue(true);

    const onAgentInitialized = jest.fn();

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
        onAgentInitialized,
      },
    );

    expect(getAgent).toHaveBeenCalledWith({ id: 'B' });
    expect(getAgent).toHaveBeenCalledWith({ id: 'C' });
    expect(result.agentConfigs.size).toBe(2);
    expect(result.agentConfigs.has('B')).toBe(true);
    expect(result.agentConfigs.has('C')).toBe(true);
    expect(result.edges).toHaveLength(2);
    expect(onAgentInitialized).toHaveBeenCalledTimes(2);
    expect(onAgentInitialized.mock.calls.map((c) => c[0])).toEqual(['B', 'C']);
  });

  it('skips orphaned agents and filters out edges pointing at them', async () => {
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'A', to: 'MISSING', edgeType: 'handoff' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const getAgent = jest.fn(async ({ id }: { id: string }) =>
      id === 'B' ? makeAgent('B', []) : null,
    );
    const checkPermission = jest.fn().mockResolvedValue(true);
    const onAgentSkipped = jest.fn();

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
        onAgentSkipped,
      },
    );

    expect(result.agentConfigs.has('B')).toBe(true);
    expect(result.agentConfigs.has('MISSING')).toBe(false);
    expect(result.skippedAgentIds.has('MISSING')).toBe(true);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to).toBe('B');
    expect(onAgentSkipped).toHaveBeenCalledWith('MISSING');
  });

  it('skips sub-agents the user lacks VIEW permission on and filters their edges', async () => {
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'A', to: 'FORBIDDEN', edgeType: 'handoff' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      FORBIDDEN: makeAgent('FORBIDDEN', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    const checkPermission = jest.fn(
      async ({ resourceId }: { resourceId: unknown }) => resourceId !== 'mongo-FORBIDDEN',
    );

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.agentConfigs.has('B')).toBe(true);
    expect(result.agentConfigs.has('FORBIDDEN')).toBe(false);
    expect(result.skippedAgentIds.has('FORBIDDEN')).toBe(true);
    expect(result.edges.map((e) => e.to)).toEqual(['B']);
  });

  it('forces `endpoint: agents` on sub-agent init so allowedProviders is always enforced', async () => {
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);

    await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        // Caller passes a non-agents endpoint (e.g. the OpenAI-compat
        // controllers do this — endpoint = primary provider)
        endpointOption: { endpoint: EModelEndpoint.openAI, model_parameters: {} },
        allowedProviders: new Set(['openai']),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    // The helper must override `endpoint` to 'agents' so
    // `isAgentsEndpoint` is true and the allowedProviders guard in
    // `initializeAgent` actually runs for sub-agents.
    expect(mockInitializeAgent).toHaveBeenCalled();
    const initArgs = mockInitializeAgent.mock.calls[0][0];
    expect(initArgs.endpointOption.endpoint).toBe(EModelEndpoint.agents);
  });

  it('forwards codeEnvAvailable to every handoff initializeAgent call', async () => {
    /* Pre-Phase 8, a handoff sub-agent with `tools: ['execute_code']`
       got `CodeExecutionToolDefinition` registered unconditionally via
       the legacy registry path. Phase 8 replaced that with a
       `params.codeEnvAvailable`-gated expansion inside `initializeAgent`;
       if discovery forgets to forward the primary's capability flag,
       handoff agents lose `bash_tool` + `read_file` even though the
       primary had them. Pin the pass-through so regressions surface. */
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);

    await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        codeEnvAvailable: true,
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ codeEnvAvailable: true }),
      expect.anything(),
    );
  });

  /** A handoff agent re-hydrates the same conversation's prior-turn files, so
   *  it has to prime them on exactly the terms its parent did — forgetting this
   *  gives a denied role its search files back one hop later. */
  it.each([true, false, undefined])(
    'forwards fileSearchAvailable=%s verbatim to every handoff initializeAgent call',
    async (fileSearchAvailable) => {
      const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
      const getAgent = jest.fn(async () => makeAgent('B', []));
      const checkPermission = jest.fn().mockResolvedValue(true);

      await discoverConnectedAgents(
        {
          req: makeReq(),
          res: makeRes(),
          primaryConfig,
          allowedProviders: new Set(),
          modelsConfig: { openai: ['gpt-4o'] },
          loadTools: jest.fn(),
          fileSearchAvailable,
        },
        {
          getAgent,
          checkPermission,
          logViolation: jest.fn(),
          db: {} as never,
        },
      );

      expect(mockInitializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fileSearchAvailable }),
        expect.anything(),
      );
    },
  );

  /** A handoff agent's provider config can turn native web search on as well, so
   *  dropping the resolver here would leave it ungated one hop later. */
  it('forwards resolveWebSearchGrant to every handoff initializeAgent call', async () => {
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    const getAgent = jest.fn(async () => makeAgent('B', []));
    const resolveWebSearchGrant = jest.fn().mockResolvedValue(false);

    await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        resolveWebSearchGrant,
      },
      {
        getAgent,
        checkPermission: jest.fn().mockResolvedValue(true),
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ resolveWebSearchGrant }),
      expect.anything(),
    );
  });

  it('forwards normalized request metadata to every handoff initializeAgent call', async () => {
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);
    const requestBody = {
      messageId: 'message-1',
      conversationId: 'conversation-1',
      parentMessageId: 'parent-1',
    };

    await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        requestBody,
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody }),
      expect.anything(),
    );
  });

  it('forwards codeEnvAvailable=false verbatim so handoff agents respect disabled capability', async () => {
    /* Symmetric to the "true" case: when the primary resolved
       `codeEnvAvailable = false`, handoffs must NOT accidentally
       re-enable code execution. The passthrough must preserve `false`
       distinctly from `undefined`. */
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);

    await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        codeEnvAvailable: false,
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ codeEnvAvailable: false }),
      expect.anything(),
    );
  });

  it('passes the configured resourceType (e.g. REMOTE_AGENT) to checkPermission', async () => {
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);

    await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        resourceType: 'REMOTE_AGENT',
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(checkPermission).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'REMOTE_AGENT' }),
    );
  });

  it('prunes sub-agents disconnected from the primary after edge filtering', async () => {
    // Graph: primary A has edges [A->B, B->C] stored directly on A.
    // BFS loads B and C before permission is checked. B is skipped, and
    // both edges reference B so they are filtered out. C was initialized
    // but is now unreachable from A through any surviving edge — it must
    // NOT be returned (otherwise it becomes a stray start node when
    // createRun sees `agents.length > 1`).
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'B', to: 'C', edgeType: 'handoff' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    // B fails permission, C passes.
    const checkPermission = jest.fn(
      async ({ resourceId }: { resourceId: unknown }) => resourceId !== 'mongo-B',
    );

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.skippedAgentIds.has('B')).toBe(true);
    expect(result.edges).toHaveLength(0);
    // C is unreachable once B's edges are filtered → must be pruned.
    expect(result.agentConfigs.has('C')).toBe(false);
    expect(result.agentConfigs.size).toBe(0);
  });

  it('preserves valid routes when one co-source of a multi-source edge is skipped', async () => {
    // Primary A has edge `{ from: ['A','B'], to: 'C' }`, but B lacks
    // VIEW permission. The SDK treats each source independently, so the
    // `A -> C` route is still valid. Discovery must strip B from the
    // edge's sources rather than dropping the whole edge.
    const edges: GraphEdge[] = [{ from: ['A', 'B'], to: 'C', edgeType: 'handoff' }];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    // Only B is forbidden.
    const checkPermission = jest.fn(
      async ({ resourceId }: { resourceId: unknown }) => resourceId !== 'mongo-B',
    );

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.skippedAgentIds.has('B')).toBe(true);
    expect(result.agentConfigs.has('C')).toBe(true);
    expect(result.agentConfigs.has('B')).toBe(false);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toEqual(['A']);
    expect(result.edges[0].to).toBe('C');
  });

  it('reduces a multi-source barrier to its surviving reachable sources', async () => {
    // Primary A has a single edge `{from: ['A','B'], to: 'C'}`. B loads
    // successfully but has no incoming path from A. The agents SDK adds
    // one LangGraph edge per `from` source (see
    // `agents/src/graphs/MultiAgentGraph.ts`), so `A -> C` is a real
    // routing regardless of B's reachability. Discovery must preserve it:
    // - C reachable via A
    // - edge kept (A source reachable, C dest reachable)
    // - B kept in agentConfigs because it's still referenced by the
    //   surviving edge; otherwise the SDK's `validateEdgeAgents`
    //   safety-net rejects the graph for a missing `from` endpoint.
    const edges: GraphEdge[] = [{ from: ['A', 'B'], to: 'C', edgeType: 'handoff' }];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    const checkPermission = jest.fn().mockResolvedValue(true);

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.agentConfigs.has('B')).toBe(true);
    expect(result.agentConfigs.has('C')).toBe(true);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toEqual(['A', 'B']);
    expect(result.edges[0].to).toBe('C');
  });

  it('advances through a multi-source edge once all sources are reachable', async () => {
    // Two independent paths converge: `A -> B` and `A -> C` both reach
    // the fan-in edge `['B','C'] -> D`. Once both B and C are reachable,
    // D should become reachable in a subsequent fixed-point iteration.
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'direct' },
      { from: 'A', to: 'C', edgeType: 'direct' },
      { from: ['B', 'C'], to: 'D', edgeType: 'direct' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
      D: makeAgent('D', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    const checkPermission = jest.fn().mockResolvedValue(true);

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.agentConfigs.has('B')).toBe(true);
    expect(result.agentConfigs.has('C')).toBe(true);
    expect(result.agentConfigs.has('D')).toBe(true);
    expect(result.edges).toHaveLength(3);
  });

  it('strips unreachable co-sources from surviving multi-source edges (no stray parallel root)', async () => {
    // Primary has `[A -> C, X -> B, [B,C] -> D]`. X is skipped, so
    // `X -> B` is filtered and B loses its only upstream. The fan-in
    // edge `[B,C] -> D` still has C as a reachable source, so it
    // survives — but discovery must strip B from that edge's `from`
    // list and prune B from `agentConfigs`. Leaving B behind would
    // make it an incoming-less agent that `MultiAgentGraph.analyzeGraph`
    // runs as an unintended parallel root.
    const edges: GraphEdge[] = [
      { from: 'A', to: 'C', edgeType: 'handoff' },
      { from: 'X', to: 'B', edgeType: 'handoff' },
      { from: ['B', 'C'], to: 'D', edgeType: 'direct' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
      D: makeAgent('D', []),
      X: makeAgent('X', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    // X is forbidden; B, C, D pass.
    const checkPermission = jest.fn(
      async ({ resourceId }: { resourceId: unknown }) => resourceId !== 'mongo-X',
    );

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.skippedAgentIds.has('X')).toBe(true);
    expect(result.agentConfigs.has('B')).toBe(false);
    expect(result.agentConfigs.has('C')).toBe(true);
    expect(result.agentConfigs.has('D')).toBe(true);

    // Every returned edge must reference only reachable agents — no B
    // anywhere, not in a co-source slot and not as a node the SDK would
    // need to register.
    const endpoints = result.edges.flatMap((edge) =>
      [edge.from, edge.to].flatMap((v) => (Array.isArray(v) ? v : [v])),
    );
    expect(endpoints).not.toContain('B');
    // The fan-in edge survived (C is a reachable co-source) but now
    // lists only C as the source.
    const fanInEdge = result.edges.find((edge) => {
      const to = Array.isArray(edge.to) ? edge.to : [edge.to];
      return to.includes('D');
    });
    expect(fanInEdge).toBeDefined();
    expect(fanInEdge!.from).toEqual(['C']);
  });

  it('does not promote a downstream orphan to a parallel start when its only upstream is skipped', async () => {
    // Primary A has `[A -> B, X -> Y]`. X is skipped (no VIEW), Y loads.
    // Y had an incoming edge pre-filter (`X -> Y`), so it's a downstream
    // agent — not a legitimate parallel starting node. When X is
    // skipped, Y becomes a stranded orphan and must be pruned; the
    // weaker "not pre-filter reachable from primary" rule would have
    // incorrectly treated Y as an intentional parallel start.
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'X', to: 'Y', edgeType: 'direct' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      X: makeAgent('X', []),
      Y: makeAgent('Y', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    // X is forbidden — should be skipped.
    const checkPermission = jest.fn(
      async ({ resourceId }: { resourceId: unknown }) => resourceId !== 'mongo-X',
    );

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.skippedAgentIds.has('X')).toBe(true);
    expect(result.agentConfigs.has('B')).toBe(true);
    expect(result.agentConfigs.has('Y')).toBe(false);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to).toBe('B');
  });

  it('preserves user-defined parallel-start branches disconnected from the primary', async () => {
    // Primary A has edges `[A -> B, X -> Y]`. The `X -> Y` branch is
    // intentionally disconnected from A — `MultiAgentGraph.analyzeGraph`
    // treats X as a starting node (no incoming edges) and runs it in
    // parallel with A. Discovery must keep this branch intact.
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'X', to: 'Y', edgeType: 'direct' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      X: makeAgent('X', []),
      Y: makeAgent('Y', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    const checkPermission = jest.fn().mockResolvedValue(true);

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.agentConfigs.has('B')).toBe(true);
    expect(result.agentConfigs.has('X')).toBe(true);
    expect(result.agentConfigs.has('Y')).toBe(true);
    expect(result.edges).toHaveLength(2);
    expect(result.edges.map((e) => e.to).sort()).toEqual(['B', 'Y']);
  });

  it('prunes surviving-but-unreachable edges from the return value (A->B->C->D, B skipped)', async () => {
    // All three edges are stored on the primary A. When B is skipped,
    // `filterOrphanedEdges` removes A->B (to=B) and B->C (from=B) — but
    // `C->D` has no skipped endpoint and would otherwise survive,
    // referencing agents that the reachability pass then prunes from
    // `agentConfigs`. That combination is the exact shape that re-raises
    // the "Found edge ending at unknown node" crash in `createRun`.
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'B', to: 'C', edgeType: 'handoff' },
      { from: 'C', to: 'D', edgeType: 'handoff' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
      D: makeAgent('D', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    const checkPermission = jest.fn(
      async ({ resourceId }: { resourceId: unknown }) => resourceId !== 'mongo-B',
    );

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.skippedAgentIds.has('B')).toBe(true);
    expect(result.agentConfigs.has('C')).toBe(false);
    expect(result.agentConfigs.has('D')).toBe(false);
    // Every returned edge must reference only agents present in
    // `agentConfigs` or the primary — no stranded `C->D` survives.
    for (const edge of result.edges) {
      const endpoints = [edge.from, edge.to].flatMap((v) => (Array.isArray(v) ? v : [v]));
      for (const id of endpoints) {
        expect(id === primaryConfig.id || result.agentConfigs.has(id)).toBe(true);
      }
    }
    expect(result.edges).toHaveLength(0);
  });

  it('does not mutate a sub-agent userMCPAuthMap when merging later sub-agents', async () => {
    // Primary has no MCP auth; first sub-agent (B) seeds `userMCPAuthMap`,
    // and the second sub-agent (C) merges into it. Make sure B's own
    // `config.userMCPAuthMap` object is not mutated by C's merge.
    const bAuth = { serverB: { token: 'b' } };
    const cAuth = { serverC: { token: 'c' } };
    const primaryConfig = makeConfig('A', [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'A', to: 'C', edgeType: 'handoff' },
    ]);
    primaryConfig.userMCPAuthMap = undefined;

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
    };
    const authById: Record<string, Record<string, Record<string, string>>> = {
      B: bAuth,
      C: cAuth,
    };

    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    const checkPermission = jest.fn().mockResolvedValue(true);
    mockInitializeAgent.mockImplementation(async ({ agent }: { agent: Agent }) => {
      const cfg = makeConfig(agent.id);
      cfg.userMCPAuthMap = authById[agent.id];
      return cfg;
    });

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    // B's own map must not have picked up C's entry.
    expect(bAuth).toEqual({ serverB: { token: 'b' } });
    expect(cAuth).toEqual({ serverC: { token: 'c' } });
    // The returned merged map should still contain both.
    expect(result.userMCPAuthMap).toEqual({
      serverB: { token: 'b' },
      serverC: { token: 'c' },
    });
  });

  it('does not mutate the caller-supplied primaryConfig.userMCPAuthMap', async () => {
    const primaryAuth = { serverA: { token: 'primary' } };
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    primaryConfig.userMCPAuthMap = primaryAuth;

    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);

    mockInitializeAgent.mockImplementation(async ({ agent }: { agent: Agent }) => {
      const cfg = makeConfig(agent.id);
      cfg.userMCPAuthMap = { serverB: { token: 'secondary' } };
      return cfg;
    });

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    // Caller's map is unchanged — only the returned merged map has the
    // sub-agent entries.
    expect(primaryConfig.userMCPAuthMap).toBe(primaryAuth);
    expect(primaryConfig.userMCPAuthMap).toEqual({ serverA: { token: 'primary' } });
    expect(result.userMCPAuthMap).toEqual({
      serverA: { token: 'primary' },
      serverB: { token: 'secondary' },
    });
    expect(result.userMCPAuthMap).not.toBe(primaryAuth);
  });

  it('keeps sub-agents that remain reachable via surviving edges', async () => {
    // Graph: A -> [B, C]; B is skipped, C is kept. C must remain because
    // A -> C survives filtering.
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'A', to: 'C', edgeType: 'handoff' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    const checkPermission = jest.fn(
      async ({ resourceId }: { resourceId: unknown }) => resourceId !== 'mongo-B',
    );

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.agentConfigs.has('C')).toBe(true);
    expect(result.agentConfigs.has('B')).toBe(false);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].to).toBe('C');
  });

  it('drops edges whose `from` references a skipped agent (bidirectional graph)', async () => {
    // Orchestrator A with bidirectional handoffs A<->B. B is inaccessible,
    // so `A -> B` and `B -> A` must both be filtered — otherwise `B -> A`
    // leaks into createRun and triggers `Found edge ending at unknown node`.
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'B', to: 'A', edgeType: 'handoff' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(false);

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.skippedAgentIds.has('B')).toBe(true);
    expect(result.edges).toHaveLength(0);
  });

  it('does not re-initialize agents that are already known (dedup)', async () => {
    const edges: GraphEdge[] = [
      { from: 'A', to: 'B', edgeType: 'handoff' },
      { from: 'B', to: 'A', edgeType: 'handoff' },
      { from: 'A', to: 'B', edgeType: 'handoff' },
    ];
    const primaryConfig = makeConfig('A', edges);

    const getAgent = jest.fn(async ({ id }: { id: string }) =>
      id === 'B' ? makeAgent('B', [{ from: 'B', to: 'A', edgeType: 'handoff' }]) : null,
    );
    const checkPermission = jest.fn().mockResolvedValue(true);

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    // B should be fetched once; A is the primary and is never re-fetched
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(result.agentConfigs.size).toBe(1);
    expect(result.agentConfigs.has('B')).toBe(true);
    // Deduped edges: A->B and B->A (not the duplicate A->B)
    expect(result.edges).toHaveLength(2);
  });

  it('processes legacy agent_ids chain and adds sequential chain edges', async () => {
    const primaryConfig = makeConfig('A', []);

    const agentMap: Record<string, Agent> = {
      B: makeAgent('B', []),
      C: makeAgent('C', []),
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => agentMap[id] ?? null);
    const checkPermission = jest.fn().mockResolvedValue(true);

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        agent_ids: ['B', 'C'],
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.agentConfigs.size).toBe(2);
    expect(result.agentConfigs.has('B')).toBe(true);
    expect(result.agentConfigs.has('C')).toBe(true);
    // Sequential chain: A -> B -> C (2 direct edges)
    expect(result.edges).toHaveLength(2);
    expect(result.edges.every((e) => e.edgeType === 'direct')).toBe(true);
  });

  it('merges userMCPAuthMap across primary and sub-agents', async () => {
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    primaryConfig.userMCPAuthMap = { serverA: { token: 'primary' } };

    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);

    mockInitializeAgent.mockImplementation(async ({ agent }: { agent: Agent }) => {
      const cfg = makeConfig(agent.id);
      cfg.userMCPAuthMap = { serverB: { token: 'secondary' } };
      return cfg;
    });

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(result.userMCPAuthMap).toEqual({
      serverA: { token: 'primary' },
      serverB: { token: 'secondary' },
    });
  });

  it('throws when a sub-agent model validation fails', async () => {
    mockValidateAgentModel.mockResolvedValueOnce({
      isValid: false,
      error: { message: 'bad model' },
    });

    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);

    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);

    const result = await discoverConnectedAgents(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    // Validation error is caught inside the BFS and the agent is skipped
    expect(result.skippedAgentIds.has('B')).toBe(true);
    expect(result.agentConfigs.has('B')).toBe(false);
  });

  it.each([
    ['expected MCP tools are unavailable', 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE', 503],
    ['CodeAPI resource recovery is required', ErrorTypes.RESOURCE_RECOVERY_REQUIRED, 409],
  ])('propagates a fatal handoff initialization error when %s', async (_case, code, statusCode) => {
    const toolError = Object.assign(new Error(_case), { code, statusCode });
    mockInitializeAgent.mockRejectedValueOnce(toolError);

    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);
    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn().mockResolvedValue(true);

    await expect(
      discoverConnectedAgents(
        {
          req: makeReq(),
          res: makeRes(),
          primaryConfig,
          allowedProviders: new Set(),
          modelsConfig: { openai: ['gpt-4o'] },
          loadTools: jest.fn(),
        },
        {
          getAgent,
          checkPermission,
          logViolation: jest.fn(),
          db: {} as never,
        },
      ),
    ).rejects.toBe(toolError);
  });

  it.each([
    ['expected MCP tools are unavailable', 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE', 503],
    ['CodeAPI resource recovery is required', ErrorTypes.RESOURCE_RECOVERY_REQUIRED, 409],
  ])(
    'propagates a fatal legacy-chain initialization error when %s',
    async (_case, code, statusCode) => {
      const toolError = Object.assign(new Error(_case), { code, statusCode });
      mockInitializeAgent.mockRejectedValueOnce(toolError);

      const primaryConfig = makeConfig('A');
      const getAgent = jest.fn(async () => makeAgent('B', []));
      const checkPermission = jest.fn().mockResolvedValue(true);

      await expect(
        discoverConnectedAgents(
          {
            req: makeReq(),
            res: makeRes(),
            primaryConfig,
            agent_ids: ['B'],
            allowedProviders: new Set(),
            modelsConfig: { openai: ['gpt-4o'] },
            loadTools: jest.fn(),
          },
          {
            getAgent,
            checkPermission,
            logViolation: jest.fn(),
            db: {} as never,
          },
        ),
      ).rejects.toBe(toolError);
    },
  );

  it.each([
    ['handoff', [{ from: 'A', to: 'B', edgeType: 'handoff' as const }], undefined],
    ['legacy chain', undefined, ['B']],
  ])('propagates owning-run cancellation during %s discovery', async (_case, edges, agentIds) => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      discoverConnectedAgents(
        {
          req: makeReq(),
          res: makeRes(),
          signal: controller.signal,
          primaryConfig: makeConfig('A', edges),
          agent_ids: agentIds,
          allowedProviders: new Set(),
          modelsConfig: { openai: ['gpt-4o'] },
          loadTools: jest.fn(),
        },
        {
          getAgent: jest.fn(async () => makeAgent('B', [])),
          checkPermission: jest.fn().mockResolvedValue(true),
          logViolation: jest.fn(),
          db: {} as never,
        },
      ),
    ).rejects.toBe(controller.signal.reason);
  });

  it.each(['getAgent', 'checkPermission', 'validateAgentModel', 'initializeAgent'] as const)(
    'detaches promptly when cancellation occurs during %s',
    async (stage) => {
      const controller = new AbortController();
      const reason = new Error(`stopped during ${stage}`);
      let settlePending!: (value: unknown) => void;
      const pending = new Promise<unknown>((resolve) => {
        settlePending = resolve;
      });
      const getAgent = jest.fn(async () => makeAgent('B', []));
      const checkPermission = jest.fn().mockResolvedValue(true);

      if (stage === 'getAgent') {
        getAgent.mockReturnValueOnce(pending as Promise<Agent>);
      } else if (stage === 'checkPermission') {
        checkPermission.mockReturnValueOnce(pending as Promise<boolean>);
      } else if (stage === 'validateAgentModel') {
        mockValidateAgentModel.mockReturnValueOnce(pending as Promise<{ isValid: boolean }>);
      } else {
        mockInitializeAgent.mockReturnValueOnce(pending as Promise<InitializedAgent>);
      }

      const discovery = discoverConnectedAgents(
        {
          req: makeReq(),
          res: makeRes(),
          signal: controller.signal,
          primaryConfig: makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' as const }]),
          allowedProviders: new Set(),
          modelsConfig: { openai: ['gpt-4o'] },
          loadTools: jest.fn(),
        },
        {
          getAgent,
          checkPermission,
          logViolation: jest.fn(),
          db: {} as never,
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort(reason);

      await expect(discovery).rejects.toBe(reason);
      if (stage === 'getAgent') {
        settlePending(makeAgent('B', []));
      } else if (stage === 'checkPermission') {
        settlePending(true);
      } else if (stage === 'validateAgentModel') {
        settlePending({ isValid: true });
      } else {
        settlePending(makeConfig('B'));
      }
    },
  );

  it('skips when request has no authenticated user', async () => {
    const primaryConfig = makeConfig('A', [{ from: 'A', to: 'B', edgeType: 'handoff' }]);

    const getAgent = jest.fn(async () => makeAgent('B', []));
    const checkPermission = jest.fn();

    const result = await discoverConnectedAgents(
      {
        req: { user: undefined } as unknown as ServerRequest,
        res: makeRes(),
        primaryConfig,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
      },
      {
        getAgent,
        checkPermission,
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(checkPermission).not.toHaveBeenCalled();
    expect(result.skippedAgentIds.has('B')).toBe(true);
    expect(result.edges).toHaveLength(0);
  });
});

describe('resolveSubagentGraphs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateAgentModel.mockResolvedValue({ isValid: true });
    mockInitializeAgent.mockImplementation(async ({ agent }: { agent: Agent }) =>
      makeConfig(agent.id),
    );
  });

  it('resolves a complete graph team while reusing the primary config', async () => {
    const primaryConfig = makeConfig('A') as GraphSubagentHostConfig;
    primaryConfig.userMCPAuthMap = { primary: { token: 'primary-token' } };
    primaryConfig.subagents = {
      enabled: true,
      graphs: [
        {
          type: 'team',
          name: 'Team',
          description: 'A remote graph team',
          agent_ids: ['A', 'B'],
          edges: [{ from: 'A', to: 'B', edgeType: 'direct' }],
          entry_agent_id: 'A',
          result_agent_id: 'B',
        },
      ],
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) => makeAgent(id));
    const onAgentInitialized = jest.fn();
    mockInitializeAgent.mockImplementationOnce(async ({ agent }: { agent: Agent }) => ({
      ...makeConfig(agent.id),
      userMCPAuthMap: { graph: { token: 'graph-token' } },
    }));

    const userMCPAuthMap = await resolveSubagentGraphs(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        rootConfigs: [primaryConfig],
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        resourceType: 'remote_agent',
        statefulSessionsAvailable: true,
        allowedStatefulCodeEnvironments: ['user'],
      },
      {
        getAgent,
        checkPermission: jest.fn().mockResolvedValue(true),
        logViolation: jest.fn(),
        db: {} as never,
        onAgentInitialized,
      },
    );

    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(getAgent).toHaveBeenCalledWith({ id: 'B' });
    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        statefulSessionsAvailable: true,
        allowedStatefulCodeEnvironments: ['user'],
      }),
      expect.anything(),
    );
    expect(onAgentInitialized).toHaveBeenCalledWith('B', expect.anything(), expect.anything());
    expect(primaryConfig.subagentGraphConfigs).toEqual([
      expect.objectContaining({
        memberConfigs: [primaryConfig, expect.objectContaining({ id: 'B' })],
      }),
    ]);
    expect(userMCPAuthMap).toEqual({
      primary: { token: 'primary-token' },
      graph: { token: 'graph-token' },
    });
  });

  it('propagates owning-run cancellation while resolving a graph member', async () => {
    const controller = new AbortController();
    controller.abort();
    const primaryConfig = makeConfig('A') as GraphSubagentHostConfig;
    primaryConfig.subagents = {
      enabled: true,
      graphs: [
        {
          type: 'team',
          name: 'Team',
          description: 'A remote graph team',
          agent_ids: ['A', 'B'],
          edges: [{ from: 'A', to: 'B', edgeType: 'direct' }],
          entry_agent_id: 'A',
          result_agent_id: 'B',
        },
      ],
    };

    await expect(
      resolveSubagentGraphs(
        {
          req: makeReq(),
          res: makeRes(),
          signal: controller.signal,
          primaryConfig,
          rootConfigs: [primaryConfig],
          allowedProviders: new Set(),
          modelsConfig: { openai: ['gpt-4o'] },
          loadTools: jest.fn(),
          resourceType: 'remote_agent',
        },
        {
          getAgent: jest.fn(async ({ id }: { id: string }) => makeAgent(id)),
          checkPermission: jest.fn().mockResolvedValue(true),
          logViolation: jest.fn(),
          db: {} as never,
        },
      ),
    ).rejects.toBe(controller.signal.reason);
  });

  it('does not charge initialized root members against the graph load budget', async () => {
    const rootConfigs = Array.from({ length: MAX_SUBAGENT_GRAPH_NODES }, (_, index) => {
      const config = makeConfig(`root_${index}`) as GraphSubagentHostConfig;
      config.subagents = {
        enabled: true,
        graphs: [
          {
            type: `self_team_${index}`,
            name: `Self team ${index}`,
            description: 'Reuses an initialized root',
            agent_ids: [config.id],
            edges: [],
            entry_agent_id: config.id,
            result_agent_id: config.id,
          },
        ],
      };
      return config;
    });
    const finalRoot = rootConfigs[rootConfigs.length - 1];
    finalRoot.subagents?.graphs?.push({
      type: 'external_team',
      name: 'External team',
      description: 'Still has room for a real member load',
      agent_ids: ['external_member'],
      edges: [],
      entry_agent_id: 'external_member',
      result_agent_id: 'external_member',
    });
    const getAgent = jest.fn(async ({ id }: { id: string }) => makeAgent(id));

    await resolveSubagentGraphs(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig: rootConfigs[0],
        rootConfigs,
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        resourceType: 'remote_agent',
      },
      {
        getAgent,
        checkPermission: jest.fn().mockResolvedValue(true),
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(getAgent).toHaveBeenCalledWith({ id: 'external_member' });
    expect(finalRoot.subagentGraphConfigs).toHaveLength(2);
  });

  it('omits the whole graph when a member lacks remote VIEW access', async () => {
    const primaryConfig = makeConfig('A') as GraphSubagentHostConfig;
    primaryConfig.subagents = {
      enabled: true,
      graphs: [
        {
          type: 'team',
          name: 'Team',
          description: 'A remote graph team',
          agent_ids: ['A', 'B'],
          edges: [{ from: 'A', to: 'B', edgeType: 'direct' }],
          entry_agent_id: 'A',
          result_agent_id: 'B',
        },
      ],
    };

    await resolveSubagentGraphs(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        rootConfigs: [primaryConfig],
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        resourceType: 'remote_agent',
      },
      {
        getAgent: jest.fn(async ({ id }: { id: string }) => makeAgent(id)),
        checkPermission: jest.fn().mockResolvedValue(false),
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(primaryConfig.subagentGraphConfigs).toEqual([]);
    expect(mockInitializeAgent).not.toHaveBeenCalled();
  });

  it('caches successful members from an incomplete team for later teams', async () => {
    const primaryConfig = makeConfig('A') as GraphSubagentHostConfig;
    primaryConfig.subagents = {
      enabled: true,
      graphs: [
        {
          type: 'incomplete',
          name: 'Incomplete team',
          description: 'Contains a missing member',
          agent_ids: ['B', 'missing'],
          edges: [{ from: 'B', to: 'missing', edgeType: 'direct' }],
          entry_agent_id: 'B',
          result_agent_id: 'missing',
        },
        {
          type: 'complete',
          name: 'Complete team',
          description: 'Reuses the successful member',
          agent_ids: ['B'],
          edges: [],
          entry_agent_id: 'B',
          result_agent_id: 'B',
        },
      ],
    };
    const getAgent = jest.fn(async ({ id }: { id: string }) =>
      id === 'missing' ? null : makeAgent(id),
    );
    const onAgentInitialized = jest.fn();

    await resolveSubagentGraphs(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        rootConfigs: [primaryConfig],
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        resourceType: 'remote_agent',
      },
      {
        getAgent,
        checkPermission: jest.fn().mockResolvedValue(true),
        logViolation: jest.fn(),
        db: {} as never,
        onAgentInitialized,
      },
    );

    expect(getAgent).toHaveBeenCalledTimes(2);
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(onAgentInitialized).toHaveBeenCalledTimes(1);
    expect(primaryConfig.subagentGraphConfigs).toEqual([
      expect.objectContaining({ memberConfigs: [expect.objectContaining({ id: 'B' })] }),
    ]);
  });

  it('caches failed members across incomplete teams', async () => {
    const primaryConfig = makeConfig('A') as GraphSubagentHostConfig;
    primaryConfig.subagents = {
      enabled: true,
      graphs: ['first', 'second'].map((suffix) => ({
        type: `incomplete_${suffix}`,
        name: `Incomplete ${suffix}`,
        description: 'Reuses the same missing member',
        agent_ids: ['missing'],
        edges: [],
        entry_agent_id: 'missing',
        result_agent_id: 'missing',
      })),
    };
    const getAgent = jest.fn().mockResolvedValue(null);
    const onAgentSkipped = jest.fn();

    await resolveSubagentGraphs(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        rootConfigs: [primaryConfig],
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        resourceType: 'remote_agent',
      },
      {
        getAgent,
        checkPermission: jest.fn(),
        logViolation: jest.fn(),
        db: {} as never,
        onAgentSkipped,
      },
    );

    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(onAgentSkipped).toHaveBeenCalledTimes(1);
    expect(primaryConfig.subagentGraphConfigs).toEqual([]);
  });

  it('counts distinct failed attempts against the request-wide member limit', async () => {
    const firstMemberIds = Array.from({ length: 32 }, (_, index) => `missing_first_${index}`);
    const overflowMemberIds = Array.from({ length: 20 }, (_, index) => `missing_overflow_${index}`);
    const primaryConfig = makeConfig('A') as GraphSubagentHostConfig;
    primaryConfig.subagents = {
      enabled: true,
      graphs: [
        {
          type: 'first_missing_team',
          name: 'First missing team',
          description: 'Consumes the attempted-member budget',
          agent_ids: firstMemberIds,
          edges: [],
          entry_agent_id: firstMemberIds[0],
          result_agent_id: firstMemberIds[firstMemberIds.length - 1],
        },
        {
          type: 'overflow_missing_team',
          name: 'Overflow missing team',
          description: 'Must be skipped before member lookup',
          agent_ids: overflowMemberIds,
          edges: [],
          entry_agent_id: overflowMemberIds[0],
          result_agent_id: overflowMemberIds[overflowMemberIds.length - 1],
        },
      ],
    };
    const getAgent = jest.fn().mockResolvedValue(null);

    await resolveSubagentGraphs(
      {
        req: makeReq(),
        res: makeRes(),
        primaryConfig,
        rootConfigs: [primaryConfig],
        allowedProviders: new Set(),
        modelsConfig: { openai: ['gpt-4o'] },
        loadTools: jest.fn(),
        resourceType: 'remote_agent',
      },
      {
        getAgent,
        checkPermission: jest.fn(),
        logViolation: jest.fn(),
        db: {} as never,
      },
    );

    expect(getAgent).toHaveBeenCalledTimes(firstMemberIds.length);
    expect(primaryConfig.subagentGraphConfigs).toEqual([]);
  });
});
