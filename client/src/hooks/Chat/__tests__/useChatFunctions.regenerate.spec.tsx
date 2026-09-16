import { Provider as JotaiProvider, createStore, getDefaultStore } from 'jotai';
import { renderHook, act } from '@testing-library/react';
import { Constants, ContentTypes, EModelEndpoint, QueryKeys, createPayload } from 'librechat-data-provider';
import type {
  Agent,
  CodeEnvironmentMode,
  CodeWorkspaceSelection,
  TConversation,
  TMessage,
  TSubmission,
  TReasoningOverride,
  TEphemeralAgent,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { pendingReasoningOverrideFamily } from '~/components/Chat/Input/Composer/state';
import { activeUsageResponseIdFamily, pendingUsageFamily } from '~/store/usage';
import { revealedQueuedTurnFamily } from '~/store/steer';
import useChatFunctions from '../useChatFunctions';
import { isPasteSubmitted } from '~/utils';

const mockNavigate = jest.fn();
const mockSetShowStopButton = jest.fn();
const mockSetIsSubmitting = jest.fn();
const mockGetEphemeralAgent = jest.fn((): TEphemeralAgent | null => null);
const mockSetFilesToDelete = jest.fn();
const mockGetSender = jest.fn(() => 'Assistant');
const mockGetExpiry = jest.fn(() => 'expiry-key');
const mockAgentQueryData: { current?: Agent } = {};
const mockGetQueryData = jest.fn((queryKey: readonly unknown[]) =>
  queryKey[0] === QueryKeys.agent ? mockAgentQueryData.current : {},
);
const mockLoggerWarn = jest.fn();
const mockGetLatestConversation = jest.fn(() => null as TConversation | null);
const mockResolveCodeWorkspaceSubmission = jest.fn<
  | { codeEnvironmentMode?: CodeEnvironmentMode; codeWorkspaces?: CodeWorkspaceSelection[] }
  | undefined,
  [CodeWorkspaceSelection[]?, CodeEnvironmentMode?]
>(() => ({}));
const mockCodeWorkspace = {
  resolveSubmission: mockResolveCodeWorkspaceSubmission,
  rememberSelection: jest.fn(),
};

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    getQueryData: mockGetQueryData,
    getQueryState: jest.fn(() => undefined),
  }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
  useSetRecoilState: (atom: unknown) =>
    String(atom).includes('isSubmitting') ? mockSetIsSubmitting : mockSetShowStopButton,
  useRecoilCallback: (factory: any) =>
    factory({
      snapshot: {
        getLoadable: (_atom: unknown) => ({
          state: 'hasValue',
          contents: [],
        }),
      },
      set: jest.fn(),
      reset: jest.fn(),
    }),
}));

jest.mock('~/hooks/Files/useSetFilesToDelete', () => () => mockSetFilesToDelete);
jest.mock('~/hooks/Agents/useCodeApprovalMode', () => () => ({
  modes: ['ask', 'acceptEdits'],
  selected: 'ask',
}));
jest.mock('~/hooks/Agents/useCodeWorkspace', () => () => mockCodeWorkspace);
jest.mock('~/hooks/Conversations/useGetConversation', () => () => mockGetLatestConversation);
jest.mock('~/hooks/Conversations/useGetSender', () => () => mockGetSender);
jest.mock('~/hooks/Input/useUserKey', () => () => ({ getExpiry: mockGetExpiry }));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: null }),
}));
jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => ({
    'agent-1': {
      provider: 'openAI',
      model: 'gpt-5.1',
    },
  }),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    isTemporary: 'isTemporary',
    isSubmittingFamily: () => 'isSubmitting',
    submissionStartFamily: () => 'submissionStart',
    showStopButtonByIndex: () => 'showStopButton',
    pendingManualSkillsByConvoId: () => 'pendingManualSkills',
    pendingQuotesByConvoId: () => 'pendingQuotes',
    messagesSiblingIdxFamily: () => 'messagesSiblingIdx',
    conversationByKeySelector: () => 'conversation',
  },
  useGetEphemeralAgent: () => mockGetEphemeralAgent,
}));
jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  logger: {
    log: jest.fn(),
    dir: jest.fn(),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
  },
  createDualMessageContent: jest.fn(() => []),
  getRouteChatProjectId: jest.fn(() => null),
  requestChatFocus: jest.fn(),
}));

