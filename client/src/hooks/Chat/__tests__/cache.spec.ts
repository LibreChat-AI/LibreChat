import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { getMessageCacheIds, getMessagesConversationId } from '../cache';

/** `Constants` is a heterogeneous enum (`string | number`); annotate as
 *  `string` so the member is usable where a `string` field is expected. */
const NEW_CONVO: string = Constants.NEW_CONVO;

const message = (conversationId?: string | null): TMessage =>
  ({
    messageId: 'message-id',
    conversationId,
  }) as TMessage;

describe('chat message cache helpers', () => {
  it('uses the latest concrete conversation id from streamed messages', () => {
    expect(
      getMessagesConversationId([
        message(Constants.NEW_CONVO),
        message(null),
        message('generated-convo-id'),
      ]),
    ).toBe('generated-convo-id');
  });

  it('mirrors new-chat messages into the generated conversation cache', () => {
    expect(
      getMessageCacheIds({
        queryParam: NEW_CONVO,
        conversationId: NEW_CONVO,
        messages: [message('generated-convo-id')],
      }),
    ).toEqual([Constants.NEW_CONVO, 'generated-convo-id']);
  });

  it('keeps the current conversation cache id while avoiding duplicate ids', () => {
    expect(
      getMessageCacheIds({
        queryParam: 'generated-convo-id',
        conversationId: 'generated-convo-id',
        messages: [message('generated-convo-id')],
      }),
    ).toEqual(['generated-convo-id']);
  });
});
