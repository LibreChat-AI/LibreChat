import fs from 'node:fs';
import path from 'node:path';
import { Tools } from 'librechat-data-provider';
import type { CodeEnvironmentConfig } from '~/agents/execution';
import type { AgentCodeRouteAgent } from './agent';
import {
  withRequestCodeInputs,
  resolveAgentCodeFlags,
  resolveAgentCodeExecution,
  optsOutOfAttachedCodeEnvironment,
} from './agent';
import { resolveCodeExecutionWorkspaceContext } from './capabilities';
import { CodeWorkspaceSelectionError } from './errors';

const SKYNET = 'code-yuwoQAAPhY1WMaDD6oIk';

const environments: CodeEnvironmentConfig[] = [
  {
    id: 'managed',
    name: 'Managed',
    type: 'managed',
    baseURL: 'https://managed.example/v1',
    owner: 'deployment',
  },
  {
    id: SKYNET,
    name: 'Skynet',
    type: 'attached',
    baseURL: 'https://bridge.example/v1/',
    workerId: 'worker-skynet',
    owner: 'deployment',
  },
];

/** The incident agent: stateful code sessions on an attached default machine. */
const terra: AgentCodeRouteAgent = {
  id: 'agent_nw3URLZi7gDH4kDgHGsWF',
  tools: [Tools.execute_code],
  stateful_code_sessions: true,
  stateful_code_environment: 'conversation',
  code_environment_id: SKYNET,
};

const baseParams = {
  codeExecutionAvailable: true,
  statefulSessionsAvailable: true,
  environments,
  userId: 'user-1',
  conversationId: 'eb29d36a-1224-57ec-979b-5ec7d3475fa5',
};