const userMessage = (messageId: string, parentMessageId = '00000000-0000-0000-0000-000000000000') =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'conversation-1',
    isCreatedByUser: true,
    sender: 'User',
    text: messageId,
  }) as TMessage;

const assistantMessage = (messageId: string, parentMessageId: string) =>
  ({
    messageId,
    parentMessageId,
    conversationId: 'conversation-1',
    isCreatedByUser: false,
    sender: 'Assistant',
    text: messageId,
  }) as TMessage;

const conversation = (conversationId: string) =>
  ({
    conversationId,
    endpoint: EModelEndpoint.agents,
    model: 'gpt-4o',
    agent_id: 'agent-1',
  }) as TConversation;

function renderAsk(
  messages: TMessage[] | undefined,
  conversationId = 'conversation-1',
  options: {
    endpoint?: TConversation['endpoint'];
    isSubmitting?: boolean;
    reasoningOverride?: TReasoningOverride;
    agentId?: string;
  } = {},
) {
  const setMessages = jest.fn();
  const setSubmission = jest.fn();
  const getMessages = jest.fn(() => messages);
  const immutableConversation = conversation(conversationId);
  if ('endpoint' in options) {
    immutableConversation.endpoint = options.endpoint ?? null;
  }
  if (options.agentId != null) {
    immutableConversation.agent_id = options.agentId;
  }
  const reasoningStore = createStore();
  reasoningStore.set(pendingReasoningOverrideFamily(conversationId), options.reasoningOverride);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
  );
  const hook = renderHook(
    () =>
      useChatFunctions({
        isSubmitting: options.isSubmitting ?? false,
        latestMessage: messages?.at(-1) ?? null,
        conversation: immutableConversation,
        getMessages,
        setMessages,
        setSubmission,
      }),
    { wrapper },
  );

  return { ...hook, getMessages, setMessages, setSubmission, reasoningStore };
}

