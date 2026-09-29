import { Provider } from 'jotai';
import { renderHook } from '@testing-library/react';
import { LocalStorageKeys } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import useCodeApprovalMode from '../useCodeApprovalMode';

const mockUseGetAgentsConfig = jest.fn();
const mockUseAgentToolPermissions = jest.fn();
const mockUseAgentsMapContext = jest.fn();

jest.mock('../useGetAgentsConfig', () => () => mockUseGetAgentsConfig());
jest.mock(
  '../useAgentToolPermissions',
  () => (agentId?: string) => mockUseAgentToolPermissions(agentId),
);
jest.mock('~/Providers', () => ({ useAgentsMapContext: () => mockUseAgentsMapContext() }));

const conversation = {
  conversationId: 'conversation-1',
  endpoint: 'agents',
  agent_id: 'agent_1',
  title: 'Code',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  codeApprovalMode: 'acceptEdits',
} as TConversation;

describe('useCodeApprovalMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAgentsMapContext.mockReturnValue({});
    mockUseAgentToolPermissions.mockReturnValue({
      agent: {
        id: 'agent_1',
        tools: ['execute_code'],
        stateful_code_sessions: true,
        code_environment_id: 'mac',
      },
    });
    mockUseGetAgentsConfig.mockReturnValue({
      agentsConfig: {
        statefulCodeSessions: {
          approvalsEnabled: true,
          approvalModes: ['ask', 'acceptEdits'],
          environments: [
            {
              id: 'mac',
              name: 'Mac',
              type: 'attached',
              configSchema: {
                permissions: {
                  fileWrite: { allowed: ['ask', 'allow'], default: 'ask' },
                  commandExecution: { allowed: ['ask'], default: 'ask' },
                },
              },
            },
          ],
        },
      },
    });
  });

  test('returns the selected mode when the attached environment permits it', () => {
    const { result } = renderHook(() => useCodeApprovalMode(conversation));

    expect(result.current).toEqual({
      available: true,
      modes: ['ask', 'acceptEdits'],
      selected: 'acceptEdits',
    });
  });

  test.each(['permitted', 'restricted', 'missing'])(
    'full access requires every reachable machine: %s',
    (policy) => {
      const permissions = {
        fileWrite: { allowed: ['ask', 'allow'], default: 'ask' },
        commandExecution: { allowed: ['ask', 'allow'], default: 'ask' },
      };
      mockUseAgentToolPermissions.mockReturnValue({
        agent: {
          id: 'agent_1',
          tools: ['execute_code'],
          stateful_code_sessions: true,
          code_environment_id: 'mac',
          subagents: { enabled: true, agent_ids: ['child'] },
        },
      });
      mockUseAgentsMapContext.mockReturnValue(
        policy === 'missing'
          ? {}
          : {
              child: {
                id: 'child',
                tools: ['execute_code'],
                stateful_code_sessions: true,
                code_environment_id: 'child-machine',
              },
            },
      );
      mockUseGetAgentsConfig.mockReturnValue({
        agentsConfig: {
          statefulCodeSessions: {
            approvalsEnabled: true,
            approvalModes: ['ask', 'acceptEdits', 'fullAccess'],
            environments: [
              { id: 'mac', type: 'attached', configSchema: { permissions } },
              {
                id: 'child-machine',
                type: 'attached',
                configSchema: { permissions: policy === 'permitted' ? permissions : {} },
              },
            ],
          },
        },
      });
      const { result } = renderHook(() =>
        useCodeApprovalMode({ ...conversation, codeApprovalMode: 'fullAccess' }),
      );
      expect(result.current.modes.includes('fullAccess')).toBe(policy === 'permitted');
      expect(result.current.selected).toBe(policy === 'permitted' ? 'fullAccess' : 'ask');
    },
  );

  test.each(['agent_1', 'agent_2'])(
    'waits for unresolved root %s before full access',
    (missingId) => {
      const permissions = {
        fileWrite: { allowed: ['ask', 'allow'], default: 'ask' },
        commandExecution: { allowed: ['ask', 'allow'], default: 'ask' },
      };
      mockUseGetAgentsConfig.mockReturnValue({
        agentsConfig: {
          statefulCodeSessions: {
            approvalsEnabled: true,
            approvalModes: ['ask', 'acceptEdits', 'fullAccess'],
            environments: [{ id: 'mac', type: 'attached', configSchema: { permissions } }],
          },
        },
      });
      let loaded = false;
      mockUseAgentToolPermissions.mockImplementation((id?: string) => ({
        agent:
          id === missingId && !loaded
            ? undefined
            : {
                id,
                tools: ['execute_code'],
                stateful_code_sessions: true,
                code_environment_id: 'mac',
              },
      }));
      const { result, rerender } = renderHook(() =>
        useCodeApprovalMode(
          { ...conversation, codeApprovalMode: 'fullAccess' },
          { ...conversation, agent_id: 'agent_2' },
        ),
      );
      expect(result.current.modes).not.toContain('fullAccess');
      expect(result.current.selected).toBe('ask');
      loaded = true;
      rerender();
      expect(result.current.modes).toContain('fullAccess');
      expect(result.current.selected).toBe('fullAccess');
    },
  );

  test('falls back to ask when a saved mode is no longer permitted', () => {
    mockUseGetAgentsConfig.mockReturnValue({
      agentsConfig: {
        statefulCodeSessions: {
          approvalsEnabled: true,
          approvalModes: ['ask', 'acceptEdits'],
          environments: [
            {
              id: 'mac',
              name: 'Mac',
              type: 'attached',
              configSchema: {
                permissions: { fileWrite: { allowed: ['ask'], default: 'ask' } },
              },
            },
          ],
        },
      },
    });

    const { result } = renderHook(() => useCodeApprovalMode(conversation));

    expect(result.current.selected).toBe('ask');
    expect(result.current.modes).toEqual(['ask']);
  });

  test('omits the mode when approvals are administratively disabled', () => {
    mockUseGetAgentsConfig.mockReturnValue({
      agentsConfig: {
        statefulCodeSessions: {
          approvalsEnabled: false,
          approvalModes: [],
          environments: [{ id: 'mac', name: 'Mac', type: 'attached' }],
        },
      },
    });

    const { result } = renderHook(() => useCodeApprovalMode(conversation));

    expect(result.current).toEqual({ available: false, modes: [], selected: undefined });
  });

  test('requires an affirmative server approval capability', () => {
    mockUseGetAgentsConfig.mockReturnValue({
      agentsConfig: {
        statefulCodeSessions: {
          environments: [{ id: 'mac', name: 'Mac', type: 'attached' }],
        },
      },
    });

    const { result } = renderHook(() => useCodeApprovalMode(conversation));

    expect(result.current).toEqual({ available: false, modes: [], selected: undefined });
  });

  test('keeps ask fail-closed when an older server does not advertise approval modes', () => {
    mockUseGetAgentsConfig.mockReturnValue({
      agentsConfig: {
        statefulCodeSessions: {
          approvalsEnabled: true,
          environments: [{ id: 'mac', name: 'Mac', type: 'attached' }],
        },
      },
    });

    const { result } = renderHook(() => useCodeApprovalMode(conversation));

    expect(result.current).toEqual({ available: false, modes: [], selected: 'ask' });
  });

  test('keeps ask fail-closed while agent metadata is unavailable', () => {
    mockUseAgentToolPermissions.mockReturnValue({ agent: undefined });

    const { result } = renderHook(() => useCodeApprovalMode(conversation));

    expect(result.current).toEqual({ available: false, modes: [], selected: 'ask' });
  });

  test('includes attached subagents while preserving their mandatory asks', () => {
    const primary = {
      id: 'agent_1',
      tools: [],
      stateful_code_sessions: false,
      subagents: { enabled: true, agent_ids: ['child-1', 'child-2'] },
    };
    mockUseAgentToolPermissions.mockReturnValue({ agent: primary });
    mockUseAgentsMapContext.mockReturnValue({
      'child-1': {
        id: 'child-1',
        tools: ['execute_code'],
        stateful_code_sessions: true,
        code_environment_id: 'mac',
      },
      'child-2': {
        id: 'child-2',
        tools: ['execute_code'],
        stateful_code_sessions: true,
        code_environment_id: 'restricted',
      },
    });
    mockUseGetAgentsConfig.mockReturnValue({
      agentsConfig: {
        statefulCodeSessions: {
          approvalsEnabled: true,
          approvalModes: ['ask', 'acceptEdits'],
          environments: [
            {
              id: 'mac',
              name: 'Mac',
              type: 'attached',
              configSchema: {
                permissions: { fileWrite: { allowed: ['ask', 'allow'], default: 'ask' } },
              },
            },
            {
              id: 'restricted',
              name: 'Restricted',
              type: 'attached',
              configSchema: {
                permissions: { fileWrite: { allowed: ['ask'], default: 'ask' } },
              },
            },
          ],
        },
      },
    });

    const { result } = renderHook(() => useCodeApprovalMode(conversation));

    expect(result.current.available).toBe(true);
    expect(result.current.modes).toEqual(['ask', 'acceptEdits']);
  });

  test.each(['restricted', 'missing'])(
    'downgrades saved Full Access for a %s added agent',
    (kind) => {
      const primary = {
        id: 'agent_1',
        tools: ['execute_code'],
        stateful_code_sessions: true,
        code_environment_id: 'open',
      };
      const added = { ...primary, id: 'agent_2', code_environment_id: 'restricted' };
      mockUseAgentToolPermissions.mockImplementation((id?: string) => {
        if (id === 'agent_1') {
          return { agent: primary };
        }
        return { agent: id === 'agent_2' && kind !== 'missing' ? added : undefined };
      });
      mockUseGetAgentsConfig.mockReturnValue({
        agentsConfig: {
          statefulCodeSessions: {
            approvalsEnabled: true,
            approvalModes: ['ask', 'fullAccess'],
            environments: [
              {
                id: 'open',
                type: 'attached',
                configSchema: {
                  permissions: {
                    fileWrite: { allowed: ['ask', 'allow'], default: 'ask' },
                    commandExecution: { allowed: ['ask', 'allow'], default: 'ask' },
                  },
                },
              },
              {
                id: 'restricted',
                type: 'attached',
                configSchema: {
                  permissions: {
                    commandExecution: { allowed: ['ask'], default: 'ask' },
                  },
                },
              },
            ],
          },
        },
      });
      const primaryConversation = { ...conversation, codeApprovalMode: 'fullAccess' as const };
      const primaryOnly = renderHook(() => useCodeApprovalMode(primaryConversation));
      expect(primaryOnly.result.current.selected).toBe('fullAccess');
      const combined = renderHook(() =>
        useCodeApprovalMode(primaryConversation, { ...conversation, agent_id: 'agent_2' }),
      );
      expect(combined.result.current.selected).toBe('ask');
      expect(combined.result.current.modes).not.toContain('fullAccess');
    },
  );

  test('includes the active parallel conversation agent', () => {
    const primary = {
      id: 'agent_1',
      tools: [],
      stateful_code_sessions: false,
    };
    const addedAgent = {
      id: 'agent_2',
      tools: ['execute_code'],
      stateful_code_sessions: true,
      code_environment_id: 'mac',
    };
    mockUseAgentToolPermissions.mockImplementation((agentId?: string) => ({
      agent: agentId === 'agent_2' ? addedAgent : primary,
    }));
    const addedConversation = { endpoint: 'agents', agent_id: 'agent_2' } as TConversation;

    const { result } = renderHook(() => useCodeApprovalMode(conversation, addedConversation));

    expect(result.current.available).toBe(true);
    expect(result.current.modes).toEqual(['ask', 'acceptEdits']);
  });

  test('does not traverse disabled subagent configurations', () => {
    mockUseAgentToolPermissions.mockReturnValue({
      agent: {
        id: 'agent_1',
        tools: ['execute_code'],
        stateful_code_sessions: true,
        code_environment_id: 'restricted',
        subagents: { enabled: false, agent_ids: ['child-1'] },
      },
    });
    mockUseAgentsMapContext.mockReturnValue({
      'child-1': {
        id: 'child-1',
        tools: ['execute_code'],
        stateful_code_sessions: true,
        code_environment_id: 'mac',
      },
    });
    mockUseGetAgentsConfig.mockReturnValue({
      agentsConfig: {
        statefulCodeSessions: {
          approvalsEnabled: true,
          approvalModes: ['ask', 'acceptEdits'],
          environments: [
            {
              id: 'mac',
              name: 'Mac',
              type: 'attached',
              configSchema: {
                permissions: { fileWrite: { allowed: ['ask', 'allow'], default: 'ask' } },
              },
            },
            {
              id: 'restricted',
              name: 'Restricted',
              type: 'attached',
              configSchema: {
                permissions: { fileWrite: { allowed: ['ask'], default: 'ask' } },
              },
            },
          ],
        },
      },
    });

    const { result } = renderHook(() => useCodeApprovalMode(conversation));

    expect(result.current.modes).toEqual(['ask']);
    expect(result.current.selected).toBe('ask');
  });
});