describe('resolveAgentCodeExecution', () => {
  it('runs an attached-default agent on the managed default route in a no-workspace conversation', async () => {
    const resolved = resolveAgentCodeExecution({
      ...baseParams,
      agent: terra,
      requestBody: { codeEnvironmentMode: 'without_attached' },
    });

    expect(resolved).toMatchObject({
      attachedEnvironmentOptOut: true,
      codeEnvAvailable: false,
      statefulSessions: false,
    });
    expect(resolved.context).toEqual(
      expect.objectContaining({ executionProfile: 'default', statefulSessions: false }),
    );
    expect(resolved.context.environmentType).toBeUndefined();
    await expect(
      resolveCodeExecutionWorkspaceContext({ context: resolved.context, environments }),
    ).resolves.toBe(resolved.context);
  });

  it('still requires a workspace selection when the conversation runs on attached machines', async () => {
    for (const requestBody of [{ codeEnvironmentMode: 'attached' as const }, {}]) {
      const resolved = resolveAgentCodeExecution({ ...baseParams, agent: terra, requestBody });

      expect(resolved).toMatchObject({
        attachedEnvironmentOptOut: false,
        codeEnvAvailable: true,
        statefulSessions: true,
      });
      expect(resolved.context).toEqual(
        expect.objectContaining({ environmentId: SKYNET, environmentType: 'attached' }),
      );
      await expect(
        resolveCodeExecutionWorkspaceContext({ context: resolved.context, environments }),
      ).rejects.toEqual(new CodeWorkspaceSelectionError('required'));
    }
  });

  it('keeps a managed stateful agent on its machine in a no-workspace conversation', () => {
    const resolved = resolveAgentCodeExecution({
      ...baseParams,
      agent: { ...terra, code_environment_id: 'managed' },
      requestBody: { codeEnvironmentMode: 'without_attached' },
    });

    expect(resolved).toMatchObject({
      attachedEnvironmentOptOut: false,
      codeEnvAvailable: true,
      statefulSessions: true,
    });
    expect(resolved.context).toEqual(
      expect.objectContaining({ environmentId: 'managed', environmentType: 'managed' }),
    );
  });

  it('gives no code to an agent that does not list execute_code or lacks the grant', () => {
    const withoutTool = resolveAgentCodeFlags({ ...baseParams, agent: { ...terra, tools: [] } });
    const withoutGrant = resolveAgentCodeFlags({
      ...baseParams,
      agent: terra,
      codeExecutionAvailable: false,
    });
    const withoutAgent = resolveAgentCodeFlags({ ...baseParams, agent: undefined });

    for (const flags of [withoutTool, withoutGrant, withoutAgent]) {
      expect(flags).toMatchObject({ codeEnvAvailable: false, statefulSessions: false });
    }
  });

  it('enforces the stateful environment policy only for agents that run stateful code', () => {
    expect(() =>
      resolveAgentCodeFlags({
        ...baseParams,
        agent: terra,
        allowedStatefulCodeEnvironments: ['user'],
      }),
    ).toThrow('Stateful code environment is not allowed by this deployment: conversation');
    expect(
      resolveAgentCodeFlags({
        ...baseParams,
        agent: terra,
        requestBody: { codeEnvironmentMode: 'without_attached' },
        allowedStatefulCodeEnvironments: ['user'],
      }).statefulSessions,
    ).toBe(false);
  });

  it('keeps an opt-out initialization decided for a caller holding a partial agent record', () => {
    const stripped = { id: terra.id, tools: terra.tools };

    expect(resolveAgentCodeFlags({ ...baseParams, agent: stripped }).codeEnvAvailable).toBe(true);
    expect(
      resolveAgentCodeFlags({ ...baseParams, agent: stripped, attachedEnvironmentOptOut: true }),
    ).toMatchObject({ attachedEnvironmentOptOut: true, codeEnvAvailable: false });
    expect(
      resolveAgentCodeFlags({
        ...baseParams,
        agent: terra,
        requestBody: { codeEnvironmentMode: 'without_attached' },
        attachedEnvironmentOptOut: false,
      }).attachedEnvironmentOptOut,
    ).toBe(true);
  });

  it('applies the conversation rule to a context initialization already resolved', () => {
    const resolvedContext = resolveAgentCodeExecution({ ...baseParams, agent: terra }).context;
    const reused = resolveAgentCodeExecution({
      ...baseParams,
      agent: terra,
      requestBody: { codeEnvironmentMode: 'without_attached' },
      resolvedContext,
    });

    expect(reused.context).toBe(resolvedContext);
    expect(reused.codeEnvAvailable).toBe(false);
  });

  it('opts out an unresolvable stateful route only when no implicit managed route exists', () => {
    const agent = { ...terra, code_environment_id: undefined };
    const body = { codeEnvironmentMode: 'without_attached' as const };

    expect(optsOutOfAttachedCodeEnvironment(agent, body, [], false)).toBe(true);
    expect(optsOutOfAttachedCodeEnvironment(agent, body, [], true)).toBe(false);
    expect(optsOutOfAttachedCodeEnvironment(agent, {}, environments, false)).toBe(false);
  });

  it('keeps an implicit stateful agent on code only when the caller reports the route live', () => {
    const agent = { ...terra, code_environment_id: undefined };
    const params = {
      ...baseParams,
      agent,
      environments: [],
      requestBody: { codeEnvironmentMode: 'without_attached' as const },
    };

    expect(resolveAgentCodeFlags(params).codeEnvAvailable).toBe(false);
    expect(
      resolveAgentCodeFlags({ ...params, implicitStatefulRouteAvailable: true }).codeEnvAvailable,
    ).toBe(true);
  });
});

