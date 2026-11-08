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

describe('stateful default profile setting', () => {
  const toggleOff: AgentCodeRouteAgent = { ...terra, stateful_code_sessions: false };
  const toggleUnset: AgentCodeRouteAgent = { ...terra, stateful_code_sessions: undefined };
  const withoutAttached = { codeEnvironmentMode: 'without_attached' as const };
  /** An implicit machine: no id and no attached default, so the setting applies. */
  const implicit = (a: AgentCodeRouteAgent): AgentCodeRouteAgent => ({
    ...a,
    code_environment_id: undefined,
  });

  afterEach(() => {
    delete process.env.LIBRECHAT_CODE_DEFAULT_PROFILE;
  });

  it('runs a toggle-off or unset agent on a managed machine stateful when the setting is stateful', () => {
    process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';
    const managedParams = { ...baseParams, environments: [{ ...environments[0], default: true }] };

    for (const agent of [toggleOff, toggleUnset].map((a) => ({
      ...a,
      code_environment_id: undefined,
    }))) {
      expect(resolveAgentCodeFlags({ ...managedParams, agent }).statefulSessions).toBe(true);
      expect(resolveAgentCodeExecution({ ...managedParams, agent }).context).toEqual(
        expect.objectContaining({ executionProfile: 'stateful', statefulSessions: true }),
      );
    }
  });

  it('keeps a toggle-off or unset agent on the default profile when the setting is unset or default', () => {
    for (const setting of [undefined, 'default']) {
      if (setting == null) delete process.env.LIBRECHAT_CODE_DEFAULT_PROFILE;
      else process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = setting;
      for (const agent of [toggleOff, toggleUnset].map(implicit)) {
        expect(resolveAgentCodeFlags({ ...baseParams, agent }).statefulSessions).toBe(false);
        expect(resolveAgentCodeExecution({ ...baseParams, agent }).context).toEqual(
          expect.objectContaining({ executionProfile: 'default', statefulSessions: false }),
        );
      }
      expect(resolveAgentCodeFlags({ ...baseParams, agent: terra }).statefulSessions).toBe(true);
    }
  });

  it('picks the default profile when the deployment capability is off, whatever the setting', () => {
    process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

    expect(
      resolveAgentCodeFlags({
        ...baseParams,
        agent: implicit(toggleOff),
        statefulSessionsAvailable: false,
      }),
    ).toMatchObject({ codeEnvAvailable: true, statefulSessions: false });
  });

  it('gives no stateful sessions without execute_code or the grant, whatever the setting', () => {
    process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

    expect(
      resolveAgentCodeFlags({ ...baseParams, agent: { ...implicit(toggleOff), tools: [] } })
        .statefulSessions,
    ).toBe(false);
    expect(
      resolveAgentCodeFlags({
        ...baseParams,
        agent: implicit(toggleOff),
        codeExecutionAvailable: false,
      }).statefulSessions,
    ).toBe(false);
  });

  it('never opts a toggle-off agent with an attached default out under the setting', () => {
    for (const setting of [undefined, 'default', 'stateful']) {
      if (setting == null) delete process.env.LIBRECHAT_CODE_DEFAULT_PROFILE;
      else process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = setting;
      expect(optsOutOfAttachedCodeEnvironment(toggleOff, withoutAttached, environments)).toBe(
        false,
      );
    }
  });

  it('keeps code on a toggle-off agent when the capability is off or no stateful route exists', () => {
    process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';
    const params = {
      agent: implicit(toggleOff),
      requestBody: withoutAttached,
      codeExecutionAvailable: true,
    };

    expect(resolveAgentCodeFlags({ ...params, statefulSessionsAvailable: false })).toMatchObject({
      attachedEnvironmentOptOut: false,
      codeEnvAvailable: true,
      statefulSessions: false,
    });
    expect(
      resolveAgentCodeFlags({
        ...params,
        agent: implicit(toggleOff),
        statefulSessionsAvailable: true,
      }),
    ).toMatchObject({
      attachedEnvironmentOptOut: false,
      codeEnvAvailable: true,
      statefulSessions: true,
    });
  });

  it('keeps a toggle-off agent on an attached machine on the default profile under the setting', () => {
    process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

    for (const requestBody of [withoutAttached, {}]) {
      expect(resolveAgentCodeFlags({ ...baseParams, agent: toggleOff, requestBody })).toMatchObject(
        {
          attachedEnvironmentOptOut: false,
          codeEnvAvailable: true,
          statefulSessions: false,
        },
      );
    }
  });

  it('runs a toggle-off agent on a managed default stateful under the setting', () => {
    process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';
    const managedDefault: CodeEnvironmentConfig[] = [{ ...environments[0], default: true }];

    expect(
      resolveAgentCodeFlags({
        ...baseParams,
        environments: managedDefault,
        agent: { ...toggleOff, code_environment_id: undefined },
      }),
    ).toMatchObject({ codeEnvAvailable: true, statefulSessions: true });
    expect(
      resolveAgentCodeFlags({
        ...baseParams,
        environments: managedDefault,
        agent: { ...toggleOff, code_environment_id: 'managed' },
      }),
    ).toMatchObject({ codeEnvAvailable: true, statefulSessions: true });
  });

  describe('allowed stateful scopes under the setting', () => {
    const settingForced = implicit({ ...toggleOff, stateful_code_environment: undefined });

    it('keeps base behaviour when the setting-forced scope is not allowed', () => {
      process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

      expect(
        resolveAgentCodeFlags({
          ...baseParams,
          agent: settingForced,
          allowedStatefulCodeEnvironments: ['conversation'],
        }),
      ).toMatchObject({ codeEnvAvailable: true, statefulSessions: false });
    });

    it('applies the setting when the setting-forced scope is allowed', () => {
      process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

      expect(
        resolveAgentCodeFlags({
          ...baseParams,
          agent: settingForced,
          allowedStatefulCodeEnvironments: ['user'],
        }).statefulSessions,
      ).toBe(true);
    });

    it('still refuses an explicit stateful agent outside the allowed scopes', () => {
      process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

      expect(() =>
        resolveAgentCodeFlags({
          ...baseParams,
          agent: { ...settingForced, stateful_code_sessions: true },
          allowedStatefulCodeEnvironments: ['conversation'],
        }),
      ).toThrow('Stateful code environment is not allowed by this deployment: user');
    });
  });

  describe('toggle-off agent whose code environment is gone', () => {
    const staleMachines: CodeEnvironmentConfig[] = [
      {
        id: 'm1',
        name: 'Machine',
        type: 'attached',
        baseURL: 'https://bridge.example/v1/',
        workerId: 'worker-m1',
        owner: 'deployment',
        default: true,
      },
    ];
    const staleAgent: AgentCodeRouteAgent = {
      ...toggleOff,
      code_environment_id: 'gone',
    };
    const staleParams = {
      ...baseParams,
      environments: staleMachines,
      agent: staleAgent,
      requestBody: withoutAttached,
    };

    it('keeps code on the default profile in a no-workspace conversation under the setting', () => {
      process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

      expect(resolveAgentCodeFlags(staleParams)).toMatchObject({
        attachedEnvironmentOptOut: false,
        codeEnvAvailable: true,
        statefulSessions: false,
      });
      expect(
        resolveAgentCodeFlags({
          ...staleParams,
          agent: { ...staleAgent, stateful_code_sessions: true },
        }),
      ).toMatchObject({ attachedEnvironmentOptOut: true, codeEnvAvailable: false });
    });

    it('resolves its execution without throwing under the setting', () => {
      process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

      expect(resolveAgentCodeExecution(staleParams).context).toEqual(
        expect.objectContaining({ executionProfile: 'default', statefulSessions: false }),
      );
    });

    it('keeps code on the default profile when the deployment capability is off', () => {
      process.env.LIBRECHAT_CODE_DEFAULT_PROFILE = 'stateful';

      expect(
        resolveAgentCodeFlags({
          ...baseParams,
          agent: implicit(toggleOff),
          requestBody: withoutAttached,
          statefulSessionsAvailable: false,
        }),
      ).toMatchObject({
        attachedEnvironmentOptOut: false,
        codeEnvAvailable: true,
        statefulSessions: false,
      });
    });
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
