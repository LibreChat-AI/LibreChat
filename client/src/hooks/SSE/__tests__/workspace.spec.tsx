import { useState } from 'react';
import { Provider } from 'jotai';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import type { ChatCreatedFrame, EventSubmission, TConversation } from 'librechat-data-provider';
import useCodeWorkspace from '~/hooks/Agents/useCodeWorkspace';
import useEventHandlers from '../useEventHandlers';

const mockStatus = jest.fn();
const mockStartupConfig = jest.fn();
const mockApplyAgentTemplate = jest.fn();
const mockAnnounce = jest.fn();
const mockReset = jest.fn();

jest.mock('~/hooks/Agents', () => ({ useApplyAgentTemplate: () => mockApplyAgentTemplate }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ token: 'test' }) }));
jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: mockAnnounce }),
  useAgentsMapContext: () => ({}),
}));
jest.mock('~/hooks/SSE/useContentHandler', () => () => ({}));
jest.mock('~/hooks/SSE/useAttachmentHandler', () => () => jest.fn());
jest.mock('~/hooks/SSE/useStepHandler', () => () => ({
  resetSubagentAtoms: mockReset,
  resetPtcAtoms: mockReset,
}));
jest.mock('~/hooks/Agents/workspacePreferences', () => ({
  useWorkspacePreferences: () => ({ get: () => undefined }),
}));
jest.mock('~/hooks/Roles/useHasAccess', () => () => true);
jest.mock('~/hooks/Agents/useAgentToolPermissions', () => () => ({
  agent: {
    id: 'agent_primary',
    stateful_code_sessions: true,
    code_environment_id: 'personal-vm',
    tools: ['execute_code'],
  },
}));
jest.mock('~/hooks/Agents/useGetAgentsConfig', () => () => ({
  agentsConfig: {
    capabilities: ['execute_code', 'stateful_code_sessions'],
    statefulCodeSessions: {
      environments: [{ id: 'personal-vm', type: 'attached', name: 'Personal VM' }],
    },
  },
}));
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  /** The barrel can be partially initialized through the hook imports above. Keep these
   * real hooks rather than snapshotting missing exports or replacing recovery with a stub. */
  ...jest.requireActual('~/data-provider/CodeEnvironments'),
  useCodeEnvironmentStatusQueries: () => mockStatus(),
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
}));

const selection = { environmentId: 'personal-vm', workspaceId: 'project-a' };
const initialConversation = {
  conversationId: Constants.NEW_CONVO,
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_primary',
  title: 'New Chat',
} as TConversation;

function setup(current = initialConversation, isAddedRequest = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.allConversations], { pages: [], pageParams: [] });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <Provider>
        <RecoilRoot>
          <MemoryRouter initialEntries={['/c/new']}>{children}</MemoryRouter>
        </RecoilRoot>
      </Provider>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const [conversation, setConversation] = useState<TConversation | null>(current);
      const handlers = useEventHandlers({
        isAddedRequest,
        setConversation,
        setMessages: jest.fn(),
        getMessages: () => [],
        setCompleted: jest.fn(),
        setIsSubmitting: jest.fn(),
        setShowStopButton: jest.fn(),
      });
      return {
        conversation,
        setConversation,
        workspace: useCodeWorkspace(conversation),
        ...handlers,
      };
    },
    { wrapper },
  );
  const submission: EventSubmission = {
    isTemporary: false,
    endpointOption: { endpoint: EModelEndpoint.agents },
    conversation: current,
    messages: [],
    userMessage: {
      messageId: 'user-1',
      text: 'Hello',
      sender: 'User',
      isCreatedByUser: true,
      parentMessageId: String(Constants.NO_PARENT),
      conversationId: 'saved-chat',
    },
    initialResponse: {
      messageId: 'response-1',
      parentMessageId: 'user-1',
      conversationId: 'saved-chat',
      text: '',
      sender: 'Assistant',
      isCreatedByUser: false,
    },
    ...hook.result.current.workspace.resolveSubmission(
      current.codeWorkspaces,
      current.codeEnvironmentMode,
    ),
  };
  const createdData: ChatCreatedFrame = {
    created: true,
    message: submission.userMessage,
  };
  return { ...hook, submission, createdData, queryClient };
}

