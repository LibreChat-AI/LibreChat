/**
 * @jest-environment jsdom
 */
import { useMemo, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, act } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { MessagePartsHost, ContentPartsSlotProps } from '../../../react/host';
import type { MessageBodySlotProps } from '../../../react/messages/host';
import type { ChatContract } from '../../../react/chat/contract';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { useErrorSource } from '../../../react/messages/error';
import { MessagePartsHostProvider } from '../../../react/host';
import { ChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';
import MessageContent from '../MessageContent';
import MessageParts from '../MessageParts';
import Message from '../Message';

beforeAll(initEnglish);

let mockHoverButtonsRenderCount = 0;
let mockContentRenderCount = 0;

jest.mock('../HoverButtons', () => ({
  __esModule: true,
  default: () => {
    mockHoverButtonsRenderCount += 1;
    return <div data-testid="hover-buttons" />;
  },
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

const StructuredMessage = MessageContent;

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

type RowComponent = typeof Message;

const partsHost = {
  useAgent: () => undefined,
  useUser: () => undefined,
  useUserTextPreferences: () => ({
    usernameDisplay: false,
    enableUserMsgMarkdown: false,
    collapseLongUserMessages: false,
  }),
  useShare: () => ({}),
  useShowThinking: () => true,
  useAutoExpandTools: () => false,
  renderContentParts: function ContentParts({ content }: ContentPartsSlotProps) {
    mockContentRenderCount += 1;
    return <StructuredContent content={content} />;
  },
} as unknown as MessagePartsHost;

function StructuredContent({ content }: Pick<ContentPartsSlotProps, 'content'>) {
  const errorSource = useErrorSource();
  return (
    <div data-testid="structured-message-content" data-error-source-model={errorSource?.model}>
      {JSON.stringify(content ?? [])}
    </div>
  );
}

const messagesHost = createMessagesHost({
  renderMessageBody: ({ text }: MessageBodySlotProps) => {
    mockContentRenderCount += 1;
    return <div data-testid="message-content">{text}</div>;
  },
});

let replaceLatest: (message: TMessage) => void = () => undefined;

function DerivedStreamingRow({
  initial,
  structured = false,
  submitting = true,
  siblingIdx = 1,
  row,
}: {
  initial: TMessage;
  structured?: boolean;
  submitting?: boolean;
  siblingIdx?: number;
  row?: RowComponent;
}) {
  const [latestMessage, setLatestMessage] = useState<TMessage>(initial);
  replaceLatest = setLatestMessage;
  const latestMessageId = latestMessage.messageId;
  const latestMessageDepth = latestMessage.depth;

  const chatContext = useMemo(
    () =>
      ({
        ask: jest.fn(),
        index: 0,
        regenerate: jest.fn(),
        conversation,
        latestMessageId,
        latestMessageDepth,
        handleContinue: jest.fn(),
        isSubmitting: submitting,
        abortScroll: false,
        setAbortScroll: jest.fn(),
      }) as unknown as ChatContract,
    [latestMessageDepth, latestMessageId, submitting],
  );

  const MessageComponent = row ?? (structured ? StructuredMessage : Message);
  return (
    <ChatContext.Provider value={chatContext}>
      <MessageComponent
        message={latestMessage}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
        siblingIdx={siblingIdx}
        siblingCount={2}
        setSiblingIdx={jest.fn()}
      />
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
  const initial =
    assistantMessage ??
    (structured ? optimisticStructuredAssistantMessage : optimisticAssistantMessage);

  render(
    <MessagesHostProvider host={messagesHost}>
      <MessagePartsHostProvider host={partsHost}>
        <DerivedStreamingRow
          initial={initial}
          structured={structured}
          submitting={submitting}
          siblingIdx={siblingIdx}
          row={row}
        />
      </MessagePartsHostProvider>
    </MessagesHostProvider>,
  );
}

describe('streaming hover actions', () => {
  beforeEach(() => {
    mockHoverButtonsRenderCount = 0;
    mockContentRenderCount = 0;
  });

  it('keeps actions mounted while an optimistic assistant row is replaced', async () => {
    const user = userEvent.setup();
    renderStreamingRow();

    await user.hover(screen.getByTestId('message-content'));

    expect(screen.getByTestId('hover-buttons')).toBeInTheDocument();
    expect(mockHoverButtonsRenderCount).toBeGreaterThan(0);

    act(() => {
      replaceLatest(canonicalAssistantMessage);
    });

    expect(screen.getByTestId('hover-buttons')).toBeInTheDocument();
    expect(mockHoverButtonsRenderCount).toBeGreaterThan(0);
  });

  it('keeps actions mounted for structured tool-capable responses', async () => {
    const user = userEvent.setup();
    renderStreamingRow(true);

    await user.hover(screen.getByTestId('structured-message-content'));

    expect(screen.getByTestId('hover-buttons')).toBeInTheDocument();

    act(() => {
      replaceLatest(canonicalStructuredAssistantMessage);
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
      'no-touch:opacity-0',
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

    expect(screen.getByTestId('hover-buttons').parentElement).toHaveClass('min-h-[1.9375rem]');
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
   * The timer additionally requires the newest sibling position: a counting
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
