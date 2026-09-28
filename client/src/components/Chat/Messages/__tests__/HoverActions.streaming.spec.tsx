import React, { useMemo } from 'react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { RecoilRoot, type MutableSnapshot } from 'recoil';
import { render, screen, act } from '@testing-library/react';
import { QueryKeys, type TConversation, type TMessage } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useLatestMessage, useLatestMessageId } from '~/hooks/Messages/useLatestMessage';
import { ChatContext, MessagesViewProvider, useChatContext } from '~/Providers';
import StructuredMessage from '~/components/Messages/MessageContent';
import MessageParts from '~/components/Chat/Messages/MessageParts';
import Message from '~/components/Chat/Messages/Message';
import store from '~/store';

let mockHoverButtonsRenderCount = 0;
let mockContentRenderCount = 0;

jest.mock('~/components/Chat/Messages/HoverButtons', () => ({
  __esModule: true,
  default: () => {
    mockHoverButtonsRenderCount += 1;
    return <div data-testid="hover-buttons" />;
  },
}));

jest.mock('~/components/Chat/Messages/Content/MessageContent', () => ({
  __esModule: true,
  default: ({ text }: { text: string }) => {
    mockContentRenderCount += 1;
    return <div data-testid="message-content">{text}</div>;
  },
}));

jest.mock('~/components/Chat/Messages/Content/ContentParts', () => {
  const { useErrorSource } = jest.requireActual('~/components/Messages/Content/Error/source');
  return {
    __esModule: true,
    default: function ContentParts({ content }: { content?: TMessage['content'] }) {
      mockContentRenderCount += 1;
      const errorSource = useErrorSource();
      return (
        <div data-testid="structured-message-content" data-error-source-model={errorSource?.model}>
          {JSON.stringify(content ?? [])}
        </div>
      );
    },
  };
});

jest.mock('~/components/Chat/Messages/Content/Parts/AuthorHeader', () => ({
  __esModule: true,
  default: () => <div data-testid="author-header" />,
}));

jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="message-icon" />,
}));

jest.mock('~/hooks', () => {
  const useMessageProcess = jest.requireActual('~/hooks/Messages/useMessageProcess').default;
  const useMemoizedChatContext = jest.requireActual(
    '~/hooks/Messages/useMemoizedChatContext',
  ).default;
  const useMessageHelpers = jest.requireActual('~/hooks/Messages/useMessageHelpers').default;
  return {
    useMessageProcess,
    useMessageHelpers,
    useMemoizedChatContext,
    useContentMetadata: () => ({ hasParallelContent: false }),
    useAttachments: () => ({ attachments: [], searchResults: undefined }),
    useLocalize: () => (key: string) => key,
    useMessageActions: ({
      chatContext,
      message,
    }: {
      chatContext: {
        ask: jest.Mock;
        index: number;
        regenerate: jest.Mock;
        conversation: TConversation | null;
        latestMessageId: string | undefined;
        latestMessageDepth: number | undefined;
        handleContinue: jest.Mock;
      };
      message?: TMessage;
    }) => ({
      ask: chatContext.ask,
      edit: false,
      index: chatContext.index,
      agent: undefined,
      assistant: undefined,
      conversation: chatContext.conversation,
      messageLabel: message?.sender ?? 'Assistant',
      handleFeedback: jest.fn(),
      handleContinue: chatContext.handleContinue,
      copyToClipboard: jest.fn(),
      latestMessageId: chatContext.latestMessageId,
      regenerateMessage: jest.fn(),
      latestMessageDepth: chatContext.latestMessageDepth,
    }),
  };
});

const conversation = {
  conversationId: 'conversation-streaming',
  endpoint: 'openAI',
  model: 'gpt-4',
} as TConversation;

const userMessage = {
  messageId: 'user-message',
  parentMessageId: '00000000-0000-0000-0000-000000000000',
  conversationId: conversation.conversationId,
  text: 'Tell me something',
  isCreatedByUser: true,
} as TMessage;

const optimisticAssistantMessage = {
  messageId: 'assistant-message_',
  parentMessageId: userMessage.messageId,
  conversationId: conversation.conversationId,
  sender: 'Assistant',
  text: '',
  isCreatedByUser: false,
} as TMessage;

const canonicalAssistantMessage = {
  ...optimisticAssistantMessage,
  messageId: 'assistant-message',
  text: 'Streaming canonical response',
} as TMessage;