describe('useChatFunctions ask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentQueryData.current = undefined;
    mockGetQueryData.mockReturnValue({});
    mockGetLatestConversation.mockReturnValue(null);
    mockResolveCodeWorkspaceSubmission.mockReturnValue({});
  });

  it.each([EModelEndpoint.agents, EModelEndpoint.openAI])(
    'binds the optimistic %s response before publishing its messages',
    (endpoint) => {
      const { result, setMessages, setSubmission } = renderAsk([], 'conversation-1', { endpoint });
      const store = getDefaultStore();
      store.set(activeUsageResponseIdFamily('conversation-1'), null);
      setMessages.mockImplementation((messages: TMessage[]) => {
        expect(store.get(activeUsageResponseIdFamily('conversation-1'))).toBe(
          messages.at(-1)?.messageId,
        );
      });
      act(() => result.current.ask({ text: 'Hello', conversationId: 'conversation-1' }));
      const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
      expect(store.get(activeUsageResponseIdFamily('conversation-1'))).toBe(
        submission.initialResponse?.messageId,
      );
      expect(store.get(pendingUsageFamily('conversation-1')).eventCount).toBe(0);
    },
  );

  it('reads an approval-mode selection made immediately before send', () => {
    mockGetLatestConversation.mockReturnValue({
      ...conversation('conversation-1'),
      codeApprovalMode: 'acceptEdits',
    });
    const { result, setSubmission } = renderAsk([]);

    act(() => {
      result.current.ask({ text: 'Edit the file', conversationId: 'conversation-1' });
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.codeApprovalMode).toBe('acceptEdits');
    expect(submission.conversation.codeApprovalMode).toBe('acceptEdits');
  });

  it('preallocates a durable Agents user id for the optimistic response anchor', () => {
    const { result, setSubmission } = renderAsk([]);

    act(() => {
      result.current.ask({ text: 'Queue safely', conversationId: 'conversation-1' });
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    const userMessageId = submission.userMessage.messageId;
    expect(submission.endpointOption.overrideUserMessageId).toBe(
      `${userMessageId}${Constants.COMMON_DIVIDER}0`,
    );
    expect(createPayload(submission).payload.overrideUserMessageId).toBe(
      `${userMessageId}${Constants.COMMON_DIVIDER}0`,
    );
    expect(submission.initialResponse?.clientQueueParentMessageId).toBe(userMessageId);
  });

  it('submits the latest validated workspace selection', () => {
    const selection = { environmentId: 'personal-vm', workspaceId: 'project-a' };
    mockResolveCodeWorkspaceSubmission.mockReturnValue({ codeWorkspaces: [selection] });
    mockGetLatestConversation.mockReturnValue({
      ...conversation('conversation-1'),
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selection],
    });
    const { result, setSubmission } = renderAsk([]);

    act(() => {
      result.current.ask({ text: 'Edit the file', conversationId: 'conversation-1' });
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(mockResolveCodeWorkspaceSubmission).toHaveBeenCalledWith([selection], 'attached');
    expect(submission.codeWorkspaces).toEqual([selection]);
  });

  it('refuses every direct send before consuming composer context during handoff', () => {
    const family = revealedQueuedTurnFamily('conversation-1');
    getDefaultStore().set(family, {
      clientRequestId: 'queued',
      parentMessageId: 'response',
      generationCreatedAt: 41,
      text: 'queued',
      revealedAt: new Date().toISOString(),
    });
    try {
      const { result, setSubmission, getMessages } = renderAsk([]);
      expect(result.current.ask({ text: 'direct' })).toBe(false);
      expect(
        result.current.ask({ text: 'rerun', parentMessageId: 'earlier' }, { isRegenerate: true }),
      ).toBe(false);
      expect(mockResolveCodeWorkspaceSubmission).not.toHaveBeenCalled();
      expect(getMessages).not.toHaveBeenCalled();
      expect(setSubmission).not.toHaveBeenCalled();
      expect(mockSetFilesToDelete).not.toHaveBeenCalled();
    } finally {
      getDefaultStore().set(family, null);
    }
  });

  it('refuses to send when workspace submission resolution is not ready', () => {
    mockResolveCodeWorkspaceSubmission.mockReturnValue(undefined);
    const { result, setSubmission } = renderAsk([]);

    expect(result.current.ask({ text: 'Edit the file', conversationId: 'conversation-1' })).toBe(
      false,
    );
    expect(setSubmission).not.toHaveBeenCalled();
  });

  it('refuses to send to an existing conversation before its history loads', () => {
    const { result, getMessages, setMessages, setSubmission } = renderAsk(undefined);

    let askResult: ReturnType<typeof result.current.ask>;
    act(() => {
      askResult = result.current.ask({ text: 'Hello', conversationId: 'conversation-1' });
    });

    expect(askResult!).toBe(false);
    expect(getMessages).toHaveBeenCalledWith('conversation-1');
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[useChatFunctions] Refusing to send before existing conversation history loads',
    );
  });

  it('synchronously reports a refusal while another submit is in flight', () => {
    const { result, setMessages, setSubmission } = renderAsk([], 'conversation-1', {
      isSubmitting: true,
    });

    let askResult: ReturnType<typeof result.current.ask>;
    act(() => {
      askResult = result.current.ask({ text: 'queued follow-up' });
    });

    expect(askResult!).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
    expect(mockSetShowStopButton).not.toHaveBeenCalled();
  });

  it('refuses a second submit fired in the same task, before isSubmitting commits', () => {
    const { result, setSubmission } = renderAsk([]);

    let first: ReturnType<typeof result.current.ask>;
    let second: ReturnType<typeof result.current.ask>;
    act(() => {
      first = result.current.ask({ text: 'double enter', conversationId: 'conversation-1' });
      second = result.current.ask({ text: 'double enter', conversationId: 'conversation-1' });
    });

    expect(first!).not.toBe(false);
    expect(second!).toBe(false);
    expect(setSubmission).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight guard on the next commit rather than latching it', () => {
    const { result, rerender, setSubmission } = renderAsk([]);

    act(() => {
      result.current.ask({ text: 'first turn', conversationId: 'conversation-1' });
    });
    /* `isSubmitting` never turns true here, standing in for a start that fails
       outright: the next commit has to release the guard on its own instead of
       latching the composer shut. */
    act(() => {
      rerender();
    });
    act(() => {
      result.current.ask({ text: 'second turn', conversationId: 'conversation-1' });
    });

    expect(setSubmission).toHaveBeenCalledTimes(2);
  });

  it('reports a refusal when no endpoint is available', () => {
    const { result, setMessages, setSubmission } = renderAsk([], 'conversation-1', {
      endpoint: null,
    });

    let askResult: ReturnType<typeof result.current.ask>;
    act(() => {
      askResult = result.current.ask({ text: 'queued follow-up' });
    });

    expect(askResult!).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
    expect(mockSetShowStopButton).not.toHaveBeenCalled();
  });

  it.each([
    ['empty text', { text: '   ' }, undefined],
    ['the search view', { text: 'queued follow-up', conversationId: 'search' }, undefined],
    ['a continue without a latest message', { text: 'continue' }, { isContinued: true }],
  ])('reports a refusal for %s', (_label, props, askOptions) => {
    const { result, setMessages, setSubmission } = renderAsk([]);

    let askResult: ReturnType<typeof result.current.ask>;
    act(() => {
      askResult = result.current.ask(props, askOptions);
    });

    expect(askResult!).toBe(false);
    expect(setMessages).not.toHaveBeenCalled();
    expect(setSubmission).not.toHaveBeenCalled();
  });

  it('allows an existing conversation whose loaded history is empty', () => {
    const { result, setMessages, setSubmission } = renderAsk([]);

    act(() => {
      result.current.ask({ text: 'Hello', conversationId: 'conversation-1' });
    });

    expect(setMessages).toHaveBeenCalled();
    expect(setSubmission).toHaveBeenCalled();
  });

  it('allows a new conversation before its message cache exists', () => {
    const newConversationId = Constants.NEW_CONVO as string;
    const { result, setMessages, setSubmission } = renderAsk(undefined, newConversationId);

    act(() => {
      result.current.ask({ text: 'Hello', conversationId: newConversationId });
    });

    expect(setMessages).toHaveBeenCalled();
    expect(setSubmission).toHaveBeenCalled();
  });

  it('allows explicit override messages before the cache exists', () => {
    const { result, setMessages, setSubmission } = renderAsk(undefined);

    act(() => {
      result.current.ask(
        { text: 'Hello', conversationId: 'conversation-1' },
        { overrideMessages: [] },
      );
    });

    expect(setMessages).toHaveBeenCalled();
    expect(setSubmission).toHaveBeenCalled();
  });

  it('stores an explicit reasoning override on only the submitted user turn', () => {
    const { result, setSubmission } = renderAsk([]);
    const override = { key: 'reasoning_effort', value: 'high' } as TReasoningOverride;

    act(() => {
      result.current.ask({ text: 'Think carefully' }, { overrideReasoning: override });
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.userMessage.reasoningOverride).toEqual(override);
    expect(submission.conversation).not.toHaveProperty('reasoning_effort', 'high');
    expect(submission.endpointOption).not.toHaveProperty('reasoning_effort', 'high');
  });

  it('drains a staged reasoning override onto a fresh submission exactly once', () => {
    const override = { key: 'reasoning_effort', value: 'high' } as TReasoningOverride;
    const { result, setSubmission, reasoningStore } = renderAsk([], 'conversation-1', {
      reasoningOverride: override,
    });

    act(() => {
      result.current.ask({ text: 'Think carefully' });
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.userMessage.reasoningOverride).toEqual(override);
    expect(reasoningStore.get(pendingReasoningOverrideFamily('conversation-1'))).toBeUndefined();
  });
  it('uses hydrated per-agent query data when the agent catalog is unavailable', () => {
    const agentId = 'agent-uncatalogued';
    const override = { key: 'reasoning_effort', value: 'high' } as TReasoningOverride;
    mockAgentQueryData.current = {
      id: agentId,
      provider: 'openAI',
      model: 'gpt-5.1',
    } as Agent;
    const { result, setSubmission, reasoningStore } = renderAsk([], 'conversation-uncatalogued', {
      agentId,
      reasoningOverride: override,
    });

    act(() => {
      result.current.ask({ text: 'Think carefully' });
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.userMessage.reasoningOverride).toEqual(override);
    expect(
      reasoningStore.get(pendingReasoningOverrideFamily('conversation-uncatalogued')),
    ).toBeUndefined();
    expect(mockGetQueryData).toHaveBeenCalledWith([QueryKeys.agent, agentId]);
  });
});

describe('useChatFunctions regenerate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentQueryData.current = undefined;
  });

  it('keys a non-tail regenerate to the selected assistant response', () => {
    let messages = [
      userMessage('user-1'),
      assistantMessage('assistant-1', 'user-1'),
      userMessage('user-2', 'assistant-1'),
      assistantMessage('assistant-2', 'user-2'),
      userMessage('user-3', 'assistant-2'),
      assistantMessage('assistant-3', 'user-3'),
    ];
    const setMessages = jest.fn((nextMessages: TMessage[]) => {
      messages = nextMessages;
    });
    const setSubmission = jest.fn();
    const conversation = {
      conversationId: 'conversation-1',
      endpoint: EModelEndpoint.agents,
      model: 'gpt-4o',
      agent_id: 'agent-1',
    } as TConversation;

    const { result } = renderHook(() =>
      useChatFunctions({
        isSubmitting: false,
        latestMessage: messages[5],
        conversation,
        getMessages: () => messages,
        setMessages,
        setSubmission,
      }),
    );

    act(() => {
      result.current.regenerate(messages[1]);
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.codeApprovalMode).toBe('ask');
    expect(submission.userMessage.overrideParentMessageId).toBe('user-1');
    expect(submission.userMessage.responseMessageId).toBe('assistant-1_');
    expect(submission.initialResponse?.messageId).toBe('assistant-1_');
    expect(submission.initialResponse?.parentMessageId).toBe('user-1');
    expect(submission.initialResponse?.clientQueueParentMessageId).toBe('user-1');
    expect(submission.messages.map((message) => message.messageId)).toEqual(['user-1']);
    expect(submission.regenerateMessages?.map((message) => message.messageId)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
      'user-3',
      'assistant-3',
    ]);
    expect(
      setMessages.mock.calls.at(-1)?.[0].map((message: TMessage) => message.messageId),
    ).toEqual(['user-1', 'assistant-1_']);
    expect(messages.at(-1)?.messageId).toBe('assistant-1_');
  });

  it.each(['assistant-1', 'assistant_1_'])(
    'marks an edited optimistic response %s with its durable user anchor',
    (responseMessageId) => {
      const parent = userMessage('user-1');
      const response = {
        ...assistantMessage(responseMessageId, parent.messageId),
        content: [{ type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'before' }],
      } as TMessage;
      const { result, setSubmission } = renderAsk([parent, response]);

      act(() => {
        result.current.ask(
          { ...parent },
          {
            isRegenerate: true,
            isEdited: true,
            editedMessageId: responseMessageId,
            editedContent: {
              index: 0,
              type: ContentTypes.TEXT,
              [ContentTypes.TEXT]: 'after',
            },
          },
        );
      });

      const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
      expect(submission.initialResponse?.messageId).toBe(responseMessageId);
      expect(submission.initialResponse?.clientQueueParentMessageId).toBe('user-1');
    },
  );
  it('replays the original user turn reasoning override on regenerate', () => {
    const parent = {
      ...userMessage('user-reasoning'),
      reasoningOverride: { key: 'reasoning_effort', value: 'high' },
    } as TMessage;
    const response = assistantMessage('assistant-reasoning', parent.messageId);
    const { result, setSubmission } = renderAsk([parent, response]);

    act(() => {
      result.current.regenerate(response);
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.userMessage.reasoningOverride).toEqual(parent.reasoningOverride);
  });

  it('drops a replayed reasoning override that the selected model no longer supports', () => {
    const parent = {
      ...userMessage('user-reasoning'),
      reasoningOverride: { key: 'effort', value: 'max' },
    } as TMessage;
    const response = assistantMessage('assistant-reasoning', parent.messageId);
    const { result, setSubmission } = renderAsk([parent, response]);

    act(() => result.current.regenerate(response));

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.userMessage.reasoningOverride).toBeUndefined();
  });
});

describe('useChatFunctions ask attachments', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentQueryData.current = undefined;
  });
  afterEach(() => {
    mockGetEphemeralAgent.mockReturnValue(null);
  });

  /** The server titles an attachment-only turn from the submitted filenames
   *  (getAttachmentTitleText), so the fresh-file mapping must carry them. */
  it('carries the filename on freshly attached files', () => {
    const setMessages = jest.fn();
    const setSubmission = jest.fn();
    const setFiles = jest.fn();
    const files = new Map([
      [
        'file-1',
        {
          file_id: 'file-1',
          filepath: '/uploads/file-1',
          filename: 'quarterly-report.pdf',
          type: 'application/pdf',
        },
      ],
    ]) as unknown as Parameters<typeof useChatFunctions>[0]['files'];

    const { result } = renderHook(() =>
      useChatFunctions({
        isSubmitting: false,
        latestMessage: null,
        conversation: conversation(Constants.NEW_CONVO as string),
        getMessages: () => [],
        setMessages,
        setSubmission,
        files,
        setFiles,
      }),
    );

    act(() => {
      result.current.ask({ text: '' });
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.userMessage.files?.[0]).toMatchObject({
      file_id: 'file-1',
      filename: 'quarterly-report.pdf',
    });
  });

  it('keeps the next composer file staged when a text-only App message uses empty overrides', () => {
    const setMessages = jest.fn();
    const setSubmission = jest.fn();
    const setFiles = jest.fn();
    const files = new Map([
      [
        'app-next-draft-file',
        {
          file_id: 'app-next-draft-file',
          filepath: '/uploads/app-next-draft-file',
          filename: 'private-next-message.pdf',
          type: 'application/pdf',
        },
      ],
    ]) as unknown as Parameters<typeof useChatFunctions>[0]['files'];
    const { result } = renderHook(() =>
      useChatFunctions({
        isSubmitting: false,
        latestMessage: null,
        conversation: conversation(Constants.NEW_CONVO as string),
        getMessages: () => [],
        setMessages,
        setSubmission,
        files,
        setFiles,
      }),
    );
    const selectedConversationTools: TEphemeralAgent = {
      skills: true,
      mcp: ['selected-server'],
    };
    mockGetEphemeralAgent.mockReturnValue(selectedConversationTools);

    act(() => {
      result.current.ask(
        { text: 'approved App message' },
        {
          overrideFiles: [],
          overrideManualSkills: [],
          overrideQuotes: [],
        },
      );
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.userMessage.text).toBe('approved App message');
    expect(submission.userMessage.files).toBeUndefined();
    expect(submission.userMessage.manualSkills).toBeUndefined();
    expect(submission.userMessage.quotes).toBeUndefined();
    expect(submission.ephemeralAgent).toEqual(selectedConversationTools);
    expect(mockGetEphemeralAgent).toHaveBeenCalledTimes(1);
    expect(files?.has('app-next-draft-file')).toBe(true);
    expect(setFiles).not.toHaveBeenCalled();
    expect(isPasteSubmitted('app-next-draft-file')).toBe(false);
  });

  it('rejects a blank text-only App turn even when the composer contains a staged file', () => {
    const setSubmission = jest.fn();
    const files = new Map([
      ['staged-file', { file_id: 'staged-file', filename: 'private-draft.pdf' }],
    ]) as unknown as Parameters<typeof useChatFunctions>[0]['files'];
    const { result } = renderHook(() =>
      useChatFunctions({
        isSubmitting: false,
        latestMessage: null,
        conversation: conversation(Constants.NEW_CONVO as string),
        getMessages: () => [],
        setMessages: jest.fn(),
        setSubmission,
        files,
        setFiles: jest.fn(),
      }),
    );
    let accepted: ReturnType<typeof result.current.ask>;
    act(() => {
      accepted = result.current.ask(
        { text: '  ' },
        {
          overrideFiles: [],
          overrideManualSkills: [],
          overrideQuotes: [],
        },
      );
    });
    expect(accepted!).toBe(false);
    expect(setSubmission).not.toHaveBeenCalled();
    expect(files?.has('staged-file')).toBe(true);
  });

  it('treats a legacy null file override as an ordinary staged-file submission', () => {
    const files = new Map([
      ['legacy-draft-file', { file_id: 'legacy-draft-file', filename: 'draft.pdf' }],
    ]) as unknown as Parameters<typeof useChatFunctions>[0]['files'];
    const setSubmission = jest.fn();
    const { result } = renderHook(() =>
      useChatFunctions({
        isSubmitting: false,
        latestMessage: null,
        conversation: conversation(Constants.NEW_CONVO as string),
        getMessages: () => [],
        setMessages: jest.fn(),
        setSubmission,
        files,
        setFiles: jest.fn(),
      }),
    );
    act(() => {
      result.current.ask(
        { text: '' },
        {
          overrideFiles: null as unknown as NonNullable<
            Parameters<typeof result.current.ask>[1]
          >['overrideFiles'],
        },
      );
    });
    expect(setSubmission).toHaveBeenCalledTimes(1);
    expect((setSubmission.mock.calls[0][0] as TSubmission).userMessage.files).toEqual([
      expect.objectContaining({ file_id: 'legacy-draft-file' }),
    ]);
  });

  it('still uses a staged ephemeral agent for an ordinary composer submission', () => {
    const stagedAgent: TEphemeralAgent = { skills: true, mcp: ['selected-tool'] };
    mockGetEphemeralAgent.mockReturnValue(stagedAgent);
    const { result, setSubmission } = renderAsk([], 'conversation-1');
    act(() => {
      result.current.ask({ text: 'normal user draft' });
    });
    expect(mockGetEphemeralAgent).toHaveBeenCalledTimes(1);
    expect((setSubmission.mock.calls.at(-1)?.[0] as TSubmission).ephemeralAgent).toEqual(
      stagedAgent,
    );
  });

  it('marks files consumed through overrideFiles as submitted', () => {
    const overrideFiles = [
      {
        file_id: 'queued-override-file',
        temp_file_id: 'queued-override-temp-file',
        filepath: '/uploads/queued-override-file',
        filename: 'queued-override.txt',
        type: 'text/plain',
      },
    ];
    const setMessages = jest.fn();
    const setSubmission = jest.fn();
    const setFiles = jest.fn();

    const { result } = renderHook(() =>
      useChatFunctions({
        isSubmitting: false,
        latestMessage: null,
        conversation: conversation(Constants.NEW_CONVO as string),
        getMessages: () => [],
        setMessages,
        setSubmission,
        files: new Map(),
        setFiles,
      }),
    );

    act(() => {
      result.current.ask(
        { text: 'queued override' },
        {
          overrideFiles,
        },
      );
    });

    expect(isPasteSubmitted('queued-override-file')).toBe(true);
    expect(isPasteSubmitted('queued-override-temp-file')).toBe(true);
  });
});

