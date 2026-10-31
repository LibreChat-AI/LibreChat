/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { MessageCopy, MessageCopyInput } from '../../../react/messages/host';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import MinimalHoverButtons from '../MinimalHoverButtons';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

const message = { messageId: 'm1', text: 'Shared result.', isCreatedByUser: false } as TMessage;

function renderWithCopy(useMessageCopy: (input: MessageCopyInput) => MessageCopy) {
  const host = createMessagesHost({ useMessageCopy });
  return render(
    <MessagesHostProvider host={host}>
      <MinimalHoverButtons message={message} variant="lite" />
    </MessagesHostProvider>,
  );
}

describe('MinimalHoverButtons', () => {
  it('asks the host to copy the row and shows the copied state it reports', () => {
    const useMessageCopy = jest.fn<MessageCopy, [MessageCopyInput]>(() => ({
      copyToClipboard: (setIsCopied) => setIsCopied(true),
      canCopy: true,
    }));
    renderWithCopy(useMessageCopy);

    expect(useMessageCopy).toHaveBeenCalledWith({
      message,
      searchResults: undefined,
      variant: 'lite',
    });
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_copy_to_clipboard' }));
    expect(screen.getByRole('button', { name: 'com_ui_copied_to_clipboard' })).toBeInTheDocument();
  });

  it('disables the copy control when the host cannot copy', () => {
    renderWithCopy(() => ({ copyToClipboard: jest.fn(), canCopy: false }));

    expect(screen.getByRole('button', { name: 'com_ui_copy_to_clipboard' })).toBeDisabled();
  });
});
