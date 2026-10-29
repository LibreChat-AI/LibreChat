import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, UIMappingOptions } from 'librechat-data-provider';
import { toView } from '../views';

const toolCall = (): TMessage => ({
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  content: [
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'call-1', type: 'tool_call', name: 'search', args: '{}', output: 'x' },
    },
  ],
});

const failed = (): UIMappingOptions => ({ resolveToolFailure: () => 'failed' });
const succeeded = (): UIMappingOptions => ({});

describe('toView', () => {
  it('reuses a view only for the tool outcome rules that mapped it', () => {
    const message = toolCall();

    const first = toView(message, undefined, failed);
    expect(toView(message, undefined, failed)).toBe(first);

    const other = toView(message, undefined, succeeded);
    expect(other).not.toBe(first);
    expect(other.parts[0]).not.toEqual(first.parts[0]);
  });
});