describe('useCodeApprovalMode remembered pick', () => {
  const withoutMode = { ...conversation, codeApprovalMode: undefined } as TConversation;

  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockUseAgentsMapContext.mockReturnValue({});
    mockUseAgentToolPermissions.mockReturnValue({
      agent: {
        id: 'agent_1',
        tools: ['execute_code'],
        stateful_code_sessions: true,
        code_environment_id: 'mac',
      },
    });
    mockUseGetAgentsConfig.mockReturnValue({
      agentsConfig: {
        statefulCodeSessions: {
          approvalsEnabled: true,
          approvalModes: ['ask', 'acceptEdits'],
          environments: [
            {
              id: 'mac',
              name: 'Mac',
              type: 'attached',
              configSchema: {
                permissions: {
                  fileWrite: { allowed: ['ask', 'allow'], default: 'ask' },
                  commandExecution: { allowed: ['ask'], default: 'ask' },
                },
              },
            },
          ],
        },
      },
    });
  });

  test('opens a conversation with no stored mode on the last pick', () => {
    localStorage.setItem(LocalStorageKeys.LAST_CODE_APPROVAL_MODE, JSON.stringify('acceptEdits'));
    const { result } = renderHook(() => useCodeApprovalMode(withoutMode), { wrapper: Provider });
    expect(result.current.selected).toBe('acceptEdits');
  });

  test('a stored conversation mode still wins over the remembered pick', () => {
    localStorage.setItem(LocalStorageKeys.LAST_CODE_APPROVAL_MODE, JSON.stringify('acceptEdits'));
    const { result } = renderHook(
      () => useCodeApprovalMode({ ...conversation, codeApprovalMode: 'ask' } as TConversation),
      { wrapper: Provider },
    );
    expect(result.current.selected).toBe('ask');
  });

  test('falls back to ask when policy no longer allows the remembered pick', () => {
    localStorage.setItem(LocalStorageKeys.LAST_CODE_APPROVAL_MODE, JSON.stringify('fullAccess'));
    const { result } = renderHook(() => useCodeApprovalMode(withoutMode), { wrapper: Provider });
    expect(result.current.modes).not.toContain('fullAccess');
    expect(result.current.selected).toBe('ask');
  });

  test('ignores a corrupted remembered value', () => {
    localStorage.setItem(LocalStorageKeys.LAST_CODE_APPROVAL_MODE, JSON.stringify('nonsense'));
    const { result } = renderHook(() => useCodeApprovalMode(withoutMode), { wrapper: Provider });
    expect(result.current.selected).toBe('ask');
  });
});
