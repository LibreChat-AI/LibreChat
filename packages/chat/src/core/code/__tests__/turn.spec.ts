import { Tools, EModelEndpoint, CODE_ENVIRONMENT_DECISION_VERSION } from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  TConversation,
  CodeWorkspaceSelection,
} from 'librechat-data-provider';
import type { TurnCodeInputs } from '../turn';
import { resolveTurnCode } from '../turn';

const agent: Agent = {
  id: 'agent_primary',
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
  code_environment_id: 'personal-vm',
};

const conversation = (overrides: Partial<TConversation> = {}): TConversation => ({
  conversationId: 'new',
  title: 'Code',
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_primary',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const statefulCodeSessions: NonNullable<TConfig['statefulCodeSessions']> = {
  allowedEnvironments: ['user'],
  approvalsEnabled: true,
  approvalModes: ['ask', 'acceptEdits'],
  environments: [
    {
      id: 'personal-vm',
      name: 'Personal VM',
      type: 'attached',
      configSchema: {
        permissions: {
          fileWrite: { allowed: ['ask', 'allow'], default: 'ask' },
          commandExecution: { allowed: ['ask'], default: 'ask' },
        },
      },
    },
  ],
};

const projectA: CodeWorkspaceSelection = { environmentId: 'personal-vm', workspaceId: 'project-a' };
const projectB: CodeWorkspaceSelection = { environmentId: 'personal-vm', workspaceId: 'project-b' };

/** An agents chat that requires a workspace, with two ready and the first chosen. */
const turnInputs = (overrides: Partial<TurnCodeInputs> = {}): TurnCodeInputs => ({
  workspace: {
    conversation: conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectA] }),
    primaryAgent: agent,
    agentsMap: {},
    statefulCodeSessions,
    startupConfig: { codeEnvironmentDecisionVersion: CODE_ENVIRONMENT_DECISION_VERSION },
    canRunCode: true,
    capabilities: ['execute_code', 'stateful_code_sessions'],
    configurationLoaded: true,
    recoveryPending: false,
    replacingDecision: false,
    statuses: {
      'personal-vm': {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          workspaces: [{ id: 'project-a' }, { id: 'project-b' }],
        },
        isLoading: false,
        isError: false,
      },
    },
    getPreferredWorkspace: () => undefined,
  },
  approval: {
    conversation: conversation({ conversationId: 'conversation-1' }),
    statefulCodeSessions,
    reachable: { agents: [agent], complete: true },
  },
  latest: null,
  ...overrides,
});

describe('resolveTurnCode', () => {
  it('waits while a recovery is pending', () => {
    const inputs = turnInputs();
    expect(
      resolveTurnCode(
        { ...inputs, workspace: { ...inputs.workspace, recoveryPending: true } },
        null,
      ),
    ).toBeNull();
  });

  it('waits while a decision replacement is in flight', () => {
    const inputs = turnInputs();
    expect(
      resolveTurnCode(
        { ...inputs, workspace: { ...inputs.workspace, replacingDecision: true } },
        null,
      ),
    ).toBeNull();
  });

  it('returns an empty decision when no workspace is required', () => {
    const inputs = turnInputs();
    const decision = resolveTurnCode(
      {
        workspace: { ...inputs.workspace, canRunCode: false },
        approval: { conversation: null, reachable: { agents: [], complete: true } },
        latest: null,
      },
      null,
    );
    expect(decision?.code).toEqual({
      approvalMode: undefined,
      latestApprovalMode: undefined,
      environmentMode: undefined,
      workspaces: undefined,
    });
  });

  it("prefers the pane's latest conversation over the submitted one", () => {
    const decision = resolveTurnCode(
      turnInputs({
        latest: conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectA] }),
      }),
      conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectB] }),
    );
    expect(decision?.code.environmentMode).toBe('attached');
    expect(decision?.code.workspaces).toEqual([projectA]);
  });

  it('falls back to the submitted conversation when the latest has no decision', () => {
    const submitted = conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectB] });
    const absent = resolveTurnCode(turnInputs({ latest: null }), submitted);
    expect(absent?.code.workspaces).toEqual([projectB]);
    const undecided = resolveTurnCode(turnInputs({ latest: conversation() }), submitted);
    expect(undecided?.code.environmentMode).toBe('attached');
    expect(undecided?.code.workspaces).toEqual([projectB]);
  });

  it('carries the gated ask for a turn without a workspace while reporting the latest pick', () => {
    const inputs = turnInputs();
    const decision = resolveTurnCode(
      {
        ...inputs,
        workspace: {
          ...inputs.workspace,
          conversation: conversation({
            conversationId: 'conversation-1',
            codeEnvironmentMode: 'without_attached',
          }),
        },
        latest: conversation({
          conversationId: 'conversation-1',
          codeApprovalMode: 'acceptEdits',
          codeEnvironmentMode: 'without_attached',
        }),
      },
      null,
    );
    expect(decision?.code.environmentMode).toBe('without_attached');
    expect(decision?.code.approvalMode).toBe('ask');
    expect(decision?.code.latestApprovalMode).toBe('acceptEdits');
  });

  it('submits the latest approval mode the policy offers', () => {
    const decision = resolveTurnCode(
      turnInputs({
        latest: conversation({
          codeApprovalMode: 'acceptEdits',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [projectA],
        }),
      }),
      null,
    );
    expect(decision?.code.approvalMode).toBe('acceptEdits');
  });

  it('falls back to the selected mode when the requested one is not offered', () => {
    const inputs = turnInputs();
    const decision = resolveTurnCode(
      {
        ...inputs,
        approval: { ...inputs.approval, conversation: conversation(), preferred: 'acceptEdits' },
        latest: conversation({
          codeApprovalMode: 'fullAccess',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [projectA],
        }),
      },
      null,
    );
    expect(decision?.code.approvalMode).toBe('acceptEdits');
    expect(decision?.code.latestApprovalMode).toBe('fullAccess');
  });

  it('records the submission on a conversation', () => {
    const decision = resolveTurnCode(
      turnInputs({
        latest: conversation({ codeEnvironmentMode: 'attached', codeWorkspaces: [projectA] }),
      }),
      null,
    );
    const current = conversation({ conversationId: 'conversation-1' });
    expect(decision?.apply(current)).toEqual({
      ...current,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [projectA],
    });
  });
});
