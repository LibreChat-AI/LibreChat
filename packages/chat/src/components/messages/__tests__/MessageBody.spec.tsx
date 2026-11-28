/** @jest-environment jsdom */
import { Constants } from 'librechat-data-provider';
import { cleanup, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type {
  MessagePartsHost,
  MessagePartsMarkdownProps,
  MessagePartsUserTextPreferences,
} from '../../../react/host';
import type { MessageBodySlotProps, MessagesHost } from '../../../react/messages/host';
import { DisplayMessage, MessageBody, UnfinishedMessage, renderMessageBody } from '../MessageBody';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { initEnglish } from '../../../__fixtures__/i18n';

jest.mock('../../errors/ErrorMessage', () => ({
  ...jest.requireActual('../../errors/ErrorMessage'),
  __esModule: true,
  default: ({ text }: { text: string }) => <div data-testid="error-message">{text}</div>,
}));
jest.mock('../../parts/ToolCallLimitNotice', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-call-limit-notice" />,
}));
jest.mock('../../parts/Thinking', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div data-testid="thinking">{children}</div>,
}));

beforeAll(initEnglish);

const TOOL_CALL_LIMIT = String(Constants.TOOL_CALL_LIMIT_FINISH_REASON);

const message = (overrides: Partial<TMessage> = {}): TMessage =>
  ({ messageId: 'message-1', isCreatedByUser: true, ...overrides }) as TMessage;

const preferences = (
  overrides: Partial<MessagePartsUserTextPreferences> = {},
): MessagePartsUserTextPreferences => ({
  enableUserMsgMarkdown: false,
  collapseLongUserMessages: false,
  usernameDisplay: false,
  ...overrides,
});

const props = (overrides: Partial<MessageBodySlotProps> = {}): MessageBodySlotProps => ({
  ask: jest.fn(),
  edit: false,
  isLast: false,
  text: 'Hello there',
  message: message(),
  enterEdit: jest.fn(),
  error: false,
  isSubmitting: false,
  unfinished: false,
  isCreatedByUser: true,
  siblingIdx: 0,
  setSiblingIdx: jest.fn(),
  ...overrides,
});

/** A markdown renderer that says which variant it was asked for. */
const markdown = jest.fn(({ content, variant }: MessagePartsMarkdownProps) => (
  <div data-testid={`markdown-${variant}`}>{content}</div>
));

function draw(
  body: React.ReactNode,
  parts: Partial<MessagePartsHost> = {},
  messages: Partial<MessagesHost> = {},
) {
  return render(
    <MessagesHostProvider host={createMessagesHost(messages)}>
      <MessagePartsHostProvider
        host={createMessagePartsHost({
          renderMarkdown: markdown,
          useUserTextPreferences: () => preferences(),
          ...parts,
        })}
      >
        {body}
      </MessagePartsHostProvider>
    </MessagesHostProvider>,
  );
}

beforeEach(() => {
  markdown.mockClear();
});

