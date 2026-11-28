import {
  AGENT_WORKSPACE_ATTACHED_ENVIRONMENT_ERROR,
  agentCodeEnvironmentErrorResponse,
  isActiveAgentWorkspaceConfiguration,
  reconcileAgentWorkspaceDefault,
  resolveAgentWorkspaceRestoreConfiguration,
  validateAgentWorkspaceDefaultBinding,
  validateAgentCodeEnvironmentAllowlist,
  validateStatefulCodeEnvironment,
} from './workspace';

describe('restored agent workspace configuration', () => {
  it('inherits persistent session fields and clears omitted binding fields', () => {
    const restored = resolveAgentWorkspaceRestoreConfiguration({
      version: {},
      current: {
        stateful_code_sessions: true,
        stateful_code_environment: 'conversation',
        code_environment_id: 'removed-vm',
        code_workspace_id: 'project-a',
      },
    });

    expect(restored).toEqual({
      stateful_code_sessions: true,
      stateful_code_environment: 'conversation',
      code_environment_id: undefined,
      code_workspace_id: undefined,
      code_environment_ids: undefined,
    });
    expect(isActiveAgentWorkspaceConfiguration(restored)).toBe(true);
  });

  it('uses explicit historical session and binding fields', () => {
    const restored = resolveAgentWorkspaceRestoreConfiguration({
      version: {
        stateful_code_sessions: false,
        stateful_code_environment: 'user',
        code_environment_id: 'removed-vm',
        code_workspace_id: 'project-a',
      },
      current: {
        stateful_code_sessions: true,
        stateful_code_environment: 'conversation',
      },
    });

    expect(restored).toEqual({
      stateful_code_sessions: false,
      stateful_code_environment: 'user',
      code_environment_id: 'removed-vm',
      code_workspace_id: 'project-a',
      code_environment_ids: undefined,
    });
    expect(isActiveAgentWorkspaceConfiguration(restored)).toBe(false);
  });
});

describe('reconcileAgentWorkspaceDefault', () => {
  it('clears a stale default when the attached environment changes', () => {
    expect(
      reconcileAgentWorkspaceDefault({
        update: { code_environment_id: 'machine-b' },
        request: { code_environment_id: 'machine-b' },
        currentEnvironmentId: 'machine-a',
      }),
    ).toEqual({ code_environment_id: 'machine-b', code_workspace_id: '' });
  });

  it('preserves an explicit replacement default', () => {
    expect(
      reconcileAgentWorkspaceDefault({
        update: { code_environment_id: 'machine-b', code_workspace_id: 'project-b' },
        request: { code_environment_id: 'machine-b', code_workspace_id: 'project-b' },
        currentEnvironmentId: 'machine-a',
      }),
    ).toEqual({ code_environment_id: 'machine-b', code_workspace_id: 'project-b' });
  });

  it('does not clear the default when an unchanged environment is resubmitted', () => {
    expect(
      reconcileAgentWorkspaceDefault({
        update: { code_environment_id: 'machine-a' },
        request: { code_environment_id: 'machine-a' },
        currentEnvironmentId: 'machine-a',
      }),
    ).toEqual({ code_environment_id: 'machine-a' });
  });
});

describe('agent machine allowlist authorization', () => {
  const config = (maximum = 32) =>
    ({
      endpoints: {
        agents: {
          statefulCodeSessions: {
            maxEnvironmentChoices: maximum,
            environments: [
              { id: 'authorized', type: 'attached', baseURL: 'https://code.test' },
              { id: 'managed', type: 'managed' },
              { id: 'control-plane', type: 'attached', pairing: { allowPrincipalWorkers: true } },
            ],
          },
        },
      },
    }) as Parameters<typeof validateAgentCodeEnvironmentAllowlist>[0];
  it('authorizes each additional machine with the loaded principal-scoped config', () => {
    expect(validateAgentCodeEnvironmentAllowlist(config(), ['authorized'])).toEqual({ ok: true });
  });
  it.each(['another-principals-machine', 'managed', 'control-plane'])(
    'refuses %s before reservations even without a default or active sessions',
    (id) => {
      const result = validateStatefulCodeEnvironment(config(), {
        enabled: false,
        environmentIds: [id],
      });
      expect(result).toEqual({
        ok: false,
        error: { code: 'code_environment_choices_unauthorized' },
      });
      if (!result.ok) {
        expect(agentCodeEnvironmentErrorResponse(result.error)).toEqual({
          status: 403,
          body: {
            error: 'One or more agent machine choices are not authorized attached environments',
          },
        });
      }
    },
  );
  it('enforces the deployment limit before scanning any candidate IDs', () => {
    const result = validateAgentCodeEnvironmentAllowlist(config(1), ['authorized', 'missing']);
    expect(result).toEqual({
      ok: false,
      error: { code: 'code_environment_choices_exceeded', details: { maximum: 1 } },
    });
    if (!result.ok) {
      expect(agentCodeEnvironmentErrorResponse(result.error)).toEqual({
        status: 400,
        body: { error: 'Agent machine choices exceed the configured maximum of 1' },
      });
    }
  });
  it('allows removing choices and unrelated edits without reauthorizing inaccessible stored choices', () => {
    expect(validateAgentCodeEnvironmentAllowlist(config(), [])).toEqual({ ok: true });
    expect(validateAgentCodeEnvironmentAllowlist(config(), undefined)).toEqual({ ok: true });
  });
  it('restores a version list instead of inheriting current machine privileges', () => {
    expect(
      resolveAgentWorkspaceRestoreConfiguration({
        version: { code_environment_ids: ['authorized'] },
        current: { code_environment_ids: ['revoked'] },
      }).code_environment_ids,
    ).toEqual(['authorized']);
    expect(
      resolveAgentWorkspaceRestoreConfiguration({
        version: {},
        current: { code_environment_ids: ['revoked'] },
      }).code_environment_ids,
    ).toBeUndefined();
  });
});

