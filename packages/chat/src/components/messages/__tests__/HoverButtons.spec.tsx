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
import HoverButtons from '../HoverButtons';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

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

function renderButtons(overrides: Partial<MessagesHost> = {}, isSubmitting = false) {
  const chat = { index: 0, isSubmitting } as ChatContract;
  return render(
    <ChatContext.Provider value={chat}>
      <MessagesHostProvider host={createMessagesHost(overrides)}>
        <HoverButtons
          index={0}
          isLast={true}
          isEditing={false}
          message={answer}
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
  it('draws no read-aloud control when the host renders none', () => {
    renderButtons();

    expect(screen.queryByTestId('read-aloud-button')).toBeNull();
    expect(screen.getByTestId('copy-response-button')).toBeInTheDocument();
  });

  it('hands the host the spoken text and draws its control as a toolbar button', () => {
    const renderMessageAudio = jest.fn(({ renderButton }: MessageAudioProps) =>
      renderButton?.({ onClick: jest.fn(), title: 'com_ui_read_aloud', icon: null }),
    );
    renderButtons({ renderMessageAudio });

    expect(renderMessageAudio).toHaveBeenCalledWith(
      expect.objectContaining({ index: 0, messageId: answer.messageId, content: answer.text }),
    );
    expect(screen.getByTestId('read-aloud-button')).toHaveAccessibleName('com_ui_read_aloud');
  });

  it('offers rerun once the host thread shows the parent is the user turn', () => {
    renderButtons({ useGetMessages: () => () => [question, answer] });

    expect(screen.getByTestId('regenerate-generation-button')).toBeEnabled();
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
});
