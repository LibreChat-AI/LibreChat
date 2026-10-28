import React, { useMemo, useState } from 'react';
import { RecoilRoot } from 'recoil';
import { act, render } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import { ChatContext, MessagesViewProvider, useChatContext } from '~/Providers';
import MessageContent from '../MessageContent';

const mockRowRenders = new Map<string, number>();

jest.mock('~/components/Chat/Messages/ui/MessageRow', () => ({
  __esModule: true,
  default: ({
    id,
    children,
    footer,
  }: {
    id?: string;
    children: React.ReactNode;
    footer: React.ReactNode;
  }) => {
    mockRowRenders.set(id ?? '', (mockRowRenders.get(id ?? '') ?? 0) + 1);
    return (
      <div data-testid={`row-${id}`}>
        {children}
        {footer}
      </div>
    );
  },
}));

jest.mock('~/components/Chat/Messages/Content/ContentParts', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Chat/Messages/HoverButtons', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('~/components/Chat/Messages/Elapsed', () => ({
  __esModule: true,
  default: () => null,
  shouldShowElapsed: () => false,
}));

jest.mock('~/hooks', () => ({
  useMessageProcess: jest.requireActual('~/hooks/Messages/useMessageProcess').default,
  useMemoizedChatContext: jest.requireActual('~/hooks/Messages/useMemoizedChatContext').default,
  useLocalize: () => (key: string) => key,
  useAttachments: () => ({ attachments: undefined, searchResults: undefined }),
  useContentMetadata: () => ({ hasParallelContent: false }),
  useMessageActions: ({ chatContext }: { chatContext: { conversation: TConversation } }) => ({
    edit: false,
    index: 0,
    agent: undefined,
    assistant: undefined,
    conversation: chatContext.conversation,
    messageLabel: 'Assistant',
    enterEdit: mockNoop,
    handleContinue: mockNoop,
    handleFeedback: undefined,
    copyToClipboard: mockNoop,
    getCanCopy: () => true,
    regenerateMessage: mockNoop,
    hasConfiguredSender: false,
  }),
}));

function mockNoop() {}

const conversation = {
  conversationId: 'convo-tail',
  endpoint: 'openAI',
  model: 'gpt-4',
} as TConversation;

function row(messageId: string, parentMessageId: string, depth: number, isCreatedByUser: boolean) {
  return {
    messageId,
    parentMessageId,
    depth,
    isCreatedByUser,
    conversationId: conversation.conversationId,
    sender: isCreatedByUser ? 'User' : 'Assistant',
    text: messageId,
    content: [{ type: 'text', text: messageId }],
    createdAt: '2026-09-30T12:00:00.000Z',
    children: [],
  } as unknown as TMessage;
}

/** Links each row to the next, as the thread index does for the visible path. */
function thread(rows: TMessage[]): TMessage[] {
  return rows.map((message, index) => ({
    ...message,
    children: rows[index + 1] ? [rows[index + 1]] : [],
  }));
}

const settled = [
  row('user-1', '00000000-0000-0000-0000-000000000000', 0, true),
  row('assistant-1', 'user-1', 1, false),
  row('user-2', 'assistant-1', 2, true),
  row('assistant-2', 'user-2', 3, false),
];

type ThreadState = {
  messages: TMessage[];
  latestMessageId: string;
  isSubmitting: boolean;
};

let setThreadState: React.Dispatch<React.SetStateAction<ThreadState>> = () => undefined;
const setCurrentEditId = () => undefined;
const setSiblingIdx = () => undefined;
const stableHelpers = {
  ask: jest.fn(),
  regenerate: jest.fn(),
  handleContinue: jest.fn(),
  setAbortScroll: jest.fn(),
  getMessages: jest.fn(),
  setMessages: jest.fn(),
};

function Thread() {
  const [state, setState] = useState<ThreadState>({
    messages: thread(settled),
    latestMessageId: 'assistant-2',
    isSubmitting: false,
  });
  setThreadState = setState;
  const latestMessageDepth = state.messages.find(
    (message) => message.messageId === state.latestMessageId,
  )?.depth;

  const chatHelpers = useMemo(
    () =>
      ({
        ...stableHelpers,
        index: 0,
        conversation,
        abortScroll: false,
        feedbackEnabled: true,
        isSubmitting: state.isSubmitting,
        latestMessageId: state.latestMessageId,
        latestMessageDepth,
      }) as unknown as ReturnType<typeof useChatContext>,
    [state.isSubmitting, state.latestMessageId, latestMessageDepth],
  );

  return (
    <ChatContext.Provider value={chatHelpers}>
      <MessagesViewProvider>
        {state.messages.map((message) => (
          <MessageContent
            key={message.depth}
            message={message}
            currentEditId={null}
            setCurrentEditId={setCurrentEditId}
            siblingIdx={0}
            siblingCount={1}
            setSiblingIdx={setSiblingIdx}
          />
        ))}
      </MessagesViewProvider>
    </ChatContext.Provider>
  );
}

function rendersOf(...ids: string[]) {
  return ids.map((id) => mockRowRenders.get(id) ?? 0);
}

describe('message rows across a send', () => {
  beforeEach(() => {
    mockRowRenders.clear();
    render(
      <RecoilRoot>
        <Thread />
      </RecoilRoot>,
    );
    mockRowRenders.clear();
  });

  it('re-renders only the rows entering or leaving the tail when a message is sent', () => {
    act(() => {
      setThreadState(() => ({
        messages: thread([
          ...settled,
          row('user-3', 'assistant-2', 4, true),
          row('assistant-3_', 'user-3', 5, false),
        ]),
        latestMessageId: 'assistant-3_',
        isSubmitting: true,
      }));
    });

    expect(rendersOf('user-1', 'assistant-1', 'user-2')).toEqual([0, 0, 0]);
    expect(rendersOf('assistant-2', 'user-3', 'assistant-3_')).toEqual([1, 1, 1]);
  });

  it('leaves settled rows alone when the streaming id hydrates and the run settles', () => {
    const sent = [
      ...settled,
      row('user-3', 'assistant-2', 4, true),
      row('assistant-3_', 'user-3', 5, false),
    ];
    act(() => {
      setThreadState({
        messages: thread(sent),
        latestMessageId: 'assistant-3_',
        isSubmitting: true,
      });
    });
    mockRowRenders.clear();

    const hydrated = [...sent.slice(0, 5), row('assistant-3', 'user-3', 5, false)];
    act(() => {
      setThreadState({
        messages: thread(hydrated),
        latestMessageId: 'assistant-3',
        isSubmitting: true,
      });
    });
    act(() => {
      setThreadState((current) => ({ ...current, isSubmitting: false }));
    });

    expect(rendersOf('user-1', 'assistant-1', 'user-2', 'assistant-2', 'user-3')).toEqual([
      0, 0, 0, 0, 0,
    ]);
    expect(mockRowRenders.get('assistant-3')).toBeGreaterThan(0);
  });
});
