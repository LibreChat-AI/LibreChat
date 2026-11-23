/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { MessageUsageProps } from '../host';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessageUsageSlot, MessagesHostProvider } from '../host';

const reply = {
  messageId: 'reply-1',
  conversationId: 'convo-1',
  isCreatedByUser: false,
  text: 'A',
} as TMessage;

const usage = { input: 120, output: 35, cacheRead: 0, cacheWrite: 0, cost: 0.02 };

function mount(first: MessageUsageProps) {
  const renderMessageUsage = jest.fn((props: MessageUsageProps) => (
    <span>{props.message.metadata?.usage == null ? 'pending' : 'recorded'}</span>
  ));
  const host = createMessagesHost({ renderMessageUsage });
  const view = render(
    <MessagesHostProvider host={host}>
      <MessageUsageSlot {...first} />
    </MessagesHostProvider>,
  );
  const update = (next: MessageUsageProps) =>
    view.rerender(
      <MessagesHostProvider host={host}>
        <MessageUsageSlot {...next} />
      </MessagesHostProvider>,
    );
  return { renderMessageUsage, update };
}

describe('MessageUsageSlot', () => {
  it('does not render the control again for a streamed frame of the same response', () => {
    const { renderMessageUsage, update } = mount({ message: reply, conversationId: 'convo-1' });

    for (const text of ['A response', 'A response that', 'A response that grows']) {
      update({ message: { ...reply, text }, conversationId: 'convo-1' });
    }

    expect(renderMessageUsage).toHaveBeenCalledTimes(1);
  });

  it('renders the control again once the response has its usage', () => {
    const { renderMessageUsage, update } = mount({ message: reply, conversationId: 'convo-1' });
    expect(screen.getByText('pending')).toBeInTheDocument();

    update({ message: { ...reply, metadata: { usage } }, conversationId: 'convo-1' });

    expect(renderMessageUsage).toHaveBeenCalledTimes(2);
    expect(screen.getByText('recorded')).toBeInTheDocument();
  });

  it.each<[string, MessageUsageProps]>([
    ['its id', { message: { ...reply, messageId: 'reply-2' }, conversationId: 'convo-1' }],
    [
      'its conversation',
      { message: { ...reply, conversationId: 'convo-2' }, conversationId: 'convo-1' },
    ],
    ['the conversation it is shown in', { message: reply, conversationId: 'convo-2' }],
    ['its place as the last response', { message: reply, conversationId: 'convo-1', isLast: true }],
  ])('renders the control again when the response changes %s', (_what, next) => {
    const { renderMessageUsage, update } = mount({ message: reply, conversationId: 'convo-1' });

    update(next);

    expect(renderMessageUsage).toHaveBeenCalledTimes(2);
    expect(renderMessageUsage).toHaveBeenLastCalledWith(next);
  });

  it('renders nothing for a host without a usage control', () => {
    const { container } = render(
      <MessagesHostProvider host={createMessagesHost({ renderMessageUsage: undefined })}>
        <MessageUsageSlot message={reply} />
      </MessagesHostProvider>,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
