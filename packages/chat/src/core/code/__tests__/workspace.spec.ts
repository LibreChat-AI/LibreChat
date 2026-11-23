import {
  Tools,
  EModelEndpoint,
  CODE_ENVIRONMENT_DECISION_VERSION,
  CODE_WORKSPACE_INHERITANCE_VERSION,
} from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  TAgentsMap,
  TConversation,
  TStartupConfig,
  CodeWorkspaceSelection,
} from 'librechat-data-provider';
import type {
  CodeWorkspaceInputs,
  CodeEnvironmentStatusSnapshot,
  CodeWorkspaceEnvironmentResult,
} from '../workspace';
import { aggregateState, resolveCodeWorkspace } from '../workspace';

const agent = (overrides: Partial<Agent> & Pick<Agent, 'id'>): Agent => ({
  name: null,
  description: null,
  created_at: 0,
  avatar: null,
  provider: EModelEndpoint.openAI,
  model: null,
  model_parameters: {
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
  stateful_code_sessions: true,
  tools: [Tools.execute_code],
  ...overrides,
});

const conversation = (overrides: Partial<TConversation> = {}): TConversation => ({
  conversationId: 'new',
  title: 'Code',
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_primary',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const ready = (
  environmentId: string,
  workspaceIds = ['project-a'],
): CodeEnvironmentStatusSnapshot => ({
  data: {
    environmentId,
    status: 'ready',
    workspaces: workspaceIds.map((id) => ({ id })),
  },
  isLoading: false,
  isError: false,
});

const decisions: Partial<TStartupConfig> = {
  codeEnvironmentDecisionVersion: CODE_ENVIRONMENT_DECISION_VERSION,
};

const sessions = (
  overrides: Partial<NonNullable<TConfig['statefulCodeSessions']>> = {},
): TConfig['statefulCodeSessions'] => ({
  allowedEnvironments: ['user'],
  environments: [{ id: 'personal-vm', name: 'Personal VM', type: 'attached' }],
  ...overrides,
});

const inputs = (overrides: Partial<CodeWorkspaceInputs> = {}): CodeWorkspaceInputs => ({
  conversation: conversation(),
  primaryAgent: agent({ id: 'agent_primary', code_environment_id: 'personal-vm' }),
  agentsMap: {},
  statefulCodeSessions: sessions(),
  startupConfig: decisions,
  canRunCode: true,
  capabilities: ['execute_code', 'stateful_code_sessions'],
  configurationLoaded: true,
  recoveryPending: false,
  replacingDecision: false,
  statuses: { 'personal-vm': ready('personal-vm') },
  getPreferredWorkspace: () => undefined,
  ...overrides,
});

const projectA: CodeWorkspaceSelection = { environmentId: 'personal-vm', workspaceId: 'project-a' };

describe('resolveCodeWorkspace', () => {
  it('returns an empty submission when no workspace is required', () => {
    const result = resolveCodeWorkspace(inputs({ canRunCode: false }));
    expect(result.required).toBe(false);
    expect(result.state).toBe('not_required');
    expect(result.resolveSubmission()).toEqual({});
    expect(result.canSubmit).toBe(true);
  });

  it('selects the sole workspace of a new chat and submits it attached', () => {
    const result = resolveCodeWorkspace(inputs());
    expect(result.state).toBe('ready');
    expect(result.mode).toBe('attached');
    expect(result.selections).toEqual([projectA]);
    expect(result.resolveSubmission()).toEqual({
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [projectA],
    });
  });

  it('withholds the submission while recovery is pending, even when nothing is required', () => {
    expect(resolveCodeWorkspace(inputs({ recoveryPending: true })).resolveSubmission()).toBe(
      undefined,
    );
    const idle = resolveCodeWorkspace(inputs({ recoveryPending: true, canRunCode: false }));
    expect(idle.resolveSubmission()).toBeUndefined();
    expect(idle.visible).toBe(true);
  });

  it('waits while a decision replacement is in flight', () => {
    const result = resolveCodeWorkspace(inputs({ replacingDecision: true }));
    expect(result.resolveSubmission([projectA])).toBeUndefined();
    expect(result.canSubmit).toBe(false);
    expect(
      resolveCodeWorkspace(
        inputs({ replacingDecision: true, canRunCode: false }),
      ).resolveSubmission(),
    ).toEqual({});
  });

  it('sends without attached workspaces only when the API supports decisions', () => {
    const saved = conversation({
      conversationId: 'saved',
      codeEnvironmentMode: 'without_attached',
    });
    const supported = resolveCodeWorkspace(inputs({ conversation: saved }));
    expect(supported.state).toBe('without_attached');
    expect(supported.resolveSubmission()).toEqual({ codeEnvironmentMode: 'without_attached' });

    const legacy = resolveCodeWorkspace(inputs({ conversation: saved, startupConfig: {} }));
    expect(legacy.supportsEnvironmentDecisions).toBe(false);
    expect(legacy.resolveSubmission(undefined, 'without_attached')).toBeUndefined();
  });

  it('defaults an undecided saved chat to without_attached under the decision protocol', () => {
    const result = resolveCodeWorkspace(
      inputs({ conversation: conversation({ conversationId: 'saved' }) }),
    );
    expect(result.locked).toBe(false);
    expect(result.mode).toBe('without_attached');
    expect(result.resolveSubmission()).toEqual({ codeEnvironmentMode: 'without_attached' });
  });

  it('refuses a sealed machine choice outside the attached and former environments', () => {
    const foreign: CodeWorkspaceSelection = { environmentId: 'other-vm', workspaceId: 'project-a' };
    const result = resolveCodeWorkspace(
      inputs({
        conversation: conversation({
          conversationId: 'saved',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [foreign],
        }),
      }),
    );
    expect(result.locked).toBe(true);
    expect(result.selections).toBeUndefined();
    expect(result.resolveSelections([foreign])).toBeUndefined();
    expect(result.resolveSubmission([foreign])).toBeUndefined();
    expect(result.canSubmit).toBe(false);
  });

  describe('subagent machine inheritance', () => {
    const sealedChoice: CodeWorkspaceSelection[] = [
      { environmentId: 'runtime-vm', workspaceId: 'project-a', agentIds: ['agent_primary'] },
    ];
    const agentsMap: TAgentsMap = {
      reviewer: agent({
        id: 'reviewer',
        name: 'PR Reviewer',
        code_environment_id: 'personal-vm',
        code_environment_ids: ['runtime-vm'],
      }),
    };
    const graph = (startupConfig: Partial<TStartupConfig>) =>
      inputs({
        startupConfig,
        conversation: conversation({
          conversationId: 'saved',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: sealedChoice,
        }),
        primaryAgent: agent({
          id: 'agent_primary',
          code_environment_id: 'personal-vm',
          code_environment_ids: ['runtime-vm'],
          subagents: { enabled: true, agent_ids: ['reviewer'] },
        }),
        agentsMap,
        statefulCodeSessions: sessions({
          allowEnvironmentSelection: true,
          environments: [
            { id: 'personal-vm', name: 'Personal VM', type: 'attached' },
            { id: 'runtime-vm', name: 'Runtime VM', type: 'attached' },
          ],
        }),
        statuses: { 'personal-vm': ready('personal-vm'), 'runtime-vm': ready('runtime-vm') },
      });

    it("routes a reviewer with its parent's sealed machine when inheritance is advertised", () => {
      const result = resolveCodeWorkspace(
        graph({
          ...decisions,
          codeWorkspaceInheritanceVersion: CODE_WORKSPACE_INHERITANCE_VERSION,
        }),
      );
      expect(result.environments.map(({ environment }) => environment.id)).toEqual(['runtime-vm']);
      expect(result.environments[0].requiredBy).toEqual(
        expect.arrayContaining([{ id: 'reviewer', name: 'PR Reviewer' }]),
      );
      expect(result.canSubmit).toBe(true);
      expect(result.resolveSubmission(sealedChoice)?.codeWorkspaces).toEqual(sealedChoice);
    });

    it("still requires the reviewer's own machine when the API predates inheritance", () => {
      const result = resolveCodeWorkspace(graph(decisions));
      expect(result.environments.map(({ environment }) => environment.id)).toEqual([
        'personal-vm',
        'runtime-vm',
      ]);
      expect(result.canSubmit).toBe(false);
    });
  });
});

describe('aggregateState', () => {
  const result = (
    state: CodeWorkspaceEnvironmentResult['state'],
  ): CodeWorkspaceEnvironmentResult => ({
    environment: { id: state, name: state, type: 'attached' },
    state,
    workspaces: [],
  });

  it('orders unavailable, unsupported, missing, loading, choose, then ready', () => {
    const all = [
      result('loading'),
      result('missing'),
      result('unsupported'),
      result('unavailable'),
    ];
    expect(aggregateState(false, false, all, undefined)).toBe('not_required');
    expect(aggregateState(true, false, [], [projectA])).toBe('unavailable');
    expect(aggregateState(true, true, all, [projectA])).toBe('unavailable');
    expect(aggregateState(true, true, all.slice(0, 3), [projectA])).toBe('unsupported');
    expect(aggregateState(true, true, all.slice(0, 2), [projectA])).toBe('missing');
    expect(aggregateState(true, true, all.slice(0, 1), [projectA])).toBe('loading');
    expect(aggregateState(true, true, [result('choose')], undefined)).toBe('choose');
    expect(aggregateState(true, true, [result('ready')], [projectA])).toBe('ready');
  });
});
