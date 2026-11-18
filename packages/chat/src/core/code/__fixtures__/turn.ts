import { Tools, EModelEndpoint, CODE_ENVIRONMENT_DECISION_VERSION } from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  TConversation,
  CodeWorkspaceSelection,
} from 'librechat-data-provider';
import type { TurnCodeInputs } from '../turn';

export const agent: Agent = {
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

export const conversation = (overrides: Partial<TConversation> = {}): TConversation => ({
  conversationId: 'new',
  title: 'Code',
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_primary',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

export const statefulCodeSessions: NonNullable<TConfig['statefulCodeSessions']> = {
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

export const projectA: CodeWorkspaceSelection = {
  environmentId: 'personal-vm',
  workspaceId: 'project-a',
};
export const projectB: CodeWorkspaceSelection = {
  environmentId: 'personal-vm',
  workspaceId: 'project-b',
};

/** An agents chat that requires a workspace, with two ready and the first chosen. */
export const turnInputs = (overrides: Partial<TurnCodeInputs> = {}): TurnCodeInputs => ({
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
