import type { SubagentExecutionContext } from '@librechat/agents';
import type { AppConfig } from '@librechat/data-schemas';
import type {
  SubagentCodeAgent,
  SubagentCodeFlags,
  SubagentCodeTargets,
  SubagentCodeTargetParams,
} from './targets';
import type { CodeEnvironmentConfig } from '~/agents/execution';
import {
  SUBAGENT_MACHINE_ARG,
  SUBAGENT_WORKSPACE_ARG,
  buildSubagentCodeHostArgs,
  createSubagentCodeRouting,
  guardRoutableSubagent,
  getSubagentHostArgValues,
  isSubagentHostArgsSupported,
  placeSubagentOnCodeTarget,
  resolveSubagentCodeTargets,
  selectSubagentCodeTarget,
} from './targets';
import {
  resolveCodeExecutionContext,
  assertCodeExecutionApprovalBinding,
  captureCodeExecutionApprovalBinding,
} from '~/agents/execution';
import { collectCodeExecutionProfileRoutes } from '~/agents/codeFilesSession';
import { collectAttachedCodeEnvironmentAgentIds } from '~/agents/hitl/byom';

/**
 * Stands in for the SDK's `SubagentHostArgumentError` until LibreChat depends
 * on an `@librechat/agents` release that exports it; the real class wins once
 * the installed SDK provides one.
 */
jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  class MockSubagentHostArgumentError extends Error {
    constructor(name: string, reason: 'unavailable' | 'not_allowed') {
      super('Subagent host argument was rejected.');
      this.name = 'SubagentHostArgumentError';
      Object.assign(this, { argument: name, rejection: reason });
    }
  }
  return {
    ...actual,
    SubagentHostArgumentError: actual.SubagentHostArgumentError ?? MockSubagentHostArgumentError,
  };
});

const BASE_URL = 'https://bridge.example';
const TOKEN_ENV = 'TEST_SUBAGENT_TARGETS_TOKEN';

const controlPlane: CodeEnvironmentConfig = {
  id: 'control-plane',
  name: 'Control plane',
  type: 'attached',
  owner: 'deployment',
  baseURL: BASE_URL,
  pairing: { allowPrincipalWorkers: true, tokenEnv: TOKEN_ENV },
};

const machine = (id: string, workerId: string): CodeEnvironmentConfig => ({
  id,
  name: `${id} machine`,
  type: 'attached',
  owner: 'principal',
  baseURL: BASE_URL,
  workerId,
  controlPlaneId: 'control-plane',
});

const environments: CodeEnvironmentConfig[] = [
  controlPlane,
  machine('laptop', 'w-laptop'),
  machine('buildbox', 'w-buildbox'),
  machine('spare', 'w-spare'),
];

const getAppConfig = jest.fn(
  async () =>
    ({
      endpoints: { agents: { statefulCodeSessions: { environments: [controlPlane] } } },
    }) as AppConfig,
);

const sealed = [
  { environmentId: 'buildbox', workspaceId: 'agents' },
  { environmentId: 'laptop', workspaceId: 'librechat' },
];

type WorkerState = { online: boolean; workspaces: string[] };

function serveWorkers(workers: Record<string, WorkerState>): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const workerId = /\/bridge\/workers\/([^/]+)\/status$/.exec(url)?.[1] ?? '';
    const worker = workers[workerId];
    return new Response(
      JSON.stringify({
        protocolVersion: 1,
        workerId,
        online: worker?.online === true,
        ready: worker?.online === true,
        leaseExpiresInMs: 45_000,
        capabilities: {
          statefulWorkspace: true,
          sandboxProfile: 'native-srt',
          runtimes: ['bash'],
          workspaceTools: {
            protocolVersion: 1,
            operations: ['read_file', 'list_files', 'execute_command'],
            workspaces: (worker?.workspaces ?? []).map((id) => ({ id })),
          },
        },
      }),
    );
  });
}

const allOnline: Record<string, WorkerState> = {
  'w-laptop': { online: true, workspaces: ['librechat'] },
  'w-buildbox': { online: true, workspaces: ['agents'] },
  'w-spare': { online: true, workspaces: ['scratch'] },
};

function params(overrides: Partial<SubagentCodeTargetParams> = {}): SubagentCodeTargetParams {
  return {
    agentId: 'agent_reviewer',
    statefulSessions: true,
    environment: 'conversation',
    environmentId: 'laptop',
    environmentIds: ['buildbox', 'spare'],
    allowEnvironmentSelection: true,
    persistedSelections: sealed,
    environments,
    userId: 'user-1',
    conversationId: 'convo-1',
    getAppConfig,
    ...overrides,
  };
}

function rejection(error: unknown): { argument?: string; rejection?: string } {
  return error as { argument?: string; rejection?: string };
}

