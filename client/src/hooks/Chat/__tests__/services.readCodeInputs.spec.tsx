import { renderHook } from '@testing-library/react';
import { QueryKeys, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
jest.mock('~/hooks/Files/useSetFilesToDelete', () => () => jest.fn());
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: jest.fn() }));
jest.mock('~/Providers/AgentsMapContext', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('~/hooks/Conversations/useGetConversation', () => () => mockGetLatestConversation);
/** Each render's reader closes over that render's values, as the real hooks' readers do, so an
 *  adapter holding a reader from an earlier render keeps returning the earlier values. */
jest.mock('~/hooks/Agents/useCodeWorkspace', () => () => {
  const rendered = mockReadWorkspaceInputs();
  return { mode: undefined, readInputs: () => rendered };
});
jest.mock('~/hooks/Agents/useCodeApprovalMode', () => () => {
  const rendered = mockReadApprovalInputs();
  return { readInputs: () => rendered };
});

const queryClient = new QueryClient({
  defaultOptions: { queries: { cacheTime: 0, retry: false } },
});
let settings = defaultChatSettings;
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <ChatSettingsContext.Provider value={settings}>{children}</ChatSettingsContext.Provider>
  </QueryClientProvider>
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
    settings = defaultChatSettings;
    queryClient.clear();
    queryClient.setQueryData([QueryKeys.endpoints], {
      [EModelEndpoint.openAI]: {},
      [EModelEndpoint.agents]: {},
    });
    mockReadWorkspaceInputs.mockReturnValue(firstWorkspace);
    mockReadApprovalInputs.mockReturnValue(firstApproval);
    mockGetLatestConversation.mockReturnValue(null);
  });

  it.each([false, true, undefined])(
    'checks configuration readiness when loaded is %s',
    (loaded) => {
      settings = { ...settings, config: { ...settings.config, loaded } };
      const { result } = renderHook(() => useTurnServices({ index: 0, conversation: null }), {
        wrapper,
      });
      const submitted = conversation({ endpoint: EModelEndpoint.openAI, model: 'gpt-5' });

      expect(result.current.canSubmit?.(submitted)).toBe(loaded !== false);
      expect(result.current.readCodeInputs().workspace).toBe(firstWorkspace);
    },
  );

  it('checks the submitted target against current query data, not the rendered conversation', () => {
    const rendered = conversation({ endpoint: EModelEndpoint.openAI, model: 'gpt-5' });
    const submitted = conversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_primary' });
    const { result } = renderHook(() => useTurnServices({ index: 0, conversation: rendered }), {
      wrapper,
    });
    const canSubmit = result.current.canSubmit;

    expect(canSubmit?.(null)).toBe(false);
    expect(canSubmit?.(rendered)).toBe(true);
    expect(canSubmit?.(submitted)).toBe(false);
    queryClient.setQueryData([QueryKeys.agent, 'agent_primary'], { id: 'agent_primary' });
    expect(canSubmit?.(submitted)).toBe(true);
    queryClient.removeQueries([QueryKeys.endpoints]);
    expect(canSubmit?.(submitted)).toBe(false);
  });

  it('reads current configuration and added targets through an earlier adapter', () => {
    const submitted = conversation({ endpoint: EModelEndpoint.openAI, model: 'gpt-5' });
    const added = conversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_added' });
    const { result, rerender } = renderHook(
      () => useTurnServices({ index: 0, conversation: submitted }),
      { wrapper },
    );
    const canSubmit = result.current.canSubmit;
    expect(canSubmit?.(submitted)).toBe(true);

    settings = { ...settings, config: { ...settings.config, loaded: false } };
    rerender();
    expect(canSubmit?.(submitted)).toBe(false);

    settings = {
      ...settings,
      config: { ...settings.config, loaded: true },
      addedConversation: added,
    };
    rerender();
    expect(canSubmit?.(submitted)).toBe(false);
    queryClient.setQueryData([QueryKeys.agent, 'agent_added'], { id: 'agent_added' });
    expect(canSubmit?.(submitted)).toBe(true);

    settings = { ...settings, addedConversation: { ...added, agent_id: 'agent_other' } };
    rerender();
    expect(canSubmit?.(submitted)).toBe(false);

    settings = { ...settings, addedConversation: null };
    rerender();
    expect(canSubmit?.(submitted)).toBe(true);
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