describe('withRequestCodeInputs', () => {
  afterEach(() => {
    delete process.env.CODE_ENVIRONMENT_DECISION_VERSION;
    delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
  });

  it('reports the deployment implicit stateful route rollout', () => {
    const request = {
      req: { body: {} },
      codeExecutionAvailable: true,
      statefulSessionsAvailable: true,
    };
    expect(withRequestCodeInputs(request).implicitStatefulRouteAvailable).toBe(false);

    process.env.CODE_ENVIRONMENT_DECISION_VERSION = '1';
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'https://stateful.example/v1';
    expect(withRequestCodeInputs(request).implicitStatefulRouteAvailable).toBe(true);
  });

  it('reads the admitted conversation, deployment machines and principal from the request', () => {
    const inheritance = new Map([[terra.id ?? '', SKYNET]]);
    const conversation = { codeWorkspaces: [{ environmentId: SKYNET, workspaceId: 'librechat' }] };
    const params = withRequestCodeInputs({
      req: {
        body: { codeEnvironmentMode: 'attached' },
        user: { id: 'user-1' } as never,
        config: {
          endpoints: {
            agents: { statefulCodeSessions: { environments, allowEnvironmentSelection: false } },
          },
        } as never,
        resolvedConversation: conversation,
        codeWorkspaceInheritance: inheritance,
      },
      agent: terra,
      codeExecutionAvailable: true,
      statefulSessionsAvailable: true,
      conversationId: 'convo-1',
    });

    expect(params).toEqual(
      expect.objectContaining({
        requestBody: { codeEnvironmentMode: 'attached' },
        conversation,
        environments,
        allowEnvironmentSelection: false,
        inheritedEnvironments: inheritance,
        userId: 'user-1',
        conversationId: 'convo-1',
      }),
    );
    expect(
      withRequestCodeInputs({
        req: { body: {}, user: { id: 'user-1' } as never },
        requestBody: { codeEnvironmentMode: 'without_attached' },
        codeExecutionAvailable: true,
        statefulSessionsAvailable: true,
        userId: 'tool-user',
      }),
    ).toEqual(
      expect.objectContaining({
        requestBody: { codeEnvironmentMode: 'without_attached' },
        userId: 'tool-user',
      }),
    );
  });
});

/**
 * Every server path that resolves an agent's code route must apply the conversation's
 * "No workspace" decision. The route primitives may only be called from the shared rule
 * and from callers that consume flags the rule already resolved.
 */
describe('agent code route invariant', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const roots = ['packages/api/src', 'api'].map((root) => path.join(repoRoot, root));
  const isSource = (file: string): boolean =>
    /\.(js|ts)$/.test(file) &&
    !/\.(spec|test)\.(js|ts)$/.test(file) &&
    !file.endsWith('.d.ts') &&
    !file.split(path.sep).includes('__tests__') &&
    !file.split(path.sep).includes('__mocks__');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return isSource(full) ? [full] : [];
    });

  const sources = roots.flatMap(walk).map((file) => ({
    file: path.relative(repoRoot, file).split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8'),
  }));
  const count = (text: string, call: string): number =>
    text.split(new RegExp(`\\b${call}\\(`)).length - 1;
  const callers = (call: string): string[] =>
    sources.filter(({ text }) => count(text, call) > 0).map(({ file }) => file);

  it('scans both server workspaces', () => {
    expect(sources.some(({ file }) => file === 'api/server/services/ToolService.js')).toBe(true);
    expect(sources.some(({ file }) => file === 'packages/api/src/code/agent.ts')).toBe(true);
  });

  it('resolves base code routes only through the shared rule', () => {
    expect(callers('resolveCodeExecutionContext').sort()).toEqual([
      /** Fallbacks over flags `initializeAgent` already resolved; they never pass a machine. */
      'packages/api/src/agents/codeFilesSession.ts',
      'packages/api/src/agents/execution.ts',
      'packages/api/src/agents/prewarm.ts',
      'packages/api/src/code/agent.ts',
      /** Per-call subagent targets: gated on the rule's flags and the conversation's mode. */
      'packages/api/src/code/targets.ts',
    ]);
    expect(callers('optsOutOfAttachedCodeEnvironment')).toEqual(['packages/api/src/code/agent.ts']);
  });

  it('binds workspaces only to routes the shared rule resolved', () => {
    const routePrimitives = [
      'packages/api/src/code/capabilities.ts',
      'packages/api/src/code/targets.ts',
    ];
    const outsideRule = sources.filter(
      ({ file, text }) =>
        count(text, 'resolveCodeExecutionWorkspaceContext') > 0 && !routePrimitives.includes(file),
    );

    expect(outsideRule.map(({ file }) => file).sort()).toEqual([
      'api/server/services/Endpoints/agents/initialize.js',
      'api/server/services/ToolService.js',
    ]);
    for (const { file, text } of outsideRule) {
      expect({
        file,
        unguarded:
          count(text, 'resolveCodeExecutionWorkspaceContext') >
          count(text, 'resolveAgentCodeExecution'),
      }).toEqual({ file, unguarded: false });
    }
  });
});