describe('subagent code targets', () => {
  beforeEach(() => {
    process.env[TOKEN_ENV] = `token-${Math.random()}`;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[TOKEN_ENV];
  });

  it('detects SDK support for per-call host arguments', () => {
    expect(isSubagentHostArgsSupported()).toBe(true);
  });

  it('lists only admitted, authorized machines with a ready worker', async () => {
    serveWorkers(allOnline);

    const { targets, unavailableMachines } = await resolveSubagentCodeTargets(params());

    expect(targets.map(({ environmentId, workspaceId }) => [environmentId, workspaceId])).toEqual([
      ['buildbox', 'agents'],
      ['laptop', 'librechat'],
    ]);
    expect(unavailableMachines.size).toBe(0);
    expect(targets[0].context).toMatchObject({
      environmentId: 'buildbox',
      environmentType: 'attached',
      bridgeWorkerId: 'w-buildbox',
      codeWorkspace: { environmentId: 'buildbox', workspaceId: 'agents' },
    });
  });

  it('excludes a machine outside the child allowlist', async () => {
    serveWorkers(allOnline);

    const { targets } = await resolveSubagentCodeTargets(params({ environmentIds: ['spare'] }));

    expect(targets.map((target) => target.environmentId)).toEqual(['laptop']);
  });

  it('keeps only the default machine when per-chat machine choice is disabled', async () => {
    serveWorkers(allOnline);

    const { targets } = await resolveSubagentCodeTargets(
      params({ allowEnvironmentSelection: false }),
    );

    expect(targets.map((target) => target.environmentId)).toEqual(['laptop']);
  });

  it('excludes a machine missing from the principal’s list', async () => {
    serveWorkers(allOnline);

    const { targets } = await resolveSubagentCodeTargets(
      params({ environments: environments.filter((environment) => environment.id !== 'buildbox') }),
    );

    expect(targets.map((target) => target.environmentId)).toEqual(['laptop']);
  });

  it('never adds an allowed machine the conversation has not admitted', async () => {
    serveWorkers(allOnline);

    const { targets } = await resolveSubagentCodeTargets(params({ environmentIds: ['spare'] }));

    expect(targets.some((target) => target.environmentId === 'spare')).toBe(false);
  });

  it('reports an authorized machine whose worker is offline as unavailable', async () => {
    serveWorkers({ ...allOnline, 'w-buildbox': { online: false, workspaces: [] } });

    const resolution = await resolveSubagentCodeTargets(params());

    expect(resolution.targets.map((target) => target.environmentId)).toEqual(['laptop']);
    expect([...resolution.unavailableMachines]).toEqual(['buildbox']);
    expect([...resolution.unavailableWorkspaces]).toEqual(['agents']);
  });

  it('treats a missing sealed workspace as unavailable', async () => {
    serveWorkers({ ...allOnline, 'w-buildbox': { online: true, workspaces: ['other'] } });

    const resolution = await resolveSubagentCodeTargets(params());

    expect([...resolution.unavailableMachines]).toEqual(['buildbox']);
  });

  it('pins a child to the machine the conversation assigned to it', async () => {
    serveWorkers(allOnline);

    const { targets } = await resolveSubagentCodeTargets(
      params({
        persistedSelections: [
          { environmentId: 'buildbox', workspaceId: 'agents', agentIds: ['agent_reviewer'] },
          { environmentId: 'laptop', workspaceId: 'librechat' },
        ],
      }),
    );

    expect(targets.map((target) => target.environmentId)).toEqual(['buildbox']);
  });

  it('lists nothing without stateful sessions or an admitted decision', async () => {
    const fetchSpy = serveWorkers(allOnline);

    await expect(
      resolveSubagentCodeTargets(params({ statefulSessions: false })),
    ).resolves.toMatchObject({ targets: [] });
    await expect(
      resolveSubagentCodeTargets(params({ persistedSelections: [] })),
    ).resolves.toMatchObject({ targets: [] });
    await expect(
      resolveSubagentCodeTargets(params({ persistedSelections: 'tampered' })),
    ).resolves.toMatchObject({ targets: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('prefers the sealed decision over a conflicting request', async () => {
    serveWorkers(allOnline);

    const { targets, unavailableMachines } = await resolveSubagentCodeTargets(
      params({ requestedSelections: [{ environmentId: 'spare', workspaceId: 'scratch' }] }),
    );

    expect(targets).toEqual([]);
    expect([...unavailableMachines].sort()).toEqual(['buildbox', 'laptop']);
  });

  it('resolves the same route for the same inputs', async () => {
    serveWorkers(allOnline);

    const first = await resolveSubagentCodeTargets(params());
    const second = await resolveSubagentCodeTargets(params());

    expect(second.targets.map((target) => target.context)).toEqual(
      first.targets.map((target) => target.context),
    );
    expect(first.targets[0].context.codeSessionKey).toBe(second.targets[0].context.codeSessionKey);
  });
});

describe('subagent code host arguments', () => {
  const resolution = (
    targets: Array<[string, string]>,
    unavailable: Array<[string, string]> = [],
  ): SubagentCodeTargets => ({
    targets: targets.map(([environmentId, workspaceId]) => ({
      environmentId,
      workspaceId,
      context: {
        baseUrl: BASE_URL,
        codeSessionKey: `session-${environmentId}`,
        executionProfile: 'stateful',
        statefulSessions: true,
        environmentId,
        environmentType: 'attached',
      },
    })),
    unavailableMachines: new Set(unavailable.map(([environmentId]) => environmentId)),
    unavailableWorkspaces: new Set(unavailable.map(([, workspaceId]) => workspaceId)),
  });

  it('declares machine and workspace enums built only from reachable targets', () => {
    const hostArgs = buildSubagentCodeHostArgs(
      resolution([
        ['buildbox', 'agents'],
        ['laptop', 'librechat'],
      ]).targets,
    );

    expect(hostArgs?.[SUBAGENT_MACHINE_ARG].enum).toEqual(['buildbox', 'laptop']);
    expect(hostArgs?.[SUBAGENT_WORKSPACE_ARG].enum).toEqual(['agents', 'librechat']);
    for (const spec of Object.values(hostArgs ?? {})) {
      expect(spec.description.length).toBeLessThan(1024);
    }
  });

  it('omits workspace when two machines share a workspace ID, and declares nothing without targets', () => {
    expect(
      Object.keys(
        buildSubagentCodeHostArgs(
          resolution([
            ['buildbox', 'agents'],
            ['laptop', 'agents'],
          ]).targets,
        ) ?? {},
      ),
    ).toEqual([SUBAGENT_MACHINE_ARG]);
    expect(buildSubagentCodeHostArgs([])).toBeUndefined();
  });

  it('returns no target for omitted arguments', () => {
    expect(selectSubagentCodeTarget(undefined, resolution([['laptop', 'librechat']]))).toBe(
      undefined,
    );
    expect(selectSubagentCodeTarget({}, resolution([['laptop', 'librechat']]))).toBe(undefined);
  });

  it('selects by machine, by workspace, or by a matching pair', () => {
    const current = resolution([
      ['buildbox', 'agents'],
      ['laptop', 'librechat'],
    ]);

    expect(selectSubagentCodeTarget({ machine: 'buildbox' }, current)?.workspaceId).toBe('agents');
    expect(selectSubagentCodeTarget({ workspace: 'librechat' }, current)?.environmentId).toBe(
      'laptop',
    );
    expect(
      selectSubagentCodeTarget({ machine: 'laptop', workspace: 'librechat' }, current)
        ?.environmentId,
    ).toBe('laptop');
  });

  it.each([
    [{ machine: 'buildbox' }, SUBAGENT_MACHINE_ARG, 'unavailable'],
    [{ machine: 'spare' }, SUBAGENT_MACHINE_ARG, 'not_allowed'],
    [{ machine: 'laptop', workspace: 'agents' }, SUBAGENT_WORKSPACE_ARG, 'not_allowed'],
    [{ workspace: 'agents' }, SUBAGENT_WORKSPACE_ARG, 'unavailable'],
    [{ workspace: 'scratch' }, SUBAGENT_WORKSPACE_ARG, 'not_allowed'],
  ])('rejects %j with a %s refusal', (hostArgs, argument, expected) => {
    const current = resolution([['laptop', 'librechat']], [['buildbox', 'agents']]);
    let thrown: unknown;
    try {
      selectSubagentCodeTarget(hostArgs, current);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('SubagentHostArgumentError');
    expect(rejection(thrown)).toMatchObject({ argument, rejection: expected });
  });

  it('reads only string host arguments from a resolver context', () => {
    expect(getSubagentHostArgValues(undefined)).toBeUndefined();
    expect(
      getSubagentHostArgValues({
        executionId: 'run',
        hostArgs: { machine: 'laptop', other: 3 },
      } as never),
    ).toEqual({ machine: 'laptop' });
    expect(getSubagentHostArgValues({ executionId: 'run', hostArgs: {} } as never)).toBe(undefined);
  });

  it('pins the routed child document to the selected machine without mutating it', () => {
    const agent = {
      id: 'agent_reviewer',
      code_environment_id: 'laptop',
      code_environment_ids: ['buildbox', 'spare'],
    };

    const routed = placeSubagentOnCodeTarget(agent, { environmentId: 'buildbox' });

    expect(routed).toEqual({
      id: 'agent_reviewer',
      code_environment_id: 'buildbox',
      code_environment_ids: ['buildbox'],
    });
    expect(agent).toEqual({
      id: 'agent_reviewer',
      code_environment_id: 'laptop',
      code_environment_ids: ['buildbox', 'spare'],
    });
  });

  it('keeps a routed child on its machine even when its parent machine would be inherited', () => {
    const routed = placeSubagentOnCodeTarget(
      { id: 'agent_reviewer', code_environment_id: 'laptop', code_environment_ids: ['buildbox'] },
      { environmentId: 'buildbox' },
    );

    const context = resolveCodeExecutionContext({
      statefulSessions: true,
      environment: 'conversation',
      environmentId: routed.code_environment_id,
      environmentIds: routed.code_environment_ids,
      allowEnvironmentSelection: true,
      workspaceSelections: sealed,
      inheritedEnvironments: new Map([['agent_reviewer', 'laptop']]),
      environments,
      userId: 'user-1',
      agentId: 'agent_reviewer',
      conversationId: 'convo-1',
    });
    const inherited = resolveCodeExecutionContext({
      statefulSessions: true,
      environment: 'conversation',
      environmentId: 'spare',
      environmentIds: ['laptop'],
      allowEnvironmentSelection: true,
      workspaceSelections: sealed,
      inheritedEnvironments: new Map([['agent_reviewer', 'laptop']]),
      environments,
      userId: 'user-1',
      agentId: 'agent_reviewer',
      conversationId: 'convo-1',
    });

    expect(context.environmentId).toBe('buildbox');
    expect(inherited.environmentId).toBe('laptop');
  });
});

describe('subagent code routing', () => {
  const request = {
    allowEnvironmentSelection: true,
    persistedSelections: sealed,
    environments,
    userId: 'user-1',
    conversationId: 'convo-1',
    getAppConfig,
  };
  const reviewer = {
    id: 'agent_reviewer',
    code_environment_id: 'laptop',
    code_environment_ids: ['buildbox'],
  };
  const flags = { statefulCodeSessions: true, statefulCodeEnvironment: 'conversation' };

  beforeEach(() => {
    process.env[TOKEN_ENV] = `token-${Math.random()}`;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env[TOKEN_ENV];
  });

  it('describes per-child choices and their approval targets', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting(request);

    const description = await routing.describe(reviewer, flags);
    const lone = await routing.describe(
      { id: 'agent_writer', code_environment_id: 'laptop' },
      flags,
    );
    const stateless = await routing.describe(reviewer, { statefulCodeSessions: false });

    expect(description.subagentHostArgs?.machine.enum).toEqual(['buildbox', 'laptop']);
    expect(description.codeExecutionChoices?.map((context) => context.environmentId)).toEqual([
      'buildbox',
      'laptop',
    ]);
    expect(lone.subagentHostArgs?.machine.enum).toEqual(['laptop']);
    expect(stateless).toEqual({});
  });

  const call = (hostArgs?: Record<string, string>, parentRunId?: string) => ({
    executionId: `run-${Math.random()}`,
    ...(parentRunId == null ? {} : { parentRunId }),
    ...(hostArgs == null ? {} : { hostArgs }),
  });

  it('re-validates on use and routes only to a currently reachable machine', async () => {
    const routing = createSubagentCodeRouting(request);
    serveWorkers(allOnline);

    const placed = await routing.place({
      agent: reviewer,
      flags,
      context: call({ machine: 'buildbox' }),
    });
    const omitted = await createSubagentCodeRouting(request).place({
      agent: reviewer,
      flags,
      context: call(),
    });

    expect(placed.agent.code_environment_id).toBe('buildbox');
    expect(placed.target?.context.bridgeWorkerId).toBe('w-buildbox');
    expect(omitted).toEqual({ agent: reviewer });

    jest.restoreAllMocks();
    process.env[TOKEN_ENV] = `token-${Math.random()}`;
    serveWorkers({ ...allOnline, 'w-buildbox': { online: false, workspaces: [] } });
    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'buildbox' }) }),
    ).rejects.toMatchObject({ argument: 'machine', rejection: 'unavailable' });
  });

  it('reserves a default route before initialization so a concurrent call cannot move it', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);

    const defaultCall = call();
    const placed = await routing.place({ agent: reviewer, flags, context: defaultCall });
    const concurrent = routing.place({
      agent: reviewer,
      flags,
      context: call({ machine: 'buildbox' }),
    });
    const sameMachine = await routing.place({
      agent: reviewer,
      flags,
      context: call({ machine: 'laptop' }),
    });

    expect(placed).toEqual({ agent: reviewer });
    await expect(concurrent).rejects.toMatchObject({
      argument: 'machine',
      rejection: 'unavailable',
    });
    expect(sameMachine.target?.environmentId).toBe('laptop');
    expect(routing.routesChildren(defaultCall.executionId)).toBe(false);
  });

  it('reserves the inherited default a parent machine gives a child', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>({
      ...request,
      getInheritedEnvironments: () => new Map([['agent_reviewer', 'buildbox']]),
    });

    await routing.place({ agent: reviewer, flags, context: call() });

    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'laptop' }) }),
    ).rejects.toMatchObject({ argument: 'machine' });
    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'buildbox' }) }),
    ).resolves.toMatchObject({ target: { environmentId: 'buildbox' } });
  });

  it('settles concurrent inherited calls from differently routed parents on one machine', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const parentOn = async (machine: string) => {
      const parent = {
        id: `agent_parent_${machine}`,
        code_environment_id: machine,
        code_environment_ids: [machine],
      };
      const parentCall = call({ machine });
      const placement = await routing.place({ agent: parent, flags, context: parentCall });
      routing.attach(new Map(), {
        agentId: parent.id,
        context: parentCall,
        placement,
        codeExecutionContext: placement.target?.context,
        toolContext: machine,
      });
      return parentCall.executionId;
    };
    const fromLaptop = await parentOn('laptop');
    const fromBuildbox = await parentOn('buildbox');

    const placements = await Promise.allSettled([
      routing.place({ agent: reviewer, flags, context: call(undefined, fromLaptop) }),
      routing.place({ agent: reviewer, flags, context: call(undefined, fromBuildbox) }),
    ]);
    const machines = placements.map((result) =>
      result.status === 'fulfilled' ? result.value.target?.environmentId : 'rejected',
    );

    expect(
      new Set(machines.filter((machine) => machine !== undefined && machine !== 'rejected')).size,
    ).toBe(1);
  });

  it('never claims a machine for a call canceled while its targets resolve', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const controller = new AbortController();

    const canceled = routing.place({
      agent: reviewer,
      flags,
      context: { ...call({ machine: 'buildbox' }), signal: controller.signal },
    });
    controller.abort();

    await expect(canceled).rejects.toBeDefined();
    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'laptop' }) }),
    ).resolves.toMatchObject({ target: { environmentId: 'laptop' } });
  });

  it('gives back a machine whose initialization failed unless another call still holds it', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const failed = new Error('initialization failed');

    const first = await routing.place({ agent: reviewer, flags, context: call() });
    const second = await routing.place({ agent: reviewer, flags, context: call() });
    await expect(routing.settle(first, Promise.reject(failed))).rejects.toBe(failed);
    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'buildbox' }) }),
    ).rejects.toMatchObject({ argument: 'machine' });

    await expect(routing.settle(second, Promise.reject(failed))).rejects.toBe(failed);
    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'buildbox' }) }),
    ).resolves.toMatchObject({ target: { environmentId: 'buildbox' } });
  });

  it('gives back a machine when its call is canceled before the child attaches', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const controller = new AbortController();

    await routing.place({
      agent: reviewer,
      flags,
      context: { ...call({ machine: 'buildbox' }), signal: controller.signal },
    });
    controller.abort();

    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'laptop' }) }),
    ).resolves.toMatchObject({ target: { environmentId: 'laptop' } });
  });

  it('keeps a machine once the resolution that placed it succeeds', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const controller = new AbortController();
    const routedCall = { ...call({ machine: 'buildbox' }), signal: controller.signal };

    const placement = await routing.settleExecution(routedCall, async () => {
      const placed = await routing.place({ agent: reviewer, flags, context: routedCall });
      routing.attach(new Map(), {
        agentId: reviewer.id,
        context: routedCall,
        placement: placed,
        codeExecutionContext: placed.target?.context,
        toolContext: 'buildbox',
      });
      return placed;
    });
    controller.abort();
    await expect(routing.settle(placement, Promise.reject(new Error('late')))).rejects.toThrow();

    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'laptop' }) }),
    ).rejects.toMatchObject({ argument: 'machine' });
  });

  it('gives back a child and its graph members when the rest of its resolution fails', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const member = { ...reviewer, id: 'agent_member' };
    const routedCall = call({ machine: 'buildbox' });
    const memberCall = {
      executionId: `${routedCall.executionId}:graph:${member.id}`,
      parentRunId: routedCall.executionId,
    };
    await expect(
      routing.settleExecution(routedCall, async () => {
        const placed = await routing.place({ agent: reviewer, flags, context: routedCall });
        routing.attach(new Map(), {
          agentId: reviewer.id,
          context: routedCall,
          placement: placed,
          codeExecutionContext: placed.target?.context,
          toolContext: 'buildbox',
        });
        const memberPlaced = await routing.place({ agent: member, flags, context: memberCall });
        routing.attach(new Map(), {
          agentId: member.id,
          context: memberCall,
          placement: memberPlaced,
          codeExecutionContext: memberPlaced.target?.context,
          toolContext: 'buildbox',
        });
        expect(memberPlaced.target?.environmentId).toBe('buildbox');
        throw new Error('a graph member failed to load');
      }),
    ).rejects.toThrow('a graph member failed to load');

    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'laptop' }) }),
    ).resolves.toMatchObject({ target: { environmentId: 'laptop' } });
    await expect(
      routing.place({ agent: member, flags, context: call({ machine: 'laptop' }) }),
    ).resolves.toMatchObject({ target: { environmentId: 'laptop' } });
  });

  it('gives back the per-agent tool context a failed resolution set', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const contexts = new Map<string, string>();
    const member = { ...reviewer, id: 'agent_member' };
    const failedCall = call({ machine: 'buildbox' });
    const routedMember = {
      executionId: `${failedCall.executionId}:graph:${member.id}`,
      parentRunId: failedCall.executionId,
    };

    await expect(
      routing.settleExecution(failedCall, async () => {
        const placed = await routing.place({ agent: reviewer, flags, context: failedCall });
        routing.attach(contexts, {
          agentId: reviewer.id,
          context: failedCall,
          placement: placed,
          codeExecutionContext: placed.target?.context,
          toolContext: 'reviewer-on-buildbox',
        });
        const memberPlaced = await routing.place({ agent: member, flags, context: routedMember });
        routing.attach(contexts, {
          agentId: member.id,
          context: routedMember,
          placement: memberPlaced,
          codeExecutionContext: memberPlaced.target?.context,
          toolContext: 'member-on-buildbox',
        });
        expect(contexts.get(member.id)).toBe('member-on-buildbox');
        throw new Error('canceled');
      }),
    ).rejects.toThrow('canceled');

    expect(contexts.has(member.id)).toBe(false);
    expect(contexts.has(reviewer.id)).toBe(false);
  });

  it('keeps the per-agent tool context of a surviving parallel placement', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const contexts = new Map<string, string>();
    const select = async (toolContext: string, fail: boolean) => {
      const selected = call({ machine: 'buildbox' });
      const placement = await routing.place({ agent: reviewer, flags, context: selected });
      routing.attach(contexts, {
        agentId: reviewer.id,
        context: selected,
        placement,
        codeExecutionContext: placement.target?.context,
        toolContext,
      });
      return {
        settle: () =>
          routing.settleExecution(selected, async () => {
            if (fail) throw new Error('canceled');
          }),
      };
    };

    const first = await select('first', true);
    const second = await select('second', false);
    await second.settle();
    await expect(first.settle()).rejects.toThrow('canceled');
    expect(contexts.get(reviewer.id)).toBe('second');

    const third = await select('third', true);
    const fourth = await select('fourth', true);
    await expect(third.settle()).rejects.toThrow('canceled');
    await expect(fourth.settle()).rejects.toThrow('canceled');
    expect(contexts.get(reviewer.id)).toBe('second');
  });

  it('queues live target probes below the shared status poller limit', async () => {
    const machines = Array.from({ length: 12 }, (_, index) => machine(`m${index}`, `w-m${index}`));
    let inFlight = 0;
    let peak = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const workerId = /\/bridge\/workers\/([^/]+)\/status$/.exec(String(input))?.[1] ?? '';
      return new Response(
        JSON.stringify({
          protocolVersion: 1,
          workerId,
          online: true,
          ready: true,
          leaseExpiresInMs: 45_000,
          capabilities: {
            statefulWorkspace: true,
            sandboxProfile: 'native-srt',
            runtimes: ['bash'],
            workspaceTools: {
              protocolVersion: 1,
              operations: ['read_file'],
              workspaces: [{ id: `ws-${workerId}` }],
            },
          },
        }),
      );
    });

    const { targets } = await resolveSubagentCodeTargets({
      ...request,
      agentId: 'agent_reviewer',
      statefulSessions: true,
      environment: 'conversation',
      environmentId: 'm0',
      environmentIds: machines.map((entry) => entry.id),
      environments: [controlPlane, ...machines],
      persistedSelections: machines.map((entry) => ({
        environmentId: entry.id,
        workspaceId: `ws-w-${entry.id}`,
      })),
    });

    expect(targets).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('gives back a machine whose initialization landed elsewhere', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const routedCall = call({ machine: 'buildbox' });

    const placement = await routing.place({ agent: reviewer, flags, context: routedCall });
    expect(() =>
      routing.attach(new Map(), {
        agentId: reviewer.id,
        context: routedCall,
        placement,
        codeExecutionContext: { environmentId: 'laptop' },
        toolContext: 'laptop',
      }),
    ).toThrow();

    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'laptop' }) }),
    ).resolves.toMatchObject({ target: { environmentId: 'laptop' } });
  });

  it('offers and accepts no attached machine while run files are shared', async () => {
    const fetchSpy = serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>({ ...request, sharedRunFiles: true });

    await expect(routing.describe(reviewer, flags)).resolves.toEqual({});
    await expect(
      routing.place({ agent: reviewer, flags, context: call({ machine: 'buildbox' }) }),
    ).rejects.toMatchObject({ argument: 'machine', rejection: 'not_allowed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips queued target probes once the resolution is canceled', async () => {
    const fetchSpy = serveWorkers(allOnline);
    const controller = new AbortController();
    controller.abort(new Error('canceled'));

    await expect(resolveSubagentCodeTargets(params({ signal: controller.signal }))).rejects.toThrow(
      'canceled',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the tool context a committed placement installed over a pending one', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const contexts = new Map<string, string>();
    const pendingCall = call();
    const pending = await routing.place({ agent: reviewer, flags, context: pendingCall });
    routing.attach(contexts, {
      agentId: reviewer.id,
      context: pendingCall,
      placement: pending,
      codeExecutionContext: { environmentId: 'laptop' },
      toolContext: 'pending',
    });
    const shared = await routing.place({ agent: reviewer, flags, context: {} });
    routing.attach(contexts, {
      agentId: reviewer.id,
      context: {},
      placement: shared,
      codeExecutionContext: { environmentId: 'laptop' },
      toolContext: 'shared-member',
    });

    await expect(
      routing.settleExecution(pendingCall, async () => {
        throw new Error('canceled');
      }),
    ).rejects.toThrow('canceled');
    expect(contexts.get(reviewer.id)).toBe('shared-member');
  });

  it('attributes a workspace-only conflict to the workspace argument', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);

    await routing.place({ agent: reviewer, flags, context: call({ machine: 'laptop' }) });

    await expect(
      routing.place({ agent: reviewer, flags, context: call({ workspace: 'agents' }) }),
    ).rejects.toMatchObject({ argument: 'workspace', rejection: 'unavailable' });
  });

  it('keeps one machine per subagent for the whole request', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const contexts = new Map<string, string>();

    const first = await routing.place({
      agent: reviewer,
      flags,
      context: call({ machine: 'buildbox' }),
    });
    const later = await routing.place({ agent: reviewer, flags, context: call() });
    const moved = routing.place({ agent: reviewer, flags, context: call({ machine: 'laptop' }) });

    const writer = {
      id: 'agent_writer',
      code_environment_id: 'laptop',
      code_environment_ids: ['buildbox'],
    };
    const writerCall = call();
    const writerPlacement = await routing.place({ agent: writer, flags, context: writerCall });
    routing.attach(contexts, {
      agentId: writer.id,
      context: writerCall,
      placement: writerPlacement,
      codeExecutionContext: { environmentId: 'laptop' },
      toolContext: 'laptop',
    });
    const writerMoved = routing.place({
      agent: writer,
      flags,
      context: call({ machine: 'buildbox' }),
    });
    const writerSame = await routing.place({
      agent: writer,
      flags,
      context: call({ machine: 'laptop' }),
    });

    expect(first.target?.environmentId).toBe('buildbox');
    expect(later.target?.environmentId).toBe('buildbox');
    await expect(moved).rejects.toMatchObject({ argument: 'machine', rejection: 'unavailable' });
    expect(writerPlacement.target).toBeUndefined();
    await expect(writerMoved).rejects.toMatchObject({
      argument: 'machine',
      rejection: 'unavailable',
    });
    expect(writerSame.target?.environmentId).toBe('laptop');
  });

  it('refuses an unavailable default only when no per-call route applies', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting(request);

    await expect(
      routing.place({ agent: reviewer, flags, context: call(), unavailableReason: 'missing' }),
    ).rejects.toMatchObject({ name: 'CodeWorkspaceSelectionError', reason: 'missing' });
    await expect(
      routing.place({
        agent: reviewer,
        flags,
        context: call({ machine: 'buildbox' }),
        unavailableReason: 'missing',
      }),
    ).resolves.toMatchObject({ target: { environmentId: 'buildbox' } });
  });

  it('passes a routed parent machine to its children, through agents without code', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const contexts = new Map<string, string>();
    const routeAndAttach = async (
      agent: SubagentCodeAgent,
      context: ReturnType<typeof call>,
      agentFlags: SubagentCodeFlags = flags,
    ) => {
      const placement = await routing.place({ agent, flags: agentFlags, context });
      routing.attach(contexts, {
        agentId: agent.id,
        context,
        placement,
        codeExecutionContext: placement.target?.context,
        toolContext: placement.agent.code_environment_id ?? 'default',
      });
      return placement;
    };

    const parentCall = call({ machine: 'buildbox' });
    await routeAndAttach(reviewer, parentCall);
    const writerCall = call(undefined, parentCall.executionId);
    const writer = await routeAndAttach(
      { id: 'agent_writer', code_environment_id: 'laptop' },
      writerCall,
      { statefulCodeSessions: false },
    );
    const grandchild = await routeAndAttach(
      { id: 'agent_tester', code_environment_id: 'laptop', code_environment_ids: ['buildbox'] },
      call(undefined, writerCall.executionId),
    );
    const unreachable = await routing.place({
      agent: { id: 'agent_docs', code_environment_id: 'laptop' },
      flags,
      context: call(undefined, parentCall.executionId),
    });
    const explicit = await routing.place({
      agent: {
        id: 'agent_lint',
        code_environment_id: 'laptop',
        code_environment_ids: ['buildbox'],
      },
      flags,
      context: call({ machine: 'laptop' }, parentCall.executionId),
    });

    expect(writer).toEqual({
      agent: { id: 'agent_writer', code_environment_id: 'laptop' },
      childEnvironmentId: 'buildbox',
    });
    expect(grandchild.target?.environmentId).toBe('buildbox');
    expect(grandchild.agent.code_environment_ids).toEqual(['buildbox']);
    expect(unreachable.target).toBeUndefined();
    expect(explicit.target?.environmentId).toBe('laptop');
  });

  it('passes a routed parent machine on from a self-spawned run it never placed', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const parentCall = call({ machine: 'buildbox' });
    const placement = await routing.place({ agent: reviewer, flags, context: parentCall });
    routing.attach(new Map(), {
      agentId: reviewer.id,
      context: parentCall,
      placement,
      codeExecutionContext: placement.target?.context,
      toolContext: 'buildbox',
    });
    const tester = {
      id: 'agent_tester',
      code_environment_id: 'laptop',
      code_environment_ids: ['buildbox'],
    };

    const fromSelfRun = await routing.place({
      agent: tester,
      flags,
      context: { ...call(undefined, 'self-run-never-placed'), parentAgentId: reviewer.id },
    });
    const fromUnroutedAgent = await routing.place({
      agent: { ...tester, id: 'agent_docs' },
      flags,
      context: { ...call(undefined, 'other-run'), parentAgentId: 'agent_unrouted' },
    });

    expect(fromSelfRun.target?.environmentId).toBe('buildbox');
    expect(fromUnroutedAgent.target).toBeUndefined();
  });

  it('passes a machine on from a self-spawned run of an agent without code', async () => {
    serveWorkers(allOnline);
    const routing = createSubagentCodeRouting<string>(request);
    const placeAndAttach = async (
      agent: SubagentCodeAgent,
      context: ReturnType<typeof call>,
      agentFlags: SubagentCodeFlags = flags,
    ) => {
      const placement = await routing.place({ agent, flags: agentFlags, context });
      routing.attach(new Map(), {
        agentId: agent.id,
        context,
        placement,
        codeExecutionContext: placement.target?.context,
        toolContext: 'context',
      });
    };
    const writer = { id: 'agent_writer', code_environment_id: 'laptop' };
    const tester = {
      id: 'agent_tester',
      code_environment_id: 'laptop',
      code_environment_ids: ['buildbox'],
    };
    const fromWriterSelfRun = (id: string) =>
      routing.place({
        agent: { ...tester, id },
        flags,
        context: { ...call(undefined, `self-run-${Math.random()}`), parentAgentId: writer.id },
      });

    const parentCall = call({ machine: 'buildbox' });
    await placeAndAttach(reviewer, parentCall);
    const failedWriterCall = call(undefined, parentCall.executionId);
    await expect(
      routing.settleExecution(failedWriterCall, async () => {
        await placeAndAttach(writer, failedWriterCall, { statefulCodeSessions: false });
        throw new Error('the writer failed to resolve');
      }),
    ).rejects.toThrow('the writer failed to resolve');
    expect((await fromWriterSelfRun('agent_after_failure')).target).toBeUndefined();

    const writerCall = call(undefined, parentCall.executionId);
    await routing.settleExecution(writerCall, () =>
      placeAndAttach(writer, writerCall, { statefulCodeSessions: false }),
    );
    await expect(fromWriterSelfRun('agent_after_success')).resolves.toMatchObject({
      target: { environmentId: 'buildbox' },
    });

    const lintCall = call({ machine: 'laptop' });
    await placeAndAttach({ ...tester, id: 'agent_lint' }, lintCall);
    const secondWriterCall = call(undefined, lintCall.executionId);
    await routing.settleExecution(secondWriterCall, () =>
      placeAndAttach(writer, secondWriterCall, { statefulCodeSessions: false }),
    );
    const ambiguous = await routing.place({
      agent: { ...tester, id: 'agent_docs' },
      flags,
      context: { ...call(undefined, 'self-run-ambiguous'), parentAgentId: writer.id },
    });
    expect(ambiguous.target).toBeUndefined();
  });

  it('rejects a revoked allowlist entry and a principal that lost the machine', async () => {
    serveWorkers(allOnline);

    await expect(
      createSubagentCodeRouting(request).place({
        agent: { ...reviewer, code_environment_ids: [] },
        flags,
        context: call({ machine: 'buildbox' }),
      }),
    ).rejects.toMatchObject({ argument: 'machine', rejection: 'not_allowed' });
    await expect(
      createSubagentCodeRouting({
        ...request,
        environments: environments.filter((environment) => environment.id !== 'buildbox'),
      }).place({ agent: reviewer, flags, context: call({ machine: 'buildbox' }) }),
    ).rejects.toMatchObject({ argument: 'machine', rejection: 'not_allowed' });
  });

  it('binds every per-call choice into paused-approval targets', async () => {
    serveWorkers(allOnline);
    const description = await createSubagentCodeRouting(request).describe(reviewer, flags);
    const descriptor = {
      id: reviewer.id,
      codeExecutionContext: description.codeExecutionChoices?.[1],
      codeExecutionChoices: description.codeExecutionChoices,
    };

    const binding = captureCodeExecutionApprovalBinding([descriptor]);
    const changedChoice = {
      ...descriptor,
      codeExecutionChoices: [
        { ...description.codeExecutionChoices![0], bridgeWorkerId: 'w-replaced' },
        description.codeExecutionChoices![1],
      ],
    };

    const changedDefault = {
      ...descriptor,
      codeExecutionContext: { ...descriptor.codeExecutionContext!, bridgeWorkerId: 'w-replaced' },
    };

    expect(binding?.targets).toHaveLength(1);
    expect(() => assertCodeExecutionApprovalBinding(binding, [descriptor])).not.toThrow();
    expect(() => assertCodeExecutionApprovalBinding(binding, [changedChoice])).toThrow(
      'The attached code environment changed',
    );
    expect(() => assertCodeExecutionApprovalBinding(binding, [changedDefault])).toThrow(
      'The attached code environment changed',
    );
    expect(
      captureCodeExecutionApprovalBinding([
        { id: reviewer.id, codeExecutionContext: descriptor.codeExecutionContext },
      ])?.targets,
    ).toHaveLength(1);
  });

  it('folds many per-call choices into one approval target per agent', () => {
    const choice = (environmentId: string) => ({
      baseUrl: BASE_URL,
      codeSessionKey: `session-${environmentId}`,
      executionProfile: 'stateful' as const,
      statefulSessions: true,
      environmentId,
      environmentType: 'attached' as const,
    });
    const agents = Array.from({ length: 5 }, (_, agentIndex) => ({
      id: `agent_${agentIndex}`,
      codeExecutionChoices: Array.from({ length: 32 }, (_, index) => choice(`m${index}`)),
    }));

    const binding = captureCodeExecutionApprovalBinding(agents);

    expect(binding?.targets).toHaveLength(5);
    expect(() => assertCodeExecutionApprovalBinding(binding, agents)).not.toThrow();
  });
});

