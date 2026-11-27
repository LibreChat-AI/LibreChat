/** @jest-environment jsdom */
import { render } from '@testing-library/react';
import { Constants, ContentTypes } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { BrowserAudioProps } from '../Audio';
import BrowserAudio from '../Audio';

const message = {
  messageId: 'reply-1',
  conversationId: 'chat-1',
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: false,
  text: 'A spoken reply.',
} as TMessage;

function props(overrides: Partial<BrowserAudioProps> = {}): BrowserAudioProps {
  return {
    routeKey: 'chat-1',
    shouldPlay: true,
    activeRunId: 'run-1',
    latestMessage: message,
    speak: jest.fn(() => true),
    cancel: jest.fn(),
    onStarted: jest.fn(),
    ...overrides,
  };
}

describe('BrowserAudio', () => {
  it('renders no DOM and acknowledges a run only after speech is accepted', () => {
    const input = props();
    const { container } = render(<BrowserAudio {...input} />);

    expect(container).toBeEmptyDOMElement();
    expect(input.speak).toHaveBeenCalledWith(message.text);
    expect(input.onStarted).toHaveBeenCalledWith('run-1');
    expect(input.cancel).not.toHaveBeenCalled();
  });

  it.each<Partial<BrowserAudioProps>>([
    { shouldPlay: false },
    { activeRunId: null },
    { latestMessage: null },
    { latestMessage: { ...message, text: '' } },
    {
      latestMessage: {
        ...message,
        text: 'Private reasoning.',
        content: [{ type: ContentTypes.THINK, think: 'Private reasoning.' }],
      },
    },
  ])('does not request speech for an ineligible input: %j', (override) => {
    const input = props(override);
    render(<BrowserAudio {...input} />);

    expect(input.speak).not.toHaveBeenCalled();
    expect(input.onStarted).not.toHaveBeenCalled();
  });

  it('filters reasoning before speaking the answer', () => {
    const input = props({
      latestMessage: {
        ...message,
        text: '',
        content: [
          { type: ContentTypes.THINK, think: 'Private reasoning.' },
          { type: ContentTypes.TEXT, text: 'Public answer.' },
        ],
      },
    });
    render(<BrowserAudio {...input} />);

    expect(input.speak).toHaveBeenCalledWith('Public answer.');
  });

  it('retries refused speech when the voice service becomes ready', () => {
    const input = props({ speak: jest.fn(() => false) });
    const { rerender } = render(<BrowserAudio {...input} />);
    expect(input.onStarted).not.toHaveBeenCalled();

    const readySpeak = jest.fn(() => true);
    rerender(<BrowserAudio {...input} speak={readySpeak} />);

    expect(readySpeak).toHaveBeenCalledWith(message.text);
    expect(input.onStarted).toHaveBeenCalledTimes(1);
    expect(input.cancel).not.toHaveBeenCalled();
  });

  it('cancels the previous route before same-commit finalization starts speech', () => {
    const events: string[] = [];
    const input = props({
      routeKey: 'new',
      shouldPlay: false,
      cancel: () => events.push('cancel'),
      speak: () => {
        events.push('speak');
        return true;
      },
      onStarted: () => events.push('started'),
    });
    const { rerender, unmount } = render(<BrowserAudio {...input} />);

    rerender(<BrowserAudio {...input} routeKey="saved-chat" shouldPlay />);
    expect(events).toEqual(['cancel', 'speak', 'started']);

    unmount();
    expect(events).toEqual(['cancel', 'speak', 'started', 'cancel']);
  });

  it('preserves the route cancellation callback without cancelling or replaying on updates', () => {
    const input = props();
    const { rerender, unmount } = render(<BrowserAudio {...input} />);
    const nextCancel = jest.fn();

    rerender(<BrowserAudio {...input} cancel={nextCancel} />);
    expect(input.speak).toHaveBeenCalledTimes(1);
    expect(input.cancel).not.toHaveBeenCalled();
    expect(nextCancel).not.toHaveBeenCalled();

    rerender(<BrowserAudio {...input} routeKey="next-chat" cancel={nextCancel} />);
    expect(input.cancel).toHaveBeenCalledTimes(1);
    expect(nextCancel).not.toHaveBeenCalled();

    unmount();
    expect(nextCancel).toHaveBeenCalledTimes(1);
    expect(input.cancel).toHaveBeenCalledTimes(1);
  });
});