describe('validateAgentWorkspaceDefaultBinding', () => {
  const environments = [
    { id: 'attached-vm', type: 'attached' },
    { id: 'managed-runtime', type: 'managed' },
  ];

  it('accepts a new default bound to an explicit attached environment', () => {
    expect(
      validateAgentWorkspaceDefaultBinding({
        workspaceId: 'project-a',
        environmentId: 'attached-vm',
        environments,
      }),
    ).toEqual({ valid: true });
  });

  it.each([
    ['an omitted environment', undefined],
    ['a managed environment', 'managed-runtime'],
    ['an unconfigured environment', 'missing-vm'],
  ])('rejects a new default bound to %s', (_label, environmentId) => {
    expect(
      validateAgentWorkspaceDefaultBinding({
        workspaceId: 'project-a',
        environmentId,
        environments,
      }),
    ).toEqual({ valid: false, error: AGENT_WORKSPACE_ATTACHED_ENVIRONMENT_ERROR });
  });

  it('skips an unchanged binding after its environment is removed', () => {
    expect(
      validateAgentWorkspaceDefaultBinding({
        workspaceId: 'project-a',
        environmentId: 'removed-vm',
        currentWorkspaceId: 'project-a',
        currentEnvironmentId: 'removed-vm',
        environments,
      }),
    ).toEqual({ valid: true });
  });

  it('revalidates the same workspace when it is rebound to another environment', () => {
    expect(
      validateAgentWorkspaceDefaultBinding({
        workspaceId: 'project-a',
        environmentId: 'managed-runtime',
        currentWorkspaceId: 'project-a',
        currentEnvironmentId: 'attached-vm',
        environments,
      }),
    ).toEqual({ valid: false, error: AGENT_WORKSPACE_ATTACHED_ENVIRONMENT_ERROR });
  });

  it('allows clearing a stale default', () => {
    expect(
      validateAgentWorkspaceDefaultBinding({
        workspaceId: '',
        environmentId: 'removed-vm',
        currentWorkspaceId: 'project-a',
        currentEnvironmentId: 'removed-vm',
        environments,
      }),
    ).toEqual({ valid: true });
  });
});

describe('validateStatefulCodeEnvironment', () => {
  const config = {
    endpoints: {
      agents: {
        statefulCodeSessions: {
          allowedEnvironments: ['user'],
          environments: [
            { id: 'attached-vm', type: 'attached', baseURL: 'https://code.test' },
            { id: 'managed-runtime', type: 'managed' },
          ],
        },
      },
    },
  } as Parameters<typeof validateStatefulCodeEnvironment>[0];

  it.each([
    [
      'a workspace default without an attached environment',
      { workspaceId: 'project-a', environmentId: 'managed-runtime' },
      { code: 'code_workspace_environment_required' },
      { status: 400, body: { error: AGENT_WORKSPACE_ATTACHED_ENVIRONMENT_ERROR } },
    ],
    [
      'an unconfigured environment',
      { enabled: true, environmentId: 'missing-vm' },
      { code: 'code_environment_not_configured', details: { environmentId: 'missing-vm' } },
      { status: 400, body: { error: 'Stateful code environment is not configured: missing-vm' } },
    ],
    [
      'a session scope the deployment does not allow',
      { enabled: true, environment: 'conversation' },
      { code: 'code_environment_not_allowed', details: { environment: 'conversation' } },
      {
        status: 403,
        body: {
          error: 'Stateful code environment is not allowed by this deployment: conversation',
        },
      },
    ],
  ])('refuses %s with a stable code and the route body', (_name, input, error, response) => {
    const result = validateStatefulCodeEnvironment(config, input);
    expect(result).toEqual({ ok: false, error });
    if (!result.ok) {
      expect(agentCodeEnvironmentErrorResponse(result.error)).toEqual(response);
    }
  });

  it('accepts an allowed configuration', () => {
    expect(
      validateStatefulCodeEnvironment(config, {
        enabled: true,
        environment: 'user',
        environmentId: 'attached-vm',
        environmentIdSelected: true,
        workspaceId: 'project-a',
      }),
    ).toEqual({ ok: true });
  });
});
