import { ContentTypes } from 'librechat-data-provider';
import type { ChatEvent, TMessage } from 'librechat-data-provider';
import type { ChatStream, ChatTransport, ChatSendRequest } from '@librechat/chat';

/** Writes the reply to a user turn; the example echoes it. */
export type Reply = (text: string) => string;

const echo: Reply = (text) => `You said: ${text}`;

/** A stream that yields its events in order, then ends. */
function streamOf(events: ChatEvent[]): ChatStream {
  return {
    close() {},
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

/**
 * A transport with no server: it answers every turn from memory with one `final` frame, the frame
 * a LibreChat server ends a turn with. Swap it for `createSSETransport` to talk to a real server.
 */
export function createMemoryTransport(reply: Reply = echo): ChatTransport {
  return {
    async sendMessages({ payload }: ChatSendRequest) {
      const conversationId = payload.conversationId ?? 'example';
      const requestMessage: TMessage = {
        messageId: payload.messageId ?? 'user',
        parentMessageId: payload.parentMessageId ?? null,
        conversationId,
        isCreatedByUser: true,
        text: payload.text ?? '',
      };
      const text = reply(requestMessage.text);
      const responseMessage: TMessage = {
        messageId: payload.responseMessageId ?? `${requestMessage.messageId}-reply`,
        parentMessageId: requestMessage.messageId,
        conversationId,
        isCreatedByUser: false,
        text,
        content: [{ type: ContentTypes.TEXT, text }],
      };
      return {
        status: 'stream',
        stream: streamOf([
          { type: 'open' },
          { type: 'final', data: { final: true, requestMessage, responseMessage } },
        ]),
      };
    },
    async reconnectToStream() {
      return null;
    },
    async abort() {
      return { success: true };
    },
  };
}