describe('useChatFunctions ask compaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetQueryData.mockReturnValue({});
  });

  it('submits a summarize-only turn hung off the leaf without a new user bubble', () => {
    const messages = [userMessage('u1'), assistantMessage('a1', 'u1')];
    const { result, setMessages, setSubmission } = renderAsk(messages);

    act(() => {
      result.current.ask(
        { text: '', conversationId: 'conversation-1', messageId: 'a1', parentMessageId: 'u1' },
        { compact: true },
      );
    });

    expect(setSubmission).toHaveBeenCalledTimes(1);
    const submission = setSubmission.mock.calls[0][0] as TSubmission;
    expect(submission.compact).toBe(true);
    expect(submission.isRegenerate).toBe(true);
    expect(submission.initialResponse?.parentMessageId).toBe('a1');
    expect(submission.initialResponse?.messageId).toBe('a1_');
    /** The leaf stands in for the user message so an error lands under it. */
    expect(submission.userMessage.messageId).toBe('a1');
    expect(submission.userMessage.overrideParentMessageId).toBeNull();
    expect(submission.userMessage.files).toBeUndefined();
    expect(submission.messages.map((message) => message.messageId)).toEqual(['u1', 'a1']);
    expect(submission.regenerateMessages?.map((message) => message.messageId)).toEqual([
      'u1',
      'a1',
    ]);

    const rendered = setMessages.mock.calls[0][0] as TMessage[];
    expect(rendered.map((message) => message.messageId)).toEqual(['u1', 'a1', 'a1_']);
  });

  it('does not re-attach the leaf files a user-message leaf carries', () => {
    const leaf = { ...userMessage('u2', 'a1'), files: [{ file_id: 'f1' }] } as TMessage;
    const messages = [userMessage('u1'), assistantMessage('a1', 'u1'), leaf];
    const { result, setSubmission } = renderAsk(messages);

    act(() => {
      result.current.ask(
        { text: '', conversationId: 'conversation-1', messageId: 'u2', parentMessageId: 'a1' },
        { compact: true },
      );
    });

    const submission = setSubmission.mock.calls[0][0] as TSubmission;
    expect(submission.userMessage.files).toBeUndefined();
    expect(submission.initialResponse?.parentMessageId).toBe('u2');
  });
});

