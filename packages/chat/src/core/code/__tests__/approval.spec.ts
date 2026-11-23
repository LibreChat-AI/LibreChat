import { Tools, EModelEndpoint } from 'librechat-data-provider';
import type { Agent, TConfig, TConversation, CodeApprovalMode } from 'librechat-data-provider';
import type { CodeApprovalModeInputs } from '../approval';
import { resolveCodeApprovalModes, resolveSubmittedCodeApprovalMode } from '../approval';

const coder: Agent = {
  id: 'agent_1',
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
  code_environment_id: 'vm',
  tools: [Tools.execute_code],
};

const conversation: TConversation = {
  conversationId: 'conversation-1',
  title: 'Code',
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  codeApprovalMode: 'acceptEdits',
};

const statefulCodeSessions: NonNullable<TConfig['statefulCodeSessions']> = {
  allowedEnvironments: ['user'],
  approvalsEnabled: true,
  approvalModes: ['ask', 'acceptEdits'],
  environments: [
    {
      id: 'vm',
      name: 'VM',
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

const inputs = (overrides: Partial<CodeApprovalModeInputs> = {}): CodeApprovalModeInputs => ({
  conversation,
  statefulCodeSessions,
  reachable: { agents: [coder], complete: true },
  ...overrides,
});

describe('resolveCodeApprovalModes', () => {
  it('offers the endpoint modes an attached machine allows and keeps the requested one', () => {
    expect(resolveCodeApprovalModes(inputs())).toEqual({
      available: true,
      modes: ['ask', 'acceptEdits'],
      selected: 'acceptEdits',
    });
  });

  it('falls back to ask for a turn without attached workspaces', () => {
    expect(resolveCodeApprovalModes(inputs({ codeEnvironmentMode: 'without_attached' }))).toEqual({
      available: false,
      modes: [],
      selected: 'ask',
    });
  });

  it('uses the remembered preference only when the conversation carries no mode', () => {
    const fresh = { ...conversation, codeApprovalMode: undefined };
    expect(
      resolveCodeApprovalModes(inputs({ conversation: fresh, preferred: 'acceptEdits' })).selected,
    ).toBe('acceptEdits');
    expect(
      resolveCodeApprovalModes(inputs({ conversation: fresh, preferred: 'fullAccess' })).selected,
    ).toBe('ask');
  });

  it('selects nothing when approvals are not supported', () => {
    const result = resolveCodeApprovalModes(
      inputs({ statefulCodeSessions: { ...statefulCodeSessions, approvalsEnabled: false } }),
    );
    expect(result).toEqual({ available: false, modes: [], selected: undefined });
  });
});

describe('resolveSubmittedCodeApprovalMode', () => {
  it('carries no mode without a fallback', () => {
    expect(resolveSubmittedCodeApprovalMode({ requested: 'acceptEdits', modes: ['ask'] })).toBe(
      undefined,
    );
  });

  it('forces ask for a turn without attached workspaces', () => {
    expect(
      resolveSubmittedCodeApprovalMode({
        requested: 'acceptEdits',
        modes: ['ask', 'acceptEdits'],
        fallback: 'acceptEdits',
        codeEnvironmentMode: 'without_attached',
      }),
    ).toBe('ask');
  });

  it('keeps an offered request and falls back for one policy no longer offers', () => {
    const modes: CodeApprovalMode[] = ['ask', 'acceptEdits'];
    expect(
      resolveSubmittedCodeApprovalMode({ requested: 'acceptEdits', modes, fallback: 'ask' }),
    ).toBe('acceptEdits');
    expect(
      resolveSubmittedCodeApprovalMode({ requested: 'fullAccess', modes, fallback: 'ask' }),
    ).toBe('ask');
  });
});
