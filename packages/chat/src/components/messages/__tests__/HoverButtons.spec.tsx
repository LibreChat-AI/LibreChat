/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { MessageAudioProps, MessagesHost } from '../../../react/messages/host';
import type { ChatContract } from '../../../react/chat/contract';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { ChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';
import HoverButtons from '../HoverButtons';

beforeAll(async () => {
  await initEnglish();
});

const conversation = {
  conversationId: 'convo-1',
  endpoint: EModelEndpoint.agents,
} as TConversation;

const question = {
  messageId: 'user-1',
  conversationId: 'convo-1',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'What is 2 + 2?',
} as TMessage;

const answer = {
  messageId: 'assistant-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: 'The answer is 4.',
} as TMessage;

function renderButtons(
  overrides: Partial<MessagesHost> = {},
  isSubmitting = false,
  readOnly = false,
  message = answer,
) {
  const chat = { index: 0, isSubmitting, readOnly } as ChatContract;
  return render(
    <ChatContext.Provider value={chat}>
      <MessagesHostProvider host={createMessagesHost(overrides)}>
        <HoverButtons
          index={0}
          isLast={true}
          isEditing={false}
          message={message}
          conversation={conversation}
          enterEdit={jest.fn()}
          regenerate={jest.fn()}
          handleContinue={jest.fn()}
          copyToClipboard={jest.fn()}
          getCanCopy={() => true}
          latestMessageId={answer.messageId}
        />
      </MessagesHostProvider>
    </ChatContext.Provider>,
  );
}

describe('HoverButtons', () => {
  it.each([false, true])('offers usage for a response, streaming=%s', (streaming) => {
    const renderMessageUsage = jest.fn(() => <span>Usage details</span>);
    renderButtons({ renderMessageUsage }, streaming);
    expect(renderMessageUsage).toHaveBeenCalledWith({
      message: answer,
      conversationId: 'convo-1',
      isLast: true,
    });
    expect(screen.getByText('Usage details')).toBeInTheDocument();
  });

  it('does not offer provider usage on a user message', () => {
    const renderMessageUsage = jest.fn(() => null);
    renderButtons({ renderMessageUsage }, false, false, question);
    expect(renderMessageUsage).not.toHaveBeenCalled();
  });

  it('draws no read-aloud control when the host renders none', () => {
    renderButtons();

    expect(screen.queryByTestId('read-aloud-button')).toBeNull();
    expect(screen.getByTestId('copy-response-button')).toHaveAccessibleName('Copy to clipboard');
  });

  it('hands the host the spoken text and draws its control as a toolbar button', () => {
    const renderMessageAudio = jest.fn(({ renderButton }: MessageAudioProps) =>
      renderButton?.({ onClick: jest.fn(), title: 'Read aloud', icon: null }),
    );
    renderButtons({ renderMessageAudio });

    expect(renderMessageAudio).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, messageId: answer.messageId, content: answer.text }),
    );
    expect(screen.getByTestId('read-aloud-button')).toHaveAccessibleName('Read aloud');
  });

  it('offers rerun once the host thread shows the parent is the user turn', () => {
    renderButtons({ useGetMessages: () => () => [question, answer] });

    expect(screen.getByTestId('regenerate-generation-button')).toBeEnabled();
    expect(screen.getByTestId('regenerate-generation-button')).toHaveAccessibleName('Regenerate');
  });

  it('withholds rerun when the host thread holds no parent to replay', () => {
    renderButtons({ useGetMessages: () => () => [answer] });

    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
  });

  it('withholds rerun while a queued follow-up is about to start', () => {
    renderButtons({
      useGetMessages: () => () => [question, answer],
      useHasPendingTurn: (conversationId) => conversationId === conversation.conversationId,
    });

    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
  });

  it('withholds rerun while the pane is generating', () => {
    renderButtons({ useGetMessages: () => () => [question, answer] }, true);

    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
  });

  it('keeps copy and withholds rerun and edit where the reader takes no turn', () => {
    renderButtons({ useGetMessages: () => () => [question, answer] }, false, true);

    expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
  });
  /**
   * A send replaces the pane's chat contract several times, as the tail moves, and each
   * replacement reaches every mounted toolbar in the thread.
   */
  describe('when the pane replaces its chat contract', () => {
    function mount() {
      /** Called once in each render of the toolbar. */
      const useHasPendingTurn = jest.fn(() => false);
      const host = createMessagesHost({
        useGetMessages: () => () => [question, answer],
        useHasPendingTurn,
      });
      /** One row's props, held across renders the way a memoized row holds them. */
      const row = {
        index: 0,
        isLast: true,
        isEditing: false,
        message: answer,
        conversation,
        enterEdit: jest.fn(),
        regenerate: jest.fn(),
        handleContinue: jest.fn(),
        copyToClipboard: jest.fn(),
        getCanCopy: () => true,
        latestMessageId: answer.messageId,
      };
      const under = (chat: Partial<ChatContract>) => (
        <ChatContext.Provider
          value={{ index: 0, isSubmitting: false, readOnly: false, ...chat } as ChatContract}
        >
          <MessagesHostProvider host={host}>
            <HoverButtons {...row} />
          </MessagesHostProvider>
        </ChatContext.Provider>
      );
      const view = render(under({}));
      return {
        renders: useHasPendingTurn,
        replace: (chat: Partial<ChatContract>) => view.rerender(under(chat)),
      };
    }

    it('does not render the toolbar again while the fields it reads are the same', () => {
      const { renders, replace } = mount();

      replace({ latestMessageId: 'user-2' });
      replace({ latestMessageId: 'assistant-2', latestMessageDepth: 3 });

      expect(renders).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('regenerate-generation-button')).toBeInTheDocument();
    });

    it('renders the toolbar again when a run starts and when it ends', () => {
      const { renders, replace } = mount();

      replace({ isSubmitting: true });
      expect(renders).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();

      replace({ isSubmitting: false });
      expect(renders).toHaveBeenCalledTimes(3);
      expect(screen.getByTestId('regenerate-generation-button')).toBeInTheDocument();
    });

    it('renders the toolbar again when the reader stops taking turns', () => {
      const { renders, replace } = mount();

      replace({ readOnly: true });

      expect(renders).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('regenerate-generation-button')).toBeNull();
    });
  });
});