describe('useChatFunctions ask compaction and the composer', () => {
  it('leaves files staged in the composer untouched', () => {
    const setMessages = jest.fn();
    const setSubmission = jest.fn();
    const setFiles = jest.fn();
    const files = new Map([
      [
        'staged-file',
        {
          file_id: 'staged-file',
          filepath: '/uploads/staged-file',
          filename: 'next-message.pdf',
          type: 'application/pdf',
        },
      ],
    ]) as unknown as Parameters<typeof useChatFunctions>[0]['files'];
    const messages = [userMessage('u1'), assistantMessage('a1', 'u1')];

    const { result } = renderHook(() =>
      useChatFunctions({
        isSubmitting: false,
        latestMessage: messages[1],
        conversation: conversation('conversation-1'),
        getMessages: () => messages,
        setMessages,
        setSubmission,
        files,
        setFiles,
      }),
    );

    act(() => {
      result.current.ask(
        { text: '', conversationId: 'conversation-1', messageId: 'a1', parentMessageId: 'a1' },
        { compact: true },
      );
    });

    const submission = setSubmission.mock.calls.at(-1)?.[0] as TSubmission;
    expect(submission.compact).toBe(true);
    expect(submission.userMessage.files).toBeUndefined();
    expect(submission.userMessage.parentMessageId).toBe('a1');
    expect(setFiles).not.toHaveBeenCalled();
    expect(isPasteSubmitted('staged-file')).toBe(false);
  });
});