describe('unavailable subagents with per-call choices', () => {
  const hostArgs = { machine: { description: 'Machine.', enum: ['buildbox'] } };

  it('keeps a routable subagent callable and tells the parent to pick a machine', async () => {
    const resolve = jest.fn(async () => 'config');

    const guarded = guardRoutableSubagent({
      description: 'Reviews PRs.',
      codeWorkspaceUnavailable: 'missing',
      subagentHostArgs: hostArgs,
      resolve,
    });

    expect(guarded.description).toContain('Unavailable in this conversation');
    expect(guarded.description).toContain('Pass "machine"');
    await expect(guarded.resolve({})).resolves.toBe('config');
  });

  it('guards a subagent without choices exactly as before', async () => {
    const resolve = jest.fn(async () => 'config');

    const guarded = guardRoutableSubagent({
      description: 'Reviews PRs.',
      codeWorkspaceUnavailable: 'missing',
      resolve,
    });
    const available = guardRoutableSubagent({
      description: 'Reviews PRs.',
      subagentHostArgs: hostArgs,
      resolve,
    });

    await expect(guarded.resolve({})).rejects.toMatchObject({ reason: 'missing' });
    expect(guarded.description).not.toContain('Pass "machine"');
    expect(resolve).not.toHaveBeenCalled();
    expect(available).toEqual({ description: 'Reviews PRs.', resolve });
  });
});