const optimisticStructuredAssistantMessage = {
  ...optimisticAssistantMessage,
  content: [{ type: 'text', text: '' }],
} as TMessage;

const canonicalStructuredAssistantMessage = {
  ...canonicalAssistantMessage,
  content: [{ type: 'text', text: 'Streaming structured response' }],
} as TMessage;

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

type RowComponent = typeof Message;

function DerivedStreamingRow({
  structured = false,
  submitting = true,
  siblingIdx = 1,
  row,
}: {
  structured?: boolean;
  submitting?: boolean;
  siblingIdx?: number;
  row?: RowComponent;
}) {
  const queryClient = useQueryClient();
  const latestMessage = useLatestMessage(0);
  const latestMessageId = useLatestMessageId(0);
  const latestMessageDepth = latestMessage?.depth;

  const chatContext = useMemo(
    () =>
      ({
        ask: jest.fn(),
        index: 0,
        regenerate: jest.fn(),
        conversation,
        latestMessageId: latestMessageId ?? undefined,
        latestMessageDepth,
        handleContinue: jest.fn(),
        isSubmitting: submitting,
        abortScroll: false,
        setAbortScroll: jest.fn(),
        getMessages: () =>
          queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversation.conversationId]),
        setMessages: (messages: TMessage[]) => {
          queryClient.setQueryData<TMessage[]>(
            [QueryKeys.messages, conversation.conversationId],
            messages,
          );
        },
      }) as unknown as ReturnType<typeof useChatContext>,
    [latestMessageDepth, latestMessageId, queryClient, submitting],
  );

  if (!latestMessage) {
    return null;
  }

  const MessageComponent = row ?? (structured ? StructuredMessage : Message);
  return (
    <ChatContext.Provider value={chatContext}>
      <MessagesViewProvider>
        <MessageComponent
          message={latestMessage}
          currentEditId={null}
          setCurrentEditId={jest.fn()}
          siblingIdx={siblingIdx}
          siblingCount={2}
          setSiblingIdx={jest.fn()}
        />
      </MessagesViewProvider>
    </ChatContext.Provider>
  );
}

function renderStreamingRow(
  structured = false,
  submitting = true,
  siblingIdx = 1,
  row?: RowComponent,
  assistantMessage?: TMessage,
) {
  const queryClient = createQueryClient();
  queryClient.setQueryData<TMessage[]>(
    [QueryKeys.messages, conversation.conversationId],
    [
      userMessage,
      assistantMessage ??
        (structured ? optimisticStructuredAssistantMessage : optimisticAssistantMessage),
    ],
  );

  const initializeState = ({ set }: MutableSnapshot) => {
    set(store.conversationByIndex(0), conversation);
    set(store.isSubmittingFamily(0), submitting);
  };

  render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={initializeState}>
        <MemoryRouter initialEntries={[`/c/${conversation.conversationId}`]}>
          <DerivedStreamingRow
            structured={structured}
            submitting={submitting}
            siblingIdx={siblingIdx}
            row={row}
          />
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );

  return queryClient;
}

