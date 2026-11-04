import { renderHook } from '@testing-library/react';
import type { CodeApprovalModeInputs, CodeWorkspaceInputs } from '@librechat/chat';
import type { TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { ChatSettingsContext, defaultChatSettings } from '~/Providers/ChatSettingsContext';
import useTurnServices from '../services';

type ApprovalInputs = Omit<CodeApprovalModeInputs, 'codeEnvironmentMode'>;

const mockReadWorkspaceInputs = jest.fn<CodeWorkspaceInputs, []>();
const mockReadApprovalInputs = jest.fn<ApprovalInputs, []>();
const mockGetLatestConversation = jest.fn<TConversation | null, []>(() => null);

jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ getQueryData: jest.fn() }) }));
jest.mock('~/hooks/Files/useSetFilesToDelete', () => () => jest.fn());
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: jest.fn() }));
jest.mock('~/Providers/AgentsMapContext', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('~/hooks/Conversations/useGetConversation', () => () => mockGetLatestConversation);
jest.mock('~/hooks/Agents/useCodeWorkspace', () => () => ({
  mode: undefined,
  readInputs: mockReadWorkspaceInputs,
}));
jest.mock('~/hooks/Agents/useCodeApprovalMode', () => () => ({
  readInputs: mockReadApprovalInputs,
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <ChatSettingsContext.Provider value={defaultChatSettings}>
    {children}
  </ChatSettingsContext.Provider>
);

const conversation = (overrides: Partial<TConversation>): TConversation => ({
  conversationId: 'new',
  endpoint: null,
  title: 'Code',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const workspace = (conversationId: string): CodeWorkspaceInputs => ({
  conversation: conversation({ conversationId }),
  canRunCode: false,
  configurationLoaded: true,
  recoveryPending: false,
  replacingDecision: false,
  statuses: {},
  getPreferredWorkspace: () => undefined,
});

const approval = (conversationId: string): ApprovalInputs => ({
  conversation: conversation({ conversationId }),
  reachable: { agents: [], complete: true },
});

const firstWorkspace = workspace('first');
const firstApproval = approval('first');
const secondWorkspace = workspace('second');
const secondApproval = approval('second');

describe('useTurnServices readCodeInputs', () => {
  beforeEach(() => {
    mockReadWorkspaceInputs.mockReturnValue(firstWorkspace);
    mockReadApprovalInputs.mockReturnValue(firstApproval);
    mockGetLatestConversation.mockReturnValue(null);
  });

  it('reads the newest render through an adapter captured from the first', () => {
    const { result, rerender } = renderHook(
      () => useTurnServices({ index: 0, conversation: null }),
      { wrapper },
    );
    const first = result.current;
    expect(first.readCodeInputs().workspace).toBe(firstWorkspace);
    expect(first.readCodeInputs().approval).toBe(firstApproval);

    mockReadWorkspaceInputs.mockReturnValue(secondWorkspace);
    mockReadApprovalInputs.mockReturnValue(secondApproval);
    rerender();

    const inputs = first.readCodeInputs();
    expect(inputs.workspace).toBe(secondWorkspace);
    expect(inputs.approval).toBe(secondApproval);
  });

  it('reads the pane conversation when called, without a rerender', () => {
    const { result } = renderHook(() => useTurnServices({ index: 0, conversation: null }), {
      wrapper,
    });
    expect(result.current.readCodeInputs().latest).toBeNull();

    const latest = conversation({ conversationId: 'later', codeApprovalMode: 'acceptEdits' });
    mockGetLatestConversation.mockReturnValue(latest);
    expect(result.current.readCodeInputs().latest).toBe(latest);
  });
});