describe('run-wide gates for per-call choices', () => {
  const choice = {
    baseUrl: BASE_URL,
    codeSessionKey: 'execute_code:stateful:buildbox-session',
    executionProfile: 'stateful' as const,
    executionRouteKey: 'stateful:buildbox',
    statefulSessions: true,
    environmentId: 'buildbox',
    environmentType: 'attached' as const,
  };
  const parent = {
    id: 'agent_parent',
    lazySubagentConfigs: [
      { id: 'agent_reviewer', codeEnvAvailable: false, codeExecutionChoices: [choice] },
    ],
  };

  it('installs the attached-machine policy for a child that can only be routed there', () => {
    expect([...collectAttachedCodeEnvironmentAgentIds([parent])]).toEqual(['agent_reviewer']);
  });

  it('primes skill files for every per-call route', () => {
    expect(collectCodeExecutionProfileRoutes([parent])).toEqual([
      { codeExecutionContext: choice, codeSessionKeys: [choice.codeSessionKey] },
    ]);
  });
});

describe('subagent tool contexts', () => {
  const executionContext = (...entries: Array<[string, string]>): SubagentExecutionContext => ({
    rootRunId: 'root',
    hookSessionId: 'hooks',
    depth: entries.length,
    ancestry: entries.map(([subagentRunId, subagentAgentId]) => ({
      subagentRunId,
      subagentType: subagentAgentId,
      subagentKind: 'agent' as const,
      subagentAgentId,
      parentRunId: 'root',
    })),
  });
  const target = (environmentId: string) => ({
    environmentId,
    workspaceId: `${environmentId}-workspace`,
    context: {
      baseUrl: BASE_URL,
      codeSessionKey: environmentId,
      executionProfile: 'stateful' as const,
      statefulSessions: true,
      environmentId,
    },
  });
  const agent = { id: 'agent_reviewer' };
  const attach = (
    routing: ReturnType<typeof createSubagentCodeRouting<string>>,
    contexts: Map<string, string>,
    executionId: string,
    machine?: string,
  ) =>
    routing.attach(contexts, {
      agentId: agent.id,
      context: { executionId },
      placement: machine == null ? { agent } : { agent, target: target(machine) },
      codeExecutionContext: { environmentId: machine ?? 'laptop' },
      toolContext: machine ?? 'laptop',
    });

  it('keeps concurrent siblings of one agent on their own routes', () => {
    const routing = createSubagentCodeRouting<string>({});
    const contexts = new Map<string, string>();

    attach(routing, contexts, 'run-a', 'buildbox');
    attach(routing, contexts, 'run-b');
    attach(routing, contexts, 'run-c', 'spare');

    expect(routing.getToolContext(agent.id, executionContext(['run-a', agent.id]))).toBe(
      'buildbox',
    );
    expect(routing.getToolContext(agent.id, executionContext(['run-c', agent.id]))).toBe('spare');
    expect(routing.getToolContext(agent.id, executionContext(['run-b', agent.id]))).toBe(undefined);
    expect(contexts.get(agent.id)).toBe('laptop');
    expect(routing.isRouted('run-a')).toBe(true);
    expect(routing.isRouted('run-b')).toBe(false);
  });

  it('lets an unplaced self-spawn defer to the routed run that spawned it', () => {
    const routing = createSubagentCodeRouting<string>({});
    attach(routing, new Map(), 'run-parent', 'buildbox');

    expect(
      routing.getToolContext(
        agent.id,
        executionContext(['run-parent', agent.id], ['run-self', agent.id]),
      ),
    ).toBe('buildbox');
  });

  it('matches the innermost execution of the asking agent only', () => {
    const routing = createSubagentCodeRouting<string>({});
    attach(routing, new Map(), 'run-parent', 'buildbox');

    expect(
      routing.getToolContext(
        'agent_helper',
        executionContext(['run-parent', agent.id], ['run-child', 'agent_helper']),
      ),
    ).toBeUndefined();
    expect(routing.getToolContext(agent.id, undefined)).toBeUndefined();
    expect(
      routing.getToolContext('agent_other', executionContext(['run-parent', agent.id])),
    ).toBeUndefined();
  });

  it('seeds the per-agent entry from a routed child only when none exists', () => {
    const routing = createSubagentCodeRouting<string>({});
    const contexts = new Map<string, string>();

    attach(routing, contexts, 'run-a', 'buildbox');

    expect(contexts.get(agent.id)).toBe('buildbox');
  });

  it('fails closed when initialization did not land on the routed machine', () => {
    const routing = createSubagentCodeRouting<string>({});

    expect(() =>
      routing.attach(new Map(), {
        agentId: agent.id,
        context: { executionId: 'run-a' },
        placement: { agent, target: target('buildbox') },
        codeExecutionContext: { environmentId: 'laptop' },
        toolContext: 'laptop',
      }),
    ).toThrow();
    expect(routing.isRouted('run-a')).toBe(false);
  });
});