describe('streaming hover actions', () => {
  beforeEach(() => {
    mockHoverButtonsRenderCount = 0;
    mockContentRenderCount = 0;
  });

  it('keeps actions mounted while an optimistic assistant row is replaced', async () => {
    const user = userEvent.setup();
    const queryClient = renderStreamingRow();

    await user.hover(screen.getByTestId('message-content'));

    expect(screen.getByTestId('hover-buttons')).toBeInTheDocument();
    expect(mockHoverButtonsRenderCount).toBeGreaterThan(0);

    act(() => {
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, conversation.conversationId],
        [userMessage, canonicalAssistantMessage],
      );
    });

    expect(screen.getByTestId('hover-buttons')).toBeInTheDocument();
    expect(mockHoverButtonsRenderCount).toBeGreaterThan(0);
  });

  it('keeps actions mounted for structured tool-capable responses', async () => {
    const user = userEvent.setup();
    const queryClient = renderStreamingRow(true);

    await user.hover(screen.getByTestId('structured-message-content'));

    expect(screen.getByTestId('hover-buttons')).toBeInTheDocument();

    act(() => {
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, conversation.conversationId],
        [userMessage, canonicalStructuredAssistantMessage],
      );
    });

    expect(screen.getByTestId('hover-buttons')).toBeInTheDocument();
  });

  /**
   * Every other action is withheld from the row that is still generating, so an
   * always-visible retry counter would sit alone under a half-written answer. Both
   * response formats have to fade it the same way.
   */
  it.each([
    ['a plain text', false],
    ['a structured', true],
  ])('fades retry navigation to hover-only on %s streaming row', (_label, structured) => {
    renderStreamingRow(structured);

    expect(screen.getByRole('navigation', { name: 'com_ui_sibling_navigation' })).toHaveClass(
      '[@media(hover:hover)]:opacity-0',
    );
  });

  /**
   * The row that is still generating withholds every action, and a lone sibling
   * counter renders nothing, so its footer measures zero until the answer lands.
   * Reserving the height keeps the transcript still at the moment it does.
   */
  it.each([
    ['a plain text', false],
    ['a structured', true],
  ])('holds the footer height while %s response streams', (_label, structured) => {
    renderStreamingRow(structured);

    expect(screen.getByTestId('hover-buttons').parentElement).toHaveClass('min-h-[31px]');
  });

  /**
   * The elapsed-time indicator fills the footer slot the withheld actions leave
   * empty, but only under the response that is actively generating.
   */
  it.each([
    ['a plain text', false],
    ['a structured', true],
  ])('shows the elapsed timer under %s streaming response', (_label, structured) => {
    renderStreamingRow(structured);

    expect(screen.getByTestId('stream-elapsed')).toBeInTheDocument();
  });

  /**
   * The retry navigation holds its width in the footer whether or not hover has
   * revealed it, so a row with siblings would otherwise indent the timer past the
   * column the streaming dot just vacated. The reading stays at the column start.
   */
  it.each([
    ['a plain text', Message],
    ['a structured', StructuredMessage],
    ['a flat-thread', MessageParts],
  ])('keeps the elapsed reading left-most in %s streaming footer', (_label, row) => {
    renderStreamingRow(false, true, 1, row);

    const timer = screen.getByTestId('stream-elapsed');
    const footer = screen.getByRole('navigation', {
      name: 'com_ui_sibling_navigation',
    }).parentElement;

    expect(footer?.firstElementChild).toContainElement(timer);
  });

  /** An error content part renders without its message, so its row supplies the identity. */
  it.each([
    ['a structured', StructuredMessage],
    ['a flat-thread', MessageParts],
  ])("hands the error parts of %s row that row's model", (_label, row) => {
    renderStreamingRow(true, true, 1, row, {
      ...optimisticStructuredAssistantMessage,
      endpoint: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    expect(screen.getByTestId('structured-message-content')).toHaveAttribute(
      'data-error-source-model',
      'claude-sonnet-4-5',
    );
  });

  it('renders no elapsed timer once the row is not submitting', () => {
    renderStreamingRow(false, false);

    expect(screen.queryByTestId('stream-elapsed')).toBeNull();
  });

  /**
   * `latestMessageId` follows the SELECTED branch, so a settled older sibling
   * the reader paged to mid-regeneration satisfies the latest+submitting gate.
   * The timer additionally requires the newest sibling position — a counting
   * timer under settled content misleads in a way withheld buttons don't.
   */
  it('renders no elapsed timer under an older sibling selected mid-stream', () => {
    renderStreamingRow(false, true, 0);

    expect(screen.queryByTestId('stream-elapsed')).toBeNull();
    expect(screen.getByTestId('hover-buttons')).toBeInTheDocument();
  });

  /**
   * The timer's once-per-second tick is component-local state: advancing the
   * clock must re-render nothing beyond the timer itself, or the indicator
   * would tax every streaming frame's neighbors.
   */
  it('ticks the elapsed timer without re-rendering content or actions', () => {
    jest.useFakeTimers();
    try {
      renderStreamingRow();

      const hoverRenders = mockHoverButtonsRenderCount;
      const contentRenders = mockContentRenderCount;

      act(() => {
        jest.advanceTimersByTime(5_000);
      });

      expect(screen.getByTestId('stream-elapsed')).toBeInTheDocument();
      expect(mockHoverButtonsRenderCount).toBe(hoverRenders);
      expect(mockContentRenderCount).toBe(contentRenders);
    } finally {
      jest.useRealTimers();
    }
  });
});