describe('MessageBody', () => {
  it('draws a prompt as plain text that keeps its line breaks', () => {
    const { container } = draw(<MessageBody {...props({ text: 'line one\nline two' })} />);

    const text = container.querySelector('.message-content');
    expect(text).toHaveTextContent('line one line two');
    expect(text?.textContent).toBe('line one\nline two');
    expect(text).toHaveClass('whitespace-pre-wrap', 'text-text-primary');
    expect(markdown).not.toHaveBeenCalled();
  });

  it('draws a prompt as light markdown when the reader turned that on', () => {
    draw(<MessageBody {...props({ text: '**bold**' })} />, {
      useUserTextPreferences: () => preferences({ enableUserMsgMarkdown: true }),
    });

    expect(screen.getByTestId('markdown-lite')).toHaveTextContent('**bold**');
    expect(document.querySelector('.message-content')).not.toHaveClass('whitespace-pre-wrap');
  });

  it('draws a reply stored as text as full markdown', () => {
    draw(
      <MessageBody
        {...props({
          text: 'An answer',
          isCreatedByUser: false,
          message: message({ isCreatedByUser: false }),
        })}
      />,
    );

    expect(screen.getByTestId('markdown-full')).toHaveTextContent('An answer');
  });

  it('draws with the package’s own markdown when the host names no renderer', () => {
    draw(
      <MessageBody
        {...props({
          text: 'An *answer*',
          isCreatedByUser: false,
          message: message({ isCreatedByUser: false }),
        })}
      />,
      { renderMarkdown: undefined },
    );

    expect(document.querySelector('.message-content em')).toHaveTextContent('answer');
  });

  it('collapses a long prompt only when the reader asked for that', () => {
    /** jsdom lays nothing out; a prompt taller than the collapsed preview is what the wrapper
     *  measures, so the text reports one. */
    const height = jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
    try {
      const { unmount } = draw(<MessageBody {...props({ text: 'A long prompt' })} />);
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
      unmount();

      draw(<MessageBody {...props({ text: 'A long prompt' })} />, {
        useUserTextPreferences: () => preferences({ collapseLongUserMessages: true }),
      });
      expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
    } finally {
      height.mockRestore();
    }
  });

  it('never collapses a reply, whatever the reader asked for prompts', () => {
    const height = jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(2000);
    try {
      draw(
        <MessageBody
          {...props({
            text: 'A long reply',
            isCreatedByUser: false,
            message: message({ isCreatedByUser: false }),
          })}
        />,
        { useUserTextPreferences: () => preferences({ collapseLongUserMessages: true }) },
      );
      expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
    } finally {
      height.mockRestore();
    }
  });

  it('splits the thinking a text reply carries from its answer', () => {
    draw(
      <MessageBody
        {...props({
          text: ':::thinking\nweighing it\n:::\nThe answer',
          isCreatedByUser: false,
          message: message({ isCreatedByUser: false }),
        })}
      />,
    );

    expect(screen.getByTestId('thinking')).toHaveTextContent('weighing it');
    expect(screen.getByTestId('markdown-full').textContent).toBe('The answer');
  });

  it('draws a failed message as its error card', () => {
    draw(<MessageBody {...props({ text: 'boom', error: true })} />);

    expect(screen.getByTestId('error-message')).toHaveTextContent('boom');
    expect(document.querySelector('.message-content')).toBeNull();
  });

  it('draws the host’s editor only while a message is edited, and the text as it is without one', () => {
    const renderMessageEditor = jest.fn((body: MessageBodySlotProps) => (
      <textarea aria-label="Edit" defaultValue={body.text} />
    ));
    const { unmount } = draw(
      <MessageBody {...props({ edit: true })} />,
      {},
      { renderMessageEditor },
    );
    expect(screen.getByRole('textbox', { name: 'Edit' })).toHaveValue('Hello there');
    expect(renderMessageEditor.mock.calls[0][0]).toMatchObject({ edit: true, text: 'Hello there' });
    unmount();

    draw(<MessageBody {...props()} />, {}, { renderMessageEditor });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelector('.message-content')).toHaveTextContent('Hello there');
    cleanup();

    draw(<MessageBody {...props({ edit: true })} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelector('.message-content')).toHaveTextContent('Hello there');
  });

  it('says a reply stopped early once it is no longer generating', () => {
    const reply = message({ isCreatedByUser: false });
    const { unmount } = draw(
      <MessageBody {...props({ unfinished: true, isSubmitting: true, message: reply })} />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    unmount();

    draw(<MessageBody {...props({ unfinished: true, isSubmitting: false, message: reply })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/stopped before it finished/);
  });

  it('is what renderMessageBody draws', () => {
    draw(renderMessageBody(props({ text: 'from the default' })));
    expect(document.querySelector('.message-content')).toHaveTextContent('from the default');
  });
});

describe('DisplayMessage', () => {
  const live = { useMessage: () => ({ messageId: 'message-1', isSubmitting: true }) };

  it('shows the block cursor on a streaming reply only where the word fade is off', () => {
    const reply = message({ isCreatedByUser: false });
    const { unmount } = draw(
      <DisplayMessage text="Partial" message={reply} isCreatedByUser={false} showCursor />,
      { ...live, useSmoothStreaming: () => true },
    );
    expect(document.querySelector('.message-content')).not.toHaveClass('result-streaming');
    expect(document.querySelector('.message-content')).toHaveClass('submitting');
    unmount();

    draw(<DisplayMessage text="Partial" message={reply} isCreatedByUser={false} showCursor />, {
      ...live,
      useSmoothStreaming: () => false,
    });
    expect(document.querySelector('.message-content')).toHaveClass('result-streaming');
  });

  it('shows no cursor on empty text', () => {
    draw(
      <DisplayMessage
        text=""
        message={message({ isCreatedByUser: false })}
        isCreatedByUser={false}
        showCursor
      />,
      { ...live, useSmoothStreaming: () => false },
    );
    expect(document.querySelector('.message-content')).not.toHaveClass('result-streaming');
  });
});

describe('UnfinishedMessage', () => {
  it('routes a step-limit turn to the actionable notice, not an error box', () => {
    draw(<UnfinishedMessage message={message({ finish_reason: TOOL_CALL_LIMIT })} />);

    expect(screen.getByTestId('tool-call-limit-notice')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the localized incomplete warning for every other unfinished turn', () => {
    draw(<UnfinishedMessage message={message({ finish_reason: 'length' })} />);

    expect(screen.queryByTestId('tool-call-limit-notice')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This response stopped before it finished. Regenerate it or send a new message.',
    );
  });
});