describe('workspace decision at stream acknowledgement', () => {
  beforeEach(() => {
    mockStartupConfig.mockReturnValue({ codeEnvironmentDecisionVersion: 1 });
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          workspaces: [{ id: 'project-a', name: 'Project A' }],
        },
        isLoading: false,
        isError: false,
      },
    ]);
  });

  it.each([
    ['created', true, false],
    ['sync', true, false],
    ['created', false, false],
    ['sync', false, false],
    ['created', true, true],
    ['sync', true, true],
  ] as const)(
    'seals an automatic workspace on %s (decision protocol %s, added pane %s)',
    (event, decisions, isAddedRequest) => {
      mockStartupConfig.mockReturnValue(decisions ? { codeEnvironmentDecisionVersion: 1 } : {});
      const { result, submission, createdData } = setup(initialConversation, isAddedRequest);
      expect(result.current.conversation?.codeWorkspaces).toBeUndefined();
      expect(submission.codeWorkspaces).toEqual([selection]);
      expect(result.current.workspace.locked).toBe(false);

      act(() => {
        if (event === 'created') {
          result.current.createdHandler(createdData, submission);
        } else {
          result.current.syncHandler(
            {
              sync: true,
              thread_id: 'thread',
              conversationId: 'saved-chat',
              requestMessage: submission.userMessage,
              responseMessage: submission.initialResponse,
            },
            submission,
          );
        }
      });

      expect(result.current.conversation).toMatchObject({
        conversationId: 'saved-chat',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      });
      expect(result.current.workspace).toMatchObject({
        locked: true,
        canSubmit: true,
        state: 'ready',
      });
    },
  );

  it('seals a without-attached submission while multiple workspaces remain available', () => {
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          workspaces: [{ id: 'project-a' }, { id: 'project-b' }],
        },
      },
    ]);
    const { result, submission, createdData } = setup();
    expect(submission.codeEnvironmentMode).toBe('without_attached');
    act(() => result.current.createdHandler(createdData, submission));
    expect(result.current.workspace).toMatchObject({
      locked: true,
      canSubmit: true,
      state: 'without_attached',
    });
  });

  it('does not replace a saved decision with a replay of an older submission', () => {
    const { result, submission, createdData } = setup({
      ...initialConversation,
      conversationId: 'saved-chat',
      codeEnvironmentMode: 'without_attached',
    });
    act(() =>
      result.current.createdHandler(createdData, {
        ...submission,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      }),
    );
    expect(result.current.conversation?.codeEnvironmentMode).toBe('without_attached');
    expect(result.current.conversation?.codeWorkspaces).toBeUndefined();
  });

  it.each(['created', 'sync'] as const)(
    'records No workspace on %s for a saved chat that has not granted workspace access',
    (event) => {
      const { result, submission, createdData } = setup({
        ...initialConversation,
        conversationId: 'saved-chat',
      });
      expect(result.current.workspace.locked).toBe(false);
      expect(submission.codeEnvironmentMode).toBe('without_attached');
      expect(submission.codeWorkspaces).toBeUndefined();
      act(() => {
        if (event === 'created') result.current.createdHandler(createdData, submission);
        else
          result.current.syncHandler(
            {
              sync: true,
              thread_id: 'thread',
              conversationId: 'saved-chat',
              requestMessage: submission.userMessage,
              responseMessage: submission.initialResponse,
            },
            submission,
          );
      });
      expect(result.current.conversation?.codeEnvironmentMode).toBe('without_attached');
      expect(result.current.conversation?.codeWorkspaces).toBeUndefined();
      expect(result.current.workspace).toMatchObject({ locked: true, canSubmit: true });
    },
  );

  it('records an explicitly selected first workspace on a previously undecided saved chat', () => {
    const { result, submission, createdData } = setup({
      ...initialConversation,
      conversationId: 'saved-chat',
    });
    act(() =>
      result.current.createdHandler(createdData, {
        ...submission,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [selection],
      }),
    );
    expect(result.current.conversation?.codeWorkspaces).toEqual([selection]);
    expect(result.current.workspace).toMatchObject({ locked: true, canSubmit: true });
  });

  it('uses the submitted without-attached choice rather than a stale draft selection', () => {
    const { result, submission, createdData } = setup({
      ...initialConversation,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selection],
    });
    act(() =>
      result.current.createdHandler(createdData, {
        ...submission,
        codeEnvironmentMode: 'without_attached',
        codeWorkspaces: undefined,
      }),
    );
    expect(result.current.conversation?.codeWorkspaces).toBeUndefined();
    expect(result.current.workspace).toMatchObject({ locked: true, state: 'without_attached' });
  });

  it('leaves an undecided conversation editable when the submission has no decision', () => {
    const { result, submission, createdData } = setup();
    act(() =>
      result.current.createdHandler(createdData, {
        ...submission,
        codeEnvironmentMode: undefined,
        codeWorkspaces: undefined,
      }),
    );
    expect(result.current.conversation?.codeEnvironmentMode).toBeUndefined();
    expect(result.current.workspace.locked).toBe(false);
  });
});
